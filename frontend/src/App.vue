<script setup lang="ts">
/**
 * 应用外壳（《前端设计规范 v0.3》§5 布局骨架）。
 *
 * 侧栏 240px + 内容区；无卡片堆砌，分区靠留白与 1px 细线。
 * 知识库清单在这里统一加载一次，侧栏与页面共用同一份 store 数据。
 */
import { onMounted } from 'vue'

import SideNav from '@/components/layout/SideNav.vue'
import ToastStack from '@/components/ui/ToastStack.vue'
import { useKnowledgeBaseStore } from '@/stores/knowledgeBases'

const store = useKnowledgeBaseStore()

onMounted(() => {
  void store.load()
})
</script>

<template>
  <div class="shell">
    <SideNav />
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
</style>
