<script setup lang="ts">
/**
 * 导航侧栏（《前端设计规范》§5）。
 *
 * 结构：产品名 → 导航（概览 / 知识库 / 对话 / 任务中心）→ 对话列表 → 页脚（账号 / 设置）。
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
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import IconChat from '@/components/icons/IconChat.vue'
import IconChevronDown from '@/components/icons/IconChevronDown.vue'
import IconDashboard from '@/components/icons/IconDashboard.vue'
import IconLibrary from '@/components/icons/IconLibrary.vue'
import IconLogo from '@/components/icons/IconLogo.vue'
import IconLogout from '@/components/icons/IconLogout.vue'
import IconSettings from '@/components/icons/IconSettings.vue'
import IconSun from '@/components/icons/IconSun.vue'
import IconTasks from '@/components/icons/IconTasks.vue'
import IconUser from '@/components/icons/IconUser.vue'
import SettingsModal from '@/components/settings/SettingsModal.vue'
import { loadRoster, roster, setOperator } from '@/composables/useOperator'
import { useConsoleTokenPrompt } from '@/composables/useConsoleToken'
import { isAdmin, logout as logoutSession } from '@/composables/useSession'
import { currentUser } from '@/composables/useSessionToken'
import { resolvedTheme, setTheme } from '@/composables/useTheme'
import { useConversationStore } from '@/stores/conversations'
import { useKnowledgeBaseStore } from '@/stores/knowledgeBases'

const route = useRoute()
const router = useRouter()
const store = useKnowledgeBaseStore()
const conversations = useConversationStore()

onMounted(async () => {
  if (store.items.length === 0) await store.load()
  void store.loadSummaries()
  void conversations.load()
  // 名册只用于显示"文档是谁传的"这一列（不再有切换使用者的入口）
  void loadRoster()
})

const NAV_ITEMS = [
  { to: '/', label: '概览', icon: IconDashboard, exact: true },
  { to: '/knowledge-bases', label: '知识库', icon: IconLibrary, exact: false },
  { to: '/chat', label: '对话', icon: IconChat, exact: false },
  { to: '/tasks', label: '任务中心', icon: IconTasks, exact: false },
] as const

function isActive(to: string, exact: boolean): boolean {
  return exact ? route.path === to : route.path.startsWith(to)
}

/**
 * 设置入口只给管理员 / 控制台令牌通道。
 *
 * 设置页里是 embedding / LLM 密钥与用户管理，后端对成员一律 403
 * （`require_console`）。把一个点进去只会报错的入口摆在侧栏，比不显示更糟。
 */
const canOpenSettings = computed(() => currentUser.value === null || isAdmin.value)

/** 当前会话 id：从路径里取，用来高亮列表里那一条。 */
const activeConversationId = computed(() => {
  const matched = /^\/chat\/([^/]+)$/.exec(route.path)
  return matched ? matched[1] : ''
})

/** 设置从页面收进弹窗：它是动作，做完就走（《界面信息架构草案》§1）。 */
const settingsOpen = ref(false)

/**
 * 401 兜底：request() 收到 401 会递增 promptCount，这里打开设置弹窗并直接
 * 落到「系统与安全」的令牌输入框。没有这层，用户只会在每个页面收到一句
 * "缺少凭据"，而**没有任何恢复入口**（useConsoleToken.ts 的头部注释讲了这个坑）。
 */
const { promptCount } = useConsoleTokenPrompt()
const settingsInitialSection = ref<string | undefined>(undefined)

watch(promptCount, () => {
  settingsInitialSection.value = 'system'
  settingsOpen.value = true
})

/** 从按钮打开是一次全新浏览：清掉 401 流程留下的定位，回到默认分组。 */
function openSettings(): void {
  settingsInitialSection.value = undefined
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
 * 没有登录账号时显示「控制台」——那是这台机器上**真正的**身份：
 * 控制台令牌通道 / 局域网开放模式下，后端认的就是控制台，
 * 写成"未登录"会让人以为进不去，而实际上他是完全授权的。
 */
const identityName = computed(() => currentUser.value?.name ?? '控制台')
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
  <aside class="sidebar">
    <!-- 字标自带 "KYLAB" 字样，不再并排写一遍品牌名（重复反而削弱标识性） -->
    <div class="brand">
      <IconLogo :size="24" />
    </div>

    <nav class="nav" aria-label="主导航">
      <RouterLink
        v-for="item in NAV_ITEMS"
        :key="item.to"
        class="nav-item"
        :class="{ 'nav-item-active': isActive(item.to, item.exact) }"
        :to="item.to"
      >
        <component :is="item.icon" class="nav-icon" />
        <span>{{ item.label }}</span>
      </RouterLink>
    </nav>

    <!--
      侧栏下半部分：**会话列表**。
      这块位置最早是「最近文档」，后来换成一句指路的占位——因为用户在这一栏里真正
      需要的不是"我最近传了什么"，而是"我最近问过什么"。对话留存做完之后，它终于有东西可放。
    -->
    <div class="side-section">
      <div class="section-head">
        <p class="section-label">对话</p>
        <RouterLink class="section-action" to="/chat" title="开始新对话">新对话</RouterLink>
      </div>

      <p v-if="conversations.error" class="side-note">{{ conversations.error }}</p>
      <p v-else-if="conversations.items.length === 0" class="side-note">
        还没有对话。在上面「对话」里提问，这里会留下记录。
      </p>
      <ul v-else class="conv-list">
        <li v-for="item in conversations.items" :key="item.id">
          <RouterLink
            class="conv-item"
            :class="{ 'conv-item-active': item.id === activeConversationId }"
            :to="`/chat/${item.id}`"
            :title="item.title || '未命名对话'"
          >
            <span class="conv-title">{{ item.title || '未命名对话' }}</span>
            <span class="conv-meta tabular">{{ item.message_count }} 条</span>
          </RouterLink>
        </li>
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
          <!-- 只有真的能登录时才给「退出登录」：控制台令牌通道没有会话可退 -->
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

    <SettingsModal
      v-model:open="settingsOpen"
      :initial-section="settingsInitialSection"
      @logout="onLogout"
    />
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
}

.brand {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-4) var(--space-4) var(--space-3);
  color: var(--text-primary);
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
  font-size: var(--text-body-size);
  color: var(--text-secondary);
  text-decoration: none;
  border-radius: var(--radius-control);
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

/* 分区标签与"新对话"同一行：后者是个动作，贴着它所属的那一段放，
   比另起一行更容易被理解为"在这一段里新建" */
.section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
  padding: 0 var(--space-2);
  margin-bottom: var(--space-2);
}

.section-action {
  flex: 0 0 auto;
  font-size: var(--text-micro-size);
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

.conv-list {
  margin: 0;
  padding: 0;
  list-style: none;
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

/* 名字吃掉剩余宽度（同样给角色与折叠箭头让位） */
.account-name {
  flex: 1;
  overflow: hidden;
  font-size: var(--text-meta-size);
  font-weight: 500;
  color: var(--text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.account-role {
  flex: 0 0 auto;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.account-caret {
  flex: 0 0 auto;
  color: var(--text-tertiary);
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
