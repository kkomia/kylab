"""知识库服务（M2）。

知识库是模型锁定的载体：创建时把当前 embedding 实现写入 ``embedding_model_id`` 与
``embedding_dim``，此后**库内一旦有向量就不允许更换模型**（架构 §6.4）。

v0.8：嵌入模型是知识库的必备属性。既没在建库时挑一个注册模型、全局默认也没配，
就**拒绝建库**并给出下一步动作——不退回无语义的哈希实现（那会让用户以为检索有效）。
"""

from __future__ import annotations

from app.core.exceptions import InvalidRequestError, NotFoundError
from app.services.embedding import NOT_CONFIGURED_HINT
from app.services.embedding.base import EmbeddingProvider
from app.services.model_registry import ModelRegistryService
from app.storage.base import KnowledgeBaseRecord, StoreBundle

__all__ = ["DEFAULT_CHUNK_STRATEGY", "KnowledgeBaseService"]

DEFAULT_CHUNK_STRATEGY = "fixed"


class KnowledgeBaseService:
    """知识库的创建与查询。"""

    def __init__(
        self,
        stores: StoreBundle,
        *,
        embedder: EmbeddingProvider,
        models: ModelRegistryService | None = None,
    ) -> None:
        self._stores = stores
        self._embedder = embedder
        # 建库时要按选中的注册模型取"模型 ID + 维度"，所以需要注册器。
        # 允许为 None 只为老测试方便——生产由组合根传进来
        self._models = models

    def create(
        self,
        *,
        kb_id: str,
        name: str,
        chunk_size: int = 512,
        chunk_overlap: int = 64,
        chunk_strategy: str = DEFAULT_CHUNK_STRATEGY,
        owner_id: str | None = None,
        embedding_model_pk: str | None = None,
    ) -> KnowledgeBaseRecord:
        """建库并**冻结嵌入模型**（架构 §6.4）。

        嵌入模型是知识库属性（v11 设计调整）：``embedding_model_pk`` 传了就用注册表里
        那个模型（凭据运行时按 pk 解析）；没传就用注册表里绑定的**默认嵌入模型**，
        两者都没有则拒绝建库——向量空间是库的地基，没有它就建不出能检索的库。

        ``owner_id``（v10）：登录成员建的库归自己；API Key 通道
        没有账号概念，传 None 即无主（对管理员全可见）。
        """
        if embedding_model_pk:
            if self._models is None:
                raise InvalidRequestError("未接入模型注册器，无法按所选模型建库")
            _, model = self._models.embedding_target(embedding_model_pk)
            model_id, dim = model.model_id, model.dim or 0
        else:
            model_id, dim = self._embedder.model_id, self._embedder.dim
            if not model_id or dim <= 0:
                raise InvalidRequestError(NOT_CONFIGURED_HINT)

        return self._stores.meta.create_knowledge_base(
            KnowledgeBaseRecord(
                id=kb_id,
                name=name,
                embedding_model_id=model_id,
                embedding_dim=dim,
                embedding_model_pk=embedding_model_pk,
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
