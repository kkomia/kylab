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

import type { ChatArtifact, ChatSource, ChatStep } from '@/api/chat'

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
/**
 * 步骤图标键。
 *
 * **是"类别"不是"工具名"**：界面按它选图标（映射表在 `ChatView`，因为那里才有
 * 图标组件），而同类工具该长同一个样子——七个 `web_search` 调用画七个图标，
 * 只会让那一列看起来在抖。分组同理（见 `traceEntries`）。
 *
 * 这一层不认识 Vue 组件，所以这里只给键；**别让它 import 图标**，
 * 那样这个纯逻辑模块就得拖着一堆 .vue 才能跑单测。
 */
export type TraceIcon =
  | 'think'
  | 'search'
  | 'web'
  | 'fetch'
  | 'library'
  | 'note'
  | 'memory'
  | 'file'
  | 'skill'
  | 'agent'
  | 'mcp'
  | 'tool'
  | 'build'

export interface TraceStep {
  key: string
  icon: TraceIcon
  label: string
  detail: string
  /** 这一步一个片段都没新增（只有检索步骤有）：界面上弱化它，别和"有收获"的轮次一样重。 */
  empty?: boolean
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
   * **分组的键**（v0.26）：同类工具并成一个入口时按它归并。
   *
   * 新数据就是工具名；老快照没有工具名，退回当时的中文标签（「联网搜索」）——
   * 那批数据已经在库里了，而用户手上正开着的就是它们，
   * "只对新对话生效"等于告诉他没修好。标签是后端从工具名生成的、每个工具唯一，
   * 拿它归并不会把两件事并到一起。非工具步骤没有这个键（它们不参与分组）。
   */
  group?: string
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
  return `检索完成 · 引用了 ${message.sources.length} 个片段 · ${documents} 篇文档`
}

/**
 * 这一轮里有没有走过降级路径（目前只有"工具步数用尽"一种：它还想继续查但没机会了）。
 *
 * 放在这里而不是页面上现算：历史回放（后端只存正文）拿不到步骤，那时它就该是 false，
 * 页面不必自己判断"有没有 steps"。
 */
export function wasDegraded(message: Message): boolean {
  return message.steps.some((step) => step.degraded === true)
}

/** Agent 步骤的阶段 → 图标键。 */
const STEP_ICONS: Record<string, TraceIcon> = {
  intent: 'think',
  rewrite: 'search',
  retrieve: 'search',
  answer: 'build',
  // 工具调用（P0 起的主流程）：一次工具就是一步，名字由后端给（"检索知识库""写笔记"…）
  tool: 'tool',
}

/**
 * 工具名 → 图标类别（v0.26）。
 *
 * 改之前所有工具都画同一个"服务器"图标——七个联网搜索、两个抓网页，
 * 那一列全是同一个方块，扫过去等于没有信息。这里按**它对外做的那件事**分类：
 *
 * | 类别 | 谁 | 为什么是这一类 |
 * | --- | --- | --- |
 * | `search` | `search` / `recall` | 都是"从已有的东西里找一段" |
 * | `web` / `fetch` | `web_search` / `web_fetch` | 一个在公网上找，一个把某一页取回来 |
 * | `library` | 知识库与文档的增删查 | 都动的是"库里有什么" |
 * | `note` | `create_note` / `list_notes` / `attach_note_to_kb` | 笔记载体 |
 * | `memory` | `remember` | 长期记忆 |
 * | `file` | 导出四件套 + `ingest_artifact` | 都产出一份文件 |
 * | `skill` / `agent` | 技能与子 Agent | 能力层，不是数据层 |
 *
 * 没列到的一律落到 `tool`（服务器的方块）——**外部的 MCP 工具**走的也是这一档：
 * 它们各自是另一家的东西，我们不知道该怎么画，用一个中性图标比猜一个更像样。
 */
const TOOL_ICONS: Record<string, TraceIcon> = {
  search: 'search',
  recall: 'search',
  web_search: 'web',
  web_fetch: 'fetch',
  list_knowledge_bases: 'library',
  create_knowledge_base: 'library',
  list_documents: 'library',
  get_document_status: 'library',
  delete_document: 'library',
  upload_document: 'library',
  add_data_source: 'library',
  attach_note_to_kb: 'library',
  create_note: 'note',
  list_notes: 'note',
  remember: 'memory',
  export_document: 'file',
  export_table: 'file',
  export_deck: 'file',
  ingest_artifact: 'file',
  list_skills: 'skill',
  read_skill: 'skill',
  spawn_subagent: 'agent',
}

/**
 * 老快照（v0.26 之前）的兜底：那时步骤里只有中文标签，没有工具名。
 *
 * **键是当时写下的标签**，所以它只对那批数据有效——后端哪天改了某个标签的措辞，
 * 这里就匹配不上，那些老步骤退回中性图标。**这是可接受的降级**：
 * 它只影响历史回放的图标，不影响任何新数据，也不会显示错的东西。
 */
const LEGACY_LABEL_ICONS: Record<string, TraceIcon> = {
  联网搜索: 'web',
  抓取网页: 'fetch',
  检索知识库: 'search',
  回忆: 'search',
  查看知识库: 'library',
  新建知识库: 'library',
  查看文档列表: 'library',
  查询文档状态: 'library',
  删除文档: 'library',
  上传文档: 'library',
  添加数据源: 'library',
  把笔记加入知识库: 'library',
  写笔记: 'note',
  查看笔记: 'note',
  记住: 'memory',
  导出文档: 'file',
  导出表格: 'file',
  导出幻灯: 'file',
  存进知识库: 'file',
  查看技能目录: 'skill',
  读技能: 'skill',
  '派子 Agent': 'agent',
}

/** 这一步该画哪个图标：先看工具名，再看老快照的标签，最后按 phase。 */
export function stepIcon(step: { phase: string; tool?: string; label?: string }): TraceIcon {
  if (step.tool) {
    // `mcp__服务__工具`：外部工具统一画"服务器"，那正是它在我们这边的身份
    if (step.tool.startsWith('mcp__')) return 'mcp'
    return TOOL_ICONS[step.tool] ?? 'tool'
  }
  if (step.phase === 'tool' && step.label) {
    return LEGACY_LABEL_ICONS[step.label] ?? 'tool'
  }
  return STEP_ICONS[step.phase] ?? 'search'
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
 * 所以现在收集到一处、摆在正文后面（见 `ChatView` 的 `.deliverables`）。
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

function agentTraceSteps(message: Message): TraceStep[] {
  // 显式标注元素类型：不标的话 TS 会把 `empty` 推成必填，后面 unshift 思考那一步就类型不兼容
  const steps: TraceStep[] = message.steps.map((step, index) => ({
    key: `${step.phase}-${index}`,
    icon: stepIcon(step),
    tool: step.tool,
    // 老快照没有 `tool`：退回当时的标签，好让**已经存在的对话**也能合并
    group: step.phase === 'tool' ? step.tool || step.label : undefined,
    label: step.label,
    detail: step.phase === 'answer' ? answerDetail(message) : step.detail,
    // "这一轮什么新东西都没找到"在过程面板里要轻一档：它是一句交代，不是一次收获
    empty: step.added === 0,
    // 原文只在真有的时候带上（"组织回答"那一步没有）
    args: step.args,
    result: step.result,
    artifacts: step.artifacts,
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
      detail: `「${short}」找到 ${message.sources.length} 个片段`,
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
  return message.text.length > 0 ? `共 ${message.text.length} 字` : ''
}

/**
 * 面板是否展开。
 *
 * **默认展开，而且不再自动收起**（v0.25，照 Kimi 的对话页）。
 *
 * 改之前是"边等边看"：还没吐字的那几秒展开（那时它就是进度条），
 * 第一个字一到就自动收起。问题是**用户永远看不到它**——
 * 他盯着屏幕的那一刻，面板正好收起来了；想再看一眼刚才调了什么，
 * 得先意识到"刚才有那么一块"，再去点那一行标题。
 *
 * Kimi 的做法是过程**常驻在正文里**：调了哪个工具、搜了几个结果，
 * 一直是答案的一部分。所以这里也改成默认展开；`traceOpen` 有值时仍完全听用户的
 * （点标题收起是明确表达过的意愿，不该被流式状态覆盖）。
 *
 * 代价是每一轮都多占几行。可接受：那些行本身就是"这句回答是怎么来的"，
 * 而收起来的信息等于没有。
 */
export function isTraceOpen(message: Message): boolean {
  if (message.traceOpen !== undefined) return message.traceOpen
  return true
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
