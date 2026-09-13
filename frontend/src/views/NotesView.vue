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
}

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
const loadingNote = ref(false)
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

const kbOptions = computed(() => kbs.items.map((kb) => ({ value: kb.id, label: kb.name })))
const activeKbName = computed(() => kbs.byId(draft.value?.kb_id ?? '')?.name ?? '')

let saveTimer: ReturnType<typeof setTimeout> | undefined
let searchTimer: ReturnType<typeof setTimeout> | undefined

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

function applyNote(note: Note): void {
  hydrating.value = true
  draft.value = {
    id: note.id,
    title: note.title,
    content_md: note.content_md,
    tags: [...note.tags],
    pinned: note.pinned,
    kb_id: note.kb_id,
    doc_id: note.doc_id,
  }
  tagDraft.value = ''
  saveState.value = 'idle'
  savedAt.value = null
  // 等这次赋值引发的 watch 跑完再解除抑制，否则装载会被当成一次编辑并触发自动保存
  void nextTick(() => {
    hydrating.value = false
  })
}

async function loadFromRoute(): Promise<void> {
  const id = String(route.params.noteId ?? '')
  if (!id) {
    await openLatest()
    return
  }
  if (draft.value?.id === id) return
  await saveNow()
  loadingNote.value = true
  try {
    applyNote(await store.fetch(id))
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '笔记加载失败')
    draft.value = null
  } finally {
    loadingNote.value = false
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

watch(() => route.params.noteId, () => void loadFromRoute(), { immediate: true })

watch(
  () => {
    const item = draft.value
    return item
      ? `${item.title}\u0000${item.content_md}\u0000${item.tags.join('\u0001')}\u0000${item.pinned}`
      : ''
  },
  () => {
    if (hydrating.value || !draft.value) return
    saveState.value = 'idle'
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => void saveNow(), 800)
  },
)

async function saveNow(): Promise<void> {
  const item = draft.value
  if (!item || hydrating.value) return
  if (saveTimer) clearTimeout(saveTimer)
  saveState.value = 'saving'
  try {
    const updated = await store.save(item.id, {
      title: item.title,
      content_md: item.content_md,
      pinned: item.pinned,
      tags: item.tags,
    })
    item.kb_id = updated.kb_id
    item.doc_id = updated.doc_id
    savedAt.value = new Date()
    saveState.value = 'saved'
  } catch (cause) {
    saveState.value = 'error'
    notifyError(cause instanceof Error ? cause.message : '保存失败')
  }
}

function formatClock(date: Date): string {
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

const saveLabel = computed(() => {
  if (saveState.value === 'saving') return '保存中…'
  if (saveState.value === 'saved') {
    return savedAt.value ? `已保存 ${formatClock(savedAt.value)}` : '已保存'
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
    await saveNow()
    const note = await store.create({ title: '', content_md: '' })
    await router.push(`/notes/${note.id}`)
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '新建失败')
  }
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
  void store.load()
  void store.loadTags()
  void kbs.load()
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  if (saveTimer) clearTimeout(saveTimer)
  if (searchTimer) clearTimeout(searchTimer)
})
</script>

<template>
  <!-- 刻意不用 PageShell：这一页的第一屏应当是"列表头 + 编辑器工具栏"，
       而不是通用页头（大标题 + 说明）。工具型界面里那两行只是占地方。 -->
  <div class="notes-page">
    <div class="notes-layout">
      <aside class="notes-list">
        <div class="list-head">
          <p class="list-title">全部<span class="list-count tabular">{{ store.total }}</span></p>
          <button type="button" class="icon-action" title="新建笔记" @click="createNew">
            <IconPlus :size="16" />
          </button>
        </div>

        <div class="search-box">
          <IconSearch :size="14" class="search-icon" />
          <AppInput
            v-model="searchInput"
            placeholder="搜索标题与正文"
            aria-label="搜索笔记"
          />
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
      </aside>

      <section class="notes-pane">
        <div v-if="loadingNote" class="pane-placeholder">正在加载…</div>
        <NoteEditor
          v-else-if="draft"
          v-model="draft.content_md"
          class="pane-editor"
          :note-id="draft.id"
          :ai-busy="aiBusy"
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
            <button type="button" class="icon-action icon-action-danger" title="删除" @click="deleteOpen = true">
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
                <button type="button" class="tag-remove" :title="`移除 ${tag}`" @click="removeTag(tag)">
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
/* 没有通用页头，顶部内边距收得很小：第一眼就是列表头与工具栏 */
.notes-page {
  padding: var(--space-3) var(--page-gutter) var(--space-8);
}

.notes-layout {
  display: grid;
  grid-template-columns: minmax(240px, 300px) minmax(0, 1fr);
  align-items: start;
}

/* ------------------------------------------------ 列表：扁平 + 时间分组 */
.notes-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
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
  padding: 2px var(--space-2);
  font-size: var(--text-micro-size);
  color: var(--text-secondary);
  background: var(--bg-subtle);
  border: 1px solid var(--border-hairline);
  border-radius: 999px;
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
  gap: 2px;
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
  min-height: 600px;
}

.pane-editor {
  flex: 1;
}

.pane-placeholder {
  padding: var(--space-8);
  color: var(--text-tertiary);
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
  border-radius: 999px;
}

.tag-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  font-size: 12px;
  line-height: 1;
  color: var(--text-tertiary);
  background: transparent;
  border: none;
  border-radius: 999px;
  cursor: pointer;
}

.tag-remove:hover {
  color: var(--status-danger);
  background: var(--danger-soft);
}

.tag-entry {
  min-width: 80px;
  padding: 2px var(--space-2);
  font-family: inherit;
  font-size: var(--text-micro-size);
  color: var(--text-secondary);
  background: transparent;
  border: 1px dashed var(--border);
  border-radius: 999px;
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
  .notes-layout {
    grid-template-columns: minmax(0, 1fr);
  }

  .notes-list {
    border-right: none;
    border-bottom: 1px solid var(--border-hairline);
    padding-left: var(--space-4);
  }
}
</style>
