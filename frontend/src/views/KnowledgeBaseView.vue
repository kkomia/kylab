<script setup lang="ts">
/**
 * 知识库详情页：文档列表（《前端设计规范 v0.3》§6）。
 *
 * 形态：文档是"条目型"对象且会很多，用**列表**而不是卡片。
 * 每行 = 类型图标 + 名称 + 状态（文字 + 语义色）+ 时间；大文件可展开子文件树。
 *
 * 上传走"提交后轮询"：后端是异步流水线（架构 §4），界面必须能看见任务在动，
 * 否则用户会以为"点了没反应"。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import {
  batchDocuments,
  cancelDocument,
  deleteDocument,
  downloadDocument,
  getDocumentImpact,
  listDocumentParts,
  listDocuments,
  moveDocument,
  renameDocument,
  reprocessDocument,
  type DataSourceKind,
  type DocumentStage,
  type DocumentListFilter,
  type ImpactReport,
  type DocumentPart,
  type DocumentSummary,
} from '@/api/documents'
import { createFolder, deleteFolder, listFolders, renameFolder, type Folder } from '@/api/folders'
import IconChevronDown from '@/components/icons/IconChevronDown.vue'
import IconChevronRight from '@/components/icons/IconChevronRight.vue'
import IconClose from '@/components/icons/IconClose.vue'
import IconDownload from '@/components/icons/IconDownload.vue'
import IconEdit from '@/components/icons/IconEdit.vue'
import IconFile from '@/components/icons/IconFile.vue'
import IconFolder from '@/components/icons/IconFolder.vue'
import IconInbox from '@/components/icons/IconInbox.vue'
import IconPlus from '@/components/icons/IconPlus.vue'
import IconRefresh from '@/components/icons/IconRefresh.vue'
import IconTrash from '@/components/icons/IconTrash.vue'
import IconSearch from '@/components/icons/IconSearch.vue'
import IconShare from '@/components/icons/IconShare.vue'
import IconUpload from '@/components/icons/IconUpload.vue'
import KbSearchPanel from '@/components/search/KbSearchPanel.vue'
import KnowledgeBaseMenu from '@/components/knowledge/KnowledgeBaseMenu.vue'
import ShareDialog from '@/components/knowledge/ShareDialog.vue'
import SourcePanel from '@/components/knowledge/SourcePanel.vue'
import UploadDialog from '@/components/knowledge/UploadDialog.vue'
import RowMenu from '@/components/ui/RowMenu.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppModal from '@/components/ui/AppModal.vue'
import AppSelect from '@/components/ui/AppSelect.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import PageShell from '@/components/ui/PageShell.vue'
import SkeletonBlock from '@/components/ui/SkeletonBlock.vue'
import StatusTag from '@/components/ui/StatusTag.vue'
import { documentStageView } from '@/components/ui/status'
import { formatBytes, formatRelativeTime } from '@/composables/useFormat'
import { MAX_UPLOAD_MB, UPLOAD_FORMAT_HINT } from '@/composables/uploadLimits'
import { roster } from '@/composables/useOperator'
import { useToast } from '@/composables/useToast'
import { useKnowledgeBaseStore } from '@/stores/knowledgeBases'

const POLL_INTERVAL_MS = 2000
/** 处于这些阶段的文档还在动，需要轮询刷新。 */
const ACTIVE_STAGES = new Set([
  'uploaded',
  'probing',
  'parsing',
  'parsed',
  'chunking',
  'chunked',
  'embedding',
  'enriching',
])

const route = useRoute()
const router = useRouter()
const store = useKnowledgeBaseStore()
const { notifyError, notifySuccess } = useToast()

/**
 * 删除确认（M6 / T6.4）。
 *
 * 三段状态：目标 → 影响清单 → 提交。**清单要在确认之前拿到**——
 * 否则那个弹窗只是个"你确定吗"的摆设，而用户根本不知道自己会失去什么。
 */
const deleteOpen = ref(false)
const deleteTarget = ref<DocumentSummary | null>(null)
const impact = ref<ImpactReport | null>(null)
const deleting = ref(false)

/** 重命名弹窗：只改显示名，不动内容。 */
const renameTarget = ref<DocumentSummary | null>(null)
const renameDraft = ref('')
const renaming = ref(false)
const renameOpen = computed({
  get: () => renameTarget.value !== null,
  set: (value: boolean) => {
    if (!value) renameTarget.value = null
  },
})

/** 正在取消解析的文档 id（防重复点击；也是按钮的 busy 态）。 */
const canceling = ref('')

/** 从行内菜单点删除：先开弹窗（带上目标），再去取影响清单。 */
function onDeleteClick(close: () => void, document: DocumentSummary): void {
  close()
  deleteTarget.value = document
  impact.value = null
  deleteOpen.value = true
  void loadImpact(document.id)
}

async function loadImpact(documentId: string): Promise<void> {
  try {
    impact.value = await getDocumentImpact(documentId)
  } catch {
    // 拿不到清单不阻断删除：弹窗会停在"正在统计影响…"，
    // 用户仍能取消——总比卡住不给动好
    impact.value = null
  }
}

async function confirmDelete(): Promise<void> {
  const target = deleteTarget.value
  if (!target || deleting.value) return
  deleting.value = true
  try {
    await deleteDocument(target.id)
    deleteOpen.value = false
    notifySuccess('已删除，原文在回收站保留 7 天')
    await refreshAll()
    void store.loadSummaries()
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '删除失败')
  } finally {
    deleting.value = false
  }
}

const kbId = computed(() => String(route.params.kbId ?? ''))
const knowledgeBase = computed(() => store.byId(kbId.value))

/** 库级管理动作的回声：改名由 store 就地更新；删库后这一页已无所指，回列表。 */
function onKbChanged(action: 'renamed' | 'deleted'): void {
  if (action === 'deleted') void router.push('/knowledge-bases')
}

const documents = ref<DocumentSummary[]>([])
const loading = ref(false)
const error = ref('')
const searchOpen = ref(false)
const uploadOpen = ref(false)
const shareOpen = ref(false)
const expanded = ref<Record<string, DocumentPart[] | undefined>>({})

// ------------------------------------------------------------------ 筛选

const SEARCH_DEBOUNCE_MS = 300

/**
 * 筛选下拉的选项。状态文案从 `documentStageView` 取——文档行上显示什么，
 * 下拉里就显示什么，不另写一套说法（否则"失败"在一处叫"失败"、另一处叫"异常"）。
 */
const FILTER_STAGE_KEYS: DocumentStage[] = [
  'uploaded',
  'probing',
  'parsing',
  'parsed',
  'chunking',
  'chunked',
  'embedding',
  'indexed',
  'enriching',
  'enriched',
  'failed',
]
const STAGE_FILTER_OPTIONS = [
  { value: '', label: '全部状态' },
  ...FILTER_STAGE_KEYS.map((stage) => ({ value: stage, label: documentStageView(stage).label })),
]
/** 只列真实可能出现的来源：webdav 是框架预留、MVP 不实现，摆上去就是点了没反应的死选项。 */
const SOURCE_FILTER_OPTIONS = [
  { value: '', label: '全部来源' },
  { value: 'upload', label: '本地上传' },
  { value: 'html', label: '网页' },
  { value: 'rss', label: 'RSS 订阅' },
]

const searchDraft = ref('')
const stageFilter = ref('')
const sourceFilter = ref('')
const hasFilter = computed(() =>
  Boolean(searchDraft.value.trim() || stageFilter.value || sourceFilter.value),
)

// ------------------------------------------------------------------ 多选与批量

/** 勾选的文档 id。**用数组而不是 Set**：Pinia/Vue 对 Set 的变更追踪要额外小心，
 *  而这里最多几十个 id，数组的 `includes` 开销可以忽略。 */
const selected = ref<string[]>([])
const selectedCount = computed(() => selected.value.length)
const allSelected = computed(
  () => documents.value.length > 0 && selected.value.length === documents.value.length,
)
const batchRunning = ref(false)

// ------------------------------------------------------------------ 目录（v13）

/**
 * 目录筛选的三种取值：
 * - `''`：全部（默认，也是本功能之前的行为）
 * - `ROOT_FILTER`：只看未归档的
 * - 其余：某个目录 id
 */
const ROOT_FILTER = '__root__'
const folders = ref<Folder[]>([])
const activeFolder = ref('')

/**
 * 目录树的「全部文档」节点是否展开。
 *
 * 树只有两层（全部 → 未归档 / 各目录），展开态没什么可配的，所以不给持久化，
 * 每次进页面都是展开的——用户要的是"一眼看到所有目录"，不是记住上次折叠。
 */
const treeOpen = ref(true)

/**
 * 「未归档」的文档数。**单独查一次**而不是从当前列表推：
 * 列表是按选中的节点过滤过的，拿它算总数会随选择变化而变。
 */
const unfiledCount = ref<number | null>(null)
const foldersTotal = computed(() =>
  folders.value.reduce((sum, folder) => sum + folder.document_count, 0),
)
/** 拿不到未归档数时回 null（界面不显示数字）——显示一个错的数比不显示更糟。 */
const totalCount = computed(() =>
  unfiledCount.value === null ? null : unfiledCount.value + foldersTotal.value,
)

/** 新建/重命名目录的表单（同一个表单，靠 `folderEditingId` 区分两种模式）。 */
const folderFormOpen = ref(false)
const folderEditingId = ref('')
const folderDraft = ref('')
const folderSaving = ref(false)

/** 移动到目录的弹窗。 */
const moveTarget = ref<DocumentSummary | null>(null)
const moveChoice = ref('')
const moving = ref(false)
const moveOpen = computed({
  get: () => moveTarget.value !== null,
  set: (value: boolean) => {
    if (!value) moveTarget.value = null
  },
})

/** 空状态文案随筛选范围变——"这个库还没有文档"在目录或搜索里看到会误导。 */
const emptyTitle = computed(() => {
  if (hasFilter.value) return '没有符合条件的文档'
  if (activeFolder.value === ROOT_FILTER) return '根目录下还没有文档'
  if (activeFolder.value) return '这个目录里还没有文档'
  return '这个知识库里还没有文档'
})

/** 上传目标目录：只有选中了具体目录时才带上（"全部/未归档"都算根目录）。 */
const uploadFolderId = computed(() =>
  activeFolder.value && activeFolder.value !== ROOT_FILTER ? activeFolder.value : undefined,
)

let timer: ReturnType<typeof setInterval> | null = null
let searchTimer: ReturnType<typeof setTimeout> | null = null

/** 搜文件名是**逐键**触发的：不防抖就会每敲一个字发一次请求，中文输入还会带上拼音中间态。 */
function scheduleSearch(): void {
  if (searchTimer !== null) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    searchTimer = null
    void refresh()
  }, SEARCH_DEBOUNCE_MS)
}

function clearFilters(): void {
  searchDraft.value = ''
  stageFilter.value = ''
  sourceFilter.value = ''
  if (searchTimer !== null) {
    clearTimeout(searchTimer)
    searchTimer = null
  }
  void refresh()
}

function toggleSelect(documentId: string): void {
  selected.value = selected.value.includes(documentId)
    ? selected.value.filter((id) => id !== documentId)
    : [...selected.value, documentId]
}

/** 全选/清空：作用于**当前列表**（当前筛选结果），不是整个库。 */
function toggleSelectAll(): void {
  selected.value = allSelected.value ? [] : documents.value.map((document) => document.id)
}

function clearSelection(): void {
  selected.value = []
}

/**
 * 批量动作。**部分失败是正常结果**，所以按后端逐条回的成败分别处理：
 * 全成 → 清空选择；有失败 → 把失败的那几条留在选中态，用户可以重试或看原因。
 */
async function runBatch(action: 'delete' | 'reprocess'): Promise<void> {
  if (selectedCount.value === 0 || batchRunning.value) return
  if (action === 'delete') {
    const confirmed = window.confirm(
      `删除选中的 ${selectedCount.value} 篇文档？原文会移入回收站保留 7 天，切块与向量立即清除。`,
    )
    if (!confirmed) return
  }
  batchRunning.value = true
  const ids = [...selected.value]
  const verb = action === 'delete' ? '删除' : '重新摄入'
  try {
    const result = await batchDocuments(kbId.value, action, ids)
    await refreshAll()
    syncPolling()
    void store.loadSummaries()
    if (result.failed === 0) {
      selected.value = []
      notifySuccess(`已${verb} ${result.succeeded} 篇`)
      return
    }
    // 有失败：说清成功/失败各几篇，并把第一条失败原因带出来——只报总数等于让人自己找
    const firstError = result.items.find((item) => !item.ok)?.error
    notifyError(
      `${verb}：${result.succeeded} 篇成功、${result.failed} 篇失败` +
        (firstError ? `（${firstError}）` : ''),
    )
    selected.value = result.items.filter((item) => !item.ok).map((item) => item.document_id)
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : `批量${verb}失败`)
  } finally {
    batchRunning.value = false
  }
}

const hasActive = computed(() =>
  documents.value.some((document) => ACTIVE_STAGES.has(document.stage)),
)

async function refresh(): Promise<void> {
  if (!kbId.value) return
  try {
    const filter: DocumentListFilter = {}
    if (activeFolder.value === ROOT_FILTER) filter.root = true
    else if (activeFolder.value) filter.folderId = activeFolder.value
    const keyword = searchDraft.value.trim()
    if (keyword) filter.q = keyword
    if (stageFilter.value) filter.stage = stageFilter.value as DocumentStage
    if (sourceFilter.value) filter.sourceKind = sourceFilter.value as DataSourceKind
    documents.value = (await listDocuments(kbId.value, filter)).items
    error.value = ''
    pruneSelection()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '文档列表加载失败'
  }
}

/** 刷新后剔除已不在列表里的选中项：否则批量删除后计数会虚高。 */
function pruneSelection(): void {
  if (selected.value.length === 0) return
  const present = new Set(documents.value.map((document) => document.id))
  const kept = selected.value.filter((id) => present.has(id))
  if (kept.length !== selected.value.length) selected.value = kept
}

async function loadFolders(): Promise<void> {
  if (!kbId.value) return
  try {
    folders.value = (await listFolders(kbId.value)).items
  } catch {
    // 目录读不到不该挡住文档列表：退化成"还没有目录"
    folders.value = []
  }
}

/** 「未归档」计数：树上的数字要准，所以单独查一次根目录范围。 */
async function loadCounts(): Promise<void> {
  if (!kbId.value) return
  try {
    unfiledCount.value = (await listDocuments(kbId.value, { root: true })).items.length
  } catch {
    unfiledCount.value = null
  }
}

/** 文档 + 目录 + 计数一起刷（新建/删除/移动之后计数与列表都得跟着变）。 */
async function refreshAll(): Promise<void> {
  await Promise.all([refresh(), loadFolders(), loadCounts()])
}

async function loadFirst(): Promise<void> {
  loading.value = true
  await refreshAll()
  loading.value = false
}

/** 只在有活儿在跑时轮询：全绿之后停表，避免无意义的持续请求。 */
function syncPolling(): void {
  if (hasActive.value && timer === null) {
    timer = setInterval(() => void refresh(), POLL_INTERVAL_MS)
  } else if (!hasActive.value && timer !== null) {
    clearInterval(timer)
    timer = null
  }
}

watch(hasActive, syncPolling)
watch(activeFolder, () => {
  void refresh()
})
watch(searchDraft, scheduleSearch)
// 下拉是离散选择，没有"输入到一半"的中间态，直接刷；也顺带取消防抖中的搜索
watch([stageFilter, sourceFilter], () => {
  if (searchTimer !== null) {
    clearTimeout(searchTimer)
    searchTimer = null
  }
  void refresh()
})
watch(kbId, () => {
  expanded.value = {}
  activeFolder.value = ''
  searchDraft.value = ''
  stageFilter.value = ''
  sourceFilter.value = ''
  selected.value = []
  void loadFirst()
})

onMounted(async () => {
  if (store.items.length === 0) await store.load()
  await loadFirst()
})

onBeforeUnmount(() => {
  if (timer !== null) clearInterval(timer)
  if (searchTimer !== null) clearTimeout(searchTimer)
})

async function onUploaded(): Promise<void> {
  // 弹窗自己负责**逐文件的结果**（哪个重复、哪个失败），这里只负责开始盯进度。
  // 不再发 toast：批量上传时 toast 会连成一片，"哪几个没成功"根本看不清，
  // 而那恰恰是用户唯一需要看的部分——那份清单留在弹窗里。
  await refreshAll()
  syncPolling()
}

// ------------------------------------------------------------------ 目录动作

function startCreateFolder(): void {
  folderEditingId.value = ''
  folderDraft.value = ''
  folderFormOpen.value = true
}

function startRenameFolder(folder: Folder): void {
  folderEditingId.value = folder.id
  folderDraft.value = folder.name
  folderFormOpen.value = true
}

function cancelFolderForm(): void {
  folderFormOpen.value = false
  folderEditingId.value = ''
  folderDraft.value = ''
}

async function submitFolder(): Promise<void> {
  const name = folderDraft.value.trim()
  if (!name) {
    notifyError('请输入目录名')
    return
  }
  folderSaving.value = true
  try {
    if (folderEditingId.value) await renameFolder(folderEditingId.value, name)
    else await createFolder(kbId.value, name)
    cancelFolderForm()
    await loadFolders()
    notifySuccess('目录已保存')
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '保存失败')
  } finally {
    folderSaving.value = false
  }
}

async function removeFolder(folder: Folder): Promise<void> {
  if (!window.confirm(`删除目录「${folder.name}」？`)) return
  try {
    await deleteFolder(folder.id)
    // 正在看的目录被删了：回到「全部」，否则列表会停在一个不存在的筛选上
    if (activeFolder.value === folder.id) activeFolder.value = ''
    await refreshAll()
    notifySuccess('目录已删除')
  } catch (cause) {
    // 目录非空时后端会拒绝，消息里带"还有 N 篇"——原样透给用户，他才好决定下一步
    notifyError(cause instanceof Error ? cause.message : '删除失败')
  }
}

function onMoveClick(close: () => void, document: DocumentSummary): void {
  close()
  moveTarget.value = document
  // 默认落在它当前所在的位置：多数人是想改到别处，而不是先看到"根目录"
  moveChoice.value = document.folder_id ?? ''
}

async function confirmMove(): Promise<void> {
  const target = moveTarget.value
  if (!target || moving.value) return
  moving.value = true
  try {
    await moveDocument(target.id, moveChoice.value || null)
    moveTarget.value = null
    await refreshAll()
    notifySuccess('已移动')
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '移动失败')
  } finally {
    moving.value = false
  }
}

async function toggleParts(document: DocumentSummary): Promise<void> {
  if (expanded.value[document.id]) {
    expanded.value = { ...expanded.value, [document.id]: undefined }
    return
  }
  try {
    const parts = (await listDocumentParts(document.id)).items
    expanded.value = { ...expanded.value, [document.id]: parts }
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '子文件加载失败')
  }
}

async function reprocess(document: DocumentSummary): Promise<void> {
  try {
    await reprocessDocument(document.id)
    notifySuccess(`已重新提交「${document.name}」`)
    await refresh()
    syncPolling()
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '重跑失败')
  }
}

/** 下载原文件。链路是"先签发短期链接再触发浏览器下载"（后端没有永久直链）。 */
async function onDownload(close: () => void, document: DocumentSummary): Promise<void> {
  close()
  try {
    await downloadDocument(document.id)
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '下载失败')
  }
}

function onRenameClick(close: () => void, document: DocumentSummary): void {
  close()
  renameTarget.value = document
  renameDraft.value = document.name
}

async function confirmRename(): Promise<void> {
  const target = renameTarget.value
  if (!target || renaming.value) return
  const name = renameDraft.value.trim()
  if (!name) {
    notifyError('文件名不能为空')
    return
  }
  renaming.value = true
  try {
    await renameDocument(target.id, name)
    renameTarget.value = null
    await refresh()
    notifySuccess('已重命名')
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '重命名失败')
  } finally {
    renaming.value = false
  }
}

/** 取消解析。**不是删除**：已产出的内容留着，之后还能重新摄入。 */
async function onCancelClick(close: () => void, document: DocumentSummary): Promise<void> {
  close()
  const confirmed = window.confirm(
    `取消「${document.name}」的解析？已解析出的内容会保留，之后可以重新摄入。`,
  )
  if (!confirmed) return
  canceling.value = document.id
  try {
    await cancelDocument(document.id)
    await refresh()
    syncPolling()
    notifySuccess('已取消解析')
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '取消失败')
  } finally {
    canceling.value = ''
  }
}

function stageOf(document: DocumentSummary) {
  return documentStageView(document.stage)
}

/** 先在模板里摊平：`@click` 里写多语句会被模板编译器拒绝（分号/换行解析不了）。 */
function onReprocessClick(close: () => void, document: DocumentSummary): void {
  close()
  void reprocess(document)
}
</script>

<template>
  <PageShell :title="knowledgeBase?.name ?? '知识库'">
    <template v-if="knowledgeBase" #description>
      {{ documents.length }} 篇文档<span class="sep">·</span>{{ knowledgeBase.embedding_model_id
      }}<span class="sep">·</span>{{ knowledgeBase.embedding_dim }} 维<span class="sep">·</span>切分
      {{ knowledgeBase.chunk_size }}<span class="sep">/</span>重叠
      {{ knowledgeBase.chunk_overlap }}
    </template>

    <template #actions>
      <AppButton :disabled="documents.length === 0" @click="searchOpen = true">
        <template #icon><IconSearch /></template>
        在此库检索
      </AppButton>
      <!-- 分享入口只对 owner / 管理员出现：can_manage 由后端算，前端不重复判定 -->
      <AppButton v-if="knowledgeBase?.can_manage" @click="shareOpen = true">
        <template #icon><IconShare /></template>
        分享
      </AppButton>
      <!-- 只读分享的成员看得到内容，但没有写入口（can_write 由后端算） -->
      <AppButton v-if="knowledgeBase?.can_write" variant="primary" @click="uploadOpen = true">
        <template #icon><IconUpload /></template>
        上传文档
      </AppButton>
      <!-- 库级管理：改名 / 删除。与「分享」同处页头，都是"对这个库本身"的动作 -->
      <KnowledgeBaseMenu
        v-if="knowledgeBase?.can_write"
        :kb="knowledgeBase"
        @changed="onKbChanged"
      />
    </template>

    <p v-if="error" class="error-line">{{ error }}</p>

    <p v-if="knowledgeBase && !knowledgeBase.can_write" class="readonly-note">
      这是别人分享给你的库，你是只读权限：可以检索与查看，不能上传或删除。
    </p>

    <!--
      目录（v13）：**左侧树**。根节点「全部文档」展开后是「未归档」与各目录，
      选中某个节点 = 右侧列表按它过滤（点根节点 = 不筛，与这个功能之前的行为一致）。
      单层数据做成两层树：这是当前模型能如实表达的形态，不假装支持无限嵌套。
    -->
    <div class="kb-body">
      <aside v-if="knowledgeBase" class="folder-tree" aria-label="目录">
        <div class="tree-head">
          <span class="tree-title">目录</span>
          <button
            v-if="knowledgeBase.can_write"
            type="button"
            class="tree-add"
            aria-label="新建目录"
            title="新建目录"
            @click="startCreateFolder"
          >
            <IconPlus :size="15" />
          </button>
        </div>

        <ul class="tree-list">
          <li>
            <div class="tree-row" :class="{ 'tree-row-on': activeFolder === '' }">
              <button
                type="button"
                class="tree-caret"
                :aria-expanded="treeOpen"
                :aria-label="treeOpen ? '收起目录' : '展开目录'"
                @click="treeOpen = !treeOpen"
              >
                <IconChevronDown v-if="treeOpen" :size="14" />
                <IconChevronRight v-else :size="14" />
              </button>
              <button
                type="button"
                class="tree-node"
                :aria-current="activeFolder === '' ? 'true' : undefined"
                @click="activeFolder = ''"
              >
                <IconFile :size="14" />
                <span class="tree-label">全部文档</span>
                <span v-if="totalCount !== null" class="tree-count tabular">{{ totalCount }}</span>
              </button>
            </div>

            <ul v-show="treeOpen" class="tree-children">
              <li>
                <div class="tree-row" :class="{ 'tree-row-on': activeFolder === ROOT_FILTER }">
                  <!-- 占位：让未归档与目录项的文字起点对齐 -->
                  <span class="tree-caret" aria-hidden="true" />
                  <button
                    type="button"
                    class="tree-node"
                    :aria-current="activeFolder === ROOT_FILTER ? 'true' : undefined"
                    @click="activeFolder = ROOT_FILTER"
                  >
                    <IconInbox :size="14" />
                    <span class="tree-label">未归档</span>
                    <span v-if="unfiledCount !== null" class="tree-count tabular">
                      {{ unfiledCount }}
                    </span>
                  </button>
                </div>
              </li>

              <li v-for="folder in folders" :key="folder.id">
                <div class="tree-row" :class="{ 'tree-row-on': activeFolder === folder.id }">
                  <span class="tree-caret" aria-hidden="true" />
                  <button
                    type="button"
                    class="tree-node"
                    :aria-current="activeFolder === folder.id ? 'true' : undefined"
                    :title="folder.name"
                    @click="activeFolder = folder.id"
                  >
                    <IconFolder :size="14" />
                    <span class="tree-label">{{ folder.name }}</span>
                    <span class="tree-count tabular">{{ folder.document_count }}</span>
                  </button>
                  <RowMenu v-if="knowledgeBase.can_write" :label="`${folder.name} 的操作`">
                    <template #default="{ close }">
                      <button type="button" @click="(startRenameFolder(folder), close())">
                        重命名
                      </button>
                      <button
                        class="menu-item-danger"
                        type="button"
                        @click="(removeFolder(folder), close())"
                      >
                        删除目录
                      </button>
                    </template>
                  </RowMenu>
                </div>
              </li>

              <li v-if="folders.length === 0" class="tree-empty">还没有目录</li>
            </ul>
          </li>
        </ul>

        <!-- 新建/重命名共用一个表单：靠 folderEditingId 区分两种模式 -->
        <div v-if="folderFormOpen" class="tree-form">
          <AppInput
            v-model="folderDraft"
            placeholder="目录名，例如：合同"
            @keydown.enter="submitFolder"
          />
          <div class="tree-form-actions">
            <AppButton size="sm" variant="primary" :disabled="folderSaving" @click="submitFolder">
              {{ folderSaving ? '保存中…' : '保存' }}
            </AppButton>
            <AppButton size="sm" @click="cancelFolderForm">取消</AppButton>
          </div>
        </div>
      </aside>

      <section class="doc-area">
        <!-- 筛选：文件名 / 状态 / 来源。放在列表之上——先缩小范围，再在范围内找 -->
        <div v-if="knowledgeBase && !loading" class="filter-bar">
          <div class="search-box">
            <IconSearch class="search-icon" :size="16" />
            <AppInput v-model="searchDraft" placeholder="搜索文件名…" />
          </div>
          <div class="filter-select">
            <AppSelect
              v-model="stageFilter"
              :options="STAGE_FILTER_OPTIONS"
              aria-label="按状态筛选"
            />
          </div>
          <div class="filter-select">
            <AppSelect
              v-model="sourceFilter"
              :options="SOURCE_FILTER_OPTIONS"
              aria-label="按来源筛选"
            />
          </div>
          <AppButton v-if="hasFilter" size="sm" @click="clearFilters">清除筛选</AppButton>
        </div>

        <SkeletonBlock v-if="loading && documents.length === 0" variant="list" :rows="4" />

        <EmptyState
          v-else-if="documents.length === 0"
          :title="emptyTitle"
          :hint="`${UPLOAD_FORMAT_HINT}；单文件上限 ${MAX_UPLOAD_MB}MB。`"
        >
          <AppButton v-if="knowledgeBase?.can_write" variant="primary" @click="uploadOpen = true">
            <template #icon><IconUpload /></template>
            上传文档
          </AppButton>
        </EmptyState>

        <template v-else>
          <!-- 批量操作条：只有在勾了东西时才出现（没选东西时它只是噪音） -->
          <div v-if="selectedCount > 0" class="batch-bar">
            <span class="batch-count">已选 {{ selectedCount }} 篇</span>
            <AppButton size="sm" :disabled="batchRunning" @click="runBatch('reprocess')">
              <template #icon><IconRefresh /></template>
              重新摄入
            </AppButton>
            <AppButton
              size="sm"
              variant="danger"
              :disabled="batchRunning"
              @click="runBatch('delete')"
            >
              <template #icon><IconTrash /></template>
              删除
            </AppButton>
            <AppButton size="sm" :disabled="batchRunning" @click="clearSelection"
              >取消选择</AppButton
            >
          </div>

          <!-- 列头：让右侧那串数字有名字，不必靠猜。
           文字列标 aria-hidden（纯装饰），但全选框是交互控件，不能被一起藏掉 -->
          <div class="panel">
            <div class="panel-head list-head">
              <span v-if="knowledgeBase?.can_write" class="head-check">
                <input
                  type="checkbox"
                  :checked="allSelected"
                  aria-label="全选当前列表"
                  @change="toggleSelectAll"
                />
              </span>
              <span class="head-file" aria-hidden="true">文件</span>
              <span class="head-number" aria-hidden="true">切块</span>
              <span class="head-size" aria-hidden="true">大小</span>
              <span class="head-time" aria-hidden="true">更新时间</span>
              <span class="head-menu" aria-hidden="true" />
            </div>

            <ul class="doc-rows">
              <li v-for="document in documents" :key="document.id" class="doc-row-group">
                <div class="doc-row panel-row">
                  <span v-if="knowledgeBase?.can_write" class="row-check">
                    <input
                      type="checkbox"
                      :checked="selected.includes(document.id)"
                      :aria-label="`选择 ${document.name}`"
                      @change="toggleSelect(document.id)"
                    />
                  </span>
                  <button
                    v-if="document.is_split"
                    class="expander"
                    type="button"
                    :aria-label="expanded[document.id] ? '收起子文件' : '展开子文件'"
                    :aria-expanded="Boolean(expanded[document.id])"
                    @click="toggleParts(document)"
                  >
                    <IconChevronDown v-if="expanded[document.id]" />
                    <IconChevronRight v-else />
                  </button>
                  <span v-else class="expander-placeholder" />

                  <IconFile class="row-icon" />

                  <span class="row-main">
                    <RouterLink class="row-name" :to="`/documents/${document.id}`">
                      {{ document.name }}
                    </RouterLink>
                    <StatusTag
                      :label="stageOf(document).label"
                      :tone="stageOf(document).tone"
                      :running="ACTIVE_STAGES.has(document.stage)"
                      :title="document.error ?? undefined"
                    />
                    <!-- 谁传的（G6）。没记到时显示"未记录"而不是留空——
                     留空会让人以为是界面没渲染出来 -->
                    <span v-if="roster.length" class="row-uploader">
                      {{ document.uploaded_by_name || '未记录' }}
                    </span>
                  </span>

                  <span class="row-number">{{ document.chunk_count }}</span>
                  <span class="row-size">{{ formatBytes(document.size_bytes) }}</span>
                  <span class="row-time">{{ formatRelativeTime(document.updated_at) }}</span>

                  <!-- 操作菜单对**所有能看这个库的人**开放：下载是只读动作，
                   写动作再逐个按 can_write 收口（只读分享的成员也该下得走原文） -->
                  <RowMenu v-slot="{ close }" class="row-menu">
                    <button type="button" @click="onDownload(close, document)">
                      <IconDownload :size="14" /> 下载
                    </button>
                    <button
                      v-if="knowledgeBase?.can_write"
                      type="button"
                      @click="onRenameClick(close, document)"
                    >
                      <IconEdit :size="14" /> 重命名
                    </button>
                    <button
                      v-if="knowledgeBase?.can_write"
                      type="button"
                      @click="onMoveClick(close, document)"
                    >
                      <IconFolder :size="14" /> 移动到目录
                    </button>
                    <button
                      v-if="knowledgeBase?.can_write"
                      type="button"
                      @click="onReprocessClick(close, document)"
                    >
                      <IconRefresh :size="14" /> 重新摄入
                    </button>
                    <!-- 取消只在真的还在跑时出现：对已完成的文档摆一个点了报错的按钮没有意义 -->
                    <button
                      v-if="knowledgeBase?.can_write && ACTIVE_STAGES.has(document.stage)"
                      type="button"
                      :disabled="canceling === document.id"
                      @click="onCancelClick(close, document)"
                    >
                      <IconClose :size="14" />
                      {{ canceling === document.id ? '取消中…' : '取消解析' }}
                    </button>
                    <!-- 删除（M6 / T6.4）。**先进回收站**：删错是常事，
                     而原文一旦没了就只能重新上传 -->
                    <button
                      v-if="knowledgeBase?.can_write"
                      class="menu-danger"
                      type="button"
                      @click="onDeleteClick(close, document)"
                    >
                      <IconTrash :size="14" /> 删除
                    </button>
                  </RowMenu>
                </div>

                <p v-if="document.error" class="row-error">{{ document.error }}</p>

                <ul v-if="expanded[document.id]?.length" class="part-rows">
                  <li v-for="part in expanded[document.id]" :key="part.id" class="part-row">
                    <span class="part-name">分片 P{{ part.part_index + 1 }}</span>
                    <span class="part-pages">第 {{ part.page_start }}–{{ part.page_end }} 页</span>
                    <StatusTag
                      :label="documentStageView(part.stage).label"
                      :tone="documentStageView(part.stage).tone"
                    />
                  </li>
                </ul>
              </li>
            </ul>
          </div>
        </template>
      </section>
    </div>

    <!-- 检索是这个库的动作，不是另一个页面：在这里开，范围天然就是当前库 -->
    <!-- 数据源（M6）：与文档列表同页——它们都是"这个库里有什么"的来源 -->
    <SourcePanel
      v-if="knowledgeBase"
      :kb-id="kbId"
      :can-write="knowledgeBase.can_write"
      @changed="refresh"
    />

    <KbSearchPanel
      v-if="knowledgeBase"
      v-model:open="searchOpen"
      :kb-id="kbId"
      :kb-name="knowledgeBase.name"
    />

    <!--
      上传（M6 / M5 收口）。**弹窗而不是"选完就传"**：
      批量上传的重复/失败必须留在屏幕上让人逐个处理，toast 做不到这件事。
    -->
    <UploadDialog
      v-if="knowledgeBase"
      v-model:open="uploadOpen"
      :kb-id="kbId"
      :kb-name="knowledgeBase.name"
      :folder-id="uploadFolderId"
      @uploaded="onUploaded"
    />

    <!-- 分享（v10）：私有是默认，想让别人看到就必须显式授出 -->
    <ShareDialog
      v-if="knowledgeBase"
      v-model:open="shareOpen"
      :kb-id="kbId"
      :kb-name="knowledgeBase.name"
    />
    <!-- 移动到目录（v13）。目录可能很多，所以用单选清单而不是"一行一个按钮" -->
    <AppModal v-model:open="moveOpen" title="移动到目录">
      <p class="move-lead">把「{{ moveTarget?.name }}」移到：</p>
      <div class="move-options">
        <label class="move-option">
          <input v-model="moveChoice" type="radio" value="" />
          <span>根目录（未归档）</span>
        </label>
        <label v-for="folder in folders" :key="folder.id" class="move-option">
          <input v-model="moveChoice" type="radio" :value="folder.id" />
          <span>{{ folder.name }}</span>
        </label>
      </div>
      <p v-if="folders.length === 0" class="move-note">
        还没有目录。先关掉这里，用左侧目录树右上角的「+」建一个。
      </p>
      <template #footer>
        <AppButton @click="moveOpen = false">取消</AppButton>
        <AppButton variant="primary" :disabled="moving" @click="confirmMove">
          {{ moving ? '移动中…' : '移动' }}
        </AppButton>
      </template>
    </AppModal>

    <!-- 重命名（v13 后）。只改显示名，不重跑解析 -->
    <AppModal v-model:open="renameOpen" title="重命名文档">
      <p class="move-lead">给「{{ renameTarget?.name }}」换一个名字：</p>
      <AppInput v-model="renameDraft" placeholder="文件名" @keydown.enter="confirmRename" />
      <template #footer>
        <AppButton @click="renameOpen = false">取消</AppButton>
        <AppButton variant="primary" :disabled="renaming" @click="confirmRename">
          {{ renaming ? '保存中…' : '保存' }}
        </AppButton>
      </template>
    </AppModal>

    <!--
      删除确认（M6 / T6.4）。**先给人看影响清单再动手**：
      "删除该文档"没人会有感觉，"3 份文档、412 个切块"才会让人停一下。
      这是《界面信息架构草案》§2"破坏性动作必须二次确认"的落点。
    -->
    <AppModal v-model:open="deleteOpen" title="删除文档">
      <p class="delete-lead">确定删除「{{ deleteTarget?.name }}」？</p>

      <p v-if="!impact" class="delete-note">正在统计影响…</p>
      <dl v-else class="delete-impact">
        <div>
          <dt>切块</dt>
          <dd class="tabular">{{ impact.chunks }}</dd>
        </div>
        <div>
          <dt>占用的空间</dt>
          <dd class="tabular">{{ formatBytes(impact.size_bytes) }}</dd>
        </div>
        <div>
          <dt>进行中的任务</dt>
          <dd class="tabular">{{ impact.running_tasks }}</dd>
        </div>
      </dl>

      <p class="delete-note">
        {{
          impact?.restorable
            ? '原文会移入回收站保留 7 天，期间可以恢复。切块与向量会立即清除——删除后立刻搜不到。'
            : '此操作不可恢复。'
        }}
      </p>

      <template #footer>
        <AppButton @click="deleteOpen = false">取消</AppButton>
        <AppButton variant="danger" :disabled="deleting" @click="confirmDelete">
          {{ deleting ? '删除中…' : '删除' }}
        </AppButton>
      </template>
    </AppModal>
  </PageShell>
</template>

<style scoped>
/* 菜单里的删除：红色文字表示破坏性，但**不填充红底**——
   填充会让它在下拉里最显眼，而它恰恰是最不该被顺手点到的那个 */
.menu-danger {
  color: var(--status-danger);
}

.delete-lead {
  margin: 0 0 var(--space-3);
  color: var(--text-primary);
}

/* 影响清单：三项并排，数字比标签显眼——用户扫的是"会失去多少" */
.delete-impact {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-3);
  margin: 0 0 var(--space-3);
  padding: var(--space-3);
  background: var(--bg-subtle);
  border-radius: var(--radius-panel);
}

.delete-impact dt {
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.delete-impact dd {
  margin: var(--space-1) 0 0;
  font-size: var(--text-section-size);
  color: var(--text-primary);
}

.delete-note {
  margin: 0;
  font-size: var(--text-meta-size);
  line-height: 1.7;
  color: var(--text-secondary);
}

.error-line {
  margin: 0 0 var(--space-4);
  color: var(--status-danger);
}

/* 只读分享的说明条：中性色，不是错误——它解释"为什么没有上传按钮" */
.readonly-note {
  margin: 0 0 var(--space-4);
  padding: var(--space-2) var(--space-3);
  font-size: var(--text-meta-size);
  line-height: 1.6;
  color: var(--text-secondary);
  background: var(--bg-subtle);
  border-radius: var(--radius-control);
}

/* ---- 目录树（v13）---- */

/* 两栏：左侧目录树（固定宽）+ 右侧文档区（吃满剩余）。
   用 `align-items: flex-start` 让树保持自身高度，sticky 才有意义 */
.kb-body {
  display: flex;
  align-items: flex-start;
  gap: var(--space-4);
}

.folder-tree {
  position: sticky;
  top: var(--space-4);
  flex: 0 0 220px;
  padding: var(--space-2);
  background: var(--bg-canvas);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-panel);
}

.doc-area {
  flex: 1;
  min-width: 0;
}

/* 窄屏：树折到上方并铺满。阈值取 1024（而不是更小的 900）：
   两栏并排时文档区要装下"切块/大小/时间/菜单"那几列固定宽度，
   实测可用宽度掉到 900 出头就开始横向溢出，所以提前折行。 */
@media (max-width: 1024px) {
  .kb-body {
    flex-direction: column;
  }

  .folder-tree {
    position: static;
    flex-basis: auto;
    width: 100%;
  }
}

.tree-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-1) var(--space-2);
}

.tree-title {
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.tree-add {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  color: var(--text-tertiary);
  border-radius: var(--radius-control);
}

.tree-add:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.tree-list,
.tree-children {
  margin: 0;
  padding: 0;
  list-style: none;
}

/* 子级用一条竖线表达"在谁的下面"——树的两层关系全靠它读出来 */
.tree-children {
  margin-left: 10px;
  border-left: 1px solid var(--border-hairline);
}

.tree-row {
  display: flex;
  align-items: center;
  gap: 2px;
  border-radius: var(--radius-control);
}

.tree-row:hover {
  background: var(--bg-hover);
}

.tree-row-on {
  background: var(--accent-soft);
}

.tree-row-on .tree-node {
  color: var(--accent-text);
}

.tree-caret {
  display: inline-flex;
  flex: 0 0 20px;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 26px;
  color: var(--text-tertiary);
  border-radius: var(--radius-control);
}

button.tree-caret:hover {
  color: var(--text-primary);
}

.tree-node {
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: center;
  gap: var(--space-2);
  height: 26px;
  padding: 0 var(--space-2) 0 0;
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
  text-align: left;
  border-radius: var(--radius-control);
}

.tree-node:hover {
  color: var(--text-primary);
}

/* 目录名可能很长：省略号收口，别把整行挤走 */
.tree-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tree-count {
  flex: 0 0 auto;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.tree-empty {
  padding: var(--space-1) var(--space-3);
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.tree-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2);
}

.tree-form-actions {
  display: flex;
  gap: var(--space-2);
}

/* ---- 筛选 ---- */

.filter-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}

/* 搜索框：图标压在输入框左内侧。AppInput 的 .field 在子组件里，
   所以用 :deep 把左内边距让给图标 */
.search-box {
  position: relative;
  flex: 0 1 260px;
  min-width: 180px;
}

.search-box :deep(.field) {
  padding-left: calc(var(--space-3) + 24px);
}

.search-icon {
  position: absolute;
  top: 50%;
  left: var(--space-3);
  z-index: 1;
  color: var(--text-tertiary);
  pointer-events: none;
  transform: translateY(-50%);
}

.filter-select {
  flex: 0 0 148px;
}

/* ---- 多选与批量 ---- */

.batch-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
  padding: var(--space-2) var(--space-3);
  background: var(--accent-soft);
  border-radius: var(--radius-control);
}

/* 左侧计数吃掉剩余空间，把按钮推到右边 */
.batch-count {
  margin-right: auto;
  font-size: var(--text-meta-size);
  color: var(--accent-text);
}

/* 勾选框列：列头与行同宽，右侧的列才不会错位 */
.head-check,
.row-check {
  display: flex;
  flex: 0 0 20px;
  align-items: center;
  justify-content: center;
}

.head-check input,
.row-check input {
  width: 15px;
  height: 15px;
  margin: 0;
  accent-color: var(--accent);
  cursor: pointer;
}

/* ---- 移动到目录 ---- */

.move-lead {
  margin: 0 0 var(--space-3);
  font-size: var(--text-meta-size);
  color: var(--text-primary);
}

.move-options {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  max-height: 280px;
  overflow-y: auto;
}

.move-option {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-control);
  cursor: pointer;
}

.move-option:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.move-option input {
  flex: 0 0 auto;
  accent-color: var(--text-secondary);
}

.move-note {
  margin: var(--space-3) 0 0;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

/* 列头与行共用同一套列宽，数字才会真的排在一条竖轴上 */
.list-head,
.doc-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

/* 表头区：底色来自 .panel-head，这里只管列宽与对齐 */
.list-head {
  padding: 0 var(--space-4);
}

/* 与文件名起点对齐：命中区 24px + gap（列头没有展开器，自己让出来） */
.head-file {
  flex: 1;
  padding-left: calc(var(--hit-target) + var(--space-3));
}

.head-number {
  flex: 0 0 56px;
  text-align: right;
}

.head-size {
  flex: 0 0 72px;
  text-align: right;
}

.head-time {
  flex: 0 0 96px;
  text-align: right;
}

.head-menu {
  flex: 0 0 24px;
}

.doc-rows {
  margin: 0;
  padding: 0;
  list-style: none;
}

.doc-row-group + .doc-row-group {
  border-top: 1px solid var(--border-hairline);
}

.doc-row {
  padding: 0 var(--space-4);
}

/* 展开器给足 24px 命中区：20px 在触屏上点不中 */
.expander,
.expander-placeholder {
  display: inline-flex;
  flex: 0 0 var(--hit-target);
  align-items: center;
  justify-content: center;
  width: var(--hit-target);
  height: var(--hit-target);
  color: var(--text-tertiary);
  border-radius: var(--radius-control);
}

.expander:hover {
  background: var(--bg-active);
  color: var(--text-primary);
}

.row-icon {
  flex: 0 0 auto;
  color: var(--text-tertiary);
}

/* 文件名与状态同处一列：状态跟着文件走，而不是飘在右边的孤立列 */
.row-main {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex: 1;
  min-width: 0;
}

/* 链接撑满整行高度：文字本身只有 23px 高，做成整行可点才够得着。
   必须写在 .row-main 之下：`.row-main { align-items }` 会覆盖单独一条 `.row-name` 的 align-self。 */
.row-main .row-name {
  display: inline-flex;
  align-items: center;
  align-self: stretch;
  min-height: var(--hit-target);
  overflow: hidden;
  color: var(--text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 数字列：等宽 + 右对齐，沿一条竖轴排下来 */
.row-number {
  flex: 0 0 56px;
  text-align: right;
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
}

.row-size {
  flex: 0 0 72px;
  text-align: right;
  font-size: var(--text-meta-size);
  color: var(--text-tertiary);
}

/* 上传者（G6）：比时间弱一档。它是"谁"，属于旁注，
   不该与文件名抢注意力 */
.row-uploader {
  flex: 0 0 auto;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.row-time {
  flex: 0 0 96px;
  text-align: right;
  font-size: var(--text-meta-size);
  color: var(--text-tertiary);
}

.row-menu {
  flex: 0 0 24px;
}

.row-error {
  margin: 0;
  padding: 0 var(--space-3) var(--space-2) var(--space-12);
  font-size: var(--text-meta-size);
  color: var(--status-danger);
}

/* 子文件树：缩进一级（§6） */
.part-rows {
  margin: 0;
  padding: 0 var(--space-3) var(--space-2) var(--space-12);
  list-style: none;
}

.part-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  height: var(--row-height-compact);
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
}

.part-name {
  color: var(--text-primary);
}

.part-pages {
  color: var(--text-tertiary);
}
</style>
