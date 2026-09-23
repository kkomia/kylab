import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import CapabilitiesView from '@/views/CapabilitiesView.vue'
import { resetResizeObservers } from '../../setup'

/**
 * 能力页（v0.15/v0.16）。
 *
 * 这一页把"这个 Agent 会什么"摊开给人看，所以测的是**三处会误导人的地方**：
 *
 * 1. **被安全扫描拦下的技能要显示原因**——静默藏掉会让用户以为技能没装上；
 * 2. **凭据不回显**，编辑时也**不回填**（回填会把掩码串写成真 key，把真的覆盖掉）；
 * 3. **策略的档位要看得见**：默认「需要确认」是这一层最要紧的默认，
 *    界面上不能把它显示成"没问题"。
 */

const listSkills = vi.fn()
const getSkill = vi.fn()
const listMCPServers = vi.fn()
const createMCPServer = vi.fn()
const updateMCPServer = vi.fn()
const deleteMCPServer = vi.fn()
const probeMCPServer = vi.fn()
const listInstalledSkills = vi.fn()
const uninstallSkill = vi.fn()
const listPlugins = vi.fn()
const enablePlugin = vi.fn()
const disablePlugin = vi.fn()
const notifyError = vi.fn()
const notifySuccess = vi.fn()

vi.mock('@/api/capabilities', () => ({
  listSkills: (...a: unknown[]) => listSkills(...a),
  getSkill: (...a: unknown[]) => getSkill(...a),
  listMCPServers: (...a: unknown[]) => listMCPServers(...a),
  createMCPServer: (...a: unknown[]) => createMCPServer(...a),
  updateMCPServer: (...a: unknown[]) => updateMCPServer(...a),
  deleteMCPServer: (...a: unknown[]) => deleteMCPServer(...a),
  probeMCPServer: (...a: unknown[]) => probeMCPServer(...a),
  listInstalledSkills: (...a: unknown[]) => listInstalledSkills(...a),
  uninstallSkill: (...a: unknown[]) => uninstallSkill(...a),
  sourceLabel: (origin: string) => origin.replace(/^github:([^@]+)@.*$/, '$1'),
  listAllMCPTools: vi.fn().mockResolvedValue([]),
}))

// 插件包（v0.43）是这一页的第三栏，面板自己去拉列表——所以这里mock它，
// 与前面那组（技能 / MCP）同样的做法：**用例只关心这一页把什么显示出来**
vi.mock('@/api/plugins', () => ({
  listPlugins: (...a: unknown[]) => listPlugins(...a),
  enablePlugin: (...a: unknown[]) => enablePlugin(...a),
  disablePlugin: (...a: unknown[]) => disablePlugin(...a),
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ notifyError, notifySuccess, notify: vi.fn(), notifyWarning: vi.fn() }),
}))

// 能力设置那个入口只给管理员（后端 /settings 是管理员端点）。
// **必须是真 ref**：模板里的 `v-if="isAdmin"` 只对 ref 自动解包，
// 换成 `{ value: true }` 永远是 truthy，那条"成员看不到"就会假通过。
vi.mock('@/composables/useSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/composables/useSession')>()
  const { ref } = await import('vue')
  return { ...actual, isAdmin: ref(true) }
})

const CLEAN_SKILL = {
  name: 'kylab-knowledge-base',
  description: '查知识库',
  source: 'builtin' as const,
  path: 'E:/skills/kylab-knowledge-base/SKILL.md',
  directory: 'E:/skills/kylab-knowledge-base',
  used_by_prompt: true,
  flagged: [],
  discarded: false,
}

const FLAGGED_SKILL = {
  ...CLEAN_SKILL,
  name: 'sketchy',
  source: 'user' as const,
  used_by_prompt: false,
  flagged: ['疑似提示注入（忽略先前指令）：这条技能不会进模型的技能目录'],
}

/** 被丢弃的技能（P0-3）：frontmatter 缺字段 → 不进目录也读不出正文，但要看得见。 */
const DROPPED_SKILL = {
  ...CLEAN_SKILL,
  name: 'broken',
  description: '',
  source: 'agents' as const,
  used_by_prompt: false,
  discarded: true,
  flagged: [
    '已丢弃：SKILL.md 的 frontmatter 里没有 description（照 ZCode 的规则：缺 description 的技能不加载）',
  ],
}

const SERVER = {
  id: 'mcp_1',
  name: '本地工具',
  transport: 'stdio' as const,
  target: 'python',
  args: ['-m', 'x'],
  policy: 'ask' as const,
  enabled: true,
  secret_keys: ['TOKEN'],
  has_secrets: true,
  tool_prefix: 'mcp__本地工具__',
  reachable: null,
  detail: '',
  tools: [],
  created_at: null,
  updated_at: null,
}

function mountView() {
  return mount(CapabilitiesView, {
    global: {
      stubs: {
        PageShell: { template: '<div><slot name="actions" /><slot /></div>' },
        // 两个插槽都要转出去：弹窗里既有正文（技能流程、表单字段）也有页脚按钮。
        // 只转 footer 的话，技能正文与输入框根本不会渲染——而"表单里是不是空的"
        // 正是下面要断言的东西（踩过：漏转默认插槽让两条用例假失败）
        AppModal: {
          props: ['open', 'title'],
          template:
            '<div class="modal" v-if="open === undefined || open"><slot /><slot name="footer" /></div>',
        },
        SettingGroupPanel: {
          name: 'SettingGroupPanel',
          props: { keys: { type: Array, default: () => [] } },
          template: '<div class="panel-stub" />',
        },
        InfoTip: true,
        SkeletonBlock: true,
      },
    },
  })
}

/**
 * 切到「插件」那一页。
 *
 * v0.19 起技能与插件是**两个标签**、一次只渲染一页（用户指定），
 * 所以断言插件内容的用例必须先点那一下——不点的话相关 DOM 根本不在。
 * 标签上的字是「插件」（v0.22 用户指定改名，协议上它仍是 MCP）——
 * 改名后这几条用例靠这个帮助函数找到那个标签，所以只改这一处就够了。
 */
async function openMcp(wrapper: ReturnType<typeof mountView>): Promise<void> {
  const tab = wrapper.findAll('.cap-tab').find((el) => el.text() === '插件')!
  await tab.trigger('click')
}

beforeEach(() => {
  vi.clearAllMocks()
  resetResizeObservers()
  // 「哪些是市场装的」：默认没有。它在卡片上只是一行来源，不影响别的断言
  listInstalledSkills.mockResolvedValue({ items: {}, total: 0 })
  listSkills.mockResolvedValue({ items: [CLEAN_SKILL, FLAGGED_SKILL], usable: 1 })
  listMCPServers.mockResolvedValue({ items: [SERVER] })
  listPlugins.mockResolvedValue({
    items: [],
    total: 0,
    enabled: 0,
    failed: 0,
    user_dir: 'E:/data/plugins',
    builtin_dir: '',
  })
})

describe('CapabilitiesView', () => {
  it('列出技能，并标出「可用 / 已拦下」', async () => {
    const wrapper = mountView()
    await vi.waitFor(() => expect(wrapper.text()).toContain(CLEAN_SKILL.name))

    expect(wrapper.text()).toContain('技能 1/2 可用')
    expect(wrapper.text()).toContain('未进提示词')
  })

  it('被拦下的技能**显示原因**（静默藏掉会让人以为没装上）', async () => {
    const wrapper = mountView()
    await vi.waitFor(() => expect(wrapper.text()).toContain('sketchy'))

    expect(wrapper.text()).toContain('疑似提示注入')
  })

  it('被丢弃的坏技能也看得见，理由与来源都在（P0-3）', async () => {
    // 「被丢弃」与「被拦下」是两件事：前者是 frontmatter 不合规（整个技能不加载），
    // 后者是能用但这一轮不给模型看。标签分开，理由原样透出来给用户照着改。
    listSkills.mockResolvedValue({ items: [CLEAN_SKILL, DROPPED_SKILL], usable: 1 })
    const wrapper = mountView()
    await vi.waitFor(() => expect(wrapper.text()).toContain(DROPPED_SKILL.name))

    expect(wrapper.text()).toContain('已丢弃')
    expect(wrapper.text()).toContain('没有 description')
    // 住在跨工具共享目录里的技能，来源那一行要说得出来
    expect(wrapper.text()).toContain('~/.agents/skills')
  })

  it('点技能能读到正文（用户有权知道它教了模型什么）', async () => {
    getSkill.mockResolvedValue({ ...CLEAN_SKILL, body: '# 流程\n\n第一步：先看索引。' })
    const wrapper = mountView()
    await vi.waitFor(() => expect(wrapper.text()).toContain(CLEAN_SKILL.name))

    await wrapper.find('.skill-main').trigger('click')

    await vi.waitFor(() => expect(getSkill).toHaveBeenCalledWith('kylab-knowledge-base'))
    await vi.waitFor(() => expect(wrapper.text()).toContain('第一步：先看索引。'))
  })

  it('插件显示策略档位，且凭据只显示「已配置」', async () => {
    const wrapper = mountView()
    await openMcp(wrapper)
    await vi.waitFor(() => expect(wrapper.text()).toContain('本地工具'))

    // 策略默认 ask：这一层最要紧的默认，界面上必须看得见
    expect(wrapper.text()).toContain('需确认')
    expect(wrapper.text()).toContain('凭据已配置')
    // **绝不显示凭据的值**（这里连键名都不该在正文里露出来）
    expect(wrapper.text()).not.toContain('TOKEN')
  })

  it('探活结果原样显示（连不上也是结果，不是错误）', async () => {
    probeMCPServer.mockResolvedValue({
      ...SERVER,
      reachable: false,
      detail: 'FileNotFoundError: 系统找不到指定的文件',
    })
    const wrapper = mountView()
    await openMcp(wrapper)
    await vi.waitFor(() => expect(wrapper.text()).toContain('本地工具'))

    const probeButton = wrapper.findAll('button').find((b) => b.text().includes('测试连接'))
    await probeButton!.trigger('click')

    // 后端那句"到底是命令不存在还是超时"是用户唯一能照着改的信息，
    // 所以它必须原样透出来
    await vi.waitFor(() =>
      expect(notifyError).toHaveBeenCalledWith(expect.stringContaining('找不到')),
    )
  })

  it('编辑时**不回填凭据**（回填会把掩码串写成真 key）', async () => {
    updateMCPServer.mockResolvedValue(SERVER)
    const wrapper = mountView()
    await openMcp(wrapper)
    await vi.waitFor(() => expect(wrapper.text()).toContain('本地工具'))

    const editButton = wrapper.findAll('button').find((b) => b.text().includes('编辑'))
    await editButton!.trigger('click')

    // 环境变量那一栏必须是空的：它只该显示在提示里（"已配过哪几个 key"），
    // 表单里回填一个值就会在保存时把真的覆盖掉
    const textarea = wrapper.find('textarea')
    expect(textarea.exists()).toBe(true)
    expect((textarea.element as HTMLTextAreaElement).value).toBe('')
  })

  it('空列表给指路而不是空白', async () => {
    listSkills.mockResolvedValue({ items: [], usable: 0 })
    listMCPServers.mockResolvedValue({ items: [] })
    const wrapper = mountView()

    await vi.waitFor(() => expect(wrapper.text()).toContain('还没有技能'))
    // 两页各看一次：它们现在不在同一屏上（v0.19 起是两个标签）
    await openMcp(wrapper)
    expect(wrapper.text()).toContain('还没有插件')
  })

  it('技能、插件、插件包是一次只看一页的三个标签', async () => {
    const wrapper = mountView()
    await vi.waitFor(() => expect(wrapper.text()).toContain(CLEAN_SKILL.name))

    // 默认在技能页：技能在、插件不在。
    // 第三个标签是 v0.43 加的（磁盘上的能力包），它与「插件」（MCP 服务）不是一回事
    expect(wrapper.findAll('.cap-tab').map((el) => el.text())).toEqual(['技能', '插件', '插件包'])
    expect(wrapper.text()).toContain(CLEAN_SKILL.name)
    expect(wrapper.text()).not.toContain('本地工具')

    await openMcp(wrapper)
    expect(wrapper.text()).toContain('本地工具')
    expect(wrapper.text()).not.toContain('kylab-knowledge-base')
  })
})

/**
 * 搜索与筛选（v0.22 重排）。
 *
 * 参考的是 Kimi Work 的插件页：内容头（标题 + 一句说明 + 搜索与主操作）、
 * 一排带计数的筛选胶囊、两栏卡片。这一组钉住"那两个控件真的在筛"——
 * 摆一个能输入但不筛的搜索框，比不摆更糟（用户会以为技能列表是空的）。
 */
describe('能力页的搜索与筛选', () => {
  it('搜索按名字与描述筛，切筛选也筛', async () => {
    listSkills.mockResolvedValue({
      items: [
        {
          name: 'kylab-web',
          description: '联网查资料',
          path: '/skills/kylab-web/SKILL.md',
          source: 'builtin',
          directory: '/skills/kylab-web',
          used_by_prompt: true,
          flagged: [],
        },
        {
          name: 'my-notes',
          description: '整理笔记',
          path: '/data/skills/my-notes/SKILL.md',
          source: 'user',
          directory: '/data/skills/my-notes',
          used_by_prompt: true,
          flagged: [],
        },
      ],
    })
    const wrapper = mountView()
    await vi.waitFor(() => expect(wrapper.text()).toContain('kylab-web'))

    // 搜索：只剩匹配的那一个
    await wrapper.find('.panel-search input').setValue('笔记')
    expect(wrapper.text()).toContain('my-notes')
    expect(wrapper.text()).not.toContain('kylab-web')

    // 清掉搜索，按来源筛
    await wrapper.find('.panel-search input').setValue('')
    const userFilter = wrapper.findAll('.filter').find((node) => node.text().includes('手动放入'))!
    await userFilter.trigger('click')
    expect(wrapper.text()).toContain('my-notes')
    expect(wrapper.text()).not.toContain('kylab-web')
  })

  it('搜索没命中时给"换个词"而不是空白', async () => {
    listSkills.mockResolvedValue({ items: [CLEAN_SKILL] })
    const wrapper = mountView()
    await vi.waitFor(() => expect(wrapper.text()).toContain(CLEAN_SKILL.name))

    await wrapper.find('.panel-search input').setValue('没有这个东西')

    expect(wrapper.text()).toContain('没有匹配的技能')
  })
})

/**
 * 插件包一栏（v0.43）。
 *
 * 它与上面那个「插件」（协议上是 MCP 服务）是两件事：那一栏是**连出去的外部服务**，
 * 这一栏是**磁盘上的能力包**（一个目录 + 一份 plugin.json）。名字取「插件包」，
 * 因为「插件」这两个字已经被 MCP 那一栏占了（v0.22 用户指定），
 * 页面上两个同名标签只会让人点错。
 */
describe('能力页的插件包一栏（v0.43）', () => {
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
    components: [],
    kinds: [],
    user_config: [],
  }

  it('切过去能看到列表，页头那条状态也来自它', async () => {
    listPlugins.mockResolvedValue({
      items: [PACK],
      total: 1,
      enabled: 1,
      failed: 0,
      user_dir: 'E:/data/plugins',
      builtin_dir: '',
    })
    const wrapper = mountView()
    await vi.waitFor(() => expect(wrapper.text()).toContain(CLEAN_SKILL.name))

    const tab = wrapper.findAll('.cap-tab').find((item) => item.text() === '插件包')
    expect(tab).toBeTruthy()
    await tab!.trigger('click')

    await vi.waitFor(() => expect(listPlugins).toHaveBeenCalled())
    await vi.waitFor(() => expect(wrapper.text()).toContain(PACK.name))
    // 「插件」那一条是 MCP（外部服务），两条状态并存不混淆
    expect(wrapper.text()).toContain('插件包 1/1')
  })
})

describe('能力页的设置入口（v0.26）', () => {
  it('管理员能看到「设置」，点开是联网与沙箱两组', async () => {
    // 联网是内置的取数能力、执行策略回答的是"允许它动手到什么程度"——
    // 它们本来就是这一页的问题，原先却挂在「总设置 → 功能」里。
    const wrapper = mountView()
    await vi.waitFor(() => expect(wrapper.text()).toContain(CLEAN_SKILL.name))

    const button = wrapper.findAll('button').find((item) => item.text().includes('设置'))
    expect(button).toBeTruthy()
    expect(wrapper.findComponent({ name: 'SettingGroupPanel' }).exists()).toBe(false)

    await button!.trigger('click')

    expect(wrapper.findComponent({ name: 'SettingGroupPanel' }).props('keys')).toEqual([
      'web',
      'sandbox',
    ])
  })

  it('成员看不到这个入口', async () => {
    const session = await import('@/composables/useSession')
    ;(session.isAdmin as unknown as { value: boolean }).value = false
    const wrapper = mountView()
    await vi.waitFor(() => expect(wrapper.text()).toContain(CLEAN_SKILL.name))

    const button = wrapper.findAll('button').find((item) => item.text().includes('设置'))
    expect(button).toBeUndefined()
  })
})
