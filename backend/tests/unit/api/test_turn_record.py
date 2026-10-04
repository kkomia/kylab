r"""`POST /api/v1/chat/turns/record`（边车写回一轮）的五条契约。

**为什么专门盯 HTTP 路径**：这条端点原先注册成了 `/api/v1/turns/record` ✗ ——
这个模块的 `router` 是 `APIRouter(tags=["chat"])`（`chat.py:143`，**没有 prefix** ✗），
每条路径都自己写全 ✓，而这里漏了 `/chat` 那一段 ✗，于是边车、文档、所有人打的
`/api/v1/chat/turns/record` 全是 **404** ✓（隔壁那条是 `/chat/turns/{id}/live` ✓）。

"注册对了没有"这件事**只有 HTTP 判据可信** ✗：直接读 `router.routes` 会因为 cwd 不同
而 import 到**另一个 `app` 包**（实测过：日志被写到仓库根的 `data/logs/` ✗）——
读到的路径不是真正在服务的那个 ✗。所以这一整个文件都走 `TestClient` 打真实路径 ✓。

五条：正常写回 / 幂等 / 别人的会话 404 / 无令牌 401 / 缺 `turn_id` 422 ✓。
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.main import create_app

#: 被验的那条路径（**必须带 `/chat`** ✓ —— 少了它就是 404 那个 bug ✗）。
RECORD = "/api/v1/chat/turns/record"

#: 管理员账号：首次 `setup` 用它建，之后走登录（临时库里第一次都走 setup ✓）。
ADMIN_USERNAME = "admin"
ADMIN_PASSWORD = "admin-password-1"


@pytest.fixture
def admin_client() -> Iterator[TestClient]:
    """带**管理员**会话凭据的客户端 ✓（跑完整 lifespan ✓）。

    为什么自己起而不是用 `tests/conftest.py` 里那个 `admin_client`：那个是
    `@contextmanager` **辅助函数**（`conftest.py:82` ✓），不是 pytest 夹具 ✗ ——
    当夹具名用会直接报"fixture not found" ✓（这一版就是这么撞出来的 ✓）。
    """
    with TestClient(create_app()) as client:
        response = client.post(
            "/api/v1/auth/setup",
            json={"username": ADMIN_USERNAME, "password": ADMIN_PASSWORD, "name": "管理员"},
        )
        if response.status_code == 409:
            # 这个临时库里管理员已经建过（同一次会话里的第二条用例 ✓）→ 改成登录
            response = client.post(
                "/api/v1/auth/login",
                json={"username": ADMIN_USERNAME, "password": ADMIN_PASSWORD},
            )
        assert response.status_code == 200, response.text
        client.headers["Authorization"] = f"Bearer {response.json()['token']}"
        yield client


@pytest.fixture
def anonymous_client() -> Iterator[TestClient]:
    """**不带任何凭据**的客户端 ✓（只给"无令牌 → 401"那条用 ✓）。"""
    with TestClient(create_app()) as client:
        yield client


def _new_conversation(client: TestClient) -> str:
    """开一条空会话（管理员建的：`owner_id=None` ✓，后面那条 404 正好用它）。"""
    response = client.post("/api/v1/conversations", json={})
    assert response.status_code == 201, response.text
    return str(response.json()["id"])


def _detail(client: TestClient, conversation_id: str) -> dict[str, Any]:
    response = client.get(f"/api/v1/conversations/{conversation_id}")
    assert response.status_code == 200, response.text
    return dict(response.json())


def _member_token(client: TestClient, *, username: str, password: str) -> str:
    """开一个成员账号并换一条**它的**会话令牌 ✓（用来验"别人的会话 → 404"）。

    账号由管理员开（`POST /users` 要管理员档 ✓），令牌走正常登录 ✓ ——
    不手工造 `Caller`：所有权过滤看的就是令牌解出来的那个人 ✓。
    """
    created = client.post(
        "/api/v1/users",
        json={"name": username, "username": username, "password": password, "role": "member"},
    )
    assert created.status_code == 201, created.text
    login = client.post("/api/v1/auth/login", json={"username": username, "password": password})
    assert login.status_code == 200, login.text
    return str(login.json()["token"])


def test_a_turn_is_recorded_with_its_two_messages(admin_client: TestClient) -> None:
    """正常写回：`recorded=true` ✓、**问与答两条都进库** ✓、标题按首问生成 ✓。

    为什么钉"两条消息"而不是只看返回值：这条端点的意义就是把**边车在本机跑完的一轮**
    变成服务器上正常的会话内容 ✗ —— 只写了一条（或一条都没写）而返回 `recorded=true`，
    界面上就是"这一轮凭空少了一半"，而前端刷新之后再也补不回来 ✓。
    """
    conversation = _new_conversation(admin_client)

    response = admin_client.post(
        RECORD,
        json={
            "conversation_id": conversation,
            "turn_id": "turn-1",
            "question": "一加一等于几",
            "answer": "等于二。",
        },
    )

    assert response.status_code == 200, response.text
    assert response.json() == {
        "conversation_id": conversation,
        "turn_id": "turn-1",
        "recorded": True,
    }
    detail = _detail(admin_client, conversation)
    assert [item["role"] for item in detail["messages"]] == ["user", "assistant"]
    assert detail["messages"][0]["content"] == "一加一等于几"
    assert detail["messages"][1]["content"] == "等于二。"
    assert detail["message_count"] == 2
    # 标题按**首问**生成（`ensure_title` ✓）；问句里没有礼貌引导词，所以开头那几字在标题里
    assert "一加一" in detail["title"]


def test_the_same_turn_id_twice_records_only_once(admin_client: TestClient) -> None:
    """幂等：同一个 `turn_id` 报两次 → 第二次 `recorded=false` ✓ 且**轮次数不变** ✗。

    为什么用"消息条数不变"当判据而不只看 `recorded` 那个布尔值：边车重试、网络重发
    都是常态 ✓，而这条端点一旦重复插，用户回看时看到的是**同一轮问答出现两遍** ✗
    （消息是真的多写了两条，`recorded=false` 也救不回来 ✓）。
    """
    conversation = _new_conversation(admin_client)
    body = {
        "conversation_id": conversation,
        "turn_id": "turn-same",
        "question": "同一轮",
        "answer": "只落一次",
    }

    first = admin_client.post(RECORD, json=body)
    second = admin_client.post(RECORD, json=body)

    assert first.status_code == 200 and first.json()["recorded"] is True, first.text
    # **幂等命中不是失败** ✓：照样 200，只是 `recorded=false` ✓
    assert second.status_code == 200, second.text
    assert second.json()["recorded"] is False
    assert _detail(admin_client, conversation)["message_count"] == 2


def test_memory_is_asked_only_after_a_real_record(
    admin_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """长期记忆**只在真的写进去之后**被叫一次 ✓，幂等命中不叫 ✗。

    为什么单独钉这一条：边车写回的轮次与人在网页里问的那一轮在库里长得一模一样 ✓，
    不在这里接一下 ✗，这些轮次就**永远不进长期记忆** ✗ —— 而"记忆里少了边车那几轮"
    是用户事后才发现、且补不回来的那类丢失 ✓。反过来，幂等命中再叫一次 ✗
    等于同一轮重复判一次（`_capture_implicit` 自己只认信号词与服务层开关、
    不做跨轮去重 ✓，见 `chat.py` 那个函数的说明）——所以「只在成功那一次叫」必须钉住 ✓。

    默认档下隐式捕获是**关**的 ✓（`memory.capture`），所以这里用替身看"叫没叫" ✓，
    不去真的落一条记忆 ✗。
    """
    import app.api.v1.chat as chat_module

    calls: list[str] = []

    def _spy(services: Any, query: str, *, caller: Any) -> None:
        _ = services, caller
        calls.append(query)

    monkeypatch.setattr(chat_module, "_capture_implicit", _spy)
    conversation = _new_conversation(admin_client)
    body = {
        "conversation_id": conversation,
        "turn_id": "turn-memory",
        "question": "这一轮要沉淀",
        "answer": "记一笔",
    }

    first = admin_client.post(RECORD, json=body)
    assert first.status_code == 200 and first.json()["recorded"] is True, first.text
    assert calls == ["这一轮要沉淀"], "落库成功之后应当叫一次，把这一轮的问句交给它"

    second = admin_client.post(RECORD, json=body)
    assert second.json()["recorded"] is False
    assert calls == ["这一轮要沉淀"], "幂等命中不该再叫一次"


def test_a_conversation_that_is_not_yours_is_a_404(admin_client: TestClient) -> None:
    """别人的会话 → **404** ✓（不是 403 ✗）：对话内容是私有数据，403 会把会话 id
    变成"存在性探针" ✓（与 `conversations._get_visible` 同口径 ✓）。

    这里用**成员令牌**打管理员建的那条会话（`owner_id=None` ✗）——所有权过滤看的是
    令牌解出来的人 ✓，所以这条正是"别人的会话" ✓。
    """
    conversation = _new_conversation(admin_client)
    member = _member_token(admin_client, username="record_member_a", password="pw-member-a")

    response = admin_client.post(
        RECORD,
        json={
            "conversation_id": conversation,
            "turn_id": "turn-other",
            "question": "别人的会话",
            "answer": "不该写进去",
        },
        headers={"Authorization": f"Bearer {member}"},
    )

    assert response.status_code == 404, response.text
    # 而且**真的没写进去** ✗：404 不能只是"回了个 404、库里却多了一条"
    assert _detail(admin_client, conversation)["message_count"] == 0


def test_no_token_is_a_401(anonymous_client: TestClient) -> None:
    """无令牌 → **401** ✓（不是 404 ✗、也不是 500 ✗）。

    这条与"路径对不对"是一对：404 既可能是"没有这条路由"也可能是"路由在、前面挡掉了" ✓。
    裸 `TestClient`（不带凭据 ✓）打同一个路径拿到 401 ✓，说明**路由在**、且鉴权在它前面生效 ✓。
    """
    response = anonymous_client.post(
        RECORD,
        json={"conversation_id": "conv_whatever", "turn_id": "t", "question": "在吗"},
    )

    assert response.status_code == 401, response.text


def test_a_missing_turn_id_is_a_422(admin_client: TestClient) -> None:
    """缺 `turn_id` → **422** ✓（必填那条在 `TurnRecordIn` 里 ✓）。

    幂等键是这个端点的**唯一**去重依据 ✗：允许它缺省等于"每次上报都算新的一轮" ✗，
    而边车重试时重复的就是同一轮 → 校验层挡住（422）比事后补救便宜 ✓。
    """
    conversation = _new_conversation(admin_client)

    response = admin_client.post(
        RECORD, json={"conversation_id": conversation, "question": "缺幂等键"}
    )

    assert response.status_code == 422, response.text
    assert _detail(admin_client, conversation)["message_count"] == 0
