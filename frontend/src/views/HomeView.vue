<script setup lang="ts">
/**
 * 概览页（M0 骨架）。
 * 完整控制台页面（知识库树 / 文件列表 / 任务中心 / 检索调试台 / 设置）
 * 在 M5 里程碑按《前端设计规范 v0.1》§6 落地。
 */
</script>

<template>
  <article class="page">
    <header class="page-head">
      <h1>概览</h1>
    </header>

    <section class="page-body">
      <h2>当前进度</h2>
      <p class="muted">
        M0 地基已完成：接口版本化（/api/v1）、双主题 Token、内联 SVG 图标、禁 emoji lint
        规则。知识库管理、摄入流水线、检索调试台将按开发计划依次接入。
      </p>

      <h2>产品边界</h2>
      <p class="muted">本服务对外只返回检索结果原文，不做任何 LLM 预处理；注入防护由调用方负责。</p>
    </section>
  </article>
</template>

<style scoped>
.page {
  max-width: var(--content-reading-width);
  margin: 0 auto;
  padding: 32px 24px 64px;
}

.page-head {
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}

.page-body h2 {
  margin: 24px 0 8px;
}

.muted {
  margin: 0;
  color: var(--text-secondary);
}
</style>
