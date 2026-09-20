<script setup lang="ts">
/**
 * 下拉选择（《前端设计规范》§7）。
 *
 * 全仓**唯一**的下拉实现，且是**自绘**的：灰底圆角触发器 + 带勾选的浮层菜单
 * （对齐 Kimi 桌面端的下拉观感）。此前两版的问题：
 *
 * 1. 第一版各处原生 `<select>` 各写一套样式——高度、边框、字号全不一样；
 * 2. 第二版虽然统一到本组件，但内核仍是原生 `<select>`：**系统渲染的弹出列表
 *    改不了**（选项行高、圆角、勾选、悬停都不受控），看起来"就是没换过"。
 *
 * 所以这一版自己画触发器和列表。键盘与无障碍仍按 WAI-ARIA combobox 模式做全：
 * `role=combobox/listbox/option` + `aria-activedescendant`（焦点留在触发器上移动高亮）、
 * 方向键/Home/End/Enter/Esc/Tab、点外部关闭。**焦点不离开触发器**是这套模式的关键，
 * 它让"键盘选中"和"屏幕阅读器朗读"用同一份状态。
 */
import { computed, nextTick, onBeforeUnmount, ref, useId, watch, type Component } from 'vue'

import IconCheck from '@/components/icons/IconCheck.vue'
import IconChevronDown from '@/components/icons/IconChevronDown.vue'

/** 一个选项：值 + 文案，外加可选的前置图标（品牌标识这类，如供应商预设）。 */
export interface SelectOption {
  value: string
  label: string
  icon?: Component
}

const model = defineModel<string>({ required: true })

const props = withDefaults(
  defineProps<{
    /** 选项值 → 显示文案。空值选项用于"不指定"这类语义。 */
    options: SelectOption[]
    id?: string
    disabled?: boolean
    /** 无障碍名：没有可见 <label> 时必填。 */
    ariaLabel?: string
    /** 值为空且没有匹配项时显示的占位文案。 */
    placeholder?: string
  }>(),
  { id: undefined, disabled: false, ariaLabel: undefined, placeholder: '请选择' },
)

const uid = useId()
const listId = `${uid}-list`
const optionId = (index: number): string => `${uid}-opt-${index}`

const root = ref<HTMLElement | null>(null)
const trigger = ref<HTMLButtonElement | null>(null)
const list = ref<HTMLElement | null>(null)

const open = ref(false)
const activeIndex = ref(-1)

/** 浮层用 fixed 定位：设置弹窗的内容区是 `overflow: auto`，
    绝对定位的浮层会被它裁掉——贴近底部的下拉会看不到选项。 */
const popStyle = ref<Record<string, string>>({})

const selectedIndex = computed(() => props.options.findIndex((item) => item.value === model.value))
const selected = computed(() => props.options[selectedIndex.value] ?? null)
/** 空值选项是"没选"，不是选了一个叫"不指定"的值——按占位符弱化显示。 */
const isPlaceholder = computed(() => !selected.value || selected.value.value === '')

function scrollActiveIntoView(): void {
  // 手动算滚动位置而不是 `scrollIntoView`：后者在 jsdom 里是"未实现"桩，
  // 调用会往虚拟控制台抛错，把测试输出弄脏。按子元素下标取也顺带免掉了
  // 拼 `#id` 要用 `CSS.escape` 的麻烦（jsdom 没有 `CSS` 全局）。
  const element = list.value
  const child = element?.children[activeIndex.value] as HTMLElement | undefined
  if (!element || !child) return
  const top = child.offsetTop
  const bottom = top + child.offsetHeight
  if (top < element.scrollTop) element.scrollTop = top
  else if (bottom > element.scrollTop + element.clientHeight) {
    element.scrollTop = bottom - element.clientHeight
  }
}

/**
 * 浮层该有多高：**量出来的自然高度，不是算出来的**。
 *
 * 原先这里是 `选项数 × 36 + 8`——8 是**一侧**的内边距，而浮层上下各有一份，
 * 于是 `wanted` 永远比内容少 8px：内容明明放得下，`scrollHeight` 还是比
 * `clientHeight` 大 8，滚动条**必然**出现（用户报的就是这个）。
 *
 * 直接量 `scrollHeight`：它天然含内边距与边框，也**不受已经应用的 `max-height` 影响**
 * （它报的是内容的自然高度）。以后改内边距或选项高度，这里不用跟着改。
 *
 * 取不到元素时（首次同步调用、还没挂载）退回一个估算值——
 * `show()` 里 `nextTick` 之后还会再调一次 `position()`，那时量得到真的。
 */
function naturalListHeight(fallbackCount: number): number {
  const measured = list.value?.scrollHeight ?? 0
  return measured > 0 ? measured : fallbackCount * 36 + 16
}

/** 贴着触发器放；下方空间不够且上方更宽裕时向上翻。 */
function position(): void {
  const element = trigger.value
  if (!element) return
  const rect = element.getBoundingClientRect()
  const gap = 4
  const wanted = Math.min(280, naturalListHeight(props.options.length))
  const below = window.innerHeight - rect.bottom - gap
  const above = rect.top - gap
  const flip = below < Math.min(wanted, 160) && above > below
  popStyle.value = {
    position: 'fixed',
    left: `${Math.round(rect.left)}px`,
    width: `${Math.round(rect.width)}px`,
    maxHeight: `${Math.round(Math.max(120, Math.min(wanted, flip ? above : below)))}px`,
    ...(flip
      ? { bottom: `${Math.round(window.innerHeight - rect.top + gap)}px` }
      : { top: `${Math.round(rect.bottom + gap)}px` }),
  }
}

function show(): void {
  if (props.disabled) return
  open.value = true
  activeIndex.value = selectedIndex.value >= 0 ? selectedIndex.value : 0
  position()
  void nextTick(() => {
    position()
    scrollActiveIntoView()
  })
}

function close(): void {
  open.value = false
}

function toggle(): void {
  if (open.value) close()
  else show()
}

function choose(index: number): void {
  const option = props.options[index]
  if (!option) return
  model.value = option.value
  close()
  trigger.value?.focus()
}

function move(delta: number): void {
  if (!open.value) {
    show()
    return
  }
  const count = props.options.length
  if (count === 0) return
  activeIndex.value = (activeIndex.value + delta + count) % count
  void nextTick(scrollActiveIntoView)
}

function onKeydown(event: KeyboardEvent): void {
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault()
      move(1)
      break
    case 'ArrowUp':
      event.preventDefault()
      move(-1)
      break
    case 'Enter':
    case ' ':
      event.preventDefault()
      if (open.value) choose(activeIndex.value)
      else show()
      break
    case 'Escape':
      if (open.value) {
        event.preventDefault()
        close()
      }
      break
    case 'Home':
      if (open.value) {
        event.preventDefault()
        activeIndex.value = 0
        void nextTick(scrollActiveIntoView)
      }
      break
    case 'End':
      if (open.value) {
        event.preventDefault()
        activeIndex.value = props.options.length - 1
        void nextTick(scrollActiveIntoView)
      }
      break
    case 'Tab':
      close()
      break
  }
}

/** 点外部关闭。用捕获阶段，免得被内层 `stopPropagation` 挡住。 */
function onDocumentPointerDown(event: PointerEvent): void {
  if (root.value && !root.value.contains(event.target as Node)) close()
}

function bindGlobal(active: boolean): void {
  if (active) {
    document.addEventListener('pointerdown', onDocumentPointerDown, true)
    window.addEventListener('scroll', position, true)
    window.addEventListener('resize', position)
  } else {
    document.removeEventListener('pointerdown', onDocumentPointerDown, true)
    window.removeEventListener('scroll', position, true)
    window.removeEventListener('resize', position)
  }
}

watch(open, (value) => bindGlobal(value))
watch(
  () => props.disabled,
  (value) => {
    if (value) close()
  },
)

onBeforeUnmount(() => bindGlobal(false))
</script>

<template>
  <span ref="root" class="select-shell" :class="{ 'select-open': open }">
    <button
      :id="id"
      ref="trigger"
      type="button"
      class="select-trigger"
      role="combobox"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-controls="listId"
      :aria-activedescendant="open && activeIndex >= 0 ? optionId(activeIndex) : undefined"
      :aria-label="ariaLabel"
      :disabled="disabled"
      @click="toggle"
      @keydown="onKeydown"
    >
      <span class="select-value" :class="{ 'select-placeholder': isPlaceholder }">
        <component :is="selected.icon" v-if="selected?.icon" class="select-icon" :size="16" />
        <span class="select-text">{{ selected?.label ?? placeholder }}</span>
      </span>
      <IconChevronDown class="select-arrow" :size="16" />
    </button>

    <!-- 浮层**不 Teleport**：原生 `<dialog>` 在 top layer，任何挂在 body 上的
         z-index 浮层都会被它盖住（实测：设置弹窗里的下拉列表完全看不见）。
         留在原地 + `position: fixed` 既不进裁剪（fixed 不受 overflow 影响），
         又与弹窗同处一个 top-layer 元素，正常画在内容之上。 -->
    <ul
      v-if="open"
      :id="listId"
      ref="list"
      class="select-pop"
      role="listbox"
      :aria-label="ariaLabel"
      :style="popStyle"
    >
      <li
        v-for="(option, index) in options"
        :id="optionId(index)"
        :key="option.value"
        class="select-option"
        :class="{
          'select-option-active': index === activeIndex,
          'select-option-selected': option.value === model,
        }"
        role="option"
        :aria-selected="option.value === model"
        @pointerdown.prevent="choose(index)"
        @pointermove="activeIndex = index"
      >
        <span class="select-option-label">
          <component :is="option.icon" v-if="option.icon" class="select-icon" :size="16" />
          <span class="select-text">{{ option.label }}</span>
        </span>
        <IconCheck v-if="option.value === model" class="select-check" :size="14" />
      </li>
    </ul>
  </span>
</template>

<style scoped>
/* 外壳只做定位与宽度：宽度由父容器的 grid/flex 决定 */
.select-shell {
  position: relative;
  display: block;
  width: 100%;
}

/* 触发器：灰底、无硬边，悬停加深；焦点/展开时抬成纸面 + 品牌色细环。
   这一套（填充而不是描边）是 Kimi 下拉的观感来源。 */
.select-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  width: 100%;
  height: var(--control-height);
  padding: 0 var(--space-2) 0 var(--space-3);
  font: inherit;
  color: var(--text-primary);
  text-align: left;
  background: var(--bg-subtle);
  border: 1px solid transparent;
  border-radius: var(--radius-row);
  cursor: pointer;
}

.select-trigger:hover:not(:disabled) {
  background: var(--bg-hover);
}

.select-open .select-trigger,
.select-trigger:focus-visible {
  background: var(--bg-surface);
  border-color: var(--accent);
  outline: none;
  box-shadow: 0 0 0 3px var(--accent-soft);
}

/* 禁用态用实色而不是 opacity：半透明会把文字与底色一起推向对方，
   与主题里的 --button-disabled-* 保持同一口径（规范 v0.13 §5）。 */
.select-trigger:disabled {
  color: var(--button-disabled-text);
  background: var(--button-disabled-bg);
  cursor: not-allowed;
}

/* 值区：图标 + 文本。文本单独一层做截断——直接对 flex 容器设 ellipsis 不生效 */
.select-value {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  overflow: hidden;
}

.select-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 品牌图标这类前置图标：不参与压缩，颜色跟随文本（占位态自动变浅） */
.select-icon {
  flex: 0 0 auto;
  color: var(--text-secondary);
}

/* 占位态用四级灰（规范 v0.13 §2 的用途约定：Quaternary 只给禁用态与占位符） */
.select-placeholder {
  color: var(--text-quaternary);
}

.select-placeholder .select-icon {
  color: var(--text-quaternary);
}

.select-arrow {
  flex: 0 0 auto;
  color: var(--text-tertiary);
  transition: transform var(--motion-fast) var(--motion-ease);
}

.select-open .select-arrow {
  transform: rotate(180deg);
}

/* 浮层：Teleport 到 body，但元素仍带本组件的 scope 属性，所以 scoped 样式够用
   （不必再写一份全局样式）。z-index 要压过弹窗内容。
   弹层构造照 Kimi 的 `.kimi-menu`：底 `Bg-Tertiary`、圆角 16、内边距 8、无边框。 */
.select-pop {
  z-index: 60;
  margin: 0;
  padding: var(--menu-pad);
  overflow-y: auto;
  list-style: none;
  background: var(--bg-menu);
  border-radius: var(--radius-panel);
  box-shadow: var(--shadow-popover);
}

.select-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: var(--menu-item-height);
  padding: 0 var(--space-2);
  font-size: var(--text-meta-size);
  line-height: 20px;
  color: var(--menu-item-text);
  border-radius: var(--menu-item-radius);
  cursor: pointer;
  transition: var(--transition-ui);
}

.select-option-active {
  background: var(--bg-hover);
}

.select-option-label {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  overflow: hidden;
}

.select-check {
  flex: 0 0 auto;
  color: var(--accent);
}
</style>
