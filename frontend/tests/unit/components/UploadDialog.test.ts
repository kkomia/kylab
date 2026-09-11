/**
 * 上传弹窗的**本地判定**与提交循环。
 *
 * 为什么值得单独测：这里有三处"界面说了但后端也会说"的规则——
 * 单文件上限、一次文件数上限、重复内容跳过。它们的价值全在**赶在网络之前**：
 * 一个 300MB 的文件要整段读完才在对面被告知超限，用户白等的那几十秒
 * 就是这几行代码省下来的。规则挪到后端也一样能拦，但那就没意义了。
 *
 * 后端仍然会拒（`MAX_UPLOAD_BYTES` 在 `app/api/v1/documents.py`）。
 * 所以这里断言的**不是"能不能传"**，而是"会不会白跑一趟网络"。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import * as documentsApi from '@/api/documents'
import UploadDialog from '@/components/knowledge/UploadDialog.vue'
import {
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_FILES,
  MAX_UPLOAD_MB,
  UPLOAD_FORMAT_HINT,
} from '@/composables/uploadLimits'

vi.mock('@/api/documents', () => ({
  uploadDocument: vi.fn(),
}))

/** 造一个只有 size 有意义的假 File——真实文件内容是后端的事，这里只走判定分支。 */
function fileOf(name: string, size = 10): File {
  const file = new File(['x'], name, { type: 'application/octet-stream' })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

/** 最小的合法响应。**照 `UploadAccepted` 写全**（含 `task_id`）而不是只写界面用到的两个字段：
 *  界面没读它不等于接口没有——少写字段会让类型检查在 `vue-tsc -b` 里红，
 *  而 `vitest` 是单跑的，看不到这个问题（本次就是这么被门禁抓到的）。 */
function accepted(name: string, duplicate = false): documentsApi.UploadAccepted {
  return {
    document: {
      id: `doc_${name}`,
      knowledge_base_id: 'kb_1',
      name,
      source_kind: 'upload',
      stage: 'uploaded',
      size_bytes: 10,
      mime_type: 'application/octet-stream',
      page_count: null,
      is_split: false,
      error: null,
      chunk_count: 0,
      uploaded_by: null,
      uploaded_by_name: '',
      folder_id: null,
      created_at: '2026-09-11T00:00:00Z',
      updated_at: '2026-09-11T00:00:00Z',
    },
    is_duplicate: duplicate,
    task_id: duplicate ? null : `task_${name}`,
  }
}

/** 挂载时把 AppModal 换成直通容器：原生 `<dialog>` 的 top layer 与 `showModal`
 *  在 jsdom 里没有实现，而这个文件的被测对象是**内容与逻辑**，不是那层壳。
 *  壳的行为（Esc 清空、焦点陷阱）已经由 `.shots/upload-dialog.cjs` 在真浏览器里验过。 */
function mountDialog() {
  return mount(UploadDialog, {
    props: { open: true, kbId: 'kb_1', kbName: '产品手册' },
    global: {
      stubs: {
        AppModal: { template: '<div><slot /><slot name="footer" /></div>' },
      },
    },
  })
}

async function pick(wrapper: ReturnType<typeof mountDialog>, files: File[]) {
  const input = wrapper.find('input[type=file]')
  Object.defineProperty(input.element, 'files', { value: files, configurable: true })
  await input.trigger('change')
  await flushPromises()
}

const uploadMock = vi.mocked(documentsApi.uploadDocument)

beforeEach(() => {
  uploadMock.mockReset()
  uploadMock.mockImplementation((_kb, file) => Promise.resolve(accepted(file.name)))
})

describe('单文件上限', () => {
  it('超限文件标为"未接收"，且不发起请求', async () => {
    const wrapper = mountDialog()
    await pick(wrapper, [fileOf('巨大.pdf', MAX_UPLOAD_BYTES + 1)])

    expect(uploadMock).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('未接收')
    expect(wrapper.find('.file-status-rejected').exists()).toBe(true)
  })

  it('恰好等于上限要放行——边界上的 `>` 与 `>=` 差一个字节，写错了没人看得出来', async () => {
    const wrapper = mountDialog()
    await pick(wrapper, [fileOf('刚好.pdf', MAX_UPLOAD_BYTES)])

    // 放行 = 进了待上传、主按钮可点。写成 `>=` 的话这一条会红
    expect(wrapper.text()).toContain('待上传')
    expect(wrapper.find('.file-status-rejected').exists()).toBe(false)
    const submit = wrapper.findAll('button').find((b) => b.text().includes('开始上传'))
    expect(submit!.attributes('disabled')).toBeUndefined()
  })

  it('提示里写出的 MB 数与常量同源，不是另抄的一个 200', async () => {
    const wrapper = mountDialog()
    const mb = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))
    expect(wrapper.text()).toContain(`单个文件不超过 ${mb}MB`)
  })
})

describe('一次文件数上限', () => {
  it('超出部分不加入清单，并明说少加了几个', async () => {
    const wrapper = mountDialog()
    const many = Array.from({ length: MAX_UPLOAD_FILES + 3 }, (_, i) => fileOf(`f${i}.txt`))
    await pick(wrapper, many)

    expect(wrapper.findAll('.file-row')).toHaveLength(MAX_UPLOAD_FILES)
    // 静默丢弃是最坏的处理：用户以为选上了，等传完才发现少文件
    expect(wrapper.text()).toContain(`后面的 3 个没有加入清单`)
  })

  it('同一批里的同名同大小文件只进一次，并且说一句免得用户以为界面吞了文件', async () => {
    const wrapper = mountDialog()
    await pick(wrapper, [fileOf('a.txt'), fileOf('a.txt'), fileOf('b.txt')])

    expect(wrapper.findAll('.file-row')).toHaveLength(2)
    expect(wrapper.text()).toContain('重复选择，只加入清单一次')
  })

  it('同名但大小不同算两个文件——内容不同的两个 a.txt 是常事', async () => {
    const wrapper = mountDialog()
    await pick(wrapper, [fileOf('a.txt', 10), fileOf('a.txt', 20)])
    expect(wrapper.findAll('.file-row')).toHaveLength(2)
  })
})

describe('提交循环', () => {
  it('逐文件记录三种结果：成功 / 重复 / 失败', async () => {
    uploadMock.mockImplementation((_kb, file) => {
      if (file.name === '重复.txt') return Promise.resolve(accepted(file.name, true))
      if (file.name === '坏.txt') return Promise.reject(new Error('不支持的文本内容'))
      return Promise.resolve(accepted(file.name))
    })

    const wrapper = mountDialog()
    await pick(wrapper, [fileOf('新.txt'), fileOf('重复.txt'), fileOf('坏.txt')])

    const submit = wrapper.findAll('button').find((b) => b.text().includes('开始上传'))
    expect(submit).toBeTruthy()
    await submit!.trigger('click')
    await flushPromises()

    const statuses = wrapper.findAll('.file-status').map((s) => s.text())
    expect(statuses).toEqual(['已提交', '重复，已跳过', '失败'])
    expect(wrapper.text()).toContain('不支持的文本内容')
    expect(wrapper.emitted('uploaded')).toHaveLength(1)
  })

  it('串行而不是并发：后端摄入是 CPU 密集的，同时跑只会让每个都更慢', async () => {
    const order: string[] = []
    let inFlight = 0
    let maxInFlight = 0
    uploadMock.mockImplementation(async (_kb, file) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await Promise.resolve()
      order.push(file.name)
      inFlight -= 1
      return accepted(file.name)
    })

    const wrapper = mountDialog()
    await pick(wrapper, [fileOf('a.txt'), fileOf('b.txt'), fileOf('c.txt')])
    const submit = wrapper.findAll('button').find((b) => b.text().includes('开始上传'))
    await submit!.trigger('click')
    await flushPromises()

    expect(maxInFlight).toBe(1)
    expect(order).toEqual(['a.txt', 'b.txt', 'c.txt'])
  })

  it('失败的可以重试，被本地拒的不进重试', async () => {
    uploadMock.mockImplementation((_kb, file) =>
      file.name === '坏.txt'
        ? Promise.reject(new Error('上游超时'))
        : Promise.resolve(accepted(file.name)),
    )

    const wrapper = mountDialog()
    await pick(wrapper, [fileOf('坏.txt'), fileOf('巨大.pdf', MAX_UPLOAD_BYTES + 1)])

    const submit = wrapper.findAll('button').find((b) => b.text().includes('开始上传'))
    await submit!.trigger('click')
    await flushPromises()

    const retry = wrapper.findAll('button').find((b) => b.text().includes('重试失败项'))
    expect(retry, '有 failed 就该给重试入口').toBeTruthy()
    expect(retry!.text()).toContain('1')

    await retry!.trigger('click')
    await flushPromises()

    // 被本地拒的那个仍然是"未接收"：重置了也会被同一把尺子再拦一次
    expect(wrapper.find('.file-status-rejected').text()).toBe('未接收')
    expect(wrapper.findAll('button').some((b) => b.text().includes('重试失败项'))).toBe(false)
  })

  it('没有待上传项时主按钮不可用', async () => {
    const wrapper = mountDialog()
    await pick(wrapper, [fileOf('巨大.pdf', MAX_UPLOAD_BYTES + 1)])

    const submit = wrapper.findAll('button').find((b) => b.text().includes('开始上传'))
    expect(submit!.attributes('disabled')).toBeDefined()
  })
})

describe('切块参数', () => {
  it('弹窗里不提供逐文件的切块参数——那是知识库级属性', async () => {
    const wrapper = mountDialog()
    // 切块策略与块长在建库时定、向量化时冻结；放这里会让人以为可以逐文件不同，
    // 那会造成同一库里切法不一致，检索质量无从解释。
    // 提示文案里也不再展开这段技术说明（用户要的只是"能不能传、多大"）。
    expect(wrapper.find('select').exists()).toBe(false)
    expect(wrapper.find('input[type=number]').exists()).toBe(false)
  })
})

describe('提示文案', () => {
  it('只说支持的类型与大小/数量上限，不讲解析链路', async () => {
    const wrapper = mountDialog()

    const scope = wrapper.find('.scope').text()
    expect(scope).toContain(UPLOAD_FORMAT_HINT)
    expect(scope).toContain(String(MAX_UPLOAD_MB))
    expect(scope).toContain(String(MAX_UPLOAD_FILES))
    // 解析渠道/切块策略这类内部细节不该出现在给用户看的规则里
    expect(scope).not.toContain('OCR')
    expect(scope).not.toContain('切块')
  })
})

describe('上传入口', () => {
  it('文件与文件夹两个入口；"选择文件"本身就支持多选', () => {
    const wrapper = mountDialog()

    const inputs = wrapper.findAll('input[type=file]')
    expect(inputs).toHaveLength(2)
    // 一个入口就够：多选是"选择文件"自带的，不该再多一个"选择多个文件"
    expect(inputs[0].attributes('multiple')).toBeDefined()
    expect(inputs[0].attributes('webkitdirectory')).toBeUndefined()
    expect(inputs[1].attributes('webkitdirectory')).toBeDefined()

    const labels = wrapper.findAll('.dropzone-actions button').map((b) => b.text())
    expect(labels).toEqual(['选择文件', '选择文件夹'])
  })

  it('文件夹里的同名文件按相对路径区分，不会被去重误吞', async () => {
    const wrapper = mountDialog()
    const inDocs = Object.assign(fileOf('a.txt'), { webkitRelativePath: 'docs/a.txt' })
    const inOther = Object.assign(fileOf('a.txt'), { webkitRelativePath: 'other/a.txt' })

    await pick(wrapper, [inDocs, inOther])

    expect(wrapper.findAll('.file-row')).toHaveLength(2)
    expect(wrapper.findAll('.file-name').map((node) => node.text())).toEqual([
      'docs/a.txt',
      'other/a.txt',
    ])
  })
})
