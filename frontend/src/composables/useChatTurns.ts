/**
 * 对话页的「回合」组织与「过程面板」数据（《前端设计规范》§6）。
 *
 * 为什么单独成模块而不是写在 ChatView 里：这些是全页最需要被验证的判断
 * （引用摘要说什么、哪些步骤该出现、引用该跳去哪），而它们**都不依赖组件**——
 * 纯输入纯输出。留在 SFC 里就只能靠挂载整页来测，而挂载一次要起路由、三个 store
 * 和一堆接口假件；搬出来之后用普通单测就能盯住。
 *
 * 这里刻意只管**数据**，不管渲染：图标名（`TraceStep.icon`）交给页面去映射，
 * 免得一个纯逻辑模块去 import 一堆 .vue。
 */

import type { ChatSource, ChatStep } from '@/api/chat'

export type ThinkingEffort = 'low' | 'medium' | 'high'

/** 强度三档。与后端 ``services/thinking.py`` 的归一化口径一致，界面只暴露这三个。 */
export const THINKING_EFFORTS: { value: ThinkingEffort; label: string }[] = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
]

export interface Message {
  role: 'user' | 'assistant'
  /** 用户消息是提问原文；助手消息是流式累积的回答（或错误文案）。 */
  text: string
  sources: ChatSource[]
  error: string
  streaming: boolean
  /**
   * 这一轮实际用的思考档（v16）。
   *
   * 只有**当场发出去的那一轮**知道；历史回放拿不到（会话记的是"这条会话的偏好"，
   * 不是每轮的），所以回放时是 `null`——过程面板就不显示"深度思考"这一步。
   * 宁可少一步，也不拿会话级的偏好冒充某一轮的事实。
   */
  thinking: { enabled: boolean; effort: ThinkingEffort } | null
  /**
   * Agent 工作流的步骤（v20）。历史回放没有它（后端只存回答正文），
   * 此时过程面板退回"检索 + 生成"两步的静态版本。
   */
  steps: ChatStep[]
  /** 流式收到的思考过程（推理模型的 reasoning_content）；历史回放为空。 */
  thinkingText: string
  /** 过程面板的展开态；`undefined` = 跟随默认（流式中、还没吐字时默认展开）。 */
  traceOpen?: boolean
}

/**
 * 一次问答（提问 + 回答）在界面上的分组。
 *
 * 消息在数据层是**平铺**的一条条（后端就是这么存的，流式也是逐条追加）；
 * 但界面上"提问气泡 + 回答"是一个整体，所以渲染前先配对。
 * 不配对就得靠 `:has()` 之类的选择器判断间距与分组，既脆又难读。
 */
export interface Turn {
  user: Message | null
  reply: Message | null
}

/** 过程面板里的一步。`icon` 是键，由页面映射成具体图标组件。 */
export interface TraceStep {
  key: string
  icon: 'search' | 'think' | 'build' | 'tool'
  label: string
  detail: string
  /** 这一步一个片段都没新增（只有检索步骤有）：界面上弱化它，别和"有收获"的轮次一样重。 */
  empty?: boolean
}

/** 提问原文在面板里只显示一小段：它是"检索了什么"的提示，不是内容主体。 */
export const TRACE_QUERY_CHARS = 44

/**
 * 新建一条消息。字段齐全，避免每处字面量漏掉新加的字段
 * （v20 加 `steps` / `thinkingText` 时就差点漏了回放那条路径）。
 */
export function makeMessage(
  role: Message['role'],
  text: string,
  extra: Partial<Message> = {},
): Message {
  return {
    role,
    text,
    sources: [],
    error: '',
    streaming: false,
    thinking: null,
    steps: [],
    thinkingText: '',
    ...extra,
  }
}

/**
 * 引文在界面上只留一小段。
 *
 * 后端的 preview 上限是 900 字（``MAX_CHUNK_CHARS``），那是给**模型**的上下文预算；
 * 照搬到界面上，六条引用会变成六屏长的文字墙——实测每条都比视口还高，
 * "引用列表"看起来就不再是列表。这里按界面用途再切一刀。
 */
export const CITE_PREVIEW_CHARS = 120

/** 把平铺的消息按"提问 → 回答"配对。 */
export function buildTurns(messages: readonly Message[]): Turn[] {
  const out: Turn[] = []
  for (const message of messages) {
    const last = out.at(-1)
    if (message.role === 'user') {
      // 连续两条用户消息不会出现（发送时成对追加），但真出现了也各自成组，不吞掉
      out.push({ user: message, reply: null })
    } else if (last && !last.reply) {
      last.reply = message
    } else {
      out.push({ user: null, reply: message })
    }
  }
  return out
}

/** 摘要行：一眼回答"这句话有没有出处"。 */
export function traceSummary(message: Message): string {
  if (message.streaming && message.sources.length === 0) {
    // 有 Agent 步骤就照它说，用户能看出"卡在理解还是卡在检索"
    const phase = message.steps.at(-1)?.phase
    if (phase === 'intent') return '正在理解问题…'
    if (phase === 'rewrite') return '正在优化检索词…'
    // 工具步要**说清在做什么**：这一步可能真的要跑几秒（检索、写文件、连外部服务），
    // 只写"处理中"会让人以为卡住了。label 是后端给的中文名，直接用。
    if (phase === 'tool') {
      const label = message.steps.at(-1)?.label
      return label ? `正在${label}…` : '正在调用工具…'
    }
    return '正在检索知识库…'
  }
  if (message.sources.length === 0) return '检索完成 · 没有命中相关内容'
  const documents = new Set(message.sources.map((item) => item.document_id)).size
  return `检索完成 · 引用了 ${message.sources.length} 个片段 · ${documents} 篇文档`
}

/**
 * 这一轮里有没有走过降级路径（只有"规划不可用"一种）。
 *
 * 放在这里而不是页面上现算：历史回放（后端只存正文）拿不到步骤，那时它就该是 false，
 * 页面不必自己判断"有没有 steps"。
 */
export function wasDegraded(message: Message): boolean {
  return message.steps.some((step) => step.degraded === true)
}

/** Agent 步骤的阶段 → 图标键。 */
const STEP_ICONS: Record<string, TraceStep['icon']> = {
  intent: 'think',
  rewrite: 'search',
  retrieve: 'search',
  answer: 'build',
  // 工具调用（P0 起的主流程）：一次工具就是一步，名字由后端给（"检索知识库""写笔记"…）
  tool: 'tool',
}

/**
 * 追加一个 Agent 步骤。
 *
 * 后端对"理解问题"会先发一条 ``running`` 占位、随后发一条同名 ``done``；
 * 占位要**就地替换**而不是追加，否则面板里会出现两行"理解问题"。
 * 检索轮次（"第 2 轮检索"）名字各不相同，不会被误合。
 */
export function mergeStep(steps: readonly ChatStep[], step: ChatStep): ChatStep[] {
  if (step.status !== 'running') {
    const index = steps.findIndex(
      (item) => item.phase === step.phase && item.label === step.label && item.status === 'running',
    )
    if (index >= 0) {
      const next = steps.slice()
      next[index] = step
      return next
    }
  }
  return [...steps, step]
}

/**
 * 过程步骤。
 *
 * 有 Agent 步骤就**如实照搬**（理解问题 → 优化检索词 → 第 N 轮检索 → 组织回答），
 * 这些是后端真的做过的动作；历史回放（后端只存正文）拿不到步骤，
 * 退回"检索 + 生成"两步的静态版本。思考这一轮开了才补一行。
 */
export function traceSteps(turn: Turn): TraceStep[] {
  const message = turn.reply
  if (!message) return []
  if (message.steps.length > 0) return agentTraceSteps(message)
  return legacyTraceSteps(turn)
}

function agentTraceSteps(message: Message): TraceStep[] {
  // 显式标注元素类型：不标的话 TS 会把 `empty` 推成必填，后面 unshift 思考那一步就类型不兼容
  const steps: TraceStep[] = message.steps.map((step, index) => ({
    key: `${step.phase}-${index}`,
    icon: STEP_ICONS[step.phase] ?? 'search',
    label: step.label,
    detail: step.phase === 'answer' ? answerDetail(message) : step.detail,
    // "这一轮什么新东西都没找到"在过程面板里要轻一档：它是一句交代，不是一次收获
    empty: step.added === 0,
  }))
  if (message.thinking?.enabled && !steps.some((item) => item.icon === 'think')) {
    steps.unshift(...thinkingStep(message))
  }
  return steps
}

/** 老链路（Agent 关闭，或回放没有步骤的历史）：只有检索与生成两步。 */
function legacyTraceSteps(turn: Turn): TraceStep[] {
  const message = turn.reply
  if (!message) return []
  const query = turn.user?.text ?? ''
  const short = query.length > TRACE_QUERY_CHARS ? `${query.slice(0, TRACE_QUERY_CHARS)}…` : query
  const searching = message.streaming && message.sources.length === 0
  const steps: TraceStep[] = [
    {
      key: 'retrieve',
      icon: 'search',
      label: '检索知识库',
      detail: searching
        ? `「${short}」`
        : message.sources.length === 0
          ? `「${short}」没有命中任何片段`
          : `「${short}」找到 ${message.sources.length} 个片段`,
    },
  ]
  if (message.thinking?.enabled) steps.push(...thinkingStep(message))
  steps.push({
    key: 'answer',
    icon: 'build',
    label: message.streaming ? '正在生成回答' : '已生成回答',
    detail: answerDetail(message),
  })
  return steps
}

function thinkingStep(message: Message): TraceStep[] {
  const effort = THINKING_EFFORTS.find((item) => item.value === message.thinking?.effort)
  return [
    {
      key: 'think',
      icon: 'think',
      label: '深度思考',
      detail: effort ? `强度：${effort.label}` : '',
    },
  ]
}

function answerDetail(message: Message): string {
  if (message.streaming) return '正在生成…'
  return message.text.length > 0 ? `共 ${message.text.length} 字` : ''
}

/**
 * 面板是否展开。
 *
 * 默认"边等边看"：还没吐字的那几秒，屏幕上除了这个过程没有别的东西可看，
 * 它就是进度条。第一个字一到就自动收起，把地方让给正文——
 * 用户手动点过之后（`traceOpen` 有值）就完全听用户的。
 */
export function isTraceOpen(message: Message): boolean {
  if (message.traceOpen !== undefined) return message.traceOpen
  return message.streaming && message.text.length === 0
}

/** 引用一行："文档名 › 章节（第 N 页）"——章节与页码可能缺，缺了就不占位。 */
export function sourceWhere(source: ChatSource): string {
  const parts: string[] = []
  if (source.heading_path) parts.push(source.heading_path)
  if (source.page !== null) parts.push(`第 ${source.page} 页`)
  return parts.join(' › ')
}

/** 出处正文的界面截断（后端那份是给模型的，见 CITE_PREVIEW_CHARS）。 */
export function sourcePreview(source: ChatSource): string {
  const body = source.preview
  return body.length > CITE_PREVIEW_CHARS ? `${body.slice(0, CITE_PREVIEW_CHARS)}…` : body
}

/*
 * 这里原先有个 `documentTarget(source)`：把引用拼成 `/kb/:id?doc=…&page=…`，
 * 让用户跳去知识库页的文档抽屉。
 *
 * v18 起删掉了——点出处改成**在对话页就地滑出右侧抽屉**（见 ChatView 的
 * `readerSource` 与 `DocumentDrawer`）。跳走会丢掉正在读的回答与滚动位置，
 * 而出处本来是看回答时顺手一瞥的动作；抽屉只需要 `document_id` 与页码，
 * 于是"历史快照缺 knowledge_base_id 就退回 /documents"那条分支也一并没了。
 */
