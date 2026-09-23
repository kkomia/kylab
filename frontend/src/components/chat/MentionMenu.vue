<script setup lang="ts">
/**
 * 输入框里的「@」上下文菜单（P1-3，开发计划 §12.225）。
 *
 * 抄的是两家的**两半**（调研报告 §2.8）：
 *
 * - **ZCode 的"多分类统一搜索"**：一个 `@` 弹出的是**同一份搜索结果**，
 *   按类别分组列出来（我们这三类：文件 / 技能 / 会话），而不是让用户先选类别；
 * - **DSH 的"只做引用、不预读"**：选中之后插进输入框的只是一个**引用**
 *   （`@路径` / `@技能名` / `@会话标题`），内容一个字都不读——读不读、读哪一段
 *   由模型自己决定（它手上有 `read_file`、`read_skill` 那些工具）。
 *   这一点是刻意的：把文件内容预先塞进这一轮，用户看不见自己付了多少上下文，
 *   也拿不回"我只要它看结论"这个选择。
 *
 * 三类的引用各有讲究：
 *
 * 1. **文件**来自这条会话的文件区（`GET /conversations/{id}/files` 那份清单）——
 *    路径里的空格按 DSH 的 grammar 用引号包起来（`@"我的 报告.md"`），
 *    否则模型那边会把一个路径切成两段；
 * 2. **技能**来自既有的技能接口（`used_by_prompt` 的那批）：插的是技能**名**，
 *    与 `/skill <名字>` 那条命令同一个标识；
 * 3. **会话**来自会话列表：插的是标题。它是一份"提到过的那条会话"的引用，
 *    不是把那边的正文搬过来。
 *
 * 键盘不在这里（↑↓ / 回车 / Esc 由输入框那一侧转发，见 `ChatView.onComposerKeydown`），
 * 与 `SlashMenu` 同一套约定：本组件把 `move(±1)` / `pickActive()` / `flat` 暴露出去。
 */
import { computed, nextTick, ref, watch } from 'vue'

/**
 * 一条可引用的东西。`value` 是**要插进输入框的那段引用**，`label` 是给人看的。
 *
 * 分开两个字段的理由：文件那一条要插的是路径（可能在子目录里、可能与旁边的同名），
 * 而菜单里显示的是短名字——用户按名字找，插进输入框的是能让模型找到它的那个标识。
 */
export interface MentionItem {
  kind: 'file' | 'skill' | 'session'
  /** 插进输入框的引用文本（不含前导的 `@`，见 `mentionText`）。 */
  value: string
  label: string
  /** 菜单里那一行右边的小字（文件的大小 / 技能的一句话 / 会话的时间）。 */
  detail: string
  /** 目录在这份清单里是**不能引用**的（引用一个目录，模型读不出内容）。 */
  isDir?: boolean
}

const props = defineProps<{
  items: MentionItem[]
  /** 过滤词：输入框里 `@` 之后的那一段。 */
  filter: string
  /** 清单还在来的路上（文件那条是异步取的）。 */
  loading?: boolean
}>()

const emit = defineEmits<{ pick: [item: MentionItem] }>()

/**
 * 分组：顺序就是**扁平顺序**（键盘上下走的是这一份）。
 * 文件排最前——它是这个菜单里最常用的一类，也是"引用"这个概念最初的那一类。
 */
const GROUPS: { kind: MentionItem['kind']; label: string }[] = [
  { kind: 'file', label: '文件' },
  { kind: 'skill', label: '技能' },
  { kind: 'session', label: '会话' },
]

/** 前缀命中优先，其次是名字/详情里包含——与 `/` 菜单同一条口径。 */
const filtered = computed(() => {
  const query = props.filter.trim().toLowerCase()
  if (!query) return props.items.filter((item) => !item.isDir)
  const head: MentionItem[] = []
  const rest: MentionItem[] = []
  for (const item of props.items) {
    // 目录只在**搜索时**出现：想引用的是目录里的某份文件，那就该继续往里打；
    // 而"列一堆目录"会把文件挤下去（那些才是能引用的东西）
    const name = item.label.toLowerCase()
    const value = item.value.toLowerCase()
    if (name.startsWith(query) || value.startsWith(query)) head.push(item)
    else if (name.includes(query) || value.includes(query) || item.detail.includes(query))
      rest.push(item)
  }
  return [...head, ...rest]
})

const grouped = computed(() =>
  GROUPS.map((group) => ({
    ...group,
    items: filtered.value.filter((item) => item.kind === group.kind),
  })).filter((group) => group.items.length > 0),
)

const flat = computed(() => grouped.value.flatMap((group) => group.items))
const active = ref(0)
const listRef = ref<HTMLElement | null>(null)

// 过滤词一变就回到第一条（同 SlashMenu：否则高亮会停在某个随手打出来的位置）
watch(flat, () => {
  active.value = 0
})

function move(delta: number): void {
  const total = flat.value.length
  if (total === 0) return
  active.value = (active.value + delta + total) % total
  void nextTick(() => {
    listRef.value
      ?.querySelector<HTMLElement>('.mention-item-active')
      ?.scrollIntoView({ block: 'nearest' })
  })
}

/** 选中当前高亮的那条（回车走这里；点击则直接构造那一条）。 */
function pickActive(): void {
  const item = flat.value[active.value]
  if (item) emit('pick', item)
}

function pick(item: MentionItem): void {
  emit('pick', item)
}

defineExpose({ move, pickActive, active, flat })
</script>

<template>
  <div class="mention-menu" role="listbox" aria-label="添加上下文">
    <div ref="listRef" class="mention-list">
      <template v-for="group in grouped" :key="group.kind">
        <p class="mention-group">{{ group.label }}</p>
        <button
          v-for="item in group.items"
          :key="`${item.kind}:${item.value}`"
          type="button"
          class="mention-item"
          :class="{ 'mention-item-active': flat.indexOf(item) === active }"
          role="option"
          :aria-selected="flat.indexOf(item) === active"
          @click="pick(item)"
        >
          <span class="mention-label">{{ item.label }}</span>
          <span v-if="item.detail" class="mention-detail">{{ item.detail }}</span>
        </button>
      </template>
      <p v-if="flat.length === 0" class="mention-empty">
        {{ loading ? '正在读文件清单…' : '没有匹配的文件 / 技能 / 会话' }}
      </p>
    </div>
    <p class="mention-foot">只插入引用，不读取内容；↑↓ 选择，回车或点击插入</p>
  </div>
</template>

<style scoped>
/* 浮在输入卡片上方（定位由 ChatView 那一侧给，与 `.slash-layer` 同一套） */
.mention-menu {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-panel);
  box-shadow: var(--shadow-popover);
}

.mention-list {
  max-height: 320px;
  padding: var(--space-1) 0;
  overflow-y: auto;
}

.mention-group {
  margin: 0;
  padding: var(--space-2) var(--space-3) var(--space-1);
  font-size: var(--text-meta-size);
  color: var(--text-tertiary);
}

.mention-item {
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

.mention-item-active,
.mention-item:hover {
  background: var(--bg-hover);
}

.mention-label {
  flex: 0 0 auto;
  max-width: 60%;
  overflow: hidden;
  font-size: var(--text-meta-size);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mention-detail {
  overflow: hidden;
  font-size: var(--text-meta-size);
  color: var(--text-quaternary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mention-foot {
  margin: 0;
  padding: var(--space-1-5) var(--space-3);
  font-size: var(--text-meta-size);
  color: var(--text-quaternary);
  border-top: 1px solid var(--border);
}

.mention-empty {
  margin: 0;
  padding: var(--space-3);
  font-size: var(--text-meta-size);
  color: var(--text-tertiary);
}
</style>
