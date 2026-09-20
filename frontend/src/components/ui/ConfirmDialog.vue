<script setup lang="ts">
/**
 * 危险/重要操作的统一确认弹窗。
 *
 * **为什么要有它**：此前破坏性确认有两套做法——文档与知识库删除走
 * "影响清单 + AppModal"（信息完整、样式可控），而删目录、删数据源、删供应商等
 * 七处走浏览器原生 `window.confirm`（样式不可控、塞不下"还有 N 篇"这类说明）。
 * 这个组件把前者的形态收敛成一个入口，后者全部换过来。
 *
 * 用法：
 * - `lead` 是一句直问（"删除目录「合同」？"）；`note` 是后果说明（弱一档的文字）；
 * - 需要展示数字清单（影响面）时用默认插槽，调用方自己排版；
 * - `busy` 为真时确认按钮禁用并显示进行中文案；`confirmLabel` 缺省"删除"。
 */
import AppButton from '@/components/ui/AppButton.vue'
import AppModal from '@/components/ui/AppModal.vue'

const open = defineModel<boolean>('open', { required: true })

withDefaults(
  defineProps<{
    title: string
    lead: string
    /** 后果说明（不可恢复 / 会保留什么），弱一档的文字。 */
    note?: string
    confirmLabel?: string
    /** 进行中的文案；同时禁用确认按钮。 */
    busyLabel?: string
    busy?: boolean
  }>(),
  { note: undefined, confirmLabel: '删除', busyLabel: '处理中…', busy: false },
)

const emit = defineEmits<{ confirm: [] }>()
</script>

<template>
  <AppModal v-model:open="open" :title="title">
    <p class="confirm-lead">{{ lead }}</p>

    <!-- 影响清单等附加内容由调用方排版：各对象的"会失去什么"字段不同 -->
    <slot />

    <p v-if="note" class="confirm-note">{{ note }}</p>

    <template #footer>
      <AppButton @click="open = false">取消</AppButton>
      <AppButton variant="danger" :disabled="busy" @click="emit('confirm')">
        {{ busy ? busyLabel : confirmLabel }}
      </AppButton>
    </template>
  </AppModal>
</template>

<style scoped>
.confirm-lead {
  margin: 0 0 var(--space-3);
  color: var(--text-primary);
}

/* 后果说明：比正文弱一档；"不可恢复"类的警示由调用方写进文案本身 */
.confirm-note {
  margin: var(--space-3) 0 0;
  font-size: var(--text-meta-size);
  line-height: var(--line-prose);
  color: var(--text-secondary);
}
</style>
