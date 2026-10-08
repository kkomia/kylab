/**
 * 用户区（侧栏左下）——与旧前端 `SideNav.vue` 里 `.sidebar-foot` / `.account` 那一段逐条对应。
 *
 * ## 只显示"我是谁"，点它向上展开菜单
 *
 * **不提供在系统里切换使用者的入口**：切换身份必须先登出再登录——一个下拉就能换人，
 * 会让"我以为我是谁"和"后端认为我是谁"分叉。
 *
 * 菜单两项（哪一项在，见右列），**每一项都在说一件"这台机器上的事"**：
 *
 * | 菜单项 | 做什么 | 为什么在这里 | 什么时候在 |
 * | --- | --- | --- | --- |
 * | 设置 | 打开 `SettingsModal` | 设置里是密钥与模型 | 本机档**都有**；服务器档不摆（见下） |
 * | 切换为浅色 / 深色 | 翻到另一边 | 低频，且"这台机器怎么显示"属于设置；这里给一条近路 | 恒在 |
 *
 * 2026-10-09：原先还有「头像」与「退出登录」两项，都删了——它们打的 `/auth/*` 一族
 * （上传头像、吊销会话）随账号死面整族下线（本机档后端 `local_router` 上没有
 * `auth.router`，登录页更早一步就删了）。**这一行现在只读不写**：
 * 显示"我是谁"，加两个入口（设置 / 主题）。
 *
 * 留下的是那一格头像本身（`Avatar`）：它是"我是谁"的一部分，与"换头像"那个动作无关。
 *
 * ## 本机档（没有账号体系）这一行的口径
 *
 * 这一份界面只有本机档一种形态，而后端把这一档短路成「本机主人」
 * （`backend/app/api/auth.py::current_caller`）。所以名字与「设置」**都不能按
 * "有没有登录"来判**——照"没有登录"判的表现是这一行空白、菜单里也没有「设置」，
 * 而设置里正是模型 key 与知识库连接唯一的入口（用户原话：
 * 「现在怎么左下角设置这些都没了？？」）。两处各自的判据：
 *
 * - **名字**：`local.present ? LOCAL_CALLER_NAME : ''`——留白只给**没有本机后端**的那一档
 *   （那一档没有账号体系之外的"主人"，留白才是实话）；
 * - **设置**：`local.present`——就是 `lib/useIsAdmin` 那条判据（本仓唯一的判据：本机档的
 *   用户就是这台机器的管理员，"本机主人"在后端那条记录里是 `is_admin=True`
 *   （`api_key.py::LOCAL_CALLER`），设置读的又正是本机那几张表）。服务器档整个不摆
 *   （那一档 `/settings` 一族不存在，点进去只会 404）。
 *
 * 「头像」「退出登录」两项 2026-10-09 删掉了（它们打的 `/auth/*` 一族随账号死面
 * 整族下线，见文件头），本机档与服务器档都只剩「设置」与主题翻转两件。
 *
 * 这一天还删掉了那一格里**与账号有关的两样**：头像图片（`currentUser.avatar_url`）与
 * 角色徽章（「管理员 / 成员」）——`currentUser` 随名册 / 操作者链一起从会话状态里删了
 * （见 `lib/session.ts` 的文件头），本机档的身份只有「本机主人」这一个事实，
 * 而它**不是"管理员"这个角色**（角色是账号体系里的东西）。头像那一格留成
 * 名字首字的兜底圆（`AvatarFallback`）。
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
 * ⚠️ 这一行**不再有任何"写"的动作**：原先那个「退出登录」要把三件事一起做
 * （吊销会话 / 清本域的会话清单、项目清单与名册缓存 / 回落地页），2026-10-09 三项
 * 一起去掉了——没有登录会话可退（`api/auth.ts` 那一族删了），本机档也没有
 * "换个人登录"这件事（身份恒为「本机主人」）。留着这一段只为说清"这一行为什么这么简单"。
 */
import { useState } from 'react'
import { RiArrowDownSLine, RiMoonLine, RiSettings3Line, RiSunLine } from '@remixicon/react'

import { SettingsModal } from '@/features/misc/settings/SettingsModal'
import { setTheme, useThemeMode } from '@/features/misc/settings/useTheme'
import { useLocalBackend } from '@/api/local'
import { cn } from '@/lib/utils'
import { useIsAdmin } from '@/lib/useIsAdmin'
import { Avatar, AvatarFallback } from '@/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu'

import { useSidebar } from './useSidebar'

const ICON = 14

/**
 * 本机档唯一调用主体的名字（后端起给它的**就是**这个）。
 *
 * 这一份界面没有账号体系（登录页与 `/auth/*` 一族都删了），后端起给本机档那个唯一主体的
 * 名字是「本机主人」（`backend/app/services/api_key.py::LOCAL_CALLER`，
 * `UserRecord(name="本机主人")`）。界面照抄同一个口径，**别在这里另起一个名字**：
 * 一句话在两处写法不同，用户会以为这是两个人。
 */
const LOCAL_CALLER_NAME = '本机主人'

/** 「我是谁」的兜底：名字的第一个字（与旧 `AppAvatar` 同一口径）。 */
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
  /** 这一份界面有没有本机后端（决定名字与「设置」在不在，见下面那两段）。 */
  const local = useLocalBackend()
  /**
   * 这一份界面上"当前这个人是不是管理员"——判据只有一处（`lib/useIsAdmin`：
   * 本机档的用户就是这台机器的管理员，与另外六处共用同一条）。
   *
   * **它在下面只用于「设置」那一项**（本机档就是管理员，服务器档这一处不摆）。
   */
  const isAdmin = useIsAdmin()

  const [settingsOpen, setSettingsOpen] = useState(false)

  /**
   * 这一行写谁：本机档是「本机主人」（见 `LOCAL_CALLER_NAME`）。
   *
   * **留白只给没有本机后端的那一档**：那一档没有账号体系之外的"主人"，
   * 写个名字只会让人以为身份被吞了（原先这里读的是会话状态里的 `currentUser`，
   * 而那个字段 2026-10-09 随名册 / 操作者链一起删了——它在本机档恒为 null）。
   */
  const identityName = local.present ? LOCAL_CALLER_NAME : ''

  /**
   * 「设置」那一项在不在——**与 `SettingsModal` 的挂载条件是同一个**（见文件头那两段）。
   *
   * 两条理由，别把它们并成一条：
   * - **服务器档不摆**（`local.present` 为假）：设置里那几节读的是本机那几张表
   *   （`/settings`、`/model-registry`、`/local/*`），这一档根本没有它们，点开只会得到
   *   一片"读不到"——摆一个点进去报错的入口比不显示更糟；
   * - **管理员才摆**（`isAdmin`）：本机档的用户就是这台机器的管理员（`lib/useIsAdmin`）——
   *   按"有没有登录"判，这一项与弹窗会一起消失
   *   （用户原话：「现在怎么左下角设置这些都没了？？」）。
   */
  const settingsAvailable = local.present && isAdmin

  function onToggleTheme(): void {
    // 切到**另一边**：所以文案要说清切过去是哪个
    setTheme(dark ? 'light' : 'dark')
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
                圆是"这里将来会是你的一张脸"，而灰色小人图标读起来像"一个叫『用户』的入口"。
                里面那一位是名字首字：本机档的身份只有「本机主人」这一个事实，
                头像图片（`avatar_url`）随账号一族 2026-10-09 删掉了。 */}
            <Avatar className="shrink-0">
              <AvatarFallback>{initialOf(identityName)}</AvatarFallback>
            </Avatar>
            {/* 名字与箭头都用 max-width 收（`.ly-collapsible`），
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
            {/* 角色徽章（「管理员 / 成员」）2026-10-09 删掉了：那是**账号体系里的角色**，
                而这一档的身份只有「本机主人」——它不是"管理员"这个角色。 */}
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
        </DropdownMenuContent>
      </DropdownMenu>

      {/* 设置弹窗由本组件持有开合：菜单一选项就收起（Radix 的默认行为），
          所以不会出现"两层浮层叠在一起"。

          **设置弹窗只在真有那条入口时才挂**（2026-10-05，NAS 网页端退役；2026-10-05
          本机档那一条见文件头）：它读的 `/settings` 那一族**服务器档根本没有**
          （`settings.router` 只挂在本机档那张白名单上，见 `backend/app/api/v1/router.py`），
          而弹窗挂上就等着用户点——挂着一个打不开、点开才发现是 404 的弹窗没有意义。
          （这条条件管"入口在不在"；"关着的时候读不读"是另一件事——`SettingsModal`
          里那四条 `useQuery` 都带 `enabled: open`，关着一条都不读。）
          入口与弹窗同一条件（`settingsAvailable`），两者一起在、一起不在。 */}
      {settingsAvailable && (
        <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      )}
    </>
  )
}
