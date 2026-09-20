import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import AvatarDialog from '@/components/settings/AvatarDialog.vue'
import SideNav from '@/components/layout/SideNav.vue'
import { currentUser } from '@/composables/useSessionToken'
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
// 真 ref：用例要能改它（头像那几条就是这么验的）。
// 用 `{ value: … }` 那种字面量会在"改完看不到变化"上骗过测试。
vi.mock('@/composables/useSessionToken', async () => {
  const { ref } = await import('vue')
  return {
    currentUser: ref({
      id: 'user_1',
      username: 'kkomia',
      name: '小又',
      role: 'admin',
      avatar_url: '',
    }),
  }
})
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
  it('顺序是「新建会话 → 导航 → 项目 → 对话」，两节默认都展开（v0.22）', () => {
    // 依据是用户给的 Kimi Work 截图：进来就是铺开的，`项目 ⌄` / `对话 ⌄`
    // 的箭头紧跟文字（它表示"能收起来"），清单直接跟在下面。
    const wrapper = mountNav()

    const heads = wrapper.findAll('.side-head .side-title').map((node) => node.text())
    expect(heads).toEqual(['项目', '对话'])

    // 默认展开：两份清单都渲染着
    expect(wrapper.find('.side-toggle').attributes('aria-expanded')).toBe('true')
    expect(wrapper.findAll('.side-list')).toHaveLength(2)
    expect(wrapper.text()).toContain('产品化') // 项目那一节里的项目
    expect(wrapper.text()).toContain('随手问的') // 对话那一节里没归项目的会话
  })

  it('两节标题右侧的「新建」按钮**悬停才出现**，且始终可 Tab 到', () => {
    // Kimi Work 那里，`项目` 右边默认什么都不摆，鼠标移上来才出现一个
    // 带加号的文件夹。常驻的话两节各挂一个加号，读起来像"这两行各有一个
    // 主要动作"，而它们的主语其实是下面那份清单。
    const wrapper = mountNav()

    const adds = wrapper.findAll('.side-add')
    expect(adds).toHaveLength(2)
    expect(adds[0].attributes('aria-label')).toBe('新建项目')
    // 「对话」节那颗 v0.25 换成了「查看全部会话」（见下面那条用例）
    expect(adds[1].attributes('aria-label')).toBe('查看全部会话')
  })

  it('不再有「未归档会话」那一栏，但两节各自铺自己的清单（v0.22）', () => {
    // 用户的原话是"对话里面的都是临时的，不要再在下面加一个未归档会话了，
    // 已经归档的在查看全部会话里看"。所以：**分节照铺，那个多余的分组去掉**。
    const wrapper = mountNav()

    expect(wrapper.text()).not.toContain('未归档会话')
    // 项目那一节：项目名 + 它下面的会话
    expect(wrapper.text()).toContain('产品化')
    expect(wrapper.text()).toContain('工作区里的会话')
    // 对话那一节：没归项目的会话
    expect(wrapper.text()).toContain('随手问的')
    // 找旧会话的入口仍在（搜索 + 已归档都在面板里），只是不再占清单里的一行
    expect(
      wrapper.findAll('.side-add').some((node) => node.attributes('aria-label') === '查看全部会话'),
    ).toBe(true)
  })

  it('项目行直接进项目（带 focus），会话行直接进会话', () => {
    // 项目名那一行是**项目本身的入口**，不是折叠开关：点它进项目页并选中它。
    // 「全部项目」在清单末尾（没有项目时不占位）。
    const wrapper = mountNav()

    const rows = wrapper.findAll('.side-row-group')
    expect(rows.map((node) => node.text())).toEqual(['产品化1'])

    void rows[0].trigger('click')
    expect(JSON.stringify(routerPush.mock.calls.at(-1)?.[0])).toContain('focus')
    expect(wrapper.text()).toContain('全部项目')
  })

  it('「新建会话」常驻最上面，是侧栏里唯一有底有框的那一颗', () => {
    const wrapper = mountNav()
    const html = wrapper.html()

    expect(html).toContain('新建会话')
    // 它在项目那一节之前（「新建项目」现在是项目节标题右边那个「管理」菜单里的一项）
    expect(html.indexOf('新建会话')).toBeLessThan(html.indexOf('新建项目'))
    // **几何复用 .nav-item（40px 行、圆角 12、图标+文字），但形态自己加一层底与框**。
    // 这条 v0.17 曾反着钉过（"与导航项同一套形态、不再填充"），v0.24 按 kimi.com
    // 对话页的实测改回来：它的侧栏里唯一有底有框的就是这一颗。
    // jsdom 不跑 scoped 样式，所以这里只钉类名，填充与描边在真浏览器里量。
    const button = wrapper.find('.new-chat')
    expect(button.classes()).toContain('nav-item')
    expect(button.classes()).toContain('new-chat')
  })

  it('快捷键提示写了就真的能用（Ctrl/Cmd+K）', async () => {
    // 界面上摆一个按不出来的快捷键，比不摆更糟——所以这条要钉住
    const wrapper = mountNav()

    // **两枚独立的小片**（Kimi 的写法），不是一个 `Ctrl K` 字符串：
    // 分开才能各自有底色和 4px 圆角，间距由容器的 gap 给。
    const chips = wrapper.findAll('.shortcut kbd')
    expect(chips.map((chip) => chip.text())).toEqual(['Ctrl', 'K'])

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

  it('「查看全部会话」打开搜索面板（搜索与已归档都在那里）', async () => {
    // 侧栏只铺最近几条；"找一条旧会话"仍然只有这一个入口——
    // 它必须真的能开面板，否则那些会话就再也找不着了。
    //
    // v0.25 它从清单**最底下那颗文字行**搬到了「对话」节的标题行上（悬停显形），
    // 与项目那一节的加号同一套手势：会话一多，埋在清单末尾就要滚到底才看得见。
    const wrapper = mountNav()

    const more = wrapper
      .findAll('.side-add')
      .find((node) => node.attributes('aria-label') === '查看全部会话')
    expect(more).toBeTruthy()
    await more!.trigger('click')

    expect(wrapper.emitted('openHistory')).toBeTruthy()
  })

  it('「新建会话」在侧栏里只有一个入口（最上面那颗）', async () => {
    // 原先「对话」节的标题行上还挂着一颗"新建会话"，与最上面那颗**是同一件事**。
    // 同一栏里两个入口做同一件事，多出来的那个只会让人犹豫点哪个。
    const wrapper = mountNav()

    const labels = wrapper.findAll('.side-add').map((node) => node.attributes('aria-label'))
    expect(labels.filter((label) => label === '新建会话')).toHaveLength(0)
    // 最上面那颗还在，并且是链接（不是 .side-add）
    expect(wrapper.find('.new-chat').text()).toContain('新建会话')
  })
})

describe('侧栏账户区的头像（v0.29）', () => {
  it('没设过头像时用名字生成的那张，而不是一枚灰色小人', () => {
    // 「一个叫『用户』的入口」与「这是某某」读起来是两件事——
    // 而这是用户唯一每天都会看到的那块身份区
    const wrapper = mountNav()

    const avatar = wrapper.find('.account-row .avatar')
    expect(avatar.exists()).toBe(true)
    expect(avatar.text()).toBe('小')
  })

  it('设过头像就渲染成图', () => {
    currentUser.value = {
      id: 'user_1',
      username: 'kkomia',
      name: '小又',
      role: 'admin',
      avatar_url: '/api/v1/avatars/user_1?signature=x',
    }

    const wrapper = mountNav()

    expect(wrapper.find('.account-row img').attributes('src')).toContain('/api/v1/avatars/user_1')
  })

  it('账户菜单里有「头像」这一项（点开是换头像的弹窗）', async () => {
    const wrapper = mountNav()
    expect(wrapper.findComponent(AvatarDialog).props('open')).toBe(false)

    const item = wrapper.findAll('button').find((node) => node.text() === '头像')
    expect(item).toBeTruthy()
    await item!.trigger('click')

    // 弹窗自己那层 `<dialog>` 在测试里被桩掉了，所以看的是它的开合状态
    expect(wrapper.findComponent(AvatarDialog).props('open')).toBe(true)
  })
})
