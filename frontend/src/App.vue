<script setup lang="ts">
/**
 * 应用外壳（《前端设计规范 v0.1》§5 布局骨架）。
 * 侧栏 240px（可收起）+ 内容区；无卡片堆砌，分区靠留白与 1px 细线。
 */
import { onMounted, ref } from 'vue'

import { fetchHealth } from '@/api/health'
import IconLogo from '@/components/icons/IconLogo.vue'
import IconMoon from '@/components/icons/IconMoon.vue'
import IconSun from '@/components/icons/IconSun.vue'
import { useTheme } from '@/composables/useTheme'

const { theme, toggleTheme } = useTheme()

/** 服务状态双编码：图标 + 文字（§8 必须项），不靠颜色单独表意。 */
type ServiceState = 'checking' | 'online' | 'offline'
const serviceState = ref<ServiceState>('checking')
const serviceDetail = ref('正在检测后端服务')

onMounted(async () => {
  try {
    const health = await fetchHealth()
    serviceState.value = 'online'
    serviceDetail.value = `后端在线 · v${health.version} · ${health.api_version}`
  } catch (error) {
    serviceState.value = 'offline'
    serviceDetail.value = error instanceof Error ? error.message : '后端不可达'
  }
})
</script>

<template>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">
        <IconLogo />
        <span class="brand-name">KYLAB 知识库</span>
      </div>

      <nav class="nav">
        <RouterLink class="nav-item" to="/">概览</RouterLink>
      </nav>

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
          <span class="service-icon" aria-hidden="true">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <circle cx="12" cy="12" r="9" />
              <path v-if="serviceState === 'online'" d="M8 12.5l2.5 2.5L16 9.5" />
              <path v-else-if="serviceState === 'offline'" d="M12 7.5v5M12 16h.01" />
              <path v-else d="M12 7.5v5M12 16h.01" />
            </svg>
          </span>
          <span class="service-text">{{ serviceDetail }}</span>
        </p>
      </div>
    </aside>

    <main class="content">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  height: 100%;
}

.sidebar {
  display: flex;
  flex-direction: column;
  width: var(--sidebar-width);
  flex: 0 0 var(--sidebar-width);
  background: var(--bg-canvas);
  border-right: 1px solid var(--border);
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
  padding: 8px;
}

.nav-item {
  padding: 6px 10px;
  border-radius: var(--radius-control);
  color: var(--text-primary);
  text-decoration: none;
}

.nav-item:hover {
  background: var(--bg-hover);
}

/* 选中项：--bg-active + 左侧 2px 指示条（§5） */
.nav-item.router-link-exact-active {
  position: relative;
  background: var(--bg-active);
}

.nav-item.router-link-exact-active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 6px;
  bottom: 6px;
  width: 2px;
  background: var(--text-secondary);
}

.sidebar-foot {
  margin-top: auto;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
}

.theme-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border-radius: var(--radius-control);
  color: var(--text-secondary);
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

.content {
  flex: 1;
  min-width: 0;
  background: var(--bg-surface);
  overflow-y: auto;
}
</style>
