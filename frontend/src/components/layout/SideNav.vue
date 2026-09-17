<script setup lang="ts">
/**
 * 导航侧栏（《前端设计规范》§5）。
 *
 * 结构：产品名 → 导航（对话 / 概览 / 知识库 / 任务中心）→ 对话列表 → 页脚（账号 / 设置）。
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

import IconChatNew from '@/components/icons/IconChatNew.vue'
import IconEdit from '@/components/icons/IconEdit.vue'
import IconPin from '@/components/icons/IconPin.vue'
import IconTrash from '@/components/icons/IconTrash.vue'
import IconChevronDown from '@/components/icons/IconChevronDown.vue'
import IconChevronRight from '@/components/icons/IconChevronRight.vue'
import IconDashboard from '@/components/icons/IconDashboard.vue'
import IconFolder from '@/components/icons/IconFolder.vue'
import IconLibrary from '@/components/icons/IconLibrary.vue'
import IconPlus from '@/components/icons/IconPlus.vue'
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
import AppButton from '@/components/ui/AppButton.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppModal from '@/components/ui/AppModal.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import RowMenu from '@/components/ui/RowMenu.vue'
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
import { useToast } from '@/composables/useToast'
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
const { notifyError, notifySuccess } = useToast()

/** 折叠为图标栏：纯显示偏好，落 localStorage（见 useSidebar）。 */
const { collapsed, toggleSidebar } = useSidebar()

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

/** 悬停/聚焦某条历史会话：把它的正文先取回来（失败静默，见 store）。 */
function onConversationIntent(id: string): void {
  void conversations.prefetchDetail(id)
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
const sectionHovered = ref(false)

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
/** 整节折叠（Kimi 的 `对话 ⌄`）。默认展开——它是这一栏的主体。 */
const sectionCollapsed = ref(false)
const knowledgeOpen = ref(false)
const openWorkspaceIds = ref<string[]>([])
const ungroupedOpen = ref(true)

/** 按工作区把会话分好组。会话只有**一份**平铺清单，分组在这里做——
 *  两处各存一份，"把会话挪进工作区"就得改两个地方。 */
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

/** 不属于任何工作区的会话（侧栏单独一栏，按最近更新排）。 */
const ungroupedConversations = computed(() =>
  conversations.items.filter((item) => !item.workspace_id),
)

function toggleKnowledge(): void {
  knowledgeOpen.value = !knowledgeOpen.value
}

function toggleWorkspace(workspaceId: string): void {
  openWorkspaceIds.value = openWorkspaceIds.value.includes(workspaceId)
    ? openWorkspaceIds.value.filter((item) => item !== workspaceId)
    : [...openWorkspaceIds.value, workspaceId]
}

function isWorkspaceOpen(workspaceId: string): boolean {
  return openWorkspaceIds.value.includes(workspaceId)
}

/** 「新建工作区」：跳工作区页并让它直接把新建表单打开（`?new=1`）。 */
function onNewWorkspace(): void {
  void router.push({ path: '/workspaces', query: { new: '1' } })
}

function isKnowledgeActive(): boolean {
  return route.path.startsWith('/knowledge-bases') || route.path.startsWith('/kb/')
}

/** 在这个工作区里开一条新会话：带上工作区，**知识库范围由后端继承工作区的**
 *  （见 api/v1/conversations.py）。这就是"进入项目，资料范围就定了"。 */
async function newConversationIn(workspaceId: string): Promise<void> {
  const workspace = workspaces.byId.get(workspaceId)
  try {
    const record = await conversations.create([], null, undefined, workspaceId)
    openWorkspaceIds.value = [...new Set([...openWorkspaceIds.value, workspaceId])]
    await workspaces.refreshCounts()
    await router.push(`/chat/${record.id}`)
  } catch (error) {
    notifyError(error instanceof Error ? error.message : '新建会话失败')
    void workspace
  }
}

/** 把一个会话挪进工作区 / 退回未归档（会话行菜单里用）。 */
async function moveConversation(
  conversation: ConversationSummary,
  workspaceId: string | null,
): Promise<void> {
  try {
    await conversations.setWorkspace(conversation.id, workspaceId)
    await workspaces.refreshCounts()
    notifySuccess(workspaceId ? '已挪进工作区' : '已移出工作区')
  } catch (error) {
    notifyError(error instanceof Error ? error.message : '移动失败')
  }
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

/** 当前会话 id：从路径里取，用来高亮列表里那一条。 */
const activeConversationId = computed(() => {
  const matched = /^\/chat\/([^/]+)$/.exec(route.path)
  return matched ? matched[1] : ''
})

// ---------------------------------------------------------------- 会话管理（v17）

/** 标题上限，与后端 `ConversationUpdateIn.title`（64）对齐。 */
const TITLE_MAX = 64

/** 搜索词。**交给后端筛**：只筛已加载的前 50 条会搜不到更早的会话。 */

const renameOpen = ref(false)
const renameDraft = ref('')
const renameTarget = ref<ConversationSummary | null>(null)
const renaming = ref(false)

function openRename(item: ConversationSummary): void {
  renameTarget.value = item
  renameDraft.value = item.title || ''
  renameOpen.value = true
}

async function confirmRename(): Promise<void> {
  const target = renameTarget.value
  const title = renameDraft.value.trim()
  if (!target) return
  if (!title) {
    notifyError('标题不能为空')
    return
  }
  renaming.value = true
  try {
    await conversations.rename(target.id, title)
    renameOpen.value = false
    notifySuccess('已重命名')
  } catch (error) {
    notifyError(error instanceof Error ? error.message : '重命名失败')
  } finally {
    renaming.value = false
  }
}

const deleteOpen = ref(false)
const deleteTarget = ref<ConversationSummary | null>(null)
const deleting = ref(false)

function openDelete(item: ConversationSummary): void {
  deleteTarget.value = item
  deleteOpen.value = true
}

/**
 * 删除当前正在看的会话时**要把人送走**：留在 `/chat/{已删 id}` 上，
 * 对话页会去拉一个不存在的会话并报错——用户刚删完就看到红字，像是删坏了。
 */
async function confirmDelete(): Promise<void> {
  const target = deleteTarget.value
  if (!target) return
  deleting.value = true
  try {
    await conversations.remove(target.id)
    deleteOpen.value = false
    if (activeConversationId.value === target.id) await router.push('/chat')
    notifySuccess('已删除对话')
  } catch (error) {
    notifyError(error instanceof Error ? error.message : '删除失败')
  } finally {
    deleting.value = false
  }
}

async function togglePin(item: ConversationSummary): Promise<void> {
  try {
    await conversations.setPinned(item.id, !item.pinned)
  } catch (error) {
    notifyError(error instanceof Error ? error.message : '置顶失败')
  }
}

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
    <!-- 字标自带 "KYLAB" 字样，不再并排写一遍品牌名（重复反而削弱标识性）。
         右侧是折叠开关：折叠后字标收起，只留这颗面板图标。
         **字标与文字都不用 v-if 摘掉**——`v-if` 是瞬时的，没法过渡；
         改用 max-width 收缩（见下方样式），宽度动画才连得上。 -->
    <div class="brand">
      <span class="brand-mark"><IconLogo :size="24" /></span>
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
      -->
      <kbd class="shortcut">Ctrl K</kbd>
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
      侧栏下半部分：**会话列表**。
      这块位置最早是「最近文档」，后来换成一句指路的占位——因为用户在这一栏里真正
      需要的不是"我最近传了什么"，而是"我最近问过什么"。对话留存做完之后，它终于有东西可放。
    -->
    <div v-if="!collapsed" class="side-section">
      <!-- 分区标题行只有路标，**动作另起一行**（Kimi 的结构）：
           它把「新对话」做成一个整块的填充按钮（BgGp-Secondary + 12px 圆角 + 44px 高），
           而不是挤在标题右边的一个文字链接——后者在视觉上像"次要入口"，
           而新建对话是这一栏里最常用的动作。 -->
      <!-- 会话区（v0.17 重排）——**它是一节「会话」，不是两节**：
           工作区与会话是同一件事的两种归类（会话按工作区分组），所以「工作区 A」
           与「未归档会话」是**同一层级的分组行**。原先「工作区」是分区标题、
           而「未归档会话」是它下面的一行——层级不一致，后者看起来像一个工作区。

           顺序上这一节在导航**之下**：导航是"去哪个功能区"，短且固定；
           会话清单会不断变长，放在导航之上就会把导航推走。 -->
      <!-- 节标题照 Kimi：`对话 ⌄` —— 点这儿折叠整节，鼠标移上来右侧出现「查看全部」。
           「查看全部」在参考图里就是**悬停才出现**的次要动作，所以它默认 opacity:0；
           但**始终可 Tab 到**（§8 禁止 hover-only 的关键操作）——聚焦时同样显形。 -->
      <div
        class="workspace-head"
        @mouseenter="sectionHovered = true"
        @mouseleave="sectionHovered = false"
      >
        <button
          type="button"
          class="section-toggle"
          :aria-expanded="!sectionCollapsed"
          @click="sectionCollapsed = !sectionCollapsed"
        >
          <span class="section-label">对话</span>
          <IconChevronDown
            class="section-chevron"
            :class="{ collapsed: sectionCollapsed }"
            :size="14"
          />
        </button>
        <button
          type="button"
          class="section-action"
          :class="{ 'section-action-visible': sectionHovered || sectionCollapsed }"
          @click="emit('openHistory')"
        >
          查看全部
        </button>
      </div>

      <p v-if="workspaces.error" class="side-note">{{ workspaces.error }}</p>

      <!-- 搜索**不放在侧栏**（v0.17，用户指定）：侧栏条数有限、位置也窄，
           而"找一条旧会话"是历史会话面板的活——那里有更大的窗口、时间分组与预览。
           侧栏只负责"最近几条"。 -->

      <ul v-show="!sectionCollapsed" class="ws-list">
        <li v-for="workspace in workspaces.items" :key="workspace.id" class="ws-group">
          <div class="ws-row">
            <button
              type="button"
              class="ws-item"
              :aria-expanded="isWorkspaceOpen(workspace.id)"
              :title="workspace.root_path"
              @click="toggleWorkspace(workspace.id)"
            >
              <IconChevronDown
                class="ws-chevron"
                :class="{ collapsed: !isWorkspaceOpen(workspace.id) }"
                :size="13"
              />
              <IconFolder :size="14" class="ws-icon" />
              <span class="ws-name">{{ workspace.name }}</span>
              <span class="ws-count tabular">{{ workspace.conversation_count }}</span>
            </button>
            <button
              type="button"
              class="ws-new"
              :title="`在「${workspace.name}」里新开一条会话`"
              @click="newConversationIn(workspace.id)"
            >
              <IconChatNew :size="14" />
            </button>
          </div>

          <ul v-if="isWorkspaceOpen(workspace.id)" class="conv-list">
            <li
              v-for="item in conversationsByWorkspace.get(workspace.id) ?? []"
              :key="item.id"
              class="conv-row"
            >
              <RouterLink
                class="conv-item conv-item-nested"
                :class="{ 'conv-item-active': item.id === activeConversationId }"
                :to="`/chat/${item.id}`"
                :title="item.title || '未命名对话'"
                @mouseenter="onConversationIntent(item.id)"
                @focus="onConversationIntent(item.id)"
              >
                <IconPin v-if="item.pinned" class="conv-pin" :size="12" />
                <span class="conv-title">{{ item.title || '未命名对话' }}</span>
              </RouterLink>
              <RowMenu class="conv-menu" :label="`${item.title || '未命名对话'} 的操作`">
                <template #default="{ close }">
                  <button type="button" @click="(togglePin(item), close())">
                    <IconPin :size="14" /> {{ item.pinned ? '取消置顶' : '置顶' }}
                  </button>
                  <button type="button" @click="(openRename(item), close())">
                    <IconEdit :size="14" /> 重命名
                  </button>
                  <button type="button" @click="(moveConversation(item, null), close())">
                    <IconFolder :size="14" /> 移出工作区
                  </button>
                  <button
                    class="menu-item-danger"
                    type="button"
                    @click="(openDelete(item), close())"
                  >
                    <IconTrash :size="14" /> 删除
                  </button>
                </template>
              </RowMenu>
            </li>
            <li
              v-if="(conversationsByWorkspace.get(workspace.id) ?? []).length === 0"
              class="conv-empty"
            >
              还没有会话
            </li>
          </ul>
        </li>

        <!-- 未归档会话：与工作区**同一层级的分组行**（v0.17 起层级一致；
             原先它是「工作区」标题下的一行，看起来像一个工作区）。
             不给它们自动建默认工作区——那会让"未归档"这个真实状态消失，
             用户就分不清"特意放进去的"与"随手问的"。 -->
        <li class="ws-group">
          <button
            type="button"
            class="ws-item ws-item-plain"
            :aria-expanded="ungroupedOpen"
            @click="ungroupedOpen = !ungroupedOpen"
          >
            <IconChevronDown class="ws-chevron" :class="{ collapsed: !ungroupedOpen }" :size="13" />
            <span class="ws-name">未归档会话</span>
            <span class="ws-count tabular">{{ ungroupedConversations.length }}</span>
          </button>

          <p v-if="conversations.error" class="side-note">{{ conversations.error }}</p>
          <p v-else-if="conversations.items.length === 0" class="side-note">
            还没有对话。点最上面的「新建会话」开始，记录会出现在这里。
          </p>
          <ul v-else-if="ungroupedOpen" class="conv-list">
            <li v-for="item in ungroupedConversations" :key="item.id" class="conv-row">
              <RouterLink
                class="conv-item"
                :class="{ 'conv-item-active': item.id === activeConversationId }"
                :to="`/chat/${item.id}`"
                :title="item.title || '未命名对话'"
                @mouseenter="onConversationIntent(item.id)"
                @focus="onConversationIntent(item.id)"
              >
                <IconPin v-if="item.pinned" class="conv-pin" :size="12" />
                <span class="conv-title">{{ item.title || '未命名对话' }}</span>
                <span class="conv-meta tabular">{{ item.message_count }} 条</span>
              </RouterLink>
              <RowMenu class="conv-menu" :label="`${item.title || '未命名对话'} 的操作`">
                <template #default="{ close }">
                  <button type="button" @click="(togglePin(item), close())">
                    <IconPin :size="14" /> {{ item.pinned ? '取消置顶' : '置顶' }}
                  </button>
                  <button type="button" @click="(openRename(item), close())">
                    <IconEdit :size="14" /> 重命名
                  </button>
                  <button
                    v-for="workspace in workspaces.items"
                    :key="workspace.id"
                    type="button"
                    @click="(moveConversation(item, workspace.id), close())"
                  >
                    <IconFolder :size="14" /> 挪进「{{ workspace.name }}」
                  </button>
                  <button
                    class="menu-item-danger"
                    type="button"
                    @click="(openDelete(item), close())"
                  >
                    <IconTrash :size="14" /> 删除
                  </button>
                </template>
              </RowMenu>
            </li>
          </ul>
        </li>

        <!-- 「新建工作区」写成一行字，而不是标题右边一个裸 +：
             裸 + 与最上面的「新对话」在视觉上是一类东西（都是"新建"），
             而它们建的是两件不同的事（一个会话 / 一个工作区）。 -->
        <li>
          <button type="button" class="ws-add" @click="onNewWorkspace">
            <IconPlus :size="14" />
            <span>新建工作区</span>
          </button>
        </li>
      </ul>
    </div>

    <AppModal v-model:open="renameOpen" title="重命名对话">
      <label class="field">
        <span class="field-label">标题</span>
        <AppInput
          v-model="renameDraft"
          :maxlength="TITLE_MAX"
          placeholder="给这段对话起个名字"
          @keyup.enter="confirmRename"
        />
        <p class="field-hint">{{ renameDraft.trim().length }} / {{ TITLE_MAX }}</p>
      </label>
      <template #footer>
        <AppButton @click="renameOpen = false">取消</AppButton>
        <AppButton variant="primary" :disabled="renaming" @click="confirmRename">
          {{ renaming ? '保存中…' : '保存' }}
        </AppButton>
      </template>
    </AppModal>

    <ConfirmDialog
      v-model:open="deleteOpen"
      title="删除对话"
      :lead="`确定删除「${deleteTarget?.title || '未命名对话'}」？`"
      note="这段对话的全部消息会一并删掉，**不进退回收站**，无法恢复。"
      confirm-label="删除"
      :busy="deleting"
      busy-label="删除中…"
      @confirm="confirmDelete"
    />

    <div class="sidebar-foot">
      <!--
        页脚只显示**当前用户**，点它向上展开菜单（用户批注）。
        **不提供在系统里切换使用者的入口**：切换身份必须先登出再登录——
        一个下拉就能换人，会让"我以为我是谁"和"后端认为我是谁"分叉。
        菜单向上弹：它挂在页脚底部，向下会出到屏幕外（与 RowMenu 同一手法）。
      -->
      <details ref="accountMenu" class="account">
        <summary class="account-row">
          <IconUser class="account-icon" />
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
  /* 折叠过渡：宽度与 flex-basis 一起动，内容区平滑让出 / 收回空间 */
  transition:
    width 180ms ease,
    flex-basis 180ms ease;
}

/* 品牌行：高度定在 56px。折叠开关是绝对定位的（不参与撑高），
   不写 min-height 的话字标一收起行高就塌，下方导航会突然上移。 */
.brand {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--header-height);
  padding: var(--space-3) var(--space-4) var(--space-2);
  color: var(--text-primary);
}

/* 字标容器：折叠时用 max-width 收成 0，而不是 v-if 摘掉——后者是瞬时的，没法过渡 */
.brand-mark {
  display: flex;
  overflow: hidden;
  max-width: 200px;
  transition:
    max-width 180ms ease,
    opacity 120ms ease;
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
  font-size: var(--text-body-size);
  /* 静止态就用主文字色（Kimi 如此）。此前用二级灰，
     五个入口读起来像"次要信息"，而它们是主导航。 */
  color: var(--text-primary);
  text-decoration: none;
  border-radius: var(--radius-nav);
  /* gap 与内边距一起过渡：折叠时图标是"滑"到中间的，不是跳过去的 */
  transition:
    gap 180ms ease,
    padding 180ms ease;
}

/* 标签用 max-width 收起（v-if 摘掉就没动画了）：折叠态收到 0 并淡出 */
.nav-label {
  overflow: hidden;
  white-space: nowrap;
  max-width: 200px;
  transition:
    max-width 180ms ease,
    opacity 120ms ease;
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
   底部的主题/设置始终贴在窗口底部，不随列表长短上下浮动 */
.side-section {
  flex: 1;
  min-height: 0;
  padding: var(--space-3) var(--space-2) var(--space-2);
  overflow-y: auto;
  border-top: 1px solid var(--border-hairline);
}

/* 「新建会话」用**和导航项一样的形态**（v0.17 改的）。
   原先它是一个 44px 的填充块按钮（`BgGp-Secondary` 底），而它正下方紧接着
   就是一堆长得完全不同的导航行——同一栏里两种按钮形态，用户得先分辨"哪个能点、
   哪个是链接"。现在它复用 `.nav-item`（40px 高、图标 + 文字、同样的悬停填充），
   只在最右端多一枚快捷键提示。

   这不只是"好看"：它把"新建会话"和"去某个地方"归成同一类东西——**都是侧栏里的一个入口**。
   填充块按钮的语义是"这一栏的主操作"，而主操作在菜单型侧栏里没有单独强调的必要。 */
.new-chat {
  /* **左右各留 8px**（v0.18）——与 `.nav` 的内边距取值一致。
     这一条是用户报的"新建会话为什么不跟其他菜单对齐"的答案：它是 `.sidebar` 的
     **直接子元素**，`.nav` 上那层 `padding: 0 var(--space-2)` 管不到它，
     于是它铺满整个侧栏宽度（x=0 / 宽 239），而它下面每一行都从 8px 开始。
     同一栏里两条不同的起始线，看着就是"这一项没对齐"。
     （它自己那一行内部本来就是对的：图标与文字都由 `.nav-item` 的内边距定位。） */
  margin: 0 var(--space-2) var(--space-2);
}

/* 快捷键提示：`Ctrl K`（Kimi 的写法）。等宽字体 + 极轻的描边，
   一眼看出是"按键"而不是文字。 */
.shortcut {
  margin-left: auto;
  padding: 0 var(--space-1-5);
  min-width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-badge);
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: var(--text-c2-size);
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

.section-label {
  display: flex;
  align-items: center;
  height: var(--nav-section-title-height);
  margin: 0;
  padding: 0 var(--space-2);
  font-size: var(--text-meta-size);
  font-weight: 500;
  color: var(--text-secondary);
}

/* 重命名弹窗里的一行提示：右对齐跟在输入框下面，与知识库设置里的计数同款 */
.field-hint {
  margin: var(--space-2) 0 0;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
  text-align: right;
}

/* 搜索框：与行同高、无边框感——它是列表的一部分，不是一个独立表单 */
.conv-search {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: 0 var(--space-2);
  margin-bottom: var(--space-2);
}

.conv-search-icon {
  flex: 0 0 auto;
  color: var(--text-tertiary);
}

/* 输入框去掉自己的边框与底色：外层已经有视觉容器，再套一层框会显得很吵 */
.conv-search :deep(.conv-search-input) {
  flex: 1;
  min-width: 0;
  height: 28px;
  padding: 0;
  font-size: var(--text-micro-size);
  background: transparent;
  border: 0;
}

.conv-search :deep(.conv-search-input:hover),
.conv-search :deep(.conv-search-input:focus) {
  border: 0;
  box-shadow: none;
}

.conv-search:focus-within {
  background: var(--bg-hover);
  border-radius: var(--radius-control);
}

.conv-search-clear {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  color: var(--text-tertiary);
  border-radius: var(--radius-control);
}

.conv-search-clear:hover {
  background: var(--bg-active);
  color: var(--text-primary);
}

.conv-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

/* 每行是"链接 + 行菜单"：菜单绝对定位在右侧，不占标题宽度 */
.conv-row {
  position: relative;
}

.conv-row .conv-item {
  /* 右侧留出菜单的位置，否则标题会压到它在下面 */
  padding-right: var(--space-6);
}

/* 行菜单平时隐形，悬停/聚焦才出现。
   **只有悬停/聚焦**——原来"当前会话也常驻显示"会让菜单与「N 条」同时出现、
   在同一处叠着（用户报的"和列表有冲突"就是这个）。 */
.conv-menu {
  position: absolute;
  top: 50%;
  right: var(--space-1);
  z-index: 1;
  /* **垂直居中用负 margin，不用 `transform: translateY(-50%)`**：
     带 transform 的元素会成为 fixed 定位后代的包含块，而菜单浮层正是 fixed
     （见 RowMenu）。实测这一条会让浮层跑到视口外（left 变成 -988px）。
     负 margin 的取值是触发器的一半高（--hit-target / 2） */
  margin-top: calc(var(--hit-target) / -2);
  opacity: 0;
  transition: opacity var(--motion-fast) var(--motion-ease);
}

.conv-row:hover .conv-menu,
.conv-row:focus-within .conv-menu,
.conv-menu:focus-within {
  opacity: 1;
}

/* 菜单出现时把「N 条」隐掉：两者在同一个位置，**先隐后现而不是叠在一起**。
   条数没被删掉，移开鼠标就回来；行宽 231px，塞不下两个并排的元素 */
.conv-meta {
  transition: opacity var(--motion-fast) var(--motion-ease);
}

.conv-row:hover .conv-meta,
.conv-row:focus-within .conv-meta {
  opacity: 0;
}

/* 置顶标记：固定宽度，置顶与否不会让标题左右跳动。
   颜色用三级灰而不是品牌色——它是"这条被钉住了"的状态标记，
   不是"该点这里"的动作，抢品牌色会与主导航的强调打架。 */
.conv-pin {
  flex: 0 0 auto;
  color: var(--text-tertiary);
}

.conv-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  /* 高 40px、圆角 12px（Kimi 的 `.next-sidebar-history-item` 实测值）。
     此前 32px——同样一条标题在侧栏里多占一行的高度。 */
  min-height: var(--nav-height);
  padding: 0 var(--space-2);
  font-size: var(--text-meta-size);
  color: var(--text-primary);
  text-decoration: none;
  border-radius: var(--radius-nav);
}

.conv-item:hover {
  background: var(--bg-hover);
}

/* 选中态与主导航同一套语言：**中性 alpha 底**（Kimi 也是 Fills-F2） */
.conv-item-active {
  background: var(--bg-selected);
}

/* 标题占满剩余宽度并省略：会话标题来自首轮提问，长度不可控 */
.conv-title {
  flex: 1;
  overflow: hidden;
  min-width: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conv-meta {
  flex: 0 0 auto;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.side-note {
  margin: var(--space-2);
  font-size: var(--text-micro-size);
  line-height: 1.6;
  color: var(--text-tertiary);
}

.sidebar-foot {
  /* margin-top: auto 让页脚始终贴底：折叠态下会话列表整段隐藏，
     flex:1 的撑高元素没了，不写这句页脚会跑到导航正下方。 */
  margin-top: auto;
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--border-hairline);
}

/* 账号区：一行摘要，点开是向上的二级菜单（设置 / 切换主题 / 退出登录）。
   页脚现在**只有这一行**——使用者下拉与独立的「设置」按钮都已收进菜单。 */
.account {
  position: relative;
  background: var(--bg-surface);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-control);
}

.account-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  padding: var(--space-2);
  border-radius: var(--radius-control);
  cursor: pointer;
  list-style: none;
}

.account-row::-webkit-details-marker {
  display: none;
}

.account-row:hover,
.account[open] .account-row {
  background: var(--bg-hover);
}

.account-icon {
  flex: 0 0 auto;
  color: var(--text-tertiary);
}

/* 名字吃掉剩余宽度（同样给角色与折叠箭头让位）。
   `max-width` + `overflow: hidden` 是为折叠过渡：折叠态收到 0 而不是 display:none */
.account-name {
  flex: 1;
  overflow: hidden;
  max-width: 200px;
  font-size: var(--text-meta-size);
  font-weight: 500;
  color: var(--text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
  transition:
    max-width 180ms ease,
    opacity 120ms ease;
}

.account-role {
  flex: 0 0 auto;
  overflow: hidden;
  max-width: 80px;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
  white-space: nowrap;
  transition:
    max-width 180ms ease,
    opacity 120ms ease;
}

.account-caret {
  flex: 0 0 auto;
  overflow: hidden;
  max-width: 16px;
  color: var(--text-tertiary);
  transition:
    max-width 180ms ease,
    opacity 120ms ease;
}

/* 菜单向上弹出：它就挂在页脚底部，向下会出到屏幕外 */
.account-pop {
  position: absolute;
  right: 0;
  bottom: calc(100% + var(--space-1));
  left: 0;
  z-index: 20;
  padding: var(--space-1);
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  box-shadow: var(--shadow-popover);
}

.account-pop button {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 30px;
  padding: 0 var(--space-2);
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
  text-align: left;
  border-radius: var(--radius-control);
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

/* 工作区栏：标题 + 右侧「+」 */
.workspace-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin-top: var(--space-3);
}

/* 「新建工作区」行：与分组行同高同缩进，读起来是清单的一部分 */
.ws-add {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  width: 100%;
  height: var(--nav-height);
  padding: 0 var(--space-1-5);
  border: none;
  background: none;
  border-radius: var(--radius-nav);
  color: var(--text-tertiary);
  font-size: var(--text-meta-size);
  text-align: left;
  cursor: pointer;
  transition: var(--transition-ui);
}

.ws-add:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

/* 节标题：「对话 ⌄」——标签与箭头合成一个可点的整块（点它折叠整节） */
.section-toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  height: var(--nav-section-title-height);
  padding: 0;
  border: none;
  background: none;
  color: var(--text-tertiary);
  cursor: pointer;
}

.section-toggle:hover {
  color: var(--text-primary);
}

.section-chevron {
  transition: transform var(--motion-fast) var(--motion-ease);
}

.section-chevron.collapsed {
  transform: rotate(-90deg);
}

.section-action {
  display: inline-flex;
  align-items: center;
  height: var(--hit-target);
  padding: 0 var(--space-2);
  border: none;
  background: none;
  border-radius: var(--radius-control);
  /* 提示色而不是灰：参考图里「查看全部」比分组标签略深，是一个可点的动作 */
  color: var(--text-secondary);
  font-size: var(--text-meta-size);
  cursor: pointer;
  /* **默认不可见但占位**：用 opacity 而不是 display，避免出现时把标题挤动一下。
     悬停显形是参考图的形态；同时它在 DOM 里始终可 Tab 到并即时显形。 */
  opacity: 0;
  transition: opacity var(--motion-fast) var(--motion-ease);
}

.section-action-visible,
.section-toggle:hover ~ .section-action {
  opacity: 1;
}

.section-action:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.section-action:focus-visible {
  opacity: 1;
}

.ws-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.ws-group + .ws-group {
  margin-top: var(--space-0-5);
}

.ws-row {
  display: flex;
  align-items: center;
  gap: var(--space-0-5);
}

/* 工作区行：与导航项同为 40px，但文字用次要色——它是"容器"，不是"目的地" */
.ws-item {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  flex: 1;
  min-width: 0;
  height: var(--nav-height);
  padding: 0 var(--space-1-5);
  border: none;
  background: none;
  border-radius: var(--radius-nav);
  color: var(--text-secondary);
  font-size: var(--text-meta-size);
  text-align: left;
  cursor: pointer;
  transition: var(--transition-ui);
}

.ws-item:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.ws-item-plain {
  flex: 1;
}

.ws-chevron {
  flex-shrink: 0;
  color: var(--text-tertiary);
  transition: transform var(--motion-fast) var(--motion-ease);
}

.ws-chevron.collapsed {
  transform: rotate(-90deg);
}

.ws-icon {
  flex-shrink: 0;
  color: var(--text-tertiary);
}

.ws-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.ws-count {
  flex-shrink: 0;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

/* 工作区行里的「新开一条会话」：悬停才显眼，但始终可点（§8 禁止项） */
.ws-new {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--hit-target);
  height: var(--hit-target);
  flex-shrink: 0;
  border: none;
  background: none;
  border-radius: var(--radius-control);
  color: var(--text-tertiary);
  cursor: pointer;
  opacity: 0.7;
}

.ws-new:hover {
  background: var(--bg-active);
  color: var(--text-primary);
  opacity: 1;
}

/* 工作区下的会话缩进一级，且不带"几条消息"——那一栏属于工作区，
   会话本身只需要标题（宽度本来就只有 240px）。 */
.conv-item-nested {
  padding-left: var(--space-6);
}

.conv-empty {
  padding: var(--space-1) var(--space-2) var(--space-1) var(--space-6);
  color: var(--text-tertiary);
  font-size: var(--text-micro-size);
}
</style>
