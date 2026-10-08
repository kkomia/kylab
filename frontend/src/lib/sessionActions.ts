/**
 * 会话动作（React 版；对应旧前端 `composables/useSession.ts`）。
 *
 * 状态在 `lib/session.ts`，这里只做"发请求 + 落状态"的编排。三条边界照搬旧实现：
 *
 * 1. `ensureAuthStatus` **失败不抛**——后端没起时抛出去会让调用方变成死循环；
 *    拿不到状态按"不拦"处理；
 * 2. 登录 / 初始化的令牌**只此一次**，立刻落本地；丢了只能重新登录；
 * 3. `logout` 即使服务端调用失败也清本地——用户点了退出，就不该还留着令牌。
 *
 * ## 2026-10-08：登录页下线之后，这一族还剩谁在用
 *
 * 门禁（`app/App.tsx::LocalBackendGate`）**不再问账号**：本机档无条件免登录，
 * 判据归 `api/local.ts::localBackendPresent`（原先那个 `localOnlyDeployment`
 * 已删，理由写在文件尾）。于是这三条现在只服务**仍然在的**那两处：设置里的账号一节
 * （改密 / 头像 / 用户管理）与账号菜单的「退出登录」；`ensureAuthStatus` / `restoreSession`
 * 没有生产调用点了（登录页与门禁都不再问），留着是因为它们是这条链的公开动作、
 * 用例也逐条钉着——**要不要整族删掉（连带设置里账号那一节）是产品判断，不在这轮里**。
 */
import {
  changePassword as apiChangePassword,
  clearAvatar as apiClearAvatar,
  getAuthBootstrapStatus,
  login as apiLogin,
  logout as apiLogout,
  me as apiMe,
  setup as apiSetup,
  uploadAvatar as apiUploadAvatar,
  type AuthBootstrapStatus,
  type LoginResult,
} from '@/api/auth'
import { clearSessionToken, isUnauthorized, setSessionToken, useSessionStore } from '@/lib/session'

/** 在途的状态请求：并发调用共享同一次，避免启动时连打三四个 `/auth/status`。 */
let statusPromise: Promise<AuthBootstrapStatus | null> | null = null

export async function ensureAuthStatus(force = false): Promise<AuthBootstrapStatus | null> {
  const cached = useSessionStore.getState().authStatus
  if (!force && cached) return cached
  if (!force && statusPromise) return statusPromise
  statusPromise = getAuthBootstrapStatus()
    .then((status) => {
      useSessionStore.setState({ authStatus: status })
      return status
    })
    .catch(() => null)
    .finally(() => {
      statusPromise = null
    })
  return statusPromise
}

export async function login(username: string, password: string): Promise<LoginResult> {
  const result = await apiLogin(username, password)
  setSessionToken(result.token)
  useSessionStore.setState({ currentUser: result.user })
  await ensureAuthStatus(true)
  return result
}

export async function setup(
  username: string,
  password: string,
  name?: string,
): Promise<LoginResult> {
  const result = await apiSetup(username, password, name)
  setSessionToken(result.token)
  useSessionStore.setState({ currentUser: result.user })
  await ensureAuthStatus(true)
  return result
}

export async function logout(): Promise<void> {
  try {
    if (useSessionStore.getState().token) await apiLogout()
  } catch {
    // 会话可能已过期或被吊销：服务端报错不影响"本地退出"这件事
  }
  clearSessionToken()
  await ensureAuthStatus(true)
}

/**
 * 恢复身份的结果——**三态，不是一个布尔**（D07，2026-09-28 走查）。
 *
 * 原先这里是 `Promise<boolean>`：`catch` 一律 `clearSessionToken()` + `false`，
 * 于是**网络抖动 / 超时 / 后端 5xx** 与"你的登录真过期了"被当成同一件事：
 * 用户被强制登出，而且**本地令牌被删掉**（网好了还得重新输密码）。
 * 实测报告 D07 记的就是这一条，`client.ts` 其实**早就给错误标了 `status`** ✗ 没人看。
 *
 * 三态之后调用方才能各做各的：
 * - `ok`：身份拿到了；
 * - `expired`：401，凭据真失效 → 清令牌（登录页已删，见 `app/App.tsx` 的文件头，
 *   所以"去登录页"那一步没有了；壳里的 401 出口也改成清令牌，见 `layout/AppShell.tsx`）；
 * - `unreachable`：没连上/服务端出错 → **令牌留着**，别把用户踢出去。
 */
export type SessionRestore = 'ok' | 'expired' | 'unreachable'

export async function restoreSession(): Promise<SessionRestore> {
  if (!useSessionStore.getState().token) return 'expired'
  try {
    useSessionStore.setState({ currentUser: await apiMe() })
    return 'ok'
  } catch (error) {
    // **只有 401 才算过期**（见 `lib/session.ts::isUnauthorized` 的说明）
    if (!isUnauthorized(error)) return 'unreachable'
    clearSessionToken()
    return 'expired'
  }
}

/**
 * 这一档**是不是只连本机后端**——**这个判据 2026-10-08 删了**，说明见文件尾。
 */
export function changeOwnPassword(
  currentPassword: string,
  newPassword: string,
): Promise<{ revoked_sessions: number }> {
  return apiChangePassword(currentPassword, newPassword)
}

export async function setAvatar(file: File): Promise<void> {
  const user = await apiUploadAvatar(file)
  useSessionStore.setState({ currentUser: user })
}

export async function removeAvatar(): Promise<void> {
  const user = await apiClearAvatar()
  useSessionStore.setState({ currentUser: user })
}

/*
 * ------------------------------------------------------------- 删掉的那条判据（R13）
 *
 * 这里原先有个 `localOnlyDeployment()`：问本机后端答不答 `/local/status`（回
 * `deployment === 'local'` 就是本机档），供登录守卫在"远端问不出来"时放行。
 *
 * 它要回答的那个问题（M3 / M4 / M5 三次验收都记着的那一条：**远端不可达时前端被拦回
 * 登录页，而数据就在本机**）现在由**门禁**自己回答（`app/App.tsx::LocalBackendGate`，
 * 读 `api/local.ts::localBackendPresent`）：本机档**无条件**免登录。
 *
 * 两个理由，别把它加回来：
 * 1. **R13 那版把顺序搞反了**——只在"远端答不上话"时放行，于是 NAS 一答话反而弹登录
 *    （拿远端那份账号体系来管本机数据）；判据该先认本机后端，而不是先问远端；
 * 2. 它把"这一档是不是本机档"**又实现了一遍**（同一端点、同一判据的第二个副本），
 *    而门禁要的是**同步、可订阅**的结论（渲染时就要用）——那只有 `api/local.ts`
 *    那份模块级缓存给得了。判据只留一处，这一份就下线了。
 */
