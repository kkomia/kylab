"""mem0 的接线层：把它的两个模型通道接到我们的模型注册表上（v0.57）。

这一层只做三件事，每件都只在**这一个文件**里做：

1. **在 import mem0 之前把两个环境变量定下来**（下面那两行）。mem0 在 import 时求值
   它们，晚了就没用：``MEM0_TELEMETRY`` 决定它要不要往 PostHog 发事件，
   ``MEM0_DIR`` 决定它把 ``config.json``（telemetry 的匿名 id）写在哪 ——
   不改的话是 ``~/.mem0``，一个本机产品的进程不该在用户家目录里建那个目录；
2. **两个自定义 provider**：``KylabChat`` 走 ``services/llm.OpenAICompatChat``
   （模型身份来自注册表的「对话生成」目标，**恒定关思考**），``KylabEmbedder``
   走注册表的「向量化」目标（没配就退回开发用确定性嵌入，界面上据此说"检索质量是兜底"）；
3. **装配一个 ``Memory``**（``build_memory``）：qdrant 本地模式 + history.sqlite，
   落点由调用方给（``MemoryService`` 按账号算）。

**为什么配置要用 ``MemoryConfig.model_construct`` 绕过校验**：mem0 的
``LlmConfig`` / ``EmbedderConfig`` 里那张 provider 白名单是**写死在 pydantic
校验器里**的（``mem0/llms/configs.py``、``mem0/embeddings/configs.py``），
``LlmFactory.register_provider`` 只改工厂那张表、改不动校验器 ——
注册完仍然会抛 "Unsupported LLM provider"。所以自定义 provider 只能：
注册进工厂（这样 ``create`` 找得到）+ 用 ``model_construct`` 造配置（跳过那层校验）。
**下面的单测钉住的就是这条链**，mem0 换实现时会红。

**provider 与实例之间的那根线是模块级的**（``_CHANNELS``）：mem0 是按
``provider_to_class`` 里的**类路径字符串**去 import 类再构造的，它只会给构造函数
传一个配置对象 —— 没有地方能塞进"我们这一轮要用的模型通道"。所以配置里那个
``model`` 字段放的是**通道 key**（一个稳定的短字符串），provider 拿它回表查。
"""

from __future__ import annotations

import os
import tempfile
import threading
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.core.exceptions import InvalidRequestError
from app.services.embedding.base import EmbeddingProvider
from app.services.llm import ChatMessage

# --------------------------------------------------------------------- 环境
#
# 这两行必须在这份文件**任何 mem0 的 import 之前**：mem0 在模块级求值它们
# （``mem0/memory/telemetry.py`` 与 ``mem0/memory/setup.py``）。
# 用 ``setdefault`` 而不是直接赋值：部署仍然可以用环境变量覆盖。


def _mem0_home() -> Path:
    """mem0 自己的簿记目录（它会在里面写一个 ``config.json``）。

    里面那个文件只是 telemetry 的匿名 user_id，**没有别的东西读它** ——
    我们真正要用的 qdrant 落点与 ``history_db_path`` 都是显式传的。
    这里定的是"别写进用户家目录"，不是"mem0 的数据放哪"。
    """
    override = os.environ.get("KYLAB_MEM0_HOME") or os.environ.get("MEM0_DIR")
    if override:
        return Path(override).expanduser()
    try:
        from app.core.config import get_settings

        return Path(get_settings().data_dir).expanduser().resolve() / "mem0"
    except Exception:
        return Path(tempfile.gettempdir()) / "kylab-mem0"


os.environ.setdefault("MEM0_TELEMETRY", "false")
os.environ.setdefault("MEM0_DIR", str(_mem0_home()))

import mem0  # noqa: E402
from mem0.configs.base import MemoryConfig  # noqa: E402
from mem0.configs.llms.base import BaseLlmConfig  # noqa: E402
from mem0.embeddings.base import EmbeddingBase  # noqa: E402
from mem0.embeddings.configs import EmbedderConfig  # noqa: E402
from mem0.llms.base import LLMBase  # noqa: E402
from mem0.llms.configs import LlmConfig  # noqa: E402
from mem0.utils.factory import EmbedderFactory, LlmFactory  # noqa: E402
from mem0.vector_stores.configs import VectorStoreConfig  # noqa: E402

__all__ = [
    "CHAT_PROVIDER",
    "COLLECTION_NAME",
    "EMBEDDER_PROVIDER",
    "Channel",
    "KylabChat",
    "KylabEmbedder",
    "build_memory",
    "channel_for",
    "clear_channels",
    "register_channel",
]

#: 我们注册进 mem0 工厂的两个 provider 名。**故意不用 ``openai`` 之类已存在的名字**：
#: 覆盖一个真 provider 会让"这份配置到底走的哪条路"再也看不出来。
CHAT_PROVIDER = "kylab"
EMBEDDER_PROVIDER = "kylab_embedder"

#: 列名（``Memory.from_config`` 的默认值，这里显式写出来：D1 只说了落点没说名字）。
COLLECTION_NAME = "kylab_memory"


@dataclass(frozen=True, slots=True)
class Channel:
    """一条解析好的模型通道：mem0 要的接口与我们的实现在这里对齐一次。

    ``key`` 是**配置里的 ``model`` 字段**（见模块头），也是通道表的键。
    调用方（``MemoryService._channel``）算出来的是 ``kylab:<存储落点>``——
    **只认落点、不带模型身份**：mem0 的 ``Memory`` 只在构造那一刻取 llm / embedder，
    而两个 provider 都是拿 key **现查**通道表的，所以"设置页换了模型"下一次访问
    就自动生效。反过来让 key 带上模型身份会变成**每换一次模型就换一个实例**，
    而 qdrant 的本地模式同一个 path 只允许有一个实例——那条路走不通。
    """

    key: str
    chat: Callable[[Sequence[ChatMessage]], str]
    """一次完整的对话补全（非流式）。生产是 ``OpenAICompatChat.complete``，
    测试注入一个假的，于是"判定与抽取跑没跑、跑了几次"能钉住。"""

    embedder: EmbeddingProvider

    dim: int
    development: bool = False
    """这条通道的向量是不是开发兜底（``EmbeddingProvider.is_development``）——
    界面据此提示"检索质量是兜底"，不要让它看起来和真嵌入一样。"""


_CHANNELS: dict[str, Channel] = {}
_LOCK = threading.Lock()


def register_channel(channel: Channel) -> str:
    """把一条通道登记进表，返回它的 key。重复登记同一个 key 就是覆盖（后写的赢）。"""
    with _LOCK:
        _CHANNELS[channel.key] = channel
    return channel.key


def channel_for(key: str) -> Channel:
    """按 key 取通道。取不到是**接线错误**（配置与实际注册对不上），如实报错。"""
    try:
        return _CHANNELS[key]
    except KeyError as exc:
        raise InvalidRequestError(
            f"记忆的模型通道没登记：{key}（这是内部接线问题，请重新打开记忆或重启）"
        ) from exc


def clear_channels() -> None:
    """清空通道表（用例的清理口，生产不使用）。"""
    with _LOCK:
        _CHANNELS.clear()


def _to_chat_messages(messages: Sequence[Any]) -> list[ChatMessage]:
    """mem0 给的是 ``[{"role": ..., "content": ...}]``，我们的通道要 ``ChatMessage``。

    只认这两个字段：mem0 这条链上不会有工具调用也不会带推理（它只要一段文本，
    见 ``KylabChat.generate_response`` 的说明）。
    """
    out: list[ChatMessage] = []
    for item in messages:
        if isinstance(item, ChatMessage):
            out.append(item)
            continue
        role = str(item.get("role") or "user")
        content = item.get("content")
        if isinstance(content, list):
            # 多模态那一档（mem0 的 vision 支持）我们不用，但真给到时不要炸：
            # 把文本块拼起来，图片块丢掉（我们这条链上不会有图片）。
            content = " ".join(
                str(part.get("text") or "")
                for part in content
                if isinstance(part, dict) and part.get("type") == "text"
            )
        out.append(ChatMessage(role=role, content=str(content or "")))
    return out


class KylabChat(LLMBase):
    """mem0 的「对话模型」通道：走 ``OpenAICompatChat``，**恒定关思考**。

    **为什么必须关思考**：``services/llm.py`` 的模块注释里就写着这条 —— 抽取类任务
    要显式关。实测（真模型 + 真数据，2026-09-27）开着思考时模型的**推理过程会混进
    正文**：那次的输出里中英文夹着"等等，第二个条目没有内容，不应该输出…Let me
    reconsider"，于是解析器只认得出半条。mem0 的抽取与"这一轮有没有值得记的事"
    都是抽取类任务，不是推理题。

    **它不读 ``config`` 里的采样参数**：模型身份、温度、max_tokens 全部由我们自己的
    注册表快照说了算（``Channel.chat`` 闭包里已经带着那份快照）。mem0 配置里那个
    ``model`` 字段只当通道 key 用 —— 让它能覆盖我们的采样参数，等于给"模型配置"
    开了第二个入口。
    """

    def generate_response(
        self,
        messages: Sequence[Any],
        tools: Sequence[Any] | None = None,
        tool_choice: str = "auto",
        **kwargs: Any,
    ) -> str:
        """mem0 的调用口。它的抽取提示词要求**纯 JSON** 或纯文本，
        ``tools`` / ``tool_choice`` 这两个参数在它那条链上永远是空的。
        """
        del tools, tool_choice, kwargs
        return channel_for(str(self.config.model or "")).chat(_to_chat_messages(messages))


class KylabEmbedder(EmbeddingBase):
    """mem0 的「向量化」通道：走注册表登记的嵌入模型。

    **形状的差**：mem0 只要求 ``embed(text, memory_action)``，而我们的
    ``EmbeddingProvider`` 是批量的（``embed(texts)``）—— 一次一条地过。
    ``memory_action`` 在我们这一侧没有对应物（它是 mem0 给"入库 / 检索 / 更新"
    分档用的），丢掉。
    """

    @property
    def _channel(self) -> Channel:
        return channel_for(str(self.config.model or ""))

    def embed(self, text: str, memory_action: str | None = None) -> list[float]:
        del memory_action
        vectors = self._channel.embedder.embed([text])
        return list(vectors[0]) if vectors else []


def build_memory(
    *,
    path: Path,
    history_db_path: Path,
    channel: Channel,
    collection_name: str = COLLECTION_NAME,
) -> mem0.Memory:
    """装配一个 ``Memory``：qdrant 本地模式 + sqlite 历史，模型走 ``channel``。

    **qdrant 用 ``path`` 本地模式**（D1）：进程内起一个本地实现、sqlite 落盘、
    Windows 上能跑。代价是**同一个 path 一个进程只能有一个实例**（文件锁，
    第二个会抛 ``RuntimeError``）—— 所以 ``MemoryService`` 那边必须是单例。

    **``on_disk=True``**：向量落盘而不是常驻内存（个人记忆的量级用不着它常驻，
    启动时也不必把全部向量读回来）。

    **``history_db_path``** 是 mem0 自己的历史库（每次 add/update/delete 一行），
    界面上「点开看 history」读的就是它。
    """
    register_channel(channel)
    config = MemoryConfig.model_construct(
        # config 必须是**普通 dict**：VectorStoreConfig 的字段类型是 Dict，
        # 塞一个 QdrantConfig 实例会在字段校验那一层就被拒（不是 model_validator）
        vector_store=VectorStoreConfig(
            provider="qdrant",
            config={
                "collection_name": collection_name,
                "embedding_model_dims": channel.dim,
                "path": str(path),
                "on_disk": True,
            },
        ),
        # `config` 保持 dict：mem0 在 add 里会 `self.config.llm.config.get("enable_vision")`
        llm=LlmConfig.model_construct(provider=CHAT_PROVIDER, config={"model": channel.key}),
        embedder=EmbedderConfig.model_construct(
            provider=EMBEDDER_PROVIDER,
            config={"model": channel.key, "embedding_dims": channel.dim},
        ),
        history_db_path=str(history_db_path),
        reranker=None,
        version="v1.1",
        custom_instructions=None,
    )
    return mem0.Memory(config=config)


#: 两个 provider 在**导入期**就注册好（``LlmFactory.create`` 那一刻要能查到）。
LlmFactory.register_provider(
    CHAT_PROVIDER, "app.services.memory_providers.KylabChat", BaseLlmConfig
)
EmbedderFactory.provider_to_class[EMBEDDER_PROVIDER] = (
    "app.services.memory_providers.KylabEmbedder"
)
