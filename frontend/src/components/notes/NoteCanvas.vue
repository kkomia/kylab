<script setup lang="ts">
/**
 * 笔记的**文档画布**：只负责 ProseMirror 实例与正文渲染，不含工具栏。
 *
 * **一个实例服务所有笔记**。切换笔记不再重建编辑器——重建要付两份代价：
 * 扩展/口令/插件全部重装，以及新画布挂进 Vue 的一次卸载+挂载；
 * 换成"原地换文档"后，工具栏、DOM、滚动容器、插件视图全都留着。
 *
 * 难点是撤销栈隔离：Tiptap v3 没有清历史的公开 API，`setContent` 又会把
 * "整篇替换"记成一步（于是 Ctrl+Z 能把上一条笔记撤回来，再被自动保存写进当前这条）。
 * 解法是 `view.updateState(EditorState.create({ doc, plugins }))`——
 * ProseMirror 会**重新初始化所有插件 state**（历史自然归零），文档和视图原地保留。
 * 之前以为这招在 v3 无效，实测是错的：`editor.state` 会跟着新 state 走，
 * `can().undo()` 也确为 false（见 NoteCanvas.test.ts）。
 *
 * 另外维护一份 markdown → 文档的缓存：切回看过的笔记时省掉
 * markdown → HTML → DOM 这一趟解析（它是切换里最贵的一段）。
 */
import type { Editor } from '@tiptap/core'
import { createDocument } from '@tiptap/core'
import { Placeholder } from '@tiptap/extension-placeholder'
import { TaskItem } from '@tiptap/extension-task-item'
import { TaskList } from '@tiptap/extension-task-list'
import Image from '@tiptap/extension-image'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import StarterKit from '@tiptap/starter-kit'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import { watch } from 'vue'
import { Markdown } from 'tiptap-markdown'

const props = withDefaults(
  defineProps<{ modelValue: string; editable?: boolean; noteId?: string }>(),
  { editable: true, noteId: undefined },
)
const emit = defineEmits<{
  'update:modelValue': [value: string]
  /** 实例就绪/销毁时通知父组件（工具栏的激活态、命令都要用它）。 */
  ready: [editor: Editor | null]
  /** 每次交易之后通知父组件重算工具栏状态。 */
  change: []
}>()

/** 最近一次由本组件发出去的 markdown：用来判断"外部真的改了内容吗"，省一次全量序列化。 */
let lastEmitted = props.modelValue

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
    lastEmitted = markdownOf(instance)
    emit('update:modelValue', lastEmitted)
  },
  onTransaction: () => {
    emit('change')
  },
})

/**
 * markdown → 文档的缓存。key 是 markdown 原文，value 是解析好的 ProseMirror 文档。
 *
 * 同一个编辑器实例意味着 schema 不变，因此解析好的文档可以跨 state 复用
 * （ProseMirror 的 Node 不可变，共享是安全的）。容量很小：只为"来回切几条"服务。
 */
const docCache = new Map<string, ProseMirrorNode>()
const DOC_CACHE_LIMIT = 8

function remember(markdown: string, doc: ProseMirrorNode): void {
  docCache.delete(markdown) // 重新插入以便让最近使用的那条排到最后
  docCache.set(markdown, doc)
  if (docCache.size > DOC_CACHE_LIMIT) {
    const oldest = docCache.keys().next().value
    if (oldest !== undefined) docCache.delete(oldest)
  }
}

watch(
  editor,
  (instance) => {
    if (instance) remember(props.modelValue, instance.state.doc)
    emit('ready', instance ?? null)
  },
  { immediate: true },
)

/**
 * 换 state 并**手动同步 Tiptap 的响应式 state**。
 *
 * `@tiptap/vue-3` 的 Editor 是 core Editor 的子类，它把 state 缓存在 `reactiveState`
 * 这个 customRef 里，只在自己的 `beforeTransaction` 钩子（以及 register/unregisterPlugin）
 * 里刷新。`view.updateState` 是 ProseMirror 的底层方法，绕过了那套钩子——
 * 不同步的话 `editor.state` / `can().undo()` 会停留在**旧笔记**上，
 * 工具栏状态是错的，`editor.commands.undo()` 甚至会拿旧文档去撤销。
 * 这里做的是 Tiptap 自己在 `registerPlugin` 里做的事，写法与它保持一致。
 */
function applyState(instance: Editor, state: EditorState): void {
  instance.view.updateState(state)
  const reactive = (instance as unknown as { reactiveState?: { value: EditorState } }).reactiveState
  if (reactive) reactive.value = state
}

/** 上一个已灌进去的笔记 id：用来区分"换笔记"与"同一条笔记内容被外部改写"。 */
let appliedNoteId: string | undefined = props.noteId

/**
 * 换笔记：一条 `updateState` 同时换文档 + 清撤销栈（命中文档缓存时零解析）。
 * 同一条笔记内容被外部改写（AI 写回）：走 setContent，**保留历史**——
 * 用户要能撤销掉 AI 的改动（提示里也是这么承诺的）。
 */
watch(
  [() => props.modelValue, () => props.noteId],
  ([value, noteId]) => {
    const instance = editor.value
    if (!instance) return
    const switched = noteId !== appliedNoteId
    if (switched) {
      appliedNoteId = noteId
      // 把离开这条的当前文档按当时的 markdown 存起来，回来时零解析
      remember(markdownOf(instance), instance.state.doc)
    } else if (value === lastEmitted) {
      return
    }
    if (switched) {
      const cached = docCache.get(value)
      const plugins = instance.state.plugins
      if (cached) {
        applyState(instance, EditorState.create({ doc: cached, plugins }))
      } else {
        instance.commands.setContent(value || '', { emitUpdate: false })
        remember(value, instance.state.doc)
        applyState(instance, EditorState.create({ doc: instance.state.doc, plugins }))
      }
      lastEmitted = value
    } else {
      instance.commands.setContent(value || '', { emitUpdate: false })
      remember(value, instance.state.doc)
      lastEmitted = value
    }
    // updateState 绕过了 dispatchTransaction，Tiptap 的 onTransaction 不会响——
    // 工具栏的激活态/可撤销态得手动让它重算一次
    emit('change')
  },
  { immediate: true },
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

/** 同上：拿到 markdown 解析器（把 markdown 转成 HTML 字符串，再交给 ProseMirror）。 */
function markdownParserOf(instance: Editor): { parse: (content: string) => string } {
  return (
    instance.storage as unknown as {
      markdown: { parser: { parse: (content: string) => string } }
    }
  ).markdown.parser
}

/**
 * 预热：把某篇的 markdown **提前解析成文档**塞进缓存，切换时就不必再解析。
 *
 * 做法与 Tiptap 的 `setContent` 完全一致（`createDocument(parser.parse(md), schema)`），
 * 所以产出的文档与正常装载一模一样，只是挪到了"鼠标悬停"这段空档里做——
 * 大笔记的解析要几十毫秒，放在点击之后就是肉眼可见的一顿，放在悬停期间则完全被藏掉。
 *
 * 只处理 markdown 与当前一致的篇目；解析失败静默放弃（真装载时会正常报错）。
 */
function warm(markdown: string): void {
  const instance = editor.value
  if (!instance || docCache.has(markdown)) return
  try {
    const html = markdownParserOf(instance).parse(markdown || '')
    const doc = createDocument(
      html,
      instance.schema,
      {},
      {
        errorOnInvalidContent: instance.options.enableContentCheck,
      },
    )
    // markdown 走的是 HTML 字符串分支，产出应是整篇 doc；不是就放弃，别把 Fragment 塞进缓存
    if (!('type' in doc) || doc.type.name !== 'doc') return
    remember(markdown, doc)
  } catch {
    // 预热是尽力而为：失败就留给真正的装载去解析/报错
  }
}

defineExpose({ warm })
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
  font-size: var(--text-page-title-size);
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
