/**
 * 应用壳的冒烟用例（P2 起升级成真用例：P0 那句占位断言已经被 ChatPage 替换掉了）。
 *
 * 钉住三件事：路由挂得上、登录守卫拦得住、全局容器（Toaster）在。
 * 守卫要的两件网络事（引导状态、会话恢复）都在 `@/api/auth` 这一层 mock 掉。
 */
import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { App } from '@/app/App'
import { SESSION_TOKEN_STORAGE_KEY, setSessionToken, useSessionStore } from '@/lib/session'

vi.mock('@/api/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/auth')>()
  return {
    ...actual,
    getAuthBootstrapStatus: vi.fn(async () => ({ needs_setup: false, auth_enabled: true })),
    me: vi.fn(async () => ({
      id: 'u1',
      username: 'kkomia',
      name: '管理员',
      role: 'admin',
      disabled: false,
      avatar_url: null,
      created_at: null,
    })),
  }
})

// 对话页那一堆读接口：冒烟只关心"路由到了它"，网络一律空答复
vi.mock('@/api/chat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/chat')>()
  return {
    ...actual,
    chatStream: vi.fn(),
    openLiveTurn: vi.fn(async () => ({ abort: vi.fn() })),
    listCommands: vi.fn(async () => []),
    getContextUsage: vi.fn(async () => ({ items: [], used: 0, total: 0 })),
    getSuggestedQuestions: vi.fn(async () => ({ questions: [], generated: false })),
  }
})

vi.mock('@/api/conversations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/conversations')>()
  return {
    ...actual,
    // 一条空会话（形状按契约给全）：冒烟只关心"路由到了对话页"，不推任何事件
    getConversation: vi.fn(async () => ({
      id: 'c1',
      title: '冒烟',
      kb_ids: [],
      model_pk: '',
      thinking: null,
      thinking_effort: null,
      workspace_id: null,
      pinned: false,
      archived: false,
      message_count: 0,
      created_at: null,
      updated_at: null,
      messages: [],
    })),
    listConversations: vi.fn(async () => ({ items: [], total: 0 })),
    listArtifacts: vi.fn(async () => ({ items: [] })),
    listFiles: vi.fn(async () => ({
      mode: 'object',
      label: '本会话',
      path: '',
      parent: null,
      entries: [],
      truncated: false,
    })),
  }
})

vi.mock('@/api/knowledgeBases', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/knowledgeBases')>()
  return { ...actual, listKnowledgeBases: vi.fn(async () => ({ items: [], total: 0 })) }
})

vi.mock('@/api/modelRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/modelRegistry')>()
  return { ...actual, getRegistry: vi.fn(async () => ({ providers: [], models: [], slots: [] })) }
})

// 壳（侧栏）一挂载就要这三样：会话清单、项目清单、名册
vi.mock('@/api/stats', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/stats')>()
  return { ...actual, getDashboard: vi.fn(async () => ({ cards: [], activity: [], trends: [] })) }
})

vi.mock('@/api/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/workspaces')>()
  return { ...actual, listWorkspaces: vi.fn(async () => ({ items: [] })) }
})

vi.mock('@/api/users', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/users')>()
  return { ...actual, listUsers: vi.fn(async () => ({ items: [] })) }
})

describe('应用壳', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/')
    // 两头都要写：localStorage 那行走的是真实持久化路径，
    // `setSessionToken` 让**已经加载过**的会话 store 跟上
    // （store 在模块加载时读一次 localStorage，而测试是先 import 再 beforeEach）
    window.localStorage.setItem(SESSION_TOKEN_STORAGE_KEY, 'kylab_st_smoke')
    setSessionToken('kylab_st_smoke')
  })

  it('带凭据时放行，并落在壳里（侧栏主导航在）', async () => {
    render(<App />)

    await waitFor(() => {
      expect(screen.getByRole('navigation', { name: '主导航' })).toBeInTheDocument()
    })
  })

  // 反向验证的**确定性守卫**：这一条要等整壳（懒加载的对话页 chunk + Provider 挂载链）才
  // settle，属"CPU 型重活"——全量并发时超过默认 5s（实测 5120ms），而**单跑**只有 ~2.4s、
  // 撤掉超时照样绿，所以"单跑拿红"抓不到这个失效。用源码断言钉住：删了就红。
  it('重挂载类用例带着显式超时（删了就红）', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8')
    expect(source).toMatch(
      /it\(\s*'`\/chat` 落在对话页（壳的内容区里）'\s*,\s*\{\s*timeout:\s*15_000\s*\}/,
    )
    // **内层那一处也要显式放宽**：它等的正是懒加载 chunk + Provider 挂载链。
    // 原先 5s，满载实测这条用例 7014ms ✗（> 内层 5s ⇒ 是**它**先超时）→ 提到 12s。
    // 把这一处改回默认（或调小）就红——不依赖负载，单跑也能抓到。
    expect(source).toMatch(/getByLabelText\('对话内容'\)[\s\S]{0,120}?timeout:\s*1[0-9]_000/)
  })

  // **放宽这一处**（不是放宽全局 `testTimeout`）：要等懒加载 chunk + Provider 挂载链，
  // CPU 型重活，全量并发时被挤过默认 5s（实测 5120ms → 那次放宽到 5s；后来又实测
  // **7014ms ✗**（全量 1084 条）→ 内层这一处再抬到 12s）。外层 15s 是兜底，不动。
  it('`/chat` 落在对话页（壳的内容区里）', { timeout: 15_000 }, async () => {
    window.history.pushState({}, '', '/chat')
    render(<App />)

    // 对话页是**懒加载**的（chunk 里有 assistant-ui + katex + highlight，静态 import 会把
    // 主 chunk 顶到 1.4 MB）：这里要等一次动态 import + 整壳 Provider 挂载，
    // 满载并发下实测到 7s ✗ —— 只放宽**这一处内层等待**，别用默认的 1 秒、也别动全局。
    await waitFor(
      () => {
        expect(screen.getByLabelText('对话内容')).toBeInTheDocument()
      },
      { timeout: 12_000, interval: 50 },
    )
  })

  it('没有凭据时把人送到登录页，并带上 redirect', async () => {
    window.localStorage.removeItem(SESSION_TOKEN_STORAGE_KEY)
    setSessionToken('')

    render(<App />)

    await waitFor(() => {
      expect(window.location.pathname).toBe('/login')
    })
    // 落地页是概览（`/`），所以 redirect 记的是它
    expect(window.location.search).toContain('redirect=%2F')
  })

  /**
   * `/backup` 那条路由挂上了（M5 阶段 7）。
   *
   * 这一档（浏览器里、没有桌面壳）**不是本机档**，所以看到的是守卫那句说明——
   * 这一条同时在验两件事：路由指向的是 `BackupRoute`+`BackupPage`（不是 404 页），
   * 以及"不是本机档"那一条分支说得清楚。本机档那一支（提供者连不上也放行）
   * 在 `tests/backup-gate.test.tsx` 里逐条钉着。
   */
  it('`/backup` 落在备份页（本机档专属那一页挂上了路由）', { timeout: 15_000 }, async () => {
    window.history.pushState({}, '', '/backup')
    render(<App />)

    await waitFor(
      () => {
        expect(screen.getByText(/「备份」只有本机档/)).toBeInTheDocument()
      },
      { timeout: 12_000, interval: 50 },
    )
  })
})

describe('启动期的骨架（D30，2026-09-28 走查）', () => {
  it('启动期显示骨架，而不是一块白画布', async () => {
    // 把"探身份"挂住不放行 → `AuthGate` 的 `ready` 停在 false，正是真实启动期那一段
    // （走查实测 146–513ms 里 `bodyText` 是空的、也没有任何骨架）。
    // **先清掉"已经探过身份"的缓存**：`ensureAuthStatus` 把结果存在 store 里，
    // 前面的用例填过之后，这一条会直接拿到 ready=true、根本不经过启动期那一帧
    // （症状就是"单跑绿、整文件跑红"）。
    useSessionStore.setState({ authStatus: null })
    const auth = await import('@/api/auth')
    let release: ((value: { needs_setup: boolean; auth_enabled: boolean }) => void) | null = null
    vi.mocked(auth.getAuthBootstrapStatus).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        }) as never,
    )

    render(<App />)

    // 那段空白里现在有骨架（形状照着应用壳摆：侧栏一栏 + 内容块）
    expect(await screen.findByTestId('app-boot-skeleton')).toBeInTheDocument()

    // 放行之后骨架让位
    await act(async () => {
      release?.({ needs_setup: false, auth_enabled: true })
    })
    await waitFor(() => expect(screen.queryByTestId('app-boot-skeleton')).not.toBeInTheDocument())
  })
})
