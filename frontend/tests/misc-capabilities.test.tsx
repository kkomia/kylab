/**
 * 能力页（旧 `views/CapabilitiesView.vue` + `components/capabilities/**`）的用例。
 *
 * 十条刻意设计的验证：
 * 1. **被拦下/被丢弃的技能要显示原因**（`flagged` + `discarded` 分开标）；
 * 2. **插件包的"未实现"原样显示**（四类能力面的 status 是后端给的，界面不改写）；
 * 3. **探活连不上不是错误、是结果**：`reachable:false` + `detail` 要显示出来；
 * 4. **分区导航是页签组**（`aria-selected` 跟着点击走）——这一页唯一的导航，
 *    评审 G1 报的就是它既没有当前态、也不是页签；当前态现在由 `@/ui/tabs`
 *    自己的 `data-[state=active]:bg-surface` 画，第一批那层临时垫底 span 不再出现；
 * 5. **技能卡紧凑**（评审 G2）：一行摘要、来源不逐卡重复、长描述进详情弹窗；
 * 6. **技能正文按 markdown 渲染**：用户看到的是文档，不是 `SKILL.md` 源码
 *    （`#` 成标题、`**` 成加粗），且首行那句解释小字已按 U1 删掉；
 * 7. **联网搜索的配置区就摆在页面上**、保存不会把留空的密钥发出去（2026-09-30：
 *    用户"找不到哪儿能填 API key"，而密钥被抹掉是同一处的另一半）；
 * 8. **"读不到"不等于"没有"**：页头三颗读数（技能 / 插件 / 插件包）分三态——
 *    读取中 / 读取失败 / 真有数。`技能 0 / 0 可用` 只有在后端真回了个空列表时
 *    才是对的；请求还在飞或已经失败时它会被读成"一个都没装"；
 * 9. **每类默认只露 2 条精选**（v0.61）：判据是接口标在每条上的 `featured`
 *    （**前端不自己算"前 2 条"**），其余收在「展开其余 N 条」后面；搜索时不受这
 *    2 条限制（否则用户搜不到），清空关键词回到默认收起态；后端一条精选都没标、
 *    或**这一类**没有精选时**全露**——宁可多露几张卡，也不能把一类画成空的。
 * 10. **归类按后端给的 `category`**（镜像那份是快照，实测与后端现算的差 25 条）：
 *    同一条按镜像该进「其他」、后端说是「演示与幻灯片」，就必须进后者——
 *    否则精选（后端按自己的分类选的）与分组错位，几类会露 1 条或 3 条。
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
    // D23：单条技能的启停
    setSkillEnabled: vi.fn(),
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
  setSkillEnabled,
  type MCPServer,
  type Skill,
} from '@/api/capabilities'
import { listPlugins, type PluginPack } from '@/api/plugins'
import { resetLocalBackendForTest, setLocalBackendForTest } from '@/api/local'
import { getSettings, updateSettings, type SettingGroup } from '@/api/settings'
import { CapabilitiesPage } from '@/features/misc/capabilities/CapabilitiesPage'
import { renderMisc } from '@/features/misc/testing/harness'
import { resetToasts } from '@/features/misc/shared/toast'
import { useSessionStore } from '@/lib/session'

const listSkillsMock = vi.mocked(listSkills)
const listInstalledMock = vi.mocked(listInstalledSkills)
const listServersMock = vi.mocked(listMCPServers)
const probeMock = vi.mocked(probeMCPServer)
const listPluginsMock = vi.mocked(listPlugins)
const getSettingsMock = vi.mocked(getSettings)
const updateSettingsMock = vi.mocked(updateSettings)

/** 联网那一组（后端的 `SETTING_GROUPS['web']`，密钥已配过 → 只回掩码） */
const WEB_GROUP: SettingGroup = {
  key: 'web',
  label: '联网',
  fields: [
    {
      key: 'web.search_provider',
      label: '搜索服务商',
      type: 'select',
      value: 'tavily',
      configured: true,
      options: [
        { value: 'tavily', label: 'Tavily' },
        { value: 'bocha', label: '博查 Bocha' },
      ],
    },
    {
      key: 'web.search_api_key',
      label: '搜索 API 密钥',
      type: 'secret',
      value: 'tvl…lTV',
      configured: true,
      options: [],
    },
  ],
}

/**
 * 技能列表项的夹具。
 *
 * `category` / `featured`（v0.61）是 `@/api/capabilities` 的手写声明还没带上的那两个
 * 字段（生成物 `@/api/schema.d.ts` 里已经有了），这里窄吃它们——
 * "每类默认只露 2 条"那条口径只有拿 `featured` 才钉得住（**前端不重算精选**），
 * `category` 则决定这一条归哪一类（后端给的优先于镜像映射）。
 * **两个字段默认都不给**（= 老后端 / 没经过分类的样子），要用的用例自己写。
 */
type SkillFixture = Skill & { category?: string; featured?: boolean }

function skill(overrides: Partial<SkillFixture> = {}): SkillFixture {
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
    // D23：用户那颗开关的位置（与 `used_by_prompt` 分开——那个是"实际进没进"）
    enabled: true,
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

afterEach(() => {
  // 「这一份有没有本机后端」是模块级单份状态（`api/local.ts`）：摆过的用例必须复位，
  // 否则这一份的结论会串到下一条（真机上表现为"管理员入口时有时无"）
  resetLocalBackendForTest()
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

  it('不再有按来源分的筛选排（「随代码发布」「从市场装」是内部分类名，2026-09-24 删）', async () => {
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

    await screen.findByText('builtin-a')
    // 那一排胶囊（含「全部」与三档来源）整排不在了：来源靠详情弹窗那一行说，
    // 找技能靠搜索与列表。**断言"整排不存在"**，而不是"少了几颗"——
    // 否则以后把内部分类名加回来时用例照样绿
    expect(screen.queryByRole('tablist', { name: '技能筛选' })).toBeNull()
    expect(screen.queryByText('随代码发布')).toBeNull()
    expect(screen.queryByText('从市场装')).toBeNull()
    // 三个技能照样都列出来（列表本身没被筛选排带走）
    expect(screen.getByText('from-market')).toBeInTheDocument()
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

  it('技能卡上有开关：点它调 setSkillEnabled（D23，走查实测原先一个开关都没有）', async () => {
    listSkillsMock.mockResolvedValue({ items: [skill()], usable: 1 })
    vi.mocked(setSkillEnabled).mockResolvedValue(skill({ enabled: false }))

    renderMisc(<CapabilitiesPage />)

    // 可访问名说清"按下去会怎样"，而不是只写一个「开关」
    const toggle = await screen.findByRole('switch', { name: '关掉技能 pdf-report' })
    await userEvent.click(toggle)

    await waitFor(() => expect(setSkillEnabled).toHaveBeenCalledWith('pdf-report', false))
  })

  it('被丢弃的技能**不给**开关（按下去不会有反应，摆着更糟）', async () => {
    listSkillsMock.mockResolvedValue({
      items: [skill({ discarded: true, used_by_prompt: false, flagged: ['缺 description'] })],
      usable: 0,
    })

    renderMisc(<CapabilitiesPage />)

    expect(await screen.findByText('已丢弃')).toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  })

  it('技能按分类分组：每类头带条数、可收合，搜索在类内生效', async () => {
    /*
     * **夹具刻意小**（不拿真映射那 183 条来渲染）：这一条验的是**页面的分组交互**
     * （头 + 条数 + 收合 + 类内搜索 ✓），渲染 183 张卡再逐个点/搜会把这条用例顶到
     * vitest 默认 5 秒超时边上 ✗（2026-09-29 全量并发时真翻过：单跑 1.5 秒 ✓、
     * 全量并发时 5.2 秒 ✗）。"**每类条数之和 = 真映射的条数、每条只出现一次**"
     * 这条性质由纯函数用例钉着（`tests/misc-capabilities-categories.test.ts` ✓，
     * 读的就是那份真镜像 JSON ✓）——两层各管一件事 ✓。
     */
    const items = [
      skill({ name: 'pptx' }), // 演示与幻灯片
      skill({ name: 'slide-skill' }),
      skill({ name: 'xlsx' }), // 表格与数据
      skill({ name: 'pdf-pro' }), // 文档与办公
      skill({ name: 'my-own-skill' }), // 不在映射里 → 「其他」
    ]
    listSkillsMock.mockResolvedValue({ items, usable: items.length })

    renderMisc(<CapabilitiesPage />)

    const headers = await screen.findAllByTestId('skill-category')
    expect(headers.length).toBeGreaterThanOrEqual(3)
    const counts = headers.map((header) => {
      const number = [...header.querySelectorAll('span')].find((el) =>
        /^\d+$/.test(el.textContent ?? ''),
      )
      return Number(number?.textContent ?? '0')
    })
    expect(counts.reduce((total, value) => total + value, 0)).toBe(items.length)
    expect(document.querySelectorAll('li.m-card')).toHaveLength(items.length)

    // 收合第一类：它那一组从画面上消失，别的类还在
    const first = headers[0] as HTMLElement
    await userEvent.click(first)
    expect(first).toHaveAttribute('aria-expanded', 'false')
    expect(document.querySelectorAll('li.m-card')).toHaveLength(items.length - counts[0])
    // 再点开：回到全部
    await userEvent.click(first)
    expect(document.querySelectorAll('li.m-card')).toHaveLength(items.length)

    // 搜索在类内生效：只剩命中的那一条，其余类的头也不画
    await userEvent.type(screen.getByLabelText('搜索技能'), 'pdf-pro')
    await waitFor(() => expect(document.querySelectorAll('li.m-card')).toHaveLength(1))
    expect(screen.getAllByTestId('skill-category')).toHaveLength(1)
  })

  /* ------------------------------------------------------- 每类默认只露 2 条（v0.61） */

  /**
   * v0.61 的精选夹具：`slides`（演示与幻灯片）一类 4 条、后端标了前 2 条为精选；
   * `documents`（文档与办公）一类 2 条、两条都是精选（**没有可展开的**——
   * 那颗入口就不该出现）。名字都取自真映射，落在哪一类不是用例编的。
   */
  function featuredSkills(): SkillFixture[] {
    return [
      skill({ name: 'slide-skill', featured: true }),
      skill({ name: 'presentation-skill', featured: true }),
      skill({ name: 'html2pptx' }),
      skill({ name: 'mocky' }),
      skill({ name: 'pdf-pro', featured: true }),
      skill({ name: 'office-automation', featured: true }),
    ]
  }

  /** 某一类的头（`data-category` 是 slug）。 */
  function categoryHeader(slug: string): HTMLElement {
    const found = screen
      .getAllByTestId('skill-category')
      .find((element) => element.getAttribute('data-category') === slug)
    if (!found) throw new Error(`这一类没画出来：${slug}`)
    return found
  }

  /** 类头上那个条数——说的是**这一类一共几条**，不是现在露了几条。 */
  function headerCount(slug: string): number {
    const span = [...categoryHeader(slug).querySelectorAll('span')].find((element) =>
      /^\d+$/.test(element.textContent ?? ''),
    )
    return Number(span?.textContent ?? '0')
  }

  it('归类按后端给的 `category`：镜像说「其他」、后端说「演示与幻灯片」时就进后者', async () => {
    /*
     * 镜像那份 `assignments` 是**快照**，后端是**现算**的（实测 187 条里差 25 条，
     * 产品自带的 `pptx`/`docx`/`xlsx`/`pdf` 压根不在镜像里）。两边若各用一份，
     * 精选（后端按自己的分类选的）与分组就错位：这一类会露 1 条、那一类露 3 条。
     * 所以分组跟着后端走——这条用例把优先级钉死。
     */
    const items = [
      skill({ name: 'pptx', category: 'slides', featured: true }),
      skill({ name: 'slide-skill', category: 'slides', featured: true }),
      skill({ name: 'html2pptx', category: 'slides' }),
      // 后端给了一个**没登记过**的分类（版本不匹配）：照旧兜到「其他」，不许凭空消失
      skill({ name: 'no-such-category', category: 'not-registered', featured: true }),
    ]
    listSkillsMock.mockResolvedValue({ items, usable: items.length })

    renderMisc(<CapabilitiesPage />)

    // `pptx` 在镜像里查不到（按镜像该进「其他」），但后端说它属于演示与幻灯片
    expect(await screen.findByText('pptx')).toBeInTheDocument()
    expect(headerCount('slides')).toBe(3)
    // 这一类按后端标了 2 条精选（pptx + slide-skill），第 3 条收在入口后面
    expect(document.querySelectorAll('li.m-card')).toHaveLength(3)
    expect(screen.getByRole('button', { name: /展开其余 1 条/ })).toHaveAttribute(
      'data-category',
      'slides',
    )
    // 没登记过的分类兜到「其他」：那一条在那儿，且它没精选 → 这一类全露
    expect(headerCount('other')).toBe(1)
    expect(screen.getByText('no-such-category')).toBeInTheDocument()
  })

  it('每类默认只露 2 条：以接口标的 `featured` 为准，其余收在那颗入口后面', async () => {
    const items = featuredSkills()
    listSkillsMock.mockResolvedValue({ items, usable: items.length })

    renderMisc(<CapabilitiesPage />)

    // 这一类 4 条，先露后端标的那 2 条。**判据是 `featured`**：夹具里后面两条
    // 名字更短、看起来也更像"精选"，但后端没标它们，前端就不许自己挑
    expect(await screen.findByText('slide-skill')).toBeInTheDocument()
    expect(screen.getByText('presentation-skill')).toBeInTheDocument()
    expect(screen.queryByText('html2pptx')).toBeNull()
    expect(screen.queryByText('mocky')).toBeNull()
    // 另一类两条都是精选：全露
    expect(screen.getByText('pdf-pro')).toBeInTheDocument()
    expect(screen.getByText('office-automation')).toBeInTheDocument()
    expect(document.querySelectorAll('li.m-card')).toHaveLength(4)

    // 类头那颗数说的是这一类**一共**几条（0 条也不许出现：那会把一类说成空的）
    expect(headerCount('slides')).toBe(4)
    expect(headerCount('documents')).toBe(2)

    // 「展开其余 N 条」只说真收起来的那几条，而且只出现在真有收起来的**那一类**
    const reveals = screen.getAllByTestId('skill-category-reveal')
    expect(reveals).toHaveLength(1)
    expect(reveals[0]).toHaveAttribute('data-category', 'slides')
    expect(reveals[0]).toHaveTextContent('展开其余 2 条')
  })

  it('点「展开其余 N 条」把这一类补全，再点「收起」回到 2 条', async () => {
    const items = featuredSkills()
    listSkillsMock.mockResolvedValue({ items, usable: items.length })

    renderMisc(<CapabilitiesPage />)

    await userEvent.click(await screen.findByRole('button', { name: /展开其余 2 条/ }))

    expect(screen.getByText('html2pptx')).toBeInTheDocument()
    expect(screen.getByText('mocky')).toBeInTheDocument()
    expect(document.querySelectorAll('li.m-card')).toHaveLength(6)
    // 展开之后同一颗变「收起」（与插件卡上「工具 N 个 / 收起工具」同一形态），
    // 而且**可访问名带着类名**：一屏十几颗同样的入口，光听"收起"分不出是哪一类的
    const collapse = screen.getByRole('button', { name: '演示与幻灯片：收起' })
    expect(collapse).toHaveAttribute('data-category', 'slides')
    expect(collapse).toHaveAttribute('aria-expanded', 'true')

    await userEvent.click(collapse)
    expect(screen.queryByText('html2pptx')).toBeNull()
    expect(document.querySelectorAll('li.m-card')).toHaveLength(4)
    expect(screen.getByRole('button', { name: /展开其余 2 条/ })).toBeInTheDocument()
  })

  it('搜索时不受这 2 条限制：有关键词就在这一类里搜全部', async () => {
    const items = featuredSkills()
    listSkillsMock.mockResolvedValue({ items, usable: items.length })

    renderMisc(<CapabilitiesPage />)

    await screen.findByText('slide-skill')
    // 夹具里每条描述都含 "PDF"，所以这个词会把两类都筛成"整类都在"
    await userEvent.type(screen.getByLabelText('搜索技能'), 'pdf')
    await waitFor(() => expect(document.querySelectorAll('li.m-card')).toHaveLength(6))
    // 不在精选里的那两条也搜得到——收着它们就等于"搜了也没有"
    expect(screen.getByText('html2pptx')).toBeInTheDocument()
    expect(screen.getByText('mocky')).toBeInTheDocument()
    // 这一屏没有"收起来的"，那颗入口整颗不出现（「展开其余 0 条」是一句废话）
    expect(screen.queryByTestId('skill-category-reveal')).toBeNull()
  })

  it('清空关键词回到默认收起态：搜过 / 展开过都不许把默认值改掉', async () => {
    const items = featuredSkills()
    listSkillsMock.mockResolvedValue({ items, usable: items.length })

    renderMisc(<CapabilitiesPage />)

    await screen.findByText('slide-skill')
    // 先手动把这一类摊开
    await userEvent.click(screen.getByRole('button', { name: /展开其余 2 条/ }))
    expect(document.querySelectorAll('li.m-card')).toHaveLength(6)

    const search = screen.getByLabelText('搜索技能')
    await userEvent.type(search, 'mocky')
    await waitFor(() => expect(document.querySelectorAll('li.m-card')).toHaveLength(1))
    expect(screen.getByText('mocky')).toBeInTheDocument()

    // 清空关键词：回到默认收起态（每类 2 条），不是回到"搜之前摊开的样子"
    await userEvent.clear(search)
    await waitFor(() => expect(document.querySelectorAll('li.m-card')).toHaveLength(4))
    expect(screen.queryByText('mocky')).toBeNull()
    expect(screen.getByRole('button', { name: /展开其余 2 条/ })).toBeInTheDocument()
  })

  it('后端一条精选都没标时降级为**全露**：宁可多露几张，也不能把一类收成空壳', async () => {
    // 老后端 / 字段没给：`featured` 一位都没有
    const items = [
      skill({ name: 'slide-skill' }),
      skill({ name: 'presentation-skill' }),
      skill({ name: 'html2pptx' }),
      skill({ name: 'mocky' }),
    ]
    listSkillsMock.mockResolvedValue({ items, usable: items.length })

    renderMisc(<CapabilitiesPage />)

    expect(await screen.findByText('slide-skill')).toBeInTheDocument()
    expect(document.querySelectorAll('li.m-card')).toHaveLength(4)
    // 类头还在（不是空分组），也没有一颗"展开其余 0 条"
    expect(categoryHeader('slides')).toHaveTextContent('演示与幻灯片')
    expect(screen.queryByTestId('skill-category-reveal')).toBeNull()
  })

  it('某一类没有精选时**只有这一类**全露，别的类照旧收着 2 条', async () => {
    // `documents` 这一类后端给不出精选（整类都被拦下时就是这样）：不许画成空的
    const items = [
      skill({ name: 'slide-skill', featured: true }),
      skill({ name: 'presentation-skill', featured: true }),
      skill({ name: 'html2pptx' }),
      skill({ name: 'pdf-pro' }),
      skill({ name: 'office-automation' }),
      skill({ name: 'kylab-office-export' }),
    ]
    listSkillsMock.mockResolvedValue({ items, usable: items.length })

    renderMisc(<CapabilitiesPage />)

    await screen.findByText('slide-skill')
    // slides 露 2 条精选 + documents 全露 3 条
    expect(document.querySelectorAll('li.m-card')).toHaveLength(5)
    expect(screen.getByText('kylab-office-export')).toBeInTheDocument()
    expect(headerCount('documents')).toBe(3)
    // 有精选的那一类照旧收着，入口也只有它一颗
    const reveals = screen.getAllByTestId('skill-category-reveal')
    expect(reveals).toHaveLength(1)
    expect(reveals[0]).toHaveAttribute('data-category', 'slides')
    expect(reveals[0]).toHaveTextContent('展开其余 1 条')
  })

  /*
   * 下面这一组钉的是同一件事的三面：**"读不到"不等于"没有"**。
   *
   * 技能那一路是**全库返回**（1.6 万条、冷扫几十秒），所以打开这一页时"数据还没到"
   * 是常态；而 `data ?? []` 那种读法会把它画成 `技能 0 / 0 可用`——与"一个技能都
   * 没装"字面相同。0 在这几处是**结论**，不能拿它当"还不知道"。
   */
  it('数据还没到时页头三颗读数都说「读取中」，一颗都不报 0', async () => {
    // 三个查询一起挂在半空中：这正是打开这一页时的第一帧
    const pending: (() => void)[] = []
    listSkillsMock.mockImplementation(
      () =>
        new Promise<{ items: Skill[]; usable: number }>((resolve) => {
          pending.push(() => resolve({ items: [skill()], usable: 1 }))
        }),
    )
    listServersMock.mockImplementation(
      () =>
        new Promise<{ items: MCPServer[] }>((resolve) => {
          pending.push(() => resolve({ items: [server()] }))
        }),
    )
    listPluginsMock.mockImplementation(
      () =>
        new Promise<Awaited<ReturnType<typeof listPlugins>>>((resolve) => {
          pending.push(() =>
            resolve({
              items: [pack()],
              total: 1,
              enabled: 1,
              failed: 0,
              user_dir: '/data/plugins',
              builtin_dir: '/app/plugins',
            }),
          )
        }),
    )

    renderMisc(<CapabilitiesPage />)

    expect(await screen.findByText('技能 读取中')).toBeInTheDocument()
    expect(screen.getByText('插件 读取中')).toBeInTheDocument()
    expect(screen.getByText('插件包 读取中')).toBeInTheDocument()
    // "还不知道"不许写成 0：这三处的 0 都是结论
    expect(screen.queryByText(/技能 \d+ \/ \d+ 可用/)).toBeNull()
    expect(screen.queryByText(/插件 \d+ 个/)).toBeNull()
    expect(screen.queryByText(/插件包 \d+ \/ \d+/)).toBeNull()
    // 也不能落到空态上："还没有技能"会被读成"一个都没装"
    expect(screen.queryByText('还没有技能')).toBeNull()

    // 数据到了之后三颗一起报数
    pending.forEach((resolve) => resolve())
    expect(await screen.findByText('技能 1 / 1 可用')).toBeInTheDocument()
    expect(screen.getByText('插件 1 个')).toBeInTheDocument()
    expect(screen.getByText('插件包 1 / 1')).toBeInTheDocument()
  })

  it('技能读不到时是错误态 + 重试入口，不伪装成「还没有技能」', async () => {
    listSkillsMock.mockRejectedValueOnce(new Error('技能列表读取超时'))

    renderMisc(<CapabilitiesPage />)

    // 页头那颗如实说"读不到"，不写 0
    expect(await screen.findByText('技能 读取失败')).toBeInTheDocument()
    expect(screen.queryByText(/技能 \d+ \/ \d+ 可用/)).toBeNull()
    // 列表的位置上是错误态：后端那句原话 + 一个重试入口
    expect(screen.getByText('技能读取失败')).toBeInTheDocument()
    expect(screen.getByText('技能列表读取超时')).toBeInTheDocument()
    expect(screen.queryByText('还没有技能')).toBeNull()

    // 重试真的再拉一次：数据回来之后列表与读数都跟着回来
    await userEvent.click(screen.getByRole('button', { name: /重试/ }))
    expect(await screen.findByText('pdf-report')).toBeInTheDocument()
    expect(screen.getByText('技能 1 / 1 可用')).toBeInTheDocument()
  })

  it('插件读不到时同样是错误态：不谎报「还没有插件」，筛选胶囊也不画', async () => {
    listServersMock.mockRejectedValueOnce(new Error('连不上本机服务'))

    renderMisc(<CapabilitiesPage />)
    await userEvent.click(await screen.findByRole('tab', { name: '插件' }))

    expect(await screen.findByText('插件读取失败')).toBeInTheDocument()
    expect(screen.getByText('插件 读取失败')).toBeInTheDocument()
    expect(screen.getByText('连不上本机服务')).toBeInTheDocument()
    expect(screen.queryByText('还没有插件')).toBeNull()
    // 「全部 0」也是把"还没回来"画成 0：没有数就整排不画
    expect(screen.queryByRole('tablist', { name: '插件筛选' })).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: /重试/ }))
    expect(await screen.findByText('filesystem')).toBeInTheDocument()
  })

  it('插件包读不到时报「读取失败」，不谎报「还没有插件包」', async () => {
    listPluginsMock.mockRejectedValue(new Error('插件目录读不动'))

    renderMisc(<CapabilitiesPage />)
    await userEvent.click(await screen.findByRole('tab', { name: '插件包' }))

    expect(await screen.findByText('插件包读取失败')).toBeInTheDocument()
    expect(screen.getByText('插件包 读取失败')).toBeInTheDocument()
    expect(screen.getByText('插件目录读不动')).toBeInTheDocument()
    expect(screen.queryByText('还没有插件包')).toBeNull()
  })

  it('真拿到空结果才说「还没有技能」，页头那三颗也才敢报 0', async () => {
    listSkillsMock.mockResolvedValue({ items: [], usable: 0 })
    listServersMock.mockResolvedValue({ items: [] })
    listPluginsMock.mockResolvedValue({
      items: [],
      total: 0,
      enabled: 0,
      failed: 0,
      user_dir: '/data/plugins',
      builtin_dir: '/app/plugins',
    })

    renderMisc(<CapabilitiesPage />)

    expect(await screen.findByText('还没有技能')).toBeInTheDocument()
    expect(screen.getByText('技能 0 / 0 可用')).toBeInTheDocument()
    expect(screen.getByText('插件 0 个')).toBeInTheDocument()
    expect(screen.getByText('插件包 0 / 0')).toBeInTheDocument()
  })

  it('查询被暂停（浏览器报离线）时也是「读取中」：暂停≠没有，也更不是"读不到"', async () => {
    /*
     * 实测到的第三种"未就绪"：react-query 在浏览器报离线时把查询挂成
     * `fetchStatus: 'paused'`——那时 `isLoading` 与 `isError` 都是 false，只有"没数"
     * 是真的。按 `isLoading` 分支的写法会把它画成"还没有技能"（与那个假 0 同一类错）。
     * 所以这条直接按离线态钉住：三颗读数说读取中、列表位置是骨架、**不出现空态**。
     */
    const { onlineManager } = await import('@tanstack/react-query')
    onlineManager.setOnline(false)
    try {
      renderMisc(<CapabilitiesPage />)

      expect(await screen.findByText('技能 读取中')).toBeInTheDocument()
      expect(screen.getByText('插件 读取中')).toBeInTheDocument()
      expect(screen.getByText('插件包 读取中')).toBeInTheDocument()
      // 没数就不报数、也不说"读不到"（那是把"还不知道"说成结论）
      expect(screen.queryByText(/技能 \d+ \/ \d+ 可用/)).toBeNull()
      expect(screen.queryByText('技能 读取失败')).toBeNull()
      expect(screen.queryByText('还没有技能')).toBeNull()
      // 列表位置上是骨架（还没数），不是空态
      expect(document.querySelector('.m-empty')).toBeNull()
    } finally {
      // 别的用例要的是正常的在线态（onlineManager 是模块级单例）
      onlineManager.setOnline(true)
    }
  })

  /**
   * 管理员的定义（`lib/useIsAdmin`）：**本机档没有账号体系**（`currentUser` 恒为 null），
   * 而那一档"本机主人"就是这台机器的管理员。这一页上被那条判据挡着的入口读的全是
   * **本机服务**的东西（`/settings`、`/skills`、`/plugins` 都在本机档的白名单上），
   * 所以按"有没有登录"判会把它们一并藏掉——用户报过两次同类 bug（侧栏「设置」、
   * 输入框那排「权限」）。反面同样要钉：服务器档 + 没有账号 ⇒ 确实不该摆。
   */
  describe('能力页 · 管理员的入口（本机档 / 服务器档）', () => {
    /** 技能页上那三处（页头「设置」、联网搜索那一组、市场那一颗）。 */
    function entriesOnSkills(): (HTMLElement | null)[] {
      return [
        screen.queryByRole('button', { name: '设置' }),
        screen.queryByRole('region', { name: '联网搜索' }),
        screen.queryByRole('button', { name: /浏览市场/ }),
      ]
    }

    it('本机档（没有账号）：页头「设置」、联网搜索那一组、市场、插件包卡上的操作都在', async () => {
      setLocalBackendForTest('local')
      useSessionStore.setState({ token: '', currentUser: null, reloginCount: 0 })

      renderMisc(<CapabilitiesPage />)
      await screen.findByRole('button', { name: /浏览市场/ })

      expect(entriesOnSkills().every((item) => item !== null)).toBe(true)

      await userEvent.click(screen.getByRole('tab', { name: '插件包' }))
      expect(await screen.findByRole('button', { name: 'demo-pack 的操作' })).toBeInTheDocument()
    })

    it('服务器档 + 没有账号：这三处与插件包那一条**都不在**', async () => {
      setLocalBackendForTest('absent')
      useSessionStore.setState({ token: '', currentUser: null, reloginCount: 0 })

      renderMisc(<CapabilitiesPage />)
      // 技能那一页照旧在（这一条钉的是那几处入口，不是整页）
      expect(await screen.findByText('pdf-report')).toBeInTheDocument()

      expect(entriesOnSkills()).toEqual([null, null, null])

      await userEvent.click(screen.getByRole('tab', { name: '插件包' }))
      expect(await screen.findByText('demo-pack')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'demo-pack 的操作' })).toBeNull()
    })

    it('服务器档 + 管理员账号：照旧都在（判据对"有账号"那一支没改）', async () => {
      // 这一档是 NAS 网页端那一位管理员：没有本机后端，但账号是真的、角色是管理员
      setLocalBackendForTest('absent')

      renderMisc(<CapabilitiesPage />)
      await screen.findByRole('button', { name: /浏览市场/ })

      expect(entriesOnSkills().every((item) => item !== null)).toBe(true)

      await userEvent.click(screen.getByRole('tab', { name: '插件包' }))
      expect(await screen.findByRole('button', { name: 'demo-pack 的操作' })).toBeInTheDocument()
    })
  })

  it('联网搜索的配置区直接摆在页面上，且保存不会把留空的密钥抹掉', async () => {
    /*
     * 2026-09-30 用户反馈的原话是"界面上找不到任何地方能填 Tavily 的 API key"：
     * 它原来跟着沙箱一起收在页头那颗「设置」弹窗里，而后端报错文案说的是
     * 「设置 → 联网」——用户顺着那句话去**总设置**里找（那儿早就不放联网了）。
     * 所以这一条钉两件事：
     *
     * 1. **不点任何按钮就看得见**（页面上常驻的区块）；
     * 2. 密钥那一栏是 password 型，且"只改了服务商、密钥留空"时**一个密钥字段都不发**
     *    ——后端把空值当**清除**，发出去就是把用户真配过的密钥抹掉。
     *
     * 这条用例与别的不同：它需要设置接口返回真形状的 `web` 组，所以
     * `getSettings` 的实现留在这里（`vi.clearAllMocks` 只清调用记录，不清实现，
     * 因此这条放在文件末尾）。
     */
    getSettingsMock.mockResolvedValue({
      groups: [WEB_GROUP],
      embedding_model_id: '',
      embedding_dim: 0,
      embedding_configured: false,
      embedding_is_development: false,
      rerank_enabled: false,
    })
    updateSettingsMock.mockResolvedValue({ updated: 1, rejected: [] })

    renderMisc(<CapabilitiesPage />)

    expect(await screen.findByRole('heading', { name: /联网/ })).toBeInTheDocument()
    expect(screen.getByText('已配置')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '编辑' }))

    expect(screen.getByLabelText('搜索 API 密钥')).toHaveAttribute('type', 'password')

    await userEvent.click(screen.getByRole('button', { name: '保存' }))

    expect(updateSettingsMock).toHaveBeenCalledWith([
      { key: 'web.search_provider', value: 'tavily' },
    ])
  })
})
