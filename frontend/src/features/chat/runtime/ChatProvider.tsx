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
  type ChatAttachment,
  type ChatCommand,
  type ChatCommandResult,
  type ChatHistoryMessage,
  type ChatSource,
  type ChatStep,
  type ThinkingEffort,
} from '@/api/chat'
import {
  createConversation,
  getConversation,
  ingestArtifact,
  listArtifacts,
  rewindConversation,
  type ConversationArtifact,
  type ConversationDetail,
} from '@/api/conversations'
import { uploadFile } from '@/api/conversations'
import type { KnowledgeBase } from '@/api/knowledgeBases'
import { createNote } from '@/api/notes'
import type { RegisteredModel } from '@/api/modelRegistry'
import { copyText } from '@/lib/clipboard'
import { formatBytes, formatCount } from '@/lib/format'

import {
  buildTurns,
  isTraceOpen,
  makeMessage,
  traceForceExpanded,
  tracePage,
  TRACE_PAGE_SIZE,
  type Message,
  type TraceOpen,
  type TracePage,
  type Turn,
} from '@/features/chat/model/turns'
import { splitSuggestions } from '@/features/chat/model/suggestions'

// 侧栏那份会话清单（壳那一层）：新会话建出来之后要**当场**插进去。
// 不做这一步的话，侧栏只在挂载时 `load()` 过一次，谁也告诉不了它清单变长了——
// 于是新会话要刷新页面才出现（用户报的那条）。
import { useConversationStore } from '@/features/layout/conversations'
// 项目清单（壳那一层）：`?workspace=` 那条新建链路要说清"这一条会落在哪个项目"。
// 侧栏是发起方，这份清单通常已经在手上（`ensureWorkspacesLoaded` 那一下就是补这个）。
import { ensureWorkspacesLoaded, useWorkspaceStore } from '@/features/layout/workspaces'
// 单文件上限（D21）：对话上传这条路上原先一处预校验都没有，而知识库那边早就有——
// 那个模块存在的理由正是"别到处各写一个 200"，所以这里引它、不再抄一份数字。
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_MB } from '@/features/knowledge/uploadLimits'

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

/**
 * 发送前**暂存在输入框里**的一份附件（v0.55）。
 *
 * 为什么不再"选完立刻上传"：用户报的"上传文件得效果不合理……文件和图片应该通过缩略图
 * 的形式保留在对话框（agent 产品都是这么做的），而你是直接发送，然后上传到工作区"。
 * 落点是**发送那一刻**（`send` 里，建完会话之后逐份上传），在那之前它只是输入框里
 * 的一张缩略图 / 一个文件片。
 *
 * 顺带解掉另一条反馈（"新项目上传文件甚至需要先对话一次"）：暂存不需要会话 id，
 * 而建会话发生在发送那一步、比上传更早——那道"先聊一句才能传文件"的限制自然没有了。
 */
export interface StagedAttachment {
  id: string
  file: File
  /** 图片用 `URL.createObjectURL` 出来的**本地**预览；非图片（或环境不支持）为空串。 */
  preview: string
}

let attachmentSeq = 0

/**
 * 图片附件的**本地预览地址**（`blob:`），非图片给空串。
 *
 * 两处保守，都是实测踩出来的：
 * - 环境里没有 `URL.createObjectURL`（老浏览器、某些测试环境）→ 空串，界面退回文件片；
 * - 有它但**调用会抛**（jsdom / vitest 的桩在遇到非 Node `Blob` 时报
 *   `Cannot read properties of undefined (reading '_buffer')`）→ 同样退回空串。
 * 预览只是锦上添花，不该因为它让"加一份附件"整个失败。
 */
function imagePreview(file: File): string {
  if (!file.type.startsWith('image/')) return ''
  try {
    return typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : ''
  } catch {
    return ''
  }
}

/** 释放一个预览地址（与 `imagePreview` 成对；同样容忍环境没有它或它只是会抛的桩）。 */
function releasePreview(url: string): void {
  if (!url) return
  try {
    URL.revokeObjectURL(url)
  } catch {
    // 没有东西要释放
  }
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
  /**
   * **发送前暂存在输入框里的附件**（v0.55）。
   *
   * 用户报的："文件和图片应该通过缩略图的形式保留在对话框（agent 产品都是这么做的），
   * 而你是直接发送，然后上传到工作区。" 所以它们现在只是界面上的缩略图 / 文件片，
   * **发送那一刻**才落到这条会话的文件区（见 `send`）。
   */
  attachments: StagedAttachment[]
  /** 把选中的 / 拖进来 / 粘进来的文件**暂存**到输入框（不再立刻上传）。 */
  addAttachments: (files: File[]) => void
  removeAttachment: (id: string) => void
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
  /** 这一轮的面板档位（`'collapsed' | 'full'`）：判定在 `turns.ts::isTraceOpen` 里。 */
  traceOpen: (message: Message) => TraceOpen
  toggleTrace: (message: Message) => void
  traceView: (turnIndex: number, turn: Turn) => TracePage
  showMoreTrace: (turnIndex: number) => void
  isStepOpen: (key: string) => boolean
  toggleStep: (key: string) => void
  /**
   * 用户对这一组的**选择**：`true` = 他开过 / `false` = 他收过 / `undefined` = 没碰过。
   *
   * 为什么不是 `isGroupOpen(key) => boolean`（P0 收尾批改的）：布尔那两档分不出
   * "他收过"与"他没碰过"，而组级默认档（还在跑就展开）只在**没碰过**时才该生效
   * ——见 §12.333 约束 1 与下面 `openGroups` 的说明。
   */
  groupOpenChoice: (key: string) => boolean | undefined
  /** 记下用户对某一组的选择（`open` = 他点完之后是开着还是收着）。 */
  chooseGroupOpen: (key: string, open: boolean) => void
  /**
   * **批量**把某一轮里的若干行设成同一档（「全部展开 / 全部收起」，调研 §5.2 P2）。
   *
   * 为什么一次把 key 给全、而不是在界面那一层逐个 `toggleStep` / `chooseGroupOpen`：
   * 那会写出 N 个中间态（React 会合批成一次渲染，但**记账**仍是 N 次"翻一下"），
   * 而这一下点击在语义上**是一件事**（用户原话要的是"一下摊开这一轮"）。
   *
   * 写的是**同一张表**（`openSteps` / `openGroups`）：所以"用户选过"那一档照旧记得住，
   * 收起面板再打开、换会话再回来还是他选的那一档（不另造一套记账）。
   *
   * 注意：调用方（`TracePanel`）**不许把强制展开的那些 key 递进来**：`awaiting` / `failed` /
   * `blocked` 是安全语义，优先级高于用户这一下点击（§12.333 约束 2）。
   */
  chooseStepsOpen: (keys: readonly string[], open: boolean) => void
  chooseGroupsOpen: (keys: readonly string[], open: boolean) => void
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
 * 四处"都要还原"：
 * - **过程与思考**（v0.25）：不然离开这一页再回来，只剩一句"已生成回答"；
 * - **库范围**：回放时沿用，否则多轮上下文会指向上一次没查的库；
 * - **模型与思考档**（v12/v16）：为空则保持当前默认；
 * - **随发的附件**（v0.55）：用户消息带着"当时传了哪几份"，不还原的话回看时那条提问
 *   就只剩文字了——用户报的正是"发送的对话里没有文件组件标识"。
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
      // 用户随发的附件（v0.55）：回看旧会话时也要画得出来；老消息没有这一项，给空数组
      attachments: item.attachments ?? [],
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
 * 接回来的那一轮**手里有没有能画的东西**（D10，2026-09-28 走查）。
 *
 * 原先 `recover` 只认正文（`state.text.length > 0`，理由是"有正文就等于这一轮还活着"）。
 * 但补发里**正文增量是不重放的**（见 `live_turns.LiveEmit` 的 `keep`：只留进缓冲的那几条），
 * 而步骤 / 出处 / 思考恰恰是重放的。于是刷新正好落在**工具阶段**（正文一个字还没出）时，
 * 界面在"步骤已经跑过好几步"的整段时间里一片空白：过程面板不在文档里、消息数是 0，
 * 那一轮看起来像没了（真浏览器实测：刷新后 **4.9 秒**里消息数一直是 0，等它终于出来时
 * 正文已经 52 个字了）。
 *
 * 判据换成"有任何一样"：这三样与正文是**同一批事件**补发来的，一样能证明这一轮还活着
 * （`adoptHandlers` 认的也是"第一条事件到了"）。
 */
function hasLiveContent(state: LiveTurnState): boolean {
  return (
    state.text.length > 0 ||
    state.steps.length > 0 ||
    state.sources.length > 0 ||
    state.thinkingText.length > 0
  )
}

/*
 * D10 **没做的那一半**：提问补不回来（这段是留给下一个动手的人看的）。
 *
 * 刷新之后这一轮还在跑时，提问在**任何一侧都拿不到**：库里要等这一轮落库才有
 * （`record_turn` 在收尾那一刻才写），直播流里也不带它（`step` / `thinking` /
 * `sources` / `delta` / `done` 里都没有 query）。所以画面上的这一段只有"回答 + 过程"，
 * 提问要等用户再进一次这条会话才回来。
 *
 * 收尾之后**倒是**可以从库里重读那份详情把它接回来（后端是先落库、后发 `done`），
 * 但那一下必然动到 `ui/ChatThread.tsx` 落底那一处认的两个键：重读会把整批消息换成
 * **新的 id**、把**提问条数 +1**——真浏览器实测（id 那一版判据）：在"接着一条刚收尾的
 * 轮次、用户正往上翻着读"的窗口里重读一次，`scrollTop` 被拽回 **2688px**（51 次写入），
 * 正是 D31 修掉的那条。改成"会话 id + 提问条数"之后 id 那一半不再受影响，**提问条数
 * 那一半照旧**会踩到。所以这一半**按兵不动**：等那条判据与"消息内容怎么变"彻底脱钩
 * （比如只认用户自己那一次发送）之后再补回来。
 */

/**
 * 把"正在流式的那一轮"**镜像**进本页的消息数组（旧 `ChatView.syncLive`，逐条照搬）。
 *
 * 规则四支：
 * - **`command`（一条斜杠命令）**：真有内容才补出"提问 + 回答"，而且只补一次——
 *   命令可能只是系统的回话（`/help`），那不该在对话流里留下气泡；
 * - **`append`（新起一轮）且画面上没有那一对**（用户离开期间流还在跑，回来时组件是新挂载的）
 *   → 用 live 里的提问与已经流出的字补出一对；
 * - **`recover`（刷新之后接回来的那一轮）**：只补回答那一条，而且**有内容就补**
 *   （见 `hasLiveContent`——工具阶段只有步骤/思考时也必须补，否则过程看不见）；
 *   提问随落库才有，这里补不出来（收尾之后能不能重读库里那份把它接回来，
 *   见这个文件里 `mirrorLive` 上方那段"D10 没做的那一半"的说明）；
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
    } else if (state.mode === 'recover' && hasLiveContent(state)) {
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

  /**
   * 刚建的那条会话（等它的标题生成出来，见下面那个 effect）。
   *
   * 用 ref 不用 state：它只在"这一轮结束后"被读一次，进 state 会让每次新建都多一次渲染，
   * 而它本身不参与任何渲染结果。
   */
  const createdConversationRef = useRef('')

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [query, setQueryState] = useState('')
  const [resolvingEntry, setResolvingEntry] = useState(false)
  const [uploading, setUploading] = useState(false)
  /** 发送前暂存的附件（v0.55）：只是输入框里的缩略图 / 文件片，发送那一刻才上传。 */
  const [attachments, setAttachments] = useState<StagedAttachment[]>([])
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

  /**
   * 过程面板的展开态：两张表分开（"看某一步的原文"与"看这一组有哪些调用"同时开着是正常的）。
   *
   * 单步这张是 `Set`（在表里 = 摊开），与组那张的 `Map` 形状不同，而这个不同是有理由的：
   * **单步没有自动档**（不像组那样"还在跑就展开"），默认就是折着——于是"不在表里"
   * 与"他收过"落在同一个画面上，不需要分出第二档；组必须分得清（见下面 `openGroups`）。
   *
   * 「全部展开 / 全部收起」（调研 §5.2 P2）写的就是**这张表**（`chooseStepsOpen`），
   * 不另记一笔：收起来之后换挂载、换会话回来看见的还是它。
   */
  const [openSteps, setOpenSteps] = useState<ReadonlySet<string>>(new Set())
  /**
   * 组的开合那张表的键：**会话 id + 组 key**（见下面 `openGroups` 的说明）。
   *
   * 组 key（`turns.traceKey`）只保证**同一轮内**唯一，而那张表跨会话活着——
   * 不带会话前缀的话，A 会话里收起的那一组会让 B 会话里同 key 的组也一上来就折着。
   */
  const groupScopeKey = (key: string): string => `${conversationId}|${key}`

  /**
   * 组的开合：**用户选过什么**（`true` = 他开过 / `false` = 他收过 / 不在表里 = 没碰过）。
   *
   * 为什么不是"翻转型 Set"（P0 收尾批改的就是它）：Set 只记得"开过"，记不了"他收过"。
   * 而 §12.333 约束 1 要的是"**用户手动开合过就完全听他的**"——组级默认档是
   * "还在跑就展开"，于是他收起一个正在跑的组时，那一下没有地方记：收起面板再打开、
   * 或换会话再回来，又按默认档弹开，用户那一口等于白点。
   *
   * **键上带会话 id**（`groupScopeKey`）：这张表跨会话活着（换会话那一处不清它，
   * 好让"回来还是他选的那一档"成立），而组 key 只保证**同一轮内**唯一——
   * 不带会话前缀的话，A 会话里收起的那一组会让 B 会话里 key 相同的组也一上来就折着
   * （与 `traceKey` 修的跨轮串号是同一类 bug）。默认档只在**没碰过**时生效。
   *
   * **forced（在等确认 / 没做成）仍然压过用户**这一档（三层优先级见 `TracePanel`）。
   * 只活在这一次会话的内存里（不做本机记忆）：它记的是"他点过这一组没有"，
   * 与单步那张表（`openSteps`）同一档——面板级原先那份"手动开过没有"的本机记忆
   * 已按用户要求整档删掉（见 `traceOpen`），别把这张表也当成那种东西。
   */
  const [openGroups, setOpenGroups] = useState<ReadonlyMap<string, boolean>>(new Map())
  const [traceExtraPages, setTraceExtraPages] = useState<ReadonlyMap<number, number>>(new Map())
  const [expandedCites, setExpandedCites] = useState<ReadonlySet<number>>(new Set())
  /**
   * 某一轮自己的展开档（用户点过就按点的那一档；`undefined` = 没点过，问自动规则）。
   *
   * 从布尔改成 `'collapsed' | 'full'`（P0）：这一档要能与"自动折出来的收起"分开说，
   * 见 `turns.ts::isTraceOpen`。**就这一位**——跨轮次的本机豁免删掉之后，
   * "手动干预"只在这里留痕（用户 2026-09-29："那个记忆可以不要"）。
   */
  const [traceOpenIds, setTraceOpenIds] = useState<Record<string, TraceOpen>>({})

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
   * 新建会话要动的那两份壳状态：侧栏那份会话清单要**多一行**，
   * 项目行上的条数是**另一个 store 里的数**，要**加一**（同一个事实不能只改一半）。
   */
  const upsertConversation = useConversationStore((state) => state.upsert)
  const refreshWorkspaceCounts = useWorkspaceStore((state) => state.refreshCounts)

  /**
   * 把某一条会话的摘要重新读一遍并**就地替换那一行**（v0.54）。
   *
   * 为什么是"读一条"而不是 `load()` 整份清单：这时变的只是标题，整份重拉的代价与闪烁
   * 都白付（这条纪律写在 `conversations.ts` 的 `upsert` 上）。而 `ConversationDetail
   * extends ConversationSummary`——详情那一份**就是**摘要，所以不必另发列表请求，
   * 也不必自己拼字段（拼出来的那一份迟早与列表接口分叉）。
   */
  const refreshConversationSummary = useCallback(
    async (id: string) => {
      try {
        upsertConversation(await getConversation(id))
      } catch {
        // 补标题失败不该打扰用户：那一行还在（只是暂时还叫「未命名对话」），
        // 下次进对话页或刷新页面会自动校正。
      }
    },
    [upsertConversation],
  )

  /**
   * 刚建的那条会话，**等这一轮跑完再把标题补上**（v0.54）。
   *
   * 时序是后端定的：`POST /conversations` 建出来的记录标题是空的，标题要等第一句提问
   * 落下才生成——所以"建完当场 upsert"只能得到一行「未命名对话」。用户报的现象正是
   * "新建对话之后左下方的列表里没有出现新的对话名"，只补一行空标题等于半个修复。
   *
   * 判据取 `live.streaming`：它是"这一轮还在跑"的唯一信号（跑完、出错、被停止都会落回
   * `false`），而那时标题已经在库里了。**只补一次**（取完就清掉 ref），
   * 否则之后每一轮结束都会为同一件事再发一次请求。
   */
  useEffect(() => {
    const pending = createdConversationRef.current
    if (!pending || live?.streaming) return
    createdConversationRef.current = ''
    void refreshConversationSummary(pending)
  }, [live?.streaming, refreshConversationSummary])

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
   * 从「新建态」（`/chat?new=1`）刚建出来的那条会话 id（v0.55）。
   *
   * 用户在新建页发出第一条消息时，`send` 会先建会话、再把地址换成 `/chat/<新id>`。
   * 那一下**不是"换一条会话"**——消息是同一个逻辑会话里刚写上的，而下面两个 effect
   * 会把它当成"切走再切回来"处理：一个清空 `messages`，一个拿**还没落库的空详情**
   * 覆盖它。两边各擦一次再画回来，用户看到的就是"发完闪一下，然后我发的那条才出现"
   * （他报的正是这条）。这个 ref 就是让这两道闸认出新会话是"新建态的延续"：
   * 建会话那一刻写上，等"换会话"那个 effect 消费掉就清空。
   */
  const createdEntryRef = useRef('')
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

  /**
   * 换会话：清掉页面上一切"属于上一条"的东西。
   *
   * **这个 effect 必须声明在"应用详情"那个之前**（2026-09-27 修的 bug）：
   * 返回一条**看过的**会话时，详情命中 React Query 的缓存、在切换那一轮就到位了——
   * 两个 effect 在同一轮里按声明顺序跑，"先清后画"才是对的；反过来会把刚画上的
   * 内容当场擦掉，屏幕上就成了"标题换了、内容还是新对话页"（用户报的那个）。
   *
   * 同时**复位 `appliedDetail`**：那道闸是"这一条会话的详情只画一次"，
   * 换会话就得重新上膛，否则再回到同一条会话时会被它挡住、一个字都不画。
   */
  useEffect(() => {
    // 从「新建态」落到**刚建出来的那条**：不算换会话（v0.55，见 `createdEntryRef`）。
    // 放它过去，`messages` 就不会被清一下再画回来——用户报的那一下闪烁正是这里。
    if (createdEntryRef.current && createdEntryRef.current === conversationId) {
      createdEntryRef.current = ''
      return
    }
    setMessages([])
    setOpenSteps(new Set())
    /*
      组的选择**不在这里清**（见 `openGroups`）：它按会话存着（键上带会话 id），
      换出去再回来还是他选的那一档；那张表里别的会话那些键也漏不到这一条会话来。
      只有"新建态"（`conversationId` 是空串，见 `groupScopeKey`）没有 id 可依附——
      它的键都以 `|` 开头，这里把那一段清掉，免得上一回新对话里的选择漏到这一回来。
    */
    if (!conversationId) {
      setOpenGroups((prev) => new Map([...prev].filter(([key]) => !key.startsWith('|'))))
    }
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
    appliedDetail.current = ''
  }, [conversationId, wantsNew])

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

  /**
   * 补发到的 `done(recovered)` **画面里已经画过**：把画面按库里那份重铺一次（D10）。
   *
   * 为什么会出现"多出来的一条"：刷新一条**刚跑完**的会话时，库里那份（提问 + 回答）已经
   * 画在画面上了，而环形缓冲里那一轮还留着（十分钟），于是补发把同一轮的步骤又送一遍。
   * 那批事件与收尾的 `done` 分在两三个渲染里到，`recover` 那条支路就按"有内容就补"
   * **多补出一条回答**（真浏览器实测：刷新一条刚跑完的会话后，消息数 3、回答气泡 2）。
   *
   * 判据只有一条：**画面里同一条回答出现了两次**（正文逐字相同）。库里那份就是权威的
   * （页面上本来这份就是它），铺回去把多出来的那条收掉；也不用重读接口——现在手里这份
   * `detail` 就是它的来源，而且这一铺**不新增提问**，动不到 `ui/ChatThread.tsx` 落底
   * 那一处认的键（换会话 / 提问条数）。
   *
   * 按状态对象只做一次（同一份状态里两条一模一样的回答也可能是库里本来就有的——
   * 比如同一句话问了两次、答案又相同，那样这条判据会一直成立）。
   */
  const recoverDeduped = useRef<LiveTurnState | null>(null)
  useEffect(() => {
    if (!detail || detail.id !== conversationId) return
    if (!live || live.conversationId !== conversationId) return
    // "这一轮早就收尾"（补发到的那条 done 带 `recovered`）+ 正文到位，才谈得上"画了两遍"
    if (!live.recovered || live.text.length === 0) return
    const drawn = messages.filter((item) => item.role === 'assistant' && item.text === live.text)
    if (drawn.length < 2) return
    if (recoverDeduped.current === live) return
    recoverDeduped.current = live
    setMessages(messagesFromDetail(detail))
  }, [detail, conversationId, live, messages])

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

  /**
   * 附件**暂存**（v0.55）：选中的 / 拖进来的 / 粘进来的文件先摆在输入框里，
   * 发送那一刻才落到这条会话的文件区（见 `send` 里那一段）。
   *
   * 为什么不再"选完立刻上传"（旧 `uploadFiles` 的行为）：用户报的"上传文件得效果不合理……
   * 文件和图片应该通过缩略图的形式保留在对话框（agent 产品都是这么做的），而你是直接发送，
   * 然后上传到工作区"。三处入口（拖拽 / 粘贴 / 加号）共用这一份，与上传落点分工明确：
   * **这一层只碰本地文件，网络在发送那一步**。
   *
   * **图片给一张本地预览**：`URL.createObjectURL` 出来的是本机 blob，不产生任何请求；
   * 非图片（或环境里没有这个 API，例如 jsdom）留空串，界面画一个文件片。
   *
   * **位置在 `send` 之前**：`send` 的依赖数组里有 `attachments` 与 `removeAttachments`，
   * 而依赖数组是渲染期求值的——把这段放在 `send` 之后会当场抛
   * `Cannot access 'removeAttachments' before initialization`。
   */
  const addAttachments = useCallback((files: File[]) => {
    if (files.length === 0) return
    // **先按单文件上限筛一遍**（D21，2026-09-28 走查）。
    //
    // 后端的限也是 200 MB，但它是"整个 body 读完才判"——前端不先拦的话，用户要等
    // 整份传完才拿到一句失败，白等一场（走查实测：对话上传这条路上**一处预校验都没有**，
    // 而知识库上传那边早就有）。数字与后端 `api/v1/conversations.py` 的 `MAX_UPLOAD_BYTES`
    // 同源，这里直接引 `uploadLimits.ts`（那个模块存在的理由就是"别到处各写一个 200"）。
    const accepted = files.filter((file) => file.size <= MAX_UPLOAD_BYTES)
    const tooBig = files.filter((file) => file.size > MAX_UPLOAD_BYTES)
    if (tooBig.length > 0) {
      const first = tooBig[0]
      notifyWarning(
        tooBig.length === 1
          ? `「${first.name}」有 ${formatBytes(first.size)}，超过单文件上限 ${MAX_UPLOAD_MB} MB，没有加进来。`
          : `有 ${tooBig.length} 份超过单文件上限 ${MAX_UPLOAD_MB} MB（第一份「${first.name}」` +
              `${formatBytes(first.size)}），都没有加进来。`,
      )
    }
    if (accepted.length === 0) return
    setAttachments((prev) => [
      ...prev,
      ...accepted.map((file) => {
        attachmentSeq += 1
        return { id: `att${attachmentSeq}`, file, preview: imagePreview(file) }
      }),
    ])
  }, [])

  /**
   * 移除若干份暂存附件。
   *
   * **预览地址要一并释放**：不释放的话每选一次图就多占一份 blob，直到整页刷新——
   * 那正是 blob URL 最常见的泄漏方式（同一件事的第二半在下面那个卸载清理里）。
   */
  const removeAttachments = useCallback((ids: string[]) => {
    if (ids.length === 0) return
    const drop = new Set(ids)
    setAttachments((prev) => {
      for (const item of prev) {
        if (drop.has(item.id)) releasePreview(item.preview)
      }
      return prev.filter((item) => !drop.has(item.id))
    })
  }, [])

  const removeAttachment = useCallback((id: string) => removeAttachments([id]), [removeAttachments])

  /** 卸载时把还没发出去的预览地址一起放掉（见 `removeAttachments`）。 */
  const attachmentsRef = useRef(attachments)
  attachmentsRef.current = attachments
  useEffect(
    () => () => {
      for (const item of attachmentsRef.current) releasePreview(item.preview)
    },
    [],
  )

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
      /**
       * 这一轮随发的附件（v0.55）。**只有 `send` 那条路会给**——它拿上传返回的条目
       * 拼出快照；其余调用点（示例问题 / 重新生成 / 重试 / 命令）用默认空数组，
       * 它们这一轮没有新上传的文件。
       */
      attachments: ChatAttachment[] = [],
    ) => {
      setMessages((prev) => [
        ...prev,
        // 附件要**当场**挂上用户气泡：刚发出去那一轮立刻就有文件片，不必等回看
        makeChatMessage('user', text, { attachments }),
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
          // **只把 key 交上去**：名字 / 类型 / 字节数由服务端按库里的记录回填
          // （见 `ChatAttachment`），服务端还会校验它属于这条会话
          attachments: attachments.map((item) => ({ key: item.key })),
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
    !resolvingEntry &&
    // 上传期间不许再发（那一下会把这批附件重复上传一次）
    !uploading

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
         * 这一条是「新建态」的延续，不是"换会话"：两处都要放它过去，否则刚写上的
         * 那一对消息会被"清空 + 用空详情覆盖"各擦一遍再画回来（用户看到的闪烁，v0.55）。
         *
         * - `createdEntryRef`：让"换会话"那个 effect 跳过这一次；
         * - `appliedDetail`：这条会话的详情此刻**还是空的**（这一轮要跑完才落库），
         *   照它 `setMessages` 会把流式中的正文当场擦掉，所以先上膛、别让它应用一次。
         */
        createdEntryRef.current = target
        appliedDetail.current = target
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
        /**
         * 新会话**当场**进侧栏：侧栏那份清单只在挂载时 `load()` 一次，
         * 不告诉它的话，新会话要刷新页面才出现（用户报的"刷新一下才有"就是这条）。
         * 用后端刚返回的那条摘要（与列表接口同一个 `ConversationOut`），
         * 就地插入而**不重拉列表**——理由写在 `conversations.ts` 的 `upsert` 上。
         *
         * 落在项目下时，项目行的条数是另一个 store 里的数，得跟着刷一次；
         * 刷不动也不该把这一轮发送带崩（它只是个计数），所以只丢掉那个失败。
         */
        upsertConversation(created)
        if (pendingWorkspaceId) void refreshWorkspaceCounts().catch(() => undefined)
        /**
         * 记下"这条是刚建的"：**后端此刻还没给它起标题**（标题要等这一轮提问落下才生成），
         * 所以侧栏那一行现在只能显示「未命名对话」。用户报的正是"没有出现新的对话名"
         * ——只补一行空标题等于半个修复，所以等这一轮答完再回来把真名补上（见下面那个 effect）。
         */
        createdConversationRef.current = created.id
      } catch (cause) {
        notifyError(cause)
        return
      }
    }

    /**
     * 暂存的附件**在这里**落到这条会话的文件区（v0.55）。
     *
     * 三件事的顺序都是必须的：
     * 1. **先建会话再上传**——文件区的落点就是会话，没有会话时上传无处可去
     *    （这也是"新项目要先对话一次才能传文件"那条反馈的根因，现在建会话发生在同一趟里）；
     * 2. **上传失败就不发这一轮**：文件没上去，这一轮就少了它们，而用户以为已经带上了；
     *    这时**保留输入的原文**（还没 `setQueryState('')`），他改一下就能重发；
     * 3. **成功的那几份立刻从输入框拿掉**（连同预览地址），失败重发时才不会重复上传。
     *
     * 边传边攒`sentAttachments`（v0.55）：它就是"这一轮随发了哪几份"的**快照**，
     * 交给 `streamTurn` 一起发出去与画进用户气泡。用**上传返回的条目**而不是本地那份
     * `File`——key / 名字 / 类型 / 字节数都以服务端落完账的那份为准（同名会退成
     * `名字 (2).ext`，本地名字可能与库里的不同）。
     */
    const sentAttachments: ChatAttachment[] = []
    if (attachments.length > 0) {
      setUploading(true)
      const uploadedIds: string[] = []
      try {
        for (const item of attachments) {
          const entry = await uploadFile(target, item.file)
          uploadedIds.push(item.id)
          sentAttachments.push({
            key: entry.key,
            name: entry.name,
            kind: entry.kind,
            size_bytes: entry.size_bytes,
          })
        }
      } catch (cause) {
        removeAttachments(uploadedIds)
        notifyError(cause)
        setUploading(false)
        return
      }
      setUploading(false)
      removeAttachments(attachments.map((item) => item.id))
      // 文件区那份清单是"打开才拉"的（`wantConvFiles`），按 key 失效，下次打开就是新的
      void queryClient.invalidateQueries({ queryKey: ['chat', 'files', target] })
    }

    setQueryState('')
    if (text.startsWith('/')) {
      await runCommand(text, target, model, kbIds)
      return
    }
    await streamTurn(text, context, model, target, kbIds, sentAttachments)
  }, [
    attachments,
    canSend,
    conversationId,
    effectiveKbIds,
    history,
    kbs,
    modelPk,
    navigate,
    pendingWorkspaceId,
    query,
    queryClient,
    refreshWorkspaceCounts,
    removeAttachments,
    runCommand,
    sending,
    streamTurn,
    thinkingEffort,
    thinkingOn,
    upsertConversation,
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

  /**
   * 面板这一轮该摊开还是收起。
   *
   * **判断只有一处**（`turns.ts::isTraceOpen`）：这里只负责把**一个**事实递过去——
   * 用户在**这一轮**点过的那一档（`traceOpenIds`）。两条流水线（流式中 / 完成）与
   * "待确认强制展开"的规则都写在那个纯函数里，免得同一件事在宿主与界面各判一遍。
   *
   * 原先这里还递第二个事实（"他手动开过面板没有"，一份本机记忆）：用户 2026-09-29
   * 拍板"那个记忆可以不要"，整档删了——**豁免只作用于这一轮**，没点过的完成轮一律自动折。
   */
  const traceOpen = useCallback(
    (message: Message): TraceOpen => isTraceOpen(message, { chosen: traceOpenIds[idOf(message)] }),
    [traceOpenIds],
  )

  const toggleTrace = useCallback(
    (message: Message) => {
      // (c) 有步骤在等人工介入：这一下不收（理由见 `traceForceExpanded` 的注释）
      if (traceForceExpanded(message)) return
      const next: TraceOpen = traceOpen(message) === 'full' ? 'collapsed' : 'full'
      // 只记"这一轮他选了哪一档"（`chosen`）：跨轮次那档豁免已经删掉，
      // 所以这里不再往任何本机记忆里写东西（见 `traceOpen` 的说明）。
      setTraceOpenIds((prev) => ({ ...prev, [idOf(message)]: next }))
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
      // **这一轮之后、已经在库里的那几轮要一起撤掉**（D35，2026-09-28 走查）。
      //
      // 失败这一轮从来没落过库（见上面那段），所以它自己不用删；但它**后面**的轮次
      // 可能已经落库了——本地切掉、库里留着的话，一刷新那几轮又冒出来，与新发的这一轮
      // 前后错位。原先靠"只给最后一轮重试"绕开这件事，代价是**前面失败的轮次没有重试入口**
      // （走查实测：两条都失败之后，第一个气泡只剩「复制问题」）。
      // 判据用 `reply.error`：有错的没落库，没落的不用删。
      const laterPersisted = turns
        .slice(turnIndex + 1)
        .filter((item) => item.reply !== null && item.reply.error === '').length
      if (laterPersisted > 0) await rewindConversation(id, laterPersisted)
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
    attachments,
    addAttachments,
    removeAttachment,
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
    groupOpenChoice: (key) => openGroups.get(groupScopeKey(key)),
    chooseGroupOpen: (key, open) =>
      setOpenGroups((prev) => {
        // 两档都写下来：他收过的那一组，下一次挂载与"换出去再回来"都不该被默认档弹开
        const next = new Map(prev)
        next.set(groupScopeKey(key), open)
        return next
      }),
    /*
      批量那两位：**一次 setState 把整批写进去**（见接口上的说明）。
      没有一行要改时把**原引用还回去**——空写会让整棵消息树白白重渲染一次，
      而这一下点击在"全都是这一档"的时候本来就什么都不该做。
    */
    chooseStepsOpen: (keys, open) =>
      setOpenSteps((prev) => {
        const next = new Set(prev)
        let changed = false
        for (const key of keys) {
          if (next.has(key) === open) continue
          if (open) next.add(key)
          else next.delete(key)
          changed = true
        }
        return changed ? next : prev
      }),
    chooseGroupsOpen: (keys, open) =>
      setOpenGroups((prev) => {
        let next: Map<string, boolean> | null = null
        for (const key of keys) {
          const scoped = groupScopeKey(key)
          if (prev.get(scoped) === open) continue
          if (!next) next = new Map(prev)
          next.set(scoped, open)
        }
        return next ?? prev
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
