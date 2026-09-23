/**
 * 登录动作（React 版；对应旧前端 `composables/useSession.ts`）。
 *
 * 状态在 `lib/session.ts`，这里只做"发请求 + 落状态"的编排。三条边界照搬旧实现：
 *
 * 1. `ensureAuthStatus` **失败不抛**——后端没起时抛出去会让路由守卫变成死循环；
 *    拿不到状态按"不拦"处理，让界面照常渲染，由各请求自己报网络错误；
 * 2. 登录 / 初始化的令牌**只此一次**，立刻落本地；丢了只能重新登录；
 * 3. `logout` 即使服务端调用失败也清本地——用户点了退出，就不该还留着令牌。
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
import { clearSessionToken, setSessionToken, useSessionStore } from '@/lib/session'

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

export async function restoreSession(): Promise<boolean> {
  if (!useSessionStore.getState().token) return false
  try {
    useSessionStore.setState({ currentUser: await apiMe() })
    return true
  } catch {
    clearSessionToken()
    return false
  }
}

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
