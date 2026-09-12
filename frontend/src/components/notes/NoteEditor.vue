<script setup lang="ts">
/**
 * 笔记编辑器（Tiptap，headless）。
 *
 * 为什么是 Tiptap：它是 headless 的，菜单、气泡、占位符全部自己画，能直接套现有设计令牌，
 * 不会像 Cherry/Vditor 那样自带一套皮肤跟控制台打架（见《笔记功能调研》§2.1）。
 * `content_md` 是唯一事实源——进出这一层的都是 Markdown 字符串，编辑器 JSON 不落库，
 * 所以以后换编辑器，数据与后端都不用动。
 *
 * 工具栏用**文字标签**而不是图标：粗体/斜体/各类列表这些没有现成图标，
 * 为它们画十几个 SVG 不划算，而中文标签在小尺寸下比抽象图标更不用猜。
 */
import { Placeholder } from '@tiptap/extension-placeholder'
import { TaskItem } from '@tiptap/extension-task-item'
import { TaskList } from '@tiptap/extension-task-list'
import StarterKit from '@tiptap/starter-kit'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import { ref, watch } from 'vue'
import { Markdown } from 'tiptap-markdown'

const props = withDefaults(defineProps<{ modelValue: string; editable?: boolean }>(), {
  editable: true,
})
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const editor = useEditor({
  editable: props.editable,
  content: props.modelValue,
  extensions: [
    StarterKit.configure({
      // 笔记里贴链接是常态，但点一下就跳走会打断写作——按住 Ctrl 才打开
      link: { openOnClick: false, autolink: true },
      codeBlock: {},
    }),
    Placeholder.configure({ placeholder: '记录点什么… 选中文字后可用上方工具栏格式化' }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Markdown.configure({ html: false, linkify: true, breaks: false }),
  ],
  onUpdate: ({ editor: instance }) => {
    emit('update:modelValue', markdownOf(instance))
  },
  onTransaction: () => {
    // 工具栏的激活态跟着光标/选区走，每次交易重算一次（见下面的 refreshActive）
    refreshActive()
  },
})

/**
 * `useEditor` 返回的是 core 的 `Editor`（不是 vue-3 包装的那个子类），
 * 所以类型从实例本身推——手写 import 反而会撞上两个包各自的 `Editor`。
 */
type CoreEditor = NonNullable<typeof editor.value>

/**
 * tiptap-markdown 没有把 `storage.markdown` 补进 Tiptap 的类型声明，
 * 这里给它一个明确的形状再取——比在调用处到处 `as any` 收敛。
 */
function markdownOf(instance: { storage: unknown }): string {
  return (instance.storage as { markdown: { getMarkdown: () => string } }).markdown.getMarkdown()
}

/** 外部换笔记时把内容灌进来；不比较会让每次按键都重置光标。 */
watch(
  () => props.modelValue,
  (value) => {
    const instance = editor.value
    if (!instance) return
    if (value !== markdownOf(instance)) {
      instance.commands.setContent(value || '', { emitUpdate: false })
    }
  },
)
watch(
  () => props.editable,
  (value) => editor.value?.setEditable(value),
)

/**
 * 各按钮的激活态。
 *
 * Tiptap 实例不在 Vue 的响应式图里，所以不能直接 `computed(isActive)`——
 * 改成"每次交易回调里重算一次"的普通 ref（`onTransaction` 里调 `refreshActive`）。
 */
const active = ref({
  h1: false,
  h2: false,
  bold: false,
  italic: false,
  strike: false,
  bullet: false,
  ordered: false,
  quote: false,
  code: false,
  task: false,
  link: false,
})

function refreshActive(): void {
  const instance = editor.value
  active.value = instance
    ? {
        h1: instance.isActive('heading', { level: 1 }),
        h2: instance.isActive('heading', { level: 2 }),
        bold: instance.isActive('bold'),
        italic: instance.isActive('italic'),
        strike: instance.isActive('strike'),
        bullet: instance.isActive('bulletList'),
        ordered: instance.isActive('orderedList'),
        quote: instance.isActive('blockquote'),
        code: instance.isActive('codeBlock'),
        task: instance.isActive('taskList'),
        link: instance.isActive('link'),
      }
    : active.value
}

function run(action: (instance: CoreEditor) => void): void {
  const instance = editor.value
  if (!instance) return
  action(instance)
}

function toggleLink(): void {
  const instance = editor.value
  if (!instance) return
  if (instance.isActive('link')) {
    instance.chain().focus().unsetLink().run()
    return
  }
  const url = window.prompt('链接地址（留空则取消）', 'https://')
  if (!url) return
  instance.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
}
</script>

<template>
  <div class="note-editor">
    <div v-if="editable" class="toolbar" role="toolbar" aria-label="排版工具栏">
      <button
        type="button"
        class="tool"
        :class="{ 'tool-on': active.h1 }"
        title="一级标题"
        @click="run((e) => e.chain().focus().toggleHeading({ level: 1 }).run())"
      >
        H1
      </button>
      <button
        type="button"
        class="tool"
        :class="{ 'tool-on': active.h2 }"
        title="二级标题"
        @click="run((e) => e.chain().focus().toggleHeading({ level: 2 }).run())"
      >
        H2
      </button>
      <span class="tool-sep" aria-hidden="true" />
      <button
        type="button"
        class="tool"
        :class="{ 'tool-on': active.bold }"
        title="粗体"
        @click="run((e) => e.chain().focus().toggleBold().run())"
      >
        B
      </button>
      <button
        type="button"
        class="tool tool-italic"
        :class="{ 'tool-on': active.italic }"
        title="斜体"
        @click="run((e) => e.chain().focus().toggleItalic().run())"
      >
        I
      </button>
      <button
        type="button"
        class="tool tool-strike"
        :class="{ 'tool-on': active.strike }"
        title="删除线"
        @click="run((e) => e.chain().focus().toggleStrike().run())"
      >
        S
      </button>
      <span class="tool-sep" aria-hidden="true" />
      <button
        type="button"
        class="tool"
        :class="{ 'tool-on': active.bullet }"
        title="无序列表"
        @click="run((e) => e.chain().focus().toggleBulletList().run())"
      >
        列表
      </button>
      <button
        type="button"
        class="tool"
        :class="{ 'tool-on': active.ordered }"
        title="有序列表"
        @click="run((e) => e.chain().focus().toggleOrderedList().run())"
      >
        编号
      </button>
      <button
        type="button"
        class="tool"
        :class="{ 'tool-on': active.task }"
        title="待办清单"
        @click="run((e) => e.chain().focus().toggleTaskList().run())"
      >
        待办
      </button>
      <span class="tool-sep" aria-hidden="true" />
      <button
        type="button"
        class="tool"
        :class="{ 'tool-on': active.quote }"
        title="引用"
        @click="run((e) => e.chain().focus().toggleBlockquote().run())"
      >
        引用
      </button>
      <button
        type="button"
        class="tool"
        :class="{ 'tool-on': active.code }"
        title="代码块"
        @click="run((e) => e.chain().focus().toggleCodeBlock().run())"
      >
        代码
      </button>
      <button type="button" class="tool" :class="{ 'tool-on': active.link }" title="链接" @click="toggleLink">
        链接
      </button>
    </div>

    <EditorContent class="editor-body" :editor="editor" />
  </div>
</template>

<style scoped>
.note-editor {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-pair);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border-hairline);
  background: var(--bg-surface);
}

.tool {
  min-width: var(--hit-target);
  height: var(--hit-target);
  padding: 0 var(--space-2);
  font-size: var(--text-micro-size);
  font-family: inherit;
  color: var(--text-secondary);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-control);
  cursor: pointer;
}

.tool:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.tool-on {
  color: var(--accent-text);
  background: var(--accent-soft);
  border-color: var(--accent-selected);
}

.tool-italic {
  font-style: italic;
}

.tool-strike {
  text-decoration: line-through;
}

.tool-sep {
  width: 1px;
  height: 16px;
  margin: 0 var(--space-1);
  background: var(--border);
}

.editor-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.editor-body :deep(.tiptap) {
  min-height: 320px;
  padding: var(--space-4) var(--space-5) var(--space-12);
  font-size: var(--text-body-size);
  line-height: 1.75;
  color: var(--text-primary);
  outline: none;
}

.editor-body :deep(.tiptap > * + *) {
  margin-top: var(--space-3);
}

.editor-body :deep(.tiptap h1) {
  font-size: var(--text-page-title-size);
}

.editor-body :deep(.tiptap h2) {
  font-size: var(--text-section-size);
}

.editor-body :deep(.tiptap h3) {
  font-size: var(--text-body-size);
  font-weight: 600;
}

.editor-body :deep(.tiptap ul),
.editor-body :deep(.tiptap ol) {
  padding-left: var(--space-6);
}

.editor-body :deep(.tiptap ul) {
  list-style: disc;
}

.editor-body :deep(.tiptap ol) {
  list-style: decimal;
}

.editor-body :deep(.tiptap ul[data-type='taskList']) {
  list-style: none;
  padding-left: var(--space-2);
}

.editor-body :deep(.tiptap ul[data-type='taskList'] li) {
  display: flex;
  gap: var(--space-2);
  align-items: flex-start;
}

/* 原生复选框默认是浏览器蓝，和全站的青绿强调色不是一套；显式交给主题令牌 */
.editor-body :deep(.tiptap input[type='checkbox']) {
  accent-color: var(--accent);
  margin-top: 0.35em;
}

.editor-body :deep(.tiptap blockquote) {
  padding-left: var(--space-4);
  color: var(--text-secondary);
  border-left: 2px solid var(--border-strong);
}

.editor-body :deep(.tiptap pre) {
  padding: var(--space-3) var(--space-4);
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: var(--text-micro-size);
  background: var(--bg-subtle);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-control);
}

.editor-body :deep(.tiptap code) {
  font-family: var(--font-mono);
  font-size: 0.92em;
}

.editor-body :deep(.tiptap a) {
  color: var(--accent-text);
  text-decoration: underline;
}

.editor-body :deep(.tiptap p.is-editor-empty:first-child::before) {
  float: left;
  height: 0;
  color: var(--text-tertiary);
  pointer-events: none;
  content: attr(data-placeholder);
}
</style>
