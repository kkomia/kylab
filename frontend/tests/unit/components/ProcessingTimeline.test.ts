/**
 * 处理明细（§12.115）。
 *
 * 用户要的三件事必须一眼读得到：**共有几个环节、当前第几个、各环节各花多久**。
 * 另外两件是这次调研的结论：**停滞要么不说、要么说清"该做什么"**，以及
 * **重试要露头**（反复重试与卡住的处置不同）。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getDocumentTimeline = vi.fn()

vi.mock('@/api/documents', () => ({
  getDocumentTimeline: (...args: unknown[]) => getDocumentTimeline(...args),
}))

import ProcessingTimeline from '@/components/knowledge/ProcessingTimeline.vue'
import type { DocumentTimeline } from '@/api/documents'

function makeTimeline(overrides: Partial<DocumentTimeline> = {}): DocumentTimeline {
  return {
    document_id: 'doc_1',
    status: 'running',
    current_index: 3,
    step_total: 6,
    total_ms: 252_000,
    stalled: false,
    steps: [
      {
        key: 'uploaded',
        label: '已接收',
        status: 'done',
        duration_ms: 400,
        visits: 1,
        error: null,
      },
      {
        key: 'probing',
        label: '探测文件',
        status: 'done',
        duration_ms: 1200,
        visits: 1,
        error: null,
      },
      {
        key: 'parsing',
        label: '解析内容',
        status: 'running',
        duration_ms: 134_000,
        visits: 1,
        error: null,
      },
      {
        key: 'chunking',
        label: '切分与出题',
        status: 'pending',
        duration_ms: 0,
        visits: 0,
        error: null,
      },
      {
        key: 'embedding',
        label: '向量化',
        status: 'pending',
        duration_ms: 0,
        visits: 0,
        error: null,
      },
      {
        key: 'indexed',
        label: '完成索引',
        status: 'pending',
        duration_ms: 0,
        visits: 0,
        error: null,
      },
    ],
    ...overrides,
  }
}

async function mountPanel(timeline: DocumentTimeline) {
  getDocumentTimeline.mockResolvedValue(timeline)
  const wrapper = mount(ProcessingTimeline, {
    props: { documentId: 'doc_1', active: true },
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  getDocumentTimeline.mockReset()
})

describe('ProcessingTimeline', () => {
  it('顶部一行给全三个结论：共几个环节、当前第几个、总耗时', async () => {
    const wrapper = await mountPanel(makeTimeline())

    const headline = wrapper.find('.progress-headline').text()
    expect(headline).toContain('共 6 个环节')
    expect(headline).toContain('当前第 3 个')
    expect(headline).toContain('4 分 12 秒')
  })

  it('逐一列出每个环节与它自己花的时间', async () => {
    const wrapper = await mountPanel(makeTimeline())

    const rows = wrapper.findAll('.step')
    expect(rows).toHaveLength(6)
    expect(rows[1].text()).toContain('探测文件')
    expect(rows[1].text()).toContain('1 秒')
    expect(rows[2].text()).toContain('解析内容')
    expect(rows[2].text()).toContain('2 分 14 秒')
    // 还没走到的环节不编耗时，如实给"—"
    expect(rows[3].text()).toContain('未开始')
    expect(rows[3].text()).toContain('—')
  })

  it('重试过几步要露头：反复重试与卡住要做的事不同', async () => {
    const timeline = makeTimeline()
    timeline.steps[2].visits = 3
    const wrapper = await mountPanel(timeline)

    expect(wrapper.find('.step').exists()).toBe(true)
    expect(wrapper.text()).toContain('进入 3 次')
  })

  it('失败时把原因单独成块给出来', async () => {
    const timeline = makeTimeline({ status: 'failed', current_index: 3 })
    timeline.steps[2].status = 'failed'
    timeline.steps[2].error = '所有解析器都失败：-60006 文件超过 200 页'
    const wrapper = await mountPanel(timeline)

    expect(wrapper.text()).toContain('失败原因')
    expect(wrapper.find('.progress-failure').text()).toContain('-60006')
  })

  it('停滞要说清"没有 worker 在续约"以及该做什么', async () => {
    const wrapper = await mountPanel(makeTimeline({ stalled: true }))

    expect(wrapper.text()).toContain('疑似卡住')
    expect(wrapper.text()).toContain('没有 worker')
    // 只说"卡住"等于把问题丢回用户；这句是"该做什么"
    expect(wrapper.text()).toContain('重新摄入')
  })

  it('没在看着这一页时不发请求（抽屉里还有两个页签）', async () => {
    getDocumentTimeline.mockResolvedValue(makeTimeline())
    mount(ProcessingTimeline, { props: { documentId: 'doc_1', active: false } })
    await flushPromises()

    expect(getDocumentTimeline).not.toHaveBeenCalled()
  })

  it('说明文字里的强调走 <strong>，不写 markdown 星号', async () => {
    // 这里是纯文本模板，不经过 markdown 渲染：写 `**到此刻为止**` 会在界面上
    // 原样显示出四个星号（实机截图里看到了）
    const wrapper = await mountPanel(makeTimeline())

    expect(wrapper.text()).not.toContain('**')
    expect(wrapper.find('.progress-note strong').exists()).toBe(true)
  })

  it('请求失败时说清原因，不是空面板', async () => {
    getDocumentTimeline.mockRejectedValue(new Error('文档不存在：doc_1'))
    const wrapper = mount(ProcessingTimeline, { props: { documentId: 'doc_1', active: true } })
    await flushPromises()

    expect(wrapper.find('.progress-error').text()).toContain('文档不存在')
  })
})
