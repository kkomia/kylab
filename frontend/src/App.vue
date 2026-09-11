<script setup lang="ts">
/**
 * 应用外壳（《前端设计规范》§5 布局骨架）。
 *
 * 侧栏 + 内容区；无卡片堆砌，分区靠留白与 1px 细线。
 * 知识库清单由侧栏统一加载一次，页面共用同一份 store 数据。
 *
 * 两条与登录相关的职责在这里：
 * 1. **登录页不套侧栏**——还没有身份，侧栏上的知识库、会话、设置都无从谈起；
 * 2. **会话失效的统一出口**：`request()` 发现 401 会递增 relogin 信号，
 *    这里跳登录页并记住原地址。放在外壳而不是每个页面里，是因为任何请求都可能失效。
 */
import { computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import SideNav from '@/components/layout/SideNav.vue'
import ToastStack from '@/components/ui/ToastStack.vue'
import { initFontScale } from '@/composables/useFontScale'
import { ensureAuthStatus, restoreSession } from '@/composables/useSession'
import { hasCredential, useReloginPrompt } from '@/composables/useSessionToken'
import { initTheme } from '@/composables/useTheme'
import { useKnowledgeBaseStore } from '@/stores/knowledgeBases'

const route = useRoute()
const router = useRouter()
const store = useKnowledgeBaseStore()

const isLoginPage = computed(() => route.name === 'login')

// index.html 的首屏脚本已经设过 --font-scale 与 data-theme；这里把 composable
// 的状态与那两个值对齐，好让设置页的选择器高亮在正确的档位上。不调用的话，
// 页面按存储的档位渲染，而选择器停在默认档——两处对不上。
initFontScale()
initTheme()

onMounted(async () => {
  const status = await ensureAuthStatus()
  // 还没有账号 → 用户会被送到首次设置向导；此时**不要**发业务请求：
  // 那些请求必然 401，只会在登录页顶上再弹一句"登录已过期"，而用户根本进不去。
  if (status?.needs_setup) return
  // 没有会话令牌 → 守卫已经把人送到登录页了，这里不必再发请求。
  if (!hasCredential()) return
  // 有令牌就验一次身份：界面靠 currentUser 决定页脚显示谁的名字、给不给管理员入口。
  await restoreSession()
  void store.load()
})

const { reloginCount } = useReloginPrompt()

watch(reloginCount, () => {
  if (isLoginPage.value) return
  void router.push({ name: 'login', query: { redirect: route.fullPath } })
})
</script>

<template>
  <div class="shell" :class="{ 'shell-bare': isLoginPage }">
    <SideNav v-if="!isLoginPage" />
    <main class="content">
      <RouterView />
    </main>
    <ToastStack />
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  height: 100%;
}

.content {
  flex: 1;
  min-width: 0;
  background: var(--bg-surface);
  overflow-y: auto;
}

/* 登录页撑满整个窗口，底色用画布而不是内容区的纸白 */
.shell-bare .content {
  background: var(--bg-canvas);
}
</style>
