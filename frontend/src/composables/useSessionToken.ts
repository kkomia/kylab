/**
 * 登录会话的本地状态（纯状态，不发请求）。
 *
 * **为什么与 `useSession.ts` 分开**：`api/client.ts` 需要读会话令牌、
 * 并在会话失效时发"请重新登录"信号，而 `useSession.ts` 要调 `api/auth.ts`
 * ——两者合在一起就是 `client → useSession → api/auth → client` 的循环依赖。
 * 把"状态"与"动作"拆开，依赖就成了一条直线：
 *
 * ```
 * api/auth ─→ api/client ─→ useSessionToken（纯状态）
 *      └──→ useSession ─→ useSessionToken
 * ```
 *
 * 存 localStorage 而不是 sessionStorage：自托管用户不想每开一个标签页就重新登录，
 * 这与主题、字号是同一类"这台机器的偏好"。令牌为空时不加 Authorization 头，
 * 于是"未启用鉴权"的本机开发连头都不出现。
 */

import { readonly, ref } from 'vue'

import type { Account, AuthBootstrapStatus } from '@/api/auth'
import { consoleToken } from '@/composables/useConsoleToken'

export const SESSION_TOKEN_STORAGE_KEY = 'kylab-session-token'

function read(): string {
  try {
    return window.localStorage.getItem(SESSION_TOKEN_STORAGE_KEY) ?? ''
  } catch {
    // 隐私模式下 localStorage 不可写：退化成"本次会话有效"，而不是崩掉
    return ''
  }
}

const token = ref<string>(typeof window === 'undefined' ? '' : read())

/** 当前登录账号（会话令牌通道才有；控制台令牌/API Key 通道为 null）。 */
export const currentUser = ref<Account | null>(null)

/** 后端认证状态（是否需初始化 / 是否已启用鉴权）。 */
export const authStatus = ref<AuthBootstrapStatus | null>(null)

export function sessionToken(): string {
  return token.value
}

export function setSessionToken(next: string): void {
  token.value = next.trim()
  try {
    if (token.value) window.localStorage.setItem(SESSION_TOKEN_STORAGE_KEY, token.value)
    else window.localStorage.removeItem(SESSION_TOKEN_STORAGE_KEY)
  } catch {
    // 存不上就只在本次会话生效
  }
}

/** 清除会话与账号缓存（退出登录、会话失效都走它）。 */
export function clearSessionToken(): void {
  setSessionToken('')
  currentUser.value = null
}

/** 是否持有可用凭据：登录会话或控制台令牌，有其一即可访问 /api/v1。 */
export function hasCredential(): boolean {
  return Boolean(token.value || consoleToken())
}

/**
 * 「请重新登录」的信号：`request()` 收到 401 且当时带着会话令牌时递增它，
 * `App.vue` 监听后跳到登录页。
 *
 * 用**计数器**而不是布尔：连续多个请求同时 401 时，值不变 watch 不会再响，
 * 只会跳一次且之后失效。每次递增保证每次都触发（与 useConsoleToken 同一手法）。
 */
const reloginCount = ref(0)

export function requestRelogin(): void {
  reloginCount.value += 1
}

export function useReloginPrompt() {
  return { reloginCount: readonly(reloginCount) }
}
