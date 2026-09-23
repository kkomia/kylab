<script setup lang="ts">
/**
 * 笔记页：左侧时间线列表 + 右侧编辑器（《笔记功能调研》§3.5）。
 *
 * 版式对齐 ima 笔记：列表是**扁平分组**（置顶 / 今天 / 过去 7 天 / 过去 30 天 / 更早），
 * 不是一叠带边框的卡片；编辑器无卡片边框，工具栏在最上、标题在文档里、正文走窄栏。
 * 信息架构仍收敛在一个视图内（列表 → 编辑都在本页），侧栏只多一个入口。
 *
 * 保存：`content_md`/标题/标签/置顶变化后**防抖自动保存**（800ms），
 * 同时保留 Ctrl/Cmd+S；切换笔记前先落盘。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import type { Note, NoteAiAction, NoteListItem } from '@/api/notes'
import { aiTransform } from '@/api/notes'
import IconCheck from '@/components/icons/IconCheck.vue'
import IconChevronLeft from '@/components/icons/IconChevronLeft.vue'
import IconChevronRight from '@/components/icons/IconChevronRight.vue'
import IconLibrary from '@/components/icons/IconLibrary.vue'
import IconPin from '@/components/icons/IconPin.vue'
import IconPlus from '@/components/icons/IconPlus.vue'
import IconSearch from '@/components/icons/IconSearch.vue'
import IconTrash from '@/components/icons/IconTrash.vue'
import NoteEditor from '@/components/notes/NoteEditor.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppModal from '@/components/ui/AppModal.vue'
import AppSelect from '@/components/ui/AppSelect.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { useToast } from '@/composables/useToast'
import { useKnowledgeBaseStore } from '@/stores/knowledgeBases'
import { latestNoteId, useNoteStore } from '@/stores/notes'

interface Draft {
  id: string
  title: string
  content_md: string
  tags: string[]
  pinned: boolean
  kb_id: string | null
  doc_id: string | null
  updated_at: string | null
}

/** 页面只关心这些字段：缓存里的正文、服务端详情、草稿都满足这个形状。 */
type NoteBodyLike = Pick<
  Note,
  'id' | 'title' | 'content_md' | 'tags' | 'pinned' | 'kb_id' | 'doc_id' | 'updated_at'
>

/**
 * 切换时"压暗旧内容"的启动延迟。
 *
 * 比这更快到货的切换（命中缓存、局域网快往返）**完全不压暗**——
 * 快路径不该被动画拖慢，看起来就该是瞬移；只有真的在等网络时才给一个过渡，
 * 让这段时间有交代，而不是画面僵住再硬切。
 */
const SWITCH_DIM_DELAY_MS = 120

interface Group {
  label: string
  items: NoteListItem[]
}

const route = useRoute()
const router = useRouter()
const store = useNoteStore()
const kbs = useKnowledgeBaseStore()
const { notifyError, notifySuccess } = useToast()

const draft = ref<Draft | null>(null)
/** 灌入内容时抑制自动保存：装载不是"用户改了字"。 */
const hydrating = ref(false)
const saveState = ref<'idle' | 'saving' | 'saved' | 'error'>('idle')
/** 最近一次保存成功的时刻：只显示"已保存"看不出"什么时候存的"。 */
const savedAt = ref<Date | null>(null)

const searchInput = ref(store.query)
const tagDraft = ref('')
const aiBusy = ref(false)
const attachOpen = ref(false)
const attachKb = ref('')
const attaching = ref(false)
const deleteOpen = ref(false)
const deleting = ref(false)

const editorRef = ref<InstanceType<typeof NoteEditor> | null>(null)

/**
 * 列表折叠（本机偏好）。
 *
 * 与侧栏折叠同一类东西——**"这台机器怎么显示"**，所以落 `localStorage`，
 * 不进后端设置；换台机器该重新选。
 *
 * 折叠态做成一条窄导轨而不是整列消失：**回来的入口必须留在原地**，
 * 否则想看列表就得先猜"从哪儿能把它叫回来"。
 */
const NOTES_LIST_COLLAPSED_STORAGE_KEY = 'kylab-notes-list-collapsed'

function readListCollapsed(): boolean {
  try {
    return window.localStorage.getItem(NOTES_LIST_COLLAPSED_STORAGE_KEY) === '1'
  } catch {
    // 隐私模式下 localStorage 不可读：退化成"展开"
    return false
  }
}

/** 初值就来自存储：**刷新之后保持折叠**，而不是先展开再收起来（那会闪一下）。 */
const listCollapsed = ref(readListCollapsed())

function setListCollapsed(next: boolean): void {
  listCollapsed.value = next
  try {
    if (next) window.localStorage.setItem(NOTES_LIST_COLLAPSED_STORAGE_KEY, '1')
    else window.localStorage.removeItem(NOTES_LIST_COLLAPSED_STORAGE_KEY)
  } catch {
    // 存不上就只在本次会话生效
  }
}

function toggleListCollapsed(): void {
  setListCollapsed(!listCollapsed.value)
}

const kbOptions = computed(() => kbs.items.map((kb) => ({ value: kb.id, label: kb.name })))
const activeKbName = computed(() => kbs.byId(draft.value?.kb_id ?? '')?.name ?? '')

/** 缓存未命中、正文还在路上：给编辑区一个过渡（延迟后才亮，见 SWITCH_DIM_DELAY_MS）。 */
const switching = ref(false)

let saveTimer: ReturnType<typeof setTimeout> | undefined
let searchTimer: ReturnType<typeof setTimeout> | undefined
let switchDimTimer: ReturnType<typeof setTimeout> | undefined
/** 切换请求的序号：迟到的响应不许覆盖后点的笔记，也不许乱灭"加载中"。 */
let switchToken = 0

/**
 * 已落盘内容的指纹。保存前比一次：没改过就不发请求。
 *
 * 切换笔记时原来会无条件 PATCH 一次（哪怕一个字没动），既是一次白写的数据库事务，
 * 也是切换延迟里的一段。存个指纹就能直接把这次往返省掉。
 */
let savedSnapshot = ''

function snapshotOf(item: Pick<Draft, 'title' | 'content_md' | 'tags' | 'pinned'>): string {
  return `${item.title}\u0000${item.content_md}\u0000${item.tags.join('\u0001')}\u0000${item.pinned ? '1' : '0'}`
}

/**
 * 鼠标移到列表项上时：先取正文，取到后**在空闲时间把它预先解析成文档**。
 *
 * 从 hover 到点击通常有百来毫秒，够这两件事都不落在点击路径上——
 * 于是切换只剩一次 state 替换，大笔记也不会在点击后卡一下。
 * 只保留最后一次悬停的预热（连扫多行不会排一队解析）。
 */
let warmToken = 0

function scheduleWarm(markdown: string): void {
  const token = ++warmToken
  const run = (): void => {
    if (token === warmToken) editorRef.value?.warm(markdown)
  }
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 300 })
  else setTimeout(run, 0)
}

function onNoteHover(noteId: string): void {
  void store.prefetch(noteId).then((note) => {
    if (note) scheduleWarm(note.content_md)
  })
}

function beginSwitchWait(token: number): void {
  if (switchDimTimer) clearTimeout(switchDimTimer)
  switchDimTimer = setTimeout(() => {
    if (token === switchToken) switching.value = true
  }, SWITCH_DIM_DELAY_MS)
}

function endSwitchWait(token: number): void {
  if (token !== switchToken) return
  if (switchDimTimer) {
    clearTimeout(switchDimTimer)
    switchDimTimer = undefined
  }
  switching.value = false
}

function timeOf(item: NoteListItem): number {
  return item.updated_at ? new Date(item.updated_at).getTime() : 0
}

function shortDate(item: NoteListItem): string {
  const at = timeOf(item)
  if (!at) return ''
  const date = new Date(at)
  return `${date.getMonth() + 1}/${date.getDate()}`
}

/** 置顶单独一组，其余按时间分桶——和 ima 的时间线分组同一套读法。 */
const groups = computed<Group[]>(() => {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const day = 86_400_000
  const buckets: Group[] = []
  const pinned = store.items.filter((item) => item.pinned)
  if (pinned.length) buckets.push({ label: '置顶', items: pinned })
  const rest = store.items.filter((item) => !item.pinned)
  const defs: { label: string; test: (at: number) => boolean }[] = [
    { label: '今天', test: (at) => at >= startOfToday },
    { label: '过去 7 天', test: (at) => at >= startOfToday - 6 * day },
    { label: '过去 30 天', test: (at) => at >= startOfToday - 29 * day },
    { label: '更早', test: () => true },
  ]
  const used = new Set<string>()
  for (const def of defs) {
    const items = rest.filter((item) => !used.has(item.id) && def.test(timeOf(item)))
    for (const item of items) used.add(item.id)
    if (items.length) buckets.push({ label: def.label, items })
  }
  return buckets
})

function applyNote(note: NoteBodyLike): void {
  hydrating.value = true
  draft.value = {
    id: note.id,
    title: note.title,
    content_md: note.content_md,
    tags: [...note.tags],
    pinned: note.pinned,
    kb_id: note.kb_id,
    doc_id: note.doc_id,
    updated_at: note.updated_at,
  }
  tagDraft.value = ''
  // 状态直接落到"已保存 <这条笔记的上次保存时间>"，而不是先清空再等下一次保存：
  // 清空会让标签在切换时闪一下再消失，而库里本来就存着这个时间，照实显示即可。
  saveState.value = 'saved'
  savedAt.value = note.updated_at ? new Date(note.updated_at) : null
  savedSnapshot = snapshotOf(draft.value)
  // 等这次赋值引发的 watch 跑完再解除抑制，否则装载会被当成一次编辑并触发自动保存
  void nextTick(() => {
    hydrating.value = false
  })
}

/**
 * 切到路由上的那条笔记。
 *
 * 三条路径，按代价从低到高：
 * 1. 就是当前这条 → 什么都不做；
 * 2. 正文在本地缓存里（刚看过、或 hover 时已预取）→ **同步上屏，零等待**；
 * 3. 缓存没有 → 请求详情，期间给编辑区一个延迟生效的压暗过渡。
 *
 * 两条旧实现里的坑，这里都绕开了：
 * - 不再 `await saveNow()` 再 `fetch()`：保存旧笔记与读取新笔记之间没有先后依赖，
 *   串行只是白等一个往返。现在保存**不阻塞**（`flush` 只发不等）。
 * - 离开前把旧笔记的当前正文写进本地缓存：这样"改完立刻切走再切回来"
 *   看到的是自己刚写的内容，而不是一个还在飞的保存里的旧版本。
 */
async function loadFromRoute(): Promise<void> {
  const token = ++switchToken
  const id = String(route.params.noteId ?? '')
  if (!id) {
    endSwitchWait(token)
    await openLatest()
    return
  }
  if (draft.value?.id === id) {
    endSwitchWait(token)
    return
  }
  const leaving = draft.value
  if (leaving) {
    store.remember({ ...leaving })
    flush(leaving)
  }
  const cached = store.cached(id)
  if (cached) {
    applyNote(cached)
    endSwitchWait(token)
    return
  }
  beginSwitchWait(token)
  try {
    const note = await store.fetch(id)
    // 取回来的路上用户可能又切走了：别把旧请求的结果盖到新笔记上
    if (token !== switchToken) return
    applyNote(note)
  } catch (cause) {
    if (token !== switchToken) return
    notifyError(cause instanceof Error ? cause.message : '笔记加载失败')
    draft.value = null
  } finally {
    endSwitchWait(token)
  }
}

/**
 * 没有指定笔记时，**默认打开最新的一条**（与「对话」入口同一套语义：
 * 既然已经有「新建」按钮，入口就该回到上次写的那条，而不是停在一个空页面）。
 *
 * 等待列表期间用户可能已经点了某条（或点了新建）——那就不许再改路径，
 * 否则会把刚打开的那条顶掉（`ChatView` 的 `enterChat` 踩过同一个坑）。
 */
async function openLatest(): Promise<void> {
  if (!store.items.length) await store.load()
  if (route.params.noteId) return
  const latest = latestNoteId(store.items)
  if (latest) {
    await router.replace(`/notes/${latest}`)
    return
  }
  draft.value = null // 一条都没有：显示空态，让用户去点「新建」
}

watch(
  () => route.params.noteId,
  () => void loadFromRoute(),
  { immediate: true },
)

watch(
  () => {
    const item = draft.value
    return item
      ? `${item.title}\u0000${item.content_md}\u0000${item.tags.join('\u0001')}\u0000${item.pinned}`
      : ''
  },
  () => {
    if (hydrating.value || !draft.value) return
    // 刻意不在这里把状态退回 idle：那会让"已保存 12:30"在每次敲字时先消失、
    // 800ms 后再出现，看起来像闪烁。让上一行保存结果留着，等真正开始保存再变。
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => void saveNow(), 800)
  },
)

/**
 * 保存当前笔记（Ctrl/Cmd+S、AI、入库前的落盘）。
 *
 * `silent`：切换/新建这种"马上就要离开这条笔记"的场合用——照常落盘，
 * 但**不碰保存状态**（那个标签立刻要归下一条笔记，亮一下再消失就是闪烁）。
 */
async function saveNow(options: { silent?: boolean } = {}): Promise<void> {
  const item = draft.value
  if (!item || hydrating.value) return
  await saveDraft(item, options)
}

/**
 * 落盘一份草稿快照。
 *
 * 注意它接收的是**快照对象**而不是读 `draft.value`：切换笔记时的保存是"不等结果"的，
 * 等响应回来时 `draft` 早就换成下一条了——如果那时才去读，就会把下一条的内容
 * 写进上一条。
 *
 * 没改动（指纹一致）直接返回：不发请求、也不动保存标签。
 */
async function saveDraft(item: Draft, options: { silent?: boolean } = {}): Promise<void> {
  const snap = snapshotOf(item)
  if (snap === savedSnapshot) return
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = undefined
  }
  if (!options.silent) saveState.value = 'saving'
  try {
    const updated = await store.save(item.id, {
      title: item.title,
      content_md: item.content_md,
      pinned: item.pinned,
      tags: item.tags,
    })
    item.kb_id = updated.kb_id
    item.doc_id = updated.doc_id
    item.updated_at = updated.updated_at
    // 只有它还是当前笔记时才碰界面状态；离开的笔记的响应不许改新笔记的标签。
    // 指纹只推进到**这次真正发出去的那份**：请求期间用户又敲的字仍算未保存，
    // 会被防抖保存接着写出去，不会被误判成已保存。
    if (item.id !== draft.value?.id) return
    savedSnapshot = snap
    if (options.silent) return
    savedAt.value = new Date()
    saveState.value = 'saved'
  } catch (cause) {
    if (item.id === draft.value?.id && !options.silent) saveState.value = 'error'
    notifyError(cause instanceof Error ? cause.message : '保存失败')
  }
}

/**
 * 离开一条笔记前把它落盘——**只发不等**。
 *
 * 新笔记的读取与旧笔记的写入彼此独立，串起来只是让用户多等一个往返。
 * 顺带清掉防抖定时器：留着它会在 800ms 后用**新笔记**的草稿去触发保存。
 */
function flush(item: Draft): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = undefined
  }
  if (snapshotOf(item) === savedSnapshot) return
  void saveDraft(item, { silent: true })
}

/** 同一天只给时间；跨天带上日期——否则"已保存 09:12"看不出是哪天的 09:12。 */
function formatSavedAt(date: Date): string {
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return sameDay ? `${hh}:${mm}` : `${date.getMonth() + 1}/${date.getDate()} ${hh}:${mm}`
}

const saveLabel = computed(() => {
  if (saveState.value === 'saving') return '保存中…'
  if (saveState.value === 'saved') {
    return savedAt.value ? `已保存 ${formatSavedAt(savedAt.value)}` : '已保存'
  }
  if (saveState.value === 'error') return '保存失败'
  return ''
})

function onKeydown(event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    void saveNow()
  }
}

/** 标签是"顺手贴的分类"：空格/逗号/回车都能提交，最多 8 个、单个 24 字。 */
function commitTag(): void {
  const item = draft.value
  if (!item) return
  const parts = tagDraft.value
    .split(/[\s,，、]+/)
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length) {
    const next = [...item.tags]
    for (const part of parts) {
      const tag = part.slice(0, 24)
      if (!next.includes(tag) && next.length < 8) next.push(tag)
    }
    item.tags = next
  }
  tagDraft.value = ''
}

function onTagKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
    event.preventDefault()
    commitTag()
  } else if (event.key === 'Backspace' && !tagDraft.value && draft.value?.tags.length) {
    // 空输入时退格删掉最后一个：标签编辑的通用手感
    draft.value.tags = draft.value.tags.slice(0, -1)
  }
}

function removeTag(tag: string): void {
  if (draft.value) draft.value.tags = draft.value.tags.filter((item) => item !== tag)
}

async function createNew(): Promise<void> {
  try {
    // 同样要离开当前这条：留一份本地副本并安静落盘（不等结果），
    // 别让保存状态在新笔记的工具栏上闪一下
    const leaving = draft.value
    if (leaving) {
      store.remember({ ...leaving })
      flush(leaving)
    }
    const note = await store.create({ title: '', content_md: '' })
    await router.push(`/notes/${note.id}`)
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '新建失败')
  }
}

/**
 * 列表出来之后，趁空闲把**最靠前的几条**正文先取回来。
 *
 * 用户最先点的通常就是列表头部这几条（刚写过、刚看过），提前取好，
 * 就算他没悬停、直接点，切换也不必等一个往返。只取前几条是刻意的：
 * 整表预取会在打开页面时打出一串请求，得不偿失。
 */
const PREFETCH_TOP_N = 6

function prefetchTopNotes(): void {
  const ids = store.items.slice(0, PREFETCH_TOP_N).map((item) => item.id)
  const run = (): void => {
    for (const id of ids) void store.prefetch(id)
  }
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 800 })
  else setTimeout(run, 0)
}

function onSearchInput(): void {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(
    () => void store.setFilter(searchInput.value.trim(), store.activeTag),
    300,
  )
}

// 用 watch 而不是给 AppInput 挂 @input：那个组件只发 update:modelValue，
// 靠属性透传碰巧也能收到原生 input，但那是实现细节，不该依赖
watch(searchInput, onSearchInput)

function onTitleEnter(): void {
  ;(document.activeElement as HTMLElement | null)?.blur()
}

/** 编辑器内的提示（图片上传失败等）由页面统一弹。 */
function onEditorNotify(payload: { type: 'error' | 'success'; message: string }): void {
  if (payload.type === 'error') notifyError(payload.message)
  else notifySuccess(payload.message)
}

/**
 * 执行一次 AI 处理。
 *
 * 顺序要紧：**先把当前改动落盘**，因为后端处理的是库里保存的正文——
 * 不保存就会出现"AI 整理的是旧版本"这种很难察觉的错位。
 * 结果写回 `draft.content_md`，随后由正常的防抖保存持久化；空结果不覆盖原文。
 */
async function runAi(action: NoteAiAction): Promise<void> {
  const item = draft.value
  if (!item || aiBusy.value) return
  aiBusy.value = true
  try {
    await saveNow()
    const result = await aiTransform(item.id, action)
    if (!result.content_md.trim()) {
      notifyError('AI 没有返回内容，正文保持原样')
      return
    }
    item.content_md = result.content_md
    notifySuccess('AI 处理完成；不满意可以用工具栏的撤销或直接改')
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : 'AI 处理失败')
  } finally {
    aiBusy.value = false
  }
}

async function toggleTag(tag: string): Promise<void> {
  await store.setFilter(searchInput.value.trim(), store.activeTag === tag ? '' : tag)
}

function togglePinned(): void {
  if (draft.value) draft.value.pinned = !draft.value.pinned
}

function openAttach(): void {
  if (!kbOptions.value.length) {
    notifyError('还没有知识库，先去「知识库」新建一个')
    return
  }
  attachKb.value = draft.value?.kb_id ?? kbOptions.value[0].value
  attachOpen.value = true
}

async function confirmAttach(): Promise<void> {
  if (!draft.value || !attachKb.value) return
  attaching.value = true
  try {
    // 先落盘再入库：入库读的是库里的正文，未保存的改动不该被漏掉
    await saveNow()
    const updated = await store.attach(draft.value.id, attachKb.value)
    draft.value.kb_id = updated.kb_id
    draft.value.doc_id = updated.doc_id
    attachOpen.value = false
    notifySuccess('已加入知识库，之后可以在检索里命中这条笔记')
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '加入知识库失败')
  } finally {
    attaching.value = false
  }
}

async function confirmDelete(): Promise<void> {
  if (!draft.value) return
  deleting.value = true
  try {
    await store.remove(draft.value.id)
    deleteOpen.value = false
    draft.value = null
    await router.replace('/notes')
    notifySuccess('笔记已删除')
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '删除失败')
  } finally {
    deleting.value = false
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  void store.load().then(prefetchTopNotes)
  void store.loadTags()
  void kbs.load()
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  if (saveTimer) clearTimeout(saveTimer)
  if (searchTimer) clearTimeout(searchTimer)
  if (switchDimTimer) clearTimeout(switchDimTimer)
})
</script>

<template>
  <!-- 刻意不用 PageShell：这一页的第一屏应当是"列表头 + 编辑器工具栏"，
       而不是通用页头（大标题 + 说明）。工具型界面里那两行只是占地方。 -->
  <div class="notes-page">
    <div class="notes-layout" :class="{ 'list-collapsed': listCollapsed }">
      <aside class="notes-list">
        <div class="list-head">
          <template v-if="!listCollapsed">
            <p class="list-title">
              全部<span class="list-count tabular">{{ store.total }}</span>
            </p>
            <button type="button" class="icon-action" title="新建笔记" @click="createNew">
              <IconPlus :size="16" />
            </button>
          </template>
          <!-- 折叠开关：箭头指向"列表会往哪边收"，展开态在右、折叠态独居导轨中央 -->
          <button
            type="button"
            class="icon-action collapse-toggle"
            :title="listCollapsed ? '展开列表' : '折叠列表'"
            :aria-label="listCollapsed ? '展开笔记列表' : '折叠笔记列表'"
            :aria-expanded="!listCollapsed"
            @click="toggleListCollapsed"
          >
            <IconChevronRight v-if="listCollapsed" :size="16" />
            <IconChevronLeft v-else :size="16" />
          </button>
        </div>

        <!-- 折叠后整块列表**移出 DOM**（不只是 CSS 藏起来）：导轨里再养着搜索框
             与上百行列表没有意义，而且它们还得继续跟着 store 变化重渲染 -->
        <template v-if="!listCollapsed">
          <div class="search-box">
            <IconSearch :size="14" class="search-icon" />
            <AppInput v-model="searchInput" placeholder="搜索标题与正文" aria-label="搜索笔记" />
          </div>

          <div v-if="store.tags.length" class="tag-bar">
            <button
              v-for="item in store.tags"
              :key="item.tag"
              type="button"
              class="tag-chip"
              :class="{ 'tag-on': store.activeTag === item.tag }"
              @click="toggleTag(item.tag)"
            >
              {{ item.tag }}<span class="tag-count tabular">{{ item.count }}</span>
            </button>
          </div>

          <p v-if="store.error" class="list-hint list-error">{{ store.error }}</p>
          <EmptyState
            v-else-if="!store.loading && !store.items.length"
            title="还没有笔记"
            hint="点右上角的 + 写第一条"
          />
          <div v-else class="note-groups">
            <section v-for="group in groups" :key="group.label" class="note-group">
              <p class="group-label">{{ group.label }}</p>
              <ul class="note-items">
                <li v-for="item in group.items" :key="item.id">
                  <RouterLink
                    class="note-item"
                    :class="{ 'note-item-active': item.id === draft?.id }"
                    :to="`/notes/${item.id}`"
                    @pointerenter="onNoteHover(item.id)"
                    @pointerdown="onNoteHover(item.id)"
                    @focus="onNoteHover(item.id)"
                  >
                    <span class="note-item-title">
                      <IconPin v-if="item.pinned" :size="12" class="pin-icon" />
                      {{ item.title || '未命名笔记' }}
                    </span>
                    <span class="note-item-meta">
                      <span class="note-item-preview">{{ item.preview || '（空）' }}</span>
                      <span class="note-item-tail">
                        <IconLibrary v-if="item.doc_id" :size="12" title="已加入知识库" />
                        <span class="tabular">{{ shortDate(item) }}</span>
                      </span>
                    </span>
                  </RouterLink>
                </li>
              </ul>
            </section>
          </div>
        </template>
      </aside>

      <section class="notes-pane">
        <!-- **不要**在切换时把编辑器换成"加载中"占位：那会卸载并重建整个 Tiptap
             （工具栏、扩展、DOM 全部重来），切换笔记看起来就像卡了一下。
             这里让它一直挂着，只换内容——同类型笔记之间没有必须重建的东西。 -->
        <NoteEditor
          v-if="draft"
          ref="editorRef"
          v-model="draft.content_md"
          class="pane-editor"
          :note-id="draft.id"
          :ai-busy="aiBusy"
          :loading="switching"
          @notify="onEditorNotify"
          @ai="runAi"
        >
          <template #status>
            <span class="save-label" :class="{ 'save-error': saveState === 'error' }">{{
              saveLabel
            }}</span>
          </template>

          <template #actions>
            <button
              type="button"
              class="icon-action"
              :class="{ 'icon-action-on': draft.pinned }"
              :title="draft.pinned ? '取消置顶' : '置顶'"
              @click="togglePinned"
            >
              <IconPin :size="15" />
            </button>
            <button
              type="button"
              class="icon-action"
              :class="{ 'icon-action-on': draft.doc_id }"
              :title="draft.doc_id ? `已加入「${activeKbName}」` : '加入知识库'"
              @click="openAttach"
            >
              <IconLibrary :size="15" />
            </button>
            <button
              type="button"
              class="icon-action icon-action-danger"
              title="删除"
              @click="deleteOpen = true"
            >
              <IconTrash :size="15" />
            </button>
          </template>

          <template #header>
            <input
              v-model="draft.title"
              class="doc-title"
              placeholder="标题"
              aria-label="笔记标题"
              @keydown.enter.prevent="onTitleEnter"
            />
            <div class="tag-row">
              <span v-for="tag in draft.tags" :key="tag" class="tag-pill">
                {{ tag }}
                <button
                  type="button"
                  class="tag-remove"
                  :title="`移除 ${tag}`"
                  @click="removeTag(tag)"
                >
                  ×
                </button>
              </span>
              <input
                v-model="tagDraft"
                class="tag-entry"
                :placeholder="draft.tags.length ? '' : '＋ 标签'"
                aria-label="添加标签"
                @keydown="onTagKeydown"
                @blur="commitTag"
              />
            </div>
            <div v-if="draft.doc_id" class="doc-status">
              <IconCheck :size="13" />
              已加入知识库「{{ activeKbName }}」
              <RouterLink class="doc-link" :to="`/documents/${draft.doc_id}`">查看文档</RouterLink>
            </div>
          </template>
        </NoteEditor>
        <div v-else class="pane-empty">
          <EmptyState title="选择一条笔记开始编辑" hint="或点左上角的 + 写一条新的" />
        </div>
      </section>
    </div>

    <ConfirmDialog
      v-model:open="deleteOpen"
      title="删除这条笔记？"
      lead="删除后无法恢复。已加入知识库生成的文档不会跟着删除。"
      :busy="deleting"
      @confirm="confirmDelete"
    />

    <AppModal v-model:open="attachOpen" title="加入知识库" size="md">
      <p class="modal-lead">
        笔记会作为一份 Markdown 文档进入选中的知识库，之后检索与问答都能命中它。
      </p>
      <label class="field">
        <span class="field-label">目标知识库</span>
        <AppSelect v-model="attachKb" :options="kbOptions" aria-label="目标知识库" />
      </label>
      <template #footer>
        <AppButton @click="attachOpen = false">取消</AppButton>
        <AppButton variant="primary" :disabled="attaching" @click="confirmAttach">
          {{ attaching ? '处理中…' : '加入' }}
        </AppButton>
      </template>
    </AppModal>
  </div>
</template>

<style scoped>
/* 没有通用页头，顶部内边距收得很小：第一眼就是列表头与工具栏。
 *
 * 这一页**自己占满内容区**（`height: 100%`，与 ChatView 的 `.chat` 同一个做法）：
 * 外层 `main.content` 于是没有东西可滚，滚动条落到下面两列自己身上。
 * 高度链一环都不能少——`html/body/#app` 到 `.shell` 都是 `height: 100%`，
 * `.content` 作为 flex 项被拉伸，再到这一层与 `.notes-layout`；
 * 断在哪一环，百分比都退化成"内容高"，两列就又会合并成同一条滚动条。 */
.notes-page {
  height: 100%;
  padding: var(--space-3) var(--page-gutter) var(--space-8);
}

/* 分栏：**两列各自滚**。
 *
 * 原先这里写着 `align-items: start`：两列各按**内容高**排版，页面被正文撑得很长，
 * 滚动只能落在最外层——正文一滚，左边那份并不长的目录也被一起带走（用户报的现象）。
 * 去掉它（grid 默认 stretch）并给容器定高，两列的高度才等于"可用高度"，
 * 各自的 `overflow-y: auto` 也才真的滚得起来。 */
.notes-layout {
  display: grid;
  grid-template-columns: minmax(240px, 300px) minmax(0, 1fr);
  height: 100%;
}

/* 折叠态：列表收成一条窄导轨（44 = 28px 的按钮 + 两侧各 8px 内边距），
   省下来的这一栏**整份给正文**——这正是折叠要买的东西。 */
.notes-layout.list-collapsed {
  grid-template-columns: 44px minmax(0, 1fr);
}

.notes-layout.list-collapsed .notes-list {
  gap: 0;
  align-items: center;
  padding: var(--space-2) 0;
}

.notes-layout.list-collapsed .list-head {
  justify-content: center;
}

/* ------------------------------------------------ 列表：扁平 + 时间分组 */
.notes-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
  /* 目录自己滚：`height: 100%` 撑满这一格（配 grid 的 stretch）。
     `min-height: 0` 不是装饰——grid 项的自动最小尺寸是**内容高**，
     不压到 0 的话列表长了会把这一格顶高，滚动条又跑回外层去。 */
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-2) var(--space-4) var(--space-6) var(--space-1);
  border-right: 1px solid var(--border-hairline);
}

.list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.list-title {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  margin: 0;
  font-size: var(--text-section-size);
  font-weight: 600;
  color: var(--text-primary);
}

.list-count {
  font-size: var(--text-micro-size);
  font-weight: 400;
  color: var(--text-tertiary);
}

.icon-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  border-radius: var(--radius-control);
  cursor: pointer;
}

.icon-action:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.icon-action-on {
  color: var(--accent-text);
  background: var(--accent-soft);
}

.icon-action-danger:hover {
  color: var(--status-danger);
  background: var(--danger-soft);
}

/* 折叠开关比旁边的动作安静一档：它是版式开关，不是"对这条笔记做什么"。
   必须写在 `.icon-action` 之后——同为单类选择器，靠顺序才能盖过它的次级文字色 */
.collapse-toggle {
  color: var(--text-tertiary);
}

.search-box {
  position: relative;
}

.search-icon {
  position: absolute;
  top: 50%;
  left: var(--space-3);
  z-index: 1;
  color: var(--text-tertiary);
  transform: translateY(-50%);
  pointer-events: none;
}

.search-box :deep(input) {
  padding-left: calc(var(--space-3) * 2 + 14px);
}

.tag-bar {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.tag-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-pair) var(--space-2);
  font-size: var(--text-micro-size);
  color: var(--text-secondary);
  background: var(--bg-subtle);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-pill);
  cursor: pointer;
}

.tag-chip:hover {
  background: var(--bg-hover);
}

.tag-on {
  color: var(--accent-text);
  background: var(--accent-soft);
  border-color: var(--accent-selected);
}

.tag-count {
  color: var(--text-tertiary);
}

.list-hint {
  margin: 0;
  font-size: var(--text-micro-size);
}

.list-error {
  color: var(--status-danger);
}

.note-groups {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.group-label {
  margin: 0 0 var(--space-2);
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.note-items {
  display: flex;
  flex-direction: column;
  gap: var(--space-pair);
  margin: 0;
  padding: 0;
  list-style: none;
}

.note-item {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  color: inherit;
  text-decoration: none;
  border-radius: var(--radius-row);
}

.note-item:hover {
  background: var(--bg-hover);
}

.note-item-active {
  background: var(--accent-soft);
}

.note-item-title {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--text-meta-size);
  font-weight: 500;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.pin-icon {
  flex: 0 0 auto;
  color: var(--accent-text);
}

.note-item-meta {
  display: flex;
  gap: var(--space-3);
  align-items: baseline;
  justify-content: space-between;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.note-item-preview {
  display: -webkit-box;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 1;
}

.note-item-tail {
  display: inline-flex;
  flex: 0 0 auto;
  gap: var(--space-1);
  align-items: center;
  color: var(--text-tertiary);
}

/* ------------------------------------------------ 编辑器：无边框、工具栏在顶 */
.notes-pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  /* 正文列就是"正文的滚动容器"：工具栏的 sticky 吸的正是它（见 NoteEditor 的 `.toolbar`），
     所以它必须真的滚起来，不能被 `.editor-body` 里那层内滚动架空。
     原先的 `min-height: 600px` 在这里撤掉：矮窗口里它会让这一列比可用高度还高，
     于是又把滚动推回外层；那条下限只在单栏堆叠时留着（见文件末尾的断点）。 */
  height: 100%;
  min-height: 0;
  overflow-y: auto;
}

/* 编辑区：**撑满这一列，但不许被压回一列的高度**。
 *
 * `min-height: 100%` 管"短笔记也铺满"——点得到正文下面那片空白；
 * `flex: none` 管"正文多长它就多长"：flex 项默认 `flex-shrink: 1`，
 * 正文几屏长时这一层会被压回列高，溢出的正文虽然照样在列里滚，
 * 但工具栏 sticky 的**包含块**（就是这一层）也缩到了一屏——
 * 滚过一屏之后再没地方可粘，工具栏会跟着滚走（吸顶静默失效）。
 *
 * 也**不要**写 `flex: 1`：它的 `flex-basis: 0%` 会把这一层的高度与内容彻底脱钩，
 * 落在同一个坑里（实现"两列各自滚"时踩到过）。 */
.pane-editor {
  flex: none;
  min-height: 100%;
}

/* 没选笔记时把提示放在视觉中心：左上角一行字会被宽敞的编辑区衬得很空 */
.pane-empty {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--space-12) 0;
}

.save-label {
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
  white-space: nowrap;
}

.save-error {
  color: var(--status-danger);
}

/* 标题是"文档的一部分"，不是表单字段：无边框、字大、和正文同栏 */
.doc-title {
  display: block;
  width: 100%;
  margin: 0 0 var(--space-3);
  padding: 0;
  font-family: inherit;
  /* 比页标题小一档：它是"文档标题"，不该压过工具栏与正文的层级关系 */
  font-size: calc(var(--text-page-title-size) * 0.78);
  font-weight: 600;
  line-height: 1.3;
  color: var(--text-primary);
  background: transparent;
  border: none;
  outline: none;
}

.doc-title::placeholder {
  color: var(--text-tertiary);
}

.tag-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: center;
  min-height: var(--hit-target);
  margin-bottom: var(--space-4);
}

.tag-pill {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 1px var(--space-2);
  font-size: var(--text-micro-size);
  color: var(--text-secondary);
  background: var(--bg-subtle);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-pill);
}

.tag-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  /* 这个 × 是**固定 14px 的圆钮**里的一枚符号（不是正文字），所以字号不跟
     `--font-scale` 走：它一旦放大就会从 14px 的钮里溢出来，钮又不能再大
     （标签胶囊只有 24px 高）。全站唯一一处刻意脱离字阶的地方，在这里写明。 */
  font-size: var(--text-micro-size);
  line-height: 1;
  color: var(--text-tertiary);
  background: transparent;
  border: none;
  border-radius: var(--radius-pill);
  cursor: pointer;
}

.tag-remove:hover {
  color: var(--status-danger);
  background: var(--danger-soft);
}

.tag-entry {
  min-width: 80px;
  padding: var(--space-pair) var(--space-2);
  font-family: inherit;
  font-size: var(--text-micro-size);
  color: var(--text-secondary);
  background: transparent;
  border: 1px dashed var(--border);
  border-radius: var(--radius-pill);
  outline: none;
}

.tag-entry:focus {
  border-color: var(--accent-selected);
}

.doc-status {
  display: flex;
  gap: var(--space-1);
  align-items: center;
  margin-bottom: var(--space-3);
  font-size: var(--text-micro-size);
  color: var(--status-success);
}

.doc-link {
  margin-left: var(--space-2);
  color: var(--accent-text);
  text-decoration: none;
}

.doc-link:hover {
  text-decoration: underline;
}

.modal-lead {
  margin: 0 0 var(--space-4);
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
}

@media (max-width: 900px) {
  /* 单栏是**堆叠**：上面目录、下面正文，"两列"这件事本身就不存在了。
     各自独立滚动只在两列并排、各自有独立视野时才成立；堆叠时若还各滚各的，
     一屏里会冒出两个小滚动区，滚到底还得先判断"现在滚的是哪一段"。
     所以高度与 overflow 一并还原成内容流——两段重新共用外层那一条滚动条。 */
  .notes-page {
    height: auto;
  }

  .notes-layout {
    height: auto;
    grid-template-columns: minmax(0, 1fr);
  }

  /* 单栏下正文列不再有"撑满一屏"的高度：高度与 overflow 一并还原（见上），
     再给它一条下限——否则短笔记会让编辑区缩成一条，看起来像没加载出来 */
  .notes-pane {
    height: auto;
    min-height: 600px;
    overflow-y: visible;
  }

  /* 单栏下没有"另一栏"可以接收空间，折叠于是只能收成一条**横向**细条：
     留一条窄列反而既占宽度又什么也放不下 */
  .notes-layout.list-collapsed {
    grid-template-columns: minmax(0, 1fr);
  }

  .notes-layout.list-collapsed .notes-list {
    flex-direction: row;
    padding: var(--space-1) var(--space-4);
  }

  .notes-layout.list-collapsed .list-head {
    justify-content: flex-start;
  }

  .notes-list {
    height: auto;
    overflow-y: visible;
    border-right: none;
    border-bottom: 1px solid var(--border-hairline);
    padding-left: var(--space-4);
  }
}
</style>
