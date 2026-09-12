"""知识库服务（M2）。

知识库是模型锁定的载体：创建时把当前 embedding 实现写入 ``embedding_model_id`` 与
``embedding_dim``，此后**库内一旦有向量就不允许更换模型**（架构 §6.4）。

v0.8：嵌入模型是知识库的必备属性。既没在建库时挑一个注册模型、全局默认也没配，
就**拒绝建库**并给出下一步动作——不退回无语义的哈希实现（那会让用户以为检索有效）。
"""

from __future__ import annotations

from datetime import datetime

from app.core.exceptions import InvalidRequestError, NotFoundError
from app.services.chunking import (
    CHUNK_OVERLAP_RATIO_MAX,
    CHUNK_SIZE_MAX,
    CHUNK_SIZE_MIN,
    DEFAULT_CHUNK_SIZE,
    DEFAULT_OVERLAP,
)
from app.services.embedding import NOT_CONFIGURED_HINT
from app.services.embedding.base import EmbeddingProvider
from app.services.model_registry import ModelRegistryService
from app.storage.base import KnowledgeBaseRecord, StoreBundle

__all__ = [
    "DEFAULT_CHUNK_STRATEGY",
    "KnowledgeBaseService",
    "validate_chunking",
]

DEFAULT_CHUNK_STRATEGY = "fixed"

KB_NAME_MAX_CHARS = 120
"""与建库时的 schema 上限一致（``KnowledgeBaseCreate.name``）。"""

KB_DESCRIPTION_MAX_CHARS = 200
"""库简介上限。卡片上只显示两行，200 字足够写清"这个库是干什么的"。"""


def validate_chunking(size: int, overlap: int) -> tuple[int, int]:
    """校验切分参数，返回规范化后的 ``(size, overlap)``。

    **为什么放在服务层而不是只靠 pydantic**：PATCH 可能只传其中一个字段，
    必须与库里已有的那个合并之后再判"重叠 < 块长"——单个字段的 ``ge/le``
    校验看不到另一个字段，做不到这件事。两个字段一起传时也走这里，
    保证建库与改配置**用同一套口径**，不会出现"建库能过、改配置不过"。

    报错文案写给用户看：说清该填多少，而不是回一句"参数非法"。
    """
    if not (CHUNK_SIZE_MIN <= size <= CHUNK_SIZE_MAX):
        raise InvalidRequestError(
            f"块长需要在 {CHUNK_SIZE_MIN}–{CHUNK_SIZE_MAX} 之间（当前 {size}）"
        )
    overlap_max = max(1, int(size * CHUNK_OVERLAP_RATIO_MAX))
    if not (0 <= overlap <= overlap_max):
        raise InvalidRequestError(
            f"块重叠需要在 0–{overlap_max} 之间（当前 {overlap}）；"
            "上限是块长的一半——重叠等于块长会让切分原地打转"
        )
    return size, overlap


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
        chunk_size: int = DEFAULT_CHUNK_SIZE,
        chunk_overlap: int = DEFAULT_OVERLAP,
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

        切分参数（v17）在这里就落库并校验，**摄入时按库读取**——之前它只是被存下来
        没人用（真实切分永远是默认 512/64），那是一个不成立的承诺。
        """
        chunk_size, chunk_overlap = validate_chunking(chunk_size, chunk_overlap)
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

    def document_stats(self) -> dict[str, tuple[int, datetime | None]]:
        """每个库的 ``(文档数, 最近更新时间)``——**一次聚合查询**，不逐库列文档。"""
        return self._stores.meta.document_stats_by_kbs()

    def set_description(self, kb_id: str, description: str) -> KnowledgeBaseRecord:
        """改库简介。空串是合法值（= 清空），不做"必须填"的要求。"""
        record = self.get(kb_id)
        cleaned = " ".join((description or "").split())
        if len(cleaned) > KB_DESCRIPTION_MAX_CHARS:
            raise InvalidRequestError(f"简介最多 {KB_DESCRIPTION_MAX_CHARS} 个字符")
        if cleaned == record.description:
            return record
        self._stores.meta.set_knowledge_base_description(kb_id, cleaned)
        record.description = cleaned
        return record

    def rename(self, kb_id: str, name: str) -> KnowledgeBaseRecord:
        """改显示名。**不碰嵌入模型**——那是库的地基，改名只是标签。

        切分参数另走 ``set_chunking``：它与改名不是一回事，改错了要重跑摄入。
        """
        record = self.get(kb_id)
        cleaned = name.strip()
        if not cleaned:
            raise InvalidRequestError("知识库名称不能为空")
        if len(cleaned) > KB_NAME_MAX_CHARS:
            raise InvalidRequestError(f"知识库名称最多 {KB_NAME_MAX_CHARS} 个字符")
        if cleaned == record.name:
            return record
        self._stores.meta.rename_knowledge_base(kb_id, cleaned)
        record.name = cleaned
        return record

    def set_chunking(
        self, kb_id: str, *, chunk_size: int | None, chunk_overlap: int | None
    ) -> KnowledgeBaseRecord:
        """改切分参数（块长 / 块重叠）。两个都可选，只传要改的那个。

        **改动只对之后摄入的文档生效**——切块是解析阶段写进库的，
        已经切好的文档不会自己跟着变。所以接口不假装"改完就生效"：
        调用方（界面）负责提示"已有文档需要重新摄入"，并把
        `documents/batch` 的 reprocess 入口摆在那里。

        这里**不做自动重跑**是刻意的：一个几万文档的库被一次参数微调
        静默全量重跑（要钱、要时间、还要临时占用云端配额）比"没生效"更糟。
        用户自己点那一下，才知道代价。
        """
        record = self.get(kb_id)
        size = record.chunk_size if chunk_size is None else chunk_size
        overlap = record.chunk_overlap if chunk_overlap is None else chunk_overlap
        size, overlap = validate_chunking(size, overlap)
        if (size, overlap) == (record.chunk_size, record.chunk_overlap):
            return record
        self._stores.meta.set_knowledge_base_chunking(kb_id, size, overlap)
        record.chunk_size = size
        record.chunk_overlap = overlap
        return record
