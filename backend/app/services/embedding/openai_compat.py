"""OpenAI 兼容端点的 embedding 实现（M2 T2.9）。

一套客户端覆盖云端（硅基流动等）与本地（Ollama / vLLM / LM Studio），
换 provider 只改 ``base_url``，这正是架构 §9 说的"embedding 与解析共用云端/本地节点抽象"。
"""

from __future__ import annotations

from collections.abc import Sequence

import httpx

from app.services.embedding.base import EmbeddingError, EmbeddingProvider, l2_normalize

DEFAULT_TIMEOUT_SECONDS = 60.0
_MAX_ERROR_BODY = 200


class OpenAICompatEmbedder(EmbeddingProvider):
    """``POST {base_url}/embeddings``，请求体与响应格式遵循 OpenAI 规范。"""

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        model_id: str,
        dim: int,
        max_batch: int = 32,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        client: httpx.Client | None = None,
    ) -> None:
        if dim <= 0:
            raise ValueError("维度必须为正整数")
        self.base_url = base_url.rstrip("/")
        self.model_id = model_id
        self.dim = dim
        self.max_batch = max_batch
        self._api_key = api_key
        self._timeout = timeout
        self._client = client

    # ------------------------------------------------------------------ 接口

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        if not texts:
            return []
        vectors: list[list[float]] = []
        for start in range(0, len(texts), self.max_batch):
            batch = list(texts[start : start + self.max_batch])
            vectors.extend(self._embed_batch(batch))
        return vectors

    # ------------------------------------------------------------------ 内部

    def _embed_batch(self, batch: list[str]) -> list[list[float]]:
        payload = {"model": self.model_id, "input": batch}
        headers = {"Authorization": f"Bearer {self._api_key}"}

        if self._client is not None:
            response = self._client.post(
                f"{self.base_url}/embeddings", json=payload, headers=headers
            )
        else:
            with httpx.Client(timeout=self._timeout) as client:
                response = client.post(
                    f"{self.base_url}/embeddings", json=payload, headers=headers
                )

        if response.status_code != 200:
            body = response.text[:_MAX_ERROR_BODY]
            hint = "（401 通常意味着 token 失效或额度用尽）" if response.status_code == 401 else ""
            raise EmbeddingError(
                f"embedding 端点返回 {response.status_code}: {body}{hint}"
            )

        try:
            items = response.json()["data"]
        except (KeyError, ValueError) as exc:
            raise EmbeddingError(f"embedding 响应格式不符合 OpenAI 规范：{exc}") from exc

        # 按 index 排序：规范里 data 不保证顺序，取错顺序会让向量与文本错位且难以察觉
        ordered = sorted(items, key=lambda item: item.get("index", 0))
        vectors = [l2_normalize(item["embedding"]) for item in ordered]

        self._verify(vectors, len(batch))
        return vectors

    def _verify(self, vectors: list[list[float]], expected_count: int) -> None:
        if len(vectors) != expected_count:
            raise EmbeddingError(
                f"返回向量数 {len(vectors)} 与请求文本数 {expected_count} 不一致"
            )
        actual = len(vectors[0])
        if actual != self.dim:
            raise EmbeddingError(
                f"模型 {self.model_id} 实际输出 {actual} 维，配置声明 {self.dim} 维；"
                "维度不符会污染整个向量空间，请改正 KYLAB_EMBEDDING_DIM"
            )
