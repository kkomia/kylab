/**
 * 文件抽屉（v0.26）：预览按后缀路由 + 文件区浏览。
 *
 * 两条最要紧的契约：
 *
 * 1. **不该假装能预览的就说不能**——给一个"加载中"永远转的空白框，
 *    比直接说"下载它，用本机程序打开"糟得多；
 * 2. **文件区是服务端说了算**——`mode` 是 `object` 时（会话临时区）不得出现
 *    "进子目录"这类动作，那里是平铺的。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ConversationFile, ConversationFileListing } from '@/api/conversations'

const listFiles = vi.fn()
const uploadFile = vi.fn()
const downloadFile = vi.fn()
const getFileUrl = vi.fn()
const notifyError = vi.fn()

vi.mock('@/api/conversations', () => ({
  listFiles: (...a: unknown[]) => listFiles(...a),
  uploadFile: (...a: unknown[]) => uploadFile(...a),
  downloadFile: (...a: unknown[]) => downloadFile(...a),
  getFileUrl: (...a: unknown[]) => getFileUrl(...a),
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ notifyError, notifySuccess: vi.fn(), notifyWarning: vi.fn() }),
}))

import FileDrawer from '@/components/files/FileDrawer.vue'
import FilePreview from '@/components/files/FilePreview.vue'

function entry(
  partial: Partial<ConversationFile> & { key: string; name: string },
): ConversationFile {
  return {
    is_dir: false,
    size_bytes: 1024,
    modified_at: null,
    kind: '',
    ...partial,
  }
}

function listing(partial: Partial<ConversationFileListing> = {}): ConversationFileListing {
  return {
    mode: 'object',
    label: '本会话',
    path: '',
    parent: null,
    entries: [],
    truncated: false,
    ...partial,
  }
}

function mountDrawer(props: Record<string, unknown> = {}) {
  return mount(FileDrawer, {
    props: { conversationId: 'c1', initialKey: null, ...props },
    global: {
      stubs: {
        // Office 预览带着三个引擎，这里换成桩：要证的是"路由选对了它"
        OfficePreview: {
          name: 'OfficePreview',
          props: ['kind', 'url', 'filename'],
          template: '<div class="office-stub" />',
        },
        SkeletonBlock: { template: '<div class="skeleton" />' },
      },
    },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  // 文本类预览（md / 代码）会去 fetch 签名链接读正文。jsdom 里没有真服务器，
  // 桩一个够用的响应——要证的是"选对了渲染器"，不是"fetch 能不能用"
  const sample = ['# 标题', '', '正文', '', 'print(1)'].join('\n')
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, text: async () => sample })),
  )
  listFiles.mockResolvedValue(listing())
  getFileUrl.mockResolvedValue({
    url: '/api/v1/files/content?signature=x',
    expires_at: 1,
    name: 'a',
  })
})

describe('文件抽屉', () => {
  it('列文件区：名字、大小、目录在前', async () => {
    listFiles.mockResolvedValue(
      listing({
        entries: [
          entry({ key: '章节', name: '章节', is_dir: true, kind: 'dir' }),
          entry({ key: 'a.md', name: 'a.md', kind: 'md' }),
        ],
      }),
    )
    const wrapper = mountDrawer()
    await flushPromises()

    expect(listFiles).toHaveBeenCalledWith('c1', '')
    const names = wrapper.findAll('.file-name').map((node) => node.text())
    expect(names).toEqual(['章节', 'a.md'])
    // 目录没有大小可显示
    expect(wrapper.findAll('.file-meta.tabular')).toHaveLength(1)
  })

  it('点目录进子目录，面包屑跟着走', async () => {
    listFiles.mockResolvedValueOnce(
      listing({
        mode: 'workspace',
        label: '工作区「项目」',
        entries: [entry({ key: '章节', name: '章节', is_dir: true, kind: 'dir' })],
      }),
    )
    const wrapper = mountDrawer()
    await flushPromises()

    listFiles.mockResolvedValueOnce(
      listing({
        mode: 'workspace',
        label: '工作区「项目」',
        path: '章节',
        parent: '',
        entries: [entry({ key: '章节/一.md', name: '一.md', kind: 'md' })],
      }),
    )
    await wrapper.find('.file-main').trigger('click')
    await flushPromises()

    expect(listFiles).toHaveBeenLastCalledWith('c1', '章节')
    expect(wrapper.findAll('.crumb').map((node) => node.text())).toEqual(['工作区「项目」', '章节'])
  })

  it('截断要如实说：不然"只有 300 个"与"只给你看了 300 个"看起来一样', async () => {
    listFiles.mockResolvedValue(
      listing({ truncated: true, entries: [entry({ key: 'a', name: 'a' })] }),
    )
    const wrapper = mountDrawer()
    await flushPromises()

    expect(wrapper.text()).toContain('只显示了前 300 项')
  })

  it('空态说"这里还没有文件"，并指出去哪儿弄一个', async () => {
    const wrapper = mountDrawer()
    await flushPromises()

    expect(wrapper.text()).toContain('这里还没有文件')
  })

  it('上传：带上当前目录，成功后重列', async () => {
    listFiles.mockResolvedValue(
      listing({ mode: 'workspace', label: '工作区「项目」', path: '素材' }),
    )
    uploadFile.mockResolvedValue(entry({ key: '素材/x.txt', name: 'x.txt' }))
    const wrapper = mountDrawer()
    await flushPromises()

    const input = wrapper.find('input[type="file"]')
    Object.defineProperty(input.element, 'files', {
      value: [new File(['x'], 'x.txt', { type: 'text/plain' })],
      configurable: true,
    })
    await input.trigger('change')
    await flushPromises()

    // **带上 path**：在看子目录时上传，文件就该落进那个子目录
    expect(uploadFile).toHaveBeenCalledWith('c1', expect.any(File), '素材')
    expect(listFiles).toHaveBeenCalledTimes(2)
  })

  it('每行都能直接下载，不用先打开再点上面那个', async () => {
    listFiles.mockResolvedValue(listing({ entries: [entry({ key: 'a.docx', name: 'a.docx' })] }))
    const wrapper = mountDrawer()
    await flushPromises()

    await wrapper.find('.file-download').trigger('click')
    expect(downloadFile).toHaveBeenCalledWith('c1', 'a.docx')
  })
})

describe('预览按后缀选渲染器', () => {
  async function preview(file: ConversationFile) {
    const wrapper = mount(FilePreview, {
      props: { conversationId: 'c1', file },
      global: {
        stubs: {
          OfficePreview: {
            name: 'OfficePreview',
            props: ['kind', 'url', 'filename'],
            template: '<div class="office-stub" />',
          },
        },
      },
    })
    await flushPromises()
    return wrapper
  }

  it('md 走自己的渲染器：标题真的成了 h1', async () => {
    const wrapper = await preview(entry({ key: 'a.md', name: 'a.md', kind: 'md' }))
    expect(wrapper.find('.preview-markdown').exists()).toBe(true)
    // `#` 落成真正的标题元素（层级夹在 2–4：h1 留给页面标题，见解析器那条注释）
    expect(wrapper.find('h2.md-h').text()).toBe('标题')
    expect(wrapper.find('.md-p').text()).toContain('正文')
  })

  it('代码走等宽块，不是 Markdown', async () => {
    const wrapper = await preview(entry({ key: 'a.py', name: 'a.py', kind: 'py' }))
    expect(wrapper.find('.preview-text').text()).toContain('print')
  })

  it('pdf 用 iframe 指签名链接（浏览器自带的阅读器）', async () => {
    const wrapper = await preview(entry({ key: 'a.pdf', name: 'a.pdf', kind: 'pdf' }))
    const frame = wrapper.find('.preview-pdf')
    expect(frame.exists()).toBe(true)
    // inline 是**请求**内联：PDF 不进 iframe 会变成下载
    expect(getFileUrl).toHaveBeenCalledWith('c1', 'a.pdf', 'inline')
  })

  it('docx / xlsx / pptx 交给 OfficePreview，且选对了引擎', async () => {
    for (const [kind, expected] of [
      ['docx', 'docx'],
      ['xlsx', 'excel'],
      ['pptx', 'pptx'],
    ] as const) {
      const wrapper = await preview(entry({ key: `a.${kind}`, name: `a.${kind}`, kind }))
      expect(wrapper.findComponent({ name: 'OfficePreview' }).props('kind')).toBe(expected)
    }
  })

  it('认不出的格式**不假装能预览**', async () => {
    const wrapper = await preview(entry({ key: 'a.zip', name: 'a.zip', kind: 'zip' }))
    expect(wrapper.text()).toContain('这个格式不能在这里预览')
    // 连签名链接都不该去要：要了也没东西可画
    expect(getFileUrl).not.toHaveBeenCalled()
  })

  it('svg 归到"不能预览"：内联它会变成存储型 XSS，服务端也会强制 attachment', async () => {
    const wrapper = await preview(entry({ key: 'a.svg', name: 'a.svg', kind: 'svg' }))
    expect(wrapper.text()).toContain('这个格式不能在这里预览')
  })
})
