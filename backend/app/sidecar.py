r"""**边车入口**（Phase B · P3，2026-09-29）：把循环 + 工具 + 工作区 + 沙箱放进**本地进程**，
KB 与模型经 P2 的两个**远端客户端**接出去 ✓ —— 同一份循环代码、两个装配点里的第二个 ✓。

## 跑法

```bash
# 在 backend/ 下（默认工作区 ~/.kylab/workspace，绝不写系统目录 ✗）
python -m app.sidecar --port 8765
```

## 装配点（方案 §4）

| 这一侧 | 边车模式 | 服务器模式（今天 ✓） |
| --- | --- | --- |
| KB | `RemoteKnowledgeClient`（`POST /api/v1/search` ✓） | `ChatService.retrieve_sources` ✓ |
| 模型 | `RemoteModelClient`（`POST /api/v1/model-proxy/*` ✓） | `OpenAICompatChat` ✓ |
| 工具 / 工作区 / 沙箱 | **本地** ✓（`isolation.py` / `sandbox.py` ✓； | 服务器进程内 ✓ |
| | **没有隔离就拒绝执行** ✗ 这条不绕过 ✓） | |

`if` 只出现在 `build_clients()` 这一处 ✓ —— **循环不复制** ✗。

## 本轮做到哪（如实写）

- ✓ `GET /health`：版本 + **两端可达性**（真去打后端的 `/api/v1/health` ✓，
  打不通就**如实报不可达** ✗ 不假装健康 ✓）；
- ✓ `POST /turn`：吃一条用户消息 → 建**同一个 `ToolLoop`** ✓（循环本体一行没改 ✗）
  → 工具在**本机执行** ✓ → 结果回灌模型 → 返回 `{answer, steps, notes, sse}` ✓；
- ✓ `steps` 现在是**真的**：`ToolLoop` 产出的 `StepEvent` 逐条转成 dict ✓；
- ✗ SSE 端点：结构留了位（`sse` 字段 + `text/event-stream` 的说明 ✓），端点本身 P4 与前端一起做 ✓；
- ✗ 审批的**确认入口**：整套 `ApprovalRegistry` 带过来了 ✓（`ask` 档的行为与服务器一致 ✓），
  但边车这一侧还没有界面能点头 → 需要确认的调用会等到超时按"没批准"处理 ✓（P4 与前端一起做）。

## 工作区与沙箱

- 工作区默认 `~/.kylab/workspace` ✓（可用 `--workspace` 指定 ✓）；**系统目录一律拒绝** ✗
  （`_check_workspace` 挡 `C:\Windows`、`/etc`、`/usr` 这些 ✓）；
- 命令执行仍走既有两道闸 ✓（`sandbox.require_isolation` 默认**拒绝**裸跑 ✓ —— 这条不许绕 ✓）。
"""

from __future__ import annotations

import argparse
import json
import os
from collections.abc import Iterator, Sequence
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.core.exceptions import NotFoundError
from app.services import agent_tools, plan_gate
from app.services import approvals as approval_service
from app.services.agent import ApprovalEvent, DeltaEvent, DoneEvent, StepEvent
from app.services.api_key import Caller
from app.services.llm import ChatMessage, ToolSpec
from app.services.remote_clients import (
    RemoteClientError,
    RemoteKnowledgeClient,
    RemoteModelClient,
)
from app.services.runtime_config import RuntimeConfigService
from app.services.tool_loop import ToolLoop

__all__ = ["SIDECAR_VERSION", "build_clients", "create_app", "default_workspace"]

SIDECAR_VERSION = "0.2.0"

#: 本地这一侧的"会话 id"：边车是**一问一答**的入口 ✓（方案 §6 说会话权威在服务器 ✓），
#: 这个常量只用来定位沙箱目录与计划门闸的格子，不上报、不落库 ✓。
LOCAL_CONVERSATION = "sidecar"

#: 默认工作区（用户目录下，**不写系统目录** ✗）。
DEFAULT_WORKSPACE = Path.home() / ".kylab" / "workspace"

#: 系统目录前缀：指定到这些下面一律拒绝 ✗（宁可起不来，也不让工具在系统目录里跑）。
FORBIDDEN_ROOTS = (
    "c:\\windows",
    "c:\\program files",
    "/etc",
    "/usr",
    "/bin",
    "/sbin",
    "/system",
    "/var",
)


def default_workspace() -> Path:
    """默认工作区目录 —— **按可写性逐级回退** ✓（P3 烟测抓到：`~/.kylab` 建不出来 ✗）。

    实测（2026-09-29 真烟测）：在这台机器上 `Path.home()/".kylab"` 直接
    `PermissionError: [WinError 5]` ✗ —— 用户目录并不总是可写的（受限配置、
    受管终端、沙箱策略都会这样 ✓）。而边车**必须能起来** ✓，所以按顺序试：

    1. `~/.kylab/workspace`（首选 ✓，用户看得见、好备份 ✓）；
    2. `%LOCALAPPDATA%\\kylab\\workspace`（Windows）/ `$XDG_DATA_HOME`（*nix）✓；
    3. `%LOCALAPPDATA%\\Temp\\kylab-workspace`（Windows）/ 系统临时目录（*nix）✓
       —— **两个问题分开** ✗：`tempfile.gettempdir()` 在受管终端里可能指向**仓库目录**
       （本会话实测就是 `E:\\gitlab\\kylab\\backend` ✗）→ 落在仓库里的工作区会被 git 看见 ✗、
       也会跟着仓库被清掉 ✗，所以 Windows 上**显式用 `%LOCALAPPDATA%\\Temp`** ✓，
       并且**任何落点只要在仓库根之下就跳过** ✗（`_inside_repo` ✓）。

    三处都写不了才抛 ✗（那时如实报出来，而不是假装起来了 ✓）。
    """
    candidates: list[Path] = [DEFAULT_WORKSPACE]
    local = os.environ.get("LOCALAPPDATA") or os.environ.get("XDG_DATA_HOME")
    if local:
        candidates.append(Path(local) / "kylab" / "workspace")
    import tempfile

    if os.name == "nt" and os.environ.get("LOCALAPPDATA"):
        candidates.append(Path(os.environ["LOCALAPPDATA"]) / "Temp" / "kylab-workspace")
    candidates.append(Path(tempfile.gettempdir()) / "kylab-workspace")

    problems: list[str] = []
    for candidate in candidates:
        # **绝不落在仓库里** ✗（临时兜底最容易踩：TEMP 常被指到工程目录 ✓）
        if _inside_repo(candidate):
            problems.append(f"{candidate}（在仓库根之下，跳过 ✗）")
            continue
        try:
            candidate.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            problems.append(f"{candidate}（{type(exc).__name__}: {exc}）")
            continue
        return candidate
    raise RuntimeError("找不到可写的工作区目录：" + "；".join(problems))


def _inside_repo(path: Path) -> bool:
    """这个路径是不是落在**仓库根**之下（`backend/` 的上一级 ✓）。

    判据用 `app/sidecar.py` 自己的位置往上一级推 ✓ —— 不依赖 cwd ✗、
    也不依赖用户把仓库放在哪儿 ✓。
    """
    repo_root = Path(__file__).resolve().parents[2]
    try:
        return path.resolve().is_relative_to(repo_root)
    except OSError:
        return False


class _LocalSettings:
    """`RuntimeConfigService` 要的 settings 形状：**只有 `data_dir` 是真给的** ✓。

    其余的引导值（embedding / llm / memory / chat 那几项，`_bootstrap_value` 一次读一串）
    **一律 None** ✓：边车的配置以**本地设置文件**为准 ✓，不从 `.env` 猜 ✗。
    用 `__getattr__` 兜底是刻意的：那张属性表是 `runtime_config` 内部的事，
    它将来多一个名字时**不该让边车起不来** ✗（引导值留空即可 ✓）。
    """

    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir

    def __getattr__(self, name: str) -> None:
        return None


class _MetaStore:
    """`RuntimeConfigService` 要的那个鸭子类型：**一个本地 JSON 文件当设置库** ✓。

    真实那套在 PG 的 `app_settings` 表里 ✗（服务器权威）——边车这一侧不复制它 ✗，
    但**默认值用服务器同一份** ✓（`runtime_config.DEFAULTS` ✓），所以
    `sandbox.require_isolation` 的默认仍是 `"true"` ✓、`chat.permission` 仍是默认档 ✓。
    """

    def __init__(self, path: Path) -> None:
        self._path = path

    def _read(self) -> dict[str, str]:
        try:
            payload = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            # 文件没有/坏了都当"没配过"：设置读不出来不该让边车起不来 ✓（读失败只影响覆盖值）
            return {}
        if not isinstance(payload, dict):
            return {}
        return {str(key): str(value) for key, value in payload.items()}

    def get_settings(self, keys: Sequence[str]) -> dict[str, str]:
        stored = self._read()
        return {str(key): stored[str(key)] for key in keys if str(key) in stored}

    def set_setting(self, key: str, value: str) -> None:
        stored = self._read()
        stored[str(key)] = str(value)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(
            json.dumps(stored, ensure_ascii=False, indent=2, sort_keys=True),
            encoding="utf-8",
        )


class _EmptySkills:
    """**本机没有技能目录**：如实回空 ✓（别假装有 ✗）。

    为什么不是"扫一遍本机 `skills/`"：那会让边车与服务器各有一份技能目录，
    而技能目录的权威在服务器 ✓（方案 §3 第 3 条：会话权威在服务器）——
    这一轮**不接**，并把这件事写在响应里 ✓（见 `/turn` 的 `notes` ✓）。
    """

    def list(self) -> list[Any]:
        return []

    def read(self, name: str) -> tuple[Any, str]:
        raise NotFoundError(f"边车这一侧没有技能目录（读不到技能：{name}）")


class _NoMcp:
    """边车这一侧**没有接 MCP 服务**：清单回空 ✓（工具表里因此不会出现 `mcp__*`）。"""

    def available_tools(self, *, user_id: str | None = None) -> list[Any]:
        return []

    def list(self, *, user_id: str | None = None) -> list[Any]:
        return []

    def decide(self, *args: Any, **kwargs: Any) -> Any:
        raise NotFoundError("边车这一侧没有接 MCP 服务")

    def call(self, *args: Any, **kwargs: Any) -> Any:
        raise NotFoundError("边车这一侧没有接 MCP 服务")


class _KnowledgeSeam:
    """**KB 接缝**：`services.chat.retrieve_sources` → P2 的远端实现 ✓。

    `build_runner` 里只有这一处取资料（`agent_tools.py` 的 `search` 那一支 ✓），
    它在服务器模式下调的是 `ChatService.retrieve_sources` ✓；边车这一侧
    **同一个方法名、同一个签名** ✓，换的只是实现 ✓ —— 这正是 P1 抽协议的目的 ✓。
    """

    def __init__(self, knowledge: Any) -> None:
        self._knowledge = knowledge

    def retrieve_sources(self, **kwargs: Any) -> Any:
        return self._knowledge.retrieve_sources(**kwargs)


class _ApiKeySeam:
    """范围校验**留在服务器那一侧** ✓（`/api/v1/search` 按令牌拒 ✗）——本地不重做一遍 ✓。

    为什么不在本地再查一次：本地没有账号与库的权威数据 ✓（那些在 PG 里），
    照着"看不见的就放行"写一遍只会造出第二套权限语义 ✗。
    """

    def check_access(self, caller: Any, **kwargs: Any) -> None:
        return None


class _LocalConversations:
    """`resolve_roots` 会问"这条会话挂在哪个工作区" ✓ → 边车只有一个：**本机那个目录** ✓。"""

    def get(self, conversation_id: str) -> Any:
        return SimpleNamespace(workspace_id=LOCAL_CONVERSATION)


class _LocalWorkspaces:
    """工作区记录的最小形状（`resolve_roots` 只读 `root_path` ✓）。"""

    def __init__(self, root: Path) -> None:
        self._root = root

    def get(self, workspace_id: str, *, user_id: str | None = None) -> Any:
        return SimpleNamespace(root_path=str(self._root))


class LocalServices:
    """边车这一侧的 `Services` **影子**（鸭子类型 ✓）：只放本地真有的那几件 ✓。

    缺的那些**不提供**而不是"提供一个会炸的" ✓ —— 工具表里也就不会出现它们
    （`SIDECAR_TOOL_NAMES` 那一层再筛一次 ✓），模型不会去撞一句"内部错误" ✗。
    """

    def __init__(
        self,
        *,
        runtime: RuntimeConfigService,
        approvals: Any,
        knowledge: Any,
        workspace: Path,
    ) -> None:
        self.runtime = runtime
        self.approvals = approvals
        self.workspace = workspace
        self.skills = _EMPTY_SKILLS
        self.mcp = _NO_MCP
        self.chat = _KnowledgeSeam(knowledge)
        self.api_keys = _API_KEY_SEAM
        self.conversations = _LocalConversations()
        self.workspaces = _LocalWorkspaces(workspace)


_EMPTY_SKILLS = _EmptySkills()
_NO_MCP = _NoMcp()
_API_KEY_SEAM = _ApiKeySeam()

#: 这一轮边车**真的能服务**的工具 ✓（其余不摆给模型 ✗ —— 摆上去只会撞一句"内部错误" ✗）。
#:
#: - `search` 走**远端 KB** ✓（只有这一轮给了 `kb_ids` 才出现 ✓，与服务器同口径 ✓）；
#: - 文件三件 + `run_command` 是**本地执行的主体** ✓（沙箱与隔离探测都在本机 ✓）；
#: - 联网两件在 `tools.py` 里实现 ✓，不依赖仓储 ✓；
#: - 技能两件**如实回空** ✓（`list_skills` 会说"这台机器上还没有安装技能" ✓）。
#:
#: 导出 / 笔记 / 记忆 / 入库 / 表格 / 定时要 PG 与对象存储（服务器权威 ✗）→ 留给 P4 ✓。
SIDECAR_TOOL_NAMES = frozenset(
    {
        "search",
        "list_files",
        "read_file",
        "search_files",
        "run_command",
        "web_search",
        "web_fetch",
        "list_skills",
        "read_skill",
    }
)


def _step_payload(event: StepEvent) -> dict[str, Any]:
    """`StepEvent` → 响应里的 dict ✓（字段与服务器那条链路同一套名字 ✓）。"""
    return {
        "phase": event.phase,
        "label": event.label,
        "detail": event.detail,
        "status": event.status,
        "tool": event.tool,
        "outcome": event.outcome,
        "args": event.args,
        "result": event.result,
    }


def _approval_step(event: ApprovalEvent) -> dict[str, Any]:
    """边车这一侧**还没有确认入口** ✗ → 把这条待确认如实记成一步 ✓（别吞掉 ✗）。"""
    return {
        "phase": "tool",
        "label": f"在等确认：{event.label}",
        "detail": (
            f"{event.args}（边车这一侧还没有确认入口，等不到就按「没批准」处理："
            f"{int(event.timeout_seconds)} 秒）"
        ),
        "status": "done",
        "tool": event.tool,
        "outcome": "awaiting",
        "args": event.args,
        "result": "",
    }


def _notes(clients: Clients) -> list[str]:
    """响应里那几句**如实说明** ✓（"这一侧有什么、没有什么" ✗ 不假装有 ✓）。"""
    return [
        "本机无内置技能目录：技能目录的权威在服务器，边车这一侧如实回空。",
        f"本地执行：工作区 {clients.workspace}；沙箱在 {clients.data_dir / 'sandbox'} 下。",
    ]


def _check_workspace(raw: str | None) -> Path:
    """解析工作区：**系统目录一律拒绝** ✗（用户目录下怎么放都行 ✓）。"""
    path = Path(raw).expanduser().resolve() if raw else default_workspace()
    text = str(path).replace("/", "\\").lower() if os.name == "nt" else str(path).lower()
    if os.name == "nt":
        text = text.replace("\\", "/")
        for root in FORBIDDEN_ROOTS:
            marker = root.replace("\\", "/")
            if text == marker or text.startswith(f"{marker}/"):
                raise ValueError(f"工作区不能是系统目录：{path}")
    else:
        for root in FORBIDDEN_ROOTS:
            if text == root or text.startswith(f"{root}/"):
                raise ValueError(f"工作区不能是系统目录：{path}")
    path.mkdir(parents=True, exist_ok=True)
    return path


class Clients:
    """**装配点**：远端两端 + 本地那一侧（P3）✓（服务器模式在 `core/services.py` ✓）。

    | 件 | 边车这一侧 | 怎么来 |
    | --- | --- | --- |
    | KB 检索 | **远端** ✓ | `RemoteKnowledgeClient` ✓，接在 `services.chat.retrieve_sources` 上 ✓ |
    | 模型 | **远端** ✓ | `RemoteModelClient` ✓（key 不下发 ✓） |
    | 循环 / 工具 / 沙箱 / 审批 | **本地** ✓ | `ToolLoop` + `build_runner` ✓（同一份代码 ✓） |
    | 技能目录 | **没有** ✗ | 如实回空 ✓（`/turn` 的 `notes` 里说清 ✓） |
    | MCP / 记忆 / 笔记 / 入库 / 表格 | **没有** ✗ | 要 PG 与对象存储（服务器权威 ✓）✗ |
    """

    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        workspace: Path,
        data_dir: Path,
        knowledge: Any = None,
        model: Any = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        #: 打服务器自己的健康端点（探活很便宜，不占用模型的额度 ✓）
        self.health_url = self.base_url.rsplit("/api/v1", 1)[0] + "/api/v1/health"
        # 两端可注入（用例给假实现 ✓）——**默认就是 P2 的远端实现** ✓。
        self.knowledge = (
            knowledge
            if knowledge is not None
            else RemoteKnowledgeClient(self.base_url, token=token)
        )
        self.model = model if model is not None else RemoteModelClient(self.base_url, token=token)
        self.workspace = workspace
        self.data_dir = data_dir
        data_dir.mkdir(parents=True, exist_ok=True)
        #: 本地运行期配置（**同一份默认值** ✓，落在本地 JSON 文件里 ✓）。
        #: `require_isolation` 的默认值仍是 `"true"` ✓ —— **那道闸没有被绕** ✗。
        #: 注意 `RuntimeConfigService` 读的是 `stores.meta`（鸭子类型里那一层 ✓）。
        self.runtime = RuntimeConfigService(
            SimpleNamespace(meta=_MetaStore(data_dir / "settings.json")),
            _LocalSettings(data_dir),
        )
        #: **整套 `ApprovalRegistry` 带过来** ✓（`ask` 档的行为与服务器逐条一致 ✓）。
        self.approvals = approval_service.ApprovalRegistry()
        #: `build_runner` 眼里 `Services` 是**鸭子类型** ✓ → 给一份"本地真的有的"影子 ✓。
        self.services = LocalServices(
            runtime=self.runtime,
            approvals=self.approvals,
            knowledge=self.knowledge,
            workspace=workspace,
        )

    def tool_specs(self, *, kb_ids: Sequence[str] = ()) -> list[ToolSpec]:
        """这一轮摆给模型的工具：**只摆本地真能服务的那些** ✓（见 `SIDECAR_TOOL_NAMES`）。"""
        scope = [str(item) for item in kb_ids if str(item).strip()]
        specs = agent_tools.tool_specs(self.services, owner_id=None, kb_ids=scope or None)
        return [spec for spec in specs if spec.name in SIDECAR_TOOL_NAMES]

    def tool_loop(self, *, kb_ids: Sequence[str] = ()) -> ToolLoop:
        """把**远端两端 + 本地那一侧**拼成一个 `ToolLoop` ✓（循环本体一行不改 ✗）。

        三处口径与服务器那条链路逐条对齐：工具表（`tool_specs` ✓）、执行器
        （`build_runner` ✓，`services` 鸭子类型 ✓）、档位（`chat.mode` / `chat.permission`
        从**本地**运行期配置读 ✓，与 `chat.tool_loop` 同一读法 ✓）。
        """
        scope = [str(item) for item in kb_ids if str(item).strip()]
        # ``Caller(is_admin=True)``：**本地这一侧没有本地账号权威** ✓（账号与会话权威在服务器 ✓，
        # 口径对齐是 P4 ✗）。而 `agent_exec` 的第一道闸问的是"能不能在**这台机器**上执行代码"
        # （`agent_exec.py` 的闸 1 ✓）——边车跑在**用户自己的机器**上 ✓，能起边车的人就是这台
        # 机器的主人 ✓，所以按"本机主人"放行 ✓。**服务器那道 `require_admin` 没有被绕过** ✗：
        # 它管的是服务器上的执行 ✓，而边车这一侧的执行**根本不经过服务器** ✓。
        # 隔离（`require_isolation` ✓）与权限档（`chat.permission` ✓）两道闸照旧生效 ✓。
        runner = agent_tools.build_runner(
            self.services,
            Caller(is_admin=True),
            kb_ids=scope,
            conversation_id=LOCAL_CONVERSATION,
        )
        return ToolLoop(
            client_factory=lambda: self.model,
            tools=self.tool_specs(kb_ids=kb_ids),
            runner=runner,
            approvals=self.approvals,
            mode=self.runtime.get("chat.mode"),
            permission=self.runtime.get("chat.permission"),
            gate=plan_gate.gate_for(LOCAL_CONVERSATION),
        )


def build_clients(
    base_url: str, token: str, *, workspace: Path, data_dir: Path
) -> Clients:
    """唯一的装配处 ✓（方案 §4：`if` 只允许出现在这里）。"""
    return Clients(base_url, token, workspace=workspace, data_dir=data_dir)


class TurnIn(BaseModel):
    """一条用户消息（**为 SSE 留位**：`stream` 打开时走 `text/event-stream` ✓）。"""

    message: str = Field(min_length=1, max_length=32_000)
    workspace: str | None = Field(default=None, description="留空用默认工作区（用户目录下）")
    kb_ids: list[str] = Field(
        default_factory=list,
        description="这一轮允许查的库；**留空 = 知识库关着** ✓（与服务器同口径 ✓）",
    )
    stream: bool = Field(default=False, description="预留：P4 与前端一起做 SSE ✓")


class TurnOut(BaseModel):
    """回答 + 本轮步骤（`steps` 现在是 `ToolLoop` 真的产出的 ✓）+ 如实说明 ✓。"""

    answer: str
    steps: list[dict[str, Any]] = Field(default_factory=list)
    workspace: str
    notes: list[str] = Field(default_factory=list, description="这一侧有什么/没有什么（如实写 ✓）")
    sse: bool = Field(default=False, description="预留：true 时可用 /turn/stream 取 SSE ✓")


class HealthOut(BaseModel):
    """**如实报**两端可达性 ✗（不许假装健康 ✓）。"""

    version: str
    workspace: str
    kb_reachable: bool
    model_reachable: bool
    note: str = ""


def _probe_health(url: str, timeout: float = 5.0) -> tuple[bool, str]:
    """探活 → ``(可达?, 说明)`` ✓ —— **失败原因必须带出来** ✗（P3 烟测抓到：吞成 False ✗）。

    烟测现场：`/health` 说"后端不可达" ✗，可**同一份 base/token** 的 `/turn` 却成功了 ✓ ——
    探针把原因吞了，于是"不可达"三个字既不可信、也没法排障 ✗。现在分两类如实报：

    - **网络层不可达**（连不上/超时/DNS）→ 带上异常原文 ✓；
    - **端点答了但不是 2xx** → 带上**状态码 + 正文前 200 字** ✓（那条才是真正要看的 ✓）。
    """
    try:
        response = httpx.get(url, timeout=timeout)
    except httpx.HTTPError as exc:
        return False, f"网络不可达：{type(exc).__name__}: {exc}（url={url}）"
    if response.status_code >= 400:
        return False, (
            f"端点返回 {response.status_code}（url={url}）：{response.text[:200]}"
        )
    return True, ""


def create_app(
    base_url: str, token: str, workspace: Path, *, data_dir: Path | None = None
) -> FastAPI:
    """造边车应用（入口只做参数解析与 `uvicorn.run` ✓，方便用例直接拿 app ✓）。

    ``data_dir`` 是**本地**运行期数据的落点 ✓（沙箱在它下面 ✓）：默认取工作区的
    上一级 `…/data` ✓ —— 与工作区同处一个用户目录，备份时一起拿走 ✓。
    """
    data_dir = data_dir or (workspace.parent / "data")
    clients = build_clients(base_url, token, workspace=workspace, data_dir=data_dir)
    app = FastAPI(title="kylab sidecar", version=SIDECAR_VERSION)

    @app.get("/health", response_model=HealthOut, summary="健康 + 两端可达性")
    def health() -> HealthOut:
        kb_ok, why = _probe_health(clients.health_url)
        return HealthOut(
            version=SIDECAR_VERSION,
            workspace=str(workspace),
            kb_reachable=kb_ok,
            model_reachable=kb_ok,  # 同一个后端；模型是否**可用**要看它的档位配置 ✓
            # **如实报原因** ✗（网络不可达 vs 端点非 2xx 分开 ✓ —— 别吞成一句"不可达" ✗）
            note=why,
        )

    @app.post("/turn", response_model=TurnOut, summary="走一轮（模型与 KB 远端；工具在本机跑）")
    def turn(payload: TurnIn) -> TurnOut:
        """**同一个 `ToolLoop`** ✓：远端模型 + 远端 KB + 本地工具/沙箱/审批 ✓。

        顺序与服务器那条链路逐条对齐（见 `api/v1/chat.py` 的同名循环）：
        取正文以收尾那条 `DoneEvent` 为准 ✓、步骤逐条收 ✓、远端失败**如实报** ✗。
        """
        target = _check_workspace(payload.workspace) if payload.workspace else workspace
        notes = _notes(clients)
        loop = clients.tool_loop(kb_ids=payload.kb_ids)
        messages = [ChatMessage(role="user", content=payload.message)]
        answer = ""
        steps: list[dict[str, Any]] = []
        try:
            for event in loop.run(messages=messages):
                if isinstance(event, StepEvent):
                    steps.append(_step_payload(event))
                elif isinstance(event, DeltaEvent):
                    answer += event.text
                elif isinstance(event, DoneEvent):
                    # 收尾那条带的是拼好的全文，**以它为准** ✓（个别增量丢了也不会与步骤对不上 ✓）
                    answer = event.answer or answer
                elif isinstance(event, ApprovalEvent):
                    steps.append(_approval_step(event))
        except RemoteClientError as exc:
            # **失败分档照旧** ✓：远端不可用/被拒都要如实说出来 ✗（不当成"空回答" ✓）
            return TurnOut(answer=f"（边车报告：{exc}）", workspace=str(target), notes=notes)
        return TurnOut(answer=answer, steps=steps, workspace=str(target), notes=notes)

    @app.post("/turn/stream", summary="预留：SSE（P4 与前端一起做）")
    def turn_stream(payload: TurnIn) -> StreamingResponse:
        """**占位**：结构与 `/turn` 同源 ✓，只为让 P4 有落点 ✓（本轮不实现流式渲染 ✗）。"""

        def gen() -> Iterator[str]:
            messages = [ChatMessage(role="user", content=payload.message)]
            try:
                for delta in clients.model.stream_events(messages):
                    yield f"data: {delta.text}\n\n"
            except RemoteClientError as exc:
                yield f"data: （边车报告：{exc}）\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(gen(), media_type="text/event-stream")

    return app


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="KYLAB 本地边车（循环本地、KB 与模型远端）")
    parser.add_argument("--host", default="127.0.0.1", help="**只监听本机**（默认 127.0.0.1）")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument(
        "--server",
        default=os.environ.get("KYLAB_SERVER_URL", "http://127.0.0.1:8000/api/v1"),
        help="服务器 API 基址（KB 与模型代理都在它下面）",
    )
    parser.add_argument(
        "--token", default=os.environ.get("KYLAB_TOKEN", ""), help="用户会话令牌"
    )
    parser.add_argument(
        "--workspace", default=None, help="本地工作区目录（默认 ~/.kylab/workspace）"
    )
    parser.add_argument(
        "--data-dir",
        default=None,
        help="本地运行期数据目录（沙箱与设置落在它下面；默认取工作区上一级的 data/）",
    )
    args = parser.parse_args(argv)

    workspace = _check_workspace(args.workspace)
    data_dir = Path(args.data_dir).expanduser().resolve() if args.data_dir else None
    import uvicorn  # 局部导入：用例 import 本模块时不必拉起 uvicorn ✓

    uvicorn.run(
        create_app(args.server, args.token, workspace, data_dir=data_dir),
        host=args.host,
        port=args.port,
    )


if __name__ == "__main__":
    main()
