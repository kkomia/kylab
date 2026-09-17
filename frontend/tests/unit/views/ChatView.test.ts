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
import type { KnowledgeBase } from '@/api/knowledgeBases'

const listConversations = vi.fn()
const getConversation = vi.fn()
// 知识库清单要能被单个用例改写：v0.18 的「使用知识库」开关会按库数显示不同文案，
// 固定返回空列表就测不到"选了库"那一档
const listKnowledgeBases = vi.fn()
const createConversation = vi.fn()
const chatStream = vi.fn()
const listSkills = vi.fn()

vi.mock('@/api/conversations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/conversations')>()
  return {
    ...actual,
    listConversations: (...args: unknown[]) => listConversations(...args),
    getConversation: (...args: unknown[]) => getConversation(...args),
    createConversation: (...args: unknown[]) => createConversation(...args),
    updateConversation: vi.fn(),
    deleteConversation: vi.fn(),
  }
})

vi.mock('@/api/chat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/chat')>()
  return {
    ...actual,
    chatStream: (...args: unknown[]) => chatStream(...args),
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
  return { ...actual, listKnowledgeBases: (...args: unknown[]) => listKnowledgeBases(...args) }
})

vi.mock('@/api/modelRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/modelRegistry')>()
  return {
    ...actual,
    getRegistry: vi.fn().mockResolvedValue({ providers: [], models: [], slots: [] }),
  }
})

vi.mock('@/api/capabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/capabilities')>()
  return { ...actual, listSkills: (...args: unknown[]) => listSkills(...args) }
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
    // 未归档（v0.15）：夹具默认放在"未归档"那一栏，与真实的新建行为一致
    workspace_id: null,
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

/** 知识库夹具：只填与这一页有关的那几个字段（其余照 store 那边的默认值）。 */
function kb(id: string, name: string): KnowledgeBase {
  return {
    id,
    name,
    description: '',
    embedding_model_id: 'dev/deterministic-hash',
    embedding_dim: 256,
    chunk_strategy: 'fixed',
    chunk_size: 512,
    chunk_overlap: 64,
    suggested_enabled: true,
    suggested_count: 6,
    suggested_model_pk: null,
    suggested_prompt: '',
    system_prompt: '',
    wiki_enabled: false,
    created_at: '2026-09-10T00:00:00Z',
    can_manage: true,
    can_write: true,
    document_count: 1,
    last_activity: null,
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
  // 「使用知识库」与钉住的技能是**落 localStorage 的偏好**，而 jsdom 的 localStorage
  // 在同一个文件里的用例之间是共享的——不清就会出现"上一个用例把开关关了，
  // 这一个用例一进来就是关的、再点一下反而打开"这种顺序依赖
  // （这条就是这么被抓出来的：单独跑过、连起来跑挂）。
  window.localStorage.clear()
  listKnowledgeBases.mockResolvedValue({ items: [] })
  listSkills.mockResolvedValue({ items: [], usable: 0 })
  // 默认"手上一条会话都没有"：`listConversations` 的实现是会被 `mockClear` 留下的，
  // 不清成空会让后面的用例落到"最近一条会话"上——那时发送**不会新建会话**，
  // 于是断言新建参数就随用例顺序飘（这条也是这么被抓出来的）
  listConversations.mockResolvedValue([])
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
  // ------------------------------------------------- 输入框上的开关（v0.18）
  //
  // 用户要求：把「使用知识库」单独做一个开关，并在子菜单里选库。
  // 这两条是能被断言的部分——**关掉之后必须能发**（否则开关是假的），
  // 以及文案要跟着状态走（占位符还写着"向知识库提问"就是在骗人）。

  it('默认开着知识库，占位符与触发器都写明依据', async () => {
    listKnowledgeBases.mockResolvedValue({ items: [kb('kb_1', '指南库'), kb('kb_2', '论文库')] })
    const { wrapper } = await mountAt('/chat')
    await flushPromises()

    expect(wrapper.find('.composer-field').attributes('placeholder')).toContain('向知识库提问')
    // 默认全选：打开这一页的人多半就是要问遍手上的资料
    expect(wrapper.find('.tool-kb .tool-trigger-text').text()).toBe('知识库 2 个')
    wrapper.unmount()
  })

  it('关掉开关：文案转成"不使用知识库"，且此时**没有选库也能发**', async () => {
    listKnowledgeBases.mockResolvedValue({ items: [kb('kb_1', '指南库')] })
    const { wrapper } = await mountAt('/chat')
    await flushPromises()

    // 先取消勾选——模拟"开着但一个库都没选"这种发不出去的状态
    await wrapper.find('.tool-kb .tool-check input').setValue(false)
    await wrapper.find('.composer-field').setValue('随便聊聊')
    const sendBtn = wrapper.find('.send-btn')
    expect(sendBtn.attributes('disabled')).toBeDefined()

    // 关掉开关之后同一个输入就该能发了
    await wrapper.find('.tool-kb .tool-switch').trigger('click')
    await flushPromises()

    expect(wrapper.find('.tool-kb .tool-trigger-text').text()).toBe('不使用知识库')
    // 触发器上要能看出"关"这个状态：它会影响答案的性质，藏进菜单里等于没说
    expect(wrapper.find('.tool-kb').classes()).toContain('tool-off')
    expect(wrapper.find('.composer-field').attributes('placeholder')).toContain('纯对话')
    expect(wrapper.find('.send-btn').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  it('关掉开关之后选库框变成不可点（状态与操作要对得上）', async () => {
    listKnowledgeBases.mockResolvedValue({ items: [kb('kb_1', '指南库')] })
    const { wrapper } = await mountAt('/chat')
    await flushPromises()

    await wrapper.find('.tool-kb .tool-switch').trigger('click')
    await flushPromises()

    const box = wrapper.find('.tool-kb .tool-check input')
    expect(box.attributes('disabled')).toBeDefined()
    expect(wrapper.find('.tool-sub-muted').exists()).toBe(true)
    wrapper.unmount()
  })
  // 上面三条钉的是"界面状态对不对"，下面两条钉的是**发出去的东西对不对**——
  // 开关只在界面上断开、请求里还带着库，那就是个假的开关。
  //
  // 都挂在一个**已存在的会话**上（`/chat/c1`）：那样发送不经过"新建会话 + 改路径"，
  // 一步就走到 `chatStream`，断言的东西只有一件——请求体。
  // （先在 `/chat` 上试过，`createConversation` 与路由跳转把断言搅成了顺序依赖。）

  it('关掉知识库后发送：请求里 kb_ids 是空的', async () => {
    listKnowledgeBases.mockResolvedValue({ items: [kb('kb_1', '指南库')] })
    getConversation.mockResolvedValue({ ...chatDetail('c1'), kb_ids: ['kb_1'] })
    chatStream.mockResolvedValue({ abort: vi.fn() })
    const { wrapper } = await mountAt('/chat/c1')
    await flushPromises()

    await wrapper.find('.tool-kb .tool-switch').trigger('click')
    await wrapper.find('.composer-field').setValue('纯聊一句')
    await wrapper.find('.send-btn').trigger('click')
    await flushPromises()

    const payload = chatStream.mock.calls.at(-1)?.[0] as { kb_ids: string[] }
    expect(payload.kb_ids).toEqual([])
    wrapper.unmount()
  })

  it('勾了技能后发送：钉住的技能进了 skill_names', async () => {
    listKnowledgeBases.mockResolvedValue({ items: [kb('kb_1', '指南库')] })
    getConversation.mockResolvedValue({ ...chatDetail('c1'), kb_ids: ['kb_1'] })
    chatStream.mockResolvedValue({ abort: vi.fn() })
    listSkills.mockResolvedValue({
      items: [
        {
          name: '周报',
          description: '写周报的流程',
          source: 'builtin',
          path: '/skills/report',
          directory: 'report',
          used_by_prompt: true,
          flagged: [],
        },
        {
          name: '被拦下的技能',
          description: '',
          source: 'user',
          path: '/skills/bad',
          directory: 'bad',
          // 被安全扫描拦下的**不该出现在可勾列表里**：钉了也不生效，摆出来就是骗人
          used_by_prompt: false,
          flagged: ['含有可疑指令'],
        },
      ],
      usable: 1,
    })
    const { wrapper } = await mountAt('/chat/c1')
    await flushPromises()

    // 展开「加号 → 技能」，勾上周报
    await wrapper.findAll('.tool-plus .tool-item')[1].trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.tool-plus .tool-check-name').map((node) => node.text())).toEqual([
      '周报',
    ])
    await wrapper.find('.tool-plus .tool-check input').setValue(true)

    await wrapper.find('.composer-field').setValue('写个周报')
    await wrapper.find('.send-btn').trigger('click')
    await flushPromises()

    const payload = chatStream.mock.calls.at(-1)?.[0] as { skill_names: string[] }
    expect(payload.skill_names).toEqual(['周报'])
    wrapper.unmount()
  })

  it('输入框上不再有「提示词」入口（v0.19：它搬到知识库里了）', async () => {
    // 用户要求：对话界面的提示词系统去掉，改由知识库设置。
    // 这条钉的是"去掉"这件事本身——留着入口会让人以为还在这里配。
    listKnowledgeBases.mockResolvedValue({ items: [kb('kb_1', '指南库')] })
    const { wrapper } = await mountAt('/chat/c1')
    await flushPromises()

    expect(wrapper.find('.prompt-link').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('提示词')
    // 也确认工具条本身还在（别把整排控件一起删掉了）
    expect(wrapper.find('.tool-kb').exists()).toBe(true)
    wrapper.unmount()
  })
})
