/**
 * 「这一份界面上，当前这个人是不是管理员」——**全仓唯一的判据**。
 *
 * ## 现在的答案：本机主人就是这台机器的管理员
 *
 * 这一份界面只有一种形态——**背后有一个本机后端**（桌面壳里由壳拉起，浏览器里是
 * 127.0.0.1:8765 那个边车，见 `app/App.tsx` 的文件头）。本机档**没有账号体系**：
 * `/auth/*` 一族根本不挂在边车的 `local_router` 上（`backend/app/api/v1/router.py`），
 * 登录页与 `api/auth.ts` 那一族 2026-10-08 / 10-09 先后删掉，会话状态里的
 * `currentUser` 也随之删了（写入方早就没了）。而后端起给这一档那个唯一调用主体的名字是
 * 「本机主人」，它的记录里 `is_admin=True` / `role=UserRole.ADMIN`
 * （`backend/app/services/api_key.py::LOCAL_CALLER`）——**本机主人就是这台机器的管理员**。
 *
 * 所以判据落到**一句话**：**这一份界面有没有本机后端**（`api/local.ts::useLocalBackend`，
 * 那个判据只有它一处）。有就是管理员。
 *
 * ## 为什么这条口径值得单独一个函数（而不是各调用点写 `local.present`）
 *
 * 它曾经是"按账号角色判，没账号才看本机后端"的三支判据——用户 2026-10-05 报过两次
 * （侧栏左下角「设置」不见了、输入框那排的「权限」胶囊不见了），都是"按有没有登录判"
 * 判出来的。**七个调用点共用这一条**（AccountMenu / PermissionControl / CapabilitiesPage /
 * PluginPackPanel / MemoryPage / TasksPage / 两个工作区弹窗），
 * 以后真要接回账号体系，改这里一处就够。
 *
 * 三条边界：
 *
 * 1. **没有本机后端那一档**走不到这里：门禁（`app/App.tsx::LocalBackendGate`）会把整壳
 *    换成一页「本机后端未启动」；
 * 2. **本机后端在不在**（`api/local.ts::localBackendView`）在壳里是**同步**的（恒真），
 *    所以主产品形态不会先按"不是"渲染一帧再纠正；浏览器那一份要探一次 `/local/status`
 *    才有结论，结论没回来之前判据按"有"走（`localBackendView` 的既有口径：一次没答上来的
 *    探测不该把界面拆掉）——那一档的入口等结论到了才收起来；
 * 3. **只管"那条链在本机服务"的入口**。`/tasks/load`（知识库那边的运行负载）这类
 *    **只挂在服务器档**的端点本来不适用本判据（`local_router` 那张白名单里没有
 *    `tasks.router`）：2026-10-09 起 `TasksPage` 也改成用它了（那一处原先按
 *    `currentUser?.role === 'admin'` 判，而那个字段已经不在了）——**代价写在那一份的文件头**：
 *    本机档 + 知识库接上时，运行负载面板现在会显示，也会发那条 `/tasks/load`。
 */
import { useLocalBackend } from '@/api/local'

export function useIsAdmin(): boolean {
  const local = useLocalBackend()
  return local.present
}
