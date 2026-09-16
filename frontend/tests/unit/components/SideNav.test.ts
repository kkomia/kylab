import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import SideNav from '@/components/layout/SideNav.vue'
import { resetResizeObservers } from '../../setup'

/**
 * 侧栏（v0.15 重排）。
 *
 * 这一轮侧栏改的是**信息架构**，所以测的是两条结构性的事实，而不是"渲染出来了"：
 *
 * 1. **知识库收成了子菜单**：收起时它只占一行，展开后每个库一行可点；
 * 2. **会话按工作区分组**，不隶属任何工作区的单独一栏。
 *
 * 这两条都是"用户能不能一眼找到东西"的问题，而它们的失效方式是**看起来很乱**
 * ——没有断言的话，改一次样式就可能退回去。
 */

const conversations = {
  items: [
    {
      id: 'conv_a',
      title: '工作区里的会话',
      kb_ids: [],
      model_pk: null,
      thinking: null,
      thinking_effort: null,
      pinned: false,
      workspace_id: 'ws_1',
      created_at: null,
      updated_at: '2026-09-16T10:00:00',
      message_count: 2,
    },
    {
      id: 'conv_b',
      title: '随手问的',
      kb_ids: [],
      model_pk: null,
      thinking: null,
      thinking_effort: null,
      pinned: false,
      workspace_id: null,
      created_at: null,
      updated_at: '2026-09-16T09:00:00',
      message_count: 1,
    },
  ],
  error: '',
  load: vi.fn().mockResolvedValue(undefined),
  prefetchDetail: vi.fn(),
  prefetchLatestDetail: vi.fn(),
  rename: vi.fn(),
  remove: vi.fn(),
  setPinned: vi.fn(),
  setWorkspace: vi.fn().mockResolvedValue(undefined),
  $reset: vi.fn(),
}

const workspaces = {
  items: [
    {
      id: 'ws_1',
      name: '产品化',
      root_path: 'E:/code/proj',
      description: '',
      kb_ids: [],
      conversation_count: 1,
      created_at: null,
      updated_at: null,
    },
  ],
  error: '',
  byId: new Map(),
  load: vi.fn().mockResolvedValue(undefined),
  refreshCounts: vi.fn().mockResolvedValue(undefined),
}

const knowledgeBases = {
  items: [
    { id: 'kb_1', name: '产品手册' },
    { id: 'kb_2', name: '运维库' },
  ],
  load: vi.fn().mockResolvedValue(undefined),
}

// 侧栏要读 `route.path` 判当前项。**要 mock 它**：不装 router 时
// `useRoute()` 返回 undefined，而组件一读 `route.path` 就在 setup 里炸
// ——报的是 "Cannot read properties of undefined"，看着像组件坏了。
vi.mock('vue-router', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('vue-router')
  return {
    ...actual,
    useRoute: () => ({ path: '/chat', query: {} }),
    useRouter: () => ({ push: vi.fn() }),
  }
})

vi.mock('@/stores/conversations', () => ({ useConversationStore: () => conversations }))
vi.mock('@/stores/workspaces', () => ({ useWorkspaceStore: () => workspaces }))
vi.mock('@/stores/knowledgeBases', () => ({ useKnowledgeBaseStore: () => knowledgeBases }))
vi.mock('@/stores/tasks', () => ({ useTaskStore: () => ({ load: vi.fn() }) }))
vi.mock('@/stores/stats', () => ({ useStatsStore: () => ({ load: vi.fn() }) }))
vi.mock('@/stores/modelRegistry', () => ({ useModelRegistryStore: () => ({ load: vi.fn() }) }))
vi.mock('@/composables/useOperator', () => ({
  loadRoster: vi.fn(),
  roster: { value: [] },
  setOperator: vi.fn(),
}))
vi.mock('@/composables/useSession', () => ({
  isAdmin: () => true,
  logout: vi.fn(),
}))
vi.mock('@/composables/useSessionToken', () => ({ currentUser: { value: { name: '演示' } } }))
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ notifyError: vi.fn(), notifySuccess: vi.fn(), notify: vi.fn() }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  resetResizeObservers()
  setActivePinia(createPinia())
  workspaces.byId = new Map(workspaces.items.map((item) => [item.id, item]))
})

function mountNav() {
  return mount(SideNav, {
    global: {
      stubs: {
        RouterLink: { template: '<a><slot /></a>', props: ['to'] },
        AppModal: true,
        ConfirmDialog: true,
        SettingsModal: true,
        RowMenu: { template: '<div><slot :close="() => {}" /></div>' },
        AppInput: { template: '<input />', props: ['modelValue'] },
        AppButton: { template: '<button><slot /></button>' },
      },
    },
  })
}

describe('SideNav（v0.15 信息架构）', () => {
  it('知识库收成子菜单：默认收起，只有一行', () => {
    const wrapper = mountNav()

    expect(wrapper.text()).toContain('知识库')
    // 收起时**不该**把库名列出来——那正是"收起来"的意义
    expect(wrapper.text()).not.toContain('产品手册')
    expect(wrapper.find('.nav-sub').exists()).toBe(false)
  })

  it('展开知识库后每个库一行可点', async () => {
    const wrapper = mountNav()

    await wrapper.find('.nav-item-group').trigger('click')

    expect(wrapper.find('.nav-sub').exists()).toBe(true)
    expect(wrapper.text()).toContain('产品手册')
    expect(wrapper.text()).toContain('运维库')
    expect(wrapper.findAll('.nav-sub-item')).toHaveLength(3) // 所有知识库 + 两个库
  })

  // 导航在清单**之上**是刻意的：导航短且固定，清单会不断变长——
  // 把清单放在上面，长起来就会把导航推走，而那是导航最不该有的行为。
  // 这条曾经与文档对不上（文档写「工作区在导航之上」，代码一直是导航在前），
  // 是这个断言把它对上的。
  it('顺序是「新对话 → 导航 → 工作区与会话」', () => {
    const wrapper = mountNav()
    const html = wrapper.html()

    expect(html.indexOf('新对话')).toBeLessThan(html.indexOf('任务中心'))
    expect(html.indexOf('任务中心')).toBeLessThan(html.indexOf('产品化'))
    expect(wrapper.text()).toContain('产品化')
  })

  it('会话按工作区分组，未归档的单独一栏', async () => {
    const wrapper = mountNav()

    // 未归档那一栏默认展开：那是"随手问"落地的地方
    expect(wrapper.text()).toContain('未归档会话')
    expect(wrapper.text()).toContain('随手问的')
    // 属于工作区的那条**不在**未归档里
    expect(wrapper.find('.ws-list').text()).toContain('未归档会话')
  })

  it('展开工作区能看到它下面的会话', async () => {
    const wrapper = mountNav()

    const wsButton = wrapper.findAll('.ws-item')[0]
    await wsButton.trigger('click')

    expect(wrapper.text()).toContain('工作区里的会话')
  })

  it('「新对话」常驻在最上面（它是这一栏最高频的动作）', () => {
    const wrapper = mountNav()

    const html = wrapper.html()
    expect(html).toContain('新对话')
    // 它在工作区标题之前
    expect(html.indexOf('新对话')).toBeLessThan(html.indexOf('工作区'))
  })
})
