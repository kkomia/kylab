/**
 * 用户区（侧栏左下）——与旧前端 `SideNav.vue` 里 `.sidebar-foot` / `.account` 那一段逐条对应。
 *
 * ## 只显示"我是谁"，点它向上展开菜单
 *
 * **不提供在系统里切换使用者的入口**：切换身份必须先登出再登录——一个下拉就能换人，
 * 会让"我以为我是谁"和"后端认为我是谁"分叉。
 *
 * 菜单四项（哪一项在，见右列），**每一项都在说一件"这台机器上的事"**：
 *
 * | 菜单项 | 做什么 | 为什么在这里 | 什么时候在 |
 * | --- | --- | --- | --- |
 * | 头像 | 换一张脸（`AvatarDialog`） | 低频、只跟账号有关 | 只在真有账号时 |
 * | 设置 | 打开 `SettingsModal` | 设置里是密钥与模型（用户管理只给管理员），后端对成员一律 403 | 本机档**都有**；服务器档不摆（见下） |
 * | 切换为浅色 / 深色 | 翻到另一边 | 低频，且"这台机器怎么显示"属于设置；这里给一条近路 | 恒在 |
 * | 退出登录 | 退会话 → 清本地 → 回概览 | 不可逆，摊在页脚上误点代价高，所以收进二级菜单 | 只在真有账号时 |
 *
 * ## 本机档（没有账号体系）这一行的口径
 *
 * 桌面壳那一份里 `currentUser` **恒为 null**：本机档的 `/auth/*` 一族根本不挂在
 * `local_router` 上，后端把这一档短路成"本机主人"（`backend/app/api/auth.py::current_caller`）。
 * 所以名字与「设置」**都不能按"有没有登录"来判**——照"没有登录"判的表现是这一行空白、
 * 菜单里也没有「设置」，而设置里正是模型 key 与知识库连接唯一的入口（用户原话：
 * 「现在怎么左下角设置这些都没了？？」）。两处各自的判据：
 *
 * - **名字**：`currentUser?.name ?? (local.present ? LOCAL_CALLER_NAME : '')` —— 兜底只在
 *   **有本机后端**的那一份给（服务器档没有账号体系之外的"主人"，留白才是实话）；
 * - **设置**：`local.present && useIsAdmin()`——管理员判据与另外六处**共用同一条**
 *   （`lib/useIsAdmin`：有账号按角色，本机档按"有没有本机后端"；本机档没有账号体系，
 *   而"本机主人"在后端那条记录里就是管理员（`api_key.py::LOCAL_CALLER`：
 *   `is_admin=True`、`role=UserRole.ADMIN`），设置读的又正是本机那几张表）。
 *   前面那一条 `local.present` 是**这一处自己的**：服务器档整个不摆（那一档
 *   `/settings` 一族不存在，点进去只会 404）。
 *
 * 「头像」「退出登录」照旧**只给真账号**：本机档没有账号可退，也没有头像那一族端点。
 *
 * 页脚**只有这一行**：使用者下拉、独立的「设置」按钮、字体大小入口都已收进设置弹窗；
 * 旧版还把「后端在线」那行探针删掉了（真出问题会有请求报错）。
 *
 * ## 三条与观感有关的旧账（都在旧版逐处调过）
 *
 * 1. **容器本身完全透明**（无填充、无边框、无圆角）：底色只在悬停/展开时出现。
 *    常驻一个填充 + 描边的账号块会让它成为整条栏里最重的一块，
 *    而它承载的信息（我是谁）恰恰最不需要强调；
 * 2. **菜单向上弹**：它挂在页脚底部，向下会出到屏幕外（Radix 的 `side="top"`）；
 * 3. **折叠态下菜单向右飞出**：60px 的栏里放不下 168px 的菜单。Radix 的浮层是
 *    portal 到 body 的，所以这一条不需要额外处理（旧版还得写一条 `left: calc(100% + 4px)`）。
 *
 * 退出登录三件事必须一起做，少一件都会把上一个人的数据留给下一个人：
 * 1. 吊销会话并清本地令牌（`logout`）；
 * 2. **清空本域的会话/工作区清单与名册缓存**——数据留在内存里的话，
 *    换个人登录进来会先看到前一个人的会话；
 * 3. **回概览**（`/`）。原先这一步是"去登录页"，而登录页已删（本机档免登录、
 *    本产品不再有 web 登录这一环，见 `app/App.tsx` 文件头）——退完之后能给的那句
 *    实话就是"本机这份照常，回到落地页"。
 */
import { useState } from 'react'
import {
  RiArrowDownSLine,
  RiLogoutBoxRLine,
  RiMoonLine,
  RiSettings3Line,
  RiSunLine,
  RiUserLine,
} from '@remixicon/react'
import { useNavigate } from 'react-router'

import { AvatarDialog } from '@/features/misc/settings/AvatarDialog'
import { SettingsModal } from '@/features/misc/settings/SettingsModal'
import { setTheme, useThemeMode } from '@/features/misc/settings/useTheme'
import { useLocalBackend } from '@/api/local'
import { cn } from '@/lib/utils'
import { logout } from '@/lib/sessionActions'
import { useSessionStore } from '@/lib/session'
import { useIsAdmin } from '@/lib/useIsAdmin'
import { setOperator, useOperatorStore } from '@/lib/operator'
import { Avatar, AvatarFallback, AvatarImage } from '@/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu'

import { useConversationStore } from './conversations'
import { useWorkspaceStore } from './workspaces'
import { useSidebar } from './useSidebar'

const ICON = 14

/**
 * 本机档唯一调用主体的名字（后端起给它的**就是**这个）。
 *
 * 本机档没有账号体系，`currentUser` 恒为 null（见文件头"本机档"那一节），
 * 而这一行不能因此留白——后端起给本机档那个唯一主体的名字是「本机主人」
 * （`backend/app/services/api_key.py::LOCAL_CALLER`，`UserRecord(name="本机主人")`）。
 * 界面照抄同一个口径，**别在这里另起一个名字**：一句话在两处写法不同，
 * 用户会以为这是两个人。
 */
const LOCAL_CALLER_NAME = '本机主人'

/** 「我是谁」的兜底：没有头像就用名字的第一个字（与旧 `AppAvatar` 同一口径）。 */
function initialOf(name: string): string {
  return name.trim().slice(0, 1) || '·'
}

/**
 * 当前**生效**的主题（`'system'` 档要落到系统实际上是什么）。
 *
 * `useThemeMode()` 是"用户选了哪一档"（设置页那三档选择器用它），而菜单里那句
 * 「切换为浅色 / 深色」问的是"点下去会变成哪一边"——所以这里再落一层。
 */
function useResolvedDark(): boolean {
  const mode = useThemeMode()
  if (mode === 'dark') return true
  if (mode === 'light') return false
  return Boolean(window.matchMedia?.('(prefers-color-scheme: dark)').matches)
}

export function AccountMenu() {
  const navigate = useNavigate()
  const currentUser = useSessionStore((state) => state.currentUser)
  const dark = useResolvedDark()
  /**
   * 侧栏折叠态：这一行在折叠栏里只剩头像，于是**整行居中、gap 归零**。
   *
   * 这两个值原先写在 `layout.css` 的 `.ly-sidebar-collapsed .ly-account-row` 里，
   * 靠"那份文件没有 `@layer`"才压得过这里的 `gap-2`。收层之后**层序与优先级无关**，
   * 层里的声明压不过工具类——所以状态在这里表达（`useSidebar` 是模块级单例，
   * 与侧栏读的是同一份状态，不会出现"栏收了、行没动"）。
   */
  const { collapsed } = useSidebar()
  /** 这一份界面有没有本机后端（决定「设置」那一项在不在，见下面 `settingsAvailable` 那段）。 */
  const local = useLocalBackend()
  /**
   * 这一份界面上"当前这个人是不是管理员"——判据只有一处（`lib/useIsAdmin`）：
   * 有账号按角色，本机档（没有账号体系，`currentUser` 恒为 null）按"有没有本机后端"。
   *
   * **它在下面只用于「设置」那一项**；屏幕上印的「管理员 / 成员」是账号自己的角色
   * （`accountIsAdmin`），与本机档那一条无关——本机档那一行不印角色。
   */
  const isAdmin = useIsAdmin()

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [avatarOpen, setAvatarOpen] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)

  /**
   * 这一行写谁：真账号的名字，本机档则是「本机主人」（见 `LOCAL_CALLER_NAME`）。
   *
   * 服务器档里 `currentUser` 为 null 意味着"身份还没验完"：那不是一种身份，
   * 写个名字只会让人以为登录被吞了——所以**只在本机档兜底**（`local.present`）。
   */
  const identityName = currentUser?.name ?? (local.present ? LOCAL_CALLER_NAME : '')
  /** 这一格是**账号自己的角色**（屏幕上印的「管理员 / 成员」），与本机档那一条无关。 */
  const accountIsAdmin = currentUser?.role === 'admin'
  const identityRole = currentUser ? (accountIsAdmin ? '管理员' : '成员') : ''

  /**
   * 「设置」那一项在不在——**与 `SettingsModal` 的挂载条件是同一个**（见文件头那两段）。
   *
   * 两条理由，别把它们并成一条：
   * - **服务器档不摆**（`local.present` 为假）：设置里那几节读的是本机那几张表
   *   （`/settings`、`/model-registry`、`/local/*`），这一档根本没有它们，点开只会得到
   *   一片"读不到"——摆一个点进去报错的入口比不显示更糟；
   * - **管理员才摆**：成员拿到的一律是 403（`/settings` 是管理员端点）。判据本身在
   *   `lib/useIsAdmin`：本机档没有账号体系（`currentUser` 恒为 null），而那一档
   *   "本机主人"就是这台机器的管理员——按"有没有登录"判，这一项与弹窗会一起消失
   *   （用户原话：「现在怎么左下角设置这些都没了？？」）。
   */
  const settingsAvailable = local.present && isAdmin

  function onToggleTheme(): void {
    // 切到**另一边**：所以文案要说清切过去是哪个
    setTheme(dark ? 'light' : 'dark')
  }

  /**
   * 退出登录。
   *
   * 三件事的顺序与旧版一致：**先退会话，再清本地，最后回概览**。
   * `logout()` 内部已经把"服务端失败也清令牌"兜住了；这里再兜一层是给"状态刷新失败"
   * （`ensureAuthStatus` 那次请求）——本地那几件清理不能因为它被跳过：
   * 少清一份缓存，下一个人登录进来就会先看到上一个人的会话。
   */
  async function onLogout(): Promise<void> {
    setLoggingOut(true)
    try {
      await logout()
    } catch {
      // 忽略：本地清理在下面照做
    } finally {
      useConversationStore.getState().reset()
      useWorkspaceStore.getState().reset()
      useOperatorStore.setState({ roster: [] })
      setOperator('')
      setLoggingOut(false)
    }
    await navigate('/')
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              'ly-account-row flex min-h-11 w-full min-w-0 items-center gap-2 rounded-nav p-2 text-left transition-colors hover:bg-[var(--bg-hover)] data-[state=open]:bg-[var(--bg-hover)]',
              collapsed && 'justify-center gap-0',
            )}
            aria-label={identityName ? `账号：${identityName}` : '账号'}
          >
            {/* 头像是**一个 28px 的圆**（`--avatar-size`），不是一枚线稿图标：
                圆是"这里将来会是你的一张脸"，而灰色小人图标读起来像"一个叫『用户』的入口" */}
            <Avatar className="shrink-0">
              {currentUser?.avatar_url && <AvatarImage src={currentUser.avatar_url} alt="" />}
              <AvatarFallback>{initialOf(identityName)}</AvatarFallback>
            </Avatar>
            {/* 名字、角色、箭头都用 max-width 收（`.ly-collapsible`），
                折叠态收到 0 而不是 `display: none`——后者是瞬时的，没有过渡可接 */}
            {/* 行高**归 20px**（`leading-5` ✓）：Kimi 那份对照表里是 `14px/20px 500` ✓，
                而默认行高在这套 token 下算出 20.58px ✗ —— 差 0.58px，
                但它是"名字基线比左侧导航项低半像素"这类观感的来源 ✓（对照表 §1 ✓） */}
            <span
              className="ly-collapsible flex-1 truncate text-[length:var(--text-meta-size)] leading-5 font-medium text-text-primary"
              title={identityName}
            >
              {identityName}
            </span>
            {identityRole && (
              <span className="ly-collapsible shrink-0 text-[length:var(--text-micro-size)] whitespace-nowrap text-text-tertiary">
                {identityRole}
              </span>
            )}
            {/* 行右端是**一个 44×44 的图标位** ✓（Kimi 对照表：行右端 `44×44` ✓；
                改前只有一枚 14px 的裸箭头 ✗）。视觉上仍是那枚小箭头 ✓，
                但命中区与行高同高（44）✓ —— 点起来不再需要瞄 ✓ */}
            <span className="ly-collapsible flex h-11 w-11 shrink-0 items-center justify-center text-text-tertiary">
              <RiArrowDownSLine size={14} aria-hidden="true" />
            </span>
          </button>
        </DropdownMenuTrigger>
        {/* 向上弹：它挂在页脚底部，向下会出到屏幕外 */}
        <DropdownMenuContent side="top" align="start" className="w-[168px]">
          {/* 「头像」只给真账号 */}
          {currentUser && (
            <DropdownMenuItem onSelect={() => setAvatarOpen(true)}>
              <RiUserLine size={ICON} aria-hidden="true" /> 头像
            </DropdownMenuItem>
          )}
          {/* 「设置」在不在由 `settingsAvailable` 定（见它在组件顶部那段：服务器档不摆，
              本机档没有账号体系也照摆）。**两处的条件必须是同一个值**——入口与弹窗
              一起在、一起不在。 */}
          {settingsAvailable && (
            <DropdownMenuItem onSelect={() => setSettingsOpen(true)}>
              <RiSettings3Line size={ICON} aria-hidden="true" /> 设置
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={onToggleTheme}>
            {dark ? (
              <RiSunLine size={ICON} aria-hidden="true" />
            ) : (
              <RiMoonLine size={ICON} aria-hidden="true" />
            )}
            {dark ? '切换为浅色' : '切换为深色'}
          </DropdownMenuItem>
          {/* 退出登录只在真有账号时给：没有会话就没有可退的东西 */}
          {currentUser && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={loggingOut}
                onSelect={() => void onLogout()}
              >
                <RiLogoutBoxRLine size={ICON} aria-hidden="true" />{' '}
                {loggingOut ? '正在退出…' : '退出登录'}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* 两个浮层由本组件持有开合：菜单一选项就收起（Radix 的默认行为），
          所以不会出现"两层浮层叠在一起"。

          **设置弹窗只在真有那条入口时才挂**（2026-10-05，NAS 网页端退役；2026-10-05
          本机档那一条见文件头）：它读的 `/settings` 那一族**服务器档根本没有**
          （`settings.router` 只挂在本机档那张白名单上，见 `backend/app/api/v1/router.py`），
          而弹窗挂上就等着用户点——挂着一个打不开、点开才发现是 404 的弹窗没有意义。
          （这条条件管"入口在不在"；"关着的时候读不读"是另一件事——`SettingsModal`
          里那四个 `useQuery` 都带 `enabled: open`，关着一条都不读。）
          入口与弹窗同一条件（`settingsAvailable`），两者一起在、一起不在。 */}
      {settingsAvailable && (
        <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      )}
      <AvatarDialog
        open={avatarOpen}
        name={identityName}
        url={currentUser?.avatar_url ?? ''}
        onClose={() => setAvatarOpen(false)}
      />
    </>
  )
}
