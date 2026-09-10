"""embedding 工厂的单元测试。

镜像同构：``app/services/embedding/__init__.py``
→ ``tests/unit/services/embedding/test_factory.py``。

这条分支决定"用真实模型还是开发兜底"，选错了会让检索质量静默失真，必须测。
配置来源已从 ``.env`` 改为运行期配置（设置页写入 SQLite），所以这里造的是
``RuntimeConfigService`` 而不是 ``Settings``。
"""

import logging

import pytest

from app.services.embedding import DEV_MODEL_ID, build_embedder
from app.services.embedding.deterministic import DeterministicEmbedder
from app.services.embedding.openai_compat import OpenAICompatEmbedder


def _configure(runtime, **values) -> None:
    """只写显式给出的键：其余留给代码默认值（默认模型就是 bge-m3 / 1024 维）。"""
    runtime.set({key.replace("_", "."): str(value) for key, value in values.items()})


def test_falls_back_to_deterministic_without_credentials(runtime, caplog) -> None:
    runtime.set({"embedding.api_key": ""})
    with caplog.at_level(logging.WARNING, logger="app.services.embedding"):
        embedder = build_embedder(runtime)

    assert isinstance(embedder, DeterministicEmbedder)
    assert embedder.is_development is True
    # 必须留下告警：否则用户会把"词面匹配"误当成语义检索效果
    assert any(DEV_MODEL_ID in record.getMessage() for record in caplog.records)


def test_uses_openai_compat_when_configured(runtime) -> None:
    runtime.set(
        {
            "embedding.api_key": "sk-test",
            "embedding.model_id": "BAAI/bge-m3",
            "embedding.dim": "1024",
            "embedding.batch_size": "16",
        }
    )

    embedder = build_embedder(runtime)

    assert isinstance(embedder, OpenAICompatEmbedder)
    assert embedder.model_id == "BAAI/bge-m3"
    assert embedder.dim == 1024
    assert embedder.max_batch == 16
    assert embedder.is_development is False


def test_masked_secret_is_never_written_back(runtime) -> None:
    """界面上显示的是 ``sk-…est`` 这种掩码，把它当新值回写就等于把密钥改坏。"""
    runtime.set({"embedding.api_key": "sk-test-0123456789"})
    masked = runtime.describe()["groups"][0]["fields"][1]["value"]
    assert "…" in masked

    runtime.set({"embedding.api_key": masked})

    assert runtime.get("embedding.api_key") == "sk-test-0123456789"


@pytest.mark.parametrize("missing", ["embedding.api_key", "embedding.model_id"])
def test_partial_credentials_still_fall_back(runtime, missing: str) -> None:
    """只配了一半不能装作能用真实模型——那会在首次摄入时才炸。"""
    runtime.set(
        {
            "embedding.api_key": "sk-test",
            "embedding.model_id": "BAAI/bge-m3",
            "embedding.dim": "1024",
        }
    )
    runtime.set({missing: ""})

    assert isinstance(build_embedder(runtime), DeterministicEmbedder)


def test_env_only_bootstraps_until_user_overrides(runtime, bundle) -> None:
    """.env 只是引导值：网页上写过一次之后就以数据库为准。"""
    from app.core.config import Settings
    from app.services.runtime_config import RuntimeConfigService

    boot = RuntimeConfigService(
        bundle, Settings(_env_file=None, embedding_model="bootstrapped-model")  # type: ignore[arg-type]
    )
    assert boot.get("embedding.model_id") == "bootstrapped-model"

    boot.set({"embedding.model_id": "user-picked-model"})
    assert boot.get("embedding.model_id") == "user-picked-model"
