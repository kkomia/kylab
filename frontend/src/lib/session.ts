/**
 * 会话状态（React 版；逻辑与旧前端 `composables/useSessionToken.ts` 逐条对应）。
 *
 * **为什么要单独一层**：`api/client.ts` 要读令牌、并在 401 时发"请重新登录"信号，
 * 而 `lib/session.ts` 不能反过来依赖 api 层（那就是循环依赖）。旧前端把这条依赖
 * 拉成直线（api/auth → api/client → 会话状态），这里沿用同一条。
 *
 * 用 **zustand** 而不是 React Context：`client.ts`（非组件代码）也要读它，
 * Context 只在组件树里可用；zustand 的 `getState()` 在模块里随手可调。
 *
 * ## 2026-10-09：账号那一族删了，这一份留下的是**传输层机制**
 *
 * 登录页早已删掉（本机档免登录，见 `app/App.tsx` 的文件头），这一天又把账号死面
 * 一并清掉：`api/auth.ts`（`/auth/*` 客户端）、`lib/sessionActions.ts`、设置里的
 * 「账号」一节、账号菜单的「头像 / 退出登录」都没了。**但这一份不能跟着删**：
 * `api/client.ts::authHeaders()` 仍在给每个请求挂 `Authorization`，401 时仍要
 * "清掉那条死凭据 + 递增重新登录信号"（`clearSessionToken` / `requestRelogin`），
 * 壳里仍靠那个计数把凭据收干净（`layout/AppShell.tsx`）。所以这里保留的是
 * **令牌的读 / 写 / 清 + 重新登录信号**这一套机制本身。
 *
 * 一并删掉的是**没有读者**的那几件：`hasCredential`（零调用点）、`isUnauthorized`
 * （只被 `sessionActions` 那份三态恢复用，那条链随登录页下线）、以及 store 上的
 * `authStatus` 字段（唯一写入者是 `sessionActions::ensureAuthStatus`）。
 *
 * ## 2026-10-09（第二轮）：`currentUser` 也删了
 *
 * 名册 / 操作者链（`lib/operator.ts` + `api/users.ts`）整族删掉之后，`currentUser`
 * 的**写入方与读方一起消失**（写入方是上一轮删掉的 `login`/`setup`/`restoreSession`，
 * 读方是那一族与 AccountMenu 的兜底显示）。它的值在生产里**恒为 null**，
 * 留着只会让每个读方都写一遍"恒 null 时怎么办"——所以字段与 `Account` 类型一起去掉，
 * 「本机主人」那个显示改成 `AccountMenu` 里的常量（那一档的事实）。
 *
 * 令牌从哪来：一个**也不再由这一份界面签发**——本机档后端没有 `/auth/*`
 * （`local_router` 上没有 `auth.router`），`setSessionToken` 如今只有测试在用
 * （拿它摆"手上有一条凭据"的现场）。留着它是因为"读 / 写 / 清"是同一套机制的三面，
 * 只留读和清会让机制残缺。
 */
import { create } from 'zustand'

export const SESSION_TOKEN_STORAGE_KEY = 'kylab-session-token'

function read(): string {
  try {
    return window.localStorage.getItem(SESSION_TOKEN_STORAGE_KEY) ?? ''
  } catch {
    // 隐私模式下 localStorage 不可写：退化成"本次会话有效"，而不是崩掉
    return ''
  }
}

interface SessionState {
  token: string
  /** 「请重新登录」的**计数器**：连续多个请求同时 401 时，布尔值只会跳一次。 */
  reloginCount: number
}

export const useSessionStore = create<SessionState>(() => ({
  token: typeof window === 'undefined' ? '' : read(),
  reloginCount: 0,
}))

/** 当前令牌（**每个请求都现取**：手上那条会话下一次请求就该生效）。 */
export function sessionToken(): string {
  return useSessionStore.getState().token
}

export function setSessionToken(next: string): void {
  const token = next.trim()
  useSessionStore.setState({ token })
  try {
    if (token) window.localStorage.setItem(SESSION_TOKEN_STORAGE_KEY, token)
    else window.localStorage.removeItem(SESSION_TOKEN_STORAGE_KEY)
  } catch {
    // 存不上就只在本次会话生效
  }
}

/** 清掉本地凭据（401 那条链走它）。 */
export function clearSessionToken(): void {
  setSessionToken('')
}

export function requestRelogin(): void {
  useSessionStore.setState((state) => ({ reloginCount: state.reloginCount + 1 }))
}
