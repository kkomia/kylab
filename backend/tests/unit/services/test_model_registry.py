"""模型注册器（G1）。

镜像同构：``app/services/model_registry.py`` → 本文件。

**最要紧的一条性质**：注册器是**叠加层**——绑定了就以它为准，没绑定就回退到
``.env`` / 设置页那套。升级不能打断已有部署，这条必须有测试钉住。
"""

from __future__ import annotations

import pytest

from app.core.exceptions import ConflictError, InvalidRequestError, NotFoundError
from app.services.model_registry import SLOTS, ModelRegistryService


@pytest.fixture
def registry(bundle) -> ModelRegistryService:  # type: ignore[no-untyped-def]
    return ModelRegistryService(bundle)


def _provider(registry: ModelRegistryService, **kwargs):  # type: ignore[no-untyped-def]
    base = {"kind": "llm", "name": "某供应商", "base_url": "https://api.example.com"}
    base.update(kwargs)
    return registry.create_provider(**base)


def _model(registry: ModelRegistryService, provider_id: str, **kwargs):  # type: ignore[no-untyped-def]
    base = {"provider_id": provider_id, "model_id": "some-model", "capabilities": ["chat"]}
    base.update(kwargs)
    return registry.register_model(**base)


# --------------------------------------------------------------------- 供应商


def test_create_and_get_provider(registry: ModelRegistryService) -> None:
    created = _provider(registry, name="深度求索", api_key="sk-abc")

    fetched = registry.get_provider(created.id)
    assert fetched.name == "深度求索"
    assert fetched.api_key == "sk-abc"
    assert fetched.enabled is True


def test_provider_kind_is_validated(registry: ModelRegistryService) -> None:
    """类别写错要当场拒绝：它决定设置页怎么分组，写个错值界面会无从渲染。"""
    with pytest.raises(InvalidRequestError) as excinfo:
        _provider(registry, kind="随便什么")
    assert "未知的供应商类别" in str(excinfo.value)


def test_provider_name_cannot_be_blank(registry: ModelRegistryService) -> None:
    with pytest.raises(InvalidRequestError):
        _provider(registry, name="   ")


def test_get_missing_provider_raises(registry: ModelRegistryService) -> None:
    with pytest.raises(NotFoundError):
        registry.get_provider("prov_不存在")


def test_update_provider_keeps_the_key_when_not_supplied(
    registry: ModelRegistryService,
) -> None:
    """**``None`` 表示"没改"，空串表示"清空"**——这个区分是必要的。

    设置页把密钥掩码成占位符，用户不动它时前端回传的是掩码。
    若把"没传"当成"清空"，用户改个名字就会把密钥弄丢。
    """
    provider = _provider(registry, api_key="sk-original")

    registry.update_provider(provider.id, name="改了个名字")

    assert registry.get_provider(provider.id).api_key == "sk-original"


def test_update_provider_can_clear_the_key(registry: ModelRegistryService) -> None:
    provider = _provider(registry, api_key="sk-original")

    registry.update_provider(provider.id, api_key="")

    assert registry.get_provider(provider.id).api_key == ""


def test_update_provider_can_replace_the_key(registry: ModelRegistryService) -> None:
    provider = _provider(registry, api_key="sk-old")

    registry.update_provider(provider.id, api_key="sk-new")

    assert registry.get_provider(provider.id).api_key == "sk-new"


# --------------------------------------------------------------------- 模型


def test_register_model(registry: ModelRegistryService) -> None:
    provider = _provider(registry)
    created = _model(
        registry,
        provider.id,
        model_id="deepseek-chat",
        label="对话主力",
        capabilities=["chat"],
    )

    assert created.provider_id == provider.id
    assert list(created.capabilities) == ["chat"]
    assert registry.get_model(created.id).model_id == "deepseek-chat"


def test_duplicate_model_in_same_provider_is_rejected(
    registry: ModelRegistryService,
) -> None:
    """同一供应商下重复登记同一个 model_id 是纯粹的重复劳动，当场拒绝。"""
    provider = _provider(registry)
    _model(registry, provider.id, model_id="dup-model")

    with pytest.raises(ConflictError):
        _model(registry, provider.id, model_id="dup-model")


def test_same_model_id_under_different_providers_is_allowed(
    registry: ModelRegistryService,
) -> None:
    """两家供应商都叫 `gpt-4o-mini` 是常态（自建网关 + 官方），不该拦。"""
    first = _provider(registry, name="甲家")
    second = _provider(registry, name="乙家")

    _model(registry, first.id, model_id="gpt-4o-mini")
    _model(registry, second.id, model_id="gpt-4o-mini")  # 不该抛


def test_unknown_capability_is_rejected(registry: ModelRegistryService) -> None:
    provider = _provider(registry)
    with pytest.raises(InvalidRequestError) as excinfo:
        _model(registry, provider.id, capabilities=["chat", "fly"])
    assert "未知的能力标记" in str(excinfo.value)


def test_register_model_needs_an_existing_provider(registry: ModelRegistryService) -> None:
    with pytest.raises(NotFoundError):
        registry.register_model(provider_id="prov_不存在", model_id="m")


def test_dim_is_stored_for_embedding_models(registry: ModelRegistryService) -> None:
    """dim 是模型属性，登记一次就不该再让用户在两处各填一遍。"""
    provider = _provider(registry, kind="embedding")
    model = _model(
        registry, provider.id, model_id="bge-m3", dim=1024, capabilities=["embedding"]
    )
    assert model.dim == 1024


# --------------------------------------------------------------------- 绑定


def test_bind_and_resolve(registry: ModelRegistryService) -> None:
    provider = _provider(registry)
    model = _model(registry, provider.id, model_id="deepseek-chat", capabilities=["chat"])

    registry.bind("chat", model.id)

    resolved = registry.resolve("chat")
    assert resolved is not None
    assert resolved[0].id == provider.id
    assert resolved[1].id == model.id


def test_unbound_slot_resolves_to_none(registry: ModelRegistryService) -> None:
    """**未绑定不是错误**，返回 None 让调用方回退到设置页那套。

    这正是"叠加层"的落点：升级不会让已有部署失效。
    """
    assert registry.resolve("chat") is None
    assert registry.bindings() == {}


def test_unbind_clears_the_binding(registry: ModelRegistryService) -> None:
    provider = _provider(registry)
    model = _model(registry, provider.id, capabilities=["chat"])
    registry.bind("chat", model.id)

    registry.bind("chat", None)

    assert registry.resolve("chat") is None


def test_binding_requires_the_declared_capability(registry: ModelRegistryService) -> None:
    """把只声明了 embedding 的模型绑到「对话生成」上要当场拒绝。

    否则用户会得到一条"绑定成功"却在提问时报错的路径——排查成本很高。
    """
    provider = _provider(registry, kind="embedding")
    model = _model(registry, provider.id, capabilities=["embedding"])

    with pytest.raises(InvalidRequestError) as excinfo:
        registry.bind("chat", model.id)
    assert "未声明" in str(excinfo.value)


def test_model_without_capabilities_can_be_bound(registry: ModelRegistryService) -> None:
    """没声明能力时不拦：旧数据或手工登记可能留空，拦了反而没法用。"""
    provider = _provider(registry)
    model = _model(registry, provider.id, capabilities=[])

    registry.bind("chat", model.id)

    assert registry.resolve("chat") is not None


def test_unknown_slot_is_rejected(registry: ModelRegistryService) -> None:
    provider = _provider(registry)
    model = _model(registry, provider.id, capabilities=["chat"])
    with pytest.raises(InvalidRequestError) as excinfo:
        registry.bind("画图", model.id)
    assert "未知的用途" in str(excinfo.value)


def test_one_model_can_serve_multiple_slots(registry: ModelRegistryService) -> None:
    """同一家的同一个网关常常既做对话又做向量化（OpenAI 兼容服务）。"""
    provider = _provider(registry)
    model = _model(registry, provider.id, capabilities=["chat", "embedding"])

    registry.bind("chat", model.id)
    registry.bind("embedding", model.id)

    assert registry.bindings() == {"chat": model.id, "embedding": model.id}


# --------------------------------------------------------------------- 级联


def test_delete_model_unbinds_it_from_slots(registry: ModelRegistryService) -> None:
    """**删模型必须解绑**：否则之后每次检索都报"绑定的模型不存在"，
    而用户在设置页只看到一个灰色下拉，很难联想到是自己删了模型。
    """
    provider = _provider(registry)
    model = _model(registry, provider.id, capabilities=["chat"])
    registry.bind("chat", model.id)

    registry.delete_model(model.id)

    assert registry.resolve("chat") is None
    assert registry.bindings() == {}


def test_delete_provider_removes_its_models_and_unbinds(
    registry: ModelRegistryService, bundle
) -> None:  # type: ignore[no-untyped-def]
    """删供应商要连模型一起删——本项目连接没开 PRAGMA foreign_keys，级联不生效。"""
    provider = _provider(registry)
    model = _model(registry, provider.id, capabilities=["chat"])
    registry.bind("chat", model.id)

    registry.delete_provider(provider.id)

    assert registry.list_models() == []
    assert registry.resolve("chat") is None
    with pytest.raises(NotFoundError):
        registry.get_provider(provider.id)


def test_delete_provider_only_removes_its_own_models(registry: ModelRegistryService) -> None:
    first = _provider(registry, name="甲家")
    second = _provider(registry, name="乙家")
    _model(registry, first.id, model_id="a-model")
    kept = _model(registry, second.id, model_id="b-model")

    registry.delete_provider(first.id)

    assert [item.id for item in registry.list_models()] == [kept.id]


def test_dangling_binding_falls_back_instead_of_raising(
    registry: ModelRegistryService, bundle
) -> None:  # type: ignore[no-untyped-def]
    """绑定指向已不存在的模型时**回退而不是抛错**。

    这条路径正常操作走不到（删除时会解绑），但数据库被手工改过、
    或未来某条迁移出问题时会出现——那时让用户还能用，比整站报错好。
    """
    bundle.meta.set_setting("registry.slot.chat", "mdl_不存在")

    assert registry.resolve("chat") is None


# --------------------------------------------------------------------- 槽位定义


def test_slots_cover_the_three_model_uses() -> None:
    assert set(SLOTS) == {"chat", "embedding", "rerank"}
    for slot, spec in SLOTS.items():
        assert spec["label"], slot
        assert spec["capability"], slot
