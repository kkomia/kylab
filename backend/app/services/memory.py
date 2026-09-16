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
- ``core_text`` → 供对话把 ``MEMORY.md`` 注入 system prompt（二期）；
- ``files`` / ``file_text`` / ``write_file`` / ``delete_file`` / ``graph`` → 三期的
  记忆页（浏览/编辑/看图谱）。这些**直接读写本地工作区**，理由写在
  ``services/memory_files.py`` 的模块头：看自己的文本文件不该先要求另一个进程活着。
  编辑后的索引由 ReMe 自己的文件守护追（实测：5 秒 debounce），**保存路径上不需要
  我们做什么**；``reindex`` 只是手动兜底。

**关着时一律明确报错，不返回空**：返回空会让模型以为"没有相关记忆"，
然后基于错误前提继续推理——那是比报错更坏的一种失败。
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from app.core.exceptions import InvalidRequestError, UpstreamError
from app.models.enums import TaskKind, TaskState
from app.services import memory_files
from app.services.memory_files import MemoryFile, MemoryFileDetail, MemoryGraph
from app.services.runtime_config import RuntimeConfigService
from app.storage.base import StoreBundle, TaskRecord

__all__ = [
    "CORE_MEMORY_FILE",
    "MAX_ENTRY_CHARS",
    "MAX_RECALL",
    "SOUL_FILE",
    "MemoryFile",
    "MemoryFileDetail",
    "MemoryGraph",
    "MemoryHit",
    "MemoryLink",
    "MemoryService",
    "MemoryStatus",
]

logger = logging.getLogger(__name__)

#: 核心长期记忆的文件名。**不进检索**，靠注入 system prompt 生效。
CORE_MEMORY_FILE = "MEMORY.md"

#: 人格文件。与记忆并列的第二类持久文件（见 ``soul_text`` 的说明）。
SOUL_FILE = "SOUL.md"

#: 一次召回最多取几条。与检索工具同一口径：给模型"够用"的几条，
#: 而不是它说要多少就给多少（上下文预算是有限的）。
MAX_RECALL = 20
DEFAULT_RECALL = 6

#: 捕获节流的默认值：每几个用户回合沉淀一次。
#: 5 是 ReMe/QwenPaw 的默认（见设计文档 §2.4），这里保持一致——
#: 换成别的数没有依据，而它有：那条默认值来自它们的实际使用经验。
DEFAULT_CAPTURE_EVERY = 5

#: 一条记忆的字数上限。**协议层与这里同源**（``api/v1/schemas.py`` 的
#: ``MemoryRememberIn`` 直接引这个常量）：写死两份的话，界面会先放行再被服务层拒，
#: 用户看到的是一句"请求不合法"，而不是"这条太长了，请存成笔记"。
MAX_ENTRY_CHARS = 500

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

    ``text`` 是 ReMe 给的片段原文；``path`` + 行号是它在工作区里的位置——
    保留位置是因为"这条记忆从哪个文件的哪一段来"决定了用户能不能去改它，
    也是"渐进式展开"的入口（先给片段，不够再按路径读全文）。
    """

    text: str
    path: str = ""
    start_line: int | None = None
    end_line: int | None = None
    score: float | None = None


@dataclass(frozen=True, slots=True)
class MemoryLink:
    """命中文档的邻接边（wikilink 图谱）。``direction`` 是 ``out`` / ``in``。"""

    path: str
    direction: str
    name: str = ""


class MemoryService:
    """记忆的门面。**不持有任何 ReMe 的进程内状态**——它是另一个进程。"""

    def __init__(
        self,
        runtime: RuntimeConfigService,
        data_dir: Path,
        *,
        stores: StoreBundle | None = None,
    ) -> None:
        self._runtime = runtime
        self._data_dir = data_dir
        #: 存储（可选）：**只有入队捕获任务时才需要**。不给它也能用——
        #: recall / remember / 注入都不碰数据库，测试与脚本因此可以轻量构造。
        self._stores = stores

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

    def recall(
        self, query: str, *, limit: int | None = None
    ) -> tuple[list[MemoryHit], list[MemoryLink]]:
        """在记忆里找回相关片段。**与文档检索是两条路**（见模块头）。

        返回（片段，邻接边）。带图谱是因为 ReMe 的召回本来就是"渐进式"的：
        先给最相关的片段，不够时按 wikilink 走到相关的记忆节点——
        这一步不额外花检索成本，它就在同一个响应里。
        """
        self._require_enabled()
        text = query.strip()
        if not text:
            raise InvalidRequestError("缺少参数：query")
        count = max(1, min(int(limit or DEFAULT_RECALL), MAX_RECALL))

        payload = self._post("search", {"query": text, "limit": count})
        return _hits_of(payload), _links_of(payload)

    # ------------------------------------------------------------------ 捕获

    def capture(self, messages: list[dict[str, str]], *, session_id: str) -> dict[str, Any]:
        """把一轮对话交给 ReMe 的 Auto-Memory 沉淀。

        **由 ReMe 决定记什么**，我们不在这里做二次筛选——它的规矩是
        "识别以后仍可能有用的事"（稳定偏好、项目背景与限制、已确认的决定及原因、
        当前进展与阻塞、可复用的流程），并且没有值得记的内容时**不产生空记忆**。
        我们替它筛一遍，只会把它判断得比它差。

        ``messages`` 每项要带 ``role`` 与 ``name``：ReMe 那侧收的是 agentscope 的
        ``Msg``，**缺 ``name`` 会被它的校验直接拒掉**（实测报
        ``1 validation error for Msg / name Field required``）。``name`` 就是
        "谁说的"，所以这里强制调用方给全，而不是替它编一个。

        ``session_id`` 是**溯源锚点**：ReMe 会把来源对话写成
        ``session/dialog/<session_id>.jsonl`` 并在记忆笔记里回链，
        这样"这条记忆是哪次对话来的"永远查得到。用我们的 conversation id 正好。
        """
        self._require_enabled()
        if not messages:
            raise InvalidRequestError("没有可沉淀的消息")
        for index, item in enumerate(messages):
            if not (item.get("role") and item.get("name") and item.get("content")):
                raise InvalidRequestError(
                    f"第 {index + 1} 条消息缺少 role / name / content"
                    "（记忆服务要求每条都标明是谁说的）"
                )
        if not session_id.strip():
            raise InvalidRequestError("缺少参数：session_id（记忆要靠它回溯来源对话）")

        payload = self._post(
            "auto_memory", {"messages": messages, "session_id": session_id}
        )
        meta = payload.get("metadata") if isinstance(payload, dict) else None
        meta = meta if isinstance(meta, dict) else {}
        return {
            "created": bool(meta.get("created")),
            "modified": bool(meta.get("modified")),
            # `answer` 是它给人类读的一句话（"记下了什么"），直接透出给日志与界面
            "summary": str(payload.get("answer") or "")[:300]
            if isinstance(payload, dict)
            else "",
            "path": str(meta.get("path") or ""),
            "messages": int(meta.get("n_messages") or 0),
        }

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
        if len(text) > MAX_ENTRY_CHARS:
            # 一条记忆该是一句可复用的事实，不是一篇文档。超长的应该存成笔记
            # （notes + 知识库那条路），否则 MEMORY.md 会被一篇长文撑爆，
            # 而它每轮都要注入上下文。
            raise InvalidRequestError(
                f"一条记忆最多 {MAX_ENTRY_CHARS} 字（收到 {len(text)} 字）。"
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

    def enqueue_capture(
        self, messages: list[dict[str, str]], *, session_id: str, turn_count: int
    ) -> bool:
        """按节流规则把一次沉淀排进队列；返回**是否真的入了队**。

        为什么必须有节流：ReMe 的设计是"每累计 5 个用户回合触发一次"，
        **但它的服务不管累计**（每次调用就是一次 LLM 调用）。每轮都沉淀
        等于每轮多花一次模型调用，而省 token 是这个项目反复强调的事。

        为什么放在服务层而不是调用方：它是"记忆怎么工作"的一部分。
        调用方只该提供"这是第几轮"，不该知道"每几轮一次"这个规则——
        规则散到调用方，界面入口和自动化入口就会各有一个阈值。

        节流不通过时**返回 False 而不是报错**：这不是失败，是设计如此。
        """
        if not self.enabled or self._stores is None:
            return False
        every = self._runtime.get_int("memory.capture_every") or DEFAULT_CAPTURE_EVERY
        every = max(1, every)
        if turn_count <= 0 or turn_count % every != 0:
            return False

        self._stores.meta.enqueue_task(
            TaskRecord(
                id=f"task_{uuid.uuid4().hex[:12]}",
                kind=TaskKind.MEMORY,
                state=TaskState.PENDING,
                payload={"messages": messages, "session_id": session_id},
            )
        )
        return True

    # ------------------------------------------------------------------ 文件
    #
    # 三期的浏览/编辑走**本地目录**（理由见 services/memory_files.py 的模块头）：
    # 这几个方法**不要求 ``memory.enabled``**——记忆关着的时候，用户依然该能打开
    # 自己的记忆文件看看写了什么、把不对的改掉。要求"先起一个服务才能读自己的文本
    # 文件"是没道理的。真正需要服务活着的只有召回与索引（``recall`` / ``reindex``）。

    def files(self) -> list[MemoryFile]:
        """列出工作区里的记忆文件（分类、摘要、出链、是否已整合）。"""
        return memory_files.scan(self.workspace)

    @property
    def scan_limit(self) -> int:
        """一次最多列多少个文件。界面要拿它判断"列表是不是被截断了"——
        截断了却不说，用户会以为"我的文件丢了"。"""
        return memory_files.MAX_LISTED_FILES

    def describe(self, path: str) -> MemoryFile:
        """单个文件的元信息（不含正文）。见 ``memory_files.describe``。"""
        return memory_files.describe(self.workspace, path)

    def file_text(self, path: str) -> MemoryFileDetail:
        """读一个文件的原文（含 frontmatter，供编辑器逐字还原）。"""
        return memory_files.read_file(self.workspace, path)

    def write_file(self, path: str, content: str) -> MemoryFileDetail:
        """写一个文件。

        **故意不在这里调 ``reindex``**：ReMe 自己有一组后台守护
        （``index_update_loop``，``watch_dirs: [daily_dir, digest_dir]``、
        ``force_polling`` + 5 秒 debounce），编辑会被它自动吃掉；
        而 ``reindex`` 的说明是 *without rescanning workspace files*——
        它只重建"已入库分片"的索引，**看不见刚新建的文件**。所以每次保存后调它
        既是多余的、又解决不了新文件的问题。要手动兜底时用 ``reindex``（界面上是
        那个按钮），而不是在保存路径上假装做了点什么。
        """
        return memory_files.write_file(self.workspace, path, content)

    def delete_file(self, path: str) -> None:
        """删一个文件。索引同上：交给 ReMe 的守护去追。"""
        memory_files.delete_file(self.workspace, path)

    def graph(self) -> MemoryGraph:
        """wikilink 图谱（本地算，见 ``memory_files.graph_of`` 的说明）。"""
        return memory_files.graph_of(self.files())

    def reindex(self) -> str:
        """请记忆服务重建索引，返回它给的一句话。

        这是**手动兜底**，不是保存流程的一环：守护进程只在服务活着的时候看文件，
        所以"服务没起时改了一批文件、后来才起"这类情况下索引可能是旧的
        （它启动时有 ``init_changes_step`` 做一次差量，但没覆盖到的就得手动来）。
        ``scope`` 默认 ``all``（它自己的默认值），我们不传。
        """
        self._require_enabled()
        return _brief(self._post("reindex", {}))

    # ------------------------------------------------------ 核心记忆的条目

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

    **真实形状**（实测得出，见设计文档 §3.2）::

        {"answer": "…给人读的文本…", "success": true,
         "metadata": {"results": [{"id","text","path","start_line","end_line",
                                   "scores": {"keyword": 2.72, "score": 2.72}}],
                      "link_expansion": {…}}}

    注意分数在 ``scores.score`` 里（不是顶层 ``score``），
    而结果列表在 ``metadata.results`` 里——这两个位置第一版都猜错了，
    是靠**真跑一遍服务**才纠正的（原先的容错解析会直接报"认不出结构"）。
    容错仍然保留：字段名多认几种，版本升级时不至于立刻断，
    但"整个返回都不认识"要报错而不是返回空。
    """
    body = _unwrap(payload)

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
        hits.append(
            MemoryHit(
                text=text,
                path=path,
                start_line=_int_or_none(item.get("start_line")),
                end_line=_int_or_none(item.get("end_line")),
                score=_score_of(item),
            )
        )

    if hits:
        return hits
    if items:
        raise UpstreamError(
            "记忆服务返回了内容，但没有认出其中的片段字段；"
            f"可能是它的响应格式变了（原始返回前 200 字：{_brief(payload)}）"
        )
    if not found_list and payload:
        raise UpstreamError(
            "记忆服务的返回结构与预期不符（找不到结果列表）；"
            f"原始返回前 200 字：{_brief(payload)}"
        )
    # 认出来了、而且是空的 = 真的没有相关记忆。这才是该返回空的情况。
    return []


def _links_of(payload: Any) -> list[MemoryLink]:
    """命中片段的邻接边（ReMe 的 ``metadata.link_expansion``）。

    结构是 ``{命中路径: {"outlinks": [{"path","meta":{"name"}}], "inlinks": [...]}}``。
    它是**免费附带的**：ReMe 在同一个响应里给了图谱，我们不额外花一次检索就能让
    模型"顺着链接走"。取不出来时返回空列表——图谱缺失不该让一次召回失败，
    片段本身已经够用了。
    """
    body = _unwrap(payload)
    if not isinstance(body, dict):
        return []
    expansion = body.get("link_expansion")
    if not isinstance(expansion, dict):
        return []

    links: list[MemoryLink] = []
    for _source, sides in expansion.items():
        if not isinstance(sides, dict):
            continue
        for key, direction in (("outlinks", "out"), ("inlinks", "in")):
            for edge in sides.get(key) or []:
                if not isinstance(edge, dict):
                    continue
                path = edge.get("path")
                if not isinstance(path, str) or not path:
                    continue
                meta = edge.get("meta") if isinstance(edge.get("meta"), dict) else {}
                name = meta.get("name")
                links.append(
                    MemoryLink(
                        path=path,
                        direction=direction,
                        name=name if isinstance(name, str) else "",
                    )
                )
    return links


def _unwrap(payload: Any) -> Any:
    """逐层剥开外层信封。

    ``metadata`` 是 ReMe 的实际信封（实测），其余几个是容错：它的版本之间
    换过字段名，多认几个不至于一升级就"召回到零条"。
    """
    body = payload
    for key in ("metadata", "data", "result", "payload"):
        if isinstance(body, dict) and isinstance(body.get(key), (dict, list)):
            body = body[key]
            break
    return body


def _int_or_none(value: Any) -> int | None:
    return int(value) if isinstance(value, (int, float)) else None


def _score_of(item: dict[str, Any]) -> float | None:
    """分数在 ``scores.score``（融合后的分）里；也认顶层 ``score``。"""
    scores = item.get("scores")
    if isinstance(scores, dict):
        for key in ("score", "rrf", "vector", "keyword"):
            value = scores.get(key)
            if isinstance(value, (int, float)):
                return float(value)
    for key in ("score", "rrf_score", "relevance"):
        value = item.get(key)
        if isinstance(value, (int, float)):
            return float(value)
    return None
