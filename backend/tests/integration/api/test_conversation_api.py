"""对话留存的 HTTP 行为（§11.2）。

镜像同构：``app/api/v1/conversations.py`` + `/chat` 的落库分支 → 本文件。

这里要证的是"端到端真的存下来了"：问一轮 → 会话里能查到那两条消息；
再问一轮 → 历史带上上一轮。以及改名、删除、越权。
"""

from __future__ import annotations

import io

import pytest
from fastapi.testclient import TestClient

from app.core.services import get_services
from tests.conftest import admin_client as admin_session
from tests.conftest import bind_model

KB_NAME = "对话留存测试库"


class FakeChat:
    """假的对话模型：不打网络，专注测落库。"""

    def __init__(self, answer: str = "这是回答。[1]") -> None:
        self.answer = answer

    def complete(self, messages):  # type: ignore[no-untyped-def]
        return self.answer

    def stream(self, messages):  # type: ignore[no-untyped-def]
        yield from self.answer


@pytest.fixture(autouse=True)
def fake_llm():
    """把对话模型换成假的并配好 llm。

    否则 `/chat` 会先报「尚未配置对话模型」502——那样测的就成了错误映射，
    而不是我们关心的落库行为。
    """
    from app.core.services import get_services

    services = get_services()
    bind_model(services.models, "chat", model_id="fake-model", capabilities=["chat"])
    services.chat._chat_factory = lambda config: FakeChat()
    yield


@pytest.fixture
def client():
    """带管理员会话凭据的客户端（v0.11 起 /api/v1 一律要凭据）。"""
    with admin_session() as test_client:

        yield test_client



@pytest.fixture
def kb_id(client: TestClient) -> str:
    return client.post("/api/v1/knowledge-bases", json={"name": KB_NAME}).json()["id"]


def _conversation(client: TestClient, kb_id: str) -> str:
    response = client.post("/api/v1/conversations", json={"kb_ids": [kb_id]})
    assert response.status_code == 201, response.text
    return response.json()["id"]


# --------------------------------------------------------------------- CRUD


def test_create_lists_and_deletes(client: TestClient, kb_id: str) -> None:
    conv_id = _conversation(client, kb_id)

    listing = client.get("/api/v1/conversations").json()["items"]
    assert [item["id"] for item in listing] == [conv_id]
    assert listing[0]["message_count"] == 0

    assert client.delete(f"/api/v1/conversations/{conv_id}").status_code == 204
    assert client.get("/api/v1/conversations").json()["items"] == []


def test_rename(client: TestClient, kb_id: str) -> None:
    conv_id = _conversation(client, kb_id)

    response = client.patch(
        f"/api/v1/conversations/{conv_id}", json={"title": "眼科问题汇总"}
    )

    assert response.status_code == 200
    assert response.json()["title"] == "眼科问题汇总"
    assert client.get(f"/api/v1/conversations/{conv_id}").json()["title"] == "眼科问题汇总"


def test_rename_rejects_empty_title(client: TestClient, kb_id: str) -> None:
    conv_id = _conversation(client, kb_id)
    response = client.patch(f"/api/v1/conversations/{conv_id}", json={"title": ""})
    assert response.status_code == 422  # 参数校验挡在业务之前


def test_unknown_conversation_is_404(client: TestClient) -> None:
    assert client.get("/api/v1/conversations/conv_不存在").status_code == 404
    assert client.delete("/api/v1/conversations/conv_不存在").status_code == 404


def test_detail_returns_messages(client: TestClient, kb_id: str) -> None:
    conv_id = _conversation(client, kb_id)
    services = get_services()
    services.conversations.append(conv_id, role="user", content="近视怎么监测")
    services.conversations.append(conv_id, role="assistant", content="看眼轴长度")

    detail = client.get(f"/api/v1/conversations/{conv_id}").json()

    assert [m["role"] for m in detail["messages"]] == ["user", "assistant"]
    assert detail["message_count"] == 2


# --------------------------------------------------------------------- 落库


def test_chat_persists_the_turn(client: TestClient, kb_id: str) -> None:
    """指定 conversation_id 之后，提问与回答都要落库。"""
    conv_id = _conversation(client, kb_id)

    response = client.post(
        "/api/v1/chat",
        json={"query": "这个库里有什么", "kb_ids": [kb_id], "conversation_id": conv_id}
    )
    assert response.status_code == 200, response.text

    detail = client.get(f"/api/v1/conversations/{conv_id}").json()
    assert [m["role"] for m in detail["messages"]] == ["user", "assistant"]
    assert detail["messages"][0]["content"] == "这个库里有什么"


def test_chat_without_conversation_does_not_persist(client: TestClient, kb_id: str) -> None:
    """不指定会话时保持原来的无状态行为——脚本与 MCP 调用不该留下垃圾会话。"""
    response = client.post(
        "/api/v1/chat", json={"query": "随便问问", "kb_ids": [kb_id]}
    )
    assert response.status_code == 200
    assert client.get("/api/v1/conversations").json()["items"] == []


def test_title_is_generated_from_the_first_question(client: TestClient, kb_id: str) -> None:
    conv_id = _conversation(client, kb_id)

    client.post(
        "/api/v1/chat",
        json={"query": "近视怎么监测眼轴", "kb_ids": [kb_id], "conversation_id": conv_id}
    )

    assert client.get(f"/api/v1/conversations/{conv_id}").json()["title"] == "近视怎么监测眼轴"


def test_chat_with_unknown_conversation_is_404(client: TestClient, kb_id: str) -> None:
    """**指了会话就必须存在**，不做"静默新建"。

    静默新建的后果是：用户拼错一个 id，会得到一次正常回答，然后发现历史没存上——
    而落库失败本身是静默的，两次静默叠起来根本无法排查。
    校验放在流开始之前，所以流式那条路径也能正常回 404。
    """
    for path in ("/api/v1/chat", "/api/v1/chat/stream"):
        response = client.post(
            path,
            json={"query": "问一句", "kb_ids": [kb_id], "conversation_id": "conv_不存在"}
    )
        assert response.status_code == 404, path


def test_history_comes_from_the_database_not_the_request(
    client: TestClient, kb_id: str
) -> None:
    """**带 conversation_id 时以库里的记录为准**，忽略请求里带的 history。

    两处都算会让同一轮被计两遍；而且刷新后前端那份就没了，行为会时好时坏。
    """
    conv_id = _conversation(client, kb_id)
    services = get_services()
    services.conversations.append(conv_id, role="user", content="库里的问题")
    services.conversations.append(conv_id, role="assistant", content="库里的回答")

    seen: dict = {}
    real = services.chat.answer

    def spy(  # type: ignore[no-untyped-def]
        *, query, sources, history=None, system_prompt=None, model_pk=None,
        thinking=None, thinking_effort=None,
    ):
        seen["history"] = [(item.role, item.content) for item in (history or [])]
        return real(
            query=query,
            sources=sources,
            history=history,
            system_prompt=system_prompt,
            model_pk=model_pk,
            thinking=thinking,
            thinking_effort=thinking_effort,
        )

    services.chat.answer = spy  # type: ignore[method-assign]
    try:
        client.post(
            "/api/v1/chat",
            json={
                "query": "继续问",
                "kb_ids": [kb_id],
                "conversation_id": conv_id,
                # 故意带一份"假"历史：它应当被忽略
                "history": [{"role": "user", "content": "请求里塞的假历史"}],
            }
    )
    finally:
        services.chat.answer = real  # type: ignore[method-assign]

    assert ("user", "库里的问题") in seen["history"]
    assert not any("假历史" in content for _, content in seen["history"])


def test_stream_also_persists(client: TestClient, kb_id: str) -> None:
    """流式那条路径同样要落库——它是前端的默认路径，漏了等于功能没做。"""
    conv_id = _conversation(client, kb_id)

    with client.stream(
        "POST",
        "/api/v1/chat/stream",
        json={"query": "流式落库测试", "kb_ids": [kb_id], "conversation_id": conv_id}
    ) as response:
        assert response.status_code == 200
        body = "".join(response.iter_text())

    assert '"type": "done"' in body
    detail = client.get(f"/api/v1/conversations/{conv_id}").json()
    assert [m["role"] for m in detail["messages"]] == ["user", "assistant"]


# --------------------------------------------------------------------- 鉴权


def test_conversations_need_credentials() -> None:
    """没有凭据就是 401（v0.11 起鉴权永远生效）。刻意用不带会话的客户端。"""
    from app.main import create_app

    with TestClient(create_app()) as anonymous:
        assert anonymous.get("/api/v1/conversations").status_code == 401


def test_readonly_key_can_read_but_not_delete(client: TestClient) -> None:
    """历史对话属于内容本身，只读密钥可以回看；删除是写操作。"""
    console = dict(client.headers)  # 管理员会话
    kb = client.post("/api/v1/knowledge-bases", json={"name": "鉴权库"}, headers=console)
    conv = client.post(
        "/api/v1/conversations", json={"kb_ids": [kb.json()["id"]]}, headers=console
    )
    issued = client.post(
        "/api/v1/api-keys",
        json={"name": "只读", "permission": "readonly", "knowledge_base_ids": []},
        headers=console
    ).json()
    readonly = {"Authorization": f"Bearer {issued['token']}"}

    conv_path = f"/api/v1/conversations/{conv.json()['id']}"
    assert client.get("/api/v1/conversations", headers=readonly).status_code == 200
    assert client.get(conv_path, headers=readonly).status_code == 200
    assert client.delete(conv_path, headers=readonly).status_code == 403
    assert (
        client.post("/api/v1/conversations", json={"kb_ids": []}, headers=readonly).status_code
        == 403
    )

def test_markdown_upload_placeholder(client: TestClient, kb_id: str) -> None:
    """顺带确认：文档相关接口没有被这次改动影响。"""
    upload = client.post(
        f"/api/v1/knowledge-bases/{kb_id}/documents",
        files={"file": ("a.md", io.BytesIO("# 标题\n".encode()), "text/markdown")},
        params={"start": "false"}
    )
    assert upload.status_code == 202


# --------------------------------------------------------------------- 会话级模型（v12）


def test_conversation_remembers_the_chosen_model(client: TestClient, kb_id: str) -> None:
    """建会话时选的模型要能读回来（列表与详情都带上）——界面靠它回填选择器。"""
    created = client.post(
        "/api/v1/conversations", json={"kb_ids": [kb_id], "model_pk": "mdl_pick"}
    ).json()

    assert created["model_pk"] == "mdl_pick"
    assert (
        client.get(f"/api/v1/conversations/{created['id']}").json()["model_pk"] == "mdl_pick"
    )
    listed = client.get("/api/v1/conversations").json()["items"]
    assert [item["model_pk"] for item in listed if item["id"] == created["id"]] == ["mdl_pick"]


def test_conversation_without_model_pk_stays_none(client: TestClient, kb_id: str) -> None:
    """没选就是 None（跟随全局默认），不落一个被猜出来的模型。"""
    created = client.post("/api/v1/conversations", json={"kb_ids": [kb_id]}).json()
    assert created["model_pk"] is None


def test_chat_records_the_chosen_model_on_the_conversation(
    client: TestClient, kb_id: str
) -> None:
    """在已有会话上用另一个模型提问，该会话应当记住新选择（v12"跟随会话保存"）。"""
    services = get_services()
    provider = services.models.create_provider(
        kind="llm", name="切换家", base_url="https://switch.example.com/v1", api_key="sk-s"
    )
    model = services.models.register_model(
        provider_id=provider.id, model_id="m-switch", capabilities=["chat"]
    )
    conv = client.post("/api/v1/conversations", json={"kb_ids": [kb_id]}).json()

    response = client.post(
        "/api/v1/chat",
        json={
            "query": "继续问",
            "kb_ids": [kb_id],
            "conversation_id": conv["id"],
            "model_pk": model.id,
        },
    )

    assert response.status_code == 200, response.text
    assert client.get(f"/api/v1/conversations/{conv['id']}").json()["model_pk"] == model.id


# --------------------------------------------------------------------- 思考偏好（v16）


def _capturing_chat() -> dict:
    """把对话工厂换成"记下收到的 config"，用来断言这一轮真正用的思考档位。"""
    services = get_services()
    seen: dict = {}

    def factory(config):  # type: ignore[no-untyped-def]
        seen["config"] = config
        return FakeChat()

    services.chat._chat_factory = factory
    return seen


def test_conversation_can_be_created_with_thinking_preference(
    client: TestClient, kb_id: str
) -> None:
    created = client.post(
        "/api/v1/conversations",
        json={"kb_ids": [kb_id], "thinking": True, "thinking_effort": "low"},
    ).json()

    assert created["thinking"] is True
    assert created["thinking_effort"] == "low"


def test_chat_request_thinking_override_reaches_the_model_and_persists(
    client: TestClient, kb_id: str
) -> None:
    """输入框里的那两档是**请求级覆盖**，并且要随会话留痕（回看时仍是当时那一档）。"""
    seen = _capturing_chat()
    conv = client.post("/api/v1/conversations", json={"kb_ids": [kb_id]}).json()

    response = client.post(
        "/api/v1/chat",
        json={
            "query": "关掉思考再问",
            "kb_ids": [kb_id],
            "conversation_id": conv["id"],
            "thinking": False,
            "thinking_effort": "high",
        },
    )

    assert response.status_code == 200, response.text
    assert seen["config"].enable_thinking is False
    assert seen["config"].thinking_effort == "high"
    detail = client.get(f"/api/v1/conversations/{conv['id']}").json()
    assert detail["thinking"] is False
    assert detail["thinking_effort"] == "high"


def test_chat_falls_back_to_the_conversation_thinking(client: TestClient, kb_id: str) -> None:
    """请求不带时沿用会话已存的——这是"会话级偏好"存在的意义。"""
    seen = _capturing_chat()
    conv = client.post(
        "/api/v1/conversations",
        json={"kb_ids": [kb_id], "thinking": False, "thinking_effort": "low"},
    ).json()

    response = client.post(
        "/api/v1/chat",
        json={"query": "沿用会话设置", "kb_ids": [kb_id], "conversation_id": conv["id"]},
    )

    assert response.status_code == 200, response.text
    assert seen["config"].enable_thinking is False
    assert seen["config"].thinking_effort == "low"


def test_chat_without_conversation_uses_global_default(client: TestClient, kb_id: str) -> None:
    """没有会话可记时回到全局默认（默认开、中档），而不是悄悄关掉。"""
    seen = _capturing_chat()

    response = client.post("/api/v1/chat", json={"query": "一次性提问", "kb_ids": [kb_id]})

    assert response.status_code == 200, response.text
    assert seen["config"].enable_thinking is True
    assert seen["config"].thinking_effort == "medium"


# ------------------------------------------------- 置顶 / 搜索 / 回退（v17）


def _two_turns(client: TestClient) -> str:
    """建一条会话并写进一轮问答（直接落库，不经过模型）。"""
    from app.core.services import get_services

    conversation = client.post("/api/v1/conversations", json={"kb_ids": []}).json()
    services = get_services()
    services.conversations.append(conversation["id"], role="user", content="眼轴怎么测")
    services.conversations.append(conversation["id"], role="assistant", content="用 AL 测量")
    return conversation["id"]


def test_patch_pins_a_conversation(client: TestClient) -> None:
    """置顶是 PATCH 的一个字段：与改名同属"整理这条会话"。"""
    first = _two_turns(client)
    second = client.post("/api/v1/conversations", json={"kb_ids": []}).json()["id"]

    response = client.patch(f"/api/v1/conversations/{first}", json={"pinned": True})

    assert response.status_code == 200, response.text
    assert response.json()["pinned"] is True
    # 列表里置顶的排最前（第二个是刚建的，不置顶）
    items = client.get("/api/v1/conversations").json()["items"]
    assert next(item["id"] for item in items) == first
    assert second in [item["id"] for item in items]


def test_patch_can_rename_and_pin_together(client: TestClient) -> None:
    """两个字段一起传就一起改；只传一个时另一个不动。"""
    conversation_id = _two_turns(client)

    body = client.patch(
        f"/api/v1/conversations/{conversation_id}", json={"title": "改过的标题", "pinned": True}
    ).json()

    assert (body["title"], body["pinned"]) == ("改过的标题", True)


def test_list_searches_by_title(client: TestClient) -> None:
    from app.core.services import get_services

    services = get_services()
    target = client.post("/api/v1/conversations", json={"kb_ids": []}).json()["id"]
    services.conversations.rename(target, "眼科指南问答")
    client.post("/api/v1/conversations", json={"kb_ids": []})

    items = client.get("/api/v1/conversations", params={"q": "眼科"}).json()["items"]

    assert [item["id"] for item in items] == [target]


def test_rewind_returns_the_question_and_removes_the_turn(client: TestClient) -> None:
    """「重新生成」的两步：先回退拿到提问，再由前端重发（重发走正常提问链路）。"""
    conversation_id = _two_turns(client)

    response = client.post(f"/api/v1/conversations/{conversation_id}/rewind", json={"turns": 1})

    assert response.status_code == 200, response.text
    assert response.json() == {"query": "眼轴怎么测", "removed": 2}
    detail = client.get(f"/api/v1/conversations/{conversation_id}").json()
    assert detail["messages"] == []


def test_rewind_without_a_question_is_422(client: TestClient) -> None:
    empty = client.post("/api/v1/conversations", json={"kb_ids": []}).json()["id"]

    response = client.post(f"/api/v1/conversations/{empty}/rewind", json={})

    assert response.status_code == 422
    assert "没有可回退" in response.json()["message"]
