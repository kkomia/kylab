/**
 * 任务中心（《前端设计规范》§6）——与旧前端 `views/TasksView.vue` 逐条对应。
 *
 * 每行一个任务：图标 + 类型 + 关联文档 + 状态 + **健康判据** + 尝试次数 + 时间。
 * 有任务在跑时自动刷新——否则用户只能不停手动点刷新。
 *
 * **健康列（M7 / T7.4）不是装饰**：`running` 这个状态本身说明不了任何事——
 * 一个跑了 5 秒的和一个卡了两小时的看起来完全一样。后端按租约是否续上算出
 * "可能卡住 / 长时间未执行"，这里负责把它显示出来。
 *
 * 缓存口径与旧 store 一致：**列表整份缓存在 query 里**，筛选/分页都在客户端做
 * （任务量级在几百以内）；轮询期间旧数据继续显示，不闪骨架屏。
 */
import { TASKS_QUERY_KEY } from '@/features/misc/queryKeys'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, FileText, RefreshCw } from 'lucide-react'
import { useNavigate } from 'react-router'

import { cancelTasks, getTaskLoad, listTasks, type TaskSummary } from '@/api/tasks'
import { formatDate } from '@/lib/format'
import { useSessionStore } from '@/lib/session'

import { useKnowledgeBases } from '../shared/knowledgeBases'
import { isTaskProblem, taskHealthTone, taskKindLabel, taskStateView } from '../shared/status'
import { notifyError, notifySuccess } from '../shared/toast'
import { Button } from '@/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/ui/tabs'
import {
  CheckRow,
  ConfirmDialog,
  EmptyState,
  ErrorLine,
  Modal,
  OptionSelect,
  PageShell,
  SkeletonBlock,
  StatusTag,
} from '../shared/composites'
import { LoadPanel } from './LoadPanel'
import { SchedulePanel } from './SchedulePanel'

const POLL_INTERVAL_MS = 2000
/** 任务列表原先一次铺满（几百条时滚不到底），与文档列表同一套口径。 */
const PAGE_SIZE = 20

const TASK_LOAD_QUERY_KEY = ['tasks', 'load'] as const

/** 分段控件的取值（Radix 的 `onValueChange` 给的是 `string`，在这里收窄一次）。 */
type TaskView = 'tasks' | 'schedules'

const VIEWS = [
  { value: 'tasks' as const, label: '流水线任务' },
  { value: 'schedules' as const, label: '定时任务' },
]

const STATE_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'pending', label: '排队中' },
  { value: 'running', label: '执行中' },
  { value: 'succeeded', label: '已完成' },
  { value: 'failed', label: '失败' },
  { value: 'canceled', label: '已取消' },
]

const HEALTH_OPTIONS = [
  { value: '', label: '全部健康' },
  { value: 'running', label: '执行中' },
  { value: 'idle', label: '排队中' },
  { value: 'stalled', label: '可能卡住' },
  { value: 'overdue', label: '长时间未执行' },
]

export function TasksPage() {
  const navigate = useNavigate()
  const [view, setView] = useState<TaskView>('tasks')

  const [kb, setKb] = useState('')
  const [state, setState] = useState('')
  const [health, setHealth] = useState('')
  /**
   * 是否把**已取消**的任务也列出来（默认不显示）。
   *
   * 取消是"我不等了"的动作，撤下来的那批会立刻把列表淹掉——实测一次批量撤下
   * 留下 23 行"已取消"。但它们不能永久藏起来（排查时要看得到），
   * 所以给一个显式开关，并在工具栏上如实说明"藏了多少条"。
   */
  const [showCanceled, setShowCanceled] = useState(false)
  const [page, setPage] = useState(1)
  const [detail, setDetail] = useState<TaskSummary | null>(null)
  const [cancelOpen, setCancelOpen] = useState(false)
  const [canceling, setCanceling] = useState(false)
  /**
   * 列表滚到底了没有（决定底部那层渐隐出不出现）。
   * 初值是 `true`：首帧还没量过，宁可不显示——一层渐隐压在最后一行上，
   * 比"该出现时晚半帧"要误导得多。
   */
  const [listAtEnd, setListAtEnd] = useState(true)
  const listRef = useRef<HTMLDivElement | null>(null)

  const isAdmin = useSessionStore((store) => store.currentUser?.role === 'admin')
  const knowledgeBases = useKnowledgeBases()

  const list = useQuery({
    queryKey: TASKS_QUERY_KEY,
    queryFn: () => listTasks(),
    // 轮询的**开与关**由"有没有任务在跑"决定：空闲时不发请求是有意的
    // （旧 `usePolling` 的 `active`），切换标签页看不见时 react-query 自己会停表，
    // 切回来立刻刷一次——这正是旧版 `visibilitychange` 那段的手工活。
    refetchInterval: (query) => tasksRefetchInterval(query.state.data?.items),
    refetchOnWindowFocus: true,
  })

  const running = hasActive(list.data?.items)

  /**
   * 运行负载（§12.115）——**只管理员拉**：这个端点对成员是 403
   * （机器资源与运维参数不给成员看），明知会被拒还发请求只会让控制台多一串红字。
   *
   * 与列表**同一个节拍**（同一个轮询间隔，而不是另起一个计时器）：
   * 两个计时器会让"列表说有 3 个在跑"和面板上"在跑 1"出现在同一帧里对不上，
   * 而这两个数正是要合起来读的（"队列深 + 槽位满"才是结论）。
   */
  const load = useQuery({
    queryKey: TASK_LOAD_QUERY_KEY,
    queryFn: getTaskLoad,
    enabled: isAdmin,
    refetchInterval: running ? POLL_INTERVAL_MS : false,
    // 负载读不到不该影响任务列表：它是解释性的附加信息，而列表才是主体
    // （旧版把这里的异常整个吞掉，这里靠"不渲染错误态"表达同一件事）
    retry: false,
  })

  const tasks = useMemo(() => list.data?.items ?? [], [list.data])
  const error = list.isError ? messageOf(list.error, '任务列表加载失败') : ''
  const loading = list.isLoading

  /** 工具栏上那条提示：藏了多少条（0 就不显示）。 */
  const hiddenCanceled = showCanceled ? 0 : tasks.filter((task) => task.state === 'canceled').length

  const kbOptions = useMemo(
    () => [
      { value: '', label: '全部知识库' },
      ...knowledgeBases.items.map((item) => ({ value: item.id, label: item.name })),
    ],
    [knowledgeBases.items],
  )

  const hasFilter = kb !== '' || state !== '' || health !== '' || showCanceled

  /** 任务量级在几百以内，筛选在客户端做：不必为它再加一版后端查询参数。 */
  const visibleTasks = useMemo(
    () =>
      tasks.filter(
        (task) =>
          (kb === '' || task.knowledge_base_id === kb) &&
          (state === '' || task.state === state) &&
          (health === '' || task.health === health) &&
          // 默认不看已取消；显式选了「已取消」这个状态时当然要显示
          (showCanceled || state === 'canceled' || task.state !== 'canceled'),
      ),
    [tasks, kb, state, health, showCanceled],
  )

  const pageCount = Math.max(1, Math.ceil(visibleTasks.length / PAGE_SIZE))
  const pagedTasks = visibleTasks.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  /** 筛选一变就回第 1 页：否则会停在"新条件下不存在的那一页"上，看起来像列表空了。 */
  useEffect(() => {
    setPage(1)
  }, [kb, state, health, showCanceled])

  // 页数缩了（任务被撤下）之后当前页可能越界，拉回最后一页
  useEffect(() => {
    setPage((current) => Math.min(current, pageCount))
  }, [pageCount])

  /**
   * 换页之后把列表滚回顶部：停在上一页的滚动位置上，第一行会像是被跳过了。
   * **只挂在 `page` 上**——挂 `visibleTasks` 的话，轮询期间任务一变就把用户从
   * 正在看的那几行上拽回顶部。
   */
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0
  }, [page])

  /** 换页或换筛选之后重新量一次列表的滚动位置：内容换了，渐隐该不该出现也跟着变。 */
  useEffect(() => {
    const element = listRef.current
    if (!element) return
    setListAtEnd(scrolledToEnd(element))
  }, [page, visibleTasks])

  const pendingCount = tasks.filter((task) => task.state === 'pending').length

  /**
   * 撤下任务。
   *
   * **逐条结果**：批量里"30 条撤下 28 条"是正常结果（有的刚好跑完了），
   * 所以按成功/失败分别报，并把第一条失败原因带出来——只报总数等于让人自己找。
   */
  async function runCancel(taskIds?: string[]): Promise<void> {
    if (canceling) return
    setCanceling(true)
    setCancelOpen(false)
    try {
      const result = await cancelTasks(taskIds ? { taskIds } : {})
      setDetail(null)
      await list.refetch()
      if (result.failed === 0) {
        notifySuccess(`已撤下 ${result.succeeded} 个任务`)
        return
      }
      const firstError = result.items.find((item) => !item.ok)?.error
      notifyError(
        `撤下：${result.succeeded} 个成功、${result.failed} 个未撤下` +
          (firstError ? `（${firstError}）` : ''),
      )
    } catch (cause) {
      notifyError(messageOf(cause, '取消任务失败'))
    } finally {
      setCanceling(false)
    }
  }

  const clearFilters = () => {
    setKb('')
    setState('')
    setHealth('')
    setShowCanceled(false)
  }

  const refresh = () => {
    void list.refetch()
    if (isAdmin) void load.refetch()
  }

  return (
    <PageShell
      title="任务中心"
      actions={
        // 只有流水线那一段归这两个按钮管：定时任务有它自己的刷新（在面板里）
        view === 'tasks' ? (
          <>
            {running && <StatusTag tone="info" live label="有任务在跑，自动刷新中" />}
            <Button onClick={refresh}>
              <RefreshCw size={14} />
              刷新
            </Button>
          </>
        ) : undefined
      }
    >
      {/*
        页签就是 `@/ui/tabs` 原语本身，一块补丁都不加。

        上一轮这里垫过一对 span（绝对定位的白底 + 手写 `px-3`）：当时 `tokens.css` 的元素重置
        没进 `@layer`，按层叠规则压过 `@layer utilities`，原语自带的
        `data-[state=active]:bg-surface` / `px-3` / `font-medium` 全被吃掉（评审 T1 实测两项一样）。
        根因已修（重置已收进 `@layer base`），垫层随之删掉——当前态现在由**原语自己**画出来：
        `--bg-subtle` 轨道上浮起白色当前项（当前项墨色 `--text-primary`、另一项次级灰
        `--text-secondary`，两边同为 500 字重，差别在**底色 + 字色**，悬停时字色也转墨色）。
        `misc/memory`、`misc/capabilities` 的页签是同一个形状（同一原语、同样不加类）。
      */}
      <Tabs value={view} onValueChange={(next) => setView(next as TaskView)}>
        <TabsList aria-label="任务视图">
          {VIEWS.map((item) => (
            <TabsTrigger key={item.value} value={item.value}>
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {view === 'schedules' ? (
        <div className="page-shell-body">
          <SchedulePanel />
        </div>
      ) : (
        <div className="page-shell-body">
          {/*
            运行负载放在最上面：它解释的是"为什么后台慢"，而那正是用户打开这一页时
            的问题——排在列表下方的话，他要先翻过几十行任务才看得到（管理员专属）。
          */}
          {isAdmin && <LoadPanel load={load.data ?? null} live={running} />}

          {error && <ErrorLine>{error}</ErrorLine>}
          {loading && <SkeletonBlock variant="list" rows={5} />}

          {!loading && tasks.length === 0 && (
            <EmptyState
              title="还没有任务"
              hint="上传文档后会在这里看到探测、解析、切分、向量化各步骤的进展。"
            />
          )}

          {!loading && tasks.length > 0 && (
            <>
              <div className="m-toolbar">
                <div className="m-filter-select">
                  <OptionSelect
                    value={kb}
                    onValueChange={setKb}
                    options={kbOptions}
                    label="按知识库筛选"
                  />
                </div>
                <div className="m-filter-select">
                  <OptionSelect
                    value={state}
                    onValueChange={setState}
                    options={STATE_OPTIONS}
                    label="按状态筛选"
                  />
                </div>
                <div className="m-filter-select">
                  <OptionSelect
                    value={health}
                    onValueChange={setHealth}
                    options={HEALTH_OPTIONS}
                    label="按健康筛选"
                  />
                </div>
                {/* 已取消默认不显示：给一个显式开关，并如实说藏了多少条 */}
                <CheckRow checked={showCanceled} onCheckedChange={setShowCanceled}>
                  显示已取消
                </CheckRow>
                {hiddenCanceled > 0 && (
                  <span className="m-toolbar-note">已隐藏 {hiddenCanceled} 条已取消</span>
                )}
                {hasFilter && (
                  <Button variant="secondary" size="sm" onClick={clearFilters}>
                    清除筛选
                  </Button>
                )}
                {/* 唯一能真正"给队列踩刹车"的地方：几十条 pending 堵着时，
                    逐篇取消文档是做不到的（用户反馈） */}
                {pendingCount > 0 && (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={canceling}
                    onClick={() => setCancelOpen(true)}
                  >
                    取消排队中的任务（{pendingCount}）
                  </Button>
                )}
                <span className="m-toolbar-count tabular">
                  {visibleTasks.length} / {tasks.length} 项
                </span>
              </div>

              <div className="panel">
                {/*
                  表头**逐格对着行内的格子**（评审 T3：原表头 5 格、行内 7 件，且「任务」还带
                  `padding-left: 16px + gap` 去让图标，于是它正好压在每行的类型标签「解析」上，
                  「状态」也比徽章左边缘多出 30px）。
                  现在两边共用同一套列宽：类型列（图标 16 + gap 12 + 标签 56 = 84）、
                  标题列（`flex: 1`，与 `.m-row-main` 同一套负外边距 + 内边距）、
                  状态 84 / 健康 92 / 尝试次数 100 / 更新时间 120——列宽只有一处定义。
                  类型列给了表头「类型」而不是留白：这一列有内容（解析 / 切分 / 向量化），
                  没有表头的话读者只能靠猜它与标题的关系。
                */}
                <div className="panel-head m-list-head" aria-hidden="true">
                  <span className="m-head-kind">类型</span>
                  <span className="m-head-task">任务</span>
                  <span className="m-head-col-status">状态</span>
                  <span className="m-head-col-health">健康</span>
                  <span className="m-head-col-attempts">尝试次数</span>
                  <span className="m-row-time">更新时间</span>
                </div>

                {visibleTasks.length === 0 ? (
                  <p className="m-filter-empty">
                    没有符合筛选条件的任务。换个条件，或点右上角「清除筛选」。
                  </p>
                ) : (
                  /*
                    列表有**确定的高度上限**（8 行 ≈ `--row-height * 8`）并自己滚动
                    （评审 T6：此前整页滚，第 13 行被视口从中间切断，翻页器落到折线以下——
                    "还有多少"看不出来）。定高之后：表头留在面板里不动、翻页器回到首屏、
                    "共 N 项 / 第几页"常显；行数不足 8 行时容器按内容收缩，不留一块空白。
                    行内是按钮（可聚焦），键盘 Tab 到没露出来的那几行时浏览器会自己把这一格
                    滚进来，所以这个滚动容器不需要 `tabIndex` 去抢一个焦点位（§8）。
                    底部那层渐隐只在**下面确实还有没露出来的行**时出现。
                  */
                  <div className="relative">
                    <div
                      ref={listRef}
                      onScroll={(event) => setListAtEnd(scrolledToEnd(event.currentTarget))}
                      className="max-h-[calc(var(--row-height)*8)] overflow-y-auto"
                    >
                      <ul className="m-list">
                        {pagedTasks.map((task) => (
                          <li key={task.id} className="m-list-item">
                            <div className="m-task-row panel-row">
                              <FileText className="m-row-icon" size={16} />
                              <span className="m-row-kind">{taskKindLabel(task.kind)}</span>

                              {/*
                              整行可点是这里最要紧的交互：任务名只有十几个字宽，
                              而"看失败原因"是这一页唯一的深层动作，命中区不该只有一个词那么大。
                              里面是个真 button，所以 Tab 能到、回车能开（§8 键盘可达）。
                              */}
                              <button
                                type="button"
                                className="m-row-main"
                                aria-label={`查看任务详情：${taskKindLabel(task.kind)} ${documentName(task)}`}
                                onClick={() => setDetail(task)}
                              >
                                <span className="m-row-name">{documentName(task)}</span>
                                {needsAttention(task) && (
                                  <span className="m-row-attention">
                                    {attentionText(task)}
                                    <ChevronRight size={12} />
                                  </span>
                                )}
                              </button>

                              {/*
                                状态与健康各自包在**固定列宽**里（`.m-col-status` 84 / `.m-col-health` 92，
                                与表头同宽）：徽章宽度随文案变（「执行中」比「已完成」多一个脉动点），
                                不固定列宽的话后面的列会跟着徽章一起左右挪，表头永远对不上。
                              */}
                              <span className="m-col-status">
                                <StatusTag
                                  label={taskStateView(task.state).label}
                                  tone={taskStateView(task.state).tone}
                                  live={task.state === 'running'}
                                />
                              </span>
                              <span className="m-col-health">{healthCell(task)}</span>
                              <span className="m-row-attempts">{attemptText(task)}</span>
                              <span className="m-row-time">{formatDate(task.updated_at)}</span>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                    {!listAtEnd && (
                      <div
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-[var(--bg-surface)] to-transparent"
                      />
                    )}
                  </div>
                )}
              </div>

              {/* 分页：**总数常显、只藏翻页控件**，与文档列表同一套口径 */}
              {visibleTasks.length > 0 && (
                <div className="m-pager">
                  <span className="m-pager-total">共 {visibleTasks.length} 项</span>
                  {pageCount > 1 && (
                    <div className="m-pager-controls">
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={page <= 1}
                        onClick={() => setPage((current) => Math.max(1, current - 1))}
                      >
                        <ChevronLeft size={14} />
                        上一页
                      </Button>
                      <span className="m-pager-page tabular">
                        第 {page} / {pageCount} 页
                      </span>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={page >= pageCount}
                        onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
                      >
                        下一页
                        <ChevronRight size={14} />
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/*
            任务详情。**为什么必须有个弹窗而不是 title 属性**：失败原因常常是一整段
            （含上游 URL、错误码、JSON 片段），`title` 一移开鼠标就没了，
            也没法选中复制去查——而"拿这段去搜"正是用户下一步要做的事。
          */}
          <Modal
            open={detail !== null}
            title="任务详情"
            onClose={() => setDetail(null)}
            footer={
              detail ? (
                <>
                  <Button onClick={() => setDetail(null)}>关闭</Button>
                  {canCancel(detail) && (
                    <Button
                      variant="destructive"
                      disabled={canceling}
                      onClick={() => void runCancel([detail.id])}
                    >
                      取消这个任务
                    </Button>
                  )}
                  {detail.document_id && (
                    <Button
                      onClick={() => {
                        const documentId = detail.document_id
                        setDetail(null)
                        if (documentId) void navigate(`/documents/${documentId}`)
                      }}
                    >
                      打开文档
                    </Button>
                  )}
                </>
              ) : null
            }
          >
            {detail && (
              <>
                <dl className="m-detail-grid">
                  <div>
                    <dt>任务</dt>
                    <dd>
                      {taskKindLabel(detail.kind)} · {documentName(detail)}
                    </dd>
                  </div>
                  <div>
                    <dt>状态</dt>
                    <dd>{taskStateView(detail.state).label}</dd>
                  </div>
                  <div>
                    <dt>健康</dt>
                    <dd>{detail.health_label}</dd>
                  </div>
                  <div>
                    <dt>尝试次数</dt>
                    <dd className="tabular">{attemptText(detail)}</dd>
                  </div>
                  <div>
                    <dt>创建</dt>
                    <dd>{formatDate(detail.created_at)}</dd>
                  </div>
                  <div>
                    <dt>更新</dt>
                    <dd>{formatDate(detail.updated_at)}</dd>
                  </div>
                  {detail.lease_expires_at && (
                    <div>
                      <dt>租约到期</dt>
                      <dd>{formatDate(detail.lease_expires_at)}</dd>
                    </div>
                  )}
                </dl>

                {/* 原因单独成块：它是这个弹窗里唯一需要**读**的东西 */}
                {(detail.error || detail.health_detail) && (
                  <>
                    <h3 className="m-block-title">
                      {detail.state === 'failed' ? '失败原因' : '健康判据说明'}
                    </h3>
                    <pre className="m-detail-error">{detail.error || detail.health_detail}</pre>
                  </>
                )}

                <p className="m-detail-id">
                  任务 ID <code>{detail.id}</code>。排查日志时用它去搜。
                </p>
              </>
            )}
          </Modal>

          {/* 批量撤下要二次确认：这是"把几十篇的处理全叫停"，点错了代价不小。
              文案里说清"文档不会被删/不会变状态"，因为那正是用户担心的 */}
          <ConfirmDialog
            open={cancelOpen}
            title="取消排队中的任务"
            lead={`撤下 ${pendingCount} 个还在排队的任务？`}
            note="只是不再处理：文档与已入库内容都保留，之后可重新上传或点「重新摄入」。正在执行的任务不在此列。"
            confirmLabel="撤下"
            busy={canceling}
            onCancel={() => setCancelOpen(false)}
            onConfirm={() => void runCancel()}
          />
        </div>
      )}
    </PageShell>
  )
}

function hasActive(items: TaskSummary[] | undefined): boolean {
  return (items ?? []).some((task) => task.state === 'pending' || task.state === 'running')
}

/**
 * 滚动容器到底了没有。留 4px 容差：浏览器在小数行高/缩放下报的 `scrollHeight`
 * 常比"最后一行正好露完"多零点几像素，不留容差会让渐隐在到底之后还赖着不走。
 */
function scrolledToEnd(element: HTMLElement): boolean {
  return element.scrollTop + element.clientHeight >= element.scrollHeight - 4
}

/**
 * 轮询间隔：**只在有任务在跑时才开**（空闲时不发请求是有意的，§12.116）。
 *
 * 抽成纯函数导出，是让这条口径能被用例钉住——它正是"别把轮询丢了"那件事本身。
 */
export function tasksRefetchInterval(items: TaskSummary[] | undefined): number | false {
  return hasActive(items) ? POLL_INTERVAL_MS : false
}

function documentName(task: TaskSummary): string {
  if (!task.document_id) return '—'
  // 后端解析好的名字；理论上不会为空，为空时退回 id 而不是显示空白
  return task.document_name || task.document_id
}

/**
 * 尝试次数：**成功也照实显示"1 / 5"**，不再换成"一次通过"。
 *
 * 原来成功行写"一次通过"、其余写"第 N / M 次尝试"，同一列出现两种句式，
 * 列头叫「尝试」却读不出它到底是次数还是结论。统一成次数之后这一列只有一个含义。
 */
function attemptText(task: TaskSummary): string {
  return `${task.attempts} / ${task.max_attempts}`
}

/**
 * 健康列这一格的内容。
 *
 * **只有"成功"这一档不写字**：后端在 `succeeded` 那档给的 label 正是「已完成」，
 * 与左边状态列逐字相同——同一行两个徽章说同一件事，一个字的新判断都没有（评审 T2）。
 * 所以那一档退成一个不带词的中性标记。
 *
 * 判定必须按 `state === 'succeeded'`：**失败与已取消同样落在 `health === 'done'`**
 * （后端把三种都算终态），而它们的 label（已失败 / 已取消）恰恰是这一列存在的意义
 * ——失败要有可读的文字出口，不能跟着一起吞掉。
 *
 * 标记不带词，但不能没有名字：列头是 `aria-hidden` 的，读屏器只能靠 `aria-label`
 * 知道这一格是什么。`role="img"` 是让那个名字真的被读出来——`generic` 角色上的
 * `aria-label` 按 ARIA 规范不参与命名。
 */
function healthCell(task: TaskSummary) {
  if (task.state === 'succeeded' && task.health === 'done') {
    return (
      <span className="m-row-health-done" role="img" aria-label="健康">
        —
      </span>
    )
  }
  // 其余各档逐字显示后端给的标签（执行中 / 排队中 / 可能卡住 / 长时间未执行 / 已失败 / 已取消）
  if (task.health === 'done') {
    return <span className="m-row-health-done">{task.health_label}</span>
  }
  return <StatusTag label={task.health_label} tone={taskHealthTone(task.health)} />
}

/** 行上是否需要招人注意：**失败**与**卡住/逾期**都要，但原因不同，所以文案分开。 */
function needsAttention(task: TaskSummary): boolean {
  return task.state === 'failed' || isTaskProblem(task.health)
}

/**
 * 行尾那句提示。失败与卡住是两回事：失败得看原因（详情弹窗里有）；
 * 卡住/逾期得看运维（重启服务、检查 worker）。合成一句"有问题"会让人不知道找谁。
 */
function attentionText(task: TaskSummary): string {
  if (task.state === 'failed') return '查看失败原因'
  if (task.health === 'stalled') return '可能卡住，查看详情'
  if (task.health === 'overdue') return '长时间未执行，查看详情'
  return ''
}

/** 单个任务能否取消：只有还没结束的两种状态可以（与后端口径一致）。 */
function canCancel(task: TaskSummary | null): boolean {
  return task !== null && (task.state === 'pending' || task.state === 'running')
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}
