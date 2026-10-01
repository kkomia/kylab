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
from app.services import memory_files
from app.services.memory_files import (
    _BLOCK_CACHE,
    MAX_WRITE_BYTES,
    _load_blocks,
    _split_blocks,
    classify,
    delete_file,
    describe,
    graph_of,
    parse_frontmatter,
    read_file,
    safe_path,
    scan,
    search,
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


def test_scan_only_calls_a_day_page_an_index_when_it_is_derived(tmp_path: Path) -> None:
    """``is_day_index`` 看的是**内容里的自动区块**，不是文件名。

    ``daily/<日期>.md`` 在**旧部署里装的是真记忆**（那时条目直接平铺在这个文件
    里），按文件名去认就会把它们从「待整合」的计数里悄悄漏掉——而那个数字是
    用户判断"还有多少没归档"的唯一线索。有 ``notes:auto`` 区块的才算派生物。

    这一条是被一条集成用例逼出来的：那条用例写了一份**手写的**
    ``daily/2026-09-17.md``，期望它算进「待整合」。
    """
    root = tmp_path / "memory"
    (root / "daily").mkdir(parents=True)
    (root / "daily" / "2026-09-16.md").write_text(
        "# 老格式\n\n- 手写的一条真记忆\n", encoding="utf-8"
    )
    (root / "daily" / "2026-09-17.md").write_text(
        "# 2026-09-17\n\n<!-- notes:auto -->\n"
        "- [[daily/2026-09-17/某会话.md]] 摘要\n<!-- /notes:auto -->\n",
        encoding="utf-8",
    )

    by_path = {item.path: item for item in scan(root)}

    assert by_path["daily/2026-09-16.md"].is_day_index is False
    assert by_path["daily/2026-09-17.md"].is_day_index is True


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


# -------------------------------------- 切块：AST 感知（P1，照 QwenPaw 的分块器）
#
# 这一组只测**切块本身**（不经过 recall）：它是召回的地基——块切错了，
# 分数再准也找不回正确的那一段。三条新行为都是 AST 带来的，两条旧行为是必须保住的。


def test_a_heading_becomes_a_breadcrumb_not_an_empty_chunk() -> None:
    """标题**不单独成块**：它进块的文本当面包屑，而**行号仍从内容行起算**。

    旧切法给出两块：一块只有 `## 复盘`（正文是空的），一块只有那条 bullet。
    空块会被召回——白占"每份文件最多 3 条"的名额，而它的片段里没有一个字能回答
    用户；而那条 bullet 光看也不知道属于哪一天、哪一节。

    **行号起算点这一条是有意保留的**：集成用例钉着"`daily/2026-09-24.md` 的那条
    bullet 必须报第 3 行"（用户拿着行号去编辑器里找的是他的目标，标题不是）。
    """
    blocks = _split_blocks("# 2026-09-24\n\n## 复盘\n\n- 固定每周五下午做复盘\n")

    assert [(begin, end) for begin, end, _ in blocks] == [(5, 5)]
    text = blocks[0][2]
    assert "# 2026-09-24" in text and "## 复盘" in text
    assert text.endswith("- 固定每周五下午做复盘")


def test_the_breadcrumb_follows_the_heading_levels() -> None:
    """层级变了面包屑跟着变：三级标题下不该还挂着隔壁二级的兄弟。"""
    blocks = _split_blocks("# 顶层\n\n## 甲\n\n甲的内容\n\n## 乙\n\n乙的内容\n")

    texts = [text for _begin, _end, text in blocks]
    assert texts[0].startswith("# 顶层\n\n## 甲")
    assert texts[1].startswith("# 顶层\n\n## 乙"), "兄弟节不能进面包屑"


def test_line_numbers_still_point_at_the_content_not_the_heading() -> None:
    """行号要跳过 frontmatter 与标题：报错了用户就跳错地方。"""
    blocks = _split_blocks("---\nsummary: 测试\n---\n\n# 标题\n\n## 小节\n\n正文在这里\n")

    assert [(begin, end) for begin, end, _ in blocks] == [(9, 9)]
    assert blocks[0][2].startswith("# 标题\n\n## 小节")


def test_a_fence_keeps_its_blank_line() -> None:
    """围栏内部的空行**不能切**：切开之后两块各少半截，谁都跑不起来。"""
    blocks = _split_blocks("## 跑法\n\n```bash\nset -e\n\npytest -q\n```\n")

    assert len(blocks) == 1
    assert (blocks[0][0], blocks[0][1]) == (3, 7)
    assert "set -e" in blocks[0][2] and "pytest -q" in blocks[0][2]


def test_a_bullet_inside_a_fence_does_not_start_a_new_chunk() -> None:
    """围栏里的 `- 一条` 是**代码**，不是列表项。

    不认这一条的话，一篇讲"怎么写记忆笔记"的记忆里那个示例代码块会被劈成两半
    ——而示例代码恰恰是"照抄能跑"的那种内容。
    """
    blocks = _split_blocks("## 写法\n\n```markdown\n- 一条示例\n- 另一条\n```\n")

    assert len(blocks) == 1
    assert "- 一条示例" in blocks[0][2] and "- 另一条" in blocks[0][2]


def test_an_indented_code_block_is_protected_too() -> None:
    """四空格缩进的代码块同样会含空行，同样不能切。"""
    blocks = _split_blocks("## 片段\n\n    first\n\n    second\n\n后面一段\n")

    assert len(blocks) == 2
    assert "first" in blocks[0][2] and "second" in blocks[0][2]
    assert "后面一段" in blocks[1][2]


def test_the_breadcrumb_drops_the_outermost_ancestor_when_it_is_too_long() -> None:
    """面包屑超预算时**从最外层开始丢**（照 QwenPaw）。

    丢最外层而不是最内层：越靠近正文的标题越能说明"这一段在讲什么"，
    而最外层那个往往是"这份东西叫什么"；跟着每个块重复一遍才是真浪费。
    """
    deep = "\n\n".join(f"{'#' * level} 第{level}层" + "长" * 40 for level in range(1, 6))
    blocks = _split_blocks(f"{deep}\n\n正文\n")

    text = blocks[0][2]
    assert "正文" in text
    assert "第1层" not in text, "最外层要先丢"
    assert "第5层" in text, "最靠近正文的那一层必须留着"


def test_too_many_headings_falls_back_to_line_splitting() -> None:
    """标题多到 ``MAX_AST_SECTIONS`` 以上时整份**退回按行切**（照 QwenPaw 的
    ``max_ast_sections``）。

    那种形状多半是机器生成的目录/日志，为它建树不划算。兜底不是"少切几块"，
    而是**换一套简单规则**——所以这里同时断言"还切得出块"与"没有面包屑"。
    """
    from app.services.memory_files import MAX_AST_SECTIONS

    text = "\n\n".join(f"## 标题{index}\n\n内容{index}" for index in range(MAX_AST_SECTIONS + 5))

    blocks = _split_blocks(text)

    assert len(blocks) >= MAX_AST_SECTIONS
    assert any("内容0" in body for _begin, _end, body in blocks)
    assert blocks[0][2] == "## 标题0", "兜底那条路没有面包屑，标题自成一块"


def _no_jieba(monkeypatch: pytest.MonkeyPatch) -> None:
    """让 ``import jieba`` 真的失败（抛的是**真** ``ModuleNotFoundError``）。

    两件事都要做：拦住 import（``sys.meta_path`` 插一个只拒 jieba 的 finder），
    再清掉分词器缓存（`coverage._JIEBA`）——前面的用例可能已经把它导进来了。
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
def test_missing_jieba_degrades_to_the_pair_channel(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """缺 jieba 时：实词那条通道**空着**，字对那条照常干活（召回仍然是完整的一次）。

    这条钉的是机制本身（`memory_files._requirement_terms`）：它是唯一一处调用分词器
    的地方，也是唯一一处该失败的地方。标 ``local``：打包后的桌面端就是这种运行时，
    而这正是这条降级要治的那个现场。
    """
    root = tmp_path / "memory"
    (root / "daily").mkdir(parents=True)
    (root / "daily" / "2026-09-26.md").write_bytes("- 用户偏好深色模式，晚上别看亮底\n".encode())
    _no_jieba(monkeypatch)
    monkeypatch.setattr(memory_files, "_SEGMENTATION_MISSING", False)

    assert memory_files._requirement_terms("深色模式偏好") == []
    assert memory_files.segmentation_unavailable() is True

    hits = search(root, "深色模式偏好")

    assert hits, "字对那条通道必须把人救回来"
    assert "深色模式" in hits[0].text


@pytest.mark.local
def test_only_the_missing_tokenizer_is_swallowed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """**只吞 jieba 的缺失**：别的 ``ModuleNotFoundError`` 原样抛。

    把它也吞掉，一个真 bug 就会变成"召回质量莫名其妙变差"——那是这个项目最不想要的
    一类失败（没有报错、只是结果不对）。
    """

    def broken(query: str):  # type: ignore[no-untyped-def]
        raise ModuleNotFoundError("No module named 'numpy'", name="numpy")

    monkeypatch.setattr(memory_files, "content_terms", broken)

    with pytest.raises(ModuleNotFoundError):
        memory_files._requirement_terms("深色模式偏好")


# ----------------------------------------- 分块缓存（P1：一次召回不再重读整池）
#
# 缓存最容易出的错是"改了却还是旧的"，而那种错**不会报错**——所以这一组钉的全是
# 失效路径，而不是"缓存命中得快"。


def test_the_block_cache_notices_an_outside_edit(tmp_path: Path) -> None:
    """**外部编辑器改了文件，召回必须看到新的。**

    判据是 ``(mtime_ns, size)``：本地盘上它是硬的，所以这条在大多数环境里本来就过。
    它存在的意义是把"缓存把改动吃掉了"这种**不会报错的错**钉死。
    """
    root = tmp_path / "memory"
    (root / "daily").mkdir(parents=True)
    target = root / "daily" / "2026-09-24.md"
    target.write_bytes("- 复盘只看没做完的事\n".encode())

    first = search(root, "复盘")
    assert first and "没做完" in first[0].text

    target.write_bytes("- 复盘要先把上周的结论过一遍，再逐条对\n".encode())
    again = search(root, "复盘")

    assert again and "上周的结论" in again[0].text


def test_writing_through_the_memory_layer_invalidates_immediately(tmp_path: Path) -> None:
    """**我们自己写的一定要立刻生效**，不能等 mtime 那一层。

    网络文件系统的时间戳精度可能只有一秒上下，同一个 tick 内**等长改写**会溜过
    ``(mtime_ns, size)``——而这个项目要跑在 NAS 上，所以写入路径显式失效。
    这条用例特意用**等长**的两次写入来钉它。
    """
    root = tmp_path / "memory"
    (root / "digest").mkdir(parents=True)
    write_file(root, "digest/a.md", "- 复盘只看没做完的事\n")
    _load_blocks(root, root / "digest" / "a.md")  # 先让它进缓存

    # 长度一模一样，只有内容不同：这正是 mtime+size 盖不住的那种改写
    write_file(root, "digest/a.md", "- 复盘先把上周过一遍\n")

    hits = search(root, "复盘")
    assert hits and "上周过一遍" in hits[0].text


def test_the_block_cache_reuses_an_untouched_file(tmp_path: Path) -> None:
    """内容没变时**不重读**：同一份文件的块对象就是同一个。

    用对象身份而不是计时来断言：计时在 CI 上不稳，而"有没有重新建过"是事实。
    """
    root = tmp_path / "memory"
    (root / "digest").mkdir(parents=True)
    target = root / "digest" / "a.md"
    target.write_bytes("- 复盘只看没做完的事\n".encode())

    first = _load_blocks(root, target)
    second = _load_blocks(root, target)

    assert first is second
    assert first and first[0].block.path == "digest/a.md"


def test_the_cache_drops_files_that_left_the_workspace(tmp_path: Path) -> None:
    """文件没了，缓存里也不该还留着它——缓存的大小跟着**工作区**走，不跟着历史走。"""
    root = tmp_path / "memory"
    (root / "digest").mkdir(parents=True)
    target = root / "digest" / "a.md"
    target.write_bytes("- 复盘只看没做完的事\n".encode())
    _load_blocks(root, target)

    target.unlink()
    search(root, "复盘")

    assert target not in _BLOCK_CACHE


# ------------------------------------------- 打分：BM25 的长度归一化（P1）


def test_a_short_precise_chunk_outranks_a_long_one_that_merely_mentions_it(
    tmp_path: Path,
) -> None:
    """**一句话写得很准**要压过**长笔记里顺带提了一次**。

    旧打分 ``Σ(权重 × (1+ln 频次))`` 没有长度项：两者同 tf、同 df 就**打平**，
    于是按 ``(路径, 起始行)`` 排序——字典序靠前的那份（长笔记）拿走第一条，
    用户看到的是三百字里那一句无关内容。BM25 的 ``b`` 正是治这件事的。
    """
    root = tmp_path / "memory"
    (root / "digest" / "a").mkdir(parents=True)
    (root / "digest" / "b").mkdir(parents=True)
    filler = "\n".join(f"这一行在讲别的事情，编号 {index}。" for index in range(12))
    (root / "digest" / "a" / "杂记.md").write_bytes(
        f"# 一周杂记\n\n{filler}\n其中有一天顺带提到了复盘这件事。\n".encode()
    )
    (root / "digest" / "b" / "口径.md").write_bytes("- 复盘只看没做完的事\n".encode())

    hits = search(root, "复盘", limit=5)

    assert hits, "两边都写了这两个字，必须都召回得到"
    assert hits[0].path == "digest/b/口径.md", "排在第一条的该是那句写得准的短记忆"
    assert hits[0].score > hits[1].score
    assert len(hits[0].text) < len(hits[1].text), "短的那条本来就短，这也是它该排前面的理由"
