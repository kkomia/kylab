/**
 * 登录 / 首次初始化（v10 账号体系的前端入口）
 * ——与旧前端 `views/LoginView.vue` 逐条对应。
 *
 * 一个页面两种模式，由 `/auth/status` 的 `needs_setup` 决定：
 * - **首次设置**：还没有任何可登录账号 → 创建管理员（用户名 + 显示名 + 密码 + 确认）；
 * - **登录**：已有账号 → 用户名 + 密码。
 *
 * 为什么不做成注册页：本产品面向个人与家庭自托管，**不开放注册**——
 * 首个用户即管理员，其余账号由管理员在设置里开通。
 *
 * 会话写入走 `lib/session`（`setSessionToken` + `currentUser`），与其它页面读的是同一份，
 * 所以登录成功后不需要刷新页面，下一次请求就带上了新凭据。
 *
 * 视觉上刻意只留一条窄列：登录页没有可"扫视比较"的内容，
 * 界面越像一份表越好——品牌名、标题、两个字段、一个按钮。
 */
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LogIn, ShieldCheck } from 'lucide-react'
import { useNavigate, useSearchParams } from 'react-router'

import { getAuthBootstrapStatus, login, me, setup, MIN_PASSWORD_CHARS } from '@/api/auth'
import { clearSessionToken, setSessionToken, useSessionStore } from '@/lib/session'

import { Button, Field, TextInput } from '../shared/ui'

/** 登录后回到用户原本想去的页面（守卫在 query 里带了 redirect）。 */
function redirectTarget(raw: string | null): string {
  return raw && raw.startsWith('/') ? raw : '/'
}

export function LoginPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const queryClient = useQueryClient()
  const currentUser = useSessionStore((store) => store.currentUser)
  const token = useSessionStore((store) => store.token)

  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [localError, setLocalError] = useState('')

  const status = useQuery({
    queryKey: ['auth', 'bootstrap'],
    queryFn: getAuthBootstrapStatus,
    retry: false,
  })
  const isSetup = status.data?.needs_setup === true

  const target = redirectTarget(searchParams.get('redirect'))

  /**
   * 已持有凭据时不再要求登录；守卫通常已经拦下了，这里是页内二次确认。
   *
   * 验一次 `/auth/me`（失败即清本地令牌）而不是直接放行：令牌可能已过期或被吊销，
   * 直接跳走会让用户看到一串 401。
   */
  useEffect(() => {
    if (isSetup || !token) return
    let cancelled = false
    void (async () => {
      try {
        const account = await me()
        if (cancelled) return
        // 拿不到账号就当令牌失效：**不能把 undefined 写进 store**，
        // 那会让 `isAdmin` 与页头账号一起变成空，而界面还以为登录着
        if (!account?.id) throw new Error('会话无效')
        useSessionStore.setState({ currentUser: account })
        await navigate(target, { replace: true })
      } catch {
        if (!cancelled) clearSessionToken()
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSetup, token])

  const submit = useMutation({
    mutationFn: async () => {
      const name = username.trim()
      if (!name) throw new Error('请填写用户名')
      if (!password) throw new Error('请填写密码')
      if (isSetup) {
        if (password.length < MIN_PASSWORD_CHARS) {
          throw new Error(`密码至少 ${MIN_PASSWORD_CHARS} 个字符`)
        }
        if (password !== confirmPassword) throw new Error('两次输入的密码不一致')
        return setup(name, password, displayName.trim() || undefined)
      }
      return login(name, password)
    },
    onSuccess: async (result) => {
      // 会话令牌只在这一次响应里出现：立刻落本地，丢了只能重新登录
      setSessionToken(result.token)
      useSessionStore.setState({ currentUser: result.user })
      await queryClient.invalidateQueries()
      // 登录之后引导状态已经变了（needs_setup 不再为真），让守卫读到新的一份
      await status.refetch()
      await navigate(target, { replace: true })
    },
    onError: (error: unknown) =>
      setLocalError(error instanceof Error ? error.message : '操作失败，请重试'),
  })

  return (
    <div className="m-login">
      <div className="m-login-panel">
        <div className="m-login-brand">
          {isSetup ? <ShieldCheck size={32} /> : <LogIn size={32} />}
        </div>

        <h1 className="m-login-title">{isSetup ? '创建管理员账号' : '登录'}</h1>
        <p className="m-login-hint">
          {isSetup
            ? '第一次使用：创建管理员账号即可进入。已有的知识库会归到这个账号名下。'
            : '用管理员为你开通的账号登录。'}
        </p>

        <form
          className="m-form"
          onSubmit={(event) => {
            event.preventDefault()
            setLocalError('')
            submit.mutate()
          }}
        >
          <Field label="用户名" htmlFor="login-username">
            <TextInput
              id="login-username"
              value={username}
              onValueChange={setUsername}
              placeholder={isSetup ? '由你决定，例如 admin' : ''}
              autoComplete="username"
              disabled={submit.isPending}
            />
          </Field>

          {isSetup && (
            <Field label="显示名" optional htmlFor="login-name">
              <TextInput
                id="login-name"
                value={displayName}
                onValueChange={setDisplayName}
                placeholder="界面上显示的名字，留空则用用户名"
                disabled={submit.isPending}
              />
            </Field>
          )}

          <Field label="密码" htmlFor="login-password">
            <TextInput
              id="login-password"
              type="password"
              value={password}
              onValueChange={setPassword}
              placeholder={isSetup ? `至少 ${MIN_PASSWORD_CHARS} 个字符` : ''}
              autoComplete="current-password"
              disabled={submit.isPending}
            />
          </Field>

          {isSetup && (
            <Field label="确认密码" htmlFor="login-confirm">
              <TextInput
                id="login-confirm"
                type="password"
                value={confirmPassword}
                onValueChange={setConfirmPassword}
                autoComplete="new-password"
                disabled={submit.isPending}
              />
            </Field>
          )}

          {localError && (
            <p className="m-login-error" role="alert">
              {localError}
            </p>
          )}

          <Button variant="primary" type="submit" block disabled={submit.isPending}>
            {submit.isPending ? '请稍候…' : isSetup ? '创建并进入' : '登录'}
          </Button>
        </form>

        {currentUser && !isSetup && <p className="m-login-hint">当前已登录：{currentUser.name}</p>}
      </div>
    </div>
  )
}
