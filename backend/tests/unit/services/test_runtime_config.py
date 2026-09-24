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


def test_memory_keys_can_be_preset_from_env(bundle) -> None:  # type: ignore[no-untyped-def]
    """记忆的开关 / 落点也能从 ``.env`` 预设（v0.1.1）。

    为什么值得这两项有一条路：容器部署要在 compose 里一次写清"记忆落在哪、
    要不要开"，而不是让用户先去界面上找开关。而在这之前 ``_bootstrap_value``
    的映射表里没有它们——写进 .env 是**静默无效**的（这比没有更糟）。
    （第三项"服务地址"已随 ReMe 一起删，见 memory.py 的模块头。）
    """
    settings = Settings(  # type: ignore[call-arg]
        memory_enabled=True,
        memory_workspace="memo",
    )
    runtime = RuntimeConfigService(bundle, settings)

    assert runtime.get_bool("memory.enabled") is True
    assert runtime.get("memory.workspace") == "memo"


def test_memory_defaults_stay_when_the_env_says_nothing(bundle) -> None:  # type: ignore[no-untyped-def]
    """没给引导值时**沿用代码默认**：开关仍是关。

    这一条是"别把默认开关改了"的守门：默认开等于部署升级之后，
    每 N 个回合就多一次模型调用去沉淀记忆（而省 token 是这个项目的硬要求）。
    """
    runtime = RuntimeConfigService(bundle, Settings())  # type: ignore[call-arg]

    assert runtime.get("memory.enabled") == DEFAULTS["memory.enabled"] == "false"
    assert runtime.get("memory.workspace") == DEFAULTS["memory.workspace"]


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
    runtime.set({"llm.temperature": "0.7"})

    snapshot = runtime.llm()

    # 模型自带的采样参数优先于设置页（推理模型的最优区间不同）
    assert snapshot.temperature == 0.1
    assert snapshot.enable_thinking is True
    # 模型没指定长度上限时不发这个字段（设置页也管不着它了）
    assert snapshot.max_tokens is None
    assert snapshot.model_id == "deepseek-reasoner"


def test_thinking_defaults_to_on_with_medium_effort(runtime: RuntimeConfigService, bundle) -> None:  # type: ignore[no-untyped-def]
    """思考**默认开**：主流模型默认都思考，关掉是例外。强度默认中档。"""
    bind_model(ModelRegistryService(bundle), "chat", model_id="m-default", capabilities=["chat"])

    snapshot = runtime.llm()

    assert snapshot.enable_thinking is True
    assert snapshot.thinking_effort == "medium"


def test_model_options_override_thinking_effort_and_dialect(
    runtime: RuntimeConfigService, bundle
) -> None:  # type: ignore[no-untyped-def]
    registry = ModelRegistryService(bundle)
    provider = registry.create_provider(
        kind="llm", name="推理家", base_url="https://reason.example.com/v1", api_key="sk-r"
    )
    model = registry.register_model(
        provider_id=provider.id,
        model_id="m",
        capabilities=["chat"],
        options={"enable_thinking": False, "thinking_effort": "high", "thinking_dialect": "qwen"},
    )
    registry.bind("chat", model.id)

    snapshot = runtime.llm()

    assert snapshot.enable_thinking is False
    assert snapshot.thinking_effort == "high"
    assert snapshot.thinking_dialect == "qwen"


def test_describe_exposes_thinking_effort_as_a_select(runtime: RuntimeConfigService) -> None:
    """设置页靠这个结构渲染下拉；候选值必须由后端给出，前端不硬编码。"""
    groups = {group["key"]: group for group in runtime.describe()["groups"]}
    fields = {field["key"]: field for field in groups["llm"]["fields"]}

    assert fields["llm.enable_thinking"]["type"] == "bool"
    effort = fields["llm.thinking_effort"]
    assert effort["type"] == "select"
    assert [option["value"] for option in effort["options"]] == ["low", "medium", "high"]
    assert effort["value"] == "medium"


def test_cloud_parser_snapshots_come_from_settings(runtime: RuntimeConfigService) -> None:
    runtime.set({"mineru.token": "m-token", "paddleocr.token": "p-token"})

    assert runtime.mineru().token == "m-token"
    assert runtime.paddleocr().token == "p-token"


def test_max_tokens_is_no_longer_a_setting(runtime: RuntimeConfigService) -> None:
    """回复长度上限**不再是设置项**：默认不传这个字段，交还给模型自己。

    它曾经默认 2048，实测会把回复预算掐死在思考阶段、正文一个字都出不来（且时好时坏）。
    抬到 16384 只是降低概率；正确做法是不替模型决定长度。想显式限制的走模型注册的
    ``options.max_tokens``（见 test_registry_bridge）。
    """
    assert "llm.max_tokens" not in DEFAULTS
    assert all(
        field["key"] != "llm.max_tokens"
        for group in SETTING_GROUPS.values()
        for field in group["fields"]
    )
    assert runtime.llm().max_tokens is None


# ------------------------------------------------------------------ 读取缓存


def _count_reads(bundle, monkeypatch):  # type: ignore[no-untyped-def]
    """把仓储的批量读取包一层计数：用来断言"第二次真的没查库"。"""
    calls: list[list[str]] = []
    original = bundle.meta.get_settings

    def spy(keys):  # type: ignore[no-untyped-def]
        calls.append(list(keys))
        return original(keys)

    monkeypatch.setattr(bundle.meta, "get_settings", spy)
    return calls


def test_repeated_reads_hit_the_cache(runtime, bundle, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """同一个键连着读两次，只查一次库。

    一次读取的固定开销实测约 6ms（PG 自己只花 2ms，其余是连接池借还 + 往返），
    而它在每次请求的路径上——一轮对话要读十几次设置。
    """
    calls = _count_reads(bundle, monkeypatch)

    assert runtime.get_int("chat.top_k") == runtime.get_int("chat.top_k")
    assert len(calls) == 1


def test_a_key_that_is_not_in_the_database_is_remembered_too(
    runtime, bundle, monkeypatch  # type: ignore[no-untyped-def]
) -> None:
    """"库里没有这一项"也要记住。

    否则"没配过的键"每次都白查一遍——而设置页打开的 ``describe()`` 里大半都是这种键。
    """
    calls = _count_reads(bundle, monkeypatch)

    assert runtime.get("mineru.token") == ""
    assert runtime.get("mineru.token") == ""

    assert len(calls) == 1


def test_many_reads_share_one_query(runtime, bundle, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """``get_many`` 只发一条 SQL（§12.116 的口径），且第二次不再发。"""
    keys = ["chat.top_k", "chat.section_chars", "chat.material_chars"]
    calls = _count_reads(bundle, monkeypatch)

    runtime.get_many(keys)
    runtime.get_many(keys)

    assert len(calls) == 1
    assert sorted(calls[0]) == sorted(keys)


def test_set_clears_the_cache_immediately(runtime, bundle, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """写完立刻读得到新值：``set`` 主动清缓存，"改完马上看"不走 TTL。"""
    calls = _count_reads(bundle, monkeypatch)

    runtime.get("chat.top_k")
    runtime.set({"chat.top_k": "9"})

    assert runtime.get_int("chat.top_k") == 9
    # 首次读一次 + set 清掉之后再读一次
    assert len(calls) == 2


def test_keys_written_by_other_services_are_never_cached(
    runtime, bundle, monkeypatch  # type: ignore[no-untyped-def]
) -> None:
    """按实体生成的键（``document.<id>.*`` / ``trash.<id>.*``）**不进缓存**。

    它们的写入方（摄入、回收站）直接落库、不经过本服务的 ``set()``；
    缓存了就会在写入后读到旧值，而"偶尔读到旧值"这种 bug 极难复现。
    """
    calls = _count_reads(bundle, monkeypatch)
    key = "document.doc_1.original_path"

    runtime.get(key)
    runtime.get(key)

    assert len(calls) == 2


def test_entries_expire_after_the_ttl(runtime, bundle, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """过了 TTL 要重新查库——这一层的作用是"同一轮里反复读"，不是"永不更新"。"""
    calls = _count_reads(bundle, monkeypatch)
    # 取负数而不是 0：0 会让"同一时刻的两次读"仍算命中，用例会偶然变红
    monkeypatch.setattr("app.services.runtime_config._CACHE_TTL_SECONDS", -1.0)

    runtime.get("chat.top_k")
    runtime.get("chat.top_k")

    assert len(calls) == 2
