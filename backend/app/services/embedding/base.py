"""Embedding 提供方协议。"""

from __future__ import annotations

import math
from abc import ABC, abstractmethod
from collections.abc import Sequence

__all__ = [
    "EmbeddingError",
    "EmbeddingNotConfiguredError",
    "EmbeddingProvider",
    "l2_normalize",
]


class EmbeddingError(Exception):
    """向量化失败。带 ``stage`` 便于状态机把失败定位到具体步骤。"""

    def __init__(self, message: str, *, stage: str = "embedding") -> None:
        super().__init__(message)
        self.stage = stage


class EmbeddingNotConfiguredError(EmbeddingError):
    """**没有可用的嵌入模型**（是本机配置缺失，不是调用失败）。

    单列一类是因为处置方式完全不同：重试没有意义，正确动作是去设置里选模型。
    调用方据此选择"拒绝建库"或"跳过向量通道"，而不是把它当成上游抖动反复重试，
    更不是退回一个无语义的兜底实现。
    """

    def __init__(self, message: str) -> None:
        super().__init__(message, stage="config")


def l2_normalize(vector: Sequence[float]) -> list[float]:
    """L2 归一化。

    归一化后内积等价于余弦相似度，量纲统一；零向量原样返回（全零文本不该让流程炸掉）。
    """
    norm = math.sqrt(sum(value * value for value in vector))
    if norm == 0.0:
        return list(vector)
    return [value / norm for value in vector]


class EmbeddingProvider(ABC):
    """向量化提供方。

    ``model_id`` 与 ``dim`` 是模型锁定的依据：知识库记录它们，**不一致就必须拒绝写入**
    （架构 §6.4：维度相同不等于向量空间兼容）。
    """

    model_id: str = "unnamed"
    dim: int = 0
    max_batch: int = 32
    is_development: bool = False
    """开发兜底实现为 True，接口层应据此提示用户"检索质量不代表真实效果"。"""

    @abstractmethod
    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        """把文本批量转成向量，返回顺序与入参一致。"""

    def __repr__(self) -> str:
        return f"<{type(self).__name__} model_id={self.model_id!r} dim={self.dim}>"
