/**
 * 「这一份界面上，当前这个人是不是管理员」——**全仓唯一的判据**。
 *
 * ## 为什么不能只按账号判（用户报过两次的 bug）
 *
 * 本机档**没有账号体系**：`/auth/*` 一族根本不挂在边车的 `local_router` 上
 * （`backend/app/api/v1/router.py`），门禁（`app/App.tsx::LocalBackendGate`）在
 * "有本机后端"时直接放行、一个字都不问（2026-10-08 起；此前那版要先问远端账号体系），
 * 于是这一档 `useSessionStore(s => s.currentUser)` **恒为 null**。
 * 而后端起给这一档那个唯一调用主体的名字是「本机主人」，它的记录里
 * `is_admin=True` / `role=UserRole.ADMIN`（`backend/app/services/api_key.py::LOCAL_CALLER`）
 * ——**本机主人就是这台机器的管理员**。
 *
 * 所以按"有没有登录"判，会把这一档的管理员入口**一并藏掉**（用户 2026-10-05 报了两次：
 * 侧栏左下角「设置」不见了——`AccountMenu` 那一条已按同一口径修过；
 * 输入框那一排的「权限」胶囊不见了）。
 *
 * ## 判据（每条都在这里说清）
 *
 * 1. **有账号** → 按账号的角色（`role === 'admin'`）；
 * 2. **没有账号** → 按**这一份界面有没有本机后端**（`api/local.ts::useLocalBackend`，
 *    那个判据只有它一处）：有（本机档）就是管理员。没有的那一种如今走不到这一步——
 *    门禁（`app/App.tsx::LocalBackendGate`）会把整壳换成一页「本机后端未启动」，
 *    而"会话还没恢复完"也不存在了：本机档不再问账号（2026-10-08）；
 * 3. **本机后端在不在**（`api/local.ts::localBackendView`）在壳里是**同步**的（恒真），所以
 *    主产品形态不会先按"不是"渲染一帧再纠正；浏览器那一份要探一次 `/local/status` 才有结论，
 *    结论没回来之前判据按"有"走（`localBackendView` 的既有口径：一次没答上来的探测不该把
 *    界面拆掉）——那一档的入口等结论到了才收起来。
 *
 * ## 边界：只管"那条链在本机服务"的入口
 *
 * `/tasks/load`（知识库那边的运行负载，`TasksPage` 的负载面板）这类**只挂在服务器档**的
 * 端点不适用本判据（`local_router` 那张白名单里没有 `tasks.router`）：本机档按本机档判成
 * 管理员，等于摆一个点进去读不到、白打一趟必被拒请求的入口。那一处照旧按"有没有账号体系"判
 * （`currentUser?.role === 'admin'`），调用点写着理由。
 *
 * （原先这里还举了 `/users` 与 `SettingsModal` 的「用户」那一节当例子：那一节
 * 2026-10-09 随账号死面整块删掉了。）
 *
 * 与 `AccountMenu::settingsAvailable` 的关系：那一处是 `local.present && 本判据`
 * （服务器档整个不摆「设置」，理由在那份文件头）——多出来的那一条是**它自己的**，
 * 不是本判据的一部分。
 */
import { useLocalBackend } from '@/api/local'
import { useSessionStore } from '@/lib/session'

export function useIsAdmin(): boolean {
  const user = useSessionStore((state) => state.currentUser)
  const local = useLocalBackend()
  return user ? user.role === 'admin' : local.present
}
