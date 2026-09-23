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

**交付与留档是两件事**（v0.41 写清楚）：`export_document` / `export_table` /
`export_deck` 是**交付口**——文件落在会话的产物区，对话里挂一张可下载的卡片；
`create_note` 是**留档**——只进笔记列表，对方在对话里什么也拿不到。
这两件事此前在两边的 description 里没分开写，于是"给我一份 .md"被办成了
"我把内容存成笔记了"：落点错了，用户在对话页上找不到任何可下载的东西。
现在分工同时写在两边的 description、系统提示词（`chat.AGENT_SYSTEM_PROMPT`）
与 `create_note` 的返回值里——**返回值那句是给"已经用错一次"准备的**，
它不需要用户再纠正一遍。

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
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from app.core.exceptions import InvalidRequestError, UpstreamError
from app.core.services import Services
from app.models.enums import DataSourceKind
from app.services import office, web
from app.services.api_key import WRITE, Caller
from app.services.memory import DEFAULT_RECALL, MAX_RECALL
from app.storage.base import ARTIFACT_IN_WORKSPACE

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
#: 拼文本用的换行。**写成 chr(10) 而不是字面转义**：
#: 这个文件里的多行字符串被 heredoc 吃掉过好几层转义（反斜杠 n 变成真换行、
#: 字符串直接断行），而它只是「一个换行」，不值得每次都赌一遍引号与反斜杠。
_NL = chr(10)

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
    "export_document",
    "export_table",
    "export_deck",
    "ingest_artifact",
    "web_search",
    "web_fetch",
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
                "把一段成果保存成**笔记**（Markdown）——**笔记是给自己长期留档用的**："
                "它只进笔记列表，**不是交付**（对方在对话里看不到卡片、也下载不了）。"
                "**对方要的是一份文件时不要用这个**（「给我一份」「发我个 .md / .docx」"
                "「能下载的」「发给我同事」），那种要求用 export_document 交付。"
                "**这是「把对话结论沉淀下来」的第一步**："
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
        {
            "name": "web_search",
            "description": (
                "**联网搜索**：回若干条结果（标题、网址、摘要），"
                "并**顺带读回前两条的正文开头**（每条 2000 字）"
                "——多数情况这些就够回答了，不必再抓一遍。"
                "问的是「现在 / 最近 / 今天」这类**本地资料里不会有**的信息时用它；"
                "确需整页原文时再用 web_fetch 打开对应的网址（它一次能给 5 个）。"
                "记忆与知识库只装「已经在你手里的东西」，装不了外面的世界。"
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "检索词"},
                    "limit": {"type": "integer", "description": "最多几条（默认 8，上限 10）"},
                    "read_top": {
                        "type": "integer",
                        "description": (
                            "顺带读回前几条的正文开头（默认 2，最多 3）。"
                            "只想要链接、或要自己挑着抓时传 0"
                        ),
                    },
                },
                "required": ["query"],
                "additionalProperties": False,
            },
        },
        {
            "name": "web_fetch",
            "description": (
                "**抓网页并抽出正文**（回 Markdown）。"
                "适合：对方给了一个网址要你看内容、搜索结果的某一页要读全文、"
                "要核对某个说法。"
                "**要读多页就一次给完**（最多 5 个），别一个一个来——"
                "每多一次调用就多一个来回，而一轮里你可能要读十几页。"
                "个别地址抓不到（403、超时）只影响那一条，其余照常返回。"
                "只访问公网地址，内网与本机地址会被拒。"
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "http/https 地址"},
                    "urls": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "一次要读的多个地址（最多 5 个）；与 url 二选一",
                    },
                },
                "additionalProperties": False,
            },
        },
        {
            "name": "export_document",
            "description": (
                "把整理好的正文**导出成一份真文件**"
                "（.docx / .pdf / .md / .txt / .csv / .html）。"
                "正文用 Markdown（标题 #、要点 -、表格 | a | b |）。"
                "**这是「交付一份文件」的那个口**：对方说「给我一份」「发我个 .md」「一份报告」"
                "「能下载的」「发给我同事」时都用它——"
                "文件落在**这条会话的产物区**（会话挂了工作区就落进那个目录），"
                "对话里会挂一张可下载的卡片，他点一下就能拿到。"
                "**不要用 create_note 顶替交付**：笔记只进他自己的笔记列表，"
                "对话里既看不到、也下载不了。"
                ".md / .txt / .csv / .html 这四种是**原样落正文**（不做转换）；"
                "要能被 Excel 排序求和的那张表用 export_table（.xlsx）。"
                "**它不会进知识库**——那是另一件事，对方明确要求时才调 ingest_artifact。"
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "knowledge_base_id": {
                        "type": "string",
                        "description": (
                            "存到哪个库。**只在没有会话上下文的那条通道上要求**"
                            "（外部 MCP 客户端、一次性脚本）；对话里不要传，"
                            "产物会自己落到该落的地方"
                        ),
                    },
                    "filename": {
                        "type": "string",
                        "description": (
                            "文件名，扩展名决定格式："
                            ".docx / .pdf / .md / .txt / .csv / .html"
                        ),
                    },
                    "markdown": {"type": "string", "description": "正文（Markdown）"},
                    "title": {
                        "type": "string",
                        "description": (
                            "文档标题；留空则不加标题（.md / .txt / .csv / .html 不看它）"
                        ),
                    },
                },
                "required": ["filename", "markdown"],
                "additionalProperties": False,
            },
        },
        {
            "name": "export_table",
            "description": (
                "把二维数据导出成 .xlsx。"
                "**当结果是「一张表」时用它**（清单、对照、逐项统计）——"
                "表格塞进文档里就没法排序与计算了。"
                "第一行当表头；数字直接给数字，不要给字符串。"
                "文件落在这条会话的产物区，**不进知识库**（要入用 ingest_artifact）。"
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "knowledge_base_id": {
                        "type": "string",
                        "description": "同 export_document：只有没有会话上下文的通道才需要",
                    },
                    "filename": {"type": "string", "description": "文件名，扩展名用 .xlsx"},
                    "rows": {
                        "type": "array",
                        "items": {"type": "array", "items": {}},
                        "description": "二维数组，第一行是表头",
                    },
                    "sheet_name": {"type": "string", "description": "工作表名；留空为 Sheet1"},
                },
                "required": ["filename", "rows"],
                "additionalProperties": False,
            },
        },
        {
            "name": "export_deck",
            "description": (
                "把要点导出成一份 .pptx 幻灯。"
                "**当对方要「讲一遍」时用它**（汇报、方案、提纲）——"
                "每页只放标题与要点，不要写成成段的文字。"
                "文件落在这条会话的产物区，**不进知识库**（要入用 ingest_artifact）。"
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "knowledge_base_id": {
                        "type": "string",
                        "description": "同 export_document：只有没有会话上下文的通道才需要",
                    },
                    "filename": {"type": "string", "description": "文件名，扩展名用 .pptx"},
                    "slides": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "title": {"type": "string", "description": "这一页的标题"},
                                "bullets": {
                                    "type": "array",
                                    "items": {"type": "string"},
                                    "description": "这一页的要点",
                                },
                            },
                            "required": ["title"],
                        },
                        "description": "按顺序的页面",
                    },
                    "title": {"type": "string", "description": "封面标题；留空则不要封面"},
                },
                "required": ["filename", "slides"],
                "additionalProperties": False,
            },
        },
        {
            "name": "ingest_artifact",
            "description": (
                "把**刚才导出的那个文件**存进知识库（之后能被检索、出现在文档列表里）。"
                "**只在对方明确要求时调**——「存进知识库」「放进资料库」「以后能查到」"
                "这类话。导出的文件默认**不**进库，那是他的选择，不是默认。"
                "对方没指定哪个库、你也拿不准时，先用 list_knowledge_bases 看有哪些，"
                "或者直接问他——**不要替他挑一个**。"
                "artifact_id 就用导出那一步返回的那个。"
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "artifact_id": {
                        "type": "string",
                        "description": "导出类工具返回的那个 artifact_id",
                    },
                    "knowledge_base_id": {
                        "type": "string",
                        "description": "存进哪个库（对方指定或确认过的那个）",
                    },
                },
                "required": ["artifact_id", "knowledge_base_id"],
                "additionalProperties": False,
            },
        },
    ]


#: 需要"这一轮在哪条会话里"的工具（v0.26）——导出类的产物要落到会话的临时位置
#: 或它所属工作区的目录里。**只有这三个**：其余工具与"在哪条会话里"无关，
#: 给它们一律加一个用不上的参数，会让"哪些工具依赖会话上下文"在签名里读不出来。
_CONTEXTUAL_TOOLS = frozenset({"export_document", "export_table", "export_deck"})


def call_tool(
    services: Services,
    name: str,
    arguments: dict[str, Any] | None,
    *,
    caller: Caller,
    conversation_id: str | None = None,
) -> Any:
    """执行一个工具。**未知工具报错而不是返回空**——静默失败会让模型
    以为"查到了但没有结果"，然后基于错误前提继续推理。

    ``caller`` 是必填的（见模块头）：调用方从 ``auth.current_caller()`` 取，
    拿不到就会在那里抛 401，而不是走到这里变成匿名调用。

    ``conversation_id`` 只有对话这条链路给得出（外部 MCP 客户端与一次性脚本
    没有会话）——它决定产物落在哪儿，见 :func:`_save_export`。
    """
    args = arguments or {}
    handler = _HANDLERS.get(name)
    if handler is None:
        raise InvalidRequestError(f"未知的工具：{name}（可用：{'、'.join(TOOL_NAMES)}）")
    if name in _CONTEXTUAL_TOOLS:
        return handler(services, args, caller=caller, conversation_id=conversation_id)
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


def _upload_document(services: Services, args: dict[str, Any], *, caller: Caller) -> dict[str, Any]:
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


def _add_data_source(services: Services, args: dict[str, Any], *, caller: Caller) -> dict[str, Any]:
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
                # `chunk_id` 与所属库是**给"要用这些片段做引用"的调用方**用的：
                # 对话链路要把命中转成界面上的出处（`SourceRef` 要求 chunk_id），
                # 没有它就只能给一个连不回原文的引用。对外部 MCP 客户端同样有用。
                "chunk_id": hit.chunk_id,
                "knowledge_base_id": hit.knowledge_base_id,
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
        "note": ("已可检索" if record.stage.value == "indexed" else "尚未完成处理，此时检索不到它"),
    }


def _delete_document(services: Services, args: dict[str, Any], *, caller: Caller) -> dict[str, Any]:
    document_id = _require(args, "document_id")
    record = services.documents.get(document_id)
    # 删除是写操作：只读分享拿到的库不能删
    services.api_keys.check_access(caller, need=WRITE, kb_ids=[record.knowledge_base_id])
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
            "笔记已保存。**它是笔记，不是交付**——只出现在对方的笔记列表里，"
            "对话里不会有可下载的卡片；**对方要的如果是「一份文件」，"
            "请改用 export_document 交付**。"
            "另外**此时还检索不到它**——"
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


def _list_documents(services: Services, args: dict[str, Any], *, caller: Caller) -> dict[str, Any]:
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

    **记忆目前是"一个工作区"，不按账号分**（设计文档 §5 的已知边界）：
    只要 ReMe 跑在同一个工作区上，不同账号召回的就是同一份记忆。
    这里**不做归属过滤**，因为过滤不了——真过滤需要按账号分工作区目录，
    而那个决定在产品层面还没做。

    这段话是刻意写在这里的：先前这里写的是"记忆的归属按账号走、它绑人"，
    而代码里没有任何一处做这件事。留着那种说法，下一个人就会以为记忆已经隔离好了。
    """
    query = _require(args, "query")
    limit = int(args.get("limit") or DEFAULT_RECALL)
    hits, links = services.memory.recall(query, limit=limit, user_id=_owner_of(caller))
    return {
        "query": query,
        "hits": [
            {
                "text": item.text,
                "path": item.path,
                # 行号是"渐进式展开"的入口：片段不够时按它去读全文
                "lines": (
                    f"{item.start_line}-{item.end_line}" if item.start_line is not None else None
                ),
                "score": round(item.score, 4) if item.score is not None else None,
            }
            for item in hits
        ],
        # wikilink 图谱随召回免费附上：不够时顺着它走到相关记忆，不用再搜一次
        "links": [
            {"path": item.path, "name": item.name, "direction": item.direction}
            for item in links[:20]
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


# ------------------------------------------------------------------ 联网


#: 搜索时**顺带抓回前几条的正文开头**（v0.39）。
#:
#: 为什么值得：本地抓页极快（实测两页并行 **0.34 秒**），而**每多一次模型往返是
#: 1.2–4.4 秒**（同一轮实测：一轮 17.8 秒里有 11.3 秒花在 4 次模型调用上）。
#: 搜完之后模型总要挑一两条读正文，那一跳就是要一次往返；把前两条的开头直接附在
#: 结果里，常见情况（摘要不够回答、正文开头就够判断）就不用再走那一跳。
#:
#: 只给**开头**而不是全文：全文由 `web_fetch` 负责（它一次能给 5 个网址）。
#: 这里的目标是"少一跳"，不是"把网页都塞进上下文"。
SEARCH_FETCH_TOP = 2
SEARCH_FETCH_CHARS = 2000

#: 顺带抓那两页的**墙钟预算**（秒）。比 `web_fetch` 的 20 秒紧得多。
#:
#: 实测（2026-09-21）：多数页面 0.2–0.7 秒，但**有的一直慢慢吐字节**——
#: 某新闻站首页抓了 33 秒（8 条结果里最慢的三条是 25/24/23 秒）。
#: 那种页面在这里是灾难性的：一次搜索为了某一页的开头等三十秒，
#: 比它想省下的那次模型往返（1.2–4.4 秒）贵一个量级。
#: 宁可这一页读不到（就写成"这一页没读成"，模型可以去 web_fetch 单独读它）。
SEARCH_FETCH_TIMEOUT = 5.0

#: 模型最多能顺带读几条（再多就是它在替我们做批量抓取，那件事交给 web_fetch）。
MAX_SEARCH_FETCH_TOP = 3


def _web_search(services: Services, args: dict[str, Any], *, caller: Caller) -> str:
    """搜一次网。**结果渲染成带编号的文本**（与检索那份同理）：

    模型接下来要挑一条去 :func:`_web_fetch`，而它挑的依据是编号与网址——
    JSON 里的字段名会把这件事弄糊。返回文本而不是 dict，也顺带让
    "标题 + 网址 + 摘要" 在上下文里是人读得懂的样子。

    **前几条的正文开头一起带回来**（``read_top``，默认 2，见 ``SEARCH_FETCH_TOP``）：
    搜索之后单独再抓一页，代价不是那 0.2 秒的网络，而是**整整一次模型往返**
    （1.2–4.4 秒，实测）。常见的那一跳在这里省掉。
    """
    query = _require(args, "query")
    limit = args.get("limit")
    hits = web.search_web(
        query,
        api_key=services.runtime.get("web.search_api_key"),
        provider=services.runtime.get("web.search_provider") or "tavily",
        limit=int(limit) if isinstance(limit, int) else 8,
    )
    if not hits:
        return f"没有搜到结果（检索词：{query}）。换个说法再试一次，或者直接抓一个你知道的网址。"
    lines = [f"检索词：{query}，共 {len(hits)} 条："]
    for index, hit in enumerate(hits, start=1):
        where = f"（{hit.published}）" if hit.published else ""
        lines.append(f"[{index}] {hit.title}{where}{_NL}{hit.url}{_NL}{hit.snippet}")
    read_top = _read_top(args)
    if read_top:
        excerpts = _search_excerpts(hits, read_top)
        if excerpts:
            header = (
                f"【前 {read_top} 条的正文开头】"
                f"（每条最多 {SEARCH_FETCH_CHARS} 字；要读全文用 web_fetch）"
            )
            lines.append(f"{header}{_NL}{_NL}" + f"{_NL}{_NL}".join(excerpts))
    lines.append(f"{_NL}要读全文就用 web_fetch 打开其中的网址。")
    return f"{_NL}{_NL}".join(lines)


def _read_top(args: dict[str, Any]) -> int:
    """这一轮顺带读前几条的正文（``read_top``，缺省 ``SEARCH_FETCH_TOP``）。

    模型可以传 0 关掉（只想要链接时没必要抓），也可以调到 3；再多不给——
    那已经是替它做批量抓取，而 `web_fetch` 一次能给 5 个网址、还能并行。
    """
    value = args.get("read_top")
    if not isinstance(value, int) or isinstance(value, bool):
        return SEARCH_FETCH_TOP
    return max(0, min(value, MAX_SEARCH_FETCH_TOP))


def _search_excerpts(hits: list[web.SearchHit], count: int) -> list[str]:
    """**并发**抓前 ``count`` 条的正文开头（见 ``SEARCH_FETCH_TOP``）。

    一页读不到（403 / 超时 / 不是网页）只影响那一条，就地写成一行说明：
    与 `web_fetch` 同一条纪律——上游的毛病不该让整次搜索白跑。
    """
    targets = [hit.url for hit in hits[:count]]
    if not targets:
        return []
    with ThreadPoolExecutor(max_workers=len(targets)) as pool:
        return list(pool.map(_excerpt_one, targets))


def _excerpt_one(url: str) -> str:
    """抓一页的开头，渲染成"标题 + 正文节选"；失败就给一行原因。

    预算比 `web_fetch` 短（见 ``SEARCH_FETCH_TIMEOUT``）：这里等的是"顺手多给一点"，
    不该让一整次搜索为某一页卡住。
    """
    try:
        title, body = web.fetch_url(
            url, limit=SEARCH_FETCH_CHARS, timeout=SEARCH_FETCH_TIMEOUT
        )
    except (UpstreamError, InvalidRequestError) as exc:
        return f"【这一页没读成】{url}{_NL}{exc}"
    return f"【{title}】{url}{_NL}{body}"


#: 一次最多读几页。**上限存在的理由是上下文**，不是网络：
#: 每页正文上限 3 万字，五页就是十五万字的工具结果，够把预算吃光。
MAX_FETCH_URLS = 5


def _web_fetch(services: Services, args: dict[str, Any], *, caller: Caller) -> str:
    """抓网页正文（**一次可以给多个网址**，v0.26）。

    **以字符串回、不包成 JSON**：正文里的换行与引号在 JSON 里会变成一屏转义字符，
    而这段文本是要给模型读的。来源地址写在每一页的开头——它引用时能说清是哪一页。

    **为什么要支持一次给多个**：实测一轮里模型会连着抓十几页，而每抓一页就要
    等一次模型往返（那条会话里 10 次搜索 + 15 次抓取 = 25 个来回，占了一轮
    一百多秒里的大头；相比之下 Tavily 一次 2 秒根本不算慢）。
    把"读这几页"合成一次调用，省下的是往返，不是网络。

    一页失败**不拖垮整次调用**：403/超时是常事（实测抓 15 页里有 2 页 403），
    把失败原因就地写在那一条下面，模型据此换一个来源——而不是整轮重来。
    """
    urls: list[str] = []
    single = str(args.get("url") or "").strip()
    if single:
        urls.append(single)
    raw = args.get("urls")
    if isinstance(raw, list):
        urls.extend(str(item).strip() for item in raw if str(item).strip())
    if not urls:
        raise InvalidRequestError("缺少参数：url（或用 urls 一次给多个）")
    # 去重但保序：模型偶尔把同一个地址写两遍，抓两次纯属浪费
    unique = list(dict.fromkeys(urls))
    if len(unique) > MAX_FETCH_URLS:
        raise InvalidRequestError(
            f"一次最多读 {MAX_FETCH_URLS} 页（收到 {len(unique)} 个）。先读这几页，看完再要下一批"
        )

    # **先把每一个地址过一遍再发请求**（与单页时同一条纪律）：内网 / 本机 / 云元数据
    # 地址要挡在发出去之前，而不是"发完再看结果"。放在循环外还有一个好处——
    # 一批里有一个非法地址时，其余几个也不会被先抓走（那等于用合法的几个
    # 把非法那个夹带出去，日志里看还像是正常抓取）。
    for url in unique:
        web.check_public_url(url)

    # **并行抓**（v0.26）：这几页之间没有任何依赖，一页一页等就是白等。
    # 每页 0.4–1.2 秒（实测），三页串行 3 秒、并行 1.2 秒；而模型之所以被鼓励
    # 一次给多个网址，图的就是这个——一个来回里把几页都拿回来。
    #
    # `web.fetch_url` 是**无状态的纯函数**（共享的 httpx 客户端本身线程安全），
    # 所以并发在这里是安全的；这也是不在工具循环那一层并发的原因：
    # 那边有共享的"来源账本"与 MCP 会话，动它们要另说。
    chunks: list[str] = []
    with ThreadPoolExecutor(max_workers=MAX_FETCH_URLS) as pool:
        futures = [pool.submit(_fetch_one, url) for url in unique]
        for future in futures:
            chunks.append(future.result())
    return f"{_NL}{_NL}".join(chunks)


def _fetch_one(url: str) -> str:
    """抓一页，把结果（或失败原因）渲染成一段文本。

    **只有上游的毛病就地降级**（403 / 超时 / 不是网页）——那是常事，
    实测抓 15 页有 2 页 403，一页读不到不该让整批白跑。
    `InvalidRequestError`（内网地址、参数非法）不走这里：那是策略拒绝，
    调用方在上面已经逐条拦过了。
    """
    try:
        title, body = web.fetch_url(url)
        return f"【{title}】{_NL}来源：{url}{_NL}{_NL}{body}"
    except UpstreamError as exc:
        return f"【这一页没抓成】{_NL}来源：{url}{_NL}{_NL}{exc}"


# ------------------------------------------------------------------ Office 产出


def _export_document(
    services: Services,
    args: dict[str, Any],
    *,
    caller: Caller,
    conversation_id: str | None = None,
) -> dict[str, Any]:
    """Markdown → .docx / .pdf（转换）或 .md / .txt / .csv / .html（原样落字节）。

    见 :func:`_save_export` 与 `office.build_text`。
    """
    markdown = _require(args, "markdown")
    if len(markdown) > office.MAX_CHARS:
        raise InvalidRequestError(
            f"正文太长（{len(markdown)} 字，上限 {office.MAX_CHARS}）。"
            "这么长的材料更适合拆成几份分别导出"
        )
    kind = _suffix_of(_require(args, "filename"))
    if kind in office.PLAIN_TEXT_KINDS:
        # 纯文本类**不过转换器**：它们的"产出"就是正文本身（见 office.build_text）
        content = _build(kind, office.build_text, markdown, kind=kind)
    elif kind in ("docx", "pdf"):
        content = _build(
            kind,
            office.build_docx if kind == "docx" else office.build_pdf,
            markdown,
            title=str(args.get("title") or ""),
        )
    else:
        raise InvalidRequestError(
            f"export_document 只做 .docx / .pdf / .md / .txt / .csv / .html（收到 .{kind}）。"
            "表格用 export_table（.xlsx），幻灯用 export_deck（.pptx）"
        )
    return _save_export(
        services, args, content, caller=caller, kind=kind, conversation_id=conversation_id
    )


def _export_table(
    services: Services,
    args: dict[str, Any],
    *,
    caller: Caller,
    conversation_id: str | None = None,
) -> dict[str, Any]:
    """二维数据 → .xlsx → 落成一份文件。"""
    raw = args.get("rows")
    if not isinstance(raw, list) or not raw:
        raise InvalidRequestError("rows 要是一个非空的二维数组（第一行是表头）")
    rows = [list(row) if isinstance(row, list) else [row] for row in raw]
    if len(rows) > office.MAX_ROWS:
        raise InvalidRequestError(f"行数太多（{len(rows)}，上限 {office.MAX_ROWS}）")
    if max(len(row) for row in rows) > office.MAX_COLUMNS:
        raise InvalidRequestError(f"列数太多（上限 {office.MAX_COLUMNS}）")
    kind = _suffix_of(_require(args, "filename"))
    if kind != "xlsx":
        raise InvalidRequestError(f"export_table 只做 .xlsx（收到 .{kind}）")
    content = _build(
        kind, office.build_xlsx, rows, sheet_name=str(args.get("sheet_name") or "Sheet1")
    )
    return _save_export(
        services, args, content, caller=caller, kind=kind, conversation_id=conversation_id
    )


def _export_deck(
    services: Services,
    args: dict[str, Any],
    *,
    caller: Caller,
    conversation_id: str | None = None,
) -> dict[str, Any]:
    """要点 → .pptx → 落成一份文件。"""
    raw = args.get("slides")
    if not isinstance(raw, list) or not raw:
        raise InvalidRequestError("slides 要是一个非空的数组（每项 {title, bullets}）")
    if len(raw) > office.MAX_SLIDES:
        raise InvalidRequestError(f"页数太多（{len(raw)}，上限 {office.MAX_SLIDES}）")
    slides: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            raise InvalidRequestError("slides 里每一项都要是对象：{title, bullets}")
        bullets = item.get("bullets") or []
        if not isinstance(bullets, list):
            raise InvalidRequestError("某一页的 bullets 不是数组")
        slides.append(
            {
                "title": str(item.get("title") or ""),
                "bullets": [str(text) for text in bullets[: office.MAX_BULLETS_PER_SLIDE]],
            }
        )
    kind = _suffix_of(_require(args, "filename"))
    if kind != "pptx":
        raise InvalidRequestError(f"export_deck 只做 .pptx（收到 .{kind}）")
    content = _build(kind, office.build_pptx, slides, title=str(args.get("title") or ""))
    return _save_export(
        services, args, content, caller=caller, kind=kind, conversation_id=conversation_id
    )


def _build(fmt: str, builder: Any, *args: Any, **kwargs: Any) -> bytes:
    """跑一次产出。

    **依赖缺失先判、单独报**：它是"这台机器上做不到"（要装东西），
    与"这份输入造不出来"是两回事。合成一句话的话，模型会去反复改内容，
    而问题根本不在那里。

    第一个参数叫 ``fmt`` 而不是 ``kind``：``build_text`` 自己要收一个 ``kind``
    关键字参数，同名会让 `_build(kind, build_text, …, kind=kind)` 直接报
    "got multiple values for argument"。
    """
    problem = office.missing_requirement(fmt)
    if problem:
        raise InvalidRequestError(problem)
    try:
        return builder(*args, **kwargs)
    except RuntimeError as exc:  # 产出过程中的内容问题（如 PDF 里出现非法标记）
        raise InvalidRequestError(f"生成 {fmt} 失败：{exc}") from exc


def _save_export(
    services: Services,
    args: dict[str, Any],
    content: bytes,
    *,
    caller: Caller,
    kind: str,
    conversation_id: str | None = None,
) -> dict[str, Any]:
    """把产出**落成一个文件**（v0.26）。

    改之前这里是"直接当一次入库提交"：文件唯一的身份是"某个知识库里的一份文档"，
    而 `knowledge_base_id` 是必填的。于是没挂工作区的会话要导出 docx 时，模型
    只能**替用户挑一个语义上最顺手的库**——实测它挑中了「笔记」，并在回答里说明
    "你这边没有专门的工作区，我就选了最顺手的那个"。这不是模型的错：它没有别的落点。

    现在两件事分开：

    - **落盘**：挂在工作的会话落进工作区目录（用户打开项目就看得见），
      没挂的落进对象存储里按会话分的临时前缀；
    - **入库**：另一个工具 ``ingest_artifact``，只在对方明确要求时才调。

    没有会话上下文时（外部 MCP 客户端、一次性脚本）仍然要求 ``knowledge_base_id``：
    那条通道没有产物区，而且"外部客户端点名叫了哪个库"本身就是显式的。
    """
    filename = _require(args, "filename")
    if conversation_id:
        record = services.artifacts.save(
            conversation_id=conversation_id,
            filename=filename,
            content=content,
            kind=kind,
            owner_id=caller.owner_id,
        )
        label = services.artifacts.label_for(record)
        saved: dict[str, Any] = {
            "artifact_id": record.id,
            "name": record.name,
            "size_bytes": record.size_bytes,
            "format": kind,
            "saved_to": label,
            "note": (
                f"文件已经生成，落在{label}，对方在对话里就能下载。"
                "**它没有进知识库**——那是另一件事，等他明确要求时再调 ingest_artifact"
            ),
        }
        if record.storage == ARTIFACT_IN_WORKSPACE:
            # 只有工作区那份的路径对模型有用：它下一步可能要去改这个文件
            saved["path"] = record.location
        return {**saved, ARTIFACT_KEY: services.artifacts.describe(record)}

    kb_id = _require(args, "knowledge_base_id")
    services.api_keys.check_access(caller, need=WRITE, kb_ids=[kb_id])
    outcome = services.ingest.submit(
        knowledge_base_id=kb_id,
        filename=filename,
        content=content,
        uploaded_by=caller.user.id if caller.user is not None else None,
    )
    if not outcome.is_duplicate:
        services.documents.enqueue_ingest(outcome.document.id)
    return {
        "document_id": outcome.document.id,
        "name": outcome.document.name,
        "size_bytes": len(content),
        "format": kind,
        "note": (
            "内容与库里已有的一份文件完全相同，没有重复入库"
            if outcome.is_duplicate
            else "已存进知识库并开始处理。对方可以在文档列表里下载或看它"
        ),
        # 界面用的那一份：`ToolOutcome.artifacts` 会把它原样带到前端，在那里挂成
        # 一张可点的文件卡片。**与给模型看的字段放在同一个 dict 里**是有意的：
        # 它们本来就是同一件事，分成两份迟早会一处改了另一处没改。
        ARTIFACT_KEY: {
            "artifact_id": outcome.document.id,
            "name": outcome.document.name,
            "size_bytes": len(content),
            "format": kind,
            "storage": "document",
            "where": "知识库",
            "knowledge_base_id": kb_id,
            "document_id": outcome.document.id,
        },
    }


def _ingest_artifact(services: Services, args: dict[str, Any], *, caller: Caller) -> dict[str, Any]:
    """把**已经导出**的那份文件存进知识库（显式动作，v0.26）。

    与 ``upload_document`` 的分工：那个是"别处来的一份文件，入我的库"，
    这个是"刚才我给你做的那个文件，也存一份进库"——后者不需要把内容再传一遍，
    因为文件已经在服务器上了（工作区目录或对象存储里）。
    """
    artifact_id = _require(args, "artifact_id")
    kb_id = _require(args, "knowledge_base_id")
    services.api_keys.check_access(caller, need=WRITE, kb_ids=[kb_id])
    record = services.artifacts.get(artifact_id)
    document_id, is_duplicate = services.artifacts.ingest(
        record,
        knowledge_base_id=kb_id,
        uploaded_by=caller.user.id if caller.user is not None else None,
    )
    return {
        "document_id": document_id,
        "name": record.name,
        "knowledge_base_id": kb_id,
        "note": (
            "库里已经有一份内容完全相同的文件，没有重复入库"
            if is_duplicate
            else "已存进知识库并开始处理。它现在可被检索，也能在文档列表里下载"
        ),
        # 同一张卡片换成"已入库"的状态：界面按 artifact_id 合并，
        # 于是这一步跑完，卡片上立刻多出"已存进知识库「X」"
        ARTIFACT_KEY: services.artifacts.describe(record),
    }


#: 工具结果里那个"给界面用"的键。`agent_tools.py` 的执行器按它摘出 `artifacts`，
#: 之后这个键会**从回给模型的文本里去掉**——模型不需要看一份自己的结果的副本。
ARTIFACT_KEY = "__artifact__"


def _suffix_of(filename: str) -> str:
    """取扩展名（小写、不带点）。没有扩展名时回空串，由调用方给出可读的报错。"""
    _, _, tail = (filename or "").rpartition(".")
    return tail.strip().lower() if tail else ""


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
    "web_search": _web_search,
    "web_fetch": _web_fetch,
    "export_document": _export_document,
    "export_table": _export_table,
    "export_deck": _export_deck,
    "ingest_artifact": _ingest_artifact,
}


def _query(*, query: str, kb_ids: list[str], top_k: int):  # type: ignore[no-untyped-def]
    """构造检索请求。

    放在函数里 import：``mcp`` 层与 ``services`` 层都往这儿引用，
    顶层 import 会让这条单向依赖变得不明显。
    """
    from app.services.retrieval import RetrievalQuery

    return RetrievalQuery(query=query, kb_ids=kb_ids, top_k=top_k)
