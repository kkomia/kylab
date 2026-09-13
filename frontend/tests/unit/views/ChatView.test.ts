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

// 引用抽屉（DocumentDrawer）会拉文档详情与预览；这些用例只关心"抽屉开没开、路由动没动"
const getDocument = vi.fn()
vi.mock('@/api/documents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/documents')>()
  return {
    ...actual,
    getDocument: (...args: unknown[]) => getDocument(...args),
    listDocumentChunks: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    getDocumentPreview: vi.fn().mockResolvedValue({
      kind: 'markdown',
      filename: '指南.md',
      text: '正文',
      url: null,
      expires_at: null,
      original_kind: 'markdown',
    }),
  }
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

/** 带一条出处的会话：用来测"点文件名 → 右侧抽屉"。 */
function detailWithSource(id: string): ConversationDetail {
  return {
    ...summary(id),
    messages: [
      { id: 'm1', role: 'user', content: '眼轴怎么监测', sources: [], created_at: null },
      {
        id: 'm2',
        role: 'assistant',
        content: '眼轴是主要参数[1]。',
        created_at: null,
        sources: [
          {
            index: 1,
            chunk_id: 'chunk1',
            document_id: 'doc_a',
            document_name: '中国干眼共识（2024年）.pdf',
            heading_path: '4 黏蛋白',
            page: 2,
            score: 0.9,
            preview: '原文片段',
            knowledge_base_id: 'kb_1',
          },
        ],
      },
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

// jsdom 没有实现原生 <dialog> 的 showModal/close，而 AppModal 正是靠它们进出 top-layer
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false
  }
})

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  clearConversationDetailCache()
  vi.clearAllMocks()
  getDocument.mockImplementation(async (id: string) => ({
    id,
    knowledge_base_id: 'kb_1',
    name: '中国干眼共识（2024年）.pdf',
    source_kind: 'upload',
    stage: 'indexed',
    size_bytes: 1024,
    mime_type: 'application/pdf',
    page_count: 10,
    is_split: false,
    error: null,
    chunk_count: 3,
    uploaded_by: null,
    uploaded_by_name: '',
    folder_id: null,
    disabled: false,
    original_kind: 'markdown',
    created_at: null,
    updated_at: null,
  }))
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

  it('回答里的引用徽标显示文档短名（去扩展名），而不是序号', async () => {
    const store = useConversationStore()
    store.rememberDetail(detailWithSource('c1'))

    const { wrapper } = await mountAt('/chat/c1')
    await flushPromises()

    const chip = wrapper.find('.md-cite')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toBe('中国干眼共识（2024年）')
    // 序号不再出现在徽标里；完整名字与位置留在 title
    expect(chip.attributes('title')).toContain('中国干眼共识（2024年）.pdf')
    expect(chip.attributes('title')).toContain('第 2 页')
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

describe('引用文档抽屉', () => {
  it('点出处文件名：在右侧抽屉里打开原文，不跳知识库页', async () => {
    const store = useConversationStore()
    store.rememberDetail(detailWithSource('c1'))
    const { wrapper, router } = await mountAt('/chat/c1')
    await flushPromises()

    await wrapper.find('.cite-title').trigger('click')

    await vi.waitFor(() => expect(wrapper.find('.doc-drawer').exists()).toBe(true))
    // 关键：人还在对话页（旧实现在这里会跳到 /kb/kb_1?doc=…）
    expect(router.currentRoute.value.path).toBe('/chat/c1')
    // 抽屉拿到的是被引用的那份文档
    expect(getDocument).toHaveBeenCalledWith('doc_a')
    wrapper.unmount()
  })

  it('「引用原文」弹窗里的「查看文档」也走抽屉，关掉弹窗不跳走', async () => {
    const store = useConversationStore()
    store.rememberDetail(detailWithSource('c1'))
    const { wrapper, router } = await mountAt('/chat/c1')
    await flushPromises()

    await wrapper.find('.cite-more').trigger('click')
    await flushPromises()
    const action = wrapper.findAll('button').find((button) => button.text().includes('查看文档'))
    expect(action).toBeTruthy()

    await action!.trigger('click')

    await vi.waitFor(() => expect(wrapper.find('.doc-drawer').exists()).toBe(true))
    expect(router.currentRoute.value.path).toBe('/chat/c1')
    wrapper.unmount()
  })

  it('抽屉收起（Esc / 收起按钮）后回到对话，不残留', async () => {
    const store = useConversationStore()
    store.rememberDetail(detailWithSource('c1'))
    const { wrapper } = await mountAt('/chat/c1')
    await flushPromises()
    await wrapper.find('.cite-title').trigger('click')
    await vi.waitFor(() => expect(wrapper.find('.doc-drawer').exists()).toBe(true))

    await wrapper.find('button[aria-label="收起"]').trigger('click')
    // 抽屉是"先滑回去再卸载"，等它的收起动画（样式里 180ms）
    await vi.waitFor(() => expect(wrapper.find('.doc-drawer').exists()).toBe(false), {
      timeout: 1000,
    })
    wrapper.unmount()
  })
})
