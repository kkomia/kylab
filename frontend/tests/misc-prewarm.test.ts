/**
 * 空闲预热（`features/misc/prewarm.ts`）**按档取舍**（2026-10-05，NAS 网页端退役）。
 *
 * 这一份钉的是一件很轻、但每次启动都会发生的事：那几条 `prefetchQuery` 里，
 * **定时任务**（`/scheduled-tasks`）只挂在本机档上——服务器档没有这条路径，
 * 于是没有本机后端时那一条必然 404。而这正是最容易漏掉的那类请求：
 * 预热**失败静默**（它本来就不是功能），所以 404 不会有人看见，只会白打一趟。
 *
 * 判据用的是同一个（`api/local.ts`），这里逐档摆答案（`setLocalBackendForTest`）——
 * 判据本身的三态在 `tests/unit/api/local.test.ts` 那一份里，不在这里重复。
 */
import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/schedules', () => ({ listScheduledTasks: vi.fn() }))
vi.mock('@/api/stats', () => ({ getDashboard: vi.fn(), getUsage: vi.fn() }))
vi.mock('@/api/tasks', () => ({ listTasks: vi.fn() }))

import { resetLocalBackendForTest, setLocalBackendForTest } from '@/api/local'
import { listScheduledTasks } from '@/api/schedules'
import { getDashboard, getUsage } from '@/api/stats'
import { listTasks } from '@/api/tasks'
import { prewarmMisc } from '@/features/misc/prewarm'
import { SCHEDULES_QUERY_KEY } from '@/features/misc/queryKeys'

const listSchedulesMock = vi.mocked(listScheduledTasks)
const listTasksMock = vi.mocked(listTasks)
const getDashboardMock = vi.mocked(getDashboard)
const getUsageMock = vi.mocked(getUsage)

function testClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

beforeEach(() => {
  vi.clearAllMocks()
  listSchedulesMock.mockResolvedValue({ items: [], timezone: 'CST UTC+08:00' })
  listTasksMock.mockResolvedValue({ items: [] } as never)
  getDashboardMock.mockResolvedValue({} as never)
  getUsageMock.mockResolvedValue({} as never)
})

afterEach(() => {
  // 模块级单份状态：不复位会串到下一条用例（表现是"档位时有时无"）
  resetLocalBackendForTest()
})

describe('空闲预热按档取舍', () => {
  it('没有本机后端：定时任务那一条**不排**（其余照旧预热）', async () => {
    setLocalBackendForTest('absent')
    const client = testClient()

    prewarmMisc(client)
    // 先等预热那几条真发出去（`prefetchQuery` 是异步的），再核"少的那一条"
    await vi.waitFor(() => expect(listTasksMock).toHaveBeenCalled())

    expect(listSchedulesMock).not.toHaveBeenCalled()
    expect(client.getQueryState(SCHEDULES_QUERY_KEY)).toBeUndefined()
    // 少的是那一条，不是整个预热：另外三条一条都没少
    expect(getDashboardMock).toHaveBeenCalled()
    expect(getUsageMock).toHaveBeenCalled()
    expect(listTasksMock).toHaveBeenCalledTimes(1)
  })

  it('有本机后端（桌面壳）：一条都不少', async () => {
    setLocalBackendForTest('local')
    const client = testClient()

    prewarmMisc(client)

    await vi.waitFor(() => expect(listSchedulesMock).toHaveBeenCalledTimes(1))
    expect(client.getQueryState(SCHEDULES_QUERY_KEY)).toBeDefined()
    expect(listTasksMock).toHaveBeenCalledTimes(1)
  })
})
