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
- ✓ `POST /turn`：吃一条用户消息 → 走**模型这一端**（`RemoteModelClient.stream_events` ✓）
  → 返回 `{answer, steps, sse}` ✓；
- ✗ **本轮的 `/turn` 还没有执行工具** ✗：工具表要经 `agent_tools.build_runner`，
  而 `agent_tools.py:1314` 那条 KB 接缝此刻正被另一条 lane 改 ✓（方案里写明"接线是 P3"，
  按纪律我没碰它 ✗）→ **工具执行留在接线之后** ✓；响应结构已为它留位（`steps` 列表 ✓）；
- ✗ SSE 端点：结构留了位（`sse` 字段 + `text/event-stream` 的说明 ✓），端点本身 P4 与前端一起做 ✓。

## 工作区与沙箱

- 工作区默认 `~/.kylab/workspace` ✓（可用 `--workspace` 指定 ✓）；**系统目录一律拒绝** ✗
  （`_check_workspace` 挡 `C:\Windows`、`/etc`、`/usr` 这些 ✓）；
- 命令执行仍走既有两道闸 ✓（`sandbox.require_isolation` 默认**拒绝**裸跑 ✓ —— 这条不许绕 ✓）。
"""

from __future__ import annotations

import argparse
import os
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.services.llm import ChatMessage
from app.services.remote_clients import (
    RemoteClientError,
    RemoteKnowledgeClient,
    RemoteModelClient,
)

__all__ = ["SIDECAR_VERSION", "build_clients", "create_app", "default_workspace"]

SIDECAR_VERSION = "0.1.0"

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
    """**装配点**：边车模式下两端都是远端实现 ✓（服务器模式在 `core/services.py` ✓）。"""

    def __init__(self, base_url: str, token: str) -> None:
        self.base_url = base_url.rstrip("/")
        #: 打服务器自己的健康端点（探活很便宜，不占用模型的额度 ✓）
        self.health_url = self.base_url.rsplit("/api/v1", 1)[0] + "/api/v1/health"
        self.knowledge = RemoteKnowledgeClient(self.base_url, token=token)
        self.model = RemoteModelClient(self.base_url, token=token)


def build_clients(base_url: str, token: str) -> Clients:
    """唯一的装配处 ✓（方案 §4：`if` 只允许出现在这里）。"""
    return Clients(base_url, token)


class TurnIn(BaseModel):
    """一条用户消息（**为 SSE 留位**：`stream` 打开时走 `text/event-stream` ✓）。"""

    message: str = Field(min_length=1, max_length=32_000)
    workspace: str | None = Field(default=None, description="留空用默认工作区（用户目录下）")
    stream: bool = Field(default=False, description="预留：P4 与前端一起做 SSE ✓")


class TurnOut(BaseModel):
    """回答 + 本轮步骤摘要（`steps` 现在恒为空 ✓ —— 工具执行在接线之后 ✓）。"""

    answer: str
    steps: list[dict[str, Any]] = Field(default_factory=list)
    workspace: str
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


def create_app(base_url: str, token: str, workspace: Path) -> FastAPI:
    """造边车应用（入口只做参数解析与 `uvicorn.run` ✓，方便用例直接拿 app ✓）。"""
    clients = build_clients(base_url, token)
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

    @app.post("/turn", response_model=TurnOut, summary="走一轮（模型在远端；工具待接线）")
    def turn(payload: TurnIn) -> TurnOut:
        target = _check_workspace(payload.workspace) if payload.workspace else workspace
        messages = [ChatMessage(role="user", content=payload.message)]
        try:
            deltas = list(clients.model.stream_events(messages))
        except RemoteClientError as exc:
            # **失败分档照旧** ✓：远端不可用/被拒都要如实说出来 ✗（不当成"空回答" ✓）
            return TurnOut(answer=f"（边车报告：{exc}）", workspace=str(target))
        answer = "".join(delta.text for delta in deltas)
        return TurnOut(answer=answer, workspace=str(target))

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
    args = parser.parse_args(argv)

    workspace = _check_workspace(args.workspace)
    import uvicorn  # 局部导入：用例 import 本模块时不必拉起 uvicorn ✓

    uvicorn.run(create_app(args.server, args.token, workspace), host=args.host, port=args.port)


if __name__ == "__main__":
    main()
