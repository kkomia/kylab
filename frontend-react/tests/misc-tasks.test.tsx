/**
 * 任务中心（旧 `views/TasksView.vue`）的用例。
 *
 * 覆盖三件最容易在迁移里丢掉的事：
 * 1. **健康列不是装饰**——失败/卡住要有可读的文字出口，而不是只靠一个颜色；
 * 2. **缓存口径**：轮询失败时列表**保留上一次的数据**（旧 store 的 SWR 语义），
 *    只有错误提示出现；
 * 3. **批量撤下的逐条结果**：部分成功要分开报，并把第一条失败原因带出来。
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/tasks', () => ({
  listTasks: vi.fn(),
  getTaskLoad: vi.fn(),
  cancelTasks: vi.fn(),
}))

vi.mock('@/api/knowledgeBases', () => ({
  listKnowledgeBases: vi.fn(async () => ({
    items: [{ id: 'kb-1', name: '产品手册' }],
  })),
}))

vi.mock('@/api/schedules', () => ({
  listScheduledTasks: vi.fn(),
  createScheduledTask: vi.fn(),
  updateScheduledTask: vi.fn(),
  deleteScheduledTask: vi.fn(),
  runScheduledTaskNow: vi.fn(),
}))

import {
  listScheduledTasks,
  runScheduledTaskNow,
  updateScheduledTask,
  type ScheduledTask,
} from '@/api/schedules'
import { cancelTasks, getTaskLoad, listTasks, type TaskSummary } from '@/api/tasks'
import { renderMisc } from '@/features/misc/testing/harness'
import { resetToasts } from '@/features/misc/shared/toast'
import { TasksPage, tasksRefetchInterval } from '@/features/misc/tasks/TasksPage'
import { useSessionStore } from '@/lib/session'

const listTasksMock = vi.mocked(listTasks)
const getTaskLoadMock = vi.mocked(getTaskLoad)
const cancelTasksMock = vi.mocked(cancelTasks)
const listSchedulesMock = vi.mocked(listScheduledTasks)
const runScheduleNowMock = vi.mocked(runScheduledTaskNow)
const updateScheduleMock = vi.mocked(updateScheduledTask)

function schedule(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'sch-1',
    name: '每日早报',
    prompt: '把昨天的构建日志汇总成三条结论',
    kind: 'cron',
    cron: '0 9 * * *',
    run_at: null,
    next_run_at: '2026-09-24T01:00:00Z',
    enabled: true,
    kb_ids: [],
    conversation_id: 'conv-1',
    last_run_at: '2026-09-23T01:00:00Z',
    last_status: 'ok',
    last_error: '',
    run_count: 3,
    schedule_text: '每天 09:00',
    created_at: null,
    updated_at: null,
    ...overrides,
  }
}

function task(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: 'task-1',
    kind: 'parse',
    state: 'running',
    document_id: 'doc-1',
    knowledge_base_id: 'kb-1',
    document_name: '手册.pdf',
    attempts: 1,
    max_attempts: 5,
    error: null,
    next_run_at: null,
    lease_expires_at: null,
    created_at: '2026-09-23T10:00:00Z',
    updated_at: '2026-09-23T10:02:00Z',
    health: 'running',
    health_label: '执行中',
    health_detail: '正在解析第 3 页',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetToasts()
  useSessionStore.setState({ token: '', currentUser: null, authStatus: null, reloginCount: 0 })
  listTasksMock.mockResolvedValue({ items: [task()] })
  getTaskLoadMock.mockRejectedValue(new Error('403'))
  listSchedulesMock.mockResolvedValue({ items: [schedule()], timezone: 'CST UTC+08:00' })
})

describe('任务中心', () => {
  it('列出任务并显示健康判据与尝试次数（失败行给出可读出口）', async () => {
    listTasksMock.mockResolvedValue({
      items: [
        task(),
        task({
          id: 'task-2',
          kind: 'embed',
          state: 'failed',
          document_name: '年报.docx',
          attempts: 3,
          error: 'upstream 502: {"detail":"bad gateway"}',
          health: 'stalled',
          health_label: '可能卡住',
          health_detail: '租约已过期',
        }),
      ],
    })

    renderMisc(<TasksPage />)

    expect(
      await screen.findByRole('button', { name: /查看任务详情：解析 手册.pdf/ }),
    ).toBeInTheDocument()
    // 健康列的文字是后端给的判定结论（前端不再翻译一遍）。
    // 按列表范围查：筛选下拉里也有一个同名的选项，全局查会撞上两处
    expect(within(screen.getByRole('list')).getByText('可能卡住')).toBeInTheDocument()
    // 尝试次数统一成"次数"口径：成功也照实显示 1 / 5，不换成"一次通过"
    expect(screen.getByText('3 / 5')).toBeInTheDocument()
    // 失败行必须给一个**文字**出口（红点在黑白截图里就不见了）
    // 行尾给一句**可操作**的提示：失败与卡住要找的人不同，所以分开说
    expect(screen.getByText('查看失败原因')).toBeInTheDocument()
  })

  it('点开详情用 pre 显示失败原文（可选中复制，而不是 title 属性）', async () => {
    listTasksMock.mockResolvedValue({
      items: [
        task({
          state: 'failed',
          error: 'upstream 502: {"detail":"bad gateway"}',
          health: 'done',
          health_label: '已结束',
          health_detail: '任务已结束',
        }),
      ],
    })

    renderMisc(<TasksPage />)
    await userEvent.click(await screen.findByRole('button', { name: /查看任务详情/ }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('失败原因')).toBeInTheDocument()
    expect(within(dialog).getByText(/"detail":"bad gateway"/)).toBeInTheDocument()
    expect(within(dialog).getByText('task-1')).toBeInTheDocument()
  })

  it('轮询只在有任务在跑时开着（空闲时不发请求是有意的）', () => {
    expect(tasksRefetchInterval([task({ state: 'running' })])).toBe(2000)
    expect(tasksRefetchInterval([task({ state: 'pending' })])).toBe(2000)
    expect(tasksRefetchInterval([task({ state: 'succeeded' })])).toBe(false)
    expect(tasksRefetchInterval([])).toBe(false)
  })

  it('刷新失败时保留上一次的列表（缓存口径与旧 store 的 SWR 一致）', async () => {
    const { client } = renderMisc(<TasksPage />)
    expect(await screen.findByText('手册.pdf')).toBeInTheDocument()

    listTasksMock.mockRejectedValueOnce(new Error('后端不可达'))
    await client.refetchQueries({ queryKey: ['tasks', 'list'] })

    expect(await screen.findByText('后端不可达')).toBeInTheDocument()
    // 旧数据**不消失**：只有错误提示出现（这是旧 store 刻意保留的口径）
    expect(screen.getByText('手册.pdf')).toBeInTheDocument()
  })

  it('批量撤下排队任务：确认后按成功/失败分别报，并带出第一条失败原因', async () => {
    listTasksMock.mockResolvedValue({
      items: [task({ id: 'p1', state: 'pending', health: 'idle', health_label: '排队中' })],
    })
    cancelTasksMock.mockResolvedValue({
      succeeded: 1,
      failed: 1,
      items: [
        { task_id: 'p1', ok: true, error: null },
        { task_id: 'p2', ok: false, error: '任务已经开始执行' },
      ],
    })

    renderMisc(<TasksPage />)
    await userEvent.click(await screen.findByRole('button', { name: /取消排队中的任务（1）/ }))

    const dialog = await screen.findByRole('alertdialog')
    // @/ui/alert-dialog：确认框不是 dialog 而是 alertdialog（Esc / 点遮罩都不关）
    expect(dialog).toHaveAttribute('data-slot', 'alert-dialog-content')
    await userEvent.click(within(dialog).getByRole('button', { name: '撤下' }))

    await waitFor(() => expect(cancelTasksMock).toHaveBeenCalledWith({}))
    expect(
      await screen.findByText(/撤下：1 个成功、1 个未撤下（任务已经开始执行）/),
    ).toBeInTheDocument()
  })

  it('管理员才看得到运行负载面板（端点在成员那里是 403）', async () => {
    getTaskLoadMock.mockResolvedValue({
      hardware: {
        cpu_percent: null,
        cpu_count: 8,
        memory_used_bytes: 1024,
        memory_total_bytes: 2048,
        memory_percent: 50,
        process_rss_bytes: null,
      },
      queue: {
        running: 0,
        pending: 0,
        slots: 1,
        pending_by_kind: {},
        oldest_pending_seconds: null,
        stalled: 0,
        overdue: 0,
      },
      quota: {
        parser_name: 'mineru',
        configured: false,
        pages_used: 0,
        calls: 0,
        daily_quota: 0,
        remaining: 0,
        exhausted: false,
      },
      sampled_at: '2026-09-23T10:00:00Z',
    })

    const { unmount } = renderMisc(<TasksPage />)
    await screen.findByText('手册.pdf')
    expect(screen.queryByLabelText('运行负载')).not.toBeInTheDocument()
    unmount()

    useSessionStore.setState({
      token: 'st',
      currentUser: { id: 'u1', username: 'admin', name: '管理员', role: 'admin', avatar_url: '' },
    })
    renderMisc(<TasksPage />)

    expect(await screen.findByLabelText('运行负载')).toBeInTheDocument()
    // CPU 的 null 显示"—"而不是 0%（后端首次采样没有差值可算）
    expect(await screen.findByText('8 核 · 采样中')).toBeInTheDocument()
  })
})

describe('定时任务分段', () => {
  it('显示服务器时区、上一轮结论与下次时间（"下次几点"只能靠它，猜错的代价是它在你睡觉时跑）', async () => {
    renderMisc(<TasksPage />)
    // 分段控件已经是 @/ui/tabs（Radix）：role=tab 由库给，键盘左右键也能切
    const tab = await screen.findByRole('tab', { name: '定时任务' })
    expect(tab).toHaveAttribute('data-slot', 'tabs-trigger')
    await userEvent.click(tab)

    expect(await screen.findByText('每日早报')).toBeInTheDocument()
    expect(screen.getByText(/时间按服务器时区（CST UTC\+08:00）计算/)).toBeInTheDocument()
    expect(screen.getByText('每天 09:00')).toBeInTheDocument()
    expect(screen.getByText(/上次跑成了（/)).toBeInTheDocument()
    expect(screen.getByText(/下次 2026-09-24/)).toBeInTheDocument()
    expect(screen.getByText('跑过 3 次')).toBeInTheDocument()
  })

  it('「立即跑一次」只入队（不动调度字段），「停用」改的是 enabled', async () => {
    runScheduleNowMock.mockResolvedValue({ task_id: 't1', detail: '已入队' })
    listSchedulesMock
      .mockResolvedValueOnce({ items: [schedule()], timezone: 'CST UTC+08:00' })
      .mockResolvedValue({ items: [schedule({ enabled: false })], timezone: 'CST UTC+08:00' })
    updateScheduleMock.mockResolvedValue(schedule({ enabled: false }))

    renderMisc(<TasksPage />)
    await userEvent.click(await screen.findByRole('tab', { name: '定时任务' }))

    await userEvent.click(await screen.findByRole('button', { name: '立即跑一次' }))
    await waitFor(() => expect(runScheduleNowMock).toHaveBeenCalledWith('sch-1'))
    // 只是入队：调度字段一个字都没改
    expect(updateScheduleMock).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: '停用' }))
    await waitFor(() =>
      expect(updateScheduleMock).toHaveBeenCalledWith('sch-1', { enabled: false }),
    )
  })
})
