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
        // 桩要**同时渲染 trigger 与菜单项**：真的 RowMenu 两个都渲染，
        // 只渲染菜单项的话，「管理」这个可见的入口在测试里等于不存在
        // （第一版就是这样，于是那条断言只能去数菜单项）。
        RowMenu: {
          template: '<div><slot name="trigger" /><slot :close="() => {}" /></div>',
        },
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
  it('顺序是「新建会话 → 导航 → 项目 → 对话」（v0.22）', () => {
    // Kimi Work 的侧栏条目表是：新建任务 / 看板 / 插件 / 技能 / 定时任务 /
    // WebBridge / **项目** / **对话**——导航在前，两个入口在后，项目在对话之前。
    // **按 DOM 顺序断言**：字符串下标会被 logo 的 aria-label 之类绊到（踩过）。
    const wrapper = mountNav()

    const nodes = Array.from(
      wrapper.element.querySelectorAll(
        '.new-chat, nav.nav, .side-entry-projects, .side-entry-chat',
      ),
    ).map((node) => (node as Element).className.split(' ')[0])

    expect(nodes[0]).toBe('nav-item') // 新建会话（它复用 nav-item 的形态）
    expect(nodes[1]).toBe('nav')
    expect(nodes[2]).toBe('nav-item') // 项目
    expect(nodes[3]).toBe('nav-item') // 对话
    const projects = wrapper.element.querySelector('.side-entry-projects')!
    const chat = wrapper.element.querySelector('.side-entry-chat')!
    // 用**文档位置**比较：RowMenu 的桩会在两行外面各包一层 div，相邻兄弟不成立
    const order = projects.compareDocumentPosition(chat)
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING, '项目要在对话之前').toBeTruthy()
  })

  it('侧栏里不铺任何会话清单——两条入口而已（v0.22）', () => {
    // 用户的原话是"对话里面的都是临时的，不要再在下面加一个未归档会话"，
    // 而 Kimi Work 那边侧栏里**一条会话都不列**：点「对话」进搜索菜单。
    // 原先那一栏堆的是随手问的"你好"（实测 9 条里 6 条）。
    const wrapper = mountNav()

    expect(wrapper.text()).not.toContain('未归档会话')
    expect(wrapper.text()).not.toContain('工作区里的会话')
    expect(wrapper.text()).not.toContain('随手问的')
    expect(wrapper.findAll('.conv-item')).toHaveLength(0)
  })

  it('项目入口是一个菜单：两个动作 + 最近的项目', () => {
    // 「通过一个项目菜单来统一管理」：新建 / 全部 / 具体项目都在同一个菜单里，
    // 点某个项目**直接进它**（`?focus=<id>`），不必进去再找。
    const wrapper = mountNav()
    const menu = wrapper.find('.side-entry-projects').element.closest('div')!.parentElement!

    expect(wrapper.text()).toContain('新建项目')
    expect(wrapper.text()).toContain('全部项目')
    expect(wrapper.text()).toContain('产品化') // 夹具里的项目
    expect(wrapper.find('.side-entry-projects').exists()).toBe(true)
    void menu
  })

  it('点菜单里的项目 → 带 focus 进项目页', async () => {
    const wrapper = mountNav()

    const item = wrapper.findAll('button').find((node) => node.text().includes('产品化'))
    await item!.trigger('click')

    expect(JSON.stringify(routerPush.mock.calls.at(-1)?.[0])).toContain('focus')
  })

  it('「新建会话」常驻最上面，且与导航项**同一套形态**', () => {
    const wrapper = mountNav()
    const html = wrapper.html()

    expect(html).toContain('新建会话')
    // 它在项目那一节之前（「新建项目」现在是项目节标题右边那个「管理」菜单里的一项）
    expect(html.indexOf('新建会话')).toBeLessThan(html.indexOf('新建项目'))
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

  it('「对话」那一条打开搜索面板（管理对话交给它）', async () => {
    // 侧栏不再自己列会话，所以"找一条旧会话"只有这一条入口——它必须真的能开面板。
    const wrapper = mountNav()

    await wrapper.find('.side-entry-chat').trigger('click')

    expect(wrapper.emitted('openHistory')).toBeTruthy()
  })
})
