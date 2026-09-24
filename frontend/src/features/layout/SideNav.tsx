/**
 * 导航侧栏（《前端设计规范》§5）——与旧前端 `components/layout/SideNav.vue` 逐条对应。
 *
 * 结构（v0.22，照 Kimi Work 的侧栏条目）：
 *
 * ```
 * 品牌位（环行星标 + 折叠开关）
 * 新建会话（`/chat?new=1`，带快捷键提示）
 * 主导航：笔记 / 记忆 / 能力 / 知识库▸（所有知识库 / 概览 / 任务中心）
 * 项目节：项目行（带条数，悬停时右端出现「+」= 在这个项目里新开会话）+ 各自的项目内会话（超过 5 条先收起）+ 全部项目
 * 对话节：没归项目的会话（前 8 条）+ 查看全部会话
 * 页脚：账号（头像 + 名字 → 向上展开的菜单）
 * ```
 *
 * ## 图标：Remix Icon（与旧版同一套）
 *
 * 侧栏 / 用户区 / 导航这一片的图标**一律取 Remix Icon 集合**（`@remixicon/react`），
 * 与旧前端 `components/icons/*.vue` 逐枚对应——那些 Vue 文件的注释里都写着
 * "源：Remix 图标集合 `xxx-line`"，这里用的是**同一个集合、同一份路径数据**
 * （`@remixicon/react` 的 `d` 与旧内联 SVG 逐字节相同）：
 *
 * | 位置 | 图标 | 旧文件 |
 * | --- | --- | --- |
 * | 笔记 | `sticky-note-line` | `IconNote.vue` |
 * | 记忆 | `robot-line` | `IconRobot.vue` |
 * | 能力 | `server-line` | `IconServer.vue` |
 * | 知识库 / 所有知识库 | `book-2-line` | `IconLibrary.vue` |
 * | 概览 | `dashboard-line` | `IconDashboard.vue` |
 * | 任务中心 | `task-line` | `IconTasks.vue` |
 * | 项目 / 移至项目 | `folder-line` | `IconFolder.vue` |
 * | 新建项目 | `folder-add-line` | `IconFolderPlus.vue`（自绘） |
 * | 查看全部会话 | `time-line` | `IconClock.vue` |
 * | 分节箭头 / 组内箭头 | `arrow-down-s-line` / `arrow-right-s-line` | `IconChevronDown/Right.vue` |
 * | 品牌标 | 环行星（自绘） | `IconLogo.vue`（React 版在 `chat/ui/Logo.tsx`） |
 * | 折叠开关 / 新建会话 | 自绘 | `IconSidebar.vue` / `IconChatNew.vue`（见 `./icons.tsx`） |
 *
 * 三枚"自绘"不是随手换的例外：`IconChatNew` 与 `IconSidebar` 的注释都写了来源
 * （开放集里没有"圆角气泡 + 时钟"这个造型；折叠开关是用户给的 iconfont 原稿），
 * 所以它们**照搬旧 SVG** 放在 `./icons.tsx`；品牌标不是 UI 图标（它要能被认出来），同理另放一处。
 * **页面内部的图标不在这里**（表格行、按钮里的那些不在本次范围内，见对照记录 §3）。
 *
 * ## 侧栏的位置留给"入口"，清单留给各自的菜单
 *
 * 旧版前两版把「项目」做成常驻展开的分组、给「对话」配了独立的节结构，结果都做反了：
 * 侧栏于是又变成一份会变长的清单。判据很简单——**侧栏的位置留给入口**。
 *
 * ## 几条照旧的行为（都在旧版逐处调过）
 *
 * 1. **「新对话」在最上面**：它是这一栏里最高频的动作（Kimi Work / ChatGPT 同款位置）。
 *    带上 `?new=1` 才是"新建"，裸 `/chat` 表示"回到最近一次对话"；
 * 2. **知识库是可折叠的子菜单**，里面只列三条固定子项、**不列库名**：
 *    库可能几十个，全铺在侧栏上正是"知识库占的地方太多"的根源；
 * 3. **设置入口只给管理员**，且放在账号的二级菜单里：退出登录低频且不可逆、
 *    主题属于"这台机器怎么显示"，摊在页脚上都不合适；
 * 4. **会话行的「⋯」、项目行的「+」与节标题右侧的加号都是"悬停才显形、但始终可 Tab 到"**
 *    （规范 §8 禁止"只有 hover 才够得着"的关键操作）。三者显形都**不动别人的位置**：
 *    前两个走 `.ly-row-menu`（绝对定位 + 那片宽度常驻预留），最后那个在标题行里；
 * 5. **"我在哪"整栏只有一种样子**：当前会话 / 当前项目 / 当前导航项都加
 *    `--bg-selected` 底（= `Fills-F2`，规范 §7 的取值：中性 alpha 填充，不用品牌色底、
 *    也没有左侧指示条），并各自带上 `aria-current="page"`。会话行静止态是**正文色**
 *    （项目下的那层降一档灰）：会话行是列表项，不是"点了会跳走的链接"。
 *    **当前会话是原先最容易丢的一项**——它挂着「⋯」菜单与预取，却一直没有任何
 *    "就是这条"的标记（界面评审 C13）。
 *
 * ## 全局快捷键（`chat.new` / `layout.toggleSidebar`）
 *
 * 绑定来自设置页那份注册表（`kylab-shortcuts`），**提示与绑定同源**：用户把
 * 「新建会话」改成别的键之后，侧栏那一排小片跟着变。两条规矩：
 *
 * 1. **只处理 `global` 作用域**：输入框里的那些（回车发送）归对话页，
 *    在这里也处理一遍会让一次回车干两件事；
 * 2. **敲字的地方不抢**（`isTypingTarget`）：`Ctrl+K` 在很多编辑器里是删行、
 *    `Cmd+B` 在笔记页是加粗——这条判断在注册表里只定义一处。
 *
 * 切换侧栏走**偏好那一层**（`toggleSidebarPreference`：落 `kylab-sidebar-collapsed`
 * 并广播 `kylab:sidebar-toggle`）。本组件既是那个键的读者、也是那次广播的听众，
 * 于是"按 Ctrl+B"和"点那颗折叠按钮"最终落到同一个状态上。
 */
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useMatch, useNavigate, useSearchParams } from 'react-router'

import { useQueryClient } from '@tanstack/react-query'

import { preloadPage, type PageName } from '@/app/routes'
import { prefetchConversationDetail } from '@/features/chat/runtime/useChatData'
import {
  RiAddLine,
  RiArrowDownSLine,
  RiArrowRightSLine,
  RiBook2Line,
  RiDashboardLine,
  RiFolderAddLine,
  RiFolderLine,
  RiRobotLine,
  RiServerLine,
  RiStickyNoteLine,
  RiTaskLine,
  RiTimeLine,
} from '@remixicon/react'

import { Logo } from '@/features/chat/ui/Logo'
import {
  bindingParts,
  bindingsOf,
  isTypingTarget,
  matchShortcut,
} from '@/features/misc/settings/useShortcuts'
import { toggleSidebarPreference } from '@/features/chat/runtime/shortcutPrefs'
import type { ConversationSummary } from '@/api/conversations'
import { formatCount } from '@/lib/format'
import { cn } from '@/lib/utils'

import { AccountMenu } from './AccountMenu'
import { ConversationRowMenu } from './ConversationRowMenu'
import { IconChatNew, IconSidebar } from './icons'
import { useConversationStore } from './conversations'
import { ensureWorkspacesLoaded, useWorkspaceStore } from './workspaces'
import { useAutoHideScrollbar } from './useAutoHideScrollbar'
import { useSidebar } from './useSidebar'
import './layout.css'

/** 每个项目默认露几条会话（其余的收在「展开」后面）。 */
const PROJECT_PREVIEW = 5
/** 对话那一节默认露几条（一屏放不下的清单会把这一栏变成滚动条）。 */
const CHAT_PREVIEW = 8

/**
 * 导航行：40px 高、圆角 12、图标 18、gap 6（都来自 `tokens.css` 的侧栏那一组）。
 * 静止态就用主文字色——它们是主导航，读起来不该像"次要信息"。
 */
const NAV_ROW =
  'ly-nav-item flex min-h-[var(--nav-height)] items-center gap-1.5 overflow-hidden rounded-[var(--radius-nav)] px-2 text-[length:var(--text-meta-size)] leading-5 text-text-primary no-underline transition-[gap,padding] duration-[var(--motion-slow)] ease-in-out hover:bg-[var(--bg-hover)]'

/**
 * 折叠态的导航行：图标居中。
 *
 * **这两个值必须在调用点表达**（不是"顺手挪的"）：它们原先写在 `layout.css` 的
 * `.ly-sidebar-collapsed .ly-nav-item` 里，那条规则靠"本文件没有 `@layer`"才压得过
 * 上面这两个工具类。收层之后**层序与优先级无关**，层里的声明压不过工具类——
 * 留在 CSS 里就等于从来没生效（图标会偏左、gap 也不归零）。
 *
 * 左右 14px = (44 − 16) ÷ 2：44 是折叠栏（60）减掉 nav 的 `px-2` 两侧，16 是图标盒。
 * 折叠开关的过渡靠 `transition-[gap,padding]`（在 `NAV_ROW` 上），换类名就能平滑滑过去。
 */
const NAV_ROW_COLLAPSED = 'gap-0 px-[14px]'

/** 会话 / 项目那些行：同高同圆角，只是没有图标位。 */
const SIDE_ROW =
  'ly-side-row box-border flex h-[var(--nav-height)] w-full items-center gap-2 rounded-[var(--radius-nav)] px-1.5 text-left text-[length:var(--text-meta-size)] leading-5 text-text-primary no-underline transition-colors hover:bg-[var(--bg-hover)]'

/**
 * 给行右端常驻的「⋯」让出的那一片宽度（= 按钮 24 + 右间距 6 + 4px 呼吸缝）。
 *
 * 原先写在 `layout.css` 的 `.ly-side-row-wrap > .ly-side-row` 里，靠层外身份压过行自己的
 * `px-1.5`；收层后同样压不过，所以在这里按同一份取值写出来（`_` 是 Tailwind 任意值里的空格）。
 */
const SIDE_ROW_MENU_GUTTER = 'pr-[calc(var(--hit-target)_+_var(--space-1-5)_+_var(--space-1))]'

/**
 * 会话 / 项目行的类名。
 *
 * **当前那一行**（正开着的会话、正停着的项目）加 `--bg-selected` 底——与主导航的
 * 当前项同一个取值，于是"侧栏里的当前位置"整栏只有一种样子（规范 §7：当前项用
 * 中性 alpha 填充，不用品牌色底、也没有左侧指示条）。
 * 项目下的会话默认降一档灰（层级靠缩进 + 色，不靠加边框），**当前那条提回正文色**：
 * 选中底要在一眼扫过去时读得出来，降档只该作用在"不是这里"的行上。
 *
 * `menuGutter` 只给"行里挂着「⋯」"的那些（`ConversationRow`）——它对应的正是原来
 * `.ly-side-row-wrap > .ly-side-row` 那条后代规则，别的行（项目名、展开、全部项目）
 * 从来不在 wrap 里，也就从来不吃这片内边距。
 */
function sideRow({
  sub = false,
  current = false,
  menuGutter = false,
}: { sub?: boolean; current?: boolean; menuGutter?: boolean } = {}): string {
  return cn(
    SIDE_ROW,
    sub && 'pl-6',
    menuGutter && SIDE_ROW_MENU_GUTTER,
    current ? 'bg-[var(--bg-selected)]' : sub && 'text-text-secondary',
  )
}

/**
 * 节标题行上那个动作按钮：默认隐形（`.ly-side-add`），悬停/聚焦才显形。
 *
 * **过渡属性写在调用点**：按钮身上的 `transition-colors`（原语那一套）与
 * `layout.css` 里的 `.ly-side-add { transition: opacity ... }` 是同一个属性上的竞争，
 * 收层后工具类赢——所以把原规则里的三个取值（属性/时长/曲线）逐条写在这里，
 * 计算结果与收层前逐字相同（探针核过：`transitionProperty` 仍是 `opacity`）。
 */
const SIDE_ADD =
  'ly-side-add ml-auto inline-flex size-6 items-center justify-center rounded-control text-text-tertiary transition-[opacity] duration-[var(--motion-fast)] ease-[var(--motion-ease)] hover:bg-[var(--bg-hover)] hover:text-text-primary'

/**
 * 项目行右端那颗「在这个项目里新建会话」（+）。
 *
 * 与上面那颗节标题的按钮同一副长相（24px 命中区、悬停才显形但不改变布局），
 * 差别只有两处，都是**行内嵌在列表里**带来的：
 *
 * 1. **去掉 `ly-side-add` 与 `ml-auto`**：显隐由 `.ly-row-menu` 那一套管
 *    （跟着行一起在 hover / focus-within 时淡入，和会话行的「⋯」同一处规则）；
 * 2. **`shrink-0`**：它是绝对定位容器里的实体按钮，别被挤变形。
 *
 * 为什么要它：在已有项目里新开一条会话应当是**行上点一下**的事——原先只有
 * "点进工作区页 → 右栏底部那颗按钮"（两次点击、还要先认路），而侧栏最上面那颗
 * 「新建会话」建出来的是**未归档**对话，事后得自己去「移至项目」找补。
 */
const SIDE_ROW_ADD =
  'inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-control border-0 bg-transparent text-text-tertiary transition-colors hover:bg-[var(--bg-hover)] hover:text-text-primary'

/**
 * 导航项顺序 = 使用频率（《界面信息架构草案》§1）。
 *
 * **「知识库」不在这里**：它是一个可折叠的子菜单（见 `KNOWLEDGE_GROUP`）。
 * **「对话」也不在这里**：它与下面的会话列表、以及最上面的「新对话」是同一件事的三个入口，
 * 并排时用户会犹豫该点哪个——**会话列表本身就是那个入口**（Kimi / ChatGPT / Claude 同款）。
 *
 * `motion` 是这个条目的**悬停动效族**（v0.18）：一项一个动作，取的是"这个图标画的是什么"
 * 该有的动作（便签自下放上 / 记忆歪一头再正过来 / 能力上电弹一下 / 书脊滑进来）。
 */
const NAV_ITEMS = [
  {
    to: '/notes',
    label: '笔记',
    icon: RiStickyNoteLine,
    exact: false,
    motion: 'rise',
    page: 'notes',
  },
  { to: '/memory', label: '记忆', icon: RiRobotLine, exact: false, motion: 'tilt', page: 'memory' },
  // 能力的图标**不能用齿轮**：齿轮在账号菜单里是「设置」，同一个图标两种含义会让人
  // 以为这一项是设置（旧版踩过：一眼看过去就是"两个设置"）
  {
    to: '/capabilities',
    label: '能力',
    icon: RiServerLine,
    exact: false,
    motion: 'spring',
    page: 'capabilities',
  },
] as const

/**
 * 知识库组：**概览与任务中心也收进来**（v0.17）。
 *
 * 子项只有三条、**不再列每个库的名字**（见文件头第 2 条）。
 * 这一项照抄 Kimi 的原样动作（右侧滑入 + 放大落定）：它是这一栏里唯一的分组头，
 * 动作与"把一叠东西从右边推上来"的语义对得上。
 */
const KNOWLEDGE_GROUP = {
  label: '知识库',
  icon: RiBook2Line,
  motion: 'slide',
  children: [
    {
      to: '/knowledge-bases',
      label: '所有知识库',
      icon: RiBook2Line,
      exact: true,
      page: 'knowledgeBases',
    },
    // 「概览」= 驾驶舱，住 `/`（与旧前端一致：落地页就是概览，书签不用改）。
    // `/dashboard` 只是同一页的旧入口，在新路由表里是一条重定向。
    { to: '/', label: '概览', icon: RiDashboardLine, exact: true, page: 'dashboard' },
    { to: '/tasks', label: '任务中心', icon: RiTaskLine, exact: false, page: 'tasks' },
  ],
} as const

/** 会话行：链接 + 右端的「⋯」。菜单是链接的**兄弟**，不套在链接里。 */
function ConversationRow({
  item,
  sub = false,
  current = false,
  onChanged,
}: {
  item: ConversationSummary
  /** 项目下的会话：缩进一级、字色降一档（层级靠缩进 + 色，不靠加边框）。 */
  sub?: boolean
  /** 就是当前打开的那条（`/chat/:id`）：加选中底，并标进语义里。 */
  current?: boolean
  onChanged?: () => void
}) {
  const title = item.title || '未命名对话'
  const queryClient = useQueryClient()
  return (
    <div className="ly-side-row-wrap">
      <Link
        to={`/chat/${item.id}`}
        className={sideRow({ sub, current, menuGutter: true })}
        title={title}
        /* 当前那条会话标在语义上（辅助技术与用例都靠它读） */
        aria-current={current ? 'page' : undefined}
        /* 划过就预取正文（旧 `SideNav.vue` 的悬停预取口径）**并把对话页的代码拉下来**：
           点进去既不必等往返、也不必等 chunk */
        onMouseEnter={() => {
          preloadPage('chat')
          prefetchConversationDetail(queryClient, item.id)
        }}
        onFocus={() => {
          preloadPage('chat')
          prefetchConversationDetail(queryClient, item.id)
        }}
      >
        <span className="min-w-0 flex-1 truncate">{title}</span>
      </Link>
      {/* **菜单不能放进 Link 里**：点菜单会先触发跳转。它是链接的兄弟，
          绝对定位浮在行右端（见 layout.css）。 */}
      <div className="ly-row-menu">
        <ConversationRowMenu item={item} onChanged={onChanged} />
      </div>
    </div>
  )
}

export function SideNav({ onOpenHistory }: { onOpenHistory: () => void }) {
  const location = useLocation()
  const navigate = useNavigate()
  const { collapsed, toggleSidebar } = useSidebar()
  const [searchParams] = useSearchParams()

  /**
   * 当前打开的是哪条会话（`/chat/<id>`；裸 `/chat` 与 `/chat?new=1` 没有 id）。
   *
   * 走 `useMatch` 而不是自己切 pathname：参数由路由解码，也不必再写一份
   * `/chat/` 前缀判断（那份判断迟早会和路由表分叉）。
   */
  const conversationId = useMatch('/chat/:conversationId')?.params.conversationId ?? null
  /**
   * 当前停在哪一页工作区（`/workspaces?focus=<id>`）。
   * 只在工作区那一页上算：`?focus=` 是那一页的定位参数，别的地方带着它不算数。
   */
  const onWorkspaces = location.pathname === '/workspaces'
  const focusedWorkspaceId = onWorkspaces ? searchParams.get('focus') : null

  const conversations = useConversationStore((state) => state.items)
  const loadConversations = useConversationStore((state) => state.load)
  const workspaces = useWorkspaceStore((state) => state.items)
  const workspaceError = useWorkspaceStore((state) => state.error)

  /** 滚动的那一层（项目 + 对话两节）。滚动条按"用时才出现"显示。 */
  const sideScroll = useRef<HTMLDivElement | null>(null)
  // `!collapsed`：折叠时这一层不在 DOM 里，展开那一刻才是它第一次需要监听
  useAutoHideScrollbar(sideScroll, !collapsed)

  // 两节**默认都展开**（照 Kimi Work 的实际形态）。开合状态不落 localStorage：
  // 它是"我现在想不想看"，不是一条长期偏好——存起来的话，用户哪天顺手收起来一次，
  // 之后每次打开都是收着的，而他会以为坏了。
  const [projectsOpen, setProjectsOpen] = useState(true)
  const [chatsOpen, setChatsOpen] = useState(true)
  const [knowledgeOpen, setKnowledgeOpen] = useState(false)
  /** 手动展开了哪几个项目。 */
  const [expandedProjects, setExpandedProjects] = useState<string[]>([])

  useEffect(() => {
    void loadConversations()
    // 项目清单也是首屏就有的数据：它和会话一起决定侧栏下半栏长什么样。
    // 走 `ensureWorkspacesLoaded` 而不是直接 `load`：行菜单的「移至项目」
    // 也要这份清单，两处都不该重复发同一个请求。
    void ensureWorkspacesLoaded()
  }, [loadConversations])

  /**
   * 全局快捷键（P2-1，照 ZCode 的注册表）。
   *
   * 挂在 window 上：它在页面的任何位置都该生效（侧栏只是它的提示位）。
   * **必须在卸载时摘掉**——侧栏在登录页不渲染，残留的监听会在别处误触发（旧版踩过）。
   */
  useEffect(() => {
    const onKeydown = (event: KeyboardEvent): void => {
      if (isTypingTarget(event)) return
      const action = matchShortcut(event, 'global')
      if (!action) return
      event.preventDefault()
      // 让壳这一层的处理**先赢**：对话页此刻还挂着一份临时实现
      // （`chat/runtime/ChatProvider` 里那段"壳还没落地"的监听）。一次按键被两处处理，
      // 结果是"侧栏收起来又立刻打开"——净效果为零。壳落地之后那段由主控摘掉
      // （见最终报告的"需要主控做的事"）。
      event.stopImmediatePropagation()
      if (action === 'chat.new') {
        void navigate('/chat?new=1')
        return
      }
      // 与对话页同一条契约：落 `kylab-sidebar-collapsed` 并广播 `kylab:sidebar-toggle`
      toggleSidebarPreference()
    }
    window.addEventListener('keydown', onKeydown)
    return () => window.removeEventListener('keydown', onKeydown)
  }, [navigate])

  /** 「新建会话」现在绑的是哪几组键（提示与绑定同源）。 */
  const newChatKeys = useMemo(() => bindingParts(bindingsOf('chat.new')[0] ?? ''), [])

  function isActive(to: string, exact: boolean): boolean {
    return exact ? location.pathname === to : location.pathname.startsWith(to)
  }

  /**
   * 「知识库」这一组里的当前项。
   *
   * **按组里那三个子项自己算**（`isActive`），外加库详情 / Wiki（`/kb/:id`，它们不在
   * 侧栏里单列）——手写一条条前缀的那一版漏了 `/` 与 `/tasks`：站在概览或任务中心时
   * 整组一声不响（默认又是收起的），用户看不出自己在哪一节里。
   */
  const knowledgeActive =
    KNOWLEDGE_GROUP.children.some((item) => isActive(item.to, item.exact)) ||
    location.pathname.startsWith('/kb/')

  // 会话只有**一份**平铺清单，分组在这里做（两处各存一份的话，
  // "把某条会话挪进工作区"就得同时改两个地方）
  const byWorkspace = useMemo(() => {
    const groups = new Map<string, ConversationSummary[]>()
    for (const item of conversations) {
      if (!item.workspace_id) continue
      const list = groups.get(item.workspace_id) ?? []
      list.push(item)
      groups.set(item.workspace_id, list)
    }
    return groups
  }, [conversations])

  /**
   * 没归项目的会话（对话那一节铺的就是它们）。
   * **已归档的不在这里**：归档后 store 会把它从这份清单里摘掉，它们只在「已归档」视图里。
   */
  const looseConversations = useMemo(
    () => conversations.filter((item) => !item.workspace_id),
    [conversations],
  )

  function shownConversations(workspaceId: string): ConversationSummary[] {
    const all = byWorkspace.get(workspaceId) ?? []
    return expandedProjects.includes(workspaceId) ? all : all.slice(0, PROJECT_PREVIEW)
  }

  function hiddenCount(workspaceId: string): number {
    return (byWorkspace.get(workspaceId)?.length ?? 0) - shownConversations(workspaceId).length
  }

  return (
    <aside
      className={
        collapsed
          ? 'ly-sidebar ly-sidebar-collapsed flex w-[var(--sidebar-collapsed-width)] flex-[0_0_var(--sidebar-collapsed-width)] flex-col border-r border-[var(--border-hairline)] bg-[var(--bg-canvas)]'
          : 'ly-sidebar flex w-[var(--sidebar-width)] flex-[0_0_var(--sidebar-width)] flex-col overflow-hidden border-r border-[var(--border-hairline)] bg-[var(--bg-canvas)]'
      }
      aria-label="侧栏"
    >
      {/* 品牌位只放那颗**环行星**（v0.31 换的新标）：完整的 "kylab" 字标挪到了对话页的
          空态上——这一格只有 24px 宽的位置，字标在这么小的地方既读不出来、又跟下方的
          导航抢宽度；而行星标本身已经认得出来（旧版的口径：侧栏只留行星标）。
          右侧是折叠开关：折叠后行星标收起，只留那颗面板图标。
          **两者都不用条件渲染摘掉**——摘掉是瞬时的、没法过渡；改用 max-width 收缩
          （`.ly-collapsible`），宽度动画才连得上。 */}
      <div className="relative flex min-h-[var(--sidebar-header-height)] items-center gap-2 pt-[15px] pr-4 pb-[9px] pl-4 text-text-primary">
        <span className="ly-collapsible flex">
          <Logo variant="mark" size={22} />
        </span>
        <button
          type="button"
          className="absolute top-4 right-4 inline-flex size-7 items-center justify-center rounded-control text-text-tertiary transition-colors hover:bg-[var(--bg-hover)] hover:text-text-primary"
          aria-label={collapsed ? '展开侧栏' : '收缩侧栏'}
          aria-expanded={!collapsed}
          title={collapsed ? '展开侧栏' : '收缩侧栏'}
          onClick={toggleSidebar}
        >
          <IconSidebar size={17} />
        </button>
      </div>

      {/* 「新对话」放在**最上面**（导航之上）：它是这一栏里最高频的动作，
          埋在任何东西下面都是浪费。带上 `?new=1` 才是"新建"。 */}
      {!collapsed && (
        <Link
          to="/chat?new=1"
          /* 划过就先把对话页的代码拉下来（它是最可能去的地方），点进去不必等 */
          onMouseEnter={() => preloadPage('chat')}
          onFocus={() => preloadPage('chat')}
          className="ly-nav-item mx-2 mb-2 flex min-h-11 items-center gap-1.5 overflow-hidden rounded-[var(--radius-nav)] border border-[var(--border-hairline)] bg-[var(--bg-group)] px-2 text-[length:var(--text-meta-size)] leading-5 font-medium text-text-primary no-underline transition-colors hover:border-[var(--border-strong)]"
          title={`新建会话（${newChatKeys.join(' + ')}）`}
        >
          <IconChatNew size={18} className="ly-nav-motion-drop shrink-0" />
          <span className="ly-collapsible">新建会话</span>
          {/* 快捷键提示：**显示它就必须真的能用**，所以它与上面那段 window 监听
              是同一条绑定（都读注册表）。两枚独立的小片，不是一个 `Ctrl K` 字符串。 */}
          <span className="ml-auto inline-flex gap-1" aria-hidden="true">
            {newChatKeys.map((part) => (
              <kbd
                key={part}
                className="inline-flex h-5 min-w-5 items-center justify-center rounded-badge bg-[var(--Fills-F2)] px-1 text-[length:var(--text-meta-size)] leading-none text-text-tertiary"
              >
                {part}
              </kbd>
            ))}
          </span>
        </Link>
      )}

      <nav className="flex flex-col px-2 pb-2" aria-label="主导航">
        {NAV_ITEMS.map((item) => (
          <Link
            key={item.to}
            onMouseEnter={() => preloadPage(item.page as PageName)}
            onFocus={() => preloadPage(item.page as PageName)}
            to={item.to}
            // 选中态用**中性 alpha 底**（不是品牌色底，Kimi 的实测值），而且是类名不是内联样式：
            // 内联样式会压过 `:hover`，鼠标划过当前项就没了反馈
            className={cn(
              NAV_ROW,
              collapsed && NAV_ROW_COLLAPSED,
              isActive(item.to, item.exact) && 'bg-[var(--bg-selected)]',
            )}
            // 当前路由标在语义上（旧版只有一个 CSS class）：辅助技术与用例都靠它读
            aria-current={isActive(item.to, item.exact) ? 'page' : undefined}
            title={collapsed ? item.label : undefined}
          >
            <item.icon
              size={18}
              className={`ly-nav-motion-${item.motion} shrink-0`}
              aria-hidden="true"
            />
            <span className="ly-collapsible">{item.label}</span>
          </Link>
        ))}

        {/* 知识库组（v0.17）：三条固定子项，**不列库名**。
            选中态只在收起时亮：展开之后"当前在这一组里"由子项自己说。 */}
        <div className="flex flex-col">
          <button
            type="button"
            className={cn(
              NAV_ROW,
              collapsed && NAV_ROW_COLLAPSED,
              'w-full cursor-pointer border-0 text-left',
              knowledgeActive && !knowledgeOpen ? 'bg-[var(--bg-selected)]' : 'bg-transparent',
            )}
            aria-expanded={knowledgeOpen}
            title={collapsed ? KNOWLEDGE_GROUP.label : undefined}
            onClick={() => setKnowledgeOpen((open) => !open)}
          >
            <KNOWLEDGE_GROUP.icon
              size={18}
              className={`ly-nav-motion-${KNOWLEDGE_GROUP.motion} shrink-0`}
              aria-hidden="true"
            />
            <span className="ly-collapsible">{KNOWLEDGE_GROUP.label}</span>
            {!collapsed && (
              <RiArrowRightSLine
                size={13}
                aria-hidden="true"
                className={
                  knowledgeOpen
                    ? 'shrink-0 rotate-90 text-text-tertiary transition-transform'
                    : 'shrink-0 text-text-tertiary transition-transform'
                }
              />
            )}
          </button>
          {knowledgeOpen && !collapsed && (
            <ul className="mt-0 mb-1 list-none p-0 pl-6">
              {KNOWLEDGE_GROUP.children.map((item) => (
                <li key={item.to}>
                  <Link
                    to={item.to}
                    aria-current={isActive(item.to, item.exact) ? 'page' : undefined}
                    className={
                      isActive(item.to, item.exact)
                        ? 'flex h-[var(--row-height-compact)] items-center gap-1.5 rounded-control bg-[var(--bg-selected)] px-2 text-[length:var(--text-meta-size)] text-text-primary no-underline'
                        : 'flex h-[var(--row-height-compact)] items-center gap-1.5 rounded-control px-2 text-[length:var(--text-meta-size)] text-text-secondary no-underline transition-colors hover:bg-[var(--bg-hover)] hover:text-text-primary'
                    }
                  >
                    <item.icon size={14} aria-hidden="true" />
                    <span className="truncate">{item.label}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </nav>

      {/* 下半栏（v0.22，照 Kimi Work 的实际形态）：**两节，默认都展开**。
          形状来自用户给的截图——标题是「项目 ⌄」（箭头紧跟在文字后面，表示"这一节能收起来"）；
          标题右侧默认什么都不摆，鼠标移上来才出现一个"新建"图标；标题下面直接铺清单。

          这一栏的滚动条**用时才出现**（v0.26，用户报的）：它一直在那儿时，那条灰竖线
          是在回答"你还能往下滚"——而那个问题只在鼠标进到这一栏时才存在。 */}
      {!collapsed && (
        <div ref={sideScroll} className="scroll-quiet flex-1 overflow-y-auto px-2 pb-2">
          {/* ------------------------------------------------------------ 项目 */}
          <div className="ly-side-head mt-3 flex items-center gap-1 pr-1">
            <button
              type="button"
              className="inline-flex h-[var(--nav-section-title-height)] cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-[length:var(--text-meta-size)] leading-5 text-text-tertiary transition-colors hover:text-text-primary"
              aria-expanded={projectsOpen}
              onClick={() => setProjectsOpen((open) => !open)}
            >
              <span>项目</span>
              <RiArrowDownSLine
                size={13}
                aria-hidden="true"
                className={
                  projectsOpen
                    ? 'text-text-tertiary transition-transform'
                    : '-rotate-90 text-text-tertiary transition-transform'
                }
              />
            </button>
            <button
              type="button"
              className={SIDE_ADD}
              title="新建项目"
              aria-label="新建项目"
              onClick={() => void navigate('/workspaces?new=1')}
            >
              <RiFolderAddLine size={15} aria-hidden="true" />
            </button>
          </div>

          {workspaceError && (
            <p className="m-2 text-[length:var(--text-micro-size)] leading-[var(--line-prose)] text-text-tertiary">
              {workspaceError}
            </p>
          )}

          {/* `hidden` 与旧版 `v-show` 同一形态：收起时内容仍在 DOM 里（滚动位置、宽度动画都不跳） */}
          <ul className="m-0 list-none p-0" hidden={!projectsOpen}>
            {workspaces.map((workspace) => (
              <Fragment key={workspace.id}>
                <li>
                  {/* 项目行也是"能停住的一页"（`/workspaces?focus=<id>`）：停在这一页上时
                      它就该像导航项一样亮起来——项目节此前一整片都没有当前项。

                      右端那颗「+」是**在这个项目里新开一条会话**（市面上的"在已有项目内
                      新增对话就是点一下"）：它是行的兄弟、绝对定位浮在右端，所以
                      (a) 点它不会触发上面那次"进项目页"的跳转；(b) 它显形时整行一个字都不动
                      ——那片宽度由 `menuGutter` 常驻预留（与会话行的「⋯」同一套做法）。 */}
                  <div className="ly-side-row-wrap">
                    <button
                      type="button"
                      className={cn(
                        sideRow({
                          current: workspace.id === focusedWorkspaceId,
                          menuGutter: true,
                        }),
                        'cursor-pointer border-0',
                        workspace.id === focusedWorkspaceId ? undefined : 'bg-transparent',
                      )}
                      aria-current={workspace.id === focusedWorkspaceId ? 'page' : undefined}
                      title={workspace.root_path}
                      onClick={() => void navigate(`/workspaces?focus=${workspace.id}`)}
                    >
                      <RiFolderLine
                        size={15}
                        className="shrink-0 text-text-secondary"
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                      <span className="tabular shrink-0 text-[length:var(--text-micro-size)] text-text-tertiary">
                        {formatCount(workspace.conversation_count)}
                      </span>
                    </button>
                    <div className="ly-row-menu">
                      {/* 带 `?workspace=` 才是"在这个项目里新建"（对话页据此把会话挂上去，
                          并在第一句话落下之前就把落点说出来）。 */}
                      <button
                        type="button"
                        className={SIDE_ROW_ADD}
                        aria-label={`在项目「${workspace.name}」里新建会话`}
                        title="在这个项目里新建会话"
                        onMouseEnter={() => preloadPage('chat')}
                        onFocus={() => preloadPage('chat')}
                        onClick={() =>
                          void navigate(`/chat?new=1&workspace=${encodeURIComponent(workspace.id)}`)
                        }
                      >
                        <RiAddLine size={15} aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                </li>
                {shownConversations(workspace.id).map((item) => (
                  <li key={item.id}>
                    <ConversationRow item={item} sub current={item.id === conversationId} />
                  </li>
                ))}
                {/* 超出上限就先收起，点「展开」再看——一屏放不下的清单会把下面那一节推走 */}
                {hiddenCount(workspace.id) > 0 && (
                  <li>
                    <button
                      type="button"
                      className={`${SIDE_ROW} cursor-pointer border-0 bg-transparent pl-6 text-text-tertiary`}
                      onClick={() =>
                        setExpandedProjects((current) =>
                          current.includes(workspace.id) ? current : [...current, workspace.id],
                        )
                      }
                    >
                      展开（还有 {formatCount(hiddenCount(workspace.id))} 条）
                    </button>
                  </li>
                )}
              </Fragment>
            ))}
            {workspaces.length === 0 ? (
              <li className="px-1.5 py-2 text-[length:var(--text-meta-size)] leading-5 text-text-tertiary">
                还没有项目
              </li>
            ) : (
              <li>
                {/* 「全部项目」是这一节的收尾入口（`/workspaces` 本身）：停在那一页上就亮它，
                    带着 `?focus=` 时亮的是上面那个具体的项目行——两处互斥，不会同时亮。 */}
                <button
                  type="button"
                  className={
                    onWorkspaces && !focusedWorkspaceId
                      ? `${SIDE_ROW} cursor-pointer border-0 bg-[var(--bg-selected)]`
                      : `${SIDE_ROW} cursor-pointer border-0 bg-transparent text-text-tertiary`
                  }
                  aria-current={onWorkspaces && !focusedWorkspaceId ? 'page' : undefined}
                  onClick={() => void navigate('/workspaces')}
                >
                  全部项目
                </button>
              </li>
            )}
          </ul>

          {/* ------------------------------------------------------------ 对话 */}
          <div className="ly-side-head mt-3 flex items-center gap-1 pr-1">
            <button
              type="button"
              className="inline-flex h-[var(--nav-section-title-height)] cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-[length:var(--text-meta-size)] leading-5 text-text-tertiary transition-colors hover:text-text-primary"
              aria-expanded={chatsOpen}
              onClick={() => setChatsOpen((open) => !open)}
            >
              <span>对话</span>
              <RiArrowDownSLine
                size={13}
                aria-hidden="true"
                className={
                  chatsOpen
                    ? 'text-text-tertiary transition-transform'
                    : '-rotate-90 text-text-tertiary transition-transform'
                }
              />
            </button>
            {/* 「查看全部会话」（v0.25 换的）：原先这一格是一个"新建会话"的加号，
                与最上面那颗**是同一件事**——同一栏里两个入口做同一件事，多出来的那个
                只会让人犹豫点哪个。换成"找一条旧会话"（面板里有搜索 + 全部 + 已归档）。 */}
            <button
              type="button"
              className={SIDE_ADD}
              title="查看全部会话"
              aria-label="查看全部会话"
              onClick={onOpenHistory}
            >
              <RiTimeLine size={15} aria-hidden="true" />
            </button>
          </div>

          <ul className="m-0 list-none p-0" hidden={!chatsOpen}>
            {looseConversations.slice(0, CHAT_PREVIEW).map((item) => (
              <li key={item.id}>
                <ConversationRow item={item} current={item.id === conversationId} />
              </li>
            ))}
            {looseConversations.length === 0 && (
              <li className="px-1.5 py-2 text-[length:var(--text-meta-size)] leading-5 text-text-tertiary">
                还没有对话
              </li>
            )}
          </ul>
        </div>
      )}

      {/* 页脚：**没有上分隔线**（v0.24 去掉的），内边距 8px——
          侧栏里一条分割线都没有，区块之间靠留白分块。 */}
      <div className="ly-sidebar-foot mt-auto p-2">
        <AccountMenu />
      </div>
    </aside>
  )
}
