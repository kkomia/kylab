<script setup lang="ts">
/**
 * 笔记的**文档画布**：只负责 ProseMirror 实例与正文渲染，不含工具栏。
 *
 * 为什么单独拆出来：Tiptap v3 自己维护编辑器 state（`view.updateState` 改不动它），
 * 也没有清撤销栈的公开 API。于是"切换笔记"只能靠**换一个实例**来保证撤销栈隔离——
 * 而"换实例"如果连工具栏一起换，就会看到整条工具栏闪一下、感觉卡。
 * 拆开之后：调用方给本组件加 `:key="noteId"`，切换时只重建这块画布，
 * 工具栏/标题/标签/动作全部留在父组件里不动。
 */
import { Placeholder } from '@tiptap/extension-placeholder'
import { TaskItem } from '@tiptap/extension-task-item'
import { TaskList } from '@tiptap/extension-task-list'
import Image from '@tiptap/extension-image'
import StarterKit from '@tiptap/starter-kit'
import type { Editor } from '@tiptap/core'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import { watch } from 'vue'
import { Markdown } from 'tiptap-markdown'

const props = withDefaults(defineProps<{ modelValue: string; editable?: boolean }>(), {
  editable: true,
})
const emit = defineEmits<{
  'update:modelValue': [value: string]
  /** 实例就绪/销毁时通知父组件（工具栏的激活态、命令都要用它）。 */
  ready: [editor: Editor | null]
  /** 每次交易之后通知父组件重算工具栏状态。 */
  change: []
}>()

const editor = useEditor({
  editable: props.editable,
  content: props.modelValue,
  extensions: [
    StarterKit.configure({
      // 笔记里贴链接是常态，但点一下就跳走会打断写作——按住 Ctrl 才打开
      link: { openOnClick: false, autolink: true },
    }),
    Placeholder.configure({ placeholder: '记录点什么… 选中文字后可用上方工具栏格式化' }),
    TaskList,
    TaskItem.configure({ nested: true }),
    // 配图：地址是带签名的相对链接，正文里存的就是它（Markdown 里是 ![](...)）
    Image.configure({ inline: false, allowBase64: false }),
    Markdown.configure({ html: false, linkify: true, breaks: false }),
  ],
  onUpdate: ({ editor: instance }) => {
    emit('update:modelValue', markdownOf(instance))
  },
  onTransaction: () => {
    emit('change')
  },
})

watch(
  editor,
  (instance) => emit('ready', instance ?? null),
  { immediate: true },
)

/** 外部改正文（AI 写回、或同一实例内被程序改写）时灌进去；不比较会重置光标。 */
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
 * tiptap-markdown 没有把 `storage.markdown` 补进 Tiptap 的类型声明，
 * 这里给它一个明确的形状再取——比在调用处到处 `as any` 收敛。
 */
function markdownOf(instance: { storage: unknown }): string {
  return (instance.storage as { markdown: { getMarkdown: () => string } }).markdown.getMarkdown()
}
</script>

<template>
  <EditorContent class="editor-content" :editor="editor" />
</template>

<style scoped>
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

.editor-content :deep(.tiptap img) {
  max-width: 100%;
  height: auto;
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-control);
}

.editor-content :deep(.tiptap img.ProseMirror-selectednode) {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.editor-content :deep(.tiptap p.is-editor-empty:first-child::before) {
  float: left;
  height: 0;
  color: var(--text-tertiary);
  pointer-events: none;
  content: attr(data-placeholder);
}
</style>
