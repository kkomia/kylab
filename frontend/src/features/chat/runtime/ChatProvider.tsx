/**
 * 对话页的**页面状态与动作**（旧 `ChatView.vue` 里除模板之外的那一半）。
 *
 * 三件事只在这一处发生，界面（`ui/**`）只读它、只调它：
 *
 * 1. **消息数组**：`Message[]` 是唯一真相，平铺一条条（与后端存的一致），
 *    展示分组交给 `buildTurns`；
 * 2. **常驻流的镜像**：`model/liveTurn` 里那一轮的状态（正文/思考/步骤/出处/确认）
 *    被"倒"进消息数组（旧 `ChatView.syncLive` 那条规则，逐条照搬）；
 * 3. **发送链路**：建会话 → 斜杠命令分流 → 起一轮（全部走我们自己的 SSE，
 *    assistant-ui 一个字节都不碰）。
 *
 * 为什么状态放在 React 里而不是模块作用域：旧前端的消息数组是组件局部的，常驻流
 * 才是模块级的（切页不丢）。这一层保持同一分工——**页面状态随页面走，
 * 流的状态随应用走**（后者在 `model/liveTurn` 里）。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams, useSearchParams } from 'react-router'

import {
  chatStream,
  listCommands,
  type ChatApproval,
  type ChatArtifact,
  type ChatCommand,
  type ChatCommandResult,
  type ChatHistoryMessage,
  type ChatSource,
  type ChatStep,
  type ThinkingEffort,
} from '@/api/chat'
import {
  createConversation,
  ingestArtifact,
  listArtifacts,
  rewindConversation,
  type ConversationArtifact,
  type ConversationDetail,
} from '@/api/conversations'
import { uploadDocument } from '@/api/documents'
import type { KnowledgeBase } from '@/api/knowledgeBases'
import { createNote } from '@/api/notes'
import type { RegisteredModel } from '@/api/modelRegistry'
import { copyText } from '@/lib/clipboard'
import { formatBytes, formatCount } from '@/lib/format'

import {
  buildTurns,
  makeMessage,
  readTraceOpenMemory,
  tracePage,
  TRACE_PAGE_SIZE,
  writeTraceOpenMemory,
  type Message,
  type TracePage,
  type Turn,
} from '@/features/chat/model/turns'
import { splitSuggestions } from '@/features/chat/model/suggestions'

// 项目清单（壳那一层）：`?workspace=` 那条新建链路要说清"这一条会落在哪个项目"。
// 侧栏是发起方，这份清单通常已经在手上（`ensureWorkspacesLoaded` 那一下就是补这个）。
import { ensureWorkspacesLoaded, useWorkspaceStore } from '@/features/layout/workspaces'

import { liveActions, useLiveTurnState, type LiveThinking, type LiveTurnState } from './liveAdapter'
import { notifyError, notifySuccess, notifyWarning } from './notify'
import {
  KB_SWITCH_KEY,
  LAST_EFFORT_KEY,
  LAST_MODEL_KEY,
  LAST_THINKING_KEY,
  readPinnedSkills,
  readStored,
  readStoredEffort,
  writePinnedSkills,
  writeStored,
} from './prefs'
import {
  useChatCommands,
  useChatModels,
  useConversationDetail,
  useConversations,
  useConversationFiles,
  useKnowledgeBases,
  useSkills,
  useContextUsage,
  useSuggestedQuestions,
} from './useChatData'

/** 会话里带入模型的历史轮数上限：无边界地带上全部历史，提示词会先被自己挤爆。 */
const HISTORY_LIMIT = 6
/** 示例问题一次显示几个。一屏放得下五六个，再多就变成一堵墙。 */
const SAMPLE_COUNT = 5

/**
 * 静态样例：**语料生成拿不到时的兜底**。
 *
 * 写死的问题和用户的语料无关，点进去往往答不上来，所以它只做兜底；
 * 真正展示的是后端依据所选库的原文生成的建议。
 */
const STATIC_SAMPLES = [
  '这些资料里反复提到的关键结论是什么？',
  '把几份文档的主要观点对比一下。',
  '有哪些明确的数字或阈值？分别出自哪里？',
  '关于这个问题，资料里有相互矛盾的说法吗？',
  '按资料的说法，第一步应该做什么？',
  '有没有提到适用范围或前提条件？',
  '最近入库的文档都讲了什么？',
  '哪些结论有原文明确支持，哪些只是推测？',
] as const

/**
 * 界面里的消息：模型层那份 `Message` 加上一个**稳定的 id**。
 *
 * 为什么要 id：assistant-ui 的消息列表靠它做 key 与"这一条是哪一条"，
 * 而我们自己的镜像（把流的状态打进最后一条）也要能认出它。
 */
export interface ChatMessage extends Message {
  id: string
}

let messageSeq = 0
function makeChatMessage(
  role: ChatMessage['role'],
  text: string,
  extra: Partial<Message> = {},
): ChatMessage {
  messageSeq += 1
  return { ...makeMessage(role, text, extra), id: `m${messageSeq}` }
}

/** `@` 提及里的一条候选（四类共用一个形状，见 `ui/Menus.tsx`）。 */
export interface MentionItem {
  /**
   * `knowledge` 那一类与另外三类**做的事不一样**：它不是"往输入框里插一条引用文本"，
   * 而是**把某个知识库并进这一轮的检索范围**（见 `applyMention`）。
   * 所以那一类的 `value` 放的是**库 id**（只用来认是哪一份，不插进输入框）。
   */
  kind: 'file' | 'skill' | 'session' | 'knowledge'
  /** 插进输入框的引用文本（不含前导的 `@`）；`knowledge` 那一类放库 id，不插。 */
  value: string
  label: string
  detail: string
  isDir?: boolean
}

type UsageQuery = ReturnType<typeof useContextUsage>

export interface ChatApi {
  // —— 会话
  conversationId: string
  messages: ChatMessage[]
  turns: Turn[]
  /** 还没决定这一页显示什么（解析入口或回放会话）：画骨架屏，不画欢迎层。 */
  pendingEntry: boolean
  /** 第一轮对话之前：欢迎层与输入卡片作为一组居中。 */
  welcome: boolean
  /**
   * 这次新建将落到哪个项目（`?new=1&workspace=<id>`，侧栏项目行那颗「+」带来的）；
   * `null` = 不落在任何项目下（未归档对话），或者项目名还没到手。
   *
   * 摆出来是让人**在第一条消息落下之前**就知道这条会话归谁——建完才知道落点，
   * 事后还得自己去「移至项目」里找补，正是这条链路要修掉的那件事。
   */
  pendingWorkspace: { id: string; name: string } | null
  sending: boolean

  // —— 流上两条"停在这里等用户"的东西
  pendingApproval: ChatApproval | null
  /** 那条确认已经有结论了：把它收起来（决定本身由 `ApprovalBar` POST 给后端）。 */
  dismissApproval: () => void
  commandResult: ChatCommandResult | null
  dismissCommandResult: () => void
  /**
   * 命令送回输入框的那一句（`/rewind` 的 `refill`）；`null` = 没有正在等认领的回填。
   *
   * `Composer` 认它做一件事：**把焦点与光标交回输入框末尾**。字已经在 `query` 里了
   * （provider 填的），这里给的是"这一下是回填来的"这个信号（`seq` 让同一句话连着
   * 回填两次也各算一次）。
   */
  commandRefill: { text: string; seq: number } | null

  // —— 输入
  query: string
  setQuery: (value: string) => void
  canSend: boolean
  send: () => void
  stop: () => void

  // —— 知识库与技能
  kbs: KnowledgeBase[]
  kbLoading: boolean
  /** 这一轮查不查库（原「知识库」开关；现在长在合并后那颗胶囊的面板顶部，叫「启用」）。 */
  useKb: boolean
  /**
   * 打开/关掉「启用」。**是 set 而不是 toggle**：那颗开关现在是一枚多选项
   * （Radix 的 checkbox 语义给出的是"目标状态"，不是"翻一下"），
   * 传目标值能避免"连点两下少翻一次"那类对不上的状态。
   */
  setKbEnabled: (on: boolean) => void
  selectedKbIds: string[]
  toggleKb: (id: string) => void
  /** 面板上的「全选」/「清空」：一次改完整个范围，比逐个点快。 */
  selectAllKbs: () => void
  clearKbs: () => void
  /**
   * 合并后那颗胶囊上"状态"那段字：`已关` / `读取中…` / `还没有知识库` / `未选库` /
   * `全部 N 个` / `已选 N 个`（前缀「知识库 ·」由 `ComposerControls` 拼上）。
   */
  kbPickText: string
  pinnedSkills: string[]
  toggleSkill: (name: string) => void
  skills: { name: string; summary: string; description: string }[]
  skillsLoading: boolean
  uploadFiles: (files: File[]) => void
  uploading: boolean

  // —— 模型与思考
  models: RegisteredModel[]
  modelOptions: { value: string; label: string }[]
  modelPk: string
  setModelPk: (value: string) => void
  modelPlaceholder: string
  modelsLoaded: boolean
  thinkingOn: boolean
  setThinkingOn: (value: boolean) => void
  thinkingEffort: ThinkingEffort
  setThinkingEffort: (value: string) => void

  // —— 命令与提及
  commands: ChatCommand[]
  loadCommands: () => void
  mentionItems: MentionItem[]
  mentionLoading: boolean
  loadMentions: () => void
  applyMention: (item: MentionItem) => void
  insertReference: (value: string) => void
  mentionToken: (value: string) => string

  // —— 结构化问答（`/plan` 这类命令的写法见 `ui/SlashMenu`）
  commandsLoading: boolean
  applyCommand: (command: ChatCommand) => void

  // —— 上下文仪表
  contextUsage: UsageQuery
  compressContext: () => void

  // —— 欢迎层
  suggestions: string[]
  suggestionsLoading: boolean
  showSuggestions: boolean
  shuffleSuggestions: () => void
  useSample: (question: string) => void

  // —— 过程面板
  traceOpen: (message: Message) => boolean
  toggleTrace: (message: Message) => void
  traceView: (turnIndex: number, turn: Turn) => TracePage
  showMoreTrace: (turnIndex: number) => void
  isStepOpen: (key: string) => boolean
  toggleStep: (key: string) => void
  isGroupOpen: (key: string) => boolean
  toggleGroup: (key: string) => void
  citesExpanded: (turnIndex: number) => boolean
  toggleCites: (turnIndex: number) => void
  flashCite: string
  revealSource: (turnIndex: number, sourceIndex: number) => void
  copiedKey: string
  copyMessage: (turnIndex: number, message: Message) => void
  savedTurns: number[]
  saveAsNote: (turnIndex: number, turn: Turn) => void
  regenerating: boolean
  regenerate: (turnIndex: number) => void
  /** 重发**失败的那一轮**（只在画面上撤掉这一对，不回退会话，见 provider 里的说明）。 */
  retryTurn: (turnIndex: number) => void
  resuming: boolean
  resumeTurn: (turnIndex: number) => void

  // —— 出处原文与交付物
  sourceOpen: boolean
  activeSource: ChatSource | null
  openSource: (source: ChatSource) => void
  closeSource: () => void

  /**
   * 文件区抽屉（产物与文件）。
   *
   * 状态落在 provider 上而不是 `Composer` 里，因为**它有两个入口**：输入卡片的
   * 「加号 → 浏览文件」，与产物卡片上的「预览」——后者在消息流里，够不着
   * `Composer` 的内部状态（旧 `ChatView` 的 `fileDrawer` 也是页面级的：
   * 它要同时表达"开着"与"直落哪一份"）。
   */
  filesOpen: boolean
  /**
   * 打开文件区时**要直落的那一份**（产物卡片点「预览」给的就是它）。
   *
   * `key` 是这份文件在文件区里的 key——产物在临时区的 key 就是 `artifact_id`，
   * **没有后缀**，光看它猜不出该用哪个渲染器，所以名字与格式由调用方一起给
   * （旧 `FileDrawer` 的 `initialEntry` 就是为这一段存在的，那里的注释写着用户报的
   * 那个 bug：同一份文件从产物卡片点开说"不能预览"，从工作区点开却好好的）。
   */
  filesSeed: { key: string; name: string; kind: string } | null
  openFiles: (seed?: { key: string; name: string; kind: string } | null) => void
  closeFiles: () => void

  ingestTarget: ChatArtifact | null
  ingestKbId: string
  setIngestKbId: (value: string) => void
  openIngest: (file: ChatArtifact) => void
  closeIngest: () => void
  confirmIngest: () => void
  ingesting: boolean
  kbName: (kbId?: string) => string

  // —— 拖拽的两种落法
  dropKind: 'attach' | 'reference' | null
  setDropKind: (value: 'attach' | 'reference' | null) => void
}

const ChatContext = createContext<ChatApi | null>(null)

export function useChat(): ChatApi {
  const value = useContext(ChatContext)
  if (!value) throw new Error('useChat 必须在 <ChatProvider> 里用')
  return value
}

/** 这一条消息的 id（界面里的消息一定有；模型层那份类型没有这个字段）。 */
function idOf(message: Message): string {
  return (message as ChatMessage).id ?? ''
}

/**
 * 把一份会话详情铺进界面（缓存与网络两条路都走它，口径才不会分叉）。
 *
 * 三个"都要还原"：
 * - **过程与思考**（v0.25）：不然离开这一页再回来，只剩一句"已生成回答"；
 * - **库范围**：回放时沿用，否则多轮上下文会指向上一次没查的库；
 * - **模型与思考档**（v12/v16）：为空则保持当前默认。
 */
function messagesFromDetail(detail: ConversationDetail): ChatMessage[] {
  return detail.messages.map((item) =>
    makeChatMessage(item.role === 'user' ? 'user' : 'assistant', item.content, {
      sources: item.sources,
      // 后端的 `steps` 是"快照"（字段随版本加过好几次），读的时候一律按可选取值
      steps: (item.steps ?? []) as unknown as ChatStep[],
      thinkingText: item.thinking ?? '',
      // 这一轮当时用哪档思考没存（那是会话级偏好），不猜
      thinking: null,
    }),
  )
}

/** 接口返回的产物 → 步骤快照里那份的形状（空值归一，理由见旧 `ChatView.fromStored`）。 */
function fromStored(item: ConversationArtifact): Partial<ChatArtifact> & { artifact_id: string } {
  return {
    artifact_id: item.artifact_id,
    name: item.name,
    size_bytes: item.size_bytes,
    format: item.format,
    storage: item.storage,
    where: item.where,
    ...(item.path ? { path: item.path } : {}),
    ...(item.knowledge_base_id ? { knowledge_base_id: item.knowledge_base_id } : {}),
    ...(item.document_id ? { document_id: item.document_id } : {}),
  }
}

/**
 * 输入框上那颗「知识库」胶囊的**状态那段字**上写什么。
 *
 * 这里是"当前这一轮查不查、查哪几个"的**唯一**读数：开关与多选合并成一个控件之后
 * （2026-09-24，"开关和『全部 4 个』合并成一个控件"），三态必须从这一颗胶囊上读出来
 * ——`已关` / `未选库` / `全部 N 个`或`已选 N 个`。
 *
 * 关掉的那一档**不沿用"选了哪几个"那几句话**：关着时"全部 4 个"是一句假话
 * （这一轮一个都不查），所以它单独占一档，排在最前。
 */
function pickText(enabled: boolean, loading: boolean, total: number, selected: number): string {
  if (!enabled) return '已关'
  // **还没加载完就说"还没有知识库"是假话**：库明明在，只是还没取回来
  if (loading && total === 0) return '读取中…'
  if (total === 0) return '还没有知识库'
  if (selected === 0) return '未选库'
  if (selected === total) return `全部 ${selected} 个`
  return `已选 ${selected} 个`
}

/**
 * 一段消息要带给模型的那份历史（只取最后 `HISTORY_LIMIT` 条）。
 *
 * 失败或没吐字的助手消息**不进历史**：模型看到空的上一轮会更离谱。
 * 「重试」也要用它，但作用在**这一轮之前**的那一段上（见 `retryTurn`）。
 */
function historyOf(items: readonly ChatMessage[]): ChatHistoryMessage[] {
  return items
    .filter((item) => item.role === 'user' || (item.text.length > 0 && !item.error))
    .slice(-HISTORY_LIMIT)
    .map((item) => ({ role: item.role, content: item.text }))
}

/**
 * 一条斜杠命令**有没有真的产出内容**（P1-2）。
 *
 * 判据就是任务里那句话：**看结果里有没有正文/回答**——命令的表级 `short_circuit`
 * 只说明"通常不产生回答"，而 `/plan <描述>`、自定义命令会照常过模型并留下回答。
 * 唯一要排除的是**补发的收口**（`recovered`）：那条 `done` 带的是库里最后一条回答，
 * 不是这一轮产出的东西，照它建气泡会凭空多出一轮看过的回答。
 */
function commandProducedContent(state: LiveTurnState): boolean {
  return (
    state.steps.length > 0 ||
    state.sources.length > 0 ||
    state.error.length > 0 ||
    (state.text.length > 0 && !state.recovered)
  )
}

/**
 * 把"正在流式的那一轮"**镜像**进本页的消息数组（旧 `ChatView.syncLive`，逐条照搬）。
 *
 * 规则四支：
 * - **`command`（一条斜杠命令）**：真有内容才补出"提问 + 回答"，而且只补一次——
 *   命令可能只是系统的回话（`/help`），那不该在对话流里留下气泡；
 * - **`append`（新起一轮）且画面上没有那一对**（用户离开期间流还在跑，回来时组件是新挂载的）
 *   → 用 live 里的提问与已经流出的字补出一对；
 * - **`recover`（刷新之后接回来的那一轮）**：只补回答那一条，而且**只有正文到了才补**
 *   （正文增量不补发，"有正文"就等于"这一轮还活着"；提问随落库才有，补不出来）；
 * - 其余只管把最后一条助手消息的字段刷成最新值。
 */
function mirrorLive(
  prev: ChatMessage[],
  state: LiveTurnState,
  drawn: WeakSet<object>,
): ChatMessage[] {
  const last = prev.at(-1)
  const hasPlaceholder = last?.role === 'assistant' && last.streaming === true
  let next = prev

  if (!hasPlaceholder) {
    if (state.mode === 'command') {
      if (drawn.has(state) || !commandProducedContent(state)) return prev
      drawn.add(state)
      next = [
        ...prev,
        makeChatMessage('user', state.query),
        makeChatMessage('assistant', state.text, {
          streaming: state.streaming,
          thinking: state.thinking,
        }),
      ]
    } else if (!state.streaming) {
      // 收尾了、画面上又还没有它：什么都不补——库里那份才是权威
      return prev
    } else if (state.mode === 'append') {
      next = [
        ...prev,
        makeChatMessage('user', state.query),
        makeChatMessage('assistant', state.text, { streaming: true, thinking: state.thinking }),
      ]
    } else if (state.mode === 'recover' && state.text.length > 0) {
      next = [
        ...prev,
        makeChatMessage('assistant', state.text, { streaming: true, thinking: state.thinking }),
      ]
    } else {
      return prev
    }
  }

  const target = next.at(-1)
  if (!target || target.role !== 'assistant') return next
  return next.map((item) =>
    item.id === target.id
      ? {
          ...item,
          text: state.text,
          thinkingText: state.thinkingText,
          steps: state.steps,
          sources: state.sources,
          streaming: state.streaming,
          error: state.error,
        }
      : item,
  )
}

export function ChatProvider({ children }: { children: ReactNode }) {
  const params = useParams<{ conversationId?: string }>()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  /**
   * 当前会话 id。**以路径为唯一来源**，不做本地副本：侧栏点、前进/后退、
   * 直接打开链接三种入口都会改路径，自己再存一份就得在三处同步。
   */
  const conversationId = params.conversationId ?? ''
  /** 显式新建（侧栏「新对话」带来的 `?new=1`）：`/chat` 表示"回到最近一次"。 */
  const wantsNew = Boolean(searchParams.get('new'))
  /**
   * 这次新建要落在哪个项目下（`?workspace=<id>`，侧栏项目行那颗「+」带来的）。
   *
   * **两个条件都要满足**：是"新建"这条入口（`?new=1`）且还没有会话 id。
   * 会话一旦建起来，落点就已经写进库里了——地址里再挂着它只会骗人
   * （`/chat/<id>?workspace=x` 什么都改不了），所以那边一律不认。
   */
  const pendingWorkspaceId =
    wantsNew && !params.conversationId ? (searchParams.get('workspace') ?? '').trim() : ''

  const live = useLiveTurnState()

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [query, setQueryState] = useState('')
  const [resolvingEntry, setResolvingEntry] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [resuming, setResuming] = useState(false)
  const [copiedKey, setCopiedKey] = useState('')
  const [savedTurns, setSavedTurns] = useState<number[]>([])
  const [commandResult, setCommandResult] = useState<ChatCommandResult | null>(null)
  /**
   * 命令送回输入框的那句提问（`/rewind` 的 `refill`）。
   *
   * 存成一个带 `seq` 的对象而不是一段字符串：**同一句话连着回填两次也要各自生效一次**
   * ——用户撤回、不改就又发出去、再撤回时，`text` 一个字没变，光看字符串的话
   * `Composer` 那个"把焦点交回输入框"的副作用第二次就不会跑。
   */
  const [commandRefill, setCommandRefill] = useState<{ text: string; seq: number } | null>(null)
  const [flashCite, setFlashCite] = useState('')
  const [sampleOffset, setSampleOffset] = useState(0)

  // 过程面板的展开态：两张表分开（"看某一步的原文"与"看这一组有哪些调用"同时开着是正常的）
  const [openSteps, setOpenSteps] = useState<ReadonlySet<string>>(new Set())
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(new Set())
  const [traceExtraPages, setTraceExtraPages] = useState<ReadonlyMap<number, number>>(new Map())
  const [expandedCites, setExpandedCites] = useState<ReadonlySet<number>>(new Set())
  /** 某一轮自己的展开态（点过就按点的那一档，`undefined` = 跟随"上次那一档"）。 */
  const [traceOpenIds, setTraceOpenIds] = useState<Record<string, boolean>>({})
  const [traceOpenMemory, setTraceOpenMemory] = useState<boolean | undefined>(() =>
    readTraceOpenMemory(),
  )

  // 出处原文弹窗 / 文件区抽屉 / 存进知识库弹窗 / 拖拽落法
  const [sourceOpen, setSourceOpen] = useState(false)
  const [activeSource, setActiveSource] = useState<ChatSource | null>(null)
  const [filesOpen, setFilesOpen] = useState(false)
  const [filesSeed, setFilesSeed] = useState<{ key: string; name: string; kind: string } | null>(
    null,
  )
  const [ingestTarget, setIngestTarget] = useState<ChatArtifact | null>(null)
  const [ingestKbId, setIngestKbId] = useState('')
  const [ingesting, setIngesting] = useState(false)
  const [dropKind, setDropKind] = useState<'attach' | 'reference' | null>(null)

  // —— 本机偏好（与旧前端同一批键） ——
  const [useKb, setUseKb] = useState(() => readStored(KB_SWITCH_KEY) !== '0')
  const [selectedKbIds, setSelectedKbIds] = useState<string[]>([])
  const [pinnedSkills, setPinnedSkills] = useState<string[]>(() => readPinnedSkills())
  const [modelPk, setModelPkState] = useState(() => readStored(LAST_MODEL_KEY))
  const [thinkingOn, setThinkingOnState] = useState(() => readStored(LAST_THINKING_KEY) !== 'false')
  const [thinkingEffort, setThinkingEffortState] = useState<ThinkingEffort>(() =>
    readStoredEffort(),
  )
  const [wantSkills, setWantSkills] = useState(false)
  const [wantCommands, setWantCommands] = useState(false)
  const [wantConvFiles, setWantConvFiles] = useState(false)

  // —— 服务端状态 ——
  const kbsQuery = useKnowledgeBases()
  const modelsQuery = useChatModels()
  const commandsQuery = useChatCommands(wantCommands)
  const skillsQuery = useSkills(wantSkills)
  const detailQuery = useConversationDetail(conversationId)
  const conversationsQuery = useConversations()
  const filesQuery = useConversationFiles(conversationId, wantConvFiles)
  const usageQuery = useContextUsage(conversationId)

  const kbs = useMemo(() => kbsQuery.data ?? [], [kbsQuery.data])
  const registry = modelsQuery.data
  const models = useMemo(() => registry?.models ?? [], [registry])
  const commands = useMemo(() => commandsQuery.data ?? [], [commandsQuery.data])
  const skills = useMemo(() => skillsQuery.data ?? [], [skillsQuery.data])

  /**
   * 项目清单：`?workspace=` 那条路上要用它的**名字**（新会话落在哪儿要摆给人看）。
   * 侧栏是这条入口的发起方，清单通常已经在手上——走 `ensureWorkspacesLoaded`
   * 只补"没加载过"那一次，与 `ChatHeader` / 「移至项目」同一条口径。
   */
  const workspaces = useWorkspaceStore((state) => state.items)
  useEffect(() => {
    if (pendingWorkspaceId) void ensureWorkspacesLoaded()
  }, [pendingWorkspaceId])
  /**
   * 摆给用户看的落点。**名字还没到手时给 `null`**（不画）：
   * 「在项目『』里新建」是一句不成立的话，而它一闪而过同样让人不安。
   */
  const pendingWorkspace = useMemo(() => {
    if (!pendingWorkspaceId) return null
    const name = workspaces.find((item) => item.id === pendingWorkspaceId)?.name ?? ''
    return name ? { id: pendingWorkspaceId, name } : null
  }, [pendingWorkspaceId, workspaces])

  /** 这一轮真正发出去的库范围：开关关掉就是空（后端据此跳过检索，就是一轮纯对话）。 */
  const effectiveKbIds = useMemo(() => (useKb ? selectedKbIds : []), [useKb, selectedKbIds])

  const suggestedQuery = useSuggestedQuestions(
    effectiveKbIds,
    messages.length === 0 && effectiveKbIds.length > 0,
  )

  // 库清单到位后**默认全选**：打开这一页的人多半就是要问遍手上的资料
  const kbSeeded = useRef(false)
  useEffect(() => {
    if (kbSeeded.current || kbs.length === 0) return
    kbSeeded.current = true
    setSelectedKbIds(kbs.map((item) => item.id))
  }, [kbs])

  /** 选一个默认模型：会话已存 > 本地上次 > 注册表里绑定给 chat 的 > 第一个可用。 */
  useEffect(() => {
    if (!registry) return
    setModelPkState((current) => {
      if (current && registry.models.some((item) => item.id === current)) return current
      const remembered = readStored(LAST_MODEL_KEY)
      const candidate = [registry.defaultPk, remembered].find(
        (value) => value && registry.models.some((item) => item.id === value),
      )
      return candidate ?? registry.models[0]?.id ?? ''
    })
  }, [registry])

  const setModelPk = useCallback((value: string) => {
    setModelPkState(value)
    if (value) writeStored(LAST_MODEL_KEY, value)
  }, [])

  const setThinkingOn = useCallback((value: boolean) => {
    setThinkingOnState(value)
    writeStored(LAST_THINKING_KEY, value ? 'true' : 'false')
  }, [])

  const setThinkingEffort = useCallback((value: string) => {
    const next: ThinkingEffort = value === 'low' || value === 'high' ? value : 'medium'
    setThinkingEffortState(next)
    writeStored(LAST_EFFORT_KEY, next)
  }, [])

  // ---------------------------------------------------------------- 常驻流的镜像

  /**
   * 流的状态**每一个可见字段**的指纹。
   *
   * 为什么不直接依赖 `live` 这个对象：那一层可能就地改字段（旧 Vue 的响应式就是这么做的），
   * 对象引用不一定变。指纹变了就说明"画面上该动"——这正是旧 `ChatView` 的
   * `streamFingerprint` 用来决定滚动的那一招，这里把它用在镜像上，更稳。
   */
  const liveFingerprint = useMemo(() => {
    if (!live) return ''
    const steps = live.steps.reduce(
      (sum, step) =>
        sum +
        step.label.length +
        step.detail.length +
        (step.args?.length ?? 0) +
        (step.result?.length ?? 0),
      0,
    )
    return [
      live.conversationId,
      live.mode,
      live.query,
      live.text.length,
      live.thinkingText.length,
      live.steps.length,
      steps,
      live.sources.length,
      live.streaming,
      live.error,
      live.recovered,
      live.approval?.approval_id ?? '',
    ].join('|')
  }, [live])

  const liveRef = useRef(live)
  liveRef.current = live
  /** 命令那一轮的气泡建过没有（按 live 状态对象认：换一轮就是新对象）。 */
  const commandPairDrawn = useRef<WeakSet<object>>(new WeakSet())
  /** 已经倒进消息里的那一份指纹（据此跳过没变化的重复计算）。 */
  const appliedFingerprint = useRef('')
  /** 库里那份会话详情已经画进消息了没有（按会话 id 记一次，见"会话装载"那一节）。 */
  const appliedDetail = useRef('')
  /**
   * 这一轮命令**撤掉了库里的轮次**（`/rewind` 给了 `refill`，见 `ChatCommandResult`）。
   *
   * 它要在收尾时起作用：那几轮在服务端已经删了，画面得按库重画一次；而
   * "会话详情只画一次"那道闸（`appliedDetail`）得先放回去，重画才落得下来。
   * 只置真、不在这里清——清的理由只有一个：收尾时用掉了（见下面那个 effect）。
   */
  const rewoundTurns = useRef(false)

  useEffect(() => {
    const state = liveRef.current
    if (!state || state.conversationId !== conversationId) return
    if (appliedFingerprint.current === liveFingerprint) return
    appliedFingerprint.current = liveFingerprint
    setMessages((prev) => mirrorLive(prev, state, commandPairDrawn.current))
  }, [liveFingerprint, conversationId])

  /**
   * 流从"在跑"变成"没在跑"：**由当前挂载着的这一页收尾**（旧 `settleTurn`）。
   *
   * 用户自己按的「停止」是例外：被停掉的那一轮不在库里（后端只在跑完时落库），
   * 所以不回源去盖掉它；上下文仪表仍然要刷新（它读的是接口，不影响这些收尾）。
   */
  const wasStreaming = useRef(false)
  const usageRefetch = usageQuery.refetch
  const detailRefetch = detailQuery.refetch
  useEffect(() => {
    const streaming = Boolean(live?.streaming)
    const settled = wasStreaming.current && !streaming
    wasStreaming.current = streaming
    if (!settled || !conversationId) return
    void usageRefetch()
    if (live?.stopped) return
    // `/rewind` 撤过轮：被撤的那几轮只在库里"没了"，画面上的尾部是镜像自己长出来的，
    // 不重读一次库它就永远挂在那儿（直到刷新）。**顺手把"只画一次"那道闸放回去**
    // ——否则刚重读回来的详情会被它挡掉，等于白读。
    if (rewoundTurns.current) {
      rewoundTurns.current = false
      appliedDetail.current = ''
    }
    void detailRefetch()
  }, [live?.streaming, live?.stopped, conversationId, detailRefetch, usageRefetch])

  // ---------------------------------------------------------------- 会话装载

  /**
   * 把这条会话的产物**现在的样子**合并进各步骤的卡片（按 `artifact_id` 对齐）。
   *
   * 只在已有的卡片上改，**不新增**：列表接口会带回这条会话的全部产物，
   * 包括被「重新生成」回退掉的那几轮——凭空多出来的卡片会让人以为文件还在。
   */
  const refreshArtifacts = useCallback(async (id: string) => {
    try {
      const { items } = await listArtifacts(id)
      setMessages((prev) =>
        prev.map((message) => ({
          ...message,
          steps: message.steps.map((step) =>
            step.artifacts
              ? {
                  ...step,
                  artifacts: step.artifacts.map((file) => {
                    const fresh = items.find((item) => item.artifact_id === file.artifact_id)
                    return fresh ? { ...file, ...fromStored(fresh) } : file
                  }),
                }
              : step,
          ),
        })),
      )
    } catch {
      // 锦上添花的一次刷新：拿不到就退回快照那份（卡片仍然可用）
    }
  }, [])

  const detail = detailQuery.data
  useEffect(() => {
    if (!detail || detail.id !== conversationId) return
    if (appliedDetail.current === detail.id) return
    appliedDetail.current = detail.id
    // 这一轮还在写（无论本页在不在），库里都没有它——画完历史之后由镜像补回来；
    // 但要是它**已经写完了**（用户离开期间跑完的），库里那份才是权威
    const current = liveRef.current
    if (current?.conversationId === detail.id && !current.streaming) liveActions.clearLiveTurn()
    setMessages(messagesFromDetail(detail))
    if (detail.kb_ids.length) {
      setSelectedKbIds((prev) => {
        const kept = detail.kb_ids.filter((id) => kbs.some((item) => item.id === id))
        return kept.length ? kept : prev
      })
    }
    if (detail.model_pk) setModelPk(detail.model_pk)
    if (detail.thinking !== null) setThinkingOn(detail.thinking)
    if (detail.thinking_effort) setThinkingEffortState(detail.thinking_effort)
    // 产物的**当前状态**要另外问一次：步骤里存的是流式当时的样子
    void refreshArtifacts(detail.id)
    void liveActions.attachLiveTurn(detail.id)
  }, [detail, conversationId, kbs, setModelPk, setThinkingOn, refreshArtifacts])

  /** 换会话：清掉页面上一切"属于上一条"的东西。 */
  useEffect(() => {
    setMessages([])
    setOpenSteps(new Set())
    setOpenGroups(new Set())
    setTraceExtraPages(new Map())
    setExpandedCites(new Set())
    setTraceOpenIds({})
    setCommandResult(null)
    // 回填信号也跟着清：换会话之后没人认领它，留着会让新页面白挨一次焦点跳动
    setCommandRefill(null)
    setCopiedKey('')
    setSavedTurns([])
    setDropKind(null)
    setWantConvFiles(false)
    appliedFingerprint.current = ''
  }, [conversationId, wantsNew])

  /**
   * 停在 `/chat`（没有 id）时该显示什么：最近一次对话，或者空态。
   *
   * 解析期间**不画欢迎层**（`resolvingEntry`）：先画再跳的话，用户还是会看到
   * "一屏新对话一闪而过"。用 `replace` 而不是 `push`：历史里不该留下中间那个空的 `/chat`。
   */
  const entryToken = useRef(0)
  const latestId = conversationsQuery.data?.[0]?.id ?? ''
  useEffect(() => {
    if (conversationId || wantsNew) return
    if (!latestId) return
    const token = ++entryToken.current
    setResolvingEntry(true)
    if (token !== entryToken.current) return
    setResolvingEntry(false)
    void navigate(`/chat/${latestId}`, { replace: true })
  }, [conversationId, wantsNew, latestId, navigate])

  // 全局快捷键（`chat.new` / `layout.toggleSidebar`）由**壳**注册
  // （`features/layout/SideNav` 的全局快捷键宿主，见 `runtime/shortcutPrefs.ts` 的模块头）：
  // 这一页不再自己挂 window keydown —— 两份监听会双触发（侧栏收起来又立刻打开）。
  // 输入框里的那两条（回车发送 / 换行）仍归 `Composer`，作用域是 local，不在此列。

  // ---------------------------------------------------------------- 发送链路

  const turns = useMemo(() => buildTurns(messages), [messages])
  const sending = Boolean(live?.streaming && live.conversationId === conversationId)
  const pendingEntry = resolvingEntry || detailQuery.isLoading

  /**
   * 这一条会话上**在等用户点头**的那一次工具调用。看会话是刻意的：确认条属于"这一轮"，
   * 切走再回来也还要摆出来——后端一直在等，界面不显示的话它只能等到超时。
   */
  const pendingApproval = useMemo(
    () => (live && live.conversationId === conversationId ? live.approval : null),
    [live, conversationId],
  )

  const history = useMemo<ChatHistoryMessage[]>(() => historyOf(messages), [messages])

  /**
   * 跑一轮流式问答：追加"提问 + 占位回答"两条，再把增量**就地**打进占位那条。
   * `send` 与 `regenerate` **共用这一份**（旧前端踩过"两处各抄一遍"的坑）。
   */
  const streamTurn = useCallback(
    async (
      text: string,
      context: ChatHistoryMessage[],
      model: string | undefined,
      target: string,
      /**
       * 这一轮真正发出去的库范围。默认就是输入框当前那份；**新建那条路上显式给一份**
       * ——从项目入口进来时，后端按工作区继承下来的那几个库（见 `send`）：
       * 建会话与发第一轮之间隔着一次往返，闭包里那份 `effectiveKbIds` 可能已经不是
       * 接口刚刚记下的那份了。
       */
      kbIds: string[] = effectiveKbIds,
    ) => {
      setMessages((prev) => [
        ...prev,
        makeChatMessage('user', text),
        makeChatMessage('assistant', '', {
          streaming: true,
          // 记下这一轮实际发出去的思考档：过程面板要如实显示"这一步做没做"
          thinking: { enabled: thinkingOn, effort: thinkingEffort },
        }),
      ])
      const thinking: LiveThinking = { enabled: thinkingOn, effort: thinkingEffort }
      await liveActions.startChatTurn(
        {
          query: text,
          kb_ids: kbIds,
          skill_names: pinnedSkills,
          history: context,
          conversation_id: target,
          model_pk: model,
          thinking: thinkingOn,
          thinking_effort: thinkingEffort,
        },
        { conversationId: target, query: text, thinking },
      )
    },
    [effectiveKbIds, pinnedSkills, thinkingEffort, thinkingOn],
  )

  /**
   * 输入框内容的那一个入口（受控组件：**一律经过这里**，别处只读 `query`）。
   *
   * 它定义在这一段（而不是下面"引用与命令"那一节）只有一个原因：`refillQuery` 要用它，
   * 而 `refillQuery` 得排在 `runCommand` 前面（`runCommand` 的依赖数组在渲染期就求值，
   * 引用一个定义在下面的 `const` 会当场抛 `Cannot access 'setQuery' before initialization`）。
   */
  const setQuery = useCallback((value: string) => {
    setQueryState(value)
    setWantCommands(value.startsWith('/') && !value.includes('\n'))
    if (value.lastIndexOf('@') >= 0) setWantSkills(true)
  }, [])

  /**
   * 命令把一句提问送回输入框（`/rewind` 的 `refill`）：**填进去、光标落在末尾、
   * 焦点跟着进去**——用户改一版就能直接回车重发，不必先点一下输入框。
   *
   * 填的是后端给的那一句**原样**：既不改写也不去重，别的判断一概不做。
   * 焦点那一下由 `Composer` 认 `commandRefill` 这个信号去做（textarea 在它手上，
   * provider 不碰 DOM）。
   */
  const refillQuery = useCallback(
    (text: string) => {
      setQuery(text)
      setCommandRefill((prev) => ({ text, seq: (prev?.seq ?? 0) + 1 }))
    },
    [setQuery],
  )

  /**
   * 命令回话里那几个"顺手要做的事"（后端 `action`）。
   * 放在 `runCommand` 之前定义：它要在两处被调到（常驻链路与流式期间那条直连链路）。
   */
  const handleCommandAction = useCallback(
    (result: ChatCommandResult): void => {
      const action = result.action
      if (!action) return
      if (action.kind === 'conversation' && action.conversation_id) {
        // `/new`：切到新会话（replace，不该在历史里留一条旧会话）
        void navigate(`/chat/${action.conversation_id}`, { replace: true })
        return
      }
      if (action.kind === 'stop_turn') {
        liveActions.abortLiveTurn()
        return
      }
      if (action.kind === 'mode') {
        // 模式被命令改了：那一排的控件要跟着显示新档
        window.dispatchEvent(new CustomEvent('kylab:mode-changed', { detail: action.mode }))
        return
      }
      if (action.kind === 'model' && action.model_pk) {
        // `/model <名字>`：不同步的话它显示的还是旧模型，而下一条消息会照它把旧模型写回会话。
        // 缓存里那份会话详情还带着旧模型，所以让后端校准一次
        setModelPk(action.model_pk)
        void detailRefetch()
      }
    },
    [detailRefetch, navigate, setModelPk],
  )

  const conversationsRefetch = conversationsQuery.refetch

  /**
   * 跑一条命令：**它就是一轮请求，只是后端可能不产生回答**。
   *
   * 分流**按结果**，不按菜单里的 `short_circuit`：那个标记是表级的保守口径，
   * 而 `/plan <描述>` 与 `/skill` 同属改写类（描述就是这一轮的提示、要过一次模型、
   * 会留下回答）。所以这里统一带上 `onCommand` 走正常那一轮，由镜像按"有没有内容"
   * 决定建不建气泡。
   */
  const runCommand = useCallback(
    async (
      text: string,
      target: string,
      model: string | undefined,
      /** 同 `streamTurn` 的第 5 个参数：新建那条路上把这一轮的库范围显式传进来。 */
      kbIds: string[] = effectiveKbIds,
    ) => {
      // **先确保菜单到手**（要真的等一下）：清单空 = 后端没有命令这一层（旧版本），
      // 按普通一轮发出去才是对的（反过来的话，用户会得到一条空回答。
      // 第一次敲 `/plan` 时清单还没请求过，读 hook 上那份会读到 undefined——
      // 于是"带参数的 /plan"就会被当成普通提问，正是这条分支要修的 bug）
      setWantCommands(true)
      let list: ChatCommand[] = commandsQuery.data ?? []
      if (list.length === 0 && !commandsQuery.data) {
        list = await queryClient.fetchQuery<ChatCommand[]>({
          queryKey: ['chat', 'commands'],
          queryFn: () => listCommands(),
          staleTime: Infinity,
        })
      }
      if (list.length === 0) {
        await streamTurn(text, history, model, target)
        return
      }
      const payload = {
        query: text,
        kb_ids: kbIds,
        conversation_id: target,
        model_pk: model,
      }
      setCommandResult(null)
      const onCommand = (result: ChatCommandResult): void => {
        setCommandResult(result)
        // `/rewind`：后端把**被撤掉的那句提问**随结果给回来 → 回填进输入框。
        // 没有这个字段时一个字都不动（也不从 `result.text` 里抠，见 `ChatCommandResult`）。
        if (result.refill) {
          // 顺手记下"库里少了几轮"：收尾时要按库重画一次（见 `rewoundTurns`）
          rewoundTurns.current = true
          refillQuery(result.refill)
        }
        handleCommandAction(result)
      }
      try {
        if (sending) {
          // 这一轮还在跑（`/stop` 恰恰只在这个窗口里有意义）：走直连那条路，
          // 不接管常驻链路（那一格只放"当前这一轮"）
          await chatStream(payload, {
            onCommand,
            onError: (message) => notifyError(new Error(message)),
          })
        } else {
          await liveActions.startCommandTurn(
            payload,
            {
              conversationId: target,
              query: text,
              thinking: { enabled: thinkingOn, effort: thinkingEffort },
            },
            onCommand,
          )
        }
        void conversationsRefetch()
      } catch (cause) {
        notifyError(cause instanceof Error ? cause : new Error('命令没跑起来'))
      }
    },
    [
      commandsQuery.data,
      conversationsRefetch,
      queryClient,
      effectiveKbIds,
      handleCommandAction,
      history,
      refillQuery,
      sending,
      streamTurn,
      thinkingEffort,
      thinkingOn,
    ],
  )

  const canSend =
    (!useKb || selectedKbIds.length > 0) &&
    query.trim().length > 0 &&
    !detailQuery.isLoading &&
    !resolvingEntry

  const send = useCallback(async () => {
    const text = query.trim()
    if (text.length === 0) return
    // **命令在流式期间也放行**：`/stop` 存在的意义就是"这一轮还在跑的时候把它停下"。
    // 普通提问仍然不许插队（后端没有"往跑着的一轮里插话"这条路）
    const isCommand = text.startsWith('/')
    if (sending && !isCommand) {
      notifyWarning('这一轮还在跑：等它结束再发，或者用 /stop 停下')
      return
    }
    if (!isCommand && !canSend) return
    // 先算历史：这条提问还没进 messages，不能把自己也算成上下文
    const context = history
    const model = modelPk || undefined

    // 新对话：第一句话落下去之前先建会话，拿到 id 再提问。
    // 反过来（先问再建）会丢掉这一轮的落库
    let target = conversationId
    /** 这一轮发出去查哪些库；新建那条路上可能被项目继承来的那份替掉（见下）。 */
    let kbIds = effectiveKbIds
    if (!target) {
      try {
        /**
         * **从项目入口进来时（`?workspace=`）故意传空库列表**：让后端按工作区绑定的库
         * 继承（`api/v1/conversations.py` 里那条）——"项目绑的库是这个项目里新会话的
         * 默认库"落到行为上就是这一行，与工作区页那颗「在这个工作区新开会话」逐字同一条。
         *
         * **不带项目的入口维持原样**（传输入框里选的那几个）：会话记下这一次的选择，
         * 下次打开按 `detail.kb_ids` 回填。两边合起来是一句实话——**从哪儿进来决定
         * 默认范围**：项目里进来就是项目的库，直接新建就是你在输入框里选的那些。
         */
        const created = await createConversation(
          pendingWorkspaceId ? [] : effectiveKbIds,
          modelPk || null,
          {
            thinking: thinkingOn,
            thinking_effort: thinkingEffort,
          },
          pendingWorkspaceId || null,
        )
        target = created.id
        /**
         * 继承来的库**当场**就是这一轮的库范围，同时把输入框的选择也改成它们。
         *
         * 不这么做的话，第一轮查的是"输入框里原来的那些"（默认是全部），而输入框
         * 随后按详情回填成项目绑的那几个——同一轮里"看到的范围"和"实际查的范围"对不上，
         * 用户会觉得范围自己变过。
         *
         * `useKb` 关着时不动：那颗「启用」开关是用户**明确表过态**的（"这一轮不查库"），
         * 项目的默认库不该越过它。
         */
        const inherited = created.kb_ids.filter((id) => kbs.some((item) => item.id === id))
        if (pendingWorkspaceId && useKb && inherited.length > 0) {
          kbIds = inherited
          setSelectedKbIds(inherited)
        }
        void navigate(`/chat/${target}`, { replace: true })
      } catch (cause) {
        notifyError(cause)
        return
      }
    }

    setQueryState('')
    if (text.startsWith('/')) {
      await runCommand(text, target, model, kbIds)
      return
    }
    await streamTurn(text, context, model, target, kbIds)
  }, [
    canSend,
    conversationId,
    effectiveKbIds,
    history,
    kbs,
    modelPk,
    navigate,
    pendingWorkspaceId,
    query,
    runCommand,
    sending,
    streamTurn,
    thinkingEffort,
    thinkingOn,
    useKb,
  ])

  /**
   * 用户点了「停止」。
   *
   * 两件事，各有各的必要：
   * 1. **本页不再等它**（`abortLiveTurn`）：已经流出来的正文与过程留着，它仍然有用；
   * 2. **让后端也停下**（`/stop` 命令）：这一轮在后端是后台任务，断开订阅不会取消它。
   *    清单还没到手时不发——后端没有命令这一层的话，它会被当成一句普通提问发给模型。
   */
  const commandsRef = commandsQuery.data
  const stop = useCallback(() => {
    const target = conversationId
    liveActions.abortLiveTurn()
    if (target && (commandsRef?.length ?? 0) > 0) {
      void chatStream(
        { query: '/stop', kb_ids: [], conversation_id: target },
        {
          onCommand: (result) => handleCommandAction(result),
          onError: (message) => notifyError(new Error(message)),
        },
      ).catch(() => undefined)
    }
  }, [commandsRef, conversationId, handleCommandAction])

  // ---------------------------------------------------------------- 过程面板与消息动作

  const traceOpen = useCallback(
    (message: Message) => {
      const own = traceOpenIds[idOf(message)]
      if (own !== undefined) return own
      return traceOpenMemory ?? true
    },
    [traceOpenIds, traceOpenMemory],
  )

  const toggleTrace = useCallback(
    (message: Message) => {
      const next = !traceOpen(message)
      setTraceOpenIds((prev) => ({ ...prev, [idOf(message)]: next }))
      // **收起态可记忆**：点这一下的意思不只是"这一轮收起来"，还有"以后别默认摊开"
      setTraceOpenMemory(next)
      writeTraceOpenMemory(next)
    },
    [traceOpen],
  )

  const traceView = useCallback(
    (turnIndex: number, turn: Turn): TracePage => {
      const pages = 1 + (traceExtraPages.get(turnIndex) ?? 0)
      return tracePage(turn, TRACE_PAGE_SIZE * pages)
    },
    [traceExtraPages],
  )

  const copyMessage = useCallback(async (turnIndex: number, message: Message) => {
    const key = `${turnIndex}:${message.role}`
    // 复制的是**原文**（Markdown 源文本）而不是渲染后的文字：带 `**` 与 `[1]` 的原文
    // 在其它 Markdown 环境里仍然成立
    if (await copyText(message.text)) {
      setCopiedKey(key)
      window.setTimeout(() => setCopiedKey((current) => (current === key ? '' : current)), 1600)
      return
    }
    notifyError(new Error('复制失败，请手动选中后复制'))
  }, [])

  const saveAsNote = useCallback(
    async (turnIndex: number, turn: Turn) => {
      const question = (turn.user?.text ?? '').trim()
      const answer = (turn.reply?.text ?? '').trim()
      if (!answer) {
        notifyWarning('这条回答还没有内容')
        return
      }
      try {
        await createNote({
          title: question.slice(0, 80) || '来自对话的笔记',
          // 正文只放回答：提问已经在标题里了
          content_md: answer,
          source_kind: 'chat',
          source_ref: conversationId || null,
        })
        setSavedTurns((prev) => (prev.includes(turnIndex) ? prev : [...prev, turnIndex]))
        notifySuccess('已存为笔记，可在侧栏「笔记」里查看')
      } catch (cause) {
        notifyError(cause)
      }
    },
    [conversationId],
  )

  /**
   * 重新生成最后一条回答：先把会话退回到提问之前（后端删掉那一轮），再原样重发。
   * 回退是**服务端已删、本地才跟上**的顺序（反过来在接口失败时会错位）。
   */
  const regenerate = useCallback(
    async (turnIndex: number) => {
      const turn = turns[turnIndex]
      const id = conversationId
      if (!turn?.user || !id || regenerating || sending) return
      const text = turn.user.text
      const context = history
      const model = modelPk || undefined
      setRegenerating(true)
      try {
        await rewindConversation(id, 1)
        setMessages((prev) => prev.slice(0, turnIndex * 2))
        await streamTurn(text, context, model, id)
      } catch (cause) {
        notifyError(cause)
        void detailRefetch()
      } finally {
        setRegenerating(false)
      }
    },
    [conversationId, detailRefetch, history, modelPk, regenerating, sending, streamTurn, turns],
  )

  /**
   * **继续**上一轮：接着把没做完的那一轮做完，而不是重发一遍。
   *
   * 与「重新生成」的区别：续跑把已经查到的资料、已经写了一半的正文交给模型接着用
   * （那是真花钱的东西），用户看到的是**同一轮被补完**。
   */
  const resumeTurn = useCallback(
    async (turnIndex: number) => {
      const turn = turns[turnIndex]
      const id = conversationId
      const reply = turn?.reply
      if (!reply || !id || resuming || sending || regenerating) return
      // 端点续的是**最后一轮**：不是最后一轮就不该有这个按钮
      if (turnIndex !== turns.length - 1) return
      setResuming(true)
      const replyId = idOf(reply)
      setMessages((prev) =>
        prev.map((item) =>
          item.id === replyId ? { ...item, text: '', error: '', streaming: true } : item,
        ),
      )
      try {
        await liveActions.startResumeTurn(
          id,
          { skill_names: pinnedSkills },
          { thinking: { enabled: thinkingOn, effort: thinkingEffort } },
        )
      } finally {
        setResuming(false)
      }
    },
    [
      conversationId,
      pinnedSkills,
      regenerating,
      resuming,
      sending,
      thinkingEffort,
      thinkingOn,
      turns,
    ],
  )

  /**
   * **重发失败的那一轮**（第四批评审 B①）。
   *
   * 与「重新生成」的区别只有一处，但那一处要紧：**不回退会话**。
   * `rewindConversation` 删的是**库里最后那一轮**，而失败的一轮从来没落过库
   * ——后端在整轮跑完时才把提问与回答一次写进会话（`services/conversation.py` 的
   * `_write_turn`，失败那条路只记事件日志）。照着 `regenerate` 删一轮，
   * 删掉的就是**上一轮那条好好的回答**，用户会以为重试把好东西弄丢了。
   * 所以这里只在画面上撤掉这一对（它本来也只存在于这一页），再原样发一次。
   *
   * 上下文取**这一轮之前**的那一段：失败这一轮的提问马上会被重发一遍，
   * 而 `history` 留着所有提问（失败那条提问也在里面），带上它模型会看到同一个问题两次。
   */
  const retryTurn = useCallback(
    async (turnIndex: number) => {
      const turn = turns[turnIndex]
      const id = conversationId
      if (!turn?.user || !id || sending || regenerating) return
      const text = turn.user.text
      const context = historyOf(messages.slice(0, turnIndex * 2))
      const model = modelPk || undefined
      setMessages((prev) => prev.slice(0, turnIndex * 2))
      await streamTurn(text, context, model, id)
    },
    [conversationId, messages, modelPk, regenerating, sending, streamTurn, turns],
  )

  /** 点行内引用徽标：展开过程面板 → 滚到那一条出处 → 闪一下（三步缺一不可）。 */
  const revealSource = useCallback((turnIndex: number, sourceIndex: number) => {
    setExpandedCites((prev) => {
      const next = new Set(prev)
      next.add(turnIndex)
      return next
    })
    setFlashCite(`${turnIndex}:${sourceIndex}`)
    window.setTimeout(() => {
      const node = document.querySelector(
        `[data-turn="${turnIndex}"] [data-source="${sourceIndex}"]`,
      )
      node?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
    }, 0)
    window.setTimeout(
      () => setFlashCite((current) => (current === `${turnIndex}:${sourceIndex}` ? '' : current)),
      1400,
    )
  }, [])

  // ---------------------------------------------------------------- 输入区的那些开关

  const toggleSkill = useCallback((name: string) => {
    setPinnedSkills((prev) => {
      const next = prev.includes(name) ? prev.filter((item) => item !== name) : [...prev, name]
      writePinnedSkills(next)
      return next
    })
  }, [])

  const toggleKb = useCallback((kbId: string) => {
    setSelectedKbIds((prev) =>
      prev.includes(kbId) ? prev.filter((item) => item !== kbId) : [...prev, kbId],
    )
  }, [])

  /** 面板上的「全选」：范围 = 手上这份清单里的全部。 */
  const selectAllKbs = useCallback(() => {
    setSelectedKbIds(kbs.map((item) => item.id))
  }, [kbs])

  /**
   * 面板上的「清空」：**清的是选择，不是关开关**。
   *
   * 两件事看着像，结果差很远：清空之后"这一轮一个库都不查"由 `canSend` 拦住
   * （开着且一个都没选 → 不许发），用户看得出自己把范围清没了；
   * 若这里顺手把开关也关掉，用户会以为"我只是清了一下"，而其实连"要不要查库"
   * 那个更硬的决定都被改了。
   */
  const clearKbs = useCallback(() => {
    setSelectedKbIds([])
  }, [])

  /**
   * 打开/关掉「启用」。**这一颗是"我平时怎么用"**（写进本机偏好，见 `KB_SWITCH_KEY`），
   * 与「选了哪几个」分开存：关掉时**不清空选择**，下次打开还是原来那几个。
   */
  const setKbEnabled = useCallback((on: boolean) => {
    setUseKb(on)
    writeStored(KB_SWITCH_KEY, on ? '1' : '0')
  }, [])

  const kbsRefetch = kbsQuery.refetch

  /**
   * 附件上传：附件在 KYLAB 里就是**知识库文档**（没有"只挂在这一轮消息上"的附件），
   * 所以必须有一个落点：优先用当前勾选的第一个库；一个都没有时**明确拒绝并说明**。
   */
  const uploadFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return
      const targetId = useKb ? (selectedKbIds[0] ?? kbs[0]?.id) : undefined
      if (!targetId) {
        notifyWarning(
          useKb
            ? '先在「知识库」里选一个库，文件才有地方放'
            : '在「知识库」里打开「启用」后再传文件',
        )
        return
      }
      const name = kbs.find((item) => item.id === targetId)?.name ?? ''
      setUploading(true)
      void (async () => {
        try {
          for (const file of files) await uploadDocument(targetId, file)
          // 只报结果。原来还缀着"入库后就能被引用"——那是入库这条链路的后果说明，
          // 不属于"这一下做成了没有"（2026-09-24 用户要求清掉这一类解释）
          notifySuccess(`已把 ${formatCount(files.length)} 个文件传给「${name}」`)
          void kbsRefetch()
        } catch (cause) {
          notifyError(cause)
        } finally {
          setUploading(false)
        }
      })()
    },
    [kbs, kbsRefetch, selectedKbIds, useKb],
  )

  // —— `@` 提及：候选来自知识库 + 这条会话的文件区 + 技能 + 会话列表

  const mentionItems = useMemo<MentionItem[]>(
    () => [
      /**
       * **知识库**（与另外三类做的事不一样，见 `MentionItem` 与 `applyMention`）：
       * 点一下是"把这个库并进这一轮的检索范围"，不插文本。所以 `value` 放**库 id**
       * ——它只用来认是哪一份（同名库不会串），`label` 才是给人看的名字。
       *
       * 候选直接来自同一层已经取过的 `kbs`（输入框那颗「知识库」胶囊读的也是它），
       * 不为这个菜单多起一次请求。
       */
      ...kbs.map((kb) => ({
        kind: 'knowledge' as const,
        value: kb.id,
        label: kb.name,
        detail:
          useKb && selectedKbIds.includes(kb.id)
            ? '已在检索范围'
            : `${formatCount(kb.document_count)} 篇文档`,
      })),
      ...(filesQuery.data?.entries ?? []).map((file) => ({
        kind: 'file' as const,
        // **引用的是它在文件区里的 key（路径）**，不是显示用的短名字
        value: file.key,
        label: file.name,
        detail: file.is_dir ? '目录' : formatBytes(file.size_bytes),
        isDir: file.is_dir,
      })),
      ...skills.map((skill) => ({
        kind: 'skill' as const,
        value: skill.name,
        label: skill.name,
        detail: skill.summary || skill.description,
      })),
      ...(conversationsQuery.data ?? []).map((item) => ({
        kind: 'session' as const,
        value: item.title,
        label: item.title,
        detail: '会话',
      })),
    ],
    [conversationsQuery.data, filesQuery.data, kbs, selectedKbIds, skills, useKb],
  )

  const loadMentions = useCallback(() => {
    setWantSkills(true)
    setWantConvFiles(true)
  }, [])

  /** 打 `/` 的那一刻就把清单取回来（之后每次打开是内存里的）。 */
  const loadCommands = useCallback(() => setWantCommands(true), [])

  /**
   * 一条引用在输入框里的写法（照 DSH 的 grammar）：**带空白的值用双引号包起来**——
   * 不加引号的路径在模型那边会被当成两段，而用户看到的是一个名字里有空格的普通文件。
   */
  const mentionToken = useCallback(
    (value: string) => (/\s/.test(value) ? `@${JSON.stringify(value)}` : `@${value}`),
    [],
  )

  /**
   * `@` 里点了一个知识库：**并进检索范围**（不插文本）。
   *
   * 三条口径，都是为了让"点完会发生什么"一眼可推：
   *
   * 1. **只增不减、持久**：并进去的留在 `selectedKbIds` 里，发送之后不清空——
   *    它与输入框上那颗「知识库」胶囊**同一份状态**（合并之后只有这一处状态，
   *    所以面板里勾的、胶囊上写的、`@` 并进去的三者天然一致）。多造一个"本轮有效"的
   *    临时层就要多一套"什么时候还回去"的规则，而用户看到的那颗胶囊会自己变回去
   *    （正是"怎么又变回去了"那类困惑）。要取消就在那颗胶囊里逐个点掉、或点「清空」。
   * 2. **开关关着时顺手打开**：不打开的话点这一下什么都不会发生（范围按空算），
   *    那是这里最坏的结果——用户以为选上了，实际没查。提示里明说这一点。
   * 3. **已经在范围里就说一句"已经在"**，不重复并入（也不谎报"已加入"）。
   */
  const pickKnowledge = useCallback(
    (kbId: string) => {
      const kb = kbs.find((item) => item.id === kbId)
      if (!kb) return
      if (useKb && selectedKbIds.includes(kbId)) {
        notifyWarning(`「${kb.name}」已经在检索范围里了`)
        return
      }
      const turnedOn = !useKb
      setSelectedKbIds((prev) => (prev.includes(kbId) ? prev : [...prev, kbId]))
      if (turnedOn) setKbEnabled(true)
      notifySuccess(
        turnedOn
          ? `已把「${kb.name}」并入检索范围，并打开了「知识库」开关`
          : `已把「${kb.name}」并入检索范围（在输入框的「知识库」里可以取消）`,
      )
    },
    [kbs, selectedKbIds, setKbEnabled, useKb],
  )

  /**
   * 选中一条候选。
   *
   * **文件 / 技能 / 会话**：只把引用插进输入框（"不预读"那一半）。
   *
   * 读什么、读哪一段由模型决定（它手上有 `read_file` / `read_skill` / 会话工具）——
   * 界面在这里替它读一遍，用户既看不见自己付了多少上下文，也拿不回"我只要它看结论"这个选择。
   *
   * **知识库**：点一下 = 并进检索范围，不插文本（见 `pickKnowledge`）。理由有两条：
   * `@库名` 会与同名的文件 / 会话撞在一起（三类都按名字认），而那件事**有地方看得见、
   * 也能取消**（输入框那颗「知识库」胶囊），所以让范围那条状态来表达它比留一段文本更准。
   * 顺手把还在打的 `@过滤词` 收掉：那一段不是内容（是搜索词），留着就会发给模型，
   * 而且收掉之后菜单自然合上（`Composer` 的判据是"最后一个 `@` 之后还有没有字"）。
   */
  const applyMention = useCallback(
    (item: MentionItem) => {
      if (item.kind === 'knowledge') {
        pickKnowledge(item.value)
        // 走 `setQuery`（输入框那个唯一入口）而不是 `setQueryState`：这一步是**替用户
        // 改输入内容**，与敲键盘是同一件事，`/` 那几档状态该跟着一起算。
        const at = query.lastIndexOf('@')
        if (at >= 0) setQuery(query.slice(0, at))
        return
      }
      setQueryState((current) => {
        const at = current.lastIndexOf('@')
        if (at < 0) return current
        return `${current.slice(0, at)}${mentionToken(item.value)} `
      })
    },
    [mentionToken, pickKnowledge, query, setQuery],
  )

  /** 拖拽那条路进来的引用：接在**现有内容后面**（拖进来时没有 `@` 可以替换）。 */
  const insertReference = useCallback(
    (value: string) => {
      setQueryState((current) => {
        const glue = current.length > 0 && !/\s$/.test(current) ? ' ' : ''
        return `${current}${glue}${mentionToken(value)} `
      })
    },
    [mentionToken],
  )

  /**
   * 选中一条命令：**能补完就补完，补不了就执行**。
   *
   * - 还要参数的（`/mode `、`/skill <技能名>`）：把 `/名字 ` 插进输入框，光标留给参数；
   * - 不要参数的（`/help`、`/new`）：输入框里已经是这条命令了，于是**再按一次回车就是执行**
   *   ——遇到"没有变化"时直接发送，避免"按了回车什么都没发生"。
   */
  const applyCommand = useCallback(
    (command: ChatCommand) => {
      const needsArgs =
        Boolean(command.argument_hint) || command.usage.trim() !== `/${command.name}`
      const text = needsArgs ? `/${command.name} ` : `/${command.name}`
      if (query.trim() === text.trim()) {
        void send()
        return
      }
      setQueryState(text)
    },
    [query, send],
  )

  const compressContext = useCallback(() => {
    const target = conversationId
    if (!target) {
      notifyWarning('这条会话还没建起来，没有可压缩的上下文')
      return
    }
    void runCommand('/compact', target, modelPk || undefined).then(() => usageQuery.refetch())
  }, [conversationId, modelPk, runCommand, usageQuery])

  // ---------------------------------------------------------------- 欢迎层的示例问题

  const suggestions = useMemo(() => {
    // `splitSuggestions` 只为排版服务：模型偶尔把两条问题写成一行（中间一个全角空格），
    // 后端按行取，于是那一行就是"一条"——拆开是为了让每条占一行，一个字都不改它。
    // （`片段N` 那种前缀属于**模型写下的内容**，这一层不动，理由见 `model/suggestions.ts`）
    const generated = splitSuggestions(suggestedQuery.data?.questions ?? [])
    if (generated.length > 0) return generated.slice(0, SAMPLE_COUNT)
    return Array.from(
      { length: Math.min(SAMPLE_COUNT, STATIC_SAMPLES.length) },
      (_, index) => STATIC_SAMPLES[(sampleOffset + index) % STATIC_SAMPLES.length],
    )
  }, [sampleOffset, suggestedQuery.data])

  /** 点示例问题：填进输入框；能发就直接发——这一步本来就是"照着问"。 */
  const useSample = useCallback(
    (question: string) => {
      setQueryState(question)
      if (canSend && !sending) {
        // 用刚填进去的那一句发（state 还没生效，不能走 `send`）
        void (async () => {
          const target = conversationId
          if (!target) return
          await streamTurn(question, history, modelPk || undefined, target)
        })()
      }
    },
    [canSend, conversationId, history, modelPk, sending, streamTurn],
  )

  const shuffleSuggestions = useCallback(() => {
    if ((suggestedQuery.data?.questions.length ?? 0) > 0) {
      void suggestedQuery.refetch()
      return
    }
    setSampleOffset((prev) => (prev + SAMPLE_COUNT) % STATIC_SAMPLES.length)
  }, [suggestedQuery])

  // ---------------------------------------------------------------- 交付物

  const kbName = useCallback(
    (kbId?: string) => kbs.find((item) => item.id === kbId)?.name ?? '',
    [kbs],
  )

  const openIngest = useCallback(
    (file: ChatArtifact) => {
      setIngestTarget(file)
      // 预选不等于替他决定：弹窗在那儿、库名看得见，他点了确认才算数
      setIngestKbId(file.knowledge_base_id || effectiveKbIds[0] || kbs[0]?.id || '')
      void kbsRefetch()
    },
    [effectiveKbIds, kbs, kbsRefetch],
  )

  const confirmIngest = useCallback(async () => {
    const file = ingestTarget
    const id = conversationId
    if (!file || !id || !ingestKbId) return
    setIngesting(true)
    try {
      const updated = await ingestArtifact(id, file.artifact_id, ingestKbId)
      const patch = fromStored(updated)
      setMessages((prev) =>
        prev.map((message) => ({
          ...message,
          steps: message.steps.map((step) =>
            step.artifacts
              ? {
                  ...step,
                  artifacts: step.artifacts.map((item) =>
                    item.artifact_id === patch.artifact_id ? { ...item, ...patch } : item,
                  ),
                }
              : step,
          ),
        })),
      )
      setIngestTarget(null)
      notifySuccess(`已存进知识库「${kbName(updated.knowledge_base_id ?? '')}」`)
    } catch (cause) {
      notifyError(cause)
    } finally {
      setIngesting(false)
    }
  }, [conversationId, ingestKbId, ingestTarget, kbName])

  const api: ChatApi = {
    conversationId,
    messages,
    turns,
    pendingEntry,
    welcome: messages.length === 0 && !pendingEntry,
    pendingWorkspace,
    sending,
    pendingApproval,
    dismissApproval: () => liveActions.settleLiveApproval(),
    commandResult,
    dismissCommandResult: () => setCommandResult(null),
    commandRefill,
    query,
    setQuery,
    canSend,
    send: () => void send(),
    stop,
    kbs,
    kbLoading: kbsQuery.isLoading,
    useKb,
    setKbEnabled,
    selectedKbIds,
    toggleKb,
    selectAllKbs,
    clearKbs,
    kbPickText: pickText(useKb, kbsQuery.isLoading, kbs.length, selectedKbIds.length),
    pinnedSkills,
    toggleSkill,
    skills,
    skillsLoading: skillsQuery.isLoading,
    uploadFiles,
    uploading,
    models,
    modelOptions: models.map((model) => ({
      value: model.id,
      label: model.label || model.model_id,
    })),
    modelPk,
    setModelPk,
    // **加载中与"没配置"必须分开说**：注册表回来之前显示"未配置对话模型"会闪一下一个并不成立的状态
    modelPlaceholder: !registry ? '默认模型' : models.length === 0 ? '未配置对话模型' : '默认模型',
    modelsLoaded: Boolean(registry),
    thinkingOn,
    setThinkingOn,
    thinkingEffort,
    setThinkingEffort,
    commands,
    loadCommands,
    commandsLoading: commandsQuery.isLoading,
    applyCommand,
    mentionItems,
    mentionLoading: wantConvFiles && filesQuery.isLoading,
    loadMentions,
    applyMention,
    insertReference,
    mentionToken,
    contextUsage: usageQuery,
    compressContext,
    suggestions,
    suggestionsLoading: suggestedQuery.isFetching,
    // 没有选中知识库时**整块不显示**：推荐问题是"从库里的语料出题"抽出来的，
    // 没有库就没有依据——那时给一排样例是在暗示"随便点一个"，点了也答不出东西
    showSuggestions: effectiveKbIds.length > 0,
    shuffleSuggestions,
    useSample,
    traceOpen,
    toggleTrace,
    traceView,
    showMoreTrace: (turnIndex) =>
      setTraceExtraPages((prev) => {
        const next = new Map(prev)
        next.set(turnIndex, (next.get(turnIndex) ?? 0) + 1)
        return next
      }),
    isStepOpen: (key) => openSteps.has(key),
    toggleStep: (key) =>
      setOpenSteps((prev) => {
        const next = new Set(prev)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      }),
    isGroupOpen: (key) => openGroups.has(key),
    toggleGroup: (key) =>
      setOpenGroups((prev) => {
        const next = new Set(prev)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      }),
    citesExpanded: (turnIndex) => expandedCites.has(turnIndex),
    toggleCites: (turnIndex) =>
      setExpandedCites((prev) => {
        const next = new Set(prev)
        if (next.has(turnIndex)) next.delete(turnIndex)
        else next.add(turnIndex)
        return next
      }),
    flashCite,
    revealSource,
    copiedKey,
    copyMessage: (turnIndex, message) => void copyMessage(turnIndex, message),
    savedTurns,
    saveAsNote: (turnIndex, turn) => void saveAsNote(turnIndex, turn),
    regenerating,
    regenerate: (turnIndex) => void regenerate(turnIndex),
    retryTurn: (turnIndex) => void retryTurn(turnIndex),
    resuming,
    resumeTurn: (turnIndex) => void resumeTurn(turnIndex),
    sourceOpen,
    activeSource,
    openSource: (source) => {
      setActiveSource(source)
      setSourceOpen(true)
    },
    closeSource: () => setSourceOpen(false),
    filesOpen,
    filesSeed,
    openFiles: (seed = null) => {
      setFilesSeed(seed)
      setFilesOpen(true)
    },
    closeFiles: () => setFilesOpen(false),
    ingestTarget,
    ingestKbId,
    setIngestKbId,
    openIngest,
    closeIngest: () => setIngestTarget(null),
    confirmIngest: () => void confirmIngest(),
    ingesting,
    kbName,
    dropKind,
    setDropKind,
  }

  return <ChatContext.Provider value={api}>{children}</ChatContext.Provider>
}
