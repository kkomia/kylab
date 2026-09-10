<script setup lang="ts">
/**
 * 导航侧栏（《前端设计规范 v0.3》§5）。
 *
 * 结构：产品名 → 导航（概览 / 检索 / 任务 / 设置）→ 知识库列表 → 底部主题切换与服务状态。
 *
 * 侧栏自己管两件事：知识库导航列表、后端连通性。都是"全局状态"，
 * 放在这里而不是各页面各查一遍——同一次操作后出现两处不一致是最常见的界面 bug。
 */
import { onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'

import { fetchHealth } from '@/api/health'
import { listKnowledgeBases, type KnowledgeBase } from '@/api/knowledgeBases'
import IconLibrary from '@/components/icons/IconLibrary.vue'
import IconLogo from '@/components/icons/IconLogo.vue'
import IconMoon from '@/components/icons/IconMoon.vue'
import IconSearch from '@/components/icons/IconSearch.vue'
import IconSettings from '@/components/icons/IconSettings.vue'
import IconSun from '@/components/icons/IconSun.vue'
import IconTasks from '@/components/icons/IconTasks.vue'
import { useTheme } from '@/composables/useTheme'

const { theme, toggleTheme } = useTheme()
const route = useRoute()

const knowledgeBases = ref<KnowledgeBase[]>([])
const kbError = ref('')

async function refreshKnowledgeBases(): Promise<void> {
  try {
    knowledgeBases.value = (await listKnowledgeBases()).items
    kbError.value = ''
  } catch (error) {
    kbError.value = error instanceof Error ? error.message : '知识库列表加载失败'
  }
}

/** 服务状态双编码：图标 + 文字（§8 必须项），不靠颜色单独表意。 */
type ServiceState = 'checking' | 'online' | 'offline'
const serviceState = ref<ServiceState>('checking')
const serviceDetail = ref('正在检测后端服务')

async function checkService(): Promise<void> {
  try {
    const health = await fetchHealth()
    serviceState.value = 'online'
    serviceDetail.value = `后端在线 · v${health.version} · ${health.api_version}`
  } catch (error) {
    serviceState.value = 'offline'
    serviceDetail.value = error instanceof Error ? error.message : '后端不可达'
  }
}

onMounted(() => {
  void refreshKnowledgeBases()
  void checkService()
})

/** 新建/删除知识库后由页面调用，避免侧栏与页面各存一份列表。 */
defineExpose({ refreshKnowledgeBases, checkService })

const NAV_ITEMS = [
  { to: '/', label: '概览', icon: IconLibrary, exact: true },
  { to: '/search', label: '检索调试台', icon: IconSearch, exact: false },
  { to: '/tasks', label: '任务中心', icon: IconTasks, exact: false },
  { to: '/settings', label: '设置', icon: IconSettings, exact: false },
] as const

function isActive(to: string, exact: boolean): boolean {
  return exact ? route.path === to : route.path.startsWith(to)
}
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

    <div class="kb-section">
      <p class="section-label">知识库</p>
      <p v-if="kbError" class="kb-error">{{ kbError }}</p>
      <p v-else-if="knowledgeBases.length === 0" class="kb-empty">还没有知识库</p>
      <ul v-else class="kb-list">
        <li v-for="kb in knowledgeBases" :key="kb.id">
          <RouterLink
            class="kb-item"
            :class="{ 'kb-item-active': route.path.startsWith(`/kb/${kb.id}`) }"
            :to="`/kb/${kb.id}`"
            :title="kb.name"
          >
            {{ kb.name }}
          </RouterLink>
        </li>
      </ul>
    </div>

    <div class="sidebar-foot">
      <button
        class="theme-toggle"
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
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  width: var(--sidebar-width);
  flex: 0 0 var(--sidebar-width);
  background: var(--bg-canvas);
  border-right: 1px solid var(--border);
  overflow: hidden;
}

.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px;
  color: var(--text-primary);
}

.brand-name {
  font-weight: 600;
}

.nav {
  display: flex;
  flex-direction: column;
  padding: 0 8px 8px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  color: var(--text-primary);
  text-decoration: none;
  border-radius: var(--radius-control);
}

.nav-item:hover {
  background: var(--bg-hover);
}

.nav-icon {
  color: var(--text-secondary);
}

/* 选中项：--bg-active + 左侧 2px 指示条（§5） */
.nav-item-active {
  position: relative;
  background: var(--bg-active);
}

.nav-item-active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 6px;
  bottom: 6px;
  width: 2px;
  background: var(--text-secondary);
}

.kb-section {
  flex: 1;
  min-height: 0;
  padding: 8px;
  overflow-y: auto;
  border-top: 1px solid var(--border);
}

.section-label {
  margin: 8px 10px 4px;
  font-size: 12px;
  color: var(--text-tertiary);
}

.kb-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.kb-item {
  display: block;
  padding: 5px 10px;
  overflow: hidden;
  color: var(--text-secondary);
  text-decoration: none;
  text-overflow: ellipsis;
  white-space: nowrap;
  border-radius: var(--radius-control);
}

.kb-item:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.kb-item-active {
  background: var(--bg-active);
  color: var(--text-primary);
}

.kb-empty,
.kb-error {
  margin: 4px 10px;
  font-size: 13px;
  color: var(--text-tertiary);
}

.kb-error {
  color: var(--status-danger);
}

.sidebar-foot {
  padding: 12px 16px;
  border-top: 1px solid var(--border);
}

.theme-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  color: var(--text-secondary);
  border-radius: var(--radius-control);
}

.theme-toggle:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.service {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--text-secondary);
}

.service-icon {
  display: inline-flex;
  margin-top: 3px;
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
