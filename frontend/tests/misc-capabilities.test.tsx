/**
 * 能力页（旧 `views/CapabilitiesView.vue` + `components/capabilities/**`）的用例。
 *
 * 六条刻意设计的验证：
 * 1. **被拦下/被丢弃的技能要显示原因**（`flagged` + `discarded` 分开标）；
 * 2. **插件包的"未实现"原样显示**（四类能力面的 status 是后端给的，界面不改写）；
 * 3. **探活连不上不是错误、是结果**：`reachable:false` + `detail` 要显示出来；
 * 4. **分区导航是页签组**（`aria-selected` 跟着点击走）——这一页唯一的导航，
 *    评审 G1 报的就是它既没有当前态、也不是页签；当前态现在由 `@/ui/tabs`
 *    自己的 `data-[state=active]:bg-surface` 画，第一批那层临时垫底 span 不再出现；
 * 5. **技能卡紧凑**（评审 G2）：一行摘要、来源不逐卡重复、长描述进详情弹窗；
 * 6. **技能正文按 markdown 渲染**：用户看到的是文档，不是 `SKILL.md` 源码
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
  it('技能卡片「中文简介优先」+「被丢弃」的原因都留在卡上，来源与状态各就各位', async () => {
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

    const card = (await screen.findByText('pdf-report')).closest('li') as HTMLElement
    // 中文简介优先（`description` 是模型判断"何时该用"的英文触发文本）
    expect(within(card).getByText('把一批文档汇成一份 PDF 报告')).toBeInTheDocument()
    // 能用的**不再逐卡挂「可用」**（那是默认状态，同一列里重复 N 遍是纯噪音，
    // 而"几个能用"页头那颗「技能 x / y 可用」已经说过一次了）——卡上只留例外
    expect(within(card).queryByText('可用')).not.toBeInTheDocument()
    expect(within(card).queryByRole('status')).not.toBeInTheDocument()
    // 来源**不在卡上**（每张卡都挂同一条「随代码发布」是纯噪音），它去了筛选与详情
    expect(within(card).queryByText('手动放入')).not.toBeInTheDocument()

    const broken = (await screen.findByText('broken')).closest('li') as HTMLElement
    expect(within(broken).getByText('已丢弃')).toBeInTheDocument()
    expect(within(broken).getByText('frontmatter 缺 name')).toBeInTheDocument()
    // 状态栏那个数来自后端：1 / 2 可用（斜杠两侧带空格，全站一种写法）
    expect(screen.getByText('技能 1 / 2 可用')).toBeInTheDocument()
  })

  it('来源筛选：0 计数的来源不占位置，「全部」永远在（用户反馈："整简洁一点"）', async () => {
    listSkillsMock.mockResolvedValue({
      items: [
        skill({ name: 'builtin-a', source: 'builtin' }),
        skill({ name: 'builtin-b', source: 'builtin' }),
        skill({ name: 'from-market', source: 'user' }),
      ],
      usable: 3,
    })
    listInstalledMock.mockResolvedValue({
      items: { 'from-market': 'github:owner/repo@abc1234#skills/from-market' },
      total: 1,
    })

    renderMisc(<CapabilitiesPage />)

    // 先等技能列表到货：计数是从它算出来的（等不到就会读到清一色的 0）
    await screen.findByText('builtin-a')
    const chips = screen.getByRole('tablist', { name: '技能筛选' })
    const labels = [...chips.querySelectorAll('button')].map((chip) => chip.textContent)
    // 5 颗变 3 颗：`手动放入 0` / `未进提示词 0` 两颗点不出任何东西的胶囊不再占位置
    expect(labels).toEqual(['全部3', '随代码发布2', '从市场装1'])
    // "能看到全部"的那一颗必须在
    expect(within(chips).getByRole('tab', { name: /全部/ })).toBeInTheDocument()
    expect(within(chips).queryByRole('tab', { name: /手动放入/ })).toBeNull()
    expect(within(chips).queryByRole('tab', { name: /未进提示词/ })).toBeNull()
  })

  it('首屏只留一个主动作：浏览市场在主位，「重新扫描」收进「更多」（功能不删）', async () => {
    renderMisc(<CapabilitiesPage />)

    // 主位那颗就是安装入口
    expect(await screen.findByRole('button', { name: /浏览市场/ })).toBeInTheDocument()
    // 补救动作在「更多」里，不再平铺在首屏
    expect(screen.queryByRole('button', { name: /重新扫描/ })).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: '更多' }))
    const item = await screen.findByRole('menuitem', { name: /重新扫描/ })
    expect(item).toBeInTheDocument()
  })

  it('技能卡是 2–3 列紧凑网格：摘要只占一行，长描述进详情弹窗', async () => {
    const long = '这一条描述很长，长到单列大卡时会折成三行、末句还被截掉，紧凑卡只留一行。'
    listSkillsMock.mockResolvedValue({
      items: [skill({ summary: '', description: long })],
      usable: 1,
    })
    const { getSkill } = await import('@/api/capabilities')
    vi.mocked(getSkill).mockResolvedValue({
      ...skill({ summary: '把一批文档汇成一份 PDF 报告', description: long }),
      body: '# 正文',
    })

    renderMisc(<CapabilitiesPage />)

    const card = (await screen.findByText('pdf-report')).closest('li') as HTMLElement
    const grid = card.parentElement as HTMLElement
    expect(grid.tagName).toBe('UL')
    // 900px 的屏上也排得下两列；宽屏三列
    expect(grid.className).toContain('sm:grid-cols-2')
    expect(grid.className).toContain('xl:grid-cols-3')
    // 卡片上那一行是**截断**的（整段仍在 DOM 里，读全的地方是详情）
    expect(within(card).getByText(long).className).toContain('truncate')

    /*
      **形状是共享原语的，不是手写副本**（第六批）：容器 `.m-cards`（列间距归它）、
      卡片 `.m-card`（底色 / 描边 / 圆角 / 首行对齐归它）、图标 `.m-card-icon`。
      紧凑密度只有四个取值写在调用点——那四条能盖过 `.m-card`，靠的是 `misc.css`
      收进了 `@layer components`（工具类赢在层序）。谁再把这一套抄回调用点，这里会挂。
    */
    expect(grid.className).toContain('m-cards')
    expect(grid.className.split(/\s+/)).not.toContain('gap-[var(--space-2-5)]')
    expect(card.className).toContain('m-card')
    expect(card.className).toContain('rounded-[var(--radius-row)]')
    // 图标：装饰性（aria-hidden 保住），对齐交给原语自己（不再用 span 加内边距顶）
    const icon = card.querySelector('span') as HTMLElement
    expect(icon.className).toBe('m-card-icon')
    expect(icon).toHaveAttribute('aria-hidden', 'true')

    await userEvent.click(within(card).getByRole('button', { name: 'pdf-report' }))
    const dialog = await screen.findByRole('dialog')
    // 中文简介优先，整段读得到；英文原文也在（描述是模型那条路的触发文本）
    expect(within(dialog).getByText('把一批文档汇成一份 PDF 报告')).toBeInTheDocument()
    expect(within(dialog).getByText(long)).toBeInTheDocument()
  })

  it('来源只在详情里（卡片上不再逐卡重复）：跨工具共享那条也要说得出', async () => {
    const { getSkill } = await import('@/api/capabilities')
    vi.mocked(getSkill).mockResolvedValue({
      ...skill({ name: 'shared', source: 'agents', summary: '' }),
      body: '# 正文',
    })
    listSkillsMock.mockResolvedValue({
      items: [skill({ name: 'shared', source: 'agents', summary: '' })],
      usable: 1,
    })

    renderMisc(<CapabilitiesPage />)

    const card = (await screen.findByText('shared')).closest('li') as HTMLElement
    expect(within(card).queryByText('跨工具共享（~/.agents/skills）')).not.toBeInTheDocument()

    await userEvent.click(within(card).getByRole('button', { name: 'shared' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('跨工具共享（~/.agents/skills）')).toBeInTheDocument()
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

  it('分区导航是带当前态的页签组：白底由原语跟着 `data-state` 画，不再垫 span', async () => {
    renderMisc(<CapabilitiesPage />)

    const skills = await screen.findByRole('tab', { name: '技能' })
    const plugins = screen.getByRole('tab', { name: '插件' })
    expect(skills).toHaveAttribute('aria-selected', 'true')
    expect(skills).toHaveAttribute('data-state', 'active')
    expect(plugins).toHaveAttribute('aria-selected', 'false')
    expect(plugins).toHaveAttribute('data-state', 'inactive')
    // 当前态的视觉是原语自带的类（真样式见 `.shots/batch2/14-capabilities.png`）
    expect(skills.className).toContain('data-[state=active]:bg-surface')
    expect(skills.className).toContain('px-3')
    // 第一批为绕开病根垫的那层 span 已随根因修复删掉，这里不该再有
    expect(skills.querySelector('[data-slot="segment-current"]')).toBeNull()

    await userEvent.click(plugins)
    expect(plugins).toHaveAttribute('aria-selected', 'true')
    expect(plugins).toHaveAttribute('data-state', 'active')
    expect(skills).toHaveAttribute('aria-selected', 'false')
    expect(skills).toHaveAttribute('data-state', 'inactive')
  })

  it('技能空态说人话：指屏幕上已有的两个入口，不写 SKILL.md / 目录规则（B②）', async () => {
    listSkillsMock.mockResolvedValue({ items: [], usable: 0 })

    renderMisc(<CapabilitiesPage />)

    expect(await screen.findByText('还没有技能')).toBeInTheDocument()
    const hint = document.querySelector('.m-empty-hint') as HTMLElement
    // 出路就是屏幕上那两颗：装一个（浏览市场）、读本地目录（重新扫描）
    expect(hint.textContent).toContain('浏览市场')
    expect(hint.textContent).toContain('重新扫描')
    // 写给开发者的那一套不再出现（用户不知道 SKILL.md 是什么）
    expect(hint.textContent).not.toContain('SKILL.md')
    expect(hint.textContent).not.toContain('~/.agents')
    expect(hint.textContent).not.toContain('数据目录')
  })

  it('不是管理员时按屏幕上**真的有**的那颗说（市场入口只给管理员）', async () => {
    useSessionStore.setState({
      token: 'st',
      currentUser: { id: 'u2', username: 'member', name: '成员', role: 'member', avatar_url: '' },
      authStatus: null,
      reloginCount: 0,
    })
    listSkillsMock.mockResolvedValue({ items: [], usable: 0 })

    renderMisc(<CapabilitiesPage />)

    expect(await screen.findByText('还没有技能')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /浏览市场/ })).toBeNull()
    const hint = document.querySelector('.m-empty-hint') as HTMLElement
    expect(hint.textContent).toContain('重新扫描')
    expect(hint.textContent).not.toContain('浏览市场')
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
