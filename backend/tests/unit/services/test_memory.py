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
from app.services import memory as memory_service
from app.services import memory_files
from app.services.llm import LLMConfig
from app.services.memory import (
    AGENTS_FILE,
    CORE_MEMORY_FILE,
    LINK_MAX,
    PROFILE_FILE,
    SOUL_FILE,
    MemoryService,
    _append_see_also,
    _capture_headline,
    _dream_slug,
    _fingerprint,
    _normalize,
    _parse_dream,
    _select_new,
    _similar,
)
from app.services.memory_files import MemoryMatch


class _FakeRuntime:
    """只实现 MemoryService 用到的那几个读接口。"""

    def __init__(self, values: dict[str, str], llm: LLMConfig | None = None) -> None:
        self._values = values
        self._llm = llm

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

    def get_float(self, key: str) -> float:
        """同上（``memory.vector_min_score`` 用的是它）。"""
        try:
            return float(self.get(key))
        except ValueError:
            return 0.0

    def llm(self) -> LLMConfig:
        """没绑定对话模型的那个快照（``is_configured`` 为假）。

        捕获那条路要用它；给一个"没配模型"的替身，才能测到那条明确报错的路径
        （真实现里这个快照来自注册表，见 ``RuntimeConfigService.llm``）。
        要测"真的走到模型通道"时（比如思考开关），构造时传一份配置好的进来。
        """
        return self._llm or LLMConfig(base_url="", api_key="", model_id="")


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


def _service(tmp_path: Path, *, ask=None, embed=None, **values: str) -> MemoryService:
    base = {"memory.enabled": "true", "memory.workspace": "memory"}
    base.update(values)
    return MemoryService(_FakeRuntime(base), tmp_path, ask=ask, embed=embed)  # type: ignore[arg-type]


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
    """``remember`` 不看那道闸（§7.3）：它写的是档案，而**档案编辑不看开关**
    ——"关了也能改自己的东西"这条纪律保留。

    对照：``recall`` 在关着时仍然明确报错（它代表"档案进不进这一轮的上下文"）。
    """
    service = _service(tmp_path, **{"memory.enabled": "false"})

    result = service.remember("用户偏好先给结论")
    assert result.action == "added"
    with pytest.raises(InvalidRequestError, match="未启用"):
        service.recall("偏好")


def test_archive_block_is_empty_when_disabled_instead_of_raising(tmp_path: Path) -> None:
    """注入是"有就带上"：没启用（或档案还空着）时返回空串，不让对话失败。"""
    service = _service(tmp_path, **{"memory.enabled": "false"})
    service.remember("用户偏好先给结论")

    assert service.archive_block() == ""
    assert service.archive_text(), "档案本身照旧可读可写——那道闸只管注入与 recall"


# --------------------------------------------------------------------- 记住
#
# 写入走 `archive.ArchiveService`（分区、预算、顶替、变更流），本层只做
# "门面"那部分：开关、归区、把回执原样交出去。这一组钉的是**门面这一侧**的行为。


def test_remember_creates_the_archive_with_four_fixed_sections(tmp_path: Path) -> None:
    service = _service(tmp_path)

    result = service.remember("用户偏好先给结论")

    assert result.action == "added"
    assert result.section == "长期偏好与风格", "归区按内容走（词表与迁移共用一处）"
    body = (tmp_path / "memory" / PROFILE_FILE).read_text(encoding="utf-8")
    for title in ("身份与称呼", "长期偏好与风格", "进行中的项目", "工具与环境"):
        assert f"## {title}" in body
    assert "- 用户偏好先给结论" in body


def test_remember_is_idempotent(tmp_path: Path) -> None:
    service = _service(tmp_path)
    service.remember("用户偏好先给结论")

    again = service.remember("用户偏好先给结论")

    assert again.action == "existing"
    assert "已经有了" in again.receipt
    body = (tmp_path / "memory" / PROFILE_FILE).read_text(encoding="utf-8")
    assert body.count("用户偏好先给结论") == 1


def test_remember_honours_an_explicit_section(tmp_path: Path) -> None:
    """模型看得见整份档案，所以它可以指定分区；**分区名不认识时按内容归区**
    而不是拒掉这一笔（分区名不该成为一次写入失败的原因）。"""
    service = _service(tmp_path)

    tool = service.remember("用户的内网有一台 L20", section="工具与环境")
    assert tool.section == "工具与环境"

    fallback = service.remember("用户叫小又", section="身份")  # 是旧叫法，不是分区名
    assert fallback.section == "身份与称呼"


def test_remember_replaces_in_one_call(tmp_path: Path) -> None:
    """`replaces` 让"更正"**一次调用**完成（§4.3）：旧值进变更流、档案里是新值。

    这条对整个设计很关键：没有它就退化成"先忘掉、再记住"两次，而中间那一刻
    档案里是**没有这条**的——用户如果刚好在那时问一句，答案是错的。
    """
    service = _service(tmp_path)
    service.remember("用户要求回答简短", section="长期偏好与风格")

    result = service.remember(
        "用户要求回答先给结论、再列依据",
        section="长期偏好与风格",
        replaces="用户要求回答简短",
    )

    assert result.action == "replaced"
    assert result.replaced == "用户要求回答简短"
    body = service.archive_text()
    assert "用户要求回答先给结论" in body
    assert "用户要求回答简短" not in body, "被顶替的那条不该同时留着"
    # 旧值逐字留在变更流里（可还原）
    assert "用户要求回答简短" in (tmp_path / "memory" / "changes.md").read_text(encoding="utf-8")


def test_remember_appends_after_existing_entries(tmp_path: Path) -> None:
    service = _service(tmp_path)
    service.remember("第一条", section="长期偏好与风格")

    service.remember("第二条", section="长期偏好与风格")

    assert len(service.archive_entries()) == 2
    body = service.archive_text()
    assert body.index("- 第一条") < body.index("- 第二条")


def test_remember_rejects_content_that_is_too_long(tmp_path: Path) -> None:
    """超长**由服务层以回执拒绝**（不是抛错）：回执里要给两条出路。

    它与协议层那道 500 字的粗护栏不是一回事——那个是"别白读一遍"，这个是设计本身
    （§3.3：档案每轮进上下文，一条必须是一句话）。
    """
    result = _service(tmp_path).remember("字" * 121)

    assert result.action == "rejected"
    assert "最多 120 字" in result.receipt
    assert "AGENTS.md" in result.receipt, "要给出路"


def test_remember_rejects_sensitive_content_without_leaving_a_trace(tmp_path: Path) -> None:
    """敏感信息**连变更流都不进**：留痕本身就是泄漏（§4.2 的否决项）。"""
    result = _service(tmp_path).remember("用户的 api key 是 sk-abcdefghijklmno")

    assert result.action == "rejected"
    changes = tmp_path / "memory" / "changes.md"
    assert not changes.exists() or "sk-abc" not in changes.read_text(encoding="utf-8")


def test_remember_rejects_blank_content(tmp_path: Path) -> None:
    with pytest.raises(InvalidRequestError, match="缺少参数"):
        _service(tmp_path).remember("   ")


def test_forget_removes_the_entry_and_keeps_a_restorable_trace(tmp_path: Path) -> None:
    service = _service(tmp_path)
    service.remember("用户偏好先给结论", section="长期偏好与风格")

    result = service.forget("用户偏好先给结论")

    assert result.action == "forgotten"
    assert "忘掉了" in result.receipt
    assert service.archive_entries() == ()
    assert "用户偏好先给结论" in (
        tmp_path / "memory" / "changes.md"
    ).read_text(encoding="utf-8")


def test_forget_accepts_a_topic_and_refuses_to_guess(tmp_path: Path) -> None:
    """``forget`` 的入参是**话题**，所以先按原样找、再按唯一子串兜一次；
    对得上不止一条时**不猜**，把候选列回来。"""
    service = _service(tmp_path)
    service.remember("用户要求先给结论", section="长期偏好与风格")
    service.remember("项目代号叫 kylab", section="进行中的项目")

    unique = service.forget("先给结论")
    assert unique.action == "forgotten"
    assert unique.text == "用户要求先给结论"

    missing = service.forget("合唱团的排练安排")
    assert missing.action == "rejected"
    assert missing.reason == "missing"


def test_forget_refuses_an_ambiguous_topic(tmp_path: Path) -> None:
    """一句话对得上两条时列候选——删错的代价与多问一句完全不对等。"""
    service = _service(tmp_path)
    service.remember("项目代号叫 kylab", section="进行中的项目")
    service.remember("项目目标是 11 月交付", section="进行中的项目")

    result = service.forget("项目")

    assert result.action == "rejected"
    assert result.reason == "ambiguous"
    assert "kylab" in result.receipt and "11 月交付" in result.receipt
    assert len(service.archive_entries()) == 2, "一条都不许删"


# --------------------------------------------------------------------- 召回
#
# **池子只有变更流**（§5.3）：档案本身每轮已经全量注入，再召回一次就是把同一段
# 内容进两次上下文。所以这一组钉两件相反的事：**改过的事要查得到（带行号）**、
# **没改过的事与档案条目一律查不到**。

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

_SEED_CHANGES = """- 2026-10-01 09:20 · 新增 · 长期偏好与风格 · 来源：显式
  - 新：用户要求回答先给结论，再列依据。
- 2026-10-02 14:05 · 顶替 · 进行中的项目 · 来源：显式
  - 旧：项目代号叫 kylab。
  - 新：项目代号叫 kylab2，11 月交付。
- 2026-10-03 08:00 · 忘掉 · 工具与环境 · 来源：界面
  - 旧：用户的内网有一台 L20。
"""


def _no_jieba(monkeypatch: pytest.MonkeyPatch) -> None:
    """让 ``import jieba`` 真的失败（抛的是**真** ``ModuleNotFoundError``）。

    两件事都得做：拦住 import（``sys.meta_path`` 里插一个只拒 jieba 的 finder），
    以及**清掉分词器缓存**（``coverage._JIEBA``）——上一个用例可能已经把它导进来了。
    """
    import sys

    from app.services.retrieval import coverage

    class _NoJieba:
        def find_spec(self, name, path=None, target=None):  # type: ignore[no-untyped-def]
            if name == "jieba" or name.startswith("jieba."):
                raise ModuleNotFoundError(f"No module named {name!r}", name=name)
            return None

    monkeypatch.setattr(coverage, "_JIEBA", None)
    monkeypatch.setattr(sys, "meta_path", [_NoJieba(), *sys.meta_path])


def test_recall_works_when_jieba_is_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """**缺 jieba 的运行时里 recall 照常工作**（打包后的桌面端就是那种运行时）。

    这条用例的口径在期二随池子换过一次，理由要说清：它原先钉的是
    "``memory_files.search`` 的分词通道失败时降级到字对通道"——而 recall 现在
    **根本不走那条路**（池子只剩变更流，排序是纯字面的二元组覆盖率，见 §5.3）。
    留着的意义因此变成**回归护栏**：谁哪天把分词（或向量、或 ``memory_files``）
    再接回 recall，这条就会红——那种接法会让桌面端重新出现"一召回就炸"。

    标 ``local``：它证明的恰恰是**没有 jieba 的那台机器**上的行为，
    而它只用临时目录与假 runtime，不该因为缺 PG 被跳过。
    """
    service = _service(tmp_path)
    _seed(service)
    _no_jieba(monkeypatch)
    # 那个标记是**进程级**的（一台机器上"有没有 jieba"不会变），用例自己擦干净
    monkeypatch.setattr(memory_files, "_SEGMENTATION_MISSING", False)

    hits, _links = service.recall("项目代号叫什么")

    assert hits, "缺 jieba 不该把 recall 整条打掉"
    assert hits[0].path == "changes.md"
    # 连分词器都没被问过：`_SEGMENTATION_MISSING` 是"试过一次、它不在"的标记，
    # 而 recall 现在根本不走那条通道（这正是这条用例的意义）
    assert memory_files.segmentation_unavailable() is False

    from app.api.v1.memory import RECALL_NOTE as api_note
    from app.services.tools import _recall_note as tool_note

    # **两处的说明都不再提分词**：池子只有几十到几百条记录，谁也没走分词那条通道，
    # 再挂一句"召回质量受影响"就是描述一个不存在的机制
    assert memory_files.SEGMENTATION_UNAVAILABLE_NOTE not in api_note
    assert memory_files.SEGMENTATION_UNAVAILABLE_NOTE not in tool_note()


def _seed(service: MemoryService) -> Path:
    """铺一个像样的工作区：一份档案 + 一份变更流（外加 daily/digest 各一份）。

    daily 与 digest 那两份**故意留着**：它们曾经是召回池，现在不是了——
    下面有用例钉"它们不再被 recall 返回"（池子换了，不是全都招不到）。
    """
    workspace = service.workspace
    _write(workspace, "digest/personal/锂价.md", _SEED_DIGEST)
    _write(workspace, "daily/2026-09-24.md", _SEED_DAILY)
    _write(
        workspace,
        PROFILE_FILE,
        "---\nupdated: 2026-10-03\n---\n\n# 用户档案\n\n## 身份与称呼\n\n"
        "- 用户叫小又，称呼「小又」即可。\n\n## 长期偏好与风格\n\n"
        "- 用户要求回答先给结论，再列依据。\n",
    )
    _write(workspace, "changes.md", _SEED_CHANGES)
    return workspace


def test_recall_finds_a_changed_entry_with_a_real_line_range(tmp_path: Path) -> None:
    """命中的证据是**文件 + 行号区间**：用户拿着它就能去看那次改动。

    行号必须是**文件里的真实行号**（这一条记录的头一行），不是"记录里的第几行"。
    """
    service = _service(tmp_path)
    _seed(service)

    hits, _links = service.recall("项目代号叫什么")

    assert hits, "这条改动就在变更流里，必须能查到"
    top = hits[0]
    assert top.path == "changes.md"
    # 第二条记录：第一条占 2 行（头 + 「新：」），所以它从第 3 行开始、到第 5 行结束
    assert (top.start_line, top.end_line) == (3, 5)
    assert "kylab2" in top.text and "11 月交付" in top.text
    assert top.score > 0


def test_recall_refuses_a_noise_query(tmp_path: Path) -> None:
    """查不到就返回空——只有一个含义：**变更流里确实没有相关的话**。"""
    service = _service(tmp_path)
    _seed(service)

    assert service.recall("合唱团的排练时间安排")[0] == []
    assert service.recall("今天天气怎么样")[0] == []


def test_recall_pool_excludes_archive_entries_already_injected(tmp_path: Path) -> None:
    """§9.2 第 7 条：**已经注入的档案条目不再被召回返回**。

    档案每轮整份进上下文，再召回一遍等于同一段内容进两次——而且它会让模型
    以为"这是查出来的证据"，而不是"我本来就知道的设定"。
    """
    service = _service(tmp_path)
    _seed(service)

    hits, _links = service.recall("用户叫小又，称呼「小又」即可")
    assert hits == [], "档案里的条目不在召回池里"

    # 反向确认：变更流里那条**确实**能查到（池子不是空的，是换了个池子）
    assert service.recall("先给结论，再列依据")[0]


def test_recall_pool_is_not_the_daily_or_digest_layer(tmp_path: Path) -> None:
    """daily / digest 那一层**不再进召回池**（§5.3）。

    它们仍在工作区里（期五才清理），但 recall 已经不吃它们了——
    这条与上一条一起把"池子换了"钉死：不是检索坏了，是换了池子。
    """
    service = _service(tmp_path)
    _seed(service)

    assert service.recall("锂价下跌对毛利的影响")[0] == []
    assert service.recall("发布前必须先跑一遍后端门禁脚本")[0] == []


def test_recall_never_returns_document_pool_content(tmp_path: Path) -> None:
    """两池红线（§9.2 第 8 条）：``recall`` 的池子是**这个工作区的变更流**，
    它不 import 检索服务、不碰 pgvector、也看不到任何文档片段。"""
    service = _service(tmp_path)
    _seed(service)

    hits, _links = service.recall("知识库原文里的那段话")

    assert hits == []
    assert all(hit.path == "changes.md" for hit in service.recall("项目代号")[0])


def test_recall_clamps_the_limit(tmp_path: Path) -> None:
    """上限生效，否则会把上下文塞爆（与检索工具同一口径）。"""
    service = _service(tmp_path)
    workspace = service.workspace
    _write(
        workspace,
        "changes.md",
        "".join(
            f"- 2026-10-01 09:0{index} · 新增 · 长期偏好与风格 · 来源：显式\n"
            f"  - 新：偏好记录 {index} 号\n"
            for index in range(30)
        ),
    )

    hits, _links = service.recall("偏好记录", limit=9999)

    assert len(hits) == 20


def test_recall_is_empty_when_there_is_no_changelog(tmp_path: Path) -> None:
    """没有变更流时返回空——那是"还没有改过什么"，不是出错。"""
    service = _service(tmp_path)
    _write(service.workspace, PROFILE_FILE, "---\nupdated: 2026-10-03\n---\n\n- 项目代号叫 kylab\n")

    hits, links = service.recall("项目代号")

    assert hits == [] and links == []


def test_recall_raises_when_the_query_is_empty(tmp_path: Path) -> None:
    with pytest.raises(InvalidRequestError, match="query"):
        _service(tmp_path).recall("   ")


def test_recall_does_not_use_the_vector_route(tmp_path: Path) -> None:
    """**向量那一路不参与 recall**（§5.3）：池子只有几十到几百条记录，
    排序是纯字面判据——不建索引、不嵌任何东西。

    这条同时挡住"顺手把 recall 又接回记忆索引"：那样每次查询都要赌一次
    嵌入延迟，而换来的精度在一个几十条的池子上没有意义。
    """

    def _boom(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("recall 不该去碰嵌入/向量那一路")

    service = MemoryService(  # type: ignore[arg-type]
        _FakeRuntime(
            {
                "memory.enabled": "true",
                "memory.workspace": "memory",
                # 开关打开也没用：recall 那一侧根本不问它（下面那个 embed 会炸）
                "memory.vector_enabled": "true",
            }
        ),
        tmp_path,
        embed=_boom,
    )
    _seed(service)

    hits, _links = service.recall("项目代号叫什么")

    assert hits, "关掉向量那一路不影响查变更流"


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
    # 档案 + 变更流 + digest + daily = 4 份（`PROFILE.md` 与 `changes.md` 是期二
    # 新写进来的两份；`daily`/`digest` 那一层还在盘上，等期五清理）
    assert status.file_count == 4
    assert status.retrievable_count == 2
    # 那个数字数的仍是**旧召回池**（daily/digest）的切块数：digest 2 块 + daily 2 块。
    # 期二没有改它的口径——它随整个统计一起等期五（那时 daily/digest 退场，
    # 界面上这个数字也跟着换）。
    assert status.entry_count == 4
    assert status.core_file_exists is False, "MEMORY.md 退场：新部署不再有这份文件"
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


def _day(service: MemoryService) -> str:
    return datetime.now().strftime("%Y-%m-%d")


def _day_path(service: MemoryService) -> Path:
    """**当天索引页**（``daily/<日期>.md``）——它列出当天各条会话笔记。"""
    return service.workspace / "daily" / f"{_day(service)}.md"


def _day_dir(service: MemoryService) -> Path:
    """当天各条**会话笔记**所在的目录（``daily/<日期>/``）。"""
    return service.workspace / "daily" / _day(service)


def _all_notes(service: MemoryService) -> str:
    """当天全部会话笔记拼起来（测试多半只关心"一共写了几次"）。"""
    directory = _day_dir(service)
    if not directory.is_dir():
        return ""
    return "\n".join(
        item.read_text(encoding="utf-8") for item in sorted(directory.glob("*.md"))
    )


def test_capture_writes_new_entries_into_todays_daily_file(tmp_path: Path) -> None:
    """捕获落 **daily**（设计文档 §1 的两层分工）：``MEMORY.md`` 是每轮整份注入的
    核心记忆，自动沉淀直接写进去等于机器替人决定"什么该长期占着上下文窗口"。

    落点是**这个会话当天的那一条笔记**（``daily/<日期>/<会话>.md``），来源会话
    既进 frontmatter（用来认领这份笔记）也留一行 HTML 注释（渲染时看不见）。
    """
    chat = _FakeChat("- 用户偏好简短回答，先说结论\n- 回复不要长篇大论")
    service = _service(tmp_path, ask=chat)

    result = service.capture(_TURN, session_id="conv_1")

    assert result["created"] is True
    assert result["path"].startswith(f"daily/{_day(service)}/")
    body = (service.workspace / result["path"]).read_text(encoding="utf-8")
    assert "- 用户偏好简短回答，先说结论" in body
    assert "- 回复不要长篇大论" in body
    assert "conv_1" in body
    # 当天索引页把这条笔记列出来，而且链的是**真实存在**的那一份
    assert f"[[{result['path']}]]" in _day_path(service).read_text(encoding="utf-8")
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
    # 数**条目行**而不是那句话：新笔记的 summary 取自第一条，所以同一句话在
    # 文件里本来就有两处（frontmatter 一次、条目一次）。
    assert _all_notes(service).count("- 用户偏好简短回答") == 1


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


def test_capture_keeps_one_note_per_session(tmp_path: Path) -> None:
    """**一个会话一天一条笔记**：同一天再沉淀是续写那一条，不是另起一份。

    这是这一层从"只增不并"里走出来的那一步。原先所有会话往同一个平铺文件尾部
    追加，既分不清哪些条目属于哪次对话、也没有地方可以"更新"，于是只能越堆越长。
    照 QwenPaw 的 Auto-Memory：认领的键是 frontmatter 里的 ``session_id``
    （精确相等），**不靠内容相似度去猜**。
    """
    service = _service(tmp_path, ask=_FakeChat("- 第一条事实"))
    service.capture(_TURN, session_id="conv_1")

    # 同一会话、同一天，第二次沉淀 → 还是那一份笔记，只是多了一行
    again = _service(tmp_path, ask=_FakeChat("- 第二条事实"))
    again.capture(_TURN, session_id="conv_1")
    notes = sorted(_day_dir(service).glob("*.md"))
    assert len(notes) == 1
    body = notes[0].read_text(encoding="utf-8")
    assert "- 第一条事实" in body and "- 第二条事实" in body

    # 另一个会话 → 另一份笔记；当天索引页把两条都列出来
    other = _service(tmp_path, ask=_FakeChat("- 别的会话的事"))
    other.capture(_TURN, session_id="conv_2")

    assert len(sorted(_day_dir(service).glob("*.md"))) == 2
    assert _day_path(service).read_text(encoding="utf-8").count("[[daily/") == 2


def test_capture_does_not_wipe_a_flat_day_file_from_an_older_version(
    tmp_path: Path,
) -> None:
    """升级不抹记忆：**旧的平铺当天文件**（条目直接写在 ``daily/<日期>.md`` 里）
    必须原样留着，索引区块只追加。

    老部署里那些条目是用户看得到、也改得过的记忆。重建整份索引页会把它们删掉，
    而"升级把记忆弄没了"是这一层最不可接受的失败。
    """
    service = _service(tmp_path, ask=_FakeChat("- 新沉淀的事实"))
    _day_path(service).parent.mkdir(parents=True, exist_ok=True)
    _day_path(service).write_bytes("# 老格式\n\n- 老版本记下的事实\n".encode())

    service.capture(_TURN, session_id="conv_1")

    index = _day_path(service).read_text(encoding="utf-8")
    assert "- 老版本记下的事实" in index
    assert "- [[daily/" in index


def test_capture_drops_overlong_entries(tmp_path: Path) -> None:
    """超过单条上限的**丢掉而不是截断**：半条记忆会被当成完整事实读，比没有更糟。"""
    service = _service(tmp_path, ask=_FakeChat(f"- {'字' * 501}\n- 短的那条"))

    service.capture(_TURN, session_id="conv_1")

    body = _all_notes(service)
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
        self.settings: dict[str, str] = {}

    def enqueue_task(self, record: object) -> None:
        self.tasks.append(record)

    def get_setting(self, key: str) -> str | None:
        return self.settings.get(key)

    def set_setting(self, key: str, value: str) -> None:
        self.settings[key] = value


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


def test_implicit_capture_never_fires_from_the_turn_flow(tmp_path: Path) -> None:
    """§9.2 第 9 条：**捕获路径一次模型都不调**（旧定时捕获已废）。

    期二把"每 N 个用户回合判一次"整条退场了（§4.1：它花的是固定节奏的钱），
    所以 `enqueue_capture` 恒 False、一个任务都不入队——哪怕
    ``memory.capture_every`` 设成 1、存储也接上了。

    留下的自动写入只有**期四的信号捕获**（默认关）；在那之前
    "默认配置下每轮零额外模型调用"是**结构上**成立的。
    """
    service, stores = _service_with_stores(tmp_path, **{"memory.capture_every": "1"})

    for turn in (1, 2, 3, 4, 5):
        assert service.enqueue_capture(_TURN, session_id="c1", turn_count=turn) is False

    assert stores.meta.tasks == []


def test_capture_turn_is_retired(tmp_path: Path) -> None:
    """一轮问答收尾时不再有"沉淀"这一步：`capture_turn` 恒 False，**含 ``force``**。

    ``force`` 原先服务上下文压缩那一刻（被折进摘要的内容再不记就没人记得住了）。
    它一起退场的理由：自动写入只剩期四那一条路，留一个"能绕过一切的开关"
    就等于把定时捕获又接回来——而那正是这一次要废掉的东西。
    """
    service, stores = _service_with_stores(tmp_path, **{"memory.capture_every": "1"})

    assert service.capture_turn("c1", turn_count=5) is False
    assert service.capture_turn("c1", turn_count=5, force=True) is False
    assert stores.meta.tasks == []


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


def test_capture_due_is_always_false_now(tmp_path: Path) -> None:
    """`capture_due` 是界面那一步（「交给长期记忆」）问的判据：**恒 False**。

    它必须与写侧同源（`api/v1/chat._memory_handoff_step`）：写侧不入队而它说"会"，
    界面就会报一件不会发生的事——那比不报更糟。现在两边都是 False，
    于是那一步也不会出现（期四把两边一起改回真判据）。
    """
    with_store, _meta = _capturing_service(tmp_path, **{"memory.capture_every": "1"})
    bare = _service(tmp_path)

    assert with_store.capture_due(5) is False
    assert bare.capture_due(5) is False


def test_default_config_makes_zero_extra_model_calls_per_turn(tmp_path: Path) -> None:
    """§9.2 第 1 条：**默认配置下，一轮对话的模型调用次数与记忆无关**。

    注入、显式写入（``remember``/``forget``）、``recall`` 都不新增调用——
    它们要么是纯本地读写，要么本来就在当轮的工具循环里。

    这一条**按产品默认值构造**（从 ``DEFAULTS`` 取 memory.* 那几个键），
    而不是自己发明一份配置：默认值一改，这条就会跟着改口径；要是手抄一份，
    测的就是测试自己写的配置了。

    顺带钉住 v0.56 的默认值变更（§7.3 的行为变更）：``memory.enabled`` 默认 **true**、
    ``memory.persona_files`` 只剩两份人设（档案不在那份清单里）。
    """
    from app.services.runtime_config import DEFAULTS

    assert DEFAULTS["memory.enabled"] == "true"
    assert DEFAULTS["memory.persona_files"] == "SOUL.md,AGENTS.md"

    defaults = {key: value for key, value in DEFAULTS.items() if key.startswith("memory")}
    chat = _FakeChat()  # 每被调用一次就往 `prompts` 里记一笔
    stores = _FakeStores()
    service = MemoryService(  # type: ignore[arg-type]
        _FakeRuntime(defaults), tmp_path, stores=stores, ask=chat
    )

    # 一轮对话里与记忆有关的那几件事，一件不落
    service.seed_persona()
    service.archive_block()
    service.guidance()
    service.bootstrap_block()
    service.remember("用户要求先给结论", section="长期偏好与风格")
    service.recall("先给结论")
    service.archive_block()
    service.forget("先给结论")

    assert chat.prompts == [], "这几件事一件都不该问模型"

    # 自动捕获那两条路也不许产生调用（定时捕获已废）
    assert service.capture_turn("c1", turn_count=5) is False
    assert service.capture_turn("c1", turn_count=5, force=True) is False
    assert service.enqueue_capture(_TURN, session_id="c1", turn_count=5) is False
    assert chat.prompts == []
    assert stores.meta.tasks == [], "一个记忆任务都不该入队"


# --------------------------------------------------------------------- 注入


def test_archive_block_carries_every_entry_verbatim(tmp_path: Path) -> None:
    """§9.2 第 2 条：**档案每个条目都出现在注入块里**（逐条比对，不做抽样）。

    注入是"全量、不挑选、不摘要、不排序"（§5.1）——挑一条漏一条的表现是
    "我写进去了它却不知道"，而那是最难查的一类。
    """
    service = _service(tmp_path)
    entries = [
        service.remember("用户叫小又，称呼「小又」即可。", section="身份与称呼").text,
        service.remember("用户要求回答先给结论，再列依据。", section="长期偏好与风格").text,
        service.remember("项目目标是把知识库放进内网。", section="进行中的项目").text,
        service.remember("用户的内网有一台 L20。", section="工具与环境").text,
    ]

    block = service.archive_block()

    for item in entries:
        assert f"- {item}" in block, item
    # 四个分区按 §3.1 的固定顺序出现
    titles = ("身份与称呼", "长期偏好与风格", "进行中的项目", "工具与环境")
    positions = [block.index(f"## {title}") for title in titles]
    assert positions == sorted(positions)
    # 边界说明也在（§5.1）：少了它，模型会把档案当文献引用或当任务逐条念
    assert "不是文献依据" in block


def test_archive_block_is_empty_for_an_empty_archive(tmp_path: Path) -> None:
    """一条都没有时不注入空壳：四行标题加一句"这是你的档案"只占上下文。"""
    assert _service(tmp_path).archive_block() == ""


def test_archive_block_declares_truncation_instead_of_truncating_silently(
    tmp_path: Path,
) -> None:
    """§5.2：超限**必须在提示词里说出来**，而且只给前 N 条。

    正常路径碰不到它（写入侧 4000 字就拒了）——它兜的是"用户拿外部编辑器把档案
    改超了"这一态。**静默截断不可接受**：用户会以为助手看到了整份档案。
    """
    service = _service(tmp_path)
    body = "\n".join(f"- 第 {index} 条记录" + "字" * 100 for index in range(80))
    _write(
        service.workspace,
        PROFILE_FILE,
        f"---\nupdated: 2026-10-03\n---\n\n## 身份与称呼\n\n{body}\n",
    )

    block = service.archive_block()

    assert "超出上限" in block
    assert "请到记忆页整理" in block
    # 声明里报的条数要与实际给出的条数一致（不然它是一句假话）
    kept = block.count("- 第 ")
    assert f"前 {kept} 条" in block


def test_archive_block_does_not_depend_on_the_persona_list(tmp_path: Path) -> None:
    """**档案的注入不挂在 ``memory.persona_files`` 上**（§7.2）。

    挂在那一行上的后果很具体：用户从人设清单里删掉一个文件名，档案就静默停止注入
    ——而那条清单管的是"人设的取舍与顺序"。
    """
    service = _service(tmp_path, **{"memory.persona_files": "AGENTS.md"})
    service.remember("用户叫小又", section="身份与称呼")

    assert "用户叫小又" in service.archive_block()
    assert PROFILE_FILE not in service.persona_order()


def test_archive_block_is_empty_when_disabled_but_the_archive_stays_writable(
    tmp_path: Path,
) -> None:
    """关掉开关就**不注入**（§7.3）——而档案本身照旧可读可写（口径要分清）。"""
    service = _service(tmp_path, **{"memory.enabled": "false"})
    service.remember("用户叫小又", section="身份与称呼")

    assert service.archive_block() == ""
    assert "用户叫小又" in service.archive_text()

    service_on = _service(tmp_path, **{"memory.enabled": "true"})
    assert "用户叫小又" in service_on.archive_block()


# ------------------------------------------------- 铺模板并且不被记忆挤掉


def test_the_archive_is_written_as_the_four_section_skeleton(tmp_path: Path) -> None:
    """第一条写进来时，档案要有**四个固定分区的骨架**（§3.1）。

    为什么这条重要：用户拿编辑器打开这份文件时，看到的是四个标题而不是一份
    需要猜结构的散文；模型看到的顺序与用户看到的顺序因此是同一个。
    """
    service = _service(tmp_path)

    service.remember("对方偏好简短的答复", section="长期偏好与风格")

    body = (tmp_path / "memory" / PROFILE_FILE).read_text(encoding="utf-8")
    for title in ("身份与称呼", "长期偏好与风格", "进行中的项目", "工具与环境"):
        assert f"## {title}" in body
    assert "- 对方偏好简短的答复" in body
    # frontmatter 只放 `updated`（§3.5 第 1 条）
    assert body.startswith("---\nupdated: ")
    assert "summary:" not in body


def test_remember_does_not_rewrite_line_endings(tmp_path: Path) -> None:
    """写档案要**按字节写**：`write_text` 在 Windows 上会把换行改成 CRLF。

    后果不只是"文件变脏"：这份文件每次都在被读、被比对（顶替判据、注入），
    换行在多轮之间来回翻会让逐字节比较与哈希都不稳定——而"顶替"的判据正是
    逐字节的。
    """
    service = _service(tmp_path)
    service.remember("第一条", section="长期偏好与风格")

    raw = (tmp_path / "memory" / PROFILE_FILE).read_bytes()

    assert b"\r\n" not in raw
    changes = (tmp_path / "memory" / "changes.md").read_bytes()
    assert b"\r\n" not in changes


def test_capture_does_not_rewrite_line_endings(tmp_path: Path) -> None:
    """捕获写的是当天的现场文件，同一条纪律：按字节写。

    （捕获这条链路期二已从请求流程里退场，机制本身还在，等期五清理。）
    """
    service = _service(tmp_path, ask=_FakeChat("- 甲"))

    service.capture(_TURN, session_id="conv_1")

    assert b"\r\n" not in _day_path(service).read_bytes()


def test_untouched_legacy_templates_are_upgraded(tmp_path: Path) -> None:
    """**还在用旧模板的实例要能看到新模板**，改过的文件一个字也不动。

    v0.21 把三份模板换成了 QwenPaw 那套有内容的写法，而 `seed_persona` 的原则是
    "已存在的一律不动"——照字面执行的话，已经在跑的部署永远看不到新模板，
    除非用户自己去删文件（而他并不知道该删）。v0.56 的 `PROFILE.md` 又是一次
    换形状（散文 → 四区骨架），同一个问题再来一遍。

    判据是**逐字节相同**：那才是"我们写下去之后没人动过"。所以第三条断言
    （只改了一个标题的文件）与第二条（真正的旧模板）必须表现不同——
    这是"宁可漏升级、不可误覆盖"的落点。
    """
    from app.services.memory import _LEGACY_TEMPLATES

    workspace = tmp_path / "memory"
    workspace.mkdir(parents=True)
    (workspace / SOUL_FILE).write_bytes(_LEGACY_TEMPLATES[SOUL_FILE][0].encode("utf-8"))
    (workspace / AGENTS_FILE).write_bytes(
        _LEGACY_TEMPLATES[AGENTS_FILE][0].replace("## 工作方式", "## 我自己的工作方式").encode()
    )
    # 散文体的 PROFILE.md（v0.21–v0.55 的模板）也要被换成四区骨架
    (workspace / PROFILE_FILE).write_bytes(_LEGACY_TEMPLATES[PROFILE_FILE][1].encode("utf-8"))
    service = _service(tmp_path)

    service.seed_persona()

    # 旧模板 → 换成新的（有内容的那份）
    assert "真心帮忙" in (workspace / SOUL_FILE).read_text(encoding="utf-8")
    # 动过一个字的 → 原样不动
    assert "我自己的工作方式" in (workspace / AGENTS_FILE).read_text(encoding="utf-8")
    # 散文体资料 → 换成档案骨架（用户一个字都没动过）
    assert "## 身份与称呼" in (workspace / PROFILE_FILE).read_text(encoding="utf-8")
    # 幂等：第二次没有可升级的
    assert service.seed_persona() == []


# ------------------------------------------------- 铺模板（v0.56：三份，不含 MEMORY.md）
#
# 容器里"长期记忆不生效"里属于**文件那一半**的验收是：新实例起来后
# 「记忆」页就可写、重启后内容还在。所以模板要一次性铺全、幂等、
# 且**不看 memory.enabled**——那开关管的是注入与 recall，不是这几个文件。


def test_seed_persona_lays_down_the_three_files(tmp_path: Path) -> None:
    """三份都铺：SOUL / AGENTS / **PROFILE.md（= 档案）**。

    ``MEMORY.md`` **不再铺**（§7.2 退场：它不再注入、不再写入、也不再被播种）——
    新部署的「记忆」页上看的是这份四区档案，而不是一份"已知事实"的旧文件。
    """
    service = _service(tmp_path)

    created = service.seed_persona()

    assert sorted(created) == sorted([SOUL_FILE, PROFILE_FILE, AGENTS_FILE])
    assert not (tmp_path / "memory" / CORE_MEMORY_FILE).exists()
    # 幂等：第二次一个都不新建
    assert service.seed_persona() == []
    body = (tmp_path / "memory" / PROFILE_FILE).read_text(encoding="utf-8")
    for title in ("身份与称呼", "长期偏好与风格", "进行中的项目", "工具与环境"):
        assert f"## {title}" in body


def test_the_archive_is_seeded_even_when_the_switch_is_off(tmp_path: Path) -> None:
    """**关着也铺**：容器里"记忆页可写"不该依赖用户先去设置页把开关打开
    （浏览与编辑那几个文件本来就不走那道闸，见 ``services/memory.py`` 的说明）。"""
    service = _service(tmp_path, **{"memory.enabled": "false"})

    created = service.seed_persona()

    assert PROFILE_FILE in created
    assert (tmp_path / "memory" / PROFILE_FILE).exists()


def test_remember_writes_into_the_seeded_archive(tmp_path: Path) -> None:
    """先铺骨架、再记住：第一条落进对应分区，四个标题一个不少。

    （旧版本这条钉的是"``_write_entries`` 的兜底与模板逐字一致"；期二
    ``MEMORY.md`` 与那套重写逻辑一起退场，剩下的性质是"播种的骨架与之后
    写入的档案是同一个形状"——由 ``archive_files.render_archive`` 一个渲染器保证。）
    """
    service = _service(tmp_path)
    service.seed_persona()

    service.remember("设备名是 nas", section="工具与环境")

    body = (tmp_path / "memory" / PROFILE_FILE).read_text(encoding="utf-8")
    assert "- 设备名是 nas" in body
    assert "## 工具与环境" in body and "## 身份与称呼" in body
    # 写完之后骨架不再是"没人动过"（首次引导据此自己消失）
    assert service.profile_is_untouched() is False


# ------------------------------------------------------------------ 记忆指导


def test_guidance_is_empty_when_the_switch_is_off(tmp_path: Path) -> None:
    """**关着时不给指导**：那时 `recall` 会明确报错，把"什么时候该去查"
    讲给模型听，只会换来每轮一次无效调用加一句错误。

    这与知识库那一侧是同一个形状（见 `agent_tools._KB_TOOLS` 的说明：给了又拒，
    白花两个来回）——那边已经踩过一次，记忆这一侧别再踩。
    """
    off = _service(tmp_path, **{"memory.enabled": "false"})
    on = _service(tmp_path)

    assert off.guidance() == ""
    assert on.guidance() != ""


def test_guidance_says_the_archive_is_already_injected(tmp_path: Path) -> None:
    """指导里必须有一句"**档案已经全量注入了，不必再去检索它**"（§5.3）。

    旧文案教的是"问偏好时先 `recall`"——那句话让模型白花一次调用，还会把
    同一段内容读两遍；而它现在也**查不到**档案（池子只剩变更流）。
    """
    text = _service(tmp_path).guidance()

    assert "全量" in text
    assert "变更流" in text
    assert "recall" in text and "remember" in text and "forget" in text
    # 字数与条数从 archive 的常量取，不写死第二份
    assert "120" in text and "60" in text and "4000" in text


def test_guidance_points_at_replaces_instead_of_delete_then_write(tmp_path: Path) -> None:
    """更正要**一次调用**（`replaces`），指导里必须这么说。

    不写的话，"不是 A，是 B"会退化成两次调用：先忘掉、再记住——中间那一刻
    档案里是没有这条的（用户刚好在那时问一句，答案就是错的）。
    """
    text = _service(tmp_path).guidance()

    assert "replaces" in text
    assert "不要先删再记" in text


# ------------------------------------------------------------------ 首次引导


def test_bootstrap_shows_while_the_archive_is_still_the_skeleton(tmp_path: Path) -> None:
    """档案还是空骨架时给引导，**写进第一条之后它自己就没了**。

    这是"感觉不到人设"的正面解法：新装的档案是空的，而**没有任何机制会让它被填上**
    ——用户不会主动去改一份档案文件（他甚至不知道有这回事），Agent 也不会问。
    QwenPaw 用一份"用完就删"的 BOOTSTRAP.md 解决；我们用**没有这个问题的等价信号**
    （"档案还没被写过"），于是不需要"用过就删"的簿记。
    """
    service = _service(tmp_path)
    service.seed_persona()

    assert service.bootstrap_block() != ""

    service.remember("用户叫小又", section="身份与称呼")

    assert service.bootstrap_block() == ""


def test_bootstrap_tells_the_agent_how_to_write_it_down(tmp_path: Path) -> None:
    """引导里必须写清"答案往哪儿放"——不然模型问完就忘了。

    期二把落点从 `write_memory`（整份覆盖，已退场）换成了 **`remember` 一条一条写**
    （§7.4），而这条用例跟着换口径：点名 `remember` 与三个分区名，
    并**明确不许写 `write_memory`**——老提示词里那个名字已经不管用了。
    """
    service = _service(tmp_path)
    service.seed_persona()

    text = service.bootstrap_block()

    assert "remember" in text
    assert "身份与称呼" in text and "进行中的项目" in text and "长期偏好与风格" in text
    assert "write_memory" not in text
    assert "PROFILE.md" in text and "SOUL.md" in text


def test_bootstrap_does_not_depend_on_the_memory_switch(tmp_path: Path) -> None:
    """关着长期记忆也要引导：档案的编辑本来就不受那道闸管
    （挂在开关上的话，关着记忆的实例永远不做引导）。"""
    service = _service(tmp_path, **{"memory.enabled": "false"})
    service.seed_persona()

    assert service.bootstrap_block() != ""


def test_bootstrap_is_silent_without_a_profile_file(tmp_path: Path) -> None:
    """文件不存在时**不说话**：那多半是还没铺模板，这时判"没填过"等于把引导
    挂在一个不存在的对象上。"""
    assert _service(tmp_path).bootstrap_block() == ""


# ------------------------------------------------------------------ 累积捕获


class _Msg:
    """一条会话消息的最小形状（捕获只看 id / role / content 三样）。"""

    def __init__(self, mid: str, role: str, content: str, conversation_id: str = "c1") -> None:
        self.id = mid
        self.role = role
        self.content = content
        self.conversation_id = conversation_id


class _MetaWithMessages:
    """水位线要用到的四个动作：列消息、读写设置、入队。"""

    def __init__(self) -> None:
        self.messages: list[_Msg] = []
        self.settings: dict[str, str] = {}
        self.tasks: list[object] = []

    def list_messages(self, conversation_id: str) -> list[_Msg]:
        return [item for item in self.messages if item.conversation_id == conversation_id]

    def get_setting(self, key: str) -> str | None:
        return self.settings.get(key)

    def set_setting(self, key: str, value: str) -> None:
        self.settings[key] = value

    def enqueue_task(self, record: object) -> None:
        self.tasks.append(record)


class _StoresWithMessages:
    def __init__(self, meta: _MetaWithMessages) -> None:
        self.meta = meta


def _capturing_service(
    tmp_path: Path, **values: str
) -> tuple[MemoryService, _MetaWithMessages]:
    meta = _MetaWithMessages()
    values.setdefault("memory.enabled", "true")
    service = MemoryService(
        _FakeRuntime({"memory.workspace": "memory", **values}),  # type: ignore[arg-type]
        tmp_path,
        stores=_StoresWithMessages(meta),  # type: ignore[arg-type]
    )
    return service, meta


def _turns(count: int, conversation_id: str = "c1") -> list[_Msg]:
    out: list[_Msg] = []
    for index in range(1, count + 1):
        out.append(_Msg(f"m{index * 2 - 1}", "user", f"t{index} 问", conversation_id))
        out.append(_Msg(f"m{index * 2}", "assistant", f"t{index} 答", conversation_id))
    return out


def _bodies(meta: _MetaWithMessages, index: int = 0) -> list[str]:
    payload = meta.tasks[index].payload  # type: ignore[attr-defined]
    return [item["content"] for item in payload["messages"]]


def _backlog(service: MemoryService, meta: _MetaWithMessages, cid: str = "c1"):  # type: ignore[no-untyped-def]
    """直接问服务层的"_backlog"（"上次捕获以来该送哪一段"）。

    **为什么要绕开 ``capture_turn``**：期二把定时捕获整条退场了（见
    ``test_capture_turn_is_retired``），但"该送哪一段"这段逻辑本身留着——
    期四的信号捕获要复用它，期五才随 ``daily/`` 一起清理。所以这一组改成
    直接钉那个纯计算，口径不变而入口换掉了。
    """
    return service._backlog(_StoresWithMessages(meta), cid)


def test_capture_backlog_sends_everything_since_the_last_capture(tmp_path: Path) -> None:
    """**拍 10 轮，每一轮都要进得了那一段**（这是当年修过的那个漏）。

    原先每次只把**当轮**那两条交出去，而节流是"每 5 个用户回合一次"——
    两者相乘的结果是每 5 轮里只有 1 轮被看过一眼，其余 4 轮永远不进入记忆。
    用户那边的现象就是"我明明说过，它就是不记得"。
    """
    service, meta = _capturing_service(tmp_path)
    every_turn = _turns(10)
    meta.messages = list(every_turn)

    backlog, upto = _backlog(service, meta)

    assert backlog[0]["content"] == "t1 问"
    assert len(backlog) == 20 and upto == "m20"


def test_capture_backlog_caps_one_payload_and_catches_up_next_time(
    tmp_path: Path,
) -> None:
    """一次 payload 有上限；超出的**下一轮接着补**，不是静默丢掉。

    没有上限的话，一个中间一直没沉淀的会话会把几百条消息塞进 ``tasks`` 表的
    一行 JSON——那种形状平时看不出问题，出事时很难查。
    """
    from app.services.memory import CAPTURE_BATCH_TURNS

    service, meta = _capturing_service(tmp_path)
    meta.messages = _turns(CAPTURE_BATCH_TURNS + 10)

    first, upto = _backlog(service, meta)
    assert len(first) == CAPTURE_BATCH_TURNS * 2
    # 水位线推进到"真正送出去的那一条"，所以下一轮接着补
    meta.settings["memory.captured.c1"] = upto
    rest, _ = _backlog(service, meta)
    assert len(first) + len(rest) == len(meta.messages)


def test_capture_backlog_takes_a_recent_window_when_the_watermark_is_gone(
    tmp_path: Path,
) -> None:
    """水位线那条消息被 ``/rewind`` 删掉时，取**最近**一段而不是从头。

    从头等于把整段会话重记一遍，而其中绝大部分早就记过了；取最近这一段，
    重复的部分由捕获自身的去重兜住。
    """
    from app.services.memory import CAPTURE_BATCH_TURNS

    service, meta = _capturing_service(tmp_path)
    meta.messages = _turns(30)
    meta.settings["memory.captured.c1"] = "rewind 删掉的那条"

    backlog, _upto = _backlog(service, meta)

    assert backlog[0]["content"] == f"t{30 - CAPTURE_BATCH_TURNS + 1} 问"


def test_capture_backlog_advances_the_watermark_past_an_empty_message(
    tmp_path: Path,
) -> None:
    """最后一条正文是空的，水位线**照样要往前推**。

    不推的话，一条空消息会把水位线永久卡在它前面，之后每一轮都从它重新往后送
    ——越送越长，而这次的"什么都没送"会一直重复。
    """
    service, meta = _capturing_service(tmp_path)
    meta.messages = [
        _Msg("y1", "user", "真问题"),
        _Msg("y2", "assistant", ""),
    ]

    backlog, upto = _backlog(service, meta)

    assert [item["content"] for item in backlog] == ["真问题"]
    assert upto == "y2"


# --------------------------------------------------------------------- 整理
#
# Auto-Dream 的等价物：把``daily/`` 那份**现场**沉淀成 ``digest/`` 那份**长期知识**。
# 这一组的重点是"该不该动、往哪动"——整理是**唯一一个会自动改写已有记忆**的动作，
# 所以每一条纪律都要有用例钉着。


_DREAM_REPLY = (
    "=== CREATE｜personal｜发布顺序\n"
    "摘要：发布顺序固定为：先跑门禁、再打标签、最后推镜像\n"
    "关联：[[镜像发布]]\n"
    "正文：\n"
    "发布顺序固定为：先跑门禁 → 再打标签 → 最后推镜像。不要跳步。\n"
    "===\n"
)


def _field_note(tmp_path: Path) -> None:
    """铺一份现场记忆（整理的输入）。"""
    _write(
        tmp_path / "memory",
        "daily/2026-09-25.md",
        "# 2026-09-25\n\n- 发布顺序固定为先跑门禁再打标签\n",
    )


def _dream_service(
    tmp_path: Path, *, ask: _FakeChat, **values: str
) -> tuple[MemoryService, Path]:
    """带存储（水位线要落库）与假模型的服务。"""
    stores = _FakeStores()
    values.setdefault("memory.enabled", "true")
    values.setdefault("memory.dream_after_hours", "24")
    service = MemoryService(
        _FakeRuntime({"memory.workspace": "memory", **values}),  # type: ignore[arg-type]
        tmp_path,
        ask=ask,
        stores=stores,  # type: ignore[arg-type]
    )
    service.seed_persona()
    return service, service.workspace


def test_dream_moves_the_field_notes_into_long_term_knowledge(tmp_path: Path) -> None:
    """**整理把现场沉淀成长期知识。**

    四件事一起验：落点在 ``digest/<类别>/``；``## Sources`` 指回那份现场
    （于是它被认成"已整合"——界面上那枚「待整合」标记从此才真的在说事）；
    关联变成正文里的一句话；**现场一个字都没被改**。
    """
    _field_note(tmp_path)
    service, workspace = _dream_service(tmp_path, ask=_FakeChat(_DREAM_REPLY))
    field = workspace / "daily" / "2026-09-25.md"
    before = field.read_bytes()

    result = service.dream(force=True)

    assert result["created"] == ["digest/personal/发布顺序.md"]
    body = (workspace / "digest" / "personal" / "发布顺序.md").read_text(encoding="utf-8")
    assert body.startswith("---\n") and "kind: preference" in body
    assert "先跑门禁" in body
    assert "另见 [[镜像发布]]。" in body, "关联要收成一句话，不是裸链接行"
    assert "- [[daily/2026-09-25.md]]" in body
    assert field.read_bytes() == before, "现场是「当时到底发生了什么」的不可变记录"

    entries = {item.path: item for item in memory_files.scan(workspace)}
    assert entries["daily/2026-09-25.md"].consolidated is True


def test_dream_calls_the_model_only_when_something_changed(tmp_path: Path) -> None:
    """**没有变化就一次模型都不调**（照 QwenPaw 的 "No changed dream input"）。

    这条是省钱的闸：worker 的空闲分支每小时都会来问一次，不问清楚就会变成
    "每小时烧一次钱"。
    """
    _field_note(tmp_path)
    chat = _FakeChat(_DREAM_REPLY)
    service, _workspace = _dream_service(tmp_path, ask=chat)

    first = service.dream(force=True)
    second = service.dream(force=True)

    assert first["units"] == 1
    assert second["skipped"] == "现场没有变化"
    assert len(chat.prompts) == 1, "第二次不该再问模型"


def test_dream_respects_the_cadence(tmp_path: Path) -> None:
    """节拍没到就不跑。**这是这件事唯一的开关**——不另立"启用整理"（见 `dream` 的说明）。"""
    _field_note(tmp_path)
    service, _workspace = _dream_service(tmp_path, ask=_FakeChat(_DREAM_REPLY))
    service.dream(force=True)

    assert service.dream()["skipped"] == "还没到节拍"


def test_dream_cadence_zero_turns_it_off(tmp_path: Path) -> None:
    """``memory.dream_after_hours = 0`` 就是不做。"""
    _field_note(tmp_path)
    service, _workspace = _dream_service(
        tmp_path, ask=_FakeChat(_DREAM_REPLY), **{"memory.dream_after_hours": "0"}
    )

    assert service.dream()["skipped"] == "整理已关闭（节拍为 0）"


def test_dream_is_off_when_memory_is_disabled(tmp_path: Path) -> None:
    """记忆整个关着时，整理也不该动（它写的是记忆）。"""
    _field_note(tmp_path)
    service, _workspace = _dream_service(
        tmp_path, ask=_FakeChat(_DREAM_REPLY), **{"memory.enabled": "false"}
    )

    assert service.dream()["skipped"] == "未启用长期记忆"


def test_dream_updates_an_existing_note_instead_of_making_a_second_one(
    tmp_path: Path,
) -> None:
    """``CORROBORATE`` / ``REFINE`` / ``CORRECT`` 并进**已有那一份**，不新开一条。

    这是"只增不并"的正面：同一个主题再出现时，长期知识里仍然只有一条，
    而来源多了一条（``## Sources`` 里已经有的那个不重复加）。
    """
    _field_note(tmp_path)
    _write(
        tmp_path / "memory",
        "digest/wiki/锂价敏感性.md",
        "---\nsummary: 锂价敏感性\n---\n\n# 锂价敏感性\n\n锂价下跌压低正极材料成本。\n"
        "\n## Sources\n- [[daily/2026-09-20.md]]\n",
    )
    chat = _FakeChat(
        "=== CORROBORATE｜wiki｜锂价敏感性\n"
        "摘要：锂价敏感性\n"
        "正文：\n"
        "又确认了一次：锂价下跌压低正极材料成本。\n"
        "===\n"
    )
    service, workspace = _dream_service(tmp_path, ask=chat)

    result = service.dream(force=True)

    assert result["updated"] == ["digest/wiki/锂价敏感性.md"]
    body = (workspace / "digest" / "wiki" / "锂价敏感性.md").read_text(encoding="utf-8")
    assert "## 更新（" in body and "又确认了一次" in body
    assert body.count("- [[daily/2026-09-20.md]]") == 1, "旧来源不重复加"
    assert "- [[daily/2026-09-25.md]]" in body
    assert len(list((workspace / "digest" / "wiki").glob("*.md"))) == 1, "不新开一条"


def test_dream_creates_when_the_named_target_does_not_exist(tmp_path: Path) -> None:
    """模型把动作说错了（说 REFINE 但那个主题还不存在）→ **退回新建**。

    并进一份不存在的文件是没意义的；"新建"是可恢复的（用户看得见、能改），
    而覆盖不是。
    """
    _field_note(tmp_path)
    service, workspace = _dream_service(
        tmp_path,
        ask=_FakeChat(
            "=== REFINE｜procedure｜回滚流程\n摘要：回滚\n正文：\n先停流量，再回滚镜像。\n===\n"
        ),
    )

    result = service.dream(force=True)

    assert result["created"] == ["digest/procedure/回滚流程.md"]
    assert (workspace / "digest" / "procedure" / "回滚流程.md").exists()


def test_dream_retries_a_note_it_failed_to_write(tmp_path: Path, monkeypatch) -> None:
    """**写不进去的那一份不回写水位线**，下一轮会重新出现在"变了样的"里面。

    这是 QwenPaw 的 dream catalog 那条规矩（失败路径绝不回写 checkpoint）：
    回写了就等于那份现场永远不再被整理——而且**不会报错**，是查不出来的坏法。
    """
    _field_note(tmp_path)
    service, _workspace = _dream_service(tmp_path, ask=_FakeChat(_DREAM_REPLY, _DREAM_REPLY))

    def boom(*_args: object, **_kwargs: object) -> None:
        raise InvalidRequestError("磁盘满了")

    monkeypatch.setattr(memory_files, "write_file", boom)
    first = service.dream(force=True)

    assert first["created"] == [], "一条都没落盘"
    assert first["failed"] == ["digest/personal/发布顺序.md"]
    monkeypatch.undo()
    second = service.dream(force=True)
    assert second["created"] == ["digest/personal/发布顺序.md"], "下一轮会重试那一份"


def test_dream_does_not_repeat_an_update_that_already_landed(tmp_path: Path) -> None:
    """**重试是幂等的**：已经追加过的那条正文不会再追加一遍。

    这条与上一条是一对：上一条要求"有一条没落盘就整批留到下一轮重试"，
    而重试会把**已经成功**的那几条重新算一遍——如果追加不幂等，
    一次写失败就会换来一条重复的「更新」节。
    """
    _field_note(tmp_path)
    body = "锂价下跌压低正极材料成本。"
    chat = _FakeChat(
        f"=== CREATE｜wiki｜锂价敏感性\n摘要：锂价敏感性\n正文：\n{body}\n===\n",
        f"=== CORROBORATE｜wiki｜锂价敏感性\n摘要：锂价敏感性\n正文：\n{body}\n===\n",
    )
    service, workspace = _dream_service(tmp_path, ask=chat)
    service.dream(force=True)
    digest = workspace / "digest" / "wiki" / "锂价敏感性.md"
    before = digest.read_bytes()

    # 把现场改一下（mtime 变了），逼它重新整理同一个主题
    field = workspace / "daily" / "2026-09-25.md"
    field.write_bytes(field.read_bytes() + "\n- 又提了一次锂价\n".encode())
    result = service.dream(force=True)

    assert result["updated"] == [], "正文已经在里面了，这一次是空操作"
    assert digest.read_bytes() == before


def test_dream_all_walks_every_workspace(tmp_path: Path) -> None:
    """``dream_all`` 是给 worker 的空档分支用的：共享桶与每个账号的工作区都要看。

    判据是"这个目录里有那四份核心文件里的至少一份"——``daily/`` 这类子目录不会命中，
    所以不必另立一张"哪些账号有工作区"的表。
    """
    _field_note(tmp_path)
    service, _workspace = _dream_service(tmp_path, ask=_FakeChat(_DREAM_REPLY, _DREAM_REPLY))
    service.seed_persona("u1")
    # 每个工作区各有各的现场（共享桶的那份是 `_field_note` 铺的）
    _write(
        tmp_path / "memory",
        "u1/daily/2026-09-25.md",
        "# 2026-09-25\n\n- 发布顺序固定为先跑门禁再打标签\n",
    )

    assert service.workspaces() == [None, "u1"]
    done = service.dream_all(force=True)

    assert set(done) == {"-", "u1"}, "两个工作区都要真的被整理过，而不是只看了共享桶"


# --------------------------------------------------- 整理：解析与文件名（纯函数）


def test_dream_keeps_the_field_notes_when_it_cannot_read_the_output(tmp_path: Path) -> None:
    """模型**说了话、但一条都认不出来** → 不把那几份现场记成"已整理"。

    这是真跑逼出来的：两次真跑的模型输出都没能被解析（一次把格式里的占位符原样吐回，
    一次把推理过程写进了正文），而当时的实现**照样推进了水位线**——那几份现场就永远
    不会再被整理，而且**不会报错**。

    同时断言"时钟走了"：``at`` 要往前推，否则每个空闲周期都会去问一次模型
    ——那是拿钱换一个已知会失败的结果。
    """
    _field_note(tmp_path)
    junk = "好的，我看看。\n=== 动作｜类别｜名字\n摘要：示例\n正文：\n占位\n===\n"
    service, _workspace = _dream_service(tmp_path, ask=_FakeChat(junk, junk))

    first = service.dream(force=True)
    second = service.dream(force=True)
    cadence = service.dream()

    assert first["skipped"] == "模型输出认不出来"
    assert second["skipped"] == "模型输出认不出来", "那几份现场下一轮还会重试"
    assert cadence["skipped"] == "还没到节拍", "但时钟走了：不会每个空闲周期都问一次"


def test_dream_turns_thinking_off_for_the_extraction_call(
    tmp_path: Path, monkeypatch
) -> None:
    """**抽取类调用要关掉思考。**

    ``llm.py`` 的模块注释里就写着这条（"测试场景要显式传 ``enable_thinking: false``"），
    而真跑（真模型 + 真数据）证实它不是理论问题：开着思考时模型的推理**混进了正文**
    ——那次输出里中英文夹着「等等，第二个条目没有内容，不应该输出…Let me reconsider」，
    于是解析器只认得出半条。
    """
    _field_note(tmp_path)
    seen: list[LLMConfig] = []

    class _Chat:
        def __init__(self, config: LLMConfig) -> None:
            seen.append(config)

        def complete(self, messages: list[object]) -> str:
            return _DREAM_REPLY

    monkeypatch.setattr(memory_service, "OpenAICompatChat", _Chat)
    service = MemoryService(
        _FakeRuntime(  # type: ignore[arg-type]
            {"memory.enabled": "true", "memory.workspace": "memory"},
            llm=LLMConfig(
                base_url="http://model.invalid/v1",
                api_key="k",
                model_id="m",
                enable_thinking=True,
            ),
        ),
        tmp_path,
        stores=_FakeStores(),  # type: ignore[arg-type]
        ask=None,
    )
    service.seed_persona()

    service.dream(force=True)

    assert seen, "应该真的走到了模型通道"
    assert seen[0].enable_thinking is False, "记忆抽取不该带思考"


# --------------------------------------------------------------- 向量那一路
#
# 这一组测的是**用户看得见的那一层**：开关关着时一次嵌入都不发（默认配置下不该
# 因为多了一条路而花钱），开着时同义写法也能找到。向量用查表给——真实模型的分离度
# 在真跑里量过（见 services/memory_index.py 的模块说明）。


class _FakeEmbed:
    """按文本查表给向量；查不到就给默认向量。记录每一次调用。"""

    model_id = "fake-1"
    dim = 2
    max_batch = 2

    def __init__(self) -> None:
        self.calls: list[list[str]] = []
        self.table: dict[str, list[float]] = {}

    def embed(self, texts):  # type: ignore[no-untyped-def]
        self.calls.append(list(texts))
        return [list(self.table.get(text, [1.0, 0.0])) for text in texts]


#: 用例里显式给出余弦下限。**为什么必须显式**：真实现取不到值时回落到
#: ``DEFAULTS``（0.45），而假 runtime 没有那份默认表——不写的话这里会变成 0.0，
#: 于是"余弦正好 0 的噪声"也会过闸，测出来的就不是产品行为了。
_FLOOR = {"memory.vector_min_score": "0.45"}


def test_recall_stays_lexical_when_the_vector_route_is_off(tmp_path: Path) -> None:
    """开关关着时**一次嵌入都不发**——而且 recall 现在压根不看这个开关。

    这条是"默认关"那个决定的兑现方式：默认配置下，记忆层不该因为多了一条路而
    开始花钱。期二之后这句话更硬了：**recall 的池子只有变更流**，向量那一路
    （``memory.vector_enabled``）已经不参与它了（§5.3）——下面两条用例
    （开着时的同义命中）一起被这条性质取代，它们测的是旧检索路径。
    """
    fake = _FakeEmbed()
    service = _service(tmp_path, **{"memory.vector_enabled": "false"}, embed=fake)
    _write(service.workspace, "digest/偏好.md", "# 偏好\n\n沟通风格是开门见山。\n")

    hits, _links = service.recall("我之前的回答是什么风格")

    assert fake.calls == [], "关着时不该有任何嵌入调用"
    assert hits == [], "那一层已经不在池子里了"


def test_recall_ignores_the_vector_route_even_when_it_is_on(tmp_path: Path) -> None:
    """把向量那一路打开也**一次嵌入都不发**（§5.3）。

    这条替代了原来的两条"同义命中"用例：它们钉的是 `memory_files.search` +
    `memory_index.search_hybrid` 那条检索链，而 recall 已经不吃它了。
    向量那一层本身还留在代码里（期五清理），但"把嵌入挪进查询路径就等于
    每次查询赌一次上游延迟"这条纪律，从今往后由**没有调用点**来保证。
    """
    fake = _FakeEmbed()
    service = _service(tmp_path, **{"memory.vector_enabled": "true", **_FLOOR}, embed=fake)
    _seed(service)

    hits, _links = service.recall("项目代号叫什么")

    assert fake.calls == [], "开着也不该有嵌入调用"
    assert [hit.path for hit in hits] == ["changes.md"]


def test_sync_index_is_a_no_op_without_an_embedder(tmp_path: Path) -> None:
    """没有嵌入能力时对齐是空操作（不报错）：词面那一路本来就是完整的。"""
    service = _service(tmp_path, **{"memory.vector_enabled": "true"})

    assert service.sync_index(force=True) == {"skipped": "没有嵌入能力"}


def test_sync_index_is_a_no_op_when_the_switch_is_off(tmp_path: Path) -> None:
    """开关关着时对齐也是空操作——**一次嵌入都不该发**。"""
    fake = _FakeEmbed()
    service = _service(tmp_path, **{"memory.vector_enabled": "false"}, embed=fake)

    assert service.sync_index() == {"skipped": "向量那一路关着"}
    assert fake.calls == []


# ------------------------------------ 人设文件：注入哪几份、按什么顺序（v0.51）
#
# 照 QwenPaw 的 ``system_prompt_files``：那几份文件每轮整份进 system prompt，
# 所以"哪几份、什么顺序"是用户的设定，不该由代码钉死。


def test_persona_order_defaults_to_the_documented_order(tmp_path: Path) -> None:
    """没配就是那份默认表：**人格 → 规程**（§7.2 起只有这两份）。

    ``PROFILE.md``（= 档案）走独立贡献者，``MEMORY.md`` 已退场——
    它们都不在这份清单里，用户也就不可能"从清单里删掉一个名字，档案静默停止注入"。
    """
    service = _service(tmp_path)

    assert service.persona_order() == (SOUL_FILE, AGENTS_FILE)


def test_persona_order_follows_the_setting(tmp_path: Path) -> None:
    """用户能决定哪两份、按什么顺序进提示词；``persona_texts`` 跟着这个顺序读。"""
    service = _service(tmp_path, **{"memory.persona_files": "AGENTS.md, SOUL.md"})
    _write(service.workspace, SOUL_FILE, "我的人格")
    _write(service.workspace, AGENTS_FILE, "操作规程")

    assert service.persona_order() == (AGENTS_FILE, SOUL_FILE)
    assert [name for name, _text in service.persona_texts()] == [AGENTS_FILE, SOUL_FILE]


def test_persona_order_takes_a_full_width_comma_too(tmp_path: Path) -> None:
    """中文输入法下逗号是全角的——**那不是用户的错**，别让他配了没反应。"""
    service = _service(tmp_path, **{"memory.persona_files": "SOUL.md，AGENTS.md"})

    assert service.persona_order() == (SOUL_FILE, AGENTS_FILE)


def test_persona_order_drops_names_it_does_not_know(tmp_path: Path) -> None:
    """只认那几份核心文件，其余丢掉：**让任意路径进 system prompt 等于绕过分界**
    （哪些是"设定"）。想去掉重复的名字也在这里收掉。"""
    service = _service(
        tmp_path, **{"memory.persona_files": "SOUL.md, daily/x.md, SOUL.md, 笔记.md"}
    )

    assert service.persona_order() == (SOUL_FILE,)


def test_persona_order_drops_profile_and_memory(tmp_path: Path) -> None:
    """**``PROFILE.md`` 与 ``MEMORY.md`` 从清单里被丢掉**（§7.2、v0.56）。

    老配置里这一行八成还写着四个名字（默认值改之前就是那样）：
    - 档案挂上去的后果是**用户删一个名字、档案就静默停止注入**；
    - ``MEMORY.md`` 已经退场，再注入一遍就是把同一件事说两次。
    两者都是"名字写了但不生效"，所以**记一条日志**——静默忽略会让那一行看起来生效了。
    """
    service = _service(
        tmp_path, **{"memory.persona_files": "SOUL.md,PROFILE.md,AGENTS.md,MEMORY.md"}
    )

    assert service.persona_order() == (SOUL_FILE, AGENTS_FILE)


def test_persona_order_falls_back_when_nothing_is_recognised(tmp_path: Path) -> None:
    """全不认识 → 回到默认顺序：**"配错了"不该变成"一份都不注入"**。

    一份都不注入等于让 agent 突然失了人格——而用户只是打错了一个文件名。
    """
    service = _service(tmp_path, **{"memory.persona_files": "不存在的文件.md"})

    assert service.persona_order() == (SOUL_FILE, AGENTS_FILE)


def test_capture_takes_the_title_and_summary_the_model_gave(tmp_path: Path) -> None:
    """模型给的「主题」「摘要」进 frontmatter（v0.51）：**摘要是这份笔记的一句话**，
    而不是第一条条目（那处降级写在 ``_note_summary`` 里）。

    两样都是**看得见**的东西：摘要进界面列表那一列与召回时的标题加权；主题进
    frontmatter 的 ``title``（``memory_files._title_of`` 优先取它），所以列表里显示的
    是"这份笔记在讲什么"，而不是日期。**主题不占正文标题**——那份 H1 还是当天那行，
    免得同一天里每次沉淀都把标题改一遍。
    """
    chat = _FakeChat(
        "主题：回复风格与设备\n"
        "摘要：他偏好先给结论，不要客套\n"
        "- 用户偏好简短回答，先说结论\n"
    )
    service = _service(tmp_path, ask=chat)

    result = service.capture(_TURN, session_id="conv_1")

    body = (service.workspace / result["path"]).read_text(encoding="utf-8")
    assert 'title: "回复风格与设备"' in body
    assert 'summary: "他偏好先给结论，不要客套"' in body
    assert f"# {_day(service)} 现场" in body, "主题不占正文标题"
    entries = {item.path: item for item in memory_files.scan(service.workspace)}
    assert entries[result["path"]].title == "回复风格与设备"
    assert entries[result["path"]].summary == "他偏好先给结论，不要客套"


def test_capture_falls_back_to_the_first_entry_without_a_summary(tmp_path: Path) -> None:
    """模型没给那两行时走兜底：**摘要取第一条**（老行为），而且条目照常落盘。

    提示词说了"能写就写"，所以"没写"是正常路径，不是失败路径。
    """
    chat = _FakeChat("- 用户偏好简短回答，先说结论\n")
    service = _service(tmp_path, ask=chat)

    result = service.capture(_TURN, session_id="conv_1")

    body = (service.workspace / result["path"]).read_text(encoding="utf-8")
    assert 'summary: "用户偏好简短回答，先说结论"' in body
    assert "title:" not in body


def test_capture_headline_is_lenient_but_needs_a_colon() -> None:
    """解析的宽容与严格各一半。

    宽：全角/半角冒号都认、标签前有项目符号也认、近义说法（标题/描述）也认。
    严：**没有冒号的行不算**——否则 `- 主题是深色` 这种**条目**会被当成标题读走，
    那会静默改掉这份笔记的显示名。
    """
    title, summary = _capture_headline(
        "好的，我整理如下：\n主题: 部署与设备\n描述：内网部署的两台机器\n- 主题是深色\n"
    )

    assert title == "部署与设备"
    assert summary == "内网部署的两台机器"
    assert _capture_headline("- 主题是深色\n- 摘要里有冒号：但不在行首\n") == ("", "")


# ------------------------------------------- Auto-Link 的另一半（补链，v0.51）
#
# 模型只在写入那一刻给它知道的关联；**两份长期知识之间的边要等它们都存在之后**
# 才看得出来。这一组钉的是：补得上、补得准（判据比召回更严）、双向、不重复。


def test_append_see_also_extends_the_existing_line() -> None:
    """**并进已有的那一行**，而不是再起一行：一文件里堆三行「另见」读起来像三份文档。"""
    text = "# 甲\n\n正文。\n\n另见 [[乙]]。\n\n## Sources\n\n- [[daily/a.md]]\n"

    merged = _append_see_also(text, ["丙"])

    assert merged.count("另见 ") == 1
    assert "另见 [[乙]]、[[丙]]。" in merged
    assert merged.endswith("- [[daily/a.md]]\n"), "来源那一节原样在末尾"


def test_append_see_also_is_idempotent() -> None:
    """已经在那一行里的名字不再重复加——重试（整批留到下一轮）因此是安全的。"""
    text = "# 甲\n\n正文。\n\n另见 [[乙]]。\n"

    assert _append_see_also(text, ["乙"]) == text
    assert _append_see_also(text, ["乙", "乙"]) == text


def test_append_see_also_starts_a_line_when_there_is_none() -> None:
    merged = _append_see_also("# 甲\n\n正文。\n", ["乙", "丙"])

    assert merged.rstrip("\n").endswith("另见 [[乙]]、[[丙]]。")


def test_append_see_also_caps_what_it_adds() -> None:
    """自动补的最多几条：**链接多了等于没链接**（照 QwenPaw 的克制）。"""
    merged = _append_see_also("# 甲\n\n正文。\n", ["乙", "丙", "丁", "戊"])

    assert merged.count("[[") == LINK_MAX


def _two_related_notes(tmp_path: Path) -> tuple[MemoryService, Path]:
    service = _service(tmp_path)
    _write(
        service.workspace,
        "digest/wiki/锂价敏感性.md",
        "---\nsummary: 锂价敏感性\n---\n\n# 锂价敏感性\n\n锂价下跌压低正极材料成本。\n",
    )
    _write(
        service.workspace,
        "digest/wiki/锂价与毛利.md",
        "---\nsummary: 锂价与毛利\n---\n\n# 锂价与毛利\n\n"
        "锂价敏感性与毛利的关系：锂价跌一成就少几个点。\n",
    )
    return service, service.workspace


def test_autolink_connects_two_related_notes_both_ways(tmp_path: Path) -> None:
    """找得到同类主题就补上，而且**双向**——图谱的"入链"那一半才有东西可显示。"""
    service, space = _two_related_notes(tmp_path)

    added = service._autolink(space, ["digest/wiki/锂价敏感性.md"])

    first = (space / "digest/wiki/锂价敏感性.md").read_text(encoding="utf-8")
    second = (space / "digest/wiki/锂价与毛利.md").read_text(encoding="utf-8")
    assert "[[锂价与毛利]]" in first
    assert "[[锂价敏感性]]" in second
    assert set(added) == {"digest/wiki/锂价敏感性.md", "digest/wiki/锂价与毛利.md"}


def test_autolink_leaves_unrelated_notes_alone(tmp_path: Path) -> None:
    """**判据比召回更严**：链接错了是在图谱上写下一句"这两件事有关"，而用户会信它。"""
    service, space = _two_related_notes(tmp_path)
    _write(
        service.workspace,
        "digest/wiki/合唱团.md",
        "---\nsummary: 合唱团\n---\n\n# 合唱团\n\n每周四晚上排练，指挥姓王。\n",
    )

    added = service._autolink(space, ["digest/wiki/锂价敏感性.md"])

    assert "合唱团" not in added.get("digest/wiki/锂价敏感性.md", [])
    assert "另见" not in (space / "digest/wiki/合唱团.md").read_text(encoding="utf-8")


def test_autolink_does_not_add_the_same_link_twice(tmp_path: Path) -> None:
    """第二次跑**什么都不改**（幂等）：它挂在每次整理之后，而整理会重复跑。"""
    service, space = _two_related_notes(tmp_path)
    service._autolink(space, ["digest/wiki/锂价敏感性.md"])
    before = (space / "digest/wiki/锂价敏感性.md").read_text(encoding="utf-8")

    again = service._autolink(space, ["digest/wiki/锂价敏感性.md"])

    assert again == {}
    assert (space / "digest/wiki/锂价敏感性.md").read_text(encoding="utf-8") == before


def test_dream_reports_the_links_it_added(tmp_path: Path) -> None:
    """整理这条链路里确实接上了补链（不是只写了一个没人调的函数）。

    夹具是"现场里有一条发布顺序、已有长期知识里也有一条发布流程"——整理会**新建**
    那份长期知识，而新建之后它和已有那条讲的是同一件事，补链应当把它们连起来。
    """
    _field_note(tmp_path)
    _write(
        tmp_path / "memory",
        "digest/procedure/发布流程.md",
        "---\nsummary: 发布流程\n---\n\n# 发布流程\n\n发布顺序固定为先跑门禁再打标签。\n",
    )
    service, workspace = _dream_service(tmp_path, ask=_FakeChat(_DREAM_REPLY))

    result = service.dream(force=True)

    assert result["created"] == ["digest/personal/发布顺序.md"]
    assert "digest/personal/发布顺序.md" in result["linked"]
    created = (workspace / "digest" / "personal" / "发布顺序.md").read_text(encoding="utf-8")
    peer = (workspace / "digest" / "procedure" / "发布流程.md").read_text(encoding="utf-8")
    # 模型给的那条关联与自动找到的这条**并进同一行**（不是各起一行）
    assert "另见 [[镜像发布]]、[[发布流程]]。" in created
    assert "另见 [[发布顺序]]" in peer, "另一头也要补（图谱的入链那一半）"


def test_parse_dream_reads_the_block_format() -> None:
    """围栏要吃掉、三个字段都要认出来、正文可以多行。"""
    units = _parse_dream(
        "```\n"
        "=== CREATE｜personal｜发布顺序\n"
        "摘要：发布顺序\n"
        "关联：[[镜像发布]] [[回滚流程]]\n"
        "正文：\n"
        "第一行\n"
        "第二行\n"
        "===\n"
        "```\n"
    )

    assert len(units) == 1
    unit = units[0]
    assert (unit.action, unit.bucket, unit.name) == ("CREATE", "personal", "发布顺序")
    assert unit.summary == "发布顺序"
    assert unit.links == ("镜像发布", "回滚流程")
    assert unit.body == "第一行\n第二行"


def test_parse_dream_skips_what_it_cannot_read() -> None:
    """**宽容的是"多写一句解释"，严格的是"字段值不合法"。**

    写进 ``digest/`` 的东西要长期留着，所以动作/类别认不出来、或者没有正文的那一条
    宁可丢掉（并记日志），也不猜着写下去。
    """
    units = _parse_dream(
        "好的，我整理了一下：\n"
        "=== UPDATE｜personal｜动作不认识\n摘要：x\n正文：\n有正文\n===\n"
        "=== CREATE｜不存在的类别｜类别不认识\n摘要：x\n正文：\n有正文\n===\n"
        "=== CREATE｜wiki｜少了正文\n摘要：只有摘要\n===\n"
        "=== CREATE｜wiki｜这条是对的\n摘要：对\n正文：\n正文在这里\n===\n"
    )

    assert [unit.name for unit in units] == ["这条是对的"]
    assert units[0].body == "正文在这里"


def test_parse_dream_tolerates_a_missing_body_marker() -> None:
    """模型偶尔漏掉「正文：」那个标记——**剩下的行仍然是内容**，不该整条丢掉。"""
    units = _parse_dream("=== CREATE｜wiki｜概念\n摘要：一句话\n就是正文本身。\n===\n")

    assert len(units) == 1
    assert units[0].body == "就是正文本身。"
    assert units[0].summary == "一句话"


def test_dream_slug_flattens_names_into_a_filename() -> None:
    """主题名要同时满足：能被 ``[[...]]`` 链上、在 Windows 上合法、同名即同一条。"""
    assert _dream_slug("发布顺序") == "发布顺序"
    assert _dream_slug("digest/wiki/锂价敏感性.md") == "锂价敏感性", "路径前缀要抹掉"
    assert _dream_slug("wiki/锂价敏感性.md") == "锂价敏感性"
    assert _dream_slug("  发布 顺序  ") == "发布-顺序"
    assert _dream_slug('a/b:c*d?"e') == "abcde"
    assert _dream_slug("///") == "未命名"


def test_the_archive_block_warns_against_placeholder_words(tmp_path: Path) -> None:
    """D26 的另一半：**注入的那一段**要拦住"照着占位词去追问"。

    D26（2026-09-28 走查）：那份 `PROFILE.md` 里三行写着「待确认」，于是**每一轮**
    注入之后模型都把它当成"还没做完的事"，见面就问"怎么称呼你"——那天 17 条新会话
    里 14 条都出现了这种追问。

    规则在期二搬进了**档案块**：病灶那几行字现在住在档案里，规则就该跟着它走
    （写在人设总起句里会让那一段去讲一份它已经不管的文件）。模板本身不再带提示语
    ——它是四区骨架，用户要填的是自己的话，不是我们的说明。
    """
    service = _service(tmp_path)
    _write(
        service.workspace,
        PROFILE_FILE,
        "---\nupdated: 2026-10-03\n---\n\n## 身份与称呼\n\n- **怎么称呼他：** 待确认\n",
    )

    block = service.archive_block()

    assert "没填的字段就当没填" in block
    assert "追问" in block
    # 点名那几个占位词：不点名的话，模型未必把「待补」也当成同一类
    assert "待确认" in block and "待补" in block
    # 骨架里只有四个标题与 frontmatter，没有我们的提示语混进去
    assert "待确认" not in memory_service._PROFILE_TEMPLATE
