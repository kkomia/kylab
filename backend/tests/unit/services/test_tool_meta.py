"""工具元数据表（v0.42，抄 ZCode 的六字段 + DSH 的 fail-closed 分组）。

这一组的价值在**防漏**：表里少一个工具，那条路就是"按独占算"（慢，但不坏数据），
所以漏了不会报错——只会在某天有人问"为什么这批突然不并发了"。
于是用一条门禁把口子封死：**内置工具一个都不能漏**。
"""

from __future__ import annotations

import pytest

from app.services.agent_tools import _LOCAL_TOOLS, _SKILL_TOOLS
from app.services.tool_meta import TOOL_META, meta_of, parallel_groups
from app.services.tools import TOOL_NAMES


def _builtin_names() -> set[str]:
    """内置工具名：MCP 那批（``TOOL_NAMES``）+ 技能那批（``_SKILL_TOOLS``）+
    这台机器上那批（``_LOCAL_TOOLS``）。三段都要，漏一段门禁就有洞。"""
    return (
        set(TOOL_NAMES)
        | {str(item["name"]) for item in _SKILL_TOOLS}
        | {str(item["name"]) for item in _LOCAL_TOOLS}
    )


def test_every_builtin_tool_declares_its_metadata() -> None:
    """**内置工具一个都不能漏**（新加工具时必须来这张表上声明一次）。

    漏掉的后果不是报错，而是它被当成"独占"——那是安全的默认，
    但"为什么这个工具不并发"会变成没人答得上来的问题。
    """
    missing = sorted(_builtin_names() - set(TOOL_META))
    assert missing == [], f"这些内置工具没有声明元数据：{missing}"


def test_the_table_has_no_ghosts() -> None:
    """反过来也要查：表里不该有已经不存在的工具名（改名后忘了删）。"""
    ghosts = sorted(set(TOOL_META) - _builtin_names())
    assert ghosts == [], f"表里有已经不存在的工具：{ghosts}"


def test_values_are_from_the_agreed_vocabulary() -> None:
    """取值只能来自约定的词表（照 ZCode 的枚举）——拼错了会被当成"另一个档"。"""
    from app.services.tool_meta import RISKS, SCOPES

    for name, meta in TOOL_META.items():
        scope = meta.side_effect_scope
        assert scope in SCOPES, f"{name} 的影响面取值非法：{scope}"
        assert meta.risk_level in RISKS, f"{name} 的风险分级非法：{meta.risk_level}"


def test_reading_tools_are_the_ones_that_parallelize() -> None:
    """**只读 + 无副作用**的才并发；写类与执行类一律独占。

    这是这张表存在的全部理由：v0.41 之前整批一律并发，
    而"导出文档 + 写笔记 + 上传"并发就是在赌它们之间没有共享状态。
    """
    parallel = {name for name, meta in TOOL_META.items() if meta.parallel}
    assert "search" in parallel
    assert "web_search" in parallel
    assert "read_file" in parallel
    for name in ("create_note", "delete_document", "upload_document", "run_command", "remember"):
        assert name not in parallel, f"{name} 会改东西，不该并发"
    # 联网那两个**影响面是 network 而不是 none**，但它们是只读的：
    # 这里刻意允许（照 ZCode 的判定，一次网络读不会改任何东西）
    assert meta_of("web_fetch").read_only is True


def test_an_unknown_tool_falls_back_to_the_conservative_side() -> None:
    """未知工具（外部 MCP、以后新加的）**按独占算**：fail-closed。"""
    meta = meta_of("mcp__whatever__do_something")
    assert meta.parallel is False
    assert meta.concurrent_safe is False
    assert meta.side_effect_scope == "system"
    assert meta.risk_level == "high"


def test_run_command_always_needs_approval() -> None:
    """执行命令在元数据这一层就写着"总是要问"——策略之外的第二道（照 ZCode 的 Bash）。"""
    meta = meta_of("run_command")
    assert meta.needs_approval is True
    assert meta.destructive is True
    assert meta.side_effect_scope == "system"
    assert meta.parallel is False


@pytest.mark.parametrize(
    ("names", "expected"),
    [
        # 三条只读连成一组
        (["read_file", "read_file", "read_file"], [[0, 1, 2]]),
        # 独占的在中间：前后各成一组，它自己是屏障
        (["read_file", "create_note", "read_file"], [[0], [1], [2]]),
        # 混排：两条读并发 → 一条写独占 → 两条读并发
        (
            ["web_fetch", "read_file", "run_command", "read_file", "web_fetch"],
            [[0, 1], [2], [3, 4]],
        ),
        # 未知工具也是独占，两个未知之间不并发
        (["mcp__a__x", "mcp__a__x"], [[0], [1]]),
    ],
)
def test_grouping_shape(names: list[str], expected: list[list[int]]) -> None:
    """分组的形状（组序 = 调用序，组内可并发，独占各成一组）。"""
    assert parallel_groups(names) == expected
