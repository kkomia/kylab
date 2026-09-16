"""MCP 客户端（v0.15，设计见 ``docs/Agent-工作区与能力层设计-v0.1.md`` §6.2）。

在此之前 KYLAB **只做 MCP 服务端**（把自己的知识库能力暴露给外部 Agent）。
这个模块补上反向的那一半：**连别人的 MCP 服务、发现它的工具、在对话里调用**——
这就是"技能与插件的能力"里的插件那一半。

QwenPaw 把这层叫 **Drivers**，并强调两件事，这里都照做：

1. **凭据加密存放、绝不回显**。接口只回"这个 key 配过没有"（``has_secrets``），
   与设置页里模型注册表对 api_key 的做法一致——回显一次，日志与截图里就有了一份。
2. **每次调用过策略闸**。三档：``allow``（直接调）、``ask``（要先确认，接口回 409
   并把"要调什么"讲清楚）、``deny``（拒绝）。默认 ``ask``：
   接一个外部服务进来就默认让它静默执行，是这层最不该有的默认。

**工具命名**：一律 ``mcp__<服务名>__<工具名>``（Anthropic 的 MCP 约定）。
加前缀不只是好看——外部服务的工具名我们无法约束，撞上内置工具名（``search``、
``list_documents``）会让模型与我们都分不清在调哪个。

**进程与超时**：``stdio`` 传输会**起一个子进程**。这意味着两件事：它是
"用户明确配置了才发生"的动作（不是自动发现），以及必须设超时——
一个卡住的子进程会拖住整个请求。超时后我们主动断开并如实报错。
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import dataclass
from typing import Any

from app.core.exceptions import (
    ConflictError,
    ForbiddenError,
    InvalidRequestError,
    NotFoundError,
)
from app.storage.base import MCPServerRecord, StoreBundle

__all__ = ["POLICIES", "MCPClientService", "MCPTool", "tool_qualified_name"]

logger = logging.getLogger(__name__)

#: 三档准入策略。默认 ``ask``：接进来就默认静默执行是最不该有的默认。
POLICIES = ("allow", "ask", "deny")

#: 一次连接/调用的超时。stdio 会起子进程，所以给得比普通 HTTP 宽一点；
#: 但必须有——卡住的子进程会拖住整个请求。
_TIMEOUT_SECONDS = 20.0

#: 工具名前缀。见模块头：外部工具名我们无法约束，撞名会让"到底在调哪个"变得无解。
TOOL_PREFIX = "mcp"


def tool_qualified_name(server_name: str, tool_name: str) -> str:
    """``mcp__<服务>__<工具>``。服务名里的下划线会与分隔符混淆，统一折成横线。"""
    safe = "_".join(part for part in (server_name or "").replace("_", "-").split() if part)
    return f"{TOOL_PREFIX}__{safe}__{tool_name}"


@dataclass(frozen=True, slots=True)
class MCPTool:
    """外部服务上的一个工具（已带限定名）。"""

    name: str
    qualified: str
    description: str = ""
    server_id: str = ""
    server_name: str = ""


class MCPClientService:
    """MCP 服务的登记与调用。**无状态**：每次调用现连现断。

    不保持长连接的理由：这些服务是**用户配的外部依赖**，它们的可用性不该影响
    KYLAB 的进程健康（连不上只该让那一次调用失败）；而常驻连接要处理重连、
    子进程泄漏、配置变更时失效——那些复杂度换来的只是几百毫秒。
    """

    def __init__(self, stores: StoreBundle) -> None:
        self._stores = stores

    # ------------------------------------------------------------------ 登记

    def list(self, *, user_id: str | None) -> list[MCPServerRecord]:
        records = self._stores.meta.list_mcp_servers()
        if user_id is None:
            return records
        return [item for item in records if item.owner_id == user_id]

    def get(self, server_id: str, *, user_id: str | None) -> MCPServerRecord:
        record = self._stores.meta.get_mcp_server(server_id)
        if record is None or not self._visible(record, user_id):
            raise NotFoundError(f"MCP 服务不存在：{server_id}")
        return record

    def create(
        self,
        *,
        name: str,
        transport: str,
        target: str,
        user_id: str | None,
        args: list[str] | None = None,
        env: dict[str, str] | None = None,
        headers: dict[str, str] | None = None,
        policy: str = "ask",
    ) -> MCPServerRecord:
        clean = (name or "").strip()
        if not clean:
            raise InvalidRequestError("缺少参数：name")
        if transport not in ("stdio", "http"):
            raise InvalidRequestError("transport 只能是 stdio 或 http")
        if not (target or "").strip():
            raise InvalidRequestError("缺少参数：target（stdio 填命令，http 填地址）")
        if policy not in POLICIES:
            raise InvalidRequestError(f"policy 只能是 {'/'.join(POLICIES)}")
        return self._stores.meta.create_mcp_server(
            MCPServerRecord(
                id=f"mcp_{uuid.uuid4().hex[:12]}",
                name=clean,
                transport=transport,
                target=target.strip(),
                args=tuple(args or ()),
                env=dict(env or {}),
                headers=dict(headers or {}),
                policy=policy,
                owner_id=user_id,
            )
        )

    def update(self, server_id: str, *, user_id: str | None, **fields: Any) -> MCPServerRecord:
        """改配置。**凭据字段是"整份替换"而不是合并**：删掉一个 header 也得能表达，
        而合并语义下"删掉"与"没传"分不开。"""
        record = self.get(server_id, user_id=user_id)
        for key in ("name", "target", "policy"):
            value = fields.get(key)
            if value is not None:
                setattr(record, key, str(value).strip())
        if record.policy not in POLICIES:
            raise InvalidRequestError(f"policy 只能是 {'/'.join(POLICIES)}")
        if not record.name or not record.target:
            raise InvalidRequestError("name 与 target 都不能为空")
        if fields.get("transport") is not None:
            if fields["transport"] not in ("stdio", "http"):
                raise InvalidRequestError("transport 只能是 stdio 或 http")
            record.transport = fields["transport"]
        if fields.get("args") is not None:
            record.args = tuple(str(item) for item in fields["args"])
        if fields.get("env") is not None:
            record.env = {str(k): str(v) for k, v in fields["env"].items()}
        if fields.get("headers") is not None:
            record.headers = {str(k): str(v) for k, v in fields["headers"].items()}
        if fields.get("enabled") is not None:
            record.enabled = bool(fields["enabled"])
        return self._stores.meta.update_mcp_server(record)

    def delete(self, server_id: str, *, user_id: str | None) -> None:
        self.get(server_id, user_id=user_id)
        self._stores.meta.delete_mcp_server(server_id)

    @staticmethod
    def _visible(record: MCPServerRecord, user_id: str | None) -> bool:
        """可见性：无归属过滤的通道（管理员/API Key）看全部；成员只看自己的。

        与工作区/知识库/会话同一口径；**无主的老数据对成员不可见**。
        """
        if user_id is None:
            return True
        return record.owner_id == user_id

    # ------------------------------------------------------------------ 调用

    def probe(self, server_id: str, *, user_id: str | None) -> tuple[bool, str, list[MCPTool]]:
        """连通性 + 工具清单（「测试连接」用它）。失败**不抛错**，回一句人话。"""
        record = self.get(server_id, user_id=user_id)
        try:
            tools = self.list_tools(record)
        except Exception as exc:  # 刻意兜住一切，理由见下
            # **probe 不向上抛任何东西**。它是「测试连接」，报错就是它的产出；
            # 抛出去的话前端只剩一句"请求失败"，用户看不到"是命令不存在、
            # 还是握手被拒、还是超时"——而那正是他要点这个按钮的原因。
            #
            # 实测过会走到这里的几类：命令不存在（`FileNotFoundError`）、
            # 子进程立刻退出（`MCPError: Connection closed`）、握手超时
            # （`TimeoutError`）、以及 anyio 把它们包成的 `ExceptionGroup`。
            # 它们的共同点是"都不在 `KylabError` 体系里"——上游的异常类型
            # 不受我们控制，所以这里只能按"兜住一切"来写。
            logger.info("MCP 服务 %s 探活失败：%s", record.name, exc, exc_info=True)
            return False, f"{type(exc).__name__}: {exc}", []
        return True, f"连接正常，发现 {len(tools)} 个工具", tools

    def list_tools(self, record: MCPServerRecord) -> list[MCPTool]:
        """连上去问它有哪些工具。连不上就报错（**不返回空**）。

        不返回空是有意的：空列表意味着"这个服务没有任何工具"，而连不上是另一回事。
        混起来的话，界面会显示"发现 0 个工具"——用户会去检查服务配置，
        而真正的问题是网络。
        """
        raw = self._run(self._a_list_tools(record))
        tools: list[MCPTool] = []
        for item in raw:
            name = str(getattr(item, "name", "") or "")
            if not name:
                continue
            tools.append(
                MCPTool(
                    name=name,
                    qualified=tool_qualified_name(record.name, name),
                    description=str(getattr(item, "description", "") or ""),
                    server_id=record.id,
                    server_name=record.name,
                )
            )
        return tools

    def call(
        self,
        record: MCPServerRecord,
        tool_name: str,
        arguments: dict[str, Any],
        *,
        approved: bool = False,
    ) -> str:
        """调用外部工具，返回**文本结果**。

        策略闸在这里（而不是在 API 层）：调用点将来不止一个（对话链路、
        MCP 服务端转发、定时任务），把闸放在能被绕过的地方等于没有闸。
        """
        if record.policy == "deny":
            raise ForbiddenError(
                f"这个 MCP 服务（{record.name}）被设为「拒绝调用」。"
                "要放行请在能力页把策略改成「允许」或「需要确认」"
            )
        if record.policy == "ask" and not approved:
            # 409 而不是 403：这不是"你不能做"，是"要先确认一下"。
            # 界面上据此弹确认框，确认后带着 approved=true 再调一次。
            raise ConflictError(
                f"调用 {record.name} 的 {tool_name} 需要你确认："
                "外部工具会以你的名义执行动作，确认后才会真正发出这次调用"
            )
        return self._run(self._a_call(record, tool_name, arguments))

    # -------------------------------------------------------------- 异步桥接

    def _run(self, coro: Any) -> Any:  # type: ignore[no-untyped-def]
        """在同步代码里跑一次异步调用。

        **每次新建一个事件循环**（``asyncio.run``）：协议层的端点都是同步 ``def``，
        FastAPI 把它们放在线程池里跑，那里没有正在运行的循环，所以这是安全的。
        反过来，如果哪天有人从 ``async def`` 端点里调到这里，会因为
        "循环已在运行"直接报错——那正是我们想要的：**别在事件循环里阻塞**。
        """
        return asyncio.run(asyncio.wait_for(coro, timeout=_TIMEOUT_SECONDS))

    async def _a_list_tools(self, record: MCPServerRecord) -> list[Any]:
        async with self._session(record) as session:
            result = await session.list_tools()
            return list(getattr(result, "tools", []) or [])

    async def _a_call(
        self, record: MCPServerRecord, tool_name: str, arguments: dict[str, Any]
    ) -> str:
        async with self._session(record) as session:
            result = await session.call_tool(tool_name, arguments)
        return _flatten_result(result)

    def _session(self, record: MCPServerRecord):  # type: ignore[no-untyped-def]
        """建一条到外部服务的会话（``async with`` 用）。"""
        return _session(record)


def _session(record: MCPServerRecord):  # type: ignore[no-untyped-def]
    """按传输方式建会话。**两种传输分开建**，因为它们要的参数完全不同
    （stdio 是子进程 + 管道，http 是 URL + 请求头）。

    返回一个异步上下文管理器；调用方负责 ``wait_for`` 超时。
    """
    from mcp import ClientSession, StdioServerParameters

    if record.transport == "stdio":
        params = StdioServerParameters(
            command=record.target, args=list(record.args), env=dict(record.env) or None
        )
        return _stdio_session(ClientSession, params)

    from mcp.client.streamable_http import streamablehttp_client

    return _http_session(ClientSession, streamablehttp_client, record)


class _stdio_session:
    def __init__(self, client_session: Any, params: Any) -> None:
        self._client_session = client_session
        self._params = params

    async def __aenter__(self):
        from mcp.client.stdio import stdio_client

        self._stdio = stdio_client(self._params)
        read, write = await self._stdio.__aenter__()
        self._session = self._client_session(read, write)
        await self._session.__aenter__()
        await self._session.initialize()
        return self._session

    async def __aexit__(self, *exc: Any) -> None:
        # 先关会话再关管道：反过来的话，会话的关闭消息没有通道可发，
        # 子进程会留在那里等（Windows 上尤其明显）
        await self._session.__aexit__(*exc)
        await self._stdio.__aexit__(*exc)


class _http_session:
    def __init__(self, client_session: Any, transport: Any, record: MCPServerRecord) -> None:
        self._client_session = client_session
        self._transport = transport
        self._record = record

    async def __aenter__(self):
        self._streams = self._transport(
            self._record.target, headers=dict(self._record.headers) or None
        )
        streams = await self._streams.__aenter__()
        read, write = streams[0], streams[1]
        self._session = self._client_session(read, write)
        await self._session.__aenter__()
        await self._session.initialize()
        return self._session

    async def __aexit__(self, *exc: Any) -> None:
        await self._session.__aexit__(*exc)
        await self._streams.__aexit__(*exc)


def _flatten_result(result: Any) -> str:
    """把工具返回摊成文本。

    MCP 的返回是一组 content block（文本、图片、资源引用）。**只取文本**：
    图片与资源引用要落到"文件在哪、怎么显示"那一层才有意义，而本轮不做那件事；
    把它们塞成 base64 进对话上下文只会烧 token。
    """
    parts: list[str] = []
    for block in getattr(result, "content", None) or []:
        text = getattr(block, "text", None)
        if isinstance(text, str) and text:
            parts.append(text)
    if parts:
        return "\n".join(parts)
    if getattr(result, "isError", False):
        return "（外部工具返回了错误，但没有文本内容）"
    return "（外部工具返回了非文本内容）"
