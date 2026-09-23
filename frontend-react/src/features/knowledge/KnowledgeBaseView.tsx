/**
 * 知识库详情页：文档列表（《前端设计规范》§6）——旧 `views/KnowledgeBaseView.vue` 逐条对齐。
 *
 * 形态：文档是"条目型"对象且会很多，用**列表**而不是卡片。
 * 每行 = 类型图标 + 名称 + 状态（文字 + 语义色）+ 时间；大文件可展开子文件树。
 *
 * 上传走"提交后轮询"：后端是异步流水线（架构 §4），界面必须能看见任务在动，
 * 否则用户会以为"点了没反应"。
 *
 * 与旧实现一致的三处关键约定：
 * - **抽屉的状态放 URL**（`?doc=`）：刷新、分享链接、后退都能回到同一个画面；
 * - **翻页不清空勾选**（跨页累计），界面上如实说明"另有 N 篇不在本页"；
 * - **删除前先给人看影响清单**："删除该文档"没人会有感觉，"412 个切块"才会让人停一下。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Download,
  Folder as FolderIcon,
  Inbox,
  Library,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Share2,
  Trash2,
  Upload,
  X,
} from 'lucide-react'

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
  setDocumentDisabled,
  DOCUMENT_PAGE_SIZE,
  type DataSourceKind,
  type DocumentBatchAction,
  type DocumentBatchResult,
  type DocumentListFilter,
  type DocumentPart,
  type DocumentStage,
  type DocumentSummary,
  type ImpactReport,
} from '@/api/documents'
import { createFolder, deleteFolder, listFolders, renameFolder, type Folder } from '@/api/folders'
import { DocumentDrawer } from '@/features/knowledge/DocumentDrawer'
import { KbSearchPanel } from '@/features/knowledge/KbSearchPanel'
import { KnowledgeBaseSettings } from '@/features/knowledge/KnowledgeBaseSettings'
import {
  Button,
  ConfirmDialog,
  IconButton,
  Input,
  MenuItem,
  MeterBar,
  Modal,
  RowMenu,
  Select,
  Skeleton,
  StatusTag,
} from '@/features/knowledge/primitives'
import { ShareDialog } from '@/features/knowledge/ShareDialog'
import { messageOf, notify, useKnowledgeBases, usePolling } from '@/features/knowledge/store'
import { useOperatorStore } from '@/lib/operator'
import { documentStageView, FILTER_STAGE_KEYS } from '@/features/knowledge/status'
import { UploadDialog } from '@/features/knowledge/UploadDialog'
import { MAX_UPLOAD_MB, UPLOAD_FORMAT_HINT } from '@/features/knowledge/uploadLimits'
import { formatBytes, formatMillis, formatRelativeTime } from '@/lib/format'

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
/** 目录筛选的三种取值：`''` 全部 / `ROOT` 未归档 / 其余是目录 id。 */
const ROOT_FILTER = '__root__'
/** 搜文件名是逐键触发的：不防抖就会每敲一个字发一次请求。 */
const SEARCH_DEBOUNCE_MS = 300
/** 与 CSS 的 `--row-height` 一致：补白行按它算，两处漂了就会算错行数。 */
const ROW_HEIGHT = 44

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

/** 列表行的悬浮提示：文件名 + 摘要（v25）。摘要不占列，但对"这篇是啥"很省事。 */
function rowTitle(document: DocumentSummary): string {
  const summary = document.summary?.trim()
  return summary ? `${document.name}\n\n${summary}` : document.name
}

export interface KnowledgeBaseViewProps {
  /** 不传则从路由参数取（`/kb/:kbId`）。 */
  kbId?: string
}

export function KnowledgeBaseView({ kbId: kbIdProp }: KnowledgeBaseViewProps) {
  const params = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const store = useKnowledgeBases()

  const kbId = kbIdProp ?? String(params.kbId ?? '')
  const knowledgeBase = store.byId(kbId)
  /**
   * 名册（G6）由壳负责加载；这里只读它决定**要不要**显示"谁传的"那一列——
   * 名册为空（没配名册、或鉴权开着而没人名）时不摆一列"未记录"。
   */
  const roster = useOperatorStore((state) => state.roster)

  const [documents, setDocuments] = useState<DocumentSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [searchDraft, setSearchDraft] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [stageFilter, setStageFilter] = useState('')
  const [sourceFilter, setSourceFilter] = useState('')
  const [activeFolder, setActiveFolder] = useState('')
  const [folders, setFolders] = useState<Folder[]>([])
  const [unfiledCount, setUnfiledCount] = useState<number | null>(null)
  const [treeOpen, setTreeOpen] = useState(true)
  const [selected, setSelected] = useState<string[]>([])
  const [expanded, setExpanded] = useState<Record<string, DocumentPart[] | undefined>>({})
  const [batchRunning, setBatchRunning] = useState(false)
  const [fillerRows, setFillerRows] = useState(0)
  const listPanel = useRef<HTMLDivElement | null>(null)

  const [searchOpen, setSearchOpen] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)

  const [folderFormOpen, setFolderFormOpen] = useState(false)
  const [folderEditingId, setFolderEditingId] = useState('')
  const [folderDraft, setFolderDraft] = useState('')
  const [folderSaving, setFolderSaving] = useState(false)
  const [folderDeleteTarget, setFolderDeleteTarget] = useState<Folder | null>(null)
  const [folderDeleting, setFolderDeleting] = useState(false)

  const [moveTarget, setMoveTarget] = useState<DocumentSummary | null>(null)
  const [moveBatchIds, setMoveBatchIds] = useState<string[]>([])
  const [moveChoice, setMoveChoice] = useState('')
  const [moving, setMoving] = useState(false)

  const [renameTarget, setRenameTarget] = useState<DocumentSummary | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [renaming, setRenaming] = useState(false)

  const [deleteTarget, setDeleteTarget] = useState<DocumentSummary | null>(null)
  const [deleteImpact, setDeleteImpact] = useState<ImpactReport | null>(null)
  const [deleting, setDeleting] = useState(false)

  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false)
  const [cancelTarget, setCancelTarget] = useState<DocumentSummary | null>(null)
  const [canceling, setCanceling] = useState('')

  /* ------------------------------------------------------------ 抽屉（状态在 URL） */

  const openDocumentId = searchParams.get('doc') ?? ''
  const tabParam = searchParams.get('tab') ?? ''
  const initialTab =
    tabParam === 'read' || tabParam === 'chunks' || tabParam === 'progress' ? tabParam : null
  const pageParam = Number(searchParams.get('page') ?? '') || null

  /** 打开一份文档：**去掉 `page` 与 `tab`**——它们只对"刚才点开的那一份"有意义。 */
  function documentLink(id: string): string {
    const next = new URLSearchParams(searchParams)
    next.delete('page')
    next.delete('tab')
    next.set('doc', id)
    return `${location.pathname}?${next.toString()}`
  }

  function closeDocument(): void {
    const next = new URLSearchParams(searchParams)
    next.delete('doc')
    next.delete('page')
    next.delete('tab')
    const query = next.toString()
    setSearchParams(query, { replace: true })
  }

  /* ------------------------------------------------------------ 列表加载 */

  const buildFilter = useCallback((): DocumentListFilter => {
    const filter: DocumentListFilter = {}
    if (activeFolder === ROOT_FILTER) filter.root = true
    else if (activeFolder) filter.folderId = activeFolder
    if (searchQuery) filter.q = searchQuery
    if (stageFilter) filter.stage = stageFilter as DocumentStage
    if (sourceFilter) filter.sourceKind = sourceFilter as DataSourceKind
    return filter
  }, [activeFolder, searchQuery, stageFilter, sourceFilter])

  const loadDocuments = useCallback(async () => {
    if (!kbId) return
    try {
      const list = await listDocuments(kbId, {
        ...buildFilter(),
        limit: DOCUMENT_PAGE_SIZE,
        offset: (page - 1) * DOCUMENT_PAGE_SIZE,
      })
      // 删除到某页空了（比如最后一页只剩 1 篇被删掉）就夹回最后一页再取，
      // 而不是给用户一个空列表——那看起来像"这个库没文档了"
      const pages = Math.max(1, Math.ceil(list.total / DOCUMENT_PAGE_SIZE))
      if (page > pages) {
        setPage(pages)
        setLoading(false)
        return
      }
      setDocuments(list.items)
      setTotal(list.total)
      setError('')
    } catch (cause) {
      setError(messageOf(cause, '文档列表加载失败'))
    } finally {
      setLoading(false)
    }
  }, [buildFilter, kbId, page])

  const loadFolders = useCallback(async () => {
    if (!kbId) return
    try {
      setFolders((await listFolders(kbId)).items)
    } catch {
      // 目录读不到不该挡住文档列表：退化成"还没有目录"
      setFolders([])
    }
  }, [kbId])

  /** 「未归档」计数：树上的数字要准，所以单独查一次根目录范围（`limit: 1` 只要那个 total）。 */
  const loadCounts = useCallback(async () => {
    if (!kbId) return
    try {
      setUnfiledCount((await listDocuments(kbId, { root: true, limit: 1 })).total)
    } catch {
      setUnfiledCount(null)
    }
  }, [kbId])

  const refreshAll = useCallback(async () => {
    await Promise.all([loadDocuments(), loadFolders(), loadCounts()])
  }, [loadDocuments, loadFolders, loadCounts])

  useEffect(() => {
    // 列表随筛选/页码变；`loadDocuments` 的依赖里带着这几项。
    // `loading` 只在**首次**那一轮让位给骨架屏（之后换筛选不该把整块列表换成骨架）
    if (documents.length === 0) setLoading(true)
    void loadDocuments()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadDocuments])

  useEffect(() => {
    void loadFolders()
    void loadCounts()
  }, [loadFolders, loadCounts])

  useEffect(() => {
    // 进页面时把库清单拉回来（标题与设置弹窗的"文档 N 篇"都要它）
    if (store.items.length === 0) void store.load()
    // 只做首屏这一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 换库时把上一库的现场清掉（同一个组件被复用，路由参数变了不会重新挂载）。 */
  useEffect(() => {
    setDocuments([])
    setActiveFolder('')
    setSearchDraft('')
    setSearchQuery('')
    setStageFilter('')
    setSourceFilter('')
    setSelected([])
    setExpanded({})
    setPage(1)
  }, [kbId])

  /** 搜文件名逐键触发，但**防抖**：中文输入还会带上拼音中间态。 */
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const next = searchDraft.trim()
      if (next === searchQuery) return
      setSearchQuery(next)
      setPage(1)
      setSelected([])
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [searchDraft, searchQuery])

  /* ------------------------------------------------------------ 表格补白 */

  /**
   * 表格的行数**不跟着文件数走**：只有两三个文件时如果只画两三行，下面就是一大片空白，
   * 页面看着像没加载完。补的是**空行**（带分隔线），而不是把面板拉高。
   */
  const syncFillerRows = useCallback(() => {
    const element = listPanel.current
    if (!element) return
    const head = element.querySelector<HTMLElement>('.panel-head')
    const headHeight = head?.offsetHeight ?? 36
    const bottomGap = 56
    const available = window.innerHeight - element.getBoundingClientRect().top - bottomGap
    const dataRows = Math.max(documents.length, 1)
    const fit = Math.ceil((available - headHeight) / ROW_HEIGHT)
    setFillerRows(Math.max(0, Math.min(fit - dataRows, 60)))
  }, [documents.length])

  useEffect(() => {
    syncFillerRows()
    window.addEventListener('resize', syncFillerRows)
    return () => window.removeEventListener('resize', syncFillerRows)
  }, [syncFillerRows])

  /* ------------------------------------------------------------ 轮询 */

  /** 当前页还有没有在跑的文档。按时间倒序时它们都在第 1 页，所以只看当前页不会漏信号。 */
  const hasActive = documents.some((item) => ACTIVE_STAGES.has(item.stage))
  /** 出题任务不改变文档阶段，`hasActive` 看不到它，必须单列（否则"点了没反应"）。 */
  const questionsPending = documents.some((item) => item.questions_pending)
  usePolling(loadDocuments, {
    active: hasActive || questionsPending,
    intervalMs: POLL_INTERVAL_MS,
    immediate: false,
  })

  /* ------------------------------------------------------------ 多选 */

  const selectedCount = selected.length
  const allSelected = documents.length > 0 && documents.every((item) => selected.includes(item.id))
  const pageSelectedCount = documents.filter((item) => selected.includes(item.id)).length
  const someSelected = !allSelected && pageSelectedCount > 0
  const offPageSelected = useMemo(() => {
    const onPage = new Set(documents.map((item) => item.id))
    return selected.filter((id) => !onPage.has(id)).length
  }, [documents, selected])

  function toggleSelect(id: string): void {
    setSelected((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    )
  }

  /**
   * 表头复选框：**只切换当前页**在选中集里的去留。
   * 连点几页的表头 = 跨页全选（当前页已全选时把这一页移出，其他页保留）。
   */
  function toggleSelectAll(): void {
    if (allSelected) {
      const onPage = new Set(documents.map((item) => item.id))
      setSelected((current) => current.filter((id) => !onPage.has(id)))
      return
    }
    const merged = new Set(selected)
    for (const item of documents) merged.add(item.id)
    setSelected([...merged])
  }

  function dropFromSelection(ids: readonly string[]): void {
    if (selected.length === 0) return
    const gone = new Set(ids)
    setSelected((current) => current.filter((id) => !gone.has(id)))
  }

  /* ------------------------------------------------------------ 批量的统一骨架 */

  /**
   * 跑一次批量动作并**按逐条结果报账**。
   *
   * 四个入口（删除/重建、出题、停用/恢复、移动）共用同一套骨架：守卫 → 置忙 → 调接口
   * → 刷新 → 按"全成 / 部分失败"两套口径报账 → 复位。**文案仍由调用方给**：
   * 措辞是产品口径（出题要说"已排队"、停用要说"的检索"），抽象不该把它吞掉。
   *
   * "部分失败"单独一条路：批量里"10 篇删掉 9 篇"是**正常结果**，后端也因此不 reject。
   */
  async function runBatchAction(
    action: DocumentBatchAction,
    options: {
      verb: string
      success?: (result: DocumentBatchResult) => string
      partial?: (result: DocumentBatchResult, firstError: string) => string
      ids?: string[]
      all?: boolean
      refresh?: 'all' | 'list'
      clearOnSuccess?: boolean
      keepFailed?: boolean
    },
  ): Promise<void> {
    const ids = options.ids ?? [...selected]
    if (ids.length === 0 || batchRunning) return
    setBatchRunning(true)
    try {
      const result = await batchDocuments(kbId, action, ids, null, options.all ?? false)
      if (options.refresh === 'list') {
        await loadDocuments()
      } else {
        await refreshAll()
        // 汇总（每库的文档数）也要跟着变：删/移之后侧栏与设置弹窗的数字不能停在旧值
        void store.refreshSummaries()
      }

      if (result.failed === 0) {
        if (options.clearOnSuccess) setSelected([])
        notify.success(options.success?.(result) ?? `已${options.verb} ${result.succeeded} 篇`)
        return
      }

      const firstError = result.items.find((item) => !item.ok)?.error ?? ''
      notify.error(
        options.partial?.(result, firstError) ??
          `${options.verb}：${result.succeeded} 篇成功、${result.failed} 篇失败` +
            (firstError ? `（${firstError}）` : ''),
      )
      if (options.keepFailed) {
        setSelected(result.items.filter((item) => !item.ok).map((item) => item.document_id))
      }
    } catch (cause) {
      notify.error(messageOf(cause, `批量${options.verb}失败`))
    } finally {
      setBatchRunning(false)
    }
  }

  async function runBatch(action: 'delete' | 'reprocess'): Promise<void> {
    setBatchDeleteOpen(false)
    await runBatchAction(action, {
      verb: action === 'delete' ? '删除' : '重新摄入',
      clearOnSuccess: true,
      keepFailed: true,
    })
  }

  /**
   * 批量补生成分段问题（v24）：**非破坏性、也不清空选择**——文档还在、还想再生成一次
   * 都可能。它是异步任务，所以立刻给一句"已完成会自动刷新"的预期。
   */
  async function runBatchQuestions(): Promise<void> {
    await runBatchAction('questions', {
      verb: '生成问题',
      refresh: 'list',
      success: (result) => `已排队为 ${result.succeeded} 篇生成问题，完成后列表会自动刷新`,
      partial: (result, firstError) =>
        `生成问题：${result.succeeded} 篇已排队、${result.failed} 篇未排队` +
        (firstError ? `（${firstError}）` : ''),
    })
  }

  async function runBatchToggleDisabled(action: 'enable' | 'disable'): Promise<void> {
    const verb = action === 'disable' ? '停用' : '恢复'
    await runBatchAction(action, {
      verb,
      success: (result) => `已${verb} ${result.succeeded} 篇的检索`,
    })
  }

  /* ------------------------------------------------------------ 单篇动作 */

  async function reprocess(document: DocumentSummary): Promise<void> {
    try {
      await reprocessDocument(document.id)
      notify.success(`已重新提交「${document.name}」`)
      await loadDocuments()
    } catch (cause) {
      notify.error(messageOf(cause, '重跑失败'))
    }
  }

  async function onToggleDisabled(document: DocumentSummary): Promise<void> {
    try {
      await setDocumentDisabled(document.id, !document.disabled)
      await loadDocuments()
      notify.success(document.disabled ? '已恢复检索' : '已停用检索：文档与内容都保留')
    } catch (cause) {
      notify.error(messageOf(cause, '操作失败'))
    }
  }

  async function onDownload(document: DocumentSummary): Promise<void> {
    try {
      await downloadDocument(document.id)
    } catch (cause) {
      notify.error(messageOf(cause, '下载失败'))
    }
  }

  async function confirmRename(): Promise<void> {
    const target = renameTarget
    if (!target || renaming) return
    const name = renameDraft.trim()
    if (!name) {
      notify.error('文件名不能为空')
      return
    }
    setRenaming(true)
    try {
      await renameDocument(target.id, name)
      setRenameTarget(null)
      await loadDocuments()
      notify.success('已重命名')
    } catch (cause) {
      notify.error(messageOf(cause, '重命名失败'))
    } finally {
      setRenaming(false)
    }
  }

  async function confirmCancelParse(): Promise<void> {
    const target = cancelTarget
    if (!target || canceling) return
    setCanceling(target.id)
    try {
      await cancelDocument(target.id)
      setCancelTarget(null)
      await loadDocuments()
      notify.success('已取消解析')
    } catch (cause) {
      notify.error(messageOf(cause, '取消失败'))
    } finally {
      setCanceling('')
    }
  }

  /** 从行内菜单点删除：先开弹窗（带上目标），再去取影响清单。 */
  function openDelete(document: DocumentSummary): void {
    setDeleteTarget(document)
    setDeleteImpact(null)
    void getDocumentImpact(document.id)
      .then(setDeleteImpact)
      // 拿不到清单不阻断删除：弹窗会停在"正在统计影响…"，用户仍能取消
      .catch(() => setDeleteImpact(null))
  }

  async function confirmDelete(): Promise<void> {
    const target = deleteTarget
    if (!target || deleting) return
    setDeleting(true)
    try {
      await deleteDocument(target.id)
      setDeleteTarget(null)
      // 跨页选择下要**主动**摘掉这一篇：列表刷新只换当前页的内容
      dropFromSelection([target.id])
      notify.success('已删除，原文在回收站保留 7 天')
      await refreshAll()
    } catch (cause) {
      notify.error(messageOf(cause, '删除失败'))
    } finally {
      setDeleting(false)
    }
  }

  async function confirmMove(): Promise<void> {
    if (moving) return
    setMoving(true)
    const folderId = moveChoice || null
    try {
      if (moveBatchIds.length > 0) {
        const result = await batchDocuments(kbId, 'move', [...moveBatchIds], folderId)
        setMoveBatchIds([])
        await refreshAll()
        if (result.failed === 0) {
          setSelected([])
          notify.success(`已移动 ${result.succeeded} 篇`)
        } else {
          const reason = result.items.find((item) => !item.ok)?.error ?? ''
          notify.error(
            `移动：${result.succeeded} 篇成功、${result.failed} 篇失败${reason ? `（${reason}）` : ''}`,
          )
          setSelected(result.items.filter((item) => !item.ok).map((item) => item.document_id))
        }
        return
      }
      const single = moveTarget
      if (!single) return
      await moveDocument(single.id, folderId)
      setMoveTarget(null)
      dropFromSelection([single.id])
      await refreshAll()
      notify.success('已移动')
    } catch (cause) {
      notify.error(messageOf(cause, '移动失败'))
    } finally {
      setMoving(false)
    }
  }

  async function toggleParts(document: DocumentSummary): Promise<void> {
    if (expanded[document.id]) {
      setExpanded((current) => ({ ...current, [document.id]: undefined }))
      return
    }
    try {
      const parts = (await listDocumentParts(document.id)).items
      setExpanded((current) => ({ ...current, [document.id]: parts }))
    } catch (cause) {
      notify.error(messageOf(cause, '子文件加载失败'))
    }
  }

  /* ------------------------------------------------------------ 目录 */

  function startCreateFolder(): void {
    setFolderEditingId('')
    setFolderDraft('')
    setFolderFormOpen(true)
  }

  function startRenameFolder(folder: Folder): void {
    setFolderEditingId(folder.id)
    setFolderDraft(folder.name)
    setFolderFormOpen(true)
  }

  async function submitFolder(): Promise<void> {
    const name = folderDraft.trim()
    if (!name) {
      notify.error('请输入目录名')
      return
    }
    setFolderSaving(true)
    try {
      if (folderEditingId) await renameFolder(folderEditingId, name)
      else await createFolder(kbId, name)
      setFolderFormOpen(false)
      setFolderEditingId('')
      setFolderDraft('')
      await loadFolders()
      notify.success('目录已保存')
    } catch (cause) {
      notify.error(messageOf(cause, '保存失败'))
    } finally {
      setFolderSaving(false)
    }
  }

  async function confirmFolderDelete(): Promise<void> {
    const folder = folderDeleteTarget
    if (!folder || folderDeleting) return
    setFolderDeleting(true)
    try {
      await deleteFolder(folder.id)
      setFolderDeleteTarget(null)
      // 正在看的目录被删了：回到「全部」，否则列表会停在一个不存在的筛选上
      if (activeFolder === folder.id) setActiveFolder('')
      await refreshAll()
      notify.success('目录已删除')
    } catch (cause) {
      // 目录非空时后端会拒绝，消息里带"还有 N 篇"——原样透给用户
      notify.error(messageOf(cause, '删除失败'))
    } finally {
      setFolderDeleting(false)
    }
  }

  /* ------------------------------------------------------------ 展示口径 */

  const hasFilter = Boolean(searchDraft.trim() || stageFilter || sourceFilter)
  /** 空状态文案随筛选范围变——"这个库还没有文档"在目录或搜索里看到会误导。 */
  const emptyTitle = hasFilter
    ? '没有符合条件的文档'
    : activeFolder === ROOT_FILTER
      ? '根目录下还没有文档'
      : activeFolder
        ? '这个目录里还没有文档'
        : '这个知识库里还没有文档'

  /** 上传目标目录：只有选中了具体目录时才带上（"全部/未归档"都算根目录）。 */
  const uploadFolderId = activeFolder && activeFolder !== ROOT_FILTER ? activeFolder : undefined
  const foldersTotal = folders.reduce((sum, folder) => sum + (folder.document_count ?? 0), 0)
  /** 拿不到未归档数时回 null（界面不显示数字）——显示一个错的数比不显示更糟。 */
  const totalCount = unfiledCount === null ? null : unfiledCount + foldersTotal
  const pageCount = Math.max(1, Math.ceil(total / DOCUMENT_PAGE_SIZE))

  /** 出题列文案：生成中 > 已出题条数 > 未生成 > 还没切块（出不了题）。 */
  function questionCell(document: DocumentSummary): string {
    if (document.questions_pending) return '生成中…'
    if (document.question_count > 0) return `${document.question_count} 题`
    if (document.chunk_count === 0) return '—'
    return '未生成'
  }

  function questionTitle(document: DocumentSummary): string {
    if (document.questions_pending) return '正在为这份文档的切块生成问题'
    if (document.question_count === 0) {
      return document.chunk_count === 0
        ? '还没有切块，无法出题'
        : '还没有为这份文档生成切块问题（选中后可点「生成问题」）'
    }
    return `${document.questioned_chunk_count}/${document.chunk_count} 段有问题，共 ${document.question_count} 条`
  }

  function goToPage(next: number): void {
    const clamped = Math.min(Math.max(1, next), pageCount)
    if (clamped === page) return
    setPage(clamped)
  }

  function onKbChanged(action: 'renamed' | 'deleted' | 'sources'): void {
    if (action === 'deleted') {
      void navigate('/knowledge-bases')
      return
    }
    if (action === 'sources') void refreshAll()
  }

  return (
    <div className="page-shell">
      <div className="kb-head-actions">
        <h1 style={{ flex: 1 }}>{knowledgeBase?.name ?? '知识库'}</h1>
        {/* 设置齿轮贴在标题右侧：它是"这个库本身"的入口，不是页面的动作 */}
        {knowledgeBase?.can_write ? (
          <KnowledgeBaseSettings kb={knowledgeBase} onChanged={onKbChanged} />
        ) : null}
      </div>

      {error ? <p className="kb-error-line">{error}</p> : null}

      {knowledgeBase && !knowledgeBase.can_write ? (
        <p className="kb-readonly-note">
          这是别人分享给你的库，你是只读权限：可以检索与查看，不能上传或删除。
        </p>
      ) : null}

      {/* 目录树：**贯穿整个内容高度的侧栏**，不是浮在旁边的一个方块 */}
      <div className="kb-body">
        {knowledgeBase ? (
          <aside className="kb-tree" aria-label="目录">
            <div className="kb-tree-head">
              <span>目录</span>
              {knowledgeBase.can_write ? (
                <IconButton icon={Plus} size={15} label="新建目录" onClick={startCreateFolder} />
              ) : null}
            </div>

            <ul className="kb-tree-list">
              <li>
                <div
                  className={['kb-tree-row', activeFolder === '' ? 'kb-tree-row-on' : '']
                    .filter(Boolean)
                    .join(' ')}
                >
                  <button
                    type="button"
                    className="kb-tree-caret"
                    aria-expanded={treeOpen}
                    aria-label={treeOpen ? '收起目录' : '展开目录'}
                    onClick={() => setTreeOpen((value) => !value)}
                  >
                    {treeOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                  <button
                    type="button"
                    className="kb-tree-node"
                    aria-current={activeFolder === '' ? 'true' : undefined}
                    onClick={() => setActiveFolder('')}
                  >
                    <Inbox size={14} />
                    <span className="kb-tree-label">全部文档</span>
                    {totalCount !== null ? (
                      <span className="kb-tree-count tabular">{totalCount}</span>
                    ) : null}
                  </button>
                </div>

                {treeOpen ? (
                  <ul className="kb-tree-children">
                    <li>
                      <div
                        className={[
                          'kb-tree-row',
                          activeFolder === ROOT_FILTER ? 'kb-tree-row-on' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                      >
                        {/* 占位：让未归档与目录项的文字起点对齐 */}
                        <span className="kb-tree-caret" aria-hidden="true" />
                        <button
                          type="button"
                          className="kb-tree-node"
                          aria-current={activeFolder === ROOT_FILTER ? 'true' : undefined}
                          onClick={() => setActiveFolder(ROOT_FILTER)}
                        >
                          <FolderIcon size={14} />
                          <span className="kb-tree-label">未归档</span>
                          {unfiledCount !== null ? (
                            <span className="kb-tree-count tabular">{unfiledCount}</span>
                          ) : null}
                        </button>
                      </div>
                    </li>

                    {folders.map((folder) => (
                      <li key={folder.id}>
                        <div
                          className={[
                            'kb-tree-row',
                            activeFolder === folder.id ? 'kb-tree-row-on' : '',
                          ]
                            .filter(Boolean)
                            .join(' ')}
                        >
                          <span className="kb-tree-caret" aria-hidden="true" />
                          <button
                            type="button"
                            className="kb-tree-node"
                            aria-current={activeFolder === folder.id ? 'true' : undefined}
                            title={folder.name}
                            onClick={() => setActiveFolder(folder.id)}
                          >
                            <FolderIcon size={14} />
                            <span className="kb-tree-label">{folder.name}</span>
                            <span className="kb-tree-count tabular">{folder.document_count}</span>
                          </button>
                          {knowledgeBase.can_write ? (
                            <RowMenu label={`${folder.name} 的操作`}>
                              {(close) => (
                                <>
                                  <MenuItem
                                    icon={Pencil}
                                    onClick={() => {
                                      startRenameFolder(folder)
                                      close()
                                    }}
                                  >
                                    重命名
                                  </MenuItem>
                                  <MenuItem
                                    icon={Trash2}
                                    danger
                                    onClick={() => {
                                      setFolderDeleteTarget(folder)
                                      close()
                                    }}
                                  >
                                    删除目录
                                  </MenuItem>
                                </>
                              )}
                            </RowMenu>
                          ) : null}
                        </div>
                      </li>
                    ))}

                    {folders.length === 0 ? <li className="kb-tree-empty">还没有目录</li> : null}
                  </ul>
                ) : null}
              </li>
            </ul>

            {/* 新建/重命名共用一个表单：靠 folderEditingId 区分两种模式 */}
            {folderFormOpen ? (
              <div className="kb-tree-form">
                <Input
                  value={folderDraft}
                  placeholder="目录名，例如：合同"
                  aria-label="目录名"
                  onChange={(event) => setFolderDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void submitFolder()
                  }}
                />
                <div className="kb-tree-form-actions">
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={folderSaving}
                    onClick={() => void submitFolder()}
                  >
                    {folderSaving ? '保存中…' : '保存'}
                  </Button>
                  <Button size="sm" onClick={() => setFolderFormOpen(false)}>
                    取消
                  </Button>
                </div>
              </div>
            ) : null}
          </aside>
        ) : null}

        <section className="kb-doc-area">
          {/* 工具栏：搜索/筛选与库级动作**同一行**，都在列表正上方 */}
          <div className="kb-toolbar">
            <div className="kb-search-box">
              <Search className="kb-search-icon" size={16} aria-hidden="true" />
              <Input
                value={searchDraft}
                placeholder="搜索文件名…"
                aria-label="搜索文件名"
                onChange={(event) => setSearchDraft(event.target.value)}
              />
            </div>
            <div className="kb-filter">
              <Select
                value={stageFilter}
                options={STAGE_FILTER_OPTIONS}
                aria-label="按状态筛选"
                onChange={(value) => {
                  setStageFilter(value)
                  setPage(1)
                  setSelected([])
                }}
              />
            </div>
            <div className="kb-filter">
              <Select
                value={sourceFilter}
                options={SOURCE_FILTER_OPTIONS}
                aria-label="按来源筛选"
                onChange={(value) => {
                  setSourceFilter(value)
                  setPage(1)
                  setSelected([])
                }}
              />
            </div>
            {hasFilter ? (
              <Button
                size="sm"
                variant="subtle"
                onClick={() => {
                  setSearchDraft('')
                  setSearchQuery('')
                  setStageFilter('')
                  setSourceFilter('')
                  setPage(1)
                  setSelected([])
                }}
              >
                清除筛选
              </Button>
            ) : null}

            <div className="kb-toolbar-actions">
              <Button
                variant="subtle"
                icon={Search}
                disabled={documents.length === 0}
                onClick={() => setSearchOpen(true)}
              >
                在此库检索
              </Button>
              {/* Wiki 入口只在库形态选了「向量检索 + Wiki」时出现 */}
              {knowledgeBase?.wiki_enabled ? (
                <Button
                  variant="subtle"
                  icon={Library}
                  onClick={() => void navigate(`/kb/${kbId}/wiki`)}
                >
                  Wiki
                </Button>
              ) : null}
              {/* 分享入口只对 owner / 管理员出现：can_manage 由后端算 */}
              {knowledgeBase?.can_manage ? (
                <Button variant="subtle" icon={Share2} onClick={() => setShareOpen(true)}>
                  分享
                </Button>
              ) : null}
              {/* 只读分享的成员看得到内容，但没有写入口 */}
              {knowledgeBase?.can_write ? (
                <Button variant="subtle" icon={Upload} onClick={() => setUploadOpen(true)}>
                  上传文档
                </Button>
              ) : null}
            </div>
          </div>

          {loading && documents.length === 0 ? <Skeleton variant="list" rows={4} /> : null}

          {!(loading && documents.length === 0) ? (
            <>
              {/* 勾选后浮出的批量动作条（全选在列表内的表头里，不在这里） */}
              {selectedCount > 0 ? (
                <div className="kb-batch">
                  <span className="kb-batch-count">
                    已选 {selectedCount} 篇
                    {/* 跨页选择必须说清楚：否则用户看到"已选 60 篇"而眼前只有 20 行 */}
                    {offPageSelected > 0 ? (
                      <span className="kb-batch-offpage">
                        （另有 {offPageSelected} 篇不在本页）
                      </span>
                    ) : null}
                  </span>
                  <Button
                    size="sm"
                    icon={FolderIcon}
                    disabled={batchRunning}
                    onClick={() => {
                      setMoveBatchIds([...selected])
                      // 默认落在"根目录"：批量选中的文档可能来自不同目录，没有共同的当前值
                      setMoveChoice(
                        activeFolder && activeFolder !== ROOT_FILTER ? activeFolder : '',
                      )
                    }}
                  >
                    移动到目录
                  </Button>
                  <Button
                    size="sm"
                    disabled={batchRunning}
                    onClick={() => void runBatchToggleDisabled('disable')}
                  >
                    停用检索
                  </Button>
                  <Button
                    size="sm"
                    disabled={batchRunning}
                    onClick={() => void runBatchToggleDisabled('enable')}
                  >
                    恢复检索
                  </Button>
                  <Button
                    size="sm"
                    icon={CircleHelp}
                    disabled={batchRunning}
                    onClick={() => void runBatchQuestions()}
                  >
                    生成问题
                  </Button>
                  <Button
                    size="sm"
                    icon={RefreshCw}
                    disabled={batchRunning}
                    onClick={() => void runBatch('reprocess')}
                  >
                    重新摄入
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    icon={Trash2}
                    disabled={batchRunning}
                    onClick={() => {
                      if (selectedCount === 0 || batchRunning) return
                      setBatchDeleteOpen(true)
                    }}
                  >
                    删除
                  </Button>
                  <Button size="sm" disabled={batchRunning} onClick={() => setSelected([])}>
                    取消选择
                  </Button>
                </div>
              ) : null}

              <div className="panel" ref={listPanel}>
                <div className="panel-head kb-doc-head">
                  {knowledgeBase?.can_write ? (
                    <span className="kb-col-check">
                      <input
                        className="kb-checkbox"
                        type="checkbox"
                        checked={allSelected}
                        aria-label={allSelected ? '取消选择本页' : '全选本页（可逐页累加）'}
                        onChange={toggleSelectAll}
                        ref={(node) => {
                          // 原生 indeterminate 只能走 DOM 属性（表头显示"半选"）
                          if (node) node.indeterminate = someSelected
                        }}
                      />
                    </span>
                  ) : null}
                  <span className="kb-col-file kb-head-file" aria-hidden="true">
                    文件
                  </span>
                  <span className="kb-col-chunks" aria-hidden="true">
                    切块
                  </span>
                  <span className="kb-col-questions" aria-hidden="true">
                    问题
                  </span>
                  <span className="kb-col-size" aria-hidden="true">
                    大小
                  </span>
                  <span className="kb-col-updated" aria-hidden="true">
                    更新时间
                  </span>
                  <span className="kb-col-menu" aria-hidden="true" />
                </div>

                <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                  {/* 空范围也照常给表头与数据区，只是第一行换成一句说明 */}
                  {documents.length === 0 ? (
                    <li className="kb-doc-group">
                      <div className="kb-doc-row panel-row kb-doc-empty">
                        <span className="kb-doc-empty-text">{emptyTitle}</span>
                        <span className="kb-doc-empty-hint">
                          {UPLOAD_FORMAT_HINT}；单文件上限 {MAX_UPLOAD_MB}MB。
                        </span>
                      </div>
                    </li>
                  ) : null}

                  {documents.map((document) => {
                    const stage = documentStageView(document.stage)
                    return (
                      <li key={document.id} className="kb-doc-group">
                        <div className="kb-doc-row panel-row">
                          {knowledgeBase?.can_write ? (
                            <span className="kb-col-check">
                              <input
                                className="kb-checkbox"
                                type="checkbox"
                                checked={selected.includes(document.id)}
                                aria-label={`选择 ${document.name}`}
                                onChange={() => toggleSelect(document.id)}
                              />
                            </span>
                          ) : null}

                          {document.is_split ? (
                            <button
                              type="button"
                              className="kb-col-caret"
                              aria-label={expanded[document.id] ? '收起子文件' : '展开子文件'}
                              aria-expanded={Boolean(expanded[document.id])}
                              onClick={() => void toggleParts(document)}
                            >
                              {expanded[document.id] ? (
                                <ChevronDown size={16} />
                              ) : (
                                <ChevronRight size={16} />
                              )}
                            </button>
                          ) : (
                            <span className="kb-col-caret" aria-hidden="true" />
                          )}

                          <span className="kb-col-file">
                            {/* 点文件名**留在本页**：把文档 id 写进查询参数，右侧滑出详情抽屉 */}
                            <Link
                              className="kb-row-name-link"
                              to={documentLink(document.id)}
                              title={rowTitle(document)}
                            >
                              <span className="kb-row-name-text">{document.name}</span>
                            </Link>
                            <StatusTag
                              label={stage.label}
                              tone={stage.tone}
                              running={ACTIVE_STAGES.has(document.stage)}
                              title={document.error ?? undefined}
                            />
                            {/* 停用：不参与检索但一切保留。中性色——它是"被搁置"，不是"出错" */}
                            {document.disabled ? <StatusTag label="已停用" tone="neutral" /> : null}
                            {/* 谁传的（G6）。没记到时显示"未记录"而不是留空——留空会让人以为是没渲染出来 */}
                            {roster.length > 0 ? (
                              <span className="kb-col-uploader">
                                {document.uploaded_by_name || '未记录'}
                              </span>
                            ) : null}
                          </span>

                          <span className="kb-col-chunks tabular">{document.chunk_count}</span>
                          <span
                            className={[
                              'kb-col-questions',
                              questionCell(document) === '未生成' ? 'kb-col-questions-muted' : '',
                            ]
                              .filter(Boolean)
                              .join(' ')}
                            title={questionTitle(document)}
                          >
                            {questionCell(document)}
                          </span>
                          <span className="kb-col-size">{formatBytes(document.size_bytes)}</span>
                          <span className="kb-col-updated">
                            {formatRelativeTime(document.updated_at)}
                          </span>

                          {/* 操作菜单对**所有能看这个库的人**开放：下载是只读动作 */}
                          <RowMenu label={`${document.name} 的操作`} className="kb-col-menu">
                            {(close) => (
                              <>
                                <MenuItem
                                  icon={Download}
                                  onClick={() => {
                                    close()
                                    void onDownload(document)
                                  }}
                                >
                                  下载
                                </MenuItem>
                                {knowledgeBase?.can_write ? (
                                  <>
                                    <MenuItem
                                      icon={Pencil}
                                      onClick={() => {
                                        close()
                                        setRenameTarget(document)
                                        setRenameDraft(document.name)
                                      }}
                                    >
                                      重命名
                                    </MenuItem>
                                    <MenuItem
                                      icon={FolderIcon}
                                      onClick={() => {
                                        close()
                                        setMoveTarget(document)
                                        // 默认落在它当前所在的位置：多数人是想改到别处
                                        setMoveChoice(document.folder_id ?? '')
                                      }}
                                    >
                                      移动到目录
                                    </MenuItem>
                                    <MenuItem
                                      icon={RefreshCw}
                                      onClick={() => {
                                        close()
                                        void reprocess(document)
                                      }}
                                    >
                                      重新摄入
                                    </MenuItem>
                                    {/* 补生成分段问题：只对已索引的文档有意义 */}
                                    {document.stage === 'indexed' ? (
                                      <MenuItem
                                        icon={CircleHelp}
                                        onClick={() => {
                                          close()
                                          void runBatchAction('questions', {
                                            ids: [document.id],
                                            verb: '生成问题',
                                            refresh: 'list',
                                            success: () => '已排队生成问题，完成后列表会自动刷新',
                                            partial: (_result, firstError) =>
                                              firstError || '生成问题失败',
                                          })
                                        }}
                                      >
                                        生成问题
                                      </MenuItem>
                                    ) : null}
                                    <MenuItem
                                      icon={X}
                                      onClick={() => {
                                        close()
                                        void onToggleDisabled(document)
                                      }}
                                    >
                                      {document.disabled ? '恢复检索' : '停用检索'}
                                    </MenuItem>
                                    {/* 取消只在真的还在跑时出现：对已完成的文档摆一个点了报错的按钮没有意义 */}
                                    {ACTIVE_STAGES.has(document.stage) ? (
                                      <MenuItem
                                        icon={X}
                                        disabled={canceling === document.id}
                                        onClick={() => {
                                          close()
                                          setCancelTarget(document)
                                        }}
                                      >
                                        {canceling === document.id ? '取消中…' : '取消解析'}
                                      </MenuItem>
                                    ) : null}
                                    <MenuItem
                                      icon={Trash2}
                                      danger
                                      onClick={() => {
                                        close()
                                        openDelete(document)
                                      }}
                                    >
                                      删除
                                    </MenuItem>
                                  </>
                                ) : null}
                              </>
                            )}
                          </RowMenu>
                        </div>

                        {document.error ? <p className="kb-doc-error">{document.error}</p> : null}

                        {/* 分段进度：**只在还没跑完的文档上出现**（跑完的每段都是满的，纯噪声） */}
                        {document.progress && document.progress.status !== 'done' ? (
                          <div className="kb-doc-progress">
                            <div className="kb-doc-progress-meter">
                              <MeterBar
                                size="sm"
                                segments={progressSegments(document, hasActive || questionsPending)}
                                tone={progressTone(document)}
                                ariaLabel={progressCaption(document)}
                              />
                            </div>
                            <span className="kb-doc-progress-text">
                              {progressCaption(document)}
                            </span>
                            <Link
                              className="kb-doc-progress-more"
                              to={`${documentLink(document.id)}&tab=progress`}
                            >
                              处理明细
                            </Link>
                          </div>
                        ) : null}

                        {expanded[document.id]?.length ? (
                          <ul className="kb-parts">
                            {expanded[document.id]?.map((part) => (
                              <li key={part.id} className="kb-part">
                                <span className="kb-part-name">分片 P{part.part_index + 1}</span>
                                <span>
                                  第 {part.page_start}–{part.page_end} 页
                                </span>
                                <StatusTag
                                  label={documentStageView(part.stage).label}
                                  tone={documentStageView(part.stage).tone}
                                />
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </li>
                    )
                  })}

                  {/* 补白行：把表格铺满可视区，文件少时不留一大片空白（纯装饰） */}
                  {Array.from({ length: fillerRows }, (_, index) => (
                    <li
                      key={`filler-${index}`}
                      className="kb-doc-group kb-doc-filler"
                      aria-hidden="true"
                    >
                      <div className="kb-doc-row panel-row" />
                    </li>
                  ))}
                </ul>
              </div>

              {/* 总数常显，只有翻页控件在单页时隐藏：总数恰恰是扫列表时想知道的第一个数 */}
              {total > 0 || documents.length > 0 ? (
                <div className="kb-pager">
                  <span>共 {total} 篇</span>
                  {pageCount > 1 ? (
                    <div className="kb-pager-controls">
                      <Button
                        size="sm"
                        variant="subtle"
                        icon={ChevronLeft}
                        disabled={page <= 1}
                        onClick={() => goToPage(page - 1)}
                      >
                        上一页
                      </Button>
                      <span className="kb-pager-page tabular">
                        第 {page} / {pageCount} 页
                      </span>
                      <Button
                        size="sm"
                        variant="subtle"
                        disabled={page >= pageCount}
                        onClick={() => goToPage(page + 1)}
                      >
                        下一页
                      </Button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}
        </section>
      </div>

      {knowledgeBase ? (
        <KbSearchPanel
          open={searchOpen}
          kbId={kbId}
          kbName={knowledgeBase.name}
          onClose={() => setSearchOpen(false)}
          onOpenDocument={(id) => {
            setSearchOpen(false)
            void navigate(documentLink(id))
          }}
        />
      ) : null}

      {/* 上传：**弹窗而不是"选完就传"**——批量上传的重复/失败必须留在屏幕上让人逐个处理 */}
      <UploadDialog
        open={uploadOpen}
        kbId={kbId}
        folderId={uploadFolderId}
        onClose={() => setUploadOpen(false)}
        onUploaded={() => {
          // 新文档按时间倒序排在第 1 页最前，所以传完先跳回第 1 页
          setPage(1)
          void refreshAll()
        }}
      />

      {/* 分享（v10）：私有是默认，想让别人看到就必须显式授出 */}
      {knowledgeBase ? (
        <ShareDialog
          open={shareOpen}
          kbId={kbId}
          kbName={knowledgeBase.name}
          onClose={() => setShareOpen(false)}
        />
      ) : null}

      {/* 文档详情抽屉：从右侧滑出、盖在列表上，**列表本身一点不动** */}
      {openDocumentId ? (
        <DocumentDrawer
          key={openDocumentId}
          documentId={openDocumentId}
          initialTab={initialTab}
          page={pageParam}
          onClose={closeDocument}
        />
      ) : null}

      {/* 移动到目录：单篇与批量共用（目录清单、选中逻辑、提示文案都一样） */}
      <Modal
        open={moveTarget !== null || moveBatchIds.length > 0}
        title="移动到目录"
        onClose={() => {
          setMoveTarget(null)
          setMoveBatchIds([])
        }}
        footer={
          <>
            <Button
              onClick={() => {
                setMoveTarget(null)
                setMoveBatchIds([])
              }}
            >
              取消
            </Button>
            <Button variant="primary" disabled={moving} onClick={() => void confirmMove()}>
              {moving ? '移动中…' : '移动'}
            </Button>
          </>
        }
      >
        <p className="kb-lead">
          {moveBatchIds.length > 0
            ? `把选中的 ${moveBatchIds.length} 篇移到：`
            : `把「${moveTarget?.name ?? ''}」移到：`}
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
          <label className="kb-switch">
            <input
              type="radio"
              name="move-target"
              value=""
              checked={moveChoice === ''}
              onChange={() => setMoveChoice('')}
              style={{ accentColor: 'var(--text-secondary)' }}
            />
            <span>根目录（未归档）</span>
          </label>
          {folders.map((folder) => (
            <label key={folder.id} className="kb-switch">
              <input
                type="radio"
                name="move-target"
                value={folder.id}
                checked={moveChoice === folder.id}
                onChange={() => setMoveChoice(folder.id)}
                style={{ accentColor: 'var(--text-secondary)' }}
              />
              <span>{folder.name}</span>
            </label>
          ))}
        </div>
        {folders.length === 0 ? (
          <p className="text-hint">还没有目录。先关掉这里，用左侧目录树右上角的「+」建一个。</p>
        ) : null}
      </Modal>

      {/* 重命名：只改显示名，不重跑解析 */}
      <Modal
        open={renameTarget !== null}
        title="重命名文档"
        onClose={() => setRenameTarget(null)}
        footer={
          <>
            <Button onClick={() => setRenameTarget(null)}>取消</Button>
            <Button variant="primary" disabled={renaming} onClick={() => void confirmRename()}>
              {renaming ? '保存中…' : '保存'}
            </Button>
          </>
        }
      >
        <p className="kb-lead">给「{renameTarget?.name ?? ''}」换一个名字：</p>
        <Input
          value={renameDraft}
          placeholder="文件名"
          aria-label="文件名"
          onChange={(event) => setRenameDraft(event.target.value)}
        />
      </Modal>

      {/* 删除确认：**先给人看影响清单再动手** */}
      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除文档"
        lead={`确定删除「${deleteTarget?.name ?? ''}」？`}
        note={
          deleteImpact?.restorable
            ? '原文进回收站保留 7 天，其间可恢复；切块与向量立即清除，删掉就搜不到。'
            : '此操作不可恢复。'
        }
        busy={deleting}
        busyLabel="删除中…"
        onConfirm={() => void confirmDelete()}
        onClose={() => setDeleteTarget(null)}
      >
        {deleteImpact === null ? (
          <p className="text-note">正在统计影响…</p>
        ) : (
          <dl className="kb-impact">
            <div>
              <dt>切块</dt>
              <dd className="tabular">{deleteImpact.chunks}</dd>
            </div>
            <div>
              <dt>占用的空间</dt>
              <dd className="tabular">{formatBytes(deleteImpact.size_bytes)}</dd>
            </div>
            <div>
              <dt>进行中的任务</dt>
              <dd className="tabular">{deleteImpact.running_tasks}</dd>
            </div>
          </dl>
        )}
      </ConfirmDialog>

      {/* 目录删除：非空时后端会拒绝，说明文案由确认弹窗带出 */}
      <ConfirmDialog
        open={folderDeleteTarget !== null}
        title="删除目录"
        lead={`删除目录「${folderDeleteTarget?.name ?? ''}」？`}
        note="目录本身删除后不可恢复；目录里的文档不受影响（仍留在知识库中）。"
        busy={folderDeleting}
        busyLabel="删除中…"
        onConfirm={() => void confirmFolderDelete()}
        onClose={() => setFolderDeleteTarget(null)}
      />

      <ConfirmDialog
        open={batchDeleteOpen}
        title="删除文档"
        lead={`删除选中的 ${selectedCount} 篇文档？`}
        note="原文会移入回收站保留 7 天；切块与向量立即清除，删除后立刻搜不到。"
        busy={batchRunning}
        busyLabel="删除中…"
        onConfirm={() => void runBatch('delete')}
        onClose={() => setBatchDeleteOpen(false)}
      />

      {/* 取消解析：不是删除——已产出的内容保留，之后可以重新摄入 */}
      <ConfirmDialog
        open={cancelTarget !== null}
        title="取消解析"
        lead={`取消「${cancelTarget?.name ?? ''}」的解析？`}
        note="已解析出的内容会保留，之后可以重新摄入。"
        confirmLabel="取消解析"
        busyLabel="取消中…"
        busy={canceling !== ''}
        onConfirm={() => void confirmCancelParse()}
        onClose={() => setCancelTarget(null)}
      />
    </div>
  )
}

/** 清单是否还没拉过（空数组 = 该拉一次）。 */ /* ------------------------------------------------------------------ 进度口径 */

/** 把列表行上的进度折成进度条的分段（与旧 `useProgress.ts` 同一口径）。 */
function progressSegments(document: DocumentSummary, pulsing: boolean) {
  const progress = document.progress
  if (!progress) return []
  return Array.from({ length: progress.step_total }, (_, index) => {
    const position = index + 1
    if (position < progress.step_index) return { fill: 1, tone: 'accent' as const }
    if (position === progress.step_index) {
      return {
        fill: 1,
        tone: progressTone(document),
        pulsing: pulsing || progress.status === 'running',
      }
    }
    return { fill: 0, tone: 'neutral' as const }
  })
}

function progressTone(document: DocumentSummary) {
  const progress = document.progress
  if (!progress) return 'accent' as const
  if (progress.stalled) return 'danger' as const
  if (progress.status === 'failed') return 'danger' as const
  if (progress.status === 'canceled') return 'neutral' as const
  if (progress.status === 'done') return 'success' as const
  return 'info' as const
}

/** 那一行文字：`第 3/6 步 · 解析内容 · 已用 2 分 14 秒`（失败/停滞各自缀一句）。 */
function progressCaption(document: DocumentSummary): string {
  const progress = document.progress
  if (!progress) return ''
  const head = `第 ${progress.step_index}/${progress.step_total} 步 · ${progress.step_label}`
  if (progress.status === 'done') return `${head} · 共 ${formatMillis(progress.total_ms)}`
  const elapsed = `已用 ${formatMillis(progress.elapsed_ms)}`
  if (progress.stalled) return `${head} · ${elapsed} · 疑似卡住（没有 worker 在处理）`
  if (progress.status === 'failed') {
    return `${head} · 失败于这一步（已用 ${formatMillis(progress.elapsed_ms)}）`
  }
  if (progress.status === 'canceled') return `${head} · 已取消`
  if (progress.retries > 0) return `${head} · ${elapsed} · 重试 ${progress.retries} 次`
  return `${head} · ${elapsed}`
}
