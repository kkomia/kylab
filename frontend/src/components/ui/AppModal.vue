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

/**
 * 宽度两档：
 * - `md`（默认）表单类弹窗，480px；
 * - `wide` 面板类弹窗（如库内检索），给到 980px——检索要并排看查询与命中，
 *   塞进 480px 就只能上下堆叠，失去"边查边看"的意义。
 *
 * 高度三档。**为什么不交给各页面自己写 `max-height`**：之前每个弹窗各定一套
 * （一个 62vh、一个自适应），于是"设置"内容矮时下方一片空白、"编辑"内容高时内部
 * 又出现第二条滚动条，观感不统一（评审也点了这条）。统一在这里定，
 * 各页面只需说自己是哪一档：
 * - `hug`（默认）跟着内容走，上限 80vh；
 * - `tall` 固定 80vh——左菜单类弹窗需要稳定高度，否则切换分组时会跳动；
 * - `full` 固定 88vh——内容明显超过一屏（如设置里嵌长表单）。
 */
withDefaults(
  defineProps<{
    title: string
    size?: 'md' | 'wide'
    height?: 'hug' | 'tall' | 'full'
  }>(),
  { size: 'md', height: 'hug' },
)

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
  <dialog
    ref="dialog"
    class="modal"
    :class="[`modal-${size}`, `modal-h-${height}`]"
    @cancel="onCancel"
    @close="close"
  >
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
  padding: 0;
  color: var(--text-primary);
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-overlay);
  box-shadow: var(--shadow-popover);
}

.modal-md {
  width: min(480px, calc(100vw - 32px));
}

.modal-wide {
  width: min(980px, calc(100vw - 64px));
}

/*
 * 高度三档的关键：**滚动条只出现在内容区**，标题栏与底部按钮始终贴住弹窗上下边，
 * 所以用 flex 纵向排列 + `min-height: 0` 把滚动限制在 .modal-body 上。
 *
 * `display: flex` 必须写在 `[open]` 上，**不能写在 .modal 上**：
 * 浏览器靠 `dialog:not([open]) { display: none }` 把关闭的弹窗藏起来，
 * 而作者样式优先级高于 UA 样式——直接给 .modal 写 display 会让**未打开的弹窗
 * 也照样渲染出来**（实测：`open: false` 但 `display: flex`、宽 980 高 720，
 * 于是"设置"和"新建知识库"两个弹窗叠在每个页面正文上）。这个坑很隐蔽，
 * 因为 DOM 查询 `dialog[open]` 数量是 0，只有看截图或量 rect 才会发现。
 */
.modal[open] {
  display: flex;
  flex-direction: column;
}

.modal-h-hug {
  max-height: 80vh;
}

.modal-h-tall {
  height: 80vh;
}

.modal-h-full {
  height: 88vh;
}

.modal-h-hug .modal-body {
  overflow-y: auto;
}

.modal::backdrop {
  background: var(--overlay-scrim);
}

.modal-head {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border);
}

/* 弹层标题与内容区小标题同级：都是 15px，不再各写一个字号 */
.modal-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.005em;
}

.modal-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--hit-target);
  height: var(--hit-target);
  color: var(--text-secondary);
  border-radius: var(--radius-control);
}

.modal-close:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

/* `min-height: 0` 是这里最要紧的一句：flex 子项默认 `min-height: auto`，
   不写它，内容再长也只会把弹窗撑高，`overflow-y: auto` 永远不会生效。 */
.modal-body {
  flex: 1 1 auto;
  min-height: 0;
  padding: var(--space-4);
}

.modal-foot {
  display: flex;
  flex: 0 0 auto;
  justify-content: flex-end;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--border);
}
</style>
