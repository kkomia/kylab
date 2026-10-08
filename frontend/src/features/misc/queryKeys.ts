/**
 * misc 域里**被两处以上共用**的查询键（纯值，**不 import 任何页面模块**）。
 *
 * 为什么单独一个文件：`prewarm.ts`（启动后空闲预热）也要用它们，而它一旦**静态 import**
 * 页面模块（`TasksPage` / `SchedulePanel`），那一页的**动态 import 就失效**——构建期会报
 * `INEFFECTIVE_DYNAMIC_IMPORT`，那一页连同它的依赖被打进主 chunk，
 * 首屏白多几十 KB（实测踩到：预演构建时冒出来，见开发计划 §12.247）。
 *
 * 纪律：**只放值**（字符串/数字/只读数组）。放函数或组件进来，就等于把这条纪律重新破坏掉。
 *
 * 2026-10-09：「流水线任务」那一段（`/tasks` 列表）随知识库服务端剥走而下线，
 * `TASKS_QUERY_KEY` 一并删掉——现在这一份只剩定时任务那一条。
 */

/** 定时任务：列表（`SchedulePanel` 与 `prewarm.ts` 共用同一个键）。 */
export const SCHEDULES_QUERY_KEY = ['scheduled-tasks'] as const
