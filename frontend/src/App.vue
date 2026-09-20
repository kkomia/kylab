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
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import ConversationHistoryPanel from '@/components/layout/ConversationHistoryPanel.vue'
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

/** 历史会话面板的开合（侧栏「查看全部」触发）。 */
const historyOpen = ref(false)

/**
 * 换页就把它关掉（v0.26，用户报的 bug："看了历史会话之后点其他菜单没反应"）。
 *
 * 它是一块**盖住内容区的浮层**（`inset: 0 0 0 var(--sidebar-width)`），
 * 而侧栏故意留在它左边——这样用户能一边翻历史一边切页。代价是：
 * 不主动关的话，点了「笔记」路由确实变了，可内容区上还压着历史会话那一屏，
 * 用户看到的就是"点了没反应，切不过去"。**浮层没关，等于菜单没坏但用不了。**
 *
 * 挂在路由上而不是逐个菜单去关：`fullPath` 一变就关，拖住的是"任何一次跳转"，
 * 以后新加的页面不用记得这一条。
 */
watch(
  () => route.fullPath,
  () => {
    historyOpen.value = false
  },
)

watch(reloginCount, () => {
  if (isLoginPage.value) return
  void router.push({ name: 'login', query: { redirect: route.fullPath } })
})
</script>

<template>
  <div class="shell" :class="{ 'shell-bare': isLoginPage }">
    <SideNav v-if="!isLoginPage" @open-history="historyOpen = true" />
    <main class="content">
      <RouterView />
    </main>

    <!--
      历史会话面板（v0.17，照 Kimi 的做法）：由侧栏「对话」一节的「查看全部」打开。
      **挂在 shell 这一层**而不是某个页面里：侧栏在每个页面都在，
      从任何页面点「查看全部」都该能打开它。用 Teleport 是让 fixed 定位
      不受 `.content` 的 overflow 影响（那正是"面板被裁一半"的常见成因）。
    -->
    <ConversationHistoryPanel :open="historyOpen" @close="historyOpen = false" />

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
  /* 内容区是**暖底的地面**，面板/卡片才是抬起来的白层（Kimi 的层级方向）。
     此前这里放的是纸白，与面板同色，于是"面板"这个概念其实没被画出来。 */
  background: var(--bg-canvas);
  overflow-y: auto;
}

/* 登录页撑满整个窗口，底色用画布而不是内容区的纸白 */
.shell-bare .content {
  background: var(--bg-canvas);
}
</style>
