"""运行期配置（行为参数），落 SQLite ``app_settings``。

**模型身份不在这里**（v0.8 归属整理）：embedding / rerank / llm 的地址、密钥、
模型名与维度统一由模型注册表承担（``services/model_registry.py``）——
"用哪个模型"只有一个登记入口，避免同一件事在设置页与注册表各写一遍然后不一致。
本模块只留**行为参数**：向量化批大小、对话温度 / 最大回复长度 / 思考开关、
系统提示词、云端解析节点的 token 与地址。

三层优先级（从低到高）：

1. 代码默认值（本模块的 ``DEFAULTS``）；
2. 进程级 ``.env`` 里的 ``KYLAB_*``（**仅作为引导默认值**，方便部署时预设一次）；
3. 数据库 ``app_settings`` —— 网页上改的写在这一层，覆盖上面两层。

密钥的处理口径（见《界面信息架构草案》§3）：
对外**永不回显明文**，只给 ``sk-xu…ten`` 形式的掩码与"是否已配置"；
写入时留空表示"不改动"，不能把掩码当成新值回写。
"""

from __future__ import annotations

import contextlib
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from app.core.config import Settings
from app.core.exceptions import InvalidRequestError
from app.parsers.mineru_cloud import MinerUConfig
from app.parsers.paddleocr_api import PaddleOCRConfig
from app.services.llm import LLMConfig
from app.services.thinking import normalize_effort
from app.storage.base import StoreBundle

__all__ = [
    "SECRET_KEYS",
    "SETTING_GROUPS",
    "RuntimeConfigService",
    "mask_secret",
]

#: 哪些键是密钥：对外只回显掩码，且不接受把掩码写回来。
#: **模型凭据（embedding / rerank / llm 的 API Key）不在这里**——它们属于
#: 供应商，只存在注册表里，不经过设置页这一层（见模块头 §"注册入口唯一"）。
SECRET_KEYS = frozenset(
    {
        "mineru.token",
        "paddleocr.token",
    }
)

#: 分组与字段定义。前端设置页按这个结构渲染，不自己硬编码字段名。
#:
#: **只放行为参数，不放模型身份**（模型注册 v0.8 的归属整理）：
#: "用哪个模型"在「模型注册」里登记、在「向量化 / 对话模型」里选定；
#: 这里剩下的是"怎么用"——批大小、温度、最大回复长度、思考开关、提示词。
SETTING_GROUPS: dict[str, Any] = {
    "embedding": {
        "label": "向量化",
        "fields": [
            {"key": "embedding.batch_size", "label": "批大小", "type": "int"},
        ],
    },
    "mineru": {
        "label": "MinerU 云端解析",
        "fields": [
            {"key": "mineru.token", "label": "API Token", "type": "secret"},
            {"key": "mineru.model_version", "label": "模型版本", "type": "text"},
            {"key": "mineru.endpoint", "label": "接口地址", "type": "text"},
        ],
    },
    "paddleocr": {
        "label": "PaddleOCR 云端解析",
        "fields": [
            {"key": "paddleocr.token", "label": "API Token", "type": "secret"},
            {"key": "paddleocr.model", "label": "模型", "type": "text"},
            {"key": "paddleocr.endpoint", "label": "接口地址", "type": "text"},
        ],
    },
    "llm": {
        "label": "对话模型（LLM）",
        "fields": [
            {"key": "llm.temperature", "label": "温度", "type": "text"},
            {"key": "llm.enable_thinking", "label": "思考模式", "type": "bool"},
            {
                "key": "llm.thinking_effort",
                "label": "思考强度",
                "type": "select",
                # 归一化三档；具体翻译成哪家的参数由 services/thinking.py 决定
                "options": [
                    {"value": "low", "label": "低（快，省 token）"},
                    {"value": "medium", "label": "中（默认）"},
                    {"value": "high", "label": "高（深，慢）"},
                ],
            },
        ],
    },
    "chat": {
        "label": "对话行为",
        "fields": [
            {"key": "chat.system_prompt", "label": "系统提示词", "type": "textarea"},
            {"key": "chat.top_k", "label": "带入资料的条数", "type": "int"},
            {
                "key": "chat.section_chars",
                "label": "每条资料的小节长度上限",
                "type": "int",
            },
            {
                "key": "chat.agent_enabled",
                "label": "启用 Agent 多轮检索",
                "type": "bool",
            },
            {
                "key": "chat.agent_max_rounds",
                "label": "Agent 最多检索轮数",
                "type": "int",
            },
            {
                "key": "chat.context_window",
                "label": "上下文窗口（token）",
                "type": "int",
            },
            {
                "key": "chat.compress_at",
                "label": "上下文压缩阈值（占用百分比）",
                "type": "int",
            },
            {
                "key": "chat.compress_keep",
                "label": "压缩时保留的最近消息条数",
                "type": "int",
            },
        ],
    },
}

#: 代码默认值。**只有行为参数**：模型身份来自注册表，没有默认模型这回事。
DEFAULTS: dict[str, str] = {
    "embedding.batch_size": "32",
    "mineru.endpoint": "https://mineru.net/api/v4",
    "mineru.token": "",
    "mineru.model_version": "vlm",
    "paddleocr.endpoint": "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs",
    "paddleocr.token": "",
    "paddleocr.model": "PaddleOCR-VL-1.6",
    "llm.temperature": "0.3",
    # 回复长度上限**不再是设置项**：默认不传，把这个上限交还给模型自己。
    # 曾经是 2048，实测会把回复预算全花在思考上、正文一个字都出不来（且时好时坏）；
    # 改成 16384 只是把概率调低。正确做法是别替模型做主——详见《开发计划》§12.88。
    # 个别端点"不传就退化成很小的默认值"时，走模型注册的 options.max_tokens。
    # 思考**默认开**：主流模型默认都思考，这里的开关只用来"临时关掉"。
    "llm.enable_thinking": "true",
    "llm.thinking_effort": "medium",
    "chat.system_prompt": "",  # 空则用 services/chat.py 的内置提示词
    "chat.top_k": "6",
    # 检索按块命中，但**喂给模型的是整段小节**（v17，见 services/chat.py
    # 的「小块检索、大块阅读」）：0 = 关闭，只给命中的那一块
    "chat.section_chars": "1800",
    # 整块资料的字数预算（v25）：按条数均摊，每条不低于 400 字。
    # 摘要（见 services/summary.py）补上了"这篇文档在讲什么"这层背景，
    # 于是片段本身可以更短——这是本轮省 token 的主要落点。
    "chat.material_chars": "6000",
    # 入库时给每篇文档生成摘要（v25）。它是**省 token 的机制**而不是锦上添花：
    # 一次提问复用一篇摘要，能省掉成倍的资料 token。关掉它只会让问答更贵。
    "ingest.summary_enabled": "true",
    # Agent 工作流（v20，见 services/agent.py）：意图识别 + 检索词改写 + 多轮检索。
    # 默认开；关掉就退回"原问题单轮检索"的老链路。轮数上限 1~5，默认 3——
    # 每多一轮都是一次真实检索加一次模型调用，3 轮是成本与召回的折中。
    "chat.agent_enabled": "true",
    "chat.agent_max_rounds": "3",
    # 上下文压缩（v20.1，见 services/chat.py::prepare_context）：
    # 占用达到阈值就把更早的对话折成摘要，避免长会话撑爆窗口或悄悄失忆。
    # 窗口做成本设置项是因为**没有统一的 API 能查到模型的真实窗口**。
    "chat.context_window": "65536",
    "chat.compress_at": "70",
    "chat.compress_keep": "6",
}


def mask_secret(value: str) -> str:
    """密钥掩码：够长才两头留一点，短密钥整体打码。

    目的是让用户能确认"配的是不是我以为的那把钥匙"，而不是提供任何还原线索——
    所以只回显前后各 3 位。
    """
    if not value:
        return ""
    if len(value) <= 8:
        return "•" * len(value)
    return f"{value[:3]}…{value[-3:]}"


def _as_int(raw: str, fallback: int) -> int:
    """宽松解析整数（同 ``_as_float`` 的理由：设置页里是自由文本）。"""
    try:
        return int(raw)
    except (TypeError, ValueError):
        return fallback


def _as_float(raw: str, fallback: float) -> float:
    """宽松解析：设置页里温度是自由文本，写错了退回默认值而不是崩。"""
    try:
        return float(raw)
    except (TypeError, ValueError):
        return fallback


@dataclass(frozen=True, slots=True)
class EmbeddingSettings:
    """向量化配置的快照。"""

    base_url: str
    api_key: str
    model_id: str
    dim: int
    batch_size: int

    @property
    def is_configured(self) -> bool:
        """有 key、有模型、维度为正，才算配好。"""
        return bool(self.api_key and self.model_id and self.dim > 0)


@dataclass(frozen=True, slots=True)
class RerankSettings:
    """重排配置的快照；未配置时检索整体跳过重排（架构 §5）。"""

    base_url: str
    api_key: str
    model_id: str

    @property
    def is_configured(self) -> bool:
        return bool(self.api_key and self.model_id)


class RuntimeConfigService:
    """读写运行期配置，并把配置解析成各模块直接可用的快照。"""

    def __init__(
        self,
        stores: StoreBundle,
        settings: Settings | None = None,
        *,
        registry: object | None = None,
    ) -> None:
        self._stores = stores
        self._settings = settings
        self._registry = registry
        """模型注册器（G1）。**可选**：没有它时全部走 .env / 设置页那套，
        所以既有部署与既有测试不受影响——注册器是叠加层，不是替换。"""

    # ------------------------------------------------------------------ 读写

    def get(self, key: str) -> str:
        """取一个键的最终值：数据库 > .env 引导值 > 代码默认值。"""
        stored = self._stores.meta.get_setting(key)
        if stored is not None:
            return stored
        boot = self._bootstrap_value(key)
        if boot:
            return boot
        return DEFAULTS.get(key, "")

    def get_many(self, keys: Sequence[str]) -> dict[str, str]:
        """一次取多个键，**一条 SQL**（§12.116）。

        为什么值得单独开一个入口：一次查询的固定开销（连接池借还 + 往返）实测约 6ms，
        而 PG 自己只花 2ms——**成本几乎全在"往返次数"上**。取三个键就是三次往返、
        约 18ms（实测 ``mineru()`` 正好是 17.97ms）。而取模型快照的那几个入口
        （``mineru`` / ``paddleocr`` / ``llm`` / ``embedding``）都在**每次请求**的
        路径上（负载面板每 2 秒一次、对话每轮一次），这笔固定税很显眼。

        返回值保证**包含每个请求的键**：调用方按 ``values[key]`` 取，不必写兜底。
        优先级与 ``get`` 完全一致（库 > 引导值 > 默认值）——两条路径不能有第二种答案。
        """
        ordered = list(dict.fromkeys(keys))
        if not ordered:
            return {}
        stored = self._stores.meta.get_settings(ordered)
        return {
            key: (
                stored[key]
                if key in stored
                else (self._bootstrap_value(key) or DEFAULTS.get(key, ""))
            )
            for key in ordered
        }

    def get_int(self, key: str) -> int:
        raw = self.get(key)
        try:
            return int(raw)
        except ValueError:
            return int(DEFAULTS.get(key, "0") or 0)

    def set(self, values: dict[str, str], *, clear_secrets: set[str] | None = None) -> None:
        """写入一批配置。

        - 空字符串：密钥视为"清除"，非密钥视为"恢复默认"（写空即回落默认值）；
        - ``clear_secrets`` 里的键即使给了值也只清空——用于"删除凭据"这个明确动作。
        """
        drop = clear_secrets or set()
        for key, value in values.items():
            if key in drop:
                self._stores.meta.set_setting(key, "")
                continue
            text = (value or "").strip()
            # 掩码被当成新值回写是最容易踩的坑：界面上显示的 `sk-xu…ten` 不是密钥
            if key in SECRET_KEYS and "…" in text:
                continue
            self._stores.meta.set_setting(key, text)

    def describe(self) -> dict[str, Any]:
        """给前端的配置视图：分组、字段、掩码后的值、是否已配置。"""
        groups = []
        for group_key, spec in SETTING_GROUPS.items():
            fields = []
            for field in spec["fields"]:
                raw = self.get(field["key"])
                is_secret = field["key"] in SECRET_KEYS
                entry: dict[str, Any] = {
                    "key": field["key"],
                    "label": field["label"],
                    "type": field["type"],
                    # 密钥只给掩码；前端据此显示"已配置 sk-xu…ten"
                    "value": mask_secret(raw) if is_secret else raw,
                    "configured": bool(raw),
                }
                # 下拉项的候选值。只有 select 类字段带它，前端据此渲染 AppSelect。
                if field.get("options"):
                    entry["options"] = list(field["options"])
                fields.append(entry)
            groups.append({"key": group_key, "label": spec["label"], "fields": fields})
        return {"groups": groups}

    # ------------------------------------------------------------------ 注册器桥接

    def _bound(self, slot: str) -> tuple[object, object] | None:
        """取某用途在注册器里绑定的（供应商, 模型）；未绑定或注册器缺席返回 ``None``。

        **用鸭子类型而不是导入 ModelRegistryService**：两者会互相引用
        （注册器要用 get_setting，配置要用 resolve），真导入就成环。
        这里的契约很小（只要一个 ``resolve``），不值得为它引入依赖注入框架。
        """
        registry = self._registry
        if registry is None:
            return None
        resolver = getattr(registry, "resolve", None)
        if resolver is None:
            return None
        return resolver(slot)  # type: ignore[no-any-return]

    # ------------------------------------------------------------------ 快照

    def embedding(self) -> EmbeddingSettings:
        """向量化配置快照——**只来自模型注册表**（v0.8 归属整理）。

        没绑定「向量化」用途就是没配：``is_configured`` 为假，调用方据此报错，
        而不是退回某个"看起来能用"的实现。批大小是行为参数，仍在设置页。
        """
        batch_size = _as_int(self.get("embedding.batch_size"), 32) or 32
        bound = self._bound("embedding")
        if bound is None:
            return EmbeddingSettings(
                base_url="", api_key="", model_id="", dim=0, batch_size=batch_size
            )
        provider, model = bound
        return EmbeddingSettings(
            base_url=provider.base_url,
            api_key=provider.api_key,
            model_id=model.model_id,
            # 维度是模型属性：注册表登记了才算数，不再从设置页补
            dim=model.dim or 0,
            batch_size=batch_size,
        )

    def rerank(self) -> RerankSettings:
        """重排快照：同样只来自注册表；未绑定即未启用（跳过重排，不影响检索可用性）。"""
        bound = self._bound("rerank")
        if bound is None:
            return RerankSettings(base_url="", api_key="", model_id="")
        provider, model = bound
        return RerankSettings(
            base_url=provider.base_url,
            api_key=provider.api_key,
            model_id=model.model_id,
        )

    def mineru(self) -> MinerUConfig:
        values = self.get_many(("mineru.token", "mineru.endpoint", "mineru.model_version"))
        return MinerUConfig(
            token=values["mineru.token"],
            endpoint=values["mineru.endpoint"],
            model_version=values["mineru.model_version"],
        )

    def paddleocr(self) -> PaddleOCRConfig:
        values = self.get_many(("paddleocr.token", "paddleocr.endpoint", "paddleocr.model"))
        return PaddleOCRConfig(
            token=values["paddleocr.token"],
            endpoint=values["paddleocr.endpoint"],
            model=values["paddleocr.model"],
        )

    def llm(self) -> LLMConfig:
        """对话模型快照。

        **身份（base_url / key / model_id）只来自注册表**（v0.8 归属整理）；
        采样参数（temperature / max_tokens / thinking）来自设置页——它们是
        "这次怎么问"而不是"用哪家模型"，换个模型通常也不想重新调一遍。
        没绑定「对话生成」就是没配，``is_configured`` 为假，对话会明确报错。
        """
        temperature, max_tokens, thinking, effort = self._sampling()

        bound = self._bound("chat")
        if bound is None:
            return LLMConfig(
                base_url="",
                api_key="",
                model_id="",
                temperature=temperature,
                max_tokens=max_tokens,
                enable_thinking=thinking,
                thinking_effort=effort,
            )

        provider, model = bound
        return self._llm_config(provider, model)

    def llm_for(self, model_pk: str | None) -> LLMConfig:
        """按**指定注册模型**取对话快照；``model_pk`` 为空等价于 ``llm()``。

        ``llm()`` 只认注册表里绑定给 ``chat`` 的全局默认模型；会话级选模型（v12）
        需要一个"就用这一个"的入口。**能不能用交校验给注册器的 ``chat_target``**：
        模型不存在 / 没声明对话能力 / 供应商停用或没密钥，都在那里给出可读的 422。
        """
        if not model_pk:
            return self.llm()
        target = getattr(self._registry, "chat_target", None)
        if target is None:
            raise InvalidRequestError("模型注册表不可用，无法按指定模型对话")
        provider, model = target(model_pk)
        return self._llm_config(provider, model)

    def _llm_config(self, provider: object, model: object) -> LLMConfig:
        """把（供应商, 模型）折成 ``LLMConfig``：采样参数取设置页，模型 options 可覆盖。

        不同模型对采样参数的最优区间不同（推理模型通常要更低的 temperature），
        所以模型自带的默认值优先于设置页。
        """
        temperature, max_tokens, thinking, effort = self._sampling()
        dialect: str | None = None
        options = getattr(model, "options", None) or {}
        if "temperature" in options:
            temperature = _as_float(str(options["temperature"]), temperature)
        if "max_tokens" in options:
            # 登记时可能填了非数字；解析不了就沿用手上的值，不要让整次对话失败
            with contextlib.suppress(TypeError, ValueError):
                max_tokens = int(options["max_tokens"])  # type: ignore[arg-type]
        if "enable_thinking" in options:
            thinking = bool(options["enable_thinking"])
        if "thinking_effort" in options:
            effort = normalize_effort(options["thinking_effort"], effort)
        if options.get("thinking_dialect"):
            dialect = str(options["thinking_dialect"]).strip().lower()
        return LLMConfig(
            base_url=getattr(provider, "base_url", ""),
            api_key=getattr(provider, "api_key", ""),
            model_id=getattr(model, "model_id", ""),
            temperature=temperature,
            max_tokens=max_tokens,
            enable_thinking=thinking,
            thinking_effort=effort,
            thinking_dialect=dialect,
        )

    def _sampling(self) -> tuple[float, int | None, bool, str]:
        """设置页那几档采样参数的快照：温度、回复长度上限、思考开关与强度。

        **回复长度上限默认是 ``None``（请求里不发这个字段）**：上限本来就是模型自己的事，
        不传时端点会一直生成到模型自然收尾。我们拍一个数字只会引入新故障——
        2048 时实测过"思考把预算吃光、正文一个字都出不来"，而且随采样时好时坏。
        只有模型注册里显式写了 ``options.max_tokens`` 才发（见 ``llm_for``），
        那是给"不传就用一个很小默认值"的端点留的手动出路。
        """
        values = self.get_many(("llm.temperature", "llm.enable_thinking", "llm.thinking_effort"))
        temperature = _as_float(values["llm.temperature"], 0.3)
        thinking = values["llm.enable_thinking"].lower() in ("1", "true", "yes", "on")
        effort = normalize_effort(values["llm.thinking_effort"])
        return temperature, None, thinking, effort

    # ------------------------------------------------------------------ 引导值

    def _bootstrap_value(self, key: str) -> str:
        """``.env`` 只作为引导：部署时可以预设一次，之后以网页上的值为准。

        **模型身份不在映射里**（v0.8）：embedding / rerank / llm 的地址与密钥由
        模型注册表承担，``.env`` 里写也不生效——留着半生效的入口比没有更糟。
        """
        settings = self._settings
        if settings is None:
            return ""
        mapping = {
            "embedding.batch_size": settings.embedding_batch_size,
            "mineru.token": settings.mineru_token,
            "paddleocr.token": settings.paddleocr_token,
            "llm.temperature": settings.llm_temperature,
            "llm.enable_thinking": settings.llm_enable_thinking,
            "llm.thinking_effort": settings.llm_thinking_effort,
        }
        value = mapping.get(key)
        return "" if value is None else str(value)
