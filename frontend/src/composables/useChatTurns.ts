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

import type { RouteLocationRaw } from 'vue-router'

import type { ChatSource } from '@/api/chat'

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
  icon: 'search' | 'think' | 'build'
  label: string
  detail: string
}

/** 提问原文在面板里只显示一小段：它是"检索了什么"的提示，不是内容主体。 */
export const TRACE_QUERY_CHARS = 44

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
  if (message.streaming && message.sources.length === 0) return '正在检索知识库…'
  if (message.sources.length === 0) return '检索完成 · 没有命中相关内容'
  const documents = new Set(message.sources.map((item) => item.document_id)).size
  return `检索完成 · 引用了 ${message.sources.length} 个片段 · ${documents} 篇文档`
}

/**
 * 过程步骤。
 *
 * 只写**真的发生过**的事：检索、思考（这一轮开了才有）、生成。
 * 不搬 WeKnora 的"问题理解"那一行——我们的链路里没有查询改写这一步，
 * 摆一行假动作只是好看的谎话，用户迟早会问"它到底改写了什么"。
 */
export function traceSteps(turn: Turn): TraceStep[] {
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
  if (message.thinking?.enabled) {
    const effort = THINKING_EFFORTS.find((item) => item.value === message.thinking?.effort)
    steps.push({
      key: 'think',
      icon: 'think',
      label: '深度思考',
      detail: effort ? `强度：${effort.label}` : '',
    })
  }
  steps.push({
    key: 'answer',
    icon: 'build',
    label: message.streaming ? '正在生成回答' : '已生成回答',
    detail: message.text.length > 0 ? `共 ${message.text.length} 字` : '',
  })
  return steps
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

/**
 * 引用要跳去哪。
 *
 * 有知识库 id 就**直连库页的文档抽屉**（`/kb/:id?doc=…&page=…`）——这是引用最该
 * 落到的地方，也是用户点"出处"想看的东西。只有历史快照缺这个字段（旧数据）时，
 * 才退回 `/documents/:id` 那条转发一跳。
 */
export function documentTarget(source: ChatSource): RouteLocationRaw {
  const page = source.page === null ? {} : { page: String(source.page) }
  if (source.knowledge_base_id) {
    return { path: `/kb/${source.knowledge_base_id}`, query: { doc: source.document_id, ...page } }
  }
  return { path: `/documents/${source.document_id}`, query: page }
}
