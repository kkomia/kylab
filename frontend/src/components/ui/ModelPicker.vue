<script setup lang="ts">
/**
 * 对话模型选择器：**一个入口装下"用哪个模型"与"它怎么想"**（《前端设计规范》§7）。
 *
 * 为什么不是三个并排的下拉：输入区原来摆着 模型 / 思考开关 / 强度 三个控件，
 * 而它们回答的是同一个问题——"这一轮怎么生成"。铺在输入框下方，每加一个参数
 * 就多一格，工具条很快就比输入框还热闹。主流产品（ChatGPT / Claude 的模型选择器、
 * Cherry Studio / LobeChat 的参数面板）都把生成参数收进模型这一个入口。
 *
 * 面板里三块：模型列表（单选）→ 思考开关 → 思考强度。选模型后面板收起（决定做完了），
 * 切开关/强度后面板留着（还可能要连着调）。
 *
 * 浮层沿用全仓的手法：**不 Teleport**，原地 `position: fixed`——原生 `<dialog>`
 * 在 top layer，挂在 body 上的浮层会被它盖住。Esc 用捕获阶段处理：面板嵌在弹窗里时
 * 先关面板、不把外层弹窗一起关掉。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch, type Component } from 'vue'

import IconCheck from '@/components/icons/IconCheck.vue'
import IconChevronDown from '@/components/icons/IconChevronDown.vue'

const model = defineModel<string>({ required: true })
const thinking = defineModel<boolean>('thinking', { required: true })

const props = withDefaults(
  defineProps<{
    /** 可选模型。与 AppSelect 的选项同形，顺带支持品牌图标。 */
    options: { value: string; label: string; icon?: Component }[]
    /** 当前思考强度；取值由 `efforts` 决定，改动走 `update:effort`。 */
    effort: string
    efforts: { value: string; label: string }[]
    disabled?: boolean
    /** 没有匹配项时触发器显示什么。 */
    placeholder?: string
    ariaLabel?: string
  }>(),
  { disabled: false, placeholder: '默认模型', ariaLabel: '模型设置' },
)

const emit = defineEmits<{ 'update:effort': [value: string] }>()

const root = ref<HTMLElement | null>(null)
const trigger = ref<HTMLButtonElement | null>(null)
const panel = ref<HTMLElement | null>(null)
const open = ref(false)
const popStyle = ref<Record<string, string>>({})

const selected = computed(() => props.options.find((item) => item.value === model.value) ?? null)

/** 触发器上的文案：选中的模型名，没有就用占位。 */
const valueLabel = computed(() => selected.value?.label ?? props.placeholder)

// ------------------------------------------------------------------ 开关与定位

function position(): void {
  const element = trigger.value
  if (!element) return
  const rect = element.getBoundingClientRect()
  const gap = 4
  const wanted = 320
  const below = window.innerHeight - rect.bottom - gap
  const above = rect.top - gap
  const flip = below < Math.min(wanted, 220) && above > below
  popStyle.value = {
    position: 'fixed',
    left: `${Math.round(rect.left)}px`,
    width: `${Math.round(Math.max(rect.width, 248))}px`,
    maxHeight: `${Math.round(Math.max(180, Math.min(wanted, flip ? above : below)))}px`,
    ...(flip
      ? { bottom: `${Math.round(window.innerHeight - rect.top + gap)}px` }
      : { top: `${Math.round(rect.bottom + gap)}px` }),
  }
}

function show(): void {
  if (props.disabled) return
  open.value = true
  position()
  void nextTick(position)
}

function close(): void {
  open.value = false
}

function toggle(): void {
  if (open.value) close()
  else show()
}

/** 选一个模型就把面板收起：这一件事做完了，剩下的多半是直接发送。 */
function chooseModel(value: string): void {
  model.value = value
  close()
  trigger.value?.focus()
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (root.value && !root.value.contains(event.target as Node)) close()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && open.value) {
    // 捕获阶段截住：面板嵌在弹窗里时，Esc 只该关面板
    event.stopPropagation()
    event.preventDefault()
    close()
    trigger.value?.focus()
  }
}

function bindGlobal(active: boolean): void {
  if (active) {
    document.addEventListener('pointerdown', onDocumentPointerDown, true)
    // Esc 挂捕获阶段：冒泡到弹窗时它已经把整层关掉了
    document.addEventListener('keydown', onKeydown, true)
    window.addEventListener('scroll', position, true)
    window.addEventListener('resize', position)
  } else {
    document.removeEventListener('pointerdown', onDocumentPointerDown, true)
    document.removeEventListener('keydown', onKeydown, true)
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
  <span ref="root" class="model-picker" :class="{ 'model-picker-open': open }">
    <button
      ref="trigger"
      type="button"
      class="mp-trigger"
      :disabled="disabled"
      :aria-expanded="open"
      aria-haspopup="dialog"
      :aria-label="ariaLabel"
      @click="toggle"
    >
      <span class="mp-value">
        <span class="mp-text">{{ valueLabel }}</span>
        <!-- 只有"关掉思考"这种非默认状态才占位：默认开着不显示任何额外信息 -->
        <span v-if="!thinking" class="mp-badge">思考关</span>
      </span>
      <IconChevronDown class="mp-arrow" :size="16" />
    </button>

    <div
      v-if="open"
      ref="panel"
      class="mp-panel"
      role="dialog"
      :aria-label="ariaLabel"
      :style="popStyle"
    >
      <div class="mp-models" role="listbox" aria-label="对话模型">
        <button
          v-for="option in options"
          :key="option.value"
          type="button"
          class="mp-model"
          :class="{ 'is-on': option.value === model }"
          role="option"
          :aria-selected="option.value === model"
          @click="chooseModel(option.value)"
        >
          <component :is="option.icon" v-if="option.icon" class="mp-model-icon" :size="16" />
          <span class="mp-model-label">{{ option.label }}</span>
          <IconCheck v-if="option.value === model" class="mp-check" :size="14" />
        </button>
        <p v-if="options.length === 0" class="mp-empty">没有可用的对话模型</p>
      </div>

      <div class="mp-sep" />

      <div class="mp-row">
        <span class="mp-row-label">思考</span>
        <button
          type="button"
          class="mp-switch"
          role="switch"
          :aria-checked="thinking"
          :aria-label="thinking ? '关闭思考' : '开启思考'"
          @click="thinking = !thinking"
        >
          <span class="mp-knob" />
        </button>
      </div>

      <div class="mp-row">
        <span class="mp-row-label">强度</span>
        <div class="mp-seg" role="group" aria-label="思考强度">
          <button
            v-for="item in efforts"
            :key="item.value"
            type="button"
            class="mp-seg-btn"
            :class="{ 'is-on': item.value === effort }"
            :aria-pressed="item.value === effort"
            :disabled="!thinking"
            @click="emit('update:effort', item.value)"
          >
            {{ item.label }}
          </button>
        </div>
      </div>
    </div>
  </span>
</template>

<style scoped>
.model-picker {
  position: relative;
  display: block;
  width: 100%;
}

/* 触发器与 AppSelect / 输入框同款：灰底、无框、同一档圆角与高度 */
.mp-trigger {
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

.mp-trigger:hover:not(:disabled) {
  background: var(--bg-hover);
}

.model-picker-open .mp-trigger,
.mp-trigger:focus-visible {
  background: var(--bg-surface);
  border-color: var(--accent);
  outline: none;
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.mp-trigger:disabled {
  color: var(--text-tertiary);
  cursor: not-allowed;
}

.mp-value {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  overflow: hidden;
}

.mp-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 「思考关」标记：非默认态才出现，用弱化的底色，不与模型名抢读 */
.mp-badge {
  flex: 0 0 auto;
  padding: 0 var(--space-1);
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
  background: var(--bg-hover);
  border-radius: var(--radius-control);
}

.mp-arrow {
  flex: 0 0 auto;
  color: var(--text-tertiary);
  transition: transform var(--motion-fast) var(--motion-ease);
}

.model-picker-open .mp-arrow {
  transform: rotate(180deg);
}

.mp-panel {
  z-index: 60;
  padding: var(--space-2);
  overflow-y: auto;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-overlay);
  box-shadow: var(--shadow-popover);
}

.mp-models {
  display: flex;
  flex-direction: column;
}

.mp-model {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 34px;
  padding: 0 var(--space-2);
  font: inherit;
  font-size: var(--text-body-size);
  color: var(--text-primary);
  text-align: left;
  background: none;
  border: 0;
  border-radius: var(--radius-row);
  cursor: pointer;
}

.mp-model:hover {
  background: var(--bg-hover);
}

.mp-model.is-on {
  color: var(--accent);
}

.mp-model-icon {
  flex: 0 0 auto;
  color: var(--text-secondary);
}

.mp-model-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mp-check {
  flex: 0 0 auto;
}

.mp-empty {
  margin: var(--space-2);
  font-size: var(--text-meta-size);
  color: var(--text-tertiary);
}

.mp-sep {
  height: 1px;
  margin: var(--space-2) 0;
  background: var(--border-hairline);
}

.mp-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: 32px;
  padding: 0 var(--space-2);
}

.mp-row-label {
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
}

/* 开关：实心色块表达状态，不用透明度（深色主题下透明度会把状态洗淡） */
.mp-switch {
  position: relative;
  flex: 0 0 auto;
  width: 36px;
  height: 20px;
  padding: 0;
  background: var(--bg-hover);
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  cursor: pointer;
}

.mp-switch[aria-checked='true'] {
  background: var(--accent);
  border-color: var(--accent);
}

.mp-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  background: var(--bg-surface);
  border-radius: 50%;
  transition: transform var(--motion-fast) var(--motion-ease);
}

.mp-switch[aria-checked='true'] .mp-knob {
  transform: translateX(16px);
}

/* 强度：三档分段控件。窄，比一个下拉少一次点击 */
.mp-seg {
  display: flex;
  padding: var(--space-pair);
  background: var(--bg-subtle);
  border-radius: var(--radius-row);
}

.mp-seg-btn {
  min-width: 34px;
  height: 24px;
  padding: 0 var(--space-2);
  font: inherit;
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
  background: none;
  border: 0;
  border-radius: var(--radius-control);
  cursor: pointer;
}

.mp-seg-btn:hover:not(:disabled) {
  color: var(--text-primary);
}

.mp-seg-btn.is-on {
  color: var(--text-primary);
  background: var(--bg-surface);
  box-shadow: 0 1px 2px rgb(0 0 0 / 10%);
}

.mp-seg-btn:disabled {
  color: var(--text-tertiary);
  cursor: not-allowed;
}
</style>
