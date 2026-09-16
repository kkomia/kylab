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
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import IconChatNew from '@/components/icons/IconChatNew.vue'
import IconClose from '@/components/icons/IconClose.vue'
import IconEdit from '@/components/icons/IconEdit.vue'
import IconPin from '@/components/icons/IconPin.vue'
import IconSearch from '@/components/icons/IconSearch.vue'
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
 */
/**
 * 工作区与知识库子菜单的开合状态（v0.15）。
 *
 * **默认都收起**：这两个子菜单的意义就是"把空间让给会话"，
 * 默认展开等于没改。会话所在的工作区会自动展开（见 `openWorkspaceIds` 的 watch）。
 */
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

const knowledgeBases = computed(() => store.items)

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
  // **没有「对话」这一项**（v0.17 去掉）：它与下面的会话列表、以及最上面的
  // 「新对话」是同一件事的三个入口——点「对话」是"回到最近一次对话"，
  // 而列表也是"去某次对话"，两者并排时用户会犹豫该点哪个。
  // Kimi Work / ChatGPT / Claude 都没有这一项：**会话列表本身就是那个入口**。
  // `/chat` 路由仍然在（新对话按钮与会话项都指向它），只是不再占一个导航位。
  { to: '/', label: '概览', icon: IconDashboard, exact: true },
  { to: '/notes', label: '笔记', icon: IconNote, exact: false },
  { to: '/memory', label: '记忆', icon: IconRobot, exact: false },
  // 能力的图标**不能用齿轮**：齿轮在账号菜单里是「设置」，同一个图标两种含义
  // 会让人以为这一项是设置（踩过：一眼看过去就是"两个设置"）。
  // 用 IconServer 与能力页里的 MCP 服务图标一致。
  { to: '/capabilities', label: '能力', icon: IconServer, exact: false },
  { to: '/tasks', label: '任务中心', icon: IconTasks, exact: false },
] as const

/** 知识库子菜单的入口（与 `NAV_ITEMS` 平级渲染，但带展开/收起）。 */
const KNOWLEDGE_GROUP = { to: '/knowledge-bases', label: '知识库', icon: IconLibrary } as const

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
const searchDraft = ref('')
let searchTimer: number | undefined

/**
 * 输入即搜，但**防抖 300ms**：每敲一个字发一次请求，在本地实例上也能看出卡顿，
 * 而且中文输入法在组字阶段会连续触发 input（"眼科"会打出 眼/眼轴/眼科 三次请求）。
 */
function onSearchInput(): void {
  window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => void conversations.load(searchDraft.value), 300)
}

function clearSearch(): void {
  searchDraft.value = ''
  window.clearTimeout(searchTimer)
  void conversations.load()
}

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
    <RouterLink v-if="!collapsed" class="new-chat" :to="{ path: '/chat', query: { new: '1' } }">
      <IconChatNew :size="18" />
      <span>新对话</span>
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
        <component :is="item.icon" class="nav-icon" />
        <span class="nav-label">{{ item.label }}</span>
      </RouterLink>

      <!--
        知识库：**收成子菜单**（v0.15）。它原先占一个顶级位置，却没承担该承担的
        导航——要进某个库还得先点"知识库"、再在页面里找。展开之后每个库一行，
        **点一次就到**；收起时只占一行。
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
          <component :is="KNOWLEDGE_GROUP.icon" class="nav-icon" />
          <span class="nav-label">{{ KNOWLEDGE_GROUP.label }}</span>
          <span class="nav-count tabular">{{ knowledgeBases.length }}</span>
          <IconChevronRight
            v-if="!collapsed"
            class="nav-chevron"
            :class="{ open: knowledgeOpen }"
            :size="13"
          />
        </button>
        <ul v-if="knowledgeOpen && !collapsed" class="nav-sub">
          <li>
            <RouterLink class="nav-sub-item" :to="KNOWLEDGE_GROUP.to">
              <IconLibrary :size="14" />
              <span>所有知识库</span>
            </RouterLink>
          </li>
          <li v-for="kb in knowledgeBases" :key="kb.id">
            <RouterLink class="nav-sub-item" :to="`/kb/${kb.id}`" :title="kb.name">
              <span class="nav-sub-name">{{ kb.name }}</span>
            </RouterLink>
          </li>
          <li v-if="!knowledgeBases.length" class="nav-sub-empty">还没有知识库</li>
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
      <div class="workspace-head">
        <p class="section-label">会话</p>
      </div>

      <p v-if="workspaces.error" class="side-note">{{ workspaces.error }}</p>

      <!-- 搜索放在这一节的**最上面**：它搜的是全部会话（后端按标题全局搜），
           位置就该在"全部会话"这个层级上。原先它嵌在「未归档会话」里面，
           看起来像只搜那一组。 -->
      <div v-if="conversations.items.length > 0 || searchDraft" class="conv-search">
        <IconSearch class="conv-search-icon" :size="14" />
        <AppInput
          v-model="searchDraft"
          class="conv-search-input"
          placeholder="搜索全部对话"
          aria-label="搜索对话"
          @input="onSearchInput"
        />
        <button
          v-if="searchDraft"
          type="button"
          class="conv-search-clear"
          aria-label="清除搜索"
          @click="clearSearch"
        >
          <IconClose :size="14" />
        </button>
      </div>

      <ul class="ws-list">
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
          <p v-else-if="conversations.items.length === 0 && searchDraft" class="side-note">
            没有标题匹配「{{ searchDraft }}」的对话。
          </p>
          <p v-else-if="conversations.items.length === 0" class="side-note">
            还没有对话。点最上面的「新对话」开始，记录会出现在这里。
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

/* 「新对话」= 整块的填充按钮，Kimi 的结构与取值：
   `BgGp-Secondary` 底 + 12px 圆角 + 44px 高 + `12px 8px` 内边距。
   它与侧栏底色是"浮起来一层"的关系，所以在任何主题下都读得出可点。 */
.new-chat {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  min-height: 44px;
  padding: var(--space-3) var(--space-2);
  margin-bottom: var(--space-2);
  font-size: var(--text-meta-size);
  font-weight: 500;
  color: var(--text-primary);
  text-decoration: none;
  background: var(--bg-group);
  border-radius: var(--radius-nav);
}

.new-chat:hover {
  background: var(--bg-hover);
}

/* 分区标签：侧栏宽一点以后，光靠留白已经分不开"导航"与下面这段。
   高度 28px 与左右 8px 内边距让它和下面「新对话」块的左边缘对齐——
   对不齐的话，扫视时会看到两条错开的起始线。
   字号取 14（Kimi 的分区标题是 ui-B2），不再加宽字距：
   加字距是"小号全大写西文"的习惯，中文上加字距只是变稀，不增加区分度。 */
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

.section-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--hit-target);
  height: var(--hit-target);
  border: none;
  background: none;
  border-radius: var(--radius-control);
  color: var(--text-tertiary);
  cursor: pointer;
}

.section-action:hover {
  background: var(--bg-active);
  color: var(--text-primary);
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
