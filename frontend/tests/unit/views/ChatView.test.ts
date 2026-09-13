/**
 * 对话页的两个切换行为（用户实测的两条反馈）。
 *
 * 1. **"跳回对话"**：停在 `/chat` 时会在后台解析"最近一次会话"，然后 `replace` 到
 *    `/chat/:id`。这一步是一次网络往返，用户完全可能在这期间点了别的菜单——
 *    此时旧代码只检查了 `conversationId`（切走后它本来就是空的），于是照样 replace，
 *    把刚走的人拽回对话页。这里钉住"已离开就不再改路径"。
 * 2. **正文缓存**：切回看过的会话要立刻出内容（缓存命中不回源）；
 *    未命中时才给骨架屏，而不是干等一屏空白。
 */
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'

import type { ConversationDetail, ConversationSummary } from '@/api/conversations'

const listConversations = vi.fn()
const getConversation = vi.fn()

vi.mock('@/api/conversations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/conversations')>()
  return {
    ...actual,
    listConversations: (...args: unknown[]) => listConversations(...args),
    getConversation: (...args: unknown[]) => getConversation(...args),
    createConversation: vi.fn(),
    updateConversation: vi.fn(),
    deleteConversation: vi.fn(),
  }
})

vi.mock('@/api/chat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/chat')>()
  return {
    ...actual,
    chatStream: vi.fn(),
    getSuggestedQuestions: vi.fn().mockResolvedValue({ questions: [] }),
  }
})

vi.mock('@/api/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/settings')>()
  return {
    ...actual,
    getSettings: vi.fn().mockResolvedValue({ groups: [] }),
    updateSettings: vi.fn(),
  }
})

vi.mock('@/api/knowledgeBases', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/knowledgeBases')>()
  return { ...actual, listKnowledgeBases: vi.fn().mockResolvedValue({ items: [] }) }
})

vi.mock('@/api/modelRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/modelRegistry')>()
  return {
    ...actual,
    getRegistry: vi.fn().mockResolvedValue({ providers: [], models: [], slots: [] }),
  }
})

vi.mock('@/api/notes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/notes')>()
  return { ...actual, createNote: vi.fn() }
})

import { clearConversationDetailCache, useConversationStore } from '@/stores/conversations'
import ChatView from '@/views/ChatView.vue'

function summary(id: string, extra: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id,
    title: id,
    kb_ids: [],
    model_pk: null,
    thinking: null,
    thinking_effort: null,
    pinned: false,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    message_count: 2,
    ...extra,
  }
}

function chatDetail(id: string): ConversationDetail {
  return {
    ...summary(id),
    messages: [
      { id: 'm1', role: 'user', content: '你好', sources: [], created_at: null },
      { id: 'm2', role: 'assistant', content: '这是回答', sources: [], created_at: null },
    ],
  }
}

let pinia: Pinia

async function mountAt(path: string): Promise<{ wrapper: VueWrapper; router: Router }> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/chat/:conversationId?', name: 'chat', component: { template: '<div />' } },
      { path: '/knowledge-bases', name: 'knowledge-bases', component: { template: '<div />' } },
    ],
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(ChatView, { global: { plugins: [pinia, router] } })
  return { wrapper, router }
}

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  clearConversationDetailCache()
  vi.clearAllMocks()
})

describe('停在 /chat 时解析"最近一次会话"', () => {
  it('解析期间用户切到别的菜单：不许再把他拽回对话页', async () => {
    let resolveList!: (value: { items: ConversationSummary[] }) => void
    listConversations.mockReturnValue(
      new Promise<{ items: ConversationSummary[] }>((resolve) => {
        resolveList = resolve
      }),
    )
    const { wrapper, router } = await mountAt('/chat')
    await flushPromises() // 跑到 latestId 的 await 上

    await router.push('/knowledge-bases')
    await flushPromises()

    // 迟到的结论：确实有一条最近会话（旧代码正是在这里把人拽回去的）
    resolveList({ items: [summary('c_latest')] })
    await flushPromises()
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/knowledge-bases')
    wrapper.unmount()
  })

  it('一直停在 /chat 时，仍会落到最近那一条', async () => {
    listConversations.mockResolvedValue({ items: [summary('c_latest')] })
    const { wrapper, router } = await mountAt('/chat')
    await flushPromises()
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/chat/c_latest')
    wrapper.unmount()
  })
})

describe('会话正文', () => {
  it('命中缓存：同步出内容，不再回源', async () => {
    const store = useConversationStore()
    store.rememberDetail(chatDetail('c1'))

    const { wrapper } = await mountAt('/chat/c1')
    await flushPromises()

    expect(getConversation).not.toHaveBeenCalled()
    expect(wrapper.findAll('.turn')).toHaveLength(1)
    expect(wrapper.text()).toContain('这是回答')
    wrapper.unmount()
  })

  it('未命中缓存：先骨架屏，内容到达后换成消息', async () => {
    let resolveDetail!: (value: ConversationDetail) => void
    getConversation.mockReturnValue(
      new Promise<ConversationDetail>((resolve) => {
        resolveDetail = resolve
      }),
    )

    const { wrapper } = await mountAt('/chat/c1')
    await flushPromises()
    expect(wrapper.find('.chat-loading').exists()).toBe(true)
    expect(wrapper.findAll('.turn')).toHaveLength(0)

    resolveDetail(chatDetail('c1'))
    await flushPromises()

    expect(wrapper.find('.chat-loading').exists()).toBe(false)
    expect(wrapper.findAll('.turn')).toHaveLength(1)
    wrapper.unmount()
  })
})
