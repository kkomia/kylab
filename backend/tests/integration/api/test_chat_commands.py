"""斜杠命令端点与模式事件的集成测试（P1-2 与 P1-1 的两处遗留）。

镜像同构：``app/api/v1/chat.py`` 的命令那一段 → 本文件。

要钉住的是**短路**这件事本身（QwenPaw 的"进 LLM 之前短路" + DSH 的
"命令不进模型历史"）：

1. ``/help`` 与 ``/mode plan`` **不调模型**（把模型工厂换成"一调就炸"的那种，
   用例照样过）、**不产生 assistant 消息**（库里只有事件，没有消息）；
2. 命令那一轮留下一条 ``command`` 事件（DSH：写 session log 但不进模型历史）；
3. 自定义 md 命令**能调得起来**，参数替换正确（含"没有占位符时自动追加"）——
   它是**改写类**：要过一次模型，提示里是渲染后的正文；
4. 切模式写 ``mode/changed``（带 previousMode），而**在会话外改的档**由下一轮补记
   （source="settings"）；
5. 系统提示词里出现**当前档与它的语义**（P1-1 遗留 #7，抄"先告知"那条）。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.services import get_services
from tests.conftest import (
    admin_client as admin_session,
)
from tests.conftest import (
    install_fake_chat,
)


@pytest.fixture
def client():
    with admin_session() as test_client:
        yield test_client


@pytest.fixture
def kb_id(client: TestClient) -> str:
    return client.post("/api/v1/knowledge-bases", json={"name": "命令库"}).json()["id"]


def _event(items: list[dict], kind: str) -> dict:  # type: ignore[type-arg]
    """流里第一条某类事件（找不到就当场炸在这条用例上，比返回 None 好读）。"""
    return next(item for item in items if item["type"] == kind)


def _parse_sse(text: str) -> list[dict]:  # type: ignore[type-arg]
    return [json.loads(line[5:].strip()) for line in text.splitlines() if line.startswith("data:")]


def _no_model(monkeypatch: pytest.MonkeyPatch) -> None:
    """把模型工厂换成"一调就炸"：短路类命令**一个模型调用都不该有**。

    比"数调用次数"更硬：漏掉一处就会当场炸在这条用例上，而不是等某个数字对不上。
    """

    def explode(config):  # type: ignore[no-untyped-def]
        raise AssertionError("短路命令不该走到模型这一步")

    get_services().chat._chat_factory = explode


def _conversation(client: TestClient, kb_id: str) -> str:
    return client.post(
        "/api/v1/conversations", json={"title": "命令", "kb_ids": [kb_id]}
    ).json()["id"]


def _events(client: TestClient, conversation_id: str, kind: str = "") -> list[dict]:  # type: ignore[type-arg]
    query = f"?kinds={kind}" if kind else ""
    return client.get(f"/api/v1/conversations/{conversation_id}/events{query}").json()["items"]


def _messages(client: TestClient, conversation_id: str) -> list[dict]:  # type: ignore[type-arg]
    return client.get(f"/api/v1/conversations/{conversation_id}").json()["messages"]


# --------------------------------------------------------------------- 短路


def test_help_short_circuits_without_touching_the_model(
    client: TestClient, kb_id: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``/help``：**不调模型、不产生 assistant 消息**，回的是那份命令清单。

    这条是 P1-2 的核心验收：命令在进模型之前被认出来并直接执行。
    """
    _no_model(monkeypatch)
    conversation_id = _conversation(client, kb_id)

    response = client.post(
        "/api/v1/chat/stream",
        json={"query": "/help", "kb_ids": [kb_id], "conversation_id": conversation_id},
    )

    assert response.status_code == 200
    events = _parse_sse(response.text)
    command = [item for item in events if item["type"] == "command"]
    assert len(command) == 1
    assert command[0]["name"] == "help"
    assert command[0]["ok"] is True
    assert "/mode" in command[0]["text"] and "/compact" in command[0]["text"]
    # 收尾是 done（形状与正常那一轮一致），但**没有正文**——命令不产生回答
    assert _event(events, "done")["answer"] == ""
    assert not [item for item in events if item["type"] in {"step", "delta"}]
    # **不进模型历史**：库里一条消息都没有
    assert _messages(client, conversation_id) == []


def test_mode_switch_short_circuits_and_records_the_event(
    client: TestClient, kb_id: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``/mode plan``：短路 + 写 ``mode/changed``（带 previousMode），消息仍然为空。"""
    _no_model(monkeypatch)
    conversation_id = _conversation(client, kb_id)

    events = _parse_sse(
        client.post(
            "/api/v1/chat/stream",
            json={"query": "/mode plan", "kb_ids": [kb_id], "conversation_id": conversation_id},
        ).text
    )
    command = _event(events, "command")
    assert command["ok"] is True and command["action"]["mode"] == "plan"
    assert "计划" in command["text"]
    assert _messages(client, conversation_id) == []

    changes = _events(client, conversation_id, "mode/changed")
    assert changes, "切模式必须留下一条 mode/changed"
    payload = changes[-1]["payload"]
    assert payload["mode"] == "plan"
    assert payload["previousMode"] == "build"
    assert payload["source"] == "command"
    # 命令那一轮本身也留在日志里（DSH：写 session log 但不进模型历史）
    logged = _events(client, conversation_id, "command")
    assert [item["payload"]["name"] for item in logged] == ["mode"]


def test_an_unknown_command_is_answered_not_sent_to_the_model(
    client: TestClient, kb_id: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """认不出的 ``/xxx`` **不当成普通提问**（DSH：``/`` 行永不静默降级）。

    静默发给模型的话，用户以为自己在用命令，而模型在猜他想说什么。
    """
    _no_model(monkeypatch)
    events = _parse_sse(
        client.post("/api/v1/chat/stream", json={"query": "/znou", "kb_ids": [kb_id]}).text
    )
    command = _event(events, "command")
    assert command["ok"] is False
    assert "没有这个命令" in command["text"]
    assert "/help" in command["text"]


def test_the_non_streaming_endpoint_short_circuits_too(
    client: TestClient, kb_id: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``POST /chat`` 也短路：脚本与 MCP 通道要能用同一批命令（一等命令那条）。"""
    _no_model(monkeypatch)
    body = client.post("/api/v1/chat", json={"query": "/help", "kb_ids": [kb_id]}).json()
    assert "/mode" in body["answer"]
    assert body["sources"] == []


# --------------------------------------------------------------------- 自定义命令


def test_a_custom_md_command_rewrites_this_turn(
    client: TestClient, kb_id: str, tmp_path: Path
) -> None:
    """自定义命令：**文件名即命令名**，参数替进正文，正文就是这一轮的提示。

    它是改写类（不是短路类）：要过一次模型，而提示里是渲染后的正文
    ——``$ARGUMENTS`` 那一处已经被用户的参数替掉了。
    """
    commands_dir = get_services().commands.user_dir
    commands_dir.mkdir(parents=True, exist_ok=True)
    (commands_dir / "review.md").write_text(
        "---\ndescription: 评审一段代码\n---\n请按仓库规范评审：$ARGUMENTS",
        encoding="utf-8",
    )
    conversation_id = _conversation(client, kb_id)
    fake = install_fake_chat("评审完成。[1]")

    events = _parse_sse(
        client.post(
            "/api/v1/chat/stream",
            json={
                "query": "/review 这段循环有问题",
                "kb_ids": [kb_id],
                "conversation_id": conversation_id,
            },
        ).text
    )
    assert _event(events, "done")["answer"] == "评审完成。[1]"
    # 交给模型的提示是**渲染后的正文**（不是用户敲的那一行）
    prompt = fake.seen_messages[-1].content
    assert "请按仓库规范评审：这段循环有问题" in prompt
    # 用户敲的那一行仍然作为"他问了什么"落进消息（回看时看得出用了哪条命令）
    stored = _messages(client, conversation_id)
    assert stored[0]["content"] == "/review 这段循环有问题"
    assert stored[-1]["role"] == "assistant"


def test_a_custom_command_without_a_placeholder_appends_the_arguments(
    client: TestClient, kb_id: str
) -> None:
    """正文没有占位符时**自动把参数追加到末尾**（ZCode 那条兜底）。"""
    commands_dir = get_services().commands.user_dir
    commands_dir.mkdir(parents=True, exist_ok=True)
    (commands_dir / "sum3.md").write_text("把这段总结成三句话。", encoding="utf-8")
    fake = install_fake_chat("好的。[1]")

    client.post(
        "/api/v1/chat/stream", json={"query": "/sum3 第一段 第二段", "kb_ids": [kb_id]}
    )
    assert "用户参数：第一段 第二段" in fake.seen_messages[-1].content


def test_the_commands_endpoint_lists_builtins_and_custom_ones(client: TestClient) -> None:
    """``GET /chat/commands``：四项给菜单（name / summary / usage / group），
    自定义的按发现源分组，被遮蔽的带着 ``shadowed_by`` 也在列表里。"""
    commands_dir = get_services().commands.user_dir
    commands_dir.mkdir(parents=True, exist_ok=True)
    (commands_dir / "deploy.md").write_text("---\ndescription: 发版\n---\n发版", encoding="utf-8")
    (commands_dir / "mode.md").write_text("想顶掉内置的 mode", encoding="utf-8")

    body = client.get("/api/v1/chat/commands").json()
    # 同名的两条（生效的 + 被遮蔽的）里取**生效的那条**——菜单也是这么挑的
    usable = [item for item in body["items"] if not item["shadowed_by"] and not item["error"]]
    items = {item["name"]: item for item in usable}
    assert {"help", "compact", "new", "stop", "mode", "skill"} <= set(items)
    assert items["help"]["group"] == "builtin"
    assert items["help"]["short_circuit"] is True
    assert items["skill"]["short_circuit"] is False
    assert items["deploy"]["group"] == "user"
    assert items["deploy"]["summary"] == "发版"
    # 同名时内置生效，用户那份**仍然列出来并写明被谁遮蔽**（照插件列表的做法）
    assert items["mode"]["group"] == "builtin"
    shadowed = [item for item in body["items"] if item["shadowed_by"]]
    assert [item["name"] for item in shadowed] == ["mode"]
    assert body["user_dir"] == str(commands_dir)


# --------------------------------------------------------------------- 模式的另外一半


def test_a_mode_changed_outside_the_conversation_is_recorded_on_the_next_turn(
    client: TestClient, kb_id: str
) -> None:
    """设置页改的档**在下一轮被观测到**并补一条 ``mode/changed``（source="settings"）。

    模式是应用级配置、事件是会话级的，那些改档的地方手里没有会话——
    所以在每一轮开始时对照一下（见 ``services/commands.ModeWatch``）。
    """
    install_fake_chat("好啊。[1]")
    conversation_id = _conversation(client, kb_id)
    # 第一轮：build（默认档），没有切换可言
    client.post(
        "/api/v1/chat/stream",
        json={"query": "第一轮", "kb_ids": [kb_id], "conversation_id": conversation_id},
    )
    assert _events(client, conversation_id, "mode/changed") == []

    # 会话之外改档（等价于点设置页那个下拉）
    get_services().runtime.set({"chat.mode": "yolo"})
    client.post(
        "/api/v1/chat/stream",
        json={"query": "第二轮", "kb_ids": [kb_id], "conversation_id": conversation_id},
    )
    changes = _events(client, conversation_id, "mode/changed")
    assert len(changes) == 1
    payload = changes[0]["payload"]
    assert payload["mode"] == "yolo" and payload["previousMode"] == "build"
    assert payload["source"] == "settings"
    # 同一档不重复报：第三轮没有新的 mode/changed
    client.post(
        "/api/v1/chat/stream",
        json={"query": "第三轮", "kb_ids": [kb_id], "conversation_id": conversation_id},
    )
    assert len(_events(client, conversation_id, "mode/changed")) == 1


def test_the_mode_is_written_into_the_system_prompt(client: TestClient, kb_id: str) -> None:
    """当前档与它的语义**写进系统提示词**（P1-1 遗留 #7）。

    抄的是"先告知"（而不是只有 QwenPaw 的"拦下并回灌"）：说清楚现在哪一档、
    这一档允许什么，那一撞大多不会发生。
    """
    services = get_services()
    services.runtime.set({"chat.mode": "plan"})
    fake = install_fake_chat("好的。[1]")

    client.post("/api/v1/chat/stream", json={"query": "帮我看看", "kb_ids": [kb_id]})

    system = fake.seen_messages[0]
    assert system.role == "system"
    assert "【当前模式】" in system.content
    assert "计划" in system.content and "plan" in system.content
    # 换一档，下一轮的提示词跟着换（同一个读点，见 ChatService.current_mode）
    services.runtime.set({"chat.mode": "yolo"})
    client.post("/api/v1/chat/stream", json={"query": "再来一次", "kb_ids": [kb_id]})
    assert "yolo" in fake.seen_messages[0].content


# --------------------------------------------------------------------- 其余几条内置命令


def test_compact_goes_through_the_existing_compression_chain(
    client: TestClient, kb_id: str
) -> None:
    """``/compact``：**现在就把上下文压掉**，走的是自动压缩那条链路的同一个函数。

    与自动压缩的区别只有一个——它不等占用越过阈值（用户想压常常有别的理由）。
    """
    fake = install_fake_chat("这是回答。[1]")
    conversation_id = _conversation(client, kb_id)
    client.post(
        "/api/v1/chat/stream",
        json={"query": "问一句", "kb_ids": [kb_id], "conversation_id": conversation_id},
    )
    # 摘要那一步走的是同一个假模型的 `complete`
    fake.answer = "压缩后的摘要：用户问了一句。"
    events = _parse_sse(
        client.post(
            "/api/v1/chat/stream",
            json={"query": "/compact", "kb_ids": [kb_id], "conversation_id": conversation_id},
        ).text
    )
    command = _event(events, "command")
    assert command["ok"] is True and "压成摘要" in command["text"]
    assert _messages(client, conversation_id)[-1]["role"] == "assistant", "只有原来那一轮"
    assert len(_messages(client, conversation_id)) == 2, "命令本身不产生消息"
    # 再压一次：没有可压的了，**如实说**（不假装做了事）
    again = _event(
        _parse_sse(
            client.post(
                "/api/v1/chat/stream",
                json={"query": "/compact", "kb_ids": [kb_id], "conversation_id": conversation_id},
            ).text
        ),
        "command",
    )
    assert again["ok"] is True and "没有可压缩的内容" in again["text"]


def test_new_starts_a_conversation_and_reports_its_id(
    client: TestClient, kb_id: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``/new``：开一条新会话并把 id 交给界面（当前那条**不删**）。"""
    _no_model(monkeypatch)
    conversation_id = _conversation(client, kb_id)
    events = _parse_sse(
        client.post(
            "/api/v1/chat/stream",
            json={"query": "/new", "kb_ids": [kb_id], "conversation_id": conversation_id},
        ).text
    )
    command = _event(events, "command")
    created = command["action"]["conversation_id"]
    assert created and created != conversation_id
    # 库范围继承当前这条会话（"换个话题"不该把这一轮的选择也重置掉）
    assert client.get(f"/api/v1/conversations/{created}").json()["kb_ids"] == [kb_id]
    # 当前这条还在
    assert client.get(f"/api/v1/conversations/{conversation_id}").status_code == 200


def test_stop_says_so_when_nothing_is_running(
    client: TestClient, kb_id: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``/stop``：没有在跑的一轮时**如实回一句**（假装停了一下比不回答更糟）。"""
    _no_model(monkeypatch)
    events = _parse_sse(
        client.post("/api/v1/chat/stream", json={"query": "/stop", "kb_ids": [kb_id]}).text
    )
    command = _event(events, "command")
    assert command["ok"] is False
    assert "没有在跑的一轮" in command["text"]


def test_stop_really_stops_a_running_turn(client: TestClient, kb_id: str) -> None:
    """``/stop`` 把**正在跑的那一轮**叫停（P1-2：「停止也要是一等命令」）。

    后端能停后端的那一半：正在跑的那一轮在**下一次拿到事件时**看到停止标记、
    自己收工并补一条 ``interrupted``（从外面掐线程会让这一轮没有任何收尾）。

    **直接驱动那个生成器**就是"另一个请求正在跑"在服务端的形状
    （与 ``test_chat_api`` 里那条同一手法）：手上有生成器，
    就能在一次事件之后停下来、从另一个请求发 ``/stop``、再让它接着跑。

    P2-2 之后这条路**更要紧**了：客户端断开不再取消那一轮，``/stop`` 成了
    唯一的取消入口（那一轮跑在后台线程里，见 ``services/live_turns``）。
    这里测的正是"标记 + 协作式收尾"这一半——它与线程是谁起的无关。
    """
    from app.api.v1 import chat as chat_api
    from app.api.v1.schemas import ChatRequestIn
    from app.services.api_key import Caller

    install_fake_chat("甲乙丙丁戊己")  # 逐字吐：没被叫停的话它会吐满六个字
    conversation_id = _conversation(client, kb_id)
    payload = ChatRequestIn(query="问题", kb_ids=[kb_id], conversation_id=conversation_id)
    stream = chat_api._events(get_services(), payload, None, None, None, Caller(is_admin=True))
    next(stream)  # 让这一轮真的开跑（turn/start 已登记、turns.begin 已调用）

    # 另一个请求发 /stop —— 与界面上敲那条命令走的是同一条路
    command = _event(
        _parse_sse(
            client.post(
                "/api/v1/chat/stream",
                json={"query": "/stop", "kb_ids": [kb_id], "conversation_id": conversation_id},
            ).text
        ),
        "command",
    )
    assert command["ok"] is True and command["action"]["kind"] == "stop_turn"

    rest = list(stream)
    assert any(item.payload.get("type") == "done" for item in rest), (
        "被叫停的那条流也要正常收尾（发一条 done）"
    )
    emitted = "".join(
        str(item.payload.get("text", ""))
        for item in rest
        if item.payload.get("type") == "delta"
    )
    assert "戊" not in emitted and "己" not in emitted, "叫停之后不该再有新的字流出来"

    # 日志：补一条 interrupted（"哪些调用没有结果"那份名单也在这里）
    kinds = [item["kind"] for item in _events(client, conversation_id)]
    assert kinds[-1] == "interrupted"
    interrupted = _events(client, conversation_id)[-1]["payload"]
    assert "/stop" in interrupted["reason"]
    # 半截的回答**不落消息**（与"失败的一轮不留半截记录"同一口径）
    assert _messages(client, conversation_id) == []
    # 这一轮真的收工了：再发一条命令不会被判成"还有一轮在跑"
    assert get_services().commands.turns.running(conversation_id) is False


def test_mode_with_an_unknown_value_lists_the_four(
    client: TestClient, kb_id: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``/mode 乱写``：不认识的档**当场列出四档**，而不是悄悄按默认档走。"""
    _no_model(monkeypatch)
    events = _parse_sse(
        client.post("/api/v1/chat/stream", json={"query": "/mode 快", "kb_ids": [kb_id]}).text
    )
    command = _event(events, "command")
    assert command["ok"] is False
    assert all(name in command["text"] for name in ("plan", "build", "edit", "yolo"))
    # 报错也不该改设置
    assert get_services().chat.current_mode() == "build"


def test_help_with_a_command_name_expands_it(
    client: TestClient, kb_id: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``/help mode``：展开一条的用法与说明（与菜单同一份数据）。"""
    _no_model(monkeypatch)
    events = _parse_sse(
        client.post("/api/v1/chat/stream", json={"query": "/help mode", "kb_ids": [kb_id]}).text
    )
    text = _event(events, "command")["text"]
    assert "用法：/mode [plan|build|edit|yolo]" in text
    assert "plan" in text and "yolo" in text


def test_turn_start_carries_the_mode(client: TestClient, kb_id: str) -> None:
    """``turn/start`` 里带着这一轮的档：它是"档换过了没有"的基线（可查、可回放）。"""
    install_fake_chat("好的。[1]")
    conversation_id = _conversation(client, kb_id)
    client.post(
        "/api/v1/chat/stream",
        json={"query": "问一句", "kb_ids": [kb_id], "conversation_id": conversation_id},
    )
    starts = _events(client, conversation_id, "turn/start")
    assert starts and starts[0]["payload"]["mode"] == "build"
