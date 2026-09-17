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
  listAllMCPTools: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ notifyError, notifySuccess, notify: vi.fn(), notifyWarning: vi.fn() }),
}))

const CLEAN_SKILL = {
  name: 'kylab-knowledge-base',
  description: '查知识库',
  source: 'builtin' as const,
  path: 'E:/skills/kylab-knowledge-base/SKILL.md',
  directory: 'E:/skills/kylab-knowledge-base',
  used_by_prompt: true,
  flagged: [],
}

const FLAGGED_SKILL = {
  ...CLEAN_SKILL,
  name: 'sketchy',
  source: 'user' as const,
  used_by_prompt: false,
  flagged: ['疑似提示注入（忽略先前指令）：这条技能不会进模型的技能目录'],
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
        AppModal: { template: '<div class="modal"><slot /><slot name="footer" /></div>' },
        InfoTip: true,
        SkeletonBlock: true,
      },
    },
  })
}

/**
 * 切到「MCP 服务」那一页。
 *
 * v0.19 起技能与 MCP 是**两个标签**、一次只渲染一页（用户指定），
 * 所以断言 MCP 内容的用例必须先点那一下——不点的话相关 DOM 根本不在。
 */
async function openMcp(wrapper: ReturnType<typeof mountView>): Promise<void> {
  const tab = wrapper.findAll('.cap-tab').find((el) => el.text() === 'MCP 服务')!
  await tab.trigger('click')
}

beforeEach(() => {
  vi.clearAllMocks()
  resetResizeObservers()
  listSkills.mockResolvedValue({ items: [CLEAN_SKILL, FLAGGED_SKILL], usable: 1 })
  listMCPServers.mockResolvedValue({ items: [SERVER] })
})

describe('CapabilitiesView', () => {
  it('列出技能，并标出「可用 / 已拦下」', async () => {
    const wrapper = mountView()
    await vi.waitFor(() => expect(wrapper.text()).toContain('kylab-knowledge-base'))

    expect(wrapper.text()).toContain('技能 1/2 可用')
    expect(wrapper.text()).toContain('未进提示词')
  })

  it('被拦下的技能**显示原因**（静默藏掉会让人以为没装上）', async () => {
    const wrapper = mountView()
    await vi.waitFor(() => expect(wrapper.text()).toContain('sketchy'))

    expect(wrapper.text()).toContain('疑似提示注入')
  })

  it('点技能能读到正文（用户有权知道它教了模型什么）', async () => {
    getSkill.mockResolvedValue({ ...CLEAN_SKILL, body: '# 流程\n\n第一步：先看索引。' })
    const wrapper = mountView()
    await vi.waitFor(() => expect(wrapper.text()).toContain('kylab-knowledge-base'))

    await wrapper.find('.skill-main').trigger('click')

    await vi.waitFor(() => expect(getSkill).toHaveBeenCalledWith('kylab-knowledge-base'))
    await vi.waitFor(() => expect(wrapper.text()).toContain('第一步：先看索引。'))
  })

  it('MCP 服务显示策略档位，且凭据只显示「已配置」', async () => {
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
    expect(wrapper.text()).toContain('还没有登记 MCP 服务')
  })

  it('技能与 MCP 是一次只看一页的两个标签', async () => {
    const wrapper = mountView()
    await vi.waitFor(() => expect(wrapper.text()).toContain('kylab-knowledge-base'))

    // 默认在技能页：技能在、MCP 不在
    expect(wrapper.findAll('.cap-tab').map((el) => el.text())).toEqual(['技能', 'MCP 服务'])
    expect(wrapper.text()).toContain('kylab-knowledge-base')
    expect(wrapper.text()).not.toContain('本地工具')

    await openMcp(wrapper)
    expect(wrapper.text()).toContain('本地工具')
    expect(wrapper.text()).not.toContain('kylab-knowledge-base')
  })
})
