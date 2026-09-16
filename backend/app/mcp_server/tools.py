"""MCP 工具的装配与调用（M6 之后的独立里程碑 / T4.8）。

架构 §5 定的七个工具，加上 v0.12 为"个人 agent 读写知识库"补的四个（标注 +）。

| 工具 | 作用 |
|------|------|
| `list_knowledge_bases` | 有哪些库 |
| `create_knowledge_base` | 建库 |
| `upload_document` | 传文档（内容用 base64 传） |
| `add_data_source` | 挂 RSS / 网页订阅 |
| `search` | 检索（产品的主打能力） |
| `list_documents` + | 库里有哪些文档、处理到什么状态 |
| `get_document_status` | 文档处理到哪一步了 |
| `delete_document` | 删文档（进回收站） |
| `create_note` + | 把成果存成笔记 |
| `attach_note_to_kb` + | 把笔记加进知识库（"沉淀成果"的收口动作） |
| `list_notes` + | 列笔记，并标明哪些还没进知识库 |

**为什么补那两个笔记工具**：知识库此前只有"上传文件"这一个入口，
于是 agent 干完活之后无处安放——它没法把"刚整理出的结论"变成库里可检索的内容。
`create_note` + `attach_note_to_kb` 就是这条路的两个半步，与界面上手动
「存为笔记 → 加入知识库」走的是**同一条服务层链路**（不另开一条写文档的通道，
否则库里会出现两种来源、两种格式）。

**为什么工具实现在这里、而不在 stdio/HTTP 的入口里**：两种传输方式要暴露同一批
工具。写在入口里就得复制两份，而两份迟早会漂（一个加了字段另一个没加）。
这里只依赖服务层，入口只负责把它挂到各自的传输上。

**与协议层的分层关系**：`mcp_server/` 与 `api/` 平级——都是"把服务层暴露出去"的适配层，
所以同样不许出现 SQL 与业务规则（工程规范 §3.3 L1）。工具函数做的是
"参数校验 + 调服务 + 收成可序列化的形状"这三件事。

**关于返回值**：MCP 工具的结果要给 LLM 读，所以**不用 pydantic 模型**，
直接给 dict / list——模型不需要 schema，而多一层转换只多一处出错的地方。

**每个工具都必须带上调用者**（v0.12 起的收口）：``call_tool`` 的 ``caller``
是**必填关键字参数、没有默认值**——默认值一旦存在，"忘了传"就等于匿名放行，
而这类洞不会报错。作用域判定一律走 ``ApiKeyService``（``check_access`` /
``visible_kb_ids``），不在这里另写一套：两套判定必然相漂。
"""

from __future__ import annotations

import base64
import binascii
import logging
import uuid
from typing import Any

from app.core.exceptions import InvalidRequestError
from app.core.services import Services
from app.models.enums import DataSourceKind
from app.services.api_key import WRITE, Caller
from app.services.memory import DEFAULT_RECALL, MAX_RECALL

__all__ = ["TOOL_NAMES", "call_tool", "tool_definitions"]

logger = logging.getLogger(__name__)

#: 上传大小的上限。MCP 走的是进程间消息，塞一个 200MB 的 base64
#: 会把客户端与服务端一起拖住——所以这里比 HTTP 上传更保守。
MAX_UPLOAD_BYTES = 32 * 1024 * 1024

#: 检索条数上限：工具是给 Agent 用的，它通常只要"够回答"的几条。
MAX_TOP_K = 20

#: 列表类工具的每页条数上限。给模型一个上限而不是"它说要多少就给多少"：
#: 上下文预算是有限的，而 50 条已经够它判断"库里有没有我要的东西"。
MAX_NOTE_PAGE = 50
MAX_DOC_PAGE = 100
DEFAULT_DOC_PAGE = 30
#: 笔记摘录长度：正文可能很长，全量塞进上下文会把预算吃光。
#: 需要读全文时它应该换用检索或直接在界面上看。
NOTE_EXCERPT_CHARS = 200

TOOL_NAMES = (
    "list_knowledge_bases",
    "create_knowledge_base",
    "upload_document",
    "add_data_source",
    "search",
    "list_documents",
    "get_document_status",
    "delete_document",
    "create_note",
    "attach_note_to_kb",
    "list_notes",
    "recall",
    "remember",
)


def tool_definitions() -> list[dict[str, Any]]:
    """工具的 JSON Schema 定义（MCP 协议用它描述给客户端）。

    描述文案是**写给模型看的**，不是写给人看的：说清"什么时候该用"比
    说清"参数是什么"更重要——模型选错工具的代价比填错参数大得多。
    """
    return [
        {
            "name": "list_knowledge_bases",
            "description": (
                "列出所有知识库及其文档数。"
                "在检索之前先调它，确认要查哪个库——库里没有的东西检索不出来。"
            ),
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        },
        {
            "name": "create_knowledge_base",
            "description": "新建一个知识库。库之间相互隔离，检索时按库过滤。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "库名"},
                    "description": {"type": "string", "description": "可选说明"},
                },
                "required": ["name"],
                "additionalProperties": False,
            },
        },
        {
            "name": "upload_document",
            "description": (
                "把一份文档加进知识库。内容用 base64 编码。"
                "入库是异步的：拿到 document_id 后可用 get_document_status 查进度。"
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "knowledge_base_id": {"type": "string"},
                    "filename": {"type": "string", "description": "文件名，扩展名决定用哪个解析器"},
                    "content_base64": {"type": "string", "description": "文件内容的 base64"},
                },
                "required": ["knowledge_base_id", "filename", "content_base64"],
                "additionalProperties": False,
            },
        },
        {
            "name": "add_data_source",
            "description": (
                "给知识库挂一个会持续更新的来源（RSS 订阅或某个网页），"
                "之后内容会自动抓进来。**登记不会立刻抓取**。"
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "knowledge_base_id": {"type": "string"},
                    "kind": {"type": "string", "enum": ["rss", "html"]},
                    "url": {"type": "string"},
                    "name": {"type": "string"},
                },
                "required": ["knowledge_base_id", "kind", "url"],
                "additionalProperties": False,
            },
        },
        {
            "name": "search",
            "description": (
                "在知识库里检索原文片段。**这是本服务的主打能力**："
                "返回的是原文出处（含文档名与页码），不是生成的回答。"
                "需要一段连贯的话时用 REST 的 chat 接口，这个工具给的是依据。"
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "检索词，用自然语言即可"},
                    "knowledge_base_ids": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "在哪些库里查；留空则查全部",
                    },
                    "top_k": {"type": "integer", "minimum": 1, "maximum": MAX_TOP_K},
                },
                "required": ["query"],
                "additionalProperties": False,
            },
        },
        {
            "name": "get_document_status",
            "description": (
                "查一份文档处理到哪一步了。"
                "阶段依次是 uploaded → parsing → parsed → chunked → embedding → indexed。"
                "**只有 indexed 才可被检索到**。"
            ),
            "inputSchema": {
                "type": "object",
                "properties": {"document_id": {"type": "string"}},
                "required": ["document_id"],
                "additionalProperties": False,
            },
        },
        {
            "name": "delete_document",
            "description": (
                "删除一份文档。原文会进回收站保留 7 天，切块与向量立即清除——"
                "所以删除后**立刻搜不到**了。"
            ),
            "inputSchema": {
                "type": "object",
                "properties": {"document_id": {"type": "string"}},
                "required": ["document_id"],
                "additionalProperties": False,
            },
        },
        {
            "name": "list_documents",
            "description": (
                "列出某个知识库里的文档及其处理状态。"
                "**想确认「这个库里到底有什么」时用它**——search 只返回与问题相关的片段，"
                "看不出库的全貌。可按文件名片段过滤。"
                "只有 searchable 为 true 的文档能被检索到。"
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "knowledge_base_id": {"type": "string"},
                    "query": {"type": "string", "description": "按文件名片段过滤，可留空"},
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": MAX_DOC_PAGE,
                        "description": f"最多返回几条，默认 {DEFAULT_DOC_PAGE}",
                    },
                },
                "required": ["knowledge_base_id"],
                "additionalProperties": False,
            },
        },
        {
            "name": "create_note",
            "description": (
                "把一段成果保存成笔记（Markdown）。**这是「把对话结论沉淀下来」的第一步**，"
                "但笔记此时还不在知识库里、检索不到；要能被检索，再调 attach_note_to_kb。"
                "适合保存：整理出的结论、待办与决定、可复用的流程。"
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "content_md": {"type": "string", "description": "笔记正文，Markdown"},
                    "title": {"type": "string", "description": "标题；留空则取正文首行"},
                    "tags": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "标签，便于以后筛",
                    },
                    "source_kind": {
                        "type": "string",
                        "enum": ["manual", "chat", "clip"],
                        "description": "来源类型；默认 manual",
                    },
                    "source_ref": {
                        "type": "string",
                        "description": "来源引用：chat 填会话 id，clip 填网址",
                    },
                },
                "required": ["content_md"],
                "additionalProperties": False,
            },
        },
        {
            "name": "attach_note_to_kb",
            "description": (
                "把一条笔记作为 Markdown 文档加进知识库，之后就能被 search 检索到。"
                "内容相同的重复入库不会产生副本（按内容哈希去重）。"
                "**这是「把对话成果放进知识库」的收口动作。**"
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "note_id": {"type": "string"},
                    "knowledge_base_id": {"type": "string"},
                },
                "required": ["note_id", "knowledge_base_id"],
                "additionalProperties": False,
            },
        },
        {
            "name": "list_notes",
            "description": (
                "列出笔记（可按关键词搜标题与正文）。"
                "每条会标明**是否已经进过知识库**：没进的检索不到，需要先 attach。"
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "关键词，可留空"},
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": MAX_NOTE_PAGE,
                        "description": "最多返回几条，默认 20",
                    },
                },
                "additionalProperties": False,
            },
        },
        {
            "name": "recall",
            "description": (
                "在**长期记忆**里召回：过去对话沉淀下来的结论、偏好与约定。"
                "**它与 search 是两个池子**——search 给「文献怎么写的」（有出处可引用），"
                "recall 给「我们之前怎么说的」（没有出处）。"
                "回答「我们上次怎么决定的」「我的偏好是什么」这类问题时用它。"
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "想找回什么，自然语言即可"},
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": MAX_RECALL,
                        "description": f"最多返回几条，默认 {DEFAULT_RECALL}",
                    },
                },
                "required": ["query"],
                "additionalProperties": False,
            },
        },
        {
            "name": "remember",
            "description": (
                "把一条**长期有效**的事实写进核心记忆，之后的对话都会带上它。"
                "适合：用户的稳定偏好、定下来的约定与决策、踩过的坑。"
                "**一条只记一句**（上限 500 字）；成篇的内容用 create_note。"
                "同一件事重复记不会写第二遍。"
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "content": {"type": "string", "description": "一句可复用的事实"},
                    "tags": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "标签，便于以后筛",
                    },
                },
                "required": ["content"],
                "additionalProperties": False,
            },
        },
    ]


def call_tool(
    services: Services,
    name: str,
    arguments: dict[str, Any] | None,
    *,
    caller: Caller,
) -> Any:
    """执行一个工具。**未知工具报错而不是返回空**——静默失败会让模型
    以为"查到了但没有结果"，然后基于错误前提继续推理。

    ``caller`` 是必填的（见模块头）：调用方从 ``auth.current_caller()`` 取，
    拿不到就会在那里抛 401，而不是走到这里变成匿名调用。
    """
    args = arguments or {}
    handler = _HANDLERS.get(name)
    if handler is None:
        raise InvalidRequestError(f"未知的工具：{name}（可用：{'、'.join(TOOL_NAMES)}）")
    return handler(services, args, caller=caller)


# --------------------------------------------------------------------- 各工具


def _require(args: dict[str, Any], key: str) -> str:
    value = str(args.get(key) or "").strip()
    if not value:
        raise InvalidRequestError(f"缺少参数：{key}")
    return value


def _visible_items(services: Services, caller: Caller) -> list[Any]:
    """当前调用者能看到的库。``visible_kb_ids`` 返回 ``None`` 表示**不受限**
    （管理员会话，或范围为空 = 不限范围的 API Key），此时不过滤。"""
    visible = services.api_keys.visible_kb_ids(caller)
    items = services.knowledge_bases.list_all()
    if visible is None:
        return items
    allowed = set(visible)
    return [item for item in items if item.id in allowed]


def _list_knowledge_bases(
    services: Services, args: dict[str, Any], *, caller: Caller
) -> list[dict[str, Any]]:
    return [
        {
            "id": item.id,
            "name": item.name,
            "documents": services.documents.count_documents(item.id),
            "embedding_model": item.embedding_model_id,
        }
        for item in _visible_items(services, caller)
    ]


def _create_knowledge_base(
    services: Services, args: dict[str, Any], *, caller: Caller
) -> dict[str, Any]:
    name = _require(args, "name")
    # 不涉及既有库，所以只判权限档位（只读 Key 会被拒）。
    # **kb_ids 传 None**：这是"要新建"，不是"要访问某个既有库"
    services.api_keys.check_access(caller, need=WRITE)
    # kb_id 由调用方生成：服务层要求显式传入（与 REST 层同一口径），
    # 这样将来要支持"由客户端指定 id"时不用改服务层签名
    record = services.knowledge_bases.create(
        kb_id=f"kb_{uuid.uuid4().hex[:12]}",
        name=name,
        # 归属要跟着身份走：不写 owner 的话，成员建出来的库**自己都看不见**
        # （visible_kb_ids 对成员只算"自己拥有的 + 被分享的"）
        owner_id=caller.user.id if caller.user is not None else None,
    )
    return {"id": record.id, "name": record.name}


def _upload_document(
    services: Services, args: dict[str, Any], *, caller: Caller
) -> dict[str, Any]:
    kb_id = _require(args, "knowledge_base_id")
    filename = _require(args, "filename")
    raw = _require(args, "content_base64")

    # 写入必须先判作用域：越界时**指出是哪个库**，
    # 模型据此能告诉用户"这把 Key 没有那个库的写权限"，而不是笼统地失败
    services.api_keys.check_access(caller, need=WRITE, kb_ids=[kb_id])

    try:
        content = base64.b64decode(raw, validate=True)
    except (binascii.Error, ValueError) as exc:
        # 说清是"base64 不合法"而不是笼统的"参数错误"——
        # 模型据此能自己改对（重新编码）而不是放弃这个工具
        raise InvalidRequestError(f"content_base64 不是合法的 base64：{exc}") from exc

    if len(content) > MAX_UPLOAD_BYTES:
        raise InvalidRequestError(
            f"文件超过 {MAX_UPLOAD_BYTES // (1024 * 1024)}MB 上限。"
            "MCP 走进程间消息，更大的文件请用 REST 上传"
        )

    outcome = services.ingest.submit(
        knowledge_base_id=kb_id,
        filename=filename,
        content=content,
        # 记上"是谁传的"：多用户下这是文档列表里的上传者列，缺了就显示"未记录"
        uploaded_by=caller.user.id if caller.user is not None else None,
    )
    if not outcome.is_duplicate:
        services.documents.enqueue_ingest(outcome.document.id)

    return {
        "document_id": outcome.document.id,
        "name": outcome.document.name,
        "is_duplicate": outcome.is_duplicate,
        "note": (
            "内容与库中已有文档相同，未重复入库"
            if outcome.is_duplicate
            else "已入队处理，可用 get_document_status 查进度"
        ),
    }


def _add_data_source(
    services: Services, args: dict[str, Any], *, caller: Caller
) -> dict[str, Any]:
    kb_id = _require(args, "knowledge_base_id")
    kind = _require(args, "kind").lower()
    url = _require(args, "url")
    if kind not in ("rss", "html"):
        raise InvalidRequestError(f"kind 只能是 rss 或 html，收到：{kind}")

    # 挂数据源会让内容源源不断进库，是**写**操作
    services.api_keys.check_access(caller, need=WRITE, kb_ids=[kb_id])

    record = services.sources.create(
        knowledge_base_id=kb_id,
        kind=DataSourceKind(kind),
        name=str(args.get("name") or ""),
        url=url,
    )
    return {
        "id": record.id,
        "name": record.name,
        "note": "已登记。内容不会立刻抓取——等定时任务，或在控制台点「立即拉取」",
    }


def _search(services: Services, args: dict[str, Any], *, caller: Caller) -> dict[str, Any]:
    query = _require(args, "query")
    kb_ids = [str(item) for item in (args.get("knowledge_base_ids") or [])]
    if not kb_ids:
        # 留空 = 查**这个调用者能看到的全部**：Agent 常常不知道有哪些库，
        # 逼它先列一遍是多余的一步。注意这里**不是** list_all()——
        # 那是"所有人的库"，在收口之前正是越权的来源
        kb_ids = [item.id for item in _visible_items(services, caller)]
    else:
        # 显式指定了库就把越界挡在检索之前：检索是很重的操作，
        # 让它先跑完再拒，白烧一次算力
        services.api_keys.check_access(caller, kb_ids=kb_ids)
    if not kb_ids:
        return {"query": query, "hits": [], "note": "没有任何知识库"}

    top_k = int(args.get("top_k") or 6)
    top_k = max(1, min(MAX_TOP_K, top_k))

    response = services.retrieval.search(_query(query=query, kb_ids=kb_ids, top_k=top_k))
    return {
        "query": query,
        "hits": [
            {
                "document_id": hit.document_id,
                "document_name": hit.document_name or hit.document_id,
                "text": hit.text,
                "score": round(hit.score, 4),
                "page": hit.page,
                "heading_path": hit.heading_path,
            }
            for hit in response.hits
        ],
        "filtered_out": response.filtered_out,
    }


def _document_or_403(services: Services, document_id: str, *, caller: Caller) -> Any:
    """取文档并判它所属库的读权限。

    顺序是"先取再判"：文档记录里才有所属库 id，没有它无从判起。
    代价是"猜 id 探测存在性"——不存在的 id 报 404、存在但越界的报 403，
    两者可分。局域网自用工具的这个量级上可接受，真要收紧就得把
    doc_id 也变成不可枚举的。
    """
    record = services.documents.get(document_id)
    services.api_keys.check_access(caller, kb_ids=[record.knowledge_base_id])
    return record


def _get_document_status(
    services: Services, args: dict[str, Any], *, caller: Caller
) -> dict[str, Any]:
    document_id = _require(args, "document_id")
    record = _document_or_403(services, document_id, caller=caller)
    return {
        "document_id": record.id,
        "name": record.name,
        "stage": record.stage.value,
        "chunks": services.documents.chunk_count(record.id),
        "error": record.error,
        "searchable": record.stage.value == "indexed",
        "note": (
            "已可检索"
            if record.stage.value == "indexed"
            else "尚未完成处理，此时检索不到它"
        ),
    }


def _delete_document(
    services: Services, args: dict[str, Any], *, caller: Caller
) -> dict[str, Any]:
    document_id = _require(args, "document_id")
    record = services.documents.get(document_id)
    # 删除是写操作：只读分享拿到的库不能删
    services.api_keys.check_access(
        caller, need=WRITE, kb_ids=[record.knowledge_base_id]
    )
    entry = services.lifecycle.delete_document(document_id)
    return {
        "document_id": document_id,
        "trash_id": entry.id,
        "restorable_until": entry.expires_at.isoformat(),
        "note": "原文保留 7 天可恢复；切块与向量已清除，现在搜不到了",
    }


# --------------------------------------------------------------------- 笔记


def _owner_of(caller: Caller) -> str | None:
    """笔记的归属 id。

    会话令牌（``kylab_st_``）能给出账号，于是笔记归那个人；
    API Key 通道没有账号，只能是 ``None``——而 ``None`` 在本仓库里
    表示"不校验归属"（与 ``NotesService.list`` 同一口径）。
    所以**想让 agent 存的东西出现在你自己的笔记列表里，就用会话令牌接 MCP**。
    """
    return caller.user.id if caller.user is not None else None


def _create_note(services: Services, args: dict[str, Any], *, caller: Caller) -> dict[str, Any]:
    content = _require(args, "content_md")
    raw_tags = args.get("tags") or []
    note = services.notes.create(
        user_id=_owner_of(caller),
        title=str(args.get("title") or "").strip(),
        content_md=content,
        # 来源交给服务层校验（不在白名单里会落回 manual），这里不重复一份
        source_kind=str(args.get("source_kind") or "manual"),
        source_ref=(str(args["source_ref"]) if args.get("source_ref") else None),
        tags=[str(item) for item in raw_tags] if isinstance(raw_tags, list) else [],
    )
    return {
        "note_id": note.id,
        "title": note.title,
        "note": (
            "笔记已保存。**此时还检索不到它**——"
            "要让知识库能检索，再调 attach_note_to_kb 把它加进某个库"
        ),
    }


def _attach_note_to_kb(
    services: Services, args: dict[str, Any], *, caller: Caller
) -> dict[str, Any]:
    note_id = _require(args, "note_id")
    kb_id = _require(args, "knowledge_base_id")
    # 入库是写操作，而且是"往库里加内容"，所以判的是目标库的写权限
    services.api_keys.check_access(caller, need=WRITE, kb_ids=[kb_id])
    # attach_to_kb 内部按归属取笔记：不是自己的会 404（不泄露存在性）
    note = services.notes.attach_to_kb(note_id, user_id=_owner_of(caller), kb_id=kb_id)
    return {
        "note_id": note.id,
        "document_id": note.doc_id,
        "knowledge_base_id": note.kb_id,
        "note": (
            "已作为 Markdown 文档入库，处理是异步的："
            "用 get_document_status 查进度，索引完成后即可被 search 检索到"
        ),
    }


def _list_notes(services: Services, args: dict[str, Any], *, caller: Caller) -> dict[str, Any]:
    limit = max(1, min(int(args.get("limit") or 20), MAX_NOTE_PAGE))
    query = str(args.get("query") or "").strip() or None
    items, total = services.notes.list(user_id=_owner_of(caller), query=query, limit=limit)
    return {
        "total": total,
        "notes": [
            {
                "note_id": item.id,
                "title": item.title,
                # 正文只给前 200 字：笔记可能很长，全量塞进上下文会把预算吃光
                "excerpt": item.content_md[:NOTE_EXCERPT_CHARS],
                "tags": list(item.tags),
                "in_knowledge_base": item.doc_id is not None,
                "source_kind": item.source_kind,
                "updated_at": item.updated_at.isoformat() if item.updated_at else None,
            }
            for item in items
        ],
        "note": "「in_knowledge_base」为 false 表示这条只是笔记，还没进知识库、检索不到",
    }


def _list_documents(
    services: Services, args: dict[str, Any], *, caller: Caller
) -> dict[str, Any]:
    kb_id = _require(args, "knowledge_base_id")
    services.api_keys.check_access(caller, kb_ids=[kb_id])
    limit = max(1, min(int(args.get("limit") or DEFAULT_DOC_PAGE), MAX_DOC_PAGE))
    records = services.documents.list_documents(
        kb_id, q=str(args.get("query") or "").strip() or None, limit=limit
    )
    return {
        "knowledge_base_id": kb_id,
        "total": services.documents.count_documents(kb_id),
        "documents": [
            {
                "document_id": item.id,
                "name": item.name,
                "stage": item.stage.value,
                "searchable": item.stage.value == "indexed",
                "disabled": item.disabled,
            }
            for item in records
        ],
        "note": "只有 searchable 为 true 的文档能被 search 检索到",
    }


# --------------------------------------------------------------------- 记忆


def _recall(services: Services, args: dict[str, Any], *, caller: Caller) -> dict[str, Any]:
    """在**记忆**里召回，与 `search` 是两条路。

    记忆的归属按账号走：会话令牌能给出账号，`recall` 因此天然是"我自己的记忆"。
    这里的判定与文档库不同——记忆不绑知识库范围，它绑人。
    """
    query = _require(args, "query")
    limit = int(args.get("limit") or DEFAULT_RECALL)
    hits = services.memory.recall(query, limit=limit)
    return {
        "query": query,
        "hits": [
            {
                "text": item.text,
                "path": item.path,
                "score": round(item.score, 4) if item.score is not None else None,
            }
            for item in hits
        ],
        "total": len(hits),
        "note": (
            "这是**记忆**（过去对话里沉淀下来的结论与偏好），不是知识库原文。"
            "需要可引用的原文依据时用 search。"
        ),
    }


def _remember(services: Services, args: dict[str, Any], *, caller: Caller) -> dict[str, Any]:
    content = _require(args, "content")
    raw_tags = args.get("tags") or []
    result = services.memory.remember(
        content, tags=[str(item) for item in raw_tags] if isinstance(raw_tags, list) else []
    )
    if not result["saved"]:
        return {**result, "note": "这条已经在核心记忆里了，没有重复写入"}
    return {
        **result,
        "note": (
            "已写入核心长期记忆，之后的对话会带上它。"
            "**一条只记一句可复用的事实**（偏好、约定、结论）；"
            "成篇的内容请用 create_note"
        ),
    }


_HANDLERS = {
    "list_knowledge_bases": _list_knowledge_bases,
    "create_knowledge_base": _create_knowledge_base,
    "upload_document": _upload_document,
    "add_data_source": _add_data_source,
    "search": _search,
    "list_documents": _list_documents,
    "get_document_status": _get_document_status,
    "delete_document": _delete_document,
    "create_note": _create_note,
    "attach_note_to_kb": _attach_note_to_kb,
    "list_notes": _list_notes,
    "recall": _recall,
    "remember": _remember,
}


def _query(*, query: str, kb_ids: list[str], top_k: int):  # type: ignore[no-untyped-def]
    """构造检索请求。

    放在函数里 import：``mcp`` 层与 ``services`` 层都往这儿引用，
    顶层 import 会让这条单向依赖变得不明显。
    """
    from app.services.retrieval import RetrievalQuery

    return RetrievalQuery(query=query, kb_ids=kb_ids, top_k=top_k)
