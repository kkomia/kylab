/**
 * 对话页的「回合」组织与「过程面板」数据（《前端设计规范》§6）。
 *
 * 为什么单独成模块而不是写在对话页里：这些是全页最需要被验证的判断
 * （引用摘要说什么、哪些步骤该出现、引用该跳去哪），而它们**都不依赖组件**——
 * 纯输入纯输出。留在组件里就只能靠挂载整页来测，而挂载一次要起路由、几个 store
 * 和一堆接口假件；搬出来之后用普通单测就能盯住。
 *
 * 这里刻意只管**数据**，不管渲染：图标名（`TraceStep.icon`）交给页面去映射，
 * 免得一个纯逻辑模块去 import 一堆组件。
 *
 * ## 从 Vue 搬过来（React 迁移 P1）
 *
 * 源文件：`frontend/src/composables/useChatTurns.ts`（832 行）。**逐条搬，不是重写**：
 * 函数名、常量名、边界与注释里的"为什么"都照旧，只有两处非逻辑的改写——
 *
 * 1. 那些原来靠 Vue 响应式（`ref`/`computed`）的地方这个文件里本来就没有：
 *    全是纯函数，所以这里**一个 hook 都没加**，调用方自己 `useMemo` 就好；
 * 2. `Session`/`ChatView` 这类 Vue 组件的名字换成 React 侧的说法（`ChatPage`）。
 *
 * 唯一读外部世界的是 `readTraceOpenMemory`/`writeTraceOpenMemory`（localStorage），
 * 键名与旧实现逐字一致（`kylab-trace-open`）。
 */

import type { ChatArtifact, ChatAttachment, ChatSource, ChatStep } from '@/api/chat'
// 纯函数模块：只借它的格式化，不引组件（这一层仍然不认识任何一个 UI 组件）
import { formatCount } from '@/lib/format'

// 取值是**契约**（请求与响应都用它），定义在 api/chat.ts；这里再导出一次，
// 既有的 `import type { ThinkingEffort } from '@/composables/useChatTurns'` 因此不用改
import type { ThinkingEffort } from '@/api/chat'

export type { ThinkingEffort }

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
  /**
   * 这条**用户消息**随发的附件快照（v0.55）；助手消息恒为空。
   *
   * 存放在消息里而不是"按 key 现查"：回看旧会话（`messagesFromDetail`）与刚发出去的
   * 那一轮（`streamTurn`）都要能画出文件片，两处都拿到同一份数据才不会一边有一边没有。
   */
  attachments: ChatAttachment[]
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
/**
 * 工具的**语义种类**（P2-1）。与后端 `services/tool_meta.KINDS` 是**同一份枚举**
 * （那边一处定义、随 `StepEvent.kind` 发过来），这里只是它的类型。
 */
export type ToolKind =
  'read' | 'search' | 'write' | 'delete' | 'exec' | 'skill' | 'session' | 'message' | 'tool'

/**
 * 步骤图标键。
 *
 * 工具步骤的键**就是它的种类**（`ToolKind`），非工具步骤只有两档：
 * `think`（深度思考）、`build`（组织回答）。
 *
 * 为什么不再按工具名分类（v0.26 那张 `TOOL_ICONS` 干的就是这件事）：
 * 那张表只有界面知道，加一个工具的人不记得改它，那一行就悄悄退化成中性方块；
 * 而 ZCode 的工具卡只认（kind, status, input, output）四元组——
 * **工具名只用于显示**。所以种类由后端从工具元数据推出来（见 `tool_meta.kind_of`），
 * 界面按它选图标与配色，加几十个工具都不用动这一层。
 *
 * 这一层不认识任何一个 UI 组件，所以这里只给键；**别让它 import 图标**，
 * 那样这个纯逻辑模块就得拖着一堆组件才能跑单测。
 */
export type TraceIcon = ToolKind | 'think' | 'build'

export interface TraceStep {
  key: string
  icon: TraceIcon
  label: string
  detail: string
  /** 这一步一个片段都没新增（只有检索步骤有）：界面上弱化它，别和"有收获"的轮次一样重。 */
  empty?: boolean
  /**
   * 这一步的**结果类别**（D22，2026-09-28 走查）：`"blocked"` 被拦下（模式/权限/隔离/
   * 成员身份）、`"awaiting"` 在等用户确认；`""` 或**没有这个字段** = 正常。
   *
   * 界面据此知道"这一行说的不是成功，是拦截"——原先只能**匹配句式**
   * （见 `TraceStepRow.isRefusalDetail` 那张词表），而那一行是默认展开的。
   * 老快照里没有它，所以词表作为兜底保留。
   */
  outcome?: string
  /**
   * 这一步的**原文**：模型传的入参与工具返回的正文（v0.25）。
   * 有值才给展开入口；老链路与回放的历史数据里都没有，于是那些步骤是纯文本。
   */
  args?: string
  result?: string
  /** 这一步**产出的文件**（v0.25）：界面上在它下面挂一张可点的卡片。 */
  artifacts?: ChatArtifact[]
  /**
   * 这一步调的是**哪个工具**（v0.26，原始名如 `web_search`）。非工具步骤没有。
   *
   * **老快照里没有这个字段**：它随 v0.26 才落库，之前存下的步骤只有中文标签。
   * 那种情况下的兜底见 `group`。
   */
  tool?: string
  /**
   * 这一步的**语义种类**（P2-1，后端给的）。
   *
   * 与 `icon` 的分工：`icon` 是"画哪张图"（工具步骤就等于 kind，加思考/回答两档），
   * 这个是**原始的那一档**——配色、`data-kind` 这类要看它的地方用它，
   * 而画图统一走 `icon`（一个字段一处真相）。
   * 老快照没有它（那时只有工具名），此时它是 `undefined`。
   */
  kind?: ToolKind
  /**
   * **分组的键**（v0.26）：同类工具并成一个入口时按它归并。
   *
   * 新数据就是工具名；老快照没有工具名，退回当时的中文标签（「联网搜索」）——
   * 那批数据已经在库里了，而用户手上正开着的就是它们，
   * "只对新对话生效"等于告诉他没修好。标签是后端从工具名生成的、每个工具唯一，
   * 拿它归并不会把两件事并到一起。非工具步骤没有这个键（它们不参与分组）。
   */
  group?: string
  /**
   * **产生这一步的那一轮推理**（v0.54，用户报的"思考应该对应到它调用的工具里面去"）。
   *
   * 见 `ChatStep.thinking`：老消息没有它（整轮只有一串 thinking），
   * 那种数据由 `trailingThinking` 兜底渲染成"默认折叠的一整块"。
   */
  thinking?: string
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
    attachments: [],
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

/**
 * 一轮里"实时状态"那一行最多留多少个字（v0.27）。
 *
 * 取的是**尾巴**：思考是往前滚的，用户要看的是它此刻在想什么，
 * 而不是十分钟前那句开头。120 字在常见宽度下大约占满一行多一点，
 * 配合左边的淡出，读起来是"它在飞快地往前写"。
 */
export const LIVE_TAIL_CHARS = 120

/**
 * 流式期间那一行实时状态（v0.27，照 DeepSeek 的 harness）。
 *
 * 它替掉了"思考像一堵墙一样长高"的观感：**干活的过程只占一行**，
 * 最新吐出来的字从右边进来、旧的往左边淡出。一轮里想了几千字，
 * 屏幕上始终是一行在滚——这是"它在飞快地做事"最直接的画面。
 *
 * 三种内容，按优先级：
 *
 * 1. **正在跑的工具**：「正在抓取网页…」。工具名比思考片段具体，
 *    而且这一步真的可能跑几秒，用户需要知道卡在哪；
 * 2. **正在想的思考**：思考正文的尾巴（见 `LIVE_TAIL_CHARS`）——
 *    这是"思考只显示一行"那一半；
 * 3. 其余情况**退回原来的摘要措辞**（`traceSummary`），不在这一行上另造一套说法。
 *
 * 正文开始吐字之后就**不再抢这一行**：那时用户的注意力已经在正文上，
 * 这里回到摘要（"正在处理…"这类）。
 */
export function liveLine(message: Message): string {
  if (!message.streaming) return ''
  const last = message.steps.at(-1)
  if (last?.phase === 'tool' && last.status === 'running') {
    return last.label ? `正在${last.label}…` : '正在调用工具…'
  }
  if (!message.text && message.thinkingText.trim()) {
    return tailOf(message.thinkingText, LIVE_TAIL_CHARS)
  }
  return traceSummary(message)
}

/** 取文本的尾巴（压掉换行，超长时前面给一个省略号）。 */
function tailOf(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `…${flat.slice(-limit)}` : flat
}

/**
 * 思考正文**按段切开**（v0.28，第二批评审 A3）。
 *
 * 为什么要在界面上切：思考正文是一整串带换行的纯文本，而它渲染成 `white-space:
 * pre-wrap` 的一段——空行就是一个**整行高**的空档（实测 12px 字号下 19px），
 * 比正文的段距（`--space-3`，12px）还松。过程比答案还疏，主次是反的。
 *
 * 切法只有一条：**连续两个以上的换行**分段。段内的单个换行原样留着
 * （`pre-wrap` 会照排），段首的缩进也不动——思考里常有对齐过的列表，
 * 归一空白会把它们揉成一团。
 *
 * 返回的每一段都是**原文**，一个字符都没改（只吃掉了段与段之间的空行）。
 */
export function thinkingParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((part) => part.replace(/^\n+/, '').replace(/\n+$/, ''))
    .filter((part) => part.trim() !== '')
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
    // **没有步骤时不说"正在检索"**：P0 之后没有步骤的常见原因是"模型直接作答"，
    // 而不是"还在检索"。说成检索同样是替它编一段经过（与 0 出处不说"检索完成"同一条）
    return '正在处理…'
  }
  // 没有出处就**不说"检索完成"**（同上：没证据不声称查过）。
  // 这一轮可能压根没用工具，说成"检索完成但没有命中"是在替它编一段经过。
  if (message.sources.length === 0) {
    return message.steps.some((step) => step.phase === 'tool') ? '本轮没有命中资料' : '直接作答'
  }
  const documents = new Set(message.sources.map((item) => item.document_id)).size
  return `检索完成 · 引用了 ${formatCount(message.sources.length)} 个片段 · ${formatCount(documents)} 篇文档`
}

/**
 * 这一轮里有没有走过降级路径（工具循环用尽了某一道闸：步数，或 v0.32 起的整轮墙钟）。
 *
 * 放在这里而不是页面上现算：历史回放（后端只存正文）拿不到步骤，那时它就该是 false，
 * 页面不必自己判断"有没有 steps"。
 */
export function wasDegraded(message: Message): boolean {
  return message.steps.some((step) => step.degraded === true)
}

/**
 * 降级的原因是**服务端给的**，不在前端写死。
 *
 * 这条原来写的是"工具步数用尽"——加上第二道闸（整轮墙钟）之后它就会说错话：
 * 撞时间的用户会被告知是步数的事，而他下一步该做的完全不同（过一会儿重发 vs 缩小问题范围）。
 * 所以取那条降级步骤的 `detail`——后端拼的就是给人看的一句话，原因只有一处真相。
 */
export function degradedReason(message: Message): string {
  const step = message.steps.find((item) => item.degraded === true)
  return step?.detail?.trim() || '按当时拿到的资料作答'
}

/**
 * 失败那一轮给用户看的那句话（第四批评审 B①）。
 *
 * 绝大多数情况下**原样显示就对了**：错误体里的 `message` 是后端写给用户看的中文
 * （"服务内部错误"、"检索失败：…"），前端那几条自己写的也是中文
 * （"对话没有返回任何内容，请重试"、"对话中断"）。要翻的只有一类——
 * **浏览器自己抛的那几个英文串**（`Failed to fetch` / `Load failed` /
 * `NetworkError when attempting to fetch resource.`）：它们不是给人看的，
 * 而且指向的原因与"服务端出错"**不是一回事**（请求压根没出去，重试多半就好；
 * 服务端出错则可能要等一下）。这一层只做这一件翻译，不造别的说法，
 * 也不把后端那句话改写掉——原因只有一处真相。
 */
const NETWORK_FAILURES = [
  'failed to fetch',
  'load failed',
  'networkerror',
  'network request failed',
  'fetch failed',
  'network error',
  'err_network',
  'err_internet_disconnected',
]

export function failureText(raw: string): string {
  const text = raw.trim()
  if (!text) return '没有拿到失败原因'
  const lower = text.toLowerCase()
  if (NETWORK_FAILURES.some((mark) => lower.includes(mark))) {
    return '网络没连上（这条请求没有发出去）'
  }
  return text
}

/**
 * 这段回答里有没有"模型把工具调用写进正文"的标记（§12.227）。
 *
 * 后端在收尾那几条**不带工具表**的路上会把这类标记剥掉（`llm.split_text_tool_calls`），
 * 新的回答因此不该再出现。这一层守的是**已经落库的老消息**——修复之前存下的那些
 * （实测有 5 条），以及将来某个我们没见过的形状：它们不该被当成人话读下去。
 *
 * **只判有没有、不改文本**：原文照旧显示，只是加一行说明并把它按原文排版。
 * 就地"清洗"会把当时真实返回的东西改掉，而回看时"它到底写了什么"正是要问的事。
 *
 * 形状与后端那份对齐（三族：`<tool_call>`、DeepSeek 的特殊 token、DSML；
 * 外加 `<function=…>`），**连"要多像才算"也对齐**：`<tool_call>` 单独出现不算，
 * 得有闭合标签、或标签后面紧跟着调用载荷——因为问"`<tool_call>` 是什么意思"的
 * 回答里就会引用这个标签，把它当标记渲染成"原文 + 说明"是把正常回答弄脏了。
 */
const TOOL_MARKUP_PATTERNS: RegExp[] = [
  // 闭合的一块
  /<tool_calls?\s*>[\s\S]*?<\/tool_calls?\s*>/i,
  // 没有收尾标签（被截断）：标签后面**紧跟**一段 JSON，或"一个工具名 + JSON"
  /<tool_calls?\s*>\s*(?:\{|[A-Za-z_][\w.]*\s*\{)/i,
  // DeepSeek 的特殊 token（全角竖线 + `▁`，半角也认）
  /<[｜|]{1,2}\s*tool[▁_ ]?calls?[▁_ ]?(?:begin|end)?[｜|]{1,2}>/i,
  // DSML 那一族
  /<[｜|]{1,2}\s*\/?\s*DSML[｜|]?/i,
  // `<function=名字>` / `<function name="名字">`
  /<function\s*(?:=[^>]*|name\s*=\s*["'][^"']*["'][^>]*)>/i,
]

export function hasToolCallMarkup(text: string): boolean {
  return TOOL_MARKUP_PATTERNS.some((pattern) => pattern.test(text))
}

/**
 * 这一轮**跑过联网搜索**没有（v0.28，第二批评审 A6）。
 *
 * 用它来回答一个具体的问题：正文里那些**对不上出处**的 `[6][2]` 该怎么说。
 *
 * 联网搜索的返回**是带编号的**（后端 `services/tools.py` 的 `_web_search`：
 * `[1] 标题 / 网址 / 摘要` 一条一行，就在这一步的「返回」里）——所以正文里那些编号
 * 有出处可指，指的**不是**知识库的出处，而是过程面板里那一次搜索的返回。
 * 于是：跑过联网搜索 → 那些编号渲染成"有说明的非链接"（"见过程面板"）；
 * 没跑过 → 什么都不说（模型凭空写的编号，我们不替它编一个来源）。
 *
 * 判据认**工具名**（`tool`）与**老快照的中文标签**两样，与 `stepIcon` 的兜底同一口径：
 * v0.26 之前落库的步骤没有 `tool`，只有后端当时发的中文标签「联网搜索」。
 */
export function usedWebSearch(message: Message): boolean {
  return message.steps.some(
    (step) => step.phase === 'tool' && (step.tool === 'web_search' || step.label === '联网搜索'),
  )
}

/** Agent 步骤的阶段 → 图标键。 */
const STEP_ICONS: Record<string, TraceIcon> = {
  intent: 'think',
  rewrite: 'search',
  retrieve: 'search',
  answer: 'build',
  // 工具调用（P0 起的主流程）：一次工具就是一步，名字由后端给（"检索知识库""写笔记"…）
  tool: 'tool',
  // 「交给长期记忆」（P0-8）：这一步干的事就是**把它写进去**，所以借 write 那一档。
  // 不新增图标键是刻意的——为一个步骤动图标组件不划算，而兜底的 `search` 会明确说错
  // （它会让用户以为这一轮又去检索了一次）。
  memory: 'write',
}

/**
 * 步骤 → 图标键（P2-1）。
 *
 * 三步，顺序就是优先级：
 *
 * 1. **后端给的种类**（`step.kind`）——新数据一律走这条；
 * 2. **老快照兜底**（P2-1 之前落库的步骤没有 `kind`）：按当时的工具名/中文标签
 *    查一次表。这张表**只对那批数据有效**，不给新数据用——它是"让已经存在的
 *    对话也能画对"的一次性翻译，见下面 `LEGACY_*` 的说明；
 * 3. 都没有就按 `phase`（非工具步骤：理解问题 / 组织回答）。
 */
export function stepIcon(step: {
  phase: string
  tool?: string
  label?: string
  kind?: string
}): TraceIcon {
  if (isToolKind(step.kind)) return step.kind
  if (step.tool) {
    // 老快照（v0.26 起有 tool，P2-1 起才有 kind）：按工具名翻译成种类
    if (step.tool.startsWith('mcp__')) return 'tool'
    return LEGACY_TOOL_KINDS[step.tool] ?? 'tool'
  }
  if (step.phase === 'tool' && step.label) {
    return LEGACY_LABEL_KINDS[step.label] ?? 'tool'
  }
  return STEP_ICONS[step.phase] ?? 'search'
}

/** 后端给的 kind 是不是词表里的取值（老快照没有它、拼错的也当没有）。 */
function isToolKind(value: string | undefined): value is ToolKind {
  return typeof value === 'string' && (TOOL_KINDS as readonly string[]).includes(value)
}

/** 种类的词表（与后端 `tool_meta.KINDS` 同一份；这里只做校验用）。 */
const TOOL_KINDS: readonly ToolKind[] = [
  'read',
  'search',
  'write',
  'delete',
  'exec',
  'skill',
  'session',
  'message',
  'tool',
]

/**
 * **老快照的兜底翻译**：工具名 → 种类（只对 P2-1 之前落库的步骤有效）。
 *
 * 后端 `tool_meta.kind_of` 才是真源；这里是它的一份"当时的样子"——
 * 新数据永远走 `step.kind`，所以**这张表不会再长**（不加新工具）。
 * 查不到就画中性图标：老数据画得糙一点是可接受的降级，新数据画错才是 bug。
 */
const LEGACY_TOOL_KINDS: Record<string, ToolKind> = {
  search: 'search',
  recall: 'search',
  web_search: 'search',
  web_fetch: 'search',
  search_files: 'search',
  list_skills: 'skill',
  read_skill: 'skill',
  spawn_subagent: 'session',
  run_command: 'exec',
  delete_document: 'delete',
  list_knowledge_bases: 'read',
  list_documents: 'read',
  get_document_status: 'read',
  list_notes: 'read',
  list_files: 'read',
  read_file: 'read',
  list_tables: 'read',
  query_table: 'read',
  list_scheduled_tasks: 'read',
  // 写入 / 产出那批（与后端 `_KIND_OVERRIDES` 同口径：导出的产物算"做出来一份东西"）
  create_knowledge_base: 'write',
  upload_document: 'write',
  add_data_source: 'write',
  create_note: 'write',
  attach_note_to_kb: 'write',
  remember: 'write',
  export_document: 'write',
  export_table: 'write',
  export_deck: 'write',
  ingest_artifact: 'write',
  schedule_task: 'write',
}

/**
 * 老快照里连工具名都没有的那一档（v0.26 之前）：键是**当时写下的中文标签**。
 *
 * 后端哪天改了某个标签的措辞，这里就匹配不上，那些老步骤退回中性图标。
 * **这是可接受的降级**：它只影响历史回放的图标，不影响任何新数据。
 */
const LEGACY_LABEL_KINDS: Record<string, ToolKind> = {
  联网搜索: 'search',
  抓取网页: 'search',
  检索知识库: 'search',
  回忆: 'search',
  查看知识库: 'read',
  查看文档列表: 'read',
  查询文档状态: 'read',
  查看笔记: 'read',
  查看技能目录: 'skill',
  读技能: 'skill',
  '派子 Agent': 'session',
  删除文档: 'delete',
  执行命令: 'exec',
  新建知识库: 'write',
  上传文档: 'write',
  添加数据源: 'write',
  写笔记: 'write',
  把笔记加入知识库: 'write',
  记住: 'write',
  导出文档: 'write',
  导出表格: 'write',
  导出幻灯: 'write',
  存进知识库: 'write',
  查看文件: 'read',
  读文件: 'read',
  在文件里搜: 'search',
  查看表格: 'read',
  查表格: 'read',
  挂定时任务: 'write',
  查看定时任务: 'read',
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
 * 过程面板里的一行：要么是单独一步，要么是**同类工具并成的一组**（v0.26）。
 */
export type TraceEntry =
  | { kind: 'step'; key: string; step: TraceStep }
  | {
      kind: 'group'
      key: string
      icon: TraceIcon
      label: string
      /** 归并用的键（工具名，或老快照里的中文标签）。 */
      tool: string
      /** 这一组里的每一次调用，**保持原来的先后**。 */
      steps: TraceStep[]
    }

/**
 * 这一轮**产出的文件**（v0.26）。
 *
 * 它们原来挂在各自那一步下面——于是交付物出现在过程面板**中间**：
 * 用户要往下翻过十来步工具调用才看到"哦，东西在这儿"，而面板一收起，
 * 卡片就跟着没了。**交付物是这个回合的结果，不是过程的中间产物**，
 * 所以现在收集到一处、摆在正文后面（见对话页的 `.deliverables`）。
 *
 * 按 `artifact_id` 去重：同一个文件在几步里被提到（导出 → 入库）时只留一张卡片。
 * 顺序就是**产出的先后**——多次交付时，用户按时间找得到。
 */
export function replyArtifacts(turn: Turn): ChatArtifact[] {
  const message = turn.reply
  if (!message) return []
  const out: ChatArtifact[] = []
  const seen = new Set<string>()
  for (const step of message.steps) {
    for (const file of step.artifacts ?? []) {
      if (seen.has(file.artifact_id)) continue
      seen.add(file.artifact_id)
      out.push(file)
    }
  }
  return out
}

/**
 * 「哪一轮的第几行」——把条目 key 加上**轮次命名空间**（P0，修的是跨轮串号）。
 *
 * 步骤 key 是 `${phase}-${index}`（`agentTraceSteps`），组 key 是
 * `group:${第一次调用的 key}:${工具名}`（`groupBlock`）——**两者都只在同一轮内唯一**。
 * 而"哪一行摊开着"是宿主上的一张全局表（`ChatProvider` 的 `openSteps` / `openGroups`）。
 * 于是"第 2 轮第 1 步"与"第 5 轮第 1 步"是同一个 key：点开其中一个，所有轮次里
 * 同一个下标的行一起摊开（老链路的 `retrieve` / `answer` / `think` 更是一字不差地每轮重名）。
 *
 * 为什么加在**渲染这一层**而不是数据层：`turns.ts` 那些 key 还要当 React 列表 key
 * 与分组依据，它们只需要"同一轮内稳定"；轮次是渲染时才知道的事（`TracePanel` 拿得到
 * `turnIndex`）。在这一层套一层前缀，分组、分页、计数那些口径一个字都不用改，
 * 也就不会碰坏"同一种工具并成一组"。
 */
export function traceKey(turnIndex: number, key: string): string {
  return `t${turnIndex}:${key}`
}

/**
 * 把步骤列表并成"一行一组"（v0.26，用户要求"同类工具合并为一个入口"）。
 *
 * 规则三条，都是为了让它在长回合里仍然说得清：
 *
 * 1. **只并同一个"块"里的**：非工具步骤（理解问题 / 组织回答 / 思考）是分界，
 *    它们前后各成一块。跨过它们的合并会把"什么时候做的"讲乱。
 * 2. **块内按工具名分组、按首次出现的顺序排**：实测一个回合里
 *    联网搜索 7 次 + 抓取网页 2 次（交替出现），并完是两行而不是九行。
 * 3. **只有一次的不并**：一组只有一个成员时，"点开看全部"是个空动作，
 *    直接当普通步骤画。
 *
 * 组内**保持原顺序**，展开后每条仍是完整的一步（结论 + 入参 + 返回）——
 * 合并的是入口，不是信息。
 */
export function traceEntries(turn: Turn): TraceEntry[] {
  const steps = traceSteps(turn)
  const entries: TraceEntry[] = []
  let block: TraceStep[] = []

  const flush = (): void => {
    if (!block.length) return
    entries.push(...groupBlock(block))
    block = []
  }

  for (const step of steps) {
    if (step.group) block.push(step)
    else {
      flush()
      entries.push({ kind: 'step', key: step.key, step })
    }
  }
  flush()
  return entries
}

/**
 * 过程面板**一屏先画几条**（P2-1，照 ZCode 的两级懒加载）。
 *
 * 取 20：一屏（常见窗口高度）大约放得下十五到二十行，再往下用户要的就不是
 * "每一步都摊开"而是结论了。而长回合的量级是真的（实测一轮里几十次工具调用是常事：
 * 联网搜 7 次 + 抓网页 9 次 + 读文件十几次），全画出来会把这一页的 DOM
 * 撑成几百个节点，滚动与流式更新都跟着变卡。
 *
 * 计数单位是**条目**（一行一步，或一行一组），与界面上那行「当前已显示 X/Y」一致。
 */
export const TRACE_PAGE_SIZE = 20

/**
 * 单条原文（入参 / 返回）默认给多少字（P2-1）。
 *
 * 后端已经把这两样各裁到 2000 字（`tool_loop.MAX_STEP_PREVIEW_CHARS`），
 * 这里再切一刀是**给眼睛**切的：600 字大约十来行，够看出"它到底返回了什么"，
 * 再长就该由用户自己点开（ZCode 的 `previewBytes/fullBytes` 是同一个意思）。
 */
export const RESULT_PREVIEW_CHARS = 600

/** 一屏里先画哪几条、还剩多少条（P2-1 的两级懒加载里的第一级）。 */
export interface TracePage {
  /** 这一轮要渲染的条目（截断后）。 */
  entries: TraceEntry[]
  /** 已经显示出来的**工具调用**条数（一组算它里面那几次，见 `tracePage`）。 */
  shown: number
  /** 这一轮的工具调用总数。 */
  total: number
  /** 还有多少**条目**没画（0 = 全都在）。切的是条目，计数给的是调用。 */
  hidden: number
}

/**
 * 把一轮的条目按"先画前 N 条"切一刀（P2-1）。
 *
 * **切的是渲染，不是数据**：整轮的事件、快照一条不少（它们在后端与消息里），
 * 这里只决定"这一屏先画多少"——所以点「加载更多」是零成本的，也不会丢信息。
 *
 * 两处口径是刻意的：
 *
 * - **切按条目**：一屏放得下的是"行"，而一组（同类工具合并的那一行）本身就是一行；
 * - **报数按调用**：界面上写的是「X/Y 条工具调用」，而合并后的那一行代表的是
 *   它里面那几次（ZCode 报的也是调用数）。按条目报数会在"搜了 30 次并成一行"时
 *   说成"1 条"，那是个假数字。
 */
export function tracePage(turn: Turn, limit = TRACE_PAGE_SIZE): TracePage {
  const entries = traceEntries(turn)
  const total = countCalls(entries)
  if (limit <= 0 || entries.length <= limit) {
    return { entries, shown: total, total, hidden: 0 }
  }
  const visible = entries.slice(0, limit)
  return {
    entries: visible,
    shown: countCalls(visible),
    total,
    hidden: entries.length - limit,
  }
}

/** 这些条目一共代表几次工具调用（非工具步骤不算——那不是"工具调用"）。 */
function countCalls(entries: TraceEntry[]): number {
  let count = 0
  for (const entry of entries) {
    if (entry.kind === 'group') count += entry.steps.length
    else if (entry.step.tool) count += 1
  }
  return count
}

/**
 * 单条原文的预览（P2-1 的第二级懒加载）：超长时先给前面一段。
 *
 * 返回 `null` 表示"不用预览，原样显示"——调用方据此决定要不要给「加载全部」。
 * 判据用**字符数**而不是渲染后的行数：字符数是后端与界面都握得住的那个量
 * （后端那一刀也按字符），两处口径一致才不会出现"看起来没超、其实超了"。
 */
export function resultPreview(text: string, limit = RESULT_PREVIEW_CHARS): string | null {
  const body = text || ''
  if (body.length <= limit) return null
  return body.slice(0, limit)
}

/** 一个块内按工具名分组：按首次出现的顺序排，**只留两成员以上的**。 */
function groupBlock(block: TraceStep[]): TraceEntry[] {
  const order: string[] = []
  const buckets = new Map<string, TraceStep[]>()
  for (const step of block) {
    const tool = step.group as string
    if (!buckets.has(tool)) {
      buckets.set(tool, [])
      order.push(tool)
    }
    buckets.get(tool)!.push(step)
  }

  const entries: TraceEntry[] = []
  for (const tool of order) {
    const group = buckets.get(tool)!
    if (group.length === 1) {
      const [only] = group
      entries.push({ kind: 'step', key: only.key, step: only })
      continue
    }
    // key 取第一次调用的 key：它在同一轮里稳定，展开状态才不会自己收起来
    entries.push({
      kind: 'group',
      key: `group:${group[0].key}:${tool}`,
      icon: group[0].icon,
      label: group[0].label,
      tool,
      steps: group,
    })
  }
  return entries
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

/**
 * **整轮那一串思考**：只有"没有任何一步带自己的推理"时才需要它（v0.54）。
 *
 * 两处来由不同，所以判据是"步骤里有没有"而不是"是新的还是老的"：
 *
 * 1. **老消息**（这条规则上线前落库的）：`steps[]` 里没有 `thinking`，而整轮的
 *    `thinkingText` 是一整串（实测那条会话 26303 字、21 步）。拆不出来，所以整块给出来，
 *    由界面**默认折叠**——用户报的"很难看"主要是它一直摊着，而不是它存在。
 * 2. **回放的历史**（`ChatProvider` 的历史路径）：`thinkingText` 恒为空串，于是返回空串，
 *    界面什么都不画。
 *
 * 新数据（每一步自带推理）返回**空串**：那时思考已经落在各自的工具行里，
 * 再在末尾铺一遍同一批文字就是把同一件事说两遍。
 */
export function trailingThinking(message: Message): string {
  if (!message.thinkingText.trim()) return ''
  if (message.steps.some((step) => (step.thinking ?? '').trim())) return ''
  return message.thinkingText
}

/**
 * **记忆与人设文件的读写不进过程面板**（v0.55，用户要求）。
 *
 * 用户原话："soul.md profile.md 这种核心文件应该是要……直接显示表达出来。这样会降低
 * agent 的角色扮演感"——这条工具步骤显示的是 `read_memory` / `write_memory PROFILE.md`，
 * 等于把"角色在后台读了什么人设文件"摊在对话里，沉浸感当场就没了。
 *
 * 判据认**工具名**（`tool`），老快照没有工具名时退回中文标签（见
 * `HIDDEN_TRACE_LABELS`）。后端仍在事件流里如实发这些步骤（它不该管界面怎么画），
 * 所以这一刀只切**渲染**，数据一条不少；隐藏的是"哪几行不画"，
 * 而它们的推理也跟着那一步一起不画（那是同一件事的一部分）。
 *
 * 只隐藏**动核心文件**的三个（人设 / 长期记忆）：`recall`（回忆）是检索、
 * 与"查知识库"同类，仍然照常显示。
 */
const HIDDEN_TRACE_TOOLS: ReadonlySet<string> = new Set(['read_memory', 'write_memory', 'remember'])

/** 老快照没有工具名时按当时的中文标签认（`read_memory`/`write_memory` 的标签就是工具名，只有 `remember` 有中文标签）。 */
const HIDDEN_TRACE_LABELS: ReadonlySet<string> = new Set(['记住'])

/** 这一步动的是不是记忆 / 人设文件——是就不画进过程面板。 */
function isHiddenTraceStep(step: ChatStep): boolean {
  if (step.tool && HIDDEN_TRACE_TOOLS.has(step.tool)) return true
  return HIDDEN_TRACE_LABELS.has(step.label)
}

function agentTraceSteps(message: Message): TraceStep[] {
  // 显式标注元素类型：不标的话 TS 会把 `empty` 推成必填，后面 unshift 思考那一步就类型不兼容
  const steps: TraceStep[] = message.steps
    .filter((step) => !isHiddenTraceStep(step))
    .map((step, index) => ({
      // 这个 key 只保证**同一轮内**唯一（它同时是 React 列表 key）；跨轮的唯一性由
      // 渲染层的轮次前缀给（`traceKey`），别在这里拼轮次——这里拿不到轮次
      key: `${step.phase}-${index}`,
      icon: stepIcon(step),
      // 原始种类：工具步骤与 icon 同值，但"原始的那一档"单独留一份——
      // 配色与 `data-kind` 认它、画图认 icon（老快照没有它，于是 undefined）
      kind: isToolKind(step.kind) ? step.kind : undefined,
      tool: step.tool,
      // 老快照没有 `tool`：退回当时的标签，好让**已经存在的对话**也能合并
      group: step.phase === 'tool' ? step.tool || step.label : undefined,
      label: step.label,
      detail: step.phase === 'answer' ? answerDetail(message) : step.detail,
      // "这一轮什么新东西都没找到"在过程面板里要轻一档：它是一句交代，不是一次收获
      empty: step.added === 0,
      // 结果类别（D22）：`blocked` / `awaiting`。老快照里没有它，于是 undefined
      // （`TraceStepRow.isRefusalStep` 据此决定"听结构化字段"还是"回退认句式"）
      outcome: step.outcome,
      // 原文只在真有的时候带上（"组织回答"那一步没有）
      args: step.args,
      result: step.result,
      artifacts: step.artifacts,
      // 这一步自己那段推理（v0.54）。老快照没有它 —— 那种数据整轮只有一串，
      // 由 `trailingThinking` 兜底（见 `TracePanel`）。
      thinking: step.thinking,
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
  const steps: TraceStep[] = []
  // **只在确实有出处时**才补这一条。
  //
  // 这条兜底原本是给"回放没有步骤的历史"用的（那时后端真的检索过，只是没存步骤），
  // 所以补一条"检索知识库"还算如实。但 P0 换框架之后，"这一轮没调工具、模型直接答"
  // 成了常态——那时这里会**凭空画出一条"检索知识库 / 没有命中任何片段"**，
  // 用户看到的现象就是"我明明没开知识库，它为什么去检索了"（实测报过来的就是这个）。
  //
  // 判据取"有没有出处"而不是"有没有步骤"：出处是**证据**，没有证据就不该声称查过。
  if (message.sources.length > 0) {
    steps.push({
      key: 'retrieve',
      icon: 'search',
      label: '检索知识库',
      detail: `「${short}」找到 ${formatCount(message.sources.length)} 个片段`,
    })
  }
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
  return message.text.length > 0 ? `共 ${formatCount(message.text.length)} 字` : ''
}

/**
 * 过程面板的展开档（P0）。
 *
 * 为什么不是布尔（v0.25 起用的是 `boolean`）：这次要同时表达"流式中摊开"
 * "这一轮完成之后收起"与"手动开过就别自动折"，布尔会把**自动折出来的开**
 * 与**用户手动点出来的开**混成同一个 `true`，而这次的核心规则恰恰要求把它们分开。
 * 两档的取值照抄 LobeHub `WorkflowCollapse` 的 `collapsed | full`。
 */
export type TraceOpen = 'collapsed' | 'full'

/** 判定开合要用到的、由宿主持有的事实（见 `ChatProvider` 的 `traceOpenIds` 与记忆）。 */
export interface TraceOpenState {
  /** 用户对**这一轮**点过的那一档；`undefined` = 没点过。 */
  chosen?: TraceOpen
  /** 用户手动开过过程面板没有（见 `readTraceOpenMemory`）。 */
  userOpened?: boolean
}

/**
 * 有没有步骤在**等人工介入**（规则 c：`forceExpanded` 且拒绝收起）。
 *
 * 判据只看结构化的 `outcome === 'awaiting'`（后端执行器给的字段），不去匹配句式——
 * 句式那套（`TraceStepRow.isRefusalDetail`）只是老快照的兜底，这里不抄第二遍。
 * 隐藏的步骤不算：它们画都不画，为一个看不见的步骤把整块面板撑开没有意义
 * （所以复用 `isHiddenTraceStep`，与 `agentTraceSteps` 的过滤条件是同一份）。
 */
export function traceForceExpanded(message: Message): boolean {
  return message.steps.some((step) => step.outcome === 'awaiting' && !isHiddenTraceStep(step))
}

/**
 * 过程面板该摊开还是收起——**这条判断只写在这里**（宿主与界面都问它，不各自再判一次）。
 *
 * 四条规则照 LobeHub 的 `WorkflowCollapse`（调研 §5.2 的 P0①，依据 §4.7 / §4.8）：
 *
 * (a) **流式中 `full`、这一轮完成之后 `collapsed`**。十一个能确证的样本里没有一个
 *     把过程摊在正文里（Cline / Roo / Cherry / LobeHub / WeKnora / MaxKB / Trae /
 *     Qoder / OpenHands 全默认折），只有我们（v0.25 起）是；但"执行中就折"是有害的——
 *     Trae 的用户原话是"展开了，过一会……又给折叠掉了，AI 在干啥都不知道"，
 *     所以折只发生在**这一轮真的结束之后**。
 * (b) **用户手动开过就不自动折**：轮内是 `chosen`（他在这一轮点过），
 *     跨轮次是 `userOpened`（他点过任何一轮）。没有这一条，用户刚点开就被下一次
 *     渲染收回去（LobeHub 用 `userOpenedRef` 明写这条，Trae 是反面教材）。
 * (c) **有待确认的步骤时强制展开、且拒绝收起**（`traceForceExpanded`）。这类步骤说的是
 *     "卡住了，在等你动手"，折起来等于把"要你动手"藏进一次点击后面。
 * (d) **正文永远不在这里面**：这一档只决定"过程"那块的画法，回答正文由 `MessageView`
 *     画在面板之外（同一个分支里的下一个兄弟），收起到哪一档都不会把答案折进去。
 *
 * 这一档由宿主持有、作为参数传进来，**不挂在 `Message` 上**：流式每吐一次字，
 * 消息对象就重建一份（`mirrorLive`），挂在消息上的选择会被冲掉。
 */
export function isTraceOpen(message: Message, state: TraceOpenState = {}): TraceOpen {
  // (c) 先于一切：有步骤在等确认，任何档位都让路（包括用户刚刚点的那一下）
  if (traceForceExpanded(message)) return 'full'
  // (b) 这一轮他自己点过：完全听他的，流式与否都不覆盖
  if (state.chosen) return state.chosen
  // (a) 流式中它就是进度条，摊开；这一轮结束之后再收起
  if (message.streaming) return 'full'
  // (b) 跨轮次那一半：他手动开过，就不再替他折
  return state.userOpened ? 'full' : 'collapsed'
}

/** "用户手动开过过程面板没有"的本机记忆（P2-1 起，P0 改语义）。键与侧栏折叠同族（`kylab-*`）。 */
export const TRACE_OPEN_STORAGE_KEY = 'kylab-trace-open'

/**
 * 用户手动**开过**过程面板没有（P0 改的就是这一位的语义）。
 *
 * 旧语义是"记住上一次手动选的那一档"，再把它当之后每一轮的**默认档位**——那么只要
 * 用户（或 v0.25 那个默认展开）留下过一个"开着"，自动折叠就**永远不发生**：
 * 新加的"答完就折"一次都见不到（调研 §4.8 规律 1/2/4 的反面：手动展开只该**豁免**
 * 自动折，不该反过来把自动折整个关掉）。旧值 `'1'`/`'0'` 正好也是这个问题的形状。
 *
 * 现在这一位只回答一个问题：**要不要豁免自动折**（`isTraceOpen` 的规则 b）。
 * - 没有这个键、或最近一次手动动作是"合上"（`'0'`）→ 不豁免，答完照折；
 * - 手动开过（`'1'`）→ 完成的一轮不再替他折；他合一次就把自动折交还回来。
 *
 * 档位本身不在这里存：那是"哪一轮"的事（宿主按消息 id 记着，见 `TraceOpenState.chosen`）。
 * 读不到 localStorage（隐私模式）一律当"没手动开过"——**读不到不改变规则**。
 */
export function readTraceOpenMemory(): boolean {
  try {
    return window.localStorage.getItem(TRACE_OPEN_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

/** 记下用户这一次手动动作的意图：`true` = 他开过（豁免自动折），`false` = 交还自动折。 */
export function writeTraceOpenMemory(opened: boolean): void {
  try {
    window.localStorage.setItem(TRACE_OPEN_STORAGE_KEY, opened ? '1' : '0')
  } catch {
    // 存不上就只在本次会话生效（与侧栏折叠同一条）
  }
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
 * v18 起删掉了——点出处改成**在对话页就地滑出右侧抽屉**（见对话页的
 * `readerSource` 与 `DocumentDrawer`）。跳走会丢掉正在读的回答与滚动位置，
 * 而出处本来是看回答时顺手一瞥的动作；抽屉只需要 `document_id` 与页码，
 * 于是"历史快照缺 knowledge_base_id 就退回 /documents"那条分支也一并没了。
 */

/**
 * 会话里所有 `art_*` 的 key → 文件名（D19，2026-09-28 走查）。
 *
 * 两处来源都要：**消息附件**（用户上传的，快照里带名字）与**步骤产物**（工具导出的，
 * 键在 `artifact_id` 上）。工具入参里传的是 key——界面原样打印 `{"key":"art_7e7aecbd2ca0"}`
 * 的话，用户根本不知道那是哪一份文件（走查 D19 实测）。
 */
export function artifactNameMap(turns: readonly Turn[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const turn of turns) {
    for (const item of turn.user?.attachments ?? []) {
      if (item.key && item.name) names.set(item.key, item.name)
    }
    for (const step of turn.reply?.steps ?? []) {
      for (const file of step.artifacts ?? []) {
        if (file.artifact_id && file.name) names.set(file.artifact_id, file.name)
      }
    }
  }
  return names
}

/**
 * 入参文本里的 `art_xxx` **后面缀上文件名**：`art_xxx（走查样例.md）`。
 *
 * 键本身**保留**：它才是真正传给工具的那个值，用户要对着日志看、要拿它去下载时得看得见。
 * 只处理**原始入参**（不回灌自己的输出），所以不必担心缀两遍。
 */
export function humanizeArtifactKeys(args: string, names: ReadonlyMap<string, string>): string {
  if (!args || names.size === 0) return args
  return args.replace(/art_[0-9a-zA-Z]+/g, (key) => {
    const name = names.get(key)
    return name ? `${key}（${name}）` : key
  })
}
