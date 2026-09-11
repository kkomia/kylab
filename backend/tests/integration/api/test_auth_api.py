"""鉴权的 HTTP 层行为（M4 T4.4；v0.11 起账号是唯一的管理员身份）。

镜像同构：``app/api/auth.py`` + ``app/api/v1/api_keys.py`` →
``tests/integration/api/test_auth_api.py``。

**这份用例存在的首要理由**是外部监测报告指出的那条凭据窃取路径：
``PATCH /settings`` 若能由外部密钥调用，局域网内任何人就能把
``embedding.base_url`` 改成自己的服务器，下一次 embed 调用就会把 API Key
以 ``Authorization: Bearer`` 发过去。所以"外部 API Key 进不了设置端点"
必须有一条测试钉着，而不是只靠代码里的一句注释。

v0.11 起还有第二条契约：**鉴权永远生效**。没有控制台令牌，也没有
"还没配凭据所以先放行"——第一次打开时唯一能调的是 ``/auth/status`` 与
``/auth/setup``，其余一律 401。
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.models.enums import ApiKeyPermission
from tests.conftest import ADMIN_PASSWORD, ADMIN_USERNAME
from tests.conftest import admin_client as admin_session


@pytest.fixture
def app_client():
    """**没有任何凭据**的客户端：用于首次初始化与"缺凭据会被拒"两组用例。"""
    from app.core.config import get_settings
    from app.main import create_app

    get_settings.cache_clear()
    with TestClient(create_app()) as test_client:
        yield test_client
    get_settings.cache_clear()


@pytest.fixture
def locked():
    """已初始化管理员、请求自带会话凭据的客户端。

    名字沿用旧版（"鉴权锁上之后"）；现在**每个**实例都是锁上的，
    区别只在于有没有凭据。
    """
    with admin_session() as test_client:
        yield test_client


def _setup_admin(client: TestClient, **overrides) -> dict:
    body = {"username": ADMIN_USERNAME, "password": ADMIN_PASSWORD}
    body.update(overrides)
    response = client.post("/api/v1/auth/setup", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def _issue(client: TestClient, **overrides) -> dict:
    body = {
        "name": "给 Grafana 的只读钥匙",
        "permission": ApiKeyPermission.READONLY.value,
        "knowledge_base_ids": [],
    }
    body.update(overrides)
    response = client.post("/api/v1/api-keys", json=body)
    assert response.status_code == 201, response.text
    return response.json()


# --------------------------------------------------------------------- 默认口径



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
    ]
    )
def test_missing_credentials_are_rejected(
    app_client: TestClient, method: str, path: str
) -> None:
    """**没有凭据就是 401，初始化之前也一样**（v0.11 取消了"没配凭据就放行"）。

    用没有任何凭据的客户端：新实例上这些端点也必须先拒绝，
    否则"还没建账号"就等于"谁都能读写"。
    """
    response = getattr(app_client, method)(path)
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
    仍然不能碰设置，说明拦它的是"必须是管理员会话"而不是权限档位。
    """
    issued = _issue(locked, permission=ApiKeyPermission.READWRITE.value)
    external = {"Authorization": f"Bearer {issued['token']}"}

    # 读设置也不行：设置响应里就是打码后的凭据与全部 base_url
    read = locked.get("/api/v1/settings", headers=external)
    assert read.status_code == 403, "外部密钥读到了设置页"

    write = locked.patch(
        "/api/v1/settings",
        json={"values": [{"key": "embedding.base_url", "value": "https://evil.test"}]},
        headers=external
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
        headers={"Authorization": f"Bearer {issued['token']}"}
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
    locked.post("/api/v1/knowledge-bases", json={"name": "公开库"})
    locked.post("/api/v1/knowledge-bases", json={"name": "机密库"})

    all_kbs = locked.get("/api/v1/knowledge-bases").json()["items"]
    assert len(all_kbs) == 2
    target = next(kb for kb in all_kbs if kb["name"] == "公开库")

    issued = _issue(locked, knowledge_base_ids=[target["id"]])
    scoped = {"Authorization": f"Bearer {issued['token']}"}

    visible = locked.get("/api/v1/knowledge-bases", headers=scoped).json()["items"]
    assert [kb["name"] for kb in visible] == ["公开库"]


def test_scoped_key_cannot_read_another_kb(locked: TestClient) -> None:
    locked.post("/api/v1/knowledge-bases", json={"name": "公开库"})
    locked.post("/api/v1/knowledge-bases", json={"name": "机密库"})
    all_kbs = locked.get("/api/v1/knowledge-bases").json()["items"]
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
    locked.post("/api/v1/knowledge-bases", json={"name": "公开库"})
    locked.post("/api/v1/knowledge-bases", json={"name": "机密库"})
    all_kbs = locked.get("/api/v1/knowledge-bases").json()["items"]
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

    listing = locked.get("/api/v1/api-keys").json()["items"]
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

    assert locked.delete(f"/api/v1/api-keys/{issued['id']}").status_code == 204
    assert locked.get("/api/v1/knowledge-bases", headers=scoped).status_code == 401









# --------------------------------------------------------------------- 账号体系（v10）


def _setup_admin(client: TestClient, **overrides) -> dict:
    body = {"username": "admin", "password": "correct horse battery"}
    body.update(overrides)
    response = client.post("/api/v1/auth/setup", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def test_status_reports_needs_setup(app_client: TestClient) -> None:
    """前端据此决定显示"首次设置管理员"还是"登录"。"""
    assert app_client.get("/api/v1/auth/status").json()["needs_setup"] is True

    _setup_admin(app_client)

    assert app_client.get("/api/v1/auth/status").json()["needs_setup"] is False


def test_setup_then_login_then_me(app_client: TestClient) -> None:
    setup = _setup_admin(app_client, username="Admin", name="小又")
    assert setup["token"].startswith("kylab_st_")
    assert setup["user"]["role"] == "admin"
    # 用户名归一化为小写；显示名保留原样
    assert (setup["user"]["username"], setup["user"]["name"]) == ("admin", "小又")

    # 会话令牌立即可用，且管理员会话与控制台令牌同权（能进设置页）
    session = {"Authorization": f"Bearer {setup['token']}"}
    assert app_client.get("/api/v1/settings", headers=session).status_code == 200
    assert app_client.get("/api/v1/auth/me", headers=session).json()["username"] == "admin"

    # 退出后令牌作废
    assert app_client.post("/api/v1/auth/logout", headers=session).status_code == 204
    assert app_client.get("/api/v1/auth/me", headers=session).status_code == 401

    # 重新登录（大小写不敏感）
    login = app_client.post(
        "/api/v1/auth/login", json={"username": "ADMIN", "password": "correct horse battery"}
    )
    assert login.status_code == 200, login.text


def test_setup_is_one_shot_over_http(app_client: TestClient) -> None:
    _setup_admin(app_client)
    again = app_client.post(
        "/api/v1/auth/setup", json={"username": "second", "password": "another good password"}
    )
    assert again.status_code == 409


def test_login_rejects_wrong_password_with_uniform_message(app_client: TestClient) -> None:
    _setup_admin(app_client)

    wrong = app_client.post(
        "/api/v1/auth/login", json={"username": "admin", "password": "wrong-password"}
    )
    ghost = app_client.post(
        "/api/v1/auth/login", json={"username": "ghost", "password": "wrong-password"}
    )
    assert wrong.status_code == ghost.status_code == 401
    assert wrong.json()["message"] == ghost.json()["message"]



def test_change_password_over_http(app_client: TestClient) -> None:
    setup = _setup_admin(app_client)
    session = {"Authorization": f"Bearer {setup['token']}"}

    changed = app_client.post(
        "/api/v1/auth/password",
        json={"old_password": "correct horse battery", "new_password": "new-horse-battery"},
        headers=session
    )
    assert changed.status_code == 200, changed.text
    assert changed.json()["revoked_sessions"] == 0  # 只有这一条会话，没有别的可吊销

    # 当前会话仍然有效；旧口令已不能登录
    assert app_client.get("/api/v1/auth/me", headers=session).status_code == 200
    assert (
        app_client.post(
            "/api/v1/auth/login", json={"username": "admin", "password": "correct horse battery"}
        ).status_code
        == 401
    )



