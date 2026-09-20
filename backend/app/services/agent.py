"""对话链路的事件类型（服务层内部契约）。

本模块只放**纯逻辑**：事件数据结构。检索与模型调用留在 ``services/chat.py``
（那里才拿得到检索服务与配置），这样本模块不依赖任何服务，也就不会与 chat.py
形成循环导入。

**历史（v0.2 清理）**：这里曾经装着"意图识别 → 检索词改写 → 多轮检索工具"那一整套
——``PLAN_PROMPT`` / ``DECIDE_PROMPT`` / ``parse_plan`` / ``parse_decision`` /
``AgentPlan`` / ``AgentDecision`` / ``intent_label`` 与它们的解析辅助函数。
它的前提是"模型不支持原生工具调用，所以把检索描述成提示词里的一个工具，
让模型输出 JSON 表态"（见 v0.1 的架构说明）。对话主流程换成原生 ``tools``
参数的工具循环（``services/tool_loop.py``）之后，那一整条链路**没有任何调用者**：
旧函数还占着"主 Agent 逻辑"的位置，连设置页都挂着一个只有它在读的选项
（``chat.agent_max_rounds``，改了不生效）。整套删除，只留事件类型——
它们仍是 API 层与前端共用的 wire contract。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # 只为类型标注；运行时不需要，避免与 chat.py 循环导入
    from app.services.chat import SourceRef

__all__ = [
    "DeltaEvent",
    "DoneEvent",
    "SourcesEvent",
    "StepEvent",
    "ThinkingEvent",
]


# --------------------------------------------------------------------- 事件
# 服务层内部的进度事件，由 api/v1/chat.py 翻成 SSE 的 type 字段。
# 用 dataclass 而不是裸 dict：事件形状是这条链路的对外契约，写死类型才能在改动时被
# 类型检查与测试拦住（协议层负责序列化，服务层不碰 wire format）。


@dataclass(frozen=True, slots=True)
class StepEvent:
    """工作流里的一个步骤（第 N 次检索、组织回答……）。"""

    phase: str
    label: str
    detail: str = ""
    status: str = "done"  # "running" | "done"
    degraded: bool = False
    """这一步**没按设计跑成**，走了降级路径。

    **目前没有生产者**：唯一会置位它的是旧的多轮检索链路（它会在"规划不可用"时
    退回单轮检索），那条链路已随工具循环删除。字段本身、API 层的转发
    （``api/v1/chat.py``）与前端的重试入口都还在——收口它要同时动 wire contract
    与界面，那是另一次决定，不在这轮代码清理里顺手做（见《开发计划》§12.172）。
    """
    added: int | None = None
    """本步带来的**新增**资料条数（只有检索步骤有）。同样是旧链路的遗留字段，
    现状与 ``degraded`` 相同：没有生产者，保留待与前端一并收口。"""

    args: str = ""
    """模型给这个工具的**原始入参**（JSON 字符串，v0.25）。

    给界面"点开看这一步到底调了什么"用——只给 ``detail`` 那一行人话摘要的话，
    用户没法判断"检索知识库"这次查的是什么词、为什么没命中。

    保留**原始字符串**而不是解析后的 dict：模型可能给出不完整或不合法的 JSON,
    而这里只是要给用户看，不该因为解析失败就把整条步骤丢掉。
    """

    result: str = ""
    """工具返回的正文（v0.25，已按 ``MAX_STEP_RESULT_CHARS`` 截断）。

    与 ``detail`` 的分工：``detail`` 是**结论**（「命中 8 段」），
    它是**原文**。界面默认只显示结论，用户点开才看原文。
    """

    tool: str = ""
    """这一步调的是**哪个工具**（``web_search`` / ``fetch_url`` / ``search``…，v0.26）。

    为什么不能从 ``label`` 推：label 是给人看的中文（「联网搜索」），
    它会被改写、会为了顺口而合并；而界面要拿它做两件事——**挑图标**与**把同类调用并成一组**，
    两件都要求它是个稳定标识。``phase`` 也不行：所有工具调用的 phase 都是 ``tool``。

    非工具步骤（理解问题、组织回答）是空串。
    """

    artifacts: tuple[dict[str, object], ...] = ()
    """这一步**产出的文件**（v0.25）：导出类工具生成的那份东西。

    为什么要单独带出来：那些工具原本只在 `detail` 里说一句"已存进知识库"，
    于是界面上**没有可点的东西**——用户要下载还得自己去文档列表里找。
    带上 id 与名字之后，界面能在这一步下面挂一张文件卡片，点开就是下载。

    ``sources`` 是"这一步读到了什么"，``artifacts`` 是"这一步产出了什么"，
    两个方向不同，所以是两个字段而不是一个。
    """


@dataclass(frozen=True, slots=True)
class SourcesEvent:
    """当前累计的资料出处（多次检索会多次发出，始终是累计列表）。"""

    sources: list[SourceRef] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class ThinkingEvent:
    """思考过程增量（推理模型的 reasoning_content）。"""

    text: str


@dataclass(frozen=True, slots=True)
class DeltaEvent:
    """正文增量。"""

    text: str


@dataclass(frozen=True, slots=True)
class DoneEvent:
    """回答结束，带后端拼装好的全文。"""

    answer: str
