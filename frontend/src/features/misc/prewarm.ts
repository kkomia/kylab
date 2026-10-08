/**
 * 启动后的**空闲预热**（旧 `SideNav.vue` 的 idle 预热口径；审计 F18 的最后一截）。
 *
 * 旧版在启动后把"最可能被点的那一页"的数据先拉回来；新版原本只有 hover 预热
 * （导航项/hover 会话行），于是**直接点**某一页时还要等一次往返——观感上就是
 * "点进去先空白一下"。现在这里只剩**一条**：定时任务列表。
 *
 * 三点纪律：
 * 1. **只在空闲时做**（`requestIdleCallback`，没有就退化成 `setTimeout(0)`）：
 *    预热不能跟首屏抢带宽与主线程；
 * 2. **失败静默**：预热不是功能。真正进页该报的错由那一页自己报；
 * 3. **键与页面共用同一份常量**：都从 `queryKeys.ts` 取（纯值模块）。**不能从页面模块
 *    import**——那会让那一页的动态 import 失效（构建期 `INEFFECTIVE_DYNAMIC_IMPORT`，
 *    它被打进主 chunk，首屏白白变大；实测踩到过）。
 *
 * 与页面的关系是**单向的**：这里 import 纯值常量与 api，页面不 import 这个文件。
 *
 * ## 预热的东西也得**这一档真在服务**
 *
 * 定时任务那一族（`/scheduled-tasks`）只挂在本机档上（`backend/app/api/v1/router.py`），
 * 所以这一条挂在 `localBackendPresent()` 上：没有本机后端时**不排**——那一趟必然 404，
 * 而预热"失败静默"，看不出来它白打了一趟，偏偏每次启动都打。
 *
 * ## 2026-10-09：原先的"先等提供者结论再判档"整段作废
 *
 * 那一段（`await loadProviderStatus()` → `providerGateApplies()` / `providerView().ready`）
 * 只服务**流水线任务**那一条预热（`/tasks` 数的是知识库那边的家当，没接上时必然 404）。
 * 知识库服务端剥走、任务中心那一段下掉之后，这条预热与那套判据一起删了：
 * 现在这个文件不再认识"知识库提供者"。
 */
import type { QueryClient } from '@tanstack/react-query'

import { localBackendPresent } from '@/api/local'
import { listScheduledTasks } from '@/api/schedules'
import { SCHEDULES_QUERY_KEY } from '@/features/misc/queryKeys'

/** 空闲时拉回"最可能被点的那一页"的数据。调用方只管调，不等它。 */
export function prewarmMisc(client: QueryClient): void {
  // 定时任务只在本机档服务（见文件头）：没有本机后端时这一条**不排**，那一趟必然 404
  if (!localBackendPresent()) return
  void client
    .prefetchQuery({ queryKey: SCHEDULES_QUERY_KEY, queryFn: listScheduledTasks })
    .catch(() => undefined)
}

/** 在浏览器空闲时跑（jsdom/Safari 没有 `requestIdleCallback` 时退化成 `setTimeout`）。 */
export function onIdle(task: () => void): void {
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void) => number })
    .requestIdleCallback
  if (typeof idle === 'function') idle(task)
  else setTimeout(task, 0)
}
