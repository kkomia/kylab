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
} from 'vue'
import { useRoute, useRouter } from 'vue-router'

import {
  DEFAULT_SYSTEM_PROMPT,
  chatStream,
  getSuggestedQuestions,
  isAbortError,
  type ChatHistoryMessage,
  type ChatSource,
} from '@/api/chat'
import {
  rewindConversation,
  type ConversationDetail,
  type StoredMessage,
} from '@/api/conversations'
import type { RegisteredModel } from '@/api/modelRegistry'
import { getSettings, updateSettings } from '@/api/settings'
import IconArrowUp from '@/components/icons/IconArrowUp.vue'
import IconCopy from '@/components/icons/IconCopy.vue'
import IconAlert from '@/components/icons/IconAlert.vue'
import IconRegenerate from '@/components/icons/IconRegenerate.vue'
import IconNote from '@/components/icons/IconNote.vue'
import IconCheck from '@/components/icons/IconCheck.vue'
import IconChevronDown from '@/components/icons/IconChevronDown.vue'
import IconChevronRight from '@/components/icons/IconChevronRight.vue'
import IconRefresh from '@/components/icons/IconRefresh.vue'
import IconRobot from '@/components/icons/IconRobot.vue'
import IconSearch from '@/components/icons/IconSearch.vue'
import IconStop from '@/components/icons/IconStop.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppModal from '@/components/ui/AppModal.vue'
import AppMultiSelect from '@/components/ui/AppMultiSelect.vue'
import ModelPicker from '@/components/ui/ModelPicker.vue'
import SkeletonBlock from '@/components/ui/SkeletonBlock.vue'

/**
 * 引用文档抽屉（从右侧滑出）。
 *
 * **异步加载**：它带着 PDF iframe / Office 预览那一套，而为看一份原文而付这次下载
 * 不该摊到"每次打开对话页"上——不用它就是零成本。
 */
const DocumentDrawer = defineAsyncComponent(
  () => import('@/components/knowledge/DocumentDrawer.vue'),
)
import { renderAnswerWithCitations } from '@/composables/useMarkdown'
import {
  buildTurns,
  isTraceOpen,
  makeMessage,
  mergeStep,
  sourcePreview,
  sourceWhere,
  traceSteps,
  traceSummary,
  wasDegraded,
  THINKING_EFFORTS,
  type Message,
  type ThinkingEffort,
  type Turn,
} from '@/composables/useChatTurns'
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
const STEP_ICONS = { search: IconSearch, think: IconRobot, build: IconCheck } as const

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
const stream = ref<{ abort: () => void } | null>(null)
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

/** 没选库时的问题没有可依据的原文，与后端的 kb_ids 必填是同一条约束。 */
const canSend = computed(
  () =>
    selected.value.length > 0 &&
    query.value.trim().length > 0 &&
    !loadingHistory.value &&
    !resolvingEntry.value,
)

/** 知识库多选的下拉选项（名字给用户看，id 给后端）。 */
const kbOptions = computed(() => store.items.map((item) => ({ value: item.id, label: item.name })))

onMounted(async () => {
  if (store.items.length === 0) await store.load()
  // 默认全选：打开这一页的人多半就是要问遍手上的资料，让他先做一轮取消勾选是白费功夫
  selected.value = store.items.map((item) => item.id)
  void loadPrompt()
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
 * 正在流式写入哪条会话（空 = 没有）。
 *
 * 为什么需要它：**新建会话的第一句**会先建会话、再 `router.replace` 到 `/chat/:id`，
 * 而"路径参数变了"就会触发 `loadConversation`。此刻库里还没有这一轮的任何消息
 * ——落库要等回答流完——于是"按库里内容重画"会把刚追加的提问与空回答块一起抹掉，
 * 连流式回来的字也无处可写（`patch` 找不到那条消息）。实测：界面直接弹回欢迎页，
 * 会话里 0 条，用户以为"问了个寂寞"。
 *
 * 所以正在流式的会话，回放只认本地状态；等这一轮结束（`finish`）再交还给库里。
 * 用普通变量而不是 ref：它只在异步流程里读写，不参与渲染。
 */
let streamingConversationId = ''

/** 把一份会话详情铺进界面（缓存与网络两条路都走它，口径才不会分叉）。 */
function applyDetail(detail: ConversationDetail): void {
  messages.value = detail.messages.map((item) =>
    makeMessage(item.role === 'user' ? 'user' : 'assistant', item.content, {
      sources: item.sources,
      // 回放：这一轮当时用哪档思考没有存，别猜
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
  if (detail.thinking_effort) thinkingEffort.value = detail.thinking_effort
  stick.value = true
  void scrollToBottom()
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
  // 这一轮的回答还在路上，本地就是最新的——别用库里的旧快照盖掉它
  if (id === streamingConversationId) return

  const cached = conversations.cachedDetail(id)
  if (cached) {
    applyDetail(cached)
    return
  }

  loadingHistory.value = true
  try {
    const detail = await conversations.fetchDetail(id)
    // 取回来的路上用户可能又切走了：别把旧会话的内容盖到新选的这条上
    if (conversationId.value !== id) return
    applyDetail(detail)
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
  // 人已经离开这一页，流再跑下去只是烧 token
  unmounted = true
  stream.value?.abort()
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

async function send(): Promise<void> {
  if (!canSend.value || sending.value) return
  const text = query.value.trim()
  if (text.length === 0) {
    notifyWarning('请输入问题')
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
      const created = await conversations.create(selected.value, modelPk.value || null, {
        thinking: thinkingOn.value,
        thinking_effort: thinkingEffort.value,
      })
      target = created.id
      // **先登记再改路径**：改路径会立刻触发一次会话回放（见 streamingConversationId），
      // 登记晚一步，那一次就已经把界面清空了
      streamingConversationId = target
      // 用 replace 而不是 push：用户按"新对话"只是想换个会话，
      // 在历史里留一条空的 /chat 没有任何意义，返回时会看到一片空白
      await router.replace(`/chat/${target}`)
    } catch (cause) {
      streamingConversationId = ''
      notifyError(cause instanceof Error ? cause.message : '无法新建对话')
      return
    }
  }

  messages.value = [
    ...messages.value,
    makeMessage('user', text),
    makeMessage('assistant', '', {
      streaming: true,
      // 记下这一轮实际发出去的思考档：过程面板要如实显示"这一步做没做"
      thinking: { enabled: thinkingOn.value, effort: thinkingEffort.value },
    }),
  ]
  const index = messages.value.length - 1
  query.value = ''
  sending.value = true
  // 新问题一定要回到最新一行：用户刚按下发送，接下来的字就是他等着看的东西，
  // 哪怕他上一轮往上翻过旧回答。watch 的 flush: 'post' 会处理这次滚动
  stick.value = true
  void scrollToBottom()

  const patch = (part: Partial<Message>): void => {
    const current = messages.value[index]
    if (!current) return
    // 就地改字段而不是整数组替换：整数组替换会让每来一个 delta 就重建整个消息流
    Object.assign(current, part)
  }

  try {
    // 这一步在响应头到达时就返回，之后正文全走 handlers：
    // 「停止」按钮因此从第一个字开始就是活的
    const handle = await chatStream(
      // 带上 conversation_id 之后，历史由后端从库里取——所以 context 传不传都一样，
      // 留着是为了"没会话"那条路径（此处不会走到，但接口本身支持无状态调用）
      {
        query: text,
        kb_ids: selected.value,
        history: context,
        conversation_id: target,
        model_pk: model,
        thinking: thinkingOn.value,
        thinking_effort: thinkingEffort.value,
      },
      {
        onStep: (step) => patch({ steps: mergeStep(messages.value[index]?.steps ?? [], step) }),
        onSources: (items) => patch({ sources: items }),
        onThinking: (chunk) =>
          patch({ thinkingText: (messages.value[index]?.thinkingText ?? '') + chunk }),
        onDelta: (delta) => patch({ text: (messages.value[index]?.text ?? '') + delta }),
        // done 带的是后端拼好的全文，以它为准，避免个别 delta 丢失后正文与引用对不上
        onDone: (answer) => {
          patch({ text: answer, streaming: false })
          finish()
        },
        onError: (message) => {
          patch({ error: message, streaming: false })
          finish()
        },
      },
    )
    stream.value = handle
    // 请求建立得快的时候组件可能已经卸载了，此时不该再留着这条流
    if (unmounted) {
      handle.abort()
      finish()
    }
  } catch (cause) {
    if (!isAbortError(cause)) {
      patch({ error: cause instanceof Error ? cause.message : '对话失败', streaming: false })
    }
    finish()
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
      created_at: null,
    }))
}

/** 一轮结束：收掉「停止」，把输入权还给用户。 */
function finish(): void {
  sending.value = false
  stream.value = null
  // 这一轮写完了，库里已经有完整记录，回放重新以库为准
  streamingConversationId = ''
  if (!conversationId.value) return
  const id = conversationId.value
  // 先用本地这份覆盖缓存：后端同刻刚写完，"聊完切走再切回"才不会看到上一版
  conversations.rememberDetailMessages(id, persistedMessages())
  // 再让后端校准一次（标题是首轮才生成的、条数与时间也变了），
  // 一次请求同时更新缓存与侧栏那一条
  void conversations.refreshDetail(id)
}

/** 用户点了「停止」：已经流出来的部分留着，它仍然是有用的。 */
function stop(): void {
  stream.value?.abort()
  const last = messages.value.at(-1)
  if (last?.role === 'assistant') last.streaming = false
  finish()
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
watch(
  () =>
    messages.value.length +
    (messages.value.at(-1)?.text.length ?? 0) +
    // 思考也在长，它流出来时同样要跟着滚，否则面板里的思考会停在开头
    (messages.value.at(-1)?.thinkingText.length ?? 0),
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

function toggleTrace(turn: Turn): void {
  const message = turn.reply
  if (!message) return
  message.traceOpen = !isTraceOpen(message)
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
  try {
    await navigator.clipboard.writeText(message.text)
    copiedKey.value = key
    window.clearTimeout(copiedTimer)
    copiedTimer = window.setTimeout(() => {
      if (copiedKey.value === key) copiedKey.value = ''
    }, 1600)
  } catch {
    // 剪贴板不可用（非 https、权限被拒）：如实说，别假装复制成功
    notifyError('复制失败，请手动选中后复制')
  }
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
    await resend(query, context, model, id)
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '重新生成失败')
    // 回退可能已经成功、重发失败：以库里的状态为准重新装载，别让界面与库里错位
    void loadConversation()
  } finally {
    regenerating.value = false
  }
}

/**
 * 按给定的一句提问重新发一轮（重新生成用）。
 *
 * 与 `send()` 共用同一套流式处理，但不走"新建会话"那条分支——会话已经存在，
 * 也不该再改路由。
 */
async function resend(
  text: string,
  context: ChatHistoryMessage[],
  model: string | undefined,
  id: string,
): Promise<void> {
  messages.value = [
    ...messages.value,
    makeMessage('user', text),
    makeMessage('assistant', '', {
      streaming: true,
      thinking: { enabled: thinkingOn.value, effort: thinkingEffort.value },
    }),
  ]
  const index = messages.value.length - 1
  sending.value = true
  stick.value = true
  void scrollToBottom()
  const patch = (part: Partial<Message>): void => {
    const current = messages.value[index]
    if (current) Object.assign(current, part)
  }
  try {
    const handle = await chatStream(
      {
        query: text,
        kb_ids: selected.value,
        history: context,
        conversation_id: id,
        model_pk: model,
        thinking: thinkingOn.value,
        thinking_effort: thinkingEffort.value,
      },
      {
        onStep: (step) => patch({ steps: mergeStep(messages.value[index]?.steps ?? [], step) }),
        onSources: (items) => patch({ sources: items }),
        onThinking: (chunk) =>
          patch({ thinkingText: (messages.value[index]?.thinkingText ?? '') + chunk }),
        onDelta: (delta) => patch({ text: (messages.value[index]?.text ?? '') + delta }),
        onDone: (answer) => {
          patch({ text: answer, streaming: false })
          finish()
        },
        onError: (message) => {
          patch({ error: message, streaming: false })
          finish()
        },
      },
    )
    stream.value = handle
    if (unmounted) {
      handle.abort()
      finish()
    }
  } catch (cause) {
    if (!isAbortError(cause)) {
      patch({ error: cause instanceof Error ? cause.message : '对话失败', streaming: false })
    }
    finish()
  }
}

/** 正在闪的引用（`"${turn}:${index}"`）。点行内徽标时用它把视线引过去。 */
const flashCite = ref('')
let flashTimer: number | undefined

function onReplyClick(event: MouseEvent, index: number): void {
  const chip = citeChipOf(event.target)
  if (!chip) return
  event.preventDefault()
  void revealSource(index, chip)
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

let samplesTimer: number | undefined

/** 只在"空状态 + 至少选了一个库"时才去生成；有消息之后它是纯浪费。 */
function scheduleSamples(): void {
  window.clearTimeout(samplesTimer)
  if (messages.value.length > 0 || selected.value.length === 0) {
    suggested.value = []
    return
  }
  samplesTimer = window.setTimeout(() => void loadSamples(), 400)
}

async function loadSamples(): Promise<void> {
  if (messages.value.length > 0 || selected.value.length === 0) return
  samplesLoading.value = true
  try {
    // **只传库**：问题取自库里入库时生成的（v23），不再现场调模型，
    // 所以既没有 limit（那是"每段生成几条"，属于库设置）也没有 model_pk。
    // 读端每次都重新随机抽样，所以"换一批"什么都不用传
    const result = await getSuggestedQuestions(selected.value)
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
  if (selected.value.length > 0 && !sending.value && !loadingHistory.value) void send()
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

const promptOpen = ref(false)
const promptDraft = ref('')
const promptConfigured = ref(false)
const promptLoading = ref(false)
const promptSaving = ref(false)

async function loadPrompt(): Promise<void> {
  promptLoading.value = true
  try {
    const config = await getSettings()
    const field = config.groups
      .find((group) => group.key === 'chat')
      ?.fields.find((item) => item.key === 'chat.system_prompt')
    promptDraft.value = field?.value ?? ''
    promptConfigured.value = field?.configured ?? false
  } catch {
    // 提示词读不到不该挡住提问：编辑框留空即可，保存会由后端给出真正的错误
    promptDraft.value = ''
  } finally {
    promptLoading.value = false
  }
}

function openPrompt(): void {
  promptOpen.value = true
  if (!promptLoading.value) void loadPrompt()
}

async function savePrompt(): Promise<void> {
  promptSaving.value = true
  try {
    await updateSettings([{ key: 'chat.system_prompt', value: promptDraft.value }])
    promptConfigured.value = promptDraft.value.trim().length > 0
    notifySuccess(promptConfigured.value ? '提示词已保存' : '已恢复内置提示词')
    promptOpen.value = false
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '提示词保存失败')
  } finally {
    promptSaving.value = false
  }
}
</script>

<template>
  <div class="chat">
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

        <!-- 空状态：居中问候 + 示例问题（参考 WeKnora 的欢迎层）。
             有消息之后整块消失，让位给正文——它不是常驻装饰。
             `pendingEntry` 期间不画：那时还没决定该显示哪条对话（见 resolvingEntry）。 -->
        <div v-else-if="messages.length === 0" class="welcome">
          <h1 class="welcome-title">Hi，我是 KYLAB，让你的知识触手可及</h1>
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
              v-for="sample in samples"
              :key="sample"
              type="button"
              class="sample"
              @click="useSample(sample)"
            >
              {{ sample }}
            </button>
          </div>
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
            <p v-if="turn.reply.error" class="reply-error">{{ turn.reply.error }}</p>

            <template v-else>
              <!-- 依据摘要：这一行的数字就是"这句回答有没有出处"的答案。
                   展开才是过程与来源 -->
              <button
                v-if="hasTrace(turn.reply)"
                type="button"
                class="trace-head"
                :aria-expanded="isTraceOpen(turn.reply)"
                @click="toggleTrace(turn)"
              >
                <IconChevronRight
                  class="trace-caret"
                  :class="{ 'trace-caret-open': isTraceOpen(turn.reply) }"
                  :size="14"
                />
                <span class="trace-summary">{{ traceSummary(turn.reply) }}</span>
              </button>

              <div v-show="isTraceOpen(turn.reply)" class="trace">
                <!-- 过程时间线：只列真发生过的步骤 -->
                <ol class="steps">
                  <li
                    v-for="step in traceSteps(turn)"
                    :key="step.key"
                    class="step"
                    :class="{ 'step-empty': step.empty }"
                  >
                    <span class="step-icon">
                      <component :is="STEP_ICONS[step.icon]" :size="13" />
                    </span>
                    <div class="step-body">
                      <p class="step-label">{{ step.label }}</p>
                      <p v-if="step.detail" class="step-detail">{{ step.detail }}</p>
                    </div>
                  </li>
                </ol>

                <!-- 思考过程（推理模型的 reasoning_content）：过程的一部分，收在面板里。
                     它可能很长，所以限高滚动，不挤占正文的位置。 -->
                <div v-if="turn.reply.thinkingText" class="thinking">
                  <p class="thinking-label">
                    <span
                      v-if="turn.reply.streaming && !turn.reply.text"
                      class="thinking-dot"
                      aria-hidden="true"
                    />
                    思考过程
                  </p>
                  <p class="thinking-text">{{ turn.reply.thinkingText }}</p>
                </div>

                <!-- 逐条出处：行内徽标点进来会滚到对应这一条 -->
                <ol v-if="turn.reply.sources.length" class="cites">
                  <li
                    v-for="source in turn.reply.sources"
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
                降级提示（v25）：这一轮少了意图识别与检索词改写（规划调用失败），
                所以要**如实说出来并给一个重试入口**——否则用户只会觉得"这次答得差"，
                却不知道是链路退化了、也不知道能不能再要一次。
                重试就是重发同一句提问（复用 `regenerate`），所以只在最后一轮给按钮。
              -->
              <p v-if="!turn.reply.streaming && wasDegraded(turn.reply)" class="reply-degraded">
                <IconAlert :size="13" />
                这次没走多轮检索（规划调用失败，直接按原问题检索了一遍）。
                <button
                  v-if="turnIndex === turns.length - 1 && !sending"
                  type="button"
                  class="degraded-retry"
                  :disabled="regenerating"
                  @click="regenerate(turnIndex)"
                >
                  {{ regenerating ? '重试中…' : '重试' }}
                </button>
              </p>

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

    <!-- 输入卡片：参考 WeKnora——一个大圆角框，范围与模型都收在框内底部。
         我们的"模式"等价物是**知识库范围**：它决定这一问依据什么，空选就没有依据。 -->
    <div class="composer-wrap">
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
      <div class="composer">
        <AppInput
          id="chat-query"
          v-model="query"
          multiline
          :rows="2"
          :disabled="sending"
          class="composer-field"
          placeholder="向知识库提问…（回车发送，Shift + 回车换行）"
          @keydown.enter.exact.prevent="send"
        />
        <div class="composer-foot">
          <div class="composer-left">
            <AppMultiSelect
              v-model="selected"
              class="pick pick-kb"
              :options="kbOptions"
              aria-label="知识库"
              placeholder="选择知识库"
              search-placeholder="搜索知识库"
            />
            <!--
              模型 + 思考 + 强度收在同一个入口里（见 ModelPicker 的注释）：
              三个控件并排时工具条比输入框还热闹，而它们回答的是同一个问题——这一轮怎么生成。
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
          </div>
          <div class="composer-right">
            <button
              type="button"
              class="prompt-link"
              :title="promptConfigured ? '已自定义系统提示词' : '查看/修改系统提示词'"
              @click="openPrompt"
            >
              {{ promptConfigured ? '提示词 · 已自定义' : '提示词' }}
            </button>
            <span v-if="store.items.length && selected.length === 0" class="composer-warn">
              未选知识库
            </span>
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

    <!-- 引用文档抽屉：右侧滑出、盖在对话上。`:key` 绑文档 id——换一份文档时
         重新播放入场动画并把上一份的切块/预览状态彻底重置 -->
    <DocumentDrawer
      v-if="readerSource"
      :key="readerSource.document_id"
      :document-id="readerSource.document_id"
      :page="readerSource.page"
      @close="closeReader"
    />

    <AppModal v-model:open="promptOpen" title="系统提示词" size="wide">
      <p class="prompt-note">这段文字会拼在每轮提问的最前面。留空即恢复内置提示词。</p>
      <AppInput v-model="promptDraft" multiline :rows="8" placeholder="留空使用内置提示词" />
      <!-- 内置提示词是只读参考：不给出它，"自定义提示词"就变成盲改 -->
      <details v-if="!promptDraft.trim()" class="prompt-builtin">
        <summary>正在使用内置提示词，展开查看</summary>
        <pre class="prompt-builtin-body">{{ DEFAULT_SYSTEM_PROMPT }}</pre>
      </details>
      <template #footer>
        <AppButton @click="promptOpen = false">取消</AppButton>
        <AppButton variant="primary" :disabled="promptSaving" @click="savePrompt">
          {{ promptSaving ? '保存中…' : '保存' }}
        </AppButton>
      </template>
    </AppModal>
  </div>
</template>

<style scoped>
/* 整页占满内容区：中间滚动、底部固定输入卡片。
   **对话页没有页头**（v0.12）：侧栏已经写着"对话"，再顶一个同名标题只是重复。
   `position: relative` 是给"回到最新"浮标定位用的——它要贴在输入卡片的上方。 */
.chat {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  --chat-measure: 960px;
}

.chat-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
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

.welcome-title {
  margin: 0;
  font-size: var(--text-page-title-size);
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--text-primary);
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
  transition: opacity 120ms ease;
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
  border-radius: 999px;
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
  transition: opacity 120ms ease;
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
  line-height: 1.6;
  color: var(--status-warning);
}

/* 「重试」是个文字按钮：它是一句话里的动作，做成实心按钮会把提示的权重抬得过高 */
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

/* 没有新增资料的检索轮次：压暗一档。它和"找到了新东西"的那几轮价值不同，
   一样重会让人以为每一轮都有收获 */
.step-empty .step-label,
.step-empty .step-detail {
  color: var(--text-tertiary);
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

.trace-caret {
  flex: 0 0 auto;
  color: var(--text-tertiary);
  transition: transform 140ms ease;
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

.step {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
}

.step + .step {
  margin-top: var(--space-3);
}

.step-icon {
  position: relative;
  z-index: 1;
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 21px;
  height: 21px;
  color: var(--text-tertiary);
  background: var(--bg-canvas);
  border: 1px solid var(--border);
  border-radius: 999px;
}

.step-body {
  min-width: 0;
  padding-top: 1px;
}

.step-label {
  margin: 0;
  font-size: var(--text-micro-size);
  color: var(--text-secondary);
}

.step-detail {
  margin: var(--space-pair) 0 0;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
  overflow-wrap: anywhere;
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
  border-radius: 999px;
  background: var(--accent);
  animation: thinking-pulse 1.1s ease-in-out infinite;
}

.thinking-text {
  max-height: 220px;
  margin: 0;
  overflow-y: auto;
  font-size: var(--text-micro-size);
  line-height: 1.7;
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

/* 代码块：**横向滚动而不是折行**——折行会让缩进与对齐失真，
   而代码恰恰靠缩进读结构 */
.reply-text :deep(.md-pre) {
  position: relative;
  margin: var(--space-3) 0;
  padding: var(--space-3);
  overflow-x: auto;
  font-size: var(--text-micro-size);
  line-height: 1.6;
  background: var(--bg-subtle);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-control);
}

.reply-text :deep(.md-pre code) {
  padding: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: none;
}

/* 语言名贴在右上角：读者一眼知道这是什么语言，而不必去数关键字 */
.reply-text :deep(.md-pre[data-lang]::before) {
  content: attr(data-lang);
  position: absolute;
  top: 0;
  right: 0;
  padding: var(--space-pair) var(--space-2);
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
  background: var(--bg-active);
  border-bottom-left-radius: var(--radius-control);
}

/* 表格：窄列里必须能横向滚，否则宽表会把整页撑破 */
.reply-text :deep(.md-table-wrap) {
  margin: var(--space-3) 0;
  overflow-x: auto;
}

.reply-text :deep(.md-table) {
  border-collapse: collapse;
  font-size: var(--text-meta-size);
}

.reply-text :deep(.md-table th),
.reply-text :deep(.md-table td) {
  padding: var(--space-2) var(--space-3);
  text-align: left;
  border: 1px solid var(--border-hairline);
}

.reply-text :deep(.md-table th) {
  font-weight: 600;
  color: var(--text-primary);
  background: var(--bg-subtle);
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
  border-radius: 999px;
  box-shadow: var(--shadow-popover);
  transform: translateX(-50%);
}

.to-bottom:hover {
  color: var(--text-primary);
  border-color: var(--border-strong);
}

.composer {
  width: 100%;
  max-width: var(--chat-measure);
  margin: 0 auto;
  padding: var(--space-3) var(--space-4) var(--space-2);
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-panel);
}

/* 卡片里的文本域去掉自己的边框与底色——它是卡片的一部分，不该再套一层框；
   聚焦反馈交给整张卡片（focus-within），这样"在写字"的提示更大、更好认 */
.composer:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.composer :deep(.composer-field) {
  padding: var(--space-1) 0;
  background: transparent;
  border: 0;
  resize: none;
}

.composer :deep(.composer-field:hover),
.composer :deep(.composer-field:focus) {
  border: 0;
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

/* 知识库与模型各占一档宽度（模型的思考设置收在它自己的浮层里） */
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

/* 提示词是低频入口：降级成纯文字，不跟「发送」抢视觉重量 */
.prompt-link {
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.prompt-link:hover {
  color: var(--text-primary);
  text-decoration: underline;
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
  width: var(--control-height);
  height: var(--control-height);
  color: var(--button-primary-text);
  background: var(--button-primary-bg);
  border-radius: 999px;
  transition: background 120ms ease;
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

.prompt-note {
  margin: 0 0 var(--space-3);
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
}

.prompt-builtin {
  margin-top: var(--space-3);
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
}

.prompt-builtin summary {
  cursor: pointer;
}

.prompt-builtin-body {
  margin: var(--space-2) 0 0;
  padding: var(--space-3);
  font-family: inherit;
  font-size: var(--text-meta-size);
  line-height: 1.6;
  color: var(--text-secondary);
  white-space: pre-wrap;
  background: var(--bg-subtle);
  border-radius: var(--radius-control);
}
</style>
