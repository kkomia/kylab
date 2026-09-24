"""``api/v1/skills.py`` 的 ``_out``：中文简介从哪来、两边都有时听谁的（v0.53）。

要钉的是一条**跨两处的一致性**：能力页（``_out``）与命令菜单
（``core/services.py`` 的 ``_skill_summaries``）读的是同一份数据、必须同一套优先序。
两边反了不会报错，只会让同一个技能在两个界面上显示两句不同的说明——
那种错没人会发现，除非有人正好两处都看。

优先序：**安装清单那份 > 技能 frontmatter 自带那份**
（市场那份是为中文界面存的、更短更贴；frontmatter 那份常是英文），
只有前者没有时才退回后者（仓库自带的 5 个走这条）。
"""

from __future__ import annotations

from app.api.v1.skills import _out
from app.services.skills import SkillRecord


def _record(summary: str) -> SkillRecord:
    return SkillRecord(
        name="weekly-report",
        description="Weekly report",
        path="skills/weekly-report/SKILL.md",
        source="builtin",
        directory="weekly-report",
        summary=summary,
    )


def test_the_market_blurb_wins_when_both_sides_have_one() -> None:
    """两边都有：用清单那份（与 ``_skill_summaries`` 的覆盖顺序一致）。"""
    item = _out(_record("技能自己写的简介"), "市场装的时候存的中文简介")
    assert item.summary == "市场装的时候存的中文简介"


def test_it_falls_back_to_the_skills_own_summary() -> None:
    """清单里没有（仓库自带的技能没有安装那一步）：用 frontmatter 里那份。"""
    item = _out(_record("把结果整理成一份周报"), "")
    assert item.summary == "把结果整理成一份周报"


def test_no_summary_anywhere_is_an_empty_string() -> None:
    """两处都没有就是空串——界面按"没有中文简介"处理，不编一句出来。"""
    assert _out(_record("")).summary == ""
