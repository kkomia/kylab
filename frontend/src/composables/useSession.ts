/**
 * 登录动作：引导状态、登录 / 首次初始化 / 退出 / 恢复会话。
 *
 * 状态本身在 `useSessionToken.ts`（客户端与路由都要读它，拆开是为了避免循环依赖，
 * 那里有依赖图）。这里只做"发请求 + 落状态"的编排。
 *
 * 三条边界：
 * 1. `ensureAuthStatus` **失败不抛**——后端没起时抛出去会让路由守卫变成死循环；
 *    拿不到状态按"不拦"处理，让界面照常渲染，由各请求自己报网络错误。
 * 2. 登录 / 初始化的令牌**只此一次**，立刻落本地；丢了只能重新登录。
 * 3. `logout` 即使服务端调用失败也清本地——用户点了退出，就不该还留着令牌。
 */

import { computed } from 'vue'

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
import {
  authStatus,
  clearSessionToken,
  currentUser,
  sessionToken,
  setSessionToken,
} from '@/composables/useSessionToken'

/** 在途的状态请求：并发调用共享同一次，避免启动时连打三四个 `/auth/status`。 */
let statusPromise: Promise<AuthBootstrapStatus | null> | null = null

/**
 * 取认证引导状态（缓存）。
 *
 * `force` 用于登录 / 退出之后——那时 `needs_setup` / `auth_enabled` 已经变了。
 */
export async function ensureAuthStatus(force = false): Promise<AuthBootstrapStatus | null> {
  if (!force && authStatus.value) return authStatus.value
  if (!force && statusPromise) return statusPromise
  statusPromise = getAuthBootstrapStatus()
    .then((status) => {
      authStatus.value = status
      return status
    })
    .catch(() => null)
    .finally(() => {
      statusPromise = null
    })
  return statusPromise
}

/** 用户名 + 密码登录，成功后立刻持有会话令牌。 */
export async function login(username: string, password: string): Promise<LoginResult> {
  const result = await apiLogin(username, password)
  setSessionToken(result.token)
  currentUser.value = result.user
  await ensureAuthStatus(true)
  return result
}

/** 首次初始化：创建管理员账号（服务端仅当还没有任何账号时开放）。 */
export async function setup(
  username: string,
  password: string,
  name?: string,
): Promise<LoginResult> {
  const result = await apiSetup(username, password, name)
  setSessionToken(result.token)
  currentUser.value = result.user
  await ensureAuthStatus(true)
  return result
}

/** 退出登录：吊销当前会话并清本地令牌。 */
export async function logout(): Promise<void> {
  try {
    if (sessionToken()) await apiLogout()
  } catch {
    // 会话可能已过期或被吊销：服务端报错不影响"本地退出"这件事
  }
  clearSessionToken()
  await ensureAuthStatus(true)
}

/**
 * 用本地已存的会话令牌恢复身份。
 *
 * 返回是否已登录。失败（过期 / 被吊销 / 改密）即清除本地令牌——
 * 不清的话，界面会以为还登录着，然后每个请求各报一次 401。
 */
export async function restoreSession(): Promise<boolean> {
  if (!sessionToken()) return false
  try {
    currentUser.value = await apiMe()
    return true
  } catch {
    clearSessionToken()
    return false
  }
}

/** 修改自己的密码（吊销其他会话，保住当前这条）。 */
export function changeOwnPassword(
  oldPassword: string,
  newPassword: string,
): Promise<{ revoked_sessions: number }> {
  return apiChangePassword(oldPassword, newPassword)
}

/**
 * 换一张头像 / 去掉头像（v0.29）。
 *
 * 动作放这里而不是组件里：`currentUser` 是这一层管的状态，
 * 而"换完头像界面上要立刻变"靠的就是把接口返回的那份写回去。
 */
export async function setAvatar(file: File): Promise<void> {
  currentUser.value = await apiUploadAvatar(file)
}

export async function removeAvatar(): Promise<void> {
  currentUser.value = await apiClearAvatar()
}

export const isLoggedIn = computed(() => currentUser.value !== null)

export const isAdmin = computed(() => currentUser.value?.role === 'admin')
