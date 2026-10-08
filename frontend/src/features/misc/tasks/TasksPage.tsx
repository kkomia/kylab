/**
 * 定时任务（《前端设计规范》§6）——路由 `/tasks` 上的一页。
 *
 * 一页一件事：**这台机器上按计划自己跑的那些对话**（列表 + 新建 / 改 / 删 / 立即跑一次，
 * 都在 `SchedulePanel` 里）。
 *
 * ## 2026-10-09：这一页只剩定时任务
 *
 * 原先这里是**两段**：「流水线任务」（知识库服务端的入库任务列表，数据走远端 `/tasks`）
 * 与「定时任务」。知识库服务端已经从本产品剥走（界面搬去 kybase），那段列表——表格、
 * 三个过滤器（知识库 / 状态 / 健康）、「显示已取消」、分页、计数（`N / M 项`）、
 * 详情弹窗与批量撤下，以及只为它服务的 `api/tasks.ts`
 * （`listTasks` / `cancelTasks` / `TaskSummary`…）与 `shared/status.ts`——
 * 按用户要求整块下掉（"这个产品里没有它的位置，整个下掉"）。
 *
 * 三处跟着改的地方，别把它们当可选项：
 * 1. **标签切换器一并去掉**（只剩一个内容就不需要有标签）。页头那颗「刷新」也一起去掉
 *    ——它只服务流水线列表（那一段的轮询开关也在它身上）；定时任务有它自己那一颗，
 *    在 `SchedulePanel` 的工具栏里；
 * 2. **路由路径 `/tasks` 不变**（书签不炸），但侧栏项、`app/App.tsx` 的标题表与这一页的
 *    页头都改叫「定时任务」；
 * 3. 「没有本机后端 ⇒ 只剩流水线那一段」这条分支**没有了**：这一页现在整页属于本机档，
 *    而没有本机后端时门禁（`app/App.tsx::LocalBackendGate`）已经把整壳换成
 *    「本机后端未启动」那一页——所以这里**不需要第二道判据**（原先那道 `views` 过滤
 *    就是为流水线那一段留的）。
 */
import { PageShell } from '../shared/composites'
import { SchedulePanel } from './SchedulePanel'

export function TasksPage() {
  return (
    <PageShell title="定时任务">
      <div className="page-shell-body">
        <SchedulePanel />
      </div>
    </PageShell>
  )
}
