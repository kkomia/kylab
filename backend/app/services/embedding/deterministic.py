"""开发用确定性嵌入（M2 T2.9）。

**它没有语义。** 实现方式是特征哈希（hashing trick）：把词元哈希到固定维度上累加并做符号散列，
再 L2 归一化。因此：

- 词面重合越多，向量越接近 —— 这让"传进来的 query 与文档用词相同"的场景看起来是work的；
- 换个说法但意思相同的句子**不会**靠近 —— 这不是语义嵌入。

存在意义：让"上传 → 解析 → 切分 → 向量化 → 检索"整条链路在没有 API key、不联网的情况下
也能跑通并被测试，而不是把整条主链路卡在凭据上。启用真实模型后即可替换。
"""

from __future__ import annotations

import hashlib
from collections.abc import Sequence

import jieba

from app.services.embedding.base import EmbeddingProvider, l2_normalize

DEFAULT_DEV_DIM = 256
MAX_TOKENS_PER_TEXT = 512
"""截断上限：开发兜底不追求长文建模，避免超长文本拖慢测试。"""


def tokenize(text: str) -> list[str]:
    """切词：jieba 词元 + 中文单字。

    补单字是因为查询常常很短（"检索"），而 jieba 可能把它切成一整词，
    单字能提高短查询与长文档的碰撞概率，让开发期的召回看起来更合理。
    """
    tokens = [word.strip().lower() for word in jieba.cut_for_search(text) if word.strip()]
    tokens.extend(char for char in text if "\u4e00" <= char <= "\u9fff")
    return tokens[:MAX_TOKENS_PER_TEXT]


def _bucket(token: str, dim: int) -> tuple[int, float]:
    """哈希到桶位与符号：blake2b 稳定且跨进程一致（内置 hash() 有随机种子，不能用）。"""
    digest = hashlib.blake2b(token.encode("utf-8"), digest_size=8).digest()
    value = int.from_bytes(digest, "big")
    index = value % dim
    sign = 1.0 if (value >> 63) & 1 else -1.0
    return index, sign


class DeterministicEmbedder(EmbeddingProvider):
    """特征哈希向量化器（开发兜底）。"""

    model_id = "dev/deterministic-hash"
    is_development = True

    def __init__(self, dim: int = DEFAULT_DEV_DIM, *, max_batch: int = 64) -> None:
        if dim <= 0:
            raise ValueError("维度必须为正整数")
        self.dim = dim
        self.max_batch = max_batch
        jieba.initialize()

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        return [self._embed_one(text) for text in texts]

    def _embed_one(self, text: str) -> list[float]:
        vector = [0.0] * self.dim
        for token in tokenize(text):
            index, sign = _bucket(token, self.dim)
            vector[index] += sign
        return l2_normalize(vector)
