"""embedding 工厂的单元测试。

镜像同构：``app/services/embedding/__init__.py``
→ ``tests/unit/services/embedding/test_factory.py``。

这条分支决定"用真实模型还是开发兜底"，选错了会让检索质量静默失真，必须测。
"""

import logging

import pytest

from app.core.config import Settings
from app.services.embedding import DEV_MODEL_ID, build_embedder
from app.services.embedding.deterministic import DeterministicEmbedder
from app.services.embedding.openai_compat import OpenAICompatEmbedder


def _settings(**kwargs) -> Settings:
    params = {
        "embedding_api_key": None,
        "embedding_model": None,
        "embedding_dim": 64,
    }
    params.update(kwargs)
    return Settings(_env_file=None, **params)  # type: ignore[arg-type]


def test_falls_back_to_deterministic_without_credentials(caplog) -> None:
    with caplog.at_level(logging.WARNING, logger="app.services.embedding"):
        embedder = build_embedder(_settings())

    assert isinstance(embedder, DeterministicEmbedder)
    assert embedder.is_development is True
    assert embedder.dim == 64
    # 必须留下告警：否则用户会把"词面匹配"误当成语义检索效果
    assert any(DEV_MODEL_ID in record.getMessage() for record in caplog.records)


def test_uses_openai_compat_when_configured() -> None:
    embedder = build_embedder(
        _settings(
            embedding_api_key="sk-test",
            embedding_model="BAAI/bge-m3",
            embedding_dim=1024,
            embedding_batch_size=16,
        )
    )

    assert isinstance(embedder, OpenAICompatEmbedder)
    assert embedder.model_id == "BAAI/bge-m3"
    assert embedder.dim == 1024
    assert embedder.max_batch == 16
    assert embedder.is_development is False


@pytest.mark.parametrize(
    ("api_key", "model"),
    [(None, "BAAI/bge-m3"), ("sk-test", None), ("sk-test", "")],
)
def test_partial_credentials_still_fall_back(api_key: str | None, model: str | None) -> None:
    """只配了一半不能装作能用真实模型——那会在首次摄入时才炸。"""
    embedder = build_embedder(_settings(embedding_api_key=api_key, embedding_model=model))
    assert isinstance(embedder, DeterministicEmbedder)
