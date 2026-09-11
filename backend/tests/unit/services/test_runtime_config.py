"""运行期配置：三层优先级、快照与掩码（`services/runtime_config.py`）。

交接文档把"配置层 721 行没有直接单测"列为**最大的质量缺口**——设置页改错一个字段
可能悄悄影响所有调用，而没有测试会红。本文件补上最要紧的几条：

1. 优先级 **数据库 > `.env` 引导 > 代码默认**（顺序错了会让"部署时预设"永远压住网页设置）；
2. 密钥**只回显掩码**，且**拒绝把掩码当新值回写**（那会把真密钥写成 `sk-xu…ten`）；
3. 快照的**模型身份只来自注册表**（v0.8 归属整理），未绑定即未配置。
"""

from __future__ import annotations

from app.core.config import Settings
from app.services.model_registry import ModelRegistryService
from app.services.runtime_config import (
    DEFAULTS,
    SECRET_KEYS,
    SETTING_GROUPS,
    RuntimeConfigService,
    mask_secret,
)
from tests.conftest import bind_model


def test_defaults_apply_when_nothing_is_configured(runtime: RuntimeConfigService) -> None:
    assert runtime.get("embedding.batch_size") == DEFAULTS["embedding.batch_size"]
    assert runtime.get_int("chat.top_k") == 6
    assert runtime.get("不存在的键") == ""


def test_env_bootstrap_is_the_middle_layer(bundle) -> None:  # type: ignore[no-untyped-def]
    """`.env` 只是"部署时预设一次"，它高于代码默认、低于数据库。"""
    settings = Settings(embedding_batch_size=8, llm_temperature=0.9)  # type: ignore[call-arg]
    runtime = RuntimeConfigService(bundle, settings)

    assert runtime.get("embedding.batch_size") == "8"
    assert runtime.get("llm.temperature") == "0.9"


def test_database_beats_env_and_defaults(bundle) -> None:  # type: ignore[no-untyped-def]
    settings = Settings(embedding_batch_size=8)  # type: ignore[call-arg]
    runtime = RuntimeConfigService(bundle, settings)

    runtime.set({"embedding.batch_size": "4"})

    assert runtime.get("embedding.batch_size") == "4"


def test_empty_value_falls_back_to_the_default(runtime: RuntimeConfigService) -> None:
    """写空 = "没设过"：**类型化读取器**（get_int/_as_float 等）据此回落默认值。

    `get()` 本身如实回显存进去的空串；兜默认是读取方的责任——这条区别值得钉住，
    因为它决定了"清空一个项"到底是恢复默认还是变成一个空值。
    """
    runtime.set({"chat.top_k": "20"})
    assert runtime.get_int("chat.top_k") == 20

    runtime.set({"chat.top_k": ""})

    assert runtime.get("chat.top_k") == ""
    assert runtime.get_int("chat.top_k") == int(DEFAULTS["chat.top_k"])


def test_masked_secret_is_never_written_back(runtime: RuntimeConfigService) -> None:
    """界面上显示的 `sk-xu…ten` 不是密钥——把它写回去会把真凭据毁掉。"""
    runtime.set({"mineru.token": "sk-real-value"})
    runtime.set({"mineru.token": mask_secret("sk-real-value")})

    assert runtime.get("mineru.token") == "sk-real-value"


def test_describe_masks_secrets_and_reports_configured(
    runtime: RuntimeConfigService,
) -> None:
    runtime.set({"mineru.token": "sk-real-value"})
    groups = {group["key"]: group for group in runtime.describe()["groups"]}
    fields = {field["key"]: field for field in groups["mineru"]["fields"]}

    token = fields["mineru.token"]
    assert token["configured"] is True
    assert "…" in token["value"]
    assert "sk-real-value" not in token["value"]
    # 非密钥原样回显
    assert fields["mineru.endpoint"]["value"] != ""


def test_mask_secret_hides_short_values_completely() -> None:
    assert mask_secret("") == ""
    assert mask_secret("short") == "•••••"
    assert mask_secret("sk-abcdefghij").startswith("sk-")
    assert "…" in mask_secret("sk-abcdefghij")


def test_every_secret_key_is_a_declared_setting() -> None:
    declared = {field["key"] for group in SETTING_GROUPS.values() for field in group["fields"]}
    assert declared >= SECRET_KEYS


# --------------------------------------------------------------------- 快照


def test_embedding_snapshot_is_unconfigured_without_a_binding(
    runtime: RuntimeConfigService,
) -> None:
    assert runtime.embedding().is_configured is False
    assert runtime.llm().is_configured is False


def test_embedding_snapshot_takes_identity_from_the_registry(
    runtime: RuntimeConfigService, bundle
) -> None:  # type: ignore[no-untyped-def]
    bind_model(
        ModelRegistryService(bundle),
        "embedding",
        model_id="bge-m3",
        capabilities=["embedding"],
        dim=1024,
        base_url="https://api.siliconflow.cn/v1",
        api_key="sk-embed",
    )
    runtime.set({"embedding.batch_size": "16"})

    snapshot = runtime.embedding()

    assert (snapshot.base_url, snapshot.api_key, snapshot.model_id) == (
        "https://api.siliconflow.cn/v1",
        "sk-embed",
        "bge-m3",
    )
    assert (snapshot.dim, snapshot.batch_size) == (1024, 16)
    assert snapshot.is_configured is True


def test_llm_snapshot_lets_model_options_override_sampling(
    runtime: RuntimeConfigService, bundle
) -> None:  # type: ignore[no-untyped-def]
    registry = ModelRegistryService(bundle)
    provider = registry.create_provider(
        kind="llm", name="推理家", base_url="https://reason.example.com/v1", api_key="sk-r"
    )
    model = registry.register_model(
        provider_id=provider.id,
        model_id="deepseek-reasoner",
        capabilities=["chat"],
        options={"temperature": 0.1, "enable_thinking": True},
    )
    registry.bind("chat", model.id)
    runtime.set({"llm.temperature": "0.7", "llm.max_tokens": "2048"})

    snapshot = runtime.llm()

    # 模型自带的采样参数优先于设置页（推理模型的最优区间不同）
    assert snapshot.temperature == 0.1
    assert snapshot.enable_thinking is True
    # 模型没覆盖的仍取设置页
    assert snapshot.max_tokens == 2048
    assert snapshot.model_id == "deepseek-reasoner"


def test_cloud_parser_snapshots_come_from_settings(runtime: RuntimeConfigService) -> None:
    runtime.set({"mineru.token": "m-token", "paddleocr.token": "p-token"})

    assert runtime.mineru().token == "m-token"
    assert runtime.paddleocr().token == "p-token"
