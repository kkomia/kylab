"""模型注册器的 HTTP 行为（G1）。

镜像同构：``app/api/v1/model_registry.py`` → 本文件。

服务层的性质（叠加、级联解绑、能力校验）已在
``tests/unit/services/test_model_registry.py`` 与 ``test_registry_bridge.py`` 覆盖；
这里验的是接进接口之后仍然成立，以及**凭据不外泄**这条硬纪律。
"""

from __future__ import annotations

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

CONSOLE = "console-token-for-registry"
SECRET = "sk-super-secret-value-12345"


@pytest.fixture
def client():
    from app.main import create_app

    with TestClient(create_app()) as test_client:
        yield test_client


def _provider(client: TestClient, **overrides) -> dict:  # type: ignore[no-untyped-def]
    payload = {
        "kind": "llm",
        "name": "深度求索",
        "base_url": "https://api.deepseek.com",
        "api_key": SECRET,
    }
    payload.update(overrides)
    response = client.post("/api/v1/model-registry/providers", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def _model(client: TestClient, provider_id: str, **overrides) -> dict:  # type: ignore[no-untyped-def]
    payload = {
        "provider_id": provider_id,
        "model_id": "deepseek-chat",
        "label": "对话主力",
        "capabilities": ["chat"],
    }
    payload.update(overrides)
    response = client.post("/api/v1/model-registry/models", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


# --------------------------------------------------------------------- 供应商


def test_create_and_list_providers(client: TestClient) -> None:
    created = _provider(client)

    assert created["name"] == "深度求索"
    assert created["kind"] == "llm"
    assert created["api_key_configured"] is True
    assert created["model_count"] == 0

    listed = client.get("/api/v1/model-registry/providers").json()["items"]
    assert [item["id"] for item in listed] == [created["id"]]


def test_api_key_never_leaves_the_server(client: TestClient) -> None:
    """**凭据纪律：只回"配没配"和一个掩码尾巴，绝不回密钥本身。**

    这条必须有测试：模型注册器是新的密钥落点，一旦漏了，
    密钥就会出现在前端状态、浏览器缓存、以及任何人随手截的图里。
    """
    created = _provider(client)

    body = client.get("/api/v1/model-registry/providers").text
    assert SECRET not in body
    assert created["api_key_hint"], "至少要给个掩码尾巴让用户认出是哪一把"
    assert SECRET not in created["api_key_hint"]


def test_registry_overview_never_leaks_the_key(client: TestClient) -> None:
    provider = _provider(client)
    _model(client, provider["id"])

    assert SECRET not in client.get("/api/v1/model-registry").text


def test_update_provider_without_key_keeps_it(client: TestClient) -> None:
    """**回传掩码不能把密钥覆盖掉**——设置页就是回传掩码的。"""
    provider = _provider(client)

    client.patch(
        f"/api/v1/model-registry/providers/{provider['id']}", json={"name": "改了个名字"}
    )

    after = client.patch(
        f"/api/v1/model-registry/providers/{provider['id']}",
        json={"name": "又改一次", "api_key": provider["api_key_hint"]},
    ).json()
    # 即便前端把掩码原样回传，也不该把真实密钥变成掩码
    assert after["api_key_configured"] is True
    assert SECRET not in client.get("/api/v1/model-registry/providers").text


def test_delete_provider(client: TestClient) -> None:
    provider = _provider(client)
    assert client.delete(f"/api/v1/model-registry/providers/{provider['id']}").status_code == 204
    assert client.get("/api/v1/model-registry/providers").json()["items"] == []


def test_unknown_provider_is_404(client: TestClient) -> None:
    assert client.get("/api/v1/model-registry/providers").status_code == 200
    response = client.patch(
        "/api/v1/model-registry/providers/prov_不存在", json={"name": "x"}
    )
    assert response.status_code == 404


# --------------------------------------------------------------------- 模型


def test_register_and_list_models(client: TestClient) -> None:
    provider = _provider(client)
    created = _model(client, provider["id"])

    assert created["provider_name"] == "深度求索"
    assert created["provider_kind"] == "llm"
    assert created["capabilities"] == ["chat"]
    assert created["bound_slots"] == []

    # 供应商的模型计数要跟着变
    listed = client.get("/api/v1/model-registry/providers").json()["items"]
    assert listed[0]["model_count"] == 1


def test_duplicate_model_is_409(client: TestClient) -> None:
    provider = _provider(client)
    _model(client, provider["id"])
    response = client.post(
        "/api/v1/model-registry/models",
        json={"provider_id": provider["id"], "model_id": "deepseek-chat"},
    )
    assert response.status_code == 409


def test_delete_provider_removes_models(client: TestClient) -> None:
    provider = _provider(client)
    _model(client, provider["id"])

    client.delete(f"/api/v1/model-registry/providers/{provider['id']}")

    assert client.get("/api/v1/model-registry/models").json()["items"] == []


# --------------------------------------------------------------------- 用途绑定


def test_slots_reflect_the_settings_page_source(client: TestClient) -> None:
    """**没绑定任何模型时，用途来源应当是 ``settings`` 或 ``none``。**

    这是"叠加层"在界面上的体现：用户得看得出当前生效的是哪一套，
    否则会疑惑"我在设置页填了，为什么还提示要绑定"。
    """
    slots = client.get("/api/v1/model-registry/slots").json()
    by_slot = {item["slot"]: item for item in slots}
    assert set(by_slot) == {"chat", "embedding", "rerank"}
    for item in slots:
        assert item["source"] in ("settings", "none")
        assert item["bound_model_pk"] is None


def test_bind_slot_and_see_it_as_registry_sourced(client: TestClient) -> None:
    provider = _provider(client)
    model = _model(client, provider["id"])

    bound = client.put(
        "/api/v1/model-registry/slots/chat", json={"model_pk": model["id"]}
    ).json()

    assert bound["source"] == "registry"
    assert bound["bound_model_pk"] == model["id"]
    assert bound["configured"] is True
    assert bound["bound_model_label"] == "对话主力"

    # 模型那边也要显示它正被哪个用途用着
    models = client.get("/api/v1/model-registry/models").json()["items"]
    assert models[0]["bound_slots"] == ["chat"]


def test_unbind_falls_back_to_settings(client: TestClient) -> None:
    provider = _provider(client)
    model = _model(client, provider["id"])
    client.put("/api/v1/model-registry/slots/chat", json={"model_pk": model["id"]})

    after = client.put("/api/v1/model-registry/slots/chat", json={"model_pk": None}).json()

    assert after["bound_model_pk"] is None
    assert after["source"] in ("settings", "none")


def test_binding_a_wrong_capability_is_rejected(client: TestClient) -> None:
    provider = _provider(client, kind="embedding", name="向量家")
    model = _model(client, provider["id"], model_id="bge-m3", capabilities=["embedding"])

    response = client.put("/api/v1/model-registry/slots/chat", json={"model_pk": model["id"]})

    assert response.status_code == 422
    assert "未声明" in response.json()["message"]


def test_unbinding_happens_when_the_model_is_deleted(client: TestClient) -> None:
    """删模型要连带解绑，否则之后每次对话都报"绑定的模型不存在"。"""
    provider = _provider(client)
    model = _model(client, provider["id"])
    client.put("/api/v1/model-registry/slots/chat", json={"model_pk": model["id"]})

    client.delete(f"/api/v1/model-registry/models/{model['id']}")

    slots = {item["slot"]: item for item in client.get("/api/v1/model-registry/slots").json()}
    assert slots["chat"]["bound_model_pk"] is None


# --------------------------------------------------------------------- 总览


def test_overview_returns_everything_in_one_call(client: TestClient) -> None:
    """设置页一打开就要这三份数据；分三次请求会做出"半成品界面"。"""
    provider = _provider(client)
    _model(client, provider["id"])

    body = client.get("/api/v1/model-registry").json()

    assert len(body["providers"]) == 1
    assert len(body["models"]) == 1
    assert len(body["slots"]) == 3
    # 类别与能力的可选值也一起给：前端不必硬编码一份会漂的清单
    assert "llm" in body["provider_kinds"]
    assert "chat" in body["capabilities"]


# --------------------------------------------------------------------- 鉴权


def test_registry_requires_console_token_for_writes(monkeypatch) -> None:
    """**凭据管理只认控制台令牌**：普通 API Key 不该能读写模型凭据，
    否则一把泄露的读写密钥就能把所有人的模型指向别处。"""
    monkeypatch.setenv("KYLAB_AUTH_ENABLED", "true")
    monkeypatch.setenv("KYLAB_CONSOLE_TOKEN", CONSOLE)

    from app.core.config import get_settings
    from app.main import create_app

    get_settings.cache_clear()
    with TestClient(create_app()) as client:
        # 未鉴权
        assert client.get("/api/v1/model-registry/providers").status_code == 401

        console = {"Authorization": f"Bearer {CONSOLE}"}
        provider = client.post(
            "/api/v1/model-registry/providers",
            json={"kind": "llm", "name": "甲", "base_url": "https://a.example.com", "api_key": "k"},
            headers=console,
        )
        assert provider.status_code == 201, provider.text

        issued = client.post(
            "/api/v1/api-keys",
            json={"name": "读写", "permission": "readwrite", "knowledge_base_ids": []},
            headers=console,
        ).json()
        apikey = {"Authorization": f"Bearer {issued['token']}"}

        # 读：普通密钥可以（界面要显示有哪些模型）
        assert client.get("/api/v1/model-registry", headers=apikey).status_code == 200
        # 写：不行
        assert (
            client.post(
                "/api/v1/model-registry/providers",
                json={"kind": "llm", "name": "乙"},
                headers=apikey,
            ).status_code
            == 403
        )
        assert (
            client.patch(
                f"/api/v1/model-registry/providers/{provider.json()['id']}",
                json={"name": "偷改"},
                headers=apikey,
            ).status_code
            == 403
        )
        assert (
            client.delete(
                f"/api/v1/model-registry/providers/{provider.json()['id']}", headers=apikey
            ).status_code
            == 403
        )
    get_settings.cache_clear()


# --------------------------------------------------------------------- 供应商探活


@respx.mock
def test_test_provider_endpoint_reports_success(client: TestClient) -> None:
    """注册环节的验活：``GET {base_url}/models`` 不计费，只验地址与凭据。"""
    provider = _provider(client)
    route = respx.get("https://api.deepseek.com/models").mock(
        return_value=httpx.Response(200, json={"data": [{"id": "deepseek-chat"}]})
    )

    response = client.post(f"/api/v1/model-registry/providers/{provider['id']}/test")

    assert response.status_code == 200, response.text
    assert route.called
    assert "1 个模型" in response.json()["detail"]


@respx.mock
def test_test_provider_endpoint_maps_bad_key(client: TestClient) -> None:
    """凭据无效走 InvalidRequestError（422），文案要说清是 Key 的问题。"""
    provider = _provider(client)
    respx.get("https://api.deepseek.com/models").mock(return_value=httpx.Response(401))

    response = client.post(f"/api/v1/model-registry/providers/{provider['id']}/test")

    assert response.status_code == 422
    assert "API Key" in response.json()["message"]


def test_test_provider_endpoint_hides_the_key(client: TestClient) -> None:
    """失败文案里绝不能带出真实密钥（错误信封会进日志与截图）。"""
    provider = _provider(client)
    with respx.mock:
        respx.get("https://api.deepseek.com/models").mock(return_value=httpx.Response(500))
        response = client.post(f"/api/v1/model-registry/providers/{provider['id']}/test")

    assert SECRET not in response.text
