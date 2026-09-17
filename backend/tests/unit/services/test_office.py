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
    for kind in ("docx", "xlsx", "pptx", "pdf"):
        assert office.missing_requirement(kind) == "", kind
