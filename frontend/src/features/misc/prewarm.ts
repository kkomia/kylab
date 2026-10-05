/**
 * 启动后的**空闲预热**（旧 `SideNav.vue` 的 idle 预热口径；审计 F18 的最后一截）。
 *
 * 旧版在启动后把"最可能被点的两页"的数据先拉回来：任务列表与概览的统计
 * （外加模型注册表）。新版此前只有 hover 预热（导航项/hover 会话行），
 * 于是**直接点**「任务中心」或「概览」时还要等一次往返——观感上就是"点进去先空白一下"。
 *
 * 三点纪律：
 * 1. **只在空闲时做**（`requestIdleCallback`，没有就退化成 `setTimeout(0)`）：
 *    预热不能跟首屏抢带宽与主线程；
 * 2. **失败静默**：预热不是功能。真正进页该报的错由那一页自己报；
 * 3. **键与页面共用同一份常量**：都从 `queryKeys.ts` 取（纯值模块）。**不能从页面模块
 *    import**——那会让那两个页面的动态 import 失效（构建期 `INEFFECTIVE_DYNAMIC_IMPORT`，
 *    两页被打进主 chunk，首屏白白变大；实测踩到过）。
 *
 * 与页面的关系是**单向的**：这里 import 纯值常量与 api，页面不 import 这个文件。
 *
 * ## 预热的东西也得**这一档真在服务**（2026-10-05，NAS 网页端退役）
 *
 * 定时任务那一族（`/scheduled-tasks`）只挂在本机档上（`backend/app/api/v1/router.py`），
 * 而任务中心里那一段也按同一个判据藏掉了（`features/misc/tasks/TasksPage.tsx`）——
 * 没有本机后端的那一份界面里，这一条预热**没有任何页面会用到它**：预热本来就"失败静默"，
 * 看不出来它白打了一趟 404，而它每次启动都打。
 */
import type { QueryClient } from '@tanstack/react-query'

import { localBackendPresent } from '@/api/local'
import { getDashboard, getUsage } from '@/api/stats'
import { listScheduledTasks } from '@/api/schedules'
import { listTasks } from '@/api/tasks'
import {
  DASHBOARD_WINDOW_DAYS,
  SCHEDULES_QUERY_KEY,
  TASKS_QUERY_KEY,
  USAGE_WINDOW_DAYS,
} from '@/features/misc/queryKeys'

/** 空闲时拉回"最可能被点的两页"的数据。调用方只管调，不等它。 */
export function prewarmMisc(client: QueryClient): void {
  const jobs: Array<Promise<unknown>> = [
    client.prefetchQuery({
      queryKey: ['stats', 'dashboard', DASHBOARD_WINDOW_DAYS],
      queryFn: () => getDashboard(DASHBOARD_WINDOW_DAYS),
    }),
    client.prefetchQuery({
      queryKey: ['stats', 'usage', USAGE_WINDOW_DAYS],
      queryFn: () => getUsage(USAGE_WINDOW_DAYS),
    }),
    client.prefetchQuery({ queryKey: TASKS_QUERY_KEY, queryFn: () => listTasks() }),
  ]
  // 定时任务只在本机档服务（见文件头）：没有本机后端时这一条**不排**，那一趟必然 404
  if (localBackendPresent()) {
    jobs.push(client.prefetchQuery({ queryKey: SCHEDULES_QUERY_KEY, queryFn: listScheduledTasks }))
  }
  for (const job of jobs) void job.catch(() => undefined)
}

/** 在浏览器空闲时跑（jsdom/Safari 没有 `requestIdleCallback` 时退化成 `setTimeout`）。 */
export function onIdle(task: () => void): void {
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void) => number })
    .requestIdleCallback
  if (typeof idle === 'function') idle(task)
  else setTimeout(task, 0)
}
