"""Embedding 抽象（M2 T2.9）。

两种实现：

- :class:`~app.services.embedding.openai_compat.OpenAICompatEmbedder` —— 真用，
  指向任何 OpenAI 兼容端点（硅基流动 / 本地 Ollama / vLLM 均可）；
- :class:`~app.services.embedding.deterministic.DeterministicEmbedder` —— 开发兜底，
  **不联网、无 API key 也能把链路跑通**，但只反映词面重合、没有语义。

模型锁定规则（架构 §6.4）由知识库记录承担：``embedding_model_id`` + ``embedding_dim``
一旦入库即冻结，换 endpoint 可以、换模型必须新建库。
"""

from __future__ import annotations

import logging

from app.core.config import Settings
from app.services.embedding.base import EmbeddingError, EmbeddingProvider, l2_normalize
from app.services.embedding.deterministic import DeterministicEmbedder
from app.services.embedding.openai_compat import OpenAICompatEmbedder

logger = logging.getLogger(__name__)

DEV_MODEL_ID = DeterministicEmbedder.model_id

__all__ = [
    "DEV_MODEL_ID",
    "DeterministicEmbedder",
    "EmbeddingError",
    "EmbeddingProvider",
    "OpenAICompatEmbedder",
    "build_embedder",
    "l2_normalize",
]


def build_embedder(settings: Settings) -> EmbeddingProvider:
    """按配置选实现：配了 key 与模型就用真实端点，否则退回开发兜底并**明确告警**。"""
    if settings.embedding_api_key and settings.embedding_model:
        return OpenAICompatEmbedder(
            base_url=settings.embedding_base_url,
            api_key=settings.embedding_api_key,
            model_id=settings.embedding_model,
            dim=settings.embedding_dim,
            max_batch=settings.embedding_batch_size,
        )

    logger.warning(
        "未配置 KYLAB_EMBEDDING_API_KEY / KYLAB_EMBEDDING_MODEL，"
        "改用开发用确定性嵌入（%s，%d 维）：向量召回只反映词面重合，不代表真实语义，"
        "全文检索不受影响。",
        DEV_MODEL_ID,
        settings.embedding_dim,
    )
    return DeterministicEmbedder(dim=settings.embedding_dim)
