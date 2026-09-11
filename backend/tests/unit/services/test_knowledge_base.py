"""知识库创建：嵌入模型随库冻结（v11 设计调整）。

原先建库是把**全局**解析出的模型冻进记录，所有库共用一个 embedder；
现在嵌入模型是知识库属性——建库时从注册表挑，随库冻结。这个文件钉住三条：
选了就用选的、没选就沿用全局（兼容）、选了个不能用的要当场报错而不是摄入到一半才炸。
"""

from __future__ import annotations

from collections.abc import Sequence

import pytest

from app.core.exceptions import InvalidRequestError
from app.services.embedding.base import EmbeddingProvider
from app.services.knowledge_base import KnowledgeBaseService
from app.services.model_registry import ModelRegistryService


class _FakeEmbedder(EmbeddingProvider):
    def __init__(self, *, model_id: str, dim: int, is_development: bool = True) -> None:
        self.model_id = model_id
        self.dim = dim
        self.is_development = is_development

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        return [[0.0] * self.dim for _ in texts]


@pytest.fixture
def registry(bundle) -> ModelRegistryService:  # type: ignore[no-untyped-def]
    return ModelRegistryService(bundle)


def _register(registry: ModelRegistryService, *, model_id: str, dim: int | None) -> str:
    provider = registry.create_provider(
        kind="embedding", name="嵌入供应商", base_url="https://api.example.com", api_key="sk-x"
    )
    model = registry.register_model(
        provider_id=provider.id, model_id=model_id, capabilities=["embedding"], dim=dim
    )
    return model.id


def _service(bundle, registry: ModelRegistryService) -> KnowledgeBaseService:  # type: ignore[no-untyped-def]
    return KnowledgeBaseService(
        bundle, embedder=_FakeEmbedder(model_id="global-default", dim=256), models=registry
    )


def test_create_freezes_the_chosen_model(bundle, registry) -> None:  # type: ignore[no-untyped-def]
    pk = _register(registry, model_id="bge-m3", dim=1024)

    kb = _service(bundle, registry).create(
        kb_id="kb_1", name="高精度小库", embedding_model_pk=pk
    )

    assert kb.embedding_model_id == "bge-m3"
    assert kb.embedding_dim == 1024
    assert kb.embedding_model_pk == pk
    # 落库之后再读一次，确认字段真的持久化了（不是只留在内存记录里）
    assert bundle.meta.get_knowledge_base("kb_1").embedding_model_pk == pk


def test_create_without_a_choice_uses_the_global_default(bundle, registry) -> None:  # type: ignore[no-untyped-def]
    kb = _service(bundle, registry).create(kb_id="kb_2", name="不挑模型")

    assert kb.embedding_model_id == "global-default"
    assert kb.embedding_dim == 256
    assert kb.embedding_model_pk is None


def test_create_rejects_a_model_without_a_dimension(bundle, registry) -> None:  # type: ignore[no-untyped-def]
    pk = _register(registry, model_id="no-dim", dim=None)

    with pytest.raises(InvalidRequestError, match="维度"):
        _service(bundle, registry).create(kb_id="kb_3", name="坏模型", embedding_model_pk=pk)

    # 建库失败不该留下半成品
    assert bundle.meta.get_knowledge_base("kb_3") is None


def test_create_rejects_a_non_embedding_model(bundle, registry) -> None:  # type: ignore[no-untyped-def]
    provider = registry.create_provider(
        kind="llm", name="对话供应商", base_url="https://api.example.com", api_key="sk-x"
    )
    model = registry.register_model(
        provider_id=provider.id, model_id="chat-only", capabilities=["chat"]
    )

    with pytest.raises(InvalidRequestError, match="embedding"):
        _service(bundle, registry).create(
            kb_id="kb_4", name="用错模型", embedding_model_pk=model.id
        )
