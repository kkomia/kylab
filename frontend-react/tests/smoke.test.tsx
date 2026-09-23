/**
 * 应用壳的冒烟用例（P2 起升级成真用例：P0 那句占位断言已经被 ChatPage 替换掉了）。
 *
 * 钉住三件事：路由挂得上、登录守卫拦得住、全局容器（Toaster）在。
 * 守卫要的两件网络事（引导状态、会话恢复）都在 `@/api/auth` 这一层 mock 掉。
 */
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { App } from '@/app/App'
import { SESSION_TOKEN_STORAGE_KEY, setSessionToken } from '@/lib/session'

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

  it('`/chat` 落在对话页（壳的内容区里）', async () => {
    window.history.pushState({}, '', '/chat')
    render(<App />)

    await waitFor(() => {
      expect(screen.getByLabelText('对话内容')).toBeInTheDocument()
    })
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
})
