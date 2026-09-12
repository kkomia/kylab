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
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import {
  DEFAULT_SYSTEM_PROMPT,
  chatStream,
  getSuggestedQuestions,
  isAbortError,
  type ChatHistoryMessage,
  type ChatSource,
} from '@/api/chat'
import { getConversation } from '@/api/conversations'
import type { RegisteredModel } from '@/api/modelRegistry'
import { getSettings, updateSettings } from '@/api/settings'
import IconRefresh from '@/components/icons/IconRefresh.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppModal from '@/components/ui/AppModal.vue'
import AppMultiSelect from '@/components/ui/AppMultiSelect.vue'
import ModelPicker from '@/components/ui/ModelPicker.vue'
import { renderAnswerMarkdown } from '@/composables/useMarkdown'
import { useToast } from '@/composables/useToast'
import { useConversationStore } from '@/stores/conversations'
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

type ThinkingEffort = 'low' | 'medium' | 'high'

/** 强度三档。与后端 ``services/thinking.py`` 的归一化口径一致，界面只暴露这三个。 */
const THINKING_EFFORTS: { value: ThinkingEffort; label: string }[] = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
]

interface Message {
  role: 'user' | 'assistant'
  /** 用户消息是提问原文；助手消息是流式累积的回答（或错误文案）。 */
  text: string
  sources: ChatSource[]
  error: string
  streaming: boolean
}

const store = useKnowledgeBaseStore()
const conversations = useConversationStore()
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
 * 当前会话 id。**以路径为唯一来源**，不做本地副本：
 * 侧栏点、前进/后退、直接打开链接三种入口都会改路径，
 * 自己再存一份 state 就得在三个地方同步，迟早不一致。
 */
const conversationId = computed(() => String(route.params.conversationId ?? ''))

/** 没选库时的问题没有可依据的原文，与后端的 kb_ids 必填是同一条约束。 */
const canSend = computed(
  () => selected.value.length > 0 && query.value.trim().length > 0 && !loadingHistory.value,
)

/** 知识库多选的下拉选项（名字给用户看，id 给后端）。 */
const kbOptions = computed(() => store.items.map((item) => ({ value: item.id, label: item.name })))

onMounted(async () => {
  if (store.items.length === 0) await store.load()
  // 默认全选：打开这一页的人多半就是要问遍手上的资料，让他先做一轮取消勾选是白费功夫
  selected.value = store.items.map((item) => item.id)
  void loadPrompt()
  void loadModels()
  await loadConversation()
  scheduleSamples()
})

/**
 * 切换会话时重新装载。
 *
 * **必须 watch 而不是只靠 onMounted**：`/chat` 与 `/chat/:id` 用的是同一个组件，
 * Vue 会复用实例、不会重新挂载——只写在 onMounted 里，从列表点另一条会话时
 * 界面不会有任何变化（这是路由参数类页面最经典的坑）。
 */
watch(conversationId, () => {
  void loadConversation()
})

/** 把库里的历史读进界面。 */
async function loadConversation(): Promise<void> {
  const id = conversationId.value
  if (!id) {
    messages.value = []
    scheduleSamples()
    return
  }
  loadingHistory.value = true
  try {
    const detail = await getConversation(id)
    messages.value = detail.messages.map((item) => ({
      role: item.role === 'user' ? 'user' : 'assistant',
      text: item.content,
      sources: item.sources,
      error: '',
      streaming: false,
    }))
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
  } catch (cause) {
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
      // 用 replace 而不是 push：用户按"新对话"只是想换个会话，
      // 在历史里留一条空的 /chat 没有任何意义，返回时会看到一片空白
      await router.replace(`/chat/${target}`)
    } catch (cause) {
      notifyError(cause instanceof Error ? cause.message : '无法新建对话')
      return
    }
  }

  messages.value = [
    ...messages.value,
    { role: 'user', text, sources: [], error: '', streaming: false },
    { role: 'assistant', text: '', sources: [], error: '', streaming: true },
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
        onSources: (items) => patch({ sources: items }),
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

/** 一轮结束：收掉「停止」，把输入权还给用户。 */
function finish(): void {
  sending.value = false
  stream.value = null
  // 一轮结束后刷新侧栏那一条：标题（首轮才有）与消息数都变了。
  // 只刷这一条而不是整表，避免把用户刚建的其他会话顺序打乱
  if (conversationId.value) void conversations.refreshOne(conversationId.value)
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
  () => messages.value.length + (messages.value.at(-1)?.text.length ?? 0),
  () => {
    if (stick.value) scrollToBottom()
  },
  { flush: 'post' },
)

/** 引用一行："[1] 文档名 › 章节（第 N 页）"——章节与页码可能缺，缺了就不占位。 */
function sourceWhere(source: ChatSource): string {
  const parts: string[] = []
  if (source.heading_path) parts.push(source.heading_path)
  if (source.page !== null) parts.push(`第 ${source.page} 页`)
  return parts.join(' › ')
}

/**
 * 引文在界面上只留一小段。
 *
 * 后端的 preview 上限是 900 字（``MAX_CHUNK_CHARS``），那是给**模型**的上下文预算；
 * 照搬到界面上，六条引用会变成六屏长的文字墙——实测每条都比视口还高，
 * "引用列表"看起来就不再是列表。这里按界面用途再切一刀。
 */
const CITE_PREVIEW_CHARS = 120

function sourcePreview(source: ChatSource): string {
  const body = source.preview
  return body.length > CITE_PREVIEW_CHARS ? `${body.slice(0, CITE_PREVIEW_CHARS)}…` : body
}

// ------------------------------------------------------------------ 对话模型（v12）

const registry = computed(() => registryStore.registry)
/** 是否已经拿到过注册表。没拿到之前不显示"未配置对话模型"——那会把加载中误报成没配。 */
const modelsLoaded = computed(() => registryStore.loaded)
/** 当前选用的注册模型 pk；空串 = 交给后端的全局默认。 */
const modelPk = ref(readStored(LAST_MODEL_KEY))

/** 可对话的模型：供应商启用，且能力为空或含 chat（与设置页同一套筛选口径）。 */
const chatModels = computed<RegisteredModel[]>(() => {
  const reg = registry.value
  if (!reg) return []
  return reg.models.filter((model) => {
    const owner = reg.providers.find((item) => item.id === model.provider_id)
    if (!owner || !owner.enabled) return false
    return model.capabilities.length === 0 || model.capabilities.includes('chat')
  })
})

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
function scheduleSamples(refresh = false): void {
  window.clearTimeout(samplesTimer)
  if (messages.value.length > 0 || selected.value.length === 0) {
    suggested.value = []
    return
  }
  samplesTimer = window.setTimeout(() => void loadSamples(refresh), refresh ? 0 : 400)
}

async function loadSamples(refresh: boolean): Promise<void> {
  if (messages.value.length > 0 || selected.value.length === 0) return
  samplesLoading.value = true
  try {
    const result = await getSuggestedQuestions(selected.value, {
      limit: SAMPLE_COUNT,
      modelPk: modelPk.value || undefined,
      refresh,
    })
    suggested.value = result.questions
  } catch {
    // 生成只是引导：失败就回退静态样例，别把空状态变成错误提示
    suggested.value = []
  } finally {
    samplesLoading.value = false
  }
}

/** 「换一批」：有生成结果就重新生成；否则只是轮换静态样例。 */
function shuffleSamples(): void {
  if (suggested.value.length > 0) {
    void loadSamples(true)
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
      <div class="chat-inner" :class="{ 'chat-inner-welcome': messages.length === 0 }">
        <!-- 空状态：居中问候 + 示例问题（参考 WeKnora 的欢迎层）。
             有消息之后整块消失，让位给正文——它不是常驻装饰。 -->
        <div v-if="messages.length === 0" class="welcome">
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

        <article v-for="(message, index) in messages" :key="index" class="turn">
          <div v-if="message.role === 'user'" class="ask">
            <p class="ask-label">我的问题</p>
            <p class="ask-text">{{ message.text }}</p>
          </div>

          <div v-else class="reply">
            <p class="reply-label">回答</p>

            <p v-if="message.error" class="reply-error">{{ message.error }}</p>

            <template v-else>
              <!--
                回答是模型写的 Markdown。这里用 v-html 是刻意的：renderAnswerMarkdown 会先转义
                全部 HTML，再只还原它自己识别出的标记（tests/unit/composables/useMarkdown.test.ts
                里有对应的注入用例）。换成插值就等于把 ** 和 - 原样摆给用户看。
              -->
              <!-- eslint-disable vue/no-v-html -->
              <div
                class="reply-text"
                :class="{ 'reply-text-streaming': message.streaming }"
                v-html="renderAnswerMarkdown(message.text)"
              />
              <!-- eslint-enable vue/no-v-html -->
              <p v-if="message.streaming && !message.text" class="reply-wait">
                正在检索并生成回答…
              </p>
            </template>

            <!-- 引用：回答有没有依据，全看这一块 -->
            <ol v-if="message.sources.length" class="cites">
              <li v-for="source in message.sources" :key="source.chunk_id" class="cite">
                <div class="cite-head">
                  <span class="cite-index tabular">[{{ source.index }}]</span>
                  <!-- 带页码时把页码也带过去：详情页会转成 PDF 查看器的 #page=N 直接跳页，
                       不带的话用户还得自己在长文档里翻 -->
                  <RouterLink
                    class="cite-title"
                    :to="{
                      path: `/documents/${source.document_id}`,
                      query: source.page === null ? {} : { page: String(source.page) },
                    }"
                  >
                    {{ source.document_name }}
                  </RouterLink>
                  <span v-if="sourceWhere(source)" class="cite-where">{{
                    sourceWhere(source)
                  }}</span>
                </div>
                <p class="cite-preview">{{ sourcePreview(source) }}</p>
              </li>
            </ol>
          </div>
        </article>
      </div>
    </div>

    <!-- 输入卡片：参考 WeKnora——一个大圆角框，范围与模型都收在框内底部。
         我们的"模式"等价物是**知识库范围**：它决定这一问依据什么，空选就没有依据。 -->
    <div class="composer-wrap">
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
            <AppButton v-if="sending" variant="danger" @click="stop">停止</AppButton>
            <AppButton v-else variant="primary" :disabled="!canSend" @click="send">发送</AppButton>
          </div>
        </div>
      </div>
    </div>

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
   **对话页没有页头**（v0.12）：侧栏已经写着"对话"，再顶一个同名标题只是重复。 */
.chat {
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

.chat-inner {
  width: 100%;
  max-width: var(--chat-measure);
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

.ask-label,
.reply-label {
  margin: 0 0 var(--space-1);
  font-size: var(--text-micro-size);
  font-weight: 500;
  letter-spacing: 0.06em;
  color: var(--text-tertiary);
}

/* 提问用左侧竖线认领：整块换底色会跟回答抢同一层视觉重量，而回答才是主体。
   竖线只跟到文字长度：撑满整行的话，一个短问题会拖着一条长线跑到屏幕那头 */
.ask {
  display: inline-block;
  padding-left: var(--space-3);
  border-left: 2px solid var(--border-strong);
}

.ask-text {
  margin: 0;
  max-width: var(--measure);
  font-size: var(--text-section-size);
  color: var(--text-primary);
}

.reply {
  margin-top: var(--space-4);
}

.reply-text {
  max-width: var(--measure);
  color: var(--text-primary);
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

.reply-text :deep(code) {
  padding: 0 var(--space-1);
  font-size: var(--text-meta-size);
  background: var(--bg-subtle);
  border-radius: var(--radius-control);
}

.reply-wait,
.reply-error {
  margin: 0;
  max-width: var(--measure);
  font-size: var(--text-meta-size);
}

.reply-wait {
  color: var(--text-tertiary);
}

.reply-error {
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
  margin: var(--space-4) 0 0;
  padding: 0;
  list-style: none;
  border-top: 1px solid var(--border-hairline);
}

.cite {
  padding: var(--space-3) 0;
}

.cite + .cite {
  border-top: 1px solid var(--border-hairline);
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

.cite-title {
  font-weight: 500;
  color: var(--text-primary);
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
  margin: var(--space-1) 0 0;
  overflow: hidden;
  max-width: var(--measure);
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

/* ---- 输入卡片 ---- */

.composer-wrap {
  flex: 0 0 auto;
  padding: 0 var(--page-gutter) var(--space-5);
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
