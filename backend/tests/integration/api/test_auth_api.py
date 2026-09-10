"""鉴权的 HTTP 层行为（M4 T4.4）。

镜像同构：``app/api/auth.py`` + ``app/api/v1/api_keys.py`` →
``tests/integration/api/test_auth_api.py``。

**这份用例存在的首要理由**是外部监测报告指出的那条凭据窃取路径：
``PATCH /settings`` 无鉴权时，局域网内任何人把 ``embedding.base_url`` 改成自己的
服务器，下一次 embed 调用就会把 API Key 以 ``Authorization: Bearer`` 发过去。
所以"外部 API Key 进不了设置端点"必须有一条测试钉着，而不是只靠代码里的一句注释。
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.models.enums import ApiKeyPermission

CONSOLE = {"Authorization": "Bearer console-secret-token"}


@pytest.fixture
def app_client(monkeypatch):
    """默认关闭鉴权的客户端（本机开发口径）。"""
    from app.core.config import get_settings
    from app.main import create_app

    get_settings.cache_clear()
    with TestClient(create_app()) as test_client:
        yield test_client
    get_settings.cache_clear()


@pytest.fixture
def locked(monkeypatch):
    """启用鉴权并配一把控制台令牌的客户端。

    鉴权只在 ``Settings`` 上；用环境变量切最贴近真实部署方式，
    monkeypatch 会在用例结束后还原。
    """
    monkeypatch.setenv("KYLAB_AUTH_ENABLED", "true")
    monkeypatch.setenv("KYLAB_CONSOLE_TOKEN", "console-secret-token")

    from app.core.config import get_settings
    from app.main import create_app

    get_settings.cache_clear()
    with TestClient(create_app()) as test_client:
        yield test_client
    get_settings.cache_clear()


def _issue(client: TestClient, **overrides) -> dict:
    body = {
        "name": "给 Grafana 的只读钥匙",
        "permission": ApiKeyPermission.READONLY.value,
        "knowledge_base_ids": [],
    }
    body.update(overrides)
    response = client.post("/api/v1/api-keys", json=body, headers=CONSOLE)
    assert response.status_code == 201, response.text
    return response.json()


# --------------------------------------------------------------------- 默认口径


def test_local_development_needs_no_credentials(app_client: TestClient) -> None:
    """没配任何凭据时不该要求令牌。

    默认开启鉴权会让升级后所有既有客户端立刻 401，是最难排查的一类故障；
    而本机单人开发每次带令牌纯属折磨。
    """
    assert app_client.get("/api/v1/knowledge-bases").status_code == 200
    assert app_client.get("/api/v1/settings").status_code == 200


def test_health_stays_open_even_when_locked(locked: TestClient) -> None:
    """健康探针不鉴权：容器编排靠它判断存活，401 会让 readiness 误判。"""
    assert locked.get("/api/v1/health").status_code == 200


# --------------------------------------------------------------------- 缺凭据


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("get", "/api/v1/knowledge-bases"),
        ("get", "/api/v1/settings"),
        ("get", "/api/v1/tasks"),
        ("get", "/api/v1/stats/dashboard"),
    ],
)
def test_missing_credentials_are_rejected(locked: TestClient, method: str, path: str) -> None:
    response = getattr(locked, method)(path)
    assert response.status_code == 401
    assert response.json()["code"] == "unauthorized"
    # RFC 7235：401 要带 WWW-Authenticate，否则客户端不知道用哪种方案
    assert "WWW-Authenticate" in response.headers


def test_bad_token_is_rejected(locked: TestClient) -> None:
    # 用 ASCII：HTTP 头只能承载 latin-1，中文会先被 httpx 拒掉，测不到服务端行为
    response = locked.get(
        "/api/v1/knowledge-bases", headers={"Authorization": "Bearer not-a-real-key"}
    )
    assert response.status_code == 401


def test_non_bearer_scheme_is_rejected(locked: TestClient) -> None:
    response = locked.get("/api/v1/knowledge-bases", headers={"Authorization": "Basic xyz"})
    assert response.status_code == 401


# --------------------------------------------------------------------- 凭据窃取路径


def test_external_api_key_cannot_touch_settings(locked: TestClient) -> None:
    """**本文件最重要的一条**。

    外部 API Key 若能 PATCH /settings，就能把 base_url 指到自己的服务器上，
    下一次 embedding 调用就会把用户的 API Key 发过去。必须 403。

    同时验证"只要求读写权限是不够的"——这是一把 **readwrite** 密钥，
    仍然不能碰设置，说明拦它的是"必须是控制台身份"而不是权限档位。
    """
    issued = _issue(locked, permission=ApiKeyPermission.READWRITE.value)
    external = {"Authorization": f"Bearer {issued['token']}"}

    # 读设置也不行：设置响应里就是打码后的凭据与全部 base_url
    read = locked.get("/api/v1/settings", headers=external)
    assert read.status_code == 403, "外部密钥读到了设置页"

    write = locked.patch(
        "/api/v1/settings",
        json={"values": [{"key": "embedding.base_url", "value": "https://evil.test"}]},
        headers=external,
    )
    assert write.status_code == 403, "外部密钥改掉了 base_url —— 凭据窃取路径没封住"

    test_conn = locked.post("/api/v1/settings/test/embedding", headers=external)
    assert test_conn.status_code == 403


def test_api_key_cannot_self_issue(locked: TestClient) -> None:
    """能签发钥匙的接口如果也能被钥匙打开，一把只读密钥就能给自己发一把读写密钥。"""
    issued = _issue(locked)
    external = {"Authorization": f"Bearer {issued['token']}"}

    assert locked.get("/api/v1/api-keys", headers=external).status_code == 403
    assert (
        locked.post("/api/v1/api-keys", json={"name": "提权"}, headers=external).status_code == 403
    )
    assert locked.delete(f"/api/v1/api-keys/{issued['id']}", headers=external).status_code == 403


# --------------------------------------------------------------------- 权限档位


def test_readonly_key_cannot_create_knowledge_base(locked: TestClient) -> None:
    issued = _issue(locked, permission=ApiKeyPermission.READONLY.value)
    response = locked.post(
        "/api/v1/knowledge-bases",
        json={"name": "偷偷建的库"},
        headers={"Authorization": f"Bearer {issued['token']}"},
    )
    assert response.status_code == 403


def test_readonly_key_can_read(locked: TestClient) -> None:
    issued = _issue(locked)
    response = locked.get(
        "/api/v1/knowledge-bases", headers={"Authorization": f"Bearer {issued['token']}"}
    )
    assert response.status_code == 200


# --------------------------------------------------------------------- 作用域


def test_listing_only_shows_knowledge_bases_in_scope(locked: TestClient) -> None:
    """列表也要过滤：否则光看名字就能探出这台机器上有哪些库。"""
    locked.post("/api/v1/knowledge-bases", json={"name": "公开库"}, headers=CONSOLE)
    locked.post("/api/v1/knowledge-bases", json={"name": "机密库"}, headers=CONSOLE)

    all_kbs = locked.get("/api/v1/knowledge-bases", headers=CONSOLE).json()["items"]
    assert len(all_kbs) == 2
    target = next(kb for kb in all_kbs if kb["name"] == "公开库")

    issued = _issue(locked, knowledge_base_ids=[target["id"]])
    scoped = {"Authorization": f"Bearer {issued['token']}"}

    visible = locked.get("/api/v1/knowledge-bases", headers=scoped).json()["items"]
    assert [kb["name"] for kb in visible] == ["公开库"]


def test_scoped_key_cannot_read_another_kb(locked: TestClient) -> None:
    locked.post("/api/v1/knowledge-bases", json={"name": "公开库"}, headers=CONSOLE)
    locked.post("/api/v1/knowledge-bases", json={"name": "机密库"}, headers=CONSOLE)
    all_kbs = locked.get("/api/v1/knowledge-bases", headers=CONSOLE).json()["items"]
    public = next(kb for kb in all_kbs if kb["name"] == "公开库")
    secret = next(kb for kb in all_kbs if kb["name"] == "机密库")

    issued = _issue(locked, knowledge_base_ids=[public["id"]])
    scoped = {"Authorization": f"Bearer {issued['token']}"}

    assert locked.get(f"/api/v1/knowledge-bases/{public['id']}", headers=scoped).status_code == 200
    assert locked.get(f"/api/v1/knowledge-bases/{secret['id']}", headers=scoped).status_code == 403


def test_scoped_key_cannot_search_another_kb(locked: TestClient) -> None:
    """越界检索要 403。

    两个库都是**真实创建**的，不用编造的 id：若拿一个不存在的库去测，
    "被拒"可能是因为库不存在而不是因为越界——那样即使范围判定坏掉了，
    用例照样是绿的（我第一版就是这么写的，属于会骗人的测试）。
    """
    locked.post("/api/v1/knowledge-bases", json={"name": "公开库"}, headers=CONSOLE)
    locked.post("/api/v1/knowledge-bases", json={"name": "机密库"}, headers=CONSOLE)
    all_kbs = locked.get("/api/v1/knowledge-bases", headers=CONSOLE).json()["items"]
    public = next(kb["id"] for kb in all_kbs if kb["name"] == "公开库")
    secret = next(kb["id"] for kb in all_kbs if kb["name"] == "机密库")

    issued = _issue(locked, knowledge_base_ids=[public])
    scoped = {"Authorization": f"Bearer {issued['token']}"}

    allowed = locked.post(
        "/api/v1/search", json={"query": "任意", "kb_ids": [public]}, headers=scoped
    )
    assert allowed.status_code == 200

    blocked = locked.post(
        "/api/v1/search", json={"query": "任意", "kb_ids": [secret]}, headers=scoped
    )
    assert blocked.status_code == 403
    assert secret in blocked.json()["message"], "报错要点出是哪个库，用户才配得回来"


# --------------------------------------------------------------------- 明文只出现一次


def test_plaintext_token_only_in_creation_response(locked: TestClient) -> None:
    issued = _issue(locked)
    token = issued["token"]
    assert token.startswith("kylab_sk_")

    listing = locked.get("/api/v1/api-keys", headers=CONSOLE).json()["items"]
    assert len(listing) == 1

    # 列表里既没有明文也没有摘要，只有展示前缀
    assert token not in str(listing)
    assert "key_hash" not in listing[0]
    assert listing[0]["prefix"].startswith("kylab_sk_")
    assert len(listing[0]["prefix"]) < len(token)


def test_revoked_key_stops_working(locked: TestClient) -> None:
    issued = _issue(locked)
    scoped = {"Authorization": f"Bearer {issued['token']}"}
    assert locked.get("/api/v1/knowledge-bases", headers=scoped).status_code == 200

    assert locked.delete(f"/api/v1/api-keys/{issued['id']}", headers=CONSOLE).status_code == 204
    assert locked.get("/api/v1/knowledge-bases", headers=scoped).status_code == 401


def test_creating_a_key_turns_auth_on_automatically(monkeypatch, app_client: TestClient) -> None:
    """第二个自动生效条件：库里已有密钥，就该开始要求凭据。

    否则用户建了一把钥匙却忘了开开关，等于建了一扇不锁的门。
    """
    app_client.post(
        "/api/v1/api-keys",
        json={"name": "第一把", "permission": "readonly", "knowledge_base_ids": []},
    )
    # 下一次请求就该被拦（原来没配任何凭据时是放行的）
    assert app_client.get("/api/v1/knowledge-bases").status_code == 401


# --------------------------------------------------------------------- 首次初始化与控制台恢复


def test_bootstrap_is_open_when_no_token_exists(app_client: TestClient) -> None:
    status = app_client.get("/api/v1/auth/status")
    assert status.status_code == 200
    assert status.json()["needs_token"] is True


def test_bootstrap_closes_after_setting(app_client: TestClient) -> None:
    first = app_client.post("/api/v1/auth/console-token", json={})
    assert first.status_code == 200
    token = first.json()["token"]

    # 入口随即关闭：再调一次是状态冲突，不是权限问题
    again = app_client.post("/api/v1/auth/console-token", json={})
    assert again.status_code == 409

    assert app_client.get("/api/v1/auth/status").json()["needs_token"] is False
    # 新令牌立刻可用，且控制台身份不受库范围限制
    assert (
        app_client.get("/api/v1/settings", headers={"Authorization": f"Bearer {token}"}).status_code
        == 200
    )


def test_console_token_rescues_a_locked_out_instance(app_client: TestClient) -> None:
    """**这条复现的是实测踩到的死锁**。

    凭据关着的时候建一把 API Key → 鉴权自动生效 → 但设置页与密钥管理只认控制台令牌
    → 而令牌还没设过，于是把自己锁在门外，没有任何恢复途径。

    有了 ``POST /auth/console-token`` 就能救回来：它只在"两个来源都没有令牌"时开放。
    """
    # 1) 建一把密钥（此刻鉴权还没生效）
    app_client.post(
        "/api/v1/api-keys",
        json={"name": "把自己锁在门外的那把", "permission": "readwrite", "knowledge_base_ids": []},
    )

    # 2) 果然锁住了
    assert app_client.get("/api/v1/api-keys").status_code == 401
    assert app_client.get("/api/v1/knowledge-bases").status_code == 401

    # 3) 但初始化入口还开着，能救回来
    assert app_client.get("/api/v1/auth/status").json()["needs_token"] is True
    rescued = app_client.post("/api/v1/auth/console-token", json={})
    assert rescued.status_code == 200

    headers = {"Authorization": f"Bearer {rescued.json()['token']}"}
    assert app_client.get("/api/v1/api-keys", headers=headers).status_code == 200
    assert app_client.get("/api/v1/knowledge-bases", headers=headers).status_code == 200


def test_bootstrap_is_closed_when_env_token_exists(locked: TestClient) -> None:
    """.env 里配了令牌就不该再开放初始化入口——否则那是后门。"""
    assert locked.get("/api/v1/auth/status").json()["needs_token"] is False
    assert locked.post("/api/v1/auth/console-token", json={}).status_code == 409


def test_custom_console_token_is_accepted(app_client: TestClient) -> None:
    """允许自带令牌（有些人要用密码管理器里的固定值）。"""
    chosen = "my-own-long-console-token"
    assert app_client.post("/api/v1/auth/console-token", json={"token": chosen}).json()[
        "token"
    ] == chosen

    headers = {"Authorization": f"Bearer {chosen}"}
    assert app_client.get("/api/v1/settings", headers=headers).status_code == 200


def test_generated_console_token_is_long_and_prefixed(app_client: TestClient) -> None:
    token = app_client.post("/api/v1/auth/console-token", json={}).json()["token"]
    assert token.startswith("kylab_console_")
    assert len(token) > 40
