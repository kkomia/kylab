/**
 * 笔记的**文档画布**：只负责 ProseMirror 实例与正文渲染，不含工具栏。
 *
 * 与旧 Vue 版（`frontend/src/components/notes/NoteCanvas.vue`）逐条对齐的四件事：
 *
 * 1. **一个实例服务所有笔记**。切换笔记不再重建编辑器——重建要付两份代价：
 *    扩展/口令/插件全部重装，以及新画布挂进 React 的一次卸载+挂载；
 *    换成"原地换文档"后，工具栏、DOM、滚动容器、插件视图全都留着。
 * 2. **撤销栈隔离**：Tiptap v3 没有清历史的公开 API，`setContent` 又会把
 *    "整篇替换"记成一步（于是 Ctrl+Z 能把上一条笔记撤回来，再被自动保存写进当前这条）。
 *    解法是 `view.updateState(EditorState.create({ doc, plugins }))`——
 *    ProseMirror 会**重新初始化所有插件 state**（历史自然归零），文档和视图原地保留。
 * 3. **markdown → 文档的缓存**：切回看过的笔记时省掉解析这一趟（切换里最贵的一段）。
 * 4. **粘贴图片接管**：`handlePaste` 只能同步认领，插入位置必须在认领那一刻记下来。
 *
 * React 与 Vue 的唯一差别在"状态怎么通知出去"：Vue 版有 `reactiveState` 这一个
 * customRef 要手动同步，而 React 版没有那层缓存（`editor.state` 本来就是
 * `view.state` 的 getter），所以 `updateState` 之后**只需要让工具栏重渲染一次**
 * （`onChange` → 页面里那个 revision）。文档换没换对，读 `editor.state` 就是真相。
 */
import type { Editor } from '@tiptap/core'
import { createDocument } from '@tiptap/core'
import { Placeholder } from '@tiptap/extension-placeholder'
import { TaskItem } from '@tiptap/extension-task-item'
import { TaskList } from '@tiptap/extension-task-list'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useCallback, useEffect, useImperativeHandle, useRef, type Ref } from 'react'
import { Markdown } from 'tiptap-markdown'

import { NoteImage } from './noteImage'

export interface NoteCanvasHandle {
  /** 提前把某篇的正文解析成文档（切换时省掉这段主线程开销）。 */
  warm(markdown: string): void
}

export interface NoteCanvasProps {
  value: string
  editable?: boolean
  noteId?: string
  /**
   * 粘贴图片时把文件交出去上传，成功回一个可直接当 `<img src>` 的地址。
   * 没有这个回调就不接管粘贴（保持默认粘贴行为）——画布本身不必知道
   * 笔记接口、登录凭据与提示机制。
   */
  uploadImage?: (file: File) => Promise<{ url: string; alt?: string } | null>
  onValueChange(value: string): void
  /** 实例就绪/销毁时通知父组件（工具栏的激活态、命令都要用它）。 */
  onReady?(editor: Editor | null): void
  /** 每次交易（以及换文档）之后通知父组件重算工具栏状态。 */
  onChange?(): void
  ref?: Ref<NoteCanvasHandle>
}

/**
 * 编辑器配置：与旧 Vue 版逐一对应，只换宿主框架。
 *
 * `Markdown.configure` 的三个开关就是**落盘口径**本身（html: false 让裸 HTML
 * 当纯文本、linkify 认裸链接、breaks: false 不把单换行当 `<br>`），不能随手动。
 */
const NOTE_EXTENSIONS = [
  StarterKit.configure({
    // 笔记里贴链接是常态，但点一下就跳走会打断写作——按住 Ctrl 才打开
    link: { openOnClick: false, autolink: true },
  }),
  Placeholder.configure({ placeholder: '记录点什么… 选中文字后可用上方工具栏格式化' }),
  TaskList,
  TaskItem.configure({ nested: true }),
  // 配图：地址是带签名的相对链接，正文里存的就是它（Markdown 里是 ![](...)）。
  // resize 打开**右下角一个**手柄：只留一个角、且平时透明，拖拽时按原图比例缩放。
  NoteImage.configure({
    inline: false,
    allowBase64: false,
    resize: {
      enabled: true,
      directions: ['bottom-right'],
      minWidth: 48,
      alwaysPreserveAspectRatio: true,
    },
  }),
  Markdown.configure({ html: false, linkify: true, breaks: false }),
]

/** 剪贴板里的图片文件：优先看 `files`，没有再看 `items`（截图工具常只塞后者）。 */
function imageFilesOf(data: DataTransfer | null): File[] {
  if (!data) return []
  const files = Array.from(data.files ?? []).filter((file) => file.type.startsWith('image/'))
  if (files.length) return files
  return Array.from(data.items ?? [])
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null)
}

/**
 * markdown → 文档的缓存。key 是 markdown 原文，value 是解析好的 ProseMirror 文档。
 *
 * 同一个编辑器实例意味着 schema 不变，因此解析好的文档可以跨 state 复用
 * （ProseMirror 的 Node 不可变，共享是安全的）。容量很小：只为"来回切几条"服务。
 */
const docCache = new Map<string, ProseMirrorNode>()
const DOC_CACHE_LIMIT = 8

function rememberDoc(markdown: string, doc: ProseMirrorNode): void {
  docCache.delete(markdown) // 重新插入以便让最近使用的那条排到最后
  docCache.set(markdown, doc)
  if (docCache.size > DOC_CACHE_LIMIT) {
    const oldest = docCache.keys().next().value
    if (oldest !== undefined) docCache.delete(oldest)
  }
}

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

/** 换 state：一条 `updateState` 同时换文档 + 清撤销栈（见文件头第 2 条）。 */
function applyState(instance: Editor, state: EditorState): void {
  instance.view.updateState(state)
}

/** 逐张上传再插入；多张时后一张接在前一张之后（都插在当初那个粘贴位置）。 */
async function insertImages(
  files: readonly File[],
  at: number,
  upload: (file: File) => Promise<{ url: string; alt?: string } | null>,
  current: () => Editor | null,
): Promise<void> {
  let position = at
  for (const file of files) {
    const image = await upload(file)
    const instance = current()
    // 上传期间编辑器可能已经销毁（切走、关页）：到这里为止，别再碰它
    if (!instance || instance.isDestroyed) return
    if (!image) continue
    // 位置可能已被这段时间里的编辑推远：夹在文档长度内，别抛 RangeError
    const pos = Math.max(0, Math.min(position, instance.state.doc.content.size))
    instance
      .chain()
      .insertContentAt(pos, { type: 'image', attrs: { src: image.url, alt: image.alt } })
      .focus()
      .run()
    position = pos + 1 // 图片节点在文档里占一位
  }
}

export function NoteCanvas({
  value,
  editable = true,
  noteId,
  uploadImage,
  onValueChange,
  onReady,
  onChange,
  ref,
}: NoteCanvasProps) {
  const editorRef = useRef<Editor | null>(null)

  /**
   * 回调与最新的 props 都放一份在 ref 里。
   *
   * Tiptap 的编辑器是**在渲染期**建出来的（`useEditor` 的 `immediatelyRender`），
   * 它的选项只在创建那一刻被读一次，之后靠 `setOptions` 打补丁；把回调经 ref 转一手，
   * 就不必依赖"每次渲染都刚好补了一次 setOptions"这件不能保证的事。
   * 渲染期写 ref 在这里是安全的：它只是一份"最新值"的快照，不参与渲染结果。
   */
  const latest = useRef({ value, noteId, uploadImage, onValueChange, onReady, onChange })
  latest.current = { value, noteId, uploadImage, onValueChange, onReady, onChange }

  /** 最近一次由本组件发出去的 markdown：用来判断"外部真的改了内容吗"，省一次全量序列化。 */
  const lastEmittedRef = useRef(value)
  /** 上一个已灌进去的笔记 id：用来区分"换笔记"与"同一条笔记内容被外部改写"。 */
  const appliedNoteIdRef = useRef(noteId)

  const handlePaste = useCallback((_view: EditorView, event: ClipboardEvent): boolean => {
    const upload = latest.current.uploadImage
    const instance = editorRef.current
    const files = imageFilesOf(event.clipboardData)
    // 只读笔记不接管：`insertContentAt` 是命令，绕得过 contenteditable，
    // 接管了就会往只读文档里插东西
    if (!upload || files.length === 0 || !instance?.isEditable) return false
    void insertImages(files, instance.state.selection.from, upload, () => editorRef.current)
    return true
  }, [])

  const editor = useEditor({
    editable,
    content: value,
    extensions: NOTE_EXTENSIONS,
    editorProps: { handlePaste },
    onCreate: ({ editor: instance }) => {
      rememberDoc(latest.current.value, instance.state.doc)
    },
    onUpdate: ({ editor: instance }) => {
      lastEmittedRef.current = markdownOf(instance)
      latest.current.onValueChange(lastEmittedRef.current)
    },
    onTransaction: () => latest.current.onChange?.(),
  })

  /** 实例的交接（就绪通知 + 供粘贴/插图用的那一份引用）。 */
  useEffect(() => {
    editorRef.current = editor
    latest.current.onReady?.(editor ?? null)
  }, [editor])

  /**
   * 只读态：**只在真的变化时**才调 `setEditable`。
   *
   * Tiptap 的 `setEditable(editable, emitUpdate = true)` 默认会**发一次 update**，
   * 而挂载时那次"同步"会把初始正文当成一次编辑报上去（旧 Vue 版的 `watch` 没有
   * `immediate`，天然不会在挂载时触发，这里补一条同样的门槛）。
   */
  const editableRef = useRef(editable)
  useEffect(() => {
    if (editableRef.current === editable) return
    editableRef.current = editable
    editor?.setEditable(editable)
  }, [editor, editable])

  /**
   * 换内容：**换笔记**走 `updateState`（清撤销栈 + 命中缓存时零解析），
   * **同一条笔记被外部改写**（AI 写回）走 `setContent`（保留历史，
   * 用户要能撤销掉 AI 的改动——提示里也是这么承诺的）。
   */
  useEffect(() => {
    const instance = editorRef.current
    if (!instance || instance.isDestroyed) return
    const switched = noteId !== appliedNoteIdRef.current
    if (switched) {
      appliedNoteIdRef.current = noteId
      // 把离开这条的当前文档按当时的 markdown 存起来，回来时零解析
      rememberDoc(markdownOf(instance), instance.state.doc)
    } else if (value === lastEmittedRef.current) {
      return
    }
    if (switched) {
      const cached = docCache.get(value)
      const plugins = instance.state.plugins
      if (cached) {
        applyState(instance, EditorState.create({ doc: cached, plugins }))
      } else {
        instance.commands.setContent(value || '', { emitUpdate: false })
        rememberDoc(value, instance.state.doc)
        applyState(instance, EditorState.create({ doc: instance.state.doc, plugins }))
      }
    } else {
      instance.commands.setContent(value || '', { emitUpdate: false })
      rememberDoc(value, instance.state.doc)
    }
    lastEmittedRef.current = value
    // updateState 绕过了 dispatchTransaction，Tiptap 的 onTransaction 不会响——
    // 工具栏的激活态/可撤销态得手动让它重算一次
    latest.current.onChange?.()
  }, [editor, value, noteId])

  /**
   * 预热：把某篇的 markdown **提前解析成文档**塞进缓存，切换时就不必再解析。
   *
   * 做法与 Tiptap 的 `setContent` 完全一致（`createDocument(parser.parse(md), schema)`），
   * 所以产出的文档与正常装载一模一样，只是挪到了"鼠标悬停"这段空档里做——
   * 大笔记的解析要几十毫秒，放在点击之后就是肉眼可见的一顿，放在悬停期间则完全被藏掉。
   */
  useImperativeHandle(
    ref,
    () => ({
      warm(markdown: string): void {
        const instance = editorRef.current
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
          // markdown 走的是 HTML 字符串分支，产出应是整篇 doc；不是就放弃，
          // 别把 Fragment 塞进缓存。解析失败也静默放弃（真装载时会正常报错）。
          if (!('type' in doc) || doc.type.name !== 'doc') return
          rememberDoc(markdown, doc)
        } catch {
          // 预热是尽力而为
        }
      },
    }),
    [],
  )

  return <EditorContent className="editor-content" editor={editor} />
}

export default NoteCanvas
