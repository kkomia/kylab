/**
 * 定时任务（`/tasks` 那一页）的用例。
 *
 * 这一页 2026-10-09 起只做一件事：**这台机器上按计划自己跑的那些对话**。
 * 原先的「流水线任务」那一段（知识库服务端的入库任务列表：表格 / 健康列 / 三个过滤器 /
 * 「显示已取消」/ 分页 / 计数 / 详情弹窗 / 批量撤下 / 页签原语）随知识库服务端剥走整块
 * 下掉，它的十条用例一并删掉——那段历史写在 `TasksPage.tsx` 的文件头里，
 * 回来查"为什么要下掉"看那里。
 *
 * 留在这里的是两件"定时任务这一步会发生什么"：
 * 1. 列表把**服务器时区 / 上一轮结论 / 下次时间**说清（"下次几点"只能靠它，
 *    猜错的代价是它在你睡觉时跑）；
 * 2. 「立即跑一次」只入队（调度字段一个字都不改），「停用」改的是 `enabled`。
 */
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// 新建 / 编辑那条路上要选"带上哪几个知识库"（`ScheduleDialog` 读它）。
// 这一份用例不打开那个弹窗，摆一份空清单只是别让漏出来的那条读打到真网络。
vi.mock('@/api/knowledgeBases', () => ({
  listKnowledgeBases: vi.fn(async () => ({ items: [] })),
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
import { renderMisc } from '@/features/misc/testing/harness'
import { resetToasts } from '@/features/misc/shared/toast'
import { TasksPage } from '@/features/misc/tasks/TasksPage'

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

beforeEach(() => {
  vi.clearAllMocks()
  resetToasts()
  listSchedulesMock.mockResolvedValue({ items: [schedule()], timezone: 'CST UTC+08:00' })
})

describe('定时任务', () => {
  it('显示服务器时区、上一轮结论与下次时间（"下次几点"只能靠它，猜错的代价是它在你睡觉时跑）', async () => {
    renderMisc(<TasksPage />)

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
    await screen.findByText('每日早报')

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
