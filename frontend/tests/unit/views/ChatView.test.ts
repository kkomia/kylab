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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'

import type { ConversationDetail, ConversationSummary } from '@/api/conversations'
import type { KnowledgeBase } from '@/api/knowledgeBases'
import { resetToasts, useToast } from '@/composables/useToast'

const listConversations = vi.fn()
const getConversation = vi.fn()
// 知识库清单要能被单个用例改写：v0.18 的「使用知识库」开关会按库数显示不同文案，
// 固定返回空列表就测不到"选了库"那一档
const listKnowledgeBases = vi.fn()
const createConversation = vi.fn()
const rewindConversation = vi.fn()
const chatStream = vi.fn()
const resumeStream = vi.fn()
const listSkills = vi.fn()
// 产物的三条接口（v0.26）：卡片要能知道"文件现在在哪、进没进库"，
// 下载走签名链接，入库要经过「存进知识库」那个弹窗
const listArtifacts = vi.fn()
const ingestArtifact = vi.fn()
const listFiles = vi.fn()
const getFileUrl = vi.fn()
const downloadFile = vi.fn()

vi.mock('@/api/conversations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/conversations')>()
  return {
    ...actual,
    listConversations: (...args: unknown[]) => listConversations(...args),
    getConversation: (...args: unknown[]) => getConversation(...args),
    createConversation: (...args: unknown[]) => createConversation(...args),
    rewindConversation: (...args: unknown[]) => rewindConversation(...args),
    updateConversation: vi.fn(),
    deleteConversation: vi.fn(),
    listArtifacts: (...args: unknown[]) => listArtifacts(...args),
    listFiles: (...args: unknown[]) => listFiles(...args),
    uploadFile: vi.fn(),
    getFileUrl: (...args: unknown[]) => getFileUrl(...args),
    downloadFile: (...args: unknown[]) => downloadFile(...args),
    ingestArtifact: (...args: unknown[]) => ingestArtifact(...args),
  }
})

vi.mock('@/api/chat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/chat')>()
  return {
    ...actual,
    chatStream: (...args: unknown[]) => chatStream(...args),
    resumeStream: (...args: unknown[]) => resumeStream(...args),
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

import { clearLiveTurn, liveTurnState } from '@/composables/useLiveTurn'
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
    archived_at: null,
    preview: '',
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
      {
        id: 'm1',
        role: 'user',
        content: '你好',
        sources: [],
        steps: [],
        thinking: '',
        created_at: null,
      },
      {
        id: 'm2',
        role: 'assistant',
        content: '这是回答',
        sources: [],
        steps: [],
        thinking: '',
        created_at: null,
      },
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
      {
        id: 'm1',
        role: 'user',
        content: '眼轴怎么监测',
        sources: [],
        steps: [],
        thinking: '',
        created_at: null,
      },
      {
        id: 'm2',
        role: 'assistant',
        content: '眼轴是主要参数[1]。',
        created_at: null,
        steps: [],
        thinking: '',
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

/**
 * 展开过程面板。
 *
 * v0.2 起折叠区是 `v-if` 而不是 `v-show`：折叠时步骤、思考与出处**不在 DOM 里**
 * （长会话不再拖着每一轮的这些节点）。所以要点出处的用例得先点开标题那一下。
 */
/**
 * 确保过程面板是展开的。
 *
 * **幂等**——v0.25 起它默认就是展开的（照 Kimi：过程常驻在正文里），
 * 无条件点一下标题反而会把它收起来，于是后面找 `.cite-title` 的用例全落空。
 */
async function expandTrace(wrapper: VueWrapper): Promise<void> {
  const head = wrapper.find('.trace-head')
  if (head.attributes('aria-expanded') === 'true') return
  await head.trigger('click')
  await flushPromises()
}

/** 加号菜单里的一项（按文字找）。 */
function toolItem(wrapper: VueWrapper, label: string) {
  const found = wrapper.findAll('.tool-plus .tool-item').find((node) => node.text().includes(label))
  if (!found) throw new Error(`加号菜单里没有「${label}」`)
  return found
}

/**
 * @param attachTo 把组件挂进 `document.body`。
 *
 * **只有要断言浏览器选区（`document.getSelection()`）的用例需要它**：默认挂载是
 * 挂在一个游离的 div 上，而 jsdom 会**静默丢弃**根不在文档里的选区
 * （`addRange` 之后 `rangeCount` 直接变 0，`toString()` 是空串）。
 * 真实浏览器不这样——这条纯粹是 jsdom 的脾气，但"选中了"这件事只有在这儿才测得出来。
 */
async function mountAt(
  path: string,
  attachTo = false,
): Promise<{ wrapper: VueWrapper; router: Router }> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/chat/:conversationId?', name: 'chat', component: { template: '<div />' } },
      { path: '/knowledge-bases', name: 'knowledge-bases', component: { template: '<div />' } },
    ],
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(ChatView, {
    ...(attachTo ? { attachTo: document.body } : {}),
    global: { plugins: [pinia, router] },
  })
  return { wrapper, router }
}

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  clearConversationDetailCache()
  // **「正在流的那一轮」是模块级状态**（v0.41 起流归 `useLiveTurn` 管，见那个模块的头注释）：
  // 它不随组件卸载消失，所以用例之间会互相传染——上一轮用例把某一轮留在"流式中"，
  // 下一个用例一挂载就被它判成"sending"，发送直接 early-return，看起来像功能坏了。
  // 与 localStorage 同一类问题：**应用级状态，用例里必须自己清**。
  clearLiveTurn()
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
  // 默认"这条会话没有产物"：多数用例不关心卡片，不清的话上一个用例的产物会漏过来
  listArtifacts.mockResolvedValue({ items: [] })
  // 文件抽屉一挂上就会列一次文件区
  listFiles.mockResolvedValue({
    mode: 'object',
    label: '本会话',
    path: '',
    parent: null,
    entries: [],
    truncated: false,
  })
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

  it('过程面板默认展开；**用户收起后**它退出 DOM（不是只被 CSS 藏起来）', async () => {
    // v0.25 起默认展开（照 Kimi：过程是答案的一部分，不该在用户想看时消失），
    // 所以"折叠着不进 DOM"这条契约改成了"**用户收起之后**不进 DOM"。
    // 后半句仍要钉住：这一块装着步骤、思考全文与每条出处的正文预览，
    // 用 `v-show` 的话收起来也照样留在文档里——DOM 节点、文本与布局开销一直在。
    const store = useConversationStore()
    store.rememberDetail(detailWithSource('c1'))

    const { wrapper } = await mountAt('/chat/c1')
    await flushPromises()

    expect(wrapper.findAll('.cite-preview')).toHaveLength(1)

    // 点标题收起 → 整块离开 DOM
    await wrapper.find('.trace-head').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.cite-preview')).toHaveLength(0)

    // 再点回来还在
    await wrapper.find('.trace-head').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.cite-preview')).toHaveLength(1)

    wrapper.unmount()
  })

  it('降级横幅给两个出口：「继续」接着做、「重试」从头来', async () => {
    // 这一轮是降级收尾的（工具循环撞了上限）
    const degraded = detailWithSource('c30')
    degraded.messages[1].steps = [
      {
        phase: 'tool',
        label: '本轮时间已用尽',
        detail: '本轮最多 300 秒，已用 312 秒，按现有信息作答',
        status: 'done',
        degraded: true,
      },
    ] as never
    useConversationStore().rememberDetail(degraded)
    resumeStream.mockResolvedValue({ abort: vi.fn() })

    const { wrapper } = await mountAt('/chat/c30')
    await flushPromises()

    const banner = wrapper.find('.reply-degraded')
    expect(banner.exists()).toBe(true)
    // 提示里的原因来自服务端，前端不写死（两种原因的措辞不同）
    expect(banner.text()).toContain('本轮最多 300 秒，已用 312 秒')

    const resume = wrapper.findAll('button').find((item) => item.text() === '继续')
    expect(resume).toBeTruthy()
    await resume!.trigger('click')
    await flushPromises()

    // **续跑不碰 rewind**：那是"重试"做的事，续跑接着做
    expect(rewindConversation).not.toHaveBeenCalled()
    const [id, payload] = resumeStream.mock.calls[0]
    expect(id).toBe('c30')
    expect(payload).toMatchObject({ skill_names: [] })
    wrapper.unmount()
  })

  it('续跑的事件打进同一条消息，不新开一条回答', async () => {
    const degraded = detailWithSource('c31')
    degraded.messages[1].steps = [
      {
        phase: 'tool',
        label: '工具步数已达上限',
        detail: '本轮最多 1 步',
        status: 'done',
        degraded: true,
      },
    ] as never
    useConversationStore().rememberDetail(degraded)

    // 假实现：立刻回一段正文，模拟"这次跑完了"
    resumeStream.mockImplementation(
      async (_id: string, _payload: unknown, handlers: { onDelta?: (t: string) => void }) => {
        handlers.onDelta?.('补完的正文')
        return { abort: vi.fn() }
      },
    )

    const { wrapper } = await mountAt('/chat/c31')
    await flushPromises()
    const before = wrapper.findAll('.turn').length

    await wrapper
      .findAll('button')
      .find((item) => item.text() === '继续')!
      .trigger('click')
    await flushPromises()

    // 轮次没有多出来：续跑是同一条回答被补完
    expect(wrapper.findAll('.turn')).toHaveLength(before)
    expect(wrapper.text()).toContain('补完的正文')
    wrapper.unmount()
  })

  it('重新生成：先退回一轮，再原样重发那句提问（与 send 共用同一条流式链路）', async () => {
    const store = useConversationStore()
    store.rememberDetail(detailWithSource('c1'))
    rewindConversation.mockResolvedValue(undefined)
    chatStream.mockResolvedValue({ abort: vi.fn() })

    const { wrapper } = await mountAt('/chat/c1')
    await flushPromises()

    const button = wrapper.findAll('button').find((item) => item.text().includes('重新生成'))
    expect(button).toBeTruthy()
    await button!.trigger('click')
    await flushPromises()

    // 服务端先退回（接口失败时不该先清本地），本地消息跟着回退
    expect(rewindConversation).toHaveBeenCalledWith('c1', 1)
    expect(wrapper.findAll('.turn')).toHaveLength(1) // 退回后重新追加了"提问 + 占位回答"

    const [payload] = chatStream.mock.calls[0]
    expect(payload.query).toBe('眼轴怎么监测')
    expect(payload.conversation_id).toBe('c1')
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

    await expandTrace(wrapper)
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

    await expandTrace(wrapper)
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
    await expandTrace(wrapper)
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
    expect(wrapper.find('.tool-kb .tool-trigger-text').text()).toBe('全部 2 个')
    wrapper.unmount()
  })

  it('关掉开关：变成纯对话，且此时**没有选库也能发**', async () => {
    listKnowledgeBases.mockResolvedValue({ items: [kb('kb_1', '指南库')] })
    const { wrapper } = await mountAt('/chat')
    await flushPromises()

    // 先取消勾选——模拟"开着但一个库都没选"这种发不出去的状态
    await wrapper.find('.tool-kb .tool-check input').setValue(false)
    await wrapper.find('.composer-field').setValue('随便聊聊')
    expect(wrapper.find('.send-btn').attributes('disabled')).toBeDefined()

    // 关掉开关之后同一个输入就该能发了
    await wrapper.find('.kb-switch').trigger('click')
    await flushPromises()

    expect(wrapper.find('.kb-switch').attributes('aria-checked')).toBe('false')
    expect(wrapper.find('.composer-field').attributes('placeholder')).toContain('纯对话')
    expect(wrapper.find('.send-btn').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  it('选库入口**只在开关打开时**才在（关掉时它没有意义）', async () => {
    // 用户指定：知识库做成纯开关，"选哪几个"是开启之后才出现的小菜单。
    // 关掉时留着它是噪声——那一步此刻改变不了任何结果。
    listKnowledgeBases.mockResolvedValue({ items: [kb('kb_1', '指南库')] })
    const { wrapper } = await mountAt('/chat')
    await flushPromises()

    expect(wrapper.find('.tool-kb').exists()).toBe(true)
    expect(wrapper.find('.kb-switch').attributes('aria-checked')).toBe('true')

    await wrapper.find('.kb-switch').trigger('click')
    await flushPromises()

    expect(wrapper.find('.tool-kb').exists()).toBe(false)
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

    await wrapper.find('.kb-switch').trigger('click')
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

    // 展开「加号 → 技能」，勾上周报。
    // **按文字找，不按下标**：「浏览文件」是后加的一项，按下标写会在它加进来那天
    // 静默指到别的条目上（这一条就是这么被抓出来的）
    await toolItem(wrapper, '技能').trigger('click')
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

  it('流式期间：思考只占一行（滚动的那一行），全文等这一轮结束再给', async () => {
    // 用户要求"参考 DeepSeek 的 harness"：干活的过程只占一行，最新吐出来的字
    // 从右边进来、旧的往左滚出去——一轮里想了几千字，屏幕上始终只有一行在滚。
    // 思考全文不丢：这一轮结束后它还在过程面板里（下面那条断言）。
    listKnowledgeBases.mockResolvedValue({ items: [kb('kb_1', '指南库')] })
    getConversation.mockResolvedValue({ ...chatDetail('c1'), kb_ids: ['kb_1'] })
    let handlers: {
      onThinking: (chunk: string) => void
      onDone: (answer: string) => void
    } | null = null
    chatStream.mockImplementation((_payload: unknown, h: never) => {
      handlers = h
      return Promise.resolve({ abort: vi.fn() })
    })

    const { wrapper } = await mountAt('/chat/c1')
    await flushPromises()
    await wrapper.find('.composer-field').setValue('查一下')
    await wrapper.find('.send-btn').trigger('click')
    await flushPromises()

    handlers!.onThinking('让我先看看这个库里有什么')
    handlers!.onThinking('，再确认一下版本号')
    await flushPromises()

    const live = wrapper.find('.trace-live')
    expect(live.exists()).toBe(true)
    // 贴的是**最新那一截**（不是"思考过程"四个字，也不是开头）
    expect(live.text()).toContain('再确认一下版本号')
    // 流式期间不铺开整块思考：那一行已经说了它在想什么
    expect(wrapper.find('.thinking').exists()).toBe(false)

    handlers!.onDone('答完了')
    await flushPromises()

    expect(wrapper.find('.trace-live').exists()).toBe(false)
    expect(wrapper.find('.thinking').text()).toContain('让我先看看这个库里有什么')
    wrapper.unmount()
  })

  it('流式中切走再回来：这一轮还在（v0.41，用户报的第 4 条）', async () => {
    // 用户报的现象：回答写到一半切去笔记页，回来这一轮就没了。
    // 根因是"流的所有权跟着页面走"——卸载时 abort、消息数组又是组件局部的。
    // 现在流归 `useLiveTurn`（模块作用域），页面来去自由。
    listKnowledgeBases.mockResolvedValue({ items: [kb('kb_1', '指南库')] })
    getConversation.mockResolvedValue({ ...chatDetail('c1'), kb_ids: ['kb_1'] })
    const abort = vi.fn()
    let handlers: {
      onThinking: (chunk: string) => void
      onDelta: (chunk: string) => void
      onDone: (answer: string) => void
    } | null = null
    chatStream.mockImplementation((_payload: unknown, h: never) => {
      handlers = h
      return Promise.resolve({ abort })
    })

    const { wrapper } = await mountAt('/chat/c1')
    await flushPromises()
    await wrapper.find('.composer-field').setValue('查一下')
    await wrapper.find('.send-btn').trigger('click')
    await flushPromises()
    handlers!.onThinking('先看看库里有什么')
    handlers!.onDelta('半截回答')
    await flushPromises()
    expect(wrapper.text()).toContain('半截回答')

    // **离开这一页**：不该掐掉流（掐掉的话后端那一轮也白跑了）
    wrapper.unmount()
    expect(abort).not.toHaveBeenCalled()

    // 人走了，字还在进（服务端照跑，模块照收）
    handlers!.onDelta('，继续写')
    await flushPromises()

    // 回来：这一轮仍在画面上，且带着离开期间流出来的那部分
    const again = await mountAt('/chat/c1')
    await flushPromises()
    expect(again.wrapper.text()).toContain('半截回答')
    expect(again.wrapper.text()).toContain('继续写')

    // 这一轮写完（后端此刻才落库）：再回来就是**库里那份**，不再挂临时的那一轮。
    // 替身要在 `onDone` **之前**就跟上——真服务端在这一刻已经有这条消息了，
    // 而收尾那一跳（`finish` → `refreshDetail`）会拿它把缓存校准一次。
    const stored = chatDetail('c1')
    getConversation.mockResolvedValue({
      ...stored,
      kb_ids: ['kb_1'],
      messages: [stored.messages[0], { ...stored.messages[1], content: '半截回答，继续写。' }],
    })
    handlers!.onDone('半截回答，继续写。')
    await flushPromises()
    // 探针：模块收到 done 了吗
    expect(liveTurnState.value).toMatchObject({ streaming: false, text: '半截回答，继续写。' })
    expect(again.wrapper.text()).toContain('半截回答，继续写。')
    again.wrapper.unmount()
    const third = await mountAt('/chat/c1')
    await flushPromises()
    expect(third.wrapper.text()).toContain('半截回答，继续写。')
    // 而且**没有多出一轮**：临时那一轮该被忘掉（否则回来会看到两份回答）
    expect(third.wrapper.findAll('.turn')).toHaveLength(1)
    third.wrapper.unmount()
  })

  it('出处很多时只铺前几条，其余折成一行「还有 N 条」（v0.41，第 13 条）', async () => {
    // 用户报的现象：一次检索命中上百个片段，回答下面接了一条比回答还长的出处墙。
    // 现在的规矩：**前几条永远显示**（有没有依据是这一页存在的理由），多出来的折起来。
    const many = detailWithSource('c50')
    const first = many.messages[1].sources[0]
    many.messages[1].sources = Array.from({ length: 12 }, (_, i) => ({
      ...first,
      index: i + 1,
      chunk_id: `chunk${i + 1}`,
      document_name: `资料${i + 1}.pdf`,
    }))
    getConversation.mockResolvedValue(many)

    const { wrapper } = await mountAt('/chat/c50')
    await flushPromises()

    const before = wrapper.findAll('.cite')
    expect(before).toHaveLength(3)
    expect(wrapper.text()).toContain('资料3.pdf')
    expect(wrapper.text()).not.toContain('资料4.pdf')
    expect(wrapper.find('.cite-fold-toggle').text()).toContain('还有 9 条出处')

    await wrapper.find('.cite-fold-toggle').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.cite')).toHaveLength(12)
    expect(wrapper.text()).toContain('资料12.pdf')
    expect(wrapper.find('.cite-fold-toggle').text()).toContain('收起出处')

    await wrapper.find('.cite-fold-toggle').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.cite')).toHaveLength(3)
    wrapper.unmount()
  })

  it('点行内徽标落到折叠区里的那一条时，先把出处展开（否则滚到不存在的节点）', async () => {
    const many = detailWithSource('c51')
    const first = many.messages[1].sources[0]
    many.messages[1].content = '结论在这里[8]。'
    many.messages[1].sources = Array.from({ length: 10 }, (_, i) => ({
      ...first,
      index: i + 1,
      chunk_id: `chunk${i + 1}`,
      document_name: `资料${i + 1}.pdf`,
    }))
    getConversation.mockResolvedValue(many)

    const { wrapper } = await mountAt('/chat/c51')
    await flushPromises()

    // 第 8 条默认在折叠区里
    expect(wrapper.find('[data-source="8"]').exists()).toBe(false)
    const chip = wrapper.find('[data-cite-index="8"]')
    expect(chip.exists()).toBe(true)
    await chip.trigger('click')
    await flushPromises()

    // 展开之后它才在 DOM 里（滚动那一步才有落点）
    expect(wrapper.find('[data-source="8"]').exists()).toBe(true)
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

  // ------------------------------------------------- 输入框重排（v0.19）

  it('模型选择在右端、知识库开关在左端', async () => {
    // 用户指定：模型下拉放右侧。左边是"给这一轮什么"（附件/技能/知识库），
    // 右边是"怎么生成 + 发出去"——两类动作各占一端，扫视时不用在中间找。
    listKnowledgeBases.mockResolvedValue({ items: [kb('kb_1', '指南库')] })
    const { wrapper } = await mountAt('/chat')
    await flushPromises()

    expect(wrapper.find('.composer-right .pick-model').exists()).toBe(true)
    expect(wrapper.find('.composer-left .pick-model').exists()).toBe(false)
    expect(wrapper.find('.composer-left .kb-switch').exists()).toBe(true)
    wrapper.unmount()
  })

  it('技能子菜单往右飞出，不把菜单撑长', async () => {
    listKnowledgeBases.mockResolvedValue({ items: [kb('kb_1', '指南库')] })
    listSkills.mockResolvedValue({
      items: [
        {
          name: '周报',
          description: '写周报',
          source: 'builtin',
          path: '/skills/report',
          directory: 'report',
          used_by_prompt: true,
          flagged: [],
        },
      ],
      usable: 1,
    })
    const { wrapper } = await mountAt('/chat')
    await flushPromises()

    await toolItem(wrapper, '技能').trigger('click')
    await flushPromises()

    const flyout = wrapper.find('.tool-plus .tool-flyout')
    expect(flyout.exists()).toBe(true)
    // 贴着刚才那一行（top 由 JS 从 offsetTop 记下），而不是跟着列表往下堆
    expect(flyout.attributes('style')).toContain('top:')
    expect(flyout.text()).toContain('周报')
    wrapper.unmount()
  })

  it('第一轮对话之前，欢迎层与输入框作为一组居中', async () => {
    // 用户指定：没有对话时输入框在屏幕中间（照 Kimi 的第一轮）。
    // 贴底会让整屏下方堆着东西、上方全空。
    listKnowledgeBases.mockResolvedValue({ items: [kb('kb_1', '指南库')] })
    const empty = await mountAt('/chat')
    await flushPromises()
    expect(empty.wrapper.find('.chat').classes()).toContain('chat-centered')
    empty.wrapper.unmount()

    // 有对话之后回到"消息区撑满、输入框贴底"
    getConversation.mockResolvedValue(chatDetail('c1'))
    const loaded = await mountAt('/chat/c1')
    await flushPromises()
    expect(loaded.wrapper.find('.chat').classes()).not.toContain('chat-centered')
    loaded.wrapper.unmount()
  })

  it('推荐问题**只在选中知识库之后**才显示（关掉就整块消失）', async () => {
    // 用户指定：没选中库时不显示推荐问题。那些问题是从库里语料出的题，
    // 没有库就没有依据——摆一排样例等于暗示"随便点一个"，点了也答不出东西。
    listKnowledgeBases.mockResolvedValue({ items: [kb('kb_1', '指南库')] })
    const { wrapper } = await mountAt('/chat')
    await flushPromises()

    // 开着且在库里：显示
    expect(wrapper.find('.welcome-samples').exists()).toBe(true)
    expect(wrapper.text()).toContain('你可以这样问我')

    // 关掉开关（= 没选中任何库）：整块消失
    await wrapper.find('.kb-switch').trigger('click')
    await flushPromises()
    expect(wrapper.find('.welcome-samples').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('你可以这样问我')

    // 再打开：回来
    await wrapper.find('.kb-switch').trigger('click')
    await flushPromises()
    expect(wrapper.find('.welcome-samples').exists()).toBe(true)
    wrapper.unmount()
  })

  it('开着但一个库都没勾：同样不显示推荐问题', async () => {
    listKnowledgeBases.mockResolvedValue({ items: [kb('kb_1', '指南库')] })
    const { wrapper } = await mountAt('/chat')
    await flushPromises()

    await wrapper.find('.tool-kb .tool-check input').setValue(false)
    await flushPromises()

    expect(wrapper.find('.welcome-samples').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('产出物卡片（v0.26）', () => {
  /** 一条回答里挂着一张文件卡片：导出类工具跑完之后的样子。 */
  function detailWithArtifact(id: string, artifact: Record<string, unknown>): ConversationDetail {
    return {
      ...summary(id),
      messages: [
        {
          id: 'm1',
          role: 'user',
          content: '写一首四句的短诗，导出成 docx',
          sources: [],
          steps: [],
          thinking: '',
          created_at: null,
        },
        {
          id: 'm2',
          role: 'assistant',
          content: '已经导出。',
          sources: [],
          thinking: '',
          created_at: null,
          steps: [
            { phase: 'intent', label: '理解问题', detail: '', status: 'done' },
            {
              phase: 'tool',
              label: '导出文档',
              detail: '已生成',
              status: 'done',
              artifacts: [
                {
                  artifact_id: 'art_1',
                  name: '短诗.docx',
                  size_bytes: 36864,
                  format: 'docx',
                  storage: 'object',
                  where: '本会话',
                  ...artifact,
                },
              ],
            },
          ],
        },
      ],
    }
  }

  it('卡片写明文件落在哪，并给「存进知识库」的入口', async () => {
    getConversation.mockResolvedValue(detailWithArtifact('c1', {}))
    const { wrapper } = await mountAt('/chat/c1')
    await flushPromises()

    const card = wrapper.find('.artifact')
    expect(card.text()).toContain('短诗.docx')
    // 落点要说人话：用户要知道文件去哪了，"本会话"与"工作区「X」"是两种处境
    expect(card.text()).toContain('本会话')
    expect(wrapper.find('.artifact-kb').text()).toBe('存进知识库')
    expect(wrapper.find('.artifact-kb-done').exists()).toBe(false)
    wrapper.unmount()
  })

  it('已入库的卡片显示"已存进知识库"，不再给按钮', async () => {
    getConversation.mockResolvedValue(
      detailWithArtifact('c2', { knowledge_base_id: 'kb_1', document_id: 'doc_1' }),
    )
    listKnowledgeBases.mockResolvedValue({ items: [kb('kb_1', '资料库')] })
    const { wrapper } = await mountAt('/chat/c2')
    await flushPromises()

    expect(wrapper.find('.artifact-kb').exists()).toBe(false)
    expect(wrapper.find('.artifact-kb-done').text()).toContain('资料库')
    wrapper.unmount()
  })

  it('列表接口说的算：快照里没入库、现在入了，卡片跟着变', async () => {
    // 步骤快照是流式当时写下的，而入库发生在之后——不以列表为准的话，
    // 刷新一次卡片就退回"存进知识库"了
    getConversation.mockResolvedValue(detailWithArtifact('c3', {}))
    listArtifacts.mockResolvedValue({
      items: [
        {
          artifact_id: 'art_1',
          name: '短诗.docx',
          size_bytes: 36864,
          format: 'docx',
          storage: 'object',
          where: '本会话',
          path: null,
          knowledge_base_id: 'kb_1',
          document_id: 'doc_1',
          created_at: null,
        },
      ],
    })
    listKnowledgeBases.mockResolvedValue({ items: [kb('kb_1', '资料库')] })
    const { wrapper } = await mountAt('/chat/c3')
    await flushPromises()

    expect(wrapper.find('.artifact-kb-done').text()).toContain('资料库')
    wrapper.unmount()
  })

  it('点「存进知识库」：先挑库，确认后才真的入库', async () => {
    getConversation.mockResolvedValue(detailWithArtifact('c4', {}))
    listKnowledgeBases.mockResolvedValue({
      items: [kb('kb_1', '资料库'), kb('kb_2', '笔记')],
    })
    ingestArtifact.mockResolvedValue({
      artifact_id: 'art_1',
      name: '短诗.docx',
      size_bytes: 36864,
      format: 'docx',
      storage: 'object',
      where: '本会话',
      path: null,
      knowledge_base_id: 'kb_2',
      document_id: 'doc_9',
      created_at: null,
    })
    const { wrapper } = await mountAt('/chat/c4')
    await flushPromises()

    await wrapper.find('.artifact-kb').trigger('click')
    await flushPromises()

    // 弹窗里能看见库名（两个都在），默认选中第一个
    const picks = wrapper.findAll('.ingest-pick')
    expect(picks.map((item) => item.text())).toEqual(['资料库', '笔记'])
    expect(picks[0].attributes('aria-pressed')).toBe('true')

    // 选第二个再确认——**"放进哪个库"是用户的事**，所以这一步不能省
    await picks[1].trigger('click')
    await flushPromises()
    expect(picks[1].attributes('aria-pressed')).toBe('true')
    expect(ingestArtifact).not.toHaveBeenCalled()

    const confirm = wrapper.findAll('button').find((item) => item.text().includes('存进这个库'))
    await confirm!.trigger('click')
    await flushPromises()

    // 点的是「笔记」——就存进「笔记」，服务端不会替他改主意
    expect(ingestArtifact).toHaveBeenCalledWith('c4', 'art_1', 'kb_2')
    // 卡片当场换成已入库：用户点完按钮最想看到的就是这一句反馈
    expect(wrapper.find('.artifact-kb-done').text()).toContain('笔记')
    wrapper.unmount()
  })

  it('点卡片是**预览**（打开文件抽屉），不是直接下载', async () => {
    getConversation.mockResolvedValue(detailWithArtifact('c5', {}))
    const { wrapper } = await mountAt('/chat/c5')
    await flushPromises()

    expect(wrapper.find('.drawer-backdrop').exists()).toBe(false)
    await wrapper.find('.artifact-main').trigger('click')

    // 抽屉开了，并且直接落在这份文件上（不是先给一份目录让人自己找）。
    // `waitFor` 而不是一次 flush：抽屉是**异步组件**，动态 import 要多等一拍
    await vi.waitFor(() => expect(wrapper.find('.drawer-backdrop').exists()).toBe(true))
    expect(wrapper.findComponent({ name: 'FileDrawer' }).props('initialKey')).toBe('art_1')
    // **名字与格式也要一起给**（v0.41）：产物在临时区的 key 就是 artifact_id，
    // 抽屉光看它猜不出扩展名 → 预览会判成"没有可用的渲染器"，用户看到"无法预览"
    // （而从工作区点开同一份却正常，因为那边列表里有真名字）。用户报的就是这个。
    expect(wrapper.findComponent({ name: 'FileDrawer' }).props('initialEntry')).toMatchObject({
      key: 'art_1',
      name: '短诗.docx',
      kind: 'docx',
    })
    wrapper.unmount()
  })

  it('加号菜单里的「浏览文件」直接进目录，不带具体文件', async () => {
    getConversation.mockResolvedValue(detailWithArtifact('c6', {}))
    const { wrapper } = await mountAt('/chat/c6')
    await flushPromises()

    await toolItem(wrapper, '浏览文件').trigger('click')
    await vi.waitFor(() => expect(wrapper.find('.drawer-backdrop').exists()).toBe(true))

    expect(wrapper.findComponent({ name: 'FileDrawer' }).props('initialKey')).toBeNull()
    // 浏览态列的是文件区（一次请求），预览态才去签名取内容
    expect(listFiles).toHaveBeenCalledWith('c6', '')
    wrapper.unmount()
  })
})

describe('过程面板：同类工具合并（v0.26）', () => {
  /** 一次工具调用。`tool` 是后端给的原始工具名——分组与图标都按它来。 */
  function toolCall(tool: string, label: string, detail: string) {
    return { phase: 'tool', tool, label, detail, status: 'done' }
  }

  function detailWithToolCalls(id: string, steps: unknown[]): ConversationDetail {
    return {
      ...summary(id),
      messages: [
        {
          id: 'm1',
          role: 'user',
          content: '查一下',
          sources: [],
          steps: [],
          thinking: '',
          created_at: null,
        },
        {
          id: 'm2',
          role: 'assistant',
          content: '查到了。',
          sources: [],
          thinking: '',
          created_at: null,
          steps: steps as never,
        },
      ],
    }
  }

  it('九行并成两行：入口上写着次数，点开才是每一次', async () => {
    getConversation.mockResolvedValue(
      detailWithToolCalls('c7', [
        toolCall('web_search', '联网搜索', '查 A'),
        toolCall('web_fetch', '抓取网页', '读 A'),
        toolCall('web_search', '联网搜索', '查 B'),
        toolCall('web_search', '联网搜索', '查 C'),
        toolCall('web_fetch', '抓取网页', '读 B'),
      ]),
    )
    const { wrapper } = await mountAt('/chat/c7')
    await flushPromises()

    const groups = wrapper.findAll('.step-group')
    expect(groups).toHaveLength(2)
    expect(groups[0].text()).toContain('联网搜索')
    expect(groups[0].text()).toContain('3 次')
    expect(groups[1].text()).toContain('2 次')

    // 收起时**看不到**那几次的具体内容——这正是合并的意义
    expect(groups[0].text()).not.toContain('查 A')

    await groups[0].find('.step-toggle').trigger('click')
    await flushPromises()

    expect(groups[0].text()).toContain('查 A')
    // 组内每一条都还是完整的一步：带自己的工具名与原文入口
    expect(groups[0].findAll('.step-child')).toHaveLength(3)
    wrapper.unmount()
  })

  it('只调一次的工具不并：不该为了统一多给一层点击', async () => {
    getConversation.mockResolvedValue(
      detailWithToolCalls('c8', [
        toolCall('web_search', '联网搜索', '查 A'),
        toolCall('remember', '记住', '记了一条'),
      ]),
    )
    const { wrapper } = await mountAt('/chat/c8')
    await flushPromises()

    expect(wrapper.findAll('.step-group')).toHaveLength(0)
    expect(wrapper.text()).toContain('联网搜索')
    expect(wrapper.text()).toContain('记住')
    wrapper.unmount()
  })

  it('同类工具画同一个图标，不同类的不一样', async () => {
    getConversation.mockResolvedValue(
      detailWithToolCalls('c9', [
        toolCall('web_search', '联网搜索', '查 A'),
        toolCall('remember', '记住', '记了一条'),
        toolCall('export_document', '导出文档', '已生成'),
      ]),
    )
    const { wrapper } = await mountAt('/chat/c9')
    await flushPromises()

    // 改之前这里三行画的是同一个方块——扫过去等于没有信息
    const shapes = wrapper.findAll('.steps .step .step-icon svg').map((node) => node.html())
    expect(new Set(shapes).size).toBe(3)
    wrapper.unmount()
  })
})

describe('过程里的网址也是链接（v0.26）', () => {
  it('搜索结果那一行的网址可点，且不带句读', async () => {
    getConversation.mockResolvedValue({
      ...summary('c10'),
      messages: [
        {
          id: 'm1',
          role: 'user',
          content: '查一下',
          sources: [],
          steps: [],
          thinking: '',
          created_at: null,
        },
        {
          id: 'm2',
          role: 'assistant',
          content: '查到了。',
          sources: [],
          thinking: '',
          created_at: null,
          steps: [
            {
              phase: 'tool',
              tool: 'web_search',
              label: '联网搜索',
              detail:
                '检索词：高德 ETA，共 2 条： [1] 高德技术 https://amap.com/a。 [2] 博客 https://blog.example.com/b，',
              status: 'done',
            },
          ] as never,
        },
      ],
    })
    const { wrapper } = await mountAt('/chat/c10')
    await flushPromises()

    const links = wrapper.findAll('.step-detail a')
    expect(links.map((node) => node.attributes('href'))).toEqual([
      'https://amap.com/a',
      'https://blog.example.com/b',
    ])
    // 中文句读留在正文里，不跟着进 href
    expect(wrapper.find('.step-detail').text()).toContain('。')
    wrapper.unmount()
  })
})

describe('交付物摆在正文之后（v0.26）', () => {
  function detailWithPpt(id: string): ConversationDetail {
    return {
      ...summary(id),
      messages: [
        {
          id: 'm1',
          role: 'user',
          content: '做个 ppt',
          sources: [],
          steps: [],
          thinking: '',
          created_at: null,
        },
        {
          id: 'm2',
          role: 'assistant',
          content: '做好了。',
          sources: [],
          thinking: '',
          created_at: null,
          steps: [
            {
              phase: 'tool',
              tool: 'web_search',
              label: '联网搜索',
              detail: '共 6 条',
              status: 'done',
            },
            {
              phase: 'tool',
              tool: 'export_deck',
              label: '导出幻灯',
              detail: '已生成「攻略.pptx」（45 KB）',
              status: 'done',
              artifacts: [
                {
                  artifact_id: 'art_1',
                  name: '攻略.pptx',
                  size_bytes: 46153,
                  format: 'pptx',
                  storage: 'object',
                  where: '本会话',
                },
              ],
            },
            { phase: 'answer', label: '组织回答', detail: '共 708 字', status: 'done' },
          ] as never,
        },
      ],
    }
  }

  it('卡片挂在正文之后，**不在过程面板里**', async () => {
    // 改之前它挂在那一步下面：交付物出现在过程**中间**，要往下翻十来步才看得到，
    // 而面板一收起卡片就跟着没了。交付物是这个回合的结果，不是过程的中间产物。
    getConversation.mockResolvedValue(detailWithPpt('c11'))
    const { wrapper } = await mountAt('/chat/c11')
    await flushPromises()

    const card = wrapper.find('.deliverables .artifact')
    expect(card.exists()).toBe(true)
    expect(card.text()).toContain('攻略.pptx')

    // 不在步骤列表里
    expect(wrapper.find('.steps .artifact').exists()).toBe(false)

    // 位置：正文之后、动作之前
    const html = wrapper.find('.reply-body').html()
    expect(html.indexOf('reply-text')).toBeLessThan(html.indexOf('deliverables'))
    expect(html.indexOf('deliverables')).toBeLessThan(html.indexOf('reply-actions'))
    wrapper.unmount()
  })

  it('把过程面板收起来，卡片仍然在', async () => {
    getConversation.mockResolvedValue(detailWithPpt('c12'))
    const { wrapper } = await mountAt('/chat/c12')
    await flushPromises()

    await wrapper.find('.trace-head').trigger('click')
    await flushPromises()

    expect(wrapper.find('.steps').exists()).toBe(false)
    expect(wrapper.find('.deliverables .artifact').exists()).toBe(true)
    wrapper.unmount()
  })
})

describe('结论那一行不铺 JSON（v0.26）', () => {
  it('老快照里的原始 JSON 不显示，人话摘要照常显示', async () => {
    // 老快照（v0.26 之前存的）里，导出/记住这两步的结论就是结果开头的 JSON。
    // 后端已经给它们补了摘要，这一条挡的是**已经存在库里的那些**。
    getConversation.mockResolvedValue({
      ...summary('c13'),
      messages: [
        {
          id: 'm1',
          role: 'user',
          content: '做个 ppt',
          sources: [],
          steps: [],
          thinking: '',
          created_at: null,
        },
        {
          id: 'm2',
          role: 'assistant',
          content: '做好了。',
          sources: [],
          thinking: '',
          created_at: null,
          steps: [
            // 被裁到 120 字，**解析不了**——所以判据必须是结构而不是 JSON.parse
            {
              phase: 'tool',
              tool: 'export_deck',
              label: '导出幻灯',
              detail:
                '{"artifact_id": "art_89cb41c4a654", "name": "酒馆战棋S14上分攻略_2026年9月.pptx", "saved_to…',
              status: 'done',
            },
            {
              phase: 'tool',
              tool: 'remember',
              label: '记住',
              detail: '{"saved": true, "entries": 1, "note": "已写入核心长期记忆…',
              status: 'done',
            },
            {
              phase: 'tool',
              tool: 'web_search',
              label: '联网搜索',
              detail: '检索词：酒馆战棋，共 8 条：[1]…',
              status: 'done',
            },
          ] as never,
        },
      ],
    })
    const { wrapper } = await mountAt('/chat/c13')
    await flushPromises()

    const text = wrapper.text()
    expect(text).not.toContain('artifact_id')
    expect(text).not.toContain('"saved"')
    // 人话那一条照常
    expect(text).toContain('检索词：酒馆战棋')
    // 标签还在：那一步确实发生过
    expect(text).toContain('导出幻灯')
    wrapper.unmount()
  })
})

/* ------------------------------------------------------------ 代码块 / 表格的复制（§12.205）

   用户实测：点代码块的复制按钮，弹出的全是"复制失败"。根因是异步剪贴板要求
   文档聚焦（`NotAllowedError: Document is not focused.`），而失焦是常态。
   这两条用例盯的是**兜底真的接上了**——组件的接线（成功打勾 / 失败替用户选中）
   单独在 `composables/clipboard.test.ts` 里测不到。 */

/** 一段带围栏代码块与表格的回答。 */
function detailWithBlocks(id: string): ConversationDetail {
  return {
    ...summary(id),
    messages: [
      {
        id: 'm1',
        role: 'user',
        content: '怎么核对镜像架构',
        sources: [],
        steps: [],
        thinking: '',
        created_at: null,
      },
      {
        id: 'm2',
        role: 'assistant',
        thinking: '',
        sources: [],
        steps: [],
        created_at: null,
        content:
          '拉之前先核一下：\n\n' +
          '```bash\ndocker manifest inspect dbeaver/cloudbeaver:latest | grep architecture\n```\n\n' +
          '| 架构 | 机器 |\n| --- | --- |\n| arm64 | 鲲鹏 |\n',
      },
    ],
  }
}

describe('代码块与表格的复制按钮', () => {
  /** 换掉 `navigator.clipboard`（jsdom 里本来没有它）。 */
  function stubClipboard(writeText: () => Promise<void>): void {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  }

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    Object.defineProperty(document, 'execCommand', {
      value: undefined,
      configurable: true,
      writable: true,
    })
    // 挂到 body 上的那个用例留下的 DOM（含它设置的选区）
    document.body.innerHTML = ''
    resetToasts()
  })

  it('剪贴板正常时复制代码块：只取 pre 的文本（不带语言名），按钮变成已复制', async () => {
    getConversation.mockResolvedValue(detailWithBlocks('c20'))
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubClipboard(writeText)

    const { wrapper } = await mountAt('/chat/c20')
    await flushPromises()

    const button = wrapper.find('[data-copy-code]')
    expect(button.exists()).toBe(true)
    await button.trigger('click')
    await flushPromises()

    expect(writeText).toHaveBeenCalledWith(
      'docker manifest inspect dbeaver/cloudbeaver:latest | grep architecture',
    )
    // "已复制"的反馈走属性（图标是背景图切的，不换 DOM）
    expect(button.attributes('data-copied')).toBeTruthy()
    wrapper.unmount()
  })

  it('剪贴板失焦（真实报错）时复制仍然成功——退回 execCommand 那条路', async () => {
    getConversation.mockResolvedValue(detailWithBlocks('c21'))
    stubClipboard(() =>
      Promise.reject(new DOMException('Document is not focused.', 'NotAllowedError')),
    )
    const legacy = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', {
      value: legacy,
      configurable: true,
      writable: true,
    })

    const { wrapper } = await mountAt('/chat/c21')
    await flushPromises()

    await wrapper.find('[data-copy-code]').trigger('click')
    await flushPromises()

    expect(legacy).toHaveBeenCalledWith('copy')
    expect(useToast().toasts.value).toHaveLength(0)
    expect(wrapper.find('[data-copy-code]').attributes('data-copied')).toBeTruthy()
    wrapper.unmount()
  })

  it('两条路都断了：把代码替用户选中，并说清按 Ctrl+C 就行', async () => {
    getConversation.mockResolvedValue(detailWithBlocks('c22'))
    stubClipboard(() =>
      Promise.reject(new DOMException('Document is not focused.', 'NotAllowedError')),
    )
    Object.defineProperty(document, 'execCommand', {
      value: vi.fn(() => false),
      configurable: true,
      writable: true,
    })

    const { wrapper } = await mountAt('/chat/c22', true)
    await flushPromises()

    await wrapper.find('[data-copy-code]').trigger('click')
    await flushPromises()

    // 选中是真的（复制从此刻起是本地操作，用户按 Ctrl+C 必然拿到）
    expect(document.getSelection()?.toString()).toBe(
      'docker manifest inspect dbeaver/cloudbeaver:latest | grep architecture',
    )
    expect(useToast().toasts.value.map((toast) => toast.message)).toContain(
      '已替你选中，按 Ctrl+C 复制',
    )
    wrapper.unmount()
  })

  it('表格复制给的是制表符分隔：粘进表格工具会拆成单元格', async () => {
    getConversation.mockResolvedValue(detailWithBlocks('c23'))
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubClipboard(writeText)

    const { wrapper } = await mountAt('/chat/c23')
    await flushPromises()

    await wrapper.find('[data-copy-table]').trigger('click')
    await flushPromises()

    expect(writeText).toHaveBeenCalledWith('架构\t机器\narm64\t鲲鹏')
    wrapper.unmount()
  })
})
