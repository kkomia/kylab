"""长期记忆服务（v0.14；**v0.57 起后端是 mem0**，见 ``app/services/memory.py``）。

镜像同构：``app/services/memory.py`` → 本文件。

这里测的是**我们自己那一层**（mem0 之下的存储不归我们管，也不该由这一层替它测）：

1. **关着的时候必须报错**，不能返回空——返回空会让模型以为"没有相关记忆"，
   然后基于错误前提继续推理；
2. **写入要机械查重**（同一条不写第二遍、改一条不新增一条、敏感信息绝不进库），
   否则同一件事被记很多遍，而记忆每轮都要注入上下文，越记越长等于越记越贵；
3. **注入块的形状**：每轮全量、带边界说明、超限**在提示词里说出来**；
4. **零额外模型调用**：默认配置下注入、写入、检索、状态读数**一次模型都不问**
   ——它们全是本地存储操作，唯一会花钱的隐式捕获默认关。

用假的 runtime 而不是真配置服务：这几条都是记忆自身的逻辑，不该依赖数据库。
**嵌入模型一律"没配"**——于是走的是开发兜底嵌入（词面哈希，无语义），
所以检索那一组用**同一个说法**查，不测"换个说法也能命中"（那不是这一层的事）。
捕获那条链路注入一个假的"问模型"，不连任何真实模型（``ask`` 参数就是为它留的）。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.core.exceptions import InvalidRequestError, NotFoundError
from app.services.llm import LLMConfig
from app.services.memory import (
    AGENTS_FILE,
    CAPTURE_SIGNALS,
    PROFILE_FILE,
    SOUL_FILE,
    MemoryService,
    classify_action,
    classify_text,
    is_sensitive,
    matched_signal,
    normalize_entry,
    render_items,
)
from app.services.runtime_config import EmbeddingSettings


class _FakeRuntime:
    """只实现 MemoryService 用到的那几个读接口。

    形状**必须和真的一样**（假的少一个方法，就是"测试绿、真调用崩"）：
    ``get`` / ``get_bool`` / ``get_int`` / ``llm`` / ``embedding``。
    """

    def __init__(self, values: dict[str, str], llm: LLMConfig | None = None) -> None:
        self._values = values
        self._llm = llm

    def get(self, key: str) -> str:
        return self._values.get(key, "")

    def get_bool(self, key: str, *, default: bool = False) -> bool:
        raw = self._values.get(key)
        if raw is None or not str(raw).strip():
            return default
        return str(raw).strip().lower() in {"1", "true", "yes", "on"}

    def get_int(self, key: str) -> int:
        try:
            return int(self.get(key))
        except ValueError:
            return 0

    def llm(self) -> LLMConfig:
        """没绑定对话模型的那个快照（``is_configured`` 为假）。

        默认给"没配模型"的替身，才能测到"读 / 写 / 注入都不必问模型"这条纪律
        （真实现里这个快照来自注册表）。
        """
        return self._llm or LLMConfig(base_url="", api_key="", model_id="")

    def embedding(self) -> EmbeddingSettings:
        """**一律没配**：于是服务层退回开发用确定性嵌入（无语义的词面哈希）。"""
        return EmbeddingSettings(base_url="", api_key="", model_id="", dim=0, batch_size=32)


class _FakeChat:
    """假的"问一次模型"：把准备好的回答按顺序发出去，并记下收到的消息。"""

    def __init__(self, *replies: str) -> None:
        self._replies = list(replies)
        self.prompts: list[list[object]] = []

    def __call__(self, messages: list[object]) -> str:
        self.prompts.append(messages)
        return self._replies.pop(0) if self._replies else ""


def _service(
    tmp_path: Path, *, ask=None, llm: LLMConfig | None = None, **values: str
) -> MemoryService:
    base = {"memory.enabled": "true", "memory.workspace": "memory"}
    base.update(values)
    return MemoryService(_FakeRuntime(base, llm), tmp_path, ask=ask)  # type: ignore[arg-type]


def _write(workspace: Path, path: str, content: str) -> Path:
    target = workspace / path
    target.parent.mkdir(parents=True, exist_ok=True)
    # 按字节写：与产品同一条纪律（Windows 上 write_text 会翻成 CRLF）
    target.write_bytes(content.encode("utf-8"))
    return target


# --------------------------------------------------------------------- 关着时


def test_disabled_recall_raises_instead_of_returning_empty(tmp_path: Path) -> None:
    """关着时必须报错。返回空会让模型以为"没有相关记忆"，然后基于错误前提继续。

    注意**开着时**返回空是另一回事（那是"真没有"）——这两件事能分得清，
    正是因为本地检索不依赖任何外部东西：关着 = 我们故意不搜，开着 = 真搜过了。
    """
    service = _service(tmp_path, **{"memory.enabled": "false"})

    with pytest.raises(InvalidRequestError, match="未启用"):
        service.recall("随便问问")


def test_remember_works_even_when_the_switch_is_off(tmp_path: Path) -> None:
    """``remember`` 不看那道闸：它写的是记忆库，而**编辑不看开关**
    ——"关了也能改自己的东西"这条纪律保留。

    对照：``recall`` 在关着时仍然明确报错（它代表"记忆进不进这一轮的上下文"）。
    """
    service = _service(tmp_path, **{"memory.enabled": "false"})

    result = service.remember("用户偏好先给结论")

    assert result.action == "added"
    with pytest.raises(InvalidRequestError, match="未启用"):
        service.recall("偏好")
    # 关着只是不进提示词，条目本身照旧在库里
    assert [item.text for item in service.all_items()] == ["用户偏好先给结论"]


def test_memory_block_is_empty_when_disabled_instead_of_raising(tmp_path: Path) -> None:
    """注入是"有就带上"：没启用（或库还空着）时返回空串，不让对话失败。"""
    service = _service(tmp_path, **{"memory.enabled": "false"})
    service.remember("用户偏好先给结论")

    assert service.memory_block() == ""
    assert service.all_items(), "记忆本身照旧可读可写——那道闸只管注入与 recall"


# --------------------------------------------------------------------- 记住


def test_remember_assigns_a_section_by_content(tmp_path: Path) -> None:
    service = _service(tmp_path)

    result = service.remember("用户偏好先给结论")

    assert result.action == "added"
    assert result.section == "长期偏好与风格", "归区按内容走"
    item = service.all_items()[0]
    assert item.text == "用户偏好先给结论"
    assert item.section == "长期偏好与风格"
    assert item.source == "显式"
    assert item.id, "每条都要有 id（界面与工具按它改删）"


def test_remember_honours_an_explicit_section(tmp_path: Path) -> None:
    service = _service(tmp_path)

    assert service.remember("内网那台 L20", section="工具与环境").section == "工具与环境"


def test_remember_is_idempotent(tmp_path: Path) -> None:
    """同一条再说一遍 = ``existing``，**库里不多一条**。"""
    service = _service(tmp_path)
    service.remember("用户偏好先给结论")

    again = service.remember("用户偏好先给结论")

    assert again.action == "existing"
    assert "已经有了" in again.receipt
    assert len(service.all_items()) == 1


def test_remember_replaces_in_one_call(tmp_path: Path) -> None:
    """带 ``replaces`` 的更正**一次调用完成**：id 不变、旧值进历史。"""
    service = _service(tmp_path)
    original = service.remember("用户偏好先给结论")

    corrected = service.remember(
        "用户要求回答先给结论，再列依据", replaces="用户偏好先给结论"
    )

    assert corrected.action == "replaced"
    assert corrected.replaced == "用户偏好先给结论"
    assert corrected.item_id == original.item_id, "更正不是「删一条再记一条」"
    items = service.all_items()
    assert len(items) == 1
    assert items[0].text == "用户要求回答先给结论，再列依据"
    events = [row.event for row in service.item_history(original.item_id)]
    assert events == ["ADD", "UPDATE"]


def test_remember_falls_back_to_the_mechanical_verdict_when_replaces_misses(
    tmp_path: Path,
) -> None:
    """``replaces`` 指错了**不该让这一轮失败**：退回机械判据，如实报它做了什么。"""
    service = _service(tmp_path)
    service.remember("用户偏好先给结论")

    result = service.remember("用户的内网有一台 L20", replaces="库里的另外一条")

    assert result.action == "added"
    assert len(service.all_items()) == 2


def test_remember_merges_near_duplicates_through_containment(tmp_path: Path) -> None:
    """包含关系算同一件事（数字相同、差值 ≤ 6 字）→ 顶替，留下更完整的那条。"""
    service = _service(tmp_path)
    service.remember("用户偏好先给结论")

    result = service.remember("用户偏好先给结论，再列依据")

    assert result.action == "replaced"
    assert len(service.all_items()) == 1


def test_remember_keeps_two_facts_that_differ_by_a_number(tmp_path: Path) -> None:
    """**数字不同就不是同一件事**：这条否决一个字都不放松。"""
    service = _service(tmp_path)
    service.remember("内网只有一台 L20")

    result = service.remember("内网有两台 L20")

    assert result.action == "added"
    assert len(service.all_items()) == 2


def test_remember_rejects_content_that_is_too_long(tmp_path: Path) -> None:
    service = _service(tmp_path)

    result = service.remember("长" * 501)

    assert result.action == "rejected"
    assert "拆成两条" in result.receipt
    assert service.all_items() == []


def test_remember_rejects_sensitive_content_without_leaving_a_trace(tmp_path: Path) -> None:
    """敏感信息**绝不进记忆**：它每轮都进上下文。"""
    service = _service(tmp_path)

    result = service.remember("用户的令牌是 sk-abcdefghijklmno")

    assert result.action == "rejected"
    assert result.reason == "sensitive"
    assert "不进记忆" in result.receipt
    assert service.all_items() == []


def test_remember_rejects_blank_content(tmp_path: Path) -> None:
    service = _service(tmp_path)

    with pytest.raises(InvalidRequestError, match="content"):
        service.remember("   ")


def test_remember_asks_the_model_when_infer_is_on(tmp_path: Path) -> None:
    """``memory.infer`` 打开时写入交给 mem0 的抽取（**每写一条问一次模型**）。

    这一档是 opt-in、默认关（D3）：换来的是"换个说法说同一件事也能被认出来"，
    代价是钱。抽取没给出东西时回执只说"没有新增"——**不替它断言"已经有了"**，
    那是一件我们并不知道的事。
    """
    replies: list[list[object]] = []

    def chat(messages: list[object]) -> str:
        replies.append(messages)
        return '{"facts": ["用户要求先给结论"]}'

    service = _service(tmp_path, ask=chat, **{"memory.infer": "true"})

    result = service.remember("用户要求先给结论")

    assert len(replies) == 1, "这一档的特点就是「写一条要问一次模型」"
    assert result.action == "existing"
    assert "没有新增" in result.receipt


def test_remember_folds_a_pasted_bullet_marker(tmp_path: Path) -> None:
    """从旧文件里粘过来的一行常带 ``- ``：入口先把它折掉，否则"同一条"判不准。"""
    service = _service(tmp_path)

    service.remember("- 用户偏好先给结论")

    assert service.all_items()[0].text == "用户偏好先给结论"


# --------------------------------------------------------------------- 忘掉


def test_forget_removes_the_entry_and_keeps_its_history(tmp_path: Path) -> None:
    service = _service(tmp_path)
    service.remember("用户偏好先给结论")

    result = service.forget("用户偏好先给结论")

    assert result.action == "forgotten"
    assert "忘掉了" in result.receipt
    assert service.all_items() == []
    assert [row.event for row in service.item_history(result.item_id)] == ["ADD", "DELETE"]


def test_forget_accepts_a_unique_substring(tmp_path: Path) -> None:
    """原文记不全时按**唯一子串**兜一次——用户说"忘掉那条关于 NAS 的"就是这个形状。"""
    service = _service(tmp_path)
    service.remember("用户的内网 NAS 上有一份资料")

    result = service.forget("NAS 上有一份资料")

    assert result.action == "forgotten"
    assert service.all_items() == []


def test_forget_refuses_an_ambiguous_topic(tmp_path: Path) -> None:
    """对得上不止一条时**不猜**：把候选列回来让它说清。"""
    service = _service(tmp_path)
    service.remember("用户的内网 NAS 上有一份资料")
    service.remember("用户的内网 NAS 上有一台备份机")

    result = service.forget("NAS")

    assert result.action == "rejected"
    assert result.reason == "ambiguous"
    assert "两条" in result.receipt or "2 条" in result.receipt
    assert len(service.all_items()) == 2


def test_forget_reports_a_missing_topic(tmp_path: Path) -> None:
    service = _service(tmp_path)

    result = service.forget("库里没有这条")

    assert result.action == "rejected"
    assert result.reason == "missing"


# --------------------------------------------------------------------- 按 id 改删


def test_update_item_keeps_the_id_and_the_history(tmp_path: Path) -> None:
    service = _service(tmp_path)
    item_id = service.remember("用户偏好先给结论").item_id

    result = service.update_item(item_id, content="用户偏好先给结论，再列依据")

    assert result.action == "replaced"
    assert result.item_id == item_id
    items = service.all_items()
    assert [item.id for item in items] == [item_id]
    assert items[0].text == "用户偏好先给结论，再列依据"


def test_update_item_can_change_only_the_section(tmp_path: Path) -> None:
    service = _service(tmp_path)
    item_id = service.remember("内网那台 L20").item_id

    result = service.update_item(item_id, section="工具与环境")

    assert result.section == "工具与环境"
    assert service.all_items()[0].section == "工具与环境"


def test_update_item_applies_the_same_guards_as_remember(tmp_path: Path) -> None:
    """**换了一条路进来，判据不能松**：长度与敏感信息照样拒。"""
    service = _service(tmp_path)
    item_id = service.remember("用户偏好先给结论").item_id

    too_long = service.update_item(item_id, content="长" * 501)
    sensitive = service.update_item(item_id, content="用户的令牌是 sk-abcdefghijklmno")

    assert too_long.action == "rejected" and too_long.reason == ""
    assert sensitive.action == "rejected" and sensitive.reason == "sensitive"
    assert service.all_items()[0].text == "用户偏好先给结论"


def test_update_and_delete_report_a_missing_id(tmp_path: Path) -> None:
    service = _service(tmp_path)

    with pytest.raises(NotFoundError):
        service.update_item("不存在", content="x")
    with pytest.raises(NotFoundError):
        service.delete_item("不存在")


def test_delete_item_removes_it(tmp_path: Path) -> None:
    service = _service(tmp_path)
    item_id = service.remember("用户偏好先给结论").item_id

    result = service.delete_item(item_id)

    assert result.action == "forgotten"
    assert service.all_items() == []


# --------------------------------------------------------------------- 检索


def test_recall_finds_an_item_by_its_own_wording(tmp_path: Path) -> None:
    """检索用的池子是**记忆库本身**（不再是变更流）。

    查询用的是库里那句话本身的说法：测试环境没配嵌入模型，走的是无语义的词面兜底
    （见模块头），所以这里只证明"能定到这一条"，不证明"换个说法也能命中"。
    """
    service = _service(tmp_path)
    service.remember("用户要求回答先给结论")

    hits = service.recall("回答先给结论")

    assert hits, "这条就在库里"
    assert hits[0].text == "用户要求回答先给结论"
    assert hits[0].id
    assert hits[0].score is not None


def test_recall_is_empty_for_a_noise_query(tmp_path: Path) -> None:
    """**开着时返回空是诚实的答案**（检索确实跑过了），与"关着时返回空"不是一回事。

    在**兜底嵌入**下这条尤其要紧：它给任意两段文本的相似度是随机的
    （实测 0.18–0.29，而 mem0 的默认阈值是 0.1），所以库里只要有条目，
    不过滤就"任何查询都能翻出几条"。``_lexical_only`` 那道过滤就是为它加的
    ——下面两行一起钉住这件事：相关的进得来、不相干的进不来。
    """
    service = _service(tmp_path)
    service.remember("用户要求回答先给结论")
    service.remember("用户的内网有一台 L20")

    assert [item.text for item in service.recall("回答先给结论")] == ["用户要求回答先给结论"]
    assert service.recall("合唱团的排练时间安排") == []
    assert service.recall("不相干的一句话") == []


def test_recall_pool_never_reads_the_persona_files(tmp_path: Path) -> None:
    """两池不混：人设文件（``SOUL.md`` 等）不是记忆的池子。"""
    service = _service(tmp_path)
    workspace = service.workspace_for(None)
    _write(workspace, SOUL_FILE, "# 我是 KYLAB\n\n我不吃香菜。\n")
    service.remember("用户要求回答先给结论")

    assert service.recall("我不吃香菜") == []


def test_recall_clamps_the_limit(tmp_path: Path) -> None:
    service = _service(tmp_path)
    for index in range(5):
        service.remember(f"用户的第 {index} 条偏好是先给结论")

    assert len(service.recall("先给结论", limit=999)) <= 20
    assert len(service.recall("先给结论", limit=1)) == 1


def test_recall_raises_when_the_query_is_empty(tmp_path: Path) -> None:
    service = _service(tmp_path)

    with pytest.raises(InvalidRequestError, match="query"):
        service.recall("  ")


# --------------------------------------------------------------------- 列表与状态


def test_list_items_is_newest_first_and_searching_is_a_recall(tmp_path: Path) -> None:
    """列全部按改动时间倒序；给了 ``query`` 就走 `recall`（那道闸与上限在那里）。"""
    service = _service(tmp_path)
    service.remember("用户要求回答先给结论")
    item_id = service.remember("用户的内网有一台 L20").item_id
    service.update_item(item_id, content="用户的内网有一台 L20，还有一台 A100")

    listed = service.list_items()

    assert next(item.text for item in listed) == "用户的内网有一台 L20，还有一台 A100"
    found = service.list_items(query="先给结论")
    assert [item.text for item in found] == ["用户要求回答先给结论"]


def test_list_items_refuses_to_search_when_disabled(tmp_path: Path) -> None:
    """带 ``query`` 就是检索，检索受 ``memory.enabled`` 门控——列全部不受。"""
    service = _service(tmp_path, **{"memory.enabled": "false"})
    service.remember("用户要求回答先给结论")

    assert len(service.list_items()) == 1
    with pytest.raises(InvalidRequestError, match="未启用"):
        service.list_items(query="先给结论")


def test_status_is_local_and_counts_the_items(tmp_path: Path) -> None:
    service = _service(tmp_path)
    service.remember("用户要求回答先给结论")

    status = service.status()

    assert status.enabled is True
    assert status.items == 1
    assert status.last_changed_at
    assert str(tmp_path / "memory") == status.workspace
    # 没配嵌入模型 → 走的是开发兜底，界面据此提示"检索质量是兜底"
    assert status.development is True
    assert status.embedder == "dev/deterministic-hash"


def test_status_says_why_it_is_off_when_disabled(tmp_path: Path) -> None:
    service = _service(tmp_path, **{"memory.enabled": "false"})

    status = service.status()

    assert status.enabled is False
    assert "未启用" in status.detail


def test_each_account_gets_its_own_store(tmp_path: Path) -> None:
    """"一个账号一份记忆"：两个账号写到同一个数据目录下也互不可见。"""
    service = _service(tmp_path)

    service.remember("管理员的那条", user_id=None)
    service.remember("成员的那条", user_id="u1")

    assert [item.text for item in service.all_items(None)] == ["管理员的那条"]
    assert [item.text for item in service.all_items("u1")] == ["成员的那条"]
    # 落点也是分开的：本机主人的账号名是字面量 local
    assert service.memory_dir(None).name == "local"
    assert service.memory_dir("u1").name == "u1"


# --------------------------------------------------------------- 隐式捕获


_SIGNAL_MESSAGE = "记住：我以后都要先给结论"


def test_implicit_capture_off_by_default(tmp_path: Path) -> None:
    """默认关：**一次模型都不调**，连信号词都不看（它是这条链路上唯一会花钱的地方）。"""
    chat = _FakeChat('{"facts": ["用户要求先给结论"]}')
    service = _service(tmp_path, ask=chat)

    assert service.capture_implicit(_SIGNAL_MESSAGE) is None
    assert chat.prompts == []


def test_no_signal_word_means_no_followup(tmp_path: Path) -> None:
    """开着，但这一轮没有信号词 → 零成本（不发起那一次抽取）。"""
    chat = _FakeChat("[]")
    service = _service(tmp_path, ask=chat, **{"memory.capture": "true"})

    assert service.capture_implicit("帮我把这段改短一点") is None
    assert chat.prompts == []


def test_capture_signal_table_is_a_flat_literal_lookup() -> None:
    """信号词只做字面包含：不加分词、不做语义，判据要能被一行读明白。"""
    assert matched_signal("我以后都要这样") == "以后"
    assert matched_signal("记住：别用 emoji") in {"记住", "别"}
    assert matched_signal("帮我看一下这个文件") == ""
    assert "记住" in CAPTURE_SIGNALS


def test_implicit_capture_writes_with_a_receipt(tmp_path: Path) -> None:
    """命中信号词时才把这一轮交给 mem0 抽取（``infer=True``），回执与显式那条路同一份文案。"""
    chat = _FakeChat('{"facts": ["用户要求先给结论"]}')
    service = _service(tmp_path, ask=chat, **{"memory.capture": "true"})

    outcome = service.capture_implicit(_SIGNAL_MESSAGE)

    assert outcome is not None
    assert outcome.signal in {"记住", "以后"}
    assert len(chat.prompts) == 1, "抽取恰恰要问一次模型——这是它唯一会花钱的地方"


def test_implicit_capture_does_not_consult_the_memory_switch(tmp_path: Path) -> None:
    """捕获不看 ``memory.enabled``（那道闸管的是注入与检索），只看自己那个开关。"""
    chat = _FakeChat("[]")
    service = _service(
        tmp_path,
        ask=chat,
        **{"memory.enabled": "false", "memory.capture": "true"},
    )

    assert service.capture_implicit(_SIGNAL_MESSAGE) is not None
    assert len(chat.prompts) == 1


def test_capture_says_so_when_there_is_no_model(tmp_path: Path) -> None:
    """真的要用模型而没有模型时**如实报错**（而不是静默当"这轮没有值得记的"）。

    `ask` 没注入、runtime 也没配对话模型——报错就发生在这里，
    而**别的路（读 / 写 / 注入 / 状态）照样一个错都不出**（见下一条）。
    """
    service = _service(tmp_path, **{"memory.capture": "true"})

    with pytest.raises(InvalidRequestError, match="对话模型"):
        service.capture_implicit(_SIGNAL_MESSAGE)

    assert service.remember("用户要求回答先给结论").action == "added"


# --------------------------------------------------- 默认配置下零额外调用


def test_default_config_makes_zero_extra_model_calls_per_turn(tmp_path: Path) -> None:
    """**默认配置下，一轮对话的模型调用次数与记忆无关**。

    注入、显式写入（``remember``/``forget``）、检索、状态读数都不新增调用——
    它们全是本地存储操作；唯一会自动花钱的隐式捕获**默认关**。

    这一条**按产品默认值构造**（从 ``DEFAULTS`` 取 ``memory.*`` 那几个键），
    而不是自己发明一份配置：默认值一改，这条跟着改口径。
    """
    from app.services.runtime_config import DEFAULTS

    assert DEFAULTS["memory.enabled"] == "true"
    assert DEFAULTS["memory.persona_files"] == "SOUL.md,AGENTS.md"
    assert DEFAULTS["memory.capture"] == "false"
    assert DEFAULTS["memory.infer"] == "false"
    assert DEFAULTS["memory.inject_limit_chars"] == "6000"
    assert DEFAULTS["memory.search_top_k"] == "8"

    defaults = {key: value for key, value in DEFAULTS.items() if key.startswith("memory")}
    chat = _FakeChat()
    service = MemoryService(_FakeRuntime(defaults), tmp_path, ask=chat)  # type: ignore[arg-type]

    service.seed_persona()
    service.memory_block()
    service.guidance()
    service.bootstrap_block()
    service.remember("用户要求先给结论", section="长期偏好与风格")
    service.recall("先给结论")
    service.memory_block()
    service.forget("先给结论")
    service.status()

    assert chat.prompts == [], "这几件事一件都不该问模型"

    assert service.capture_implicit(_SIGNAL_MESSAGE) is None
    assert chat.prompts == []


# --------------------------------------------------------------------- 注入


def test_memory_block_carries_every_entry_verbatim(tmp_path: Path) -> None:
    """注入块**每轮全量**：条目原文照进，按四个分区的固定顺序排。"""
    service = _service(tmp_path)
    service.remember("内网那台 L20", section="工具与环境")
    service.remember("用户要求回答先给结论", section="长期偏好与风格")
    service.remember("用户叫小又", section="身份与称呼")

    block = service.memory_block()

    assert block.index("## 身份与称呼") < block.index("## 长期偏好与风格")
    assert block.index("## 长期偏好与风格") < block.index("## 工具与环境")
    for text in ("用户叫小又", "用户要求回答先给结论", "内网那台 L20"):
        assert text in block
    # 边界话必须在：少了它，模型会把这一整块当文献引用或当任务逐条念
    assert "不是文献依据" in block
    assert "以他此刻说的为准" in block
    # 注入块**不带 id**：一行的 id 是 36 个字符，那是每轮都发出去的成本
    assert "[" not in block.split("\n")[3]


def test_memory_block_is_empty_for_an_empty_store(tmp_path: Path) -> None:
    assert _service(tmp_path).memory_block() == ""


def test_memory_block_declares_truncation_instead_of_truncating_silently(
    tmp_path: Path,
) -> None:
    """超限**在提示词里说出来**：静默截断会让用户以为助手看到了全部记忆。"""
    service = _service(tmp_path, **{"memory.inject_limit_chars": "200"})
    for index in range(20):
        service.remember(f"用户的第 {index} 条偏好是回答先给结论再列依据")

    block = service.memory_block()

    assert "记忆超出上限" in block
    assert len(block) < 600, "装不下就不装，而不是悄悄截断"


def test_memory_block_does_not_depend_on_the_persona_list(tmp_path: Path) -> None:
    """``memory.persona_files`` 只管人设那两份，记忆走自己的开关。"""
    service = _service(tmp_path, **{"memory.persona_files": ""})
    service.remember("用户要求回答先给结论")

    assert "用户要求回答先给结论" in service.memory_block()


def test_memory_block_is_empty_when_disabled_but_items_stay_writable(tmp_path: Path) -> None:
    service = _service(tmp_path, **{"memory.enabled": "false"})
    service.remember("用户要求回答先给结论")

    assert service.memory_block() == ""
    assert len(service.all_items()) == 1


def test_render_items_can_carry_the_ids(tmp_path: Path) -> None:
    """``read_memory`` 那条路要带 id（模型改删一条靠它），注入那条路不带。"""
    service = _service(tmp_path)
    service.remember("用户要求回答先给结论")

    item = service.all_items()[0]
    assert f"[{item.id}]" in render_items([item], with_ids=True)
    assert item.id not in render_items([item])


# --------------------------------------------------------------------- 人设


def test_seed_persona_lays_down_soul_and_agents(tmp_path: Path) -> None:
    """只补缺的，**不再铺 ``PROFILE.md``**（它已经不是记忆本体了）。"""
    service = _service(tmp_path)

    created = service.seed_persona()

    assert created == [SOUL_FILE, AGENTS_FILE]
    workspace = service.workspace_for(None)
    assert (workspace / SOUL_FILE).exists()
    assert (workspace / AGENTS_FILE).exists()
    assert not (workspace / PROFILE_FILE).exists()
    assert service.seed_persona() == [], "第二次是幂等的"


def test_seed_persona_never_overwrites_what_the_user_wrote(tmp_path: Path) -> None:
    service = _service(tmp_path)
    workspace = service.workspace_for(None)
    _write(workspace, SOUL_FILE, "# 我自己写的\n")

    service.seed_persona()

    assert (workspace / SOUL_FILE).read_text(encoding="utf-8") == "# 我自己写的\n"


def test_untouched_legacy_templates_are_upgraded(tmp_path: Path) -> None:
    """**从没被改过的**旧模板才升级；用户动过一个字符就一个字都不改。"""
    service = _service(tmp_path)
    workspace = service.workspace_for(None)
    _write(
        workspace,
        SOUL_FILE,
        "---\nsummary: \"Agent 的人格：身份、准则与说话方式\"\nread_when:\n"
        "  - 需要确认自己是谁、该怎么说话、哪些事不做\n---\n\n## 我是谁\n\n## 我的准则\n\n"
        "## 说话方式\n",
    )

    service.seed_persona()

    assert "核心准则" in (workspace / SOUL_FILE).read_text(encoding="utf-8")


def test_soul_text_reads_the_file(tmp_path: Path) -> None:
    service = _service(tmp_path)
    _write(service.workspace_for(None), SOUL_FILE, "# 我是 KYLAB\n")

    assert service.soul_text() == "# 我是 KYLAB"


def test_reads_a_file_verbatim(tmp_path: Path) -> None:
    """``GET /memory/files/{path}`` 那条路：按原文读，含 frontmatter。"""
    service = _service(tmp_path)
    workspace = service.workspace_for(None)
    _write(workspace, "PROFILE.md", "---\nupdated: 2026-10-03\n---\n\n# 旧档案\n")

    detail = service.file_text(PROFILE_FILE)

    assert detail.content.startswith("---")
    assert "旧档案" in detail.content


def test_changing_the_embedding_dim_reembeds_instead_of_breaking(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """换了嵌入模型、维度也变了：**按新维度重嵌一遍，条目一条不丢**。

    这是这个功能最正常的一次演进（新装没配嵌入模型 → 256 维兜底 → 后来配上一个
    1024 维的模型），而 qdrant 的向量维度是**建集合时定死的**：不处理它，
    那一天之后每次写入都会抛 ``Vector dimension error``，记忆页整个打不开。
    """
    from app.services.embedding.deterministic import DeterministicEmbedder

    service = _service(tmp_path)
    service.remember("用户要求回答先给结论")
    service.remember("用户的内网有一台 L20")
    assert len(service.all_items()) == 2

    # 换一个**不同维度**的嵌入实现（真实现里这是用户在设置页换了模型）
    monkeypatch.setattr(
        MemoryService, "_embedder", lambda self: (DeterministicEmbedder(dim=64), True)
    )

    assert len(service.all_items()) == 2, "条目一条不丢"
    assert {item.text for item in service.all_items()} == {
        "用户要求回答先给结论",
        "用户的内网有一台 L20",
    }
    # 换完之后照旧能写（新维度已经生效）
    assert service.remember("用户要求回答简短").action == "added"
    assert len(service.all_items()) == 3


# --------------------------------------------------------------------- 通道


def test_still_works_without_a_configured_chat_model(tmp_path: Path) -> None:
    """**没配对话模型不该挡住记忆**：读、写（``infer=False``）、注入一个字都不问模型。

    真实现里 mem0 的实例要一个 LLM 对象，所以我们给的是一个"到用的时候才报错"的
    闭包——在这里抛的后果是"没配对话模型 = 记忆页打不开"，那件事与记忆无关。
    """
    service = _service(tmp_path)

    assert service.remember("用户要求回答先给结论").action == "added"
    assert service.memory_block()
    assert service.recall("先给结论")
    assert service.status().items == 1


# ----------------------------------------------------------------- 纯函数


def test_classify_text_prefers_the_project_words(tmp_path: Path) -> None:
    assert classify_text("项目目标是不出公网") == "进行中的项目"
    assert classify_text("用户喜欢简短的回答") == "长期偏好与风格"
    assert classify_text("内网那台机器的路径是 /srv") == "工具与环境"
    assert classify_text("用户叫小又") == "身份与称呼"


def test_classify_action_reads_the_numbers_before_the_words() -> None:
    """数字不同一律不顶替——这是"同一个东西"与"两个东西"唯一能机械区分的证据。"""
    from app.services.memory import MemoryItem

    known = [MemoryItem(id="1", text="内网只有一台 L20")]

    assert classify_action("内网只有两台 L20", known).action == "add"
    assert classify_action("内网只有一台 L20", known).action == "existing"
    # 包含关系（差值 ≤ 6 字、数字相同）算同一件事：顶替，不是新增；
    # 库里那条更长时反过来算"已存在"（新条目没补上信息）
    assert classify_action(
        "报告写 3 页（初稿）", [MemoryItem(id="1", text="报告写 3 页")]
    ).action == "replace"
    assert classify_action(
        "报告写 3 页", [MemoryItem(id="1", text="报告写 3 页（初稿）")]
    ).action == "existing"


def test_is_sensitive_catches_credentials_by_word_and_by_shape() -> None:
    assert is_sensitive("用户的密码是 abc")
    assert is_sensitive("令牌 sk-abcdefghijklmno")
    assert not is_sensitive("用户喜欢先给结论")


def test_normalize_entry_folds_bullets_and_whitespace() -> None:
    assert normalize_entry("  -  用户喜欢\n先给结论 ") == "用户喜欢 先给结论"
