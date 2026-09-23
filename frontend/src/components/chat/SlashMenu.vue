<script setup lang="ts">
/**
 * 输入框里的「/」命令菜单（P1-2，开发计划 §12.225）。
 *
 * 抄的是 ZCode 的命令表 + DSH 的那条规矩：**命令在进模型之前短路、不进模型历史**
 * （调研报告 §2.7）。所以这个菜单只干三件事：把后端给的命令**分组列出来**、
 * 跟着输入过滤、把用户选中的那条交回给 ChatView——执行统统在北京
 * （`POST /chat/stream` 里那条 `command` 事件）。
 *
 * 三条与后端直接相关的约定：
 *
 * 1. **列表从后端来**（`GET /api/v1/chat/commands`）：菜单与 `/help` 读的是同一份
 *    数据，两处各写一份清单的话，"菜单里点得到、`/help` 里查不到"迟早出现；
 * 2. **按发现源分组**（`group`）：内置 / 你放的（`data/commands/`）/ 随代码自带；
 * 3. **被遮蔽与被丢弃的不在这里**（那些在列表端点里，带 `shadowed_by` / `error`
 *    留在原处供排错）：菜单里摆一条点不动的命令，比不摆更糟。
 *
 * 键盘不在这里（`ArrowUp` / `ArrowDown` / `Enter` / `Escape` 绑定在输入框上，
 * 焦点自始至终都在输入框里）——所以本组件把三件事 `defineExpose` 出去给 ChatView 调：
 * `move(±1)` 移动高亮、`pickActive()` 选中当前那条、`moveToTop()` 回到第一条。
 */
import { computed, nextTick, ref, watch } from 'vue'

import type { ChatCommand } from '@/api/chat'

const props = defineProps<{
  items: ChatCommand[]
  /** 过滤词：输入框里 `/` 之后的那一段。 */
  filter: string
}>()

const emit = defineEmits<{ pick: [command: ChatCommand] }>()

/**
 * 分组的顺序与标题（`group` 的取值与后端 `CommandOut.group` 一一对应）。
 * 「随代码自带」是**我们调过的那些**，与"用户放的"分开说——出问题时先怀疑自己放的那份。
 */
const GROUPS: { key: ChatCommand['group']; label: string }[] = [
  { key: 'builtin', label: '内置' },
  { key: 'user', label: '自定义（你放的）' },
  { key: 'repo', label: '自定义（随代码自带）' },
]

/** 名称前缀命中优先，其次是名称/说明里包含——输入 `/m` 时 `/mode` 要排在最前。 */
const filtered = computed(() => {
  const query = props.filter.trim().toLowerCase()
  if (!query) return props.items
  const head: ChatCommand[] = []
  const rest: ChatCommand[] = []
  for (const item of props.items) {
    const name = item.name.toLowerCase()
    if (name.startsWith(query)) head.push(item)
    else if (name.includes(query) || item.summary.includes(props.filter.trim())) rest.push(item)
  }
  return [...head, ...rest]
})

const grouped = computed(() =>
  GROUPS.map((group) => ({
    ...group,
    items: filtered.value.filter((item) => item.group === group.key),
  })).filter((group) => group.items.length > 0),
)

/** 高亮项在**扁平顺序**里的下标（组的顺序就是扁平顺序，两处不会对不上）。 */
const flat = computed(() => grouped.value.flatMap((group) => group.items))
const active = ref(0)
const listRef = ref<HTMLElement | null>(null)

// 过滤词一变就回到第一条：否则"打了两个字母之后高亮还停在第三项"那样的跳动
watch(flat, () => {
  active.value = 0
})

function move(delta: number): void {
  const total = flat.value.length
  if (total === 0) return
  active.value = (active.value + delta + total) % total
  void nextTick(() => {
    listRef.value
      ?.querySelector<HTMLElement>('.slash-item-active')
      ?.scrollIntoView({ block: 'nearest' })
  })
}

function moveToTop(): void {
  active.value = 0
}

/** 选中当前高亮的那条（回车走这里；点击则直接构造那条命令）。 */
function pickActive(): void {
  const command = flat.value[active.value]
  if (command) emit('pick', command)
}

function pick(command: ChatCommand): void {
  emit('pick', command)
}

defineExpose({ move, moveToTop, pickActive, active, flat })
</script>

<template>
  <div class="slash-menu" role="listbox" aria-label="命令">
    <div ref="listRef" class="slash-list">
      <template v-for="group in grouped" :key="group.key">
        <p class="slash-group">{{ group.label }}</p>
        <button
          v-for="command in group.items"
          :key="command.name"
          type="button"
          class="slash-item"
          :class="{ 'slash-item-active': flat.indexOf(command) === active }"
          role="option"
          :aria-selected="flat.indexOf(command) === active"
          @click="pick(command)"
        >
          <span class="slash-usage">{{ command.usage }}</span>
          <span class="slash-summary">{{ command.summary }}</span>
        </button>
      </template>
      <!--
        一条都没匹配上时**明确说一句**（而不是画一个空框）：这时回车会落到"执行"上，
        由后端回一句"没有这个命令"——用户至少看得见自己的输入被谁读了。
      -->
      <p v-if="flat.length === 0" class="slash-empty">没有匹配的命令；回车按原样发给后端</p>
    </div>
    <p class="slash-foot">↑↓ 选择，回车或点击插入；命令由后端直接执行，不进模型历史</p>
  </div>
</template>

<style scoped>
/* 浮在输入卡片上方（`bottom: 100%` 由 ChatView 那一侧定位，见 `.slash-layer`）：
   这一层是"输入框的续写"，不是页面上的一个面板 */
.slash-menu {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-panel);
  box-shadow: var(--shadow-popover);
}

.slash-list {
  /* 长了就自己滚（命令多到几十条时仍要能用键盘走完） */
  max-height: 320px;
  padding: var(--space-1) 0;
  overflow-y: auto;
}

.slash-group {
  margin: 0;
  padding: var(--space-2) var(--space-3) var(--space-1);
  font-size: var(--text-meta-size);
  color: var(--text-tertiary);
}

.slash-item {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-1-5) var(--space-3);
  font: inherit;
  color: var(--text-primary);
  text-align: left;
  background: transparent;
  border: 0;
  cursor: pointer;
}

.slash-item-active,
.slash-item:hover {
  background: var(--bg-hover);
}

.slash-usage {
  flex: 0 0 auto;
  font-family: var(--font-mono);
  font-size: var(--text-meta-size);
}

.slash-summary {
  overflow: hidden;
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.slash-foot {
  margin: 0;
  padding: var(--space-1-5) var(--space-3);
  font-size: var(--text-meta-size);
  color: var(--text-quaternary);
  border-top: 1px solid var(--border);
}

.slash-empty {
  margin: 0;
  padding: var(--space-3);
  font-size: var(--text-meta-size);
  color: var(--text-tertiary);
}
</style>
