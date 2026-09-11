"""设置端点（PATCH /settings）的可写键契约。

**为什么值得单测**：可写键的白名单必须与"运行时真正会读的键"完全一致。
这里曾经硬编码过一份副本，v0.8 把模型身份收进注册表后副本没跟着删——
于是 `llm.api_key` / `embedding.base_url` 这类键仍被接受、回"已保存"，
而运行时根本不读，属于**静默无效**。现在白名单从 `SETTING_GROUPS` 派生。
"""

from __future__ import annotations

from tests.conftest import admin_client as admin_session


def test_behavior_settings_can_be_written() -> None:
    """行为参数（批大小、温度、提示词…）仍可写。"""
    with admin_session() as client:
        response = client.patch(
            "/api/v1/settings",
            json={"values": [{"key": "embedding.batch_size", "value": "16"}]},
        )

    assert response.status_code == 200, response.text
    assert response.json() == {"updated": 1, "rejected": []}


def test_model_identity_keys_are_rejected() -> None:
    """模型身份键必须被**拒绝并回执**，而不是"保存成功"。

    这些键在 v0.8 之后由模型注册表承担；再接受就等于给一条写不动任何东西的假入口。
    返回 `rejected` 而不是静默忽略，是为了让拼错/过期键当场可见。
    """
    stale = [
        "llm.api_key",
        "llm.base_url",
        "llm.model_id",
        "embedding.api_key",
        "embedding.base_url",
        "embedding.model_id",
        "embedding.dim",
        "rerank.base_url",
    ]
    with admin_session() as client:
        response = client.patch(
            "/api/v1/settings",
            json={"values": [{"key": key, "value": "x"} for key in stale]},
        )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["updated"] == 0
    assert sorted(body["rejected"]) == sorted(stale)


def test_unknown_key_is_reported_not_silently_ignored() -> None:
    with admin_session() as client:
        response = client.patch(
            "/api/v1/settings", json={"values": [{"key": "nope.nope", "value": "1"}]}
        )

    assert response.json() == {"updated": 0, "rejected": ["nope.nope"]}


def test_settings_page_and_writable_keys_come_from_one_source() -> None:
    """设置页渲染的分组字段 = 可写键集合（两边同源，不可能漂）。"""
    from app.api.v1.settings import _KNOWN_KEYS
    from app.services.runtime_config import SETTING_GROUPS

    declared = {
        str(field["key"]) for group in SETTING_GROUPS.values() for field in group["fields"]
    }
    assert declared == _KNOWN_KEYS


def test_member_cannot_write_settings() -> None:
    """普通成员会话写设置应当 403。

    管理员身份只来自会话角色；设置页是 embedding / LLM 凭据的落点，
    而 base_url 可改——给了非管理员就等于给它一条转发凭据的路。
    """
    with admin_session() as client:
        created = client.post(
            "/api/v1/users",
            json={"name": "只读成员", "username": "settings-member", "password": "pw123456"},
        )
        assert created.status_code == 201, created.text
        login = client.post(
            "/api/v1/auth/login",
            json={"username": "settings-member", "password": "pw123456"},
        )
        assert login.status_code == 200, login.text
        token = login.json()["token"]
        response = client.patch(
            "/api/v1/settings",
            json={"values": [{"key": "embedding.batch_size", "value": "8"}]},
            headers={"Authorization": f"Bearer {token}"},
        )

    assert response.status_code == 403


def test_settings_view_is_admin_only() -> None:
    with admin_session() as client:
        assert client.get("/api/v1/settings").status_code == 200
