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
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter, type LocationQuery, type LocationQueryRaw } from 'vue-router'

import {
  batchDocuments,
  cancelDocument,
  deleteDocument,
  downloadDocument,
  setDocumentDisabled,
  getDocumentImpact,
  listDocumentParts,
  listDocuments,
  moveDocument,
  renameDocument,
  reprocessDocument,
  DOCUMENT_PAGE_SIZE,
  type DataSourceKind,
  type DocumentStage,
  type DocumentListFilter,
  type ImpactReport,
  type DocumentPart,
  type DocumentSummary,
} from '@/api/documents'
import { createFolder, deleteFolder, listFolders, renameFolder, type Folder } from '@/api/folders'
import IconChevronDown from '@/components/icons/IconChevronDown.vue'
import IconChevronLeft from '@/components/icons/IconChevronLeft.vue'
import IconChevronRight from '@/components/icons/IconChevronRight.vue'
import IconClose from '@/components/icons/IconClose.vue'
import IconDownload from '@/components/icons/IconDownload.vue'
import IconEdit from '@/components/icons/IconEdit.vue'
import IconFile from '@/components/icons/IconFile.vue'
import IconFolder from '@/components/icons/IconFolder.vue'
import IconInbox from '@/components/icons/IconInbox.vue'
import IconLibrary from '@/components/icons/IconLibrary.vue'
import IconPlus from '@/components/icons/IconPlus.vue'
import IconQuestion from '@/components/icons/IconQuestion.vue'
import IconRefresh from '@/components/icons/IconRefresh.vue'
import IconTrash from '@/components/icons/IconTrash.vue'
import IconSearch from '@/components/icons/IconSearch.vue'
import IconShare from '@/components/icons/IconShare.vue'
import IconUpload from '@/components/icons/IconUpload.vue'
import KbSearchPanel from '@/components/search/KbSearchPanel.vue'
import DocumentDrawer from '@/components/knowledge/DocumentDrawer.vue'
import KnowledgeBaseMenu from '@/components/knowledge/KnowledgeBaseMenu.vue'
import ShareDialog from '@/components/knowledge/ShareDialog.vue'
import UploadDialog from '@/components/knowledge/UploadDialog.vue'
import RowMenu from '@/components/ui/RowMenu.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppModal from '@/components/ui/AppModal.vue'
import AppSelect from '@/components/ui/AppSelect.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import MeterBar from '@/components/ui/MeterBar.vue'
import PageShell from '@/components/ui/PageShell.vue'
import SkeletonBlock from '@/components/ui/SkeletonBlock.vue'
import StatusTag from '@/components/ui/StatusTag.vue'
import { documentStageView } from '@/components/ui/status'
import { formatBytes, formatRelativeTime } from '@/composables/useFormat'
import {
  progressCaption,
  progressSegments,
  progressTone,
  showsProgress,
} from '@/composables/useProgress'
import { MAX_UPLOAD_MB, UPLOAD_FORMAT_HINT } from '@/composables/uploadLimits'
import { usePolling } from '@/composables/usePolling'
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
 * 当前打开的文档详情抽屉（URL 查询参数 `doc`）。
 *
 * **状态放 URL 而不是组件内部**：刷新、分享链接、浏览器后退都能回到同一个画面，
 * 而"点文件名 → 换路由"这种事一旦只记在内存里，后退键就会变得不可预测。
 */
const openDocumentId = computed(() => String(route.query.doc ?? ''))

function closeDocument(): void {
  void router.replace({ path: route.path, query: withoutDocument(route.query) })
}

/**
 * 从列表点开某份文档时的目标地址：保留筛选/页码之外的查询参数，去掉 `doc` 与 `page`。
 *
 * **`page` 必须去掉**：它是引用带进来的"看第 N 页"，只对引用那一份有意义；
 * 留着它，接着点开另一份文档会莫名其妙跳到它的第 N 页。
 */
/**
 * 列表行的悬浮提示：文件名 + 摘要（v25）。
 *
 * 摘要**不占列**（列表已经八列，再加一列就真读不动了），但它对"这篇是啥"
 * 很省事——悬浮一眼就看到。没有摘要时只显示文件名，不留空行。
 */
function rowTitle(document: DocumentSummary): string {
  const summary = document.summary?.trim()
  return summary
    ? `${document.name}

${summary}`
    : document.name
}

function documentLink(id: string): LocationQueryRaw {
  return { ...withoutDocument(route.query), doc: id }
}

function withoutDocument(query: LocationQuery): LocationQueryRaw {
  const next: LocationQueryRaw = {}
  for (const [key, value] of Object.entries(query)) {
    // `tab` 也要去掉：它只对"刚才点开的那一份"有意义，留着的话关掉抽屉再点另一份
    // 会莫名其妙落在「处理明细」上（用户点文件名时想看的是阅读）
    if (key !== 'doc' && key !== 'page' && key !== 'tab' && value !== null) next[key] = value
  }
  return next
}

/** 打开抽屉时落在哪个页签（`?tab=progress` 直接送进「处理明细」）。 */
const DRAWER_TABS = ['read', 'chunks', 'progress'] as const

const initialDrawerTab = computed(() => {
  const wanted = String(route.query.tab ?? '')
  return DRAWER_TABS.includes(wanted as (typeof DRAWER_TABS)[number])
    ? (wanted as (typeof DRAWER_TABS)[number])
    : null
})

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

/** 待确认的动作（统一走 ConfirmDialog，不再用浏览器原生 confirm）。 */
const folderDeleteTarget = ref<Folder | null>(null)
const folderDeleting = ref(false)
const folderDeleteOpen = computed({
  get: () => folderDeleteTarget.value !== null,
  set: (value: boolean) => {
    if (!value) folderDeleteTarget.value = null
  },
})
const batchDeleteOpen = ref(false)
const cancelParseTarget = ref<DocumentSummary | null>(null)
const cancelParseOpen = computed({
  get: () => cancelParseTarget.value !== null,
  set: (value: boolean) => {
    if (!value) cancelParseTarget.value = null
  },
})

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
    // 跨页选择下要**主动**摘掉这一篇：列表刷新只换当前页的内容，
    // 不摘的话它会一直算在"已选 N 篇"里（后端删它会报不存在）。
    dropFromSelection([target.id])
    notifySuccess('已删除，原文在回收站保留 7 天')
    await refreshAll()
    void store.refreshSummaries()
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '删除失败')
  } finally {
    deleting.value = false
  }
}

const kbId = computed(() => String(route.params.kbId ?? ''))
const knowledgeBase = computed(() => store.byId(kbId.value))

/** 库级管理动作的回声：改名由 store 就地更新；删库后这一页已无所指，回列表。 */
function onKbChanged(action: 'renamed' | 'deleted' | 'sources'): void {
  if (action === 'deleted') {
    void router.push('/knowledge-bases')
    return
  }
  if (action === 'sources') {
    // 数据源面板里点过「立即拉取」之后，新文档要出现在列表上
    void refreshAll()
  }
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
 *  而这里最多几十个 id，数组的 `includes` 开销可以忽略。
 *
 *  **跨页累计**：翻页不清空，上一页勾的继续算数——所以批量动作打到的可能是
 *  看不见那一页的文档。界面上要如实说明（`offPageSelected`），不能只报个总数。
 *  筛选条件一变则清空（见 `refresh`）：换了一组文档还留着旧选择，
 *  用户没法知道自己到底选了些什么。 */
const selected = ref<string[]>([])
const selectedCount = computed(() => selected.value.length)

/** 当前页的 id 是否**全部**已在选中集里（决定表头复选框的状态）。 */
const allSelected = computed(
  () =>
    documents.value.length > 0 &&
    documents.value.every((document) => selected.value.includes(document.id)),
)

/** 当前页勾了几篇——用来判断半选，也用来决定表头点击是"补上"还是"去掉"。 */
const pageSelectedCount = computed(
  () => documents.value.filter((document) => selected.value.includes(document.id)).length,
)

/** 当前页选中了一部分：表头复选框显示"半选"。（原生 indeterminate 只能走 DOM 属性。） */
const someSelected = computed(() => !allSelected.value && pageSelectedCount.value > 0)

/** 选中的文档里有几篇**不在当前页**。批量条据此如实提示跨页选择。 */
const offPageSelected = computed(() => {
  const onPage = new Set(documents.value.map((document) => document.id))
  return selected.value.filter((id) => !onPage.has(id)).length
})

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

/**
 * 移动到目录的弹窗。**单篇与批量共用**：两者只差"移谁"与提交走哪个接口，
 * 目录清单、选中逻辑、提示文案都一样，没必要做两个弹窗。
 */
const moveTarget = ref<DocumentSummary | null>(null)
const moveBatchIds = ref<string[]>([])
const moveChoice = ref('')
const moving = ref(false)
const moveOpen = computed({
  get: () => moveTarget.value !== null || moveBatchIds.value.length > 0,
  set: (value: boolean) => {
    if (!value) {
      moveTarget.value = null
      moveBatchIds.value = []
    }
  },
})
const moveLead = computed(() =>
  moveBatchIds.value.length > 0
    ? `把选中的 ${moveBatchIds.value.length} 篇移到：`
    : `把「${moveTarget.value?.name}」移到：`,
)

/** 批量条目里第一条失败原因，用于"部分失败"的提示。 */
function firstBatchError(items: { ok: boolean; error: string | null }[]): string {
  return items.find((item) => !item.ok)?.error ?? ''
}

function onBatchMoveClick(): void {
  moveBatchIds.value = [...selected.value]
  // 默认落在"根目录"：批量选中的文档可能来自不同目录，没有共同的当前值
  moveChoice.value =
    activeFolder.value && activeFolder.value !== ROOT_FILTER ? activeFolder.value : ''
}

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

/**
 * 表头复选框：**只切换当前页**在选中集里的去留。
 *
 * - 当前页还没全选（含半选）→ 把这一页**并入**选中集（不覆盖其他页的选择）；
 * - 当前页已全选 → 把这一页**移出**选中集（其他页保留）。
 *
 * 因此它是"逐页累加"的入口：连点几页的表头 = 跨页全选。
 */
function toggleSelectAll(): void {
  if (allSelected.value) {
    const onPage = new Set(documents.value.map((document) => document.id))
    selected.value = selected.value.filter((id) => !onPage.has(id))
    return
  }
  const merged = new Set(selected.value)
  for (const document of documents.value) merged.add(document.id)
  selected.value = [...merged]
}

function clearSelection(): void {
  selected.value = []
}

/** 把一批 id 从选中集里去掉（文档被删/被移走之后调用）。 */
function dropFromSelection(ids: readonly string[]): void {
  if (selected.value.length === 0) return
  const gone = new Set(ids)
  selected.value = selected.value.filter((id) => !gone.has(id))
}

/** 批量删除走确认弹窗（与单篇删除同一套形态），确认后再真正执行。 */
function requestBatchDelete(): void {
  if (selectedCount.value === 0 || batchRunning.value) return
  batchDeleteOpen.value = true
}

/**
 * 批量动作。**部分失败是正常结果**，所以按后端逐条回的成败分别处理：
 * 全成 → 清空选择；有失败 → 把失败的那几条留在选中态，用户可以重试或看原因。
 */
async function runBatch(action: 'delete' | 'reprocess'): Promise<void> {
  if (selectedCount.value === 0 || batchRunning.value) return
  batchDeleteOpen.value = false
  batchRunning.value = true
  const ids = [...selected.value]
  const verb = action === 'delete' ? '删除' : '重新摄入'
  try {
    const result = await batchDocuments(kbId.value, action, ids)
    await refreshAll()
    void store.refreshSummaries()
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

/**
 * 批量补生成分段问题（v24）。
 *
 * **非破坏性、也不清空选择**：文档还在、还想再生成一次都可能，留着选中的那批
 * 反而方便。它是一个异步任务，所以立刻给一句"已完成会自动刷新"的预期，
 * 列表靠 `questions_pending` 轮询刷新（出题不改文档阶段，`hasActive` 看不到它）。
 */
async function runBatchQuestions(): Promise<void> {
  if (selectedCount.value === 0 || batchRunning.value) return
  batchRunning.value = true
  try {
    const result = await batchDocuments(kbId.value, 'questions', [...selected.value])
    await refresh()
    if (result.failed === 0) {
      notifySuccess(`已排队为 ${result.succeeded} 篇生成问题，完成后列表会自动刷新`)
      return
    }
    const firstError = result.items.find((item) => !item.ok)?.error
    notifyError(
      `生成问题：${result.succeeded} 篇已排队、${result.failed} 篇未排队` +
        (firstError ? `（${firstError}）` : ''),
    )
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '生成问题失败')
  } finally {
    batchRunning.value = false
  }
}

/** 单篇「生成问题」（行菜单）：与批量同一条路，只是目标只有这一篇。 */
async function onQuestionsClick(close: () => void, document: DocumentSummary): Promise<void> {
  close()
  try {
    const result = await batchDocuments(kbId.value, 'questions', [document.id])
    await refresh()
    if (result.failed === 0) {
      notifySuccess('已排队生成问题，完成后列表会自动刷新')
      return
    }
    notifyError(result.items[0]?.error || '生成问题失败')
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '生成问题失败')
  }
}

/** 停用 / 恢复检索（批量）：与删除/重建同一条逐条回成败的路径。 */
async function runBatchToggleDisabled(action: 'enable' | 'disable'): Promise<void> {
  if (selectedCount.value === 0 || batchRunning.value) return
  batchRunning.value = true
  const ids = [...selected.value]
  const verb = action === 'disable' ? '停用' : '恢复'
  try {
    const result = await batchDocuments(kbId.value, action, ids)
    await refresh()
    if (result.failed === 0) {
      notifySuccess(`已${verb} ${result.succeeded} 篇的检索`)
      return
    }
    const firstError = result.items.find((item) => !item.ok)?.error
    notifyError(
      `${verb}：${result.succeeded} 篇成功、${result.failed} 篇失败` +
        (firstError ? `（${firstError}）` : ''),
    )
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : `批量${verb}失败`)
  } finally {
    batchRunning.value = false
  }
}

/** 单篇停用 / 恢复（行菜单）。 */
async function onToggleDisabledClick(close: () => void, document: DocumentSummary): Promise<void> {
  close()
  try {
    await setDocumentDisabled(document.id, !document.disabled)
    await refresh()
    notifySuccess(document.disabled ? '已恢复检索' : '已停用检索——文档与其内容都保留')
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '操作失败')
  }
}

/** 当前页还有没有在跑的文档。按时间倒序时它们都在第 1 页（新上传的在最前），
 *  所以只看当前页不会漏掉"该轮询"的信号；翻到后面的页停下来是正常的。 */
const hasActive = computed(() =>
  documents.value.some((document) => ACTIVE_STAGES.has(document.stage)),
)

/** 有没有出题任务在跑。**必须单列**：它不改变文档阶段，`hasActive` 看不到它，
 *  于是"点了生成问题但列表一直不刷新"会变成一个无从解释的现象。 */
const questionsPending = computed(() =>
  documents.value.some((document) => document.questions_pending),
)

/** 需要轮询的两个来源：文档阶段在动，或出题任务在跑。 */
const needsPolling = computed(() => hasActive.value || questionsPending.value)

/** 出题列文案：生成中 > 已出题条数 > 未生成 > 还没切块（出不了题）。 */
function questionCell(document: DocumentSummary): string {
  if (document.questions_pending) return '生成中…'
  if (document.question_count > 0) return `${document.question_count} 题`
  if (document.chunk_count === 0) return '—'
  return '未生成'
}

/** 出题列的悬浮说明：把"几段里有几段出了题"说全，列里只放得下总数。 */
function questionTitle(document: DocumentSummary): string {
  if (document.questions_pending) return '正在为这份文档生成分段问题'
  if (document.question_count === 0) {
    return document.chunk_count === 0
      ? '还没有分段，无法出题'
      : '还没有为这份文档生成分段问题（选中后可点「生成问题」）'
  }
  return `${document.questioned_chunk_count}/${document.chunk_count} 段有问题，共 ${document.question_count} 条`
}

// ------------------------------------------------------------------ 分页

/**
 * 当前页（从 1 开始）与总数。
 *
 * 列表**一次只取一页**（`limit`/`offset` 下推到 SQL）：一个库几百上千篇时，
 * "全量拉回来再在内存里切"会把响应体、耗时和渲染量都随库大小一起涨。
 * `total` 来自后端：前端只拿得到当前页的 `items`，算不出总页数。
 */
const PAGE_SIZE = DOCUMENT_PAGE_SIZE
const page = ref(1)
const total = ref(0)
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))

/** 上一次请求的筛选条件（**不含分页**）。换了条件就回第 1 页——那是另一份清单。 */
const lastFilterKey = ref('')

/** 把筛选状态收成一个对象；分页参数由调用方追加，不进 filterKey。 */
function buildFilter(): DocumentListFilter {
  const filter: DocumentListFilter = {}
  if (activeFolder.value === ROOT_FILTER) filter.root = true
  else if (activeFolder.value) filter.folderId = activeFolder.value
  const keyword = searchDraft.value.trim()
  if (keyword) filter.q = keyword
  if (stageFilter.value) filter.stage = stageFilter.value as DocumentStage
  if (sourceFilter.value) filter.sourceKind = sourceFilter.value as DataSourceKind
  return filter
}

/**
 * 翻页。
 *
 * **翻页不清空勾选**：选中的是一批文档，不是"这一页"，跨页累计起来才有意义
 * （连点几页的表头就是跨页全选）。所以翻页只换内容，选择留着；换来换去的是
 * 哪些文档，由批量条上的"另有 N 篇不在本页"如实说明。
 */
function goToPage(next: number): void {
  const clamped = Math.min(Math.max(1, next), pageCount.value)
  if (clamped === page.value) return
  page.value = clamped
  void refresh()
}

async function refresh(): Promise<void> {
  if (!kbId.value) return
  try {
    const filter = buildFilter()
    const filterKey = JSON.stringify(filter)
    if (filterKey !== lastFilterKey.value) {
      lastFilterKey.value = filterKey
      page.value = 1
      selected.value = []
    }
    const offset = (page.value - 1) * PAGE_SIZE
    const list = await listDocuments(kbId.value, { ...filter, limit: PAGE_SIZE, offset })
    // 删除到某页空了（比如最后一页只剩 1 篇被删掉）就夹回最后一页再取，
    // 而不是给用户一个空列表——那看起来像"这个库没文档了"。
    const pages = Math.max(1, Math.ceil(list.total / PAGE_SIZE))
    if (page.value > pages) {
      page.value = pages
      return refresh()
    }
    documents.value = list.items
    total.value = list.total
    error.value = ''
    void nextTick(syncFillerRows)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '文档列表加载失败'
  }
}

// ------------------------------------------------------------------ 表格补白

/** 与 CSS 的 `--row-height` 一致。补白行要按它算，两处漂了就会算错行数。 */
const ROW_HEIGHT = 44

/**
 * 表格的行数**不跟着文件数走**：只有两三个文件时如果只画两三行，
 * 下面就是一大片空白，页面看着像没加载完。所以补足到铺满可视区。
 *
 * 补的是**空行**（带分隔线），而不是把面板拉高——空行读起来是"表格还有位置"，
 * 拉高一个空面板读起来是"这里坏了"。
 */
const listPanel = ref<HTMLElement | null>(null)
const fillerRows = ref(0)

function syncFillerRows(): void {
  const element = listPanel.value
  if (element === null) return
  const headHeight = 40 /* .panel-head */
  const bottomGap = 56 /* 给页面底部留一口气，别贴到边 */
  const available = window.innerHeight - element.getBoundingClientRect().top - bottomGap
  // 空库时也会有"还没有文档"那一行提示，所以数据侧至少占 1 行
  const dataRows = Math.max(documents.value.length, 1)
  const fit = Math.ceil((available - headHeight) / ROW_HEIGHT)
  fillerRows.value = Math.max(0, Math.min(fit - dataRows, 60))
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

/** 「未归档」计数：树上的数字要准，所以单独查一次根目录范围。
 *  `limit: 1` 只要那个 `total`——分页之后 `items.length` 最多是每页条数。 */
async function loadCounts(): Promise<void> {
  if (!kbId.value) return
  try {
    unfiledCount.value = (await listDocuments(kbId.value, { root: true, limit: 1 })).total
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

/**
 * 只在有活儿在跑时轮询：全绿之后停表，避免无意义的持续请求。
 *
 * 节奏、标签页隐藏时暂停、慢请求不叠加都交给 `usePolling`（§12.116）——
 * 原先这四处（本页、任务中心、Wiki、抽屉明细）各写了一遍 `setInterval`，
 * 也就各漏了一遍"隐藏时照打"与"慢请求堆积"。
 */
usePolling(refresh, { active: needsPolling, intervalMs: POLL_INTERVAL_MS })
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
/** 窗口变高变矮都要重算补白——它本来就是"铺满可视区"的意思。 */
function onWindowResize(): void {
  syncFillerRows()
}

onMounted(async () => {
  window.addEventListener('resize', onWindowResize)
  // `load()` 带回每个库的文档数（设置弹窗里的"文档 N 篇"用它）
  if (store.items.length === 0) await store.load()
  await loadFirst()
  void nextTick(syncFillerRows)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onWindowResize)
  if (searchTimer !== null) clearTimeout(searchTimer)
})

async function onUploaded(): Promise<void> {
  // 弹窗自己负责**逐文件的结果**（哪个重复、哪个失败），这里只负责开始盯进度。
  // 不再发 toast：批量上传时 toast 会连成一片，"哪几个没成功"根本看不清，
  // 而那恰恰是用户唯一需要看的部分——那份清单留在弹窗里。
  // 新文档按时间倒序排在第 1 页最前，所以传完先跳回第 1 页，别让用户以为没进去。
  page.value = 1
  await refreshAll()
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

function requestFolderDelete(folder: Folder): void {
  folderDeleteTarget.value = folder
}

async function confirmFolderDelete(): Promise<void> {
  const folder = folderDeleteTarget.value
  if (!folder || folderDeleting.value) return
  folderDeleting.value = true
  try {
    await deleteFolder(folder.id)
    folderDeleteTarget.value = null
    // 正在看的目录被删了：回到「全部」，否则列表会停在一个不存在的筛选上
    if (activeFolder.value === folder.id) activeFolder.value = ''
    await refreshAll()
    notifySuccess('目录已删除')
  } catch (cause) {
    // 目录非空时后端会拒绝，消息里带"还有 N 篇"——原样透给用户，他才好决定下一步
    notifyError(cause instanceof Error ? cause.message : '删除失败')
  } finally {
    folderDeleting.value = false
  }
}

function onMoveClick(close: () => void, document: DocumentSummary): void {
  close()
  moveTarget.value = document
  // 默认落在它当前所在的位置：多数人是想改到别处，而不是先看到"根目录"
  moveChoice.value = document.folder_id ?? ''
}

async function confirmMove(): Promise<void> {
  if (moving.value) return
  moving.value = true
  const target = moveChoice.value || null
  try {
    if (moveBatchIds.value.length > 0) {
      const ids = [...moveBatchIds.value]
      const result = await batchDocuments(kbId.value, 'move', ids, target)
      moveBatchIds.value = []
      await refreshAll()
      if (result.failed === 0) {
        // 移动完成即收工：选中的那批已经不在这个位置，留着只会变成跨页的幽灵勾选
        selected.value = []
        notifySuccess(`已移动 ${result.succeeded} 篇`)
      } else {
        const reason = firstBatchError(result.items)
        notifyError(
          `移动：${result.succeeded} 篇成功、${result.failed} 篇失败${reason ? `（${reason}）` : ''}`,
        )
        selected.value = result.items.filter((item) => !item.ok).map((item) => item.document_id)
      }
      return
    }
    const single = moveTarget.value
    if (!single) return
    await moveDocument(single.id, target)
    moveTarget.value = null
    dropFromSelection([single.id])
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
function onCancelClick(close: () => void, document: DocumentSummary): void {
  close()
  cancelParseTarget.value = document
}

async function confirmCancelParse(): Promise<void> {
  const document = cancelParseTarget.value
  if (!document || canceling.value) return
  canceling.value = document.id
  try {
    await cancelDocument(document.id)
    cancelParseTarget.value = null
    await refresh()
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
    <!-- 设置齿轮贴在标题右侧：它是"这个库本身"的入口，不是页面的动作。
         库的规模/模型/切分等具体信息移进设置弹窗，页头不再挂那行小字 -->
    <template v-if="knowledgeBase?.can_write" #title-suffix>
      <KnowledgeBaseMenu :kb="knowledgeBase" @changed="onKbChanged" />
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
                        @click="(requestFolderDelete(folder), close())"
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
        <!--
          工具栏：搜索/筛选与三个动作**同一行**，都在列表正上方（用户要求"齐平"）。
          它们都在 `--control-height`(32px) 上，所以高度天然一致。
        -->
        <div class="toolbar">
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
          <AppButton v-if="hasFilter" size="sm" variant="subtle" @click="clearFilters">
            清除筛选
          </AppButton>

          <div class="toolbar-actions">
            <AppButton
              variant="subtle"
              :disabled="documents.length === 0"
              @click="searchOpen = true"
            >
              <template #icon><IconSearch /></template>
              在此库检索
            </AppButton>
            <!-- Wiki 入口只在库形态选了「向量检索 + Wiki」时出现：没开这个形态的库
                 给它一个点了只看到引导页的按钮，等于兑现不了的承诺 -->
            <AppButton
              v-if="knowledgeBase?.wiki_enabled"
              variant="subtle"
              @click="router.push(`/kb/${kbId}/wiki`)"
            >
              <template #icon><IconLibrary /></template>
              Wiki
            </AppButton>
            <!-- 分享入口只对 owner / 管理员出现：can_manage 由后端算，前端不重复判定 -->
            <AppButton v-if="knowledgeBase?.can_manage" variant="subtle" @click="shareOpen = true">
              <template #icon><IconShare /></template>
              分享
            </AppButton>
            <!-- 只读分享的成员看得到内容，但没有写入口（can_write 由后端算） -->
            <AppButton v-if="knowledgeBase?.can_write" variant="subtle" @click="uploadOpen = true">
              <template #icon><IconUpload /></template>
              上传文档
            </AppButton>
          </div>
        </div>

        <SkeletonBlock v-if="loading && documents.length === 0" variant="list" :rows="4" />

        <template v-else>
          <!-- 勾选后浮出的批量动作条（全选在列表内的表头里，不在这里） -->
          <div v-if="selectedCount > 0" class="batch-bar">
            <span class="batch-count">
              已选 {{ selectedCount }} 篇
              <!-- 跨页选择必须说清楚：否则用户看到"已选 60 篇"而眼前只有 50 行，
                   会以为计数错了，或不知道批量动作会打到别的页上 -->
              <span v-if="offPageSelected > 0" class="batch-offpage">
                （另有 {{ offPageSelected }} 篇不在本页）
              </span>
            </span>
            <AppButton size="sm" :disabled="batchRunning" @click="onBatchMoveClick">
              <template #icon><IconFolder /></template>
              移动到目录
            </AppButton>
            <AppButton
              size="sm"
              :disabled="batchRunning"
              @click="runBatchToggleDisabled('disable')"
            >
              停用检索
            </AppButton>
            <AppButton size="sm" :disabled="batchRunning" @click="runBatchToggleDisabled('enable')">
              恢复检索
            </AppButton>
            <AppButton size="sm" :disabled="batchRunning" @click="runBatchQuestions">
              <template #icon><IconQuestion /></template>
              生成问题
            </AppButton>
            <AppButton size="sm" :disabled="batchRunning" @click="runBatch('reprocess')">
              <template #icon><IconRefresh /></template>
              重新摄入
            </AppButton>
            <AppButton
              size="sm"
              variant="danger"
              :disabled="batchRunning"
              @click="requestBatchDelete"
            >
              <template #icon><IconTrash /></template>
              删除
            </AppButton>
            <AppButton size="sm" :disabled="batchRunning" @click="clearSelection">
              取消选择
            </AppButton>
          </div>

          <!-- 列头：让右侧那串数字有名字，不必靠猜。
           文字列标 aria-hidden（纯装饰）；全选框是交互控件，保留可读名 -->
          <div ref="listPanel" class="panel">
            <div class="panel-head list-head">
              <span v-if="knowledgeBase?.can_write" class="head-check">
                <input
                  type="checkbox"
                  :checked="allSelected"
                  :indeterminate="someSelected"
                  :aria-label="allSelected ? '取消选择本页' : '全选本页（可逐页累加）'"
                  @change="toggleSelectAll"
                />
              </span>
              <span class="head-file" aria-hidden="true">文件</span>
              <span class="head-number" aria-hidden="true">切块</span>
              <span class="head-question" aria-hidden="true">问题</span>
              <span class="head-size" aria-hidden="true">大小</span>
              <span class="head-time" aria-hidden="true">更新时间</span>
              <span class="head-menu" aria-hidden="true" />
            </div>

            <ul class="doc-rows">
              <!-- 空范围也照常给表头和数据区，只是第一行换成一句说明——
                   换成一张居中大卡片会让页面塌下去一块，也丢掉了列结构 -->
              <li v-if="documents.length === 0" class="doc-row-group">
                <div class="doc-row panel-row doc-empty-row">
                  <span class="doc-empty-text">{{ emptyTitle }}</span>
                  <span class="doc-empty-hint">
                    {{ UPLOAD_FORMAT_HINT }}；单文件上限 {{ MAX_UPLOAD_MB }}MB。
                  </span>
                </div>
              </li>
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
                    <!-- 点文件名**留在本页**：把文档 id 写进查询参数，右侧滑出详情抽屉。
                         走查询参数而不是独立路由，列表组件才不会被卸载——关掉抽屉回到原位，
                         滚动位置与筛选都不丢。「在新标签打开」仍然得到 /documents/:id（跳板会转回来）。 -->
                    <RouterLink
                      class="row-name"
                      :to="{ path: route.path, query: documentLink(document.id) }"
                      :title="rowTitle(document)"
                    >
                      <span class="row-name-text">{{ document.name }}</span>
                    </RouterLink>
                    <StatusTag
                      :label="stageOf(document).label"
                      :tone="stageOf(document).tone"
                      :running="ACTIVE_STAGES.has(document.stage)"
                      :title="document.error ?? undefined"
                    />
                    <!-- 停用（v14）：不参与检索但一切保留。中性色——它是"被搁置"，不是"出错" -->
                    <StatusTag v-if="document.disabled" label="已停用" tone="neutral" />
                    <!-- 谁传的（G6）。没记到时显示"未记录"而不是留空——
                     留空会让人以为是界面没渲染出来 -->
                    <span v-if="roster.length" class="row-uploader">
                      {{ document.uploaded_by_name || '未记录' }}
                    </span>
                  </span>

                  <span class="row-number">{{ document.chunk_count }}</span>
                  <span
                    class="row-question"
                    :class="{ 'is-muted': questionCell(document) === '未生成' }"
                    :title="questionTitle(document)"
                  >
                    {{ questionCell(document) }}
                  </span>
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
                    <!-- 补生成分段问题：只对已索引的文档有意义（别的阶段还没切块，
                         或正被重写）。非索引进来的那份后端会逐条拒绝并说明原因 -->
                    <button
                      v-if="knowledgeBase?.can_write && document.stage === 'indexed'"
                      type="button"
                      @click="onQuestionsClick(close, document)"
                    >
                      <IconQuestion :size="14" /> 生成问题
                    </button>
                    <button
                      v-if="knowledgeBase?.can_write"
                      type="button"
                      @click="(onToggleDisabledClick(close, document), close())"
                    >
                      <IconClose :size="14" />
                      {{ document.disabled ? '恢复检索' : '停用检索' }}
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

                <!--
                  分段进度（§12.115）：**只在还没跑完的文档上出现**。
                  跑完的文档每段都是满的，画出来纯噪声；而"在列表上就能看到这篇
                  走到第几步了"正是当初的诉求。停滞/失败/重试的差别写在文字里，
                  颜色只负责加速识别（§8）。
                -->
                <div v-if="showsProgress(document.progress)" class="row-progress">
                  <MeterBar
                    class="row-progress-meter"
                    size="sm"
                    :segments="progressSegments(document.progress, { pulsing: needsPolling })"
                    :tone="progressTone(document.progress)"
                    :aria-label="progressCaption(document.progress)"
                  />
                  <span class="row-progress-text">{{ progressCaption(document.progress) }}</span>
                  <RouterLink
                    class="row-progress-more"
                    :to="{
                      path: route.path,
                      query: { ...documentLink(document.id), tab: 'progress' },
                    }"
                  >
                    处理明细
                  </RouterLink>
                </div>

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

              <!-- 补白行：把表格铺满可视区，文件少时不留一大片空白。
                   纯装饰（aria-hidden），不可点、也没有数据 -->
              <li
                v-for="row in fillerRows"
                :key="`filler-${row}`"
                class="doc-row-group doc-filler"
                aria-hidden="true"
              >
                <div class="doc-row panel-row" />
              </li>
            </ul>
          </div>

          <!-- 翻页条**放在面板之外并贴合视口底部**（sticky）：放进 .panel 里不行，
               那个类有 `overflow: hidden`，子元素没法粘到视口上。
               这样不管列表多长、也不管滚到哪，页码始终在屏幕内——
               用户不必"滚到最底下才知道还有几页"。 -->
          <!--
            **总数常显，只有翻页控件在单页时隐藏**（§12.116）。
            原先整个分页条挂在 `pageCount > 1` 上：一个库不到 20 篇时，"共 N 篇"也跟着
            消失了——而总数恰恰是用户扫列表时想知道的第一件事；它还会让"库间切换"
            时分页条忽有忽无，列表高度跟着跳一下。
          -->
          <div v-if="total > 0 || documents.length > 0" class="pager">
            <span class="pager-total">共 {{ total }} 篇</span>
            <div v-if="pageCount > 1" class="pager-controls">
              <AppButton
                size="sm"
                variant="subtle"
                :disabled="page <= 1"
                @click="goToPage(page - 1)"
              >
                <template #icon><IconChevronLeft :size="14" /></template>
                上一页
              </AppButton>
              <span class="pager-page tabular">第 {{ page }} / {{ pageCount }} 页</span>
              <AppButton
                size="sm"
                variant="subtle"
                :disabled="page >= pageCount"
                @click="goToPage(page + 1)"
              >
                <template #icon><IconChevronRight :size="14" /></template>
                下一页
              </AppButton>
            </div>
          </div>
        </template>
      </section>
    </div>

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

    <!--
      文档详情抽屉：从右侧滑出、盖在列表上，**列表本身一点不动**。
      `:key` 绑 id：换一份文档时重新播放一次入场动画，并把组件状态彻底重置
      （否则上一份的切块、预览会短暂留在新文档上）。
    -->
    <DocumentDrawer
      v-if="openDocumentId"
      :key="openDocumentId"
      :document-id="openDocumentId"
      :initial-tab="initialDrawerTab"
      @close="closeDocument"
    />
    <!-- 移动到目录（v13）。目录可能很多，所以用单选清单而不是"一行一个按钮" -->
    <AppModal v-model:open="moveOpen" title="移动到目录">
      <p class="move-lead">{{ moveLead }}</p>
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
    <ConfirmDialog
      v-model:open="deleteOpen"
      title="删除文档"
      :lead="`确定删除「${deleteTarget?.name}」？`"
      :note="
        impact?.restorable
          ? '原文会移入回收站保留 7 天，期间可以恢复。切块与向量会立即清除——删除后立刻搜不到。'
          : '此操作不可恢复。'
      "
      :busy="deleting"
      busy-label="删除中…"
      @confirm="confirmDelete"
    >
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
    </ConfirmDialog>

    <!-- 目录删除：非空时后端会拒绝，说明文案由确认弹窗带出 -->
    <ConfirmDialog
      v-model:open="folderDeleteOpen"
      title="删除目录"
      :lead="`删除目录「${folderDeleteTarget?.name}」？`"
      note="目录本身删除后不可恢复；目录里的文档不受影响（仍留在知识库中）。"
      :busy="folderDeleting"
      busy-label="删除中…"
      @confirm="confirmFolderDelete"
    />

    <!-- 批量删除：与单篇删除同一套形态 -->
    <ConfirmDialog
      v-model:open="batchDeleteOpen"
      title="删除文档"
      :lead="`删除选中的 ${selectedCount} 篇文档？`"
      note="原文会移入回收站保留 7 天；切块与向量立即清除，删除后立刻搜不到。"
      :busy="batchRunning"
      busy-label="删除中…"
      @confirm="runBatch('delete')"
    />

    <!-- 取消解析：不是删除——已产出的内容保留，之后可以重新摄入 -->
    <ConfirmDialog
      v-model:open="cancelParseOpen"
      title="取消解析"
      :lead="`取消「${cancelParseTarget?.name}」的解析？`"
      note="已解析出的内容会保留，之后可以重新摄入。"
      confirm-label="取消解析"
      busy-label="取消中…"
      :busy="canceling !== ''"
      @confirm="confirmCancelParse"
    />
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

/* 两栏：左侧目录树 + 右侧文档区。
   `align-items: stretch`（默认）让树**贯穿整个内容高度**——它是一条侧栏，
   不是浮在旁边的一个方块；WeKnora 的目录也是贯穿的。 */
.kb-body {
  display: flex;
  align-items: stretch;
  gap: var(--space-5);
}

/* 目录：无边框无底色的竖栏，只用一条右侧分隔线。 */
.folder-tree {
  flex: 0 0 200px;
  padding: 0 var(--space-4) 0 0;
  border-right: 1px solid var(--border-hairline);
}

.doc-area {
  flex: 1;
  min-width: 0;
}

/* 窄窗口**不把树折到上方**：折上去它就不是"贯穿的侧栏"了（用户明确要 WeKnora 那种）。
   代价是文档区变窄，所以这里牺牲"大小 / 更新时间"两列，保住主干：
   勾选、名称/状态、切块数、操作菜单。1200px 以上全列都在。 */
/*
 * 窄屏（<1200px）列优先级（§12.116）。
 *
 * 原先砍掉的是「大小 + 更新时间」，而「上传者」留着——那个取舍站不住：
 * 一份文件"什么时候传的/更新过"比"谁传的"有用得多（后者在详情抽屉里也有），
 * 而文件名被挤到只剩二十来个字、截断得看不清是什么文件。
 * 现在的顺序是：先让出**上传者**，再让出**大小**，保住文件名与更新时间。
 */
@media (max-width: 1200px) {
  .folder-tree {
    flex-basis: 180px;
  }

  .head-uploader,
  .row-uploader,
  .head-size,
  .row-size {
    display: none;
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
  gap: var(--space-pair);
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
  height: 30px;
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
  height: 30px;
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

/* ---- 工具栏（筛选 + 库级动作，同一行、都在列表上方）---- */

.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}

/* 动作组靠右；左侧的搜索/筛选吃掉剩余空间。
   行内所有控件都是 `--control-height`（32px），所以天然齐平 */
.toolbar-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin-left: auto;
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

/* 工具栏里的搜索框也走"扁平控件"那一档：与下拉、按钮同底、同圆角、无描边。
   否则一根描边输入框夹在一排无边框的控件中间会显得突兀 */
.toolbar .search-box :deep(.field) {
  background: var(--bg-subtle);
  border-color: transparent;
  border-radius: var(--radius-row);
}

.toolbar .search-box :deep(.field:hover:not(:disabled)) {
  background: var(--bg-hover);
}

/* 聚焦态与下拉一致：抬成纸面 + 品牌色细环，让"正在输入"看得出来 */
.toolbar .search-box :deep(.field:focus) {
  background: var(--bg-surface);
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
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

/* 勾选后浮出的批量动作条（全选在列表内的表头里） */
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

/* 跨页选择的那半句要弱于总数，别抢"已选 N 篇"的注意力 */
.batch-offpage {
  color: var(--text-tertiary);
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

/* 出题列：比"大小"窄一点——内容只有"N 题 / 未生成 / 生成中" */
.head-question {
  flex: 0 0 64px;
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

/* 空范围的那一行说明：标题说完，剩下的格式提示次要且可截断 */
.doc-empty-row {
  gap: var(--space-3);
}

.doc-empty-text {
  flex: 0 0 auto;
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
}

.doc-empty-hint {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 补白行：只负责占位与分隔线，不可交互 */
.doc-filler {
  pointer-events: none;
}

/* 翻页条：说明在左、控件在右，与文档行的左右分栏同一节奏。
   **粘在滚动容器（main.content）底部**：列表比一屏长时它一直浮在最下面，
   不透明底 + 顶边线，行从它下面滚过去不会透出来。
   `margin-top: -1px` 让静止时与面板的底边线叠成一条，不留双线。 */
.pager {
  position: sticky;
  bottom: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-top: -1px;
  padding: var(--space-2) var(--space-3);
  background: var(--bg-canvas);
  border: 1px solid var(--border-hairline);
  border-radius: 0 0 var(--radius-panel) var(--radius-panel);
  box-shadow: 0 -1px 0 var(--border-hairline);
}

.pager-total {
  font-size: var(--text-meta-size);
  color: var(--text-tertiary);
}

.pager-controls {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

/* 页码数字用等宽数字：翻页时"第 1 / 9 页"到"第 2 / 9 页"不该左右抖 */
.pager-page {
  min-width: 6.5em;
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
  text-align: center;
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
  min-width: 0;
  min-height: var(--hit-target);
  color: var(--text-primary);
}

/*
 * **省略号必须挂在"真正装着文本的那个元素"上**（v24 修，用户报的渲染异常）。
 *
 * `.row-name` 是 `inline-flex`（为了撑满行高、垂直居中），而 **flex 容器上的
 * `text-overflow: ellipsis` 不生效**：文件名一长就被直接裁断，连"…"都没有——
 * 截图里就是"文献表格/2.Greenness Surrounding Schools and Visual Impairment in
 * Chinese Children anc"这样硬切。仓库在 ChatView 的引用徽标上踩过同一个坑，
 * 这里是第二处，所以规则写得更显眼一点。
 *
 * 三个条件缺一不可：**块级容器 + overflow: hidden + min-width: 0**
 * （flex 项默认不收缩到内容宽度以下，不给 min-width 就永远省略不了）。
 */
.row-main .row-name-text {
  overflow: hidden;
  min-width: 0;
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

/* 出题列：有题时用次级文字色（是个有效信息），未生成时更淡（是个待办提示） */
.row-question {
  flex: 0 0 64px;
  overflow: hidden;
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-question.is-muted {
  color: var(--text-tertiary);
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

/*
 * 分段进度那一行（§12.115）。
 *
 * 左缩进与 `.row-error` / 子文件树一致（`--space-12`）：它是这一行的**附属信息**，
 * 与文档名左对齐会让它看起来像另一行数据。
 *
 * **只出现在没跑完的文档上**（见模板里的 `showsProgress`）：跑完的每段都是满的，
 * 画出来是噪声；而"每篇都多一行"正是上一轮被抱怨的"一屏看不了几篇"。
 */
.row-progress {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: 0 var(--space-3) var(--space-2) var(--space-12);
}

/* 条要装得下 6 段（每段才看得清），又不该把文字挤到折行 */
.row-progress-meter {
  flex: 0 1 220px;
  min-width: 120px;
}

.row-progress-text {
  min-width: 0;
  overflow: hidden;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* "处理明细"是这一行的附属动作（主动作是点文件名看正文），给足命中区（§8）
   但**不常驻强调色**：一屏几十行，每行一个蓝链接会把整页染成蓝色，
   而它只是"想知道为什么慢"时才点的东西。悬停时才亮起来。 */
.row-progress-more {
  flex: 0 0 auto;
  padding: var(--space-pair) var(--space-2);
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
  border-radius: var(--radius-control);
}

.row-progress-more:hover {
  color: var(--accent-text);
  background: var(--bg-hover);
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
