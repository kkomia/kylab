"""记忆文件层（v0.14 三期）。

镜像同构：``app/services/memory_files.py`` → 本文件。

这一层的错法都很安静，所以逐条钉住：

1. **路径越界**：它由前端传进来（``GET /memory/files/{path}``），不拦就等于
   把整个文件系统开放出去。``safe_path`` 的每一道检查都要有对应用例。
2. **分类与"能不能被召回"**：``retrievable`` 是实测 ReMe 的 ``watch_dirs`` 得出的
   （只有 ``daily/`` 与 ``digest/`` 进索引）。它错了界面就会骗人——
   用户改完一个文件搜不到，而界面说"应该能搜到"。
3. **链接解析**：手写的 wikilink 有全路径/文件名/主干三种写法，
   少认一种就丢半边图；重名时**必须不猜**，宁可标成悬空链接。
4. **列表与单文件读的字段必须一致**：两边曾各拼一份，加字段必漏一边。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.core.exceptions import InvalidRequestError, NotFoundError
from app.services.memory_files import (
    MAX_WRITE_BYTES,
    classify,
    delete_file,
    describe,
    graph_of,
    parse_frontmatter,
    read_file,
    safe_path,
    scan,
    wikilinks,
    write_file,
)


def _workspace(tmp_path: Path) -> Path:
    """一个像真工作区那样的目录：核心文件、每日现场、整合产物、派生物都有。"""
    root = tmp_path / "memory"
    (root / "daily" / "2026-09-16").mkdir(parents=True)
    (root / "digest" / "personal").mkdir(parents=True)
    # 派生物目录：里面就算有 .md 也不该出现在列表里
    (root / "session" / "dialog").mkdir(parents=True)
    (root / "resource").mkdir(parents=True)

    (root / "MEMORY.md").write_text(
        "---\nsummary: 核心长期记忆\n---\n\n## 核心长期记忆\n\n- 用户偏好先给结论\n",
        encoding="utf-8",
    )
    (root / "SOUL.md").write_text("# 我是 KYLAB\n\n说话直接。\n", encoding="utf-8")
    (root / "daily" / "2026-09-16" / "会话一.md").write_text(
        "---\nsummary: 现场\n---\n\n# 今天的现场\n\n结论见 [[digest/personal/锂价.md]]，"
        "另外 [[不存在的.md]] 是写错的。\n",
        encoding="utf-8",
    )
    (root / "digest" / "personal" / "锂价.md").write_text(
        "---\ntags: [锂价, 成本]\n---\n\n# 锂价敏感性\n\n"
        "来源 [[会话一]] 与 [[daily/2026-09-16/会话一.md]]。\n",
        encoding="utf-8",
    )
    (root / "session" / "dialog" / "conv_x.md").write_text("# 原始对话\n", encoding="utf-8")
    (root / "resource" / "外部资料.md").write_text("# 外部资料\n", encoding="utf-8")
    return root


# --------------------------------------------------------------------- 路径


@pytest.mark.parametrize(
    "bad",
    [
        "../backend/.env",  # 经典越界
        "daily/../../x.md",  # 走到一半再越界
        "/etc/passwd",  # 绝对路径
        "C:/Windows/x.md",  # Windows 盘符
        "C:foo.md",  # Windows 驱动器相对路径（会解析到别处）
        "a.md:stream",  # NTFS 备用数据流
        "",  # 空
        "   ",  # 空白
        "notes.txt",  # 不是 Markdown
        "a.md\x00",  # 控制字符
    ],
)
def test_safe_path_rejects_escapes(tmp_path: Path, bad: str) -> None:
    """越界路径一律拒。**最后一道是解析后复查**：前几道挡的是"写出来的坏路径"，
    而符号链接、盘符花样只有真解析一遍才确认得了。"""
    with pytest.raises(InvalidRequestError):
        safe_path(_workspace(tmp_path), bad)


def test_safe_path_normalizes_separators_and_dots(tmp_path: Path) -> None:
    """正常路径要放行，且 ``\\`` 与多余的 ``./`` 都归一化。"""
    workspace = _workspace(tmp_path)
    target = safe_path(workspace, "digest/personal/锂价.md")
    assert target.name == "锂价.md"
    assert safe_path(workspace, "digest\\personal\\锂价.md") == target
    assert safe_path(workspace, "./digest/personal/锂价.md") == target


def test_safe_path_allows_new_file(tmp_path: Path) -> None:
    """还没存在的文件也要能解析出来——新建整合笔记要写它。"""
    target = safe_path(_workspace(tmp_path), "digest/procedure/新流程.md")
    assert not target.exists()


# ------------------------------------------------------------------- 纯函数


def test_parse_frontmatter_splits_meta_and_body() -> None:
    meta, body = parse_frontmatter("---\nsummary: 一句话\ntags: [a, b]\n---\n\n正文\n")
    assert meta == {"summary": "一句话", "tags": ["a", "b"]}
    assert body.strip() == "正文"


def test_parse_frontmatter_survives_broken_yaml() -> None:
    """YAML 坏了**不能抛错**：用户正是进来修它的，此时打不开等于把人关在门外。
    退回"没有 frontmatter"、正文原样返回（含那段 ``---``）。"""
    text = "---\nsummary: '没闭合的引号\n---\n\n正文\n"
    meta, body = parse_frontmatter(text)
    assert meta == {}
    assert body == text


def test_parse_frontmatter_without_block() -> None:
    meta, body = parse_frontmatter("# 标题\n")
    assert meta == {}
    assert body == "# 标题\n"


def test_wikilinks_dedupes_and_keeps_order() -> None:
    """``[[目标|显示名]]`` 也要认；重复的只留一次（一条边不该画两遍）。"""
    found = wikilinks("看 [[a.md]] 与 [[b|c 的名字]]，还有 [[a.md]] 和 [[  c  ]]")
    assert found == ["a.md", "b", "c"]


@pytest.mark.parametrize(
    ("path", "expected"),
    [
        ("MEMORY.md", "core"),
        ("SOUL.md", "core"),
        ("daily/2026-09-16/x.md", "daily"),
        ("memory/2026-09-16/x.md", "daily"),
        ("digest/wiki/x.md", "digest"),
        ("resource/x.md", "other"),
        ("根下别的.md", "other"),
    ],
)
def test_classify(path: str, expected: str) -> None:
    """``memory/`` 与 ``daily/`` 都算每日现场：ReMe 的默认是 ``daily``，
    QwenPaw 那族写 ``memory``，我们可能被任一版本初始化过。"""
    assert classify(path) == expected


# --------------------------------------------------------------------- 扫描


def test_scan_skips_derived_dirs(tmp_path: Path) -> None:
    """``session/`` 与 ``resource/`` 是**派生物**：原始对话与外部资料就算存成 .md
    也不是记忆，列出来只会把真正要改的东西淹掉。"""
    paths = [item.path for item in scan(_workspace(tmp_path))]
    assert "session/dialog/conv_x.md" not in paths
    assert "resource/外部资料.md" not in paths
    assert paths == sorted(paths, key=paths.index)  # 顺序稳定
    assert {"MEMORY.md", "SOUL.md"} <= set(paths)


def test_scan_marks_retrievable_only_for_watched_dirs(tmp_path: Path) -> None:
    """只有 ``daily/`` 与 ``digest/`` 进检索索引（ReMe 的 ``watch_dirs``）；
    核心文件靠注入，其余既不召回也不注入。界面全靠这个字段解释"为什么搜不到"。"""
    by_path = {item.path: item for item in scan(_workspace(tmp_path))}
    assert by_path["daily/2026-09-16/会话一.md"].retrievable is True
    assert by_path["digest/personal/锂价.md"].retrievable is True
    assert by_path["MEMORY.md"].retrievable is False
    assert by_path["MEMORY.md"].is_core is True
    assert by_path["SOUL.md"].is_core is True


def test_scan_core_title_is_filename_not_heading(tmp_path: Path) -> None:
    """``MEMORY.md`` 正文里那个 ``## 核心长期记忆`` 是章节名、不是它的名字。
    取成标题的话，列表里会出现一个叫"核心长期记忆"的条目，而用户找的是 MEMORY.md。"""
    by_path = {item.path: item for item in scan(_workspace(tmp_path))}
    assert by_path["MEMORY.md"].title == "MEMORY.md"
    assert by_path["SOUL.md"].title == "SOUL.md"


def test_scan_reads_frontmatter_and_heading(tmp_path: Path) -> None:
    by_path = {item.path: item for item in scan(_workspace(tmp_path))}
    daily = by_path["daily/2026-09-16/会话一.md"]
    assert daily.summary == "现场"
    assert daily.title == "今天的现场"
    assert daily.kind == "daily"
    assert daily.links == ("digest/personal/锂价.md", "不存在的.md")
    assert daily.size_bytes > 0
    assert daily.modified_at


def test_scan_marks_consolidated_by_backlink(tmp_path: Path) -> None:
    """「哪些还没被整合」= ``daily/`` 里没被 ``digest/`` 链到的。
    判据用**链接**而不是内部状态标记：链接写在正文里，用户看得见也改得动。"""
    root = _workspace(tmp_path)
    (root / "daily" / "2026-09-17").mkdir()
    (root / "daily" / "2026-09-17" / "还没整合.md").write_text("# 孤零零\n", encoding="utf-8")

    by_path = {item.path: item for item in scan(root)}
    assert by_path["daily/2026-09-16/会话一.md"].consolidated is True
    assert by_path["daily/2026-09-17/还没整合.md"].consolidated is False
    # 非 daily（digest / core）不带这个含义，一律 False，不参与"待整合"计数
    assert by_path["digest/personal/锂价.md"].consolidated is False
    assert by_path["MEMORY.md"].consolidated is False


def test_scan_empty_workspace(tmp_path: Path) -> None:
    """工作区还不存在时返回空列表，**不报错**：记忆没启用过的部署就是这样。"""
    assert scan(tmp_path / "没有这个目录") == []


# --------------------------------------------------------------------- 读写


def test_read_write_round_trip_is_byte_exact(tmp_path: Path) -> None:
    """编辑器存回去必须**逐字还原**：不能因为我们"顺手格式化"而丢掉用户手写的东西
    （frontmatter 的排列、空行、缩进都是他自己的格式）。"""
    root = _workspace(tmp_path)
    original = read_file(root, "digest/personal/锂价.md").content
    write_file(root, "digest/personal/锂价.md", original)
    assert read_file(root, "digest/personal/锂价.md").content == original


def test_write_creates_missing_dirs(tmp_path: Path) -> None:
    """要能新建整合笔记（``digest/procedure/…``），目录得自动建。"""
    root = _workspace(tmp_path)
    detail = write_file(root, "digest/procedure/新流程.md", "# 新流程\n")
    assert detail.path == "digest/procedure/新流程.md"
    assert (root / "digest" / "procedure" / "新流程.md").read_text(encoding="utf-8") == "# 新流程\n"


def test_write_rejects_oversized(tmp_path: Path) -> None:
    """记忆是给人读的短文件；长内容该走知识库那条路。"""
    with pytest.raises(InvalidRequestError):
        write_file(_workspace(tmp_path), "digest/大.md", "字" * (MAX_WRITE_BYTES // 3 + 10))


def test_read_missing_file_is_404(tmp_path: Path) -> None:
    """不存在 → NotFoundError（映射成 404），不是"返回空内容"——
    空内容会让编辑器把一个不存在的文件显示成空白，用户一存就把它造出来了。"""
    with pytest.raises(NotFoundError):
        read_file(_workspace(tmp_path), "digest/没有这个.md")


def test_read_outside_workspace_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(InvalidRequestError):
        read_file(_workspace(tmp_path), "../secret.md")


def test_delete_removes_file(tmp_path: Path) -> None:
    root = _workspace(tmp_path)
    target = root / "digest" / "personal" / "锂价.md"
    delete_file(root, "digest/personal/锂价.md")
    assert not target.exists()
    with pytest.raises(NotFoundError):
        delete_file(root, "digest/personal/锂价.md")


def test_describe_matches_scan_entry(tmp_path: Path) -> None:
    """列表与单文件读**必须是同一份装配**（``_entry_of``）：两边各拼一份的话，
    以后加字段必然漏掉"打开编辑器"那条路。``consolidated`` 是唯一例外——
    它要跨文件才知道，``describe`` 只读了一个文件，所以这里不比对它。"""
    root = _workspace(tmp_path)
    scanned = {item.path: item for item in scan(root)}["daily/2026-09-16/会话一.md"]
    single = describe(root, "daily/2026-09-16/会话一.md")
    assert single == scanned.__class__(**{**_as_dict(scanned), "consolidated": single.consolidated})
    assert single.links == scanned.links
    assert single.retrievable == scanned.retrievable
    assert single.title == scanned.title


def _as_dict(entry) -> dict:  # type: ignore[no-untyped-def]
    from dataclasses import asdict

    return asdict(entry)


# --------------------------------------------------------------------- 图谱


def test_graph_resolves_all_three_link_styles(tmp_path: Path) -> None:
    """全路径 / 文件名 / 主干三种写法都要认，且**同一条边只留一份**：
    实测里 digest 那份同时写了 ``[[会话一]]`` 与 ``[[daily/…/会话一.md]]``，
    去重没做对的话度数会虚高一倍。"""
    graph = graph_of(scan(_workspace(tmp_path)))
    assert graph.edges == [("daily/2026-09-16/会话一.md", "digest/personal/锂价.md")]
    degrees = {node.path: node.degree for node in graph.nodes}
    assert degrees == {"daily/2026-09-16/会话一.md": 1, "digest/personal/锂价.md": 1}


def test_graph_keeps_dangling_out_of_the_picture(tmp_path: Path) -> None:
    """写错的链接**不画成悬空节点**（图上出现一堆"不存在的东西"会把真结构淹掉），
    但要单独报出来——那是用户写错了，界面该提示他。"""
    graph = graph_of(scan(_workspace(tmp_path)))
    assert graph.dangling == [("daily/2026-09-16/会话一.md", "不存在的.md")]
    assert all(node.path != "不存在的.md" for node in graph.nodes)


def test_graph_skips_isolated_nodes(tmp_path: Path) -> None:
    """孤立文件不进图：它们已经在列表里了，图要回答的是"结构"而不是"清单"。"""
    graph = graph_of(scan(_workspace(tmp_path)))
    assert all(node.path != "MEMORY.md" for node in graph.nodes)


def test_graph_ignores_self_links(tmp_path: Path) -> None:
    """自指链接（正文里提到自己）不画自环：它不表达任何关系，只会让度数虚高。"""
    root = tmp_path / "memory"
    (root / "digest").mkdir(parents=True)
    (root / "digest" / "a.md").write_text("见 [[a]] 与 [[a.md]]\n", encoding="utf-8")
    graph = graph_of(scan(root))
    assert graph.edges == []
    assert graph.nodes == []


def test_graph_does_not_guess_ambiguous_names(tmp_path: Path) -> None:
    """重名时**不猜**：``[[同名]]`` 对应两个文件时，宁可算悬空链接，
    也不要连到随机一个上——那会画出一条用户没写过的边。"""
    root = tmp_path / "memory"
    (root / "digest" / "a").mkdir(parents=True)
    (root / "digest" / "b").mkdir(parents=True)
    (root / "digest" / "a" / "同名.md").write_text("# A\n", encoding="utf-8")
    (root / "digest" / "b" / "同名.md").write_text("# B\n", encoding="utf-8")
    (root / "digest" / "引用.md").write_text("# 引用\n\n见 [[同名]]\n", encoding="utf-8")

    graph = graph_of(scan(root))
    assert graph.edges == []
    assert graph.dangling == [("digest/引用.md", "同名")]
    # 但**全路径**仍然要连得上：重名只影响"靠名字猜"的那条路
    (root / "digest" / "引用.md").write_text(
        "# 引用\n\n见 [[digest/a/同名.md]]\n", encoding="utf-8"
    )
    graph = graph_of(scan(root))
    assert graph.edges == [("digest/引用.md", "digest/a/同名.md")]
