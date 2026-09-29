"""运行期配置（行为参数），落 SQLite ``app_settings``。

**模型身份不在这里**（v0.8 归属整理）：embedding / rerank / llm 的地址、密钥、
模型名与维度统一由模型注册表承担（``services/model_registry.py``）——
"用哪个模型"只有一个登记入口，避免同一件事在设置页与注册表各写一遍然后不一致。
本模块只留**行为参数**：向量化批大小、对话温度 / 最大回复长度 / 思考开关、
系统提示词、云端解析节点的 token 与地址。

三层优先级（从低到高）：

1. 代码默认值（本模块的 ``DEFAULTS``）；
2. 进程级 ``.env`` 里的 ``KYLAB_*``（**仅作为引导默认值**，方便部署时预设一次）；
3. 数据库 ``app_settings`` —— 网页上改的写在这一层，覆盖上面两层。

密钥的处理口径（见《界面信息架构草案》§3）：
对外**永不回显明文**，只给 ``sk-xu…ten`` 形式的掩码与"是否已配置"；
写入时留空表示"不改动"，不能把掩码当成新值回写。
"""

from __future__ import annotations

import contextlib
import time
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from app.core.config import Settings
from app.core.exceptions import InvalidRequestError
from app.parsers.mineru_cloud import MinerUConfig
from app.parsers.paddleocr_api import PaddleOCRConfig
from app.services import modes
from app.services.embedding.protocols import (
    DEFAULT_PROTOCOL,
    PROTOCOL_OPTIONS,
    WEMM_PROTOCOL,
    normalize_protocol,
    protocol_for_model,
    supports_media,
)
from app.services.llm import LLMConfig
from app.services.thinking import normalize_effort
from app.storage.base import StoreBundle

__all__ = [
    "SECRET_KEYS",
    "SETTING_GROUPS",
    "RuntimeConfigService",
    "mask_secret",
]

#: 哪些键是密钥：对外只回显掩码，且不接受把掩码写回来。
#: **模型凭据（embedding / rerank / llm 的 API Key）不在这里**——它们属于
#: 供应商，只存在注册表里，不经过设置页这一层（见模块头 §"注册入口唯一"）。
SECRET_KEYS = frozenset(
    {
        "mineru.token",
        "paddleocr.token",
        # 联网搜索的密钥（v0.22）：与解析节点同一处置——只回显掩码
        "web.search_api_key",
    }
)

#: 分组与字段定义。前端设置页按这个结构渲染，不自己硬编码字段名。
#:
#: **只放行为参数，不放模型身份**（模型注册 v0.8 的归属整理）：
#: "用哪个模型"在「模型注册」里登记、在「向量化 / 对话模型」里选定；
#: 这里剩下的是"怎么用"——批大小、温度、最大回复长度、思考开关、提示词。
SETTING_GROUPS: dict[str, Any] = {
    "embedding": {
        "label": "向量化",
        "fields": [
            {"key": "embedding.batch_size", "label": "批大小", "type": "int"},
            {
                "key": "embedding.protocol",
                "label": "嵌入协议",
                "type": "select",
                # 值表来自 `services/embedding/protocols.py`（一处定义，别处只 import）：
                # 这里再抄一份字符串，改协议名时就会漏掉一处
                "options": [
                    {"value": value, "label": label} for value, label in PROTOCOL_OPTIONS
                ],
            },
        ],
    },
    "mineru": {
        "label": "MinerU 云端解析",
        "fields": [
            {"key": "mineru.token", "label": "API Token", "type": "secret"},
            {"key": "mineru.model_version", "label": "模型版本", "type": "text"},
            {"key": "mineru.endpoint", "label": "接口地址", "type": "text"},
        ],
    },
    "paddleocr": {
        "label": "PaddleOCR 云端解析",
        "fields": [
            {"key": "paddleocr.token", "label": "API Token", "type": "secret"},
            {"key": "paddleocr.model", "label": "模型", "type": "text"},
            {"key": "paddleocr.endpoint", "label": "接口地址", "type": "text"},
        ],
    },
    "llm": {
        "label": "对话模型（LLM）",
        "fields": [
            {"key": "llm.temperature", "label": "温度", "type": "text"},
            {"key": "llm.enable_thinking", "label": "思考模式", "type": "bool"},
            {
                "key": "llm.thinking_effort",
                "label": "思考强度",
                "type": "select",
                # 归一化三档；具体翻译成哪家的参数由 services/thinking.py 决定
                "options": [
                    {"value": "low", "label": "低（快，省 token）"},
                    {"value": "medium", "label": "中（默认）"},
                    {"value": "high", "label": "高（深，慢）"},
                ],
            },
        ],
    },
    "chat": {
        "label": "对话行为",
        "fields": [
            {"key": "chat.top_k", "label": "带入资料的条数", "type": "int"},
            {
                "key": "chat.section_chars",
                "label": "每条资料的小节长度上限",
                "type": "int",
            },
            {
                "key": "chat.agent_enabled",
                "label": "启用工具循环",
                "type": "bool",
            },
            {
                "key": "chat.mode",
                "label": "任务模式（目标 / 计划）",
                "type": "select",
                # 两档的取值与文案**只有一处来源**（services/modes.py）：在这里再抄一份，
                # 界面上的名字与引擎判定的档迟早会对不上。
                # **它管的是"怎么干活"（要不要先给计划），不是"能碰多少"**——后者是
                # 下一项 `chat.permission`。两根轴是用户 2026-09-27 明确分开的。
                "options": [
                    {"value": item["name"], "label": f"{item['label']}（{item['hint']}）"}
                    for item in modes.describe_modes()
                ],
            },
            {
                "key": "chat.permission",
                "label": "权限（仅查看 / 工作区内编辑 / 完全访问）",
                "type": "select",
                # 三层权限的取值与文案同样只有 `services/modes.py` 一处来源。
                # 输入区那一颗「权限」胶囊读写的也是这一项——与这里同一份数据。
                "options": [
                    {"value": item["name"], "label": f"{item['label']}（{item['hint']}）"}
                    for item in modes.describe_permissions()
                ],
            },
            {
                "key": "chat.context_window",
                "label": "上下文窗口（token）",
                "type": "int",
            },
            {
                "key": "chat.compress_at",
                "label": "上下文压缩阈值（占用百分比）",
                "type": "int",
            },
            {
                "key": "chat.compress_keep",
                "label": "压缩时保留的最近消息条数",
                "type": "int",
            },
            {
                # 与上面那条百分比**取小的那个**（D37）：窗口调到很大时（例如 1M），
                # 70% 就是 70 万 token，等于永远不压缩——绝对值这条才是真正的兜底。
                "key": "chat.compress_max_tokens",
                "label": "压缩预算的绝对上限（token）",
                "type": "int",
            },
        ],
    },
    # 联网（v0.22，见 services/web.py 的模块头）。
    # **搜索需要一个服务商**：没有免密钥又稳定的通用搜索接口，所以它是一项配置。
    # 没配时工具会明确说"去哪配"，而不是返回空结果——空结果会被模型读成
    # "网上没有这件事"，那比报错坏得多。
    # 抓网页（web_fetch）**不需要**这里的任何配置，它只认公网地址。
    # 检索（v0.54 动态返回，见 services/retrieval/distribution.py 的模块头）。
    # **这两项是"用户可配的基础阈值"**：兜底阈值决定统计窗口看多宽，基线是判"这个问题
    # 与库对不对得上"的参照线。它们的默认值来自本机实测（医学库 21580 chunk），
    # 数字是**真余弦**（旧刻度的量法见 services/retrieval/service.py 的
    # `similarity_from_distance`）：无关问题整批落在 0.460–0.520、相关问题在 0.593–0.805，
    # 基线 0.531 卡在中间。
    "retrieval": {
        "label": "检索",
        "fields": [
            {
                "key": "retrieval.floor_score",
                "label": "兜底相似度阈值（动态返回的统计下沿）",
                "type": "float",
            },
            {
                "key": "retrieval.baseline_score",
                "label": "契合度基线（0 = 按嵌入模型自动标定）",
                "type": "float",
            },
        ],
    },
    "web": {
        "label": "联网",
        "fields": [
            {
                "key": "web.search_provider",
                "label": "搜索服务商（tavily / bocha）",
                "type": "text",
            },
            {
                "key": "web.search_api_key",
                "label": "搜索 API 密钥",
                "type": "secret",
            },
        ],
    },
    # 沙箱执行（v0.16，见 docs/设计/Agent-工作区与能力层设计-v0.1.md §4）。
    #
    # **2026-09-27：「命令执行策略」这一项已折进权限轴**（用户在输入区那颗「权限」上选
    # 仅查看 / 工作区内编辑 / 完全访问，见 services/modes.py 的模块头）——
    # 它原来那一项（allow / ask / deny / sandbox）与权限档说的是同一件事，
    # 摆两处必然出现"界面上写着允许、实际还是被拒"。老值仍然认（`coerce_permission` 映射）。
    # 三张清单留在这里，它们不是"策略"而是**规则**（逐条 `Bash(git status:*)`），
    # 与权限档是两回事：档决定"要不要问"，规则决定"这种命令一律不许/一律放行"。
    "sandbox": {
        "label": "沙箱执行",
        "fields": [
            # 三张清单，语法照抄 Claude Code 的权限模型（见 services/command_policy.py）：
            # `Bash(git status:*)` 那样的规则，**deny 永远优先**。
            {
                "key": "sandbox.rules_allow",
                "label": "放行清单（每行一条，如 Bash(git status:*)）",
                "type": "text",
            },
            {
                "key": "sandbox.rules_ask",
                "label": "需确认清单（每行一条）",
                "type": "text",
            },
            {
                "key": "sandbox.rules_deny",
                "label": "拒绝清单（每行一条，优先级最高）",
                "type": "text",
            },
            {
                "key": "sandbox.bind_ro",
                "label": "只读挂载目录（逗号分隔；留空用默认清单）",
                "type": "text",
            },
            # v0.55：无内核隔离时**默认降级为直接执行**（见 services/isolation.py 的模块头）。
            # 打开这一项 = 严格：没有 bwrap / sandbox-exec / docker 时宁可跑不了也不裸跑。
            {
                "key": "sandbox.require_isolation",
                "label": "无内核隔离时拒绝执行（关 = 降级为直接执行，未隔离）",
                "type": "bool",
            },
        ],
    },
    # 记忆（v0.14，见 docs/设计/记忆层设计-v0.1.md）。
    # **默认关**：开着它，对话收尾会真的调一次模型去做沉淀（省 token 是这个项目
    # 反复强调的事），升级之后默默开始烧 token 是最不该有的默认。
    # **这一组里没有"服务地址"**（v0.46）：记忆在我们自己的进程里跑，没有第二个
    # 进程可连——那个设置项随 ReMe 一起删了，"测试连接"也随之删掉。
    "memory": {
        "label": "长期记忆",
        "fields": [
            {"key": "memory.enabled", "label": "启用长期记忆", "type": "bool"},
            {
                "key": "memory.workspace",
                "label": "记忆工作区目录（相对数据目录）",
                "type": "text",
            },
            {
                "key": "memory.capture_every",
                "label": "每多少个用户回合沉淀一次记忆",
                "type": "int",
            },
            {
                "key": "memory.dream_after_hours",
                "label": "每多少小时整理一次现场记忆（0 = 不整理）",
                "type": "int",
            },
            {
                "key": "memory.vector_enabled",
                "label": "记忆检索启用语义（向量）那一路",
                "type": "bool",
            },
            {
                "key": "memory.vector_min_score",
                "label": "语义那一路的余弦下限（越低召回越多）",
                "type": "text",
            },
            {
                "key": "memory.persona_files",
                "label": "每轮注入的人设文件与顺序（逗号分隔）",
                "type": "text",
            },
        ],
    },
}

#: 代码默认值。**只有行为参数**：模型身份来自注册表，没有默认模型这回事。
DEFAULTS: dict[str, str] = {
    "embedding.batch_size": "32",
    # 默认协议 = OpenAI 兼容：没动过这一位时，既有部署的行为一位不变
    # （`services/embedding/protocols.py` 是这张表的定义处）。
    "embedding.protocol": DEFAULT_PROTOCOL,
    "mineru.endpoint": "https://mineru.net/api/v4",
    "mineru.token": "",
    "mineru.model_version": "vlm",
    "paddleocr.endpoint": "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs",
    "paddleocr.token": "",
    "paddleocr.model": "PaddleOCR-VL-1.6",
    "llm.temperature": "0.3",
    # 回复长度上限**不再是设置项**：默认不传，把这个上限交还给模型自己。
    # 曾经是 2048，实测会把回复预算全花在思考上、正文一个字都出不来（且时好时坏）；
    # 改成 16384 只是把概率调低。正确做法是别替模型做主——详见《开发计划》§12.88。
    # 个别端点"不传就退化成很小的默认值"时，走模型注册的 options.max_tokens。
    # 思考**默认开**：主流模型默认都思考，这里的开关只用来"临时关掉"。
    "llm.enable_thinking": "true",
    "llm.thinking_effort": "medium",
    "chat.top_k": "6",
    # 动态返回的两个基础阈值（v0.54，见 services/retrieval/distribution.py）。
    # **两个数都在"真余弦"刻度上**（2026-09-29 换了口径：以前"相似度"按欧氏公式算，
    # 整体虚高，见 services/retrieval/service.py 的 `similarity_from_distance`）。
    # 旧刻度 → 真余弦的换算：``v = 1 - √(2(1 - 旧值))``，同一批实测数换算如下：
    #   兜底阈值 0.80 → **0.368**（取 0.37）：实测无关问题整批落在 0.460–0.520，
    #     统计窗口要比它更低，"答案周围围着多少噪声"才看得出来（相关度下限 0.531
    #     会把这一段剪掉）；
    #   基线 **0（= 自动）** → 按嵌入模型查标定表（bge-m3 → 0.531）。**默认不写死**：
    #     余弦的绝对尺度是模型属性，别的模型上拿别人的基线判"契合程度"会把真命中
    #     全判成噪声；没标定过的模型上这一层只报分布、不判也不收敛。
    # 注意：这两个是**用户可改**的设置。若有人按旧刻度手工填过值（例如 0.80），
    # 换算后它的含义变了（0.80 现在是"相当高"的一条线），应当按新刻度重填一次——
    # 本机开发库里这一项没被改过（`retrieval.floor_score` 走默认）。
    "retrieval.floor_score": "0.37",
    "retrieval.baseline_score": "0",
    # 检索按块命中，但**喂给模型的是整段小节**（v17，见 services/chat.py
    # 的「小块检索、大块阅读」）：0 = 关闭，只给命中的那一块
    "chat.section_chars": "1800",
    # 整块资料的字数预算（v25）：按条数均摊，每条不低于 400 字。
    # 摘要（见 services/summary.py）补上了"这篇文档在讲什么"这层背景，
    # 于是片段本身可以更短——这是本轮省 token 的主要落点。
    "chat.material_chars": "6000",
    # 入库时给每篇文档生成摘要（v25）。它是**省 token 的机制**而不是锦上添花：
    # 一次提问复用一篇摘要，能省掉成倍的资料 token。关掉它只会让问答更贵。
    "ingest.summary_enabled": "true",
    # 对话主流程（见 services/tool_loop.py）：默认走工具循环，知识库检索、联网、
    # Office 导出、子 Agent 都是其中的工具。关掉就退回"原问题单轮检索"的旧路径
    # （services/chat.py::answer_stream）——那条路径还在，用于排查与省钱。
    "chat.agent_enabled": "true",
    # 任务模式两档（2026-09-27 由四档收敛而来，见 services/modes.py 的模块头）。
    # **默认 goal**：直接干活；"要不要先给计划"是用户的活法偏好，而默认该是能干活的那个。
    "chat.mode": modes.DEFAULT_MODE,
    # 权限三档（同上）：**默认"工作区内编辑"**——默认要能干活（"仅查看"当默认，
    # 产品一上来就是废的），而"动整台机器"（执行命令）仍然要问一句，风险留在看得见的地方。
    #
    # 这一项替代了原来的 `sandbox.exec_policy`（那一项的三档已折进权限轴）。
    # **旧键的值不再被读取**，所以升级上来的部署如果原来把它设成 `allow`，
    # 命令的行为会从"直接跑"变成"问一句"——**变化的方向是更安全的那一侧**，
    # 而界面上显示的档（工作区内编辑）与实际行为一致。要放行就在权限那颗上改成"完全访问"。
    # （认旧**值**的映射还在 `modes.coerce_permission` 里：那是给"有人照旧写法写在
    #   `chat.permission` 上"这种情况用的。）
    "chat.permission": modes.DEFAULT_PERMISSION,
    # 上下文压缩（v20.1，见 services/chat.py::prepare_context）：
    # 占用达到阈值就把更早的对话折成摘要，避免长会话撑爆窗口或悄悄失忆。
    # 窗口做成本设置项是因为**没有统一的 API 能查到模型的真实窗口**。
    "chat.context_window": "65536",
    "chat.compress_at": "70",
    "chat.compress_keep": "6",
    # 绝对上限（D37）：比默认窗口的 70%（45875）高，所以**默认配置下一字不改**既有行为；
    # 只有用户把窗口调到很大时它才会先到线（12 万 token）。
    "chat.compress_max_tokens": "120000",
    # **三张清单默认都空**，也就是"一律先问"。
    # 抄的是 Claude Code 的默认：它也不预置放行清单——预置一张"看起来安全"的
    # 只读命令表是危险的，因为**只读不等于无害**：`cat /etc/passwd` 是只读的，
    # 而它能读到工作区外面的东西（内核隔离只管住了写与网络，见设计文档 §4）。
    # 所以放行清单由用户按自己的环境决定，界面上提供"以后都允许"一键写入。
    # 只读挂载清单：留空用 services/isolation.DEFAULT_BIND_RO（只挂运行所需的目录）。
    # **不给"挂整个 /"这个选项**：那正是这一层想避免的形态（见设计文档 §4）。
    "sandbox.bind_ro": "",
    "sandbox.rules_allow": "",
    "sandbox.rules_ask": "",
    "sandbox.rules_deny": "",
    # 无内核隔离时是否拒绝执行（v0.55）。**默认关 = 降级为直接执行**：没有它，
    # Windows 本地与没挂 docker 的容器两边都跑不了命令（用户报的）；
    # 打开它 = 严格，留给高敏部署（见 services/isolation.py 的模块头）。
    "sandbox.require_isolation": "false",
    "web.search_provider": "tavily",
    # 留空 = 没配。**默认不填任何密钥**：预置一个"看起来能用"的值会让
    # 用户以为联网已经开了，然后在第一次搜索时得到一个别人的额度错误。
    "web.search_api_key": "",
    "memory.enabled": "false",
    # 记忆工作区放在数据目录下（相对路径）：与其它数据一起备份/迁移，
    # 一个部署只有一处要备份。
    "memory.workspace": "memory",
    # **每多少个用户回合沉淀一次**。一次沉淀就是一次模型调用
    # （服务层 ``capture`` 要问一遍对话模型"这轮有没有值得记的"），所以节流得我们做。
    # 每轮都沉淀 = 每轮多一次调用，而这个项目反复强调过省 token。
    # 5 这个数沿用 ReMe/QwenPaw 的默认（见设计文档 §2.4）。
    "memory.capture_every": "5",
    # **每多少小时整理一次现场记忆**（Auto-Dream 的等价物，v0.49）。
    # 一次整理就是一次模型调用（要问模型"这些现场里有什么值得沉淀成长期知识的"），
    # 所以节拍定得比捕获松得多：捕获是每 5 个回合，整理是**一天一次**。
    # QwenPaw 那边用的是 cron `0 23 * * *` + 0–60 秒随机延迟；我们没有常驻调度器，
    # 挂在 worker 的空闲分支上（见 core/services.py 的 `_maintain`），
    # 实际精度就是这个间隔。
    #
    # **v0.52 起默认 0 = 不整理**（用户口径："凡是会花钱的都默认关"）。
    # 代价要说清楚：关着时**记忆只增不并**——现场条目会一直躺在 `daily/` 里，
    # 不会自动沉淀成 `digest/` 里的长期知识（界面上那枚「待整合」标记也会一直为真）。
    # 想让它每天自动整理一次，把这一项改成 24；改完**不必重启**。
    #
    # **0 = 不整理**：那是这件事唯一的开关。记忆的总开关只有 `memory.enabled` 一个，
    # 不另立"启用整理"（同一个东西两处判，迟早会分叉，见 design §2.3）。
    "memory.dream_after_hours": "0",
    # **记忆检索的语义（向量）那一路**（v0.50）。默认**关**，理由有两条：
    # ① QwenPaw 那边默认也是关的（`auto_memory_search_config.enabled = false`）；
    # ② 打开它要付嵌入账单（一次对齐要把变了的块全部嵌入），而"规模上不值得"正是
    #    当初把它推后的理由。v0.50 用真模型 + 真工作区量过它确实有用（同义查询
    #    余弦 0.615、无关 0.345），所以**值得开**——但由用户决定付不付这份钱。
    # 关着时检索完全走词面那一路，那条路自己是完整的（不是降级）。
    "memory.vector_enabled": "false",
    # 余弦下限。实测相关 0.61–0.68、无关 0.33–0.35，取中间偏保守的 0.45。
    # **它是可以调的**：样本只有五条，这个数是起点不是定论（见 services/memory_index.py）。
    "memory.vector_min_score": "0.45",
    # **每轮注入哪几份人设文件、按什么顺序**（v0.51，照 QwenPaw 的 ``system_prompt_files``）。
    # 默认顺序的理由写在 ``memory.PERSONA_FILES`` 那张表上（身份 → 资料 → 规程 → 记忆）。
    #
    # 只认那四份核心文件（``memory_files.CORE_FILES``），别的名字会被丢掉并记日志：
    # 让任意路径进 system prompt 等于绕过"哪些是设定、哪些是被召回的现场"这条分界。
    # 空值 = 默认顺序（不是"一份都不注入"）；想去掉哪一份就从这一行里删掉它。
    "memory.persona_files": "SOUL.md,PROFILE.md,AGENTS.md,MEMORY.md",
}


#: 可以被缓存复用的键：本模块自己认识的那些（默认值表 ∪ 设置页字段）。
#:
#: **只缓存这些**是刻意的：``app_settings`` 表同时被别的服务当日志式的键值仓用
#: （``document.<id>.original_path``、``trash.<id>.name``……），那些键按实体生成、
#: 由各自的写入方**直接**落库、不经过本服务的 ``set()``——缓存它们，就会在写入后
#: 最多两秒内读到旧值，而这类"偶尔读到旧值"的 bug 极难复现。
_CACHEABLE_KEYS = frozenset(DEFAULTS) | frozenset(
    field["key"] for spec in SETTING_GROUPS.values() for field in spec["fields"]
)

#: 设置读取的缓存有效期（秒）。
#:
#: 一次读取的固定开销实测约 6ms（PG 自己只花 2ms，其余是连接池借还 + 往返），
#: 而它在**每次请求**的路径上：一轮对话要读十几次（每建一次 LLM 客户端读一次快照，
#: 每轮再读 top_k / section_chars / material_chars），设置页打开一次
#: ``describe()`` 要读几十个键。
#:
#: 2 秒只为吃掉"同一轮里反复读同样的键"，短到改完设置立刻看得见；
#: 何况本进程写设置时（``set``）会**主动清空**缓存——"改完马上看"这条路径根本不走 TTL。
_CACHE_TTL_SECONDS = 2.0


def mask_secret(value: str) -> str:
    """密钥掩码：够长才两头留一点，短密钥整体打码。

    目的是让用户能确认"配的是不是我以为的那把钥匙"，而不是提供任何还原线索——
    所以只回显前后各 3 位。
    """
    if not value:
        return ""
    if len(value) <= 8:
        return "•" * len(value)
    return f"{value[:3]}…{value[-3:]}"


def _as_int(raw: str, fallback: int) -> int:
    """宽松解析整数（同 ``_as_float`` 的理由：设置页里是自由文本）。"""
    try:
        return int(raw)
    except (TypeError, ValueError):
        return fallback


def _as_float(raw: str, fallback: float) -> float:
    """宽松解析：设置页里温度是自由文本，写错了退回默认值而不是崩。"""
    try:
        return float(raw)
    except (TypeError, ValueError):
        return fallback


@dataclass(frozen=True, slots=True)
class EmbeddingSettings:
    """向量化配置的快照。"""

    base_url: str
    api_key: str
    model_id: str
    dim: int
    batch_size: int
    protocol: str = DEFAULT_PROTOCOL
    """走哪套嵌入协议（``openai`` / ``wemm``，见 `services/embedding/protocols.py`）。

    它是**行为参数**（与批大小同族）而不是模型身份，所以留在设置页那一层：
    模型身份（地址 / 密钥 / 模型名 / 维度）在模型注册表里按库冻结。
    """

    @property
    def is_configured(self) -> bool:
        """有（协议需要的）凭据、有模型、维度为正，才算配好。

        **"必须有 key"只对 OpenAI 兼容那一档成立**：局域网那台 WeMM 没有鉴权
        （接入文档 §5 的客户端一个 Authorization 都不发），要求它填 key 等于逼用户编一个
        假值；反过来 OpenAI 兼容没 key 基本就是没配好（401 会一直失败），所以那条照旧。
        两档都要有**地址**：一个没有地址的嵌入模型无从调用。
        """
        if not (self.model_id and self.dim > 0):
            return False
        if self.protocol == WEMM_PROTOCOL:
            return bool(self.base_url)
        return bool(self.api_key)


@dataclass(frozen=True, slots=True)
class RerankSettings:
    """重排配置的快照；未配置时检索整体跳过重排（架构 §5）。"""

    base_url: str
    api_key: str
    model_id: str

    @property
    def is_configured(self) -> bool:
        return bool(self.api_key and self.model_id)


class RuntimeConfigService:
    """读写运行期配置，并把配置解析成各模块直接可用的快照。"""

    def __init__(
        self,
        stores: StoreBundle,
        settings: Settings | None = None,
        *,
        registry: object | None = None,
    ) -> None:
        self._stores = stores
        self._settings = settings
        self._registry = registry
        """模型注册器（G1）。**可选**：没有它时全部走 .env / 设置页那套，
        所以既有部署与既有测试不受影响——注册器是叠加层，不是替换。"""
        #: 设置值的短 TTL 缓存（键 → (读入时刻, 库里的值或 None)）。
        #: 见 ``_CACHE_TTL_SECONDS`` 与 ``_CACHEABLE_KEYS``。
        self._cache: dict[str, tuple[float, str | None]] = {}

    # ------------------------------------------------------------------ 读写

    @property
    def data_dir(self):
        """数据目录（运行期数据的落点）。

        **从设置来而不是再传一遍**：组合根已经把它给了记忆/工作区/技能三个服务，
        再给沙箱传一次就多一个可能对不上的副本。沙箱端点要它来定位沙箱根
        （``data/sandbox/<会话>/``）。
        """
        return self._settings.data_dir

    def get(self, key: str) -> str:
        """取一个键的最终值：数据库 > .env 引导值 > 代码默认值。

        热路径上的键走**短 TTL 缓存**（见 ``_CACHE_TTL_SECONDS``）。
        """
        stored = self._cached(key)
        if stored is not None:
            return stored
        boot = self._bootstrap_value(key)
        if boot:
            return boot
        return DEFAULTS.get(key, "")

    # ------------------------------------------------------------------ 缓存

    def _many_cached(self, keys: Sequence[str]) -> dict[str, str]:
        """库里的值（**只含确实存在的键**）；可缓存的键走短 TTL 缓存。

        `None`（库里没有这一项）也会被记住：否则"没配过的键"每次都白查一遍，
        而设置页打开的 ``describe()`` 里大半都是这种键。
        """
        now = time.monotonic()
        found: dict[str, str] = {}
        pending: list[str] = []
        for key in keys:
            cached = self._cache.get(key) if key in _CACHEABLE_KEYS else None
            if cached is not None and now - cached[0] <= _CACHE_TTL_SECONDS:
                if cached[1] is not None:
                    found[key] = cached[1]
                continue
            pending.append(key)

        if not pending:
            return found
        stored = self._stores.meta.get_settings(pending)
        for key in pending:
            value = stored.get(key)
            if key in _CACHEABLE_KEYS:
                self._cache[key] = (now, value)
            if value is not None:
                found[key] = value
        return found

    def _cached(self, key: str) -> str | None:
        """单个键的库值（可能确实没有这一项 → ``None``）。"""
        return self._many_cached([key]).get(key)

    def get_many(self, keys: Sequence[str]) -> dict[str, str]:
        """一次取多个键，**一条 SQL**（§12.116）。

        为什么值得单独开一个入口：一次查询的固定开销（连接池借还 + 往返）实测约 6ms，
        而 PG 自己只花 2ms——**成本几乎全在"往返次数"上**。取三个键就是三次往返、
        约 18ms（实测 ``mineru()`` 正好是 17.97ms）。而取模型快照的那几个入口
        （``mineru`` / ``paddleocr`` / ``llm`` / ``embedding``）都在**每次请求**的
        路径上（负载面板每 2 秒一次、对话每轮一次），这笔固定税很显眼。

        返回值保证**包含每个请求的键**：调用方按 ``values[key]`` 取，不必写兜底。
        优先级与 ``get`` 完全一致（库 > 引导值 > 默认值）——两条路径不能有第二种答案。

        可缓存的键走短 TTL 缓存（见 ``_CACHE_TTL_SECONDS``）：这个方法在热路径上，
        而一次查询的固定开销（连接池借还 + 往返）比 PG 自己花的还多。
        """
        ordered = list(dict.fromkeys(keys))
        if not ordered:
            return {}
        stored = self._many_cached(ordered)
        return {
            key: (
                stored[key]
                if key in stored
                else (self._bootstrap_value(key) or DEFAULTS.get(key, ""))
            )
            for key in ordered
        }

    def get_int(self, key: str) -> int:
        raw = self.get(key)
        try:
            return int(raw)
        except ValueError:
            return int(DEFAULTS.get(key, "0") or 0)

    def get_float(self, key: str) -> float:
        """取一个浮点设置（口径与 :meth:`get_int` 一致：解析不了就回落默认值）。

        记忆的向量下限（``memory.vector_min_score``）是第一个浮点设置——**它必须能调**：
        0.45 那个数是五条样本量出来的起点，不是一个定论（见 ``memory_index``）。
        """
        raw = self.get(key)
        try:
            return float(raw)
        except ValueError:
            return float(DEFAULTS.get(key, "0") or 0)

    def get_bool(self, key: str, *, default: bool = False) -> bool:
        """取一个布尔设置。

        取值口径在这里统一：**空值回落默认**，否则认 ``1/true/yes/on``（不区分大小写）。
        此前这个判断在 ``api/v1/chat.py`` 里手写过一遍，记忆层的开关会是第二遍——
        而"同一件事两处判断"正是这类开关最容易分叉的地方（一处把空当关、另一处当开）。
        """
        raw = self.get(key)
        if raw is None or not raw.strip():
            return default
        return raw.strip().lower() in {"1", "true", "yes", "on"}

    def set(self, values: dict[str, str], *, clear_secrets: set[str] | None = None) -> None:
        """写入一批配置。

        - 空字符串：密钥视为"清除"，非密钥视为"恢复默认"（写空即回落默认值）；
        - ``clear_secrets`` 里的键即使给了值也只清空——用于"删除凭据"这个明确动作。
        """
        drop = clear_secrets or set()
        for key, value in values.items():
            if key in drop:
                self._stores.meta.set_setting(key, "")
                continue
            text = (value or "").strip()
            # 掩码被当成新值回写是最容易踩的坑：界面上显示的 `sk-xu…ten` 不是密钥
            if key in SECRET_KEYS and "…" in text:
                continue
            self._stores.meta.set_setting(key, text)
        # 写完立刻清缓存：否则"改完马上看"会读到最多两秒前的旧值（见 _CACHE_TTL_SECONDS）
        self._cache.clear()

    def describe(self) -> dict[str, Any]:
        """给前端的配置视图：分组、字段、掩码后的值、是否已配置。"""
        groups = []
        for group_key, spec in SETTING_GROUPS.items():
            fields = []
            for field in spec["fields"]:
                raw = self.get(field["key"])
                is_secret = field["key"] in SECRET_KEYS
                entry: dict[str, Any] = {
                    "key": field["key"],
                    "label": field["label"],
                    "type": field["type"],
                    # 密钥只给掩码；前端据此显示"已配置 sk-xu…ten"
                    "value": mask_secret(raw) if is_secret else raw,
                    "configured": bool(raw),
                }
                # 下拉项的候选值。只有 select 类字段带它，前端据此渲染 AppSelect。
                if field.get("options"):
                    entry["options"] = list(field["options"])
                fields.append(entry)
            groups.append({"key": group_key, "label": spec["label"], "fields": fields})
        return {"groups": groups}

    # ------------------------------------------------------------------ 注册器桥接

    def _bound(self, slot: str) -> tuple[object, object] | None:
        """取某用途在注册器里绑定的（供应商, 模型）；未绑定或注册器缺席返回 ``None``。

        **用鸭子类型而不是导入 ModelRegistryService**：两者会互相引用
        （注册器要用 get_setting，配置要用 resolve），真导入就成环。
        这里的契约很小（只要一个 ``resolve``），不值得为它引入依赖注入框架。
        """
        registry = self._registry
        if registry is None:
            return None
        resolver = getattr(registry, "resolve", None)
        if resolver is None:
            return None
        return resolver(slot)  # type: ignore[no-any-return]

    # ------------------------------------------------------------------ 快照

    def embedding(self) -> EmbeddingSettings:
        """向量化配置快照——**模型身份只来自模型注册表**（v0.8 归属整理）。

        没绑定「向量化」用途就是没配：``is_configured`` 为假，调用方据此报错，
        而不是退回某个"看起来能用"的实现。批大小与**协议**是行为参数，仍在设置页。
        """
        batch_size = _as_int(self.get("embedding.batch_size"), 32) or 32
        protocol = normalize_protocol(self.get("embedding.protocol"))
        bound = self._bound("embedding")
        if bound is None:
            return EmbeddingSettings(
                base_url="",
                api_key="",
                model_id="",
                dim=0,
                batch_size=batch_size,
                protocol=protocol,
            )
        provider, model = bound
        return EmbeddingSettings(
            base_url=provider.base_url,
            api_key=provider.api_key,
            model_id=model.model_id,
            # 维度是模型属性：注册表登记了才算数，不再从设置页补
            dim=model.dim or 0,
            batch_size=batch_size,
            protocol=protocol,
        )

    def embedding_supports_media(self) -> bool:
        """这台机器上**有没有任何一处**能嵌图片 / 视频。

        **门控不能只看全局默认协议**：协议现在是按模型的（`protocols.protocol_for_model`），
        "全局默认还是 openai、但某个库绑的是 WeMM 模型"是完全正常的组合——那种情况下
        媒体直通解析器也必须挂上，否则那个库的图片 / 视频连进都进不来（解析阶段就被
        "暂不支持"拦掉了，走不到向量那一步）。

        判据两条：全局默认协议本身支持媒体，或者**任一已登记的嵌入模型**在 ``options``
        里声明了一个支持媒体的协议。注册器缺席（老部署、手工构造的配置）时只看全局默认。
        """
        if supports_media(self.embedding().protocol):
            return True
        lister = getattr(self._registry, "list_models", None)
        if lister is None:
            return False
        try:
            models = lister()
        except Exception:
            # 注册表读不到（库抖动 / 权限）不该让整条解析链挂掉：退回"只看全局默认"，
            # 这是配置缺失而不是文档处理失败——与 `_bound` 的宽容口径一致。
            return False
        return any(
            supports_media(protocol_for_model(getattr(model, "options", None), ""))
            for model in models
        )

    def rerank(self) -> RerankSettings:
        """重排快照：同样只来自注册表；未绑定即未启用（跳过重排，不影响检索可用性）。"""
        bound = self._bound("rerank")
        if bound is None:
            return RerankSettings(base_url="", api_key="", model_id="")
        provider, model = bound
        return RerankSettings(
            base_url=provider.base_url,
            api_key=provider.api_key,
            model_id=model.model_id,
        )

    def mineru(self) -> MinerUConfig:
        values = self.get_many(("mineru.token", "mineru.endpoint", "mineru.model_version"))
        return MinerUConfig(
            token=values["mineru.token"],
            endpoint=values["mineru.endpoint"],
            model_version=values["mineru.model_version"],
        )

    def paddleocr(self) -> PaddleOCRConfig:
        values = self.get_many(("paddleocr.token", "paddleocr.endpoint", "paddleocr.model"))
        return PaddleOCRConfig(
            token=values["paddleocr.token"],
            endpoint=values["paddleocr.endpoint"],
            model=values["paddleocr.model"],
        )

    def llm(self) -> LLMConfig:
        """对话模型快照。

        **身份（base_url / key / model_id）只来自注册表**（v0.8 归属整理）；
        采样参数（temperature / max_tokens / thinking）来自设置页——它们是
        "这次怎么问"而不是"用哪家模型"，换个模型通常也不想重新调一遍。
        没绑定「对话生成」就是没配，``is_configured`` 为假，对话会明确报错。
        """
        temperature, max_tokens, thinking, effort = self._sampling()

        bound = self._bound("chat")
        if bound is None:
            return LLMConfig(
                base_url="",
                api_key="",
                model_id="",
                temperature=temperature,
                max_tokens=max_tokens,
                enable_thinking=thinking,
                thinking_effort=effort,
            )

        provider, model = bound
        return self._llm_config(provider, model)

    def llm_for(self, model_pk: str | None) -> LLMConfig:
        """按**指定注册模型**取对话快照；``model_pk`` 为空等价于 ``llm()``。

        ``llm()`` 只认注册表里绑定给 ``chat`` 的全局默认模型；会话级选模型（v12）
        需要一个"就用这一个"的入口。**能不能用交校验给注册器的 ``chat_target``**：
        模型不存在 / 没声明对话能力 / 供应商停用或没密钥，都在那里给出可读的 422。
        """
        if not model_pk:
            return self.llm()
        target = getattr(self._registry, "chat_target", None)
        if target is None:
            raise InvalidRequestError("模型注册表不可用，无法按指定模型对话")
        provider, model = target(model_pk)
        return self._llm_config(provider, model)

    def _llm_config(self, provider: object, model: object) -> LLMConfig:
        """把（供应商, 模型）折成 ``LLMConfig``：采样参数取设置页，模型 options 可覆盖。

        不同模型对采样参数的最优区间不同（推理模型通常要更低的 temperature），
        所以模型自带的默认值优先于设置页。
        """
        temperature, max_tokens, thinking, effort = self._sampling()
        dialect: str | None = None
        options = getattr(model, "options", None) or {}
        if "temperature" in options:
            temperature = _as_float(str(options["temperature"]), temperature)
        if "max_tokens" in options:
            # 登记时可能填了非数字；解析不了就沿用手上的值，不要让整次对话失败
            with contextlib.suppress(TypeError, ValueError):
                max_tokens = int(options["max_tokens"])  # type: ignore[arg-type]
        if "enable_thinking" in options:
            thinking = bool(options["enable_thinking"])
        if "thinking_effort" in options:
            effort = normalize_effort(options["thinking_effort"], effort)
        if options.get("thinking_dialect"):
            dialect = str(options["thinking_dialect"]).strip().lower()
        return LLMConfig(
            base_url=getattr(provider, "base_url", ""),
            api_key=getattr(provider, "api_key", ""),
            model_id=getattr(model, "model_id", ""),
            temperature=temperature,
            max_tokens=max_tokens,
            enable_thinking=thinking,
            thinking_effort=effort,
            thinking_dialect=dialect,
        )

    def _sampling(self) -> tuple[float, int | None, bool, str]:
        """设置页那几档采样参数的快照：温度、回复长度上限、思考开关与强度。

        **回复长度上限默认是 ``None``（请求里不发这个字段）**：上限本来就是模型自己的事，
        不传时端点会一直生成到模型自然收尾。我们拍一个数字只会引入新故障——
        2048 时实测过"思考把预算吃光、正文一个字都出不来"，而且随采样时好时坏。
        只有模型注册里显式写了 ``options.max_tokens`` 才发（见 ``llm_for``），
        那是给"不传就用一个很小默认值"的端点留的手动出路。
        """
        values = self.get_many(("llm.temperature", "llm.enable_thinking", "llm.thinking_effort"))
        temperature = _as_float(values["llm.temperature"], 0.3)
        thinking = values["llm.enable_thinking"].lower() in ("1", "true", "yes", "on")
        effort = normalize_effort(values["llm.thinking_effort"])
        return temperature, None, thinking, effort

    def normalize_modes(self) -> list[str]:
        """把**旧取值**写回新档（一次迁移，启动时跑）；返回改过的键与前后值。

        为什么不是"只在读的时候映射"：设置页下拉项是按**新**取值生成的，库里留着
        旧的 `build` 时那一格会显示成**空**——界面与引擎不一致正是最难查的一类问题。
        写回之后三处（库、界面、引擎）说的是同一个词。

        只动确实需要改的键：库里没有那一项时什么都不做（**不**替用户写一条新记录，
        那会让"这一项从来没配过"变成"配过且等于默认"）。
        """
        changed: list[str] = []
        pairs = (
            ("chat.mode", modes.coerce),
            ("chat.permission", modes.coerce_permission),
        )
        for key, coerce in pairs:
            raw = self._cached(key)
            if raw is None:
                continue
            fixed = coerce(raw)
            if fixed != raw:
                self.set({key: fixed})
                changed.append(f"{key}: {raw} → {fixed}")
        return changed

    # ------------------------------------------------------------------ 引导值

    def _bootstrap_value(self, key: str) -> str:
        """``.env`` 只作为引导：部署时可以预设一次，之后以网页上的值为准。

        **模型身份不在映射里**（v0.8）：embedding / rerank / llm 的地址与密钥由
        模型注册表承担，``.env`` 里写也不生效——留着半生效的入口比没有更糟。
        """
        settings = self._settings
        if settings is None:
            return ""
        mapping = {
            "embedding.batch_size": settings.embedding_batch_size,
            "embedding.protocol": settings.embedding_protocol,
            "mineru.token": settings.mineru_token,
            "paddleocr.token": settings.paddleocr_token,
            "llm.temperature": settings.llm_temperature,
            "llm.enable_thinking": settings.llm_enable_thinking,
            "llm.thinking_effort": settings.llm_thinking_effort,
            # 长期记忆（v0.1.1）：容器部署要在 .env/compose 里一次写清"开关 / 落点"，
            # 而这些键原先在映射表里没有——写进 .env 也**不生效**。
            # 两项默认都是 None（没设），于是不设时照旧回落到 DEFAULTS。
            # **服务地址那一项已删**（v0.46）：记忆跑在我们自己的进程里，
            # 没有第二个进程可连（见 services/memory.py 的模块头）。
            "memory.enabled": settings.memory_enabled,
            "memory.workspace": settings.memory_workspace,
            # Agent 模式（P1-1）同一套口径：容器部署可以在 compose 里一次写清
            # "这一部署默认用哪一档"（``KYLAB_CHAT_MODE``），网页上改的仍然覆盖它。
            "chat.mode": settings.chat_mode,
        }
        value = mapping.get(key)
        return "" if value is None else str(value)
