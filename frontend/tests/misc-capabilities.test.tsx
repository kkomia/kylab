/**
 * 能力页（旧 `views/CapabilitiesView.vue` + `components/capabilities/**`）的用例。
 *
 * 五条刻意设计的验证：
 * 1. **被拦下/被丢弃的技能要显示原因**（`flagged` + `discarded` 分开标）；
 * 2. **插件包的"未实现"原样显示**（四类能力面的 status 是后端给的，界面不改写）；
 * 3. **探活连不上不是错误、是结果**：`reachable:false` + `detail` 要显示出来；
 * 4. **分区导航是页签组**（`aria-selected` 跟着点击走）——这一页唯一的导航，
 *    评审 G1 报的就是它既没有当前态、也不是页签；
 * 5. **技能正文按 markdown 渲染**：用户看到的是文档，不是 `SKILL.md` 源码
 *    （`#` 成标题、`**` 成加粗），且首行那句解释小字已按 U1 删掉。
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/capabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/capabilities')>()
  return {
    // `sourceLabel` 是纯函数，保留真实现（用例正是要看"来源写成什么"）
    sourceLabel: actual.sourceLabel,
    listSkills: vi.fn(),
    getSkill: vi.fn(),
    listInstalledSkills: vi.fn(),
    uninstallSkill: vi.fn(),
    listMCPServers: vi.fn(),
    createMCPServer: vi.fn(),
    updateMCPServer: vi.fn(),
    deleteMCPServer: vi.fn(),
    probeMCPServer: vi.fn(),
    listSkillSources: vi.fn(),
    addSkillSource: vi.fn(),
    setSkillSourceEnabled: vi.fn(),
    deleteSkillSource: vi.fn(),
    browseSkillSource: vi.fn(),
    inspectMarketSkill: vi.fn(),
    installMarketSkill: vi.fn(),
    uploadSkill: vi.fn(),
    listAllMCPTools: vi.fn(),
    callMCPTool: vi.fn(),
  }
})

vi.mock('@/api/plugins', () => ({
  listPlugins: vi.fn(),
  enablePlugin: vi.fn(),
  disablePlugin: vi.fn(),
}))
vi.mock('@/api/settings', () => ({
  getSettings: vi.fn(async () => ({ groups: [] })),
  updateSettings: vi.fn(),
}))

import {
  listInstalledSkills,
  listMCPServers,
  listSkills,
  probeMCPServer,
  type MCPServer,
  type Skill,
} from '@/api/capabilities'
import { listPlugins, type PluginPack } from '@/api/plugins'
import { CapabilitiesPage } from '@/features/misc/capabilities/CapabilitiesPage'
import { renderMisc } from '@/features/misc/testing/harness'
import { resetToasts } from '@/features/misc/shared/toast'
import { useSessionStore } from '@/lib/session'

const listSkillsMock = vi.mocked(listSkills)
const listInstalledMock = vi.mocked(listInstalledSkills)
const listServersMock = vi.mocked(listMCPServers)
const probeMock = vi.mocked(probeMCPServer)
const listPluginsMock = vi.mocked(listPlugins)

function skill(overrides: Partial<Skill> = {}): Skill {
  return {
    name: 'pdf-report',
    description: 'Write a PDF report',
    summary: '把一批文档汇成一份 PDF 报告',
    source: 'user',
    path: '/data/skills/pdf-report/SKILL.md',
    directory: '/data/skills/pdf-report',
    used_by_prompt: true,
    flagged: [],
    discarded: false,
    ...overrides,
  }
}

function server(overrides: Partial<MCPServer> = {}): MCPServer {
  return {
    id: 'srv-1',
    name: 'filesystem',
    transport: 'stdio',
    target: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    policy: 'ask',
    enabled: true,
    secret_keys: ['TOKEN'],
    has_secrets: true,
    tool_prefix: 'mcp__filesystem__',
    reachable: null,
    detail: '',
    tools: [],
    created_at: null,
    updated_at: null,
    ...overrides,
  }
}

function pack(overrides: Partial<PluginPack> = {}): PluginPack {
  return {
    name: 'demo-pack',
    version: '0.1.0',
    description: '一个示例能力包',
    author: '',
    homepage: '',
    source: 'user',
    path: '/data/plugins/demo-pack',
    manifest_path: '/data/plugins/demo-pack/plugin.json',
    enabled: true,
    blocked: false,
    loaded: true,
    error: '',
    kinds: ['skill', 'tool'],
    components: [
      {
        kind: 'tool',
        name: 'run',
        path: 'tools/run.md',
        status: '未实现：这一轮只列出，不会执行',
      } as never,
    ],
    user_config: [],
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetToasts()
  useSessionStore.setState({
    token: 'st',
    currentUser: { id: 'u1', username: 'admin', name: '管理员', role: 'admin', avatar_url: '' },
    authStatus: null,
    reloginCount: 0,
  })
  listSkillsMock.mockResolvedValue({ items: [skill()], usable: 1 })
  listInstalledMock.mockResolvedValue({ items: {}, total: 0 })
  listServersMock.mockResolvedValue({ items: [server()] })
  listPluginsMock.mockResolvedValue({
    items: [pack()],
    total: 1,
    enabled: 1,
    failed: 0,
    user_dir: '/data/plugins',
    builtin_dir: '/app/plugins',
  })
})

describe('能力页', () => {
  it('技能卡片同时显示「中文简介优先」与「被丢弃」的原因（两者不能混成一句）', async () => {
    listSkillsMock.mockResolvedValue({
      items: [
        skill(),
        skill({
          name: 'broken',
          source: 'agents',
          used_by_prompt: false,
          discarded: true,
          flagged: ['frontmatter 缺 name'],
          summary: '',
          description: 'broken skill',
        }),
      ],
      usable: 1,
    })

    renderMisc(<CapabilitiesPage />)

    expect(await screen.findByText('把一批文档汇成一份 PDF 报告')).toBeInTheDocument()
    expect(screen.getByText('跨工具共享（~/.agents/skills）')).toBeInTheDocument()
    expect(screen.getByText('已丢弃')).toBeInTheDocument()
    expect(screen.getByText('frontmatter 缺 name')).toBeInTheDocument()
    // 状态栏那个数来自后端：1 / 2 可用
    expect(screen.getByText('技能 1/2 可用')).toBeInTheDocument()
  })

  it('插件包一栏把四类能力面的「未实现」原样显示，并给出本地市场目录', async () => {
    renderMisc(<CapabilitiesPage />)
    await userEvent.click(await screen.findByRole('tab', { name: '插件包' }))

    expect(await screen.findByText('demo-pack')).toBeInTheDocument()
    expect(screen.getByText('/data/plugins')).toBeInTheDocument()
    // 后端的 status 原样显示——不能让人以为点了就能跑
    await userEvent.click(screen.getByRole('button', { name: /提供了 1 项/ }))
    expect(await screen.findByText(/未实现：这一轮只列出，不会执行/)).toBeInTheDocument()
  })

  it('探活连不上不是错误：把后端那句 detail 原样显示出来', async () => {
    probeMock.mockResolvedValue(
      server({ reachable: false, detail: '命令不存在：npx 未安装', tools: [] }),
    )

    renderMisc(<CapabilitiesPage />)
    await userEvent.click(await screen.findByRole('tab', { name: '插件' }))
    await userEvent.click(await screen.findByRole('button', { name: /连接中…|测试连接/ }))

    await waitFor(() => expect(probeMock).toHaveBeenCalledWith('srv-1'))
    expect(await screen.findByText('命令不存在：npx 未安装')).toBeInTheDocument()
  })

  it('凭据只显示"已配置"，不回显值；编辑表单里那一栏留空', async () => {
    renderMisc(<CapabilitiesPage />)
    await userEvent.click(await screen.findByRole('tab', { name: '插件' }))

    expect(await screen.findByText('凭据已配置')).toBeInTheDocument()
    expect(screen.getByText('需确认')).toBeInTheDocument()
    expect(screen.queryByDisplayValue('TOKEN')).not.toBeInTheDocument()
  })

  it('技能正文弹窗里给出「卸载」入口（只对市场装的技能）', async () => {
    const { getSkill } = await import('@/api/capabilities')
    vi.mocked(getSkill).mockResolvedValue({
      ...skill({ name: 'from-github' }),
      body: '# 正文\n\n按需读进来的一段。',
    })
    listSkillsMock.mockResolvedValue({ items: [skill({ name: 'from-github' })], usable: 1 })
    listInstalledMock.mockResolvedValue({
      items: { 'from-github': 'github:owner/repo@abc1234#skills/x' },
      total: 1,
    })

    renderMisc(<CapabilitiesPage />)
    await userEvent.click(await screen.findByRole('button', { name: 'from-github' }))

    const dialog = await screen.findByRole('dialog')
    // 正文弹窗是 @/ui/dialog 的组合壳，正文按 markdown 渲染（不再用可复制的 pre）
    expect(dialog).toHaveAttribute('data-slot', 'dialog-content')
    expect(await within(dialog).findByText(/按需读进来的一段/)).toBeInTheDocument()
    expect(within(dialog).getByText('来自 owner/repo')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: /卸载/ })).toBeInTheDocument()
  })

  it('分区导航是带当前态的页签组：`aria-selected` 跟着点击走', async () => {
    renderMisc(<CapabilitiesPage />)

    const skills = await screen.findByRole('tab', { name: '技能' })
    const plugins = screen.getByRole('tab', { name: '插件' })
    expect(skills).toHaveAttribute('aria-selected', 'true')
    expect(skills).toHaveAttribute('data-state', 'active')
    expect(plugins).toHaveAttribute('aria-selected', 'false')

    await userEvent.click(plugins)
    expect(plugins).toHaveAttribute('aria-selected', 'true')
    expect(skills).toHaveAttribute('aria-selected', 'false')
  })

  it('技能正文按 markdown 渲染：看不到 `#` 与 `**`，也没有首行的解释小字', async () => {
    const { getSkill } = await import('@/api/capabilities')
    vi.mocked(getSkill).mockResolvedValue({
      ...skill({ name: 'from-github' }),
      body: '# 正文\n\n按需读进来的一段，**加粗**。',
    })
    listSkillsMock.mockResolvedValue({ items: [skill({ name: 'from-github' })], usable: 1 })

    renderMisc(<CapabilitiesPage />)
    await userEvent.click(await screen.findByRole('button', { name: 'from-github' }))

    const dialog = await screen.findByRole('dialog')
    // `#` 成了标题、`**` 成了加粗：源文件被渲染成了文档
    expect(within(dialog).getByRole('heading', { name: '正文' })).toBeInTheDocument()
    expect(within(dialog).getByText('加粗').tagName).toBe('STRONG')
    expect(dialog.textContent).not.toContain('**')
    // 首行那句"这就是模型按需读进来的正文…"（解释性小字，U1）不再出现
    expect(dialog.textContent).not.toContain('frontmatter')
  })
})
