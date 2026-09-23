"""agent 模式四档的**判定矩阵**（P1-1，开发计划 §12.225）。

这一组用例守的是调研报告 §2.6 抄下来的那几条语义，而不是"函数能跑"：

1. **四档 × 读 / 写 / 执行三类工具**：只有 ``plan`` 档会真的拦，而且只拦"会改动东西"的；
2. **模式不改工具清单**：判定函数只看元数据与档位，没有任何"这一档不给这个工具"的口子
   ——它不接触工具表，工具表的同一性由 ``test_tool_loop`` 那条端到端用例钉住；
3. **拦下时说的话要够用**：为什么被拦（这一档的规矩 + 这个工具的影响面）与怎么办
   （先给计划、等确认），缺一样模型只会换个名字重试；
4. **``edit`` / ``yolo`` 的差别在"要不要问"**（``auto_approves``），不在"能不能做"。

工具名从 ``tool_meta.TOOL_META`` 里**取真实的条目**（不新造假元数据当夹具）：
元数据被改动时（比如哪天把 ``create_note`` 改成只读），这里的矩阵就该跟着红——
这正是它存在的意义。少数几条用 ``ToolMeta(...)`` 现造，因为要测的是**判定规则**
本身（例如"destructive 但影响面在会话里"这种组合，表里暂时没有对应工具）。
"""

from __future__ import annotations

import logging

import pytest

from app.core.config import Settings
from app.services import modes
from app.services.runtime_config import SETTING_GROUPS, RuntimeConfigService
from app.services.tool_meta import TOOL_META, ToolMeta, meta_of

#: 三类工具的代表。**取真实的工具名**：判定读的是它们真实的元数据。
READ_TOOLS = ("search", "list_documents", "read_file", "web_fetch", "list_skills", "query_table")
WRITE_TOOLS = ("create_note", "upload_document", "export_document", "remember", "spawn_subagent")
EXEC_TOOLS = ("run_command",)


def _verdict(name: str, mode: str, *, plan_given: bool) -> bool:
    return modes.allows(meta_of(name), mode, plan_given=plan_given, tool=name)[0]


# ------------------------------------------------------------------ 词表本身


def test_the_four_modes_are_exactly_zcodes_enum() -> None:
    """四档的名字与顺序**照抄 ZCode**（``build|edit|plan|yolo``），默认档是 ``build``。

    抄的不是"四个词"，而是"哪一档最不意外"：ZCode 的默认是"变更前确认"，
    所以我们也不把"全放行"或者"计划"设成默认——引入模式这件事**不该改变
    任何既有行为**，默认档必须与没有模式时一模一样。
    """
    assert modes.MODES == ("build", "edit", "plan", "yolo")
    assert modes.DEFAULT_MODE == "build"
    assert modes.DEFAULT_MODE in modes.MODE_DEFS


def test_each_mode_carries_the_zcode_one_line_copy() -> None:
    """四句人话就是 ZCode 的 UI 文案（直译），界面与回给模型的理由共用这一份。"""
    assert {item["name"]: item["hint"] for item in modes.describe()} == {
        "build": "变更前确认",
        "edit": "自动编辑",
        "plan": "先给计划再动手",
        "yolo": "少确认全放行",
    }
    # 每一档都要有 detail：界面的第二行、设置页的下拉项都从它取，空串会让界面出现空白项
    assert all(item["detail"] for item in modes.describe())


def test_an_unknown_mode_falls_back_to_the_default_and_says_so(caplog) -> None:
    """设置页是自由文本：写错了**回默认档并留一条日志**，不让整轮对话失败。

    静默回默认是"改了不生效"那类问题里最难查的一种，所以日志是这条的一部分。
    """
    with caplog.at_level(logging.WARNING):
        assert modes.coerce("nonsense") == "build"
        assert modes.coerce("") == "build"
        assert modes.coerce(None) == "build"
    assert "nonsense" in caplog.text

    # 大小写与空白照收（.env 里手写的那一份常常带空格）
    assert modes.coerce("  PLAN ") == "plan"
    assert modes.coerce("yolo") == "yolo"


# ------------------------------------------------------------------ 判定矩阵


@pytest.mark.parametrize("mode", modes.MODES)
@pytest.mark.parametrize("name", READ_TOOLS)
def test_read_only_tools_run_in_all_four_modes(mode: str, name: str) -> None:
    """只读工具**四档全放行**，``plan`` 档也不例外。

    计划档要挡的是"动手"，不是"查资料"：不给它读，它连计划都写不出来
    （要动哪几个文件都不清楚）。``web_fetch`` / ``web_search`` 也算只读——
    影响面 ``network`` 在我们这一档的含义是"只发请求、不改任何东西"，
    与 ``tool_meta.ToolMeta.parallel`` 同一处有据的偏离。
    """
    assert _verdict(name, mode, plan_given=False) is True


@pytest.mark.parametrize("mode", ("build", "edit", "yolo"))
@pytest.mark.parametrize("name", WRITE_TOOLS + EXEC_TOOLS)
def test_the_other_three_modes_only_change_whether_to_ask(mode: str, name: str) -> None:
    """``build`` / ``edit`` / ``yolo`` **一律放行**：它们的差别在"要不要问一句"。

    这是照抄 ZCode 的那条原则（"模式不影响工具是否存在，只喂权限引擎"）：
    如果这三档也各自拦一些，模式就变成了第二张权限表，与工具元数据迟早说不到一起。
    """
    assert _verdict(name, mode, plan_given=False) is True
    assert modes.allows(
        meta_of(name), mode, plan_given=False, tool=name, tool_label="写笔记"
    )[1] == ""


@pytest.mark.parametrize("name", WRITE_TOOLS + EXEC_TOOLS)
def test_plan_blocks_writes_until_the_plan_is_given(name: str) -> None:
    """``plan`` 档的核心：**没出计划之前写类一律被拦**（QwenPaw 的门闸）。

    计划给出来之后同一档就放行了——这一档要的不是"永远不许写"，
    而是"先给计划、等对方确认"。
    """
    assert _verdict(name, "plan", plan_given=False) is False
    assert _verdict(name, "plan", plan_given=True) is True


def test_writes_are_decided_by_metadata_not_by_a_hardcoded_name_list() -> None:
    """判定读的是元数据（``read_only`` / ``side_effect_scope``），不是工具名清单。

    两处都算"写类"：工具自己没声明只读（fail-closed），**或者**影响面落在
    会话/工作区/机器上。所以新加一个写类工具时不必来改这个模块——声明对了就自动被拦；
    反过来，漏声明只读的只读工具会被多拦一次（保守方向，可接受）。
    """
    assert modes.is_write(meta_of("create_note")) is True
    assert modes.is_write(meta_of("run_command")) is True
    assert modes.is_write(meta_of("search")) is False
    assert modes.is_write(meta_of("web_fetch")) is False
    # 未知工具（外部 MCP）：元数据取最保守的那一档，所以算写类
    assert modes.is_write(meta_of("mcp__someone__do_something")) is True
    assert _verdict("mcp__someone__do_something", "plan", plan_given=False) is False


def test_a_destructive_write_stays_blocked_in_plan_even_with_a_plan() -> None:
    """计划给出来了也不放行**需要单独点头的**那一些？——不，放行，理由在这条用例里。

    ``plan`` 档拦的是"没计划就动手"，与"要不要审批"是两件事（后者归 ``auto_approves``
    与 ``agent_exec`` 的三道闸）。所以 ``run_command`` 在计划给出之后照跑，
    只是仍然会停下来问用户（它 ``needs_approval``）。这条用例把那个分界钉住：
    **别人以后想"顺手在 plan 档里也拦掉 destructive"时，先来这里看一眼为什么没拦**。
    """
    meta = meta_of("run_command")
    assert meta.destructive and meta.needs_approval
    assert modes.allows(meta, "plan", plan_given=True, tool="run_command")[0] is True


def test_every_declared_tool_gets_a_verdict() -> None:
    """工具表里的每一个工具都要能判定（不抛、不返回 None）——表烂掉时立刻可见。"""
    for name, meta in TOOL_META.items():
        allowed, reason = modes.allows(meta, "plan", plan_given=False, tool=name)
        assert isinstance(allowed, bool)
        assert bool(reason) is (not allowed)
        # 允许的档位下永远允许，不允许的档位下永远给出理由，两者不重叠
        assert modes.allows(meta, "build", plan_given=False, tool=name) == (True, "")


# ------------------------------------------------------------------ 拦下时说的话


def test_the_refusal_says_why_and_what_to_do() -> None:
    """被拦时回给模型的话：**这一档的规矩 + 这个工具为什么算写类 + 怎么办**。

    只说"不允许"的回话会让模型反复重试同一个调用，而屏幕前的人不知道发生了什么
    （QwenPaw 的回灌文案是同一套三段式）。
    """
    allowed, reason = modes.allows(
        meta_of("create_note"),
        "plan",
        plan_given=False,
        tool="create_note",
        tool_label="写笔记",
    )

    assert allowed is False
    assert "「计划」档" in reason  # 现在是哪一档
    assert "先给出计划、等对方确认" in reason  # 这一档的规矩
    assert "写笔记" in reason and "create_note" in reason  # 拦的是哪一个调用
    assert "workspace" in reason  # 为什么它算"会改动东西"（用元数据说事实）
    assert "不要重试这个调用" in reason  # 防它换个名字重试
    # 不可逆的工具要额外说清（同样是拿元数据说话，不是形容词）
    _, dangerous = modes.allows(
        meta_of("run_command"), "plan", plan_given=False, tool="run_command"
    )
    assert "不可逆" in dangerous


def test_the_refusal_never_names_the_tool_it_did_not_get() -> None:
    """没有中文标签时退回原始工具名，而不是编一个人话或者留空。"""
    _, reason = modes.allows(meta_of("create_note"), "plan", plan_given=False, tool="create_note")
    assert "create_note" in reason


# ------------------------------------------------------------------ 要不要问一句


def test_auto_approve_matrix() -> None:
    """``auto_approves``：这一档下"要不要停下来问"。

    - ``build`` / ``plan``：不问它是**不问**，该问的照问（现状不变）；
    - ``edit``：会话/工作区里的非破坏性写入免问（"自动编辑"）；
      执行命令（影响面在整台机器）与 destructive 的照问；
    - ``yolo``：一律免问（ZCode：``"Yolo mode bypasses permission prompts"``）。
    """
    assert modes.auto_approves(meta_of("run_command"), "build") is False
    assert modes.auto_approves(meta_of("run_command"), "plan") is False
    assert modes.auto_approves(meta_of("run_command"), "edit") is False  # 影响面在机器上
    assert modes.auto_approves(meta_of("run_command"), "yolo") is True

    workspace_write = ToolMeta(
        side_effect_scope="workspace", risk_level="medium", needs_approval=True
    )
    assert modes.auto_approves(workspace_write, "edit") is True
    assert modes.auto_approves(workspace_write, "build") is False
    assert modes.auto_approves(workspace_write, "yolo") is True

    # destructive 的即使落在工作区里也不免问：删东西不可逆，"自动编辑"管不到它
    assert modes.auto_approves(
        ToolMeta(side_effect_scope="workspace", destructive=True, needs_approval=True), "edit"
    ) is False
    assert modes.auto_approves(meta_of("delete_document"), "edit") is False


# ------------------------------------------------------------------ 存得下来（验收 ④）


def test_the_mode_is_a_runtime_setting_with_an_env_bootstrap(bundle) -> None:  # type: ignore[no-untyped-def]
    """``chat.mode`` 是**运行期配置**：网页上改的落库，``.env`` 只是引导值。

    "刷新之后还在"靠的就是这一层（前端读的是同一个 ``/settings``）。
    引导值那一半与记忆那三项同一口径（见 ``runtime_config._bootstrap_value``）：
    容器部署能在 compose 里一次写清"这个部署默认用哪一档"，
    而它的优先级排在数据库**下面**——部署时预设一次，之后以网页上的为准。
    """
    settings = Settings(chat_mode="plan")  # type: ignore[call-arg]
    runtime = RuntimeConfigService(bundle, settings)

    assert runtime.get("chat.mode") == "plan"  # .env 引导

    runtime.set({"chat.mode": "yolo"})
    assert runtime.get("chat.mode") == "yolo"  # 网页上写的盖住引导值


def test_the_default_mode_is_build_without_any_configuration(runtime) -> None:  # type: ignore[no-untyped-def]
    """什么都没配时是 ``build``（与 ZCode 默认一致）：**引入模式不改变既有行为**。"""
    assert runtime.get("chat.mode") == "build"
    assert modes.coerce(runtime.get("chat.mode")) == modes.DEFAULT_MODE


def test_the_settings_page_offers_exactly_the_four_modes() -> None:
    """设置页那一项的下拉项与 ``modes.describe()`` **同源**（四个，不多不少）。

    两处各写一份的话，界面上的档名与引擎的档名迟早会对不上——
    而"选了一个引擎不认识的档"这件事只会表现为"模式好像没生效"。
    """
    field = next(
        item for item in SETTING_GROUPS["chat"]["fields"] if item["key"] == "chat.mode"
    )

    assert field["type"] == "select"
    assert [option["value"] for option in field["options"]] == list(modes.MODES)
