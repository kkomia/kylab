/**
 * 笔记编辑器：**粘贴图片走的是与「插入图片」按钮同一条上传链路**（真实画布 + 真实编辑器）。
 *
 * 这是旧用例 `tests/unit/components/NoteEditor.test.ts` 前四条的 React 版翻译：
 * 1. 剪贴板里有图片文件时**接管**这次粘贴，上传后插入带签名地址的图片节点；
 * 2. 上传期间有可见提示（"粘了没反应"是最常见的误判）；
 * 3. 上传失败时正文**一个字都不改**（宁可没插上，也不要把半截内容留在正文里），并且有错误提示；
 * 4. 没有图片文件的粘贴不接管（默认行为照旧）。
 *
 * 与工具栏那几条分开放：这里要的是**真实 Tiptap 实例**（粘贴处理在画布里），
 * 所以不 mock 画布；`notes-editor.test.tsx` 那边验的是工具栏命令，用 mock 更精确。
 */
import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NoteImage } from '@/api/notes'

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

/** jsdom 的 `Range` 没有这两个方法，而 ProseMirror 的 `.focus()` 会去量文字矩形。 */
const ZERO_RECT = {
  x: 0,
  y: 0,
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  width: 0,
  height: 0,
  toJSON: () => ({}),
} as DOMRect

if (typeof Range.prototype.getClientRects !== 'function') {
  Range.prototype.getClientRects = function getClientRects(): DOMRectList {
    return Object.assign([], { item: () => null }) as unknown as DOMRectList
  }
  Range.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
    return ZERO_RECT
  }
}

interface Wire {
  values: string[]
  notices: { type: string; message: string }[]
}

function renderEditor(props: Partial<NoteEditorProps> = {}): {
  wire: Wire
  view: ReturnType<typeof render>
} {
  const wire: Wire = { values: [], notices: [] }
  const view = render(
    <NoteEditor
      value={props.value ?? ''}
      noteId={'noteId' in props ? props.noteId : 'n1'}
      editable={props.editable ?? true}
      onValueChange={(markdown) => wire.values.push(markdown)}
      onNotify={(payload) => wire.notices.push(payload)}
      onAi={() => undefined}
    />,
  )
  return { wire, view }
}

/** 编辑器最近一次交出去的正文（就是要存进库的那份 Markdown）。 */
const lastMarkdown = (wire: Wire): string => wire.values.at(-1) ?? ''

/** 造一次"剪贴板里有图片"的粘贴。jsdom 没有 DataTransfer，只能给个最小面。 */
function pasteFiles(target: Element, files: File[]): void {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: {
      files,
      items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
      // ProseMirror 会先读纯文本/HTML 来算粘贴的切片，这里给空串表示"没有文字"
      getData: () => '',
    },
  })
  target.dispatchEvent(event)
}

const tiptapOf = (view: ReturnType<typeof render>): Element =>
  view.container.querySelector('.tiptap') as Element

beforeEach(() => {
  uploadNoteImage.mockReset().mockResolvedValue(IMAGE)
})

describe('笔记编辑器：粘贴图片', () => {
  it('剪贴板里有图片：上传并插入，正文里是带签名地址的 Markdown 图片', async () => {
    const { wire, view } = renderEditor({ value: '开头' })

    // 截图工具给的 File 往往**没有文件名**：后端按后缀判白名单，所以这里要按 MIME 补一个
    pasteFiles(tiptapOf(view), [new File([new Uint8Array([1, 2, 3])], '', { type: 'image/png' })])

    await waitFor(() => expect(uploadNoteImage).toHaveBeenCalledTimes(1))
    const [noteId, sent] = uploadNoteImage.mock.calls[0] as [string, File]
    expect(noteId).toBe('n1')
    expect(sent.name).toMatch(/\.png$/)
    expect(sent.type).toBe('image/png')

    // 插入的是图片节点：正文（Markdown）里有它，地址就是上传回来的那个
    await waitFor(() => expect(lastMarkdown(wire)).toContain(`![image.png](${URL_A})`))
    expect(view.container.querySelector(`.tiptap img[src="${URL_A}"]`)).toBeTruthy()
  })

  it('上传期间有可见提示，落图之后提示消失', async () => {
    let resolveUpload: (image: NoteImage) => void = () => undefined
    uploadNoteImage.mockReturnValue(
      new Promise<NoteImage>((resolve) => {
        resolveUpload = resolve
      }),
    )
    const { wire, view } = renderEditor({ value: '开头' })

    pasteFiles(tiptapOf(view), [new File([new Uint8Array([1])], 'x.png', { type: 'image/png' })])

    const hint = await waitFor(() => {
      const element = view.container.querySelector('.upload-hint')
      expect(element).toBeTruthy()
      return element as HTMLElement
    })
    expect(hint.textContent).toContain('上传中')
    expect(hint.getAttribute('role')).toBe('status')

    resolveUpload(IMAGE)
    await waitFor(() => expect(view.container.querySelector('.upload-hint')).toBeNull())
    expect(lastMarkdown(wire)).toContain(`![image.png](${URL_A})`)
  })

  it('上传失败：正文里没有图片、有错误提示，且原文一字未改', async () => {
    uploadNoteImage.mockRejectedValue(new Error('图片超过 10MB 上限'))
    const { wire, view } = renderEditor({ value: '原来的正文' })

    pasteFiles(tiptapOf(view), [new File([new Uint8Array([1])], 'big.png', { type: 'image/png' })])

    await waitFor(() => expect(wire.notices).toHaveLength(1))
    expect(wire.notices[0]).toEqual({ type: 'error', message: '图片超过 10MB 上限' })
    // 失败时**不落任何东西**：宁可不插，也不要把半截内容（比如 data URL）留在正文里
    expect(view.container.querySelector('.tiptap img')).toBeNull()
    expect(wire.values).toEqual([])
  })

  it('没有图片文件的粘贴不接管（默认行为照旧）', async () => {
    const { wire, view } = renderEditor({ value: '开头' })

    pasteFiles(tiptapOf(view), [new File(['纯文本'], 'note.txt', { type: 'text/plain' })])

    await waitFor(() => expect(wire.notices).toEqual([]))
    expect(uploadNoteImage).not.toHaveBeenCalled()
    expect(view.container.querySelector('.tiptap img')).toBeNull()
  })

  it('多张图：逐张上传，按顺序都插进正文', async () => {
    uploadNoteImage
      .mockResolvedValueOnce({ url: '/a.png', name: 'a.png', alt: 'a.png' })
      .mockResolvedValueOnce({ url: '/b.png', name: 'b.png', alt: 'b.png' })
    const { wire, view } = renderEditor({ value: '开头' })

    pasteFiles(tiptapOf(view), [
      new File([new Uint8Array([1])], 'a.png', { type: 'image/png' }),
      new File([new Uint8Array([2])], 'b.png', { type: 'image/png' }),
    ])

    await waitFor(() => expect(uploadNoteImage).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(lastMarkdown(wire)).toContain('![b.png](/b.png)'))
    expect(lastMarkdown(wire)).toContain('![a.png](/a.png)')
  })

  it('只读笔记不接管粘贴（命令绕得过 contenteditable，接管了就会往只读文档里插东西）', async () => {
    const { wire, view } = renderEditor({ value: '只读正文', editable: false })

    pasteFiles(tiptapOf(view), [new File([new Uint8Array([1])], 'x.png', { type: 'image/png' })])

    await waitFor(() => expect(wire.values).toEqual([]))
    expect(uploadNoteImage).not.toHaveBeenCalled()
  })
})

/** 顺带钉住 "contenteditable 跟随 editable 走"（工具栏的可用态靠它）。 */
describe('笔记编辑器：只读态', () => {
  it('editable=false 时正文不可编辑', () => {
    const { view } = renderEditor({ value: '只读正文', editable: false })
    expect(tiptapOf(view).getAttribute('contenteditable')).toBe('false')
  })

  it('editable 默认是开着的', () => {
    const { view } = renderEditor({ value: '正文' })
    expect(tiptapOf(view).getAttribute('contenteditable')).toBe('true')
  })
})
