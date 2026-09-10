/**
 * 控制台账号（凭据）的本地保管。
 *
 * **为什么前端需要这个**：后端的 API Key 鉴权一旦启用，`/api/v1` 下所有端点都要凭据。
 * 而浏览器里的控制台原本不带任何凭据——于是"打开了鉴权"这件事会让控制台直接不可用
 * （每个页面都报「缺少凭据」），且**没有任何恢复入口**。这个模块补的就是那个入口。
 *
 * 三处刻意的设计：
 *
 * 1. **存在 localStorage，不是 sessionStorage**：自托管用户不想每开一个标签页就
 *    重新粘一次令牌。这与主题、字号是同一类"这台机器的偏好"。
 *
 * 2. **只存控制台令牌，不存 API Key**：控制台要读设置页，而设置页只认控制台身份；
 *    把一把受限的 API Key 存进来，用户会得到一堆 403 却不知道为什么。
 *
 * 3. **不作为模块级单例去碰 window**：读写都包在 try 里——隐私模式下 localStorage
 *    不可写，那时候退化成"本次会话有效"而不是崩掉。
 */

import { readonly, ref } from 'vue'

export const CONSOLE_TOKEN_STORAGE_KEY = 'kylab-console-token'

function read(): string {
  try {
    return window.localStorage.getItem(CONSOLE_TOKEN_STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

const token = ref<string>(typeof window === 'undefined' ? '' : read())

/** 当前凭据（只读）。`request()` 每次请求现取，所以改动立即生效。 */
export function consoleToken(): string {
  return token.value
}

export function setConsoleToken(next: string): void {
  token.value = next.trim()
  try {
    if (token.value) window.localStorage.setItem(CONSOLE_TOKEN_STORAGE_KEY, token.value)
    else window.localStorage.removeItem(CONSOLE_TOKEN_STORAGE_KEY)
  } catch {
    // 隐私模式：不记忆即可，本次会话内的请求仍然带着它
  }
}

export function clearConsoleToken(): void {
  setConsoleToken('')
}

export function useConsoleToken() {
  return { token: readonly(token), setConsoleToken, clearConsoleToken }
}
