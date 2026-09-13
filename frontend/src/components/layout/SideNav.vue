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

import IconChat from '@/components/icons/IconChat.vue'
import IconChatNew from '@/components/icons/IconChatNew.vue'
import IconClose from '@/components/icons/IconClose.vue'
import IconEdit from '@/components/icons/IconEdit.vue'
import IconPin from '@/components/icons/IconPin.vue'
import IconSearch from '@/components/icons/IconSearch.vue'
import IconTrash from '@/components/icons/IconTrash.vue'
import IconChevronDown from '@/components/icons/IconChevronDown.vue'
import IconDashboard from '@/components/icons/IconDashboard.vue'
import IconLibrary from '@/components/icons/IconLibrary.vue'
import IconLogo from '@/components/icons/IconLogo.vue'
import IconLogout from '@/components/icons/IconLogout.vue'
import IconNote from '@/components/icons/IconNote.vue'
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
import { useStatsStore } from '@/stores/stats'
import { useToast } from '@/composables/useToast'
import { useTaskStore } from '@/stores/tasks'

const route = useRoute()
const router = useRouter()
const store = useKnowledgeBaseStore()
const conversations = useConversationStore()
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

const NAV_ITEMS = [
  { to: '/chat', label: '对话', icon: IconChat, exact: false },
  { to: '/', label: '概览', icon: IconDashboard, exact: true },
  { to: '/knowledge-bases', label: '知识库', icon: IconLibrary, exact: false },
  { to: '/notes', label: '笔记', icon: IconNote, exact: false },
  { to: '/tasks', label: '任务中心', icon: IconTasks, exact: false },
] as const

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
    </nav>

    <!--
      侧栏下半部分：**会话列表**。
      这块位置最早是「最近文档」，后来换成一句指路的占位——因为用户在这一栏里真正
      需要的不是"我最近传了什么"，而是"我最近问过什么"。对话留存做完之后，它终于有东西可放。
    -->
    <div v-if="!collapsed" class="side-section">
      <div class="section-head">
        <p class="section-label">对话</p>
        <!-- 带上 `?new=1` 才是"新建"。裸 `/chat` 现在表示"回到最近一次对话"
             （见 ChatView 的 enterChat）——两个入口共用一条链接时，
             从知识库返回也会落在空态上，看起来就像"又给我开了个新对话"。 -->
        <RouterLink class="section-action" :to="{ path: '/chat', query: { new: '1' } }">
          <IconChatNew :size="16" />
          <span>新对话</span>
        </RouterLink>
      </div>

      <!-- 搜索只在有内容时出现：一个空列表下面挂个搜索框，是在问"你要找什么"，
           可用户手里什么也没有 -->
      <div v-if="conversations.items.length > 0 || searchDraft" class="conv-search">
        <IconSearch class="conv-search-icon" :size="14" />
        <AppInput
          v-model="searchDraft"
          class="conv-search-input"
          placeholder="搜索对话"
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

      <p v-if="conversations.error" class="side-note">{{ conversations.error }}</p>
      <p v-else-if="conversations.items.length === 0 && searchDraft" class="side-note">
        没有标题匹配「{{ searchDraft }}」的对话。
      </p>
      <p v-else-if="conversations.items.length === 0" class="side-note">
        还没有对话。在上面「对话」里提问，这里会留下记录。
      </p>
      <ul v-else class="conv-list">
        <li v-for="item in conversations.items" :key="item.id" class="conv-row">
          <RouterLink
            class="conv-item"
            :class="{ 'conv-item-active': item.id === activeConversationId }"
            :to="`/chat/${item.id}`"
            :title="item.title || '未命名对话'"
            @mouseenter="onConversationIntent(item.id)"
            @focus="onConversationIntent(item.id)"
          >
            <!-- 置顶标记占位固定宽：不占位的话，置顶与否会让标题左右跳动 -->
            <IconPin v-if="item.pinned" class="conv-pin" :size="12" />
            <span class="conv-title">{{ item.title || '未命名对话' }}</span>
            <span class="conv-meta tabular">{{ item.message_count }} 条</span>
          </RouterLink>
          <!-- 行菜单：悬停/聚焦/当前项才显示。侧栏只有 248px，每行常驻一个"…"
               会把标题挤到只剩十来个字 -->
          <RowMenu class="conv-menu" :label="`${item.title || '未命名对话'} 的操作`">
            <template #default="{ close }">
              <button type="button" @click="(togglePin(item), close())">
                <IconPin :size="14" /> {{ item.pinned ? '取消置顶' : '置顶' }}
              </button>
              <button type="button" @click="(openRename(item), close())">
                <IconEdit :size="14" /> 重命名
              </button>
              <button class="menu-item-danger" type="button" @click="(openDelete(item), close())">
                <IconTrash :size="14" /> 删除
              </button>
            </template>
          </RowMenu>
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
  min-height: 56px;
  padding: var(--space-4) var(--space-4) var(--space-3);
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

/* 行高 36px = 8 + 20 + 8，落在 4px 阶梯上；侧栏项与知识库项字号统一 13.5px */
.nav-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 36px;
  padding: 0 var(--space-2);
  overflow: hidden;
  font-size: var(--text-body-size);
  color: var(--text-secondary);
  text-decoration: none;
  border-radius: var(--radius-control);
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
  color: var(--text-tertiary);
}

/* 选中项：浅品牌色底 + 左侧 2px 品牌色指示条（§5）。
   全站唯一用品牌色的地方就在这里与主按钮、图表——它们是"当前在哪 / 该点哪里" */
.nav-item-active {
  position: relative;
  color: var(--accent-text);
  background: var(--accent-soft);
}

.nav-item-active .nav-icon {
  color: var(--accent);
}

.nav-item-active::before {
  content: '';
  position: absolute;
  left: 0;
  top: var(--space-2);
  bottom: var(--space-2);
  width: 2px;
  background: var(--accent);
  border-radius: 1px;
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

/* 分区标签与「新对话」同一行：动作贴着它所属的那一段放，
   比另起一行更容易被理解为"在这一段里新建"。
   `center` 而不是 `baseline`——右侧是图标 + 文字，基线对齐会让图标相对文字上下偏 */
.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: 0 var(--space-2);
  margin-bottom: var(--space-2);
}

/* 「新对话」= 图标 + 文字（用户给的参考图就是这个样子：气泡图标 +加粗的动作名）。
   左侧那个「对话」是这段列表的路标（小号、弱色），右侧这个是**动作**，两者职责不同，
   所以不冲突——就像 "Chats  ·  New chat" 那样一行里各占一边。 */
.section-action {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--text-micro-size);
  font-weight: 500;
  color: var(--accent-text);
}

.section-action:hover {
  text-decoration: underline;
}

/* 分区标签：侧栏宽一点以后，光靠留白已经分不开"导航"与下面这段。
   小号 + 加宽字距 + 弱色——它只是一个"这里是另一段"的路标，不该跟可点项抢注意力。 */
.section-label {
  margin: 0;
  font-size: var(--text-micro-size);
  font-weight: 500;
  letter-spacing: 0.06em;
  color: var(--text-tertiary);
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
  transition: opacity 120ms ease;
}

.conv-row:hover .conv-menu,
.conv-row:focus-within .conv-menu,
.conv-menu:focus-within {
  opacity: 1;
}

/* 菜单出现时把「N 条」隐掉：两者在同一个位置，**先隐后现而不是叠在一起**。
   条数没被删掉，移开鼠标就回来；行宽 231px，塞不下两个并排的元素 */
.conv-meta {
  transition: opacity 120ms ease;
}

.conv-row:hover .conv-meta,
.conv-row:focus-within .conv-meta {
  opacity: 0;
}

/* 置顶标记：固定宽度，置顶与否不会让标题左右跳动 */
.conv-pin {
  flex: 0 0 auto;
  color: var(--accent-text);
}

.conv-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  min-height: 32px;
  padding: 0 var(--space-2);
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
  text-decoration: none;
  border-radius: var(--radius-control);
}

.conv-item:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

/* 选中态与主导航用同一套语言：浅品牌底 + 品牌色文字 */
.conv-item-active {
  color: var(--accent-text);
  background: var(--accent-soft);
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
</style>
