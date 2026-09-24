/**
 * 记忆页（v0.14 三期；v0.46 起记忆是后端进程内的本地实现）。
 *
 * 一个视图、三块内容：**文件**（浏览与编辑）、**图谱**（wikilink 结构）、
 * **召回**（试一下搜不搜得到）。三块各回答一个问题，所以用分段控件切开。
 *
 * 三条来自后端的、必须让用户看见的事实（这一页的可用性全压在它们上）：
 * 1. **只有 `daily/` 与 `digest/` 会被召回**；`MEMORY.md` / `SOUL.md` 走**注入**
 *    ——每轮对话都进 system prompt，但不参与召回。不写清楚，"改了却搜不到"会被当成 bug；
 * 2. **没有索引需要等**：召回是每次现扫工作区，保存完就已经生效
 *    （这一页因此没有"重建索引"这种按钮，也没有"索引跟不跟得上"要解释）；
 * 3. **记忆目录随 owner**：后端按登录会话分桶（普通成员 → `data/memory/<自己>/`；
 *    管理员会话与 API Key 通道 → 共享桶 `data/memory/`，见 `api/v1/memory.py` 的
 *    `_scope`）。所以左侧栏脚注那行路径是**当前这一份**的落点，页面不另做隔离判断
 *    ——分桶由后端与 `lib/session` 的登录令牌决定，前端只如实显示它给的那条路径。
 *
 * 编辑器用**纯 textarea** 而不是笔记那套富文本：记忆文件是要逐字还原的 Markdown
 * （frontmatter 在里面），富文本"顺手格式化"一下就把用户的排版改了。
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  ChevronDown,
  FileText,
  Plus,
  Save,
  Search,
  Settings2,
  Trash2,
} from 'lucide-react'

import {
  deleteMemoryFile,
  getMemory,
  getMemoryFile,
  getMemoryGraph,
  recallMemory,
  rememberMemory,
  writeMemoryFile,
  type MemoryFile,
  type MemoryFileDetail,
} from '@/api/memory'
import { Markdown } from '@/features/knowledge/markdown'
// 阅读视角复用本仓那份 Markdown 渲染（与能力页的技能正文同一处），
// 它的排版类 `kb-md-*` 在知识库域的样式表里——本页是懒加载路由，得自己带上
import '@/features/knowledge/knowledge.css'
import { formatBytes, formatCount, formatDate, formatRelativeTime, formatScore } from '@/lib/format'
import { useSessionStore } from '@/lib/session'

import { SettingGroupPanel } from '../settings/SettingGroupPanel'
import { notifyError, notifySuccess } from '../shared/toast'
import { Badge } from '@/ui/badge'
import { Button } from '@/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu'
import { Input } from '@/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/ui/tabs'
import { Textarea } from '@/ui/textarea'
import {
  ConfirmDialog,
  EmptyState,
  Field,
  Modal,
  Notice,
  PageShell,
  SkeletonBlock,
  StatusTag,
} from '../shared/composites'
import { MemoryGraph } from './MemoryGraph'

const MEMORY_QUERY_KEY = ['memory', 'overview'] as const
const MEMORY_GRAPH_KEY = ['memory', 'graph'] as const

type Tab = 'files' | 'recall' | 'graph'

/**
 * 按类别分组，**顺序固定**（核心 → 每日现场 → 长期知识 → 其它）。
 *
 * 不用"按时间倒序的扁平列表"：记忆的读法跟笔记不同——用户来这里多半是找
 * "我知道的那个东西"，**位置**（它在哪一层）本身就是线索。
 */
const GROUPS: { kind: MemoryFile['kind']; label: string }[] = [
  { kind: 'core', label: '核心（每轮注入）' },
  { kind: 'daily', label: '每日现场（可召回）' },
  { kind: 'digest', label: '长期知识（可召回）' },
  { kind: 'other', label: '其它（不参与）' },
]

const TABS = [
  { value: 'files' as const, label: '文件' },
  { value: 'graph' as const, label: '图谱' },
  { value: 'recall' as const, label: '召回' },
]

/** 右栏的两种形态：读（渲染后的正文）与改（原文）。 */
type EditorView = 'read' | 'edit'

/** 这一份记忆怎么生效：每轮注入 / 可被召回 / 只是文本。列表行右侧那枚标记用它。 */
function effectOf(item: MemoryFile): string {
  if (item.injected) return '每轮注入'
  if (item.retrievable) return '可召回'
  return '不参与'
}

/**
 * 阅读视角的正文：**掐掉开头那段 frontmatter**。
 *
 * `---` 在 Markdown 里是分割线，整份原文直接渲染的话，`summary: …` 与 `read_when: - …`
 * 会变成正文里的一段——那是这份记忆的元数据，不是它要说的事。编辑视角仍用原文
 * （逐字还原，frontmatter 在里面）。
 */
function bodyOf(content: string): string {
  const frontmatter = /^\s*---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/
  return content.replace(frontmatter, '')
}

export function MemoryPage() {
  const queryClient = useQueryClient()
  const isAdmin = useSessionStore((store) => store.currentUser?.role === 'admin')

  const [tab, setTab] = useState<Tab>('files')
  const [activePath, setActivePath] = useState('')
  const [detail, setDetail] = useState<MemoryFileDetail | null>(null)
  const [draft, setDraft] = useState('')
  const [detailLoading, setDetailLoading] = useState(false)
  /** 右栏形态：默认**读**（渲染后的正文），编辑才切成原文。 */
  const [view, setView] = useState<EditorView>('read')
  /** 保存失败的原因原样留在编辑器上方：**不能默默丢掉用户刚写的东西**。 */
  const [saveError, setSaveError] = useState('')
  const [filter, setFilter] = useState('')

  const [recallQuery, setRecallQuery] = useState('')
  const [recallHits, setRecallHits] = useState<Awaited<ReturnType<typeof recallMemory>> | null>(
    null,
  )
  const [recallError, setRecallError] = useState('')
  const [recalling, setRecalling] = useState(false)

  const [newOpen, setNewOpen] = useState(false)
  const [newPath, setNewPath] = useState('digest/personal/')
  const [noteOpen, setNoteOpen] = useState(false)
  const [noteText, setNoteText] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [graphWanted, setGraphWanted] = useState(false)

  type Pending = { kind: 'discard' | 'delete'; path: string } | null
  const [pending, setPending] = useState<Pending>(null)
  const pendingPath = useRef('')

  const overview = useQuery({ queryKey: MEMORY_QUERY_KEY, queryFn: getMemory })
  const graph = useQuery({
    queryKey: MEMORY_GRAPH_KEY,
    queryFn: getMemoryGraph,
    enabled: graphWanted,
  })
  const files = useMemo(() => overview.data?.files ?? [], [overview.data])
  const status = overview.data?.status ?? null
  /** 草稿与已保存内容不一致 = 有未保存的改动。 */
  const dirty = detail !== null && draft !== detail.content

  const groups = useMemo(() => {
    const keyword = filter.trim().toLowerCase()
    return GROUPS.map((group) => ({
      label: group.label,
      items: files.filter((item) => {
        if (item.kind !== group.kind) return false
        if (!keyword) return true
        return (
          item.path.toLowerCase().includes(keyword) ||
          item.title.toLowerCase().includes(keyword) ||
          item.summary.toLowerCase().includes(keyword)
        )
      }),
    })).filter((group) => group.items.length > 0)
  }, [files, filter])

  /**
   * 打开一份文件。
   *
   * `force` 用于"确认放弃改动之后"：discard 那一支要真的切过去。
   * 有未保存改动时**先问**——切走会丢，而用户很可能只是点错了。
   */
  async function openFile(path: string, force = false): Promise<void> {
    if (path === activePath && detail && !force) return
    if (dirty && !force) {
      pendingPath.current = path
      setPending({ kind: 'discard', path: '' })
      return
    }
    setActivePath(path)
    setDetailLoading(true)
    setSaveError('')
    try {
      const next = await getMemoryFile(path)
      setDetail(next)
      setDraft(next.content)
    } catch (error) {
      setDetail(null)
      setDraft('')
      notifyError(`打开失败：${messageOf(error)}`)
    } finally {
      setDetailLoading(false)
    }
  }

  /** 首次进入默认打开核心记忆：它是这一页最该被看见的一份。 */
  useEffect(() => {
    if (!overview.data || activePath) return
    const first = files.find((item) => item.kind === 'core') ?? files[0]
    if (first) void openFile(first.path, true)
    // 只在首次拿到列表时自动选一份
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview.data])

  const save = useMutation({
    mutationFn: () => writeMemoryFile(detail!.path, draft),
    onSuccess: async (saved) => {
      setDetail(saved)
      setDraft(saved.content)
      await queryClient.invalidateQueries({ queryKey: MEMORY_QUERY_KEY })
      notifySuccess('已保存')
    },
    // 保存失败**不清空草稿**：用户刚写的东西必须还在编辑器里
    onError: (error: unknown) => setSaveError(messageOf(error)),
  })

  const remove = useMutation({
    mutationFn: (path: string) => deleteMemoryFile(path),
    onSuccess: async () => {
      notifySuccess('已删除')
      setDetail(null)
      setActivePath('')
      setDraft('')
      await queryClient.invalidateQueries({ queryKey: MEMORY_QUERY_KEY })
      await queryClient.invalidateQueries({ queryKey: MEMORY_GRAPH_KEY })
    },
    onError: (error: unknown) => notifyError(`删除失败：${messageOf(error)}`),
  })

  const create = useMutation({
    mutationFn: (path: string) =>
      writeMemoryFile(path, `# ${path.split('/').pop()?.replace(/\.md$/, '') ?? '新记忆'}\n\n`),
    onSuccess: async (_data, path) => {
      setNewOpen(false)
      setNewPath('digest/personal/')
      await queryClient.invalidateQueries({ queryKey: MEMORY_QUERY_KEY })
      await openFile(path, true)
      setTab('files')
      notifySuccess('已新建')
    },
    onError: (error: unknown) => notifyError(`新建失败：${messageOf(error)}`),
  })

  const remember = useMutation({
    mutationFn: (text: string) => rememberMemory(text),
    onSuccess: async (result) => {
      setNoteOpen(false)
      setNoteText('')
      await queryClient.invalidateQueries({ queryKey: MEMORY_QUERY_KEY })
      await openFile('MEMORY.md', true)
      notifySuccess(result.saved ? '已记进 MEMORY.md' : '这条已经在核心记忆里了')
    },
    onError: (error: unknown) => notifyError(`没记下来：${messageOf(error)}`),
  })

  const submitNote = () => {
    const text = noteText.trim()
    if (!text) return
    remember.mutate(text)
  }

  const submitNewFile = () => {
    const path = newPath.trim()
    if (!path) return
    if (!path.toLowerCase().endsWith('.md')) {
      notifyError('文件名要以 .md 结尾')
      return
    }
    create.mutate(path)
  }

  async function runRecall(): Promise<void> {
    const query = recallQuery.trim()
    if (!query || recalling) return
    setRecalling(true)
    setRecallError('')
    // 每次召回都先清空上一次的结果：留着旧结果而新结果还没到，两者会被看成一回事
    setRecallHits(null)
    try {
      setRecallHits(await recallMemory(query))
    } catch (error) {
      // 关着时后端**明确报错**（不返回空）——原样显示这句话。
      // 开着时的空结果是另一回事：那代表真没有相关记忆（见下面的空态）
      setRecallHits(null)
      setRecallError(messageOf(error))
    } finally {
      setRecalling(false)
    }
  }

  const onEditorKeydown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      if (!save.isPending && dirty) save.mutate()
    }
  }

  const openFromList = (path: string) => {
    setTab('files')
    void openFile(path)
  }

  /**
   * 状态标签：**只说本地事实**（v0.46）。
   *
   * 原先这里是"探测结论"（记忆服务正常 / 未连接 / 连通性未知），因为记忆那时是
   * 另一个进程、而 `GET /memory` 故意不打远端——两边拼起来，界面上就出现过
   * 用户根本不该读的东西（内部地址、端口、异常原文）。现在记忆跑在后端进程里，
   * 没有第二个进程可连，标签只说"开没开"，细节在下面那行本地数字里。
   *
   * 标签后面**不再跟一句"这意味着什么"**：开关在设置里，这行只报状态。
   */
  const statusView = !status
    ? { label: '读取中', tone: 'neutral' as const }
    : !status.enabled
      ? { label: '未启用', tone: 'neutral' as const }
      : { label: '已启用', tone: 'success' as const }

  /**
   * 本地状态那行：几份文件、多少条可召回、上次更新。
   *
   * 时间与别处**同一个口径**（`formatRelativeTime`）：同一屏里一处写"2 小时前"、
   * 另一处写绝对时间的代价是读者要在脑子里做换算，还分不清说的是不是同一时刻。
   */
  const localState = status
    ? [
        `${formatCount(status.file_count)} 份文件`,
        `${formatCount(status.entry_count)} 条可召回`,
        status.last_changed_at
          ? `上次更新 ${formatRelativeTime(status.last_changed_at)}`
          : '还没有内容',
      ].join(' · ')
    : ''

  // 显式类型：文件那一档多一个 `count`，不给类型的话它是个"有些成员没有该属性"的联合
  const tabItems: { value: Tab; label: string; count?: number }[] = TABS.map((item) =>
    item.value === 'files' && status ? { ...item, count: status.file_count } : item,
  )

  return (
    <PageShell
      title="记忆"
      actions={
        <>
          <StatusTag label={statusView.label} tone={statusView.tone} />
          {/* 「设置」就在这一页（v0.26）：开关原先挂在「总设置 → 功能」，
              而这一页顶着一句"记忆未启用"——同一个东西的说明和开关隔着两个菜单 */}
          {isAdmin && (
            <Button onClick={() => setSettingsOpen(true)}>
              <Settings2 size={15} />
              设置
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              {/*
                「新增」这两个字要**看得见**（第四批评审 B③）：它原来是枚只有图标的 ⋮，
                而空态正指着它说"手动新建一份"——整页找不到那个词，
                第一次用的人只能一个个图标去猜。菜单里的两项不变，只是入口有了名字。
              */}
              <Button variant="outline" title="新增">
                <Plus size={15} />
                新增
                <ChevronDown size={13} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem
                onSelect={() => {
                  setNoteOpen(true)
                }}
              >
                <Plus size={14} /> 记一条事实
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  setNewOpen(true)
                }}
              >
                <FileText size={14} /> 新建记忆文件
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            <Save size={14} />
            {save.isPending ? '保存中…' : '保存'}
          </Button>
        </>
      }
    >
      {overview.isError && (
        <Notice tone="error" icon={<AlertCircle size={15} />}>
          {messageOf(overview.error)}
        </Notice>
      )}

      {overview.isLoading ? (
        <SkeletonBlock variant="list" rows={6} />
      ) : (
        <>
          {/*
            页签的**当前态交给 `@/ui/tabs` 自己**（与 `misc/tasks/TasksPage.tsx` 同一个原语、
            同一个形状）：槽是 `--bg-subtle`、当前项是 `--bg-surface`，靠原语自带的
            `data-[state=active]:bg-surface` 画出来。

            这里一度在按钮里**再垫一层 span** 画白底（评审 M5 时 `px-3` 与
            `data-[state=active]:bg-surface` 都渲染不出来）。根因不在原语：当时
            `tokens.css` 的元素重置没进 `@layer base`，那条未分层的
            `button { padding: 0; background: none; font: inherit }` 压过了
            `@layer utilities` 里的全部工具类（未分层 > 分层，与优先级无关）。
            根因已修（`tokens.css` §元素重置收进 `@layer base`），垫层随之删掉。
          */}
          <Tabs
            value={tab}
            onValueChange={(next) => {
              const nextTab = next as Tab
              setTab(nextTab)
              if (nextTab === 'graph') setGraphWanted(true)
            }}
          >
            <TabsList aria-label="记忆视图">
              {tabItems.map((item) => (
                <TabsTrigger key={item.value} value={item.value}>
                  {item.label}
                  {/* 文件数仍挂在那一档上；间距由原语触发按钮自己的 `gap-1.5` 给 */}
                  {item.count !== undefined && (
                    <span className="text-[length:var(--text-micro-size)] text-text-tertiary tabular-nums">
                      {formatCount(item.count)}
                    </span>
                  )}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          {tab === 'files' && (
            <div className="m-split m-split-files page-shell-body">
              <aside className="m-side-col" aria-label="记忆文件">
                <label className="m-toolbar-search">
                  <Search size={14} />
                  <input
                    type="search"
                    value={filter}
                    placeholder="按路径、标题、摘要过滤"
                    aria-label="过滤记忆文件"
                    onChange={(event) => setFilter(event.target.value)}
                  />
                </label>

                {/*
                  这里原有一行常驻说明（"核心四份每轮整份注入提示词…"。已按用户要求删除：
                  那一句是在解释记忆怎么运作，而"这一份进不进提示词"由**列表行那枚
                  「每轮注入」标记**逐行回答（标记是数据，说明是解释）。
                */}

                {overview.data?.truncated && (
                  <p className="m-toolbar-note">
                    文件太多，这里只列出了前面 {formatCount(status?.file_count)} 个。
                  </p>
                )}

                {groups.length === 0 ? (
                  /*
                    空态指向的入口必须**在屏幕上找得到**（第四批评审 B③）：
                    原先那句"也可以先手动新建一份"指的是工具栏上一枚只有图标的 ⋮，
                    而整页找不到"新增"两个字——第一次用的人只能猜。
                    这一处与触发按钮一起改：菜单入口现在写着「新增」（见 `actions` 里那颗），
                    空态就指它，并且把菜单里的第二层（「新建记忆文件」）也写清。
                  */
                  <EmptyState
                    title={files.length > 0 ? '没有匹配的文件' : '工作区里还没有记忆文件'}
                    hint={
                      files.length > 0
                        ? '换个关键词，或者清空过滤。'
                        : '点右上角的「新增」→「新建记忆文件」。'
                    }
                  />
                ) : (
                  <div className="m-block">
                    {groups.map((group) => (
                      <section key={group.label}>
                        <p className="m-group-label">{group.label}</p>
                        <ul className="m-list">
                          {group.items.map((item) => (
                            <li key={item.path}>
                              <button
                                type="button"
                                className={
                                  item.path === activePath
                                    ? 'm-file-item m-file-item-on'
                                    : 'm-file-item'
                                }
                                /* 完整路径仍拿得到：第二行换了摘要之后，它是鼠标下的那一条 */
                                title={item.path}
                                onClick={() => openFromList(item.path)}
                              >
                                <span className="m-file-head">
                                  <span className="m-file-title">{item.title}</span>
                                  {/* 改动时间放在行右端：找"刚改过的那份"时不用逐个点开 */}
                                  <span className="m-file-time tabular">
                                    {formatRelativeTime(item.modified_at)}
                                  </span>
                                </span>
                                {/*
                                  第二行**不再是同一句话的第二遍**：核心文件的 `title`
                                  就是 `path`（AGENTS.md / AGENTS.md / 1.4 KB），
                                  整行里同一个名字写了两遍。有摘要给摘要；没摘要就只在
                                  "路径与标题不同"时给路径——两个都不一样才留空。
                                */}
                                {item.summary ? (
                                  <span className="m-file-summary">{item.summary}</span>
                                ) : item.path !== item.title ? (
                                  <span className="m-file-path">{item.path}</span>
                                ) : null}
                                <span className="m-file-meta">
                                  {/* 生效标记：这一份怎么被用上。原先只有"不参与"与每日的
                                      整合状态有标记，核心与长期知识那两行是空的——一列里
                                      有的有、有的没有，读起来像没渲染出来。 */}
                                  <Badge variant="secondary">{effectOf(item)}</Badge>
                                  {item.kind === 'daily' ? (
                                    <Badge variant={item.consolidated ? 'secondary' : 'warning'}>
                                      {item.consolidated ? '已整合' : '待整合'}
                                    </Badge>
                                  ) : null}
                                  <span className="tabular">{formatBytes(item.size_bytes)}</span>
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      </section>
                    ))}
                  </div>
                )}

                {status && (
                  <div className="m-toolbar-note" data-testid="memory-local-state">
                    <p>
                      工作区：<code>{status.workspace}</code>
                    </p>
                    {/* 本地状态就这三个数字：几份文件、多少条可召回、上次更新 */}
                    <p className="tabular">{localState}</p>
                  </div>
                )}
              </aside>

              <section className="m-editor" aria-label="记忆编辑器">
                {detailLoading ? (
                  <SkeletonBlock variant="text" rows={6} />
                ) : !detail ? (
                  <EmptyState title="选一份记忆开始读" />
                ) : (
                  <>
                    <header className="m-editor-head">
                      <div className="m-editor-title">
                        {/* 标题里不再挂「这一份怎么生效」的 ⓘ：那句话在解释机制，
                            而**这一份具体怎么生效**由列表行右侧那枚标记逐行承担（`effectOf`） */}
                        <h2>{detail.title}</h2>
                        {/* 核心文件的标题就是文件名（MEMORY.md），再摆一行路径是重复的 */}
                        {detail.path !== detail.title && (
                          <code className="m-file-path">{detail.path}</code>
                        )}
                      </div>
                      <div className="m-page-actions">
                        {dirty && <span className="text-micro">未保存</span>}
                        {/* 右栏默认是**读**（渲染后的正文），编辑才切回原文的 textarea：
                            进来看到的应该是"这份记忆说了什么"，而不是 `---` 与 `##`。
                            编辑态仍是逐字还原的原文本（frontmatter 在里面，富文本会
                            "顺手格式化"掉用户的排版）。 */}
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setView(view === 'read' ? 'edit' : 'read')}
                        >
                          {view === 'read' ? '编辑' : '阅读'}
                        </Button>
                        {dirty && (
                          <Button size="sm" onClick={() => setDraft(detail.content)}>
                            还原
                          </Button>
                        )}
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => setPending({ kind: 'delete', path: detail.path })}
                        >
                          <Trash2 size={14} />
                          删除
                        </Button>
                      </div>
                    </header>

                    {saveError && (
                      <Notice tone="error" icon={<AlertCircle size={15} />}>
                        {saveError}（你的改动还在编辑器里，可以再存一次）
                      </Notice>
                    )}

                    {view === 'read' ? (
                      /* 与笔记页共用同一种"读"：正文按 Markdown 渲染（只读长文的线宽口径），
                         没有引用角标、没有双链——记忆里没有出处这个概念 */
                      <div className="m-editor-read">
                        <Markdown text={bodyOf(draft)} />
                      </div>
                    ) : (
                      <textarea
                        className="m-editor-body"
                        spellCheck={false}
                        aria-label="记忆文件正文"
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={onEditorKeydown}
                      />
                    )}

                    <footer className="m-editor-foot text-micro">
                      {/*
                        时间与左边那一列**同一个口径**（`formatRelativeTime`）：同一屏里
                        列表写"6 天前"、这里写"2026-09-17 17:33"的话，读者要在脑子里做换算，
                        还分不清说的是不是同一个时刻。绝对时间放 `title` 供核对。
                      */}
                      <span className="tabular" title={formatDate(detail.modified_at)}>
                        {formatBytes(detail.size_bytes)} · 改动于{' '}
                        {formatRelativeTime(detail.modified_at)}
                      </span>
                      {detail.truncated && (
                        <span className="m-warn-text">
                          文件过大，这里只读出了前一部分——保存会覆盖掉后面的内容，请先用别的编辑器处理。
                        </span>
                      )}
                      <span className="tabular">{dirty ? 'Ctrl/Cmd + S 保存' : '已是最新'}</span>
                    </footer>
                  </>
                )}
              </section>
            </div>
          )}

          {tab === 'graph' && (
            <div className="m-block page-shell-body">
              {graph.isLoading ? (
                <SkeletonBlock variant="list" rows={5} />
              ) : graph.data && graph.data.nodes.length === 0 ? (
                <EmptyState
                  title="还没有连起来的记忆"
                  hint="在正文里写 [[另一份记忆]] 就能建立一条链接。"
                />
              ) : graph.data ? (
                <MemoryGraph
                  graph={graph.data}
                  selected={activePath}
                  onSelect={(path) => {
                    // 有未保存改动时不能直接切走（切了会丢），交给 openFile 去问
                    setTab('files')
                    void openFile(path, !dirty)
                  }}
                />
              ) : graph.isError ? (
                <EmptyState title="图谱读不出来" hint={messageOf(graph.error)} />
              ) : null}
            </div>
          )}

          {tab === 'recall' && (
            <div className="m-block page-shell-body">
              <form
                className="m-add-source"
                style={{ maxWidth: '640px' }}
                onSubmit={(event) => {
                  event.preventDefault()
                  void runRecall()
                }}
              >
                <Input
                  value={recallQuery}
                  onChange={(event) => setRecallQuery(event.target.value)}
                  placeholder="例如：用户偏好什么样的回答风格"
                  aria-label="召回测试"
                />
                <Button type="submit" disabled={recalling || !recallQuery.trim()}>
                  {recalling ? '召回中…' : '召回'}
                </Button>
              </form>

              {recallError ? (
                <Notice tone="error" icon={<AlertCircle size={15} />}>
                  {recallError}
                </Notice>
              ) : recallHits ? (
                recallHits.hits.length === 0 ? (
                  <EmptyState
                    title="没有召回任何记忆"
                    hint="记忆里没有相关的内容。换个说法再试，或先把这条记下来。"
                  />
                ) : (
                  <>
                    <p className="text-micro">{recallHits.note}</p>
                    <ul className="m-list">
                      {recallHits.hits.map((hit, at) => (
                        <li key={`${hit.path}-${at}`} className="m-hit">
                          <div className="m-hit-head">
                            {hit.path ? (
                              <button
                                type="button"
                                className="m-source-refresh"
                                onClick={() => openFromList(hit.path)}
                              >
                                {hit.path}
                              </button>
                            ) : (
                              <span className="m-row-value">（没有出处）</span>
                            )}
                            <span className="tabular text-micro">
                              {hit.start_line !== null && (
                                <>
                                  L{hit.start_line}
                                  {hit.end_line ? `–${hit.end_line}` : ''}
                                </>
                              )}
                              {/* 相似度与检索页同一口径：三位小数（`formatScore`）——
                                  同一个分数在两页写两位/三位，读者会以为换了算法。
                                  覆盖率是**判据**（命中多少查询词），单独标一下：
                                  它才是"这条算不算相关"的依据，分数只管排序。 */}
                              {hit.score !== null && ` · ${formatScore(hit.score)}`}
                              {hit.coverage !== null &&
                                ` · 命中 ${Math.round(hit.coverage * 100)}%`}
                            </span>
                          </div>
                          <p className="m-hit-text">{hit.text}</p>
                        </li>
                      ))}
                    </ul>

                    {recallHits.links.length > 0 && (
                      <div>
                        <p className="m-group-label">顺着链接可以走到</p>
                        <ul className="m-list">
                          {recallHits.links.map((link, at) => (
                            <li
                              key={`${link.path}-${at}`}
                              style={{
                                display: 'flex',
                                alignItems: 'baseline',
                                gap: 'var(--space-2)',
                              }}
                            >
                              <button
                                type="button"
                                className="m-source-refresh"
                                onClick={() => openFromList(link.path)}
                              >
                                {link.name || link.path}
                              </button>
                              <span className="text-micro">
                                {link.direction === 'out' ? '出链' : '入链'}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </>
                )
              ) : null}
            </div>
          )}
        </>
      )}

      <Modal
        open={newOpen}
        title="新建记忆文件"
        onClose={() => setNewOpen(false)}
        footer={
          <>
            <Button onClick={() => setNewOpen(false)}>取消</Button>
            <Button disabled={create.isPending || !newPath.trim()} onClick={submitNewFile}>
              {create.isPending ? '新建中…' : '新建'}
            </Button>
          </>
        }
      >
        {/* 只说路径与生效方式的**对应关系**（这一格该填什么），不说"目录决定一切"是怎么实现的 */}
        <p className="text-meta">
          <code>digest/</code> 会被召回，<code>memory/</code>（或 <code>daily/</code>）
          是每日现场，根目录下是普通文本。
        </p>
        <Field label="文件路径" htmlFor="memory-new-path">
          <Input
            id="memory-new-path"
            value={newPath}
            onChange={(event) => setNewPath(event.target.value)}
            placeholder="digest/personal/某条结论.md"
          />
        </Field>
        <div className="m-form-actions">
          {[
            { label: '个人知识', path: 'digest/personal/' },
            { label: '可复用流程', path: 'digest/procedure/' },
            { label: '主题综述', path: 'digest/wiki/' },
          ].map((preset) => (
            <Button
              variant="secondary"
              size="sm"
              key={preset.path}
              onClick={() => setNewPath(preset.path)}
            >
              {preset.label}
            </Button>
          ))}
        </div>
      </Modal>

      <Modal
        open={noteOpen}
        title="记一条事实"
        onClose={() => setNoteOpen(false)}
        footer={
          <>
            <Button onClick={() => setNoteOpen(false)}>取消</Button>
            <Button disabled={remember.isPending || !noteText.trim()} onClick={submitNote}>
              {remember.isPending ? '记下中…' : '记下来'}
            </Button>
          </>
        }
      >
        {/* 只说这一格的约束（一句话、500 字），不解释它会被注入到哪儿 */}
        <p className="text-meta">一句话能说完的才放这里，最多 500 字。</p>
        <Textarea
          rows={4}
          value={noteText}
          onChange={(event) => setNoteText(event.target.value)}
          aria-label="要记住的事实"
          placeholder="例如：发布前必须先跑一遍后端门禁脚本。"
        />
      </Modal>

      <ConfirmDialog
        open={pending !== null}
        title={pending?.kind === 'delete' ? '删除这份记忆？' : '放弃未保存的改动？'}
        lead={
          pending?.kind === 'delete'
            ? `将删除 ${detail?.path ?? ''}。记忆文件没有回收站，删除后只能从备份找回。`
            : '当前文件有改动还没保存，切换过去就会丢掉。'
        }
        confirmLabel={pending?.kind === 'delete' ? '删除' : '放弃改动'}
        busy={remove.isPending}
        busyLabel="删除中…"
        onCancel={() => {
          pendingPath.current = ''
          setPending(null)
        }}
        onConfirm={() => {
          const action = pending
          setPending(null)
          if (!action) return
          if (action.kind === 'delete') remove.mutate(action.path)
          else {
            const target = pendingPath.current
            pendingPath.current = ''
            if (target) void openFile(target, true)
          }
        }}
      />

      {/* 记忆的设置：只有一组（长期记忆），所以是一个小弹窗而不是一整页 */}
      <Modal open={settingsOpen} title="记忆设置" onClose={() => setSettingsOpen(false)} size="md">
        <SettingGroupPanel keys={['memory']} />
      </Modal>
    </PageShell>
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
