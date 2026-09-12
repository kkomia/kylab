<script setup lang="ts">
/**
 * 笔记页：左侧时间线列表 + 右侧编辑器（《笔记功能调研》§3.5）。
 *
 * 信息架构刻意收敛在**一个视图**里（列表 → 编辑都在本页）：调研的告诫是
 * "不要为了功能多把导航撑开"，所以笔记相关操作全部收在页内，侧栏只多一个入口。
 *
 * 编辑器与保存：Tiptap 的 `content_md` 变化后**防抖自动保存**（800ms），
 * 同时保留 Ctrl/Cmd+S 立即保存。切换笔记前若还有未保存内容会先落盘——
 * 路由 watch 里 `saveNow()` 之后再装载新的那条。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import type { Note } from '@/api/notes'
import IconEdit from '@/components/icons/IconEdit.vue'
import IconLibrary from '@/components/icons/IconLibrary.vue'
import IconNote from '@/components/icons/IconNote.vue'
import IconPin from '@/components/icons/IconPin.vue'
import IconPlus from '@/components/icons/IconPlus.vue'
import IconSearch from '@/components/icons/IconSearch.vue'
import IconTrash from '@/components/icons/IconTrash.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppModal from '@/components/ui/AppModal.vue'
import AppSelect from '@/components/ui/AppSelect.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import StatusTag from '@/components/ui/StatusTag.vue'
import PageShell from '@/components/ui/PageShell.vue'
import { formatRelativeTime } from '@/composables/useFormat'
import { useToast } from '@/composables/useToast'
import NoteEditor from '@/components/notes/NoteEditor.vue'
import { useKnowledgeBaseStore } from '@/stores/knowledgeBases'
import { useNoteStore } from '@/stores/notes'

interface Draft {
  id: string
  title: string
  content_md: string
  tagsText: string
  pinned: boolean
  kb_id: string | null
  doc_id: string | null
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

const searchInput = ref(store.query)
const attachOpen = ref(false)
const attachKb = ref('')
const attaching = ref(false)
const deleteOpen = ref(false)
const deleting = ref(false)

const kbOptions = computed(() => kbs.items.map((kb) => ({ value: kb.id, label: kb.name })))
const activeKbName = computed(() => kbs.byId(draft.value?.kb_id ?? '')?.name ?? '')

let saveTimer: ReturnType<typeof setTimeout> | undefined
let searchTimer: ReturnType<typeof setTimeout> | undefined

function parseTags(text: string): string[] {
  const parts = text
    .split(/[\s,，、]+/)
    .map((item) => item.trim())
    .filter(Boolean)
  return [...new Set(parts)].slice(0, 8)
}

function applyNote(note: Note): void {
  hydrating.value = true
  draft.value = {
    id: note.id,
    title: note.title,
    content_md: note.content_md,
    tagsText: note.tags.join(' '),
    pinned: note.pinned,
    kb_id: note.kb_id,
    doc_id: note.doc_id,
  }
  saveState.value = 'idle'
  // 等这次赋值引发的 watch 跑完再解除抑制，否则装载会被当成一次编辑并触发自动保存
  void nextTick(() => {
    hydrating.value = false
  })
}

async function loadFromRoute(): Promise<void> {
  const id = String(route.params.noteId ?? '')
  if (!id) {
    draft.value = null
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

watch(() => route.params.noteId, () => void loadFromRoute(), { immediate: true })

watch(
  () => {
    const item = draft.value
    return item ? `${item.title}\u0000${item.content_md}\u0000${item.tagsText}\u0000${item.pinned}` : ''
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
      tags: parseTags(item.tagsText),
    })
    item.kb_id = updated.kb_id
    item.doc_id = updated.doc_id
    saveState.value = 'saved'
  } catch (cause) {
    saveState.value = 'error'
    notifyError(cause instanceof Error ? cause.message : '保存失败')
  }
}

const saveLabel = computed(() => {
  if (saveState.value === 'saving') return '保存中…'
  if (saveState.value === 'saved') return '已保存'
  if (saveState.value === 'error') return '保存失败'
  return ''
})

function onKeydown(event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    void saveNow()
  }
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
  searchTimer = setTimeout(() => void store.setFilter(searchInput.value.trim(), store.activeTag), 300)
}

async function toggleTag(tag: string): Promise<void> {
  await store.setFilter(searchInput.value.trim(), store.activeTag === tag ? '' : tag)
}

function togglePinned(): void {
  if (!draft.value) return
  draft.value.pinned = !draft.value.pinned
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
  <PageShell title="笔记" description="随手记录、基于知识库写作，写好的笔记也能加入知识库被检索到。">
    <div class="notes-layout">
      <aside class="notes-list">
        <div class="list-head">
          <div class="search-box">
            <IconSearch :size="14" class="search-icon" />
            <AppInput
              v-model="searchInput"
              placeholder="搜索标题与正文"
              aria-label="搜索笔记"
              @input="onSearchInput"
            />
          </div>
          <AppButton size="sm" variant="primary" @click="createNew">
            <template #icon><IconPlus :size="14" /></template>
            新建
          </AppButton>
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
          hint="点上面的「新建」写第一条"
        />
        <ul v-else class="note-items">
          <li v-for="item in store.items" :key="item.id">
            <RouterLink
              class="note-item"
              :class="{ 'note-item-active': item.id === draft?.id }"
              :to="`/notes/${item.id}`"
            >
              <span class="note-item-title">
                <IconPin v-if="item.pinned" :size="12" class="pin-icon" />
                {{ item.title || '未命名笔记' }}
              </span>
              <span class="note-item-preview">{{ item.preview || '（空）' }}</span>
              <span class="note-item-meta">
                <span>{{ formatRelativeTime(item.updated_at) }}</span>
                <StatusTag v-if="item.doc_id" label="已入库" tone="success" />
              </span>
            </RouterLink>
          </li>
        </ul>
      </aside>

      <section class="notes-pane">
        <div v-if="loadingNote" class="pane-placeholder">正在加载…</div>
        <template v-else-if="draft">
          <header class="pane-head">
            <div class="title-row">
              <IconNote :size="16" class="pane-icon" />
              <AppInput v-model="draft.title" class="title-input" placeholder="标题" />
            </div>
            <div class="pane-actions">
              <span class="save-label" :class="{ 'save-error': saveState === 'error' }">{{
                saveLabel
              }}</span>
              <AppButton
                size="sm"
                :variant="draft.pinned ? 'primary' : 'secondary'"
                :title="draft.pinned ? '取消置顶' : '置顶'"
                @click="togglePinned"
              >
                <template #icon><IconPin :size="14" /></template>
                {{ draft.pinned ? '已置顶' : '置顶' }}
              </AppButton>
              <AppButton size="sm" @click="openAttach">
                <template #icon><IconLibrary :size="14" /></template>
                {{ draft.doc_id ? '已入库' : '加入知识库' }}
              </AppButton>
              <AppButton size="sm" variant="danger" @click="deleteOpen = true">
                <template #icon><IconTrash :size="14" /></template>
                删除
              </AppButton>
            </div>
          </header>

          <div class="meta-row">
            <AppInput
              v-model="draft.tagsText"
              class="tag-input"
              placeholder="标签（空格或逗号分隔，最多 8 个）"
              aria-label="标签"
            />
            <span v-if="activeKbName" class="kb-badge">
              <IconLibrary :size="12" />
              已加入「{{ activeKbName }}」
            </span>
          </div>

          <NoteEditor v-model="draft.content_md" class="pane-editor" />
          <RouterLink v-if="draft.doc_id" class="doc-link" :to="`/documents/${draft.doc_id}`">
            <IconEdit :size="13" />
            查看入库后的文档
          </RouterLink>
        </template>
        <EmptyState
          v-else
          title="选择一条笔记开始编辑"
          hint="或点左侧的「新建」写一条新的"
        />
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
  </PageShell>
</template>

<style scoped>
.notes-layout {
  display: grid;
  grid-template-columns: minmax(240px, 300px) minmax(0, 1fr);
  gap: var(--space-5);
  align-items: start;
}

/* ------------------------------------------------ 列表 */
.notes-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
}

.list-head {
  display: flex;
  gap: var(--space-2);
  align-items: center;
}

.search-box {
  position: relative;
  flex: 1;
  min-width: 0;
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

.note-items {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.note-item {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-3);
  color: inherit;
  text-decoration: none;
  background: var(--bg-canvas);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-row);
}

.note-item:hover {
  background: var(--bg-hover);
}

.note-item-active {
  border-color: var(--accent-selected);
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

.note-item-preview {
  display: -webkit-box;
  overflow: hidden;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.note-item-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

/* ------------------------------------------------ 编辑器 */
.notes-pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 560px;
  background: var(--bg-canvas);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-panel);
  overflow: hidden;
}

.pane-placeholder {
  padding: var(--space-8);
  color: var(--text-tertiary);
}

.pane-head {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3) var(--space-4);
}

.title-row {
  display: flex;
  flex: 1;
  gap: var(--space-2);
  align-items: center;
  min-width: 200px;
}

.pane-icon {
  flex: 0 0 auto;
  color: var(--text-tertiary);
}

.title-input :deep(input) {
  font-size: var(--text-section-size);
  font-weight: 600;
}

.pane-actions {
  display: flex;
  gap: var(--space-2);
  align-items: center;
}

.save-label {
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.save-error {
  color: var(--status-danger);
}

.meta-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  align-items: center;
  padding: 0 var(--space-4) var(--space-3);
}

.tag-input {
  flex: 1;
  min-width: 200px;
}

.kb-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 2px var(--space-2);
  font-size: var(--text-micro-size);
  color: var(--status-success);
  background: var(--status-success-soft);
  border-radius: 999px;
}

.pane-editor {
  border-top: 1px solid var(--border-hairline);
}

.doc-link {
  display: inline-flex;
  gap: var(--space-1);
  align-items: center;
  padding: var(--space-2) var(--space-4);
  font-size: var(--text-micro-size);
  color: var(--accent-text);
  text-decoration: none;
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
}
</style>
