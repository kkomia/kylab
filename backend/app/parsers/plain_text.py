"""纯文本 / Markdown 直通解析器（M2 T2.5）。

这是主链路上**不依赖任何云端服务**的一条路径：txt/md/csv/json 等文本文件直接转成
Markdown 产物，让"上传 → 解析 → 切分 → 向量化 → 可检索"在没有 API key 时也能跑通，
也让集成测试不必消耗云端额度。

类名遵循 ``<引擎><节点>Parser``（工程规范 §3.2）。
"""

from __future__ import annotations

from app.parsers.base import ParseError, ParseResult, ParserProvider, ProbeResult
from app.parsers.probe import (
    BINARY_EXTENSIONS,
    MARKDOWN_EXTENSIONS,
    TEXT_EXTENSIONS,
    suffix_of,
)
from app.services.tabular import TABULAR_EXTENSIONS

_ENCODINGS = ("utf-8-sig", "utf-8", "gb18030")
"""解码阶梯：先 UTF-8（含 BOM），再中文环境最常见的 GB18030，最后兜底不丢数据。"""

_FENCE = "```"


class PlainTextParser(ParserProvider):
    """文本直通：解码后原样作为 Markdown 产物。"""

    name = "PlainTextParser"

    def supports(self, *, filename: str, mime_type: str | None, probe: ProbeResult) -> bool:
        """只认真正的文本文件。

        **不接受 ``probe.kind == TEXT`` 这类通配条件**：PDF 的文本层覆盖率也可能很高，
        那样它就会被纯文本直通接走，切出来的是原始 PDF 字节流（真踩过）。
        文本型 PDF 该由版面解析器处理——覆盖率高只说明"不需要 OCR"，不等于"能当 txt 读"。
        """
        # 表格类由 TabularParser 接走：它会把列名渲染进每一行，
        # 而纯文本直通做不到（列名只在第一行出现一次）。这里显式让路。
        if suffix_of(filename) in TABULAR_EXTENSIONS:
            return False
        if suffix_of(filename) in TEXT_EXTENSIONS:
            return True
        # 后缀不认识时，才允许拿 MIME 与探测结论兜底，且必须不是二进制容器
        if suffix_of(filename) in BINARY_EXTENSIONS:
            return False
        return (mime_type or "").startswith("text/")

    def parse(
        self,
        *,
        content: bytes,
        filename: str,
        mime_type: str | None = None,
        probe: ProbeResult | None = None,
    ) -> ParseResult:
        text = self.decode(content, filename)
        suffix = suffix_of(filename)
        markdown = text if suffix in MARKDOWN_EXTENSIONS else self._to_markdown(text, filename)
        return ParseResult(
            markdown=markdown,
            parser_name=self.name,
            page_count=None,  # 纯文本没有页的概念
            probe=probe,
        )

    @staticmethod
    def decode(content: bytes, filename: str = "") -> str:
        """按编码阶梯解码。

        全部失败时用 UTF-8 替换错误字符而不是抛错——宁可留几个乱码字符，
        也不要因为编码问题丢掉整篇文档；替换数写进异常信息之外由调用方观测。
        """
        if not content:
            raise ParseError(f"文件内容为空：{filename or '(未命名)'}")
        for encoding in _ENCODINGS:
            try:
                return content.decode(encoding)
            except UnicodeDecodeError:
                continue
        return content.decode("utf-8", errors="replace")

    @staticmethod
    def _to_markdown(text: str, filename: str) -> str:
        """非 Markdown 文本包一层说明与代码块，避免正文被当成标题解析。"""
        title = filename.rsplit("/", 1)[-1].rsplit("\\", 1)[-1] or "未命名文档"
        body = text.rstrip("\n")
        return f"# {title}\n\n{_FENCE}text\n{body}\n{_FENCE}\n"
