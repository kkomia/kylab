<script setup lang="ts">
/**
 * `/documents/:id` 只是**跳板**——详情现在是文档列表页上滑出的抽屉。
 *
 * 为什么保留这条路径：引用、旧书签、聊天里的"查看原文"都指向它，改掉就会断链。
 * 所以这里只做一件事：查出这份文档属于哪个知识库，然后换到
 * `/kb/{kbId}?doc={id}`——列表页见到 `doc` 参数就把抽屉滑出来。
 *
 * 代价是一次重定向加一次取文档的请求；换来的是"详情只有一种呈现方式"，
 * 不必同时维护"独立页"与"抽屉"两套。
 */
import { onMounted, ref } from 'vue'

import { useRoute, useRouter } from 'vue-router'

import { getDocument } from '@/api/documents'

const route = useRoute()
const router = useRouter()
const error = ref('')

onMounted(async () => {
  const id = String(route.params.documentId ?? '')
  try {
    const document = await getDocument(id)
    // `page` 是引用带进来的页码，换到列表页时要一起带过去（PDF 查看器靠它跳页）
    const page = route.query.page
    await router.replace({
      path: `/kb/${document.knowledge_base_id}`,
      query: page ? { doc: id, page: String(page) } : { doc: id },
    })
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '打不开这份文档'
  }
})
</script>

<template>
  <div class="page-shell document-redirect">
    <p class="redirect-note">{{ error || '正在打开文档…' }}</p>
  </div>
</template>

<style scoped>
.document-redirect {
  align-items: center;
  justify-content: center;
}

.redirect-note {
  margin: 0;
  font-size: var(--text-meta-size);
  color: var(--text-tertiary);
}
</style>
