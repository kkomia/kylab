<script setup lang="ts">
/**
 * 模态弹层（《前端设计规范 v0.3》§7）：
 * `--bg-surface` + 1px 边框 + 4px 阴影，圆角 6px（弹层比面板小一档）。
 *
 * 用原生 `<dialog>`：焦点陷阱、Esc 关闭、惰性背景由浏览器负责，
 * 自己实现这三件事很容易漏掉键盘可达性（§8 必须项）。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

import IconClose from '@/components/icons/IconClose.vue'
import { popTopLayerHost, pushTopLayerHost } from '@/composables/useTopLayer'

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

/** 把 `open` 的状态落到原生 `<dialog>` 上。挂载时与每次变化都走这一条。 */
function syncOpen(isOpen: boolean): void {
  const element = dialog.value
  if (!element) return
  if (isOpen && !element.open) {
    element.showModal()
    // 通知条等全局浮层据此把自己送进这个 top-layer 元素（见 useTopLayer）
    pushTopLayerHost(element)
  }
  if (!isOpen && element.open) element.close()
}

watch(open, syncOpen)

/**
 * **挂载时补一次**（v0.25）。
 *
 * 上面那个 watcher 不是 `immediate`，也**不能是**：`immediate` 的回调在 setup 期间跑，
 * 那时 `dialog` 这个模板 ref 还是 null，等于什么都没做。
 *
 * 于是 `<AppModal v-if="X" v-model:open="X">`（弹窗只在需要时渲染、渲染出来就已经是
 * 打开状态）这个写法**永远打不开**：watcher 没有可观察的变化，`showModal()` 从没被调到，
 * 界面表现是"点了菜单项什么都不发生"。
 *
 * 改成在 `onMounted` 里补一次同步，两种写法就都对了——把弹窗的挂载时机交给调用方
 * 是合理的诉求（一屏几十行时不该给每行都挂三个 `<dialog>`），组件这边不该有暗坑。
 */
onMounted(() => syncOpen(open.value))

function close(): void {
  open.value = false
}

/** Esc 会直接关掉原生 dialog，这里把状态同步回 v-model。 */
function onCancel(event: Event): void {
  event.preventDefault()
  close()
}

/** `dialog.close()` 之后（Esc、v-model 置假、卸载）都要把宿主摘掉。 */
function onClose(): void {
  if (dialog.value) popTopLayerHost(dialog.value)
  close()
}

onBeforeUnmount(() => {
  if (dialog.value?.open) dialog.value.close()
  if (dialog.value) popTopLayerHost(dialog.value)
})
</script>

<template>
  <dialog
    ref="dialog"
    class="modal"
    :class="[`modal-${size}`, `modal-h-${height}`]"
    @cancel="onCancel"
    @close="onClose"
  >
    <div class="modal-head">
      <h2 class="modal-title">{{ title }}</h2>
      <!-- 关闭按钮**默认带图标**：这个 slot 一直没人传，于是所有弹窗右上角是个
           空的 24×24 方块——用户看到的就是"关闭在哪"（评审批注）。 -->
      <button class="modal-close" type="button" aria-label="关闭" @click="close">
        <slot name="close-icon"><IconClose :size="18" /></slot>
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
/* 弹窗靠**两层底色差**分层，不靠描边（《Kimi 界面逐处对照》§5）：
   Kimi 的外壳是画布色 `#181817`、内卡是 `#121212`，两层都没有边框也没有投影。
   我们反过来（单层 `#121212` + 1px 描边 + 投影）——去掉描边与投影之后，
   "比画布深一档"这个色差本来就在，层级不会丢，而弹窗边上少了一圈硬线。 */
.modal {
  padding: 0;
  color: var(--text-primary);
  background: var(--bg-surface);
  border: none;
  border-radius: var(--radius-overlay);
  box-shadow: none;
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

/* **三档高度都要让内容区自己滚**（v0.27 修）。

原先只给 `hug` 写了 `overflow-y: auto`，`tall`/`full` 靠 `flex: 1 1 auto` +
`min-height: 0` 撑——实测那样**内容区根本不滚**：内容比它高时（技能市场 20 条，
2226px 塞进 581px），溢出的部分按 `overflow: visible` 画到外面，
真正滚起来的是 `<dialog>` 自己（UA 的 `overflow: auto`），于是**标题栏与底部按钮
跟着一起滚走**——而"滚动条只出现在内容区、标题栏与底部按钮始终贴住上下边"
正是这个组件把高度分三档的理由。

判据（真浏览器量出来的）：`body.scrollTop = 400` 之后仍是 0，
而 `dialog.scrollHeight > dialog.clientHeight`。 */
.modal-h-hug .modal-body,
.modal-h-tall .modal-body,
.modal-h-full .modal-body {
  overflow-y: auto;
}

.modal::backdrop {
  background: var(--overlay-scrim);
}

/* 头部带：**宽/高弹窗用 72px，小弹窗仍用紧凑档**。

   72px 是 Kimi 的 `.login-desktop-cn__header` 实测值（左内边距 24）——那是一块
   667px 宽的弹窗。差的不只是数字：72px 让标题与内容之间隔开一层，53px 会让标题
   像正文的第一个字段。但同一条规律反过来说也成立——480px 宽的确认框上顶一条
   72px 的带子，头会占掉弹窗的三分之一。Kimi 的小弹窗我没量到，所以**不猜**：
   有实测的那一档照抄，没实测的那一档保持原样。 */
.modal-head {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border);
}

.modal-wide .modal-head,
.modal-h-tall .modal-head,
.modal-h-full .modal-head {
  min-height: 72px;
  padding: 0 var(--space-6);
}

/* 弹层标题与内容区小标题同级：都是 15px，不再各写一个字号 */
.modal-title {
  margin: 0;
  font-size: var(--text-section-size);
  font-weight: 600;
  letter-spacing: -0.005em;
}

.modal-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
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
