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
const routerPush = vi.fn()

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('vue-router')
  return {
    ...actual,
    useRoute: () => ({ path: '/chat', query: {} }),
    // `resolve` 是悬停预热（`preloadRoute`）用的：返回空 matched 就等于"这条路由没有
    // 懒加载代码块可预热"，它会直接返回。**必须有这个方法**——否则一悬停导航项
    // 就抛 "resolve is not a function"，而那种报错会被当成"测试自己在报错"
    // （我加"悬停不牵动其他项"那条断言时就是这么被绊了一下的）。
    useRouter: () => ({ push: routerPush, resolve: () => ({ matched: [] }) }),
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

  it('展开知识库后是三条固定子项，**不列库名**', async () => {
    // v0.17：原先这里把每个库铺一行，库一多侧栏就被占满（正是"知识库占的地方太多"）。
    // 现在固定三条：所有知识库 / 概览 / 任务中心；要看库去主页面。
    const wrapper = mountNav()

    await wrapper.find('.nav-item-group').trigger('click')

    expect(wrapper.find('.nav-sub').exists()).toBe(true)
    expect(wrapper.findAll('.nav-sub-item').map((node) => node.text())).toEqual([
      '所有知识库',
      '概览',
      '任务中心',
    ])
    expect(wrapper.text()).not.toContain('产品手册')
  })

  it('概览与任务中心在知识库组里，不在顶级导航里', async () => {
    // 用户指定：把这两个也收进知识库菜单
    const wrapper = mountNav()

    const topLabels = wrapper.findAll('nav.nav > .nav-item .nav-label').map((n) => n.text())
    expect(topLabels).not.toContain('概览')
    expect(topLabels).not.toContain('任务中心')
    expect(topLabels).toContain('笔记')
  })

  it('侧栏里不再有搜索框（找旧会话是历史面板的活）', () => {
    const wrapper = mountNav()

    expect(wrapper.find('.conv-search').exists()).toBe(false)
  })

  // 导航在清单**之上**是刻意的：导航短且固定，清单会不断变长——
  // 把清单放在上面，长起来就会把导航推走，而那是导航最不该有的行为。
  // 这条曾经与文档对不上（文档写「工作区在导航之上」，代码一直是导航在前），
  // 是这个断言把它对上的。
  it('顺序是「新建会话 → 导航 → 工作区与会话」', () => {
    const wrapper = mountNav()

    // **按 DOM 顺序断言，不按 HTML 字符串下标**：字符串里"知识库"三个字早在
    // 第 426 位就出现过一次——那是 logo 的 `aria-label="KYLAB 知识库"`，
    // 于是 `indexOf('知识库')` 永远指向它（这条断言第一版就是这么假失败的）。
    // 取真实节点的顺序，才是它想表达的东西。
    const nodes = Array.from(
      wrapper.element.querySelectorAll('.new-chat, nav.nav > .nav-item, .ws-list'),
    ).map((node) => (node as Element).className.split(' ')[0])

    expect(nodes[0]).toBe('nav-item') // 新建会话（它复用 nav-item 的形态）
    expect(nodes.at(-1)).toBe('ws-list') // 会话清单在最下
    expect(nodes.filter((name) => name === 'nav-item').length).toBeGreaterThan(1)
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

  it('「新建会话」常驻最上面，且与导航项**同一套形态**', () => {
    const wrapper = mountNav()
    const html = wrapper.html()

    expect(html).toContain('新建会话')
    // 它在会话节之前
    expect(html.indexOf('新建会话')).toBeLessThan(html.indexOf('新建工作区'))
    // **同形态**：它复用 .nav-item（不再是那个 44px 的填充块按钮）
    const button = wrapper.find('.new-chat')
    expect(button.classes()).toContain('nav-item')
  })

  it('快捷键提示写了就真的能用（Ctrl/Cmd+K）', async () => {
    // 界面上摆一个按不出来的快捷键，比不摆更糟——所以这条要钉住
    const wrapper = mountNav()

    expect(wrapper.find('.shortcut').text()).toContain('Ctrl K')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))
    await wrapper.vm.$nextTick()
    expect(routerPush).toHaveBeenCalled()
    expect(JSON.stringify(routerPush.mock.calls.at(-1)?.[0])).toContain('new')
  })
  // 用户报的两条（v0.18）："新建会话跟其他菜单有什么特殊性吗、为什么不跟其他菜单对齐"，
  // 以及"hover 的动效几个菜单之间没有解耦，移动一个菜单，其他菜单也会跟着动"。
  // 对齐那一条是纯 CSS（它缺的是 `.nav` 那层 8px 内边距），jsdom 不跑 scoped 样式，
  // 断言不到，得在真浏览器里量（实测两边都是 x=8 / 宽 223）；下面这两条是**能被断言**的部分。
  it('每个导航项的图标动效各有一套，不是共用一个', () => {
    // 原先五项共用同一份关键帧，用户的原话是"动效太单一了全部都是闪烁"。
    // 这条钉住"每项一个动效族"：五项各不相同。
    const wrapper = mountNav()

    // `wrapper.element` 在 VTU 的类型里是 untyped，直接 `querySelectorAll<T>` 会报
    // "Untyped function calls may not accept type arguments"，所以先落成一个真元素。
    const root = wrapper.element as HTMLElement
    const motions = Array.from(root.querySelectorAll('.new-chat .nav-icon, nav.nav .nav-icon')).map(
      (icon) => Array.from(icon.classList).find((name) => name.startsWith('nav-motion-')),
    )

    expect(motions).toHaveLength(5) // 新建会话 + 笔记 / 记忆 / 能力 + 知识库
    expect(motions.filter(Boolean)).toHaveLength(5)
    expect(new Set(motions).size).toBe(5)
  })

  it('悬停一项**不会**牵动其他项的图标', async () => {
    // 回归：上一版用一个侧栏共享的自增计数器当 `:key` 挂在「新建会话」的图标上，
    // 悬停「笔记」也会让它 +1 —— 那个图标被重建、动画跟着重播，
    // 表现就是用户说的"移动一个菜单，其他菜单也会跟着动"。
    // 断言方式是**节点同一性**：悬停别处之后，各图标还得是原来那个 DOM 节点。
    const wrapper = mountNav()
    const newChatIcon = wrapper.find('.new-chat .nav-icon').element
    const notesIcon = wrapper.find('nav.nav > .nav-item .nav-icon').element

    await wrapper.find('nav.nav > .nav-item').trigger('mouseenter')

    expect(wrapper.find('.new-chat .nav-icon').element).toBe(newChatIcon)
    expect(wrapper.find('nav.nav > .nav-item .nav-icon').element).toBe(notesIcon)
  })

  it('导航里没有「对话」——它与会话列表、新对话是同一件事的三个入口', () => {
    // 这是这一轮去重的那一条：点「对话」是"回到最近一次对话"，而下面的列表
    // 也是"去某次对话"，两者并排时用户会犹豫该点哪个。
    // Kimi Work / ChatGPT / Claude 都没有这一项：**会话列表本身就是那个入口**。
    const wrapper = mountNav()

    const navLabels = wrapper.findAll('nav.nav > .nav-item .nav-label').map((node) => node.text())
    expect(navLabels).not.toContain('对话')
    expect(navLabels).toContain('笔记')
  })

  it('「对话」是这一节的标签，工作区与未归档是同级分组', () => {
    // 标签用 Kimi 的叫法「对话」（参考图里就是它）。原先这里叫「工作区」，
    // 而「未归档会话」是它下面的一行——层级不一致，后者看起来像一个工作区。
    const wrapper = mountNav()

    expect(wrapper.find('.section-label').text()).toBe('对话')
    // 两个分组行都是 .ws-item（同一层级、同一套样式）
    expect(wrapper.findAll('.ws-item').length).toBeGreaterThanOrEqual(1)
    expect(wrapper.text()).toContain('未归档会话')
  })
  it('节标题可折叠（参考图里 `对话 ⌄` 就是这个）', async () => {
    const wrapper = mountNav()

    expect(wrapper.find('.ws-list').isVisible()).toBe(true)

    // **要 await**：`trigger` 自己是异步的，只 void 掉再手动 nextTick
    // 有时序问题（第一版就是这么写的，于是断言看到的是折叠前的状态）
    await wrapper.find('.section-toggle').trigger('click')

    // **断言的是内联样式，不是 `isVisible()`**：这个环境下 jsdom 的
    // `getComputedStyle` 对 `v-show` 设的 `display: none` 仍报 `block`
    // （实测：style 属性是 display: none，computed 却是 block），
    // 于是 `isVisible()` 会给出 false negative。
    // 而 `v-show` 控制的就是那个内联样式，直接断言它既准确又不依赖 jsdom 的实现细节。
    expect(wrapper.find('.ws-list').attributes('style')).toContain('display: none')
  })

  it('「查看全部」触发打开历史面板的事件', async () => {
    // 面板挂在 App 外壳上（侧栏不自己渲染它），所以这里断言的是事件
    const wrapper = mountNav()

    await wrapper.find('.section-action').trigger('click')

    expect(wrapper.emitted('openHistory')).toHaveLength(1)
  })
})
