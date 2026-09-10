<script setup lang="ts">
/**
 * 模态弹层（《前端设计规范 v0.3》§7）：
 * `--bg-surface` + 1px 边框 + 4px 阴影，圆角 6px（弹层比面板小一档）。
 *
 * 用原生 `<dialog>`：焦点陷阱、Esc 关闭、惰性背景由浏览器负责，
 * 自己实现这三件事很容易漏掉键盘可达性（§8 必须项）。
 */
import { onBeforeUnmount, ref, watch } from 'vue'

const open = defineModel<boolean>('open', { required: true })

defineProps<{ title: string }>()
const dialog = ref<HTMLDialogElement | null>(null)

watch(open, (isOpen) => {
  const element = dialog.value
  if (!element) return
  if (isOpen && !element.open) element.showModal()
  if (!isOpen && element.open) element.close()
})

function close(): void {
  open.value = false
}

/** Esc 会直接关掉原生 dialog，这里把状态同步回 v-model。 */
function onCancel(event: Event): void {
  event.preventDefault()
  close()
}

onBeforeUnmount(() => {
  if (dialog.value?.open) dialog.value.close()
})
</script>

<template>
  <dialog ref="dialog" class="modal" @cancel="onCancel" @close="close">
    <div class="modal-head">
      <h2 class="modal-title">{{ title }}</h2>
      <button class="modal-close" type="button" aria-label="关闭" @click="close">
        <slot name="close-icon" />
      </button>
    </div>
    <div class="modal-body">
      <slot />
    </div>
    <div v-if="$slots.footer" class="modal-foot">
      <slot name="footer" />
    </div>
  </dialog>
</template>

<style scoped>
.modal {
  width: min(480px, calc(100vw - 32px));
  padding: 0;
  color: var(--text-primary);
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  box-shadow: 0 4px 12px rgb(0 0 0 / 12%);
}

.modal::backdrop {
  background: rgb(0 0 0 / 32%);
}

.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}

.modal-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.modal-close {
  display: inline-flex;
  padding: 4px;
  color: var(--text-secondary);
  border-radius: var(--radius-control);
}

.modal-close:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.modal-body {
  padding: 16px;
}

.modal-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
}
</style>
