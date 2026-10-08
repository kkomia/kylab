/**
 * 空闲预热（`features/misc/prewarm.ts`）**按档取舍**（2026-10-05，NAS 网页端退役）。
 *
 * 这一份钉的是一件很轻、但每次启动都会发生的事：那条 `prefetchQuery` 里，
 * **定时任务**（`/scheduled-tasks`）只挂在本机档上（`backend/app/api/v1/router.py`）——
 * 没有本机后端时它必然 404，而预热**失败静默**（它本来就不是功能），
 * 所以 404 不会有人看见，只会白打一趟。
 *
 * 判据用的是同一个（`api/local.ts`），这里逐档摆答案（`setLocalBackendForTest`）——
 * 判据本身的三态在 `tests/unit/api/local.test.ts` 那一份里，不在这里重复。
 *
 * 2026-10-09：「流水线任务」那一条预热（`/tasks` 的列表，连带它那套"先等提供者结论再判档"
 * 的逻辑）随「流水线任务」那一段一起下掉了——这一份现在只剩定时任务这一条，
 * 也不再认识"知识库提供者"。
 */
import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/schedules', () => ({ listScheduledTasks: vi.fn() }))

import { resetLocalBackendForTest, setLocalBackendForTest } from '@/api/local'
import { listScheduledTasks } from '@/api/schedules'
import { prewarmMisc } from '@/features/misc/prewarm'
import { SCHEDULES_QUERY_KEY } from '@/features/misc/queryKeys'

const listSchedulesMock = vi.mocked(listScheduledTasks)

function testClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

beforeEach(() => {
  vi.clearAllMocks()
  listSchedulesMock.mockResolvedValue({ items: [], timezone: 'CST UTC+08:00' })
})

afterEach(() => {
  // 模块级单份状态（`api/local.ts`）：不复位会串到下一条用例（表现是"档位时有时无"）
  resetLocalBackendForTest()
})

describe('空闲预热按档取舍', () => {
  it('没有本机后端：定时任务那一条**不排**（那一趟必然 404，而预热失败静默）', async () => {
    setLocalBackendForTest('absent')
    const client = testClient()

    prewarmMisc(client)
    // 给它机会：真要是排了，这一条会在这段时间里落地
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(listSchedulesMock).not.toHaveBeenCalled()
    expect(client.getQueryState(SCHEDULES_QUERY_KEY)).toBeUndefined()
  })

  it('有本机后端（桌面壳）：那一条排上，并按它与面板共用的那个键缓存', async () => {
    setLocalBackendForTest('local')
    const client = testClient()

    prewarmMisc(client)

    await vi.waitFor(() => expect(listSchedulesMock).toHaveBeenCalledTimes(1))
    expect(client.getQueryState(SCHEDULES_QUERY_KEY)).toBeDefined()
  })
})
