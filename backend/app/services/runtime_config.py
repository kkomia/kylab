"""运行期配置（凭据与模型），落 SQLite ``app_settings``。

为什么要从 ``.env`` 搬到这里：`工程规范 §6` 写明"密钥不入库"，但 `.env` 的问题不是安全，
而是**用户改不了**——改一个 embedding 模型要 SSH 上去编辑文件、重启进程。凭据与模型属于
"用户级配置"，架构 §13 与 M1 的表设计早就把 ``app_settings`` 留好了，这里把它用起来。

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
from dataclasses import dataclass
from typing import Any

from app.core.config import Settings
from app.parsers.mineru_cloud import MinerUConfig
from app.parsers.paddleocr_api import PaddleOCRConfig
from app.services.llm import LLMConfig
from app.storage.base import StoreBundle

__all__ = [
    "SECRET_KEYS",
    "SETTING_GROUPS",
    "RuntimeConfigService",
    "mask_secret",
]

#: 哪些键是密钥：对外只回显掩码，且不接受把掩码写回来
SECRET_KEYS = frozenset(
    {
        "embedding.api_key",
        "rerank.api_key",
        "mineru.token",
        "paddleocr.token",
        "llm.api_key",
    }
)

#: 分组与字段定义。前端设置页按这个结构渲染，不自己硬编码字段名。
SETTING_GROUPS: dict[str, Any] = {
    "embedding": {
        "label": "向量化",
        "fields": [
            {"key": "embedding.base_url", "label": "接口地址", "type": "text"},
            {"key": "embedding.api_key", "label": "API Key", "type": "secret"},
            {"key": "embedding.model_id", "label": "模型 ID", "type": "text"},
            {"key": "embedding.dim", "label": "向量维度", "type": "int"},
            {"key": "embedding.batch_size", "label": "批大小", "type": "int"},
        ],
    },
    "rerank": {
        "label": "重排（可选）",
        "fields": [
            {"key": "rerank.base_url", "label": "接口地址", "type": "text"},
            {"key": "rerank.api_key", "label": "API Key", "type": "secret"},
            {"key": "rerank.model_id", "label": "模型 ID", "type": "text"},
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
            {"key": "llm.base_url", "label": "接口地址", "type": "text"},
            {"key": "llm.api_key", "label": "API Key", "type": "secret"},
            {"key": "llm.model_id", "label": "模型 ID", "type": "text"},
            {"key": "llm.temperature", "label": "温度", "type": "text"},
            {"key": "llm.max_tokens", "label": "最大回复长度", "type": "int"},
            {"key": "llm.enable_thinking", "label": "深度思考（推理模型）", "type": "bool"},
        ],
    },
    "chat": {
        "label": "对话行为",
        "fields": [
            {"key": "chat.system_prompt", "label": "系统提示词", "type": "textarea"},
            {"key": "chat.top_k", "label": "带入资料的条数", "type": "int"},
        ],
    },
}

#: 代码默认值。开箱即用指向硅基流动的 bge-m3（1024 维），用户可整套改掉。
DEFAULTS: dict[str, str] = {
    "embedding.base_url": "https://api.siliconflow.cn/v1",
    "embedding.api_key": "",
    "embedding.model_id": "BAAI/bge-m3",
    "embedding.dim": "1024",
    "embedding.batch_size": "32",
    "rerank.base_url": "https://api.siliconflow.cn/v1",
    "rerank.api_key": "",
    "rerank.model_id": "",
    "mineru.endpoint": "https://mineru.net/api/v4",
    "mineru.token": "",
    "mineru.model_version": "vlm",
    "paddleocr.endpoint": "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs",
    "paddleocr.token": "",
    "paddleocr.model": "PaddleOCR-VL-1.6",
    # 对话模型：默认取硅基流动上免费的那档，方便快速验证；用户可换成任意 OpenAI 兼容端点
    "llm.base_url": "https://api.siliconflow.cn/v1",
    "llm.api_key": "",
    "llm.model_id": "Qwen/Qwen3.5-4B",
    "llm.temperature": "0.3",
    "llm.max_tokens": "1024",
    # 推理模型默认**关掉思考**：开着会把 max_tokens 吃光、content 为空（实测）
    "llm.enable_thinking": "false",
    "chat.system_prompt": "",  # 空则用 services/chat.py 的内置提示词
    "chat.top_k": "6",
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
                fields.append(
                    {
                        "key": field["key"],
                        "label": field["label"],
                        "type": field["type"],
                        # 密钥只给掩码；前端据此显示"已配置 sk-xu…ten"
                        "value": mask_secret(raw) if is_secret else raw,
                        "configured": bool(raw),
                    }
                )
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
        """向量化配置快照。

        **优先取模型注册器里绑定到「向量化」的那个模型**（G1），没绑定则回退到
        设置页那套字段。``dim`` 以注册表登记的为准——它是模型属性，
        登记一次就不该再让用户在两处各填一遍、然后两边不一致。
        """
        bound = self._bound("embedding")
        if bound is not None:
            provider, model = bound
            return EmbeddingSettings(
                base_url=provider.base_url,
                api_key=provider.api_key,
                model_id=model.model_id,
                dim=model.dim or self.get_int("embedding.dim"),
                batch_size=self.get_int("embedding.batch_size") or 32,
            )
        return EmbeddingSettings(
            base_url=self.get("embedding.base_url"),
            api_key=self.get("embedding.api_key"),
            model_id=self.get("embedding.model_id"),
            dim=self.get_int("embedding.dim"),
            batch_size=self.get_int("embedding.batch_size") or 32,
        )

    def rerank(self) -> RerankSettings:
        bound = self._bound("rerank")
        if bound is not None:
            provider, model = bound
            return RerankSettings(
                base_url=provider.base_url,
                api_key=provider.api_key,
                model_id=model.model_id,
            )
        return RerankSettings(
            base_url=self.get("rerank.base_url"),
            api_key=self.get("rerank.api_key"),
            model_id=self.get("rerank.model_id"),
        )

    def mineru(self) -> MinerUConfig:
        return MinerUConfig(
            token=self.get("mineru.token"),
            endpoint=self.get("mineru.endpoint"),
            model_version=self.get("mineru.model_version"),
        )

    def paddleocr(self) -> PaddleOCRConfig:
        return PaddleOCRConfig(
            token=self.get("paddleocr.token"),
            endpoint=self.get("paddleocr.endpoint"),
            model=self.get("paddleocr.model"),
        )

    def llm(self) -> LLMConfig:
        """对话模型快照。

        采样参数（temperature / max_tokens / thinking）**始终来自设置页**，
        不放进注册表：它们是"这次怎么问"而不是"用哪家模型"，换个模型通常也不想
        重新调一遍。模型的身份（base_url / key / model_id）才由注册表决定。
        """
        bound = self._bound("chat")
        temperature = _as_float(self.get("llm.temperature"), 0.3)
        max_tokens = self.get_int("llm.max_tokens") or 1024
        thinking = self.get("llm.enable_thinking").lower() in ("1", "true", "yes", "on")

        if bound is not None:
            provider, model = bound
            options = model.options or {}
            # 模型自带的默认值可以覆盖设置页：不同模型对采样参数的最优区间不同，
            # 例如推理模型通常要更低的 temperature
            if "temperature" in options:
                temperature = _as_float(str(options["temperature"]), temperature)
            if "max_tokens" in options:
                # 登记时可能填了非数字；解析不了就沿用手上的值，不要让整次对话失败
                with contextlib.suppress(TypeError, ValueError):
                    max_tokens = int(options["max_tokens"])  # type: ignore[arg-type]
            if "enable_thinking" in options:
                thinking = bool(options["enable_thinking"])
            return LLMConfig(
                base_url=provider.base_url,
                api_key=provider.api_key,
                model_id=model.model_id,
                temperature=temperature,
                max_tokens=max_tokens,
                enable_thinking=thinking,
            )

        return LLMConfig(
            base_url=self.get("llm.base_url"),
            api_key=self.get("llm.api_key"),
            model_id=self.get("llm.model_id"),
            temperature=temperature,
            max_tokens=max_tokens,
            enable_thinking=thinking,
        )

    # ------------------------------------------------------------------ 引导值

    def _bootstrap_value(self, key: str) -> str:
        """``.env`` 只作为引导：部署时可以预设一次，之后以网页上的值为准。"""
        settings = self._settings
        if settings is None:
            return ""
        mapping = {
            "embedding.base_url": settings.embedding_base_url,
            "embedding.api_key": settings.embedding_api_key,
            "embedding.model_id": settings.embedding_model,
            "embedding.dim": settings.embedding_dim,
            "embedding.batch_size": settings.embedding_batch_size,
            "rerank.base_url": settings.rerank_base_url,
            "rerank.api_key": settings.rerank_api_key,
            "rerank.model_id": settings.rerank_model,
            "mineru.token": settings.mineru_token,
            "paddleocr.token": settings.paddleocr_token,
            "llm.base_url": settings.llm_base_url,
            "llm.api_key": settings.llm_api_key,
            "llm.model_id": settings.llm_model,
            "llm.temperature": settings.llm_temperature,
            "llm.max_tokens": settings.llm_max_tokens,
            "llm.enable_thinking": settings.llm_enable_thinking,
        }
        value = mapping.get(key)
        return "" if value is None else str(value)
