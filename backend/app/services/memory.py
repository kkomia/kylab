"""长期记忆（v0.14，设计见 ``docs/记忆层设计-v0.1.md``）。

**两个池子不能混**（这是本模块存在的第一条理由）：记忆是"你说的"（无出处、可改、
高频写），文档知识库是"文献说的"（有出处、不该被改、原文为王）。混进同一次检索，
引用会脏、溯源会断。所以记忆召回是独立的一路（MCP 上是 `recall`，与 `search` 分开），
结果永不合并。

**分工**：ReMe 管文件与整理（捕获、四动作整合、wikilink 图谱、它自己的 BM25 检索），
本模块只是 KYLAB 的门面：

- ``recall`` → 转发给 ReMe 的 ``POST /search``（接口面见设计文档 §3.1）；
- ``remember`` → 写 ``MEMORY.md``，**不经过 ReMe**。理由：那是"核心长期记忆"这一层，
  按 QwenPaw/ReMe 的设计它就是**用户与 Agent 共编的普通文件**、
  且明确"不由自动流程覆盖"。我们直接维护它，于是**没有 ReMe 也能记住东西**；
- ``core_text`` → 供对话把 ``MEMORY.md`` 注入 system prompt（二期）。

**关着时一律明确报错，不返回空**：返回空会让模型以为"没有相关记忆"，
然后基于错误前提继续推理——那是比报错更坏的一种失败。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from app.core.exceptions import InvalidRequestError, UpstreamError
from app.services.runtime_config import RuntimeConfigService

__all__ = ["CORE_MEMORY_FILE", "SOUL_FILE", "MemoryHit", "MemoryService", "MemoryStatus"]

logger = logging.getLogger(__name__)

#: 核心长期记忆的文件名。**不进检索**，靠注入 system prompt 生效。
CORE_MEMORY_FILE = "MEMORY.md"

#: 人格文件。与记忆并列的第二类持久文件（见 ``soul_text`` 的说明）。
SOUL_FILE = "SOUL.md"

#: 一次召回最多取几条。与检索工具同一口径：给模型"够用"的几条，
#: 而不是它说要多少就给多少（上下文预算是有限的）。
MAX_RECALL = 20
DEFAULT_RECALL = 6

#: 调用 ReMe 的超时。它的检索是本地 BM25，正常在毫秒级；
#: 给到 10 秒是为了容忍首次索引建立，而不是为了容忍它卡死。
_TIMEOUT_SECONDS = 10.0

#: 新建 MEMORY.md 时的模板。frontmatter 里的 ``summary`` / ``read_when``
#: 是 ReMe 那一族的约定（给检索与注入用），照抄以免以后要迁移。
_TEMPLATE = """---
summary: "Agent 的核心长期记忆，由用户和 Agent 共同维护"
read_when:
  - 需要了解长期有效的用户偏好、重要决策、工具设置或经验教训
---

## 核心长期记忆

{entries}

## 工具设置

## 重要决策与经验
"""


@dataclass(frozen=True, slots=True)
class MemoryStatus:
    """记忆层的当前状态，给界面与健康检查用。"""

    enabled: bool
    base_url: str
    workspace: str
    core_file_exists: bool
    reachable: bool
    detail: str = ""


@dataclass(frozen=True, slots=True)
class MemoryHit:
    """一条召回结果。

    ``text`` 是 ReMe 给的片段原文；``path`` 是它在工作区里的相对路径——
    两者都保留，因为"这条记忆是从哪个文件来的"决定了用户能不能去改它。
    """

    text: str
    path: str = ""
    score: float | None = None


class MemoryService:
    """记忆的门面。**不持有任何 ReMe 的进程内状态**——它是另一个进程。"""

    def __init__(self, runtime: RuntimeConfigService, data_dir: Path) -> None:
        self._runtime = runtime
        self._data_dir = data_dir

    # ------------------------------------------------------------------ 配置

    @property
    def enabled(self) -> bool:
        return self._runtime.get_bool("memory.enabled")

    @property
    def base_url(self) -> str:
        return self._runtime.get("memory.base_url").rstrip("/")

    @property
    def workspace(self) -> Path:
        raw = (self._runtime.get("memory.workspace") or "memory").strip()
        return self._data_dir / raw

    @property
    def core_file(self) -> Path:
        return self.workspace / CORE_MEMORY_FILE

    def _require_enabled(self) -> None:
        if not self.enabled:
            raise InvalidRequestError(
                "未启用长期记忆。请在「设置 → 长期记忆」里打开，"
                "并让记忆服务（ReMe）在配置的地址上运行"
            )

    # ------------------------------------------------------------------ 读取

    def core_text(self) -> str:
        """``MEMORY.md`` 的正文（供注入 system prompt）。

        未启用或文件还不存在时返回空串——注入是"有就带上"，缺了不该让对话失败。
        """
        if not self.enabled:
            return ""
        try:
            return self.core_file.read_text(encoding="utf-8").strip()
        except OSError:
            return ""

    def soul_text(self) -> str:
        """``SOUL.md`` 的正文（人格，一句话说就是"你是谁"）。

        与 ``MEMORY.md`` 性质不同：那个记事实与偏好，这个定身份与准则。
        两条约定照抄 QwenPaw：**由 Agent 自己进化**，以及**改动要告知用户**
        （"这是你的灵魂，他们该知道"）——后一条是产品约定，写在设计文档里。
        """
        if not self.enabled:
            return ""
        try:
            return (self.workspace / SOUL_FILE).read_text(encoding="utf-8").strip()
        except OSError:
            return ""

    def prompt_block(self) -> str:
        """拼成注入 system prompt 的**一个块**；两者都空时返回空串。

        为什么要一起给、且各带一句出处说明：

        - 不标注来源的话，模型会把记忆当成**用户这一轮说的话**——那是两回事，
          记忆可能已经过时，而用户当下说的才是准的；
        - 人格与记忆分开写，模型才知道哪句是"该怎么说话"、哪句是"已知的事实"。
        """
        core = self.core_text()
        soul = self.soul_text()
        if not core and not soul:
            return ""
        parts: list[str] = []
        if soul:
            parts.append(f"【你的人格（SOUL.md，由你自己维护）】\n{soul}")
        if core:
            parts.append(
                "【长期记忆（MEMORY.md，来自过去的对话，可能已经过时；"
                f"与用户当前所说冲突时以用户当下为准）】\n{core}"
            )
        return "\n\n".join(parts)

    def status(self) -> MemoryStatus:
        """当前状态。**不做网络探测**（那是 ``probe`` 的事）——
        界面每次渲染都调它，不该顺手打一次远端。"""
        return MemoryStatus(
            enabled=self.enabled,
            base_url=self.base_url,
            workspace=str(self.workspace),
            core_file_exists=self.core_file.exists(),
            reachable=False,
            detail="" if self.enabled else "未启用",
        )

    def probe(self) -> MemoryStatus:
        """连通性检查：真的打一次记忆服务。供设置的「测试连接」用。"""
        base = self.status()
        if not self.enabled:
            return base
        try:
            payload = self._post("health_check", {})
        except (UpstreamError, InvalidRequestError) as exc:
            return MemoryStatus(**{**base.__dict__, "detail": str(exc)})
        return MemoryStatus(
            **{**base.__dict__, "reachable": True, "detail": f"服务正常：{_brief(payload)}"}
        )

    # ------------------------------------------------------------------ 召回

    def recall(self, query: str, *, limit: int | None = None) -> list[MemoryHit]:
        """在记忆里找回相关片段。**与文档检索是两条路**（见模块头）。"""
        self._require_enabled()
        text = query.strip()
        if not text:
            raise InvalidRequestError("缺少参数：query")
        count = max(1, min(int(limit or DEFAULT_RECALL), MAX_RECALL))

        payload = self._post("search", {"query": text, "limit": count})
        return _hits_of(payload)

    # ------------------------------------------------------------------ 记住

    def remember(self, content: str, *, tags: list[str] | None = None) -> dict[str, Any]:
        """把一条长期事实写进 ``MEMORY.md``。

        **按 QwenPaw/ReMe 的约定做合并去重**：它们在 MEMORY.md 的说明里明确
        "更新前先读取现有内容，保留用户或其他会话写入的有效信息，并合并去重"。
        不这么做的话，同一件事会被记很多遍，而记忆越长越不像记忆、越像日志。

        返回 ``added`` 让调用方知道是真写进去了还是本来就有——模型据此不必重复记。
        """
        self._require_enabled()
        text = " ".join(content.split()).strip()
        if not text:
            raise InvalidRequestError("缺少参数：content")
        if len(text) > 500:
            # 一条记忆该是一句可复用的事实，不是一篇文档。超长的应该存成笔记
            # （notes + 知识库那条路），否则 MEMORY.md 会被一篇长文撑爆，
            # 而它每轮都要注入上下文。
            raise InvalidRequestError(
                f"一条记忆最多 500 字（收到 {len(text)} 字）。"
                "更长的内容请用笔记：存成笔记再决定要不要加入知识库"
            )

        tag_text = "".join(f" #{tag.strip()}" for tag in (tags or []) if tag.strip())
        line = f"- {text}{tag_text}"

        entries = self._read_entries()
        if any(_normalize(item) == _normalize(line) for item in entries):
            return {
                "saved": False,
                "reason": "这条记忆已经存在，未重复写入",
                "entries": len(entries),
            }

        entries.append(line)
        self._write_entries(entries)
        return {"saved": True, "entries": len(entries)}

    # ------------------------------------------------------------------ 文件

    def _read_entries(self) -> list[str]:
        """读回「核心长期记忆」那一节里的条目（保持顺序与原文）。"""
        try:
            body = self.core_file.read_text(encoding="utf-8")
        except OSError:
            return []
        lines: list[str] = []
        inside = False
        for raw in body.splitlines():
            if raw.startswith("## "):
                inside = raw.strip() == "## 核心长期记忆"
                continue
            if inside and raw.strip().startswith("- "):
                lines.append(raw.strip())
        return lines

    def _write_entries(self, entries: list[str]) -> None:
        """整份重写。

        **只重建「核心长期记忆」那一节**：其余小节（工具设置、重要决策与经验）
        原样保留——它们可能有人手写的内容，重写整份文件会把它们抹掉。
        """
        try:
            body = self.core_file.read_text(encoding="utf-8")
        except OSError:
            body = _TEMPLATE.format(entries="")

        block = "\n".join(entries)
        if "## 核心长期记忆" in body:
            head, _, rest = body.partition("## 核心长期记忆")
            # 找到该节之后的下一个二级标题，中间的正文整体替换成新条目
            tail = rest
            marker = "\n## "
            index = tail.find(marker)
            tail_after = tail[index:] if index >= 0 else ""
            body = f"{head}## 核心长期记忆\n\n{block}\n{tail_after}"
            if not tail[1:].startswith("\n"):
                body = f"{head}## 核心长期记忆\n\n{block}\n"
        else:
            body = body.rstrip() + f"\n\n## 核心长期记忆\n\n{block}\n"

        self.workspace.mkdir(parents=True, exist_ok=True)
        self.core_file.write_text(body, encoding="utf-8")

    # ------------------------------------------------------------------ HTTP

    def _post(self, job: str, payload: dict[str, Any]) -> Any:
        """调记忆服务的一个 job。

        **接口面**：ReMe 的 ``http_service.py`` 里写的是
        ``self.service.post(f"/{job.name}", ...)``——也就是"每个 job 就是
        ``POST /<job 名>`` + JSON 请求体"（见设计文档 §3.1）。所以这里不需要
        一张路由表，job 名直接拼路径。
        """
        if not self.base_url:
            raise InvalidRequestError("没有配置记忆服务地址（设置 → 长期记忆）")
        url = f"{self.base_url}/{job}"
        try:
            response = httpx.post(url, json=payload, timeout=_TIMEOUT_SECONDS)
        except httpx.HTTPError as exc:
            raise UpstreamError(f"连不上记忆服务 {url}：{exc}") from exc
        if response.status_code >= 400:
            raise UpstreamError(
                f"记忆服务返回 {response.status_code}：{response.text[:200]}"
            )
        try:
            return response.json()
        except ValueError as exc:
            raise UpstreamError("记忆服务返回的不是 JSON") from exc


# --------------------------------------------------------------------- 解析


def _brief(payload: Any) -> str:
    text = str(payload)
    return text[:120]


def _normalize(line: str) -> str:
    """比"是不是同一条"时用的规范化形式：去掉标签与空白差异。

    只删标签（``#xxx``）不删正文——正文不同就是两条记忆，不该被当成重复。
    """
    body = line.lstrip("- ").split(" #")[0]
    return " ".join(body.split()).lower()


def _hits_of(payload: Any) -> list[MemoryHit]:
    """从记忆服务的返回里取出片段。

    **刻意容错**：ReMe 那侧的**响应 schema 我们还没钉死**（它的服务在缺 LLM Key 时
    起不来，本轮只钉到了路径）。所以这里做三件事而不是断言一个形状：

    1. 常见的信封（``data`` / ``result`` / ``results``）逐层剥开；
    2. 列表项按候选字段名取文本（``text`` / ``content`` / ``snippet`` / ``chunk``），
       取不到就跳过这一项；
    3. **一个都取不出来时抛出上游错误**，而不是返回空列表——
       返回空会让模型以为"记忆里没有"，而真实原因是我们没读懂它的返回。
       这条与"关着时明确报错"是同一条纪律。
    """
    body = payload
    for key in ("data", "result", "results", "payload"):
        if isinstance(body, dict) and key in body:
            body = body[key]
            break

    items: list[Any] = []
    found_list = False
    if isinstance(body, list):
        items = body
        found_list = True
    elif isinstance(body, dict):
        for key in ("results", "hits", "chunks", "items", "memories"):
            candidate = body.get(key)
            if isinstance(candidate, list):
                items = candidate
                found_list = True
                break

    hits: list[MemoryHit] = []
    for item in items:
        if isinstance(item, str):
            if item.strip():
                hits.append(MemoryHit(text=item.strip()))
            continue
        if not isinstance(item, dict):
            continue
        text = ""
        for key in ("text", "content", "snippet", "chunk", "body"):
            value = item.get(key)
            if isinstance(value, str) and value.strip():
                text = value.strip()
                break
        if not text:
            continue
        path = ""
        for key in ("path", "file", "file_path", "source"):
            value = item.get(key)
            if isinstance(value, str):
                path = value
                break
        score = None
        for key in ("score", "rrf_score", "relevance"):
            value = item.get(key)
            if isinstance(value, (int, float)):
                score = float(value)
                break
        hits.append(MemoryHit(text=text, path=path, score=score))

    if hits:
        return hits
    if items:
        # 有内容但一条都认不出来 = 我们没读懂它的返回，不是"没有记忆"
        raise UpstreamError(
            "记忆服务返回了内容，但没有认出其中的片段字段；"
            f"可能是它的响应格式变了（原始返回前 200 字：{_brief(payload)}）"
        )
    if not found_list and payload:
        # **认不出结构也要报错**：这一条是自我审查时补上的——
        # 只判"列表非空却认不出"会漏掉"整个返回都不是我们认识的样子"，
        # 那种情况会静默返回空列表，而模型会当成"记忆里没有"。
        raise UpstreamError(
            "记忆服务的返回结构与预期不符（找不到结果列表）；"
            f"原始返回前 200 字：{_brief(payload)}"
        )
    # 认出来了、而且是空的 = 真的没有相关记忆。这才是该返回空的情况。
    return []
