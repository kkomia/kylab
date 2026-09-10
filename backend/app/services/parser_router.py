"""解析路由决策器（M2 T2.6）。

架构 §4.1 的差异化能力：**逐文件探测、逐文件路由**，并把决策连同理由一起写进任务记录，
让控制台能回答"这个文件为什么走了 OCR / 为什么用了直提"。

放在 ``services/`` 而不是 ``parsers/``：路由必然要 import 多个解析器实现，
而工程规范 §3.3 禁止解析器实现之间互相引用（`scripts/check_layering.py` 的 L3 规则）。
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from app.parsers.base import ParseError, ParserProvider, ProbeResult

__all__ = ["ParserRouter", "RoutingDecision"]


@dataclass(frozen=True, slots=True)
class RoutingDecision:
    """一次路由决策：选了谁、为什么、探测到了什么。"""

    parser: ParserProvider
    reason: str
    probe: ProbeResult

    @property
    def parser_name(self) -> str:
        return self.parser.name


class ParserRouter:
    """按注册顺序挑选第一个 ``supports`` 的解析器（顺序即优先级）。"""

    def __init__(self, parsers: Sequence[ParserProvider]) -> None:
        if not parsers:
            raise ValueError("至少需要注册一个解析器")
        self._parsers = tuple(parsers)

    @property
    def parser_names(self) -> tuple[str, ...]:
        return tuple(parser.name for parser in self._parsers)

    def decide(
        self, *, filename: str, mime_type: str | None, probe: ProbeResult
    ) -> RoutingDecision:
        for parser in self._parsers:
            if parser.supports(filename=filename, mime_type=mime_type, probe=probe):
                return RoutingDecision(
                    parser=parser,
                    reason=f"{parser.name} 支持该类型（探测结论：{probe.kind}）",
                    probe=probe,
                )
        raise ParseError(
            f"暂不支持的文件类型：{filename or '(未命名)'}（探测结论：{probe.kind}）",
            stage="probing",
        )
