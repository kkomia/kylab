<script setup lang="ts">
/**
 * 多选下拉（《前端设计规范》§7）：搜索框 + 复选列表 + 全选 / 清空。
 *
 * **为什么单独一个控件**：知识库选择从"一排放不下的胶囊"改成下拉——库里多一点
 * 就会把输入卡片顶成两行。参考 WeKnora 的 `KnowledgeBaseSelector`：
 * 搜索输入 + 勾选列表 + 底部「全选 / 清空」，这类"选项可能很多"的多选就该这么给。
 *
 * 与 `AppSelect` / `AppCombobox` 同一套浮层手法：**不 Teleport、原地 `position: fixed`**。
 * 原生 `<dialog>` 在 top layer，挂在 body 上的浮层会被弹窗盖住；留在原地加上 fixed，
 * 既与弹窗同处那个 top-layer 元素，也不受 `overflow: auto` 裁剪。
 *
 * 键盘按 combobox 模式：焦点留在搜索框，方向键移动高亮、Enter / 空格切换勾选，
 * Esc **只关列表**（不关外层弹窗）。多选与单选不同——**选中后面板不关**，
 * 否则选三个库要开三次。
 */
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'

import IconCheck from '@/components/icons/IconCheck.vue'
import IconChevronDown from '@/components/icons/IconChevronDown.vue'
import IconSearch from '@/components/icons/IconSearch.vue'

export interface MultiSelectOption {
  value: string
  label: string
  /** 可选的右侧小字（如条目数）。 */
  hint?: string
}

const model = defineModel<string[]>({ required: true })

const props = withDefaults(
  defineProps<{
    options: MultiSelectOption[]
    id?: string
    disabled?: boolean
    ariaLabel?: string
    /** 一个都没选时触发器上的文案。 */
    placeholder?: string
    searchPlaceholder?: string
    selectAllLabel?: string
    clearLabel?: string
  }>(),
  {
    id: undefined,
    disabled: false,
    ariaLabel: undefined,
    placeholder: '未选择',
    searchPlaceholder: '搜索…',
    selectAllLabel: '全选',
    clearLabel: '清空',
  },
)

const uid = useId()
const listId = `${uid}-list`
const optionId = (index: number): string => `${uid}-opt-${index}`

const root = ref<HTMLElement | null>(null)
const input = ref<HTMLInputElement | null>(null)
const list = ref<HTMLElement | null>(null)

const open = ref(false)
const query = ref('')
const activeIndex = ref(0)
const popStyle = ref<Record<string, string>>({})

const selectedSet = computed(() => new Set(model.value))

const filtered = computed(() => {
  const text = query.value.trim().toLowerCase()
  if (!text) return props.options
  return props.options.filter(
    (item) => item.value.toLowerCase().includes(text) || item.label.toLowerCase().includes(text),
  )
})

/** 触发器上显示"选了什么"：一个都没选 → 占位符；全选 → "全部 N 个"；否则报个数。 */
const triggerLabel = computed(() => {
  const count = model.value.length
  if (count === 0) return props.placeholder
  if (props.options.length > 0 && count === props.options.length) {
    return `全部 ${props.options.length} 个`
  }
  if (count === 1) {
    return props.options.find((item) => item.value === model.value[0])?.label ?? '1 个'
  }
  return `${count} 个已选`
})

const isPlaceholder = computed(() => model.value.length === 0)

function scrollActiveIntoView(): void {
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

function position(): void {
  const element = root.value
  if (!element) return
  const rect = element.getBoundingClientRect()
  const gap = 4
  const wanted = 320
  const below = window.innerHeight - rect.bottom - gap
  const above = rect.top - gap
  const flip = below < Math.min(wanted, 200) && above > below
  popStyle.value = {
    position: 'fixed',
    left: `${Math.round(rect.left)}px`,
    width: `${Math.round(rect.width)}px`,
    ...(flip
      ? { bottom: `${Math.round(window.innerHeight - rect.top + gap)}px` }
      : { top: `${Math.round(rect.bottom + gap)}px` }),
    maxHeight: `${Math.round(Math.max(160, Math.min(wanted, flip ? above : below)))}px`,
  }
}

function show(): void {
  if (props.disabled) return
  open.value = true
  activeIndex.value = 0
  position()
  void nextTick(() => {
    position()
    input.value?.focus()
    scrollActiveIntoView()
  })
}

function close(): void {
  open.value = false
  query.value = ''
}

function toggle(): void {
  if (open.value) close()
  else show()
}

function toggleValue(value: string): void {
  model.value = selectedSet.value.has(value)
    ? model.value.filter((item) => item !== value)
    : [...model.value, value]
}

function selectAll(): void {
  const merged = new Set([...model.value, ...filtered.value.map((item) => item.value)])
  model.value = props.options.filter((item) => merged.has(item.value)).map((item) => item.value)
}

function clearAll(): void {
  model.value = []
}

function move(delta: number): void {
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
    case ' ':
      event.preventDefault()
      {
        const option = filtered.value[activeIndex.value]
        if (option) toggleValue(option.value)
      }
      break
    case 'Escape':
      // 只关列表，不关外层弹窗
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

/** 点外部关闭。捕获阶段，免得被内层 `stopPropagation` 挡住。 */
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
  <span ref="root" class="multi-shell" :class="{ 'multi-open': open }">
    <button
      :id="id"
      type="button"
      class="multi-trigger"
      role="combobox"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-controls="listId"
      :aria-label="ariaLabel"
      :disabled="disabled"
      @click="toggle"
      @keydown="onKeydown"
    >
      <span class="multi-value" :class="{ 'multi-placeholder': isPlaceholder }">
        {{ triggerLabel }}
      </span>
      <IconChevronDown class="multi-arrow" :size="16" />
    </button>

    <div v-if="open" class="multi-pop" :style="popStyle">
      <div class="multi-search">
        <IconSearch :size="14" class="multi-search-icon" />
        <input
          ref="input"
          v-model="query"
          class="multi-search-input"
          type="text"
          :placeholder="searchPlaceholder"
          :aria-label="`${ariaLabel ?? '选项'}搜索`"
          autocomplete="off"
          @keydown="onKeydown"
        />
      </div>

      <ul :id="listId" ref="list" class="multi-list" role="listbox" :aria-label="ariaLabel">
        <li
          v-for="(option, index) in filtered"
          :id="optionId(index)"
          :key="option.value"
          class="multi-option"
          :class="{ 'multi-option-active': index === activeIndex }"
          role="option"
          :aria-selected="selectedSet.has(option.value)"
          @pointerdown.prevent="toggleValue(option.value)"
          @pointermove="activeIndex = index"
        >
          <span class="multi-box" :class="{ 'multi-box-on': selectedSet.has(option.value) }">
            <IconCheck v-if="selectedSet.has(option.value)" :size="12" />
          </span>
          <span class="multi-label">{{ option.label }}</span>
          <span v-if="option.hint" class="multi-hint">{{ option.hint }}</span>
        </li>
        <li v-if="filtered.length === 0" class="multi-empty">没有匹配的选项</li>
      </ul>

      <div class="multi-foot">
        <button type="button" class="multi-action" @click="selectAll">{{ selectAllLabel }}</button>
        <button type="button" class="multi-action" @click="clearAll">{{ clearLabel }}</button>
      </div>
    </div>
  </span>
</template>

<style scoped>
.multi-shell {
  position: relative;
  display: block;
  width: 100%;
}

/* 触发器：灰底、无硬边，与 AppSelect 同一套（填充而非描边） */
.multi-trigger {
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

.multi-trigger:hover:not(:disabled) {
  background: var(--bg-hover);
}

.multi-open .multi-trigger,
.multi-trigger:focus-visible {
  background: var(--bg-surface);
  border-color: var(--accent);
  outline: none;
  box-shadow: 0 0 0 3px var(--accent-soft);
}

/* 禁用态用实色，不用 opacity（与 --button-disabled-* 同一口径） */
.multi-trigger:disabled {
  color: var(--button-disabled-text);
  background: var(--button-disabled-bg);
  cursor: not-allowed;
}

.multi-value {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 占位态用四级灰（规范 v0.13 §2：Quaternary 只给禁用态与占位符） */
.multi-placeholder {
  color: var(--text-quaternary);
}

.multi-arrow {
  flex: 0 0 auto;
  color: var(--text-tertiary);
  transition: transform var(--motion-fast) var(--motion-ease);
}

.multi-open .multi-arrow {
  transform: rotate(180deg);
}

/* 浮层原地 + fixed：不进裁剪，且留在 top layer 内 */
.multi-pop {
  z-index: 60;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-overlay);
  box-shadow: var(--shadow-popover);
}

.multi-search {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border-hairline);
}

.multi-search-icon {
  flex: 0 0 auto;
  color: var(--text-tertiary);
}

.multi-search-input {
  width: 100%;
  font: inherit;
  color: var(--text-primary);
  background: transparent;
  border: 0;
  outline: none;
}

.multi-search-input::placeholder {
  color: var(--text-tertiary);
}

.multi-list {
  flex: 1 1 auto;
  min-height: 0;
  margin: 0;
  padding: var(--space-1);
  overflow-y: auto;
  list-style: none;
}

.multi-option {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 34px;
  padding: 0 var(--space-2);
  font-size: var(--text-body-size);
  color: var(--text-primary);
  border-radius: var(--radius-row);
  cursor: pointer;
}

.multi-option-active {
  background: var(--bg-hover);
}

/* 自绘复选框：原生 checkbox 在深浅两套主题下宽度/对齐都不受控 */
.multi-box {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  color: var(--bg-surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-badge);
}

.multi-box-on {
  background: var(--accent);
  border-color: var(--accent);
}

.multi-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.multi-hint {
  flex: 0 0 auto;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.multi-empty {
  padding: var(--space-2) var(--space-3);
  font-size: var(--text-meta-size);
  color: var(--text-tertiary);
}

.multi-foot {
  display: flex;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-top: 1px solid var(--border-hairline);
}

.multi-action {
  font-size: var(--text-micro-size);
  color: var(--accent-text);
}

.multi-action:hover {
  text-decoration: underline;
}
</style>
