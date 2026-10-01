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


def _no_jieba(monkeypatch: pytest.MonkeyPatch) -> None:
    """让 ``import jieba`` 真的失败（抛的是**真** ``ModuleNotFoundError``）。

    比 monkeypatch 掉 ``coverage._jieba`` 更接近现场：那台机器上就是"这个包不在"，
    而产品代码要挡的正是 import 那一刻。两件事都得做：

    1. 拦住 import（``sys.meta_path`` 里插一个只拒 jieba 的 finder）；
    2. **清掉分词器缓存**（`coverage._JIEBA`）——上一个用例可能已经把它导进来了。
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


@pytest.mark.local
def test_recall_still_works_when_jieba_is_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """**缺 jieba 的运行时里，召回不许整条炸掉**（打包后的桌面端就是这种运行时）。

    现场事实（阶段 3 发现、阶段 5 修）：客户端运行时里**没有 jieba**（约 41 MB，
    `requirements-sidecar.txt` 明写不打包），而记忆召回自 M2 阶段 3 起在**本机**跑——
    于是第一次调用分词器时抛 ``ModuleNotFoundError``，而它抛在一轮对话中间：
    表现是"召回整个失败"，不是"少了一条证据"。

    修法：分词那条通道失败时**降级**（`memory_files._requirement_terms`），
    由不依赖分词的"相邻字对"通道把人救回来。这条用例同时钉两件事：

    1. **召回仍然返回**（命中同一个文件——字对通道给出的证据指着同一处）；
    2. **"降级了"这件事看得见**：界面与工具两处的说明都如实加上那句话
       （`memory_files.SEGMENTATION_UNAVAILABLE_NOTE`）。

    标 ``local``：这条要证明的恰恰是**没有 PostgreSQL（也没有 jieba）的那台机器**
    上的行为，而它只用临时目录与假 runtime——在缺 PG 的机器上跳过它，
    等于把 M2 阶段 5 修的这件事整条跳过。
    """
    service = _service(tmp_path)
    _seed(service)
    _no_jieba(monkeypatch)
    # 那个标记是**进程级**的（一台机器上"有没有 jieba"不会变），用例自己擦干净：
    # 留着它会让后面的用例看到一句本不该出现的说明
    monkeypatch.setattr(memory_files, "_SEGMENTATION_MISSING", False)

    hits, _links = service.recall("锂价下跌对毛利的影响")

    assert hits, "缺 jieba 不该把召回整条打掉"
    assert hits[0].path == "digest/personal/锂价.md"
    assert memory_files.segmentation_unavailable() is True
    # 走的是字对那条通道：实词一个都没有（分词不可用），字对是有的
    assert memory_files._requirement_terms("锂价下跌对毛利的影响") == []
    assert memory_files._word_pairs("锂价下跌对毛利的影响")

    from app.api.v1.memory import _recall_note as api_note
    from app.services.tools import _recall_note as tool_note

    note = memory_files.SEGMENTATION_UNAVAILABLE_NOTE
    assert note in api_note(), "界面那句说明没有如实说降级"
    assert note in tool_note(), "模型听到的那句说明没有如实说降级"


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
    # 召回池切出来的块数：digest 那份 2 块（一段正文 + 一条条目，标题进了面包屑）、
    # daily 那份 2 块（两条 bullet 各自成块）——P1 的 AST 分块把标题从"空块"改成了
    # 面包屑，所以这里从 7 掉到 4：**少的全是答不上话的空块**。
    assert status.entry_count == 4
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


def test_capture_due_is_false_without_a_store(tmp_path: Path) -> None:
    """没接存储时是**假**：不能只判开关与节流。

    ``capture_turn`` 第一件事就是查 ``_stores``（没有它入不了队），所以
    "会不会真的入队"必须把存储一起算进去——否则界面那条「交给长期记忆」
    会说会沉淀，而实际什么也不会发生（见 `api/v1/chat._memory_handoff_step`）。
    """
    with_store, _meta = _capturing_service(tmp_path)
    bare = _service(tmp_path)

    assert with_store.capture_due(5) is True
    assert bare.capture_due(5) is False


def test_capture_due_follows_the_throttle(tmp_path: Path) -> None:
    service, _meta = _capturing_service(tmp_path, **{"memory.capture_every": "3"})

    assert service.capture_due(2) is False
    assert service.capture_due(3) is True


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


# ------------------------------------------------------------------ 记忆指导


def test_guidance_is_empty_when_the_switch_is_off(tmp_path: Path) -> None:
    """**关着时不给指导**：那时 `recall` 会明确报错，把"什么时候该去查记忆"
    讲给模型听，只会换来每轮一次无效调用加一句错误。

    这与知识库那一侧是同一个形状（见 `agent_tools._KB_TOOLS` 的说明：给了又拒，
    白花两个来回）——那边已经踩过一次，记忆这一侧别再踩。
    """
    off = _service(tmp_path, **{"memory.enabled": "false"})
    on = _service(tmp_path)

    assert off.guidance() == ""
    assert on.guidance() != ""


def test_guidance_names_the_directories_we_actually_use(tmp_path: Path) -> None:
    """目录名**从 `memory_files` 取**，不在这里写死。

    写死两处的坏法很具体：改了目录而提示词没跟上，模型就会去翻一个不存在的
    地方——而这个仓库对"给模型描述一个不存在的机制"是零容忍的。
    所以这里断言的是常量本身，不是字面量。
    """
    from app.services import memory_files

    text = _service(tmp_path).guidance()

    assert f"{memory_files.DAILY_DIR}/YYYY-MM-DD.md" in text
    assert f"{memory_files.DIGEST_DIR}/" in text
    assert "recall" in text and "remember" in text


def test_guidance_expands_with_read_memory_not_read_file(tmp_path: Path) -> None:
    """片段不够时要指向 `read_memory`，**不能指向 `read_file`**。

    `read_file` 的根只有 workspace / sandbox（见 `agent_files.Roots.pick`），
    够不到 `data/memory/`——指过去，模型会去读一个它读不到的地方，然后把失败
    当成"记忆里没有"。`read_memory` 才是记忆那一侧的入口。
    """
    text = _service(tmp_path).guidance()

    assert "read_memory" in text
    assert "read_file" not in text


# ------------------------------------------------------------------ 首次引导


def test_bootstrap_shows_while_the_profile_is_still_the_template(tmp_path: Path) -> None:
    """人设还是空模板时给引导，**填上之后它自己就没了**。

    这是"感觉不到人设"的正面解法：``PROFILE.md`` 模板里"名字："后面是空的，
    而**没有任何机制会让它被填上**——用户不会主动去改一个人设文件（他甚至不知道
    有这回事），Agent 也不会问。QwenPaw 用一份"用完就删"的 BOOTSTRAP.md 解决；
    我们用**没有这个问题的等价信号**（"资料还空着"），于是不需要"用过就删"的簿记。
    """
    service = _service(tmp_path)
    service.seed_persona()

    assert service.bootstrap_block() != ""

    service.write_file(PROFILE_FILE, "---\nsummary: 资料\n---\n\n- 名字：小又\n")

    assert service.bootstrap_block() == ""


def test_bootstrap_tells_the_agent_how_to_write_it_down(tmp_path: Path) -> None:
    """引导里必须写清"答案往哪儿放"——不然模型问完就忘了。

    只写 `PROFILE.md` 不够：Agent **没有**碰记忆文件的现成工具（``read_file``
    够不到 ``data/memory/``），所以指令里得点名 `write_memory` 与 `read_memory`，
    否则它会去试一个做不到的动作。
    """
    service = _service(tmp_path)
    service.seed_persona()

    text = service.bootstrap_block()

    assert "write_memory" in text and "read_memory" in text
    assert "PROFILE.md" in text and "SOUL.md" in text


def test_bootstrap_does_not_depend_on_the_memory_switch(tmp_path: Path) -> None:
    """关着长期记忆也要引导：人设的注入与编辑本来就不受那道闸管
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


def test_capture_turn_sends_everything_since_the_last_capture(tmp_path: Path) -> None:
    """**这是本轮修的那个漏**：拍 10 轮，每一轮都要进过记忆。

    原先每次只把**当轮**那两条交给队列，而节流是"每 5 个用户回合一次"——
    两者相乘的结果是每 5 轮里只有 1 轮被看过一眼，其余 4 轮永远不进入记忆。
    用户那边的现象就是"我明明说过，它就是不记得"。

    照 QwenPaw 的 Auto-Memory：它处理的也是"上次以来累积的对话"。
    """
    service, meta = _capturing_service(tmp_path)
    every_turn = _turns(10)
    for turn in range(1, 11):
        # 真实时序：这一轮的消息先落库，收尾时才谈沉淀
        meta.messages = [item for item in every_turn if every_turn.index(item) < turn * 2]
        service.capture_turn("c1", turn_count=turn)

    assert len(meta.tasks) == 2
    assert _bodies(meta, 0)[0] == "t1 问"
    assert _bodies(meta, 1)[0] == "t6 问"
    covered = {text for index in range(len(meta.tasks)) for text in _bodies(meta, index)}
    assert len(covered) == 20, "10 轮 = 20 条消息，两次沉淀合起来必须全覆盖"


def test_capture_turn_caps_one_payload_and_catches_up_next_time(tmp_path: Path) -> None:
    """一次 payload 有上限；超出的**下一轮接着补**，不是静默丢掉。

    没有上限的话，一个中间一直没沉淀的会话会把几百条消息塞进 ``tasks`` 表的
    一行 JSON——那种形状平时看不出问题，出事时很难查。
    """
    from app.services.memory import CAPTURE_BATCH_TURNS

    service, meta = _capturing_service(tmp_path)
    meta.messages = _turns(CAPTURE_BATCH_TURNS + 10)

    service.capture_turn("c1", force=True)
    first = len(_bodies(meta, 0))
    service.capture_turn("c1", force=True)

    assert first == CAPTURE_BATCH_TURNS * 2
    assert first + len(_bodies(meta, 1)) == len(meta.messages)


def test_capture_turn_force_bypasses_the_throttle(tmp_path: Path) -> None:
    """压缩那一刻要能**立刻**沉淀（照 QwenPaw 把 compact 当第三个触发源）。

    被折进摘要的消息从此不再进模型视野；记忆要是还没记过它们，用户下一轮问
    "刚才说的那个"就两头都查不到——原文成了摘要、``recall`` 里也还没有。
    """
    service, meta = _capturing_service(tmp_path)
    meta.messages = _turns(1)

    assert service.capture_turn("c1", turn_count=1) is False
    assert service.capture_turn("c1", turn_count=1, force=True) is True


def test_capture_turn_takes_a_recent_window_when_the_watermark_is_gone(
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

    service.capture_turn("c1", force=True)

    assert _bodies(meta, 0)[0] == f"t{30 - CAPTURE_BATCH_TURNS + 1} 问"


def test_capture_turn_advances_the_watermark_past_an_empty_message(
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

    service.capture_turn("c1", force=True)

    assert _bodies(meta, 0) == ["真问题"]
    assert meta.settings["memory.captured.c1"] == "y2"


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
    """开关关着时**一次嵌入都不发**，检索完全走词面那一路。

    这条是"默认关"那个决定的兑现方式：默认配置下，记忆层不该因为多了一条路而开始花钱。
    同时它如实记着那句词面那一路的边界——同义写法**搜不到**。
    """
    fake = _FakeEmbed()
    service = _service(tmp_path, **{"memory.vector_enabled": "false"}, embed=fake)
    _write(service.workspace, "digest/偏好.md", "# 偏好\n\n沟通风格是开门见山。\n")

    hits, _links = service.recall("我之前的回答是什么风格")

    assert fake.calls == [], "关着时不该有任何嵌入调用"
    assert hits == [], "词面那一路搜不到它——这正是向量那一路存在的理由"


def test_recall_finds_a_synonym_when_the_vector_route_is_on(tmp_path: Path) -> None:
    """开着时**同义写法也能找到**，并且如实标成"按意思找到的"。"""
    fake = _FakeEmbed()
    service = _service(tmp_path, **{"memory.vector_enabled": "true", **_FLOOR}, embed=fake)
    _write(service.workspace, "digest/偏好.md", "# 偏好\n\n沟通风格是开门见山。\n")
    chunk = memory_files.chunks_for_index(service.workspace)[0][3]
    fake.table[chunk] = [1.0, 0.0]
    fake.table["我之前的回答是什么风格"] = [1.0, 0.0]
    service.sync_index(force=True)

    hits, _links = service.recall("我之前的回答是什么风格")

    assert [hit.path for hit in hits] == ["digest/偏好.md"]
    assert hits[0].source == "vector"
    assert hits[0].coverage == 0.0, "语义那一路没有覆盖率这个概念（界面靠 source 说清）"


def test_recall_keeps_noise_empty_with_the_vector_route_on(tmp_path: Path) -> None:
    """**噪声查询仍然返回空**：余弦下限是这一路唯一的判据。

    没有下限的话，任何查询都会返回"最像的几条"，而"没召回任何东西 = 这几份记忆里
    确实没有相关的话"这条性质就毁了。
    """
    fake = _FakeEmbed()
    service = _service(tmp_path, **{"memory.vector_enabled": "true", **_FLOOR}, embed=fake)
    _write(service.workspace, "digest/偏好.md", "# 偏好\n\n沟通风格是开门见山。\n")
    chunk = memory_files.chunks_for_index(service.workspace)[0][3]
    fake.table[chunk] = [1.0, 0.0]
    fake.table["合唱团的排练时间安排"] = [0.0, 1.0]  # 正交 → 余弦 0
    service.sync_index(force=True)

    hits, _links = service.recall("合唱团的排练时间安排")

    assert hits == []


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
    """没配就是那张默认表：身份 → 资料 → 规程 → 记忆（越靠后越像"数据"）。"""
    service = _service(tmp_path)

    assert service.persona_order() == (SOUL_FILE, PROFILE_FILE, AGENTS_FILE, CORE_MEMORY_FILE)


def test_persona_order_follows_the_setting(tmp_path: Path) -> None:
    """用户能决定哪几份、按什么顺序进提示词；``persona_texts`` 跟着这个顺序读。

    最实际的用法是**把 ``MEMORY.md`` 去掉**——QwenPaw 的默认形态就是不去注入它
    （它那侧那份是很大的索引页）；我们默认注入（我们的是 ``remember`` 逐条维护的
    小文件），现在这个差异由用户自己决定。
    """
    service = _service(tmp_path, **{"memory.persona_files": "AGENTS.md, SOUL.md"})
    _write(service.workspace, SOUL_FILE, "我的人格")
    _write(service.workspace, CORE_MEMORY_FILE, "记过的事")
    _write(service.workspace, AGENTS_FILE, "操作规程")

    assert service.persona_order() == (AGENTS_FILE, SOUL_FILE)
    assert [name for name, _text in service.persona_texts()] == [AGENTS_FILE, SOUL_FILE]


def test_persona_order_takes_a_full_width_comma_too(tmp_path: Path) -> None:
    """中文输入法下逗号是全角的——**那不是用户的错**，别让他配了没反应。"""
    service = _service(tmp_path, **{"memory.persona_files": "SOUL.md，AGENTS.md"})

    assert service.persona_order() == (SOUL_FILE, AGENTS_FILE)


def test_persona_order_drops_names_it_does_not_know(tmp_path: Path) -> None:
    """只认那四份核心文件，其余丢掉：**让任意路径进 system prompt 等于绕过分界**
    （哪些是"设定"、哪些是"被召回的现场"）。想去掉重复的名字也在这里收掉。"""
    service = _service(
        tmp_path, **{"memory.persona_files": "SOUL.md, daily/x.md, SOUL.md, 笔记.md"}
    )

    assert service.persona_order() == (SOUL_FILE,)


def test_persona_order_falls_back_when_nothing_is_recognised(tmp_path: Path) -> None:
    """全不认识 → 回到默认顺序：**"配错了"不该变成"一份都不注入"**。

    一份都不注入等于让 agent 突然失忆、还失了人格——而用户只是打错了一个文件名。
    """
    service = _service(tmp_path, **{"memory.persona_files": "不存在的文件.md"})

    assert service.persona_order() == (SOUL_FILE, PROFILE_FILE, AGENTS_FILE, CORE_MEMORY_FILE)


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


def test_the_profile_template_warns_against_placeholder_words() -> None:
    """D26 的另一半：模板要拦住"下一份又被写成待确认"。

    字段**留空**（空值不会被当成待办），提示语才点名那几个词——两件事都要在，
    少一半都会重新长出那种"每轮追问"的文件。
    """
    template = memory_service._PROFILE_TEMPLATE

    assert "没填的就留空" in template
    assert "待确认" in template  # 只出现在提示语里
    # 字段值必须是空的：`- **名字：**` 后面直接换行
    assert "- **名字：**\n" in template
    assert "- **怎么称呼他：**\n" in template
