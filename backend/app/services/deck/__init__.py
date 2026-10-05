"""幻灯片生成的前三层（令牌 / 原型 / 映射）与 deck-spec 契约。

**写盘层本轮未接**：把槽位变成 .pptx 字节要用 PptxGenJS（Node），
接入方案见各模块头与交付说明；本包只描述几何、度量与决策，不 import 任何排版库。

分层（依赖方向单向，禁止反向）：

    theme_tokens ← layouts ← spec ← content_map

- `theme_tokens`：色板 / 字体白名单 / 字号阶梯 / 间距 / 度量预算（唯一的样式数字来源）；
- `layouts`：6 个原型 × light/heavy = 12 个版式，区域矩形 + 命名槽位 + 机械核对；
- `spec`：agent 该产出的结构化数据，LLM 与渲染之间的唯一接口（pydantic 校验，人话报错）；
- `content_map`：deck spec → 每页每槽填什么 + 溢出决策（缩字号 → 拆页 → 两栏）。
"""

from __future__ import annotations

from app.services.deck.content_map import (
    ACTION_LABELS,
    DeckPlan,
    OverflowAction,
    PagePlan,
    SlotDecision,
    SlotFill,
    chars_per_line,
    fit_block,
    map_deck,
    measure_width_em,
    pick_density,
    run_overflow_cases,
    text_width_em,
    wrap_lines,
)
from app.services.deck.layouts import (
    ARCHETYPE_LABELS,
    ARCHETYPES,
    LAYOUTS,
    Archetype,
    Density,
    Layout,
    Rect,
    Slot,
    SlotRole,
    get_layout,
    iter_layouts,
    validate_layouts,
)
from app.services.deck.spec import (
    ChartSeries,
    ChartSpec,
    DeckSpec,
    DeckSpecError,
    ImageIntent,
    Kpi,
    SlideSpec,
    contract_hint,
    load_deck_spec,
)
from app.services.deck.theme_tokens import (
    DEFAULT_THEME,
    SLIDE_HEIGHT_IN,
    SLIDE_WIDTH_IN,
    ThemeTokens,
    build_theme,
)

__all__ = [
    "ACTION_LABELS",
    "ARCHETYPES",
    "ARCHETYPE_LABELS",
    "DEFAULT_THEME",
    "LAYOUTS",
    "SLIDE_HEIGHT_IN",
    "SLIDE_WIDTH_IN",
    "Archetype",
    "ChartSeries",
    "ChartSpec",
    "DeckPlan",
    "DeckSpec",
    "DeckSpecError",
    "Density",
    "ImageIntent",
    "Kpi",
    "Layout",
    "OverflowAction",
    "PagePlan",
    "Rect",
    "SlideSpec",
    "Slot",
    "SlotDecision",
    "SlotFill",
    "SlotRole",
    "ThemeTokens",
    "build_theme",
    "chars_per_line",
    "contract_hint",
    "fit_block",
    "get_layout",
    "iter_layouts",
    "load_deck_spec",
    "map_deck",
    "measure_width_em",
    "pick_density",
    "run_overflow_cases",
    "text_width_em",
    "validate_layouts",
    "wrap_lines",
]
