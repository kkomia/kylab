"""知识库服务（M2）。

知识库是模型锁定的载体：创建时把当前 embedding 实现写入 ``embedding_model_id`` 与
``embedding_dim``，此后**库内一旦有向量就不允许更换模型**（架构 §6.4）。
"""

from __future__ import annotations

from app.core.exceptions import NotFoundError
from app.services.embedding.base import EmbeddingProvider
from app.storage.base import KnowledgeBaseRecord, StoreBundle

__all__ = ["DEFAULT_CHUNK_STRATEGY", "KnowledgeBaseService"]

DEFAULT_CHUNK_STRATEGY = "fixed"


class KnowledgeBaseService:
    """知识库的创建与查询。"""

    def __init__(self, stores: StoreBundle, *, embedder: EmbeddingProvider) -> None:
        self._stores = stores
        self._embedder = embedder

    def create(
        self,
        *,
        kb_id: str,
        name: str,
        chunk_size: int = 512,
        chunk_overlap: int = 64,
        chunk_strategy: str = DEFAULT_CHUNK_STRATEGY,
        owner_id: str | None = None,
    ) -> KnowledgeBaseRecord:
        """建库并把当前 embedding 实现的模型与维度冻结进记录。

        ``owner_id``（v10）：登录成员建的库归自己；控制台令牌/API Key 通道
        没有账号概念，传 None 即无主（对管理员全可见）。
        """
        return self._stores.meta.create_knowledge_base(
            KnowledgeBaseRecord(
                id=kb_id,
                name=name,
                embedding_model_id=self._embedder.model_id,
                embedding_dim=self._embedder.dim,
                chunk_strategy=chunk_strategy,
                chunk_size=chunk_size,
                chunk_overlap=chunk_overlap,
                owner_id=owner_id,
            )
        )

    def get(self, kb_id: str) -> KnowledgeBaseRecord:
        record = self._stores.meta.get_knowledge_base(kb_id)
        if record is None:
            raise NotFoundError(f"知识库不存在：{kb_id}")
        return record

    def list_all(self) -> list[KnowledgeBaseRecord]:
        return self._stores.meta.list_knowledge_bases()
