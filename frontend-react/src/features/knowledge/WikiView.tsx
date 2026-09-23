/**
 * 知识库 Wiki 页（旧 `views/WikiView.vue` 的行为逐条对齐）。
 *
 * 参考现代文档站的读法，但只取**读长文**的那一面：左边是一棵稳定的目录（读一篇时位置不变），
 * 右边是正文 + 出处。不做编辑器、不做拖拽排序——这里的页面是模型从库内容里整理出来的，
 * 用户要的是"读与溯源"。
 *
 * 三个关键取舍：
 * 1. **总览与单页分开拉**：总览只带标题/摘要（左边树要的是轻量数据），正文按选中页单独取，
 *    否则书一厚，"进页面"就要等一本全传完；
 * 2. **选中页写进 URL 查询参数 `page`**（与文档页的 `doc` 同一约定）：刷新、分享、后退都能回到同一页；
 * 3. **生成是异步任务**：点完「生成 Wiki」拿到 202 就该轮询总览，直到状态不再 `generating`。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams, Link } from 'react-router'
import { ChevronDown, ChevronRight, FileText, RefreshCw } from 'lucide-react'

import {
  clearWiki,
  generateWiki,
  getWiki,
  getWikiPage,
  type WikiOverview,
  type WikiPageDetail,
  type WikiPageSummary,
  type WikiSource,
} from '@/api/wiki'
import { Markdown } from '@/features/knowledge/markdown'
import {
  Button,
  ConfirmDialog,
  EmptyState,
  Skeleton,
  StatusTag,
  type StatusTone,
} from '@/features/knowledge/primitives'
import { messageOf, notify, useKnowledgeBases, usePolling } from '@/features/knowledge/store'
import { formatDate, formatRelativeTime } from '@/lib/format'

const POLL_INTERVAL_MS = 3000

/** 整库状态 → 文案与语义色。文字永远在，颜色只是加速识别。 */
const OVERVIEW_STATUS: Record<string, { label: string; tone: StatusTone; running?: boolean }> = {
  idle: { label: '未生成', tone: 'neutral' },
  generating: { label: '生成中…', tone: 'info', running: true },
  ready: { label: '已生成', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
}

/** 单页状态：整库生成时逐页落库，树/文章里可能出现"整库好了但某页还在生成"。 */
const PAGE_STATUS: Record<string, { label: string; tone: StatusTone; running?: boolean }> = {
  ready: { label: '已生成', tone: 'success' },
  generating: { label: '生成中…', tone: 'info', running: true },
  failed: { label: '生成失败', tone: 'danger' },
}

interface NavRow {
  page: WikiPageSummary
  depth: number
  hasChildren: boolean
}

export interface WikiViewProps {
  /** 不传则从路由参数取（`/kb/:kbId/wiki`）。 */
  kbId?: string
}

export function WikiView({ kbId: kbIdProp }: WikiViewProps) {
  const params = useParams()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const store = useKnowledgeBases()

  const kbId = kbIdProp ?? String(params.kbId ?? '')
  const kbName = store.byId(kbId)?.name ?? '知识库'

  const [overview, setOverview] = useState<WikiOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [detail, setDetail] = useState<WikiPageDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [generating, setGenerating] = useState(false)
  const [confirmRegenerateOpen, setConfirmRegenerateOpen] = useState(false)
  const [confirmClearOpen, setConfirmClearOpen] = useState(false)
  const [clearing, setClearing] = useState(false)
  /** 收起/展开的父页 id。默认都展开：刚生成完时用户最想先看全貌。 */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  /** 正在闪的出处序号（点正文徽标跳过来时给个落点）。 */
  const [flashIndex, setFlashIndex] = useState<number | null>(null)
  const flashTimer = useRef<number | undefined>(undefined)
  /** 页面详情请求的序号：快速连点两页时，只认最后一次的响应。 */
  const pageRequest = useRef(0)
  const sourcesRef = useRef<HTMLDivElement | null>(null)

  const selectedPageId = searchParams.get('page') ?? ''
  const hasPages = (overview?.pages.length ?? 0) > 0
  const statusView = OVERVIEW_STATUS[overview?.status ?? 'idle']
  const busyGenerating = generating || overview?.status === 'generating'

  const loadOverview = useCallback(async () => {
    try {
      setOverview(await getWiki(kbId))
      setError('')
    } catch (cause) {
      setError(messageOf(cause, 'Wiki 加载失败'))
    }
  }, [kbId])

  const loadPage = useCallback(async (pageId: string) => {
    if (!pageId) {
      setDetail(null)
      setDetailError('')
      return
    }
    const token = ++pageRequest.current
    setDetailLoading(true)
    setDetailError('')
    try {
      const data = await getWikiPage(pageId)
      if (token !== pageRequest.current) return
      setDetail(data)
    } catch (cause) {
      if (token !== pageRequest.current) return
      setDetail(null)
      setDetailError(messageOf(cause, '页面加载失败'))
    } finally {
      if (token === pageRequest.current) setDetailLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadPage(selectedPageId)
  }, [selectedPageId, loadPage])

  useEffect(() => {
    // 直接刷新到本页时 store 还是空的，`load()` 带回库名（面包屑用）
    if (store.items.length === 0) void store.load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      await loadOverview()
      if (!cancelled) setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [loadOverview])

  /**
   * 有页面但 URL 里没指定看哪一篇时，自动选第一篇。
   *
   * 用 `replace` 而不是 push：它是"补一个默认值"，不是用户的一次跳转——
   * 写进历史会让后退键先退到"没有选中页"再退回来，白按两下。
   */
  function ensureSelection(): void {
    if (selectedPageId) return
    const first = overview?.pages[0]
    if (!first) return
    const next = new URLSearchParams(searchParams)
    next.set('page', first.id)
    setSearchParams(next, { replace: true })
  }

  useEffect(() => {
    ensureSelection()
    // 总览更新后（首次生成完成、或刚进页面）补一次选中
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview])

  /** 只在生成中时轮询：落定之后停表，不做无意义的持续请求。 */
  const poll = useCallback(async () => {
    await loadOverview()
    if (overview?.status === 'generating') return
    // 生成刚结束：补一次选中（首次生成时树是从空变出来的），并刷新当前页
    ensureSelection()
    if (selectedPageId) await loadPage(selectedPageId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadOverview, overview?.status, selectedPageId, loadPage])

  usePolling(poll, {
    active: overview?.status === 'generating',
    intervalMs: POLL_INTERVAL_MS,
    immediate: false,
  })

  useEffect(
    () => () => {
      window.clearTimeout(flashTimer.current)
    },
    [],
  )

  async function runGenerate(): Promise<void> {
    if (generating) return
    setGenerating(true)
    try {
      await generateWiki(kbId)
      setConfirmRegenerateOpen(false)
      notify.success('已开始生成 Wiki，页面会陆续出现')
      // 立刻翻一次总览拿到 `generating`：这样状态标签与轮询都是马上对的
      await loadOverview()
    } catch (cause) {
      notify.error(messageOf(cause, '发起生成失败'))
    } finally {
      setGenerating(false)
    }
  }

  /** 已有页面时重新生成会覆盖它们，先确认；首次生成没有可失去的，直接开始。 */
  function requestGenerate(): void {
    if (hasPages) {
      setConfirmRegenerateOpen(true)
      return
    }
    void runGenerate()
  }

  async function confirmClear(): Promise<void> {
    if (clearing) return
    setClearing(true)
    try {
      await clearWiki(kbId)
      setConfirmClearOpen(false)
      setDetail(null)
      await loadOverview()
      // 选中页已经不存在了：把 `page` 从地址里摘掉，否则会被拉着去请求一个 404
      if (searchParams.get('page')) {
        const next = new URLSearchParams(searchParams)
        next.delete('page')
        setSearchParams(next, { replace: true })
      }
      notify.success('已清除 Wiki 页面')
    } catch (cause) {
      notify.error(messageOf(cause, '清除失败'))
    } finally {
      setClearing(false)
    }
  }

  function selectPage(pageId: string): void {
    if (!pageId || pageId === selectedPageId) return
    const next = new URLSearchParams(searchParams)
    next.set('page', pageId)
    setSearchParams(next)
  }

  /**
   * 把扁平页面摊成带层级的可见行（按 `parent_id` 还原树、用 `ord` 排序）。
   *
   * `visited` 是必要的守卫：后端数据一旦出现环（自己指向自己、A→B→A），
   * 没有它就会无限递归。父页缺失的页补在末尾，否则它们在导航里会彻底消失
   * ——数据脏不该表现为"页面丢了"。
   */
  const navRows = useMemo<NavRow[]>(() => {
    const pages = overview?.pages ?? []
    const children = new Map<string, WikiPageSummary[]>()
    const roots: WikiPageSummary[] = []
    for (const page of pages) {
      if (page.parent_id) {
        const bucket = children.get(page.parent_id) ?? []
        bucket.push(page)
        children.set(page.parent_id, bucket)
      } else {
        roots.push(page)
      }
    }
    const byOrd = (a: WikiPageSummary, b: WikiPageSummary): number =>
      a.ord - b.ord || a.title.localeCompare(b.title, 'zh')
    roots.sort(byOrd)
    for (const bucket of children.values()) bucket.sort(byOrd)

    const rows: NavRow[] = []
    const visited = new Set<string>()
    const walk = (list: WikiPageSummary[], depth: number): void => {
      for (const page of list) {
        if (visited.has(page.id)) continue
        visited.add(page.id)
        const kids = children.get(page.id) ?? []
        rows.push({ page, depth, hasChildren: kids.length > 0 })
        if (kids.length > 0 && !collapsed[page.id]) walk(kids, depth + 1)
      }
    }
    walk(roots, 0)

    for (const page of pages) {
      if (visited.has(page.id)) continue
      visited.add(page.id)
      rows.push({ page, depth: Math.max(0, page.level - 1), hasChildren: false })
    }
    return rows
  }, [overview, collapsed])

  /** 页面标题 → 页面 id，用来解析正文里的 `[[标题]]` 双链（对不上的原样留着）。 */
  const wikiLinks = useMemo(() => {
    const map: { [title: string]: string } = {}
    for (const page of overview?.pages ?? []) {
      if (!(page.title in map)) map[page.title] = page.id
    }
    return map
  }, [overview])

  async function revealSource(index: number): Promise<void> {
    setFlashIndex(index)
    await new Promise((resolve) => window.setTimeout(resolve, 0))
    // `scrollIntoView` 用可选调用：jsdom（测试环境）里没有这个方法，
    // 直接调用会在用例里留下一条 unhandled rejection
    sourcesRef.current
      ?.querySelector(`[data-source="${index}"]`)
      ?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
    window.clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => {
      setFlashIndex((current) => (current === index ? null : current))
    }, 1400)
  }

  /** 点出处里的文件名：回知识库详情页并打开文档抽屉（带页码落到那一页）。 */
  function openDocument(source: WikiSource): void {
    const query = new URLSearchParams({ doc: source.document_id })
    if (source.page !== null) query.set('page', String(source.page))
    void navigate(`/kb/${kbId}?${query.toString()}`)
  }

  /** 出处落点：标题路径 + 页码，可用的那部分才拼。 */
  function sourceWhere(source: WikiSource): string {
    const parts: string[] = []
    if (source.heading_path) parts.push(source.heading_path)
    if (source.page !== null) parts.push(`第 ${source.page} 页`)
    return parts.join(' · ')
  }

  const pageStatusView = detail ? PAGE_STATUS[detail.status] : PAGE_STATUS.ready
  const metaLine = detail
    ? detail.model
      ? `生成模型：${detail.model} · 生成时间：${formatRelativeTime(detail.generated_at)}`
      : `生成时间：${formatRelativeTime(detail.generated_at)}`
    : ''
  const generateLabel = busyGenerating ? '生成中…' : hasPages ? '重新生成' : '生成 Wiki'

  return (
    <div className="page-shell">
      <div className="kb-head-actions">
        <h1 style={{ flex: 1 }}>
          {/* 面包屑：Wiki 挂在某个库下，回库里的入口要一直在（旧前端同一个位置） */}
          <Link to={`/kb/${kbId}`}>{kbName}</Link>
          <ChevronRight size={13} aria-hidden="true" style={{ margin: '0 var(--space-1)' }} />
          <span>Wiki</span>
        </h1>
        {overview ? (
          <StatusTag label={statusView.label} tone={statusView.tone} running={statusView.running} />
        ) : null}
        {overview?.enabled ? (
          <Button
            variant="primary"
            icon={RefreshCw}
            disabled={busyGenerating}
            onClick={requestGenerate}
          >
            {generateLabel}
          </Button>
        ) : null}
      </div>

      {error ? <p className="kb-error-line">{error}</p> : null}

      {loading ? <Skeleton variant="list" rows={5} /> : null}

      {/* 库没开 Wiki：给"去哪儿开"的引导，不是一个空树 */}
      {!loading && overview && !overview.enabled ? (
        <div className="kb-wiki-empty">
          <EmptyState
            title="这个知识库还没有开启 Wiki"
            hint="Wiki 是库形态的一种：开启后可以用已录入的内容整理出一套带出处的百科式页面。请到「知识库设置 → Wiki」打开。"
          >
            <Button onClick={() => void navigate(`/kb/${kbId}`)}>回到知识库</Button>
          </EmptyState>
        </div>
      ) : null}

      {!loading && overview && overview.enabled ? (
        <>
          {/* 失败原因原样给出来：用户才知道是额度、模型还是内容的问题 */}
          {overview.status === 'failed' && overview.last_error ? (
            <p className="kb-error-line">{overview.last_error}</p>
          ) : null}

          {/* 正在生成且还没有页面：给"在动"的画面，而不是一个空状态 */}
          {!hasPages && overview.status === 'generating' ? (
            <div className="kb-generating">
              <Skeleton variant="list" rows={4} />
              <p className="text-note">
                正在整理库里的内容，页面会陆续出现。页面越多耗时越长，可以先去忙别的。
              </p>
            </div>
          ) : null}

          {!hasPages && overview.status !== 'generating' ? (
            <div className="kb-wiki-empty">
              <EmptyState
                title="还没有 Wiki 页面"
                hint="把库里已录入的内容整理成一套百科式页面，每个要点都带原文出处。"
              >
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 'var(--space-3)',
                    alignItems: 'center',
                  }}
                >
                  <p className="text-hint" style={{ margin: 0 }}>
                    会调用对话模型，页面越多越久。
                  </p>
                  <Button
                    variant="primary"
                    icon={RefreshCw}
                    disabled={busyGenerating}
                    onClick={requestGenerate}
                  >
                    {generateLabel}
                  </Button>
                </div>
              </EmptyState>
            </div>
          ) : null}

          {hasPages ? (
            <div className="kb-wiki-body">
              <aside className="kb-wiki-nav" aria-label="页面目录">
                <div className="kb-wiki-nav-head">
                  <span>页面 · {overview.page_count}</span>
                  {/* 清除是低频且不可恢复的动作：平时只留一行小字，确认弹窗才说清代价 */}
                  <button
                    type="button"
                    className="kb-wiki-clear"
                    onClick={() => setConfirmClearOpen(true)}
                  >
                    清除
                  </button>
                </div>
                <ul className="kb-wiki-list">
                  {navRows.map((row) => (
                    <li key={row.page.id}>
                      <div
                        className={[
                          'kb-wiki-row',
                          row.page.id === selectedPageId ? 'kb-wiki-row-on' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        style={
                          row.depth > 0
                            ? { paddingLeft: `calc(${row.depth} * var(--space-3))` }
                            : undefined
                        }
                      >
                        {row.hasChildren ? (
                          <button
                            type="button"
                            className="kb-tree-caret"
                            aria-expanded={!collapsed[row.page.id]}
                            aria-label={collapsed[row.page.id] ? '展开子页面' : '收起子页面'}
                            onClick={() =>
                              setCollapsed((current) => ({
                                ...current,
                                [row.page.id]: !current[row.page.id],
                              }))
                            }
                          >
                            {collapsed[row.page.id] ? (
                              <ChevronRight size={14} />
                            ) : (
                              <ChevronDown size={14} />
                            )}
                          </button>
                        ) : (
                          <span className="kb-tree-caret" aria-hidden="true" />
                        )}
                        <button
                          type="button"
                          className="kb-wiki-node"
                          aria-current={row.page.id === selectedPageId ? 'true' : undefined}
                          title={row.page.title}
                          onClick={() => selectPage(row.page.id)}
                        >
                          <FileText size={14} />
                          <span className="kb-wiki-label">{row.page.title}</span>
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </aside>

              <section className="kb-wiki-article">
                {detailLoading && !detail ? <Skeleton variant="text" rows={8} /> : null}
                {detailError ? <p className="kb-error-line">{detailError}</p> : null}

                {detail ? (
                  <>
                    <header className="kb-article-head">
                      <h2 className="kb-article-title">
                        {detail.title}
                        {detail.status !== 'ready' ? (
                          <StatusTag
                            label={pageStatusView.label}
                            tone={pageStatusView.tone}
                            running={pageStatusView.running}
                          />
                        ) : null}
                      </h2>
                      {detail.brief ? <p className="kb-article-brief">{detail.brief}</p> : null}
                      <p className="kb-article-meta" title={formatDate(detail.generated_at)}>
                        {metaLine}
                      </p>
                    </header>

                    <Markdown
                      text={detail.content_md}
                      citations={detail.sources.map((source) => ({
                        index: source.index,
                        document_name: source.document_name,
                      }))}
                      onCite={(index) => void revealSource(index)}
                      wikiLinks={wikiLinks}
                      onWikiPage={selectPage}
                    />

                    {detail.sources.length > 0 ? (
                      <section className="kb-sources" aria-label="出处" ref={sourcesRef}>
                        <h3 className="kb-sources-title">出处</h3>
                        <ol className="kb-sources-list">
                          {detail.sources.map((source) => (
                            <li
                              key={source.chunk_id}
                              className={[
                                'kb-source',
                                flashIndex === source.index ? 'kb-source-flash' : '',
                              ]
                                .filter(Boolean)
                                .join(' ')}
                              data-source={source.index}
                            >
                              <span className="kb-source-index tabular">[{source.index}]</span>
                              <button
                                type="button"
                                className="kb-source-doc"
                                onClick={() => openDocument(source)}
                              >
                                {source.document_name}
                              </button>
                              {sourceWhere(source) ? (
                                <span className="kb-source-where">{sourceWhere(source)}</span>
                              ) : null}
                            </li>
                          ))}
                        </ol>
                      </section>
                    ) : null}
                  </>
                ) : null}

                {!detail && !detailLoading && !detailError ? (
                  <EmptyState title="从左侧选择一篇页面" hint="文章正文与出处会显示在这里。" />
                ) : null}
              </section>
            </div>
          ) : null}
        </>
      ) : null}

      <ConfirmDialog
        open={confirmRegenerateOpen}
        title="重新生成 Wiki"
        lead={`重新生成会覆盖现有的 ${overview?.page_count ?? 0} 篇页面。`}
        note="已有页面在生成完成前仍然可读；生成过程会调用对话模型，页面越多耗时越长。"
        confirmLabel="重新生成"
        busy={generating}
        busyLabel="生成中…"
        onConfirm={() => void runGenerate()}
        onClose={() => setConfirmRegenerateOpen(false)}
      />

      <ConfirmDialog
        open={confirmClearOpen}
        title="清除 Wiki 页面"
        lead="确定清除这个知识库已生成的 Wiki 页面？"
        note="只删除整理出来的页面，不影响文档、切块与向量；清除后可以重新生成。"
        confirmLabel="清除"
        busy={clearing}
        busyLabel="清除中…"
        onConfirm={() => void confirmClear()}
        onClose={() => setConfirmClearOpen(false)}
      />
    </div>
  )
}
