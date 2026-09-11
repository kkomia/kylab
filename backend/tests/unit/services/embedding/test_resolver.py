"""按库解析嵌入模型（v11 设计调整）。

**最要紧的一条**：嵌入模型是知识库属性——"小文档库用高精度模型、大文档库用小模型
提速"这个场景，全靠"每个库各自解析出自己的 embedder"成立。这里把这条性质钉住，
外加两条回退行为：没选（老库）与模型坏掉，都不能让检索/摄入直接失败。
"""

from __future__ import annotations

from collections.abc import Sequence

import pytest

from app.services.embedding.base import EmbeddingProvider
from app.services.embedding.resolver import EmbeddingResolver
from app.services.model_registry import ModelRegistryService
from app.storage.base import KnowledgeBaseRecord, ModelProviderRecord, RegisteredModelRecord


class _FakeEmbedder(EmbeddingProvider):
    """只记身份、不做网络：本文件验的是"选对了哪个模型"，不是嵌入质量。"""

    def __init__(self, *, model_id: str, dim: int) -> None:
        self.model_id = model_id
        self.dim = dim

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        return [[0.0] * self.dim for _ in texts]


@pytest.fixture
def registry(bundle) -> ModelRegistryService:  # type: ignore[no-untyped-def]
    return ModelRegistryService(bundle)


def _register_embedding_model(registry: ModelRegistryService, *, model_id: str, dim: int) -> str:
    provider: ModelProviderRecord = registry.create_provider(
        kind="embedding",
        name=f"供应商-{model_id}",
        base_url="https://api.example.com",
        api_key="sk-x",
    )
    model: RegisteredModelRecord = registry.register_model(
        provider_id=provider.id, model_id=model_id, capabilities=["embedding"], dim=dim
    )
    return model.id


def _resolver(
    registry: ModelRegistryService, *, fallback: EmbeddingProvider
) -> tuple[EmbeddingResolver, list[str]]:
    built: list[str] = []

    def factory(*, model_id: str, dim: int, **_: object) -> EmbeddingProvider:
        built.append(model_id)
        return _FakeEmbedder(model_id=model_id, dim=dim)

    return EmbeddingResolver(registry, fallback=fallback, factory=factory), built


def test_resolves_the_model_chosen_by_the_knowledge_base(
    registry: ModelRegistryService,
) -> None:
    pk = _register_embedding_model(registry, model_id="bge-m3-large", dim=1024)
    fallback = _FakeEmbedder(model_id="global-default", dim=256)
    resolver, built = _resolver(registry, fallback=fallback)

    embedder = resolver.for_kb(
        KnowledgeBaseRecord(
            id="kb_1", name="小库", embedding_model_id="x", embedding_dim=1, embedding_model_pk=pk
        )
    )

    assert embedder.model_id == "bge-m3-large"
    assert embedder.dim == 1024
    assert built == ["bge-m3-large"]


def test_two_knowledge_bases_can_use_different_models(
    registry: ModelRegistryService,
) -> None:
    """这就是这次设计调整要支持的场景：不同库、不同嵌入模型并存。"""
    small = _register_embedding_model(registry, model_id="tiny", dim=384)
    large = _register_embedding_model(registry, model_id="precise", dim=1024)
    resolver, _ = _resolver(registry, fallback=_FakeEmbedder(model_id="fallback", dim=256))

    tiny_model = resolver.for_kb(
        KnowledgeBaseRecord(
            id="kb_a",
            name="大库",
            embedding_model_id="x",
            embedding_dim=1,
            embedding_model_pk=small,
        )
    )
    precise_model = resolver.for_kb(
        KnowledgeBaseRecord(
            id="kb_b",
            name="小库",
            embedding_model_id="x",
            embedding_dim=1,
            embedding_model_pk=large,
        )
    )

    assert (tiny_model.model_id, tiny_model.dim) == ("tiny", 384)
    assert (precise_model.model_id, precise_model.dim) == ("precise", 1024)


def test_knowledge_base_without_a_choice_falls_back(registry: ModelRegistryService) -> None:
    """老库（或建库时没挑模型）走全局默认——升级不打断既有部署。"""
    fallback = _FakeEmbedder(model_id="global-default", dim=256)
    resolver, built = _resolver(registry, fallback=fallback)

    embedder = resolver.for_kb(
        KnowledgeBaseRecord(id="kb_old", name="老库", embedding_model_id="x", embedding_dim=256)
    )

    assert embedder is fallback
    assert built == []


def test_a_broken_reference_falls_back_instead_of_failing(
    registry: ModelRegistryService,
) -> None:
    """模型被删/供应商停用：回退并告警，而不是让这个库彻底无法检索。"""
    fallback = _FakeEmbedder(model_id="global-default", dim=256)
    resolver, _ = _resolver(registry, fallback=fallback)

    embedder = resolver.for_kb(
        KnowledgeBaseRecord(
            id="kb_x",
            name="库",
            embedding_model_id="x",
            embedding_dim=1,
            embedding_model_pk="pk_already_deleted",
        )
    )

    assert embedder is fallback


def test_instances_are_cached_per_model(registry: ModelRegistryService) -> None:
    """一次摄入要分批嵌入几百个 chunk，每批重建客户端是浪费。"""
    pk = _register_embedding_model(registry, model_id="cached", dim=768)
    resolver, built = _resolver(registry, fallback=_FakeEmbedder(model_id="f", dim=256))
    kb = KnowledgeBaseRecord(
        id="kb_c", name="库", embedding_model_id="x", embedding_dim=1, embedding_model_pk=pk
    )

    first = resolver.for_kb(kb)
    second = resolver.for_kb(kb)

    assert first is second
    assert built == ["cached"]
