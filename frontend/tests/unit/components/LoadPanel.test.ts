/**
 * 运行负载面板（§12.115）。
 *
 * 这一格的每一处都在防同一种毛病：**把一个"不知道"渲染成看起来确定的数**。
 * CPU 第一次采样拿不到差值，就必须显示"—"而不是一根 0% 的条（会被读成"机器很空闲"）；
 * 云端额度没配令牌，就必须说"未配置"而不是"已用 0 / 1000 页"。
 */
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import LoadPanel from '@/components/tasks/LoadPanel.vue'
import type { SystemLoad } from '@/api/tasks'

function makeLoad(overrides: Partial<SystemLoad> = {}): SystemLoad {
  return {
    hardware: {
      cpu_percent: 37,
      cpu_count: 8,
      memory_used_bytes: 8 * 1024 ** 3,
      memory_total_bytes: 16 * 1024 ** 3,
      memory_percent: 50,
      process_rss_bytes: 512 * 1024 ** 2,
    },
    queue: {
      running: 1,
      pending: 4,
      slots: 3,
      pending_by_kind: { questions: 3, parse: 1 },
      oldest_pending_seconds: 754,
      stalled: 0,
      overdue: 0,
    },
    quota: {
      parser_name: 'MinerUCloudParser',
      configured: true,
      pages_used: 200,
      calls: 2,
      daily_quota: 1000,
      remaining: 800,
      exhausted: false,
    },
    sampled_at: '2026-09-15T12:00:00Z',
    ...overrides,
  }
}

describe('LoadPanel', () => {
  /**
   * 第 n 个仪表格（面板改成"一排仪表"之后，断言经常要限定在某一格里——
   * 整段文本里混着五格的数字，`not.toContain` 这类否定断言尤其容易被别的格污染）。
   */
  function gaugeAt(wrapper: ReturnType<typeof mount>, index: number) {
    return wrapper.findAll('.gauge')[index]
  }

  it('CPU 与内存都显示数值与总量', () => {
    const wrapper = mount(LoadPanel, { props: { load: makeLoad() } })

    expect(wrapper.text()).toContain('37%')
    expect(wrapper.text()).toContain('8 核')
    expect(wrapper.text()).toContain('8.0 GB / 16.0 GB')
  })

  it('CPU 还没有采样结果时说"采样中"，不画成 0%', () => {
    const load = makeLoad()
    load.hardware.cpu_percent = null
    const wrapper = mount(LoadPanel, { props: { load } })

    expect(wrapper.text()).toContain('采样中')
    expect(wrapper.text()).toContain('8 核')
    // 0% 会被读成"机器很空闲"，这是最误导的答案。
    // **断言限定在 CPU 那一格**（v0.25 收紧）：额度那一格的 0% 是**真的 0%**
    // （0 / 1000 页），拿整段文本去断言 `not.toContain('0%')` 会把那个合法值一起算进来。
    expect(gaugeAt(wrapper, 0).text()).not.toContain('0%')
  })

  it('槽位与队列深度一起读：在跑 / 上限 + 排队条数与最久等待', () => {
    const wrapper = mount(LoadPanel, { props: { load: makeLoad() } })

    expect(wrapper.text()).toContain('1 / 3 在跑')
    expect(wrapper.text()).toContain('排队')
    expect(wrapper.text()).toContain('出题 3')
    expect(wrapper.text()).toContain('解析 1')
    expect(wrapper.text()).toContain('12 分 34 秒')
  })

  it('槽位占满且还有排队时，给出可操作的解释', () => {
    const load = makeLoad()
    load.queue.running = 3
    const wrapper = mount(LoadPanel, { props: { load } })

    expect(wrapper.text()).toContain('槽位已占满')
    expect(wrapper.text()).toContain('KYLAB_WORKER_CONCURRENCY')
  })

  it('在跑数超过上限时说清那是"待回收的瞬时状态"，而不是算错了', () => {
    // 实机杀进程重启后出现过 2 / 1：旧进程手上的任务还写着 running，租约未到期。
    // 不解释的话，"上限 1 却有 2 个在跑"读起来像面板算错了。
    const load = makeLoad()
    load.queue.running = 4
    load.queue.slots = 2
    const wrapper = mount(LoadPanel, { props: { load } })

    expect(wrapper.text()).toContain('4 / 2 在跑')
    expect(wrapper.text()).toContain('超过了上限')
    expect(wrapper.text()).toContain('回到队列')
  })

  it('额度用尽说"不是失败"，因为用户会把它当成故障', () => {
    const load = makeLoad()
    load.quota.pages_used = 1200
    load.quota.exhausted = true
    load.quota.remaining = 0

    const wrapper = mount(LoadPanel, { props: { load } })

    expect(wrapper.text()).toContain('1200 / 1000 页')
    expect(wrapper.text()).toContain('额度已用尽')
    expect(wrapper.text()).toContain('不是失败')
  })

  it('没配云端令牌时说"未配置"，不说"用了 0 页"', () => {
    const load = makeLoad()
    load.quota.configured = false
    const wrapper = mount(LoadPanel, { props: { load } })

    expect(wrapper.text()).toContain('未配置云端解析令牌')
    expect(wrapper.text()).not.toContain('0 / 1000 页')
  })

  it('有停滞/逾期任务时才多出那一行', () => {
    const clean = mount(LoadPanel, { props: { load: makeLoad() } })
    expect(clean.text()).not.toContain('可能卡住')

    const load = makeLoad()
    load.queue.stalled = 2
    load.queue.overdue = 1
    const wrapper = mount(LoadPanel, { props: { load } })

    expect(wrapper.text()).toContain('2 个任务可能卡住')
    expect(wrapper.text()).toContain('1 个任务长时间未被领取')
  })

  it('数据还没到时也把结构画出来，只显示"—"与"读取中"', () => {
    const wrapper = mount(LoadPanel, { props: { load: null } })

    expect(wrapper.text()).toContain('运行负载')
    expect(wrapper.text()).toContain('—')
    expect(wrapper.text()).toContain('读取中')
  })
})
