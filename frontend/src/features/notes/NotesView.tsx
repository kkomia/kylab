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
import { Check, ChevronLeft, ChevronRight, Library, Pin, Plus, Search, Trash } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'

import type { NoteAiAction, NoteListItem } from '@/api/notes'
import { Button } from '@/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/ui/dialog'
import { Input } from '@/ui/input'

import { NoteEditor, type NoteEditorHandle } from './NoteEditor'
import {
  useAiTransform,
  useAttachNote,
  useCreateNote,
  useDeleteNote,
  useKnowledgeBaseOptions,
  useNoteTags,
  useNotesList,
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
  rememberBody,
  shortDate,
  snapshotOf,
  tagKindOf,
  useNotesStore,
  writeListCollapsed,
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
  const setFilter = useNotesStore((state) => state.setFilter)

  const listQuery = useNotesList({ q: query, tag: activeTag })
  const tagsQuery = useNoteTags()
  const kbQuery = useKnowledgeBaseOptions()

  const createMutation = useCreateNote()
  const saveMutation = useSaveNote()
  const deleteMutation = useDeleteNote()
  const attachMutation = useAttachNote()
  const aiMutation = useAiTransform()

  // 列表项与标签都从查询结果里派生：包一层 useMemo 是为了让它们有**稳定的身份**，
  // 否则下面那两个 effect 的依赖每次渲染都在变（`?? []` 每次都造一个新数组）
  const items = useMemo(() => listQuery.data?.items ?? [], [listQuery.data])
  const total = listQuery.data?.total ?? 0
  const tags = useMemo(() => tagsQuery.data ?? [], [tagsQuery.data])
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

  /**
   * 列表折叠（本机偏好）。
   *
   * 与侧栏折叠同一类东西——**"这台机器怎么显示"**，所以落 `localStorage`，
   * 不进后端设置；换台机器该重新选。初值就来自存储：**刷新之后保持折叠**，
   * 而不是先展开再收起来（那会闪一下）。
   */
  const [listCollapsed, setListCollapsed] = useState(() => readListCollapsed())

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
      const note = await createMutation.mutateAsync({ title: '', content_md: '' })
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
      toast.success('AI 处理完成；不满意可以用工具栏的撤销或直接改')
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
      toast.success('已加入知识库，之后可以在检索里命中这条笔记')
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
      <div className={`notes-layout${listCollapsed ? ' list-collapsed' : ''}`}>
        <aside className="notes-list">
          <div className="list-head">
            {!listCollapsed && (
              <>
                <p className="list-title">
                  全部<span className="list-count tabular">{total}</span>
                </p>
                <button
                  type="button"
                  className="icon-action"
                  title="新建笔记"
                  aria-label="新建笔记"
                  onClick={() => void createNew()}
                >
                  <Plus size={16} />
                </button>
              </>
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

          {/* 折叠后整块列表**移出 DOM**（不只是 CSS 藏起来）：导轨里再养着搜索框
              与上百行列表没有意义，而且它们还得继续跟着数据变化重渲染 */}
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

              {tags.length > 0 && (
                <div className="tag-bar">
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
                              setFilter(searchInput.trim(), activeTag === item.tag ? '' : item.tag)
                            }
                          >
                            {item.tag}
                            {/* 计数前面要有一个记号：`2026-09` 后面直接跟一个 `3`，
                                读起来是"2026-09-3"（界面评审 N4 就是这么读的——
                                它以为日期被截断了，其实那是**标签 + 计数**两个东西）。
                                `·` 是仓库里既有的分隔符（用量行也用它），不新增词汇。 */}
                            <span className="tag-count tabular">· {item.count}</span>
                          </button>
                        ))}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {listQuery.error ? (
                <p className="list-hint list-error">{errorText(listQuery.error, '笔记加载失败')}</p>
              ) : !listQuery.isLoading && !items.length ? (
                <div className="empty">
                  <p className="empty-title">还没有笔记</p>
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
          <p className="text-[length:var(--text-meta-size)] text-text-secondary">
            笔记会作为一份 Markdown 文档进入选中的知识库，之后检索与问答都能命中它。
          </p>
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
    </div>
  )
}

export default NotesView
