/**
 * 能力页（v0.15）——与旧前端 `views/CapabilitiesView.vue` 逐条对应。
 *
 * 一页三栏，答的是同一个问题的三半——**这个 Agent 会什么**：
 * - **技能**：写在磁盘上的 `SKILL.md`（流程）。目录进系统提示词、正文按需展开，
 *   所以这里要能看正文——用户有权知道"它到底教了模型什么"；
 * - **插件**（协议上是 MCP 服务，界面上叫插件）：外部工具。这里能登记、探活、
 *   看它有哪些工具、配策略闸；
 * - **插件包**（v0.43，`plugin.json` + 目录约定）：磁盘上的能力包，目录即本地市场。
 *   **它和上一栏是两件事**：那一栏是连出去的外部服务，这一栏是别人写好放在磁盘上的包。
 *
 * 三处刻意的设计：
 * 1. **被拦下的技能显示原因**（`flagged`）。静默藏掉会让人以为技能没装上；
 * 2. **凭据只显示"配过哪几个 key"**，不回显值。所以编辑时**不回填**凭据——
 *    回填就会把一把掩码串写回去，把真 key 覆盖掉；
 * 3. **策略默认「需要确认」**。外部工具会以用户的名义执行动作，默认静默执行
 *    是这一层最不该有的默认。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  Check,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings2,
  Sparkles,
  Trash2,
} from 'lucide-react'

import {
  createMCPServer,
  deleteMCPServer,
  getSkill,
  listInstalledSkills,
  listMCPServers,
  listSkills,
  probeMCPServer,
  sourceLabel,
  uninstallSkill,
  updateMCPServer,
  type MCPPolicy,
  type MCPServer,
  type Skill,
} from '@/api/capabilities'
import { useSessionStore } from '@/lib/session'
import { listPlugins } from '@/api/plugins'
// 技能正文复用知识域那一份渲染件：`Markdown` 是"只读长文"的口径（出处徽标、站内双链都要
// 显式传参才出现，这里不传），而且它的规则只认解析器认识的那些标记，源码里的 HTML 进不来。
import { Markdown } from '@/features/knowledge/markdown'

import { SettingGroupPanel } from '../settings/SettingGroupPanel'
import { notifyError, notifySuccess } from '../shared/toast'
import { Badge } from '@/ui/badge'
import { Button } from '@/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/ui/dialog'
import { Input } from '@/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/ui/tabs'
import { Textarea } from '@/ui/textarea'
import {
  ConfirmDialog,
  EmptyState,
  Field,
  FilterChips,
  Modal,
  PageShell,
  OptionSelect,
  SkeletonBlock,
  StatusTag,
  type TagTone,
} from '../shared/composites'
import { PLUGINS_QUERY_KEY, PluginPackPanel, statsOf } from './PluginPackPanel'
import { SkillMarketDialog } from './SkillMarketDialog'
// 上面那个渲染件的样式**跟着一起引**：知识域的路由是懒加载的，`knowledge.css` 只在那几个
// chunk 里加载（实测能力页上没有任何 `.kb-md-*` 规则）——少了它，正文就是裸 HTML
// （段落没有间距、代码块没有底色），那还不如继续显示源文件。
import '@/features/knowledge/knowledge.css'

const SKILLS_QUERY_KEY = ['skills', 'list'] as const
const INSTALLED_QUERY_KEY = ['skills', 'installed'] as const
const SERVERS_QUERY_KEY = ['mcp-servers', 'list'] as const

const CAP_TABS = [
  { value: 'skills' as const, label: '技能' },
  // **用户面前叫「插件」**：MCP 是协议的名字，不是用户的事。
  // 代码、接口与文档里仍是 MCP（那是它真实的东西），只改界面上这两个字。
  { value: 'mcp' as const, label: '插件' },
  // 新的一栏叫「插件包」：上面那个名字已经被 MCP 占了，而两者是不同的东西
  { value: 'packs' as const, label: '插件包' },
]

type CapTab = (typeof CAP_TABS)[number]['value']

/**
 * 分区导航（技能 / 插件 / 插件包）——这一页唯一的导航，当前档必须一眼看得出来。
 *
 * 语义与键盘交给 `@/ui/tabs`（Radix）：`role="tablist"` / `role="tab"`、`aria-selected`、
 * 左右方向键 + roving tabindex 都是它给的。**视觉也交给它**：槽用 `--bg-subtle`、
 * 当前项用 `--bg-surface` 靠底色差表示选中（原语自带的
 * `data-[state=active]:bg-surface` / `data-[state=active]:text-text-primary`）。
 *
 * 这里一度在触发按钮里**再垫一层 `span`** 画当前态：当时 `tokens.css` 的元素重置
 * 还没收进 `@layer base`，那条未分层的 `button { padding: 0; background: none; … }`
 * 压过了 `@layer utilities` 里的全部工具类（未分层 > 分层，与优先级无关），
 * 于是 `px-3` 归零、白底不生效，三个页签渲染成一串纯文本（评审 G1）。
 * 根因修好（`tokens.css` §元素重置已入 `@layer base`）之后那层垫法已删——
 * 现在两档的差别就是**原语自己**画出来的，与任务页/记忆页同一个形状。
 */
function CapabilityTabs({ value, onChange }: { value: CapTab; onChange: (next: CapTab) => void }) {
  return (
    <Tabs value={value} onValueChange={(next) => onChange(next as CapTab)}>
      <TabsList aria-label="能力">
        {CAP_TABS.map((item) => (
          <TabsTrigger key={item.value} value={item.value}>
            {item.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}

const TRANSPORT_OPTIONS = [
  { value: 'stdio', label: 'stdio（起一个本地进程）' },
  { value: 'http', label: 'http（连远端服务）' },
]
const POLICY_OPTIONS = [
  { value: 'ask', label: '需要确认（推荐）' },
  { value: 'allow', label: '允许直接调用' },
  { value: 'deny', label: '拒绝调用' },
]

interface ServerForm {
  name: string
  transport: 'stdio' | 'http'
  target: string
  args: string
  envKeys: string
  headers: string
  policy: MCPPolicy
}

const EMPTY_SERVER_FORM: ServerForm = {
  name: '',
  transport: 'stdio',
  target: '',
  args: '',
  envKeys: '',
  headers: '',
  policy: 'ask',
}

/** `每行一个 KEY=VALUE` → 对象。**只有用户真填了才提交**（空串会清掉已配的 key）。 */
export function parseKeyValues(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const text = line.trim()
    if (!text) continue
    const at = text.indexOf('=')
    if (at <= 0) continue
    out[text.slice(0, at).trim()] = text.slice(at + 1).trim()
  }
  return out
}

export function policyTone(policy: MCPPolicy): TagTone {
  if (policy === 'allow') return 'success'
  if (policy === 'deny') return 'danger'
  return 'warning'
}

export function policyLabel(policy: MCPPolicy): string {
  return { allow: '允许', ask: '需确认', deny: '拒绝' }[policy]
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

/** 滚动容器是不是已经到底了（留 4px 容差：亚像素会把"到底"判成"没到底"）。 */
function scrolledToEnd(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 4
}

export function CapabilitiesPage() {
  const queryClient = useQueryClient()
  const isAdmin = useSessionStore((store) => store.currentUser?.role === 'admin')

  const [tab, setTab] = useState<'skills' | 'mcp' | 'packs'>('skills')
  /** 能力设置弹窗（v0.26）：联网搜索与沙箱执行从「总设置 → 功能」搬到了这里。 */
  const [settingsOpen, setSettingsOpen] = useState(false)

  const [skillQuery, setSkillQuery] = useState('')
  const [skillFilter, setSkillFilter] = useState<'all' | 'builtin' | 'market' | 'user' | 'blocked'>(
    'all',
  )
  const [skillDetail, setSkillDetail] = useState<Awaited<ReturnType<typeof getSkill>> | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  /** 正文下面还有没有没读完的（决定弹窗底部那层渐隐出不出现）。 */
  const [bodyAtEnd, setBodyAtEnd] = useState(true)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const [marketOpen, setMarketOpen] = useState(false)
  const [uninstallTarget, setUninstallTarget] = useState<Skill | null>(null)

  const [serverQuery, setServerQuery] = useState('')
  const [serverFilter, setServerFilter] = useState<'all' | 'enabled' | 'disabled'>('all')
  const [probing, setProbing] = useState('')
  const [expandedTools, setExpandedTools] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<MCPServer | null>(null)
  const [form, setForm] = useState<ServerForm>(EMPTY_SERVER_FORM)
  const [confirmTarget, setConfirmTarget] = useState<MCPServer | null>(null)

  const skillsQuery = useQuery({
    queryKey: SKILLS_QUERY_KEY,
    queryFn: async () => (await listSkills()).items,
  })
  const packsQuery = useQuery({ queryKey: PLUGINS_QUERY_KEY, queryFn: listPlugins })
  /**
   * 读"哪些是市场装的"。
   *
   * 失败**不打扰用户**：这份清单只影响卡片上那行来源与「卸载」入口，
   * 而技能列表本身已经拿到了——为它弹一个错误只会让人以为技能页坏了。
   */
  const installedQuery = useQuery({
    queryKey: INSTALLED_QUERY_KEY,
    queryFn: async () => (await listInstalledSkills()).items,
    retry: false,
  })
  const serversQuery = useQuery({
    queryKey: SERVERS_QUERY_KEY,
    queryFn: async () => (await listMCPServers()).items,
  })

  const skills = skillsQuery.data ?? []
  const installed = installedQuery.data ?? {}
  const servers = serversQuery.data ?? []
  const packStats = statsOf(packsQuery.data)

  /** 这个技能是不是从市场（线上仓库）装的。清单只在管理员看过市场之后才有值。 */
  const isFromMarket = (skill: Skill) =>
    skill.source !== 'builtin' && Boolean(installed[skill.name])

  /**
   * 卡片来源那一行的说法：市场装的写仓库名，其余几种照旧。
   * 技能还可以住在 `~/.agents/skills`——那是跨工具共享的一层（ZCode / Claude Code /
   * Codex 都扫它），说法要写清楚，否则用户在那儿放了一个却在 KYLAB 里认不出来。
   */
  const sourceLabelOf = (skill: Skill): string => {
    if (skill.source === 'builtin') return '随代码发布'
    if (skill.source === 'agents') return '跨工具共享（~/.agents/skills）'
    const origin = installed[skill.name]
    return origin ? `来自 ${sourceLabel(origin)}` : '手动放入'
  }

  /** 搜索只看**名字与描述**——技能正文不进列表（它有几百行，搜它是另一件事）。 */
  const visibleSkills = skills.filter((item) => {
    if (skillFilter === 'builtin' && item.source !== 'builtin') return false
    if (skillFilter === 'market' && (item.source === 'builtin' || !isFromMarket(item))) return false
    if (skillFilter === 'user' && (item.source === 'builtin' || isFromMarket(item))) return false
    if (skillFilter === 'blocked' && item.used_by_prompt) return false
    const word = skillQuery.trim().toLowerCase()
    if (!word) return true
    return `${item.name} ${item.description}`.toLowerCase().includes(word)
  })

  const skillFilters = useMemo(
    () => [
      { key: 'all' as const, label: '全部', count: skills.length },
      {
        key: 'builtin' as const,
        label: '随代码发布',
        count: skills.filter((item) => item.source === 'builtin').length,
      },
      {
        key: 'market' as const,
        label: '从市场装',
        count: skills.filter((item) => item.source !== 'builtin' && isFromMarket(item)).length,
      },
      {
        key: 'user' as const,
        label: '手动放入',
        count: skills.filter((item) => item.source !== 'builtin' && !isFromMarket(item)).length,
      },
      {
        key: 'blocked' as const,
        label: '未进提示词',
        count: skills.filter((item) => !item.used_by_prompt).length,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [skills, installed],
  )

  const visibleServers = servers.filter((item) => {
    if (serverFilter === 'enabled' && !item.enabled) return false
    if (serverFilter === 'disabled' && item.enabled) return false
    const word = serverQuery.trim().toLowerCase()
    if (!word) return true
    return `${item.name} ${item.target}`.toLowerCase().includes(word)
  })

  const serverFilters = [
    { key: 'all' as const, label: '全部', count: servers.length },
    { key: 'enabled' as const, label: '已启用', count: servers.filter((i) => i.enabled).length },
    { key: 'disabled' as const, label: '已停用', count: servers.filter((i) => !i.enabled).length },
  ]

  const usableSkills = skills.filter((item) => item.used_by_prompt).length

  const reloadSkills = async () => {
    await queryClient.invalidateQueries({ queryKey: SKILLS_QUERY_KEY })
    await queryClient.invalidateQueries({ queryKey: INSTALLED_QUERY_KEY })
  }

  const openSkill = async (skill: Skill): Promise<void> => {
    setDetailLoading(true)
    setSkillDetail(null)
    try {
      setSkillDetail(await getSkill(skill.name))
    } catch (error) {
      notifyError(messageOf(error, '技能读取失败'))
    } finally {
      setDetailLoading(false)
    }
  }

  /**
   * 正文是**异步取回来**的（也可能换了一条），所以每换一次内容就重新量一次滚动位置：
   * 底部那层渐隐只在"下面还有正文"时出现（它是滚动提示，不是一句说明文字）。
   */
  useEffect(() => {
    const element = bodyRef.current
    if (!element) return
    setBodyAtEnd(scrolledToEnd(element))
  }, [skillDetail])

  const uninstall = useMutation({
    mutationFn: (skill: Skill) => uninstallSkill(skill.name),
    onSuccess: async (_result, skill) => {
      setSkillDetail(null)
      setUninstallTarget(null)
      await reloadSkills()
      notifySuccess(`已卸载「${skill.name}」`)
    },
    onError: (error: unknown) => notifyError(messageOf(error, '卸载失败')),
  })

  const probe = useMutation({
    mutationFn: (server: MCPServer) => probeMCPServer(server.id),
    onMutate: (server) => setProbing(server.id),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: SERVERS_QUERY_KEY })
      // 连不上不是错误，是这一次探活的结果：把后端那句话原样显示出来，
      // 它区分了"命令不存在 / 握手被拒 / 超时"，而那正是用户想知道的
      if (result.reachable) notifySuccess(result.detail || '连接正常')
      else notifyError(result.detail || '连不上')
    },
    onError: (error: unknown) => notifyError(messageOf(error, '探活失败')),
    onSettled: () => setProbing(''),
  })

  const saveServer = useMutation({
    mutationFn: async () => {
      const env = parseKeyValues(form.envKeys)
      const headers = parseKeyValues(form.headers)
      if (editing) {
        return updateMCPServer(editing.id, {
          name: form.name,
          target: form.target,
          policy: form.policy,
          args: form.args.split(/\s+/).filter(Boolean),
          // 只有用户真填了凭据才提交——空字符串会让后端把已配的 key 清掉
          ...(Object.keys(env).length > 0 ? { env } : {}),
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
        })
      }
      return createMCPServer({
        name: form.name,
        transport: form.transport,
        target: form.target,
        args: form.args.split(/\s+/).filter(Boolean),
        env,
        headers,
        policy: form.policy,
      })
    },
    onSuccess: async () => {
      notifySuccess(editing ? '已保存' : '已登记')
      setFormOpen(false)
      await queryClient.invalidateQueries({ queryKey: SERVERS_QUERY_KEY })
    },
    onError: (error: unknown) => notifyError(messageOf(error, '保存失败')),
  })

  const removeServer = useMutation({
    mutationFn: (server: MCPServer) => deleteMCPServer(server.id),
    onSuccess: async () => {
      setConfirmTarget(null)
      await queryClient.invalidateQueries({ queryKey: SERVERS_QUERY_KEY })
      notifySuccess('已删除')
    },
    onError: (error: unknown) => notifyError(messageOf(error, '删除失败')),
  })

  const startCreate = () => {
    setEditing(null)
    setForm(EMPTY_SERVER_FORM)
    setFormOpen(true)
  }

  const startEdit = (server: MCPServer) => {
    setEditing(server)
    // **凭据不回填**：接口只回键名，回填会把掩码串写成真值（见文件头第 2 条）。
    // 这里把"已配过哪些 key"显示成占位提示，用户不动它就不改。
    setForm({
      name: server.name,
      transport: server.transport,
      target: server.target,
      args: server.args.join(' '),
      envKeys: '',
      headers: '',
      policy: server.policy,
    })
    setFormOpen(true)
  }

  return (
    <PageShell
      title=""
      actions={
        <>
          <StatusTag
            label={`技能 ${usableSkills}/${skills.length} 可用`}
            tone={skills.length > 0 && usableSkills === 0 ? 'warning' : 'neutral'}
          />
          <StatusTag label={`插件 ${servers.length} 个`} tone="neutral" />
          <StatusTag
            label={`插件包 ${packStats.enabled}/${packStats.total}`}
            tone={packStats.failed > 0 ? 'warning' : 'neutral'}
          />
          {/* 联网搜索与执行策略在这后面。**只给管理员**：后端 `/settings` 是管理员端点 */}
          {isAdmin && (
            <Button onClick={() => setSettingsOpen(true)}>
              <Settings2 size={15} />
              设置
            </Button>
          )}
        </>
      }
    >
      <CapabilityTabs value={tab} onChange={setTab} />
      {tab === 'skills' && (
        <section className="page-shell-body" role="tabpanel" aria-label="技能">
          <header className="m-toolbar">
            <label className="m-toolbar-search">
              <Search size={15} />
              <input
                type="search"
                value={skillQuery}
                placeholder="搜索技能"
                aria-label="搜索技能"
                onChange={(event) => setSkillQuery(event.target.value)}
              />
            </label>
            <div className="m-market-actions">
              {/* 「逛市场」放在动作组最前（它是这一页最主要的"添置东西"的入口），
                  而「重新扫描」留在最后：那是本地目录变了之后的补救动作。
                  **只给管理员**：安装是往提示词里加东西，后端也要求管理员 */}
              {isAdmin && (
                <Button size="sm" onClick={() => setMarketOpen(true)}>
                  <Plus size={14} />
                  浏览市场
                </Button>
              )}
              <Button size="sm" onClick={() => void reloadSkills()}>
                <RefreshCw size={14} />
                重新扫描
              </Button>
            </div>
          </header>

          <FilterChips
            items={skillFilters}
            value={skillFilter}
            onChange={setSkillFilter}
            ariaLabel="技能筛选"
          />

          {skillsQuery.isLoading && <SkeletonBlock variant="list" rows={3} />}

          {!skillsQuery.isLoading && visibleSkills.length === 0 && (
            /*
              空态说的是"接下来点哪儿"，不是"SKILL.md 该放哪个目录"（第四批评审 B②）。
              原先那句整句是写给开发者的：`SKILL.md`、仓库的 `skills/`、数据目录、
              `~/.agents/skills`——使用者读完不知道点哪里，而屏幕上真正能走的那条路
              （右上「浏览市场」）一个字都没提。落盘的目录规则仍归后端与文档，
              这一行只指**屏幕上已经有的**入口（与笔记页"点右上角的 + 写第一条"同一形态）。
            */
            <EmptyState
              title={skills.length > 0 ? '没有匹配的技能' : '还没有技能'}
              hint={
                skills.length > 0
                  ? '换个关键词，或者把筛选切回「全部」。'
                  : isAdmin
                    ? '点右上角的「浏览市场」装一个；本地已经有技能目录的话，点「重新扫描」。'
                    : '点右上角的「重新扫描」，把本地的技能目录读进来。'
              }
            />
          )}

          {/* 技能卡是**紧凑网格**（评审 G2）：一列 130px 大卡时，900px 的屏只能看到 5 张，
              而每张卡上那三行英文原文读不完就被截断——密度低、重点也看不出来。
              现在每张卡只回答"叫什么、干什么、能不能用"，其余进详情弹窗（点名字打开）。

              形状取自**共享原语**，不是另抄一套：容器是 `.m-cards`（列间距本来就在它身上）、
              卡片是 `.m-card`（底色 / 描边 / 圆角 / 首行对齐都归它）、图标是 `.m-card-icon`
              （它自带的 `align-items: center` 与那 2px 顶部微调就是"图标对齐首行"这件事的答案）。
              只有**紧凑密度**那两个取值写在调用点（圆角 16 → 12、内边距 12/16 → 10/12）——
              这四条工具类能盖过 `.m-card`，靠的是 `misc.css` 收进了 `@layer components`
              （分层之后工具类赢在层序，不在优先级）。

              此前这套是手写副本：当时 `.m-cards { display: flex }` 还没进层，会静默吃掉
              同元素上的 `grid`（见 `misc.css` 文件头），于是连图标对齐都只能自己用一个
              加 `padding-top` 的 span 顶着。 */}
          {visibleSkills.length > 0 && (
            <ul className="m-cards grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
              {visibleSkills.map((skill) => (
                <li
                  key={skill.name}
                  className="m-card gap-[var(--space-2-5)] rounded-[var(--radius-row)] px-[var(--space-3)] py-[var(--space-2-5)]"
                >
                  {/* 图标是装饰：`aria-hidden` 不是原语给的，跟着换类一起留着 */}
                  <span className="m-card-icon" aria-hidden="true">
                    <Sparkles size={16} />
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-[var(--space-0-5)]">
                    <div className="flex min-w-0 items-center gap-[var(--space-2)]">
                      {/* 名字（技能标识，通常是目录名）是卡上唯一可点的东西：整张卡不做成
                          按钮，否则「复制名字」「选中摘要」这些基本操作都会变得别扭 */}
                      <button
                        type="button"
                        className="min-w-0 flex-1 truncate text-left text-[length:var(--text-meta-size)] font-medium text-text-primary hover:text-accent"
                        onClick={() => void openSkill(skill)}
                      >
                        {skill.name}
                      </button>
                      {/*
                        「被丢弃」与「被拦下」是两件事：前者是 frontmatter 不合规
                        （缺 name/description、描述超长），整个技能不加载；
                        后者是能用但这一轮不给模型看。标签分开写，理由在下面那行里。
                        能用的也标一下：同一列里"哪些不算数"要一眼扫得出来。
                      */}
                      {skill.discarded ? (
                        <Badge variant="warning">
                          <AlertCircle size={12} />
                          已丢弃
                        </Badge>
                      ) : skill.used_by_prompt ? (
                        <Badge variant="secondary">可用</Badge>
                      ) : (
                        <Badge variant="warning">
                          <AlertCircle size={12} />
                          未进提示词
                        </Badge>
                      )}
                    </div>
                    {/* 中文优先（v0.28）：技能描述基本都是英文，而这一页是给中文用户看的。
                     **一行**，多的部分进详情弹窗——卡片的宽度不该由最长的那条描述决定 */}
                    <p className="truncate text-[length:var(--text-micro-size)] text-text-secondary">
                      {skill.summary || skill.description || '（没有描述）'}
                    </p>
                    {/* 被拦下的技能**要显示理由**：静默藏掉会让人以为技能没装上 */}
                    {skill.flagged.length > 0 && (
                      <p className="flex flex-wrap gap-x-[var(--space-2)] text-[length:var(--text-micro-size)] text-status-warning">
                        {skill.flagged.map((reason, at) => (
                          <span key={at} className="truncate">
                            {reason}
                          </span>
                        ))}
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* 面板自己管数据（它一栏就是一件事），数回传给上面的状态标签 */}
      {tab === 'packs' && (
        <div className="page-shell-body">
          <PluginPackPanel />
        </div>
      )}

      {tab === 'mcp' && (
        <section className="page-shell-body" role="tabpanel" aria-label="插件">
          <header className="m-toolbar">
            <label className="m-toolbar-search">
              <Search size={15} />
              <input
                type="search"
                value={serverQuery}
                placeholder="搜索插件"
                aria-label="搜索插件"
                onChange={(event) => setServerQuery(event.target.value)}
              />
            </label>
            <div className="m-market-actions">
              <Button size="sm" onClick={startCreate}>
                <Plus size={14} />
                新建插件
              </Button>
            </div>
          </header>

          <FilterChips
            items={serverFilters}
            value={serverFilter}
            onChange={setServerFilter}
            ariaLabel="插件筛选"
          />

          {serversQuery.isLoading && <SkeletonBlock variant="list" rows={3} />}

          {/* 空态说"这里现在是什么、点了会发生什么"，**不说工具名怎么拼** */}
          {!serversQuery.isLoading && visibleServers.length === 0 && (
            <EmptyState
              title={servers.length > 0 ? '没有匹配的插件' : '还没有插件'}
              hint={
                servers.length > 0
                  ? '换个关键词，或者把筛选切回「全部」。'
                  : '登记一个 MCP 服务，它的工具就能在对话里被 Agent 直接调用。'
              }
            />
          )}

          {visibleServers.length > 0 && (
            <ul className="m-cards">
              {visibleServers.map((server) => (
                <li key={server.id} className="m-card">
                  <span className="m-card-icon">
                    <Server size={18} />
                  </span>
                  <div className="m-card-body">
                    <span className="m-card-title">{server.name}</span>
                    <p className="m-card-desc">
                      <Badge variant="secondary">{server.transport}</Badge>{' '}
                      <code className="m-card-target">{server.target}</code>
                    </p>
                    <div className="m-card-meta">
                      <StatusTag
                        label={policyLabel(server.policy)}
                        tone={policyTone(server.policy)}
                      />
                      {server.reachable === true ? (
                        <StatusTag label="连接正常" tone="success" />
                      ) : server.reachable === false ? (
                        <StatusTag label="连不上" tone="warning" />
                      ) : null}
                      {server.has_secrets && (
                        <Badge variant="secondary" title="凭据已配置（值不会回显）">
                          <Check size={12} />
                          凭据已配置
                        </Badge>
                      )}
                      {!server.enabled && <Badge variant="secondary">已停用</Badge>}
                      {server.tools.length > 0 && (
                        <Badge asChild variant="secondary">
                          <button
                            type="button"
                            onClick={() =>
                              setExpandedTools(expandedTools === server.id ? '' : server.id)
                            }
                          >
                            {expandedTools === server.id
                              ? '收起工具'
                              : `工具 ${server.tools.length} 个`}
                          </button>
                        </Badge>
                      )}
                    </div>

                    {/* 探活的结论写在卡片里（它是"这个插件现在什么状态"，不是一次操作的结果） */}
                    {server.detail && <p className="m-card-detail">{server.detail}</p>}

                    {expandedTools === server.id && (
                      <ul className="m-tool-list">
                        {server.tools.map((tool) => (
                          <li key={tool.qualified}>
                            <code>{tool.qualified}</code>
                            <span>{tool.description}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  {/* 动作收进「⋯」：卡片本身回答"这是什么"，动作是次要的 */}
                  <div className="m-card-actions">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`${server.name} 的操作`}
                      title={`${server.name} 的操作`}
                      onClick={() => startEdit(server)}
                    >
                      <Pencil size={14} />
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={probing === server.id}
                      onClick={() => probe.mutate(server)}
                    >
                      <RefreshCw size={14} />
                      {probing === server.id ? '连接中…' : '测试连接'}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      aria-label={`删除 ${server.name}`}
                      onClick={() => setConfirmTarget(server)}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* ------------------------------------------------------------ 技能正文 */}
      {/*
        弹窗自己拼（不走 `Modal`）：那个组合件的宽只有 520/620/960 三档，
        而技能正文是**阅读面**——960 与对话页的 66ch 正文纪律相反，每行会拖到 900px 以上
        （评审：右侧空一大块、行太长）。这里按 720px 收，与对话页来源抽屉同一档
        （`sm:max-w-[min(720px,92vw)]`）。三段式与 Esc/遮罩关闭/焦点退还仍由
        `@/ui/dialog`（Radix）给，见 `src/ui/dialog.tsx` 头注释里那段组合示例。
      */}
      <Dialog
        open={skillDetail !== null || detailLoading}
        onOpenChange={(next) => {
          if (!next) setSkillDetail(null)
        }}
      >
        <DialogContent className="flex max-h-[88vh] flex-col gap-0 p-0 sm:max-w-[min(720px,92vw)]">
          <DialogHeader className="flex-row items-center justify-between gap-3 border-b border-[var(--border-hairline)] px-5 py-4 pr-12 text-left">
            <DialogTitle>{skillDetail?.name ?? '读取技能…'}</DialogTitle>
          </DialogHeader>

          <div className="relative flex min-h-0 flex-1 flex-col">
            <div
              ref={bodyRef}
              onScroll={(event) => setBodyAtEnd(scrolledToEnd(event.currentTarget))}
              className="min-h-0 flex-1 overflow-y-auto px-5 py-4"
            >
              {/* 被丢弃的技能也读得出来（后端详情端点放行），但要在这里说清"它为什么不算数" */}
              {skillDetail?.discarded && (
                <ul className="m-flags">
                  {skillDetail.flagged.map((reason, at) => (
                    <li key={at}>{reason}</li>
                  ))}
                </ul>
              )}
              {/* 来源：卡片上已经不摆它了（那是每张卡都重复的同一条噪音，评审 G2），
                  但"从哪儿来的"仍要说得出——它同时决定了能不能在这里卸载 */}
              {skillDetail && (
                <p className="m-detail-meta">
                  <Badge variant={isFromMarket(skillDetail) ? 'default' : 'secondary'}>
                    {sourceLabelOf(skillDetail)}
                  </Badge>
                  {isFromMarket(skillDetail) && (
                    <span className="text-meta">
                      从市场装的，可以在这里卸载（随代码发布的那些卸不掉）
                    </span>
                  )}
                </p>
              )}
              {/* 完整描述（卡片上只有一行，长的进这里）：中文简介优先，
                  它下面是 `description`——那段是模型判断"何时该用"的原文 */}
              {skillDetail && (skillDetail.summary || skillDetail.description) && (
                <p className="mb-[var(--space-3)] text-[length:var(--text-meta-size)] leading-[var(--line-prose)] text-text-secondary">
                  {skillDetail.summary || skillDetail.description}
                </p>
              )}
              {skillDetail?.summary && skillDetail.description && (
                <p className="mb-[var(--space-3)] text-[length:var(--text-micro-size)] leading-[var(--line-prose)] text-text-tertiary">
                  {skillDetail.description}
                </p>
              )}
              {/* 正文按 markdown 渲染（复用知识域的渲染件）：`SKILL.md` 是文档，
                  不是源文件——用户不需要看 `#`、`**` 和反引号 */}
              {skillDetail && <Markdown text={skillDetail.body} />}
            </div>
            {/* 下面还有正文：底部一层渐隐（滚动提示，不是一句说明文字） */}
            {!bodyAtEnd && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-[var(--bg-overlay)] to-transparent"
              />
            )}
          </div>

          <DialogFooter className="flex-row items-center justify-end gap-2 border-t border-[var(--border-hairline)] px-5 py-3">
            {skillDetail && isFromMarket(skillDetail) && (
              <span className="m-footer-left">
                <Button onClick={() => setUninstallTarget(skillDetail)}>
                  <Trash2 size={14} />
                  卸载
                </Button>
              </span>
            )}
            <Button onClick={() => setSkillDetail(null)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ------------------------------------------------------------ 登记表单 */}
      <Modal
        open={formOpen}
        title={editing ? `编辑「${editing.name}」` : '登记插件'}
        onClose={() => setFormOpen(false)}
        size="md"
        footer={
          <>
            <Button onClick={() => setFormOpen(false)}>取消</Button>
            <Button
              disabled={saveServer.isPending || !form.name.trim() || !form.target.trim()}
              onClick={() => saveServer.mutate()}
            >
              {saveServer.isPending ? '保存中…' : '保存'}
            </Button>
          </>
        }
      >
        <p className="text-meta">
          {editing ? (
            <>
              凭据**不会回显**：只显示"已配过哪几个 key"。要改就在下面重填，
              留空表示保持原样（不是清空）。
            </>
          ) : (
            <>stdio 会**起一个本地进程**（填要执行的命令），http 连远端服务（填 URL）。</>
          )}
        </p>

        <Field label="名字" htmlFor="mcp-name">
          <Input
            id="mcp-name"
            value={form.name}
            onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
            placeholder="例如：filesystem"
          />
        </Field>

        {!editing && (
          <Field label="传输方式">
            <OptionSelect
              value={form.transport}
              onValueChange={(value) =>
                setForm((current) => ({ ...current, transport: value as 'stdio' | 'http' }))
              }
              options={TRANSPORT_OPTIONS}
              label="传输方式"
            />
          </Field>
        )}

        <Field
          label={form.transport === 'stdio' ? '命令' : 'URL'}
          htmlFor="mcp-target"
          hint={
            editing && editing.has_secrets
              ? `已配过：${editing.secret_keys.join('、') || '（无键名）'}（留空表示不改动）`
              : undefined
          }
        >
          <Input
            id="mcp-target"
            value={form.target}
            onChange={(event) => setForm((current) => ({ ...current, target: event.target.value }))}
            placeholder={form.transport === 'stdio' ? '例如：npx' : '例如：https://example.com/mcp'}
          />
        </Field>

        {form.transport === 'stdio' ? (
          <>
            <Field label="参数（空格分隔）" htmlFor="mcp-args">
              <Input
                id="mcp-args"
                value={form.args}
                onChange={(event) =>
                  setForm((current) => ({ ...current, args: event.target.value }))
                }
                placeholder="例如：-y @modelcontextprotocol/server-filesystem /data"
              />
            </Field>
            <Field label="环境变量（每行一个 KEY=VALUE）" htmlFor="mcp-env">
              <Textarea
                id="mcp-env"
                rows={2}
                value={form.envKeys}
                onChange={(event) =>
                  setForm((current) => ({ ...current, envKeys: event.target.value }))
                }
                placeholder="TOKEN=..."
              />
            </Field>
          </>
        ) : (
          <Field label="请求头（每行一个 KEY=VALUE）" htmlFor="mcp-headers">
            <Textarea
              id="mcp-headers"
              rows={2}
              value={form.headers}
              onChange={(event) =>
                setForm((current) => ({ ...current, headers: event.target.value }))
              }
              placeholder="Authorization=Bearer ..."
            />
          </Field>
        )}

        <Field label="准入策略">
          <OptionSelect
            value={form.policy}
            onValueChange={(value) =>
              setForm((current) => ({ ...current, policy: value as MCPPolicy }))
            }
            options={POLICY_OPTIONS}
            label="准入策略"
          />
        </Field>
      </Modal>

      <ConfirmDialog
        open={confirmTarget !== null}
        title="删除这个插件？"
        lead={`将删除登记信息「${confirmTarget?.name ?? ''}」。`}
        note="只删登记信息，不会去动那个服务本身，也不会删它的任何数据。"
        confirmLabel="删除"
        busy={removeServer.isPending}
        busyLabel="删除中…"
        onCancel={() => setConfirmTarget(null)}
        onConfirm={() => confirmTarget && removeServer.mutate(confirmTarget)}
      />

      {/* 技能市场：从线上仓库浏览技能并安装。装完要把本地技能列表与"哪些是市场装的"都刷一遍 */}
      <SkillMarketDialog
        open={marketOpen}
        onClose={() => setMarketOpen(false)}
        onInstalled={() => void reloadSkills()}
      />

      <ConfirmDialog
        open={uninstallTarget !== null}
        title="卸载这个技能？"
        lead={`将删掉「${uninstallTarget?.name ?? ''}」的全部文件（它的脚本、参考文档一起）。`}
        note="只删本地这份，不会去动它在 GitHub 上的仓库。要用的时候可以再从市场装回来。"
        confirmLabel="卸载"
        busy={uninstall.isPending}
        busyLabel="卸载中…"
        onCancel={() => setUninstallTarget(null)}
        onConfirm={() => uninstallTarget && uninstall.mutate(uninstallTarget)}
      />

      {/* 能力设置：联网搜索 + 沙箱执行。两组一起给，它们回答的是同一个问题
          （"它能自己去做哪些事、做到什么程度"） */}
      <Modal open={settingsOpen} title="能力设置" onClose={() => setSettingsOpen(false)} size="md">
        <SettingGroupPanel keys={['web', 'sandbox']} />
      </Modal>
    </PageShell>
  )
}
