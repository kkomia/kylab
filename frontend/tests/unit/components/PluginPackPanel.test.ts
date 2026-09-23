import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import PluginPackPanel from '@/components/capabilities/PluginPackPanel.vue'
import { resetResizeObservers } from '../../setup'

/**
 * 插件包一栏（v0.43）。
 *
 * 这一栏要答的是三个问题，所以测的也是这三个：
 *
 * 1. **这个插件提供了什么**（四类能力面各几条）；
 * 2. **它为什么没生效**——加载失败的**必须带着原因显示**（静默藏掉会让人以为没装上）；
 * 3. **它现在什么状态**，以及启停真的走了接口（而不是只改本地显示）。
 *
 * 还有一条容易被做假的地方：四类能力面这一轮**都还没接执行**，所以每一项的
 * 状态里那句"未实现"要照后端的话显示出来——不能让人以为命令点了就能跑。
 */

const listPlugins = vi.fn()
const enablePlugin = vi.fn()
const disablePlugin = vi.fn()
const notifyError = vi.fn()
const notifySuccess = vi.fn()

vi.mock('@/api/plugins', () => ({
  listPlugins: (...a: unknown[]) => listPlugins(...a),
  enablePlugin: (...a: unknown[]) => enablePlugin(...a),
  disablePlugin: (...a: unknown[]) => disablePlugin(...a),
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ notifyError, notifySuccess, notify: vi.fn(), notifyWarning: vi.fn() }),
}))

// 启停只给管理员（后端那条路也是管理员端点）。
// **必须是真 ref**：模板里的 `v-if="isAdmin"` 只对 ref 自动解包。
vi.mock('@/composables/useSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/composables/useSession')>()
  const { ref } = await import('vue')
  return { ...actual, isAdmin: ref(true) }
})

const USER_DIR = 'E:/data/plugins'

const PACK = {
  name: 'demo-pack',
  version: '1.2.0',
  description: '示例插件',
  author: '',
  homepage: '',
  source: 'user' as const,
  path: 'E:/data/plugins/demo-pack',
  manifest_path: 'E:/data/plugins/demo-pack/plugin.json',
  enabled: true,
  blocked: false,
  loaded: true,
  error: '',
  components: [
    {
      kind: 'command' as const,
      name: 'compact',
      description: '压缩上下文',
      path: 'commands/compact.md',
      status: '未实现：本轮只列出，不执行',
    },
  ],
  kinds: ['command'],
  user_config: [],
}

const BROKEN = {
  ...PACK,
  name: 'broken-pack',
  // 描述要与好的那条**不一样**：不然"筛掉之后它还在不在"这条断言等于没测
  description: '坏掉的包',
  loaded: false,
  error: 'plugin.json 缺 name（这是唯一必填的字段）',
  components: [],
  kinds: [],
}

const BUILTIN_BLOCKED = {
  ...PACK,
  name: 'inner-pack',
  source: 'builtin' as const,
  enabled: false,
  blocked: true,
}

function mountPanel() {
  return mount(PluginPackPanel, {
    global: { stubs: { SkeletonBlock: true } },
  })
}

function response(items: unknown[]) {
  return {
    items,
    total: items.length,
    enabled: items.filter((item) => (item as { enabled: boolean }).enabled).length,
    failed: items.filter((item) => !(item as { loaded: boolean }).loaded).length,
    user_dir: USER_DIR,
    builtin_dir: 'E:/repo/plugins',
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetResizeObservers()
  listPlugins.mockResolvedValue(response([PACK]))
})

describe('PluginPackPanel', () => {
  it('列出插件包，并说得出「它提供了什么」与本地市场在哪', async () => {
    const wrapper = mountPanel()
    await vi.waitFor(() => expect(wrapper.text()).toContain(PACK.name))

    expect(wrapper.text()).toContain('示例插件')
    expect(wrapper.text()).toContain('命令') // 四类能力面的中文名
    expect(wrapper.text()).toContain('提供了 1 项')
    // **本地市场就是目录**：路径要摊出来，用户才知道东西该放哪
    expect(wrapper.text()).toContain(USER_DIR)
  })

  it('加载失败的也列出来，并原样显示原因', async () => {
    listPlugins.mockResolvedValue(response([BROKEN]))
    const wrapper = mountPanel()
    await vi.waitFor(() => expect(wrapper.text()).toContain(BROKEN.name))

    expect(wrapper.text()).toContain('加载失败')
    expect(wrapper.text()).toContain(BROKEN.error)
  })

  it('展开后每一项都带着「未实现」的说明（不假装支持）', async () => {
    const wrapper = mountPanel()
    await vi.waitFor(() => expect(wrapper.text()).toContain(PACK.name))

    const toggle = wrapper.findAll('button').find((b) => b.text().includes('提供了 1 项'))
    await toggle!.trigger('click')

    expect(wrapper.text()).toContain('compact')
    expect(wrapper.text()).toContain('commands/compact.md')
    expect(wrapper.text()).toContain('未实现：本轮只列出，不执行')
  })

  it('停用走接口，卡片跟着变成「已停用」', async () => {
    disablePlugin.mockResolvedValue({ ...PACK, enabled: false })
    const wrapper = mountPanel()
    await vi.waitFor(() => expect(wrapper.text()).toContain(PACK.name))

    const stop = wrapper.findAll('button').find((b) => b.text() === '停用')
    await stop!.trigger('click')

    await vi.waitFor(() => expect(disablePlugin).toHaveBeenCalledWith('demo-pack'))
    await vi.waitFor(() => expect(wrapper.text()).toContain('已停用'))
    // 停用之后菜单里应该给的是反方向的动作
    expect(wrapper.findAll('button').some((b) => b.text() === '启用')).toBe(true)
  })

  it('内置插件被停用显示「已屏蔽」（它不是被删了）', async () => {
    listPlugins.mockResolvedValue(response([BUILTIN_BLOCKED]))
    const wrapper = mountPanel()
    await vi.waitFor(() => expect(wrapper.text()).toContain(BUILTIN_BLOCKED.name))

    expect(wrapper.text()).toContain('随代码发布')
    expect(wrapper.text()).toContain('已屏蔽')
    expect(enablePlugin).not.toHaveBeenCalled()
  })

  it('筛选「加载失败」只留下坏的那条', async () => {
    listPlugins.mockResolvedValue(response([PACK, BROKEN]))
    const wrapper = mountPanel()
    await vi.waitFor(() => expect(wrapper.text()).toContain(BROKEN.name))

    const failed = wrapper.findAll('.filter').find((f) => f.text().includes('加载失败'))
    await failed!.trigger('click')

    expect(wrapper.text()).toContain(BROKEN.name)
    expect(wrapper.text()).not.toContain(PACK.description)
  })

  it('一个插件都没有时，把市场目录写在提示里', async () => {
    listPlugins.mockResolvedValue(response([]))
    const wrapper = mountPanel()

    await vi.waitFor(() => expect(wrapper.text()).toContain('还没有插件包'))
    expect(wrapper.text()).toContain(USER_DIR)
  })

  it('拉取失败时给出错误提示，而不是空白页', async () => {
    listPlugins.mockRejectedValue(new Error('插件列表读取失败'))
    mountPanel()

    await vi.waitFor(() => expect(notifyError).toHaveBeenCalledWith('插件列表读取失败'))
  })
})
