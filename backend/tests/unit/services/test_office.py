"""Office 产出（v0.21）。

镜像同构：``app/services/office.py`` → 本文件。

这一组的**主要手法是"写出去再读回来"**：用我们自己的产出函数造文件，
再用**入库管线里那个真的解析器**把它读回来。理由是这两半是同一个产品承诺的
两个方向——"agent 能给你一份 .docx"与"你上传的 .docx 能被检索"——
只有对着真解析器回读，才能证明产出的不是一个"看起来像 docx 的字节串"。
打桩验"函数被调用了"完全证明不了这件事，而用户打不开文件是到最后一步才发现。

用到的库都在 `parsers` / `office` 两个 extra 里（CI 装全量 extra）。
"""

from __future__ import annotations

import io

import pytest

from app.parsers.base import ProbeResult
from app.parsers.local_office import LocalOfficeParser
from app.services import office

MARKDOWN = """# 随访方案

眼轴长度是近视防控的核心指标，建议每三个月测量一次。
这一句与上一句之间没有空行，它们应当合成同一个段落。

## 一、操作步骤

- 首次建档做全套
- 之后按三个月复查

1. 先建档
2. 再复查

## 二、对照表

| 项目 | 频率 |
| --- | --- |
| 眼轴 | 3 个月 |
| 验光 | 6 个月 |

### 三、备注

不要只看裸眼视力。
"""


def _probe() -> ProbeResult:
    return ProbeResult(kind="office", text_coverage=1.0)


def _read_office(name: str, data: bytes) -> str:
    return LocalOfficeParser().parse(
        filename=name, mime_type=None, content=data, probe=_probe()
    ).markdown


# ------------------------------------------------------------------ 拆块


def test_blocks_recognise_the_subset_that_matters() -> None:
    kinds = [block.kind for block in office.parse_blocks(MARKDOWN)]

    assert kinds == [
        "heading",
        "paragraph",
        "heading",
        "bullet",
        "bullet",
        "numbered",
        "numbered",
        "heading",
        "table",
        "heading",
        "paragraph",
    ]


def test_wrapped_lines_become_one_paragraph() -> None:
    """Markdown 里连续的非空行是**同一个段落**。

    逐行成段的话，一份从网页复制来的文本会变成几十个碎段，
    而 docx 里那看起来像"每句话都换行"——那不是原文的样子。
    """
    blocks = office.parse_blocks("第一句。\n第二句。\n\n另一段。")

    assert [block.text for block in blocks] == ["第一句。 第二句。", "另一段。"]


def test_table_separator_is_not_data() -> None:
    """``| --- | --- |`` 是语法不是内容：当成数据的话，表里会多出一行横线。"""
    blocks = office.parse_blocks("| 项目 | 频率 |\n| --- | --- |\n| 眼轴 | 3 个月 |")

    assert len(blocks) == 1
    assert blocks[0].rows == (("项目", "频率"), ("眼轴", "3 个月"))


def test_heading_levels_are_kept() -> None:
    blocks = office.parse_blocks("#### 深标题")

    assert blocks[0].kind == "heading" and blocks[0].level == 4


# ------------------------------------------------------------------ docx


def test_docx_round_trips_through_our_own_parser() -> None:
    """写出去的 docx 要**被我们自己的解析器读得回来**，且标题/列表/表格都在。"""
    text = _read_office("随访方案.docx", office.build_docx(MARKDOWN, title="近视防控随访"))

    assert "近视防控随访" in text
    assert "一、操作步骤" in text
    assert "首次建档做全套" in text
    assert "| 项目 | 频率 |" in text and "眼轴" in text


def test_docx_has_an_explicit_east_asian_font() -> None:
    """中文字体要显式指到 ``w:eastAsia``。

    只设 ``font.name`` 管的是西文，中文会回落到 **Word 自己的默认值**——
    而不同机器上的默认值不一样，同一份文件在两台机器上排出来的行数就不同。
    这是"我这边看着好好的"最典型的一种来源。
    """
    import zipfile

    from docx import Document

    raw = office.build_docx("正文")
    document = Document(io.BytesIO(raw))
    styles_xml = zipfile.ZipFile(io.BytesIO(raw)).read("word/styles.xml").decode("utf-8")

    assert "eastAsia" in styles_xml and "宋体" in styles_xml
    # 文档本身也要能被 python-docx 打开（结构合法）
    assert document.paragraphs


# ------------------------------------------------------------------ xlsx


def test_xlsx_keeps_numbers_as_numbers_and_sizes_columns() -> None:
    """数字按数值写、列宽跟着内容走。

    两条都是"打开就能用"的要求：全文本的列不能求和，
    而没设列宽的表打开是挤成一堆的 ``####``，每次都要手动拉。
    """
    import openpyxl

    raw = office.build_xlsx(
        [["项目", "频率(月)", "次数"], ["眼轴", "3", 4], ["验光", 6, "2"]], sheet_name="随访"
    )

    sheet = openpyxl.load_workbook(io.BytesIO(raw))["随访"]
    assert [cell.value for cell in sheet[1]] == ["项目", "频率(月)", "次数"]
    assert sheet.cell(row=2, column=2).value == 3  # 字符串 "3" → 数值
    assert sheet.cell(row=2, column=3).value == 4
    assert sheet.cell(row=3, column=3).value == 2
    assert sheet.cell(row=3, column=2).value == 6
    assert sheet.column_dimensions["A"].width >= 6


def test_xlsx_sheet_name_is_clipped_to_excels_limit() -> None:
    """工作表名上限 31 字（Excel 的硬限制）：超了 openpyxl 会直接抛，
    而"名字长了一点就生成失败"是模型完全无从预测的。"""
    import openpyxl

    raw = office.build_xlsx([["a"]], sheet_name="很长的表名" * 10)

    assert len(openpyxl.load_workbook(io.BytesIO(raw)).sheetnames[0]) == 31


# ------------------------------------------------------------------ pptx


def test_pptx_round_trips_titles_and_bullets() -> None:
    text = _read_office(
        "方案.pptx",
        office.build_pptx(
            [{"title": "监测频率", "bullets": ["三个月一次", "首次全套"]}], title="随访方案"
        ),
    )

    assert "随访方案" in text  # 封面
    assert "监测频率" in text
    assert "三个月一次" in text and "首次全套" in text


# ------------------------------------------------------------------ pdf


def test_pdf_renders_chinese_text() -> None:
    """**中文必须能抽出来**。

    reportlab 的内置字体（Helvetica）不含汉字，而它**不会报错**——
    它会照常输出一页黑方块。所以这一条不能靠"函数没抛异常"来证明，
    必须真的回读文本。
    """
    from pypdf import PdfReader

    raw = office.build_pdf(MARKDOWN, title="近视防控随访")
    text = "\n".join(page.extract_text() or "" for page in PdfReader(io.BytesIO(raw)).pages)

    assert "近视防控随访" in text
    assert "每三个月测量一次" in text
    assert "3 个月" in text  # 表格进了 PDF


def test_pdf_escapes_markup_characters() -> None:
    """正文里的 ``<`` ``&`` 要转义：reportlab 的 Paragraph 认一小套标记语言，
    不转义的话一段含 ``<br>`` 的正文会把整份文档构建搞崩。"""
    from pypdf import PdfReader

    raw = office.build_pdf("条件：a < b && c > d")
    text = "".join(page.extract_text() or "" for page in PdfReader(io.BytesIO(raw)).pages)

    assert "a < b && c > d" in text


# ------------------------------------------------------------------ 纯文本（v0.41）


@pytest.mark.parametrize("kind", ["md", "txt", "csv", "html"])
def test_text_kinds_are_written_as_is(kind: str) -> None:
    """纯文本类**原样落字节**，不做 Markdown → 纯文本的改写。

    改写（``# 标题`` → ``标题``、``| a | b |`` → 一行竖线）会让对方下载到的东西
    与屏幕上看到的不是同一份——而"我拿到的和你给我看的不一样"是最没法解释的一类问题。
    """
    raw = office.build_text(MARKDOWN, kind=kind)

    assert raw.decode("utf-8-sig") == MARKDOWN


def test_csv_gets_a_bom_so_excel_does_not_mangle_chinese() -> None:
    """含中文的 .csv 要带 UTF-8 BOM。

    Excel / WPS 双击打开无 BOM 的 UTF-8 CSV 会按本地编码（中文环境是 GBK）解，
    中文全是乱码——而一份 .csv 的去向几乎总是"被 Excel 打开"。
    BOM 对别的读法无害：我们自己的解析器就是按 ``utf-8-sig`` 起头解的。
    """
    raw = office.build_text("项目,眼轴\n复查,3 个月\n", kind="csv")

    assert raw.startswith(b"\xef\xbb\xbf")
    assert raw.decode("utf-8-sig").startswith("项目,眼轴")


def test_markdown_export_reads_back_through_the_ingest_pipeline() -> None:
    """写出去的 .md 要能被**入库管线里那个真的解析器**读回来，且一字不差。

    与 docx / pdf 那几条同一个手法（见文件头）：.md 是"原样交付"，
    所以回读必须完全相等——多一层转义、少一个换行都算交付错了东西。
    """
    from app.parsers.plain_text import PlainTextParser

    parsed = PlainTextParser().parse(
        filename="随访方案.md", content=office.build_text(MARKDOWN, kind="md")
    )

    assert parsed.markdown == MARKDOWN


def test_unknown_text_kind_is_refused() -> None:
    with pytest.raises(RuntimeError, match="不是纯文本产出"):
        office.build_text("正文", kind="rtf")


# ------------------------------------------------------------------ 依赖


def test_missing_dependency_is_a_sentence_not_an_importerror(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """缺依赖时报**"装什么"**，而不是抛 ImportError。

    这个模块被工具层调用，工具层的异常会变成给模型读的一句话——
    `ModuleNotFoundError` 对它没有任何用，它需要的是"这件事做不到、原因是这个"。
    """
    monkeypatch.setitem(office._REQUIREMENTS, "pdf", ("reportlab", "不存在的模块名"))

    problem = office.missing_requirement("pdf")

    assert "reportlab" in problem
    with pytest.raises(RuntimeError, match="reportlab"):
        office.build_pdf("正文")


def test_unknown_format_is_named_back() -> None:
    assert "不认识的产出格式" in office.missing_requirement("rtf")


def test_no_missing_requirement_for_the_formats_we_ship() -> None:
    """四种转换类与四种纯文本类都不缺东西。

    **纯文本类回空串不是巧合**：它们不需要任何库，而报"缺依赖"会让工具层
    在明明做得到的事情上回一句"做不到"（这正是"没有 .md 导出"的一半成因）。
    """
    for kind in ("docx", "xlsx", "pptx", "pdf", *office.PLAIN_TEXT_KINDS):
        assert office.missing_requirement(kind) == "", kind
