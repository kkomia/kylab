<script setup lang="ts">
/**
 * 对话页（《前端设计规范》§6）：选库 → 提问 → 带原文引用的回答。
 *
 * 它和库内检索面板的分工：检索回答"**哪个块**最像这个问题"，
 * 对话回答"**这些资料**怎么说这个问题"。所以这里的入口是跨库多选，
 * 结果也不再摊开分数与通道，而是正文 + 引用列表——用户要的是结论，不是排名。
 *
 * 布局与控件的取舍（v0.12，参考 WeKnora 的成熟做法）：
 * - **没有页头**：对话页是"一块会一直用的对话面"，不是一份清单。上面再顶一个
 *   "对话"标题只是重复（侧栏已经写着"对话"）。改为整页 flex 列 + 960px 居中窄列。
 * - **输入卡片自己带控件**：知识库多选与对话模型都在卡片底部——它们决定的正是
 *   "这一问依据什么、由谁回答"，跟输入放在一起才说得通。
 * - **示例问题来自后端语料生成**（拿不到就回退静态样例）：写死的问题和用户的语料无关，
 *   点进去往往答不上来。
 *
 * 两处仍然保留的刻意设计：
 * 1. 引用块**永远显示**，不折叠。回答是不是有据可依，是这一页存在的理由。
 * 2. 流式时给一个「停止」——模型偶尔会绕远路，那一刻用户唯一想要的就是让它闭嘴。
 */
import {
  computed,
  defineAsyncComponent,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type Component,
} from 'vue'
import { useRoute, useRouter } from 'vue-router'

import {
  chatStream,
  getSuggestedQuestions,
  listCommands,
  type ChatArtifact,
  type ChatCommand,
  type ChatCommandResult,
  type ChatHistoryMessage,
  type ChatSource,
  type ChatStep,
} from '@/api/chat'
import {
  ingestArtifact,
  listArtifacts,
  listFiles,
  rewindConversation,
  type ConversationArtifact,
  type ConversationDetail,
  type ConversationFile,
  type StoredMessage,
} from '@/api/conversations'
import { uploadDocument } from '@/api/documents'
import { formatBytes } from '@/composables/useFormat'
import { listSkills, type Skill } from '@/api/capabilities'
import type { RegisteredModel } from '@/api/modelRegistry'
import IconArrowUp from '@/components/icons/IconArrowUp.vue'
import IconAi from '@/components/icons/IconAi.vue'
import IconCopy from '@/components/icons/IconCopy.vue'
import IconAlert from '@/components/icons/IconAlert.vue'
import IconPlus from '@/components/icons/IconPlus.vue'
import IconRegenerate from '@/components/icons/IconRegenerate.vue'
import IconNote from '@/components/icons/IconNote.vue'
import IconFile from '@/components/icons/IconFile.vue'
import IconEdit from '@/components/icons/IconEdit.vue'
import IconTrash from '@/components/icons/IconTrash.vue'
import IconChat from '@/components/icons/IconChat.vue'
import IconCheck from '@/components/icons/IconCheck.vue'
import IconChevronDown from '@/components/icons/IconChevronDown.vue'
import IconChevronRight from '@/components/icons/IconChevronRight.vue'
import IconFolder from '@/components/icons/IconFolder.vue'
import IconFormatCode from '@/components/icons/IconFormatCode.vue'
import IconLogo from '@/components/icons/IconLogo.vue'
import IconRefresh from '@/components/icons/IconRefresh.vue'
import IconRobot from '@/components/icons/IconRobot.vue'
import IconSearch from '@/components/icons/IconSearch.vue'
import IconServer from '@/components/icons/IconServer.vue'
import IconStop from '@/components/icons/IconStop.vue'
import IconTasks from '@/components/icons/IconTasks.vue'
import IconUpload from '@/components/icons/IconUpload.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppModal from '@/components/ui/AppModal.vue'
import ModelPicker from '@/components/ui/ModelPicker.vue'
import RowMenu from '@/components/ui/RowMenu.vue'
import LinkText from '@/components/ui/LinkText.vue'
import SkeletonBlock from '@/components/ui/SkeletonBlock.vue'
import ApprovalBar from '@/components/chat/ApprovalBar.vue'
import ContextGauge from '@/components/chat/ContextGauge.vue'
import ExecPolicyControl from '@/components/chat/ExecPolicyControl.vue'
import LiveLine from '@/components/chat/LiveLine.vue'
import MentionMenu, { type MentionItem } from '@/components/chat/MentionMenu.vue'
import ModePicker from '@/components/chat/ModePicker.vue'
import SlashMenu from '@/components/chat/SlashMenu.vue'
import TraceStepRow from '@/components/chat/TraceStepRow.vue'
import {
  abortLiveTurn,
  attachLiveTurn,
  clearLiveTurn,
  liveTurnState,
  liveTurnState as live,
  settleLiveApproval,
  startChatTurn,
  startResumeTurn,
} from '@/composables/useLiveTurn'

/**
 * 引用文档抽屉（从右侧滑出）。
 *
 * **异步加载**：它带着 PDF iframe / Office 预览那一套，而为看一份原文而付这次下载
 * 不该摊到"每次打开对话页"上——不用它就是零成本。
 */
const DocumentDrawer = defineAsyncComponent(
  () => import('@/components/knowledge/DocumentDrawer.vue'),
)

/**
 * 文件抽屉（v0.26）：预览产物、浏览工作区/会话临时区的文件。
 *
 * 同样异步：它带着 Office 预览与 PDF iframe 那一套（三个引擎加起来近 900KB），
 * 不点开就一分钱不花。
 */
const FileDrawer = defineAsyncComponent(() => import('@/components/files/FileDrawer.vue'))
import { copyText, selectNode } from '@/composables/clipboard'
import { renderAnswerWithCitations } from '@/composables/useMarkdown'
import {
  buildTurns,
  isTraceOpen,
  liveLine,
  makeMessage,
  readTraceOpenMemory,
  replyArtifacts,
  sourcePreview,
  sourceWhere,
  tracePage,
  traceSummary,
  writeTraceOpenMemory,
  degradedReason,
  wasDegraded,
  THINKING_EFFORTS,
  TRACE_PAGE_SIZE,
  type Message,
  type ThinkingEffort,
  type TracePage,
  type Turn,
} from '@/composables/useChatTurns'
import { matchShortcut } from '@/composables/useShortcuts'
import { useToast } from '@/composables/useToast'
import { useConversationStore } from '@/stores/conversations'
import { useNoteStore } from '@/stores/notes'
import { useKnowledgeBaseStore } from '@/stores/knowledgeBases'
import { useModelRegistryStore } from '@/stores/modelRegistry'

/** 会话里带入模型的历史轮数上限：无边界地带上全部历史，提示词会先被自己挤爆。 */
const HISTORY_LIMIT = 6
/** 示例问题一次显示几个。一屏放得下五六个，再多就变成一堵墙。 */
const SAMPLE_COUNT = 5
/** 上次选过的对话模型：换会话/刷新之后仍然沿用（与 WeKnora 同一手法）。 */
const LAST_MODEL_KEY = 'kylab-last-chat-model'
/** 思考开关与强度的本机默认（新建会话时用；选中已有会话则回填会话里存的那一档）。 */
const LAST_THINKING_KEY = 'kylab-last-thinking'
const LAST_EFFORT_KEY = 'kylab-last-thinking-effort'

/**
 * 步骤图标：检索、思考、成稿。收在一张表里，模板用 `<component :is>` 取。
 * 图标映射留在页面而不是 `useChatTurns` 里——那是个纯逻辑模块，不该 import 一堆 .vue。
 */
/**
 * 过程面板的**图标表**（v0.26 按类别分开）。
 *
 * 键是 `TraceStep.icon` 那个类别（见 `useChatTurns` 的 `TraceIcon`），
 * 值在这里——**只有这个文件 import 图标组件**，逻辑层不认识它们。
 *
 * 改之前所有工具都画同一个服务器方块：七个联网搜索、两个抓网页，
 * 那一列全是同一个图形，扫过去等于没有信息。
 */
const STEP_ICONS: Record<string, Component> = {
  // 非工具步骤两档
  think: IconRobot,
  build: IconCheck,
  // 工具步骤：**键就是语义种类**（后端 `tool_meta.kind_of` 给的，P2-1）。
  // 配色在同一档类的 `.step-kind-*`（见 trace-row.css）——
  // 这张表只说"画哪张图"，颜色交给样式，两处各管一件。
  read: IconFile,
  search: IconSearch,
  // 「写入/产出」用笔（建笔记、上传、导出都是"往里放东西"）；
  // 交付物的那张卡片另在正文后面，不靠这个图标承担
  write: IconEdit,
  delete: IconTrash,
  exec: IconFormatCode,
  skill: IconTasks,
  session: IconAi,
  message: IconChat,
  // 认不出来的（外部 MCP 工具）：中性一档，不猜
  tool: IconServer,
}

const store = useKnowledgeBaseStore()
const conversations = useConversationStore()
const notes = useNoteStore()
const registryStore = useModelRegistryStore()
const route = useRoute()
const router = useRouter()
const { notifyError, notifySuccess, notifyWarning } = useToast()

const selected = ref<string[]>([])
const messages = ref<Message[]>([])
const query = ref('')
const sending = ref(false)
/** 当前这条流的取消句柄（null = 没有在跑的流）。 */
/** 组件是否已卸载：句柄到手时若人已经走了，这条流要立刻掐掉。 */
let unmounted = false
const streamHost = ref<HTMLElement | null>(null)
/** 正在回放哪一次历史对话（空 = 新对话）。 */
const loadingHistory = ref(false)
/**
 * 停在 `/chat` 时正在解析"最近一次对话"。
 *
 * 存在的唯一理由是**别先画一屏欢迎层再跳走**：那会让用户看到"新对话一闪而过"，
 * 也就是这次要修的那个现象，只是从"一直停着"变成"闪一下"。
 */
const resolvingEntry = ref(false)
/** 入口解析的序号：迟到的解析不许再把用户拽走（见 `enterChat`）。 */
let entryToken = 0

/**
 * 还没决定这一页显示什么：正在解析入口，或正在回放某条会话。
 *
 * 欢迎层要等这两件事都结束再画。回放也算进去，是因为入口解析完会 `replace` 到
 * `/chat/:id`，紧接着就是一次回放——中间那一小段空档同样会闪出欢迎层。
 */
const pendingEntry = computed(() => resolvingEntry.value || loadingHistory.value)

/**
 * 当前会话 id。**以路径为唯一来源**，不做本地副本：
 * 侧栏点、前进/后退、直接打开链接三种入口都会改路径，
 * 自己再存一份 state 就得在三个地方同步，迟早不一致。
 */
const conversationId = computed(() => String(route.params.conversationId ?? ''))

/**
 * 是不是"显式新建"（侧栏那颗「新对话」按钮带过来的 `?new=1`）。
 *
 * 为什么要靠查询参数把两个入口分开：`/chat`（侧栏「对话」）与「新对话」原本是同一条
 * 链接，于是从知识库返回时也落在空态上——用户看到的就是"又给我开了个新对话"。
 * 现在 `/chat` 表示"回到最近一次"，只有带 `?new=1` 才新建。
 *
 * 用**查询参数**而不是 `/chat/new` 这样的新路径：那就成了第二条路由记录，
 * 从 `/chat/:id` 过去会把 ChatView 卸载重建（正是路由表注释里记的那个坑）。
 */
const wantsNew = computed(() => Boolean(route.query.new))

/**
 * 能不能发。
 *
 * **关掉「使用知识库」之后不再要求选了库**（v0.18）：那一轮本来就不查库，
 * 还拦着不让发就等于开关是假的。开着时仍然要求至少选一个库——
 * 那时"没有可依据的原文"与后端的取数语义对不上。
 */
const canSend = computed(
  () =>
    (!useKb.value || selected.value.length > 0) &&
    query.value.trim().length > 0 &&
    !loadingHistory.value &&
    !resolvingEntry.value,
)

/** 这一轮真正发出去的库范围：开关关掉就是空（后端据此跳过检索）。 */
const effectiveKbIds = computed(() => (useKb.value ? selected.value : []))

/**
 * 输入框的占位文案**跟着开关走**。
 *
 * 关掉知识库还写"向知识库提问"是在骗人：用户会以为答案有依据，
 * 而这一轮根本没查库。占位符是这一页最容易被读到的一句话，值得跟着状态改。
 */
const composerPlaceholder = computed(() =>
  useKb.value
    ? '向知识库提问…（回车发送，Shift + 回车换行）'
    : '纯对话，不查知识库…（回车发送，Shift + 回车换行）',
)

/** 知识库多选的下拉选项（名字给用户看，id 给后端）。 */
const kbOptions = computed(() => store.items.map((item) => ({ value: item.id, label: item.name })))

// ------------------------------------------------- 输入框上的三个开关（v0.18）

/**
 * 「使用知识库」开关。
 *
 * **关掉 = 这一轮不查库**（后端 `kb_ids` 收空数组），就是纯对话。它和"选了库但
 * 一个都没勾"是两种状态：前者是"我不想查"，后者是"我还没选"——所以不能靠
 * `selected.length > 0` 反推，得单独存一个布尔。
 *
 * 落 localStorage：这是"我平时怎么用"的偏好，不是某一轮的一次性选择。
 */
const KB_SWITCH_KEY = 'kylab-chat-use-kb'
const useKb = ref(readStored(KB_SWITCH_KEY) !== '0')

/** 选库面板里的过滤词。库多了（几十个）没有它就得在一长条里找。 */
const kbFilter = ref('')

/** 过滤后的待选库；过滤词只用于显示，不影响已勾选的那些。 */
const visibleKbOptions = computed(() => {
  const keyword = kbFilter.value.trim().toLocaleLowerCase()
  if (!keyword) return kbOptions.value
  return kbOptions.value.filter((item) => item.label.toLocaleLowerCase().includes(keyword))
})

/**
 * 选库入口上写什么。
 *
 * 开关那件事由**开关本身**表达（v0.19 起它们是两个控件），所以这里只说"选了哪几个"。
 */
const kbPickText = computed(() => {
  // **还没加载完就说"还没有知识库"是假话**：库明明在，只是还没取回来。
  // 加载中报空会让用户以为自己的库丢了（实测确实会先闪一下这句）。
  if (store.loading && store.items.length === 0) return '读取中…'
  if (store.items.length === 0) return '还没有知识库'
  if (selected.value.length === 0) return '未选库'
  if (selected.value.length === store.items.length) return `全部 ${selected.value.length} 个`
  return `已选 ${selected.value.length} 个`
})

/**
 * 技能子菜单**往右展开**（v0.19，用户指定）。
 *
 * 记的是「技能」那一行在浮层里的 offsetTop：子菜单是绝对定位的，
 * 它的 offsetParent 正是那个浮层（`position: fixed` 是定位祖先），
 * 于是这一个数字就能让它贴着那一行、又不跟着列表往下堆。
 */
const skillsFlyoutTop = ref('0px')

/** 第一轮对话之前：欢迎层与输入卡片作为一组居中（Kimi 的形态）。 */
const isWelcome = computed(() => messages.value.length === 0 && !pendingEntry.value)

function toggleKbSwitch(): void {
  useKb.value = !useKb.value
  writeStored(KB_SWITCH_KEY, useKb.value ? '1' : '0')
}

function toggleKb(kbId: string): void {
  selected.value = selected.value.includes(kbId)
    ? selected.value.filter((item) => item !== kbId)
    : [...selected.value, kbId]
}

/**
 * 本轮钉住的技能（「加号 → 技能」勾的）。
 *
 * 也落 localStorage：它更像"我常开哪几个技能"而不是"这一句话要什么"。
 * 勾了就会每一轮都把它展开——**代价是占上下文**，所以勾选行上要写明这一点。
 */
const PINNED_SKILLS_KEY = 'kylab-chat-pinned-skills'
const pinnedSkills = ref<string[]>(
  readStored(PINNED_SKILLS_KEY)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
)
/** 技能清单（懒加载：不点开「技能」就不请求）。 */
const skillOptions = ref<Skill[]>([])
const skillsLoaded = ref(false)
const skillsOpen = ref(false)

async function loadSkills(): Promise<void> {
  if (skillsLoaded.value) return
  try {
    const { items } = await listSkills()
    // 只列**能进提示词**的：被安全扫描拦下的技能钉了也不生效，
    // 摆在可勾的位置上就是骗人（能力页里能看到它们被拦的原因）
    skillOptions.value = items.filter((item) => item.used_by_prompt)
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '技能清单取不到')
  } finally {
    skillsLoaded.value = true
  }
}

function toggleSkillsPanel(event: MouseEvent): void {
  skillsOpen.value = !skillsOpen.value
  if (!skillsOpen.value) return
  const row = event.currentTarget as HTMLElement | null
  if (row) skillsFlyoutTop.value = `${row.offsetTop}px`
  void loadSkills()
}

function toggleSkill(name: string): void {
  pinnedSkills.value = pinnedSkills.value.includes(name)
    ? pinnedSkills.value.filter((item) => item !== name)
    : [...pinnedSkills.value, name]
  writeStored(PINNED_SKILLS_KEY, pinnedSkills.value.join(','))
}

// ------------------------------------------------------- 附件（「加号」的第一项）

/**
 * 隐藏的文件选择器。**用 `<input type=file>` 而不是拖拽**：拖拽是加分项，
 * 而它在触屏上根本不存在，只做拖拽等于这部分功能在手机上没人能用。
 */
const fileInput = ref<HTMLInputElement | null>(null)
const uploading = ref(false)

/**
 * 往哪个库传。
 *
 * 附件在 KYLAB 里就是**知识库文档**（没有"只挂在这一轮消息上"的附件）——
 * 所以必须有一个落点：优先用当前勾选的第一个库。一个库都没勾（或开关关着）
 * 时**明确拒绝并说明**，而不是偷偷挑一个库塞进去。
 */
const attachTarget = computed(() => {
  if (!useKb.value) return null
  const id = selected.value[0] ?? store.items[0]?.id
  if (!id) return null
  return { id, name: store.items.find((item) => item.id === id)?.name ?? '' }
})

async function onFilesPicked(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = '' // 同一个文件连选两次也要能触发 change
  await uploadPicked(files)
}

/**
 * **上传**（既有那条链路：附件 = 知识库文档）。
 *
 * 从 `onFilesPicked` 里拆出来是为了给拖拽那条路共用：拖进来的 OS 文件走的是
 * **同一件事**（P1-3 的"两种落法"里"添加附件"那一半），两处各写一份的话，
 * "传给哪个库""失败怎么报"迟早分叉。
 */
async function uploadPicked(files: File[]): Promise<void> {
  if (files.length === 0) return
  const target = attachTarget.value
  if (!target) {
    notifyWarning(
      useKb.value ? '先在「知识库」里选一个库，文件才有地方放' : '打开「知识库」开关后再传文件',
    )
    return
  }
  uploading.value = true
  try {
    for (const file of files) await uploadDocument(target.id, file)
    notifySuccess(`已把 ${files.length} 个文件传给「${target.name}」，入库后就能被引用`)
    // 计数与文档列表随之变化：让侧栏与知识库页拿到新数字，不然要刷新才看得见
    void store.load()
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '上传失败')
  } finally {
    uploading.value = false
  }
}

// --------------------------------------------------- 上下文添加（P1-3）
//
// 这一节是 §12.225 的 P1-3 在界面上的落点，三件事各自对应调研报告里的一条：
//
// 1. **`@` 统一搜索**（ZCode 的多分类 + DSH 的"只引用不预读"）：一个 `@` 弹出
//    文件 / 技能 / 会话三类，选中只把**引用**插进输入框，内容一个字都不读；
// 2. **严格区分"上传附件"与"引用工作区文件"**（ZCode）：这是最容易被漏掉、
//    体验影响又最大的一处——拖 OS 文件是"给它素材"，拖工作区里的文件是
//    "让它自己去看那份"，两者的落法（上传 vs 插引用）与文案都不同；
// 3. **上下文仪表**（ZCode 的 `chat.contextUsage.breakdown`）：见 `ContextGauge`。

// —— ① `@` 统一搜索

/** 文件那一类的候选：这条会话的文件区（懒加载，见 `loadMentionFiles`）。 */
const mentionFiles = ref<ConversationFile[]>([])
const mentionFilesLoaded = ref(false)
const mentionMenu = ref<InstanceType<typeof MentionMenu> | null>(null)
/** 用户按 Esc 关掉之后，这一条输入里不再弹（改了内容再弹）。 */
const mentionDismissed = ref(false)

/**
 * 输入框里现在正在打的引用过滤词（`@` 之后那一段）；没在打就是 `null`。
 *
 * 两条判据与 DSH 的 `@` grammar 对齐（调研报告 §2.8）：
 *
 * - **`@` 之后不能有空白**：打了空格说明这一句已经写下去了（与 `/` 菜单同一条口径）；
 * - **邮箱里的 `@` 不触发**：前一个字符是 ASCII 词字符（`foo@bar.com`）就不算——
 *   中文里没有空格分隔，所以只排 ASCII，`看看@报告.md` 仍然要能弹。
 *
 * 取**最后一个** `@`：用户在句子里插一句引用时，最近的这个才是他正在打的。
 */
const mentionFilter = computed<string | null>(() => {
  const text = query.value
  const at = text.lastIndexOf('@')
  if (at < 0) return null
  const head = text.slice(at + 1)
  if (head.includes('\n') || /\s/.test(head)) return null
  const previous = at > 0 ? text[at - 1] : ''
  if (previous && /[A-Za-z0-9._-]/.test(previous)) return null
  return head
})

/** 三类的候选池：文件来自这条会话的文件区，技能来自既有技能接口，会话来自会话列表。 */
const mentionItems = computed<MentionItem[]>(() => [
  ...mentionFiles.value.map((file) => ({
    kind: 'file' as const,
    // **引用的是它在文件区里的 key（路径）**，不是显示用的短名字：
    // 工作区模式下它就是相对路径（能进子目录、同名也不会混），
    // 而模型手上那些 `read_file` / `list_files` 认的正是这个 key
    value: file.key,
    label: file.name,
    detail: file.is_dir ? '目录' : formatBytes(file.size_bytes),
    isDir: file.is_dir,
  })),
  ...skillOptions.value.map((skill) => ({
    kind: 'skill' as const,
    // 技能引用的是**名字**（与 `/skill <名字>` 同一个标识）
    value: skill.name,
    label: skill.name,
    detail: skill.summary || skill.description,
  })),
  ...conversations.items.map((item) => ({
    kind: 'session' as const,
    value: item.title,
    label: item.title,
    detail: '会话',
  })),
])

async function loadMentionFiles(): Promise<void> {
  const id = conversationId.value
  if (!id || mentionFilesLoaded.value) return
  mentionFilesLoaded.value = true
  try {
    const listing = await listFiles(id)
    mentionFiles.value = listing.entries
  } catch {
    // 文件清单拿不到就少一类候选：菜单是顺手入口，不该把对话页变成错误提示
    // （与 `listCommands` 同一条处置）
  }
}

/** 打 `@` 的那一刻把三类候选凑齐：文件要一次请求，技能与会话本来就有缓存。 */
function loadMentions(): void {
  void loadMentionFiles()
  void loadSkills()
  if (conversations.items.length === 0) void conversations.load()
}

watch(mentionFilter, (value) => {
  if (value !== null) loadMentions()
})

// 换了会话就重新读文件区（每条会话的文件区是它自己的）
watch(conversationId, () => {
  mentionFiles.value = []
  mentionFilesLoaded.value = false
  mentionDismissed.value = false
})

// 改内容就允许再弹（与 `/` 菜单同一条）
watch(query, () => {
  mentionDismissed.value = false
})

const mentionVisible = computed(
  () => mentionFilter.value !== null && !mentionDismissed.value && mentionItems.value.length > 0,
)

/**
 * 一条引用在输入框里的写法（照 DSH 的 `dsh-file-reference` grammar）。
 *
 * 带空白的值用**双引号**包起来：`@"我的 报告.md"`。不加引号的路径在模型那边
 * 会被当成两段（而用户看到的是一个名字里有空格的普通文件），
 * 那条 grammar 就是为这件事定的。
 */
function mentionToken(value: string): string {
  return /\s/.test(value) ? `@${JSON.stringify(value)}` : `@${value}`
}

/**
 * 选中一条候选：**只把引用插进输入框**（P1-3 的"不预读"那一半，也是最要紧的一半）。
 *
 * 读什么、读哪一段由模型决定（它手上有 `read_file` / `read_skill` / 会话工具）——
 * 界面在这里替它读一遍，用户既看不见自己付了多少上下文，也拿不回"我只要它看结论"这个选择。
 *
 * 落点就是那个 `@` 开头的那一段（`mentionFilter` 认出来的那个），把它整段替换掉。
 */
function applyMention(item: MentionItem): void {
  const text = query.value
  const at = text.lastIndexOf('@')
  if (at < 0) return
  mentionDismissed.value = true
  query.value = `${text.slice(0, at)}${mentionToken(item.value)} `
  focusComposerEnd()
}

/** 拖拽那条路进来的引用：接在**现有内容后面**（拖进来时没有 `@` 可以替换）。 */
function insertReference(value: string): void {
  const current = query.value
  const glue = current.length > 0 && !/\s$/.test(current) ? ' ' : ''
  query.value = `${current}${glue}${mentionToken(value)} `
  focusComposerEnd()
}

/** 插完引用把焦点与光标交回输入框末尾（用户接着就能往下打）。 */
function focusComposerEnd(): void {
  void nextTick(() => {
    const field = document.getElementById('chat-query') as HTMLTextAreaElement | null
    if (!field) return
    field.focus()
    field.setSelectionRange(field.value.length, field.value.length)
  })
}

// —— ② 拖拽的两种落法（附件 vs 引用）

/**
 * 工作区文件/目录拖拽时带的自定义类型（`FileDrawer` 的行上写的）。
 *
 * **必须是一个自定义 MIME**：OS 拖进来的文件与工作区里的文件都是 `Files`，
 * 只有"谁写的这个 payload"能区分它们——而这两种拖拽要做的事完全不同。
 * 名字用 `application/x-kylab-file`（照 DSH 的 `application/x-dsh-file` 命名法）。
 */
const FILE_DRAG_TYPE = 'application/x-kylab-file'

/** 正在拖什么：`null` = 没有在拖；两种落法各有各的文案（见 `dropHint`）。 */
const dropKind = ref<'attach' | 'reference' | null>(null)

/** 落法的那句话（ZCode 的两句文案，一字不改地照抄）。 */
const dropHint = computed(() =>
  dropKind.value === 'reference' ? '松开以引用此文件' : '松开以添加附件',
)

function dragKinds(event: DragEvent): string[] {
  return Array.from(event.dataTransfer?.types ?? [])
}

/**
 * 拖到了输入框上：**先判这一拖是哪一种**，再把它写成对应那一句文案。
 *
 * 判据只有 `dataTransfer.types`——`getData` 在 dragover 阶段读不到（浏览器
 * 出于安全只在 drop 时给），所以"文件还是目录"这一刻分不出来，
 * 两种都按同一句"引用"文案说（目录也一样是引用）。
 */
function onComposerDragOver(event: DragEvent): void {
  const types = dragKinds(event)
  const reference = types.includes(FILE_DRAG_TYPE)
  const files = types.includes('Files')
  if (!reference && !files) return
  // 不 preventDefault 浏览器就不会派发 drop（默认动作是"打开这个文件"）
  event.preventDefault()
  dropKind.value = reference ? 'reference' : 'attach'
}

/** 拖出输入框（含拖到子元素上）：`relatedTarget` 还在里面就不算离开，免得文案闪。 */
function onComposerDragLeave(event: DragEvent): void {
  const host = event.currentTarget as HTMLElement | null
  const next = event.relatedTarget as Node | null
  if (host && next && host.contains(next)) return
  dropKind.value = null
}

/**
 * 松手：**两种落法在这里分开**（照 ZCode 的"上传 vs 引用"）。
 *
 * - 工作区里的文件/目录 → 插一条**引用**（不读、也不上传）；
 * - 其余（从资源管理器拖进来的文件）→ 走**既有上传链路**（和「加号 → 添加文件」同一件事）。
 */
async function onComposerDrop(event: DragEvent): Promise<void> {
  dropKind.value = null
  const transfer = event.dataTransfer
  if (!transfer) return
  const payload = transfer.getData(FILE_DRAG_TYPE)
  if (payload) {
    try {
      const info = JSON.parse(payload) as { key?: string; name?: string }
      const value = info.key || info.name || ''
      if (value) insertReference(value)
    } catch {
      // 坏 payload（别的应用恰好写了同一个类型）当没发生：它本来就只是一条便利
    }
    return
  }
  await uploadPicked(Array.from(transfer.files ?? []))
}

// —— ③ 上下文仪表

/** 仪表（`ContextGauge`）：它有自己的一次请求，这里只负责在恰当的时机让它重读。 */
const contextGauge = ref<InstanceType<typeof ContextGauge> | null>(null)

/**
 * 「压缩」按钮：走**既有那条压缩链路**——`/compact` 命令（服务端 `ChatService.compact`，
 * 第一级先剪旧工具结果、不够再摘要）。界面不另造一套压缩，理由与 `/help` 那两个
 * 入口共用一份清单同一条：两处各写一份语义，"按钮压的"与"命令压的"迟早不一样。
 */
function compressContext(): void {
  const target = conversationId.value
  if (!target) {
    notifyWarning('这条会话还没建起来，没有可压缩的上下文')
    return
  }
  void runCommand('/compact', target, modelPk.value || undefined).then(() => {
    contextGauge.value?.refresh()
  })
}

onMounted(async () => {
  if (store.items.length === 0) await store.load()
  // 默认全选：打开这一页的人多半就是要问遍手上的资料，让他先做一轮取消勾选是白费功夫
  selected.value = store.items.map((item) => item.id)
  void loadModels()
  await enterChat()
  scheduleSamples()
})

/**
 * 停在 `/chat`（没有 id）时该显示什么：最近一次对话，或者空态。
 *
 * 三条为什么这么写：
 * 1. **只认路径与查询参数**：直接开链接、收藏、前进后退、中键新标签都会落到 `/chat`，
 *    只在侧栏的点击里算一次，这些入口就漏了；
 * 2. **解析期间不画欢迎层**（见 `resolvingEntry`）：先画再跳的话，用户还是会看到
 *    "一屏新对话一闪而过"——正是这次要修的现象，只是变短了；
 * 3. **用 `replace` 而不是 `push`**：历史里不该留下中间那个空的 `/chat`，
 *    否则"返回"会回到空态、又被解析弹回来，卡成一个循环（与新建会话那里同一套理由）。
 * 4. **拿到结论后要再确认一次"我还站在 `/chat` 上"**：解析是一次网络往返，
 *    这期间用户完全可能已经点了侧栏里某条会话、或按了「新对话」——
 *    那时手上的结论已经过期，照旧 `replace` 就是把人从他刚选的那条上拽走
 *    （实测：直接打开 `/chat` 后马上点第二条会话，会被弹回"最近一条"）。
 */
/**
 * 解析期间用户可能已经离开了这一页：`replace` 之前必须再确认三件事。
 *
 * - `unmounted`：组件都没了，任何改路径都是替别人做决定；
 * - **`route.name !== 'chat'`**：这是"跳回对话"那个 bug 的正主。光看
 *   `conversationId` 是不够的——切到别的菜单之后 `route.params.conversationId`
 *   本来就是空的，于是守卫放行、`replace('/chat/<latest>')` 把刚走的人拽回对话页
 *   （实测复现：点「对话」后 80ms 内点「知识库」，最终仍停在 /chat/xxx）；
 * - 路径/查询参数变了：用户已经自己选了别的会话或点了「新对话」。
 */
function entryIsStale(): boolean {
  return unmounted || route.name !== 'chat' || Boolean(conversationId.value) || wantsNew.value
}

async function enterChat(): Promise<void> {
  if (conversationId.value) {
    await loadConversation()
    return
  }
  if (wantsNew.value) {
    messages.value = []
    return
  }
  const token = ++entryToken
  resolvingEntry.value = true
  try {
    const latest = await conversations.latestId()
    // 并发进来的后一次说了算：只有最新那次允许改路径
    if (token !== entryToken || entryIsStale()) return
    if (latest) {
      await router.replace(`/chat/${latest}`)
      return
    }
    // 一条历史都没有：就是新用户，停在空态
    messages.value = []
  } catch {
    // 拿不到列表就停在空态。这里不该弹红字：用户是来问问题的，
    // 而"最近一条"只是个便利，拿不到不等于这一页坏了
    if (token === entryToken) messages.value = []
  } finally {
    if (token === entryToken) resolvingEntry.value = false
  }
}

/**
 * 切换会话时重新装载。
 *
 * **必须 watch 而不是只靠 onMounted**：`/chat` 与 `/chat/:id` 用的是同一个组件，
 * Vue 会复用实例、不会重新挂载——只写在 onMounted 里，从列表点另一条会话时
 * 界面不会有任何变化（这是路由参数类页面最经典的坑）。
 *
 * 查询参数也要看：从「新对话」（`/chat?new=1`）再点侧栏「对话」（`/chat`）时，
 * 路径参数前后都是空，只有查询参数变了——不 watch 它就还停在空态。
 */
watch([conversationId, wantsNew], () => {
  void enterChat()
})

/**
 * 把"正在流式的那一轮"**镜像**进本组件的消息数组（v0.41）。
 *
 * 这一轮的真身在 `useLiveTurn` 里（模块作用域，切页不丢）。本组件只负责把它画出来：
 *
 * - **`append` 且画面上没有那一对**（例如用户离开页面后流还在跑，回来时组件是新挂载的、
 *   库里又还没有这一轮）→ 用 `live` 里的提问与已流出的字**补出一对**；
 *   库里没有它的原因是落库发生在流跑完之后，所以不能等库。
 * - **`recover`（P2-2，刷新之后接回来的那一轮）**：只补回答那一条，而且**只有正文到了才补**。
 *   两条依据：正文增量**不补发**（见后端 `live_turns`），所以"有正文"就等于"这一轮还活着"；
 *   而提问在这一刻还没落库（它随回答一起写），补不出来——等这一轮写完，`settleTurn`
 *   会按库里那份重画，问题自己就出现了。
 * - 其余情况只管把最后一条助手消息的字段刷成最新值。
 *
 * 最后这条规则顺手解决了"补发到一个**已经收尾、也已经落库**的轮次"这件事：
 * 那种补发里全是 step / 出处（有编号）而没有正文，于是**一个字都不会多出来**
 * （不会凭空多出一轮已经看过的回答）；收口那条 `done(recovered)` 只翻 `streaming`。
 *
 * `patch`（续跑）不补新的一对：那条回答在库里存在，补了会凭空多出一轮。
 */
function syncLive(): void {
  const state = live.value
  if (!state || state.conversationId !== conversationId.value) return

  const last = messages.value.at(-1)
  const hasPlaceholder = last?.role === 'assistant' && last.streaming === true
  if (!hasPlaceholder) {
    // 收尾了、画面上又还没有它：**什么都不补**——库里那份才是权威
    // （重连到一条早已跑完的会话时走的就是这一支）
    if (!state.streaming) return
    if (state.mode === 'append') {
      messages.value = [
        ...messages.value,
        makeMessage('user', state.query),
        makeMessage('assistant', state.text, { streaming: true, thinking: state.thinking }),
      ]
    } else if (state.mode === 'recover' && state.text.length > 0) {
      messages.value = [
        ...messages.value,
        makeMessage('assistant', state.text, { streaming: true, thinking: state.thinking }),
      ]
    } else {
      return
    }
  }

  const target = messages.value.at(-1)
  if (!target || target.role !== 'assistant') return
  // 就地改字段而不是整数组替换：整数组替换会让每来一个 delta 就重建整个消息流
  Object.assign(target, {
    text: state.text,
    thinkingText: state.thinkingText,
    steps: state.steps,
    sources: state.sources,
    streaming: state.streaming,
    error: state.error,
  })
}

watch(live, syncLive, { deep: true, immediate: true })

/**
 * 页面挂载（或切到某条会话）时**接回那一轮**（P2-2 的重连）。
 *
 * 刷新是这里要治的那个场景：v0.41 让流不跟着组件走，但刷新会把这一页整个重建，
 * 于是"回答写到一半刷新一下"仍然没了。现在后端按会话留着那一轮的环形缓冲
 * （见 `services/live_turns.py`），所以挂载时用锚点问一次就能接上。
 *
 * 两件事顺序不能换：**先把库里的历史铺进界面**（`applyDetail` / 缓存那条路），
 * 再接回来——反过来的话，`recover` 那条镜像规则会先看到"画面上有一轮在流"。
 *
 * 失败不打扰用户：接不上说明这条会话当前没有在跑的一轮（或者网络不通），
 * 两种都不该把对话页变成错误提示。
 */
function attachLive(id: string): void {
  if (!id) return
  void attachLiveTurn(id)
}

/** 「停止」按钮与输入框的禁用态：跟着**这一条会话**上的那一轮走（离开页面再回来也要对）。 */
watch(
  live,
  () => {
    sending.value = Boolean(
      live.value?.streaming && live.value.conversationId === conversationId.value,
    )
  },
  { deep: true, immediate: true },
)

/**
 * 这一条会话上**在等用户点头**的那一次工具调用（v0.41）。
 *
 * 与 `sending` 同一个理由要看会话：确认条属于"这一轮"，切走再回来（组件重建）
 * 也还要摆出来——后端一直在等，界面不显示的话它只能等到超时。
 */
const pendingApproval = computed(() => {
  const state = live.value
  if (!state || state.conversationId !== conversationId.value) return null
  return state.approval
})

/** 把一份会话详情铺进界面（缓存与网络两条路都走它，口径才不会分叉）。 */
function applyDetail(detail: ConversationDetail): void {
  messages.value = detail.messages.map((item) =>
    makeMessage(item.role === 'user' ? 'user' : 'assistant', item.content, {
      sources: item.sources,
      // 过程与思考**都要还原**（v0.25）：不然用户离开这一页再回来，
      // 只剩一句"已生成回答"——而"这句答案是怎么来的"正是他回来要找的东西
      // 后端的 `steps` 是 `dict[str, object]`（协议层故意不收紧：它是**快照**，
      // 字段随版本加过好几次，老消息里就是少几个键）。这里显式转一次，
      // 读的时候一律按可选取值——见 `TraceStep` 里那些 `?`
      steps: (item.steps ?? []) as unknown as ChatStep[],
      thinkingText: item.thinking ?? '',
      // 这一轮当时用哪档思考仍然没存（那是会话级偏好，不在消息上），别猜
      thinking: null,
    }),
  )
  // 会话建立时用的哪些库：回放时应当沿用，否则多轮上下文会指向上一次没查的库
  if (detail.kb_ids.length) {
    selected.value = detail.kb_ids.filter((kbId) => store.items.some((item) => item.id === kbId))
  }
  // 会话当时选的对话模型：回放时也沿用（v12）。为空则保持当前的默认选择
  if (detail.model_pk) modelPk.value = detail.model_pk
  // 会话当时的思考偏好（v16）：`null` = 当时跟随全局，保持当前默认即可
  if (detail.thinking !== null) thinkingOn.value = detail.thinking
  // 库里那份画完了，再把"正在流的那一轮"补上去（没有它时这是个空操作）
  syncLive()
  if (detail.thinking_effort) thinkingEffort.value = detail.thinking_effort
  stick.value = true
  void scrollToBottom()
  // 产物的**当前状态**要另外问一次（v0.26）：步骤里存的是流式当时的样子，
  // 而"这份文件后来进了哪个库"是之后发生的事。不问的话，卡片上的
  // "已存进知识库"在刷新之后就退回"存进知识库"了。
  void refreshArtifacts(detail.id)
}

/**
 * 把这条会话的产物**现在的样子**合并进各步骤的卡片。
 *
 * 一次请求，按 `artifact_id` 对齐；步骤里没出现过的不补（那些产物属于被回退掉的
 * 轮次，界面不该凭空多出一张卡片）。失败就静默——卡片退回快照那份仍然可用，
 * 为一条后台刷新把整页报红不值当。
 */
async function refreshArtifacts(id: string): Promise<void> {
  try {
    const { items } = await listArtifacts(id)
    if (conversationId.value !== id) return
    for (const item of items) mergeArtifact(fromStored(item))
  } catch {
    // 见上：这是锦上添花的一次刷新
  }
}

/**
 * 把库里的历史读进界面。
 *
 * **先看缓存**：命中就同步画出来（零等待），不再等一个往返——"离开对话页再回来"
 * 是最常见的动作之一，原来每次都要空白一下。侧栏悬停时也会预取，所以多数情况下
 * 点进来就已经命中了。
 *
 * 未命中才走网络，此时给骨架屏（`pendingEntry` + 无消息）而不是干等一屏空白。
 */
async function loadConversation(): Promise<void> {
  const id = conversationId.value
  if (!id) {
    messages.value = []
    scheduleSamples()
    return
  }
  // 这一轮还在写（无论本组件在不在），库里都没有它——画完历史之后由 `syncLive`
  // 把那一对补回来；但要是它**已经写完了**（用户离开这一页期间跑完的），
  // 那就是库里的版本最新（后端在流结束时落库），把它忘掉、按库重画。
  // 这一条替代了 v0.41 之前那个 `streamingConversationId` 局部变量。
  if (live.value?.conversationId === id && !live.value.streaming) clearLiveTurn()

  const cached = conversations.cachedDetail(id)
  if (cached) {
    applyDetail(cached)
    attachLive(id)
    return
  }

  loadingHistory.value = true
  try {
    const detail = await conversations.fetchDetail(id)
    // 取回来的路上用户可能又切走了：别把旧会话的内容盖到新选的这条上
    if (conversationId.value !== id) return
    applyDetail(detail)
    attachLive(id)
  } catch (cause) {
    if (conversationId.value !== id) return
    notifyError(cause instanceof Error ? cause.message : '会话加载失败')
    messages.value = []
  } finally {
    loadingHistory.value = false
  }
}

// 清单可能是 App.vue 稍后加载完的；勾选态要在它到位后补上，否则一进来就是"没选库"
watch(
  () => store.items.length,
  () => {
    if (selected.value.length === 0) selected.value = store.items.map((item) => item.id)
  },
)

onBeforeUnmount(() => {
  // **不再 abort**（v0.41）：流归 `useLiveTurn` 管，人走了它照跑——
  // 用户切去别的页面再回来，这一轮还在（甚至是完整的）。
  // 这里只收掉本组件自己的定时器与"别再改路径"的守卫。
  unmounted = true
  window.clearTimeout(samplesTimer)
  window.clearTimeout(flashTimer)
  window.clearTimeout(copiedTimer)
})

const history = computed<ChatHistoryMessage[]>(() =>
  messages.value
    // 失败或没吐字的助手消息不进历史：模型看到空的上一轮会更离谱
    .filter((item) => item.role === 'user' || (item.text.length > 0 && !item.error))
    .slice(-HISTORY_LIMIT)
    .map((item) => ({ role: item.role, content: item.text })),
)

/**
 * 跑一轮流式问答：追加"提问 + 占位回答"两条消息，再把增量**就地**打进占位那条。
 *
 * **`send` 与 `regenerate` 共用这一份**。它们原先各抄了一遍（`resend` 的注释甚至
 * 写着"与 `send()` 共用同一套流式处理"，实际并没有）——于是"新增一种事件"
 * 要在两处同时改，漏一处就是同一句回答在两条入口里表现不同，
 * 而这种差别只在用户恰好走那条入口时才暴露。
 *
 * `conversationId` 由调用方给：`send` 可能要先建会话（还要改路由），
 * 重新生成则一定已有会话——那两件事留在各自那一边，这里只管跑流。
 */
async function streamTurn(
  text: string,
  context: ChatHistoryMessage[],
  model: string | undefined,
  conversationId: string,
): Promise<void> {
  messages.value = [
    ...messages.value,
    makeMessage('user', text),
    makeMessage('assistant', '', {
      streaming: true,
      // 记下这一轮实际发出去的思考档：过程面板要如实显示"这一步做没做"
      thinking: { enabled: thinkingOn.value, effort: thinkingEffort.value },
    }),
  ]
  sending.value = true
  // 新问题一定要回到最新一行：用户刚按下发送，接下来的字就是他等着看的东西，
  // 哪怕他上一轮往上翻过旧回答。watch 的 flush: 'post' 会处理这次滚动
  stick.value = true
  void scrollToBottom()

  // 流**不在这里持有**（v0.41）：状态与连接交给 `useLiveTurn`，本组件只做镜像
  // （见 `syncLive`）。这样用户切去别的页面时这一轮照跑，回来还能接着看。
  await startChatTurn(
    // 带上 conversation_id 之后，历史由后端从库里取——所以 context 传不传都一样，
    // 留着是为了"没会话"那条路径（见 api/chat.ts 的说明）
    {
      query: text,
      kb_ids: effectiveKbIds.value,
      skill_names: pinnedSkills.value,
      history: context,
      conversation_id: conversationId,
      model_pk: model,
      thinking: thinkingOn.value,
      thinking_effort: thinkingEffort.value,
    },
    {
      conversationId,
      query: text,
      thinking: { enabled: thinkingOn.value, effort: thinkingEffort.value },
    },
  )
}

async function send(): Promise<void> {
  if (!canSend.value) return
  const text = query.value.trim()
  if (text.length === 0) {
    notifyWarning('请输入问题')
    return
  }
  // **命令在流式期间也放行**（P1-2）：`/stop` 存在的意义就是"这一轮还在跑的时候把它停下"
  // ——把输入框在流式期间整段禁掉，这条命令就永远打不出来（"停止也要是一等命令"）。
  // 普通提问仍然不许插队：后端没有"往跑着的一轮里插话"这条路，静默吞掉更糟，
  // 所以留着文本并说清为什么。
  const isCommand = text.startsWith('/')
  if (sending.value && !isCommand) {
    notifyWarning('这一轮还在跑：等它结束再发，或者用 /stop 停下')
    return
  }
  // 先算历史：这条提问还没进 messages，不能把自己也算成上下文
  const context = history.value
  const model = modelPk.value || undefined

  // 新对话：第一句话落下去之前先建会话，拿到 id 再提问。
  // 反过来（先问再建）会丢掉这一轮的落库——后端要靠 conversation_id 才知道往哪写。
  let target = conversationId.value
  if (!target) {
    try {
      const created = await conversations.create(effectiveKbIds.value, modelPk.value || null, {
        thinking: thinkingOn.value,
        thinking_effort: thinkingEffort.value,
      })
      target = created.id
      // 用 replace 而不是 push：用户按"新对话"只是想换个会话，
      // 在历史里留一条空的 /chat 没有任何意义，返回时会看到一片空白
      await router.replace(`/chat/${target}`)
    } catch (cause) {
      notifyError(cause instanceof Error ? cause.message : '无法新建对话')
      return
    }
  }

  query.value = ''
  closeSlash()
  // 以 `/` 开头的输入**先当成命令**（P1-2，照 DSH 的"`/` 行永不静默降级"）：
  // 短路类的由后端直接答掉、不建回答气泡；改写类的（`/skill` 与自定义 md 命令）
  // 渲染出这一轮的提示后照常走模型——那两条路怎么分，后端的 `short_circuit` 说了算。
  if (text.startsWith('/')) {
    await runCommand(text, target, model)
    return
  }
  await streamTurn(text, context, model, target)
}

// ------------------------------------------------------------- 斜杠命令（P1-2）
//
// 三件事分开：**菜单**（打 `/` 弹出，见 SlashMenu.vue）、**分流**（短路类走
// `runCommand`、改写类走普通那一轮）、**回话**（`commandResult` 那一小块面板）。
// 分流必须与后端一致，所以菜单里的 `short_circuit` 就是唯一依据——
// 后端认不出某条命令时**也**不会有模型调用，所以"不在菜单里"按短路类处理（见下）。

/** 命令清单（懒加载：不敲 `/` 就不请求）。 */
const commands = ref<ChatCommand[]>([])
const commandsLoaded = ref(false)
const slashMenu = ref<InstanceType<typeof SlashMenu> | null>(null)
/** 最新的那条命令回话（`null` = 没显示）。 */
const commandResult = ref<ChatCommandResult | null>(null)

/** 输入框里现在是不是在打一条命令：`/` 开头**且还没打空格**（打了空格就是在写参数了）。 */
const slashFilter = computed(() => {
  const text = query.value
  if (!text.startsWith('/') || text.includes('\n')) return null
  const head = text.slice(1)
  if (head.includes(' ')) return null
  return head
})

const slashOpen = computed(() => slashFilter.value !== null && commands.value.length > 0)

async function loadCommands(): Promise<void> {
  if (commandsLoaded.value) return
  commands.value = await listCommands()
  commandsLoaded.value = true
}

/** 打 `/` 的那一刻就把清单取回来（之后每次打开是内存里的）。 */
watch(slashFilter, (value) => {
  if (value !== null) void loadCommands()
})

function closeSlash(): void {
  // 关掉的办法是让过滤条件不成立——`query` 由输入框持有，这里只清空下拉
  slashDismissed.value = true
}

/** 用户按 Esc 关掉菜单之后，这一条输入里不再弹（改了内容再弹，见 watch）。 */
const slashDismissed = ref(false)
watch(query, () => {
  slashDismissed.value = false
})

const menuVisible = computed(() => slashOpen.value && !slashDismissed.value)

/**
 * 选中一条命令：**能补完就补完，补不了就执行**。
 *
 * - 还要参数的（`/mode `、`/skill <技能名>`）：把 `/名字 ` 插进输入框，光标留给参数；
 * - 不要参数的（`/help`、`/new`）：输入框里已经是这条命令了，于是**再按一次回车就是执行**
 *   ——`applyCommand` 遇到"没有变化"时直接发送，避免"按了回车什么都没发生"。
 */
function applyCommand(command: ChatCommand): void {
  const needsArgs = Boolean(command.argument_hint) || command.usage.trim() !== `/${command.name}`
  const text = needsArgs ? `/${command.name} ` : `/${command.name}`
  slashDismissed.value = true
  if (query.value.trim() === text.trim()) {
    void send()
    return
  }
  query.value = text
}

/**
 * 输入框上的键盘：菜单开着时先归菜单（↑↓ 选择、回车选中、Esc 关掉），
 * 其余情况才是"回车发送"。
 *
 * 焦点**自始至终在输入框里**（菜单不抢焦点）：所以这几件事必须写在这里，
 * 而不是挂在菜单组件上——那会让用户打一半字发现焦点跑了。
 *
 * **`@` 菜单排在 `/` 之前**（P1-3）：同一个 `@` token 里不可能同时在打命令，
 * 两个菜单也不会同时开着（判据互斥），而先问引用那个更贴用户当下的动作。
 */
function onComposerKeydown(event: KeyboardEvent): void {
  if (mentionVisible.value) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      mentionMenu.value?.move(event.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      // 有过匹配才算"选中"：一条都没匹配上时回车要落到发送上
      // （与 `/` 菜单同一条，见下面那段注释）
      if (mentionMenu.value?.flat.length) {
        event.preventDefault()
        mentionMenu.value.pickActive()
        return
      }
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      mentionDismissed.value = true
      return
    }
  }
  if (menuVisible.value) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      slashMenu.value?.move(event.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      // **有过一条匹配才算"选中"**：一条都没匹配上时回车要落到"执行"上，
      // 否则用户打完整条命令再按回车会石沉大海（后端那句"没有这个命令"就见不着了）
      const menu = slashMenu.value
      if (menu && menu.flat.length > 0) {
        event.preventDefault()
        menu.pickActive()
        return
      }
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      slashDismissed.value = true
      return
    }
  }
  // 菜单都关着的时候：交给**快捷键注册表**（P2-1）。
  //
  // 改之前这里是写死的 `Enter && !shiftKey`。现在"哪组键发送、哪组键换行"由用户在
  // 设置里定（默认仍是回车发送、Shift+回车换行，见 useShortcuts 的命令表）。
  // 没匹配上的键**一律不动**：交给浏览器，也就是输入框原生的输入与换行——
  // 这正是"把发送键改成 Ctrl+回车"之后，单独按回车仍然能换行的原因。
  const action = matchShortcut(event, 'composer')
  if (action === 'chat.send') {
    event.preventDefault()
    void send()
    return
  }
  if (action === 'chat.newline') {
    event.preventDefault()
    insertLineBreak(event)
  }
}

/**
 * 在光标处插一个换行（`chat.newline` 那一条）。
 *
 * 为什么要自己插而不是"不拦着让浏览器插"：默认绑定（Shift+回车）确实原生就能换行，
 * 但用户完全可能把它改成别的（Ctrl+J 之类）——那时不拦着就等于"改了不生效"，
 * 而界面上的提示会说能用。`setRangeText` 之后**手动派发一个 input 事件**：
 * v-model 认的是它。
 */
function insertLineBreak(event: KeyboardEvent): void {
  const field = event.target as HTMLTextAreaElement | null
  if (!field || typeof field.setRangeText !== 'function') return
  const start = field.selectionStart ?? field.value.length
  const end = field.selectionEnd ?? start
  field.setRangeText('\n', start, end, 'end')
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

/**
 * 跑一条命令：**它就是一轮请求，只是后端不会产生回答**。
 *
 * 与 `streamTurn` 的两处差别，都是有意的：
 * 1. **不插"提问 + 空回答"那两条消息**——命令不进模型历史，也不该在对话流里留下气泡
 *    （ZCode / DSH 都是这个观感：命令的回话是系统的回话，不是助手说的话）；
 * 2. **不走 `useLiveTurn`**（那一套是给"切页也不丢的回答"用的）：命令是瞬时的，
 *    几十毫秒就回来了，为它维护一份跨页状态只是把简单的事复杂化。
 *
 * 后端认出它是**改写类**时（`/skill`、自定义 md 命令），这条路会收到正常那一轮的
 * step/delta 事件——所以这里按"有没有 command 事件"决定怎么收尾：
 * 收到了就显示回话面板，什么都没收到就什么也不做（真正的内容由 useLiveTurn 那条
 * 常驻链路照旧呈现）。分流的依据来自菜单的 `short_circuit`，与后端同一份数据。
 */
async function runCommand(text: string, target: string, model: string | undefined): Promise<void> {
  // **先确保菜单到手**，再决定走哪条路：分流依据是后端给的 `short_circuit`，
  // 而用户完全可能把一整条命令粘进来（那时菜单一次都没弹过、清单也还没取）。
  await loadCommands()
  const name = text.slice(1).split(/\s+/)[0]?.toLowerCase() ?? ''
  const known = commands.value.find((item) => item.name === name)
  // 清单空 = 后端没有这个端点（旧版本）：那它也没有命令这一层，
  // 按普通一轮发出去才是对的（反过来的话，用户会得到一条空回答）。
  if (commands.value.length === 0) {
    await streamTurn(text, history.value, model, target)
    return
  }
  // **改写类**（菜单里说它要模型）：按普通一轮发出去，走 `useLiveTurn` 那条常驻链路
  if (known && !known.short_circuit) {
    await streamTurn(text, history.value, model, target)
    return
  }
  // 短路类与**认不出的命令**（可能只是打错了）都走这里：后端不会为它们调模型，
  // 回一句"没有这个命令"或命令的回话——那一轮没有回答，也就不该建回答气泡。
  commandResult.value = null
  try {
    await chatStream(
      {
        query: text,
        kb_ids: effectiveKbIds.value,
        conversation_id: target,
        model_pk: model,
      },
      {
        onCommand: (result) => {
          commandResult.value = result
          handleCommandAction(result)
        },
        // 解析不了就当"没有回话"：报错的那一轮后端会经 `onError` 说清楚
        onError: (message) => {
          notifyError(message)
        },
      },
    )
    // 命令可能在服务端改了东西（切档、压缩、新建会话），刷一次侧栏与缓存
    void conversations.load()
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '命令没跑起来')
  }
}

/** 命令回话里那几个"顺手要做的事"（后端 `action`，见 `_CommandResult`）。 */
function handleCommandAction(result: ChatCommandResult): void {
  const action = result.action
  if (!action) return
  if (action.kind === 'conversation' && action.conversation_id) {
    // `/new`：切到新会话（`replace` 而不是 `push`——这里不该在历史里留一条旧会话）
    void router.replace(`/chat/${action.conversation_id}`)
    return
  }
  if (action.kind === 'stop_turn') {
    // 后端已经在它那一头叫停了；这里顺手把本页这条流也断掉（谁先到不影响结果）
    abortLiveTurn()
    return
  }
  if (action.kind === 'mode') {
    // 模式被命令改了：输入框那一排的控件要跟着显示新档，否则它显示的还是旧档
    // （它自己挂在 `onMounted` 上读一次，见 ModePicker 的注释）
    window.dispatchEvent(new CustomEvent('kylab:mode-changed', { detail: action.mode }))
  }
}

/**
 * 本地消息 → 库里的形状。
 *
 * 过滤口径与 `history` 一致（失败或没吐字的助手消息不入库），但**不截断**：
 * 缓存要的是全量，`history` 只带最近几轮是因为提示词装不下。
 */
function persistedMessages(): StoredMessage[] {
  return messages.value
    .filter((item) => item.role === 'user' || (item.text.length > 0 && !item.error))
    .map((item) => ({
      id: '',
      role: item.role,
      content: item.text,
      sources: item.sources,
      // 本地缓存也带上过程与思考：缓存与网络两条路的口径要一致，
      // 否则"刚从这一页切走再切回来"与"刷新"会看到两种过程面板（v0.25）
      steps: item.steps,
      thinking: item.thinkingText,
      created_at: null,
    }))
}

/**
 * 这一轮结束了：把界面交还给库里那份（v0.41）。
 *
 * **由"当时正看着这条会话的组件"接手**，而不是"发起这一轮的那个组件"：
 * 用户切走之后发起者已经不在画面上了（它手里的 `conversationId` 甚至是空的，
 * 收尾会被静默跳过——实测踩到）。所以这里对一个**只在挂载期间有效**的 watcher 负责，
 * 见下面 `watch(() => liveTurnState.value?.streaming, ...)`。
 *
 * 没人在看的时候（用户切走了）什么都不用做：那一轮后端照样写完并落库，
 * 下次挂载会按库里的版本重画（见 `loadConversation` 里"已经写完就忘掉活轮"那一条）。
 *
 * **用户自己按的「停止」是例外**（P2-2）：被停掉的那一轮**不在库里**
 * （后端只在跑完时落库，`/stop` 那条路只往日志里补一条 `interrupted`），
 * 所以既不能把本地这半截写进缓存、也不能回源去盖掉它——后端那句
 * "已经流出来的正文会留着"说的就是屏幕上这一份。
 */
function settleTurn(): void {
  if (!conversationId.value) return
  // 这一轮刚把话说完，上下文也跟着长了一截：仪表的读数该跟着动。
  // 它只读接口、不影响下面这些收尾，所以放在最前面（被停掉的那一轮也一样要刷）
  contextGauge.value?.refresh()
  if (live.value?.stopped) return
  const id = conversationId.value
  // 先把本地这份（含刚流完的正文与过程）覆盖进缓存：后端同刻刚写完，
  // "聊完切走再切回"才不会看到上一版
  conversations.rememberDetailMessages(id, persistedMessages())
  // 再让后端校准一次（标题是首轮才生成的、条数与时间也变了），
  // 一次请求同时更新缓存与侧栏那一条
  void conversations.refreshDetail(id)
}

/** 流从"在跑"变成"没在跑"的那一刻，由**当前挂载的**这个组件收尾。 */
watch(
  () => liveTurnState.value?.streaming,
  (streaming, was) => {
    if (was === true && streaming === false) settleTurn()
  },
)

/** 用户点了「停止」：已经流出来的部分留着，它仍然是有用的。 */
function stop(): void {
  // 只叫停：状态与收尾都跟着 `useLiveTurn` 走（`streaming` 变假 → 上面的 watcher 收尾），
  // 已经流出来的部分留着——它仍然是有用的
  abortLiveTurn()
}

function nearBottom(host: HTMLElement): boolean {
  return host.scrollHeight - host.scrollTop - host.clientHeight < 80
}

function scrollToBottom(): void {
  const host = streamHost.value
  if (!host) return
  host.scrollTop = host.scrollHeight
}

/**
 * 是否持续跟随到最新一行。
 *
 * 这里必须记"用户的意图"，不能每次现算。发送那一下会同时插入提问和空的回答块，
 * 内容高度从 240px 直接涨到 842px——**在同一个更新里**，滚到底之前就已经不贴底了。
 * 于是"贴底才跟随"的判断在第一次触发时就锁成 false，之后回答写满几屏都不会再跟随
 * （实测 scrollTop 全程 0，六条引用全在可视区外）。
 *
 * 判定权因此交给滚动事件：只有用户自己往上滚才取消跟随，滚回底部自动恢复。
 */
const stick = ref(true)

function onStreamScroll(): void {
  const host = streamHost.value
  if (host) stick.value = nearBottom(host)
}

// 只在跟随状态下自动滚到底；flush: 'post' 让它在内容写入 DOM 之后执行，
// 顺带省掉一次 nextTick。往上翻看旧回答时，新字不该把视图拽走
/**
 * 这一个"内容指纹"里**必须包含过程步骤**（v0.25 修）。
 *
 * 改之前只算了 `messages.length + 正文长度 + 思考长度`，于是工具每输出一行
 * （步骤追加、某一步从 `running` 变成带 `detail`/`args`/`result` 的完成态），
 * 内容长了、视图没动——实测"输出满一屏之后就再也看不到最新的输出了"，
 * 而那时用户什么都没做，没理由取消跟随。
 *
 * 步骤是**就地更新**的（`mergeStep` 把同一个 key 的那条替换掉），所以不能只看条数：
 * 同一步从"正在检索"变成"命中 8 段"时条数没变而文本变了。
 * 这里把每条的可见文本长度加起来当指纹——它变了就说明有东西落进了画面。
 */
function streamFingerprint(): number {
  const last = messages.value.at(-1)
  if (!last) return 0
  const steps = last.steps.reduce(
    (sum, step) =>
      sum +
      step.label.length +
      step.detail.length +
      (step.args?.length ?? 0) +
      (step.result?.length ?? 0),
    0,
  )
  return messages.value.length + last.text.length + last.thinkingText.length + steps
}

// 只在跟随状态下自动滚到底；flush: 'post' 让它在内容写入 DOM 之后执行，
// 顺带省掉一次 nextTick。往上翻看旧回答时，新字不该把视图拽走
watch(
  streamFingerprint,
  () => {
    if (stick.value) scrollToBottom()
  },
  { flush: 'post' },
)

/** 回到最新一行：把"跟随"重新打开，否则下一个字又会把视图留在原地。 */
function jumpToLatest(): void {
  stick.value = true
  scrollToBottom()
}

// ------------------------------------------------------- 过程面板（参考 WeKnora）

/** 提问 + 回答配对后的渲染列表（配对逻辑见 useChatTurns，搬出去是为了能单测）。 */
const turns = computed<Turn[]>(() => buildTurns(messages.value))

/** 出错的那一轮没有过程可讲，只报错。 */
function hasTrace(message: Message): boolean {
  return message.error.length === 0
}

/**
 * 某一步的原文是否已展开。
 *
 * **默认收起**（与整块过程面板相反）：这一步是"想深究的人才点"，
 * 而入参与返回动辄上千字——默认铺开会把过程面板变成一屏 JSON，
 * 那正是我们要摆脱的东西。
 */
const openSteps = ref(new Set<string>())

/**
 * 哪几"组"（同类工具合并出来的那一行）是展开的（v0.26）。
 *
 * 与 `openSteps` **分开两张表**：一个是"看某一步的原文"，一个是"看这一组都有哪些调用"，
 * 两者同时开着是正常的（展开一组、再展开其中一次）。合成一张的话，
 * 收起一组就得连带把里面每一次的展开态一起清掉。
 */
const openGroups = ref(new Set<string>())

function isGroupOpen(key: string): boolean {
  return openGroups.value.has(key)
}

function toggleGroup(key: string): void {
  const next = new Set(openGroups.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  openGroups.value = next
}

/**
 * 每一轮"多画了几页"（P2-1 的第一级懒加载，见 `TRACE_PAGE_SIZE`）。
 *
 * 按**轮次下标**记而不是按内容：内容会随流式增长，记内容就要跟着它一起搬。
 * 收起面板再打开时这一份不清——用户点过「加载更多」，再看一眼不该又缩回去。
 */
const traceExtraPages = ref(new Map<number, number>())

/** 这一轮**这一屏**要画什么（条目、已显示、总数、还剩多少）。 */
function traceView(turnIndex: number, turn: Turn): TracePage {
  // 模板里会调两次（一次画条目、一次画那行计数）：都是纯计算，而且
  // 同一轮里最多几十步——为省这点开销再引入一层缓存，得不偿失
  const pages = 1 + (traceExtraPages.value.get(turnIndex) ?? 0)
  return tracePage(turn, TRACE_PAGE_SIZE * pages)
}

function showMoreTrace(turnIndex: number): void {
  const next = new Map(traceExtraPages.value)
  next.set(turnIndex, (next.get(turnIndex) ?? 0) + 1)
  traceExtraPages.value = next
}

/**
 * 打开文件抽屉：``key`` 为空就是浏览文件区，给了就直接预览那一份（v0.26）。
 *
 * **产物卡片点开走这里，而不是直接下载**：用户想知道"它做出来的是个什么"，
 * 而下载是"我要拿走它"——两件事，前者先发生。下载在抽屉里一步可达。
 */
const fileDrawer = ref<{
  key: string | null
  /** 产物那份的名字与格式：key 是 artifact_id 时抽屉猜不出扩展名（见 `openFiles`） */
  seed: { name: string; kind: string } | null
  nonce: number
} | null>(null)

function openFiles(key: string | null = null, seed?: { name: string; kind: string }): void {
  if (!conversationId.value) return
  // `nonce` 让"抽屉已经开着"时再点一次也能真的重来一遍：
  // 只改 `key` 的话，从目录里点「浏览文件」（key 从 null 到 null）不会触发任何变化，
  // 用户看到的是**什么都没发生**——而他刚刚明明点了一下。
  // 名字与格式跟着 key 一起带过去：产物在临时区的 key 是 artifact_id，
  // 抽屉光看它猜不出该用哪个渲染器（见 FileDrawer.initialEntry）
  fileDrawer.value = { key, seed: seed ?? null, nonce: Date.now() }
}

/** 正在挑知识库的那份产物（点「存进知识库」之后）。``null`` = 弹窗没开。 */
const ingestTarget = ref<ChatArtifact | null>(null)
const ingestKbId = ref('')
const ingesting = ref(false)

/**
 * 「存进知识库」。
 *
 * **这个按钮是"显式"二字最实在的落点**：模型那把 `ingest_artifact` 工具要靠
 * 描述约束它别自作主张，而用户自己点一下不需要任何约束——它就是他本人的意思。
 */
async function confirmIngest(): Promise<void> {
  const file = ingestTarget.value
  const id = conversationId.value
  if (!file || !id || !ingestKbId.value) return
  ingesting.value = true
  try {
    const updated = await ingestArtifact(id, file.artifact_id, ingestKbId.value)
    mergeArtifact(fromStored(updated))
    ingestTarget.value = null
    notifySuccess(`已存进知识库「${kbName(updated.knowledge_base_id ?? '')}」`)
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '入库失败')
  } finally {
    ingesting.value = false
  }
}

/**
 * 库里那个名字。**查不到就给空串，不编一个"知识库"出来**。
 *
 * 库是可以被删的，而卡片上那句话会一直留着——兜底成"已存进知识库「知识库」"
 * 读起来像个坏掉的模板（实测见过）。空串让模板退化成"已存进知识库"，
 * 少一句名字，但每句都是真的。
 */
function kbName(kbId?: string): string {
  return store.items.find((item) => item.id === kbId)?.name ?? ''
}

function openIngest(file: ChatArtifact): void {
  ingestTarget.value = file
  // 预选当前会话范围里的第一个库——**预选不等于替他决定**：弹窗在那儿、
  // 库名看得见，他点了确认才算数
  ingestKbId.value = file.knowledge_base_id || effectiveKbIds.value[0] || store.items[0]?.id || ''
  // **每次都刷一遍清单**（不只是空的时候）：这个弹窗的全部意义就是"让你挑一个库"，
  // 而清单可能已经变了（刚建过一个库、或者模型刚建过）。给一份过期的清单让他挑，
  // 比多一次请求糟得多。
  void store.load()
}

/**
 * 把一份产物**最新的样子**合并回它所在的步骤（按 `artifact_id`）。
 *
 * 界面上的卡片是从步骤快照渲染的，而快照是流式当时写下的。入库发生在之后，
 * 不合并的话，卡片上那句"已存进知识库"要等到刷新页面才出现——
 * 而它恰恰是用户点完按钮最想看到的一句反馈。
 *
 * **只在已有的卡片上改，不新增**：列表接口会带回这条会话的全部产物，
 * 包括被「重新生成」回退掉的那几轮——凭空多出来的卡片会让人以为文件还在。
 */
function mergeArtifact(patch: Partial<ChatArtifact> & { artifact_id: string }): void {
  for (const message of messages.value) {
    for (const step of message.steps) {
      if (!step.artifacts) continue
      step.artifacts = step.artifacts.map((item) =>
        item.artifact_id === patch.artifact_id ? { ...item, ...patch } : item,
      )
    }
  }
}

/**
 * 接口返回的产物 → 步骤快照里那份的形状。
 *
 * 差别只在空值：后端（Pydantic）把没入库的字段序列化成 ``null``，
 * 而快照里那些键**根本不存在**。不归一的话，`{...item, ...patch}` 会把
 * 原本有值的键覆盖成 null（`null` 与 `undefined` 在展开时都是"有值"）。
 */
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

function isStepOpen(key: string): boolean {
  return openSteps.value.has(key)
}

function toggleStep(key: string): void {
  const next = new Set(openSteps.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  openSteps.value = next
}

/**
 * 过程面板的**默认展开态**（P2-1）：记的是"用户上一次把面板收起来还是打开"。
 *
 * 之所以要有它，而不是把面板改成默认折叠：调研报告抄的是 DSH 的"过程折叠、
 * 最终答案常显"，但那会推翻 v0.25 那次刻意选择（用户当时要的是**照 Kimi**：
 * 过程常驻在正文里）。所以这里只做一半：**默认不变（展开）**，
 * 用户自己收起过之后就按他那一档来（`写进 localStorage`，刷新与切会话都还在）。
 */
const traceOpenMemory = ref<boolean | undefined>(readTraceOpenMemory())

/** 面板此刻该不该展开：这一轮自己的态优先，其次才是"用户上次那一档"。 */
function traceOpened(message: Message): boolean {
  return isTraceOpen(message, traceOpenMemory.value ?? true)
}

function toggleTrace(turn: Turn): void {
  const message = turn.reply
  if (!message) return
  message.traceOpen = !traceOpened(message)
  // **收起态可记忆**：点这一下的意思不只是"这一轮收起来"，还有"以后别默认摊开"
  traceOpenMemory.value = message.traceOpen
  writeTraceOpenMemory(message.traceOpen)
}

// ------------------------------------------------------- 消息操作（v17）

/** 刚复制过的那条（`"${turn}:${role}"`）。给按钮一个"已复制"的即时反馈。 */
const copiedKey = ref('')
let copiedTimer: number | undefined

/**
 * 复制一条消息的正文。
 *
 * 复制的是**原文**（Markdown 源文本）而不是渲染后的文字：用户多半要粘到别处，
 * 而带 `**` 与 `[1]` 的原文在其它 Markdown 环境里仍然成立；
 * 复制渲染后的纯文本会把结构丢掉，反而不可用。
 */
async function copyMessage(turnIndex: number, message: Message): Promise<void> {
  const key = `${turnIndex}:${message.role}`
  if (await copyText(message.text)) {
    copiedKey.value = key
    window.clearTimeout(copiedTimer)
    copiedTimer = window.setTimeout(() => {
      if (copiedKey.value === key) copiedKey.value = ''
    }, 1600)
    return
  }
  // 连兜底那条路都没成：如实说，别假装复制成功
  notifyError('复制失败，请手动选中后复制')
}

const regenerating = ref(false)

/** 已存过笔记的轮次（`turnIndex`）：按钮据此显示"已存"。 */
const savedTurns = ref<Set<number>>(new Set())

/**
 * 把一轮问答存成一条笔记（`source_kind='chat'`）。
 *
 * 内容用 Markdown 记：标题是提问、正文是回答。存完不跳页——用户的注意力还在对话上，
 * 侧栏的「笔记」入口自然会多出一条。
 */
async function saveAsNote(turnIndex: number, turn: Turn): Promise<void> {
  const question = (turn.user?.text ?? '').trim()
  const answer = (turn.reply?.text ?? '').trim()
  if (!answer) {
    notifyWarning('这条回答还没有内容')
    return
  }
  try {
    await notes.create({
      title: question.slice(0, 80) || '来自对话的笔记',
      // 正文只放回答：提问已经在标题里了，再写成一级标题会在文档里重复一遍
      content_md: answer,
      source_kind: 'chat',
      source_ref: conversationId.value || null,
    })
    savedTurns.value = new Set(savedTurns.value).add(turnIndex)
    notifySuccess('已存为笔记，可在侧栏「笔记」里查看')
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '存为笔记失败')
  }
}

/**
 * 重新生成最后一条回答。
 *
 * 两步：**先把会话退回到提问之前**（后端删掉那一轮），再原样重发那句提问——
 * 重发走的是正常提问链路，所以不存在"第二条生成实现"。
 *
 * 为什么不是"让后端重跑一次"：回答是流式的，重试/中断/落库的时序都在前端这条链路上，
 * 后端再实现一遍只会让两边行为分叉。
 *
 * 回退是**服务端已删、本地才跟上**的顺序：反过来（先清本地再调接口）在接口失败时
 * 会留下一段"界面上没有、库里还有"的错位，而重发会把它变成重复的提问。
 */
async function regenerate(turnIndex: number): Promise<void> {
  const turn = turns.value[turnIndex]
  const id = conversationId.value
  if (!turn?.user || !id || regenerating.value || sending.value) return
  const query = turn.user.text
  const context = history.value
  const model = modelPk.value || undefined
  regenerating.value = true
  try {
    await rewindConversation(id, 1)
    // 本地同步回退：把这一轮从界面上摘掉（连同它后面的所有轮次）
    messages.value = messages.value.slice(0, turnIndex * 2)
    await streamTurn(query, context, model, id)
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '重新生成失败')
    // 回退可能已经成功、重发失败：以库里的状态为准重新装载，别让界面与库里错位
    void loadConversation()
  } finally {
    regenerating.value = false
  }
}

const resuming = ref(false)

/**
 * **继续**上一轮（v0.32）：接着把没做完的那一轮做完，而不是重发一遍。
 *
 * 与「重新生成」的区别是这一件事：`regenerate` 会**先回退一轮再重发**，
 * 于是已经查到的资料、已经写了一半的正文全都丢掉重来（那是真花钱的）；
 * 续跑把那些交给模型接着用，用户看到的是**同一轮被补完**。
 *
 * 界面上因此只做两件事：把这条回答的正文与错误清掉（步骤留着——服务端会把
 * 上一轮那些步骤与这一轮新的拼在一起，客户端这边保持同一形状），
 * 然后把事件打进**同一条消息**（不是新开一条）。
 */
async function resumeTurn(turnIndex: number): Promise<void> {
  const turn = turns.value[turnIndex]
  const id = conversationId.value
  const reply = turn?.reply
  if (!reply || !id || resuming.value || sending.value || regenerating.value) return
  // 端点续的是**最后一轮**（会话里最后一条回答）：不是最后一轮就不该有这个按钮，
  // 真点了也不装作能续
  if (turnIndex !== turns.value.length - 1) return
  const index = messages.value.indexOf(reply)
  if (index < 0) return

  resuming.value = true
  patchMessage(index, { text: '', error: '', streaming: true })
  // 与发送同一条纪律（v0.41）：流归 `useLiveTurn` 管，切页不丢。
  // `mode: 'patch'` 表示改的是**这一条已有的回答**，回来重放时不该补新的一轮。
  await startResumeTurn(
    id,
    { skill_names: pinnedSkills.value },
    { thinking: { enabled: thinkingOn.value, effort: thinkingEffort.value } },
  )
  resuming.value = false
}

/**
 * 改某一条消息（按索引就地改）。
 *
 * `streamTurn` 里那份 `patch` 是它自己的闭包（绑定"这一轮新建的那条"），
 * 而续跑要改的是**已经存在**的那条，所以这里按索引来。
 */
function patchMessage(index: number, part: Partial<Message>): void {
  const current = messages.value[index]
  if (!current) return
  Object.assign(current, part)
}

/** 正在闪的引用（`"${turn}:${index}"`）。点行内徽标时用它把视线引过去。 */
const flashCite = ref('')
let flashTimer: number | undefined

function onReplyClick(event: MouseEvent, index: number): void {
  const target = event.target instanceof Element ? event.target : null
  if (target && target.closest('[data-copy-code], [data-copy-table], [data-download-table]')) {
    event.preventDefault()
    void handleBlockAction(target)
    return
  }
  const chip = citeChipOf(event.target)
  if (!chip) return
  event.preventDefault()
  void revealSource(index, chip)
}

/* ---------------------------------------------------------------- 代码块 / 表格的按钮
   这两个按钮是 `v-html` 渲染出来的（`useMarkdown` 里拼的字符串），**绑不上 Vue 事件**。
   给每块代码渲染后再遍历一遍 DOM 挂监听也不划算——回答是流式的，每来一段就要重挂。
   所以走**事件委托**：判断点在谁身上，再从 DOM 里取内容。
   它挂在 `.turn` 的 click 上（`onReplyClick`）——那本来就是这一块唯一的委托入口。 */

const copiedBlock = ref('') // 刚复制过的那一块，用于把图标换成"已复制"
let copiedBlockTimer = 0

/** 复制成功的反馈与消息级的复制按钮同一套：短暂显示、之后自己消失。 */
function flashBlock(el: Element): void {
  const key = Math.random().toString(36).slice(2)
  el.setAttribute('data-copied', key)
  copiedBlock.value = key
  window.clearTimeout(copiedBlockTimer)
  copiedBlockTimer = window.setTimeout(() => {
    el.removeAttribute('data-copied')
    if (copiedBlock.value === key) copiedBlock.value = ''
  }, 1600)
}

/**
 * 表格 → CSV。
 *
 * **必须带 BOM**：Excel 打开不带 BOM 的 UTF-8 CSV 会把中文读成乱码，
 * 而"导出给别人用 Excel 打开"正是这个按钮唯一的用途。
 * 字段里的引号按 CSV 规矩翻倍，含逗号/引号/换行的字段整体加引号。
 */
function tableToCsv(table: HTMLTableElement): string {
  const cellText = (cell: Element) => (cell.textContent ?? '').replace(/\s+/g, ' ').trim()
  const rows = Array.from(table.querySelectorAll('tr')).map((row) =>
    Array.from(row.querySelectorAll('th, td')).map((cell) => {
      const value = cellText(cell)
      return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
    }),
  )
  return rows.map((row) => row.join(',')).join('\r\n')
}

function downloadTable(el: Element): void {
  const table = el.closest('.md-table-block')?.querySelector('table')
  if (!table) return
  // BOM + CSV。文件名给一个能认出来的默认值，用户不用改名就能存下多张
  const blob = new Blob(['﻿' + tableToCsv(table)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `表格-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`
  link.click()
  URL.revokeObjectURL(url)
}

/**
 * 代码块 / 表格的复制。
 *
 * 两道兜底写在 `composables/clipboard.ts` 里（异步 API 失焦就失败，退到
 * `execCommand`）；这里只管两件收场的事：成功换对勾，失败**替用户选中**。
 *
 * 选中之后这一下的结局就定了——复制是浏览器自己的本地操作，不再经过任何权限，
 * 用户按一下 Ctrl+C 必然拿到。所以提示语说的是"已替你选中"，而不是
 * "请手动选中后复制"：后者是把用户刚才白做的那件事原样退回给他。
 */
async function copyBlock(text: string, node: Element | null, button: Element): Promise<void> {
  if (await copyText(text)) {
    flashBlock(button)
    return
  }
  if (selectNode(node)) {
    notifyWarning('已替你选中，按 Ctrl+C 复制')
    return
  }
  notifyError('复制失败，请手动选中后复制')
}

/**
 * 代码块 / 表格上的按钮。返回 `true` 表示这一下已经被处理掉了。
 *
 * 代码块里**没有**"下载"：代码下载成 .txt 不如直接复制——真正想要文件的人
 * 要的是"存成一个能跑的脚本"，那需要知道扩展名与编码，属于另一个决定。
 */
async function handleBlockAction(target: Element): Promise<boolean> {
  const copyCode = target.closest('[data-copy-code]')
  if (copyCode) {
    // 只取 `pre` 的文本：语言名在头部带里，不该被带进剪贴板。
    // 用 `textContent` 而不是 `innerText`：要的是**原文**，而 `innerText` 是
    // 渲染结果的视图（受 `display` 影响、按排版归一空白）。代码块要的就是原文。
    const pre = copyCode.closest('.md-code')?.querySelector('pre') ?? null
    await copyBlock(pre?.textContent ?? '', pre, copyCode)
    return true
  }
  const copyTable = target.closest('[data-copy-table]')
  if (copyTable) {
    const table = copyTable.closest('.md-table-block')?.querySelector('table')
    if (!table) return true
    // 表格进剪贴板用**制表符分隔**而不是 CSV：粘进 Excel / 飞书表格时
    // 它会被直接拆成单元格，而 CSV 粘过去是一整行纯文本
    const rows = Array.from(table.querySelectorAll('tr')).map((row) =>
      Array.from(row.querySelectorAll('th, td'))
        .map((cell) => (cell.textContent ?? '').replace(/\s+/g, ' ').trim())
        .join('\t'),
    )
    await copyBlock(rows.join('\n'), table, copyTable)
    return true
  }
  const download = target.closest('[data-download-table]')
  if (download) {
    downloadTable(download)
    return true
  }
  return false
}

/** 键盘与鼠标走同一条路：徽标是 `role="button"`，Enter / 空格都得能用。 */
function onReplyKeydown(event: KeyboardEvent, index: number): void {
  if (event.key !== 'Enter' && event.key !== ' ') return
  const chip = citeChipOf(event.target)
  if (!chip) return
  event.preventDefault()
  void revealSource(index, chip)
}

function citeChipOf(target: EventTarget | null): number | null {
  const element = target instanceof Element ? target.closest('[data-cite-index]') : null
  const value = Number(element?.getAttribute('data-cite-index'))
  return Number.isInteger(value) ? value : null
}

/**
 * 出处列表默认只铺**前几条**（v0.41，用户报的第 13 条）。
 *
 * 原来它是整段铺开的：一次检索命中上百个片段时，回答下面会接一条比回答还长的
 * 出处墙——用户的原话是"导致很长的会话"。**不是把它藏起来**：
 * 前几条照旧永远显示（回答有没有依据是这一页存在的理由），多出来的折成一行
 * 「还有 N 条」，要看再点开。点行内徽标 [n] 落到折叠区里的那一条时会自动展开
 * （见 `revealSource`），否则会滚到一个不存在的节点上。
 */
const CITE_FOLD_LIMIT = 3
const expandedCites = ref<Set<number>>(new Set())

function citesExpanded(turnIndex: number): boolean {
  return expandedCites.value.has(turnIndex)
}

function toggleCites(turnIndex: number): void {
  const next = new Set(expandedCites.value)
  if (next.has(turnIndex)) next.delete(turnIndex)
  else next.add(turnIndex)
  expandedCites.value = next
}

/** 这一轮眼下要渲染哪几条出处。 */
function shownSources(turnIndex: number, sources: ChatSource[]): ChatSource[] {
  return citesExpanded(turnIndex) ? sources : sources.slice(0, CITE_FOLD_LIMIT)
}

/**
 * 点行内引用徽标：展开过程面板 → 滚到那一条出处 → 闪一下。
 *
 * 三步缺一不可：只展开不滚，用户还得自己在面板里找"3 是哪个"；
 * 只滚不闪，视线跟丢（面板里每条的排版几乎一样）。徽标的形状与出处列表的
 * 编号一致，所以"闪"这一步要落在编号上，不是整张卡片。
 */
async function revealSource(turnIndex: number, sourceIndex: number): Promise<void> {
  const turn = turns.value[turnIndex]
  if (!turn?.reply || !Number.isInteger(sourceIndex)) return
  turn.reply.traceOpen = true
  // 那一条可能在折叠区里：不先展开就会滚到一个不存在的节点上（点了像没反应）
  if (!citesExpanded(turnIndex)) toggleCites(turnIndex)
  flashCite.value = `${turnIndex}:${sourceIndex}`
  await nextTick()
  const host = streamHost.value
  const article = host?.querySelectorAll('.turn')[turnIndex]
  article
    ?.querySelector(`[data-source="${sourceIndex}"]`)
    ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  window.clearTimeout(flashTimer)
  flashTimer = window.setTimeout(() => {
    if (flashCite.value === `${turnIndex}:${sourceIndex}`) flashCite.value = ''
  }, 1400)
}

// ------------------------------------------------------------------ 对话模型（v12）

const registry = computed(() => registryStore.registry)
/** 是否已经拿到过注册表。没拿到之前不显示"未配置对话模型"——那会把加载中误报成没配。 */
const modelsLoaded = computed(() => registryStore.loaded)
/** 当前选用的注册模型 pk；空串 = 交给后端的全局默认。 */
const modelPk = ref(readStored(LAST_MODEL_KEY))

/**
 * 可对话的模型。口径在 store 的 `chatModels` getter 里——
 * 「知识库设置 → 推荐问题」的"出题模型"用的是同一个筛选，两处各写一份迟早会漂。
 */
const chatModels = computed<RegisteredModel[]>(() => registryStore.chatModels)

/**
 * 只显示模型名，不带供应商。
 *
 * 输入框的宽度有限，而"是哪一家"在设置 → 模型注册里看得到；把
 * `deepseek-flash · 深度求索` 塞进 200px 的控件里，真正要认的模型名反而被挤掉。
 */
const modelOptions = computed(() =>
  chatModels.value.map((model) => ({
    value: model.id,
    label: model.label || model.model_id,
  })),
)

/**
 * 下拉占位文案。
 *
 * **加载中与"没配置"必须分开说**：注册表回来之前显示"未配置对话模型"，
 * 会让每次进页面都闪一下一个并不成立的状态（实测 430ms），
 * 看起来像模型名在闪烁、也像配置丢了。
 */
const modelPlaceholder = computed(() => {
  if (!modelsLoaded.value) return '默认模型'
  return modelOptions.value.length === 0 ? '未配置对话模型' : '默认模型'
})

async function loadModels(): Promise<void> {
  await registryStore.load()
  ensureModelSelection()
}

/**
 * 选一个默认模型。优先级：**会话已存的（由 loadConversation 写入）> 本地上次选择 >
 * 注册表里绑定给 chat 的全局默认 > 第一个可用**。与 WeKnora 的默认口径一致，
 * 多一档"会话已存"是因为我们把选择随会话保存了（v12）。
 */
function ensureModelSelection(): void {
  if (modelPk.value && chatModels.value.some((item) => item.id === modelPk.value)) return
  const bound = registry.value?.slots.find((slot) => slot.slot === 'chat')?.bound_model_pk ?? ''
  const remembered = readStored(LAST_MODEL_KEY)
  const candidate = [bound, remembered].find(
    (value) => value && chatModels.value.some((item) => item.id === value),
  )
  modelPk.value = candidate ?? chatModels.value[0]?.id ?? ''
}

/** 读一条本机偏好。隐私模式（localStorage 抛错）下当作没有。 */
function readStored(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // 隐私模式：不记忆即可
  }
}

// 记住这次选的：换个会话/刷新之后仍然用它（"这台机器上次用的那个"）
watch(modelPk, (value) => {
  if (value) writeStored(LAST_MODEL_KEY, value)
})

// ------------------------------------------------------------------ 思考模式（v16）

/**
 * 思考开关与强度。
 *
 * **默认开**：主流对话模型默认都思考，关掉是例外。用户在这里改的选择会随会话
 * 保存（与模型选择同一套口径），本机另存一份作为**新建会话**时的默认。
 *
 * 这两个值只影响"这一轮怎么问"：真正翻译成哪家的字段（DeepSeek 的
 * ``thinking.type``、Qwen 的 ``enable_thinking``…）由后端按供应商方言决定。
 */
const thinkingOn = ref(readStored(LAST_THINKING_KEY) !== 'false')
const thinkingEffort = ref<ThinkingEffort>(readStoredEffort())

function readStoredEffort(): ThinkingEffort {
  const raw = readStored(LAST_EFFORT_KEY)
  return THINKING_EFFORTS.find((item) => item.value === raw)?.value ?? 'medium'
}

watch(thinkingOn, (value) => writeStored(LAST_THINKING_KEY, value ? 'true' : 'false'))
watch(thinkingEffort, (value) => writeStored(LAST_EFFORT_KEY, value))

/** ModelPicker 回传的是 string；收进三档联合类型，非法值退回默认。 */
function onEffortChange(value: string): void {
  thinkingEffort.value = THINKING_EFFORTS.find((item) => item.value === value)?.value ?? 'medium'
}

// ------------------------------------------------------------------ 示例问题

/**
 * 静态样例：**语料生成拿不到时的兜底**。
 *
 * 不按知识库内容生成的问题容易"点了答不上来"，所以它只做兜底；真正展示的是
 * 后端依据所选库的原文生成的建议（见 `api/chat.ts::getSuggestedQuestions`）。
 * 这一池子刻意选"对任何语料都成立"的问法。
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

const sampleOffset = ref(0)
const staticSamples = computed(() =>
  Array.from(
    { length: Math.min(SAMPLE_COUNT, STATIC_SAMPLES.length) },
    (_, index) => STATIC_SAMPLES[(sampleOffset.value + index) % STATIC_SAMPLES.length],
  ),
)

const suggested = ref<string[]>([])
const samplesLoading = ref(false)
/** 有生成结果就用它，否则用静态兜底。 */
const samples = computed(() => (suggested.value.length > 0 ? suggested.value : staticSamples.value))

/**
 * 要不要显示推荐问题（v0.19，用户指定）。
 *
 * **没有选中知识库时整块不显示**：推荐问题是"从库里的语料出题"抽出来的，
 * 没有库就没有依据——那时给一排样例是在暗示"随便点一个"，点了也答不出东西。
 * 关掉开关、或开着但一个库都没勾，都算"没选中"。
 *
 * 注意这与"库里有题但是空的"不同：那种情况仍然显示这块（下面会有静态兜底），
 * 因为那时**确实**选定了范围，只是这个库还没出过题。
 */
const showSamples = computed(() => effectiveKbIds.value.length > 0)

let samplesTimer: number | undefined

/** 只在"空状态 + 至少选了一个库"时才去生成；有消息之后它是纯浪费。 */
function scheduleSamples(): void {
  window.clearTimeout(samplesTimer)
  if (messages.value.length > 0 || effectiveKbIds.value.length === 0) {
    suggested.value = []
    return
  }
  samplesTimer = window.setTimeout(() => void loadSamples(), 400)
}

async function loadSamples(): Promise<void> {
  // 示例问题是从库里的分段出题结果抽的，所以**关掉知识库就没有语料**——
  // 与"没选库"同一处理，不去请求（请求也会是空集）
  if (messages.value.length > 0 || effectiveKbIds.value.length === 0) return
  samplesLoading.value = true
  try {
    // **只传库**：问题取自库里入库时生成的（v23），不再现场调模型，
    // 所以既没有 limit（那是"每段生成几条"，属于库设置）也没有 model_pk。
    // 读端每次都重新随机抽样，所以"换一批"什么都不用传
    const result = await getSuggestedQuestions(effectiveKbIds.value)
    suggested.value = result.questions
  } catch {
    // 生成只是引导：失败就回退静态样例，别把空状态变成错误提示
    suggested.value = []
  } finally {
    samplesLoading.value = false
  }
}

/** 「换一批」：库里有问题时重新抽一批；否则只是轮换静态样例。 */
function shuffleSamples(): void {
  if (suggested.value.length > 0) {
    void loadSamples()
    return
  }
  sampleOffset.value = (sampleOffset.value + SAMPLE_COUNT) % STATIC_SAMPLES.length
}

// 换库/换模型会改变"依据什么语料"，示例问题跟着重算（防抖在 scheduleSamples 里）
watch(
  () => [selected.value.join(','), modelPk.value, messages.value.length].join('|'),
  () => scheduleSamples(),
)

/** 点示例问题：填进输入框；能发就直接发——这一步本来就是"照着问"。 */
function useSample(question: string): void {
  query.value = question
  // 能发就直接发——这一步本来就是"照着问"。用 `canSend` 而不是"选了库"：
  // 关掉知识库时同样该能一键问出去
  if (canSend.value && !sending.value) void send()
}

// ------------------------------------------------------------------ 提示词

/**
 * 引用原文弹窗：出处卡片上只显示 120 字（见 CITE_PREVIEW_CHARS），
 * 但"这段到底怎么说的"往往要看全——否则用户还得跳去文档页再找回来。
 * 所以给一个就地看全文的入口。
 *
 * **没有做"高亮被引段落"**：那需要命中片段在原文里的字符区间，而我们只存了
 * chunk 文本本身（`preview`）。要做就得在切块时记录偏移并落库——那是另一件事，
 * 记在《开发计划》§12.76 里，不假装做了。
 */
const sourceOpen = ref(false)
const activeSource = ref<ChatSource | null>(null)

function openSource(source: ChatSource): void {
  activeSource.value = source
  sourceOpen.value = true
}

/**
 * 引用文档抽屉（v18）：**在对话页就地看原文**，而不是跳去知识库页。
 *
 * 原来的做法是把用户送到 `/kb/:id?doc=…&page=…`——那会离开对话、丢掉正在读的回答上下文，
 * 而"这句结论出自哪一段"本来是看回答时顺手一瞥的动作。抽屉从右侧盖上来，
 * 关掉就回到原来那条回答（滚动位置、展开的过程面板都还在）。
 *
 * 整条 `source` 存下来而不是只存 id：页码要一起带过去（引用指向第 2 页，就该打开第 2 页）。
 */
const readerSource = ref<ChatSource | null>(null)

function openReader(source: ChatSource): void {
  readerSource.value = source
}

function closeReader(): void {
  readerSource.value = null
}

/*
 * 这里原本是「提示词」那一套（弹窗 + 读写全局设置 `chat.system_prompt`）。
 * v0.19 整块搬到**知识库**上：那段文字实质是"这份资料该怎么被使用"，
 * 随资料走而不是随界面走——换个库还留着上一个库的规矩，是原先那个位置解释不了的。
 * 现在它在「知识库 → 设置 → 回答要求」里配，也可以让模型按文档摘要生成一版。
 * 对话页不再有提示词入口，也不再有"这段文字拼在最前面"这类只有实现者才关心的话。
 */
</script>

<template>
  <div class="chat" :class="{ 'chat-centered': isWelcome }">
    <!-- 消息区自己滚：输入卡片要一直停在视野里，不能跟着回答一起被顶下去 -->
    <div ref="streamHost" class="chat-scroll" @scroll.passive="onStreamScroll">
      <div
        class="chat-inner"
        :class="{ 'chat-inner-welcome': messages.length === 0 && !pendingEntry }"
      >
        <!-- 还没决定显示哪条对话（解析入口 / 回放会话）时给骨架屏。
             只画有把握的结构、不画"空对话"的欢迎层，也别让人干等一屏白：
             会话正文要等一次网络往返，这段空档是"点进来空白一下"的来源。 -->
        <div v-if="messages.length === 0 && pendingEntry" class="chat-loading">
          <SkeletonBlock variant="list" :rows="4" />
        </div>

        <!-- 空状态：品牌标 + 示例问题（参考 Kimi 的欢迎层：一行大标识、不说话）。
             有消息之后整块消失，让位给正文——它不是常驻装饰。
             `pendingEntry` 期间不画：那时还没决定该显示哪条对话（见 resolvingEntry）。 -->
        <div v-else-if="messages.length === 0" class="welcome">
          <!--
            **字标替掉了原来那句「Hi，我是 KYLAB，让你的知识触手可及」**（v0.25，
            用户指定：把侧栏的字标搬到这里）。两处理由：

            1. 那句话是**自我介绍**，而进入这一页的人已经知道自己在用什么——
               它占着整页最贵的一块位置说一件已知的事。Kimi 的空态只有一个 KIMI 字标。
            2. 侧栏那一格只有 24px 宽，字标在那里既读不出来、又跟导航抢宽度。
               字标挪到这里，侧栏只留行星标，两边都松了。

            下面那行标语留着：它是品牌定位，不是"这一页是什么"的解释性小字
            （规范 §5.1 禁的是后者）。嫌多的话说一声，删掉就是一行的事。
          -->
          <IconLogo :size="34" />
          <p class="welcome-tagline">让你的知识触手可及</p>
          <!--
            推荐问题整块**跟着"有没有选中知识库"出现/消失**（v0.19，用户指定）。
            用 `<Transition>` 而不是 v-if 直接摘掉：勾上库的那一刻它才出现，
            硬切会像"页面抖了一下"；这里给它一段淡入 + 轻微上浮，
            并且**逐条错位**出现——一排同时亮起来更像加载动画。
          -->
          <Transition name="samples">
            <div v-if="showSamples" class="welcome-samples">
              <div class="welcome-sub">
                <span>你可以这样问我</span>
                <button
                  type="button"
                  class="welcome-refresh"
                  aria-label="换一批示例问题"
                  title="换一批"
                  :disabled="samplesLoading"
                  @click="shuffleSamples"
                >
                  <IconRefresh :size="14" />
                </button>
              </div>
              <div class="samples" :class="{ 'samples-loading': samplesLoading }">
                <button
                  v-for="(sample, index) in samples"
                  :key="sample"
                  type="button"
                  class="sample"
                  :style="{ '--sample-index': index }"
                  @click="useSample(sample)"
                >
                  {{ sample }}
                </button>
              </div>
            </div>
          </Transition>
          <!-- 一个库都没有时，提问无从谈起：指路比给一排点了没反应的样例好 -->
          <RouterLink v-if="store.items.length === 0" class="welcome-guide" to="/knowledge-bases">
            还没有知识库，先去建一个并上传文档
          </RouterLink>
        </div>

        <div
          v-for="(turn, turnIndex) in turns"
          :key="turnIndex"
          class="turn"
          @click="onReplyClick($event, turnIndex)"
          @keydown="onReplyKeydown($event, turnIndex)"
        >
          <!-- 提问：右侧气泡（参考 WeKnora）。不再有"我的问题"这类标签——
               位置与形状已经说明了它是谁说的，多一行小字只是噪声 -->
          <div v-if="turn.user" class="ask">
            <p class="ask-text">{{ turn.user.text }}</p>
            <!-- 提问也能复制：用户常常要把同一个问题拿去别处问 -->
            <button
              type="button"
              class="ask-copy"
              :aria-label="copiedKey === `${turnIndex}:user` ? '已复制提问' : '复制提问'"
              :title="copiedKey === `${turnIndex}:user` ? '已复制' : '复制'"
              @click="copyMessage(turnIndex, turn.user)"
            >
              <IconCopy :size="13" />
            </button>
          </div>

          <div v-if="turn.reply" class="reply">
            <!-- 头像在左边那条沟槽里；正文与它下面的动作都归右边那一列 -->
            <span class="reply-avatar" aria-hidden="true">
              <IconLogo variant="mark" :size="22" />
            </span>
            <div class="reply-body">
              <p v-if="turn.reply.error" class="reply-error">{{ turn.reply.error }}</p>

              <template v-else>
                <!-- 依据摘要：这一行的数字就是"这句回答有没有出处"的答案。
                   展开才是过程与来源 -->
                <button
                  v-if="hasTrace(turn.reply)"
                  type="button"
                  class="trace-head"
                  :aria-expanded="traceOpened(turn.reply)"
                  @click="toggleTrace(turn)"
                >
                  <IconChevronRight
                    class="trace-caret"
                    :class="{ 'trace-caret-open': traceOpened(turn.reply) }"
                    :size="14"
                  />
                  <!-- 流式时这一行是**滚动的实时状态**（v0.27，照 DeepSeek 的 harness）：
                       工具在跑就报工具名，思考在写就给它最新的那一截，
                       始终只占一行——见 `liveLine`。 -->
                  <LiveLine
                    v-if="turn.reply.streaming"
                    class="trace-summary trace-live"
                    :text="liveLine(turn.reply)"
                  />
                  <span v-else class="trace-summary">{{ traceSummary(turn.reply) }}</span>
                </button>

                <!--
                折叠区用 `v-if` 而不是 `v-show`：这一块装着步骤、思考全文与每条出处的
                正文预览，`v-show` 会让**每一轮**的这些都留在文档里——聊到几十轮时
                它们只是被 CSS 藏起来，DOM 节点、文本与布局开销一直在。
                没有 `v-show` 就没有关闭动画的损失：这块本来就没有过渡（只有标题上
                那个箭头的 transform）。
              -->
                <div v-if="traceOpened(turn.reply)" class="trace">
                  <!-- 过程时间线：只列真发生过的步骤 -->
                  <!--
                    过程时间线：只列真发生过的步骤。

                    **同类工具并成一行**（v0.26，用户要求"参考 Web Search 的做法"）：
                    实测一个回合里联网搜索 7 次 + 抓取网页 2 次（交替出现），
                    不并就是九行几乎一样的东西，扫过去只看到"它查了很多次"。
                    并完两行，点开才是每一次的结论与原文——**合并的是入口，不是信息**。
                    分组规则在 `traceEntries` 里（只并同一块内、按首次出现排、
                    只调用一次的不并）。
                  -->
                  <ol class="steps">
                    <template v-for="entry in traceView(turnIndex, turn).entries" :key="entry.key">
                      <!-- 一组：一个入口 + 次数，点开看这一组的每一次调用 -->
                      <li
                        v-if="entry.kind === 'group'"
                        class="step step-group"
                        :class="`step-kind-${entry.icon}`"
                      >
                        <span class="step-icon">
                          <component :is="STEP_ICONS[entry.icon]" :size="13" />
                        </span>
                        <div class="step-body">
                          <button
                            type="button"
                            class="step-label step-toggle"
                            :aria-expanded="isGroupOpen(entry.key)"
                            @click="toggleGroup(entry.key)"
                          >
                            {{ entry.label }}
                            <span class="step-count">{{ entry.steps.length }} 次</span>
                            <IconChevronDown
                              class="step-caret"
                              :class="{ 'step-caret-open': isGroupOpen(entry.key) }"
                              :size="12"
                            />
                          </button>
                          <ol v-if="isGroupOpen(entry.key)" class="steps steps-nested">
                            <TraceStepRow
                              v-for="child in entry.steps"
                              :key="child.key"
                              :step="child"
                              :open="isStepOpen(child.key)"
                              :icons="STEP_ICONS"
                              variant="child"
                              @toggle="toggleStep(child.key)"
                            />
                          </ol>
                        </div>
                      </li>

                      <!-- 单独一步：绝大多数工具只调一次，那一档不该多一层点击 -->
                      <TraceStepRow
                        v-else
                        :step="entry.step"
                        :open="isStepOpen(entry.step.key)"
                        :icons="STEP_ICONS"
                        @toggle="toggleStep(entry.step.key)"
                      />
                    </template>
                  </ol>

                  <!--
                    **大输出的第一级懒加载**（P2-1，照 ZCode 的 `{shown}/{total} 条`）：
                    一轮里几十次工具调用时，面板先只画前 20 条（见 `TRACE_PAGE_SIZE`），
                    这一行如实报出"画了多少 / 一共多少"，点开才继续画。

                    计数与按钮**都在那一行里**：只给"加载更多"而不说什么进度，
                    用户不知道后面还有多少（可能是 2 条，也可能是 200 条）。
                  -->
                  <div v-if="traceView(turnIndex, turn).hidden > 0" class="trace-more">
                    <!-- 「X/Y 条工具调用」是照 ZCode 的写法；`total` 为 0 的那一档
                         （这一轮没有工具调用、但步骤很多）如实换个说法，不印 0/0 -->
                    <span
                      v-if="traceView(turnIndex, turn).total > 0"
                      class="trace-more-count tabular"
                    >
                      当前已显示 {{ traceView(turnIndex, turn).shown }}/{{
                        traceView(turnIndex, turn).total
                      }}
                      条工具调用
                    </span>
                    <span v-else class="trace-more-count">
                      还有 {{ traceView(turnIndex, turn).hidden }} 段过程没显示
                    </span>
                    <button type="button" class="trace-more-btn" @click="showMoreTrace(turnIndex)">
                      加载更多
                    </button>
                  </div>

                  <!-- 思考过程（推理模型的 reasoning_content）：过程的一部分，收在面板里。
                     它可能很长，所以限高滚动，不挤占正文的位置。 -->
                  <div v-if="turn.reply.thinkingText && !turn.reply.streaming" class="thinking">
                    <p class="thinking-label">
                      <span
                        v-if="turn.reply.streaming && !turn.reply.text"
                        class="thinking-dot"
                        aria-hidden="true"
                      />
                      思考过程
                    </p>
                    <!-- 思考过程里也常带网址（它读过的那些页）：与过程、正文同一套口径，
                         能点就点。`max-height` 那些样式在 `.thinking-text` 上，
                         而 LinkText 的根是 span —— 样式里补了 `display: block`。 -->
                    <LinkText class="thinking-text" :text="turn.reply.thinkingText" />
                  </div>

                  <!-- 逐条出处：行内徽标点进来会滚到对应这一条 -->
                  <ol v-if="turn.reply.sources.length" class="cites">
                    <li
                      v-for="source in shownSources(turnIndex, turn.reply.sources)"
                      :key="source.chunk_id"
                      class="cite"
                      :class="{ 'cite-flash': flashCite === `${turnIndex}:${source.index}` }"
                      :data-source="source.index"
                    >
                      <div class="cite-head">
                        <span class="cite-index tabular">[{{ source.index }}]</span>
                        <!-- 点文件名在**右侧抽屉**里打开原文，带着页码落到那一页
                           （PDF 走 #page=N）。不做成链接跳转：离开对话会丢掉
                           正在读的回答，而看出处本来是顺手一瞥的动作 -->
                        <button type="button" class="cite-title" @click="openReader(source)">
                          {{ source.document_name }}
                        </button>
                        <span v-if="sourceWhere(source)" class="cite-where">{{
                          sourceWhere(source)
                        }}</span>
                        <!-- 预览只显示 120 字（见 CITE_PREVIEW_CHARS）：给一个就地看全的入口，
                           否则用户得跳去文档页再自己找回来 -->
                        <button type="button" class="cite-more" @click="openSource(source)">
                          看全文
                        </button>
                      </div>
                      <p class="cite-preview">{{ sourcePreview(source) }}</p>
                    </li>
                    <!-- 多出来的折成一行：点开才铺（命中上百条时那段墙比回答还长） -->
                    <li v-if="turn.reply.sources.length > CITE_FOLD_LIMIT" class="cite-fold">
                      <button
                        type="button"
                        class="cite-fold-toggle"
                        @click="toggleCites(turnIndex)"
                      >
                        {{
                          citesExpanded(turnIndex)
                            ? '收起出处'
                            : `还有 ${turn.reply.sources.length - CITE_FOLD_LIMIT} 条出处`
                        }}
                      </button>
                    </li>
                  </ol>
                </div>

                <!--
                回答是模型写的 Markdown。这里用 v-html 是刻意的：renderAnswerWithCitations 会先转义
                全部 HTML，再只还原它自己识别出的标记（tests/unit/composables/useMarkdown.test.ts
                里有对应的注入用例）。换成插值就等于把 ** 和 - 原样摆给用户看。
                它同时把 `[1]` 标号换成可点击的徽标——点一下能落到那条出处。
              -->
                <!-- eslint-disable vue/no-v-html -->
                <div
                  class="reply-text"
                  :class="{ 'reply-text-streaming': turn.reply.streaming }"
                  v-html="renderAnswerWithCitations(turn.reply.text, turn.reply.sources)"
                />
                <!-- eslint-enable vue/no-v-html -->

                <!--
                降级提示（v25 起；v0.2 把口径从"规划失败"改成工具循环的"步数用尽"）：
                **没按设计走完**是这一轮唯一的降级情形——它还想继续查，但工具步数用完了。
                所以要如实说出来并给出口。**两个出口是两件不同的事**（v0.32）：

                - 「继续」= 接着做（`resumeStream`）：上一轮查到的资料、写了一半的正文
                  都交给模型接着用。绝大多数情况下这是用户想要的那个；
                - 「重试」= 从头再来（`regenerate`）：回退一轮、重发同一句提问。
                  模型走岔了路时才该用它——那次查的东西全部作废。

                两个都只在最后一轮给：续跑端点认的就是"会话里最后一条回答"。
              -->
                <p v-if="!turn.reply.streaming && wasDegraded(turn.reply)" class="reply-degraded">
                  <IconAlert :size="13" />
                  这次没跑完（{{ degradedReason(turn.reply) }}）。
                  <template v-if="turnIndex === turns.length - 1 && !sending">
                    <button
                      type="button"
                      class="degraded-retry degraded-primary"
                      :disabled="resuming || regenerating"
                      :title="'接着用已经查到的资料继续做'"
                      @click="resumeTurn(turnIndex)"
                    >
                      {{ resuming ? '继续中…' : '继续' }}
                    </button>
                    <span class="degraded-sep">·</span>
                    <button
                      type="button"
                      class="degraded-retry"
                      :disabled="resuming || regenerating"
                      :title="'丢掉这次的过程，重新问一遍'"
                      @click="regenerate(turnIndex)"
                    >
                      {{ regenerating ? '重试中…' : '重试' }}
                    </button>
                  </template>
                </p>

                <!--
                  **交付物**（v0.26）：这一轮产出的文件摆在这里，正文之后、动作之前。
                  改之前它们挂在各自那一步下面——交付物出现在过程面板**中间**，
                  要往下翻十来步工具调用才看得到，而面板一收起卡片就跟着没了。
                  交付物是这个回合的**结果**，不是过程的中间产物。

                  **流式中先不摆**（v0.41，用户报的第 5 条）：导出那一步一跑完，
                  卡片就冒出来了，而正文还在一个字一个字地出——看起来像"回答还没写完，
                  东西就先交了"。现在等这一轮收尾（`streaming` 变假）再一起交付；
                  过程面板里那一步照旧写着「导出文档 · 已导出」，中间状态并不丢。
                -->
                <ul
                  v-if="replyArtifacts(turn).length && !turn.reply.streaming"
                  class="deliverables"
                >
                  <li v-for="file in replyArtifacts(turn)" :key="file.artifact_id" class="artifact">
                    <span class="artifact-icon">{{ file.format.toUpperCase() }}</span>
                    <button
                      type="button"
                      class="artifact-main"
                      @click="openFiles(file.artifact_id, { name: file.name, kind: file.format })"
                    >
                      <span class="artifact-body">
                        <span class="artifact-name">{{ file.name }}</span>
                        <span class="artifact-meta tabular">
                          {{ formatBytes(file.size_bytes) }}
                          <template v-if="file.where"> · {{ file.where }}</template>
                        </span>
                      </span>
                      <span class="artifact-action">预览</span>
                    </button>
                    <button
                      v-if="!file.knowledge_base_id"
                      type="button"
                      class="artifact-kb"
                      @click="openIngest(file)"
                    >
                      存进知识库
                    </button>
                    <span v-else class="artifact-kb-done" :title="kbName(file.knowledge_base_id)">
                      已存进知识库{{
                        kbName(file.knowledge_base_id)
                          ? `「${kbName(file.knowledge_base_id)}」`
                          : ''
                      }}
                    </span>
                  </li>
                </ul>

                <!-- 消息级操作：复制永远可用；重新生成只给**最后一轮**——
                   重生成中间那轮要先回退掉它之后的全部对话，那不是用户点这个按钮的意思 -->
                <div v-if="!turn.reply.streaming" class="reply-actions">
                  <button
                    type="button"
                    class="msg-action"
                    @click="copyMessage(turnIndex, turn.reply)"
                  >
                    <IconCopy :size="13" />
                    {{ copiedKey === `${turnIndex}:assistant` ? '已复制' : '复制' }}
                  </button>
                  <!-- 存为笔记：问答是笔记最自然的来源之一（对标 ima 的"存为笔记"）。
                     笔记本身可以再一键加入知识库，于是"问答 → 笔记 → 语料"闭环 -->
                  <button type="button" class="msg-action" @click="saveAsNote(turnIndex, turn)">
                    <IconNote :size="13" />
                    {{ savedTurns.has(turnIndex) ? '已存为笔记' : '存为笔记' }}
                  </button>
                  <button
                    v-if="turnIndex === turns.length - 1 && !sending"
                    type="button"
                    class="msg-action"
                    :disabled="regenerating"
                    @click="regenerate(turnIndex)"
                  >
                    <IconRegenerate :size="13" />
                    {{ regenerating ? '生成中…' : '重新生成' }}
                  </button>
                </div>
              </template>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!--
      输入卡片：参考 WeKnora——一个大圆角框，范围与模型都收在框内底部。
      我们的"模式"等价物是**知识库范围**：它决定这一问依据什么，空选就没有依据。

      拖拽落点也在这个容器上（P1-3）：拖进来的东西有**两种落法**，文案与结果都不同
      （见 `onComposerDragOver` 与 `onComposerDrop`）——"添加附件"是上传，
      "引用此文件"是插一条引用。挂在容器上而不是那个小输入框上：
      拖拽时手在抖，落点大一圈成功率差很多。
    -->
    <div
      class="composer-wrap"
      @dragover="onComposerDragOver"
      @dragleave="onComposerDragLeave"
      @drop.prevent="onComposerDrop"
    >
      <!-- 往上翻旧回答时出现：一键回到最新一行（各家对话产品的通用件）。
           挂在输入卡片上沿而不是消息区里——它要一直浮在手边，不跟着内容滚走 -->
      <button
        v-if="!stick && messages.length > 0"
        type="button"
        class="to-bottom"
        aria-label="回到最新"
        title="回到最新"
        @click="jumpToLatest"
      >
        <IconChevronDown :size="18" />
      </button>
      <!-- 后端在等用户点头（v0.41）：**紧挨着输入框、在它上面**——
           这一条不是"对话内容"，而是"轮到你说一句话"，所以它跟输入框在一起，
           而不是飘在消息流里跟着滚走 -->
      <ApprovalBar
        v-if="pendingApproval"
        :approval="pendingApproval"
        @settled="settleLiveApproval"
      />
      <!--
        命令的回话（P1-2）：也贴在输入卡片上沿。

        **它不是一条助手回答**——后端那一路根本不产生回答（`done.answer` 是空串），
        消息也不落库。摆在这里正好：它是"系统对刚才那句话的回话"，
        与输入框是一回事，而不是对话内容的一部分（与 ApprovalBar 同一个位置理由）。
      -->
      <div v-if="commandResult" class="command-result" role="status">
        <div class="command-head">
          <span class="command-name">/{{ commandResult.name }}</span>
          <button
            type="button"
            class="command-close"
            aria-label="收起"
            title="收起"
            @click="commandResult = null"
          >
            ✕
          </button>
        </div>
        <pre class="command-text">{{ commandResult.text }}</pre>
      </div>
      <!--
        「/」命令菜单（P1-2）：浮在输入卡片上方，**不抢焦点**
        （键盘由输入框那一侧转发，见 `onComposerKeydown`）。
      -->
      <div v-if="menuVisible" class="slash-layer">
        <SlashMenu
          ref="slashMenu"
          :items="commands"
          :filter="slashFilter ?? ''"
          @pick="applyCommand"
        />
      </div>
      <!--
        「@」上下文菜单（P1-3）：与 `/` 菜单同一个位置、同一套键盘约定。
        三类候选（文件 / 技能 / 会话）来自同一个搜索框——这是 ZCode 的"多分类统一搜索"
        那一半；插进输入框的只是一条**引用**，那是 DSH 的"只引用不预读"那一半。
      -->
      <div v-if="mentionVisible" class="slash-layer">
        <MentionMenu
          ref="mentionMenu"
          :items="mentionItems"
          :filter="mentionFilter ?? ''"
          :loading="!mentionFilesLoaded"
          @pick="applyMention"
        />
      </div>
      <!--
        拖拽提示（P1-3）：**两句不同的文案**就是这个功能的一半——
        "松开以添加附件" = 它会成为这个库里的文档；"松开以引用此文件" = 它只是被提一句，
        内容一个字都不读。ZCode 把这两件事分开说，我们照抄。
      -->
      <div v-if="dropKind" class="drop-hint" :class="`drop-hint-${dropKind}`" role="status">
        {{ dropHint }}
      </div>
      <div class="composer">
        <AppInput
          id="chat-query"
          v-model="query"
          multiline
          :rows="2"
          class="composer-field"
          :placeholder="composerPlaceholder"
          @keydown="onComposerKeydown"
        />
        <div class="composer-foot">
          <div class="composer-left">
            <!--
              「加号」：附件与技能都收在这里（v0.18，照 Kimi 的输入框布局）。
              拼成一个菜单而不是并排两个按钮：它们回答的是同一个问题——
              "这一轮除了问题本身，还要给它什么"。摆成两个按钮时工具条会比输入框还热闹。
            -->
            <RowMenu class="tool tool-plus" align="left" label="添加附件或技能">
              <template #trigger>
                <IconPlus :size="16" />
              </template>
              <template #default>
                <button type="button" class="tool-item" @click="fileInput?.click()">
                  <IconUpload :size="15" />
                  <span>添加文件和图片</span>
                </button>
                <!-- 浏览这一条会话的文件区（工作区目录 / 临时区）：与"添加"是两件事——
                     一个是往这一轮里塞素材，一个是看已经在那儿的文件 -->
                <button type="button" class="tool-item" @click="openFiles()">
                  <IconFolder :size="15" />
                  <span>浏览文件</span>
                </button>
                <button
                  type="button"
                  class="tool-item"
                  :aria-expanded="skillsOpen"
                  @click="toggleSkillsPanel($event)"
                >
                  <IconAi :size="15" />
                  <span>技能</span>
                  <IconChevronRight class="tool-caret" :class="{ open: skillsOpen }" :size="13" />
                </button>
                <!--
                  技能是**钉住**（本轮必定展开正文）而不是"打开某个开关"：
                  后端没有"关掉某个技能"的概念——技能由模型按需 `use_skill` 读，
                  钉住只是把"要读"这一步替它做了。措辞按这个语义写。
                -->
                <!-- 往右飞出（用户指定）：它从属于上面那一行，不该把菜单撑长 -->
                <ul
                  v-if="skillsOpen"
                  class="tool-sub tool-flyout"
                  :style="{ top: skillsFlyoutTop }"
                >
                  <li v-for="skill in skillOptions" :key="skill.name">
                    <label class="tool-check" :title="skill.description">
                      <input
                        type="checkbox"
                        :checked="pinnedSkills.includes(skill.name)"
                        @change="toggleSkill(skill.name)"
                      />
                      <span class="tool-check-name">{{ skill.name }}</span>
                    </label>
                  </li>
                  <li v-if="!skillsLoaded" class="tool-note">正在读技能清单…</li>
                  <li v-else-if="skillOptions.length === 0" class="tool-note">
                    还没有可用的技能。去「能力」页装一个。
                  </li>
                  <li v-else class="tool-note">
                    勾上的技能每一轮都会展开正文——它会占上下文，按需勾。
                  </li>
                </ul>
              </template>
            </RowMenu>

            <!--
              「执行策略」（v0.41）：与知识库开关挨着——它管的是"这一轮让它做什么"
              这一类事。**它不是一个开关而是一个入口**：三档的名字必须看得见
              （"允许"与"拒绝"在用户眼里完全是两件事，用一个开关表示等于让他猜）。
            -->
            <ExecPolicyControl />

            <!--
              「Agent 模式」四档（v0.43，P1-1）：与「执行策略」并排——两件都是
              "这一轮它有多放手"，而且被拦下的那一刻用户正看着这段对话（见 ModePicker）。
            -->
            <ModePicker />

            <!--
              「知识库」**就是一个开关**（v0.19，用户指定）。
              原先它是个"开关 + 选库"二合一的菜单：要先点开才知道这一轮到底查不查库，
              而"查不查"比"查哪几个"高频得多，值得一步到位。
              关掉 = 这一轮纯对话（不查库），开着才有右边那个选库入口。
            -->
            <button
              type="button"
              class="kb-switch"
              role="switch"
              :aria-checked="useKb"
              :title="useKb ? '这一轮会查知识库' : '这一轮不查知识库，按纯对话回答'"
              @click="toggleKbSwitch"
            >
              <span class="kb-switch-track" :class="{ 'kb-switch-on': useKb }">
                <span class="kb-switch-knob" />
              </span>
              <span class="kb-switch-text">知识库</span>
            </button>

            <!-- 选哪几个：**开着时才有这个入口**（关掉时它没有意义，摆着只是噪声） -->
            <RowMenu v-if="useKb" class="tool tool-kb" align="left" label="选择要查的知识库">
              <template #trigger>
                <span class="tool-trigger-text">{{ kbPickText }}</span>
                <IconChevronDown :size="13" />
              </template>
              <template #default>
                <input
                  v-if="store.items.length > 8"
                  v-model="kbFilter"
                  class="tool-filter"
                  type="search"
                  placeholder="筛选知识库"
                />
                <ul class="tool-sub tool-sub-flat">
                  <li v-for="item in visibleKbOptions" :key="item.value">
                    <label class="tool-check">
                      <input
                        type="checkbox"
                        :checked="selected.includes(item.value)"
                        @change="toggleKb(item.value)"
                      />
                      <span class="tool-check-name">{{ item.label }}</span>
                    </label>
                  </li>
                  <li v-if="store.items.length === 0" class="tool-note">
                    还没有知识库。去「所有知识库」建一个，或先关掉这个开关。
                  </li>
                  <li v-else-if="visibleKbOptions.length === 0" class="tool-note">
                    没有匹配的知识库。
                  </li>
                </ul>
              </template>
            </RowMenu>
          </div>
          <div class="composer-right">
            <!--
              上下文仪表（P1-3）：摆在这一端（"怎么生成"那一侧）——它与模型/思考档
              是同一类信息：用户看它是为了判断"还能问多长"，而不是决定这一轮给什么。
              点开是**按来源分解**（数字全来自 `GET /chat/context-usage`），
              里面那个「压缩」按钮走的是既有那条 `/compact` 链路。
            -->
            <ContextGauge
              ref="contextGauge"
              :conversation-id="conversationId || null"
              @compress="compressContext"
            />
            <!--
              模型 + 思考 + 强度收在同一个入口里（见 ModelPicker 的注释）：
              三个控件并排时工具条比输入框还热闹，而它们回答的是同一个问题——这一轮怎么生成。
              **放右侧**（v0.19 用户指定）：左边是"给这一轮什么"（附件/技能/知识库），
              右边是"怎么生成 + 发出去"，两类动作各占一端，扫视时不用在中间找。
            -->
            <ModelPicker
              v-model="modelPk"
              v-model:thinking="thinkingOn"
              class="pick pick-model"
              :options="modelOptions"
              :effort="thinkingEffort"
              :efforts="THINKING_EFFORTS"
              :disabled="modelOptions.length === 0"
              :placeholder="modelPlaceholder"
              @update:effort="onEffortChange"
            />
            <span v-if="useKb && store.items.length && selected.length === 0" class="composer-warn">
              未选知识库
            </span>
            <span v-if="uploading" class="composer-warn">正在上传…</span>
            <!-- 发送 / 停止是**同一个位置、同一个形状**的图标按钮：切到"停止"时
                 按钮不跳动，用户不必重新找它。文字版按钮在这条工具行里太占位置 -->
            <button
              v-if="sending"
              type="button"
              class="send-btn send-btn-stop"
              aria-label="停止生成"
              title="停止生成"
              @click="stop"
            >
              <IconStop :size="16" />
            </button>
            <button
              v-else
              type="button"
              class="send-btn"
              aria-label="发送"
              title="发送"
              :disabled="!canSend"
              @click="send"
            >
              <IconArrowUp :size="17" />
            </button>
          </div>
        </div>
        <!--
          「添加文件和图片」的实际落点。**藏起来的 `<input type=file>` 而不是自绘按钮**：
          文件选择器必须由真实的用户手势触发，而原生 input 自带键盘可达与系统对话框，
          自绘一个再去模拟点击只是把同一件事做复杂。
        -->
        <input
          ref="fileInput"
          class="file-input"
          type="file"
          multiple
          tabindex="-1"
          aria-hidden="true"
          @change="onFilesPicked"
        />
      </div>
    </div>

    <!-- 引用原文：就地看全，不必先跳去文档页 -->
    <AppModal v-model:open="sourceOpen" title="引用原文" size="wide">
      <template v-if="activeSource">
        <p class="source-meta">
          <span class="source-doc">{{ activeSource.document_name }}</span>
          <span v-if="sourceWhere(activeSource)" class="source-where">{{
            sourceWhere(activeSource)
          }}</span>
        </p>
        <p class="source-body">{{ activeSource.preview }}</p>
      </template>
      <template #footer>
        <AppButton @click="sourceOpen = false">关闭</AppButton>
        <!-- 关掉弹窗、在右侧抽屉里打开原文：同样不离开对话页 -->
        <AppButton
          v-if="activeSource"
          variant="primary"
          @click="((sourceOpen = false), openReader(activeSource))"
        >
          查看文档
        </AppButton>
      </template>
    </AppModal>

    <!--
      存进知识库（v0.26）：**一定要经过这一步，不让服务端替他挑库**。
      库里只有一个时也不是一键入库——"放进哪个库"是用户的事，
      而这个弹窗就是他回答这件事的地方，成本只有一次点击。
    -->
    <AppModal
      :open="ingestTarget !== null"
      title="存进知识库"
      @update:open="(value: boolean) => !value && (ingestTarget = null)"
    >
      <p v-if="ingestTarget" class="ingest-note">
        把「{{ ingestTarget.name }}」存一份到知识库，之后它就能被检索到。
        <span class="ingest-hint"
          >原文件仍然在{{ ingestTarget.where || '原处' }}，不会被搬走。</span
        >
      </p>
      <ul v-if="store.items.length" class="ingest-picks">
        <li v-for="kb in store.items" :key="kb.id">
          <button
            type="button"
            class="ingest-pick"
            :class="{ on: ingestKbId === kb.id }"
            :aria-pressed="ingestKbId === kb.id"
            @click="ingestKbId = kb.id"
          >
            {{ kb.name }}
          </button>
        </li>
      </ul>
      <p v-else class="ingest-note">还没有知识库。先去「知识库」建一个，再回来存。</p>
      <template #footer>
        <AppButton @click="ingestTarget = null">取消</AppButton>
        <AppButton variant="primary" :disabled="!ingestKbId || ingesting" @click="confirmIngest">
          {{ ingesting ? '存入中…' : '存进这个库' }}
        </AppButton>
      </template>
    </AppModal>

    <!-- 文件抽屉：产物预览 + 文件区浏览（工作区目录 / 会话临时区）。
         `:key` 绑会话 id：换一条会话就整个重来（文件区是按会话划的） -->
    <FileDrawer
      v-if="fileDrawer && conversationId"
      :key="`${conversationId}-${fileDrawer.nonce}`"
      :conversation-id="conversationId"
      :initial-key="fileDrawer.key"
      :initial-entry="
        fileDrawer.seed && fileDrawer.key
          ? { key: fileDrawer.key, name: fileDrawer.seed.name, kind: fileDrawer.seed.kind }
          : null
      "
      @close="fileDrawer = null"
    />

    <!-- 引用文档抽屉：右侧滑出、盖在对话上。`:key` 绑文档 id——换一份文档时
         重新播放入场动画并把上一份的切块/预览状态彻底重置 -->
    <DocumentDrawer
      v-if="readerSource"
      :key="readerSource.document_id"
      :document-id="readerSource.document_id"
      :page="readerSource.page"
      @close="closeReader"
    />
  </div>
</template>

<style scoped src="src/components/chat/trace-row.css"></style>

<style scoped>
/* 整页占满内容区：中间滚动、底部固定输入卡片。
   **对话页没有页头**（v0.12）：侧栏已经写着"对话"，再顶一个同名标题只是重复。
   `position: relative` 是给"回到最新"浮标定位用的——它要贴在输入卡片的上方。 */
.chat {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  /* 消息列与输入框共用同一个宽度口径 = Kimi 的 `--chat-input-max-width`（768px）。
     此前是 960px：对话是**阅读型**界面，行太长会让人看丢行；
     Kimi 的窄栏正是它读起来"轻"的原因之一，这里跟着收窄。 */
  --chat-measure: var(--chat-input-max-width);
}

.chat-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}

/* 第一轮对话之前：欢迎层与输入卡片**作为一组摆在屏幕中间**（Kimi 的形态）。
   默认那套是"消息区撑满、输入框贴底"——那是有对话时的形态；
   没有对话时贴底会让整屏下方堆着东西、上方全空。
   做法是让滚动区的高度由内容决定（`flex: 0 1 auto`），
   再让这一列居中，于是这两块一起落在中间。 */
.chat-centered {
  justify-content: center;
}

.chat-centered .chat-scroll {
  flex: 0 1 auto;
}

/* 居中时下面不留那一大截内边距：它是给"贴底"时的呼吸感用的 */
.chat-centered .chat-inner {
  padding-bottom: 0;
}

/* 消息列与输入卡片**左右对齐**：两者都是同一条 960px 的居中窄列。
   所以这里用 `960 + 2×gutter` 的宽盒 + 内边距，而不是"960 的盒子再往里缩"——
   后者会让正文比输入卡片往里缩一个 gutter，两列各排各的，一眼就不齐 */
.chat-inner {
  width: 100%;
  max-width: calc(var(--chat-measure) + 2 * var(--page-gutter));
  margin: 0 auto;
  padding: var(--space-6) var(--page-gutter) var(--space-4);
}

/* 空状态时把欢迎层垂直居中（WeKnora 的做法） */
.chat-inner-welcome {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100%;
}

/* ---- 加载骨架 ---- */

/* 只占正文列宽，别撑出横向滚动；与消息列同一套左右对齐 */
.chat-loading {
  padding: var(--space-6) 0;
}

/* ---- 空状态 ---- */

.welcome {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-4);
  width: 100%;
  padding: var(--space-6) var(--space-2);
  text-align: center;
}

/* 字标下的标语：比正文小一档、用二级灰。它是品牌定位，不是要点，
   所以不抢字标的注意力；与字标的间距比块间距离（16px）小一档，
   让两者读成一个整体而不是两行独立文字。 */
.welcome-tagline {
  margin: calc(var(--space-3) * -1) 0 0;
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
}

/* 推荐问题的进出场（v0.19）。它出现的时机是"勾上知识库"，
   所以动画要**明确是它自己出现了**，而不是整页重画：
   容器淡入 + 轻微上浮（很快，120ms），每一条再各自错开 35ms 浮现。
   错位是这里唯一"多做"的一点——一排同时亮起来读起来像加载动画。 */
.samples-enter-active {
  transition:
    opacity 120ms var(--motion-ease),
    transform 120ms var(--motion-ease);
}

.samples-leave-active {
  transition: opacity 90ms var(--motion-ease);
}

.samples-enter-from,
.samples-leave-to {
  opacity: 0;
  transform: translateY(4px);
}

.samples-enter-active .sample {
  animation: sample-in 220ms var(--motion-ease) both;
  /* 序号由模板写进 `--sample-index`：CSS 算不出"第几条"，而这是唯一需要它的地方 */
  animation-delay: calc(var(--sample-index, 0) * 35ms);
}

@keyframes sample-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }

  to {
    opacity: 1;
    transform: none;
  }
}

/* 尊重"减少动态效果"：整块直接出现，不做淡入与错位 */
@media (prefers-reduced-motion: reduce) {
  .samples-enter-active,
  .samples-leave-active,
  .samples-enter-active .sample {
    transition: none;
    animation: none;
  }
}

.welcome-sub {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--text-meta-size);
  color: var(--text-tertiary);
}

.welcome-refresh {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  color: var(--text-tertiary);
  border-radius: var(--radius-control);
}

.welcome-refresh:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.welcome-refresh:disabled {
  opacity: 0.5;
  cursor: default;
}

/* 示例问题：宽度随文字（长短不一的胶囊），整体居中换行 */
.samples {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--space-2);
  max-width: 860px;
  transition: opacity var(--motion-fast) var(--motion-ease);
}

.samples-loading {
  opacity: 0.5;
}

.sample {
  padding: var(--space-2) var(--space-4);
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
  background: var(--bg-surface);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-pill);
}

.sample:hover {
  color: var(--text-primary);
  border-color: var(--border-strong);
}

.welcome-guide {
  font-size: var(--text-meta-size);
  color: var(--accent-text);
}

.welcome-guide:hover {
  text-decoration: underline;
}

/* ---- 消息 ---- */

.turn + .turn {
  margin-top: var(--space-6);
}

/* 助手消息的**头像沟槽**（v0.25）：回答左侧留一条 40px 的竖栏放头像。
   为什么要有：没有头像时，"谁在说这句话"只能靠位置与排版去猜——
   用户来回几条之后就分不清哪段是回答、哪段是自己引用的原文。
   Kimi 也是这么排的（它的头像是 56px 的动态图形，沟槽 60px）。
   用**行星标**而不是写死文字：侧栏顶部已经是那颗行星，同一套标识才立得住。 */
.reply {
  display: flex;
  gap: var(--space-3);
  align-items: flex-start;
}

.reply-avatar {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  color: var(--Always-White);
  background: var(--accent);
  border-radius: var(--radius-pill);
}

/* 正文与它下面那一排动作都占右边那一列 */
.reply-body {
  flex: 1;
  min-width: 0;
}

/* 提问：右对齐气泡。整块换底色在"对话"这个语境里是成熟产品的通例——
   左右分栏（问在右、答在左）比任何标签都更快认。 */
.ask {
  display: flex;
  justify-content: flex-end;
}

.ask-text {
  margin: 0;
  max-width: min(78%, 620px);
  padding: var(--space-2) var(--space-3);
  font-size: var(--text-body-size);
  color: var(--text-primary);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  background: var(--bg-subtle);
  border: 1px solid var(--border-hairline);
  /* 右下角收一个口：气泡的"尖"指向它的回答 */
  border-radius: var(--radius-panel) var(--radius-panel) var(--space-1) var(--radius-panel);
}

/* 回答紧跟着自己的提问：24px 是"两组问答之间"的距离，组内不该有那么大空隙 */
.ask + .reply {
  margin-top: var(--space-3);
}

/* ---- 消息级操作 ---- */

/* 提问的复制按钮：悬停在气泡里才出现，平时不占视觉重量 */
.ask-copy {
  align-self: flex-end;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  color: var(--text-tertiary);
  border-radius: var(--radius-control);
  opacity: 0;
  transition: opacity var(--motion-fast) var(--motion-ease);
}

.ask:hover .ask-copy,
.ask-copy:focus-visible {
  opacity: 1;
}

.ask-copy:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

/* 回答的操作行：靠左、字号小、颜色弱——它是"事后可做的一件事"，
   不该和正文抢注意力 */
/* 降级提示：介于"错误"与"正常"之间，用警示色而不是危险色——
   答案是能用的，只是链路退化了 */
.reply-degraded {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin: var(--space-2) 0 0;
  font-size: var(--text-micro-size);
  line-height: var(--line-prose);
  color: var(--status-warning);
}

/* 「继续」与「重试」都是文字按钮：它们是一句话里的动作，做成实心按钮会把提示的
   权重抬得过高。两者之间**只差一个加粗**——「继续」是大多数人要的那一个，
   但也不该重到压过提示本身 */
.degraded-primary {
  font-weight: 600;
}

.degraded-sep {
  color: var(--text-tertiary);
}

.degraded-retry {
  padding: 0 var(--space-1);
  font-size: inherit;
  color: var(--accent-text);
  text-decoration: underline;
  background: none;
  border: none;
  cursor: pointer;
}

.degraded-retry:disabled {
  color: var(--text-tertiary);
  cursor: default;
}

/* 交付物卡片（v0.25 起，v0.26 从步骤里搬到正文后面）。
   **不做成图标按钮**：文件是"结果"，不是"操作"——它该占一条完整的行，
   把文件名与大小摆出来（用户要先确认这是不是他要的那份，才谈得上下载）。

   宽度与正文对齐（v0.41）：这一块与 `.reply-text` 用同一个 `--measure`，
   卡片铺满它。**类名这里曾经写错过**——模板上是 `.deliverables`，CSS 写的是
   `.artifacts`，于是这段（含 `list-style: none` 与宽度）一直没生效，
   卡片比正文窄一截、还带列表圆点（用户报的"卡片与文段宽度对齐"）。 */
.deliverables {
  margin: var(--space-2) 0 0;
  padding: 0;
  list-style: none;
  max-width: var(--measure);
}

/* v0.26：卡片成了**一个框里两件事**（下载 / 存进知识库），所以外框在 li 上，
   里面那个 `.artifact-main` 才是原来的整块可点区域。合起来看还是一行卡片，
   但下载与入库不再互相抢点击区。 */
.artifact {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 48px;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-row);
  background: var(--bg-subtle);
  color: var(--text-primary);
  transition: var(--transition-ui);
}

.artifact:hover {
  background: var(--bg-group);
  border-color: var(--border-strong);
}

.artifact-main {
  display: flex;
  flex: 1;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  padding: 0;
  border: none;
  background: none;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

/* 「存进知识库」是**次要动作**：一个字重、一层底色，不与「下载」抢注意力。
   它是这一版把"入库显式化"落到手上的那个按钮，所以必须看得见、点得到。 */
.artifact-kb {
  flex: 0 0 auto;
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-control);
  background: var(--bg-surface);
  color: var(--text-secondary);
  font-size: var(--text-micro-size);
  white-space: nowrap;
  cursor: pointer;
  transition: var(--transition-ui);
}

.artifact-kb:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

/* 入库之后那句话**不可点**：它是状态，不是入口。再用按钮的样子画，
   用户会去点它，然后什么都不会发生。 */
.artifact-kb-done {
  flex: 0 0 auto;
  max-width: 160px;
  overflow: hidden;
  color: var(--text-tertiary);
  font-size: var(--text-micro-size);
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* 「存进知识库」弹窗：一句话交代 + 一列库名。
   库名用胶囊（与工作区弹窗里的知识库勾选同一套观感），选中靠底色不靠描边。 */
.ingest-note {
  margin: 0 0 var(--space-3);
  color: var(--text-secondary);
  font-size: var(--text-meta-size);
  line-height: var(--line-ui);
}

.ingest-hint {
  display: block;
  margin-top: var(--space-1);
  color: var(--text-tertiary);
  font-size: var(--text-micro-size);
}

.ingest-picks {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.ingest-pick {
  height: var(--control-height);
  padding: 0 var(--space-3);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-pill);
  background: var(--bg-surface);
  color: var(--text-secondary);
  font-size: var(--text-meta-size);
  cursor: pointer;
  transition: var(--transition-ui);
}

.ingest-pick:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

/* 选中态去掉描边、换底色：描边 + 底色同时出现会读成"按钮被按下"，
   而这里表达的是**状态**（与工作区弹窗里的知识库勾选同一口径）。 */
.ingest-pick.on {
  border-color: transparent;
  background: var(--bg-selected);
  color: var(--text-primary);
}

/* 格式角标：`DOCX` / `XLSX`。用文字而不是图标——五种格式画五个图标，
   读者还得先学会那套图标；三个字母他本来就认识。 */
.artifact-icon {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: var(--radius-control);
  background: var(--bg-active);
  color: var(--text-secondary);
  font-size: var(--text-c2-size);
  font-weight: 600;
  letter-spacing: 0.02em;
}

.artifact-body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--space-0-5);
  min-width: 0;
}

.artifact-name {
  overflow: hidden;
  font-size: var(--text-meta-size);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.artifact-meta {
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.artifact-action {
  flex: 0 0 auto;
  font-size: var(--text-meta-size);
  color: var(--accent-text);
}

.reply-actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin-top: var(--space-2);
}

.msg-action {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-2);
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
  border-radius: var(--radius-control);
}

.msg-action:hover:not(:disabled) {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.msg-action:disabled {
  cursor: default;
  opacity: 0.6;
}

/* ---- 过程面板 ---- */

/* 摘要行本身是个按钮（展开/收起），但视觉上是一行低调的说明文字 */
.trace-head {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  /* 让里面那一行实时状态能撑开、也能被裁：不给上限时它是 inline-flex，
     内容只会把按钮越撑越宽，`overflow: hidden` 永远不生效 */
  max-width: 100%;
  margin: 0 0 var(--space-2) calc(-1 * var(--space-2));
  padding: var(--space-1) var(--space-2);
  font-size: var(--text-micro-size);
  color: var(--text-secondary);
  border-radius: var(--radius-control);
}

.trace-head:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

/* 实时状态那一行：**一行，最多这么宽**（v0.27）。
   比正文窄一档是有意的——它是一句过程播报，不该和正文抢同一条右边界。 */
.trace-live {
  max-width: min(34rem, 100%);
  color: var(--text-secondary);
}

.trace-caret {
  flex: 0 0 auto;
  color: var(--text-tertiary);
  transition: transform var(--motion-fast) var(--motion-ease);
}

.trace-caret-open {
  transform: rotate(90deg);
}

.trace {
  margin: 0 0 var(--space-4);
}

/* 时间线：左侧一条竖线串起各步，图标压在线上（底色用页面底色"挖空"它） */
.steps {
  position: relative;
  margin: 0 0 var(--space-4);
  padding: 0;
  list-style: none;
}

.steps::before {
  content: '';
  position: absolute;
  top: 20px;
  bottom: 18px;
  left: 10px;
  width: 1px;
  background: var(--border);
}

/* 嵌套的那一层（一组展开后的每一次调用）**不画第二根竖线**：
   它挂在外面那条时间轴上，再画一根会变成"两套并列的时间线"。 */
.steps-nested {
  margin: var(--space-2) 0 0;
}

.steps-nested::before {
  display: none;
}

/*
 * 「当前已显示 X/Y 条工具调用」+「加载更多」（P2-1）。它是时间线的**收尾那一行**：
 * 左边留出图标位那 33px（21px 的圆底 + 12px 的 gap），与上面每行的正文对齐——
 * 对不齐的话，这一行看起来像不属于这条时间线。
 */
.trace-more {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin: 0 0 var(--space-4);
  padding-left: calc(21px + var(--space-3));
}

.trace-more-count {
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

/* 一个**轻按钮**（不是主按钮）：它是"再看看"，不是这一步该做的事 */
.trace-more-btn {
  padding: 0;
  font-size: var(--text-micro-size);
  color: var(--accent-text);
  transition: var(--transition-ui);
}

.trace-more-btn:hover {
  text-decoration: underline;
}

/* 一组被点开时，上面那一行也要跟着亮一档：用户在看的正是那一行的内容 */
.step-group .step-toggle[aria-expanded='true'] {
  color: var(--text-primary);
}

/* 「N 次」：合并的**全部理由**就是它，所以它得看得见。
   用弱一档的字色与小一号的字——它是量词，不是标签的一部分。 */
.step-count {
  color: var(--text-quaternary);
}

/* 思考过程：它是"过程"不是"结果"，用弱化的底色与文字，别和正文抢视线。
   限高滚动是因为推理模型的思考常常比回答还长。 */
.thinking {
  margin-top: var(--space-4);
  padding: var(--space-3) var(--space-4);
  background: var(--bg-subtle);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-control);
}

.thinking-label {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0 0 var(--space-2);
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.thinking-dot {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-pill);
  background: var(--accent);
  animation: thinking-pulse 1.1s ease-in-out infinite;
}

.thinking-text {
  /* LinkText 的根是 span：这里要的是**一块可滚动的区域**，所以显式声明块级 */
  display: block;
  max-height: 220px;
  margin: 0;
  overflow-y: auto;
  font-size: var(--text-micro-size);
  line-height: var(--line-prose);
  color: var(--text-secondary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

@keyframes thinking-pulse {
  0%,
  100% {
    opacity: 0.35;
  }
  50% {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .thinking-dot {
    animation: none;
  }
}

.reply-text {
  max-width: var(--measure);
  color: var(--text-primary);
}

/* 行内引用徽标：`[1]` 由 renderAnswerWithCitations 换成**文档短名**（见 citationChip）。
   显示名字而不是序号，是因为读者想知道"这句依据哪份资料"；序号只有回去数出处列表
   才有意义。点它仍会展开过程面板并闪出对应的那一条出处。

   **中性色 + 小尺寸**（对齐 WeKnora 的克制做法）：它是句尾的脚注，不该和正文抢
   注意力。早先用强调色胶囊是过火了——一屏看下来满眼蓝块，视线被脚注带走了。
   名字长度不写死截断字符数，交给 max-width + 内层省略：短名不该被白白砍掉信息 */
.reply-text :deep(.md-cite) {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  max-width: 8.5em;
  height: 16px;
  margin: 0 2px;
  padding: 0 5px;
  font-size: var(--text-micro-size);
  line-height: 1;
  color: var(--text-tertiary);
  background: var(--bg-subtle);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-control);
  cursor: pointer;
  /* 16px 的胶囊压在 1.75 行高的正文里：不抬一点会明显偏下 */
  vertical-align: -2px;
}

/* 文件名前的小图标：拿 IconFile（Remix `file-text-line`）的路径做 mask、用 currentColor
   上色。这样不必往 HTML 字符串里塞 SVG（渲染逻辑不该管画什么图），也自动跟主题色 */
.reply-text :deep(.md-cite::before) {
  flex: 0 0 auto;
  width: 11px;
  height: 11px;
  content: '';
  background: currentColor;
  -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M21 8v12.993A1 1 0 0 1 20.007 22H3.993A.993.993 0 0 1 3 21.008V2.992C3 2.455 3.449 2 4.002 2h10.995zm-2 1h-5V4H5v16h14zM8 7h3v2H8zm0 4h8v2H8zm0 4h8v2H8z'/%3E%3C/svg%3E");
  mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M21 8v12.993A1 1 0 0 1 20.007 22H3.993A.993.993 0 0 1 3 21.008V2.992C3 2.455 3.449 2 4.002 2h10.995zm-2 1h-5V4H5v16h14zM8 7h3v2H8zm0 4h8v2H8zm0 4h8v2H8z'/%3E%3C/svg%3E");
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
  -webkit-mask-size: contain;
  mask-size: contain;
}

/* 省略号必须挂在**内层 span** 上：inline-flex 容器自己设 overflow: hidden 时，
   文本的 text-overflow 在部分浏览器不生效，会直接把字裁掉而没有"…"。
   还要 min-width: 0——flex 项默认不收缩到内容宽度以下，不给它就永远省略不了 */
.reply-text :deep(.md-cite-name) {
  overflow: hidden;
  min-width: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.reply-text :deep(.md-cite:hover) {
  color: var(--text-secondary);
  background: var(--bg-hover);
  border-color: var(--border);
}

/* 流式光标：跟在最后一个字后面，说明"还在写" */
.reply-text-streaming::after {
  content: '';
  display: inline-block;
  width: 2px;
  height: 1em;
  margin-left: 2px;
  vertical-align: text-bottom;
  background: var(--text-secondary);
  animation: blink 1s step-end infinite;
}

/* Markdown 是 v-html 注入的，作用域属性加不到它身上，只能 :deep 透进去 */
.reply-text :deep(.md-h) {
  margin: var(--space-4) 0 var(--space-2);
  font-size: var(--text-section-size);
  color: var(--text-primary);
}

.reply-text :deep(.md-h:first-child) {
  margin-top: 0;
}

.reply-text :deep(.md-p) {
  margin: 0;
  white-space: pre-wrap;
}

.reply-text :deep(.md-p + .md-p) {
  margin-top: var(--space-3);
}

.reply-text :deep(.md-ul) {
  margin: var(--space-2) 0 0;
  padding-left: var(--space-5);
}

.reply-text :deep(.md-ul li + li) {
  margin-top: var(--space-1);
}
/* ---- 有序列表 / 引用 / 代码块 / 表格 / 分隔线（v17 渲染器增强） ---- */

.reply-text :deep(.md-ol) {
  margin: var(--space-2) 0 0;
  padding-left: var(--space-5);
}

.reply-text :deep(.md-ol li + li) {
  margin-top: var(--space-1);
}

/* 引用：左侧竖线 + 弱化文字。用底色会更重，而引用在回答里是补充说明 */
.reply-text :deep(.md-quote) {
  margin: var(--space-3) 0;
  padding: var(--space-2) var(--space-3);
  color: var(--text-secondary);
  border-left: 3px solid var(--border);
}

/* ---------------------------------------------------------------- 代码块与表格
   **两段式**（v0.25，照 Kimi 的对话页）：头部带（语言名 + 动作按钮）+ 内容区。
   改之前代码块是一个整块，语言名用 `::before` 绝对定位在右上角——
   代码一长就从它底下穿过去，像两样东西叠在一起；而且整块没有复制入口。
   表格则是一个光秃秃的表格，没有圆角、没有头部带、没有复制/下载。

   取值都从 Kimi 的对话页量出来（深色）：
     - 容器：圆角 12、描边 1px `Separators-S1`
     - 头部带：高 42、`padding 5px 12px`、底色比内容**暗一档**
     - 语言名：14px/20 **600**、主文字色（它在头部带里是标题，不是脚注）
     - 动作按钮：32×32、圆角 8、图标 20、默认三级灰、悬停给底色
     - 代码区：`padding 16px`、等宽 14px/21px、底色比头部带亮一档
   **头部带 sticky**：长代码块滚到中间时，语言名与复制按钮仍然在手边。 */
.reply-text :deep(.md-code),
.reply-text :deep(.md-table-block) {
  margin: var(--space-3) 0;
  overflow: hidden;
  background: var(--bg-subtle);
  border: 1px solid var(--border-hairline);
  /* 12 而不是 `--radius-panel` 的 16：Kimi 的代码块与表格都是 12
     （量的是 `.segment-code` 与 `.table-container`） */
  border-radius: var(--radius-row);
}

.reply-text :deep(.md-code-head) {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  height: 42px;
  padding: 5px 12px;
  background: var(--bg-group);
  /* 头部带压在内容上：滚动时它不能跟着走 */
  position: sticky;
  top: 0;
  z-index: 1;
}

/* 语言名吃掉剩余宽度：动作按钮因此被推到最右，不必再写 `margin-left: auto` */
.reply-text :deep(.md-code-lang) {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: var(--text-meta-size);
  font-weight: 600;
  line-height: 20px;
  color: var(--text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.reply-text :deep(.md-icon-btn) {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: none;
  border-radius: 8px;
  background: none;
  color: var(--text-secondary);
  cursor: pointer;
  transition: var(--transition-surface);
}

.reply-text :deep(.md-icon-btn:hover) {
  background: var(--bg-hover);
  color: var(--text-primary);
}

/* 复制成功：图标换成对勾。**用背景图而不是换 DOM**——按钮是 v-html 出来的，
   换内容要重新解析整段 HTML，而这是每点一次都要发生的事 */
.reply-text :deep(.md-icon-btn[data-copied]) {
  color: var(--status-success);
  background: var(--bg-hover);
}

/* 代码区：**横向滚动而不是折行**——折行会让缩进与对齐失真，
   而代码恰恰靠缩进读结构。头部带既已独立，这里就不必再躲着语言名了。 */
.reply-text :deep(.md-pre) {
  margin: 0;
  padding: var(--space-4);
  overflow-x: auto;
  font-size: var(--text-meta-size);
  line-height: var(--line-code);
  background: var(--bg-subtle);
}

.reply-text :deep(.md-pre code) {
  padding: 0;
  font-family: var(--font-mono);
  font-size: inherit;
  background: none;
}

/* 表格：窄列里必须能横向滚，否则宽表会把整页撑破 */
.reply-text :deep(.md-table-wrap) {
  overflow-x: auto;
  border-top: 1px solid var(--border-hairline);
}

.reply-text :deep(.md-table) {
  border-collapse: collapse;
  font-size: var(--text-meta-size);
}

.reply-text :deep(.md-table th),
.reply-text :deep(.md-table td) {
  padding: var(--space-2) var(--space-3);
  text-align: left;
  /* 表格自己的边框交给单元格：外框已经由 `.md-table-block` 给了，
     再画一圈是两道线叠在一起 */
  border-bottom: 1px solid var(--border-hairline);
}

.reply-text :deep(.md-table th) {
  font-weight: 600;
  color: var(--text-primary);
}

.reply-text :deep(.md-table tr:last-child td) {
  border-bottom: none;
}

.reply-text :deep(.md-hr) {
  margin: var(--space-5) 0;
  border: 0;
  border-top: 1px solid var(--border);
}

/* 链接：回答里的 URL 之前是纯文本，只能手抄 */
.reply-text :deep(.md-link) {
  color: var(--accent-text);
  text-decoration: none;
}

.reply-text :deep(.md-link:hover) {
  text-decoration: underline;
}

.reply-text :deep(code) {
  padding: 0 var(--space-1);
  font-size: var(--text-meta-size);
  background: var(--bg-subtle);
  border-radius: var(--radius-control);
}

.reply-error {
  margin: 0;
  max-width: var(--measure);
  font-size: var(--text-meta-size);
  color: var(--status-danger);
}

@keyframes blink {
  50% {
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .reply-text-streaming::after {
    animation: none;
  }

  .samples {
    transition: none;
  }
}

.cites {
  margin: 0;
  padding: 0;
  list-style: none;
}

.cite {
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-control);
}

.cite + .cite {
  margin-top: var(--space-1);
}

/* 行内徽标跳过来的那一条：闪一下底色，让眼睛有落点 */
.cite-flash {
  background: var(--accent-soft);
}

.cite-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-2);
  font-size: var(--text-meta-size);
}

.cite-index {
  flex: 0 0 auto;
  color: var(--text-secondary);
}

/* 文件名是个按钮（点它在右侧抽屉里看原文），不是跳去知识库的链接。
   长文件名要能省略，否则一份长名的 PDF 会把整行挤爆 */
.cite-title {
  overflow: hidden;
  max-width: 34ch;
  font-weight: 500;
  color: var(--text-primary);
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cite-title:hover {
  color: var(--accent-text);
  text-decoration: underline;
}

.cite-where {
  overflow: hidden;
  max-width: 48ch;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 两行足够看清"这段在讲什么"；真正的全文在文档页，点标题就过去。
   JS 侧已按 CITE_PREVIEW_CHARS 切过一刀，这里的 clamp 是排版兜底 */
.cite-preview {
  display: -webkit-box;
  overflow: hidden;
  max-width: var(--measure);
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

/* 折叠那一行：与出处同宽的一行安静按钮——它是"还有更多"的入口，
   不该抢走前几条出处的注意力 */
.cite-fold {
  margin-top: var(--space-1);
}

.cite-fold-toggle {
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-control);
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
  transition: var(--transition-ui);
}

.cite-fold-toggle:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

/* "看全文"是低频动作：字号与颜色都压到最低，只在悬停时给下划线 */
.cite-more {
  flex: 0 0 auto;
  font-size: var(--text-micro-size);
  color: var(--accent-text);
  white-space: nowrap;
}

.cite-more:hover {
  text-decoration: underline;
}

/* ---- 引用原文弹窗 ---- */

.source-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-2);
  margin: 0 0 var(--space-3);
  font-size: var(--text-meta-size);
}

.source-doc {
  font-weight: 500;
  color: var(--text-primary);
}

.source-where {
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

/* 原文按 pre-wrap 显示。**注意后端给的 preview 已经把空白压平了**
   （见 services/chat.py 的 _preview：压平是为了拼提示词时不破坏「资料」的结构），
   所以这里实际看到的是连续文本；保留 pre-wrap 是为了将来若改为原样下发不用再改样式 */
.source-body {
  margin: 0;
  max-height: 50vh;
  overflow-y: auto;
  font-size: var(--text-meta-size);
  line-height: 1.8;
  color: var(--text-secondary);
  white-space: pre-wrap;
}

/* ---- 输入卡片 ---- */

.composer-wrap {
  position: relative;
  flex: 0 0 auto;
  padding: 0 var(--page-gutter) var(--space-5);
}

/* 拖拽落点上的那句话（P1-3）：**两种落法两句文案**，颜色也分开——
   上传是"往这一轮里加东西"（中性），引用是"指一份东西给它看"（信息色）。
   盖住整张输入卡片：拖拽时手在抖，落点大一圈成功率差很多。 */
.drop-hint {
  position: absolute;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  inset: 0 var(--page-gutter) var(--space-5);
  font-size: var(--text-body-size);
  color: var(--text-primary);
  background: var(--bg-hover);
  border: 2px dashed var(--border-strong);
  border-radius: var(--radius-panel);
  /* 提示层不该吃鼠标事件：它一出现就压在输入框上，
     而拖拽的目标判定由 `.composer-wrap` 那一层负责（事件从底下冒泡上来） */
  pointer-events: none;
}

.drop-hint-attach {
  border-color: var(--text-tertiary);
}

.drop-hint-reference {
  color: var(--text-primary);
  background: var(--bg-active);
  border-color: var(--text-secondary);
}

/* 「回到最新」浮标：贴在输入卡片上沿正中，浮在内容之上。
   放在输入卡片的容器里（而不是消息区里）它才不跟着内容滚走 */
.to-bottom {
  position: absolute;
  top: -50px;
  left: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  color: var(--text-secondary);
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  box-shadow: var(--shadow-popover);
  transform: translateX(-50%);
}

.to-bottom:hover {
  color: var(--text-primary);
  border-color: var(--border-strong);
}

/* ---- 命令的回话与「/」菜单（P1-2） ----
   两块都贴在输入卡片上沿（`bottom: 100%`）：它们属于"输入这件事"，
   不属于对话内容——`/help` 的回话不是助手对你说的一句话。 */

.command-result {
  position: absolute;
  right: var(--page-gutter);
  bottom: 100%;
  left: var(--page-gutter);
  max-width: var(--chat-measure);
  margin: 0 auto var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-row);
  box-shadow: var(--shadow-popover);
}

.command-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.command-name {
  font-family: var(--font-mono);
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
}

.command-close {
  padding: 0 var(--space-1);
  font-size: var(--text-meta-size);
  color: var(--text-tertiary);
  background: transparent;
  border: 0;
  cursor: pointer;
}

.command-close:hover {
  color: var(--text-primary);
}

/* 回话可能有好几行（`/help` 那份清单、`/mode` 的四档），所以用 pre-wrap 保住换行；
   再长就自己滚，不把输入框顶上半天 */
.command-text {
  max-height: 30vh;
  margin: var(--space-1) 0 0;
  overflow-y: auto;
  font-family: inherit;
  font-size: var(--text-meta-size);
  line-height: 1.6;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-word;
}

/* 菜单层：与输入卡片同宽、贴着它往上长 */
.slash-layer {
  position: absolute;
  right: var(--page-gutter);
  bottom: 100%;
  left: var(--page-gutter);
  z-index: 2;
  max-width: var(--chat-measure);
  margin: 0 auto var(--space-2);
}

.composer {
  width: 100%;
  max-width: var(--chat-measure);
  margin: 0 auto;
  padding: var(--space-3) var(--space-4) var(--space-2);
  /* **抬起来的一层，比画布亮**：深色下 Kimi 的 `.chat-editor-content` 实测 `#1f1f1f`，
     而画布是 `#181817`。此前用 `--bg-surface`（`#121212`）——那比画布还暗，
     读起来是"凹进去的一块"。方向反了：输入框是页面里唯一常驻的抬起面，
     它必须比底亮。`--bg-group` 就是这一档（`BgGp-Secondary`）。 */
  background: var(--bg-group);
  /* 圆角取 Kimi 的 `--chat-input-radius`（24px），比面板那一档更圆——
     输入框是"手里的东西"，圆到接近胶囊才符合它的体量。 */
  border: 1px solid var(--border-subtle);
  border-radius: var(--chat-input-radius);
  /* 阴影也换到它自己那一档（Kimi 实测 `0 5px 16px -4px` / 7%）：
     `--shadow-raised`（`0 1px 2px` / 4%）是给"几乎没离开纸面"的东西用的，
     对输入框太轻，抬不起 130px 的一块。 */
  box-shadow: var(--shadow-input);
}

/* 聚焦环**只画一圈，画在卡片上**（v0.18 修）。
   此前这里有两条环：卡片这圈 3px 品牌蓝柔光 + `AppInput` 自己那圈 3px 品牌蓝柔光——
   而 `.composer :deep(.composer-field:focus)` 只把 `border` 归零、**没归 `box-shadow`**，
   所以里面那圈一直留着。用户报的"对话框选中后有重复的蓝色框线"就是这两圈。

   现在：内层文本域**完全不画环**（见下面的 `box-shadow: none`），卡片这圈改用
   Kimi 的形态——墨色、1px、inset（不往外扩）。它已经有一层 `--shadow-raised` 抬起，
   叠一圈贴边的墨线就够表达"在写字了"，不需要再套一层彩色柔光。 */
.composer:focus-within {
  box-shadow:
    var(--shadow-raised),
    inset 0 0 0 1px var(--text-primary);
}

.composer :deep(.composer-field) {
  padding: var(--space-1) 0;
  background: transparent;
  border: 0;
  resize: none;
}

/* 内层不画任何环。Kimi 的 `chat-input-editor` 就是 `outline: none`——
   焦点态整张卡片负责，输入区只是卡片里的一段文字。 */
.composer :deep(.composer-field:hover),
.composer :deep(.composer-field:focus) {
  border: 0;
  box-shadow: none;
  outline: none;
}

.composer-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2) var(--space-3);
  margin-top: var(--space-2);
  padding-top: var(--space-2);
  border-top: 1px solid var(--border-hairline);
}

.composer-left {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

/* ---------------------------------------------------------------- 工具栏控件
   这一行里现在有三个控件：加号、知识库、模型。**它们必须像同一族东西**——
   用户报的"样式统一"就是这件事。

   现成的族标准是 `ModelPicker` 的触发器（也是这一行里最老的那个控件）：
   高 `--control-height`、浅填充 `--bg-subtle`、透明描边、圆角 `--radius-row`。
   所以加号与知识库都照这一套写，而不是各自发明一个高度。
   （Kimi 那一排是 28px 的无底纯文字按钮；这里不跟它，理由是**跟同页的模型选择器
   对齐**比跟参考图对齐更重要——一排里两个高度比"整体矮 4px"难看得多。） */
.tool {
  flex: 0 0 auto;
}

/* 触发器**就是那颗胶囊本身**。
   RowMenu 默认把 `summary` 做成一个 24px（`--hit-target`）的图标方块，直接套在工具条上
   会有两个毛病：比旁边两个控件矮 8px（一排里两个高度），而且**可点区域小于看到的方块**
   ——外圈那 4px 点下去没反应。所以把胶囊样式写到 `summary` 上，让它就是那个洞。 */
.tool :deep(.menu-trigger) {
  gap: var(--space-1-5);
  min-width: 0;
  height: var(--control-height);
  padding: 0 var(--space-2);
  color: var(--text-secondary);
  background: var(--bg-subtle);
  border: 1px solid transparent;
  border-radius: var(--radius-row);
}

.tool-plus :deep(.menu-trigger) {
  justify-content: center;
  width: var(--control-height);
  padding: 0;
}

.tool :deep(.menu-trigger:hover),
.tool[open] :deep(.menu-trigger) {
  color: var(--text-primary);
  background: var(--bg-hover);
}

/* 关掉知识库时触发器转成"关"的形态：文字降一档灰、填充去掉、改用一圈 hairline。
   **不能只靠图标或勾选框表达**——关掉会改变答案的性质（不再依据库里的原文），
   这个状态必须在触发器本身上就看得见：用户不会为了确认状态去展开菜单。 */
.tool-off :deep(.menu-trigger) {
  color: var(--text-tertiary);
  background: transparent;
  border-color: var(--border-hairline);
}

.tool-trigger-text {
  max-width: 132px;
  overflow: hidden;
  font-size: var(--text-meta-size);
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 浮层里的项：图标 + 文字 + （可选的）右端箭头。RowMenu 的默认项是纯文字，
   这里要带图标，所以把它的 `display: block` 改成 flex。 */
.tool :deep(.tool-item) {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-2);
}

.tool :deep(.tool-caret) {
  margin-left: auto;
  color: var(--text-tertiary);
  transition: transform var(--motion-fast) var(--motion-ease);
}

.tool :deep(.tool-caret.open) {
  transform: rotate(90deg);
}

/* 子菜单（技能清单 / 知识库清单）。**缩进 + 分隔线**表达层级：
   它们从属于上面那一项，而不是并列的另一组动作。 */
.tool :deep(.tool-sub) {
  max-height: 260px;
  margin: var(--space-0-5) 0 0;
  padding: var(--space-1) 0 0 var(--space-4);
  overflow-y: auto;
  list-style: none;
  border-top: 1px solid var(--border-hairline);
}

.tool :deep(.tool-sub-muted) {
  opacity: 0.5;
}

.tool :deep(.tool-check) {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1-5) var(--space-2);
  font-size: var(--text-meta-size);
  color: var(--text-primary);
  border-radius: var(--radius-control);
  cursor: pointer;
}

.tool :deep(.tool-check:hover) {
  background: var(--bg-hover);
}

.tool :deep(.tool-check input) {
  flex: 0 0 auto;
  accent-color: var(--text-primary);
}

.tool :deep(.tool-check-name) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 说明文字：菜单里的"这一项是什么意思"。**必须有**——
   "钉住技能""关掉知识库"都不是一眼能懂的状态，靠标题猜会猜错。 */
.tool :deep(.tool-note) {
  padding: var(--space-1) var(--space-2) var(--space-1) 0;
  font-size: var(--text-micro-size);
  line-height: 1.5;
  color: var(--text-tertiary);
}

.tool :deep(.tool-note-block) {
  margin: 0;
  padding: 0 var(--space-2) var(--space-2);
  border-bottom: 1px solid var(--border-hairline);
}

.tool :deep(.tool-filter) {
  width: 100%;
  height: 28px;
  margin: var(--space-1) 0;
  padding: 0 var(--space-2);
  font: inherit;
  font-size: var(--text-micro-size);
  color: var(--text-primary);
  background: var(--bg-subtle);
  border: 1px solid transparent;
  border-radius: var(--radius-control);
  outline: none;
}

.tool :deep(.tool-filter:focus) {
  border-color: var(--text-primary);
}

/* ------------------------------------------------- 「使用知识库」开关（v0.19）
   它从菜单里搬到了工具条上，所以不再挂在 `.tool` 下面。

   用 `role="switch"` 的按钮而不是 `<input type=checkbox>` 加样式：
   `aria-checked` 才是这个控件真正的语义（"这一轮查不查库"不是"勾没勾某一项"）。 */
.kb-switch {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  height: var(--control-height);
  padding: 0 var(--space-2);
  background: var(--bg-subtle);
  border: 1px solid transparent;
  border-radius: var(--radius-row);
  cursor: pointer;
}

.kb-switch:hover {
  background: var(--bg-hover);
}

.kb-switch-track {
  position: relative;
  flex: 0 0 auto;
  width: 28px;
  height: 16px;
  background: var(--border-strong);
  border-radius: var(--radius-pill);
  transition: background var(--motion-fast) var(--motion-ease);
}

/* 打开时轨道转墨色：这是"通/断"的状态色，不该用品牌蓝（规范 §7） */
.kb-switch-on {
  background: var(--text-primary);
}

.kb-switch-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
  background: var(--bg-surface);
  border-radius: var(--radius-pill);
  transition: transform var(--motion-fast) var(--motion-ease);
}

.kb-switch-on .kb-switch-knob {
  transform: translateX(12px);
}

.kb-switch-text {
  font-size: var(--text-meta-size);
  font-weight: 500;
  color: var(--text-secondary);
  white-space: nowrap;
}

.kb-switch-on .kb-switch-text {
  color: var(--text-primary);
}

/* 选库那个入口现在是独立的浮层（下面没有从属的开关与说明），
   所以去掉 `tool-sub` 为"子列表"加的上边框与缩进 */
.tool :deep(.tool-sub-flat) {
  padding-left: 0;
  border-top: 0;
}

/* 技能子菜单**往右飞出**（v0.19，用户指定）：
   它是浮层（`.menu-list` 是 `position: fixed`，是这里的定位祖先），
   所以 `top` 由 JS 给（贴着「技能」那一行），`left: 100%` 就贴在右侧。 */
.tool :deep(.tool-flyout) {
  position: absolute;
  left: calc(100% + var(--space-1));
  width: 260px;
  max-height: 280px;
  margin: 0;
  padding: var(--menu-pad);
  overflow-y: auto;
  background: var(--bg-menu);
  border-radius: var(--radius-panel);
  box-shadow: var(--shadow-popover);
}

/* 技能名可能很长（英文 slug），在 260px 里要能换行而不是撑破 */
.tool :deep(.tool-flyout .tool-check-name) {
  white-space: normal;
  word-break: break-word;
}

/* 文件选择器只作为"点加号 → 弹出系统文件框"的落点，本身不显示 */
.file-input {
  display: none;
}

/* 模型与知识库各占一档宽度（思考设置收在模型自己的浮层里） */
.pick {
  width: 200px;
  max-width: 42vw;
}

.composer-right {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-left: auto;
}

.composer-warn {
  font-size: var(--text-micro-size);
  color: var(--status-warning);
}

/* 发送 / 停止：同一个位置的圆形图标按钮，两态切换时按钮不跳动 */
.send-btn {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: var(--icon-button-height);
  height: var(--icon-button-height);
  color: var(--button-primary-text);
  background: var(--button-primary-bg);
  /* 圆角取 Kimi 的 `--radius-send`（22px，实测自 `.send-button-container`），
     不是 999px：36px 的方块上两者看起来都是圆，但 22px 在按钮被拉宽时
     仍是一个"圆角方块"，999px 会变成胶囊——语义不同。 */
  border-radius: var(--radius-send);
  /* 它自成一档：Kimi 的发送键用 `background-color .15s cubic-bezier(.4,0,.2,1)`，
     不是全站的 ease。按下即走，不要"缓入"。 */
  transition: background-color var(--motion-fast) var(--motion-send);
}

.send-btn:hover:not(:disabled) {
  background: var(--button-primary-bg-hover);
}

.send-btn:disabled {
  color: var(--button-disabled-text);
  background: var(--button-disabled-bg);
  cursor: default;
}

.send-btn-stop {
  color: var(--text-primary);
  background: var(--bg-active);
}

.send-btn-stop:hover {
  background: var(--border);
}
</style>
