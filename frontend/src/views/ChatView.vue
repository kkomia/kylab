<script setup lang="ts">
/**
 * 对话页（《前端设计规范》§6）：选库 → 提问 → 带原文引用的回答。
 *
 * 它和库内检索面板的分工：检索回答"**哪个块**最像这个问题"，
 * 对话回答"**这些资料**怎么说这个问题"。所以这里的入口是跨库多选，
 * 结果也不再摊开分数与通道，而是正文 + 引用列表——用户要的是结论，不是排名。
 *
 * 两处刻意的设计：
 * 1. 引用块**永远显示**，不折叠。回答是不是有据可依，是这一页存在的理由；
 *    引用藏在"展开"后面，就等于把验证成本推给了用户。
 * 2. 流式时给一个「停止」。模型偶尔会绕远路，而用户在那一刻唯一想要的
 *    就是让它闭嘴——不给这个按钮，他只能刷新页面，连已经看到的部分都丢。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import {
  DEFAULT_SYSTEM_PROMPT,
  chatStream,
  isAbortError,
  type ChatHistoryMessage,
  type ChatSource,
} from '@/api/chat'
import { getConversation } from '@/api/conversations'
import { getSettings, updateSettings } from '@/api/settings'
import IconChat from '@/components/icons/IconChat.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppModal from '@/components/ui/AppModal.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import PageShell from '@/components/ui/PageShell.vue'
import { renderAnswerMarkdown } from '@/composables/useMarkdown'
import { useToast } from '@/composables/useToast'
import { useConversationStore } from '@/stores/conversations'
import { useKnowledgeBaseStore } from '@/stores/knowledgeBases'

/** 会话里带入模型的历史轮数上限：无边界地带上全部历史，提示词会先被自己挤爆。 */
const HISTORY_LIMIT = 6

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

const selectedNames = computed(() =>
  store.items.filter((item) => selected.value.includes(item.id)).map((item) => item.name),
)

onMounted(async () => {
  if (store.items.length === 0) await store.load()
  // 默认全选：打开这一页的人多半就是要问遍手上的资料，让他先做一轮取消勾选是白费功夫
  selected.value = store.items.map((item) => item.id)
  void loadPrompt()
  await loadConversation()
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
})

/** 一个库都没勾时用它一键全选（空状态里的那个按钮）。 */
function selectAll(): void {
  selected.value = store.items.map((item) => item.id)
}

function toggleKb(id: string): void {
  const next = new Set(selected.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  // 按 store 顺序重建，勾选顺序不影响展示
  selected.value = store.items.filter((item) => next.has(item.id)).map((item) => item.id)
}

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

  // 新对话：第一句话落下去之前先建会话，拿到 id 再提问。
  // 反过来（先问再建）会丢掉这一轮的落库——后端要靠 conversation_id 才知道往哪写。
  let target = conversationId.value
  if (!target) {
    try {
      const created = await conversations.create(selected.value)
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
      { query: text, kb_ids: selected.value, history: context, conversation_id: target },
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
  <PageShell
    title="对话"
    description="选一个或多个知识库，直接提问。回答只依据库里的原文，并逐条标出出处。"
  >
    <template #actions>
      <AppButton :disabled="promptLoading" @click="openPrompt">
        <template #icon><IconChat /></template>
        {{ promptConfigured ? '提示词（已自定义）' : '提示词' }}
      </AppButton>
    </template>

    <!-- 选库：这一页唯一的"范围"开关。空选就等于没有资料可依据 -->
    <div class="kb-bar">
      <span class="bar-label">知识库</span>
      <p v-if="store.error" class="bar-note bar-note-error">{{ store.error }}</p>
      <p v-else-if="store.items.length === 0" class="bar-note">
        还没有知识库。先到「知识库」里建一个并上传文档。
      </p>
      <template v-else>
        <label v-for="kb in store.items" :key="kb.id" class="kb-choice">
          <input type="checkbox" :checked="selected.includes(kb.id)" @change="toggleKb(kb.id)" />
          <span class="kb-name">{{ kb.name }}</span>
        </label>
      </template>
      <span v-if="selectedNames.length" class="bar-span tabular"
        >已选 {{ selectedNames.length }} 个</span
      >
    </div>

    <div ref="streamHost" class="stream" @scroll.passive="onStreamScroll">
      <EmptyState
        v-if="messages.length === 0"
        title="选一个知识库，然后提问"
        hint="比如「近视怎么监测眼轴」。回答里带 [1] [2] 的编号，对应下面的原文出处。"
      >
        <!-- 没库可选时这个按钮没有意义，指路比给一个点不动的按钮好 -->
        <RouterLink v-if="store.items.length === 0" to="/knowledge-bases">
          <AppButton variant="primary">去建一个知识库</AppButton>
        </RouterLink>
        <AppButton v-else-if="selected.length === 0" variant="primary" @click="selectAll">
          全选知识库
        </AppButton>
      </EmptyState>

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
            <p v-if="message.streaming && !message.text" class="reply-wait">正在检索并生成回答…</p>
          </template>

          <!-- 引用：回答有没有依据，全看这一块 -->
          <ol v-if="message.sources.length" class="cites">
            <li v-for="source in message.sources" :key="source.chunk_id" class="cite">
              <div class="cite-head">
                <span class="cite-index tabular">[{{ source.index }}]</span>
                <RouterLink class="cite-title" :to="`/documents/${source.document_id}`">
                  {{ source.document_name }}
                </RouterLink>
                <span v-if="sourceWhere(source)" class="cite-where">{{ sourceWhere(source) }}</span>
              </div>
              <p class="cite-preview">{{ sourcePreview(source) }}</p>
            </li>
          </ol>
        </div>
      </article>
    </div>

    <div class="composer">
      <AppInput
        id="chat-query"
        v-model="query"
        multiline
        :rows="3"
        :disabled="sending"
        placeholder="提出你的问题，回车发送，Shift + 回车换行"
        @keydown.enter.exact.prevent="send"
      />
      <div class="composer-actions">
        <span class="composer-hint">
          <template v-if="selectedNames.length"> 将检索：{{ selectedNames.join('、') }} </template>
          <template v-else>未选择知识库，无法提问</template>
        </span>
        <AppButton v-if="sending" variant="danger" @click="stop">停止</AppButton>
        <AppButton v-else variant="primary" :disabled="!canSend" @click="send">发送</AppButton>
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
  </PageShell>
</template>

<style scoped>
.kb-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--bg-canvas);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-panel);
}

.bar-label {
  font-size: var(--text-micro-size);
  font-weight: 500;
  color: var(--text-secondary);
}

.bar-note {
  margin: 0;
  font-size: var(--text-meta-size);
  color: var(--text-tertiary);
}

.bar-note-error {
  color: var(--status-danger);
}

.bar-span {
  margin-left: auto;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

/* 库名可能很长，勾选项限宽并省略，避免一个库名把整行挤成一列 */
.kb-choice {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  height: 28px;
  padding: 0 var(--space-3);
  max-width: 240px;
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
  background: var(--bg-subtle);
  border-radius: var(--radius-control);
  cursor: pointer;
}

.kb-choice:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.kb-choice input[type='checkbox'] {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  accent-color: var(--text-secondary);
}

.kb-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 消息流自己滚：输入框要一直停在视野里，不能跟着回答一起被顶下去 */
.stream {
  overflow-y: auto;
  max-height: 58vh;
  min-height: 240px;
  margin-top: var(--space-5);
}

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

.composer {
  margin-top: var(--space-5);
  padding-top: var(--space-4);
  border-top: 1px solid var(--border-hairline);
}

.composer-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-top: var(--space-3);
}

.composer-hint {
  overflow: hidden;
  min-width: 0;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
  text-overflow: ellipsis;
  white-space: nowrap;
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
