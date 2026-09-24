/**
 * 笔记页：左侧时间线列表 + 右侧编辑器（《笔记功能调研》§3.5）。
 *
 * 版式对齐 ima 笔记：列表是**扁平分组**（置顶 / 今天 / 过去 7 天 / 过去 30 天 / 更早），
 * 不是一叠带边框的卡片；编辑器无卡片边框，工具栏在最上、标题在文档里、正文走窄栏。
 * 信息架构仍收敛在一个视图内（列表 → 编辑都在本页），侧栏只多一个入口。
 *
 * 保存：`content_md`/标题/标签/置顶变化后**防抖自动保存**（800ms），
 * 同时保留 Ctrl/Cmd+S；切换笔记前先落盘（只发不等，见 `flush`）。
 *
 * 与旧 Vue 版（`frontend/src/views/NotesView.vue`）的逐条对应写在各自函数上；
 * 三处**有意差异**都在 `notes.css` 或下方注释里标明，摘要：
 * 1. 列表折叠用 `useState` + localStorage（旧版是页面级 ref，同一口径）；
 * 2. 保存状态机的"抑制装载"改由**指纹比对**承担（旧版是一个 `hydrating` 布尔 + nextTick，
 *    React 里没有 nextTick，而指纹比对本就是 `saveDraft` 的判据，两层合一）；
 * 3. 两处确认与「加入知识库」弹窗用 `@/ui/dialog` + `@/ui/button`（shadcn 原语），
 *    选库仍是平台的原生 `<select>`——它天生键盘可达，而 Radix Select 在 jsdom 里
 *    要额外补指针捕获 API（`tests/setup.ts` 没有），为两个选项不值当。
 */
import { useQueryClient } from '@tanstack/react-query'
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FolderInput,
  Library,
  ListTree,
  Pin,
  Plus,
  Search,
  Trash,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'

import type { NoteAiAction, NoteFolder, NoteListItem } from '@/api/notes'
import { formatCount } from '@/lib/format'
import { Button } from '@/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/ui/dialog'
import { Input } from '@/ui/input'

import { NoteEditor, type NoteEditorHandle } from './NoteEditor'
import type { NoteTocItem } from './NoteCanvas'
import { NoteFolderTree } from './FolderTree'
import { descendantIds, folderOptions, folderPath, subtreeStats } from './folders'
import {
  useAiTransform,
  useAttachNote,
  useCreateNote,
  useCreateNoteFolder,
  useDeleteNote,
  useDeleteNoteFolder,
  useKnowledgeBaseOptions,
  useMoveNote,
  useMoveNoteFolder,
  useNoteFolders,
  useNoteTags,
  useNotesList,
  useRenameNoteFolder,
  useSaveNote,
} from './queries'
import {
  cachedBody,
  fetchBody,
  formatSavedAt,
  groupNotes,
  latestNoteId,
  prefetchBody,
  readListCollapsed,
  readTagsCollapsed,
  rememberBody,
  shortDate,
  snapshotOf,
  tagKindOf,
  UNFILED_FOLDER,
  useNotesStore,
  writeListCollapsed,
  writeTagsCollapsed,
  type NoteBody,
  type TagKind,
} from './store'
import './notes.css'

/**
 * 切换时"压暗旧内容"的启动延迟。
 *
 * 比这更快到货的切换（命中缓存、局域网快往返）**完全不压暗**——
 * 快路径不该被动画拖慢，看起来就该是瞬移；只有真的在等网络时才给一个过渡，
 * 让这段时间有交代，而不是画面僵住再硬切。
 */
const SWITCH_DIM_DELAY_MS = 120

/**
 * 列表出来之后，趁空闲把**最靠前的几条**正文先取回来。
 *
 * 用户最先点的通常就是列表头部这几条（刚写过、刚看过），提前取好，
 * 就算他没悬停、直接点，切换也不必等一个往返。只取前几条是刻意的：
 * 整表预取会在打开页面时打出一串请求，得不偿失。
 */
const PREFETCH_TOP_N = 6

/** 自动保存的防抖窗口（旧实现同一个数）。 */
const AUTOSAVE_DELAY_MS = 800

/** 搜索输入的防抖窗口（旧实现同一个数）。 */
const SEARCH_DEBOUNCE_MS = 300

/** 页面只关心这些字段：缓存里的正文、服务端详情、草稿都满足这个形状。 */
type Draft = NoteBody

/**
 * 文件夹的建/改名共用一个表单（与知识库目录那边同一套）。
 *
 * `parentId` 只在"新建"时有意义：它是这颗新文件夹会落在哪一层——
 * "建子文件夹"与"建根级文件夹"因此是同一个对话框的两次调用。
 */
interface FolderForm {
  mode: 'create' | 'rename'
  /** 改名时的目标；新建时为空。 */
  folderId?: string
  parentId: string | null
  name: string
}

/**
 * 标签云的三组（界面评审 N4）。顺序即语义顺序：**先时间、再来源、最后状态**——
 * 时间最像"这批笔记的坐标"，来源是主体，状态是补充。
 */
const TAG_GROUPS: { kind: TagKind; label: string }[] = [
  { kind: 'time', label: '时间' },
  { kind: 'source', label: '来源' },
  { kind: 'status', label: '状态' },
]

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback
}

export function NotesView() {
  const params = useParams<{ noteId?: string }>()
  const routeNoteId = params.noteId ?? ''
  const navigate = useNavigate()
  const client = useQueryClient()

  const query = useNotesStore((state) => state.query)
  const activeTag = useNotesStore((state) => state.activeTag)
  const activeFolder = useNotesStore((state) => state.activeFolder)
  const setFilter = useNotesStore((state) => state.setFilter)
  const setFolder = useNotesStore((state) => state.setFolder)

  const listQuery = useNotesList({ q: query, tag: activeTag, folder: activeFolder })
  const tagsQuery = useNoteTags()
  const foldersQuery = useNoteFolders()
  const kbQuery = useKnowledgeBaseOptions()

  const createMutation = useCreateNote()
  const saveMutation = useSaveNote()
  const deleteMutation = useDeleteNote()
  const attachMutation = useAttachNote()
  const aiMutation = useAiTransform()
  const moveNoteMutation = useMoveNote()
  const createFolderMutation = useCreateNoteFolder()
  const renameFolderMutation = useRenameNoteFolder()
  const moveFolderMutation = useMoveNoteFolder()
  const deleteFolderMutation = useDeleteNoteFolder()

  // 列表项与标签都从查询结果里派生：包一层 useMemo 是为了让它们有**稳定的身份**，
  // 否则下面那两个 effect 的依赖每次渲染都在变（`?? []` 每次都造一个新数组）
  const items = useMemo(() => listQuery.data?.items ?? [], [listQuery.data])
  const tags = useMemo(() => tagsQuery.data ?? [], [tagsQuery.data])
  const folders = useMemo(() => foldersQuery.data?.items ?? [], [foldersQuery.data])
  const kbOptions = useMemo(
    () => (kbQuery.data ?? []).map((kb) => ({ value: kb.id, label: kb.name })),
    [kbQuery.data],
  )

  const [draft, setDraft] = useState<Draft | null>(null)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [savedAt, setSavedAt] = useState<Date | null>(null)
  const [searchInput, setSearchInput] = useState(() => useNotesStore.getState().query)
  const [tagDraft, setTagDraft] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const [attachOpen, setAttachOpen] = useState(false)
  const [attachKb, setAttachKb] = useState('')
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [switching, setSwitching] = useState(false)
  /** 文件夹的建/改名对话框（两种模式共用一个表单，与知识库目录那边同款）。 */
  const [folderForm, setFolderForm] = useState<FolderForm | null>(null)
  const [folderSaving, setFolderSaving] = useState(false)
  /** 待确认删除的文件夹（确认框里要把它会带走的东西说清楚）。 */
  const [folderDelete, setFolderDelete] = useState<NoteFolder | null>(null)

  /**
   * 列表折叠（本机偏好）。
   *
   * 与侧栏折叠同一类东西——**"这台机器怎么显示"**，所以落 `localStorage`，
   * 不进后端设置；换台机器该重新选。初值就来自存储：**刷新之后保持折叠**，
   * 而不是先展开再收起来（那会闪一下）。
   */
  const [listCollapsed, setListCollapsed] = useState(() => readListCollapsed())

  /**
   * 标签区折叠（本机偏好）。
   *
   * 与列表折叠同一类东西、同一套写法（`readListCollapsed` 那一对的口径），
   * **但默认值相反**：标签区默认折叠——它是"次要的筛选项"，标签一多就长得比笔记列表
   * 还高（实测三组 7 个 chip 占 150.1px，左栏总共才 856px）。
   */
  const [tagsCollapsed, setTagsCollapsed] = useState(() => readTagsCollapsed())

  /**
   * 目录（正文大纲）。
   *
   * 默认展开：它就是用户点名要的那件东西，藏起来等于每次都要多点一下。
   * 关掉之后整栏从布局里退出（`.notes-layout` 的第三列也一并去掉），
   * 正文列回到 780px 的宽度上限。
   */
  const [tocOpen, setTocOpen] = useState(true)
  const [tocItems, setTocItems] = useState<NoteTocItem[]>([])

  const editorRef = useRef<NoteEditorHandle | null>(null)
  const routeNoteIdRef = useRef(routeNoteId)
  const itemsRef = useRef<NoteListItem[]>(items)
  const draftRef = useRef<Draft | null>(draft)
  const savedSnapshotRef = useRef('')
  const switchTokenRef = useRef(0)
  const warmTokenRef = useRef(0)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const switchDimTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const prefetchedRef = useRef(false)

  // 渲染期刷新"最新值"快照：异步回调与定时器读它们，就不必把整个组件塞进依赖数组
  routeNoteIdRef.current = routeNoteId
  itemsRef.current = items
  draftRef.current = draft

  function applyNote(note: Draft): void {
    const next: Draft = {
      id: note.id,
      title: note.title,
      content_md: note.content_md,
      tags: [...note.tags],
      pinned: note.pinned,
      kb_id: note.kb_id,
      doc_id: note.doc_id,
      folder_id: note.folder_id ?? null,
      updated_at: note.updated_at,
    }
    setDraft(next)
    setTagDraft('')
    // 状态直接落到"已保存 <这条笔记的上次保存时间>"，而不是先清空再等下一次保存：
    // 清空会让标签在切换时闪一下再消失，而库里本来就存着这个时间，照实显示即可。
    setSaveState('saved')
    setSavedAt(note.updated_at ? new Date(note.updated_at) : null)
    savedSnapshotRef.current = snapshotOf(next)
  }

  function beginSwitchWait(token: number): void {
    if (switchDimTimerRef.current) clearTimeout(switchDimTimerRef.current)
    switchDimTimerRef.current = setTimeout(() => {
      if (token === switchTokenRef.current) setSwitching(true)
    }, SWITCH_DIM_DELAY_MS)
  }

  function endSwitchWait(token: number): void {
    if (token !== switchTokenRef.current) return
    if (switchDimTimerRef.current) {
      clearTimeout(switchDimTimerRef.current)
      switchDimTimerRef.current = undefined
    }
    setSwitching(false)
  }

  /**
   * 落盘一份草稿快照。
   *
   * 注意它接收的是**快照对象**而不是读当前 draft：切换笔记时的保存是"不等结果"的，
   * 等响应回来时 draft 早就换成下一条了——如果那时才去读，就会把下一条的内容
   * 写进上一条。没改动（指纹一致）直接返回：不发请求、也不动保存标签。
   */
  async function saveDraft(item: Draft, options: { silent?: boolean } = {}): Promise<void> {
    const snap = snapshotOf(item)
    if (snap === savedSnapshotRef.current) return
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = undefined
    }
    if (!options.silent) setSaveState('saving')
    try {
      const updated = await saveMutation.mutateAsync({
        noteId: item.id,
        payload: {
          title: item.title,
          content_md: item.content_md,
          pinned: item.pinned,
          tags: item.tags,
        },
      })
      // 只有它还是当前笔记时才碰界面状态；离开的笔记的响应不许改新笔记的标签
      if (draftRef.current?.id === item.id) {
        setDraft((prev) =>
          prev && prev.id === item.id
            ? {
                ...prev,
                kb_id: updated.kb_id,
                doc_id: updated.doc_id,
                updated_at: updated.updated_at,
              }
            : prev,
        )
        // 指纹只推进到**这次真正发出去的那份**：请求期间用户又敲的字仍算未保存，
        // 会被防抖保存接着写出去，不会被误判成已保存。
        savedSnapshotRef.current = snap
        if (!options.silent) {
          setSavedAt(new Date())
          setSaveState('saved')
        }
      }
    } catch (cause) {
      if (draftRef.current?.id === item.id && !options.silent) setSaveState('error')
      toast.error(errorText(cause, '保存失败'))
    }
  }

  /** 保存当前笔记（Ctrl/Cmd+S、AI、入库前的落盘）。 */
  async function saveNow(options: { silent?: boolean } = {}): Promise<void> {
    const item = draftRef.current
    if (!item) return
    await saveDraft(item, options)
  }

  /**
   * 离开一条笔记前把它落盘——**只发不等**。
   *
   * 新笔记的读取与旧笔记的写入彼此独立，串起来只是让用户多等一个往返。
   * 顺带清掉防抖定时器：留着它会在 800ms 后用**新笔记**的草稿去触发保存。
   */
  function flush(item: Draft): void {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = undefined
    }
    if (snapshotOf(item) === savedSnapshotRef.current) return
    void saveDraft(item, { silent: true })
  }

  /**
   * 没有指定笔记时，**默认打开最新的一条**（与「对话」入口同一套语义：
   * 既然已经有「新建」按钮，入口就该回到上次写的那条，而不是停在一个空页面）。
   *
   * 等待列表期间用户可能已经点了某条（或点了新建）——那就不许再改路径，
   * 否则会把刚打开的那条顶掉。
   */
  async function openLatest(): Promise<void> {
    let current = itemsRef.current
    if (!current.length) {
      const result = await listQuery.refetch()
      current = result.data?.items ?? []
    }
    if (routeNoteIdRef.current) return
    const latest = latestNoteId(current)
    if (latest) {
      await navigate(`/notes/${latest}`, { replace: true })
      return
    }
    setDraft(null) // 一条都没有：显示空态，让用户去点「新建」
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
    const token = ++switchTokenRef.current
    const id = routeNoteIdRef.current
    if (!id) {
      endSwitchWait(token)
      await openLatest()
      return
    }
    if (draftRef.current?.id === id) {
      endSwitchWait(token)
      return
    }
    const leaving = draftRef.current
    if (leaving) {
      rememberBody(client, leaving)
      flush(leaving)
    }
    const cached = cachedBody(client, id)
    if (cached) {
      applyNote(cached)
      endSwitchWait(token)
      return
    }
    beginSwitchWait(token)
    try {
      const note = await fetchBody(client, id)
      // 取回来的路上用户可能又切走了：别把旧请求的结果盖到新笔记上
      if (token !== switchTokenRef.current) return
      applyNote(note)
    } catch (cause) {
      if (token !== switchTokenRef.current) return
      toast.error(errorText(cause, '笔记加载失败'))
      setDraft(null)
    } finally {
      endSwitchWait(token)
    }
  }

  /**
   * 鼠标移到列表项上时：先取正文，取到后**在空闲时间把它预先解析成文档**。
   *
   * 从 hover 到点击通常有百来毫秒，够这两件事都不落在点击路径上——
   * 于是切换只剩一次 state 替换，大笔记也不会在点击后卡一下。
   * 只保留最后一次悬停的预热（连扫多行不会排一队解析）。
   */
  function scheduleWarm(markdown: string): void {
    const token = ++warmTokenRef.current
    const run = (): void => {
      if (token === warmTokenRef.current) editorRef.current?.warm(markdown)
    }
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 300 })
    else setTimeout(run, 0)
  }

  function onNoteHover(noteId: string): void {
    void prefetchBody(client, noteId).then((note) => {
      if (note) scheduleWarm(note.content_md)
    })
  }

  // 路由一变就切笔记（旧版是 watch route.params.noteId，immediate）
  useEffect(() => {
    void loadFromRoute()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeNoteId])

  /**
   * 防抖自动保存。
   *
   * 指纹与"已落盘的那份"一致时直接跳过——**装载一条笔记不算"用户改了字"**，
   * 旧版为此专门养了一个 `hydrating` 布尔并等 nextTick 解除；React 里没有 nextTick，
   * 而指纹比对本来就是 `saveDraft` 的第一道判据，两层合一之后行为不变：
   * 装载不会发请求，也不会有"保存中…"闪一下。
   *
   * 刻意不把状态退回 idle：那会让"已保存 12:30"在每次敲字时先消失、800ms 后再出现。
   */
  useEffect(() => {
    if (!draft) return
    if (snapshotOf(draft) === savedSnapshotRef.current) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => void saveNow(), AUTOSAVE_DELAY_MS)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft])

  // 搜索输入：防抖 300ms 再落到过滤条件上（列表键跟着变，react-query 自动回源）
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(
      () => setFilter(searchInput.trim(), useNotesStore.getState().activeTag),
      SEARCH_DEBOUNCE_MS,
    )
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    }
  }, [searchInput, setFilter])

  // 列表一到就趁空闲预取头几条的正文（只做一次：整表预取会在打开页面时打出一串请求）
  useEffect(() => {
    if (prefetchedRef.current || !items.length) return
    prefetchedRef.current = true
    const ids = items.slice(0, PREFETCH_TOP_N).map((item) => item.id)
    const run = (): void => {
      for (const id of ids) void prefetchBody(client, id)
    }
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 800 })
    else setTimeout(run, 0)
  }, [items, client])

  useEffect(() => {
    const onKeydown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void saveNow()
      }
    }
    window.addEventListener('keydown', onKeydown)
    return () => {
      window.removeEventListener('keydown', onKeydown)
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
      if (switchDimTimerRef.current) clearTimeout(switchDimTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 标签是"顺手贴的分类"：空格/逗号/回车都能提交，最多 8 个、单个 24 字。 */
  function commitTag(): void {
    const parts = tagDraft
      .split(/[\s,，、]+/)
      .map((part) => part.trim())
      .filter(Boolean)
    if (parts.length) {
      setDraft((prev) => {
        if (!prev) return prev
        const next = [...prev.tags]
        for (const part of parts) {
          const tag = part.slice(0, 24)
          if (!next.includes(tag) && next.length < 8) next.push(tag)
        }
        return { ...prev, tags: next }
      })
    }
    setTagDraft('')
  }

  function onTagKeydown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
      event.preventDefault()
      commitTag()
    } else if (event.key === 'Backspace' && !tagDraft && draftRef.current?.tags.length) {
      // 空输入时退格删掉最后一个：标签编辑的通用手感
      setDraft((prev) => (prev ? { ...prev, tags: prev.tags.slice(0, -1) } : prev))
    }
  }

  function removeTag(tag: string): void {
    setDraft((prev) => (prev ? { ...prev, tags: prev.tags.filter((item) => item !== tag) } : prev))
  }

  async function createNew(): Promise<void> {
    try {
      // 同样要离开当前这条：留一份本地副本并安静落盘（不等结果），
      // 别让保存状态在新笔记的工具栏上闪一下
      const leaving = draftRef.current
      if (leaving) {
        rememberBody(client, leaving)
        flush(leaving)
      }
      // 建在当前选中的文件夹里——否则在文件夹视图下点"+ 新建"，
      // 新笔记会落到未归档：**看不见自己刚建的东西**（而这一轮又没有拖拽可以补救）
      const note = await createMutation.mutateAsync({
        title: '',
        content_md: '',
        folder_id: newNoteFolderId,
      })
      await navigate(`/notes/${note.id}`)
    } catch (cause) {
      toast.error(errorText(cause, '新建失败'))
    }
  }

  /**
   * 执行一次 AI 处理。
   *
   * 顺序要紧：**先把当前改动落盘**，因为后端处理的是库里保存的正文——
   * 不保存就会出现"AI 整理的是旧版本"这种很难察觉的错位。
   * 结果写回 draft，随后由正常的防抖保存持久化；空结果不覆盖原文。
   */
  async function runAi(action: NoteAiAction): Promise<void> {
    const item = draftRef.current
    if (!item || aiBusy) return
    setAiBusy(true)
    try {
      await saveNow()
      const result = await aiMutation.mutateAsync({ noteId: item.id, action })
      if (!result.content_md.trim()) {
        toast.error('AI 没有返回内容，正文保持原样')
        return
      }
      setDraft((prev) =>
        prev && prev.id === item.id ? { ...prev, content_md: result.content_md } : prev,
      )
      // 只报"做完了"并给撤销的落点（位置，不是解释）：原来还缀着"或直接改"
      toast.success('AI 处理完成；不满意可用工具栏的撤销')
    } catch (cause) {
      toast.error(errorText(cause, 'AI 处理失败'))
    } finally {
      setAiBusy(false)
    }
  }

  function openAttach(): void {
    if (!kbOptions.length) {
      toast.error('还没有知识库，先去「知识库」新建一个')
      return
    }
    setAttachKb(draftRef.current?.kb_id ?? kbOptions[0].value)
    setAttachOpen(true)
  }

  async function confirmAttach(): Promise<void> {
    const item = draftRef.current
    if (!item || !attachKb) return
    try {
      // 先落盘再入库：入库读的是库里的正文，未保存的改动不该被漏掉
      await saveNow()
      const updated = await attachMutation.mutateAsync({ noteId: item.id, kbId: attachKb })
      setDraft((prev) =>
        prev && prev.id === updated.id
          ? { ...prev, kb_id: updated.kb_id, doc_id: updated.doc_id }
          : prev,
      )
      setAttachOpen(false)
      // 只报结果（原来那句"之后可以在检索里命中这条笔记"是在解释入库之后会怎样）
      toast.success('已加入知识库')
    } catch (cause) {
      toast.error(errorText(cause, '加入知识库失败'))
    }
  }

  async function confirmDelete(): Promise<void> {
    const item = draftRef.current
    if (!item) return
    try {
      await deleteMutation.mutateAsync(item.id)
      setDeleteOpen(false)
      setDraft(null)
      await navigate('/notes', { replace: true })
      toast.success('笔记已删除')
    } catch (cause) {
      toast.error(errorText(cause, '删除失败'))
    }
  }

  function toggleListCollapsed(): void {
    const next = !listCollapsed
    setListCollapsed(next)
    writeListCollapsed(next)
  }

  function toggleTagsCollapsed(): void {
    const next = !tagsCollapsed
    setTagsCollapsed(next)
    writeTagsCollapsed(next)
  }

  /* ------------------------------------------------------------ 文件夹（v14） */

  /** 新建的笔记落在哪儿：选中某个文件夹时就在它里面，其他两种情况进未归档。 */
  const newNoteFolderId =
    activeFolder === '' || activeFolder === UNFILED_FOLDER ? null : activeFolder

  /**
   * 选中的文件夹被删掉了（自己删的、或另一个标签页删的）→ 退回"全部"。
   *
   * 不退的话列表会停在一个**永远为空**的筛选上：数据没了、界面上却还有一条
   * 看起来正常的筛选条件，用户只会以为"笔记都没了"。
   * 只在**读数已经拿到**时判断（`isSuccess`）——首屏还没读数时 `folders` 是空数组，
   * 那时候退掉会把用户刚选中的文件夹键成白选。
   */
  useEffect(() => {
    if (!foldersQuery.isSuccess) return
    if (activeFolder === '' || activeFolder === UNFILED_FOLDER) return
    if (!folders.some((folder) => folder.id === activeFolder)) setFolder('')
  }, [foldersQuery.isSuccess, folders, activeFolder, setFolder])

  function openCreateFolder(parentId: string | null): void {
    setFolderForm({ mode: 'create', parentId, name: '' })
  }

  function openRenameFolder(folder: NoteFolder): void {
    setFolderForm({
      mode: 'rename',
      folderId: folder.id,
      parentId: folder.parent_id,
      name: folder.name,
    })
  }

  async function submitFolderForm(): Promise<void> {
    const form = folderForm
    if (!form) return
    const name = form.name.trim()
    if (!name) {
      toast.error('先给文件夹起个名字')
      return
    }
    setFolderSaving(true)
    try {
      if (form.mode === 'create') {
        await createFolderMutation.mutateAsync({ name, parentId: form.parentId })
      } else if (form.folderId) {
        await renameFolderMutation.mutateAsync({ folderId: form.folderId, name })
      }
      setFolderForm(null)
    } catch (cause) {
      // 重名、超长这类都被后端挡下来并给了可读文案（比如"这一层已经有一个同名文件夹"）
      toast.error(errorText(cause, '保存失败'))
    } finally {
      setFolderSaving(false)
    }
  }

  async function moveFolder(folder: NoteFolder, parentId: string | null): Promise<void> {
    try {
      await moveFolderMutation.mutateAsync({ folderId: folder.id, parentId })
    } catch (cause) {
      toast.error(errorText(cause, '移动失败'))
    }
  }

  async function confirmDeleteFolder(): Promise<void> {
    const folder = folderDelete
    if (!folder) return
    try {
      await deleteFolderMutation.mutateAsync(folder.id)
      // 删掉的正是当前选中的那一支 → 退回"全部"（见上面那个 effect 的同一条理由；
      // 这里先退一步是为了让用户在请求返回的瞬间就回到有内容的地方）
      const doomed = descendantIds(folders, folder.id)
      if (activeFolder === folder.id || doomed.has(activeFolder)) setFolder('')
      setFolderDelete(null)
      toast.success('文件夹已删除，里面的笔记回到了未归档')
    } catch (cause) {
      toast.error(errorText(cause, '删除失败'))
    }
  }

  /**
   * 把当前这条笔记移进某个文件夹（`folderId=null` = 移回未归档）。
   *
   * 走的是**单独那条端点**（不是编辑器的自动保存）：移动不是编辑，
   * 也不该被 800ms 后才落盘的那份草稿覆盖（见后端 `NotesService.move_note`）。
   */
  async function moveCurrentNote(folderId: string | null): Promise<void> {
    const item = draftRef.current
    if (!item) return
    if ((item.folder_id ?? null) === folderId) return
    try {
      const updated = await moveNoteMutation.mutateAsync({ noteId: item.id, folderId })
      setDraft((prev) =>
        prev && prev.id === updated.id ? { ...prev, folder_id: updated.folder_id } : prev,
      )
      const target = folderId ? folderPath(folders, folderId) : ''
      toast.success(target ? `已移动到「${target}」` : '已移回未归档')
    } catch (cause) {
      toast.error(errorText(cause, '移动失败'))
    }
  }

  /** 点目录跳过去。
   *
   * **落点不在这里算**：滚动容器是谁、阅读线在哪儿（吸顶工具栏的下沿）都是画布那边
   * 的事（`NoteTocItem.scrollTo`，见 NoteCanvas），页面只负责"点了就跳"。
   */
  function jumpToToc(item: NoteTocItem): void {
    item.scrollTo()
  }

  const groups = useMemo(() => groupNotes(items), [items])
  /** 标签按语义分三组；空的那组不占位置（没有状态标签时就只有两行）。 */
  const tagGroups = useMemo(() => {
    const buckets: Record<TagKind, typeof tags> = { time: [], source: [], status: [] }
    for (const item of tags) buckets[tagKindOf(item.tag)].push(item)
    return TAG_GROUPS.map((group) => ({ ...group, items: buckets[group.kind] })).filter(
      (group) => group.items.length > 0,
    )
  }, [tags])
  const activeKbName = kbOptions.find((option) => option.value === draft?.kb_id)?.label ?? ''

  /** 「移动到」菜单的候选：全部文件夹（带完整路径，同名不同层才分得清）。 */
  const noteMoveOptions = useMemo(() => folderOptions(folders), [folders])
  /** 打开的那条笔记现在在哪个文件夹（菜单上打勾用）。 */
  const draftFolderName = draft?.folder_id ? folderPath(folders, draft.folder_id) : ''
  /** 删除确认要说的两个数：会带走几个子文件夹、几篇笔记（数错了等于骗人）。 */
  const deleteStats = folderDelete ? subtreeStats(folders, folderDelete.id) : null

  /**
   * 列表空态的第一句随作用域变。
   *
   * 在"工作"这个文件夹里看到"还没有笔记"会让人以为笔记都没了——
   * 而实际情况是"这个位置现在是空的"，两句话说的不是一回事。
   */
  const emptyTitle =
    activeFolder === ''
      ? '还没有笔记'
      : activeFolder === UNFILED_FOLDER
        ? '没有未归档的笔记'
        : `「${folderPath(folders, activeFolder) || '这个文件夹'}」里还没有笔记`

  const saveLabel =
    saveState === 'saving'
      ? '保存中…'
      : saveState === 'saved'
        ? savedAt
          ? `已保存 ${formatSavedAt(savedAt)}`
          : '已保存'
        : saveState === 'error'
          ? '保存失败'
          : ''

  return (
    // 刻意不用 PageShell：这一页的第一屏应当是"列表头 + 编辑器工具栏"，
    // 而不是通用页头（大标题 + 说明）。工具型界面里那两行只是占地方。
    <div className="notes-page">
      <div
        className={`notes-layout${listCollapsed ? ' list-collapsed' : ''}${
          tocOpen && tocItems.length > 0 ? ' toc-open' : ''
        }`}
      >
        <aside className="notes-list">
          {/*
            头部只剩动作按钮：原来那行"全部 N"的标题移到了树上的「全部」那一行
            （选中态与条数都在那儿，两处各写一份迟早会说两套话）。
            「+」仍在这一行的右端——空态那句"点右上角的 + 写第一条"说的就是它。
          */}
          <div className="list-head">
            {!listCollapsed && (
              <button
                type="button"
                className="icon-action"
                title="新建笔记"
                aria-label="新建笔记"
                onClick={() => void createNew()}
              >
                <Plus size={16} />
              </button>
            )}
            {/* 折叠开关：箭头指向"列表会往哪边收"，展开态在右、折叠态独居导轨中央 */}
            <button
              type="button"
              className="icon-action collapse-toggle"
              title={listCollapsed ? '展开列表' : '折叠列表'}
              aria-label={listCollapsed ? '展开笔记列表' : '折叠笔记列表'}
              aria-expanded={!listCollapsed}
              onClick={toggleListCollapsed}
            >
              {listCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
            </button>
          </div>

          {/* 折叠后整块列表**移出 DOM**（不只是 CSS 藏起来）：导轨里再养着搜索框、
              文件夹树与上百行列表没有意义，而且它们还得继续跟着数据变化重渲染 */}
          {!listCollapsed && (
            <>
              <div className="search-box">
                <Search size={14} className="search-icon" aria-hidden="true" />
                <Input
                  className="pl-8"
                  value={searchInput}
                  placeholder="搜索标题与正文"
                  aria-label="搜索笔记"
                  onChange={(event) => setSearchInput(event.target.value)}
                />
              </div>

              {/*
                文件夹树：**读不到就不摆**（`isSuccess`）。空数组会渲染出一棵
                "全部 0 / 未归档 0"的树——那是把"还没读到"说成了"这里什么都没有"。
              */}
              {foldersQuery.isSuccess && (
                <div className="folder-panel">
                  <div className="folder-head">
                    <span className="folder-head-label">文件夹</span>
                    <button
                      type="button"
                      className="icon-action folder-add"
                      title="新建文件夹"
                      aria-label="新建文件夹"
                      onClick={() => openCreateFolder(null)}
                    >
                      <Plus size={14} />
                    </button>
                  </div>
                  <NoteFolderTree
                    folders={folders}
                    unfiledCount={foldersQuery.data?.unfiled_count ?? 0}
                    totalCount={foldersQuery.data?.total_count ?? 0}
                    active={activeFolder}
                    onSelect={setFolder}
                    onCreateChild={(folder) => openCreateFolder(folder.id)}
                    onRename={openRenameFolder}
                    onDelete={setFolderDelete}
                    onMove={(folder, parentId) => void moveFolder(folder, parentId)}
                  />
                </div>
              )}

              {/*
                标签区：**默认折叠**（用户反馈："标签在笔记目录里面不默认展开。不然标签
                一多就太多了"）。折叠态就是这一行小标题（实测 20px），展开态才是那三组
                chip（实测 150.1px）。

                当前生效的标签即使在折叠态也留在这一行里（旁边那颗亮着的 chip）：
                否则列表被筛过、屏幕上却没有任何东西说得出"为什么只剩这几条"。
              */}
              {tags.length > 0 && (
                <div className={`tag-bar${tagsCollapsed ? ' tag-bar-collapsed' : ''}`}>
                  <div className="tag-bar-head">
                    <button
                      type="button"
                      className="tag-bar-toggle"
                      aria-expanded={!tagsCollapsed}
                      title={tagsCollapsed ? '展开标签' : '折叠标签'}
                      onClick={toggleTagsCollapsed}
                    >
                      {tagsCollapsed ? (
                        <ChevronRight size={12} aria-hidden="true" />
                      ) : (
                        <ChevronDown size={12} aria-hidden="true" />
                      )}
                      <span>标签</span>
                      <span className="tag-count tabular">{formatCount(tags.length)}</span>
                    </button>
                    {tagsCollapsed && activeTag && (
                      <button
                        type="button"
                        className="tag-chip tag-on"
                        onClick={() => setFilter(searchInput.trim(), '')}
                      >
                        {activeTag}
                      </button>
                    )}
                  </div>

                  {!tagsCollapsed && (
                    <div className="tag-groups">
                      {tagGroups.map((group) => (
                        <div key={group.kind} className="tag-group">
                          <span className="tag-group-label">{group.label}</span>
                          <span className="tag-group-items">
                            {group.items.map((item) => (
                              <button
                                key={item.tag}
                                type="button"
                                className={`tag-chip${activeTag === item.tag ? ' tag-on' : ''}`}
                                onClick={() =>
                                  setFilter(
                                    searchInput.trim(),
                                    activeTag === item.tag ? '' : item.tag,
                                  )
                                }
                              >
                                {item.tag}
                                {/* 计数前面要有一个记号：`2026-09` 后面直接跟一个 `3`，
                                读起来是"2026-09-3"（界面评审 N4 就是这么读的——
                                它以为日期被截断了，其实那是**标签 + 计数**两个东西）。
                                `·` 是仓库里既有的分隔符（用量行也用它），不新增词汇。 */}
                                <span className="tag-count tabular">
                                  · {formatCount(item.count)}
                                </span>
                              </button>
                            ))}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {listQuery.error ? (
                <p className="list-hint list-error">{errorText(listQuery.error, '笔记加载失败')}</p>
              ) : !listQuery.isLoading && !items.length ? (
                <div className="empty">
                  {/* 空态随作用域变：在文件夹里看到"还没有笔记"会让人以为笔记没了 */}
                  <p className="empty-title">{emptyTitle}</p>
                  <p className="empty-hint">点右上角的 + 写第一条</p>
                </div>
              ) : (
                <div className="note-groups">
                  {groups.map((group) => (
                    <section key={group.label} className="note-group">
                      <p className="group-label">{group.label}</p>
                      <ul className="note-items">
                        {group.items.map((item) => (
                          <li key={item.id}>
                            <Link
                              className={`note-item${item.id === draft?.id ? ' note-item-active' : ''}`}
                              to={`/notes/${item.id}`}
                              onPointerEnter={() => onNoteHover(item.id)}
                              onPointerDown={() => onNoteHover(item.id)}
                              onFocus={() => onNoteHover(item.id)}
                            >
                              <span className="note-item-title">
                                {item.pinned && (
                                  <Pin size={12} className="pin-icon" aria-hidden="true" />
                                )}
                                {item.title || '未命名笔记'}
                              </span>
                              <span className="note-item-meta">
                                <span className="note-item-preview">
                                  {item.preview || '（空）'}
                                </span>
                                <span className="note-item-tail">
                                  {item.doc_id && <Library size={12} aria-label="已加入知识库" />}
                                  <span className="tabular">{shortDate(item)}</span>
                                </span>
                              </span>
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
                </div>
              )}
            </>
          )}
        </aside>

        <section className="notes-pane">
          {/* **不要**在切换时把编辑器换成"加载中"占位：那会卸载并重建整个 Tiptap
              （工具栏、扩展、DOM 全部重来），切换笔记看起来就像卡了一下。
              这里让它一直挂着，只换内容——同类型笔记之间没有必须重建的东西。 */}
          {draft ? (
            <NoteEditor
              ref={editorRef}
              className="pane-editor"
              value={draft.content_md}
              noteId={draft.id}
              aiBusy={aiBusy}
              loading={switching}
              onValueChange={(markdown) =>
                setDraft((prev) => (prev ? { ...prev, content_md: markdown } : prev))
              }
              onToc={setTocItems}
              onNotify={(payload) => {
                if (payload.type === 'error') toast.error(payload.message)
                else toast.success(payload.message)
              }}
              onAi={(action) => void runAi(action)}
              status={
                <span className={`save-label${saveState === 'error' ? ' save-error' : ''}`}>
                  {saveLabel}
                </span>
              }
              actions={
                <>
                  {/* 目录开关：**只在这条笔记真有标题时出现**（没有锚点的目录是个空盒子）。
                      窄屏下它与目录栏一起收起（见 notes.css 的断点）。 */}
                  {tocItems.length > 0 && (
                    <button
                      type="button"
                      className={`icon-action toc-toggle${tocOpen ? ' icon-action-on' : ''}`}
                      title={tocOpen ? '隐藏目录' : '显示目录'}
                      aria-label="目录"
                      aria-expanded={tocOpen}
                      aria-pressed={tocOpen}
                      onClick={() => setTocOpen((prev) => !prev)}
                    >
                      <ListTree size={15} />
                    </button>
                  )}
                  {/*
                    「移动到文件夹」：这一轮的移动入口（不做拖拽）。
                    放在工具栏而不是列表行上，与置顶 / 加入知识库同类——它们都是
                    "对当前这条笔记做什么"，而列表行上再加一排悬停才出现的按钮，
                    会把本来就窄的左栏挤得更紧。
                  */}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className={`icon-action${draft.folder_id ? ' icon-action-on' : ''}`}
                        title={draftFolderName ? `已在「${draftFolderName}」` : '移动到文件夹'}
                        aria-label="移动到文件夹"
                      >
                        <FolderInput size={15} />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuLabel>移动到</DropdownMenuLabel>
                      {noteMoveOptions.map((option) => (
                        <DropdownMenuItem
                          key={option.id}
                          onSelect={() => void moveCurrentNote(option.id)}
                        >
                          <Check
                            size={14}
                            aria-hidden="true"
                            className={draft.folder_id === option.id ? '' : 'invisible'}
                          />
                          {option.path}
                        </DropdownMenuItem>
                      ))}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => void moveCurrentNote(null)}>
                        <Check
                          size={14}
                          aria-hidden="true"
                          className={draft.folder_id ? 'invisible' : ''}
                        />
                        未归档
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <button
                    type="button"
                    className={`icon-action${draft.pinned ? ' icon-action-on' : ''}`}
                    title={draft.pinned ? '取消置顶' : '置顶'}
                    aria-label={draft.pinned ? '取消置顶' : '置顶'}
                    aria-pressed={draft.pinned}
                    onClick={() =>
                      setDraft((prev) => (prev ? { ...prev, pinned: !prev.pinned } : prev))
                    }
                  >
                    <Pin size={15} />
                  </button>
                  <button
                    type="button"
                    className={`icon-action${draft.doc_id ? ' icon-action-on' : ''}`}
                    title={draft.doc_id ? `已加入「${activeKbName}」` : '加入知识库'}
                    aria-label="加入知识库"
                    onClick={openAttach}
                  >
                    <Library size={15} />
                  </button>
                  <button
                    type="button"
                    className="icon-action icon-action-danger"
                    title="删除"
                    aria-label="删除"
                    onClick={() => setDeleteOpen(true)}
                  >
                    <Trash size={15} />
                  </button>
                </>
              }
              header={
                <>
                  <input
                    className="doc-title"
                    value={draft.title}
                    placeholder="标题"
                    aria-label="笔记标题"
                    onChange={(event) =>
                      setDraft((prev) => (prev ? { ...prev, title: event.target.value } : prev))
                    }
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        ;(document.activeElement as HTMLElement | null)?.blur()
                      }
                    }}
                  />
                  <div className="tag-row">
                    {draft.tags.map((tag) => (
                      <span key={tag} className="tag-pill">
                        {tag}
                        <button
                          type="button"
                          className="tag-remove"
                          title={`移除 ${tag}`}
                          onClick={() => removeTag(tag)}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                    <input
                      className="tag-entry"
                      value={tagDraft}
                      placeholder={draft.tags.length ? '' : '＋ 标签'}
                      aria-label="添加标签"
                      onChange={(event) => setTagDraft(event.target.value)}
                      onKeyDown={onTagKeydown}
                      onBlur={commitTag}
                    />
                  </div>
                  {draft.doc_id && (
                    <div className="doc-status">
                      <Check size={13} aria-hidden="true" />
                      已加入知识库「{activeKbName}」
                      <Link className="doc-link" to={`/documents/${draft.doc_id}`}>
                        查看文档
                      </Link>
                    </div>
                  )}
                </>
              }
            />
          ) : (
            <div className="pane-empty">
              <div className="empty">
                <p className="empty-title">选择一条笔记开始编辑</p>
                <p className="empty-hint">或点左上角的 + 写一条新的</p>
              </div>
            </div>
          )}
        </section>

        {/*
          目录（正文大纲）在**右栏**——这是量过之后的选择，不是顺手：
          - 左栏已经是"列表 + 标签"，再塞一层导航会把两种轴（哪条笔记 / 这一节的哪里）
            叠在同一列里；
          - 右栏放得下：1440 屏实测正文列 830.9px，而正文那一栏的上限是 780px、
            居中之后两侧只剩 25.4px——目录栏（176px）不是"用掉余量"，是**从正文列里
            借**：借完 654.9px，正文仍有 607px（≈66 个字符的行宽，没有掉出阅读区间）；
          - 再窄就借不起了（1280 屏只余 502px），所以整个功能在 1360px 以下收起
            （见 notes.css 里那段断点与推导）。

          没有标题时**整栏不渲染**：空盒子只会占地方。
        */}
        {tocOpen && tocItems.length > 0 && (
          <aside className="notes-toc" aria-label="笔记目录">
            <p className="toc-title">目录</p>
            <ul className="toc-list">
              {tocItems.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={`toc-item${item.isActive ? ' toc-item-on' : ''}${
                      item.isScrolledOver ? ' toc-item-past' : ''
                    }`}
                    /* 层级只用来缩进（1–3 级，再深的标题在 176px 里也读不出层级差） */
                    data-level={Math.min(item.level, 3)}
                    aria-current={item.isActive ? 'true' : undefined}
                    title={item.textContent}
                    onClick={() => jumpToToc(item)}
                  >
                    {item.textContent}
                  </button>
                </li>
              ))}
            </ul>
          </aside>
        )}
      </div>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>删除这条笔记？</DialogTitle>
          </DialogHeader>
          <p>删除后无法恢复。已加入知识库生成的文档不会跟着删除。</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => void confirmDelete()}
            >
              {deleteMutation.isPending ? '处理中…' : '删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={attachOpen} onOpenChange={setAttachOpen}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>加入知识库</DialogTitle>
          </DialogHeader>
          {/*
            标题下面原来还有一句"笔记会作为一份 Markdown 文档进入选中的知识库，
            之后检索与问答都能命中它。"——那是入库这条链路会发生什么，
            选项框里的库名已经说明了一切，2026-09-24 按用户要求删。
          */}
          <label className="field">
            <span className="field-label">目标知识库</span>
            <select
              className="kb-select"
              value={attachKb}
              aria-label="目标知识库"
              onChange={(event) => setAttachKb(event.target.value)}
            >
              {kbOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAttachOpen(false)}>
              取消
            </Button>
            <Button
              variant="default"
              disabled={attachMutation.isPending}
              onClick={() => void confirmAttach()}
            >
              {attachMutation.isPending ? '处理中…' : '加入'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 新建 / 重命名共用一个表单（与知识库目录那套一致）：靠 mode 区分两种模式 */}
      <Dialog open={folderForm !== null} onOpenChange={(open) => !open && setFolderForm(null)}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>
              {folderForm?.mode === 'rename' ? '重命名文件夹' : '新建文件夹'}
            </DialogTitle>
          </DialogHeader>
          {folderForm?.mode === 'create' && folderForm.parentId && (
            <p className="text-[length:var(--text-meta-size)] text-text-secondary">
              建在「{folderPath(folders, folderForm.parentId)}」里
            </p>
          )}
          <Input
            value={folderForm?.name ?? ''}
            placeholder="文件夹名"
            aria-label="文件夹名"
            autoFocus
            onChange={(event) =>
              setFolderForm((prev) => (prev ? { ...prev, name: event.target.value } : prev))
            }
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submitFolderForm()
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setFolderForm(null)}>
              取消
            </Button>
            <Button
              variant="default"
              disabled={folderSaving}
              onClick={() => void submitFolderForm()}
            >
              {folderSaving ? '保存中…' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/*
        删文件夹的确认框：**必须把后果说全**——删掉的只是文件夹，
        里面的笔记会回到未归档、一篇都不会少。这两件事一个都不许含糊：
        用户按下这一下之前，屏幕上这几句是他唯一的依据。
      */}
      <Dialog open={folderDelete !== null} onOpenChange={(open) => !open && setFolderDelete(null)}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>删除「{folderDelete?.name}」？</DialogTitle>
          </DialogHeader>
          <p>
            {deleteStats && deleteStats.folders > 0
              ? `它里面的 ${formatCount(deleteStats.folders)} 个子文件夹会被一起删除。`
              : '这个文件夹会被删除。'}
            {deleteStats && deleteStats.notes > 0
              ? `里面的 ${formatCount(deleteStats.notes)} 篇笔记会回到未归档，不会被删除。`
              : ''}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFolderDelete(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={deleteFolderMutation.isPending}
              onClick={() => void confirmDeleteFolder()}
            >
              {deleteFolderMutation.isPending ? '处理中…' : '删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default NotesView
