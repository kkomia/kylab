/**
 * 用户区（侧栏左下）——与旧前端 `SideNav.vue` 里 `.sidebar-foot` / `.account` 那一段逐条对应。
 *
 * ## 只显示"我是谁"，点它向上展开菜单
 *
 * **不提供在系统里切换使用者的入口**：切换身份必须先登出再登录——一个下拉就能换人，
 * 会让"我以为我是谁"和"后端认为我是谁"分叉。
 *
 * 菜单四项（管理员多一项），**每一项都在说一件"这台机器上的事"**：
 *
 * | 菜单项 | 做什么 | 为什么在这里 |
 * | --- | --- | --- |
 * | 头像 | 换一张脸（`AvatarDialog`） | 低频、只跟账号有关 |
 * | 设置（仅管理员） | 打开 `SettingsModal` | 设置里是密钥与用户管理，后端对成员一律 403 |
 * | 切换为浅色 / 深色 | 翻到另一边 | 低频，且"这台机器怎么显示"属于设置；这里给一条近路 |
 * | 退出登录 | 退会话 → 清本地 → 去登录页 | 不可逆，摊在页脚上误点代价高，所以收进二级菜单 |
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
 * 3. 跳登录页。
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
import { logout } from '@/lib/sessionActions'
import { useSessionStore } from '@/lib/session'
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

const ICON = 14

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

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [avatarOpen, setAvatarOpen] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)

  const identityName = currentUser?.name ?? ''
  // 身份还没验完（`currentUser` 为 null）时留空：那不是一种身份，写个名字只会让人
  // 以为登录被吞了。管理员入口同理——放行会让成员登录后一瞬间看到管理员入口。
  const isAdmin = currentUser?.role === 'admin'
  const identityRole = currentUser ? (isAdmin ? '管理员' : '成员') : ''

  function onToggleTheme(): void {
    // 切到**另一边**：所以文案要说清切过去是哪个
    setTheme(dark ? 'light' : 'dark')
  }

  /**
   * 退出登录。
   *
   * 三件事的顺序与旧版一致：**先退会话，再清本地，最后跳登录页**。
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
    await navigate('/login')
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="ly-account-row flex min-h-11 w-full min-w-0 items-center gap-2 rounded-nav p-2 text-left transition-colors hover:bg-[var(--bg-hover)] data-[state=open]:bg-[var(--bg-hover)]"
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
            <span
              className="ly-collapsible flex-1 truncate text-[length:var(--text-meta-size)] font-medium text-text-primary"
              title={identityName}
            >
              {identityName}
            </span>
            {identityRole && (
              <span className="ly-collapsible shrink-0 text-[length:var(--text-micro-size)] whitespace-nowrap text-text-tertiary">
                {identityRole}
              </span>
            )}
            <RiArrowDownSLine
              className="ly-collapsible shrink-0 text-text-tertiary"
              size={14}
              aria-hidden="true"
            />
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
          {/* 设置只给管理员：后端对成员一律 403，摆一个点进去只会报错的入口比不显示更糟 */}
          {isAdmin && (
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
          所以不会出现"两层浮层叠在一起" */}
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <AvatarDialog
        open={avatarOpen}
        name={identityName}
        url={currentUser?.avatar_url ?? ''}
        onClose={() => setAvatarOpen(false)}
      />
    </>
  )
}
