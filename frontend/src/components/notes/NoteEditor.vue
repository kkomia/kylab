<script setup lang="ts">
/**
 * 笔记编辑器（Tiptap，headless）。
 *
 * 为什么是 Tiptap：它是 headless 的，菜单、气泡、占位符全部自己画，能直接套现有设计令牌，
 * 不会像 Cherry/Vditor 那样自带一套皮肤跟控制台打架（见《笔记功能调研》§2.1）。
 * `content_md` 是唯一事实源——进出这一层的都是 Markdown 字符串，编辑器 JSON 不落库，
 * 所以以后换编辑器，数据与后端都不用动。
 *
 * 版式对齐 ima 笔记：**工具栏在顶部、标题在文档里**（不是"表单标题框"），
 * 正文收在一条居中的窄栏里阅读。所以标题通过 `#header` 插槽交给调用方，
 * 由本组件把它放在工具栏与正文之间——顺序对了，观感才对。
 */
import { Placeholder } from '@tiptap/extension-placeholder'
import { TaskItem } from '@tiptap/extension-task-item'
import { TaskList } from '@tiptap/extension-task-list'
import StarterKit from '@tiptap/starter-kit'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import { ref, watch } from 'vue'

import IconFormatBold from '@/components/icons/IconFormatBold.vue'
import IconFormatBulletList from '@/components/icons/IconFormatBulletList.vue'
import IconFormatCode from '@/components/icons/IconFormatCode.vue'
import IconFormatH1 from '@/components/icons/IconFormatH1.vue'
import IconFormatH2 from '@/components/icons/IconFormatH2.vue'
import IconFormatItalic from '@/components/icons/IconFormatItalic.vue'
import IconFormatLink from '@/components/icons/IconFormatLink.vue'
import IconFormatOrderedList from '@/components/icons/IconFormatOrderedList.vue'
import IconFormatParagraph from '@/components/icons/IconFormatParagraph.vue'
import IconFormatQuote from '@/components/icons/IconFormatQuote.vue'
import IconFormatStrike from '@/components/icons/IconFormatStrike.vue'
import IconFormatTaskList from '@/components/icons/IconFormatTaskList.vue'
import IconFormatUnderline from '@/components/icons/IconFormatUnderline.vue'
import IconRedo from '@/components/icons/IconRedo.vue'
import IconUndo from '@/components/icons/IconUndo.vue'
import { Markdown } from 'tiptap-markdown'

const props = withDefaults(defineProps<{ modelValue: string; editable?: boolean }>(), {
  editable: true,
})
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const editor = useEditor({
  editable: props.editable,
  // 初值必须来自 props：调用方只在内容就绪后才挂载本组件，
  // 若这里给空串、指望下面的 watch 灌进来，会踩到"watch 先于 editor 实例"的时序而丢正文
  content: props.modelValue,
  extensions: [
    StarterKit.configure({
      // 笔记里贴链接是常态，但点一下就跳走会打断写作——按住 Ctrl 才打开
      link: { openOnClick: false, autolink: true },
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
 * `useEditor` 返回的是 core 的 `Editor`，不同包各有自己的 `Editor` 类型，
 * 手写 import 会撞类型；这里从实例本身推。
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
  { immediate: true },
)
watch(
  () => props.editable,
  (value) => editor.value?.setEditable(value),
)

/**
 * 各按钮的激活/可用态。
 *
 * Tiptap 实例不在 Vue 的响应式图里，不能直接 `computed(isActive)`——
 * 改成"每次交易回调里重算一次"的普通 ref。
 */
const active = ref({
  paragraph: true,
  h1: false,
  h2: false,
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  bullet: false,
  ordered: false,
  task: false,
  quote: false,
  code: false,
  link: false,
  canUndo: false,
  canRedo: false,
})

function refreshActive(): void {
  const instance = editor.value
  if (!instance) return
  active.value = {
    paragraph: instance.isActive('paragraph'),
    h1: instance.isActive('heading', { level: 1 }),
    h2: instance.isActive('heading', { level: 2 }),
    bold: instance.isActive('bold'),
    italic: instance.isActive('italic'),
    underline: instance.isActive('underline'),
    strike: instance.isActive('strike'),
    bullet: instance.isActive('bulletList'),
    ordered: instance.isActive('orderedList'),
    task: instance.isActive('taskList'),
    quote: instance.isActive('blockquote'),
    code: instance.isActive('codeBlock'),
    link: instance.isActive('link'),
    canUndo: instance.can().undo(),
    canRedo: instance.can().redo(),
  }
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
    <div class="toolbar" role="toolbar" aria-label="排版工具栏">
      <div class="tool-group">
        <button
          type="button"
          class="tool"
          title="撤销"
          :disabled="!active.canUndo"
          @click="run((e) => e.chain().focus().undo().run())"
        >
          <IconUndo :size="15" />
        </button>
        <button
          type="button"
          class="tool"
          title="重做"
          :disabled="!active.canRedo"
          @click="run((e) => e.chain().focus().redo().run())"
        >
          <IconRedo :size="15" />
        </button>
      </div>

      <span class="tool-sep" aria-hidden="true" />

      <div class="tool-group">
        <button
          type="button"
          class="tool"
          :class="{ 'tool-on': active.paragraph }"
          title="正文"
          @click="run((e) => e.chain().focus().setParagraph().run())"
        >
          <IconFormatParagraph :size="15" />
        </button>
        <button
          type="button"
          class="tool"
          :class="{ 'tool-on': active.h1 }"
          title="一级标题"
          @click="run((e) => e.chain().focus().toggleHeading({ level: 1 }).run())"
        >
          <IconFormatH1 :size="15" />
        </button>
        <button
          type="button"
          class="tool"
          :class="{ 'tool-on': active.h2 }"
          title="二级标题"
          @click="run((e) => e.chain().focus().toggleHeading({ level: 2 }).run())"
        >
          <IconFormatH2 :size="15" />
        </button>
      </div>

      <span class="tool-sep" aria-hidden="true" />

      <div class="tool-group">
        <button
          type="button"
          class="tool"
          :class="{ 'tool-on': active.bold }"
          title="粗体"
          @click="run((e) => e.chain().focus().toggleBold().run())"
        >
          <IconFormatBold :size="15" />
        </button>
        <button
          type="button"
          class="tool"
          :class="{ 'tool-on': active.italic }"
          title="斜体"
          @click="run((e) => e.chain().focus().toggleItalic().run())"
        >
          <IconFormatItalic :size="15" />
        </button>
        <button
          type="button"
          class="tool"
          :class="{ 'tool-on': active.underline }"
          title="下划线"
          @click="run((e) => e.chain().focus().toggleUnderline().run())"
        >
          <IconFormatUnderline :size="15" />
        </button>
        <button
          type="button"
          class="tool"
          :class="{ 'tool-on': active.strike }"
          title="删除线"
          @click="run((e) => e.chain().focus().toggleStrike().run())"
        >
          <IconFormatStrike :size="15" />
        </button>
      </div>

      <span class="tool-sep" aria-hidden="true" />

      <div class="tool-group">
        <button
          type="button"
          class="tool"
          :class="{ 'tool-on': active.bullet }"
          title="无序列表"
          @click="run((e) => e.chain().focus().toggleBulletList().run())"
        >
          <IconFormatBulletList :size="15" />
        </button>
        <button
          type="button"
          class="tool"
          :class="{ 'tool-on': active.ordered }"
          title="有序列表"
          @click="run((e) => e.chain().focus().toggleOrderedList().run())"
        >
          <IconFormatOrderedList :size="15" />
        </button>
        <button
          type="button"
          class="tool"
          :class="{ 'tool-on': active.task }"
          title="待办清单"
          @click="run((e) => e.chain().focus().toggleTaskList().run())"
        >
          <IconFormatTaskList :size="15" />
        </button>
      </div>

      <span class="tool-sep" aria-hidden="true" />

      <div class="tool-group">
        <button
          type="button"
          class="tool"
          :class="{ 'tool-on': active.quote }"
          title="引用"
          @click="run((e) => e.chain().focus().toggleBlockquote().run())"
        >
          <IconFormatQuote :size="15" />
        </button>
        <button
          type="button"
          class="tool"
          :class="{ 'tool-on': active.code }"
          title="代码块"
          @click="run((e) => e.chain().focus().toggleCodeBlock().run())"
        >
          <IconFormatCode :size="15" />
        </button>
        <button
          type="button"
          class="tool"
          :class="{ 'tool-on': active.link }"
          title="链接"
          @click="toggleLink"
        >
          <IconFormatLink :size="15" />
        </button>
      </div>

      <div class="toolbar-right">
        <slot name="actions" />
      </div>
    </div>

    <div class="editor-body">
      <div class="editor-column">
        <slot name="header" />
        <EditorContent class="editor-content" :editor="editor" />
      </div>
    </div>
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
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border-hairline);
  background: var(--bg-surface);
}

.tool-group {
  display: flex;
  align-items: center;
  gap: 2px;
}

.tool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  border-radius: var(--radius-control);
  cursor: pointer;
}

.tool:hover:not(:disabled) {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.tool:disabled {
  color: var(--text-tertiary);
  opacity: 0.45;
  cursor: default;
}

.tool-on {
  color: var(--accent-text);
  background: var(--accent-soft);
}

.tool-sep {
  width: 1px;
  height: 16px;
  margin: 0 var(--space-1);
  background: var(--border);
}

.toolbar-right {
  display: flex;
  gap: var(--space-1);
  align-items: center;
  margin-left: auto;
}

.editor-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

/* 正文收在一条窄栏里居中：满屏宽的行读起来很累，也不像"写作工具" */
.editor-column {
  max-width: 780px;
  margin: 0 auto;
  padding: var(--space-6) var(--space-6) var(--space-16);
}

.editor-content :deep(.tiptap) {
  min-height: 360px;
  font-size: var(--text-body-size);
  line-height: 1.75;
  color: var(--text-primary);
  outline: none;
}

.editor-content :deep(.tiptap > * + *) {
  margin-top: var(--space-3);
}

.editor-content :deep(.tiptap h1) {
  font-size: 18px;
}

.editor-content :deep(.tiptap h2) {
  font-size: var(--text-section-size);
}

.editor-content :deep(.tiptap h3) {
  font-size: var(--text-body-size);
  font-weight: 600;
}

.editor-content :deep(.tiptap ul),
.editor-content :deep(.tiptap ol) {
  padding-left: var(--space-6);
}

.editor-content :deep(.tiptap ul) {
  list-style: disc;
}

.editor-content :deep(.tiptap ol) {
  list-style: decimal;
}

.editor-content :deep(.tiptap ul[data-type='taskList']) {
  list-style: none;
  padding-left: var(--space-2);
}

.editor-content :deep(.tiptap ul[data-type='taskList'] li) {
  display: flex;
  gap: var(--space-2);
  align-items: flex-start;
}

/* 原生复选框默认是浏览器蓝，和全站的青绿强调色不是一套；显式交给主题令牌 */
.editor-content :deep(.tiptap input[type='checkbox']) {
  accent-color: var(--accent);
  margin-top: 0.35em;
}

.editor-content :deep(.tiptap blockquote) {
  padding-left: var(--space-4);
  color: var(--text-secondary);
  border-left: 2px solid var(--border-strong);
}

.editor-content :deep(.tiptap pre) {
  padding: var(--space-3) var(--space-4);
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: var(--text-micro-size);
  background: var(--bg-subtle);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-control);
}

.editor-content :deep(.tiptap code) {
  font-family: var(--font-mono);
  font-size: 0.92em;
}

.editor-content :deep(.tiptap a) {
  color: var(--accent-text);
  text-decoration: underline;
}

.editor-content :deep(.tiptap p.is-editor-empty:first-child::before) {
  float: left;
  height: 0;
  color: var(--text-tertiary);
  pointer-events: none;
  content: attr(data-placeholder);
}
</style>
