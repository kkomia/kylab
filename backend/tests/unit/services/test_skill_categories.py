"""技能分类：**覆盖 178 条、每条只归一类、生成物与判据一致**。

镜像同构：``app/services/skill_categories.py`` → 本文件。

这一层是纯函数 + 两份文件，不需要真库：喂进去的是"本机装了什么"（`installed.json`）
与各技能的 `SKILL.md` frontmatter。所以这里钉的是**归属判据本身**，
而"页面上按分类列出来"那件事由前端用例 + 真浏览器截图钉（见交付记录）。

`backend/data/` 是运行期数据、不入库，缺了这些用例会**跳过**而不是编一份假数据来测：
在别的机器上它们本来就没有意义（分类判据本身仍然可用，`--check` 也能跑）。
"""

from __future__ import annotations

import json

import pytest

from app.services import skill_categories as sc

INSTALLED = sc.INSTALLED_PATH
requires_data = pytest.mark.skipif(
    not INSTALLED.exists(), reason="本机没装技能集（backend/data/ 是运行期数据，不入库）"
)


def _rows() -> list[dict[str, str]]:
    return sc._rows_from_disk()


@requires_data
def test_every_installed_skill_gets_exactly_one_declared_category() -> None:
    """不遗、不重、不越界：178 条每一条都在 `CATEGORIES` 里且只落一类。"""
    rows = _rows()
    assignments = sc.classify(rows)
    declared = {item.slug for item in sc.CATEGORIES}

    assert len(rows) == 178, "本机初始技能集应为 178 条"
    assert len(assignments) == len(rows), "一条技能只能有一个归属（slug 唯一）"
    assert set(assignments.values()) <= declared, "出现了没登记的类别"
    assert set(assignments) == {row["slug"] for row in rows}


@requires_data
def test_counts_add_up_to_the_total_and_every_category_has_a_label() -> None:
    """每类统计要加得回总数；每个类别都得有中文名（页面直接用）。"""
    assignments = sc.classify(_rows())
    counts = {item.slug: 0 for item in sc.CATEGORIES}
    for category in assignments.values():
        counts[category] += 1

    assert sum(counts.values()) == len(assignments) == 178
    for item in sc.CATEGORIES:
        assert item.label.strip(), f"{item.slug} 没有中文名"
    assert sc.CATEGORIES[-1].slug == sc.OTHER, "「其他」固定在最后一档"


@requires_data
def test_the_mapping_file_is_in_sync_with_the_rules() -> None:
    """生成物（页面读的那份 JSON）必须与判据一致——不一致说明有人只改了一边。

    改判据之后忘了 `--write` 就会在这里红：那是**故意的**，因为页面读的是 JSON，
    而"分类"的唯一真相是 `SIGNALS`。
    """
    payload = json.loads(sc.MAPPING_PATH.read_text(encoding="utf-8"))
    assignments = sc.classify(_rows())

    assert payload["assignments"] == assignments
    assert payload["categories"] == {item.slug: item.label for item in sc.CATEGORIES}


@requires_data
def test_unmistakable_skills_land_in_the_expected_category() -> None:
    """几条"名字就说明了一切"的锚点：规则被改坏时它们先红。"""
    anchors = {
        "pdf-pro": "documents",
        "image-to-editable-ppt": "slides",
        "academic-poster": "research",
        "knowledge-graph": "learning",
        "playwright-skill": "code",
        "code-review-skill": "code",
        "sci-download": "research",
        "seo-geo-aeo": "marketing",
        "personal-finance-skill": "business",
        "tasknotes": "productivity",
    }
    assignments = sc.classify(_rows())

    for slug, expected in anchors.items():
        assert assignments.get(slug) == expected, f"{slug} 应当属于 {expected}"


def test_no_signal_means_other_and_the_rule_table_explains_itself() -> None:
    """一条信号都不命中 → 「其他」（拿不准的不硬塞）；信号表的权重只有 1/2/3 三档。"""
    assert sc.category_of("zzz-nothing-matches-this-xyz") == sc.OTHER
    assert sc.OTHER == "other"

    for category, patterns in sc.SIGNALS:
        assert category in {item.slug for item in sc.CATEGORIES}
        assert patterns, f"{category} 没有任何信号"
        for weight, pattern in patterns:
            assert weight in (1, 2, 3), f"{category} 的权重只许 1/2/3，见到 {weight}"
            assert pattern.strip()


def test_the_name_beats_the_description() -> None:
    """名字里的命中按 ×2 计：描述里顺带提到别的领域的词，抢不走名字说清了的那条。

    `book-to-skill` 的描述里满是 PDF/DOCX/代码字样，名字直接说了"把书变成技能"。
    """
    text = "converts books and documents (PDF, EPUB, DOCX)"
    assert sc.category_of("book-to-skill", "", text) == "learning"
    assert sc.category_of("lineage-skill", "", "audio video pdf slides notes") == "learning"
