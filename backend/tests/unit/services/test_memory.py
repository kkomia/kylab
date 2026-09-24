"""长期记忆服务（v0.14；v0.46 起是**进程内的本地实现**，不再是 ReMe 的门面）。

镜像同构：``app/services/memory.py`` → 本文件。

这里测三类事，都是"错了会静默误导模型或丢掉用户的事实"的那类：

1. **关着的时候必须报错**，不能返回空——返回空会让模型以为"没有相关记忆"，
   然后基于错误前提继续推理；
2. **记住要合并去重**，否则同一件事被记很多遍，而 MEMORY.md 每轮都要注入上下文，
   越记越长等于越记越贵；**自动沉淀也一样要去重**（同一件事不要反复写）；
3. **召回要有出处、判据要能判定"命中 vs 不命中"**：命中给文件 + 行号区间，
   噪声查询就得返回空——而不是"随便给几条看着像的"。

用假的 runtime 而不是真配置服务：这几条都是记忆自身的逻辑，
不该依赖数据库（也就能在没有 PG 时跑起来）。捕获那条链路注入一个假的"问模型"，
不连任何真实模型（``ask`` 参数就是为它留的）。
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

import pytest

from app.core.exceptions import InvalidRequestError
from app.services.llm import LLMConfig
from app.services.memory import (
    AGENTS_FILE,
    CORE_MEMORY_FILE,
    PROFILE_FILE,
    SOUL_FILE,
    MemoryService,
    _fingerprint,
    _normalize,
    _select_new,
    _similar,
)
from app.services.memory_files import MemoryMatch


class _FakeRuntime:
    """只实现 MemoryService 用到的那几个读接口。"""

    def __init__(self, values: dict[str, str]) -> None:
        self._values = values

    def get(self, key: str) -> str:
        return self._values.get(key, "")

    def get_bool(self, key: str, *, default: bool = False) -> bool:
        raw = self._values.get(key)
        if raw is None or not raw.strip():
            return default
        return raw.strip().lower() in {"1", "true", "yes", "on"}

    def get_int(self, key: str) -> int:
        """与真实实现同一口径：解析不了返回 0，由调用方回落到默认值。

        替身的形状**必须和真的一样**，否则测的是替身的行为、不是产品的——
        这条在别处踩过（假的 `Msg` 少一个字段，于是"测试绿、真调用崩"）。
        """
        try:
            return int(self.get(key))
        except ValueError:
            return 0

    def llm(self) -> LLMConfig:
        """没绑定对话模型的那个快照（``is_configured`` 为假）。

        捕获那条路要用它；给一个"没配模型"的替身，才能测到那条明确报错的路径
        （真实现里这个快照来自注册表，见 ``RuntimeConfigService.llm``）。
        """
        return LLMConfig(base_url="", api_key="", model_id="")


class _FakeChat:
    """假的"问一次模型"：把准备好的回答按顺序发出去，并记下收到的提示词。

    捕获链路要测的是"拿到模型的输出之后我们做什么"（解析、去重、落盘），
    不是"模型会不会说人话"——所以这里不连任何真实模型。
    """

    def __init__(self, *replies: str) -> None:
        self._replies = list(replies)
        self.prompts: list[list[object]] = []

    def __call__(self, messages: list[object]) -> str:
        self.prompts.append(messages)
        return self._replies.pop(0) if self._replies else ""


def _service(tmp_path: Path, *, ask=None, **values: str) -> MemoryService:
    base = {"memory.enabled": "true", "memory.workspace": "memory"}
    base.update(values)
    return MemoryService(_FakeRuntime(base), tmp_path, ask=ask)  # type: ignore[arg-type]


def _write(workspace: Path, path: str, content: str) -> Path:
    target = workspace / path
    target.parent.mkdir(parents=True, exist_ok=True)
    # 按字节写：与产品同一条纪律（Windows 上 write_text 会翻成 CRLF）
    target.write_bytes(content.encode("utf-8"))
    return target


# --------------------------------------------------------------------- 关着时


def test_disabled_recall_raises_instead_of_returning_empty(tmp_path: Path) -> None:
    """关着时必须报错。返回空会让模型以为"没有相关记忆"，然后基于错误前提继续。

    注意**开着时**返回空是另一回事（那是"真没有"，见召回那一组）——
    这两件事现在能分得清，正是因为本地检索不依赖任何外部东西：
    关着 = 我们故意不搜，开着 = 真搜过了。
    """
    service = _service(tmp_path, **{"memory.enabled": "false"})

    with pytest.raises(InvalidRequestError, match="未启用"):
        service.recall("随便问问")


def test_remember_works_even_when_the_switch_is_off(tmp_path: Path) -> None:
    """``remember`` 不看那道闸（v0.22 起）：它写的是 ``MEMORY.md``，
    那份文件无论开关如何都会注入提示词——写进去立即有效。

    对照：``recall`` 在关着时仍然明确报错（它代表"过去的对话会不会被召回"）。
    """
    service = _service(tmp_path, **{"memory.enabled": "false"})

    assert service.remember("关着也能记住")["saved"] is True
    with pytest.raises(InvalidRequestError, match="未启用"):
        service.recall("偏好")


def test_core_text_is_empty_when_disabled_instead_of_raising(tmp_path: Path) -> None:
    """注入是"有就带上"：文件不在或没启用时返回空串，不让对话失败。"""
    assert _service(tmp_path, **{"memory.enabled": "false"}).core_text() == ""


# --------------------------------------------------------------------- 记住


def test_remember_creates_memory_file_with_template(tmp_path: Path) -> None:
    service = _service(tmp_path)

    result = service.remember("用户偏好先给结论")

    assert result["saved"] is True
    body = (tmp_path / "memory" / CORE_MEMORY_FILE).read_text(encoding="utf-8")
    assert "## 核心长期记忆" in body
    assert "- 用户偏好先给结论" in body


def test_remember_is_idempotent(tmp_path: Path) -> None:
    service = _service(tmp_path)
    service.remember("用户偏好先给结论")

    again = service.remember("用户偏好先给结论")

    assert again["saved"] is False
    assert "已经存在" in again["reason"]
    body = (tmp_path / "memory" / CORE_MEMORY_FILE).read_text(encoding="utf-8")
    assert body.count("用户偏好先给结论") == 1


def test_remember_dedupe_ignores_added_tags(tmp_path: Path) -> None:
    service = _service(tmp_path)
    service.remember("设备名是 nas")

    assert service.remember("设备名是 nas", tags=["工具"])["saved"] is False


def test_remember_appends_after_existing_entries(tmp_path: Path) -> None:
    service = _service(tmp_path)
    service.remember("第一条")

    result = service.remember("第二条")

    assert result["entries"] == 2
    body = (tmp_path / "memory" / CORE_MEMORY_FILE).read_text(encoding="utf-8")
    assert body.index("- 第一条") < body.index("- 第二条")


def test_remember_preserves_hand_written_sections(tmp_path: Path) -> None:
    """只重建「核心长期记忆」那一节：别的小节里可能有人手写的内容。"""
    service = _service(tmp_path)
    service.remember("第一条")
    core = tmp_path / "memory" / CORE_MEMORY_FILE
    core.write_text(
        core.read_text(encoding="utf-8").replace(
            "<!-- 在这里记录长期有效、与当前工作区相关的工具设置。 -->", "- 设备名是 nas"
        ),
        encoding="utf-8",
    )

    service.remember("第二条")

    body = core.read_text(encoding="utf-8")
    assert "- 设备名是 nas" in body
    assert "- 第一条" in body and "- 第二条" in body


def test_remember_rejects_overlong_content(tmp_path: Path) -> None:
    with pytest.raises(InvalidRequestError, match="最多 500 字"):
        _service(tmp_path).remember("字" * 501)


def test_remember_rejects_blank_content(tmp_path: Path) -> None:
    with pytest.raises(InvalidRequestError, match="缺少参数"):
        _service(tmp_path).remember("   ")


# --------------------------------------------------------------------- 召回
#
# 本地召回（v0.46）。这一组要同时钉住两件相反的事：
# **该命中的要命中，并带回文件与行号**；**不该命中的要返回空**（而不是凑数）。

_SEED_DIGEST = """---
summary: 锂价敏感性分析
tags: [锂价]
---

# 锂价敏感性

锂价下跌 10% 会让电池业务毛利下降约 0.8 个百分点。

## 关联

- 上游见 [[碳酸锂]]
"""

_SEED_DAILY = """# 2026-09-24

- 用户偏好先给结论再给理由
- 发布前必须先跑一遍后端门禁脚本
"""


def _seed(service: MemoryService) -> Path:
    """铺一个像样的工作区：一份 digest、一份 daily、一份核心记忆。"""
    workspace = service.workspace
    _write(workspace, "digest/personal/锂价.md", _SEED_DIGEST)
    _write(workspace, "daily/2026-09-24.md", _SEED_DAILY)
    _write(
        workspace,
        CORE_MEMORY_FILE,
        "---\nsummary: 核心\n---\n\n## 核心长期记忆\n\n- 项目代号叫 kylab\n",
    )
    return workspace


def test_recall_finds_a_seeded_entry_with_a_real_line_range(tmp_path: Path) -> None:
    """命中的证据是**文件 + 行号区间**：用户拿着它就能去改那一条。

    行号必须是**文件里的真实行号**（不是"正文里的第几行"）：frontmatter 占了三行，
    少算它就会把人带到错误的位置。
    """
    service = _service(tmp_path)
    _seed(service)

    hits, _links = service.recall("锂价下跌对毛利的影响")

    assert hits, "这条是手写进去的记忆，必须能召回"
    top = hits[0]
    assert top.path == "digest/personal/锂价.md"
    # 8 是**文件里的行号**（frontmatter 占了前 4 行、标题与空行各占 1）：正文里的
    # 第 4 行是同一个位置，但对用户没用——他要拿这个号去编辑器里找那一行
    assert (top.start_line, top.end_line) == (8, 8)
    assert "毛利" in top.text
    assert top.score > 0
    # 判据是覆盖率（归一化量），不是分数：见 memory_files.MIN_TERM_COVERAGE
    assert top.coverage >= 1 / 3


def test_recall_hits_a_daily_entry_and_refuses_noise(tmp_path: Path) -> None:
    """一正一反两条，钉住"命中 vs 不命中"的判据。

    不命中的那条**必须返回空**：本地检索没有"连不上"这种中间态，
    所以空只有一个含义——这几份记忆里确实没有相关的话。
    """
    service = _service(tmp_path)
    _seed(service)

    hits, _links = service.recall("用户偏好什么样的回答风格")
    assert [hit.path for hit in hits] == ["daily/2026-09-24.md"]
    assert hits[0].start_line == 3

    assert service.recall("合唱团的排练时间安排")[0] == []
    assert service.recall("今天天气怎么样")[0] == []


def test_recall_ignores_question_words(tmp_path: Path) -> None:
    """疑问词不算检索证据：它们描述"我要问什么"，不是"这段记忆在说什么"。

    实测两种坏法各一例：剔掉之前，「复盘什么时候做」在写着「复盘固定每周五下午做」
    的记忆上被判成不相关（"什么时候"没命中）；而「用户的时间安排」会靠蹭上「用户」
    更像命中。剔掉之后，"命中"更接近用户的直觉。
    """
    service = _service(tmp_path)
    _seed(service)
    _write(service.workspace, "daily/2026-09-25.md", "# 2026-09-25\n\n- 复盘固定每周五下午做\n")

    hits, _links = service.recall("复盘什么时候做")

    assert [hit.path for hit in hits] == ["daily/2026-09-25.md"]
    assert service.recall("用户的时间安排")[0] == []


def test_recall_survives_a_segmentation_mismatch(tmp_path: Path) -> None:
    """分词切法与正文不一致的查询**也要能命中**（字对那条证据通道）。

    实测：「发布前要先跑什么」被 jieba 切成 `发布 / 前要 / 什么`，而正文里写的是
    「发布前必须先跑一遍后端门禁脚本」——"前要"这个词在正文里永远找不到，
    只靠实词那条通道，三个词只中一个，于是**明明记过这句话却搜不出来**。
    字对（`发布 / 布前 / 先跑`）不依赖分词，正是为这类情况留的。
    """
    service = _service(tmp_path)
    _seed(service)

    hits, _links = service.recall("发布前要先跑什么")

    assert [hit.path for hit in hits] == ["daily/2026-09-24.md"]
    assert "门禁" in hits[0].text


def test_recall_never_returns_core_files(tmp_path: Path) -> None:
    """``MEMORY.md`` 不进召回池：它每轮整份注入，再召回一遍就是同一段内容进两次上下文。

    这条是界面 ``retrievable`` 标记的依据（"搜不到是位置决定的，不是检索坏了"）。
    """
    service = _service(tmp_path)
    _seed(service)

    hits, _links = service.recall("项目代号叫什么")

    assert hits == []


def test_recall_returns_links_that_resolve(tmp_path: Path) -> None:
    """命中之后顺链给出的邻接边：wikilink 就在正文里，不需要第二次检索。

    链接只在**解析得到真实文件**时给（``[[碳酸锂]]`` 没有对应文件，
    那条留在图谱的悬空链接里，不该混进召回结果）。
    """
    service = _service(tmp_path)
    _seed(service)
    _write(service.workspace, "digest/personal/碳酸锂.md", "# 碳酸锂\n\n电池上游。\n")

    _hits, links = service.recall("锂价下跌对毛利的影响")

    assert [(item.path, item.direction) for item in links] == [
        ("digest/personal/碳酸锂.md", "out")
    ]
    assert links[0].name == "碳酸锂"


def test_recall_clamps_the_limit(tmp_path: Path) -> None:
    """上限生效，否则会把上下文塞爆（与检索工具同一口径）。"""
    service = _service(tmp_path)
    workspace = service.workspace
    for index in range(30):
        _write(workspace, f"daily/2026-09-{index + 1:02d}.md", f"- 偏好记录 {index} 号\n")

    hits, _links = service.recall("偏好记录", limit=9999)

    assert len(hits) == 20


def test_recall_caps_hits_per_file(tmp_path: Path) -> None:
    """同一个文件最多贡献几条：没有这条限制，一次召回会被一份长日笔记占满，
    而召回的价值恰恰在于从多个文件里凑线索。"""
    service = _service(tmp_path)
    workspace = service.workspace
    _write(
        workspace,
        "daily/2026-09-24.md",
        "\n".join(f"- 偏好记录第 {index} 条" for index in range(10)) + "\n",
    )

    hits, _links = service.recall("偏好记录", limit=10)

    assert len(hits) == 3


def test_recall_prefers_a_file_whose_name_matches(tmp_path: Path) -> None:
    """标题/文件名加权：命中标题意味着"这份文件就是讲这个的"，
    命中正文只说明"这里提了一句"——两者不该同分。"""
    service = _service(tmp_path)
    workspace = service.workspace
    _write(workspace, "digest/wiki/锂价敏感性.md", "# 锂价敏感性\n\n见下文。\n")
    _write(workspace, "daily/2026-09-24.md", "- 今天聊到了锂价敏感性的问题\n")

    hits, _links = service.recall("锂价敏感性")

    assert hits[0].path == "digest/wiki/锂价敏感性.md"


def test_recall_is_empty_when_the_pool_is_empty(tmp_path: Path) -> None:
    """只有核心文件时召回到空——那是"这里没有可召回的东西"，不是出错。"""
    service = _service(tmp_path)
    _write(service.workspace, CORE_MEMORY_FILE, "- 项目代号叫 kylab\n")

    hits, links = service.recall("项目代号")

    assert hits == [] and links == []


def test_recall_raises_when_the_query_is_empty(tmp_path: Path) -> None:
    with pytest.raises(InvalidRequestError, match="query"):
        _service(tmp_path).recall("   ")


# --------------------------------------------------- 召回结果与工作区的形状


def test_hit_is_a_match_record_with_source() -> None:
    """召回结果必须带出处（``path`` + 行号）：没有出处就没法溯源、也没法去改。"""
    hit = MemoryMatch(
        text="锂价下跌 10% 会让毛利下降",
        path="digest/personal/锂价.md",
        start_line=7,
        end_line=7,
        score=1.5,
        coverage=1.0,
    )

    assert (hit.path, hit.start_line, hit.end_line) == ("digest/personal/锂价.md", 7, 7)


def test_status_is_local_and_counts_the_pool(tmp_path: Path) -> None:
    """状态是纯本地的数字：几份文件、其中几份可召回、可召回几条、上次更新时间。

    **没有任何"连没连上"**（v0.46 删了）：记忆在我们的进程里跑，没有第二个进程可连。
    """
    service = _service(tmp_path)
    _seed(service)

    status = service.status()

    assert status.enabled is True
    assert status.file_count == 3
    assert status.retrievable_count == 2
    # 召回池切出来的块数：digest 那份 4 块（标题、正文、小标题、条目）+ daily 三块
    assert status.entry_count > 0
    assert status.core_file_exists is True
    assert status.last_changed_at, "有文件就该有'上次更新'时间"
    assert status.detail == ""


def test_status_says_why_it_is_off_when_disabled(tmp_path: Path) -> None:
    status = _service(tmp_path, **{"memory.enabled": "false"}).status()

    assert status.enabled is False
    assert "未启用" in status.detail


# --------------------------------------------------------------------- 捕获
#
# 捕获 = 问一次对话模型 → 解析 → 去重 → 追加到当天的 daily 文件。
# 这一组用假模型（``ask``），测的是我们这一侧的全部逻辑。

_TURN = [
    {"role": "user", "name": "用户", "content": "以后回答简短点，先说结论"},
    {"role": "assistant", "name": "助手", "content": "好，以后都这样"},
]


def _day_path(service: MemoryService) -> Path:
    return service.workspace / "daily" / f"{datetime.now().strftime('%Y-%m-%d')}.md"


def test_capture_writes_new_entries_into_todays_daily_file(tmp_path: Path) -> None:
    """捕获落 **daily**（设计文档 §1 的两层分工）：``MEMORY.md`` 是每轮整份注入的
    核心记忆，自动沉淀直接写进去等于机器替人决定"什么该长期占着上下文窗口"。

    来源会话写成一行 HTML 注释：渲染出来看不见，又能回答"这条是哪次对话来的"。
    """
    chat = _FakeChat("- 用户偏好简短回答，先说结论\n- 回复不要长篇大论")
    service = _service(tmp_path, ask=chat)

    result = service.capture(_TURN, session_id="conv_1")

    assert result["created"] is True
    assert result["path"] == f"daily/{datetime.now().strftime('%Y-%m-%d')}.md"
    body = _day_path(service).read_text(encoding="utf-8")
    assert "- 用户偏好简短回答，先说结论" in body
    assert "- 回复不要长篇大论" in body
    assert "conv_1" in body
    # 提示词里要带上"谁说的"与"这一轮对话"——否则模型无从判断该记什么
    prompt = str(chat.prompts[0])
    assert "以后回答简短点" in prompt and "助手" in prompt


def test_capture_is_idempotent_across_turns(tmp_path: Path) -> None:
    """**同一件事不反复写**：第二轮的同一轮对话不该再多写一行。

    这道防线有两层：提示词里把已有条目给模型看（让它自己别重复），
    以及机械比对兜底（模型并不总是听话）。这里测的是第二层——
    假模型**故意**把同一条再说一遍。
    """
    chat = _FakeChat(
        "- 用户偏好简短回答，先说结论",
        "- 用户偏好简短回答，先说结论",
    )
    service = _service(tmp_path, ask=chat)

    first = service.capture(_TURN, session_id="conv_1")
    second = service.capture(_TURN, session_id="conv_2")

    assert first["created"] is True
    assert second["created"] is False, "同一条内容第二次不该再写"
    body = _day_path(service).read_text(encoding="utf-8")
    assert body.count("用户偏好简短回答") == 1


def test_capture_skips_a_paraphrase_of_an_existing_entry(tmp_path: Path) -> None:
    """换了语序/换了个词的同一句话也算重复（``_similar`` 的二元组判据）。"""
    chat = _FakeChat(
        "- 设备名是 nas，地址是 192.168.1.10",
        "- 地址是 192.168.1.10，设备名是 nas",
    )
    service = _service(tmp_path, ask=chat)

    service.capture(_TURN, session_id="conv_1")
    again = service.capture(_TURN, session_id="conv_2")

    assert again["created"] is False


def test_capture_writes_nothing_when_the_model_finds_nothing(tmp_path: Path) -> None:
    """没有值得记的**也是一次正常结果**（``created=false``），不是错误。

    模型偶尔会回一句散文（"这轮没有值得记的"）——那不能被当成一条记忆写进去。
    """
    service = _service(tmp_path, ask=_FakeChat("这一轮没有值得记的内容。"))

    result = service.capture(_TURN, session_id="conv_1")

    assert result["created"] is False
    assert result["path"] == ""
    assert not _day_path(service).exists()


def test_capture_appends_to_an_existing_day_file(tmp_path: Path) -> None:
    """同一天第二次沉淀是**追加**，不是覆盖（当天的现场只增不改）。"""
    service = _service(tmp_path, ask=_FakeChat("- 第一条事实"))
    service.capture(_TURN, session_id="conv_1")
    service.capture(_TURN, session_id="conv_2")  # 第二次没有新条目
    other = _service(tmp_path, ask=_FakeChat("- 第二条事实"))
    other.capture(_TURN, session_id="conv_2")

    body = _day_path(service).read_text(encoding="utf-8")
    assert "- 第一条事实" in body and "- 第二条事实" in body


def test_capture_drops_overlong_entries(tmp_path: Path) -> None:
    """超过单条上限的**丢掉而不是截断**：半条记忆会被当成完整事实读，比没有更糟。"""
    service = _service(tmp_path, ask=_FakeChat(f"- {'字' * 501}\n- 短的那条"))

    service.capture(_TURN, session_id="conv_1")

    body = _day_path(service).read_text(encoding="utf-8")
    assert "短的那条" in body
    assert "字" * 501 not in body


def test_capture_caps_how_many_entries_one_turn_can_write(tmp_path: Path) -> None:
    service = _service(tmp_path, ask=_FakeChat("\n".join(f"- 事实 {index}" for index in range(9))))

    result = service.capture(_TURN, session_id="conv_1")

    assert result["created"] is True
    assert len(result["entries"]) == 5


def test_capture_rejects_messages_without_role_or_content(tmp_path: Path) -> None:
    service = _service(tmp_path, ask=_FakeChat("- 甲"))

    with pytest.raises(InvalidRequestError, match="缺少 role / content"):
        service.capture([{"role": "user"}], session_id="conv_1")


def test_capture_requires_a_session_id(tmp_path: Path) -> None:
    """``session_id`` 是溯源锚点：没有它，"这条记忆是哪次对话来的"就查不到了。"""
    service = _service(tmp_path, ask=_FakeChat("- 甲"))

    with pytest.raises(InvalidRequestError, match="session_id"):
        service.capture(_TURN, session_id="  ")


def test_capture_rejects_empty_messages(tmp_path: Path) -> None:
    with pytest.raises(InvalidRequestError, match="没有可沉淀的消息"):
        _service(tmp_path, ask=_FakeChat("- 甲")).capture([], session_id="conv_1")


def test_capture_still_needs_the_switch(tmp_path: Path) -> None:
    """自动沉淀**仍然要开关**：它是一次真实的模型调用，
    不打招呼就烧 token 是这一层最不该有的默认。"""
    service = _service(tmp_path, ask=_FakeChat("- 甲"), **{"memory.enabled": "false"})

    with pytest.raises(InvalidRequestError, match="未启用"):
        service.capture(_TURN, session_id="conv_1")


def test_capture_reports_a_missing_chat_model(tmp_path: Path) -> None:
    """没配对话模型时**明确报错**（由队列去重试），不静默什么都不做——
    静默的后果是"记忆开着却什么都没记住"，那是最难查的一类症状。"""
    service = _service(tmp_path)  # 不给 ask，用的是 runtime.llm() 那条路

    with pytest.raises(InvalidRequestError, match="没有配置对话模型"):
        service.capture(_TURN, session_id="conv_1")


# ------------------------------------------------------------------ 去重判据


def test_similar_catches_rewrites_but_not_new_facts() -> None:
    """去重判据的**两侧**都要钉住：同一句话的改写要拦，新信息不能拦。

    阈值定得偏高（0.7）与"包含关系最多只多 6 个字"（``CONTAINMENT_SLACK``）是
    故意偏保守的：漏过一条重复看得见（用户扫一眼文件就能删），
    误判"新事实 = 旧条目"会静默丢掉一条真事实，而**这一轮没有整理机制**
    把新信息并进旧条目——拦下来就等于丢了。两者不对等。
    """
    # 只差标点/空白：同一句
    assert _similar("设备名是 nas", "设备名是 nas。")
    # 同一句话的标点级补充：多两个字，算重复
    assert _similar("设备名是 nas", "设备名是 nas 那台")
    # 语序调换的同一句话：二元组够像，算重复
    assert _similar("设备名是 nas，地址是 10.0.0.1", "地址是 10.0.0.1，设备名是 nas")
    # **补了半句的新信息不拦**：没有整理机制去合并，拦下来就是丢信息
    assert not _similar("设备名是 nas", "设备名是 nas，地址是 192.168.1.10")
    # 不同的事实：不能拦
    assert not _similar("设备名是 nas", "用户偏好简短回答")
    # **数字变了就是另一件事**：短句上"只差两个字"的相似度天然很高，
    # 没有这条否决，新版本（kylab → kylab2）会被静默丢掉
    assert not _similar("项目代号叫 kylab", "项目代号叫 kylab2 代")
    assert not _similar("订阅端口是 2333", "订阅端口改成 3333")


def test_fingerprint_and_normalize_ignore_formatting_only() -> None:
    assert _fingerprint("设备名是 nas。") == _fingerprint("设备名是nas")
    assert _normalize("- 甲 #x") == _normalize("- 甲 #y")
    assert _normalize("- 甲") != _normalize("- 乙")


def test_select_new_only_accepts_bullet_lines() -> None:
    """解析只认带项目符号/编号的行：模型回散文时结果就是"没有新条目"。"""
    fresh = _select_new("好的，我挑出了两条：\n- 甲\n2. 乙\n（以上）", [])

    assert fresh == ["甲", "乙"]


# --------------------------------------------------------------------- 节流


class _FakeMeta:
    def __init__(self) -> None:
        self.tasks: list[object] = []

    def enqueue_task(self, record: object) -> None:
        self.tasks.append(record)


class _FakeStores:
    def __init__(self) -> None:
        self.meta = _FakeMeta()


def _service_with_stores(tmp_path: Path, **values: str) -> tuple[MemoryService, _FakeStores]:
    stores = _FakeStores()
    values.setdefault("memory.enabled", "true")
    service = MemoryService(
        _FakeRuntime({"memory.workspace": "memory", **values}),  # type: ignore[arg-type]
        tmp_path,
        stores=stores,  # type: ignore[arg-type]
    )
    return service, stores


def test_capture_is_throttled_to_every_n_turns(tmp_path: Path) -> None:
    """节流是"每 N 个用户回合沉淀一次"。一次沉淀就是一次模型调用，不能每轮都来。"""
    service, stores = _service_with_stores(tmp_path, **{"memory.capture_every": "3"})

    for turn in (1, 2):
        assert service.enqueue_capture(_TURN, session_id="c1", turn_count=turn) is False
    assert service.enqueue_capture(_TURN, session_id="c1", turn_count=3) is True
    assert len(stores.meta.tasks) == 1


def test_capture_every_one_means_every_turn(tmp_path: Path) -> None:
    service, _stores = _service_with_stores(tmp_path, **{"memory.capture_every": "1"})

    assert service.enqueue_capture(_TURN, session_id="c1", turn_count=1) is True
    assert service.enqueue_capture(_TURN, session_id="c1", turn_count=2) is True


def test_capture_is_off_when_memory_is_disabled(tmp_path: Path) -> None:
    service, stores = _service_with_stores(
        tmp_path, **{"memory.enabled": "false", "memory.capture_every": "1"}
    )

    assert service.enqueue_capture(_TURN, session_id="c1", turn_count=1) is False
    assert stores.meta.tasks == []


def test_capture_without_stores_is_a_noop(tmp_path: Path) -> None:
    """没接存储时不入队、也不报错——recall / remember / 注入都不需要数据库，
    测试与脚本因此可以轻量构造。"""
    service = _service(tmp_path, **{"memory.capture_every": "5"})

    assert service.enqueue_capture(_TURN, session_id="c1", turn_count=5) is False


def test_capture_every_falls_back_when_the_setting_is_garbage(tmp_path: Path) -> None:
    service, _stores = _service_with_stores(tmp_path, **{"memory.capture_every": "abc"})

    assert service.enqueue_capture(_TURN, session_id="c1", turn_count=5) is True


# --------------------------------------------------------------------- 注入


def test_prompt_block_frames_soul_and_memory_separately(tmp_path: Path) -> None:
    """人格与记忆分开写，且**标明记忆来自过去的对话**。

    不标注来源的话模型会把记忆当成"用户这一轮说的话"——而记忆可能已经过时，
    用户当下说的才是准的。所以块里带一句"冲突时以用户当下为准"。
    """
    service = _service(tmp_path)
    service.remember("用户偏好简短回答")
    _write(service.workspace, SOUL_FILE, "你说话直接，不寒暄。")

    block = service.prompt_block()

    assert "SOUL.md" in block and "你说话直接" in block
    assert "MEMORY.md" in block and "用户偏好简短回答" in block
    assert "以用户当下为准" in block, "没有出处说明，模型会把它当成用户刚说的话"


def test_prompt_block_is_empty_without_files(tmp_path: Path) -> None:
    assert _service(tmp_path).prompt_block() == ""


def test_prompt_block_still_works_when_disabled(tmp_path: Path) -> None:
    """**关掉记忆，文件照旧注入**（这条原先断言的是相反的行为）。

    那个开关管的是"过去的对话会不会被召回、会不会自动沉淀"，而
    `MEMORY.md` / `SOUL.md` 是磁盘上的普通文件——`memory_files` 的模块头
    自己就写着"看自己的文本文件不该先要求另一个进程活着"。

    实测逼出来的：用户的实例上记忆是关的，于是人设既不播种也不注入，
    整个功能是死的，界面上还写着"没启用"。
    """
    service = _service(tmp_path, **{"memory.enabled": "false"})
    _write(service.workspace, CORE_MEMORY_FILE, "- 有内容")

    block = service.prompt_block()

    assert "有内容" in block
    assert "长期记忆" in block


# ------------------------------------------------- 铺模板并且不被记忆挤掉


def test_remember_keeps_the_sections_own_prose(tmp_path: Path) -> None:
    """那条"记什么、别记什么"的说明**不能被第一条记忆挤掉**。

    它是从 QwenPaw 的 MEMORY.md 照抄来的，里面有一条安全约定：
    「除非明确要求，不要记录密码、令牌或其他敏感信息」。这条规矩写在**文件里**
    才起作用（模型每轮都读到它），而第一版的重写逻辑只保留 `- ` 条目行——
    第一条记忆落盘的那一刻，这段话就被静默删掉了，且**没人会再去重新发现它**。
    """
    service = _service(tmp_path)

    service.remember("对方偏好简短的答复")

    body = (tmp_path / "memory" / CORE_MEMORY_FILE).read_text(encoding="utf-8")
    assert "不要记录密码、令牌或其他敏感信息" in body
    assert "不要把每日流水或整段会话记录复制到这里" in body
    # 条目本身也在，且没被当成"散文"留在上面
    assert "- 对方偏好简短的答复" in body
    # 再记一条：说明还在，条目累加
    service.remember("项目代号叫 kylab")
    body = (tmp_path / "memory" / CORE_MEMORY_FILE).read_text(encoding="utf-8")
    assert "不要记录密码、令牌或其他敏感信息" in body
    assert "- 对方偏好简短的答复" in body and "- 项目代号叫 kylab" in body


def test_remember_does_not_rewrite_line_endings(tmp_path: Path) -> None:
    """整份重写要**按字节写**：`write_text` 在 Windows 上会把换行改成 CRLF。

    后果不只是"文件变脏"：这份文件每次都在被 read/compare（去重、注入），
    换行在多轮之间来回翻会让 diff 与哈希都不稳定。
    """
    service = _service(tmp_path)
    service.remember("第一条")

    raw = (tmp_path / "memory" / CORE_MEMORY_FILE).read_bytes()

    assert b"\r\n" not in raw


def test_capture_does_not_rewrite_line_endings(tmp_path: Path) -> None:
    """捕获写的是当天的现场文件，同一条纪律：按字节写。"""
    service = _service(tmp_path, ask=_FakeChat("- 甲"))

    service.capture(_TURN, session_id="conv_1")

    assert b"\r\n" not in _day_path(service).read_bytes()


def test_untouched_legacy_templates_are_upgraded(tmp_path: Path) -> None:
    """**还在用旧模板的实例要能看到新模板**，改过的文件一个字也不动。

    v0.21 把三份模板换成了 QwenPaw 那套有内容的写法，而 `seed_persona` 的原则是
    "已存在的一律不动"——照字面执行的话，已经在跑的部署永远看不到新模板，
    除非用户自己去删文件（而他并不知道该删）。

    判据是**逐字节相同**：那才是"我们写下去之后没人动过"。所以第三条断言
    （只改了一个标题的文件）与第二条（真正的旧模板）必须表现不同——
    这是"宁可漏升级、不可误覆盖"的落点。
    """
    from app.services.memory import _LEGACY_TEMPLATES

    workspace = tmp_path / "memory"
    workspace.mkdir(parents=True)
    (workspace / SOUL_FILE).write_bytes(_LEGACY_TEMPLATES[SOUL_FILE].encode("utf-8"))
    (workspace / AGENTS_FILE).write_bytes(
        _LEGACY_TEMPLATES[AGENTS_FILE].replace("## 工作方式", "## 我自己的工作方式").encode()
    )
    service = _service(tmp_path)

    service.seed_persona()

    # 旧模板 → 换成新的（有内容的那份）
    assert "真心帮忙" in (workspace / SOUL_FILE).read_text(encoding="utf-8")
    # 动过一个字的 → 原样不动
    assert "我自己的工作方式" in (workspace / AGENTS_FILE).read_text(encoding="utf-8")
    # 缺的那份照旧补上
    assert (workspace / PROFILE_FILE).exists()
    # 幂等：第二次没有可升级的
    assert service.seed_persona() == []


# ------------------------------------------------- 铺模板（v0.1.1，§12.224 第 12 条）
#
# 容器里"长期记忆不生效"里属于**文件那一半**的验收是：新实例起来后
# 「记忆」页就可写、重启后内容还在。所以模板要一次性铺全（含 MEMORY.md）、
# 幂等、且**不看 memory.enabled**——那开关管的是召回与自动沉淀，不是这几个文件。


def test_seed_persona_lays_down_all_four_files(tmp_path: Path) -> None:
    """四份都铺：SOUL / PROFILE / AGENTS / **MEMORY.md**（最后一份是 v0.1.1 加的）。

    没有 MEMORY.md 的话，新部署的「记忆」页上看不到核心记忆文件——而它恰恰是
    这一层最该被用户看见、拿去改的那份（原先它只在第一次 ``remember`` 时才出现）。
    """
    service = _service(tmp_path)

    created = service.seed_persona()

    assert sorted(created) == sorted([SOUL_FILE, PROFILE_FILE, AGENTS_FILE, CORE_MEMORY_FILE])
    # 幂等：第二次一个都不新建
    assert service.seed_persona() == []
    body = (tmp_path / "memory" / CORE_MEMORY_FILE).read_text(encoding="utf-8")
    assert "## 核心长期记忆" in body
    assert "## 工具设置" in body and "## 重要决策与经验" in body


def test_the_memory_file_is_seeded_even_when_the_switch_is_off(tmp_path: Path) -> None:
    """**关着也铺**：容器里"记忆页可写"不该依赖用户先去设置页把开关打开
    （浏览与编辑那几个文件本来就不走那道闸，见 ``services/memory.py`` 的说明）。"""
    service = _service(tmp_path, **{"memory.enabled": "false"})

    created = service.seed_persona()

    assert CORE_MEMORY_FILE in created
    assert (tmp_path / "memory" / CORE_MEMORY_FILE).exists()


def test_remember_writes_into_the_seeded_memory_file(tmp_path: Path) -> None:
    """先铺模板、再记住：第一条记忆要落进那一节，模板的说明与其余小节都还在。

    这条钉的是"新加的铺模板"与既有的重写逻辑**接得上**——铺下去的那份必须与
    ``_write_entries`` 在"文件不存在"时的兜底一致，否则第一条记忆落盘会走另一条
    分支，很容易把那段"别记密码/令牌"的说明或「工具设置」那几节弄丢。
    """
    service = _service(tmp_path)
    service.seed_persona()

    service.remember("设备名是 nas")

    body = (tmp_path / "memory" / CORE_MEMORY_FILE).read_text(encoding="utf-8")
    assert "- 设备名是 nas" in body
    assert "不要记录密码、令牌或其他敏感信息" in body
    assert "## 工具设置" in body and "## 重要决策与经验" in body
