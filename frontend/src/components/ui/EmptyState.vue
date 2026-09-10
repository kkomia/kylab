<script setup lang="ts">
/**
 * 空状态（《前端设计规范》§7）：一句标题 + 一句指路 + 一个操作。
 *
 * 不放装饰性插画：空页面上最该被看见的是"下一步做什么"，
 * 一张 48px 的线稿图只会把注意力从操作按钮上引开。
 */
withDefaults(defineProps<{ title: string; hint?: string }>(), { hint: '' })
</script>

<template>
  <div class="empty">
    <p class="empty-title">{{ title }}</p>
    <p v-if="hint" class="empty-hint">{{ hint }}</p>
    <div v-if="$slots.default" class="empty-action">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-12) 0;
}

.empty-title {
  margin: 0;
  font-size: var(--text-section-size);
  font-weight: 600;
}

.empty-hint {
  margin: 0;
  max-width: var(--measure);
  color: var(--text-secondary);
}

.empty-action {
  margin-top: var(--space-3);
}
</style>
