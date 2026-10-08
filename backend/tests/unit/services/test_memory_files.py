"""记忆文件层（v0.14 三期；档案制见 ``docs/设计/记忆档案-设计-v0.1.md``）。

镜像同构：``app/services/memory_files.py`` → 本文件。

这一层现在只做两件事：**读得进**（一个文件的原文）与**数得出**（工作区几份文件、
最后改动时间）。**列表已经退场**（``scan``）：它最后的消费者是记忆页上那节只读的
「旧记忆」，那一节下掉之后列表没有读者了。检索、切块、图谱、当天索引页更早随档案制
退场，所以这里只钉住剩下的那几条安静错法：

1. **路径越界**：它由前端传进来（``GET /memory/files/{path}``），不拦就等于
   把整个文件系统开放出去。``safe_path`` 的每一道检查都要有对应用例；
2. **派生物目录要跳过**：``session/`` 与 ``resource/`` 里的 .md 不是记忆，
   数进状态读数只会让"几份文件"骗人；
3. **读得进、读不到要如实 404**（不是"返回空内容"：那会让编辑器把一份不存在的
   文件显示成空白，用户一存就把它造出来了）；
4. **单文件的元信息与正文必须对得上**（同一处装配）：读一个文件的两面各拼一份的话，
   以后加字段必然漏掉一边。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.core.exceptions import InvalidRequestError, NotFoundError
from app.services.memory_files import (
    classify,
    describe,
    parse_frontmatter,
    read_file,
    safe_path,
    stats,
)


def _write(root: Path, path: str, text: str) -> None:
    """按字节写（与产品同一条纪律）：`write_text` 在 Windows 上会翻成 CRLF，
    而这一层要断言的正是"读回来的与写下去的一模一样"。"""
    target = root / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(text.encode("utf-8"))


def _workspace(tmp_path: Path) -> Path:
    """一个像真工作区那样的目录：核心文件、旧每日现场、整合产物、派生物都有。

    ``daily/`` 与 ``digest/`` 那两份是**旧部署留下的用户数据**：代码不再消费它们
    （检索与整理都退场了），但文件还在盘上，扫描照样看得见。
    """
    root = tmp_path / "memory"
    (root / "daily" / "2026-09-16").mkdir(parents=True)
    (root / "digest" / "personal").mkdir(parents=True)
    # 派生物目录：里面就算有 .md 也不该出现在列表里
    (root / "session" / "dialog").mkdir(parents=True)
    (root / "resource").mkdir(parents=True)

    _write(
        root,
        "MEMORY.md",
        "---\nsummary: 核心长期记忆\n---\n\n## 核心长期记忆\n\n- 用户偏好先给结论\n",
    )
    _write(root, "SOUL.md", "# 我是 KYLAB\n\n说话直接。\n")
    _write(
        root,
        "daily/2026-09-16/会话一.md",
        "---\nsummary: 现场\n---\n\n# 今天的现场\n\n结论见 digest/personal/锂价.md。\n",
    )
    _write(
        root,
        "digest/personal/锂价.md",
        "---\ntags: [锂价, 成本]\n---\n\n# 锂价敏感性\n\n锂价下跌压低正极材料成本。\n",
    )
    _write(root, "session/dialog/conv_x.md", "# 原始对话\n")
    _write(root, "resource/外部资料.md", "# 外部资料\n")
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
    """还没存在的文件也要能解析出来——迁移草稿与档案文件都可能由我们现写。"""
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
    """分类**只按文件在磁盘上的位置**（不猜正文）：``memory/`` 与 ``daily/`` 都算
    每日现场——ReMe 的默认是 ``daily``，QwenPaw 那族写 ``memory``，
    我们可能被任一版本初始化过。"""
    assert classify(path) == expected


# --------------------------------------------------------------------- 扫描


def test_core_title_is_filename_not_heading(tmp_path: Path) -> None:
    """``MEMORY.md`` 正文里那个 ``## 核心长期记忆`` 是章节名、不是它的名字。
    取成标题的话，读它的人会看到一个叫"核心长期记忆"的东西，而他要找的是 MEMORY.md。"""
    root = _workspace(tmp_path)

    assert describe(root, "MEMORY.md").title == "MEMORY.md"
    assert describe(root, "SOUL.md").title == "SOUL.md"
    assert describe(root, "MEMORY.md").is_core is True


def test_describe_reads_frontmatter_and_heading(tmp_path: Path) -> None:
    """非核心文件的显示名取 frontmatter 的 ``title`` 或正文首个标题。"""
    root = _workspace(tmp_path)

    daily = describe(root, "daily/2026-09-16/会话一.md")
    assert daily.summary == "现场"
    assert daily.title == "今天的现场"
    assert daily.kind == "daily"
    assert daily.tags == ()
    assert daily.size_bytes > 0
    assert daily.modified_at

    digest = describe(root, "digest/personal/锂价.md")
    assert digest.tags == ("锂价", "成本")


def test_stats_on_a_missing_workspace_counts_zero(tmp_path: Path) -> None:
    """工作区还不存在时是"零份文件"，**不报错**：记忆没启用过的部署就是这样。"""
    result = stats(tmp_path / "没有这个目录")

    assert result.file_count == 0
    assert result.last_changed_at == ""


def test_stats_skips_derived_dirs(tmp_path: Path) -> None:
    """``session/`` 与 ``resource/`` 是**派生物**：原始对话与外部资料就算存成 .md
    也不是记忆，数进状态读数只会让"几份文件"骗人。"""
    result = stats(_workspace(tmp_path))

    # 核心 2 份 + daily 1 份 + digest 1 份 = 4 份（派生物两目录不算）
    assert result.file_count == 4


def test_stats_counts_files_and_reports_the_last_change(tmp_path: Path) -> None:
    """状态读数：几份文件、上次改动时间。**没有"可召回几条"了**——
    检索那一路已经退场，`daily/`/`digest/` 现在只是磁盘上的文件。"""
    result = stats(_workspace(tmp_path))

    # 核心 2 份 + daily 1 份 + digest 1 份 = 4 份（派生物两目录不算）
    assert result.file_count == 4
    assert result.last_changed_at


# --------------------------------------------------------------------- 读


def test_read_file_returns_the_original_text_verbatim(tmp_path: Path) -> None:
    """只读展示要**逐字**：不能因为我们"顺手格式化"而丢掉用户手写的东西
    （frontmatter 的排列、空行、缩进都是他自己的格式）。"""
    root = _workspace(tmp_path)
    detail = read_file(root, "digest/personal/锂价.md")

    assert detail.path == "digest/personal/锂价.md"
    assert detail.content == (root / "digest" / "personal" / "锂价.md").read_text(encoding="utf-8")
    assert detail.meta == {"tags": ["锂价", "成本"]}
    assert detail.truncated is False
    assert detail.size_bytes > 0


def test_read_missing_file_is_404(tmp_path: Path) -> None:
    """不存在 → NotFoundError（映射成 404），不是"返回空内容"——
    空内容会让界面把一个不存在的文件显示成空白。"""
    with pytest.raises(NotFoundError):
        read_file(_workspace(tmp_path), "digest/没有这个.md")


def test_read_outside_workspace_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(InvalidRequestError):
        read_file(_workspace(tmp_path), "../secret.md")


def test_describe_and_read_file_describe_the_same_file(tmp_path: Path) -> None:
    """元信息与正文**必须是同一份装配**（``_entry_of`` 与 ``read_file`` 的
    读法对齐：按字节读再解码）：两边各拼一份的话，以后加字段必然漏掉一边，
    而那一边正是"读单个文件"这条路。"""
    root = _workspace(tmp_path)
    path = "daily/2026-09-16/会话一.md"

    meta = describe(root, path)
    detail = read_file(root, path)

    assert meta.path == detail.path
    assert meta.size_bytes == detail.size_bytes
    assert meta.modified_at == detail.modified_at
