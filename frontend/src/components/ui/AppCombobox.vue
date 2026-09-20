<script setup lang="ts">
/**
 * 可搜索下拉 + 手写（combobox，《前端设计规范》§7）。
 *
 * **为什么不是 `<AppSelect>` 加个搜索框**：`AppSelect` 只能从给定选项里选，
 * 没有"值不在列表里"这条出路。而这里要解决的问题恰恰是"列表可能不全"——
 * 上游能探测出 96 个模型，也可能一个都探测不到（有的端点不返回列表），
 * 甚至用户想填一个上游还没上的模型。所以它必须**既能让用户挑，也允许直接打字**。
 *
 * 与 `AppSelect` 同一套浮层手法：**不 Teleport、原地 `position: fixed`**。
 * 原生 `<dialog>` 在 top layer，挂在 body 上的浮层会被弹窗盖住；留在原地
 * 则与弹窗同处一个 top-layer 元素，正常画在内容之上，也不受 `overflow: auto` 裁剪。
 *
 * 无障碍按 WAI-ARIA combobox 模式：`role=combobox` + `aria-expanded` +
 * `aria-activedescendant`（焦点留在输入框上，用方向键移动高亮）。
 */
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'

import IconChevronDown from '@/components/icons/IconChevronDown.vue'

const model = defineModel<string>({ required: true })

const props = withDefaults(
  defineProps<{
    /** 候选项。**不要求覆盖全部合法值**——输入框允许任意文本。 */
    options: { value: string; label: string }[]
    id?: string
    disabled?: boolean
    loading?: boolean
    ariaLabel?: string
    placeholder?: string
    /** 列表为空时的说明（如"没探测到模型，可直接输入"）。 */
    emptyText?: string
  }>(),
  {
    id: undefined,
    disabled: false,
    loading: false,
    ariaLabel: undefined,
    placeholder: '',
    emptyText: '没有可选项，直接输入即可',
  },
)

const uid = useId()
const listId = `${uid}-list`
const optionId = (index: number): string => `${uid}-opt-${index}`

const root = ref<HTMLElement | null>(null)
const inputEl = ref<HTMLInputElement | null>(null)
const list = ref<HTMLElement | null>(null)

const open = ref(false)
const activeIndex = ref(-1)
/** 打开时是否忽略当前文本、展示全部候选（否则会只剩刚选中的那一条）。 */
const showAll = ref(true)

const popStyle = ref<Record<string, string>>({})

const filtered = computed(() => {
  if (showAll.value) return props.options
  const query = model.value.trim().toLowerCase()
  if (!query) return props.options
  return props.options.filter(
    (item) => item.value.toLowerCase().includes(query) || item.label.toLowerCase().includes(query),
  )
})

function scrollActiveIntoView(): void {
  // 手算滚动而不是 scrollIntoView：后者在 jsdom 里是未实现桩，会往测试输出里抛错
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

/** 贴着输入框放；下方空间不够且上方更宽裕时向上翻。 */
function position(): void {
  const element = inputEl.value
  if (!element) return
  const rect = element.getBoundingClientRect()
  const gap = 4
  const wanted = Math.min(280, naturalListHeight(filtered.value.length))
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

function show(all: boolean): void {
  if (props.disabled) return
  showAll.value = all
  open.value = true
  activeIndex.value = 0
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
  else show(true)
}

function choose(index: number): void {
  const option = filtered.value[index]
  if (!option) return
  model.value = option.value
  close()
  // **不要在这里 focus 输入框**：@focus 会重新展开列表，等于"选完又弹开"。
  // 键盘选择时焦点本就在输入框；点选项用 pointerdown.prevent，焦点也没跑掉。
}

/** 输入即搜：不再"展示全部"，按当前文本过滤。 */
function onInput(): void {
  showAll.value = false
  if (!open.value) show(false)
  else {
    activeIndex.value = 0
    position()
    void nextTick(scrollActiveIntoView)
  }
}

function move(delta: number): void {
  if (!open.value) {
    show(true)
    return
  }
  const count = filtered.value.length
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
      // 列表开着且有高亮项才"选中"；否则保留手写文本（不做任何事）
      if (open.value && activeIndex.value >= 0) {
        event.preventDefault()
        choose(activeIndex.value)
      }
      break
    case 'Escape':
      // 只关列表，不关外层弹窗（焦点在输入框上时 Esc 是"取消搜索"）
      if (open.value) {
        event.preventDefault()
        close()
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
  <span ref="root" class="combo-shell" :class="{ 'combo-open': open }">
    <input
      :id="id"
      ref="inputEl"
      v-model="model"
      class="combo-input"
      type="text"
      role="combobox"
      autocomplete="off"
      aria-autocomplete="list"
      :aria-expanded="open"
      :aria-controls="listId"
      :aria-activedescendant="open && activeIndex >= 0 ? optionId(activeIndex) : undefined"
      :aria-label="ariaLabel"
      :placeholder="placeholder"
      :disabled="disabled"
      @input="onInput"
      @focus="show(true)"
      @keydown="onKeydown"
    />
    <button
      class="combo-toggle"
      type="button"
      tabindex="-1"
      :disabled="disabled"
      aria-label="展开候选"
      @click="toggle"
    >
      <IconChevronDown class="combo-arrow" :size="16" />
    </button>

    <ul
      v-if="open"
      :id="listId"
      ref="list"
      class="combo-pop"
      role="listbox"
      :aria-label="ariaLabel"
      :style="popStyle"
    >
      <li v-if="loading" class="combo-note">正在拉取候选…</li>
      <li v-else-if="filtered.length === 0" class="combo-note">
        {{ model.trim() ? `没有匹配「${model.trim()}」的候选` : emptyText }}
      </li>
      <li
        v-for="(option, index) in filtered"
        v-else
        :id="optionId(index)"
        :key="option.value"
        class="combo-option"
        :class="{ 'combo-option-active': index === activeIndex }"
        role="option"
        :aria-selected="option.value === model"
        @pointerdown.prevent="choose(index)"
        @pointermove="activeIndex = index"
      >
        <span class="combo-option-label">{{ option.label }}</span>
      </li>
    </ul>
  </span>
</template>

<style scoped>
.combo-shell {
  position: relative;
  display: block;
  width: 100%;
}

/* 外观与 AppInput 单行态一致：灰底、无硬边、聚焦抬成纸面 + 品牌色细环 */
.combo-input {
  width: 100%;
  height: var(--control-height);
  padding: 0 30px 0 var(--space-3);
  font: inherit;
  color: var(--text-primary);
  background: var(--bg-subtle);
  border: 1px solid transparent;
  border-radius: var(--radius-row);
}

/* 占位态用四级灰（规范 v0.13 §2：Quaternary 只给禁用态与占位符） */
.combo-input::placeholder {
  color: var(--text-quaternary);
}

.combo-input:hover:not(:disabled) {
  background: var(--bg-hover);
}

.combo-open .combo-input,
.combo-input:focus-visible {
  background: var(--bg-surface);
  border-color: var(--accent);
  outline: none;
  box-shadow: 0 0 0 3px var(--accent-soft);
}

/* 禁用态用实色，不用 opacity（与 --button-disabled-* 同一口径） */
.combo-input:disabled {
  color: var(--button-disabled-text);
  background: var(--button-disabled-bg);
  cursor: not-allowed;
}

.combo-toggle {
  position: absolute;
  top: 0;
  right: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: var(--control-height);
  color: var(--text-tertiary);
}

.combo-arrow {
  transition: transform var(--motion-fast) var(--motion-ease);
}

.combo-open .combo-arrow {
  transform: rotate(180deg);
}

/* 浮层原地 + fixed：不进弹窗的 overflow 裁剪，且留在 top layer 内部 */
.combo-pop {
  z-index: 60;
  margin: 0;
  padding: var(--space-1);
  overflow-y: auto;
  list-style: none;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-overlay);
  box-shadow: var(--shadow-popover);
}

.combo-option {
  display: flex;
  align-items: center;
  min-height: 36px;
  padding: 0 var(--space-3);
  font-size: var(--text-body-size);
  color: var(--text-primary);
  border-radius: var(--radius-row);
  cursor: pointer;
}

.combo-option-active {
  background: var(--bg-hover);
}

.combo-option-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.combo-note {
  padding: var(--space-2) var(--space-3);
  font-size: var(--text-meta-size);
  color: var(--text-tertiary);
}
</style>
