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
import { onMounted, ref } from 'vue'
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
import { useKnowledgeBaseStore } from '@/stores/knowledgeBases'

const { theme, toggleTheme } = useTheme()
const route = useRoute()
const store = useKnowledgeBaseStore()

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
      侧栏下半部分原本是「最近文档」列表，现在换成一句指路：
      用户在这一栏里真正缺的不是"我最近传了什么"，而是"这里能拿知识库干什么"。
      列表还占着最显眼的位置，却只重复了知识库卡片页已有的信息。
    -->
    <div class="side-section">
      <p class="section-label">对话</p>
      <p class="side-note">在上面「对话」里向知识库提问，回答会带原文引用。</p>
    </div>

    <div class="sidebar-foot">
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

/* 侧栏下半部分：一句关于「对话」的指路。flex:1 占住剩余高度，
   底部的主题/设置始终贴在窗口底部，不随说明文字的长短上下浮动 */
.side-section {
  flex: 1;
  min-height: 0;
  padding: var(--space-3) var(--space-2) var(--space-2);
  overflow-y: auto;
  border-top: 1px solid var(--border-hairline);
}

/* 分区标签：侧栏宽一点以后，光靠留白已经分不开"导航"与下面这段。
   小号 + 加宽字距 + 弱色——它只是一个"这里是另一段"的路标，不该跟可点项抢注意力。 */
.section-label {
  margin: 0 0 var(--space-2);
  padding: 0 var(--space-2);
  font-size: var(--text-micro-size);
  font-weight: 500;
  letter-spacing: 0.06em;
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
