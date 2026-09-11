"""按**知识库**解析嵌入实现（v11）。

**为什么需要它**：嵌入模型原先是全局一套——建库时把全局解析出的模型冻进记录，
所有库共用一个 embedder。于是"小文档库用高精度模型、大文档库用小模型提速"这个
场景做不到（用户提出的设计调整）。

现在嵌入模型是**知识库的属性**：建库时从注册表挑一个，随库冻结，摄入与检索都按库解析。
凭据仍只在注册表存一份（这里按 ``model_pk`` 取），密钥不散落到知识库表里。

**回退而不是报错**：模型被删、供应商被停用、或老库压根没选过——都回退到全局
embedder（注册表默认槽位 / 设置页配置）。理由与 `services/model_registry.py` 的
"叠加层"一致：升级与误删不该让既有数据无法检索，日志里留下线索即可。
"""

from __future__ import annotations

import logging
from collections.abc import Callable

from app.services.embedding.base import EmbeddingProvider
from app.services.embedding.openai_compat import OpenAICompatEmbedder
from app.services.model_registry import ModelRegistryService
from app.storage.base import KnowledgeBaseRecord

__all__ = ["EmbeddingResolver"]

logger = logging.getLogger(__name__)


class EmbeddingResolver:
    """把"知识库 → 嵌入实现"这件事收在一处。"""

    def __init__(
        self,
        registry: ModelRegistryService,
        *,
        fallback: EmbeddingProvider,
        batch_size: int | Callable[[], int] = 32,
        factory: Callable[..., EmbeddingProvider] = OpenAICompatEmbedder,
    ) -> None:
        self._registry = registry
        self._fallback = fallback
        # 可以是常量，也可以是**取值函数**（读运行期配置）：批大小在设置页可改，
        # 直接固化成一个数字会让那个设置项对"按库选模型"这条主路径变成 no-op
        self._batch_size = batch_size
        # 构造器做成可注入的：测试要验"按库选对了模型"，不该为此发真实 HTTP
        self._factory = factory
        # 缓存按「模型 + 生效配置」而不是只按 model_pk：一次摄入要分批嵌入几百个 chunk，
        # 每批重建客户端是浪费；但只按 pk 缓存会让"改了地址/密钥/维度"要重启才生效
        # （v0.12 review 抓到的静默问题）。
        self._cache: dict[tuple[object, ...], EmbeddingProvider] = {}
        self._warned: set[str] = set()

    def batch_size(self) -> int:
        """当前生效的批大小。"""
        value = self._batch_size() if callable(self._batch_size) else self._batch_size
        return max(1, int(value))

    def for_kb(self, kb: KnowledgeBaseRecord) -> EmbeddingProvider:
        return self.for_model_pk(kb.embedding_model_pk)

    def for_model_pk(self, model_pk: str | None) -> EmbeddingProvider:
        if not model_pk:
            return self._fallback
        try:
            provider, model = self._registry.embedding_target(model_pk)
        except Exception as exc:
            # 只在第一次告警：一个坏模型会让每个文档都走到这里，刷屏没有意义
            if model_pk not in self._warned:
                logger.warning("知识库指定的嵌入模型不可用（%s），改用全局配置：%s", model_pk, exc)
                self._warned.add(model_pk)
            return self._fallback

        batch = self.batch_size()
        key = (
            model_pk,
            provider.base_url,
            provider.api_key,
            model.model_id,
            model.dim or 0,
            batch,
        )
        cached = self._cache.get(key)
        if cached is not None:
            return cached
        # 同一个模型的旧条目（配置已变）留着没有意义，顺手清掉，
        # 免得缓存随"改了几次配置"一直长
        for stale in [item for item in self._cache if item[0] == model_pk]:
            del self._cache[stale]
        embedder = self._factory(
            base_url=provider.base_url,
            api_key=provider.api_key,
            model_id=model.model_id,
            dim=model.dim or 0,
            max_batch=batch,
        )
        self._cache[key] = embedder
        return embedder
