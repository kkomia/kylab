/**
 * 预览域的四组用例：**分派、失败态、两个命令式渲染器的挂载调用、表格的多 sheet**。
 *
 * 三个上游库（`docx-preview` / `pptx-preview` / `exceljs`）全部 `vi.mock` 掉：
 *
 * - 真实解析要真的 zip 字节，造样例文件会把测试变成"测上游"；
 * - 这里要钉住的恰恰是**集成契约**——"容器挂载之后，拿哪些参数调了上游的哪个函数"
 *   （docx-preview 是命令式的、pptx-preview 的缩放只在 init 时算一次，
 *   这两条是集成里最容易写错的，所以各有专门的用例）。
 *
 * 字节的来源统一是 `fetch`（签名链接是相对路径），所以每个用例都从
 * `vi.stubGlobal('fetch', …)` 开始——**失败态那组正是让它失败**。
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DocxPreview } from '@/features/preview/DocxPreview'
import { FilePreview } from '@/features/preview/FilePreview'
import { PptxPreview } from '@/features/preview/PptxPreview'
import { SpreadsheetPreview } from '@/features/preview/SpreadsheetPreview'
import { failureText } from '@/features/preview/notes'
import { resolveRenderer } from '@/features/preview/kinds'

/**
 * 上游替身。`vi.hoisted`：`vi.mock` 的工厂会被提到 import 之前，普通变量拿不到。
 *
 * 每个 `vi.fn` 都**写全签名**：不写的话 `mock.calls[0]` 的类型是空元组，
 * 断言参数时连索引都取不到（`Tuple type '[]' has no element at index '0'`）——
 * 而"参数对不对"正是这个文件要钉的东西。
 */
const upstream = vi.hoisted(() => {
  type Previewer = { preview: (file: ArrayBuffer) => Promise<unknown>; destroy: () => void }
  const preview = vi.fn<(file: ArrayBuffer) => Promise<unknown>>(async () => ({}))
  const destroy = vi.fn<() => void>(() => undefined)
  const init = vi.fn<(dom: HTMLElement, options: { width: number; mode: string }) => Previewer>(
    () => ({ preview, destroy }),
  )
  const renderAsync = vi.fn<
    (
      data: ArrayBuffer,
      body: HTMLElement,
      style?: HTMLElement,
      options?: Record<string, unknown>,
    ) => Promise<unknown>
  >(async () => ({}))
  const xlsxLoad = vi.fn<(buffer: ArrayBuffer) => Promise<unknown>>(async () => undefined)
  const Workbook = vi.fn(function (this: Record<string, unknown>) {
    this.xlsx = { load: xlsxLoad }
    this.worksheets = []
  })
  return { preview, destroy, init, renderAsync, xlsxLoad, Workbook }
})

vi.mock('docx-preview', () => ({ renderAsync: upstream.renderAsync }))
vi.mock('pptx-preview', () => ({ init: upstream.init }))
vi.mock('exceljs', () => ({
  Workbook: upstream.Workbook,
  default: { Workbook: upstream.Workbook },
}))

/** 一次 fetch 的替身响应：我们只用 `ok` / `status` / `arrayBuffer` / `text` 四个成员。 */
function response(body: { bytes?: number[]; text?: string; status?: number }) {
  const status = body.status ?? 200
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => new Uint8Array(body.bytes ?? [1, 2, 3]).buffer,
    text: async () => body.text ?? '',
  }
}

/**
 * `fetch` 替身。**签名写全**（与上游替身同一条纪律）：探测那一档要断言
 * "请求带了哪个头"（`Range: bytes=0-0`），不写签名的话 `mock.calls[0]` 是空元组，
 * 连 `[1]` 都取不到。
 */
function stubFetch(body: Parameters<typeof response>[0] | Error) {
  const fetchMock = vi.fn<
    (url: string, init?: RequestInit) => Promise<ReturnType<typeof response>>
  >(async () => {
    if (body instanceof Error) throw body
    return response(body)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/**
 * jsdom 没有 `ResizeObserver`，而 `PptxPreview` 靠它跟容器宽度（缩放是 init 时算死的，
 * 变宽了必须重建）。`tests/setup.ts` 里已经有一个全局替身，但本文件的
 * `afterEach` 会 `vi.unstubAllGlobals()` 把 `fetch` 的替身一起收掉——那个全局替身
 * 也会被顺手收走，所以在每个用例前重新装一个。
 */
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  upstream.preview.mockClear()
  upstream.destroy.mockClear()
  upstream.init.mockClear()
  upstream.renderAsync.mockClear()
  upstream.xlsxLoad.mockClear()
  upstream.Workbook.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('分派表', () => {
  it('按后缀选渲染器', () => {
    expect(resolveRenderer({ name: '报告.docx', kind: 'docx' })).toBe('docx')
    expect(resolveRenderer({ name: '讲稿.pptx', kind: 'pptx' })).toBe('pptx')
    expect(resolveRenderer({ name: '台账.xlsx', kind: 'xlsx' })).toBe('sheet')
    expect(resolveRenderer({ name: '旧表.xls', kind: 'xls' })).toBe('sheet')
    expect(resolveRenderer({ name: '说明.md', kind: 'md' })).toBe('markdown')
    expect(resolveRenderer({ name: '日志.log', kind: 'log' })).toBe('text')
    expect(resolveRenderer({ name: '脚本.py', kind: 'py' })).toBe('text')
    expect(resolveRenderer({ name: '截图.PNG', kind: 'png' })).toBe('image')
    expect(resolveRenderer({ name: '论文.pdf', kind: 'pdf' })).toBe('pdf')
  })

  it('后端的 PreviewKind 优先（docx / excel / image / binary 不是后缀）', () => {
    // 文档接口给的是后端算出来的 kind：`excel` 是表格、`binary` 是"服务端说别试了"
    expect(resolveRenderer({ name: '台账.xlsx', kind: 'excel' })).toBe('sheet')
    expect(resolveRenderer({ name: '扫描件', kind: 'image' })).toBe('image')
    expect(resolveRenderer({ name: '老文件.doc', kind: 'binary' })).toBe('none')
    // 有的解析产物就是 markdown：有产物时后端给的 kind 恒为它
    expect(resolveRenderer({ name: '台账.csv', kind: 'markdown' })).toBe('markdown')
  })

  it('同一份 csv 在两条路上落点不同（输入不同，结果不同，不是漏了一条）', () => {
    // 会话文件区给的是后缀 → 纯文本；文档接口给的是后端 kind → Markdown
    expect(resolveRenderer({ name: '数据.csv', kind: 'csv' })).toBe('text')
    expect(resolveRenderer({ name: '数据.csv', kind: 'markdown' })).toBe('markdown')
  })

  it('认不出来时用 mime 兜底，最后才看文件名后缀', () => {
    expect(
      resolveRenderer({
        name: '没后缀',
        mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      }),
    ).toBe('pptx')
    expect(resolveRenderer({ name: '没后缀', mime: 'application/pdf' })).toBe('pdf')
    expect(resolveRenderer({ name: '没后缀', mime: 'application/json' })).toBe('text')
    // 后缀被改坏、mime 还对：仍然能画
    expect(resolveRenderer({ name: 'x.bin', mime: 'image/webp' })).toBe('image')
    // 只有文件名时也认
    expect(resolveRenderer({ name: '最终版.DOCX' })).toBe('docx')
    expect(resolveRenderer({ name: '未知格式.bin' })).toBe('none')
  })

  it('SVG 不算图片（内联渲染就是存储型 XSS，与服务端同一口径）', () => {
    expect(resolveRenderer({ name: '图标.svg', kind: 'svg' })).toBe('none')
    expect(resolveRenderer({ name: '图标.svg', mime: 'image/svg+xml' })).toBe('none')
    // 但同一个 mime 体系里的位图照画
    expect(resolveRenderer({ name: '图标.png', mime: 'image/png' })).toBe('image')
  })
})

describe('失败说明的措辞', () => {
  it('浏览器那句英文翻成人话，后端给的中文原样保留', () => {
    // `fetch` 连不上时抛的是写给调用方看的英文（"检索失败：Failed to fetch" 不能上屏）
    expect(failureText(new TypeError('Failed to fetch'), '检索失败')).toBe('网络没连上')
    expect(failureText(new TypeError('Load failed'), '检索失败')).toBe('网络没连上')
    // 后端那几句话是写给用户的中文：一个字都不改（原因只有一处真相）
    expect(failureText(new Error('服务内部错误'), '检索失败')).toBe('服务内部错误')
    // 连原因都没有时才用兜底
    expect(failureText(undefined, '检索失败')).toBe('检索失败')
  })
})

describe('FilePreview 分派到具体渲染器', () => {
  it('md：把内联内容按 Markdown 画出来', () => {
    render(<FilePreview name="说明.md" kind="md" text={'# 标题\n\n正文'} />)
    expect(screen.getByRole('heading', { name: '标题' })).toBeInTheDocument()
  })

  it('txt 与代码：走等宽 pre，内容从链接取', async () => {
    stubFetch({ text: 'print(1)' })
    render(<FilePreview name="脚本.py" kind="py" url="/api/files/a.py?sig=x" />)
    expect(await screen.findByText('print(1)')).toBeInTheDocument()
    expect(document.querySelector('pre.kylab-text')).not.toBeNull()
  })

  it('图片：img 直接吃签名链接，不去 fetch', () => {
    const fetchMock = stubFetch({})
    render(<FilePreview name="截图.png" kind="png" url="/api/files/a.png?sig=x" />)
    const image = screen.getByRole('img', { name: '截图.png' })
    expect(image).toHaveAttribute('src', '/api/files/a.png?sig=x')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('pdf：iframe 指向签名链接', async () => {
    // 探测要先通（这里让它拿到 206）：PDF 是"先探一次再挂载"的
    stubFetch({ status: 206 })
    render(<FilePreview name="论文.pdf" kind="pdf" url="/api/documents/d1/content?sig=y" />)
    const frame = await screen.findByTitle('论文.pdf')
    expect(frame.tagName).toBe('IFRAME')
    expect(frame).toHaveAttribute('src', '/api/documents/d1/content?sig=y')
  })

  it('pdf：原件接口 500 —— 画我们自己的失败态，不把错误信封交给浏览器', async () => {
    const fetchMock = stubFetch({ status: 500 })
    render(<FilePreview name="论文.pdf" kind="pdf" url="/api/documents/d1/content?sig=y" />)

    expect(await screen.findByText(/预览失败（HTTP 500）/)).toBeInTheDocument()
    // **连 iframe 都没挂**：那份响应体是后端的错误信封，挂上去就是让浏览器把
    // `{"code":"internal_error",…}` 原样画给用户（评审 52 号图）
    expect(screen.queryByTitle('论文.pdf')).toBeNull()
    // 探的是"这条路通不通"，不是"把整份 PDF 拉下来"：只问第一个字节
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ headers: { Range: 'bytes=0-0' } })
  })

  it('pdf：重试重新探一次，通了就把 iframe 挂上', async () => {
    stubFetch({ status: 500 })
    render(<FilePreview name="论文.pdf" kind="pdf" url="/api/d1/content?sig=y" />)
    expect(await screen.findByText(/预览失败（HTTP 500）/)).toBeInTheDocument()

    stubFetch({ status: 206 })
    await userEvent.click(screen.getByRole('button', { name: '重试' }))

    expect(await screen.findByTitle('论文.pdf')).toHaveAttribute('src', '/api/d1/content?sig=y')
    expect(screen.queryByText(/预览失败/)).toBeNull()
  })

  it('pdf：探不出结论（fetch 自己抛错）时不拦——宁可按浏览器来，也不误报"看不了"', async () => {
    stubFetch(new Error('Failed to parse URL'))
    render(<FilePreview name="论文.pdf" kind="pdf" url="/api/d1/content?sig=y" />)

    expect(await screen.findByTitle('论文.pdf')).toBeInTheDocument()
    expect(screen.queryByText(/预览失败/)).toBeNull()
  })

  it('docx / pptx / xlsx：落到各自的渲染器（容器挂出来了）', async () => {
    stubFetch({ bytes: [1] })
    const { unmount } = render(<FilePreview name="报告.docx" kind="docx" url="/api/a.docx" />)
    expect(await screen.findByTestId('docx-host')).toBeInTheDocument()
    unmount()

    const pptx = render(<FilePreview name="讲稿.pptx" kind="pptx" url="/api/a.pptx" />)
    expect(await screen.findByTestId('pptx-host')).toBeInTheDocument()
    pptx.unmount()

    // 表格这一路走到 exceljs 就说明分派对了（表本身的内容由下面那组用例管）
    render(<FilePreview name="台账.xlsx" kind="xlsx" url="/api/a.xlsx" />)
    await waitFor(() => expect(upstream.Workbook).toHaveBeenCalled())
  })

  it('认不出的格式：说"不能在这里预览"，不是失败态', () => {
    render(<FilePreview name="数据.bin" kind="bin" />)
    expect(screen.getByText(/这个格式不能在这里预览/)).toBeInTheDocument()
    expect(screen.queryByText(/预览失败/)).toBeNull()
  })

  it('要链接的格式却没链接：显示后端/上层给的原因', () => {
    render(<FilePreview name="论文.pdf" kind="pdf" url={null} />)
    expect(screen.getByText(/预览失败（拿不到预览链接）/)).toBeInTheDocument()
  })

  it('后端给的原因优先于通用文案', () => {
    render(<FilePreview name="论文.pdf" kind="pdf" url={null} reason="签名链接已过期" />)
    expect(screen.getByText(/签名链接已过期/)).toBeInTheDocument()
  })

  it('pdf：给了页码就带 #page=N 锚点（原生阅读器的 PDF Open Parameters）', async () => {
    stubFetch({ status: 206 })
    render(<FilePreview name="论文.pdf" kind="pdf" url="/api/d1/content?sig=z" page={7} />)
    expect(await screen.findByTitle('论文.pdf')).toHaveAttribute(
      'src',
      '/api/d1/content?sig=z#page=7',
    )
  })

  it('文档页可以把整份「阅读视角」返回递进来，不必拆字段', () => {
    render(
      <FilePreview
        preview={{
          kind: 'markdown',
          filename: '解析产物.md',
          text: '# 解析结果',
          url: null,
          expires_at: null,
          original_kind: 'docx',
        }}
      />,
    )
    expect(screen.getByRole('heading', { name: '解析结果' })).toBeInTheDocument()
  })

  it('整份返回说 binary：不假装能预览（连链接都不试）', () => {
    const fetchMock = stubFetch({})
    render(
      <FilePreview
        preview={{
          kind: 'binary',
          filename: '老文件.doc',
          text: null,
          url: '/api/d1/content?sig=z',
          expires_at: null,
          original_kind: 'binary',
        }}
      />,
    )
    expect(screen.getByText(/「老文件.doc」这个格式不能在这里预览/)).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('失败态：blob 拿不到就说清为什么', () => {
  it('网络断了：显示 fetch 的原因', async () => {
    stubFetch(new Error('Failed to fetch'))
    render(<FilePreview name="报告.docx" kind="docx" url="/api/a.docx" />)
    expect(await screen.findByText(/预览失败（Failed to fetch）/)).toBeInTheDocument()
    // 失败时不摆一个空框（容器还在，但被藏起来——命令式的库要它一直挂着）
    expect(screen.getByTestId('docx-host')).not.toBeVisible()
  })

  it('HTTP 500：显示状态码（这是"后端给的原因"里最常见的一种）', async () => {
    stubFetch({ status: 500 })
    render(<DocxPreview url="/api/a.docx" name="报告.docx" />)
    expect(await screen.findByText(/预览失败（HTTP 500）/)).toBeInTheDocument()
  })

  it('链接为空：直接说拿不到链接，不去 fetch', () => {
    const fetchMock = stubFetch({})
    render(<PptxPreview url={null} name="讲稿.pptx" />)
    expect(screen.getByText(/预览失败（拿不到预览链接）/)).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('解析抛错：把上游的原因显示出来（pptx 只在 reject 里报错）', async () => {
    stubFetch({ bytes: [1, 2] })
    upstream.preview.mockRejectedValueOnce(new Error('Can not find end of central directory'))
    render(<PptxPreview url="/api/broken.pptx" name="坏文件.pptx" />)
    expect(await screen.findByText(/Can not find end of central directory/)).toBeInTheDocument()
  })
})

describe('docx：容器挂载后调上游 renderAsync', () => {
  it('参数是"字节 + 挂出来的容器 + 我们的类名前缀"', async () => {
    stubFetch({ bytes: [1, 2, 3] })
    render(<DocxPreview url="/api/a.docx" name="报告.docx" />)

    await waitFor(() => expect(upstream.renderAsync).toHaveBeenCalledTimes(1))
    const host = screen.getByTestId('docx-host')
    const [data, body, style, options] = upstream.renderAsync.mock.calls[0]
    // 字节：就是 fetch 回来的那个 ArrayBuffer（同一份，不复制、不再取一次）
    expect(data).toBeInstanceOf(ArrayBuffer)
    expect(data.byteLength).toBe(3)
    // 容器：挂载之后的那个 DOM 节点（命令式的库靠它，传错了就是白屏）
    expect(body).toBe(host)
    expect(style).toBeUndefined() // 缺省 = 样式注入到 body，不会漏到全站
    expect(options).toEqual({ className: 'kylab-docx', inWrapper: true })
  })

  it('换文件（url 变）就重画，卸载时松开容器', async () => {
    stubFetch({ bytes: [1] })
    const { rerender, unmount } = render(<DocxPreview url="/api/a.docx" name="a.docx" />)
    await waitFor(() => expect(upstream.renderAsync).toHaveBeenCalledTimes(1))
    const firstHost = upstream.renderAsync.mock.calls[0][1]

    rerender(<DocxPreview url="/api/b.docx" name="b.docx" />)
    await waitFor(() => expect(upstream.renderAsync).toHaveBeenCalledTimes(2))

    unmount()
    // 卸载后容器被清空（大文档的 DOM 不留给 GC 慢慢猜）
    expect(firstHost.innerHTML).toBe('')
  })
})

describe('pptx：init 之后才有 preview，销毁时自己清容器', () => {
  it('宽度量不到时用兜底宽度，mode 固定 list', async () => {
    stubFetch({ bytes: [9, 9] })
    render(<PptxPreview url="/api/a.pptx" name="讲稿.pptx" />)

    await waitFor(() => expect(upstream.init).toHaveBeenCalledTimes(1))
    const host = screen.getByTestId('pptx-host')
    const [container, options] = upstream.init.mock.calls[0]
    expect(container).toBe(host)
    // jsdom 量不到宽度 → 兜底值；真实浏览器里是容器的 clientWidth
    expect(options).toEqual({ width: 960, mode: 'list' })

    // preview 收到的正是那份字节，而且要等 init 之后
    await waitFor(() => expect(upstream.preview).toHaveBeenCalledTimes(1))
    expect(upstream.preview.mock.calls[0][0]).toBeInstanceOf(ArrayBuffer)
    expect(upstream.init.mock.invocationCallOrder[0]).toBeLessThan(
      upstream.preview.mock.invocationCallOrder[0],
    )
  })

  it('卸载：destroy 交给上游、DOM 我们自己清（上游的 destroy 不清 DOM）', async () => {
    stubFetch({ bytes: [1] })
    const { unmount } = render(<PptxPreview url="/api/a.pptx" name="a.pptx" />)
    await waitFor(() => expect(upstream.preview).toHaveBeenCalledTimes(1))
    const host = screen.getByTestId('pptx-host')
    host.appendChild(document.createElement('div')) // 假装上游画了一页

    unmount()
    expect(upstream.destroy).toHaveBeenCalledTimes(1)
    expect(host.innerHTML).toBe('')
  })
})

describe('表格：exceljs 读、多 sheet 可切', () => {
  /**
   * 一份最小的替身工作簿：两个工作表，各有一格内容。
   *
   * **这里不检查格子里的字**：表格体是按虚拟化结果画的，而 jsdom 里滚动容器量出来
   * 永远是 0×0（`@tanstack/react-virtual` 因此在 jsdom 里不产出可见项）——
   * 那是环境的限制，不是组件的分支。所以本组用例钉的是"读到字节、列出工作表、
   * 能切换、解析失败有专门的文案"这四件在 jsdom 里**确实成立**的事。
   */
  function fakeWorkbook() {
    const sheet = (id: number, name: string, text: string) => ({
      id,
      name,
      rowCount: 1,
      columnCount: 1,
      dimensions: { top: 1, left: 1, bottom: 1, right: 1 },
      getColumn: () => ({ width: 12 }),
      findRow: (rowNumber: number) =>
        rowNumber === 1
          ? {
              height: undefined,
              findCell: (columnNumber: number) =>
                columnNumber === 1
                  ? {
                      address: 'A1',
                      text,
                      value: text,
                      font: {},
                      fill: { type: 'pattern' },
                      alignment: {},
                      isMerged: false,
                      master: { address: 'A1' },
                    }
                  : undefined,
            }
          : undefined,
    })
    const sheets = [sheet(1, '汇总', '42'), sheet(2, '明细', '明细值')]
    upstream.Workbook.mockImplementationOnce(function (this: Record<string, unknown>) {
      this.xlsx = { load: upstream.xlsxLoad }
      this.worksheets = sheets
    })
  }

  it('用字节调 workbook.xlsx.load，并列出所有工作表', async () => {
    stubFetch({ bytes: [7] })
    fakeWorkbook()
    render(<SpreadsheetPreview url="/api/a.xlsx" name="台账.xlsx" />)

    await waitFor(() => expect(upstream.xlsxLoad).toHaveBeenCalledTimes(1))
    expect(upstream.xlsxLoad.mock.calls[0][0]).toBeInstanceOf(ArrayBuffer)
    expect(await screen.findByRole('tab', { name: '汇总' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '明细' })).toHaveAttribute('aria-selected', 'false')
  })

  it('点另一个标签就切过去', async () => {
    stubFetch({ bytes: [7] })
    fakeWorkbook()
    render(<SpreadsheetPreview url="/api/a.xlsx" name="台账.xlsx" />)
    const second = await screen.findByRole('tab', { name: '明细' })

    await userEvent.click(second)
    expect(second).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: '汇总' })).toHaveAttribute('aria-selected', 'false')
  })

  it('解析失败：老式 .xls 给专门的一句，不是"文件坏了"', async () => {
    stubFetch({ bytes: [0] })
    upstream.xlsxLoad.mockRejectedValueOnce(new Error('Unsupported zip file'))
    render(<SpreadsheetPreview url="/api/old.xls" name="旧台账.xls" />)
    expect(await screen.findByText(/老式 \.xls（二进制格式）解析不了/)).toBeInTheDocument()
    expect(screen.getByText(/Unsupported zip file/)).toBeInTheDocument()
  })
})
