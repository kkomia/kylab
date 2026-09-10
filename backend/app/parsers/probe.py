"""文件探测（M2 T2.4）。

职责：给出"文字型 / 扫描件 / 混合型"的判定与**文本层覆盖率**，供路由决策器使用
（架构 §4.1：逐文件探测、逐文件路由）。

当前实现覆盖纯文本与二进制启发式判定。PDF/Office 的页级覆盖度需要 pypdf/PyMuPDF，
随 ``parsers`` extra 在接入云端解析时补齐——**探测本身不依赖网络**，
这样离线也能把路由链路跑通。
"""

from __future__ import annotations

from app.parsers.base import ProbeKind, ProbeResult

TEXT_EXTENSIONS = frozenset(
    {".txt", ".md", ".markdown", ".text", ".log", ".csv", ".tsv", ".json", ".yaml", ".yml"}
)
MARKDOWN_EXTENSIONS = frozenset({".md", ".markdown"})

_SAMPLE_BYTES = 64 * 1024
"""抽样窗口：只看开头一段就够判断编码与可读性，避免大文件全量解码。"""

TEXT_COVERAGE_THRESHOLD = 0.9
"""可打印字符占比高于此值即认定为文字型。纯文本文件通常接近 1.0。"""


def _printable_ratio(sample: bytes) -> float:
    """可打印字符占比。

    以 UTF-8 能否解码为第一判据：能解码且不含 NUL 就基本是文本；
    否则退化为"ASCII 可打印 + 常见多字节高位字节"的比例估算。
    """
    if not sample:
        return 0.0
    if b"\x00" in sample:
        return 0.0
    try:
        sample.decode("utf-8")
    except UnicodeDecodeError:
        pass
    else:
        return 1.0

    printable = sum(1 for byte in sample if 32 <= byte < 127 or byte >= 0x80)
    return printable / len(sample)


def probe(
    content: bytes, *, filename: str = "", mime_type: str | None = None
) -> ProbeResult:
    """探测文件形态。

    返回的 ``detail`` 会落进任务记录，用于在控制台解释路由决策。
    """
    suffix = suffix_of(filename)
    sample = content[:_SAMPLE_BYTES]
    ratio = _printable_ratio(sample)

    is_known_text = suffix in TEXT_EXTENSIONS or (mime_type or "").startswith("text/")
    is_text = is_known_text or ratio >= TEXT_COVERAGE_THRESHOLD

    if not is_text:
        detail = {"reason": "二进制内容且扩展名未声明为文本", "suffix": suffix}
        return ProbeResult(kind=ProbeKind.SCANNED, text_coverage=ratio, detail=detail)

    detail = {
        "reason": "扩展名或 MIME 声明为文本" if is_known_text else "抽样内容可解码为 UTF-8",
        "suffix": suffix,
        "is_markdown": suffix in MARKDOWN_EXTENSIONS,
    }
    return ProbeResult(kind=ProbeKind.TEXT, text_coverage=ratio, detail=detail)


def suffix_of(filename: str) -> str:
    lowered = filename.lower()
    dot = lowered.rfind(".")
    return lowered[dot:] if dot > 0 else ""
