<script setup lang="ts">
/**
 * 导航侧栏（《前端设计规范》§5）。
 *
 * 结构（v0.22，照 Kimi Work 的侧栏条目）：产品名 → 新建会话 → 导航（笔记 / 记忆 /
 * 能力 / 知识库▸）→ **项目 ›** → **对话 ›** → 页脚（账号 / 设置）。
 *
 * Kimi Work 的官方口径（帮助中心《Kimi Work 产品介绍》）把 Work 模式侧栏列成一张
 * 平铺的条目表：**「新建任务、看板、插件、技能、定时任务、WebBridge、项目、对话」**
 * ——「项目」与「对话」是**两个并列的入口**，与看板/插件同级，**侧栏里不铺任何清单**。
 * 点它们各自打开自己的菜单：项目打开项目菜单（项目列表 + 新建项目），
 * 对话打开会话搜索菜单（搜索 + 全部 / 已归档）。
 *
 * 前两版我做反了两处，记在这里以免再来一次：
 *  1. 把「项目」做成一个**常驻展开的分组**（带项目行、可展开看会话、旁边还挂一个
 *     「管理」菜单）——侧栏于是又变成一份会变长的清单，而 Kimi 那里它只是一行；
 *  2. 给「对话」配了独立的节结构、条数与搜索标记——它同样只是一行。
 * 判据很简单：**侧栏的位置留给"入口"，清单交给各自的菜单**。
 *
 * 页脚只留"入口"，不留"状态与开关"（第二轮评审批注 1/2/3）：
 * - 退出登录收进账号的二级菜单——它低频且不可逆，摊在页脚上误点代价高；
 * - 主题切换移进「设置 → 外观」——那是"这台机器怎么显示"，属于设置；
 * - 「后端在线」状态行删掉——开发期探针，真出问题会有请求报错，不必常驻。
 *
 * 知识库清单取自 store：侧栏与概览页是同一份数据，
 * 各查一遍就会出现"新建之后这边有、那边没有"这类不同步。
 *
 * 检索没有独立入口：它是"在某个库里查东西"，收在知识库详情页里；
 * 跨库问答则收在「对话」页——那里的问题是"这些库里怎么说"，不是"哪个块最像"。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import ConversationRowMenu from '@/components/layout/ConversationRowMenu.vue'
import IconChatNew from '@/components/icons/IconChatNew.vue'
import IconChevronDown from '@/components/icons/IconChevronDown.vue'
import IconChevronRight from '@/components/icons/IconChevronRight.vue'
import IconClock from '@/components/icons/IconClock.vue'
import IconDashboard from '@/components/icons/IconDashboard.vue'
import IconFolder from '@/components/icons/IconFolder.vue'
import IconFolderPlus from '@/components/icons/IconFolderPlus.vue'
import IconLibrary from '@/components/icons/IconLibrary.vue'
import IconLogo from '@/components/icons/IconLogo.vue'
import IconLogout from '@/components/icons/IconLogout.vue'
import IconNote from '@/components/icons/IconNote.vue'
import IconRobot from '@/components/icons/IconRobot.vue'
import IconServer from '@/components/icons/IconServer.vue'
import IconSettings from '@/components/icons/IconSettings.vue'
import IconSidebar from '@/components/icons/IconSidebar.vue'
import IconSun from '@/components/icons/IconSun.vue'
import IconTasks from '@/components/icons/IconTasks.vue'
import IconUser from '@/components/icons/IconUser.vue'
import SettingsModal from '@/components/settings/SettingsModal.vue'
import { useAutoHideScrollbar } from '@/composables/useAutoHideScrollbar'
import { loadRoster, roster, setOperator } from '@/composables/useOperator'
import { isAdmin, logout as logoutSession } from '@/composables/useSession'
import { currentUser } from '@/composables/useSessionToken'
import { useSidebar } from '@/composables/useSidebar'
import { resolvedTheme, setTheme } from '@/composables/useTheme'
import type { ConversationSummary } from '@/api/conversations'
import { useConversationStore } from '@/stores/conversations'
import { useKnowledgeBaseStore } from '@/stores/knowledgeBases'
import { useModelRegistryStore } from '@/stores/modelRegistry'
import { useWorkspaceStore } from '@/stores/workspaces'
import { useStatsStore } from '@/stores/stats'
import { useTaskStore } from '@/stores/tasks'

const emit = defineEmits<{ (event: 'openHistory'): void }>()

const route = useRoute()
const router = useRouter()
const store = useKnowledgeBaseStore()
const conversations = useConversationStore()
const workspaces = useWorkspaceStore()
const taskStore = useTaskStore()
const statsStore = useStatsStore()
const modelStore = useModelRegistryStore()

/** 折叠为图标栏：纯显示偏好，落 localStorage（见 useSidebar）。 */
const { collapsed, toggleSidebar } = useSidebar()

/** 滚动的那一层（项目 + 对话两节）。滚动条按"用时才出现"显示，见那个 composable。 */
const sideScroll = ref<HTMLElement | null>(null)
useAutoHideScrollbar(sideScroll)

onMounted(async () => {
  // `load()` 一次就带回每个库的文档数（后端 GROUP BY），不再逐库拉文档列表
  if (store.items.length === 0) await store.load()
  void conversations.load()
  void workspaces.load()
  // 名册只用于显示"文档是谁传的"这一列（不再有切换使用者的入口）
  void loadRoster()
  // 启动后空闲时预热任务列表：用户点进任务中心时数据通常已经在手里。
  // 放在 idle 里而不是与上面并发——预热是"顺手多做的准备"，不该和首屏抢带宽。
  scheduleTaskPrefetch()
  // 快捷键挂在 window 上：它在页面的任何位置都该生效（侧栏只是它的提示位）。
  // **必须在卸载时摘掉**：侧栏在登录页不渲染，残留的监听会在别处误触发。
  window.addEventListener('keydown', onShortcut)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onShortcut)
})

/**
 * 预取任务列表。
 *
 * **两个触发点**：启动后空闲（`requestIdleCallback`，不支持时退化成延时）、
 * 以及鼠标悬停/键盘聚焦「任务中心」这个导航项——后者是最准的意图信号，
 * 从"手指移过去"到"点下去"通常有 100ms 以上，够发完一次本地请求。
 */
function scheduleTaskPrefetch(): void {
  const run = (): void => {
    void taskStore.prefetch()
    void statsStore.prefetch()
    // 注册表也预热：对话页的模型名要在首次进页时就解析得出来，否则会闪一下占位文案
    void modelStore.prefetch()
    // 最近一次会话的正文：点「对话」时命中缓存，就不必先空白一下
    void conversations.prefetchLatestDetail()
  }
  // **必须带 timeout**：没有超时的 requestIdleCallback 在页面一直不空闲时会被无限推迟，
  // 预热就永远不会发生——那正好退化成"每次点进去都要等一次往返"。
  const idle = (
    window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
    }
  ).requestIdleCallback
  if (typeof idle === 'function') idle(run, { timeout: 1500 })
  else window.setTimeout(run, 1200)
}

/**
 * 把某个路由的**代码块**先拉下来。
 *
 * 视图是懒加载的：第一次点某个菜单要等 chunk 下载（本地也要一两百毫秒）。
 * 那段时间与"取数据"是两件事，串在一起就成了"点进去要等这么久"。
 * 这里从路由记录里取出懒加载函数直接调一次——模块加载器会缓存结果，
 * 之后路由真正加载时命中的是同一份，既不重复下载，也不必在侧栏里再抄一份 import。
 */
function preloadRoute(path: string): void {
  const loader = router.resolve(path).matched.at(-1)?.components?.default
  if (typeof loader !== 'function') return
  void (loader as () => Promise<unknown>)().catch(() => undefined)
}

/**
 * 悬停/聚焦一个入口时的预热。
 *
 * 这是最准的意图信号：从"手指移过去"到"点下去"通常有百来毫秒，够把要用的东西先取回来——
 * 既包括页面代码块，也包括那一页要显示的数据。
 * 对话页除了注册表，还要预热**会话正文**——它是进页后唯一还要等的东西。
 */
function onNavIntent(to: string): void {
  preloadRoute(to)
  if (to === '/tasks') void taskStore.prefetch()
  if (to === '/') void statsStore.prefetch()
  if (to === '/chat') {
    void modelStore.prefetch()
    void conversations.prefetchLatestDetail()
  }
}

/**
 * 导航项顺序 = 使用频率（《界面信息架构草案》§1）。
 *
 * 「记忆」排在笔记之后、任务中心之前：它与笔记同属"我写下的东西"，
 * 但比笔记低频（记忆主要靠对话自动沉淀，人进来是校对与整理）。
 *
 * **「知识库」不在这里**（v0.15）：它是一个**可折叠的子菜单**（见下面的
 * `KNOWLEDGE_GROUP` 与模板里的那段）。理由：知识库在侧栏占着一个顶级位置，
 * 却没承担该承担的导航——要进某个库还得先进"知识库"页再找。
 * 展开之后每个库一行，**点一次就到**。
 *
 * `motion` 是这个词条的**悬停动效族**（v0.18）。原先五项共用一个关键帧，
 * 用户给的反馈是"太单一了，全部都是闪烁"——同一个动作在一栏里重复五次，
 * 读起来不是"反馈"而是"整列在闪"。所以每项有自己的姿势，取的是**这个图标
 * 画的是什么**该有的动作（气泡落下 / 便签放上 / 歪头正过来 / 通电弹一下 /
 * 书脊滑进来）。关键帧与时长在下方样式里。
 */
/**
 * 工作区与知识库子菜单的开合状态（v0.15）。
 *
 * **默认都收起**：这两个子菜单的意义就是"把空间让给会话"，
 * 默认展开等于没改。会话所在的工作区会自动展开（见 `openWorkspaceIds` 的 watch）。
 */
/*
 * 这里原本还有一个 `hoveredNav`（哪些项被悬停过）+ `enterNav()`，作用是"只给悬停过的项
 * 播离开动画"。v0.18 一并删掉了，因为**离开那段本身被砍了**（理由写在下方样式里：
 * 单元素上照抄 Kimi 的倒放会让图标永远停在收回去的姿态）。没有 leave 动画，
 * 就没有"要不要允许播"这个问题，也不需要为它记状态。
 *
 * 连同它一起删掉的还有一个 `iconEpoch`：那是个自增数字，当 `:key` 挂在「新建会话」的
 * 图标上，指望"换 key 就重建元素、动画于是重播"。**它是侧栏共用的**——悬停「笔记」
 * 也会让它 +1，「新建会话」的图标跟着被重建、动画重播一遍，表现就是用户报的
 * *"移动一个菜单，其他菜单也会跟着动"*。
 * 这个 key 从来不需要：`:hover` 结束后规则不再匹配、动画被摘掉，下次悬停重新挂上
 * 就是一次重播（重播的条件是**动画被摘掉再挂上**，不是元素换了）。
 */

/**
 * `Ctrl/Cmd + K` = 新建会话。
 *
 * 提示写了就要能用：界面上摆一个按不出来的快捷键，比不摆更糟。
 * 只在**非输入态**触发——用户正在输入框里敲字时，Ctrl+K 该归输入框
 * （那是很多编辑器的删行快捷键）。
 */
function onShortcut(event: KeyboardEvent): void {
  if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k') return
  const target = event.target as HTMLElement | null
  if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) {
    return
  }
  event.preventDefault()
  void router.push({ path: '/chat', query: { new: '1' } })
}
const knowledgeOpen = ref(false)

function toggleKnowledge(): void {
  knowledgeOpen.value = !knowledgeOpen.value
}

function isKnowledgeActive(): boolean {
  return route.path.startsWith('/knowledge-bases') || route.path.startsWith('/kb/')
}

// ------------------------------------------------- 下半栏：项目 / 对话（v0.22）

/**
 * 两节**默认都展开**（照 Kimi Work 的实际形态：它进来就是铺开的）。
 *
 * 折叠状态不落 localStorage：它是"我现在想不想看"，不是一条长期偏好——
 * 存起来的话，用户哪天顺手收起来一次，之后每次打开都是收着的，而他会以为坏了。
 */
const projectsOpen = ref(true)
const chatsOpen = ref(true)

/** 每个项目默认露几条会话（其余的收在「展开」后面）。 */
const PROJECT_PREVIEW = 5
/** 对话那一节默认露几条（一屏放不下的清单会把这一栏变成滚动条）。 */
const CHAT_PREVIEW = 8

/** 手动展开了哪几个项目（`:id` → true）。 */
const expandedProjects = ref<string[]>([])

/** 按项目分好组。会话只有**一份**平铺清单，分组在这里做。 */
const conversationsByWorkspace = computed(() => {
  const groups = new Map<string, ConversationSummary[]>()
  for (const item of conversations.items) {
    if (!item.workspace_id) continue
    const list = groups.get(item.workspace_id) ?? []
    list.push(item)
    groups.set(item.workspace_id, list)
  }
  return groups
})

/**
 * 没归项目的会话（对话那一节铺的就是它们）。
 *
 * **已归档的不在这里**：归档后 store 会把它从这份清单里摘掉（`setArchived`），
 * 它们只在「查看全部会话」的「已归档」视图里。
 */
const looseConversations = computed(() => conversations.items.filter((item) => !item.workspace_id))

const shownLoose = computed(() => looseConversations.value.slice(0, CHAT_PREVIEW))

function projectConversations(workspaceId: string): ConversationSummary[] {
  return conversationsByWorkspace.value.get(workspaceId) ?? []
}

function shownConversations(workspaceId: string): ConversationSummary[] {
  const all = projectConversations(workspaceId)
  return expandedProjects.value.includes(workspaceId) ? all : all.slice(0, PROJECT_PREVIEW)
}

function hiddenCount(workspaceId: string): number {
  return projectConversations(workspaceId).length - shownConversations(workspaceId).length
}

function showAll(workspaceId: string): void {
  expandedProjects.value = [...new Set([...expandedProjects.value, workspaceId])]
}

/** 「新建项目」：跳项目页并让它直接把新建表单打开（`?new=1`）。 */
function onNewWorkspace(): void {
  void router.push({ path: '/workspaces', query: { new: '1' } })
}

/** 「全部项目」：项目页（项目卡的完整管理：改名、路径、绑定知识库）。 */
function openProjects(): void {
  void router.push('/workspaces')
}

/** 菜单里点某个项目：进项目页并**选中它**（`?focus=<id>`，见 WorkspacesView）。 */
function openProject(workspaceId: string): void {
  void router.push({ path: '/workspaces', query: { focus: workspaceId } })
}

const NAV_ITEMS = [
  // **没有「对话」这一项**：它与下面的会话列表、以及最上面的「新对话」是同一件事的
  // 三个入口，并排时用户会犹豫该点哪个。Kimi / ChatGPT / Claude 都没有它
  // ——**会话列表本身就是那个入口**。
  { to: '/notes', label: '笔记', icon: IconNote, exact: false, motion: 'rise' },
  { to: '/memory', label: '记忆', icon: IconRobot, exact: false, motion: 'tilt' },
  // 能力的图标**不能用齿轮**：齿轮在账号菜单里是「设置」，同一个图标两种含义
  // 会让人以为这一项是设置（踩过：一眼看过去就是"两个设置"）。
  { to: '/capabilities', label: '能力', icon: IconServer, exact: false, motion: 'spring' },
] as const

/**
 * 知识库组：**概览与任务中心也收进来**（v0.17，用户指定）。
 *
 * 组的子项只有三条，**不再在这里列每个库的名字**：库可能几十个，全铺在侧栏上
 * 正是"知识库占的地方太多"那件事的根源。要看库，点「所有知识库」——
 * 主页面会给出完整那份清单（带排序、搜索、操作），那才是它该待的地方。
 */
const KNOWLEDGE_GROUP = {
  label: '知识库',
  icon: IconLibrary,
  // 这一项照抄 Kimi 的原样动作（右侧滑入 + 放大落定）：它是这一栏里唯一的
  // **分组头**，动作也是"把一叠东西从右边推上来"，与它的语义对得上。
  motion: 'slide',
  children: [
    { to: '/knowledge-bases', label: '所有知识库', icon: IconLibrary, exact: true },
    { to: '/', label: '概览', icon: IconDashboard, exact: true },
    { to: '/tasks', label: '任务中心', icon: IconTasks, exact: false },
  ],
} as const

function isActive(to: string, exact: boolean): boolean {
  return exact ? route.path === to : route.path.startsWith(to)
}

/**
 * 设置入口只给管理员。
 *
 * 设置页里是 embedding / LLM 密钥与用户管理，后端对成员一律 403
 * （`require_admin`）。把一个点进去只会报错的入口摆在侧栏，比不显示更糟。
 *
 * **身份还没验完（`currentUser` 为 null）时按"不是管理员"处理**：v0.11 起
 * 没有第二种凭据，null 只可能是"还在恢复会话"，放行会让成员登录后
 * 一瞬间看到管理员入口。
 */
const canOpenSettings = computed(() => isAdmin.value)

// ---------------------------------------------------------------- 会话管理（v17）

/** 设置从页面收进弹窗：它是动作，做完就走（《界面信息架构草案》§1）。 */
const settingsOpen = ref(false)

/**
 * 设置弹窗的打开入口。
 *
 * **401 不再往这里兜**（v0.11）：唯一的恢复路径是重新登录，由 `App.vue` 监听
 * relogin 信号统一送到登录页。原先那条"打开设置并落到令牌输入框"的兜底
 * 连着已经取消的控制台令牌。
 */
function openSettings(): void {
  settingsOpen.value = true
}

/**
 * 账号二级菜单（第二轮评审批注 1）。
 *
 * 用原生 `<details>`：键盘 Tab/Enter 能展开、Esc 能收起，行为由浏览器保证
 * （与 RowMenu 同一手法）。菜单向上弹出——它就挂在页脚底部，向下会出到屏幕外。
 */
const accountMenu = ref<HTMLDetailsElement | null>(null)

function closeAccountMenu(): void {
  if (accountMenu.value) accountMenu.value.open = false
}

/**
 * 页脚那一行显示的"我是谁"。
 *
 * 只认登录账号。v0.11 起没有"控制台通道"这种无账号身份，
 * 取不到账号就意味着**身份还没验完**（会话正在恢复），此时留空——
 * 那不是一种身份，写个名字只会让人以为登录被吞了。
 */
const identityName = computed(() => currentUser.value?.name ?? '')
const identityRole = computed(() => (currentUser.value ? (isAdmin.value ? '管理员' : '成员') : ''))

/** 主题菜单项：点一下切到**另一边**，所以文案要说清切过去是哪个。 */
const themeActionLabel = computed(() =>
  resolvedTheme.value === 'dark' ? '切换为浅色' : '切换为深色',
)

function onToggleTheme(): void {
  setTheme(resolvedTheme.value === 'dark' ? 'light' : 'dark')
  closeAccountMenu()
}

/** 菜单里的「设置」：关掉菜单再开弹窗，避免两层浮层叠在一起。 */
function onOpenSettings(): void {
  closeAccountMenu()
  openSettings()
}

/**
 * 退出登录。
 *
 * 三件事必须一起做，少一件都会把上一个人的数据留给下一个人：
 * 1. 吊销会话并清本地令牌（`logout`）；
 * 2. **清空两个 store 与名册缓存**——Pinia 的数据留在内存里，不清的话
 *    换个人登录进来会先看到前一个人的知识库与会话（列表非空，侧栏也不会重新加载）；
 * 3. 跳登录页。
 */
const loggingOut = ref(false)

async function onLogout(): Promise<void> {
  loggingOut.value = true
  try {
    await logoutSession()
    store.$reset()
    conversations.$reset()
    roster.value = []
    setOperator('')
    await router.push({ name: 'login' })
  } finally {
    loggingOut.value = false
  }
}
</script>

<template>
  <aside class="sidebar" :class="{ 'sidebar-collapsed': collapsed }">
    <!-- 品牌位只放**那只实验烧瓶**（v0.25，用户指定）：完整的 "KYLAB" 字标挪到
         了对话页的空态上（那里空间够、也没有别的东西跟它抢）。
         侧栏这一格只有 24px 宽的位置，字标在这么小的地方既读不出来、
         又跟下方的导航抢宽度；而烧瓶本身已经认得出来，Kimi 的侧栏也只放一个 K。

         右侧是折叠开关：折叠后烧瓶收起，只留那颗面板图标。
         **两者都不用 v-if 摘掉**——`v-if` 是瞬时的，没法过渡；
         改用 max-width 收缩（见下方样式），宽度动画才连得上。 -->
    <div class="brand">
      <span class="brand-mark"><IconLogo variant="mark" :size="22" /></span>
      <button
        class="collapse-toggle"
        type="button"
        :aria-label="collapsed ? '展开侧栏' : '收缩侧栏'"
        :aria-expanded="!collapsed"
        :title="collapsed ? '展开侧栏' : '收缩侧栏'"
        @click="toggleSidebar"
      >
        <IconSidebar :size="17" />
      </button>
    </div>

    <!--
      「新对话」放在**最上面**（导航之上）：它是这一栏里最高频的动作，
      埋在任何东西下面都是浪费。Kimi Work / ChatGPT 也都是这个位置。

      带上 `?new=1` 才是"新建"；裸 `/chat` 表示"回到最近一次对话"
      （见 ChatView 的 enterChat）——两个入口共用一条链接时，
      从知识库返回也会落在空态上，看起来就像"又给我开了个新对话"。
    -->
    <RouterLink
      v-if="!collapsed"
      class="nav-item new-chat"
      :to="{ path: '/chat', query: { new: '1' } }"
      title="新建会话（Ctrl/Cmd + K）"
    >
      <IconChatNew class="nav-icon nav-motion-drop" />
      <span class="nav-label">新建会话</span>
      <!--
        快捷键提示（Kimi 的 `新建会话  Ctrl K`）。**显示它就必须真的能用**——
        界面上写着一个按不出来的快捷键，比不写更糟。所以下面绑了全局 keydown。

        **两枚独立的小片**，不是一个 `Ctrl K` 字符串：Kimi 的实测是一枚 `Ctrl`
        （30×20）+ 一枚 `K`（20×20），各自有自己的底色和 4px 圆角。
        两枚的间距由容器的 `gap` 给，不靠字符串里的空格。
      -->
      <span class="shortcut" aria-hidden="true">
        <kbd>Ctrl</kbd>
        <kbd>K</kbd>
      </span>
    </RouterLink>

    <nav class="nav" aria-label="主导航">
      <RouterLink
        v-for="item in NAV_ITEMS"
        :key="item.to"
        class="nav-item"
        :class="{ 'nav-item-active': isActive(item.to, item.exact) }"
        :to="item.to"
        :title="collapsed ? item.label : undefined"
        @mouseenter="onNavIntent(item.to)"
        @focus="onNavIntent(item.to)"
      >
        <component :is="item.icon" :class="['nav-icon', `nav-motion-${item.motion}`]" />
        <span class="nav-label">{{ item.label }}</span>
      </RouterLink>

      <!--
        知识库组（v0.17）：三条固定子项，**不列库名**。
        原先这里把每个库铺一行——库一多，侧栏就被它占满了（那正是"知识库占的
        地方太多"的根源）。要看库就点「所有知识库」，主页面给完整清单。
      -->
      <div class="nav-group">
        <button
          type="button"
          class="nav-item nav-item-group"
          :class="{ 'nav-item-active': isKnowledgeActive() && !knowledgeOpen }"
          :aria-expanded="knowledgeOpen"
          :title="collapsed ? KNOWLEDGE_GROUP.label : undefined"
          @click="toggleKnowledge"
        >
          <component
            :is="KNOWLEDGE_GROUP.icon"
            :class="['nav-icon', `nav-motion-${KNOWLEDGE_GROUP.motion}`]"
          />
          <span class="nav-label">{{ KNOWLEDGE_GROUP.label }}</span>
          <IconChevronRight
            v-if="!collapsed"
            class="nav-chevron"
            :class="{ open: knowledgeOpen }"
            :size="13"
          />
        </button>
        <ul v-if="knowledgeOpen && !collapsed" class="nav-sub">
          <li v-for="item in KNOWLEDGE_GROUP.children" :key="item.to">
            <RouterLink
              class="nav-sub-item"
              :class="{ 'nav-sub-item-active': isActive(item.to, item.exact) }"
              :to="item.to"
            >
              <component :is="item.icon" :size="14" />
              <span>{{ item.label }}</span>
            </RouterLink>
          </li>
        </ul>
      </div>
    </nav>

    <!--
      下半栏（v0.22，照 Kimi Work 的实际形态）：**两节，默认都展开**。

      形状来自用户给的 Kimi Work 截图：
      - 节标题是 `项目 ⌄`——**箭头紧跟在文字后面**，它表示"这一节能收起来"，
        不是"点进去"（点进去用的是 `›`，那是另一种意思，两者别混）；
      - 标题右侧**默认什么都不摆**，鼠标移上来才出现一个"新建"图标（项目是
        带加号的文件夹、对话是新建会话）——那是这一节唯一的增补动作；
      - 标题下面直接铺清单（默认展开）：项目那一节是「项目 + 它的会话」，
        对话那一节是没归项目的会话。
    -->
    <!-- 侧栏这一栏的滚动条**用时才出现**（v0.26，用户报的）：它一直在那儿时，
         那条灰竖线是在回答"你还能往下滚"——而那个问题只在鼠标进到这一栏时才存在。
         `scroll-quiet` 给出"默认看不见"的样子，出现与消失的时机见那个 composable。 -->
    <div v-if="!collapsed" ref="sideScroll" class="side-section scroll-quiet">
      <!-- ------------------------------------------------------------ 项目 -->
      <div class="side-head">
        <button
          type="button"
          class="side-toggle"
          :aria-expanded="projectsOpen"
          @click="projectsOpen = !projectsOpen"
        >
          <span class="side-title">项目</span>
          <IconChevronDown class="side-chevron" :class="{ collapsed: !projectsOpen }" :size="13" />
        </button>
        <button
          type="button"
          class="side-add"
          title="新建项目"
          aria-label="新建项目"
          @click="onNewWorkspace"
        >
          <IconFolderPlus :size="15" />
        </button>
      </div>

      <p v-if="workspaces.error" class="side-note">{{ workspaces.error }}</p>

      <ul v-show="projectsOpen" class="side-list">
        <template v-for="workspace in workspaces.items" :key="workspace.id">
          <li>
            <button
              type="button"
              class="side-row side-row-group"
              :title="workspace.root_path"
              @click="openProject(workspace.id)"
            >
              <IconFolder class="side-row-icon" :size="15" />
              <span class="side-row-name">{{ workspace.name }}</span>
              <span class="side-row-count tabular">{{ workspace.conversation_count }}</span>
            </button>
          </li>
          <li v-for="item in shownConversations(workspace.id)" :key="item.id" class="side-sub-row">
            <div class="side-row-wrap">
              <RouterLink
                class="side-row side-row-sub"
                :to="`/chat/${item.id}`"
                :title="item.title || '未命名对话'"
              >
                <span class="side-row-name">{{ item.title || '未命名对话' }}</span>
              </RouterLink>
              <ConversationRowMenu :item="item" />
            </div>
          </li>
          <!-- 超出上限就先收起，点「展开」再看——一屏放不下的清单会把下面那一节推走 -->
          <li v-if="hiddenCount(workspace.id) > 0" :key="`${workspace.id}-more`">
            <button
              type="button"
              class="side-row side-row-sub side-more"
              @click="showAll(workspace.id)"
            >
              展开（还有 {{ hiddenCount(workspace.id) }} 条）
            </button>
          </li>
        </template>
        <li v-if="!workspaces.items.length" class="side-empty">还没有项目</li>
        <li v-else>
          <button type="button" class="side-row side-more" @click="openProjects">全部项目</button>
        </li>
      </ul>

      <!-- ------------------------------------------------------------ 对话 -->
      <div class="side-head">
        <button
          type="button"
          class="side-toggle"
          :aria-expanded="chatsOpen"
          @click="chatsOpen = !chatsOpen"
        >
          <span class="side-title">对话</span>
          <IconChevronDown class="side-chevron" :class="{ collapsed: !chatsOpen }" :size="13" />
        </button>
        <!--
          「查看全部会话」（v0.25 换的，用户指定）：这一格原先是一个"新建会话"的加号，
          与最上面那颗「新建会话」**是同一件事**——同一栏里两个入口做同一件事，
          多出来的那个只会让人犹豫点哪个。而"找一条旧会话"（面板里有搜索 + 全部 +
          已归档）原先埋在清单**最底下**那颗"查看全部会话"文字行里，
          会话一多就要滚到底才看得见。

          两头一换，两个动作各归其位：新建在最上面（最高频、且已经带了快捷键），
          查找在这一节的标题行上（鼠标移上来才出现，与项目那一节同一套手势）。
        -->
        <button
          type="button"
          class="side-add"
          title="查看全部会话"
          aria-label="查看全部会话"
          @click="emit('openHistory')"
        >
          <IconClock :size="15" />
        </button>
      </div>

      <ul v-show="chatsOpen" class="side-list">
        <li v-for="item in shownLoose" :key="item.id">
          <div class="side-row-wrap">
            <RouterLink
              class="side-row"
              :to="`/chat/${item.id}`"
              :title="item.title || '未命名对话'"
            >
              <span class="side-row-name">{{ item.title || '未命名对话' }}</span>
            </RouterLink>
            <ConversationRowMenu :item="item" />
          </div>
        </li>
        <li v-if="!looseConversations.length" class="side-empty">还没有对话</li>
      </ul>
    </div>

    <div class="sidebar-foot">
      <!--
        页脚只显示**当前用户**，点它向上展开菜单（用户批注）。
        **不提供在系统里切换使用者的入口**：切换身份必须先登出再登录——
        一个下拉就能换人，会让"我以为我是谁"和"后端认为我是谁"分叉。
        菜单向上弹：它挂在页脚底部，向下会出到屏幕外（与 RowMenu 同一手法）。
      -->
      <details ref="accountMenu" class="account">
        <summary class="account-row">
          <!--
            **头像是一个 28px 的圆**，不是一枚线稿图标（Kimi 的 `.not-login-icon`
            实测 28×28 圆形）。差别不只是大小：圆是"这里将来会是你的一张脸"，
            而一枚灰色小人图标读起来像"一个叫『用户』的入口"。
          -->
          <span class="account-avatar" aria-hidden="true">
            <IconUser :size="16" />
          </span>
          <span class="account-name" :title="identityName">{{ identityName }}</span>
          <span v-if="identityRole" class="account-role">{{ identityRole }}</span>
          <IconChevronDown class="account-caret" :size="14" />
        </summary>
        <div class="account-pop">
          <button v-if="canOpenSettings" type="button" @click="onOpenSettings">
            <IconSettings :size="14" />
            <span>设置</span>
          </button>
          <button type="button" @click="onToggleTheme">
            <IconSun :size="14" />
            <span>{{ themeActionLabel }}</span>
          </button>
          <!-- 退出登录只在真有账号时给：没有会话就没有可退的东西 -->
          <button
            v-if="currentUser"
            type="button"
            class="account-danger"
            :disabled="loggingOut"
            @click="onLogout"
          >
            <IconLogout :size="14" />
            <span>{{ loggingOut ? '正在退出…' : '退出登录' }}</span>
          </button>
        </div>
      </details>
    </div>

    <SettingsModal v-model:open="settingsOpen" @logout="onLogout" />
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  width: var(--sidebar-width);
  flex: 0 0 var(--sidebar-width);
  background: var(--bg-canvas);
  border-right: 1px solid var(--border-hairline);
  overflow: hidden;
  /* 折叠过渡：宽度与 flex-basis 一起动，内容区平滑让出 / 收回空间。
     时长取 Kimi 的 300ms ease-in-out（它折叠的是 `transform`，我们折叠的是宽度——
     聊天应用必须让内容区真的让出空间，不能只把侧栏推走。时长与缓动对齐，
     手法保留）。 */
  transition:
    width var(--motion-slow) var(--motion-ease-inout),
    flex-basis var(--motion-slow) var(--motion-ease-inout);
}

/* 品牌行：高度 56px（Kimi 的 `.sidebar-header` 实测 15/10/9/16 内边距 + 高 56，
   与页面顶栏的 58 不是同一个数）。折叠开关是绝对定位的（不参与撑高），
   不写 min-height 的话字标一收起行高就塌，下方导航会突然上移。 */
.brand {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--sidebar-header-height);
  padding: 15px var(--space-4) 9px;
  color: var(--text-primary);
}

/* 字标容器：折叠时用 max-width 收成 0，而不是 v-if 摘掉——后者是瞬时的，没法过渡 */
.brand-mark {
  display: flex;
  overflow: hidden;
  max-width: 200px;
  transition:
    max-width var(--motion-slow) var(--motion-ease-inout),
    opacity var(--motion-fast) var(--motion-ease);
}

.sidebar-collapsed .brand-mark {
  max-width: 0;
  opacity: 0;
}

/* 折叠开关：绝对定位在离右缘 `--space-4` 处。
   **这不是随手定位，是为了让过渡不跳**：展开态它在右边距 16px；折叠态 60px 栏里
   "居中"的位置恰好也是右边距 16px（60 − 16 − 28 = 16）。于是宽度动画一动，
   它就顺着右缘平滑滑到正中，不用切换 `justify-content`，也就没有瞬移。 */
.collapse-toggle {
  position: absolute;
  top: var(--space-4);
  right: var(--space-4);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  color: var(--text-tertiary);
  border-radius: var(--radius-control);
}

.collapse-toggle:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

/* ---- 折叠态：图标栏 ---- */

.sidebar-collapsed {
  width: var(--sidebar-collapsed-width);
  flex-basis: var(--sidebar-collapsed-width);
  /* 账号菜单折叠态下向右飞出，不能被侧栏裁掉 */
  overflow: visible;
}

/* 导航项不切 `justify-content`（那是瞬时的）：只把左右内边距改到能让图标居中的
   14px（= (44 − 16) ÷ 2），图标平滑滑到中间，而不是"啪"地跳过去 */
.sidebar-collapsed .nav-item {
  gap: 0;
  padding-right: 14px;
  padding-left: 14px;
}

.sidebar-collapsed .sidebar-foot {
  padding-right: var(--space-2);
  padding-left: var(--space-2);
}

.sidebar-collapsed .account-row {
  justify-content: center;
}

/* 名字 / 角色 / 箭头在 60px 里放不下；用 max-width 收成 0，动画才连得上
   （`display: none` 是瞬时的，没有过渡） */
.sidebar-collapsed .account-name,
.sidebar-collapsed .account-role,
.sidebar-collapsed .account-caret {
  max-width: 0;
  opacity: 0;
}

/* 菜单从侧栏右缘飞出：向上弹出会盖住图标栏本身 */
.sidebar-collapsed .account-pop {
  right: auto;
  bottom: 0;
  left: calc(100% + var(--space-1));
  width: 168px;
}

/* 尊重"减少动态效果"：动画是锦上添花，不该在需要静的人那里坚持播放 */
@media (prefers-reduced-motion: reduce) {
  .sidebar,
  .brand-mark,
  .nav-item,
  .nav-label,
  .account-name,
  .account-role,
  .account-caret {
    transition: none;
  }
}

.nav {
  display: flex;
  flex-direction: column;
  padding: 0 var(--space-2) var(--space-2);
}

/* 行高 40px、圆角 12px、图标与文字间距 6px——三个值都取自 Kimi 的
   `.next-sidebar-nav-item` 实测。此前是 36px / 10px / 8px，整体小一号。 */
.nav-item {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  min-height: var(--nav-height);
  padding: 0 var(--space-2);
  overflow: hidden;
  /* **14px/20px，不是正文的 15px**：Kimi 的 `.next-sidebar-nav-item` 实测如此。
     侧栏是并列的短标签，不是要读的正文；用正文字号会让整栏胖一号、行距也散。 */
  font-size: var(--text-meta-size);
  line-height: 20px;
  /* 静止态就用主文字色（Kimi 如此）。此前用二级灰，
     五个入口读起来像"次要信息"，而它们是主导航。 */
  color: var(--text-primary);
  text-decoration: none;
  border-radius: var(--radius-nav);
  /* gap 与内边距一起过渡：折叠时图标是"滑"到中间的，不是跳过去的 */
  transition:
    gap var(--motion-slow) var(--motion-ease-inout),
    padding var(--motion-slow) var(--motion-ease-inout);
}

/* 标签用 max-width 收起（v-if 摘掉就没动画了）：折叠态收到 0 并淡出。
   时长与侧栏宽度一致，否则文字会在栏还没收完时先消失。 */
.nav-label {
  overflow: hidden;
  white-space: nowrap;
  max-width: 200px;
  transition:
    max-width var(--motion-slow) var(--motion-ease-inout),
    opacity var(--motion-fast) var(--motion-ease);
}

.sidebar-collapsed .nav-label {
  max-width: 0;
  opacity: 0;
}

.nav-item:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.nav-icon {
  flex: 0 0 auto;
  /* **尺寸由 token 说了算**：Kimi 的导航图标实测 18×18，而 `IconBase` 的默认
     `size` 是 16——模板里那十几个 `<IconXxx />` 都没传 size，于是
     `--nav-icon-size` 定义了却从来没生效过（实测图标一直是 16）。
     在这里用 CSS 定尺寸，比逐处改模板更靠得住：SVG 的 width/height 属性会被
     作者的 CSS 覆盖，模板不用动。 */
  width: var(--nav-icon-size);
  height: var(--nav-icon-size);
  /* 跟随条目文字色（Kimi 的 `__icon-wrapper` 就是 currentColor）。
     此前固定三级灰，于是"图标比文字浅一档"成了默认，
     而它在静止态本该和文字同色。 */
  color: currentColor;
  /* 动效里有旋转与缩放，必须绕自身中心：SVG 根元素默认就是 50% 50%，
     写出来是为了不让"旋转绕哪个点"变成一个要靠猜的前提。 */
  transform-origin: center;
}

/* 选中项：**中性 alpha 底，不是品牌色底**（Kimi 的实测值）。
   它同时去掉了原来那条 2px 品牌色左指示条——Kimi 的选中态只有底色，
   靠底色 + 文字色表达"当前在这里"，不需要再加一根线。
   全站仍然只有主按钮与小徽章用品牌色。 */
.nav-item-active {
  background: var(--bg-selected);
}

/* 侧栏下半部分：会话列表。flex:1 占住剩余高度，
   底部的主题/设置始终贴在窗口底部，不随列表长短上下浮动。

   **上沿没有分隔线**（v0.24 去掉的）：Kimi 的侧栏里一条分割线都没有——
   区块之间靠 `.next-sidebar__body` 的 `gap: 12px` 分开。原先这里有一条
   `border-top`，与页脚那条加起来是两道横线横穿整栏，是"侧栏看起来碎"的主因。
   分隔的活交给留白(`.side-head` 的 `margin-top`)与背景差。 */
.side-section {
  flex: 1;
  min-height: 0;
  padding: 0 var(--space-2) var(--space-2);
  overflow-y: auto;
}

/* 节标题行：`项目 ⌄` + 右侧**悬停才出现**的"新建"按钮（Kimi Work 的形态）。
   箭头紧跟在文字后面（它表示"这一节能收起来"），右侧留给动作——
   而那个动作默认不摆，鼠标移上来才出现：常驻的话，两节各挂一个加号，
   读起来像"这两行各有一个主要动作"，而它们的主语其实是下面那份清单。 */
.side-head {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin-top: var(--space-3);
  padding-right: var(--space-1);
}

.side-toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  height: var(--nav-section-title-height);
  padding: 0;
  border: none;
  background: none;
  color: var(--text-tertiary);
  font-size: var(--text-meta-size);
  line-height: 20px;
  cursor: pointer;
  transition: var(--transition-ui);
}

.side-toggle:hover {
  color: var(--text-primary);
}

.side-chevron {
  transition: transform var(--motion-fast) var(--motion-ease);
}

.side-chevron.collapsed {
  transform: rotate(-90deg);
}

.side-add {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--hit-target);
  height: var(--hit-target);
  margin-left: auto;
  padding: 0;
  border: none;
  background: none;
  border-radius: var(--radius-control);
  color: var(--text-tertiary);
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--motion-fast) var(--motion-ease);
}

/* 悬停显形，但**始终可 Tab 到**（规范 §8 禁止 hover-only 的关键操作） */
.side-head:hover .side-add,
.side-add:focus-visible {
  opacity: 1;
}

.side-add:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

/* 清单：每一行都**铺满侧栏宽度**（v0.22 修）。
   上一版把行做成了行内元素，于是它只有文字那么宽（实测 87px），
   悬停高亮只覆盖一小块，看着像"没铺满"。 */
.side-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

/* 会话行 + 它的「⋯」：外层只负责"把菜单压在行右端"。
   **菜单不能放进 RouterLink 里**——`<details>` 套在链接里，点菜单会先触发跳转。
   它是链接的**兄弟**，绝对定位浮在行的右侧。 */
.side-row-wrap {
  position: relative;
}

/* 「⋯」默认隐形，鼠标移到这一行（或键盘 Tab 到它）才显形（v0.25）。
   与「项目」那一节的加号同一套手势：**列表里每一行都挂一个常驻的「⋯」，
   整栏会变成一列按钮**，而它只是"整理这一行"的次要动作。
   隐形不等于不可达：`opacity: 0` 的元素仍可聚焦，`:focus-visible` 会把它显出来
   （规范 §8 禁止"只有 hover 才够得着"的关键操作）。 */
.side-row-wrap :deep(.row-menu) {
  position: absolute;
  top: 50%;
  right: var(--space-1-5);
  display: flex;
  margin-top: calc(var(--hit-target) / -2);
  opacity: 0;
  transition: opacity var(--motion-fast) var(--motion-ease);
}

.side-row-wrap:hover :deep(.row-menu),
.side-row-wrap :deep(.row-menu:focus-within),
.side-row-wrap :deep(.menu[open]) {
  opacity: 1;
}

/* 菜单浮层自己要吃满不透明度：父层的 `opacity` 会**整片**作用于浮层（它是子元素），
   而浮层是 `position: fixed` 的独立表面——0.0 的父层会让它一起淡掉。
   所以在打开时把父层推到 1（上面那条规则已经做了），这里不必再改。 */

/* 标题要给「⋯」腾地方（v0.25 修）。「⋯」浮在行右端 6..30px 这一片，
   而标题原先一直铺到 6px 处——**省略号正好被压在「⋯」底下**（用户报的"重叠"）。
   让位的宽度 = 按钮 24 + 右间距 6 + 4px 呼吸缝。
   **常驻让位，不是 hover 时才让**：跟着 hover 变的话，鼠标扫过一列时
   每一行的省略位置都会跳一下。代价是标题少显示两个字，那比抖动划算。 */
.side-row-wrap > .side-row {
  padding-right: calc(var(--hit-target) + var(--space-1-5) + var(--space-1));
}

.side-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  box-sizing: border-box;
  width: 100%;
  height: var(--nav-height);
  padding: 0 var(--space-1-5);
  border: none;
  border-radius: var(--radius-nav);
  background: none;
  color: var(--text-primary);
  font-size: var(--text-meta-size);
  line-height: 20px;
  text-align: left;
  text-decoration: none;
  cursor: pointer;
  transition: var(--transition-ui);
}

.side-row:hover {
  background: var(--bg-hover);
}

/* 项目那一行：名字后面跟条数 */
.side-row-group {
  color: var(--text-primary);
}

.side-row-icon {
  flex-shrink: 0;
  color: var(--text-secondary);
}

.side-row-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.side-row-count {
  flex-shrink: 0;
  color: var(--text-tertiary);
  font-size: var(--text-micro-size);
}

/* 项目下的会话缩进一级（与项目行形成从属关系） */
.side-row-sub {
  padding-left: var(--space-6);
  color: var(--text-secondary);
}

.side-more {
  color: var(--text-tertiary);
}

/* 空态：一行灰字，与行同高（免得清单塌成一条缝）。
   **一句话说"现在是什么状态"，不说"你该怎么做"**：Kimi 的对话分区空态是
   「登录以同步历史会话」——一行状态。原先我们写的是「还没有对话。点上面的加号开始。」
   两行，把状态和操作指引挤在一起，反而把这个分区抬高了一倍。 */
.side-empty {
  padding: var(--space-2) var(--space-1-5);
  color: var(--text-tertiary);
  font-size: var(--text-meta-size);
  line-height: 20px;
}

/* 「新建会话」是**侧栏里唯一有底有框的一颗**（v0.24 改回）。

   上一版把它改成"和导航项一样的形态"（透明行），理由写在这儿：同一栏里两种
   按钮形态，用户得先分辨哪个能点。本轮按 kimi.com 对话页的实测改回来——
   它的侧栏里唯一有底有框的就是这一颗，其余全是透明的行。
   也就是说它对"哪个是主操作"的回答不是"都不强调"，而是**只强调一个**；
   而且它靠的是位置（第一行）+ 底色 + 边框三重信号，不靠让别的项变淡。

   形态取值全部是实测：底 `#1f1f1f`（`BgGp-Secondary`，比画布亮一档）、
   1px `Separators-S1` 描边、圆角 12、高 44、文字 **500 字重**。
   **左右各留 8px**——与 `.nav` 的内边距取值一致（它是 `.sidebar` 的直接子元素，
   `.nav` 上那层 padding 管不到它）。 */
.new-chat {
  margin: 0 var(--space-2) var(--space-2);
  background: var(--bg-group);
  border: 1px solid var(--border-hairline);
  font-weight: 500;
  transition: var(--transition-surface);
}

.new-chat:hover {
  background: var(--bg-group);
  /* 悬停不改底色，只把边框提到 `-active` 那档：块按钮已经有底了，
     再叠一层填充会变成"两块颜色拼在一起"，而边框加深是它自己的语言。 */
  border-color: var(--border-strong);
}

/* 快捷键提示：`Ctrl` `K` 两枚小片（Kimi 的写法）。
   **不是等宽字体、不是 10px**：实测它的 `.meta` 是 UI 字体的 14px、
   `Fills-F2` 底、无边框、`padding: 0 4px`、高 20、圆角 4。
   此前我们做成了 10px 等宽 + 1px 描边——那是"代码片段"的形态，不是"按键"。 */
.shortcut {
  display: inline-flex;
  gap: var(--space-1);
  margin-left: auto;
}

.shortcut kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 var(--space-1);
  background: var(--Fills-F2);
  border-radius: var(--radius-badge);
  color: var(--text-tertiary);
  font-family: inherit;
  font-size: var(--text-meta-size);
  line-height: 1;
}

/* 分区标签：侧栏宽一点以后，光靠留白已经分不开"导航"与下面这段。
   高度 28px 与左右 8px 内边距让它和下面「新对话」块的左边缘对齐——
   对不齐的话，扫视时会看到两条错开的起始线。
   字号取 14（Kimi 的分区标题是 ui-B2），不再加宽字距：
   加字距是"小号全大写西文"的习惯，中文上加字距只是变稀，不增加区分度。 */
/* ------------------------------------------------------------------ 图标动效（v0.18）
   照 kimi.com 的 **AnimatedIcon** 抄骨架，但**一项一个动作**，且**只在进入时播**。

   ## 每项一个动作（用户反馈："动效太单一了，全部都是闪烁"）

   线上侧栏 16 个图标，**每个都有自己的动画**：它们的 SVG 里各带一份 SMIL 路径形变数据
   （`<animate attributeName="d" values="…">`），互不重复。我第一版抄了它的
   **关键帧数值**，却把同一份关键帧挂给了全部五项——所以"单一"。
   **Kimi 的动效不单一，靠的不是那组 CSS 关键帧（那组本来就在各图标间共用），
   而是每个图标各自的形变。** 我们没有逐图标的形变数据（那要按每个图形手描一整套
   路径），所以改从**姿势**上区分：每项一个动效族，取"这个图标画的是什么"该有的动作
   ——气泡自上落下、便签自下放上、记忆歪一头再正过来、能力上电弹一下，
   知识库（分组头）照抄 Kimi 原样（右侧滑入 + 放大落定）。

   ## 姿势与时长的取值（从 Kimi 抄的）：`scale 0.6 → 1`、右侧约 11% 处滑入、**200ms**、
   `linear`。时长以线上 phase 规则里的 `animation-duration:200ms!important` 为准
   （SVG 内联样式里那个 0.5333s 会被它覆盖，我第一版只读到后者，写成了 0.5s）。

   ## 改掉的一处：8.333% 的硬闪

   Kimi 在 **8.333%（≈17ms）**就把 `opacity` 拉到 1，是一次硬闪；它那套图标是纯描边，
   同一条动画还叠着 `stroke-opacity .2 → 1`（由淡到实），所以看着是"显形"。
   我们的图标是填充式（见 IconBase），同样的 `opacity` 落上去就是**整块图形闪一下**，
   正是用户说的"闪烁"。所以五项统一改成**在前 40% 内淡入**（≈80ms），
   缩放与位移仍按 Kimi 的节奏走。

   ## 为什么**没有**"离开"那一段（Kimi 有，这里砍掉了）

   Kimi 的离开是"倒着播"：它的 enter / leave 关键帧逐字相同，靠
   `[data-animation-phase=leave] { animation-direction: reverse }` 反向播放。
   它之所以能这么做，是因为每个图标是**三层**结构——`idle` / `enter` / `leave`
   三个 `<g>`，同一时刻只显示一层；离开播完把 phase 切回 `idle`，
   于是**一直可见的 idle 那层**又露出来。

   单个元素上照抄会出事，我实测踩到了：把倒放写成关键帧（`nav-*-out`）并沿用
   `fill-mode: both`，动画结束后元素会**永久停在收回去的姿态**——悬停过一次的图标
   就再也看不见了（实测 `opacity: 0`、`scale(0.6)`，五个图标的 marker 全部消失，
   是截图才看出来、DOM 断言看不出来的那种）。当时的两个岔路：

   - **不保留终态**（`fill: none`）：收回之后"啪"地弹回原状，等于又加一次闪；
   - **补一层 idle**：为了一个悬停反馈引入三层结构与相位状态机，代价远超收益。

   所以只留进入那一段。用户嫌的正是"闪"，砍掉离开是唯一两头都不亏的选择。
   如果以后要 Kimi 那种"移开也动一下"，正确做法是补上它的三层结构，
   而不是在单元素上硬凑。
*/

/* 新建会话：气泡落下来 */
@keyframes nav-drop-in {
  0% {
    transform: translateY(-6px) scale(0.6);
    opacity: 0;
  }

  45% {
    transform: translateY(1px) scale(1);
    opacity: 1;
  }

  100% {
    transform: translateY(0) scale(1);
    opacity: 1;
  }
}

/* 笔记：便签自下放上（末段那 1px 的回压是"按了一下"） */
@keyframes nav-rise-in {
  0% {
    transform: translateY(6px) scale(0.65);
    opacity: 0;
  }

  45% {
    transform: translateY(-1px) scale(1);
    opacity: 1;
  }

  100% {
    transform: translateY(0) scale(1);
    opacity: 1;
  }
}

/* 记忆：歪一头，再正过来 */
@keyframes nav-tilt-in {
  0% {
    transform: rotate(-12deg) scale(0.7);
    opacity: 0;
  }

  45% {
    transform: rotate(2deg) scale(1);
    opacity: 1;
  }

  100% {
    transform: rotate(0) scale(1);
    opacity: 1;
  }
}

/* 能力：上电弹一下（1.08 的过冲是"通了"的那一下）。
   过冲上限受图标可见范围约束：图标内容约占 24 网格里的 2..22，
   放大 1.08 后仍在 viewBox 内，不会被 SVG 根元素裁掉。 */
@keyframes nav-spring-in {
  0% {
    transform: scale(0.6);
    opacity: 0;
  }

  45% {
    transform: scale(1.08);
    opacity: 1;
  }

  100% {
    transform: scale(1);
    opacity: 1;
  }
}

/* 知识库：Kimi 原样（translate 11% → 1.5% → 0，scale 0.6 → 1） */
@keyframes nav-slide-in {
  0% {
    transform: translateX(11%) scale(0.6);
    opacity: 0;
  }

  45% {
    transform: translateX(1.5%) scale(1);
    opacity: 1;
  }

  100% {
    transform: translateX(0) scale(1);
    opacity: 1;
  }
}

/* 每项一条规则。
   **动画名直接写在声明里，不要用 `var(--nav-motion)` 之类间接一层**：
   scoped 样式里的 `@keyframes` 名字会被 Vue 改名（加哈希后缀，实测是
   `nav-rise-in-acd85c5e`），而变量里的名字它看不见、改不到——动画会静默失效
   （不报错，就是不动）。 */

/* `fill-mode: both` 在这里是安全的：终帧就是静止姿态（opacity 1 / scale 1 / 无位移），
   所以悬停结束后元素停在原样，不会像上面说的那种"停在收回去的姿态"。 */
.nav-item:hover .nav-motion-drop {
  animation: nav-drop-in 200ms linear both;
}

.nav-item:hover .nav-motion-rise {
  animation: nav-rise-in 200ms linear both;
}

.nav-item:hover .nav-motion-tilt {
  animation: nav-tilt-in 200ms linear both;
}

.nav-item:hover .nav-motion-spring {
  animation: nav-spring-in 200ms linear both;
}

.nav-item:hover .nav-motion-slide {
  animation: nav-slide-in 200ms linear both;
}

/* 动效不该在"减少动态效果"的系统设置下仍然播放（规范 §8 的无障碍底线）。
   **选择器要和上面同权重**（都是 0-3-0）才压得住——只写 `.nav-item .nav-icon`
   是 0-2-0，会被 `:hover` 那条盖掉，等于这个设置从来没生效过。 */
@media (prefers-reduced-motion: reduce) {
  .nav-item:hover .nav-icon {
    animation: none;
  }
}

/* 重命名弹窗里的一行提示：右对齐跟在输入框下面，与知识库设置里的计数同款 */
.field-hint {
  margin: var(--space-2) 0 0;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
  text-align: right;
}

.side-note {
  margin: var(--space-2);
  font-size: var(--text-micro-size);
  line-height: var(--line-prose);
  color: var(--text-tertiary);
}

/* 页脚：**没有上分隔线**（v0.24 去掉的），内边距 8px。
   这是本轮"左下侧边栏"那组问题里最要紧的两条：
   1. 原先的 `border-top` 横穿整栏，加上 `.side-section` 那条一共两道，
      侧栏被切成三段；Kimi 的侧栏里一条分割线都没有，靠留白分块。
   2. 原先的内边距是 `12px 16px`，于是账号那个盒子从 x=16 起、宽 207，
      而它上面每一行导航都从 x=8 起、宽 223——**同一栏里两条起始线**。
      改成 8px 之后全栏共用一条起始线。 */
.sidebar-foot {
  /* margin-top: auto 让页脚始终贴底：折叠态下会话列表整段隐藏，
     flex:1 的撑高元素没了，不写这句页脚会跑到导航正下方。 */
  margin-top: auto;
  padding: var(--space-2);
}

/* 账号区：一行摘要，点开是向上的二级菜单（设置 / 切换主题 / 退出登录）。
   页脚现在**只有这一行**——使用者下拉与独立的「设置」按钮都已收进菜单。

   **容器本身完全透明**（无填充、无边框、无圆角）：Kimi 的 `.user-area` 实测如此，
   底色只在悬停/展开时出现。原先它常驻一个 `bg-surface` 填充 + 1px 描边，
   于是它成了整条侧栏里最重的一块——而它承载的信息（我是谁）恰恰是最不需要强调的。 */
.account {
  position: relative;
}

.account-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  /* 44px：Kimi 的 `.user-area` 实测高 44，与上面 40px 的导航行刻意不同——
     它是"一块"而不是"一行"。 */
  min-height: 44px;
  padding: var(--space-2);
  border-radius: var(--radius-nav);
  cursor: pointer;
  list-style: none;
  transition: var(--transition-ui);
}

.account-row::-webkit-details-marker {
  display: none;
}

.account-row:hover,
.account[open] .account-row {
  background: var(--bg-hover);
}

/* 头像占位：28px 圆 + 二级灰的小人 */
.account-avatar {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: var(--avatar-size);
  height: var(--avatar-size);
  background: var(--bg-selected);
  border-radius: var(--radius-pill);
  color: var(--text-secondary);
}

/* 名字吃掉剩余宽度（同样给角色与折叠箭头让位）。
   `max-width` + `overflow: hidden` 是为折叠过渡：折叠态收到 0 而不是 display:none */
.account-name {
  flex: 1;
  overflow: hidden;
  max-width: 200px;
  font-size: var(--text-meta-size);
  line-height: 20px;
  font-weight: 500;
  color: var(--text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
  transition:
    max-width var(--motion-slow) var(--motion-ease-inout),
    opacity var(--motion-fast) var(--motion-ease);
}

.account-role {
  flex: 0 0 auto;
  overflow: hidden;
  max-width: 80px;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
  white-space: nowrap;
  transition:
    max-width var(--motion-slow) var(--motion-ease-inout),
    opacity var(--motion-fast) var(--motion-ease);
}

.account-caret {
  flex: 0 0 auto;
  overflow: hidden;
  max-width: 16px;
  color: var(--text-tertiary);
  transition:
    max-width var(--motion-slow) var(--motion-ease-inout),
    opacity var(--motion-fast) var(--motion-ease);
}

/* 菜单向上弹出：它就挂在页脚底部，向下会出到屏幕外。
   尺寸照 Kimi 的 `.kimi-menu` 实测：底 `Bg-Tertiary`（深色下比画布亮两档）、
   圆角 16、内边距 8、**无边框**（分层靠底色差，不靠描边）。 */
.account-pop {
  position: absolute;
  right: 0;
  bottom: calc(100% + var(--space-1));
  left: 0;
  z-index: 20;
  padding: var(--menu-pad);
  background: var(--bg-menu);
  border-radius: var(--radius-panel);
  box-shadow: var(--shadow-popover);
}

.account-pop button {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: var(--menu-item-height);
  padding: 0 var(--space-2);
  font-size: var(--text-meta-size);
  line-height: 20px;
  color: var(--menu-item-text);
  text-align: left;
  border-radius: var(--menu-item-radius);
  transition: var(--transition-ui);
}

.account-pop button:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.account-pop button:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

/* 退出登录：语义红只在这一项——菜单里唯一不可逆的动作 */
.account-pop .account-danger {
  color: var(--status-danger);
}
/* ---------------------------------------------------------------- 侧栏（v0.15）
   新增的都是"分组"这一族：可折叠的子菜单、工作区及其会话。
   尺寸沿用 §7 的实测值（导航项 40px / 圆角 12 / gap 6），子项比父项矮一档、
   缩进一级——层级靠**缩进 + 字号**表达，不靠加边框（那会让侧栏看起来像表格）。 */

.nav-group {
  display: flex;
  flex-direction: column;
}

/* 分组头也是 40px 的导航项，只是右端多了计数与箭头 */
.nav-item-group {
  width: 100%;
  border: none;
  background: none;
  text-align: left;
  cursor: pointer;
}

.nav-count {
  margin-left: auto;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.nav-chevron {
  flex-shrink: 0;
  color: var(--text-tertiary);
  transition: transform var(--motion-fast) var(--motion-ease);
}

.nav-chevron.open {
  transform: rotate(90deg);
}

.nav-sub {
  margin: 0 0 var(--space-1);
  padding: 0 0 0 var(--space-6);
  list-style: none;
}

.nav-sub-item {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  height: var(--row-height-compact);
  padding: 0 var(--space-2);
  border-radius: var(--radius-control);
  color: var(--text-secondary);
  font-size: var(--text-meta-size);
  text-decoration: none;
  transition: var(--transition-ui);
}

.nav-sub-item:hover,
.nav-sub-item.router-link-active {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.nav-sub-name {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.nav-sub-empty {
  padding: var(--space-1) var(--space-2);
  color: var(--text-tertiary);
  font-size: var(--text-micro-size);
}

/* 工作区下的会话缩进一级，且不带"几条消息"——那一栏属于工作区，
   会话本身只需要标题（宽度本来就只有 240px）。 */
</style>
