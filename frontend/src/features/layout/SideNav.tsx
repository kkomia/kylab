/**
 * 导航侧栏（《前端设计规范》§5）——与旧前端 `components/layout/SideNav.vue` 逐条对应。
 *
 * 结构（v0.22，照 Kimi Work 的侧栏条目）：
 *
 * ```
 * 品牌位（环行星标 + 折叠开关）
 * 新建会话（`/chat?new=1`，带快捷键提示）
 * 主导航：笔记 / 记忆 / 能力 / 知识库▸（所有知识库 / 概览 / 任务中心）
 * 项目节：项目行（带条数）+ 各自的项目内会话（超过 5 条先收起）+ 全部项目
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
 * 4. **会话行的「⋯」与节标题右侧的加号都是"悬停才显形、但始终可 Tab 到"**
 *    （规范 §8 禁止"只有 hover 才够得着"的关键操作）。
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
import { Link, useLocation, useNavigate } from 'react-router'
import {
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

/** 会话 / 项目那些行：同高同圆角，只是没有图标位。 */
const SIDE_ROW =
  'ly-side-row box-border flex h-[var(--nav-height)] w-full items-center gap-2 rounded-[var(--radius-nav)] px-1.5 text-left text-[length:var(--text-meta-size)] leading-5 text-text-primary no-underline transition-colors hover:bg-[var(--bg-hover)]'

/** 节标题行上那个动作按钮：默认隐形（`.ly-side-add`），悬停/聚焦才显形。 */
const SIDE_ADD =
  'ly-side-add ml-auto inline-flex size-6 items-center justify-center rounded-control text-text-tertiary transition-colors hover:bg-[var(--bg-hover)] hover:text-text-primary'

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
  { to: '/notes', label: '笔记', icon: RiStickyNoteLine, exact: false, motion: 'rise' },
  { to: '/memory', label: '记忆', icon: RiRobotLine, exact: false, motion: 'tilt' },
  // 能力的图标**不能用齿轮**：齿轮在账号菜单里是「设置」，同一个图标两种含义会让人
  // 以为这一项是设置（旧版踩过：一眼看过去就是"两个设置"）
  { to: '/capabilities', label: '能力', icon: RiServerLine, exact: false, motion: 'spring' },
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
    { to: '/knowledge-bases', label: '所有知识库', icon: RiBook2Line, exact: true },
    // 「概览」= 驾驶舱，住 `/`（与旧前端一致：落地页就是概览，书签不用改）。
    // `/dashboard` 只是同一页的旧入口，在新路由表里是一条重定向。
    { to: '/', label: '概览', icon: RiDashboardLine, exact: true },
    { to: '/tasks', label: '任务中心', icon: RiTaskLine, exact: false },
  ],
} as const

/** 会话行：链接 + 右端的「⋯」。菜单是链接的**兄弟**，不套在链接里。 */
function ConversationRow({
  item,
  sub = false,
  onChanged,
}: {
  item: ConversationSummary
  /** 项目下的会话：缩进一级、字色降一档（层级靠缩进 + 色，不靠加边框）。 */
  sub?: boolean
  onChanged?: () => void
}) {
  const title = item.title || '未命名对话'
  return (
    <div className="ly-side-row-wrap">
      <Link
        to={`/chat/${item.id}`}
        className={sub ? `${SIDE_ROW} pl-6 text-text-secondary` : SIDE_ROW}
        title={title}
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

  const knowledgeActive =
    location.pathname.startsWith('/knowledge-bases') || location.pathname.startsWith('/kb/')

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
            to={item.to}
            // 选中态用**中性 alpha 底**（不是品牌色底，Kimi 的实测值），而且是类名不是内联样式：
            // 内联样式会压过 `:hover`，鼠标划过当前项就没了反馈
            className={
              isActive(item.to, item.exact) ? `${NAV_ROW} bg-[var(--bg-selected)]` : NAV_ROW
            }
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
            className={
              knowledgeActive && !knowledgeOpen
                ? `${NAV_ROW} w-full cursor-pointer border-0 bg-[var(--bg-selected)] text-left`
                : `${NAV_ROW} w-full cursor-pointer border-0 bg-transparent text-left`
            }
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
                        ? 'flex h-[var(--row-height-compact)] items-center gap-1.5 rounded-control bg-[var(--bg-hover)] px-2 text-[length:var(--text-meta-size)] text-text-primary no-underline'
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
                  <button
                    type="button"
                    className={`${SIDE_ROW} cursor-pointer border-0 bg-transparent`}
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
                      {workspace.conversation_count}
                    </span>
                  </button>
                </li>
                {shownConversations(workspace.id).map((item) => (
                  <li key={item.id}>
                    <ConversationRow item={item} sub />
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
                      展开（还有 {hiddenCount(workspace.id)} 条）
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
                <button
                  type="button"
                  className={`${SIDE_ROW} cursor-pointer border-0 bg-transparent text-text-tertiary`}
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
                <ConversationRow item={item} />
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
