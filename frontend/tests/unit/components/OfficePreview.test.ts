/**
 * Office 原版式预览。
 *
 * 这里不验"渲染出来像不像 Office"（那是库的事），验的是我们这层的三条边界：
 * **字节自己取**、**取不到要给可处置的提示**、**docx 的容器要等 DOM 渲染出来再画**。
 * 最后一条是真实的时序坑：`loading=false` 之后容器才进 DOM，早一步拿 ref 就是 null。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import OfficePreview from '@/components/knowledge/OfficePreview.vue'

/** 泛型给签名（让 `mock.calls` 的元素是元组），实现不必声明用不到的形参。 */
const renderAsync = vi.fn<(data: ArrayBuffer, host: HTMLElement) => Promise<void>>(async () => {})
vi.mock('docx-preview', () => ({
  renderAsync: (data: ArrayBuffer, host: HTMLElement) => renderAsync(data, host),
}))

function mountOffice() {
  return mount(OfficePreview, {
    props: {
      kind: 'docx' as const,
      url: '/api/v1/documents/doc_1/content?x=1',
      filename: '合同.docx',
    },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  renderAsync.mockClear()
})

describe('OfficePreview', () => {
  it('自己取字节，交给 docx-preview 画进容器', async () => {
    const fetchMock = vi.fn<(url: RequestInfo | URL) => Promise<Response>>(
      async () => new Response(new Uint8Array([1, 2, 3]).buffer),
    )
    vi.stubGlobal('fetch', fetchMock)

    const wrapper = mountOffice()
    await flushPromises()
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledOnce()
    // 字节由我们取：签名的相对链接不带鉴权头，交给库去猜怎么取不如自己取可控
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/v1/documents/doc_1/content?x=1')
    expect(renderAsync).toHaveBeenCalledOnce()
    const [data, host] = renderAsync.mock.calls[0] as unknown as [ArrayBuffer, HTMLElement]
    expect(data.byteLength).toBe(3)
    // 容器必须真的在 DOM 里（时序：loading=false 之后才渲染出来）
    expect(host).toBeInstanceOf(HTMLElement)
    expect(wrapper.find('.office-docx').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('预览失败')
  })

  it('取不到字节时给可处置的提示，而不是空白', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 404 })),
    )

    const wrapper = mountOffice()
    await flushPromises()

    expect(renderAsync).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('预览失败')
    expect(wrapper.text()).toContain('合同.docx') // 文件名要带上，用户知道是哪一份
    expect(wrapper.text()).toContain('下载')
  })
})
