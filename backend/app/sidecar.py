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
- ✓ `POST /turn/stream`：SSE（`step` / `thinking` / `delta` / **`approval`** /
  `done` / `error` ✓），事件形状与服务器那条链**逐字对齐** ✓；
- ✓ 审批的**确认入口**（2026-09-29 接上 ✓）：`ask` 档走到"要问"时发一条 `type=approval` ✓、
  循环停在 `ApprovalRegistry.wait_decision` 上等人 ✓；用户在界面上点的那一下走
  `POST /turn/approvals/{approval_id}` ✓（与服务器 `ChatApprovalIn/Out` 同形 ✓，
  复用**同一个登记表** ✓ 不另造一套 ✗）。**没有通道的链路**（`/turn` 那条非流式、
  以及脚本 / 单测这种没登记表的）照旧走 `UNAVAILABLE` —— 如实回"待确认"，
  **绝不静默当成用户拒绝** ✗✓。

## 工作区与沙箱

- 工作区默认 `~/.kylab/workspace` ✓（可用 `--workspace` 指定 ✓）；**系统目录一律拒绝** ✗
  （`_check_workspace` 挡 `C:\Windows`、`/etc`、`/usr` 这些 ✓）；
- 命令执行仍走既有两道闸 ✓（`sandbox.require_isolation` 默认**拒绝**裸跑 ✓ —— 这条不许绕 ✓）。
"""

from __future__ import annotations

import argparse
import json
import logging
import os
from collections.abc import Iterator, Sequence
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Literal
from uuid import uuid4

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.core.exceptions import NotFoundError
from app.services import agent_tools, plan_gate
from app.services import approvals as approval_service
from app.services.agent import ApprovalEvent, DeltaEvent, DoneEvent, StepEvent, ThinkingEvent
from app.services.api_key import Caller
from app.services.llm import ChatMessage, ToolSpec
from app.services.remote_clients import (
    RemoteClientError,
    RemoteKnowledgeClient,
    RemoteModelClient,
    RemoteUnavailableError,
)
from app.services.runtime_config import RuntimeConfigService
from app.services.tool_loop import ToolLoop
from app.storage.base import ARTIFACT_IN_OBJECTS, ConversationArtifactRecord

logger = logging.getLogger(__name__)

#: 惰性拿到的 httpx（**模块级不 import 它** ✗）。
_HTTPX: Any = None


def _httpx() -> Any:
    """惰性拿 httpx —— 既是"不进导入闭包"的手法，也是**用例的注入接缝** ✓。

    为什么模块级不 import：`httpx/__init__.py` 里那句 `from ._main import main`
    （它自带的 CLI 入口）会把 `click` + `pygments` + `rich` 一起拉进来 ✗ ——
    而客户端运行时（边车）只需要它"发请求"那一部分能力 ✓。
    实测：这一处不改，导入闭包里就一直挂着 click/pygments（约 5.5 MB ✗）。

    **行为不变**：缺包时仍在**第一次调用那一刻**抛 `ModuleNotFoundError` ✓
    （原先在导入模块那一刻抛 ✓）；判据见 `scripts/sidecar-closure.py`（重跑闭包 ✓）。

    **为什么是函数而不是散落的函数内 import**：用例要能换掉这一侧的传输
    （`monkeypatch.setattr(sidecar, "_httpx", …)` ✓）—— 散着写 import，测试就只能去改
    真模块的全局属性 ✗（那种 patch 会漏、也会互相干扰）。
    """
    global _HTTPX
    if _HTTPX is None:
        import httpx

        _HTTPX = httpx
    return _HTTPX


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

    def get(
        self, workspace_id: str, *, user_id: str | None = None, any_device: bool = False
    ) -> Any:
        # **签名要跟着真服务走** ✗（2026-09-30 踩过）：v0.59 起 `get` 多了设备那一维 ✓，
        # 而 `resolve_roots` 是**服务器与边车共用**的那段代码 ✓ —— 这里少一个关键字
        # 参数，边车里每一次"按工作区读文件"都会 TypeError ✓，表现成工具
        # `outcome: failed`（用例：`test_turn_really_runs_a_tool_in_the_local_workspace` ✓）。
        # 边车只有一个本机目录 ✓，两维都没有可判的东西 ✓ —— 收了参数就照旧返回它 ✓。
        return SimpleNamespace(root_path=str(self._root))


#: 产出物上传到服务器文件区的超时（秒）。导出本身是本地计算，这一步是**网络**：
#: 给够但别无限等——交付失败要**如实报**（见 `_LocalArtifacts`）。
ARTIFACT_UPLOAD_TIMEOUT_SECONDS = 20.0

#: 建笔记的超时（秒）：一次 POST，比上传小得多；同样"失败要如实报"（见 `_LocalNotes`）。
NOTES_TIMEOUT_SECONDS = 10.0


class _LocalArtifacts:
    """产出物的落点（边车侧）：**本地写一份 + 上传到服务器的会话文件区** ✓。

    为什么要有它（2026-09-30，实测到的能力差）：导出那一族原来整族不在
    `SIDECAR_TOOL_NAMES` 里（当时的理由："要 PG 与对象存储，服务器权威" ✗）——
    于是**同一句"生成 sales.xlsx"，网页（服务器跑）交得了、桌面（本机跑）交不了** ✗：
    模型要么回"要跑命令才能落盘"（命令又被隔离闸挡着），要么把数据贴在正文里。

    服务器那边确实不需要本机有 PG ✓：它有一个"往会话文件区放一份文件"的上传口
    （`POST /conversations/{id}/files`，multipart，回 `art_*` 键 ✓）。所以这里的做法是：
    **本地生成**（`office.py`，运行时就带着 ✓）→ **上传**拿键 ✓ → 记录里的 `id`/`location`
    用那个键 ✓ —— UI 的预览/下载走服务器**既有的**那条路 ✓。本机再留一份是附赠
    （用户打开工作区就看得见 ✓）。

    上传失败**如实抛**（`RemoteUnavailableError` ✓）：工具会把它报成一次失败，
    而不是"假装交付了" ✗ —— 与写回那一轮是同一条纪律 ✓。
    """

    def __init__(self, *, clients: Clients, workspace: Path) -> None:
        self._clients = clients
        self._workspace = workspace

    def save(
        self,
        *,
        conversation_id: str,
        filename: str,
        content: bytes,
        kind: str,
        owner_id: str | None = None,
    ) -> ConversationArtifactRecord:
        key, name = self._upload(conversation_id, filename, content)
        self._write_local(name, content)
        return ConversationArtifactRecord(
            id=key,
            conversation_id=conversation_id,
            name=name,
            format=kind,
            size_bytes=len(content),
            # 权威的那一份在服务器的会话文件区（本机那份是附赠）→ 标签按"本会话"算 ✓，
            # 与服务器侧"没挂工作区就落对象存储"是同一支 ✓。
            storage=ARTIFACT_IN_OBJECTS,
            location=key,
            owner_id=owner_id,
        )

    def read_file(self, conversation_id: str, path: str) -> tuple[bytes, str]:
        """边车侧**不读会话文件区**（权威那份在服务器的对象存储里）——如实抛 ✓。

        `_ingest_file` 对这个异常的处理正是"不在文件区 → 落回文件面"（它 catch KylabError），
        所以这里一句话就把"把服务器文件区的产物入知识库"的路让给了**本机那条**：
        产物在本机留过副本（见 `_write_local`），常见诉求（"把刚才生成的那份放进库"）
        给个文件名就能在文件面命中 ✓。
        """
        raise NotFoundError(
            f"边车这一侧不读会话文件区（{path}）——本机文件请给工作区里的相对路径"
        )

    def label_for(self, record: ConversationArtifactRecord) -> str:
        """给用户看的那句话（与 `ArtifactService.label_for` 的对象存储那一支同口径 ✓）。"""
        return "本会话"

    def describe(self, record: ConversationArtifactRecord) -> dict[str, object]:
        """给界面用的那份形状（与 `ArtifactService.describe` 的对象存储那一支逐字一致 ✓）。"""
        return {
            "artifact_id": record.id,
            "name": record.name,
            "size_bytes": record.size_bytes,
            "format": record.format,
            "storage": record.storage,
            "where": self.label_for(record),
        }

    def _upload(self, conversation_id: str, filename: str, content: bytes) -> tuple[str, str]:
        url = f"{self._clients.base_url}/conversations/{conversation_id}/files"
        try:
            response = _httpx().post(
                url,
                headers={"Authorization": f"Bearer {self._clients.token}"},
                files={"file": (filename, content)},
                timeout=ARTIFACT_UPLOAD_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
            payload = response.json()
        except Exception as error:  # httpx 的各种失败 + 回包解析不了，都算"没交出去"
            raise RemoteUnavailableError(f"产出物没能交付到对话（{url}）：{error}") from error
        key = str((payload or {}).get("key") or "")
        if not key:
            raise RemoteUnavailableError(f"产出物没能交付到对话（{url}）：服务器没有回文件键")
        return key, str((payload or {}).get("name") or filename)

    def _write_local(self, name: str, content: bytes) -> None:
        """本地那份**只取文件名**（不认子路径、不许 `..`）：写坏工作区比少一份附赠文件糟 ✗。"""
        safe = Path(name.replace("\\", "/")).name
        if not safe or safe in {".", ".."}:
            return
        try:
            self._workspace.mkdir(parents=True, exist_ok=True)
            (self._workspace / safe).write_bytes(content)
        except OSError:
            # 本机这份是附赠：写不进去**不**让整次交付失败（服务器那份才是权威 ✓）
            return


class _LocalNotes:
    """笔记的落点（边车侧）：**转发到服务器的笔记库** ✓（与产出物那条同一套做法）。

    为什么要有它（2026-10-01，与导出同一批）：笔记是**服务器权威**的数据（要 PG ✗），
    所以 `create_note` 原来不在 `SIDECAR_TOOL_NAMES` 里 —— 桌面（本机跑）说"帮我记一条笔记"
    交不了，网页却交得了 ✗。服务器有现成的 `POST /api/v1/notes` ✓，于是这里只做**转发**：
    **本地不留副本**（笔记本来就该在服务器上——界面那页笔记也是从那儿列的 ✓）。
    """

    def __init__(self, *, clients: Clients) -> None:
        self._clients = clients

    def create(
        self,
        *,
        user_id: str | None = None,
        title: str,
        content_md: str,
        source_kind: str = "manual",
        source_ref: str | None = None,
        tags: list[str] | None = None,
        folder_id: str | None = None,
    ) -> Any:
        """建一条笔记。`user_id` 收下但**不用**：归属由服务器按这把钥匙算 ✓（与服务器同源）。"""
        payload: dict[str, Any] = {
            "title": title,
            "content_md": content_md,
            "source_kind": source_kind,
        }
        if source_ref:
            payload["source_ref"] = source_ref
        if tags:
            payload["tags"] = [str(item) for item in tags]
        if folder_id:
            payload["folder_id"] = folder_id

        url = f"{self._clients.base_url}/notes"
        try:
            response = _httpx().post(
                url,
                headers={"Authorization": f"Bearer {self._clients.token}"},
                json=payload,
                timeout=NOTES_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
            body = response.json()
        except Exception as error:  # httpx 的各种失败 + 回包解析不了，都算"没记上"
            raise RemoteUnavailableError(f"笔记没能存到服务器（{url}）：{error}") from error
        return SimpleNamespace(
            id=str((body or {}).get("id") or ""),
            title=str((body or {}).get("title") or title),
        )

    def attach_to_kb(
        self,
        note_id: str,
        *,
        user_id: str | None = None,
        kb_id: str,
    ) -> Any:
        """把一条笔记作为 Markdown 文档入某个知识库（`POST /notes/{id}/attach` ✓）。

        与 `create` 同一条纪律：**只转发、本地不留副本、失败如实抛** ✓。
        权限（这把钥匙对那个库有没有写权限）在服务器那一侧判 ✓（见 `_ApiKeySeam`）——
        本地没有库与账号的权威数据，不重做一遍 ✗。
        """
        url = f"{self._clients.base_url}/notes/{note_id}/attach"
        try:
            response = _httpx().post(
                url,
                headers={"Authorization": f"Bearer {self._clients.token}"},
                json={"kb_id": kb_id},
                timeout=NOTES_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
            body = response.json()
        except Exception as error:  # 同 `create`：连不上、被拒、回包看不懂，都算"没入上"
            raise RemoteUnavailableError(f"笔记没能入到知识库（{url}）：{error}") from error
        return SimpleNamespace(
            id=str((body or {}).get("id") or note_id),
            doc_id=(body or {}).get("doc_id"),
            kb_id=(body or {}).get("kb_id") or kb_id,
        )

    def list(
        self,
        *,
        user_id: str | None = None,
        query: str | None = None,
        limit: int | None = None,
    ) -> Any:
        """列笔记（`GET /notes` ✓）；返回 `(items, total)`——形状对齐 `_list_notes` 的读法。

        两处翻译（服务器的列表契约与工具期望不同，各写一句免得后人重踩）：
        - 列表项**不带正文**（`NoteListItemOut.content_md` 是空串 ✗），而工具的 `excerpt`
          直接读 `content_md[:200]` —— 所以把服务器算好的 `preview` 放进 `content_md`
          （语义等价、还省得边车再截一遍 ✓）；
        - `updated_at` 是 ISO 字符串，而工具调 `.isoformat()` —— 还原成 `datetime` ✓
          （`Z` 后缀 Python 3.11+ 的 `fromisoformat` 认 ✓）。
        """
        params: dict[str, Any] = {}
        if query:
            params["q"] = str(query)
        if limit:
            params["limit"] = int(limit)
        url = f"{self._clients.base_url}/notes"
        try:
            response = _httpx().get(
                url,
                headers={"Authorization": f"Bearer {self._clients.token}"},
                params=params,
                timeout=NOTES_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
            body = response.json()
        except Exception as error:  # 连不上、被拒、回包解析不了，都算"没取到"
            raise RemoteUnavailableError(f"笔记列表没能取到（{url}）：{error}") from error
        items = []
        for raw in (body or {}).get("items") or []:
            if not isinstance(raw, dict):
                continue
            updated: Any = raw.get("updated_at")
            if isinstance(updated, str) and updated:
                try:
                    updated = datetime.fromisoformat(updated)
                except ValueError:
                    updated = None
            items.append(
                SimpleNamespace(
                    id=str(raw.get("id") or ""),
                    title=str(raw.get("title") or ""),
                    content_md=str(raw.get("preview") or ""),
                    tags=[str(item) for item in raw.get("tags") or []],
                    doc_id=raw.get("doc_id"),
                    source_kind=str(raw.get("source_kind") or "manual"),
                    updated_at=updated,
                )
            )
        return items, int((body or {}).get("total") or len(items))


class _LocalMemory:
    """记忆的落点（边车侧）：**转发到服务器的记忆** ✓（与 `_LocalNotes` 同一套做法）。

    为什么要有它（2026-10-01）：`recall` / `remember` 原来不在 `SIDECAR_TOOL_NAMES` 里
    （"记忆要数据目录，服务器权威" ✗）——于是"记住我偏好 X / 我们上次怎么定的"在网页
    交得了、桌面交不了 ✗。native 之后记忆是服务器数据目录里的 Markdown ✓，
    REST 口现成（`POST /memory/recall` / `POST /memory/remember` ✓），这里只做**转发**：
    **本地不留副本**（记忆本来就该在服务器上——界面那页记忆也从那儿读 ✓）。
    失败**如实抛**（`RemoteUnavailableError` ✓，与笔记两件同一条纪律 ✓）。

    `enabled` **恒 True**：开关的权威在服务器那一侧 ✓（关着时 recall 端点**明确报错**、
    不返回空结果——见 `api/v1/memory.py` 模块头 §2.3）；边车判不了就不动 ✓
    （与 `_memory_on` 的"判不了就不隐藏"同一条哲学 ✓）。
    """

    enabled = True

    def __init__(self, *, clients: Clients) -> None:
        self._clients = clients

    def recall(
        self, query: str, *, limit: int | None = None, user_id: str | None = None
    ) -> Any:
        """召回。`user_id` 收下但**不用**：归属由服务器按这把钥匙算 ✓（与笔记同源）。

        返回 `(hits, links)` 两个列表（形状对齐 `tools.py::_recall` 的读法 ✓）——
        两个方向的转发共用 `_post` ✓。
        """
        payload: dict[str, Any] = {"query": query}
        if limit:
            payload["limit"] = int(limit)
        body = self._post("/memory/recall", payload, what="召回记忆")
        hits = [
            SimpleNamespace(
                text=str(item.get("text") or ""),
                path=str(item.get("path") or ""),
                start_line=item.get("start_line"),
                end_line=item.get("end_line"),
                score=item.get("score"),
            )
            for item in (body.get("hits") or [])
            if isinstance(item, dict)
        ]
        links = [
            SimpleNamespace(
                path=str(item.get("path") or ""),
                name=str(item.get("name") or ""),
                direction=str(item.get("direction") or ""),
            )
            for item in (body.get("links") or [])
            if isinstance(item, dict)
        ]
        return hits, links

    def remember(
        self,
        content: str,
        *,
        tags: list[str] | None = None,
        user_id: str | None = None,
    ) -> Any:
        """记一条。返回服务器那份 `{saved, entries, reason}` ✓（工具按 `saved` 判重复 ✓）。"""
        body = self._post(
            "/memory/remember",
            {"content": content, "tags": [str(item) for item in (tags or [])]},
            what="写入记忆",
        )
        return {
            "saved": bool(body.get("saved")),
            "entries": int(body.get("entries") or 0),
            "reason": str(body.get("reason") or ""),
        }

    def _post(self, path: str, payload: dict[str, Any], *, what: str) -> dict[str, Any]:
        url = f"{self._clients.base_url}{path}"
        try:
            response = _httpx().post(
                url,
                headers={"Authorization": f"Bearer {self._clients.token}"},
                json=payload,
                timeout=NOTES_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
            body = response.json()
        except Exception as error:  # 连不上、被拒、回包解析不了，都算"没走通"
            raise RemoteUnavailableError(f"{what}没能走通（{url}）：{error}") from error
        return body if isinstance(body, dict) else {}


class _LocalIngest:
    """知识库入库的落点（边车侧）：**上传到服务器的知识库** ✓（`ingest_file` 用）。

    为什么要有它（2026-10-01）：`ingest_file`（"把我这台机器上的某份文件放进知识库"）
    原来不在边车里（"要 PG 与对象存储" ✗）——但服务器「上传文档」REST 口现成
    （`POST /knowledge-bases/{kb_id}/documents`，multipart ✓，`start=true` 默认立即入队 ✓），
    而**文件的字节恰恰在边车这一侧**（本机文件是桌面端的主场 ✓）。所以：
    **边车读本机 → 上传**——与导出那一族"本地生成 → 上传"同一个方向 ✓
    （`_LocalArtifacts` 的姊妹件）。

    响应形状对齐 `services.ingest.submit` 的最小读法（`outcome.document.id` /
    `outcome.document.name` / `outcome.is_duplicate`）——`_ingest_file` 的执行体逐字复用 ✓。
    """

    def __init__(self, *, clients: Clients) -> None:
        self._clients = clients

    def submit(
        self,
        *,
        knowledge_base_id: str,
        filename: str,
        content: bytes,
        uploaded_by: str | None = None,
    ) -> Any:
        """`uploaded_by` 收下但**不用**：是谁传的由服务器按这把钥匙算 ✓（与笔记同源）。"""
        url = f"{self._clients.base_url}/knowledge-bases/{knowledge_base_id}/documents"
        try:
            response = _httpx().post(
                url,
                headers={"Authorization": f"Bearer {self._clients.token}"},
                files={"file": (filename, content)},
                timeout=ARTIFACT_UPLOAD_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
            payload = response.json()
        except Exception as error:  # 连不上、被拒、回包解析不了，都算"没入上"
            raise RemoteUnavailableError(f"文件没能入到知识库（{url}）：{error}") from error
        doc = (payload or {}).get("document") or {}
        doc_id = str(doc.get("id") or "")
        if not doc_id:
            raise RemoteUnavailableError(f"文件没能入到知识库（{url}）：服务器没有回文档 id")
        return SimpleNamespace(
            document=SimpleNamespace(id=doc_id, name=str(doc.get("name") or filename)),
            is_duplicate=bool((payload or {}).get("is_duplicate")),
        )


class _UploadedDocuments:
    """`documents.enqueue_ingest` 的边车版：**空操作** ✓。

    为什么能空：`_ingest_file` 的"非重复才入队"判断与服务器 `upload_document` 逐字同源，
    而那个 REST 口带 `start=true` 时**自己已经入队**（见 `api/v1/documents.py` 里那处
    `enqueue_ingest` 调用）——边车再喊一次就是**重复入队**（会把同一份文档的摄取任务
    重排一遍 ✗）。所以这里如实"不重做" ✓。
    """

    def enqueue_ingest(self, document_id: str) -> Any:
        return SimpleNamespace(id=None)


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
        artifacts: Any,
        notes: Any,
        memory: Any,
        ingest: Any,
        documents: Any,
    ) -> None:
        self.runtime = runtime
        self.approvals = approvals
        self.workspace = workspace
        self.artifacts = artifacts
        self.notes = notes
        self.memory = memory
        self.ingest = ingest
        self.documents = documents
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
#: - 技能两件**如实回空** ✓（`list_skills` 会说"这台机器上还没有安装技能" ✓）；
#: - **导出三件**（2026-09-30 起 ✓）：产出物**本地生成、上传到服务器的会话文件区**
#:   （见 `_LocalArtifacts` ✓）——这是"要一份文件"那一类请求在**桌面与本机跑**的链上
#:   唯一缺过的一环：同一句"生成 sales.xlsx"，网页（服务器跑）交得了、桌面交不了 ✓。
#: - **笔记三件**（`create_note` / `attach_note_to_kb` / `list_notes` 2026-10-01 ✓）：
#:   笔记**转发到服务器**（见 `_LocalNotes` ✓）——与导出同一类问题："帮我记一条笔记"
#:   在网页交得了、桌面交不了 ✓；"把它加进知识库（能检索到）"是同一件事的第二步 ✓；
#:   "看看我记过什么"（`list_notes`）是第三步 ✓。
#: - **记忆两件**（`recall` / `remember` 2026-10-01 ✓）：转发到服务器的记忆
#:   （见 `_LocalMemory` ✓）——"记住我偏好 X / 我们上次怎么定的"同一类问题 ✓。
#:   `read_memory` / `write_memory`（改人设文件那两个）**仍留给 P4** ✗：它们要
#:   服务器数据目录里的记忆文件，边车够不着 ✓。
#: - **`ingest_file`**（2026-10-01 ✓）：**边车读本机 → 上传进知识库**（见 `_LocalIngest` ✓）——
#:   "把我这台机器上的某份文件放进库"本来只差一个上传口；字节恰好在这侧 ✓。
#:   受库开关门控（`_LOCAL_KB_TOOLS`：对话里没选库就不摆 ✓，与 `attach_note_to_kb` 同口径）。
#:
#: 表格读取（`list_tables` / `query_table` 要服务器侧的结构化副本与 SQL 面）/ 定时
#: 要 PG 与对象存储（服务器权威 ✗）→ 仍**留给 P4** ✓。
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
        "export_document",
        "export_table",
        "export_deck",
        "create_note",
        "attach_note_to_kb",
        "list_notes",
        "recall",
        "remember",
        "ingest_file",
    }
)


#: 边车这一侧的**最小**系统提示词（**不是**服务器那一份 ✗）。
#:
#: 服务器那份要 `Services`（知识库范围、技能目录、人设、记忆 ✓），边车这一轮没有那些 ✓；
#: 但**必须有一句"直接动手"** ✗ —— 真烟测实测（2026-09-29）：没有它时模型回的是
#: 「我先读一下这个文件。」**一个工具都没调** ✗，于是"工具真的执行"在真模型上根本不发生 ✓。
#: 完整提示词与 P4 的会话口径一起接 ✓。
#:
#: **交付口那一句（2026-09-30 加）**：导出三件在工具表里之后，不点名它照样不用 ✗——
#: 实测同一句"生成 sales.xlsx"（表里已有 export_table）它仍回"要跑命令才能落盘"，
#: 而服务器那份提示词里对等的第 10 条是**点名**的 ✓。"网页交得了、桌面交不了"，
#: 差的就是这一句。
#:
#: **"缺素材按已知写"半句（2026-09-30 同批加）**：点名交付口之后仍有一次失败 ——
#: 一句"做一份 3 页 PPT"（原句，没别的提示）它**先去工作区翻素材**（搜文件、列目录、
#: 试图读一份 docx、最后 `run_command unzip` 撞上执行闸），整轮**没交付** ✗。
#: 把同一句改成"直接用你已知的知识写、不需要翻文件"就一次到位 ✓ —— 差的正是这半句。
#:
#: **"笔记两件"半句（2026-10-01 加）**：与交付口同一课——`create_note` 进了工具表，
#: 不点名它模型仍然想不到（"记笔记"是一件服务器上的事，它默认自己够不着 ✗）；
#: `attach_note_to_kb` 是同一句话的第二步（"记下来 → 以后 `search` 搜得到"），
#: 但它**受库开关门控**（`_KB_TOOLS`：对话里没选知识库时它根本不在表里 ✗）——
#: 所以那半句带前提（"对话里选了知识库时"）。实测（2026-10-01 L1 验收）：
#: 无条件点名时，没选库的会话里模型会花半段回答解释"我这里没有这个工具" ✗。
#:
#: **"记忆两件"半句（2026-10-01 同批加）**：同一课——`recall` / `remember` 进了工具表，
#: 不点名时模型会把"帮我记住 X"往 `create_note` 上带 ✗（"记住"听起来像记一条东西），
#: 或者干脆说这台机器上没有记忆 ✗。它们不受库开关门控（受记忆开关，边车侧判不了 →
#: 恒摆 ✓，见 `_LocalMemory`）——所以这半句**不带前提** ✓。
SIDECAR_SYSTEM_PROMPT = (
    "你是这台电脑上的本地 Agent。**需要本机信息时（读文件、列目录、搜文件、跑命令、查网页）"
    "必须先调用对应工具**：list_files / read_file / search_files / run_command / "
    "web_search / web_fetch（技能用 list_skills / read_skill）——"
    "**不许只用文字描述你将要做什么** ✗（「我这就去读」「我马上跑」都算没做）。"
    "拿到工具结果之后再作答。"
    "**对方要一份文件时**（「给我一份」「发我个 .docx / .xlsx」「能下载的」）**用交付口**："
    "export_document（正文类）/ export_table（表格）/ export_deck（幻灯）——"
    "文件会挂到对话里、他点一下就能拿到；**只把内容贴在正文里不算交付** ✗。"
    "**留档用 `create_note`**（存进对方的笔记列表，服务器上能看到）；"
    "**对话里选了知识库时，再调 `attach_note_to_kb` 让笔记能被检索到**——"
    "**这两个都不是交付**：对方要的是文件时仍然走交付口 ✗。"
    "**对方让你「记住」的偏好与约定用 `remember`**（之后每轮对话都会带上）、"
    "**翻过去的结论用 `recall`**——这两件是**长期记忆**，别用 `create_note` 顶 ✗。"
    "**缺素材就按你已知的写**，不要为了找素材去翻文件 / 扫盘 / 跑命令 ✗ ——"
    "先把东西交出去，再问他要不要按真实口径改。"
    "工具报错或被拒绝时**如实转述**（连同理由），不要假装成功、也不要编结果；"
    "本机没有你要的工具时**直说没有**，不要编造。"
    "回答用简体中文。"
)


def _sse(payload: dict[str, Any]) -> str:
    """一条 SSE 事件。**形状与服务器那条链逐字一致** ✓（见 `api/v1/chat.py` 模块头那五行）：

    ``data: {"type":"step",…}`` / ``{"type":"thinking","text":…}`` / ``{"type":"delta","text":…}``
    / ``{"type":"done","answer":…}`` / ``{"type":"error","message":…}`` ✓
    —— 前端解析那一侧**同一套** ✓，所以这里**不另创形状** ✗（也不带 `seq`：边车这一侧没有会话
    事件日志，没有可补发的地方 ✓）。
    """
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


#: SSE 的媒体类型（与服务器/壳那侧同一口径 ✓）。
SSE_MEDIA_TYPE = "text/event-stream"


def _close_trailing_answer_step(steps: list[dict[str, Any]]) -> None:
    """把"回答"那一步收尾成 `done` ✓（**就地改** `steps`）。

    为什么（2026-09-29 烟测）：`tool_loop` **从不给"组织回答"这一步发 `done`**（服务器那条链路
    靠前端收敛 ✓）——所以 `/turn` 的响应里它一直是 `status:"running"` ✗，调用方会以为
    "还在跑" ✗。而 `/turn` 是**一次请求一次答复**：返回时这一轮**已经结束** ✓，
    所以这里把最后那一步如实收掉 ✓。只动边车这一侧的响应形状 ✗，循环本体一个字不改 ✓。
    """
    for step in reversed(steps):
        if step["phase"] == "answer":
            step["status"] = "done"
            return


def _step_payload(event: StepEvent) -> dict[str, Any]:
    """`StepEvent` → 响应里的 dict ✓（字段与服务器那条链路同一套名字 ✓）。

    **产出物要带出去**（2026-09-30，与导出三件同一批）：导出类工具把文件挂在
    `event.artifacts` 上，界面靠它画那张"点一下就能拿到"的卡片 —— 原来这里没抄这个字段 ✗，
    于是边车交付的文件在对话里**看得见结果、点不到卡片** ✗（服务器侧那份 `snapshot` 是带的 ✓）。
    `kind`（图标）/ `degraded`（降级横幅）/ `added`（资料条数）同理，一并对齐 ✓。
    """
    return {
        "phase": event.phase,
        "label": event.label,
        "detail": event.detail,
        "status": event.status,
        "tool": event.tool,
        "outcome": event.outcome,
        "args": event.args,
        "result": event.result,
        **({"kind": event.kind} if event.kind else {}),
        **({"degraded": True} if event.degraded else {}),
        **({"added": event.added} if event.added is not None else {}),
        **({"artifacts": [dict(item) for item in event.artifacts]} if event.artifacts else {}),
    }


def _approval_payload(event: ApprovalEvent) -> dict[str, Any]:
    """一条待确认 → SSE 载荷（字段与**服务器那条链逐字对齐** ✓）。

    照 `api/v1/chat.py` 那段 `{"type": "approval", …}` ✓：`approval_id` / `tool` / `label` /
    `args` / `detail` / `rule` / `timeout_seconds` ✓ —— 界面那三个按钮（允许一次 / 这类都允许 /
    拒绝）与"这类都允许会写下哪条规则"全都靠这几个字段 ✓，少一个就得在前端另做推断 ✗。

    **不是"过程里的一步"** ✗：过程快照记的是"这一轮做过什么"，而这是一句**还没被回答**的问题 ✓
    （服务器那条链也是这么分的 ✓）。所以它**不进 `steps`** ✗ —— 进了就会跟着这一轮写回服务器，
    用户回看历史时会冒出一条永远等不到人点的确认 ✗。
    """
    return {
        "approval_id": event.approval_id,
        "tool": event.tool,
        "label": event.label,
        "args": event.args,
        "detail": event.detail,
        "rule": event.rule,
        "timeout_seconds": event.timeout_seconds,
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
        #: 用户会话令牌：**写回那一轮**要用它（`POST /chat/turns/record` ✓ require_write ✓）。
        #: 两个远端客户端各自也拿了一份 ✓，这里存一份是为了让"写回"这件事不用绕路 ✓。
        self.token = token
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
        #: 产出物的落点（导出那一族借它交付：本地生成 → 上传到会话文件区，见 `_LocalArtifacts` ✓）。
        self.artifacts = _LocalArtifacts(clients=self, workspace=workspace)
        #: 笔记的落点（`create_note` 借它转发到服务器的笔记库，见 `_LocalNotes` ✓）。
        self.notes = _LocalNotes(clients=self)
        #: 记忆的落点（`recall` / `remember` 借它转发到服务器的记忆，见 `_LocalMemory` ✓）。
        self.memory = _LocalMemory(clients=self)
        #: 入库的落点（`ingest_file` 借它把**本机文件**上传进服务器的知识库，见 `_LocalIngest` ✓）。
        self.ingest = _LocalIngest(clients=self)
        #: `documents` 的边车版：上传口已入队，enqueue_ingest 空操作（见 `_UploadedDocuments`）。
        self.documents = _UploadedDocuments()
        #: `build_runner` 眼里 `Services` 是**鸭子类型** ✓ → 给一份"本地真的有的"影子 ✓。
        self.services = LocalServices(
            runtime=self.runtime,
            approvals=self.approvals,
            knowledge=self.knowledge,
            workspace=workspace,
            artifacts=self.artifacts,
            notes=self.notes,
            memory=self.memory,
            ingest=self.ingest,
            documents=self.documents,
        )

    def tool_specs(self, *, kb_ids: Sequence[str] = ()) -> list[ToolSpec]:
        """这一轮摆给模型的工具：**只摆本地真能服务的那些** ✓（见 `SIDECAR_TOOL_NAMES`）。"""
        scope = [str(item) for item in kb_ids if str(item).strip()]
        specs = agent_tools.tool_specs(self.services, owner_id=None, kb_ids=scope or None)
        return [spec for spec in specs if spec.name in SIDECAR_TOOL_NAMES]

    def tool_loop(
        self,
        *,
        kb_ids: Sequence[str] = (),
        #: 这一轮归属的会话：**导出那一族要靠它**（产出物上传到 `/conversations/{id}/files` ✓）。
        #: 没带会话 id 的老调用方落回 `LOCAL_CONVERSATION`（那时候导出会如实报"没有会话" ✓）。
        conversation_id: str = LOCAL_CONVERSATION,
        #: **这一轮有没有"问用户"的通道** ✓。
        #:
        #: - `True`（默认，`/turn/stream` 用 ✓）：`ask` 档走到"要问"时**发一条 `type=approval`**
        #:   并停下来等人 ✓ —— 这一侧唯一的通道就是 SSE 那条流 ✓，所以只有流式那条路配它 ✓；
        #: - `False`（`/turn` 用 ✗）：整段响应发不出一句询问 ✗（调用方拿到响应前不知道
        #:   `approval_id` ✓）→ 交给循环的 `UNAVAILABLE` 那条路 ✓，回给模型的是"待确认" ✓。
        interactive: bool = True,
    ) -> ToolLoop:
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
            conversation_id=conversation_id,
        )
        return ToolLoop(
            client_factory=lambda: self.model,
            tools=self.tool_specs(kb_ids=kb_ids),
            runner=runner,
            # **通道就是这一件事**：登记表非空 → 循环走到"要问"时发事件、停下来等人 ✓；
            # 为空 → 直接按 `UNAVAILABLE` 回"待确认" ✓（**绝不静默当成用户拒绝** ✗）。
            # 复用**同一个** `ApprovalRegistry`（`Clients.__init__` 那份 ✓）——它是
            # `POST /turn/approvals/{id}` 与正在等它的那一步之间的唯一交接点 ✓，不另造一套 ✗。
            approvals=self.approvals if interactive else None,
            mode=self.runtime.get("chat.mode"),
            permission=self.runtime.get("chat.permission"),
            gate=plan_gate.gate_for(LOCAL_CONVERSATION),
        )


def build_clients(
    base_url: str, token: str, *, workspace: Path, data_dir: Path
) -> Clients:
    """唯一的装配处 ✓（方案 §4：`if` 只允许出现在这里）。"""
    return Clients(base_url, token, workspace=workspace, data_dir=data_dir)


class HistoryIn(BaseModel):
    """历史里的一条（与前端 `ChatHistoryMessage` 同形 ✓：`role` + `content` ✓）。"""

    role: str = Field(description="user 或 assistant（其它角色一律忽略 ✓）")
    content: str = ""


#: 历史条数的**硬上限**：前端已经截过一次（最近 20 条 ✓），这里是服务端侧的兜底 ✓ ——
#: 别让"把整个会话灌进来"这件事靠调用方自觉 ✗（提示词预算是有限的 ✓）。
MAX_HISTORY_MESSAGES = 20


class TurnIn(BaseModel):
    """一条用户消息（**为 SSE 留位**：`stream` 打开时走 `text/event-stream` ✓）。"""

    message: str = Field(min_length=1, max_length=32_000)
    workspace: str | None = Field(default=None, description="留空用默认工作区（用户目录下）")
    kb_ids: list[str] = Field(
        default_factory=list,
        description="这一轮允许查的库；**留空 = 知识库关着** ✓（与服务器同口径 ✓）",
    )
    history: list[HistoryIn] = Field(
        default_factory=list,
        description=(
            "最近的对话历史（**可选，默认空 = 行为与以前完全一样** ✓）。"
            "为什么要有它：服务器那条链以**库里的历史**为准 ✓；边车这一侧没有库 ✗，"
            "前端不把最近几条带上，切到边车的那一轮就是**失忆的一轮** ✗（用户会立刻感觉到"
            "『它忘了上文』，而界面看不出来 ✗）。只取最近 `MAX_HISTORY_MESSAGES` 条 ✓。"
        ),
    )
    stream: bool = Field(default=False, description="预留：P4 与前端一起做 SSE ✓")
    conversation_id: str = Field(
        default="",
        description=(
            "这一轮归属的会话（**可选，默认空**）。空 = **不写回服务器** ✓ —— 但要在 `notes` 里"
            "如实说明「未带会话 id，本轮未写回」✗（**不许静默丢** ✓：会话是服务器权威，"
            "没写回的这一轮刷新后就没了 ✓）。"
        ),
    )
    turn_id: str = Field(
        default="",
        description=(
            "这一轮的**幂等键**（可选，默认空 = 边车自己生成 uuid4 ✓）。"
            "**同一轮重试必须复用同一个** ✓（否则服务器会当成两轮 ✗）；"
            "服务器那边「标记与两条消息同一事务」✓，所以跨重启也幂等 ✓。"
        ),
    )


def _messages_of(payload: TurnIn) -> list[ChatMessage]:
    """`TurnIn` → 循环要的消息（**顺序**：system → 历史 → 本轮 user ✓）。

    两处与服务器那条链刻意对齐 ✓：
    - 历史放在 system 之后、本轮 user 之前 ✓（顺序错了模型会把历史当"新指令" ✗）；
    - **只认 `user` / `assistant` 两个角色** ✓ —— 别让调用方从这里塞进第二条 system ✗
      （那等于绕过我们这条链的提示词 ✓）。
    """
    messages = [ChatMessage(role="system", content=SIDECAR_SYSTEM_PROMPT)]
    for item in payload.history[-MAX_HISTORY_MESSAGES:]:
        if item.role not in ("user", "assistant") or not item.content.strip():
            continue
        messages.append(ChatMessage(role=item.role, content=item.content))
    messages.append(ChatMessage(role="user", content=payload.message))
    return messages


class TurnOut(BaseModel):
    """回答 + 本轮步骤（`steps` 现在是 `ToolLoop` 真的产出的 ✓）+ 如实说明 ✓。"""

    answer: str
    steps: list[dict[str, Any]] = Field(default_factory=list)
    workspace: str
    notes: list[str] = Field(default_factory=list, description="这一侧有什么/没有什么（如实写 ✓）")
    sse: bool = Field(default=False, description="预留：true 时可用 /turn/stream 取 SSE ✓")
    turn_id: str = Field(default="", description="这一轮的幂等键（写回服务器时用它 ✓）")
    recorded: bool | None = Field(
        default=None,
        description=(
            "写回服务器的结果：`True` 已入库 ✓ / `False` 写回失败 ✗ / `None` 没写回"
            "（例如请求没带 `conversation_id` ✓）。"
            "**它不影响 `answer`** ✗ —— 写回失败时答案照旧返回，原因写在 `notes` 里 ✓。"
        ),
    )
    error: str = Field(
        default="",
        description=(
            "非空 = **这一轮没有正常作答**（可判定的标记 ✓）：远端不可用/被拒、或模型没产出正文。"
            "**空 `answer` 绝不等于成功** ✗ —— 调用方据此区分「成功」与「空」✓。"
        ),
    )


class HealthOut(BaseModel):
    """**如实报**两端可达性 ✗（不许假装健康 ✓）。"""

    version: str
    workspace: str
    kb_reachable: bool
    model_reachable: bool
    note: str = ""


class ApprovalDecisionIn(BaseModel):
    """界面在确认条上点的那一下（形状与服务器 `ChatApprovalIn` **逐字对齐** ✓）。

    **只有三个取值** ✓，都是用户明确点出来的：允许一次 / 这类都允许 / 拒绝 ✓。
    "超时"与"这条链路没人可问"**不是请求参数** ✗ —— 它们是执行侧自己的结论 ✓
    （能从外面伪造就等于开了一条绕过"等用户点头"的路 ✗，见 `services/approvals.py`）。
    """

    decision: Literal["allow_once", "allow_always", "deny"] = Field(
        description="允许一次 / 这类都允许（写进放行清单）/ 拒绝"
    )
    reason: str = Field(
        default="",
        max_length=500,
        description="拒绝时给模型的一句话（可空 ✓）；空 = 与没有这个输入框时一字不差 ✓",
    )


class ApprovalDecisionOut(BaseModel):
    """决定有没有真的交到**正在等它的那一步** ✓（照服务器 `ChatApprovalOut` ✓）。"""

    accepted: bool = Field(description="true = 那一头已经收到它，会立刻接着往下跑 ✓")
    detail: str = Field(default="", description="给人看的一句话 ✓")


#: 写回那一轮的**超时上限**（秒）。刻意给得短：用户已经拿到答案了 ✓，
#: 写回是**记账**不是作答 ✗ —— 让他为一个记账再等十几秒是错的 ✓，失败就如实报 ✓。
RECORD_TIMEOUT_SECONDS = 8.0


def _record_turn(
    clients: Clients,
    *,
    conversation_id: str,
    turn_id: str,
    question: str,
    answer: str,
    steps: list[dict[str, Any]],
    thinking: str,
) -> tuple[bool | None, str]:
    """把这一轮写回服务器（**best-effort** ✓）。返回 ``(recorded, 原因)``。

    三条铁律（派单钉的 ✓）：

    1. **写回失败绝不许影响回答** ✗ —— 调用方拿到的是 `answer` 与这里返回的原因，
       `answer` 原样返回 ✓（原因进 `notes` / SSE 的 note 步 ✓）；
    2. **超时要克制** ✓（`RECORD_TIMEOUT_SECONDS` = 8 秒，**不重试** ✗）——
       重试是服务器那侧的事：`turn_id` 是幂等键 ✓，真要重试由调用方带着**同一个**
       `turn_id` 再来一轮 ✓；
    3. **没带 `conversation_id` 就跳过** ✓，但**必须说明** ✗（静默丢一轮 = 数据丢失 ✓）。

    `recorded=False` 是**幂等命中**（服务器已有这条 `turn_id` ✓），**不是失败** ✓。
    """
    if not conversation_id:
        return None, (
            "未带会话 id（conversation_id），本轮**未写回**服务器"
            "（刷新后这一轮不会留在会话里）"
        )
    # httpx **按需导入**（P4-3）：`httpx/__init__.py` 会顺带拖进 click + pygments + rich ✗，
    # 而客户端运行时只在"真要写回一轮"时才需要它 ✓。行为不变：缺包仍在**调用的那一刻**报错 ✓。
    # 走 `_httpx()` 这个**可注入接缝**：用例 monkeypatch 它就能换掉这一侧的传输 ✓。
    httpx = _httpx()

    url = f"{clients.base_url}/chat/turns/record"
    body = {
        "conversation_id": conversation_id,
        "turn_id": turn_id,
        "question": question,
        "answer": answer,
        "steps": steps,
        "thinking": thinking,
    }
    try:
        response = httpx.post(
            url,
            json=body,
            headers={"Authorization": f"Bearer {clients.token}"},
            timeout=RECORD_TIMEOUT_SECONDS,
        )
    except httpx.HTTPError as exc:
        return False, f"写回服务器失败（这一轮已跑完，答案不受影响）：{type(exc).__name__}: {exc}"
    if response.status_code >= 400:
        return False, (
            f"写回服务器失败（这一轮已跑完，答案不受影响）：HTTP {response.status_code} "
            f"{response.text[:200]}"
        )
    try:
        payload = response.json()
    except ValueError:
        payload = {}
    recorded = bool(payload.get("recorded", True)) if isinstance(payload, dict) else True
    if not recorded:
        # 幂等命中：服务器已经有这个 turn_id 了 ✓ —— 对用户无感，只留一条 debug 痕迹 ✓
        logger.debug("这一轮已写回过（幂等命中）：turn_id=%s", turn_id)
        return False, ""
    return True, ""


def _probe_health(url: str, timeout: float = 5.0) -> tuple[bool, str]:
    """探活 → ``(可达?, 说明)`` ✓ —— **失败原因必须带出来** ✗（P3 烟测抓到：吞成 False ✗）。

    烟测现场：`/health` 说"后端不可达" ✗，可**同一份 base/token** 的 `/turn` 却成功了 ✓ ——
    探针把原因吞了，于是"不可达"三个字既不可信、也没法排障 ✗。现在分两类如实报：

    - **网络层不可达**（连不上/超时/DNS）→ 带上异常原文 ✓；
    - **端点答了但不是 2xx** → 带上**状态码 + 正文前 200 字** ✓（那条才是真正要看的 ✓）。
    """
    httpx = _httpx()  # 按需导入 + 可注入接缝（理由见 `_httpx()` 的说明）

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

    # **壳的页面要跨源直连边车**（2026-09-30 实测补上）：界面从 `http://app.localhost`
    # （自定义 scheme 在 Windows 上的映射，见 `resources.rs::app_url`）调本机边车，
    # 浏览器先做 CORS 预检——不挂这个中间件时 `fetch` 直接 `TypeError: Failed to fetch`，
    # `resolveTurnTarget()` 于是**永远回退到服务器**：页面上只留一条 console.warn，
    # "对话在本机跑"就这么静默地从来没生效过（服务端日志里能看到工具循环还在服务器上跑）。
    # 只放行三个源（壳 + vite dev 的两种写法）：别的源照旧读不到响应。
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://app.localhost",
            "http://localhost:5173",
            "http://127.0.0.1:5173",
        ],
        allow_methods=["*"],
        allow_headers=["*"],
    )

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
        # **非流式这条没有通道**（`interactive=False` ✓）：响应是**整段**回来的，
        # 询问发不出去（调用方在拿到响应之前根本不知道 `approval_id` ✗）→ 让人等 120 秒
        # 是白等 ✓。所以按"这条链路上没人可以问"走 `UNAVAILABLE` ✓ —— 回给模型的是
        # "待确认"，**不是**"用户拒绝了" ✗（分档见 `services/approvals.py` 模块头 ✓）。
        # 要真正弹确认条就用 `/turn/stream` ✓（它把询问当成一条 SSE 发出去 ✓）。
        loop = clients.tool_loop(
            kb_ids=payload.kb_ids,
            conversation_id=payload.conversation_id or LOCAL_CONVERSATION,
            interactive=False,
        )
        messages = _messages_of(payload)
        answer = ""
        steps: list[dict[str, Any]] = []
        reasoning: list[str] = []
        try:
            for event in loop.run(messages=messages):
                if isinstance(event, StepEvent):
                    steps.append(_step_payload(event))
                elif isinstance(event, DeltaEvent):
                    answer += event.text
                elif isinstance(event, ThinkingEvent):
                    # 思考过程收着**只为解释"为什么一个字都没有"** ✓——它不进 `answer` ✗：
                    # 那是模型的思考，不是给用户的回答 ✓。
                    reasoning.append(event.text)
                elif isinstance(event, DoneEvent):
                    # 收尾那条带的是拼好的全文，**以它为准** ✓（个别增量丢了也不会与步骤对不上 ✓）
                    answer = event.answer or answer
                elif isinstance(event, ApprovalEvent):
                    # 这条路上**没有通道**（`interactive=False` ✓）→ 循环不会走到这里 ✗。
                    # 真出现了就说明"通道接上了而这条链路没接" ✗ —— 如实记一条 step（不吞 ✗），
                    # 因为静默丢掉一句"要用户点头"的询问，用户看到的就是"命令被拒" ✗。
                    steps.append(
                        {
                            "phase": "tool",
                            "label": f"待确认：{event.label}",
                            "detail": (
                                f"{event.args}（非流式这条没有确认通道："
                                f"要弹确认条请用 /turn/stream ✓）"
                            ),
                            "status": "done",
                            "tool": event.tool,
                            "outcome": "awaiting",
                            "args": event.args,
                            "result": "",
                        }
                    )
        except RemoteClientError as exc:
            # **失败分档照旧** ✓：远端不可用/被拒都要如实说出来 ✗（不当成"空回答" ✓）
            return TurnOut(
                answer=f"（边车报告：{exc}）",
                workspace=str(target),
                notes=notes,
                error=str(exc),
            )
        _close_trailing_answer_step(steps)
        # **写回这一轮**（best-effort ✓）：跑在本机、账在服务器 ✓。
        # 失败**绝不影响回答** ✗ —— 原因进 `notes`，`answer` 原样返回 ✓。
        turn_id = payload.turn_id or uuid4().hex
        recorded, why = _record_turn(
            clients,
            conversation_id=payload.conversation_id,
            turn_id=turn_id,
            question=payload.message,
            answer=answer,
            steps=steps,
            thinking="".join(reasoning),
        )
        if why:
            notes = [*notes, why]
        if not answer.strip():
            # **绝不返回"空成功"** ✗✗（2026-09-29 烟测现场：`answer:""` + `steps:[]` + HTTP 200 ✓
            # 是这条链路里最危险的形态 ✗ —— 调用方以为成功 ✓、用户拿到空白 ✓）。
            # 两种成因都要写清：模型只给了思考（推理模型常见 ✓）、或者什么都没给 ✓。
            detail = (
                f"模型只返回了思考过程、没有正文与工具调用（思考 {len(reasoning)} 段）"
                if reasoning
                else "模型没有返回任何内容"
            )
            hint = (
                "这一轮没有执行任何工具。要本机动作就把要读/要跑的东西说具体些再试；"
                "本机没有隔离后端时命令会被拒绝，拒绝原因会写在回答里。"
            )
            return TurnOut(
                answer=f"（边车报告：{detail}。{hint}）",
                steps=steps,
                workspace=str(target),
                notes=notes,
                error=f"empty-answer: {detail}",
            )
        if not any(step["tool"] for step in steps):
            # 有正文但**一次工具都没调**（模型直接作答）：如实标出来 ✓ ——
            # 不许把"只宣布意图"当成"做了" ✗（从 notes 就看得出这一轮没有本机动作 ✓）。
            notes = [
                *notes,
                "这一轮没有调用任何工具（模型直接作答；需要本机动作时请把要求说得更具体）。",
            ]
        return TurnOut(
            answer=answer,
            steps=steps,
            workspace=str(target),
            notes=notes,
            turn_id=turn_id,
            recorded=recorded,
        )

    @app.post("/turn/stream", summary="走一轮（SSE：步骤 / 思考 / 正文增量 / 收尾 / 失败）")
    def turn_stream(payload: TurnIn) -> StreamingResponse:
        """与 `/turn` **同一个循环、同一套语义** ✓，只是把过程**边跑边发** ✓。

        为什么要有它（P4 前置）：前端对话是**流式**的 ✓（服务器那条 `/api/v1/chat` 就是 SSE ✓）；
        边车这一侧不先把流做实 ✗，前端切过来就会**丢流** ✗（整段等完才出字 ✓ 体验断档）。

        事件形状**照服务器那条链**（`api/v1/chat.py` 模块头那五行 ✓，逐条对齐 ✗ 不另创 ✓）::

            data: {"type":"step", phase,label,detail,status,tool,outcome,args,result}
            data: {"type":"thinking","text":"…"}
            data: {"type":"delta","text":"…"}
            data: {"type":"approval", approval_id,tool,label,args,detail,rule,timeout_seconds}
            data: {"type":"done","answer":"…"}
            data: {"type":"error","message":"…"}

        `approval` 那一条是**要用户点头**的询问 ✓（v0.41）：发出去之后这一轮的循环就停在
        `ApprovalRegistry.wait_decision` 上 ✓，等 `POST /turn/approvals/{approval_id}` 那一下 ✓。
        所以它必须**原样、立刻**发出去 ✗（攒着不发 = 两边一起等死 ✓）。

        护栏与 `/turn` **一字不差** ✓：
        - **正文为空绝不当成功** ✗✗ → 先发 `error`（`empty-answer: …` ✓）再发 `done`（如实说明 ✓）；
        - 远端不可用/被拒 → `error` + 如实的 `answer` ✓（不当成"空回答" ✗）；
        - `done.answer` 与流出去的 `delta` 拼起来的是**同一份** ✓（前端兜底不会与增量打架 ✓）。

        与 `/turn` 唯一有意的差别：`/turn` 末尾会往 `notes` 里加一句"这一轮没有调用任何工具" ✗，
        流式这条路**不加** ✓ —— 那件事在事件流里**本来就看得见**（一个 `tool` 步都没发过 ✓），
        再塞一句反而要发明一个形状 ✗（`done` 只有 `answer` ✓）。
        """

        def gen() -> Iterator[str]:
            target = _check_workspace(payload.workspace) if payload.workspace else workspace
            loop = clients.tool_loop(
                kb_ids=payload.kb_ids,
                conversation_id=payload.conversation_id or LOCAL_CONVERSATION,
            )
            messages = _messages_of(payload)
            answer = ""
            steps: list[dict[str, Any]] = []
            reasoning: list[str] = []
            try:
                for event in loop.run(messages=messages):
                    if isinstance(event, StepEvent):
                        step = _step_payload(event)
                        steps.append(step)
                        yield _sse({"type": "step", **step})
                    elif isinstance(event, DeltaEvent):
                        # **边到边发** ✓：这里不做任何缓冲/攒批 ✗（攒了就等于没做流式 ✓）
                        answer += event.text
                        yield _sse({"type": "delta", "text": event.text})
                    elif isinstance(event, ThinkingEvent):
                        # 思考也照发 ✓（前端的过程面板用它 ✓）；但它**不进 `answer`** ✗
                        reasoning.append(event.text)
                        yield _sse({"type": "thinking", "text": event.text})
                    elif isinstance(event, DoneEvent):
                        # 收尾那条带拼好的全文，**以它为准** ✓（与 `/turn` 同一口径 ✓）
                        answer = event.answer or answer
                    elif isinstance(event, ApprovalEvent):
                        # **问用户**（v0.41）：这一条发出去之后，循环那边就停在
                        # `approvals.wait_decision` 上了 ✓ —— 所以必须**原样、立刻**发出去 ✗
                        # （攒着不发 = 两边一起等死 ✓，见 `services/approvals.py` 模块头第 1 条）。
                        #
                        # **不进 `steps`** ✗：这是一句还没被回答的问题，不是"做过的一步" ✓
                        # （服务器那条链同样把它排除在快照之外 ✓）。
                        yield _sse({"type": "approval", **_approval_payload(event)})
            except RemoteClientError as exc:
                # **失败如实报** ✗（分档照旧：不可用 / 被拒 ✓，不伪装成空回答 ✓）
                yield _sse({"type": "error", "message": str(exc)})
                yield _sse({"type": "done", "answer": f"（边车报告：{exc}）"})
                return

            # 收尾那一步要**再发一次**：它先前以 `running` 出去过 ✓，而循环从不给它 `done` ✗
            #（与 `/turn` 同一个 `_close_trailing_answer_step` ✓）—— 不发这一次，
            # 前端会一直显示"正在组织回答" ✗，而这一轮其实已经结束了 ✓。
            before = [dict(step) for step in steps]
            _close_trailing_answer_step(steps)
            for old, new in zip(before, steps, strict=True):
                if old != new:
                    yield _sse({"type": "step", **new})

            # **写回这一轮**（best-effort ✓）：失败绝不影响已经流出去的答案 ✗ ——
            # 用一条 `phase="note"` 的 step 如实说出来 ✓（不发明新的 `type` ✗：
            # 事件形状照服务器那条链的五个 `type` ✓）。
            turn_id = payload.turn_id or uuid4().hex
            recorded, why = _record_turn(
                clients,
                conversation_id=payload.conversation_id,
                turn_id=turn_id,
                question=payload.message,
                answer=answer,
                steps=steps,
                thinking="".join(reasoning),
            )
            if why:
                yield _sse(
                    {
                        "type": "step",
                        "phase": "note",
                        "label": "写回服务器",
                        "detail": why,
                        "status": "done",
                        "tool": "",
                        "outcome": "recorded" if recorded else "not-recorded",
                        "args": "",
                        "result": turn_id,
                    }
                )

            if not answer.strip():
                # **绝不发"空成功"的 done** ✗✗（与 `/turn` 同一段判据与同一套措辞 ✓）
                detail = (
                    f"模型只返回了思考过程、没有正文与工具调用（思考 {len(reasoning)} 段）"
                    if reasoning
                    else "模型没有返回任何内容"
                )
                hint = (
                    "这一轮没有执行任何工具。要本机动作就把要读/要跑的东西说具体些再试；"
                    "本机没有隔离后端时命令会被拒绝，拒绝原因会写在回答里。"
                )
                yield _sse({"type": "error", "message": f"empty-answer: {detail}"})
                yield _sse({"type": "done", "answer": f"（边车报告：{detail}。{hint}）"})
                return

            del target  # 工作区已在校验时定下 ✓（响应里不再回它：流式的载荷形状照服务器那条链 ✓）
            yield _sse({"type": "done", "answer": answer})
        return StreamingResponse(gen(), media_type=SSE_MEDIA_TYPE)

    @app.post(
        "/turn/approvals/{approval_id}",
        response_model=ApprovalDecisionOut,
        summary="对一条待确认做出决定（允许一次 / 这类都允许 / 拒绝）",
    )
    def decide_turn_approval(approval_id: str, payload: ApprovalDecisionIn) -> ApprovalDecisionOut:
        """把界面点的那一下，交给**正在等它的那一步** ✓（v0.41 同一套语义 ✓）。

        与 `/turn/stream` 的关系就是这条协议的全部要点：那条流**还开着**、停在
        `ApprovalRegistry.wait_decision` 上 ✓（见 `services/approvals.py` 模块头），
        这一条请求只是把决定送回它手里 ✓。所以**不另造一套** ✗：登记表与判定都复用
        `clients.approvals`（`Clients.__init__` 里那一份 ✓，`tool_loop` 拿的也是它 ✓）。

        两处口径与**服务器那条链逐条对齐**（`api/v1/chat.py` 的 `decide_approval` ✓）：

        - **送到了** → `accepted=true` ✓；
        - **已经失效**（超时 / 已经点过一次）→ **409** ✗，而不是回一句"已记录" ✓ ——
          否则用户以为命令跑了 ✗，而那一头其实早按超时处理完了 ✓（同一个登记表的
          `decide` 就是靠"条目还在、还没过期"来回答这件事的 ✓）。

        鉴权：边车**只监听本机** ✓（`--host` 默认 127.0.0.1 ✓），能打到这个端口的就是
        这台机器的主人 ✓ —— 与服务器那条要 `require_admin` 的口径同源 ✓
        （服务器管的是"服务器上的执行" ✓，而这里执行的是**用户自己机器上**的命令 ✓）。
        """
        if not clients.approvals.decide(approval_id, payload.decision, payload.reason):
            raise HTTPException(
                status_code=409,
                detail=(
                    "这条确认已经失效了（可能等得太久超时了，或者已经点过一次）："
                    "那一轮会按「没有批准」继续，模型那边会收到这个结论。请让它再来一次。"
                ),
            )
        return ApprovalDecisionOut(accepted=True, detail="已经交给正在等它的那一步")

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
