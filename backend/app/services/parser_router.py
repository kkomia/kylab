"""解析路由决策器（M2 T2.6）。

架构 §4.1 的差异化能力：**逐文件探测、逐文件路由**，并把决策连同理由一起写进任务记录，
让控制台能回答"这个文件为什么走了 OCR / 为什么用了直提"。

放在 ``services/`` 而不是 ``parsers/``：路由必然要 import 多个解析器实现，
而工程规范 §3.3 禁止解析器实现之间互相引用（`scripts/check_layering.py` 的 L3 规则）。

**解析器清单每次决策时现建**：凭据与模型来自设置页（运行期配置），
用户在网页上填完 token 就该立刻生效，而不是重启进程才认。
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from app.parsers.base import ParseError, ParserProvider, ProbeResult
from app.parsers.mineru_cloud import MinerUCloudParser
from app.parsers.paddleocr_api import PaddleOCRApiParser
from app.parsers.plain_text import PlainTextParser
from app.services.runtime_config import RuntimeConfigService

__all__ = ["ParserRouter", "RoutingDecision", "build_parsers"]


def build_parsers(runtime: RuntimeConfigService) -> list[ParserProvider]:
    """按当前运行期配置构造解析器清单，**顺序即优先级**。

    顺序理由：纯文本直通最便宜，先给它；MinerU 版面还原更强，让它做扫描件的第一选择；
    PaddleOCR 是备选通道（架构 §4.1「云端失败可降级备选节点」）。
    两个云端解析器都会在 ``supports()`` 里排除纯文本类文件，所以顺序不会误伤本地直读。
    未配置 token 时它们的 ``supports()`` 恒为 False —— 没凭据也能跑通整条链路。
    """
    return [
        PlainTextParser(),
        MinerUCloudParser(runtime.mineru()),
        PaddleOCRApiParser(runtime.paddleocr()),
    ]


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

    def __init__(self, parsers: Sequence[ParserProvider] | RuntimeConfigService) -> None:
        if isinstance(parsers, RuntimeConfigService):
            self._runtime: RuntimeConfigService | None = parsers
            self._fixed: tuple[ParserProvider, ...] | None = None
        else:
            if not parsers:
                raise ValueError("至少需要注册一个解析器")
            self._runtime = None
            self._fixed = tuple(parsers)

    @property
    def parsers(self) -> tuple[ParserProvider, ...]:
        if self._fixed is not None:
            return self._fixed
        if self._runtime is None:  # pragma: no cover - 构造时二者必有其一
            raise RuntimeError("ParserRouter 既没有固定清单也没有运行期配置")
        return tuple(build_parsers(self._runtime))

    @property
    def parser_names(self) -> tuple[str, ...]:
        return tuple(parser.name for parser in self.parsers)

    def decide(
        self, *, filename: str, mime_type: str | None, probe: ProbeResult
    ) -> RoutingDecision:
        for parser in self.parsers:
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
