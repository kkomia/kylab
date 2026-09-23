/**
 * 笔记编辑器：**工具栏 + 标题/标签 + 文档画布**（Tiptap，headless）。
 *
 * 与旧 Vue 版（`frontend/src/components/notes/NoteEditor.vue`）逐条对齐：
 *
 * - 工具栏按钮、分组的顺序与 title 一字不改（撤销/重做｜正文·H1·H2｜粗斜下删｜
 *   无序·有序·待办｜引用·代码·链接·图片｜右侧：上传提示 · 保存状态 · AI · 页面动作）；
 * - 工具栏**吸顶**：吸附对象是正文列的滚动容器（笔记页的 `.notes-pane`），
 *   中间那一级 `.note-editor` 不许有 `overflow: hidden`，`.editor-body` 也刻意不设
 *   overflow——它一旦自己滚起来，列那层就被架空，sticky 从此贴在一个不动的盒子上；
 * - **画布单实例**：换笔记靠"原地换文档 + 清撤销栈"（见 NoteCanvas），
 *   编辑器全程留在原地，工具栏/标题/动作/滚动容器都不重建；
 * - 图片上传的**唯一通道**：工具栏选图与正文粘贴都走 `uploadImageForEditor`；
 * - 每条笔记记一个滚动位置（换文档之后滚动位置不再被重建，不主动处理就会继承上一条的）。
 *
 * 三条与 Vue 版的**有意差异**（都是为了 React 的渲染模型，行为不变）：
 * 1. 工具栏的激活态由"每次交易/换文档递增一个 revision"驱动重渲染（Vue 里靠
 *    `onTransaction` 事件 + 一个普通 ref，React 里重渲染要靠 state）；
 * 2. 滚动位置改成**滚动时随手记**（Vue 版是在 noteId 变化时读一次，读到的已经
 *    是换文档之后的位置，长笔记切短笔记那一瞬间会被钳住）；
 * 3. AI 菜单用 `@/ui/dropdown-menu`（shadcn 原语；旧版是原生 `<details>` 自绘浮层）。
 */
import type { Editor } from '@tiptap/core'
import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Image as ImageIcon,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  ListTodo,
  Pilcrow,
  Quote,
  Redo,
  Sparkles,
  Strikethrough,
  Underline as UnderlineIcon,
  Undo,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react'

import { uploadNoteImage, type NoteAiAction, type NoteImage } from '@/api/notes'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu'

import { NoteCanvas, type NoteCanvasHandle } from './NoteCanvas'

export interface NoteEditorHandle {
  /** 转发给画布：提前把某篇的正文解析成文档（切换时省掉这段主线程开销）。 */
  warm(markdown: string): void
}

export interface NoteEditorProps {
  value: string
  editable?: boolean
  noteId?: string
  aiBusy?: boolean
  /** 正在等这条笔记的正文（缓存未命中）：给内容一层"正在换"的过渡，别硬切。 */
  loading?: boolean
  /** 保存状态（页面给，编辑器不做全局通知）。 */
  status?: ReactNode
  /** 对这条笔记的动作（置顶/加入知识库/删除）。 */
  actions?: ReactNode
  /** 文档头（标题输入框、标签行、入库状态）。 */
  header?: ReactNode
  /** 落在根节点上的类名：页面用它挂 `.pane-editor`（撑满正文列但不被压矮）。 */
  className?: string
  onValueChange(value: string): void
  onNotify(payload: { type: 'error' | 'success'; message: string }): void
  /** 请求对本篇做一次 AI 处理；由页面负责保存、调用、写回。 */
  onAi(action: NoteAiAction): void
  ref?: Ref<NoteEditorHandle>
}

/**
 * MIME → 后缀。
 *
 * 剪贴板里的图常常**没有文件名**（截图工具给的是空串或 "blob"），而后端按后缀判
 * 白名单，不补一个必然被"不支持的图片格式"挡回来——这条路径的真实拦路虎就是它。
 */
const SUFFIX_BY_TYPE: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
}

/** 给没有后缀的图按 MIME 补一个后缀；已经有后缀（哪怕是别的）就不动，让后端去判。 */
function withSuffixFromType(file: File): File {
  const suffix = SUFFIX_BY_TYPE[file.type.toLowerCase()]
  if (!suffix || /\.[a-z0-9]{2,5}$/i.test(file.name)) return file
  const base = file.name.trim() || '粘贴的图片'
  return new File([file], `${base}${suffix}`, { type: file.type })
}

/**
 * 正文滚动容器：往上找第一个"样式允许滚且确实滚得动"的祖先，找不到就退回页面。
 *
 * 不写死类名是刻意的：并排两列时滚的是笔记页的正文列（`.notes-pane`）；
 * 单栏堆叠（<=900px）时那一列把滚动交回了外层 `main.content`。
 * 笔记页那次"两列各自滚"的改造正是靠这一条没被牵动。
 */
function scrollParentOf(el: HTMLElement | null): HTMLElement | null {
  let node: HTMLElement | null = el
  while (node) {
    const overflowY = getComputedStyle(node).overflowY
    const scrollable = overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay'
    if (scrollable && node.scrollHeight > node.clientHeight + 1) return node
    node = node.parentElement
  }
  return (document.scrollingElement as HTMLElement | null) ?? null
}

export function NoteEditor({
  value,
  editable = true,
  noteId,
  aiBusy = false,
  loading = false,
  status,
  actions,
  header,
  className,
  onValueChange,
  onNotify,
  onAi,
  ref,
}: NoteEditorProps) {
  const canvasRef = useRef<NoteCanvasHandle | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const [uploading, setUploading] = useState(false)

  /**
   * 画布交回来的实例（工具栏的激活态与命令都要用它）。
   *
   * Tiptap 实例不在 React 的响应式图里，不能直接 `useMemo(isActive)`——
   * 改成"画布每次交易后通知一次"的普通 state 计数，下面的 `active` 每渲染现算。
   */
  const instanceRef = useRef<Editor | null>(null)
  const [, forceToolbarRefresh] = useState(0)

  const refresh = useCallback(() => forceToolbarRefresh((count) => count + 1), [])

  const onReady = useCallback(
    (instance: Editor | null) => {
      instanceRef.current = instance
      refresh()
    },
    [refresh],
  )

  /** 各按钮的激活/可用态：每次渲染现读，读到的是**当前**文档与选区。 */
  function activeState() {
    const current = instanceRef.current
    if (!current || current.isDestroyed) {
      return {
        paragraph: false,
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
      }
    }
    return {
      paragraph: current.isActive('paragraph'),
      h1: current.isActive('heading', { level: 1 }),
      h2: current.isActive('heading', { level: 2 }),
      bold: current.isActive('bold'),
      italic: current.isActive('italic'),
      underline: current.isActive('underline'),
      strike: current.isActive('strike'),
      bullet: current.isActive('bulletList'),
      ordered: current.isActive('orderedList'),
      task: current.isActive('taskList'),
      quote: current.isActive('blockquote'),
      code: current.isActive('codeBlock'),
      link: current.isActive('link'),
      canUndo: current.can().undo(),
      canRedo: current.can().redo(),
    }
  }

  const active = activeState()

  function run(action: (editor: Editor) => void): void {
    const current = instanceRef.current
    if (!current || current.isDestroyed) return
    action(current)
  }

  function toggleLink(): void {
    const current = instanceRef.current
    if (!current || current.isDestroyed) return
    if (current.isActive('link')) {
      current.chain().focus().unsetLink().run()
      return
    }
    const url = window.prompt('链接地址（留空则取消）', 'https://')
    if (!url) return
    current.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
  }

  /**
   * 图片上传的**唯一通道**：工具栏选图与正文粘贴都走它。
   *
   * 失败时返回 null（并弹提示）而**不是**抛异常：调用方据此什么都不插——
   * 半截内容（比如 data URL）留在正文里比"没插上"更糟。
   */
  async function uploadImageForEditor(file: File): Promise<NoteImage | null> {
    if (!noteId) {
      onNotify({ type: 'error', message: '笔记还没保存，先等一下再插图' })
      return null
    }
    setUploading(true)
    try {
      return await uploadNoteImage(noteId, withSuffixFromType(file))
    } catch (cause) {
      onNotify({
        type: 'error',
        message: cause instanceof Error ? cause.message : '图片上传失败',
      })
      return null
    } finally {
      setUploading(false)
    }
  }

  function pickImage(): void {
    fileInputRef.current?.click()
  }

  /** 选图 → 上传到后端 → 以带签名的地址插入。图片标签带不了鉴权头，所以必须签名地址。 */
  async function onFileChange(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const input = event.target
    const file = input.files?.[0]
    input.value = '' // 允许连续选同一张
    if (!file) return
    const image = await uploadImageForEditor(file)
    // 上传期间笔记可能已经切走（画布换的是文档、实例还在），所以落图前重取一次实例
    const current = instanceRef.current
    if (!image || !current || current.isDestroyed) return
    current.chain().focus().setImage({ src: image.url, alt: image.alt }).run()
  }

  /** 选定 AI 动作后交给页面执行（页面负责先保存，再替换正文）。 */
  function chooseAi(action: NoteAiAction): void {
    if (aiBusy) return
    onAi(action)
  }

  useImperativeHandle(
    ref,
    () => ({ warm: (markdown: string) => canvasRef.current?.warm(markdown) }),
    [],
  )

  /**
   * 每条笔记记一个滚动位置。
   *
   * 单实例换文档之后，滚动位置不再被重建——如果不主动处理，切到新笔记会**继承上一条
   * 的滚动位置**（长笔记切走再回来停在半中间很突兀，切到短笔记还会因高度骤减而乱跳）。
   * 记住每条自己的位置，回来时接着看，这也是笔记类应用的常规手感。
   */
  const scrollByNote = useRef(new Map<string, number>())

  useEffect(() => {
    const scroller = scrollParentOf(bodyRef.current)
    if (!scroller) return
    const currentNoteId = noteId
    const onScroll = (): void => {
      if (currentNoteId) scrollByNote.current.set(currentNoteId, scroller.scrollTop)
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      onScroll() // 离开这条之前把位置存下来
      scroller.removeEventListener('scroll', onScroll)
    }
  }, [noteId])

  // 画布的换文档 effect 在子组件里先跑，这一条后跑：读到的已经是新文档的高度
  useEffect(() => {
    const scroller = scrollParentOf(bodyRef.current)
    if (scroller) scroller.scrollTop = (noteId && scrollByNote.current.get(noteId)) || 0
  }, [noteId])

  return (
    <div className={className ? `note-editor ${className}` : 'note-editor'}>
      <div className="toolbar" role="toolbar" aria-label="排版工具栏">
        <div className="tool-group">
          <button
            type="button"
            className="tool"
            title="撤销"
            disabled={!active.canUndo}
            onClick={() => run((editor) => editor.chain().focus().undo().run())}
          >
            <Undo size={15} />
          </button>
          <button
            type="button"
            className="tool"
            title="重做"
            disabled={!active.canRedo}
            onClick={() => run((editor) => editor.chain().focus().redo().run())}
          >
            <Redo size={15} />
          </button>
        </div>

        <span className="tool-sep" aria-hidden="true" />

        <div className="tool-group">
          <button
            type="button"
            className={`tool${active.paragraph ? ' tool-on' : ''}`}
            title="正文"
            onClick={() => run((editor) => editor.chain().focus().setParagraph().run())}
          >
            <Pilcrow size={15} />
          </button>
          <button
            type="button"
            className={`tool${active.h1 ? ' tool-on' : ''}`}
            title="一级标题"
            onClick={() =>
              run((editor) => editor.chain().focus().toggleHeading({ level: 1 }).run())
            }
          >
            <Heading1 size={15} />
          </button>
          <button
            type="button"
            className={`tool${active.h2 ? ' tool-on' : ''}`}
            title="二级标题"
            onClick={() =>
              run((editor) => editor.chain().focus().toggleHeading({ level: 2 }).run())
            }
          >
            <Heading2 size={15} />
          </button>
        </div>

        <span className="tool-sep" aria-hidden="true" />

        <div className="tool-group">
          <button
            type="button"
            className={`tool${active.bold ? ' tool-on' : ''}`}
            title="粗体"
            onClick={() => run((editor) => editor.chain().focus().toggleBold().run())}
          >
            <Bold size={15} />
          </button>
          <button
            type="button"
            className={`tool${active.italic ? ' tool-on' : ''}`}
            title="斜体"
            onClick={() => run((editor) => editor.chain().focus().toggleItalic().run())}
          >
            <Italic size={15} />
          </button>
          <button
            type="button"
            className={`tool${active.underline ? ' tool-on' : ''}`}
            title="下划线"
            onClick={() => run((editor) => editor.chain().focus().toggleUnderline().run())}
          >
            <UnderlineIcon size={15} />
          </button>
          <button
            type="button"
            className={`tool${active.strike ? ' tool-on' : ''}`}
            title="删除线"
            onClick={() => run((editor) => editor.chain().focus().toggleStrike().run())}
          >
            <Strikethrough size={15} />
          </button>
        </div>

        <span className="tool-sep" aria-hidden="true" />

        <div className="tool-group">
          <button
            type="button"
            className={`tool${active.bullet ? ' tool-on' : ''}`}
            title="无序列表"
            onClick={() => run((editor) => editor.chain().focus().toggleBulletList().run())}
          >
            <List size={15} />
          </button>
          <button
            type="button"
            className={`tool${active.ordered ? ' tool-on' : ''}`}
            title="有序列表"
            onClick={() => run((editor) => editor.chain().focus().toggleOrderedList().run())}
          >
            <ListOrdered size={15} />
          </button>
          <button
            type="button"
            className={`tool${active.task ? ' tool-on' : ''}`}
            title="待办清单"
            onClick={() => run((editor) => editor.chain().focus().toggleTaskList().run())}
          >
            <ListTodo size={15} />
          </button>
        </div>

        <span className="tool-sep" aria-hidden="true" />

        <div className="tool-group">
          <button
            type="button"
            className={`tool${active.quote ? ' tool-on' : ''}`}
            title="引用"
            onClick={() => run((editor) => editor.chain().focus().toggleBlockquote().run())}
          >
            <Quote size={15} />
          </button>
          <button
            type="button"
            className={`tool${active.code ? ' tool-on' : ''}`}
            title="代码块"
            onClick={() => run((editor) => editor.chain().focus().toggleCodeBlock().run())}
          >
            <Code size={15} />
          </button>
          <button
            type="button"
            className={`tool${active.link ? ' tool-on' : ''}`}
            title="链接"
            onClick={toggleLink}
          >
            <LinkIcon size={15} />
          </button>
          <button
            type="button"
            className="tool"
            disabled={uploading || !noteId}
            title={noteId ? '插入图片' : '保存后才能插入图片'}
            onClick={pickImage}
          >
            <ImageIcon size={15} />
          </button>
        </div>

        <div className="toolbar-right">
          {/* 上传中要有可见反馈：从"粘/选"到图片落进正文之间有一段时间，
              只把按钮置灰的话，用户会以为这次粘贴没被受理 */}
          {uploading ? (
            <span className="upload-hint" role="status">
              图片上传中…
            </span>
          ) : null}
          {/* 保存状态放在最左：它是"这条笔记当前的状态"，比任何动作都更该先被看到 */}
          {status}
          {/* AI 处理：星芒图标 + 三档动作下拉。放在格式工具栏与右侧动作之间——
              它属于"对内容做什么"，不属于"对这条笔记做什么"。 */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={`ai-trigger${aiBusy ? ' ai-busy' : ''}`}
                title={aiBusy ? 'AI 正在处理…' : 'AI 处理'}
                aria-label="AI 处理"
              >
                {aiBusy ? (
                  <span className="ai-spinner" aria-hidden="true" />
                ) : (
                  <Sparkles size={15} />
                )}
                <span className="ai-trigger-text">{aiBusy ? '处理中' : 'AI'}</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={4} className="min-w-[200px]">
              {/* 两行式菜单项（标题 + 一句说明）：`menu-item-title` / `menu-desc`
                  是 tokens.css 里给这种菜单项准备的那一对类 */}
              <DropdownMenuItem
                className="flex-col items-start gap-0"
                disabled={aiBusy}
                onSelect={() => chooseAi('format')}
              >
                <span className="menu-item-title">智能排版</span>
                <span className="menu-desc">只调分段与标题，不改文字</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                className="flex-col items-start gap-0"
                disabled={aiBusy}
                onSelect={() => chooseAi('polish')}
              >
                <span className="menu-item-title">内容润色</span>
                <span className="menu-desc">只改措辞与标点，不动结构</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                className="flex-col items-start gap-0"
                disabled={aiBusy}
                onSelect={() => chooseAi('both')}
              >
                <span className="menu-item-title">排版并润色</span>
                <span className="menu-desc">两件事一起做</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {actions}
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"
          className="file-input"
          aria-label="插入图片"
          onChange={(event) => void onFileChange(event)}
        />
      </div>

      <div ref={bodyRef} className={`editor-body${loading ? ' is-loading' : ''}`}>
        <div className="editor-column">
          {header}
          {/* 单实例：切换笔记由画布原地换文档并清撤销栈，这里不上 key、不重建 */}
          <NoteCanvas
            ref={canvasRef}
            value={value}
            editable={editable}
            noteId={noteId}
            uploadImage={uploadImageForEditor}
            onValueChange={onValueChange}
            onReady={onReady}
            onChange={refresh}
          />
        </div>
      </div>
    </div>
  )
}

export default NoteEditor
