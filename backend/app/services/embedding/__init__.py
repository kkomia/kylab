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

from app.services.embedding.base import EmbeddingError, EmbeddingProvider, l2_normalize
from app.services.embedding.deterministic import DeterministicEmbedder
from app.services.embedding.openai_compat import OpenAICompatEmbedder
from app.services.runtime_config import RuntimeConfigService

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


def build_embedder(runtime: RuntimeConfigService) -> EmbeddingProvider:
    """按**运行期配置**选实现：配了 key 与模型就用真实端点，否则退回开发兜底并明确告警。

    每次调用都重新读配置，因此用户在设置页改完模型立刻生效，不必重启进程。
    """
    config = runtime.embedding()
    if config.is_configured:
        return OpenAICompatEmbedder(
            base_url=config.base_url,
            api_key=config.api_key,
            model_id=config.model_id,
            dim=config.dim,
            max_batch=config.batch_size,
        )

    logger.warning(
        "未配置 embedding API Key 或模型（设置页可填），改用开发用确定性嵌入"
        "（%s，%d 维）：向量召回只反映词面重合，不代表真实语义，全文检索不受影响。",
        DEV_MODEL_ID,
        config.dim or 256,
    )
    return DeterministicEmbedder(dim=config.dim or 256)
