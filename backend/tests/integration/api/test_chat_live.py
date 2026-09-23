"""直播那一轮的端到端：后台跑、断开不取消、重连补发与收口（P2-2）。

镜像同构：``app/api/v1/chat.py`` 的 ``chat_stream``（带会话那条路）/
``live_turn`` / ``_live_stream`` 与 ``services/live_turns.py`` → 本文件。

四条验收各对应一件用户能感知的事：

1. **断开不取消那一轮**：读到一半关掉连接，那一轮照旧跑完、照旧落库
   （v0.41 之前它会跟着连接一起消失）；
2. **重连补发 + 接着流**：带着"最后收到的 seq"回来，没看到的那几条补上，
   然后挂在同一个后台任务上继续收——包括最后那条 ``done``；
3. **已经跑完时收口**：补发完给一条带说明的 ``done``，前端据此停止等待；
4. **``/stop`` 仍然是唯一的取消入口**（``/chat/stream`` 那条路现在也归它管）。

**"断开"在服务端的形状**：响应体那个生成器被 close 掉（``_live_stream`` 的
``finally`` 只做退订）。真实现里那是 Starlette 在连接断掉时干的，
用例里直接 close 它——两者是同一件事，而且这样不必去猜测试客户端的时序。
"""

from __future__ import annotations

import json
import time

import pytest
from fastapi.testclient import TestClient

from app.core.services import get_services
from app.services import live_turns
from app.services.llm import LLMDelta
from tests.conftest import admin_client as admin_session
from tests.conftest import install_fake_chat

#: 慢一点吐字：好让"读到一半断开"这件事真的能发生在**那一轮跑完之前**。
#: 真等几秒没有意义，判据只是"断开时它还在跑"。
CHAR_DELAY_SECONDS = 0.12


@pytest.fixture
def client():  # type: ignore[no-untyped-def]
    with admin_session() as test_client:
        yield test_client


@pytest.fixture(autouse=True)
def clean_shared_hub():  # type: ignore[no-untyped-def]
    """每条用例前后清空**进程内那张表**（它是全局的，用例之间不该互相看见）。"""
    live_turns.reset_shared_hub()
    yield
    live_turns.reset_shared_hub()


def _parse_sse(text: str) -> list[dict]:  # type: ignore[type-arg]
    return [json.loads(line[5:].strip()) for line in text.splitlines() if line.startswith("data:")]


def _conversation(client: TestClient) -> str:
    return client.post("/api/v1/conversations", json={}).json()["id"]


def _slow_chat(answer: str) -> None:
    """装上假模型，并让它**一个字一个字慢慢吐**（见 ``CHAR_DELAY_SECONDS``）。"""
    chat = install_fake_chat(answer)

    def slow_stream(messages, tools=None):  # type: ignore[no-untyped-def]
        for char in answer:
            time.sleep(CHAR_DELAY_SECONDS)
            yield LLMDelta(text=char)

    chat.stream_events = slow_stream  # type: ignore[method-assign]


def _start_turn(client: TestClient, conversation_id: str, query: str = "问题") -> None:
    """**真的走那个端点**开一轮：``chat_stream`` 在返回响应之前就把这一轮交给后台了。

    用例里不消费那个响应体（模拟"连上就没读"）：那一轮照跑——这正是 P2-2 的形状。
    """
    from app.api.v1 import chat as chat_api
    from app.api.v1.schemas import ChatRequestIn
    from app.services.api_key import Caller

    chat_api.chat_stream(
        ChatRequestIn(query=query, kb_ids=[], conversation_id=conversation_id),
        get_services(),
        Caller(is_admin=True),
    )


def _turn(conversation_id: str):  # type: ignore[no-untyped-def]
    turn = live_turns.shared_hub().current(conversation_id)
    assert turn is not None, "那一轮应当已经登记在直播表里"
    return turn


def _events(client: TestClient, conversation_id: str) -> list[dict]:  # type: ignore[type-arg]
    response = client.get(f"/api/v1/conversations/{conversation_id}/events")
    assert response.status_code == 200, response.text
    return response.json()["items"]


def _messages(client: TestClient, conversation_id: str) -> list[dict]:  # type: ignore[type-arg]
    return client.get(f"/api/v1/conversations/{conversation_id}").json()["messages"]


def test_a_disconnect_does_not_cancel_the_turn(client: TestClient) -> None:
    """**断开连接 → 那一轮照旧跑完、照旧落库**（P2-2 的第一条验收）。

    这是整件事的判据：客户端一断，此前 Starlette 会 close 掉那个生成器，
    ``GeneratorExit`` 一路穿到 ``_events``，那一轮当场没了（v0.41 只让前端别主动断，
    后端这半边没动）。现在它跑在后台线程里，断开只是少一个订阅者。
    """
    from app.api.v1 import chat as chat_api

    conversation_id = _conversation(client)
    _slow_chat("甲乙丙丁")
    _start_turn(client, conversation_id)
    turn = _turn(conversation_id)

    # 连上，读几条
    stream = chat_api._live_stream(get_services(), conversation_id, turn, after=0)
    seen = [next(stream) for _ in range(2)]
    assert any('"type": "step"' in item for item in seen)

    # 断开（真实现里就是响应体被 close）
    stream.close()
    assert not turn.finished, "读到一半时那一轮还没跑完（否则这条用例测了个空）"

    # 那一轮自己跑完：落库、消息都在
    assert turn.wait(20.0), "断开之后那一轮必须自己在后台跑完"
    kinds = [item["kind"] for item in _events(client, conversation_id)]
    assert kinds[0] == "turn/start" and kinds[-1] == "turn/end"
    messages = _messages(client, conversation_id)
    assert [item["role"] for item in messages] == ["user", "assistant"]
    assert messages[-1]["content"] == "甲乙丙丁", "断开不影响它把话说完"


def test_a_reconnect_replays_what_was_missed_and_keeps_streaming(client: TestClient) -> None:
    """**重连：补发 ``after`` 之后的，然后接着流**（P2-2 的第二条验收）。

    判据有两半，缺一条这个端点就没用：

    - 没看到的事件**补上了**（按 ``seq`` 切，与日志同一套编号）；
    - 补完之后**接着流**——那一轮还在跑，后面的事件照样到，最后是那条 ``done``。
    """
    from app.api.v1 import chat as chat_api

    conversation_id = _conversation(client)
    _slow_chat("甲乙丙丁戊己庚辛")
    _start_turn(client, conversation_id)
    turn = _turn(conversation_id)

    # 第一次连接：读到第一条**带编号**的事件（正文增量没有编号，见 live_turns），
    # 记下它当锚点，然后断开——这就是前端那侧"最后收到的 seq"
    first = chat_api._live_stream(get_services(), conversation_id, turn, after=0)
    got: list[dict] = []  # type: ignore[type-arg]
    while not any("seq" in item for item in got):
        got.append(_parse_sse(next(first))[0])
    after = int(got[-1]["seq"])
    first.close()

    # 重连：after 之后的事件要补上，并且接着收到最后那条 done
    again = chat_api._live_stream(get_services(), conversation_id, turn, after=after)
    text = "".join(again)
    events = _parse_sse(text)

    assert events, "重连之后至少要有内容（补发或后续增量）"
    # 补发的那些**一定是 after 之后的**：编号只会往后
    numbered = [item for item in events if "seq" in item]
    assert numbered and all(int(item["seq"]) > after for item in numbered)
    assert events[-1]["type"] == "done" and events[-1]["answer"] == "甲乙丙丁戊己庚辛", (
        "接上之后要一路收到收尾那条（带全文）"
    )
    # 编号与落库日志同一套：流里出现过的 seq 都是那条会话日志里真有的号
    # （收尾那条的 seq 是"这一轮最后一条日志事件"那个游标，也在里面）
    logged = {item["seq"] for item in _events(client, conversation_id)}
    assert {int(item["seq"]) for item in numbered} <= logged


def test_reconnecting_to_a_finished_turn_gets_a_final_done(client: TestClient) -> None:
    """**已经跑完时补发完就收口**（P2-2 的第二条验收的另一半）。

    补不了正文增量（那东西不进缓冲），但收尾那条 ``done`` 里是**完整答复**——
    所以重连的人不需要为了拿到答案再刷新一次整条会话；``recovered`` 与
    ``detail`` 说明"这一轮已收尾"，前端据此停止等待。
    """
    conversation_id = _conversation(client)
    install_fake_chat("答案在这里")
    _start_turn(client, conversation_id)
    assert _turn(conversation_id).wait(20.0)

    response = client.get(f"/api/v1/chat/turns/{conversation_id}/live?after=0")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    events = _parse_sse(response.text)

    assert events[-1]["type"] == "done"
    assert events[-1]["answer"] == "答案在这里"
    assert events[-1]["recovered"] is True
    assert "已经收尾" in events[-1]["detail"], "要说清\"这一轮已收尾\"，前端才收口"
    # 补发里带着这一轮的过程事件（step / 出处等），而不是只有一个空的 done
    assert any(item["type"] == "step" for item in events)


def test_a_conversation_without_a_live_turn_still_closes_cleanly(client: TestClient) -> None:
    """缓冲里已经没有它（跑完很久 / 服务重启过）：**给一句能收口的话**，不是空响应。

    这种情形下前端拿不到过程，但至少要知道"没有在跑的一轮了"，
    并且顺手带上库里最后那条回答——能省一趟会话刷新。
    """
    conversation_id = _conversation(client)
    install_fake_chat("早就答完了")
    client.post(
        "/api/v1/chat/stream",
        json={"query": "问题", "kb_ids": [], "conversation_id": conversation_id},
    )
    live_turns.reset_shared_hub()  # 模拟"服务重启过 / 缓冲已经清掉"

    events = _parse_sse(
        client.get(f"/api/v1/chat/turns/{conversation_id}/live?after=0").text
    )
    assert events[-1]["type"] == "done"
    assert events[-1]["recovered"] is True
    assert events[-1]["answer"] == "早就答完了", "情况不明时给库里最后那条回答，省一次刷新"
    assert "没有在跑的一轮" in events[-1]["detail"]


def test_stop_is_still_the_only_way_to_cancel_a_turn(client: TestClient) -> None:
    """``/stop`` 仍然能停那一轮（P2-2 的第三条验收）。

    断开不断了之后，取消只剩这一个入口——所以它必须真的管用，而且管的是
    **后台那一轮**（不是某一条连接）：这里没有任何订阅者在看，
    那一轮照样会被叫停并补上 ``interrupted``。
    """
    conversation_id = _conversation(client)
    _slow_chat("甲乙丙丁戊己")
    _start_turn(client, conversation_id)
    turn = _turn(conversation_id)
    # 等"有一条一轮在跑"真的登记上（``_start_live_turn`` 在起线程之前就登记了，
    # 这里只是把后台线程也开跑的时机等出来）
    deadline = time.monotonic() + 10.0
    while not get_services().commands.turns.running(conversation_id):
        assert time.monotonic() < deadline, "那一轮应当开跑"
        time.sleep(0.01)

    command = _parse_sse(
        client.post(
            "/api/v1/chat/stream",
            json={"query": "/stop", "kb_ids": [], "conversation_id": conversation_id},
        ).text
    )[0]
    assert command["type"] == "command" and command["ok"] is True
    assert command["action"]["kind"] == "stop_turn"

    assert turn.wait(20.0), "叫停之后那一轮要自己收工（协作式停止）"
    kinds = [item["kind"] for item in _events(client, conversation_id)]
    assert kinds[-1] == "interrupted"
    assert "/stop" in _events(client, conversation_id)[-1]["payload"]["reason"]
    # 半截的回答不落消息（与"失败的一轮不留半截记录"同一口径）
    assert _messages(client, conversation_id) == []
    assert live_turns.shared_hub().running(conversation_id) is False


def test_a_second_turn_replaces_the_first_in_the_live_table(client: TestClient) -> None:
    """同一条会话再开一轮：直播表指向**新**那一轮（旧的订阅者照旧收完）。

    "当前这一轮"只有一条——界面上用户又发了一句，他关心的是新的那句。
    """
    conversation_id = _conversation(client)
    install_fake_chat("第一轮")
    _start_turn(client, conversation_id)
    first = _turn(conversation_id)
    assert first.wait(20.0)

    install_fake_chat("第二轮")
    _start_turn(client, conversation_id)
    second = _turn(conversation_id)
    assert second is not first
    assert second.wait(20.0)
    # 两轮都落了库：第二条提问与第二条回答都在
    contents = [item["content"] for item in _messages(client, conversation_id)]
    assert contents == ["问题", "第一轮", "问题", "第二轮"]


def test_two_clients_can_watch_the_same_turn(client: TestClient) -> None:
    """两个订阅者看同一轮：**都能收到完整的事件**（扇出，各人有各人的队列）。

    为什么不是"谁在谁看"：用户可能开着两个标签页，也可能是重连之后的旧连接
    还没被关掉。后进的那个从自己的 ``after`` 开始，谁也不影响谁。
    """
    from app.api.v1 import chat as chat_api

    conversation_id = _conversation(client)
    install_fake_chat("甲乙丙")
    _start_turn(client, conversation_id)
    turn = _turn(conversation_id)

    late = chat_api._live_stream(get_services(), conversation_id, turn, after=0)
    early = chat_api._live_stream(get_services(), conversation_id, turn, after=0)
    late_text = "".join(late)
    early_text = "".join(early)

    for text in (late_text, early_text):
        events = _parse_sse(text)
        assert events[-1]["type"] == "done" and events[-1]["answer"] == "甲乙丙"


def test_the_endpoint_returns_while_the_turn_keeps_running(client: TestClient) -> None:
    """一轮在后台跑时，**请求那一侧已经可以返回**（与请求生命周期解耦）。

    这条是"后台跑"最直白的判据：``_start_turn`` 调的那个端点函数立刻返回
    （没有等模型吐完），而那一轮在另一个线程里继续跑完、落库。
    """
    conversation_id = _conversation(client)
    _slow_chat("甲乙丙丁戊己庚辛")

    started = time.monotonic()
    _start_turn(client, conversation_id)
    elapsed = time.monotonic() - started

    turn = _turn(conversation_id)
    # 八个字 × 0.12 秒 ≈ 1 秒：端点要是等它，这里不可能这么快返回
    assert elapsed < 8 * CHAR_DELAY_SECONDS / 2
    assert turn.wait(20.0), "那一轮在后台继续跑完了"
    assert [item["role"] for item in _messages(client, conversation_id)] == [
        "user",
        "assistant",
    ]


def test_a_quiet_live_stream_gets_a_ping(
    client: TestClient, monkeypatch  # type: ignore[no-untyped-def]
) -> None:
    """挂着的订阅者也要有心跳（P2-2 的第一半在这里同样成立）。

    这条流经常几十秒没有一个字节（等首字、跑抓网页的工具），而中间层把那读成
    "连接死了"。不带会话那条路的心跳在 ``_with_pings`` 里（另有用例），
    带会话这条由订阅者自己的空闲超时发出来（见 ``_live_stream``）——
    两条路的判据是同一个 ``SSE_PING_SECONDS``。
    """
    from app.api.v1 import chat as chat_api

    monkeypatch.setattr(chat_api, "SSE_PING_SECONDS", 0.05)
    conversation_id = _conversation(client)
    _slow_chat("甲乙")  # 两个字 × 0.12 秒：中间那段静默足够发出心跳

    response = client.post(
        "/api/v1/chat/stream",
        json={"query": "问题", "kb_ids": [], "conversation_id": conversation_id},
    )
    assert "event: ping" in response.text, "静默期里必须有心跳字节出去"
    # 心跳不打扰正文：回答照旧完整
    events = _parse_sse(response.text)
    assert events[-1]["type"] == "done" and events[-1]["answer"] == "甲乙"
