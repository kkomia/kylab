"""解析路由决策器的单元测试。

镜像同构：``app/services/parser_router.py`` → ``tests/unit/services/test_parser_router.py``。
"""

import pytest

from app.parsers.base import ParseError, ParseResult, ParserProvider, ProbeKind, ProbeResult
from app.parsers.plain_text import PlainTextParser
from app.services.parser_router import ParserRouter


def _text_probe() -> ProbeResult:
    return ProbeResult(kind=ProbeKind.TEXT, text_coverage=1.0)


def _scanned_probe() -> ProbeResult:
    return ProbeResult(kind=ProbeKind.SCANNED, text_coverage=0.0)


class _AlwaysParser(ParserProvider):
    """测试替身：无条件支持，用来验证注册顺序即优先级。"""

    name = "AlwaysParser"

    def supports(self, *, filename: str, mime_type: str | None, probe: ProbeResult) -> bool:
        return True

    def parse(self, *, content: bytes, filename: str, mime_type: str | None = None,
              probe: ProbeResult | None = None) -> ParseResult:
        return ParseResult(markdown="", parser_name=self.name)


def test_router_requires_at_least_one_parser() -> None:
    with pytest.raises(ValueError):
        ParserRouter([])


def test_routes_markdown_to_plain_text_parser() -> None:
    router = ParserRouter([PlainTextParser()])
    decision = router.decide(filename="a.md", mime_type=None, probe=_text_probe())

    assert decision.parser_name == "PlainTextParser"
    assert "PlainTextParser" in decision.reason
    assert decision.probe.kind == ProbeKind.TEXT


def test_decision_reason_mentions_probe_kind() -> None:
    """理由要能落进任务记录，供控制台解释路由。"""
    router = ParserRouter([PlainTextParser()])
    decision = router.decide(filename="a.md", mime_type=None, probe=_text_probe())
    assert ProbeKind.TEXT in decision.reason


def test_unsupported_file_raises_with_stage() -> None:
    router = ParserRouter([PlainTextParser()])
    with pytest.raises(ParseError) as excinfo:
        router.decide(filename="scan.pdf", mime_type="application/pdf", probe=_scanned_probe())

    assert "暂不支持" in str(excinfo.value)
    assert excinfo.value.stage == "probing"  # 失败定位到探测阶段


def test_registration_order_is_priority() -> None:
    router = ParserRouter([_AlwaysParser(), PlainTextParser()])
    decision = router.decide(filename="a.md", mime_type=None, probe=_text_probe())
    assert decision.parser_name == "AlwaysParser"


def test_exposes_registered_parser_names() -> None:
    router = ParserRouter([PlainTextParser(), _AlwaysParser()])
    assert router.parser_names == ("PlainTextParser", "AlwaysParser")
