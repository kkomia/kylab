<script setup lang="ts">
/**
 * 导航侧栏（《前端设计规范》§5）。
 *
 * 结构：产品名 → 导航（概览 / 知识库 / 对话 / 任务中心）→ 对话说明 → 底部主题切换与服务状态。
 *
 * 知识库清单取自 store：侧栏与概览页是同一份数据，
 * 各查一遍就会出现"新建之后这边有、那边没有"这类不同步。
 * 侧栏自己只管后端连通性。
 *
 * 检索没有独立入口：它是"在某个库里查东西"，收在知识库详情页里；
 * 跨库问答则收在「对话」页——那里的问题是"这些库里怎么说"，不是"哪个块最像"。
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'

import { fetchHealth } from '@/api/health'
import IconChat from '@/components/icons/IconChat.vue'
import IconDashboard from '@/components/icons/IconDashboard.vue'
import IconLibrary from '@/components/icons/IconLibrary.vue'
import IconLogo from '@/components/icons/IconLogo.vue'
import IconMoon from '@/components/icons/IconMoon.vue'
import IconSettings from '@/components/icons/IconSettings.vue'
import IconSun from '@/components/icons/IconSun.vue'
import IconTasks from '@/components/icons/IconTasks.vue'
import SettingsModal from '@/components/settings/SettingsModal.vue'
import { useTheme } from '@/composables/useTheme'
import { loadRoster, operator, operatorId, roster, setOperator } from '@/composables/useOperator'
import { useConversationStore } from '@/stores/conversations'
import { useKnowledgeBaseStore } from '@/stores/knowledgeBases'

const { theme, toggleTheme } = useTheme()
const route = useRoute()
const store = useKnowledgeBaseStore()
const conversations = useConversationStore()

/** 服务状态双编码：图标 + 文字（§8 必须项），不靠颜色单独表意。 */
type ServiceState = 'checking' | 'online' | 'offline'
const serviceState = ref<ServiceState>('checking')
const serviceDetail = ref('正在检测后端服务')

async function checkService(): Promise<void> {
  try {
    const health = await fetchHealth()
    serviceState.value = 'online'
    // 只留版本号：接口版本在这一行里没有决策价值，设置页有专门两项
    serviceDetail.value = `后端在线 · v${health.version}`
  } catch (error) {
    serviceState.value = 'offline'
    serviceDetail.value = error instanceof Error ? error.message : '后端不可达'
  }
}

onMounted(async () => {
  void checkService()
  if (store.items.length === 0) await store.load()
  void store.loadSummaries()
  void conversations.load()
  // 名册是可选功能：拿不到就不显示选择器，不报错
  void loadRoster()
})

defineExpose({ checkService })

const NAV_ITEMS = [
  { to: '/', label: '概览', icon: IconDashboard, exact: true },
  { to: '/knowledge-bases', label: '知识库', icon: IconLibrary, exact: false },
  { to: '/chat', label: '对话', icon: IconChat, exact: false },
  { to: '/tasks', label: '任务中心', icon: IconTasks, exact: false },
] as const

function isActive(to: string, exact: boolean): boolean {
  return exact ? route.path === to : route.path.startsWith(to)
}

/** 当前使用者（G6）。空 = 名册里没选人，上传归到"未记录"。 */
const operatorName = computed(() => operator.value?.name ?? '')

/** 当前会话 id：从路径里取，用来高亮列表里那一条。 */
const activeConversationId = computed(() => {
  const matched = /^\/chat\/([^/]+)$/.exec(route.path)
  return matched ? matched[1] : ''
})

/** 设置从页面收进弹窗：它是动作，做完就走（《界面信息架构草案》§1）。 */
const settingsOpen = ref(false)
</script>

<template>
  <aside class="sidebar">
    <div class="brand">
      <IconLogo />
      <span class="brand-name">KYLAB 知识库</span>
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
        当前使用者（G6）。**放在页脚而不是页头**：它是"我的身份"这类静态信息，
        不是每页都要操作的东西；页脚与主题/设置同级，符合"这里是环境设置"的语感。
        名册没配人时不占位——名册是可选的，空着比显示一个空下拉干净。
      -->
      <div v-if="roster.length || operatorName" class="identity">
        <label class="identity-label" for="kylab-operator">当前使用者</label>
        <select
          id="kylab-operator"
          class="identity-select"
          :value="operatorId"
          @change="setOperator(($event.target as HTMLSelectElement).value)"
        >
          <option value="">未指定（上传不记归属）</option>
          <option v-for="person in roster" :key="person.id" :value="person.id">
            {{ person.name }}
          </option>
        </select>
      </div>

      <button class="foot-action" type="button" @click="settingsOpen = true">
        <IconSettings />
        <span>设置</span>
      </button>

      <button
        class="foot-action"
        type="button"
        :aria-label="theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'"
        @click="toggleTheme"
      >
        <IconSun v-if="theme === 'dark'" />
        <IconMoon v-else />
        <span>{{ theme === 'dark' ? '浅色主题' : '深色主题' }}</span>
      </button>

      <p class="service" :class="`service-${serviceState}`">
        <span class="service-icon">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="9" />
            <path v-if="serviceState === 'online'" d="M8 12.5l2.5 2.5L16 9.5" />
            <path v-else d="M12 7.5v5M12 16h.01" />
          </svg>
        </span>
        <span class="service-text">{{ serviceDetail }}</span>
      </p>
    </div>

    <SettingsModal v-model:open="settingsOpen" />
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

.brand-name {
  font-weight: 600;
  letter-spacing: -0.005em;
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

/* 使用者选择：与页脚其他项同宽，但标签在上、下拉在下——
   一个 select 直接顶着"设置"按钮会让人以为它也是可点即走的动作 */
.identity {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: 0 var(--space-2) var(--space-2);
}

.identity-label {
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.identity-select {
  width: 100%;
  min-height: var(--hit-target);
  padding: 0 var(--space-2);
  font-family: inherit;
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
  background: var(--bg-surface);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-control);
}

.sidebar-foot {
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--border-hairline);
}

.foot-action {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 32px;
  padding: 0 var(--space-2);
  font-size: var(--text-body-size);
  color: var(--text-secondary);
  border-radius: var(--radius-control);
}

.foot-action:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.service {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: var(--space-2) 0 0;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.service-text {
  overflow: hidden;
  text-overflow: ellipsis;
}

.service-icon {
  display: inline-flex;
  margin-top: var(--space-1);
  flex: 0 0 auto;
}

/* 语义色只用于状态传达（§2.3） */
.service-online .service-icon {
  color: var(--status-success);
}

.service-offline .service-icon {
  color: var(--status-danger);
}

.service-checking .service-icon {
  color: var(--status-info);
}
</style>
