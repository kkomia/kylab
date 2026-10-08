"""mem0 接线层（``app/services/memory_providers.py``）。

镜像同构：``app/services/memory_providers.py`` → 本文件。

这一份钉的是**版本漂移**：mem0 是我们唯一一个"API 形状不归我们管"的依赖，
而它换一版就可能让我们这三处悄悄失效——

1. **两个 provider 确实注册进了工厂**（``LlmFactory`` / ``EmbedderFactory``），
   而且配出来的实例就是我们那两个类（注册只改工厂那张表，改不动 pydantic 校验器
   ——所以配置得用 ``model_construct`` 造，见模块头）；
2. **mem0 那几个方法的签名**（``add`` / ``search`` / ``get_all`` / ``update`` /
   ``delete`` / ``history``）：参数名一改，我们传的关键字参数就会在运行时炸；
3. **一次真实的往返**：写入 → 列全部 → 检索 → 改 → 历史 → 删，
   跑在 qdrant 的本地模式上（与产品同一条路）。

不连任何模型：聊天通道是注入的一个假函数，向量通道是开发用的确定性嵌入。
"""

from __future__ import annotations

import contextlib
import inspect
from pathlib import Path

import pytest
from mem0.configs.embeddings.base import BaseEmbedderConfig
from mem0.configs.llms.base import BaseLlmConfig

from app.services import memory_providers as mp
from app.services.embedding.deterministic import DeterministicEmbedder

_DIM = 32


def _channel(tmp_path: Path, *, replies: list[str] | None = None) -> mp.Channel:
    """一条测试用的通道：聊天是假的，向量是开发用确定性嵌入。"""
    del tmp_path
    said = replies if replies is not None else []
    return mp.Channel(
        key="kylab:test",
        chat=lambda messages: (said.append(list(messages)), "{}")[1],
        embedder=DeterministicEmbedder(dim=_DIM),
        embedder_model="dev/deterministic-hash",
        dim=_DIM,
        development=True,
    )


@pytest.fixture
def memory(tmp_path: Path):
    """一个真跑起来的 mem0 实例（qdrant 本地模式 + 自己的 history.db）。"""
    channel = _channel(tmp_path)
    instance = mp.build_memory(
        path=tmp_path / "qdrant",
        history_db_path=tmp_path / "history.db",
        channel=channel,
    )
    yield instance
    # 本地 qdrant 的路径锁要放掉，否则下一次在同一个 tmp_path 上建会抛
    mp.clear_channels()
    with contextlib.suppress(Exception):
        instance.vector_store.client.close()


# --------------------------------------------------------------------- 注册


def test_both_providers_are_registered_in_the_factories() -> None:
    """注册生效 = 工厂那张表里查得到我们的类路径（这是版本漂移最容易被撞掉的一处）。"""
    from mem0.utils.factory import EmbedderFactory, LlmFactory

    assert LlmFactory.provider_to_class[mp.CHAT_PROVIDER][0].endswith("KylabChat")
    assert EmbedderFactory.provider_to_class[mp.EMBEDDER_PROVIDER].endswith("KylabEmbedder")


def test_the_built_instance_uses_our_two_providers(memory) -> None:
    """造出来的实例上，llm / embedder 就是我们那两个类（不是 mem0 自带的）。"""
    assert isinstance(memory.llm, mp.KylabChat)
    assert isinstance(memory.embedding_model, mp.KylabEmbedder)


def test_a_channel_can_be_looked_up_by_its_key() -> None:
    channel = _channel(Path("."))
    assert mp.register_channel(channel) == "kylab:test"
    try:
        assert mp.channel_for("kylab:test") is channel
    finally:
        mp.clear_channels()
    with pytest.raises(Exception, match="通道没登记"):
        mp.channel_for("kylab:test")


def test_chat_goes_through_the_channel_and_forwards_messages() -> None:
    """``KylabChat.generate_response`` 把我们自己的通道接在 mem0 的调用口上。

    **消息形状要过一遍**：mem0 给的是 ``[{"role","content"}]``，我们的通道要
    ``ChatMessage``——这一层不转，真实调用里就会是"字典没有 role 属性"。
    """
    said: list[list[object]] = []
    channel = mp.Channel(
        key="kylab:chat",
        chat=lambda messages: (said.append(list(messages)), "ok")[1],
        embedder=DeterministicEmbedder(dim=_DIM),
        embedder_model="dev",
        dim=_DIM,
    )
    mp.register_channel(channel)
    try:
        chat = mp.KylabChat(BaseLlmConfig(model="kylab:chat"))
        text = chat.generate_response([{"role": "user", "content": "你好"}])
    finally:
        mp.clear_channels()

    assert text == "ok"
    assert said[0][0].role == "user"
    assert said[0][0].content == "你好"


def test_embedder_goes_through_the_channel() -> None:
    channel = _channel(Path("."))
    mp.register_channel(channel)
    try:
        embedder = mp.KylabEmbedder(BaseEmbedderConfig(model="kylab:test", embedding_dims=_DIM))
        vector = embedder.embed("一二三", "add")
    finally:
        mp.clear_channels()

    assert len(vector) == _DIM


# --------------------------------------------------------------------- 签名


@pytest.mark.parametrize(
    "method,expected",
    [
        ("add", {"user_id", "metadata", "infer", "messages"}),
        ("search", {"query", "top_k", "filters", "threshold"}),
        ("get_all", {"filters", "top_k"}),
        ("get", {"memory_id"}),
        ("update", {"memory_id", "text", "metadata"}),
        ("delete", {"memory_id"}),
        ("history", {"memory_id"}),
    ],
)
def test_the_mem0_method_signatures_still_accept_what_we_pass(
    method: str, expected: set[str]
) -> None:
    """我们传的每一个关键字参数，mem0 那一侧都得收得到。

    钉的是**参数名**（不是顺序）：mem0 换一版把 ``text=`` 改名成 ``content=``，
    这里就会红——而真到了线上那是个 TypeError。
    """
    from mem0 import Memory

    parameters = set(inspect.signature(getattr(Memory, method)).parameters)
    missing = expected - parameters
    assert not missing, f"{method} 少了我们依赖的参数：{sorted(missing)}"


def test_from_config_is_not_the_way_in() -> None:
    """我们**不走** ``Memory.from_config``：它按 provider 白名单校验配置，
    而那张白名单写死在 pydantic 校验器里（注册改不动它）。

    这一条把那个理由钉住：真去调它，会因为我们那两个 provider 名字而抛。
    """
    from mem0 import Memory

    with pytest.raises(Exception, match=r"Unsupported LLM provider|Unsupported Embedding"):
        Memory.from_config(
            {
                "llm": {"provider": mp.CHAT_PROVIDER, "config": {}},
                "embedder": {"provider": mp.EMBEDDER_PROVIDER, "config": {}},
            }
        )


# --------------------------------------------------------------------- 往返


def test_round_trip_on_the_local_qdrant(memory) -> None:
    """写入 → 列全部 → 检索 → 改 → 历史 → 删，全在本地跑通。

    这一条是"装上这个包到底能不能用"的最小证据：它走的是产品里同一条路
    （``infer=False`` 的写入 + ``get_all(top_k=200)`` 的注入 + ``search`` 的检索）。
    """
    memory.add(
        [{"role": "user", "content": "用户要求回答先给结论"}],
        user_id="local",
        metadata={"section": "长期偏好与风格", "source": "显式"},
        infer=False,
    )

    listed = memory.get_all(filters={"user_id": "local"}, top_k=200)["results"]
    assert len(listed) == 1
    assert listed[0]["memory"] == "用户要求回答先给结论"
    assert listed[0]["metadata"]["section"] == "长期偏好与风格"
    item_id = listed[0]["id"]

    hits = memory.search("回答先给结论", top_k=5, filters={"user_id": "local"})["results"]
    assert hits and hits[0]["id"] == item_id

    memory.update(item_id, text="用户要求回答先给结论，再列依据")
    history = memory.history(item_id)
    assert [row["event"] for row in history] == ["ADD", "UPDATE"]
    assert history[1]["old_memory"] == "用户要求回答先给结论"

    memory.delete(item_id)
    assert memory.get_all(filters={"user_id": "local"}, top_k=200)["results"] == []


def test_get_all_requires_an_entity_filter(memory) -> None:
    """**每次调用都必须带实体 filter**：不带 mem0 直接抛 ``ValueError``。

    钉住它是因为我们自己那一层（``MemoryService.all_items``）每次都带——
    哪天有人顺手去掉，症状会是"记忆页 500"，而不是"少了几条"。
    """
    with pytest.raises(ValueError, match="filters must contain"):
        memory.get_all()


def test_two_instances_on_one_path_are_refused(tmp_path: Path) -> None:
    """**同一个 path 一个进程只能有一个实例**（qdrant 本地模式的文件锁）。

    这一条是 "mem0 实例必须是进程级单例" 那条设计的理由本身——
    所以它红了，就意味着 :class:`MemoryService` 的缓存策略要重新想。
    """
    channel = _channel(tmp_path)
    first = mp.build_memory(
        path=tmp_path / "qdrant", history_db_path=tmp_path / "history.db", channel=channel
    )
    try:
        with pytest.raises(RuntimeError, match="already accessed"):
            mp.build_memory(
                path=tmp_path / "qdrant",
                history_db_path=tmp_path / "history.db",
                channel=channel,
            )
    finally:
        first.vector_store.client.close()


def test_telemetry_is_off_and_mem0_home_is_not_the_user_home() -> None:
    """遥测必须关，且 mem0 的簿记目录**不许落在用户家目录**（``~/.mem0``）。

    两件事都只能在 import mem0 **之前**定下来（它在模块级求值），
    所以它们只能靠"import 之后回头看环境变量"来钉。
    """
    import os

    assert os.environ["MEM0_TELEMETRY"] == "false"
    home = str(Path(os.environ["MEM0_DIR"]).expanduser().resolve())
    assert ".mem0" not in Path(home).name
    assert not home.endswith(str(Path.home() / ".mem0"))
