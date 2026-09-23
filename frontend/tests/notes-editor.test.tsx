/**
 * 笔记编辑器：**工具栏的每一条命令** + 正文头（标题/标签）+ 只读态 + 吸顶契约。
 *
 * 工具栏这一层要验的是"点哪个按钮发哪条命令、激活态怎么画"——与文档内容无关，
 * 所以这里**把画布换成 mock editor**：命令链逐条记下来，断言是精确的
 * （`['focus','toggleBold','run']` 这种），比"改完正文再读回来"更能定位回归。
 * 真实 Tiptap 那一侧（文档、撤销栈、Markdown 落盘、粘贴图片）在
 * `notes-canvas.test.tsx` 与 `notes-paste.test.tsx` 里用真实例验。
 *
 * 这是旧用例 `tests/unit/components/NoteEditor.test.ts` 的路数：那边也是拿
 * `emitted('ready')` 给出的实例直接调命令，只是 Vue 版能拿到实例、React 版在这里
 * 用 mock 更稳。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL as NodeURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

import type { NoteImage } from '@/api/notes'

/** 命令链的记账本：每 `run()` 一次记一条（含参数），用来断言"点了哪个按钮"。 */
const state = vi.hoisted(() => ({
  chains: [] as string[][],
  editor: null as unknown,
}))

vi.mock('@/features/notes/NoteCanvas', async () => {
  const React = await import('react')
  return {
    NoteCanvas: (props: Record<string, unknown>) => {
      React.useEffect(() => {
        ;(props.onReady as ((editor: unknown) => void) | undefined)?.(state.editor)
        // 只报一次就绪（同真实画布：实例建好就不再变），所以依赖刻意留空
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])
      return React.createElement('div', { className: 'tiptap' })
    },
  }
})

const uploadNoteImage = vi.fn()

vi.mock('@/api/notes', () => ({
  uploadNoteImage: (...args: unknown[]) => uploadNoteImage(...args),
  getNote: vi.fn(),
  listNotes: vi.fn(),
  listNoteTags: vi.fn(),
  createNote: vi.fn(),
  updateNote: vi.fn(),
  deleteNote: vi.fn(),
  attachNote: vi.fn(),
  aiTransform: vi.fn(),
}))

import { NoteEditor, type NoteEditorProps } from '@/features/notes/NoteEditor'

const URL_A = '/api/v1/notes/n1/images/aaa.png?expires=99&signature=sig'
const IMAGE: NoteImage = { url: URL_A, name: 'aaa.png', alt: 'image.png' }

/** 一条记录命令用的 `editor.chain()` 假链：方法名与参数都进记账本。 */
function makeChain(): unknown {
  const calls: string[] = []
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      if (prop === 'run') {
        return () => {
          state.chains.push([...calls])
        }
      }
      return (...args: unknown[]) => {
        calls.push(args.length ? `${String(prop)}(${JSON.stringify(args)})` : String(prop))
        return proxy
      }
    },
  }
  const proxy = new Proxy({}, handler)
  return proxy
}

interface FakeEditorOptions {
  active?: string[]
  canUndo?: boolean
  canRedo?: boolean
  editable?: boolean
}

function makeEditor(options: FakeEditorOptions = {}): unknown {
  const flags = new Set(options.active ?? [])
  return {
    isDestroyed: false,
    isEditable: options.editable ?? true,
    isActive: (name: string, attrs?: Record<string, unknown>) =>
      flags.has(attrs ? `${name}:${JSON.stringify(attrs)}` : name),
    can: () => ({ undo: () => options.canUndo ?? false, redo: () => options.canRedo ?? false }),
    chain: () => makeChain(),
  }
}

interface EditorWire {
  values: string[]
  notices: { type: string; message: string }[]
  ai: string[]
}

function renderEditor(
  props: Partial<NoteEditorProps> = {},
  editorOptions: FakeEditorOptions = {},
): { wire: EditorWire; view: ReturnType<typeof render> } {
  state.editor = makeEditor(editorOptions)
  state.chains = []
  const wire: EditorWire = { values: [], notices: [], ai: [] }
  const view = render(
    <NoteEditor
      value={props.value ?? ''}
      // 显式传 noteId: undefined 是"这条笔记还没落盘"的场景，不能被默认值盖掉
      noteId={'noteId' in props ? props.noteId : 'n1'}
      aiBusy={props.aiBusy ?? false}
      loading={props.loading ?? false}
      header={props.header}
      status={props.status}
      actions={props.actions}
      onValueChange={(markdown) => wire.values.push(markdown)}
      onNotify={(payload) => wire.notices.push(payload)}
      onAi={(action) => wire.ai.push(action)}
    />,
  )
  return { wire, view }
}

/** 点一个工具栏按钮（按钮靠 title 认，和用户悬停看到的提示一致）。 */
function clickTool(title: string): void {
  fireEvent.click(screen.getByTitle(title))
}

const lastChain = (): string[] => state.chains.at(-1) ?? []

describe('笔记编辑器：工具栏命令', () => {
  it('撤销/重做按可用态禁用，点了发 undo/redo', () => {
    const { view } = renderEditor({}, { canUndo: false, canRedo: false })

    expect(screen.getByTitle('撤销')).toBeDisabled()
    expect(screen.getByTitle('重做')).toBeDisabled()

    view.unmount()

    renderEditor({}, { canUndo: true, canRedo: true })
    clickTool('撤销')
    expect(lastChain()).toEqual(['focus', 'undo'])
    clickTool('重做')
    expect(lastChain()).toEqual(['focus', 'redo'])
  })

  it('段落与两级标题发的是 setParagraph / toggleHeading', () => {
    renderEditor({}, { active: ['heading:{"level":1}'] })

    // 激活态由编辑器说了算：一级标题亮着
    expect(screen.getByTitle('一级标题').className).toContain('tool-on')

    clickTool('正文')
    expect(lastChain()).toEqual(['focus', 'setParagraph'])
    clickTool('一级标题')
    expect(lastChain()).toEqual(['focus', 'toggleHeading([{"level":1}])'])
    clickTool('二级标题')
    expect(lastChain()).toEqual(['focus', 'toggleHeading([{"level":2}])'])
  })

  it('四个行内标记各自发 toggle*', () => {
    renderEditor()

    clickTool('粗体')
    expect(lastChain()).toEqual(['focus', 'toggleBold'])
    clickTool('斜体')
    expect(lastChain()).toEqual(['focus', 'toggleItalic'])
    clickTool('下划线')
    expect(lastChain()).toEqual(['focus', 'toggleUnderline'])
    clickTool('删除线')
    expect(lastChain()).toEqual(['focus', 'toggleStrike'])
  })

  it('三种列表与引用/代码块各自发 toggle*', () => {
    renderEditor()

    clickTool('无序列表')
    expect(lastChain()).toEqual(['focus', 'toggleBulletList'])
    clickTool('有序列表')
    expect(lastChain()).toEqual(['focus', 'toggleOrderedList'])
    clickTool('待办清单')
    expect(lastChain()).toEqual(['focus', 'toggleTaskList'])
    clickTool('引用')
    expect(lastChain()).toEqual(['focus', 'toggleBlockquote'])
    clickTool('代码块')
    expect(lastChain()).toEqual(['focus', 'toggleCodeBlock'])
  })

  it('链接：已有链接时取消，没有时按输入的地址设上（且先选中整段链接）', async () => {
    const user = userEvent.setup()
    const prompt = vi.fn().mockReturnValue('https://example.test/a b')
    vi.stubGlobal('prompt', prompt)

    renderEditor()

    clickTool('链接')
    expect(prompt).toHaveBeenCalled()
    expect(lastChain()).toEqual([
      'focus',
      'extendMarkRange(["link"])',
      'setLink([{"href":"https://example.test/a b"}])',
    ])

    prompt.mockReturnValue('')
    clickTool('链接')
    // 留空 = 取消这次设置：没有再发出第二条命令（链长不变）
    expect(state.chains).toHaveLength(1)

    vi.unstubAllGlobals()
    await user.click(document.body)
  })

  it('只读态（isActive link）时链接按钮发 unsetLink', () => {
    renderEditor({}, { active: ['link'] })
    clickTool('链接')
    expect(lastChain()).toEqual(['focus', 'unsetLink'])
  })
})

describe('笔记编辑器：插入图片按钮', () => {
  it('选文件 → 上传 → 以带签名的地址插入图片节点', async () => {
    uploadNoteImage.mockReset().mockResolvedValue(IMAGE)
    renderEditor({ value: '开头' })

    const input = document.querySelector('input.file-input') as HTMLInputElement
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File([new Uint8Array([1, 2])], 'picked.png', { type: 'image/png' })],
    })
    fireEvent.change(input)

    await waitFor(() => expect(uploadNoteImage).toHaveBeenCalledTimes(1))
    const [noteId, sent] = uploadNoteImage.mock.calls[0] as [string, File]
    expect(noteId).toBe('n1')
    expect(sent.name).toBe('picked.png')
    await waitFor(() =>
      expect(lastChain()).toEqual(['focus', `setImage([{"src":"${URL_A}","alt":"image.png"}])`]),
    )
  })

  it('没有 noteId 时不发上传，只提示（图片标签带不了鉴权头，必须有笔记 id 才能落盘）', async () => {
    uploadNoteImage.mockReset().mockResolvedValue(IMAGE)
    const { wire } = renderEditor({ noteId: undefined })

    const input = document.querySelector('input.file-input') as HTMLInputElement
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File([new Uint8Array([1])], 'picked.png', { type: 'image/png' })],
    })
    fireEvent.change(input)

    await waitFor(() => expect(wire.notices).toHaveLength(1))
    expect(wire.notices[0]).toEqual({ type: 'error', message: '笔记还没保存，先等一下再插图' })
    expect(uploadNoteImage).not.toHaveBeenCalled()
    // 工具栏的图片按钮也该是禁用的，提示"保存后才能插入图片"
    expect(screen.getByTitle('保存后才能插入图片')).toBeDisabled()
  })
})

describe('笔记编辑器：AI 动作', () => {
  it('三档动作各发出对应的 action', async () => {
    const user = userEvent.setup()
    const { wire } = renderEditor()

    await user.click(screen.getByLabelText('AI 处理'))
    await user.click(await screen.findByText('智能排版'))
    await user.click(screen.getByLabelText('AI 处理'))
    await user.click(await screen.findByText('内容润色'))
    await user.click(screen.getByLabelText('AI 处理'))
    await user.click(await screen.findByText('排版并润色'))

    expect(wire.ai).toEqual(['format', 'polish', 'both'])
  })

  it('处理中：入口换成进度圈 + "处理中"，三项都不可点', async () => {
    const user = userEvent.setup()
    renderEditor({ aiBusy: true })

    const trigger = screen.getByLabelText('AI 处理')
    expect(trigger.textContent).toContain('处理中')
    expect(trigger.querySelector('.ai-spinner')).toBeTruthy()

    await user.click(trigger)
    const items = await screen.findAllByRole('menuitem')
    for (const item of items) expect(item).toHaveAttribute('data-disabled')
  })
})

describe('笔记编辑器：版式契约', () => {
  it('工具栏是编辑区里的 sticky 元素（真实渲染出来的那一行）', () => {
    const { view } = renderEditor()
    const toolbar = view.container.querySelector('.note-editor > .toolbar')
    expect(toolbar).toBeTruthy()
    expect(toolbar?.getAttribute('role')).toBe('toolbar')

    const css = styleText()
    const rule = cssRule(css, '.toolbar')
    expect(rule).toMatch(/position:\s*sticky/)
    expect(rule).toMatch(/top:\s*0/)
    // 正文换笔记时带 opacity 过渡、会自成一个层叠上下文，没有正的层级它会盖住工具栏
    expect(rule).toMatch(/z-index:\s*[1-9]/)
    // 背景必须是不透明色，否则正文从工具栏底下滚过时会透出来
    expect(rule).toMatch(/background:\s*var\(--/)
  })

  it('链路上没有会裁掉 sticky 的一级：`.note-editor` 不裁剪、`.editor-body` 不自己滚', () => {
    const css = styleText()
    expect(cssRule(css, '.note-editor')).not.toMatch(/overflow(?:-x|-y)?:\s*(?:hidden|clip)/)
    expect(cssRule(css, '.editor-body')).not.toMatch(/overflow(?:-x|-y)?:\s*(?:auto|scroll)/)
    // sticky 只能在**包含块**里活动，而它的包含块就是编辑区这一层：
    // 这一层必须"至少一列高、正文多长就多长"（`flex: none` 挡住 flex-shrink）
    const column = cssRule(css, '.pane-editor')
    expect(column).toMatch(/min-height:\s*100%/)
    expect(column).toMatch(/flex:\s*none/)
    // 编辑区不写 `height: 100%`：那会把这一层钉在列高上，正文只能在 `.editor-body`
    // 里另开一个滚动区，把列那层架空
    expect(cssRule(css, '.note-editor')).not.toMatch(/(?:^|[\s;])height:\s*100%/)
  })

  it('正文收在一条窄栏里居中（不是满屏宽的行）', () => {
    const rule = cssRule(styleText(), '.editor-column')
    expect(rule).toMatch(/max-width:\s*780px/)
    expect(rule).toMatch(/margin:\s*0 auto/)
  })

  it('保存状态与页面的动作都挂在工具栏右侧（页面的 slot 落在编辑器里）', () => {
    const { view } = renderEditor({
      value: '正文',
      status: <span className="save-label">已保存 09:12</span>,
      actions: <button type="button" title="删除" />,
      header: <input className="doc-title" aria-label="笔记标题" />,
    })

    const toolbarRight = view.container.querySelector('.toolbar-right')
    expect(toolbarRight?.querySelector('.save-label')?.textContent).toBe('已保存 09:12')
    expect(toolbarRight?.querySelector('[title="删除"]')).toBeTruthy()
    // 标题属于文档头（在正文栏里），不属于工具栏
    expect(view.container.querySelector('.editor-column .doc-title')).toBeTruthy()
    expect(toolbarRight?.querySelector('.doc-title')).toBeNull()
  })
})

/* --------------------------------------------------------------- 源码小工具 */

function styleText(): string {
  return readFileSync(
    fileURLToPath(new NodeURL('../src/features/notes/notes.css', import.meta.url)),
    'utf8',
  )
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

function cssRule(source: string, selector: string): string {
  const rules = [...stripComments(source).matchAll(/\n\s*([^{}]+?)\s*\{([^{}]*)\}/g)]
  const found = rules.find((rule) =>
    (rule[1] ?? '').split(',').some((part) => part.trim() === selector),
  )
  expect(found, `没在源码里找到 CSS 规则 ${selector}`).toBeTruthy()
  return found?.[2] ?? ''
}
