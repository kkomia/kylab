/**
 * 定时任务面板（v0.33）：能建、能停、能立刻跑一次。
 *
 * 这一组盯的是**这个产品面的三条承诺**：
 *
 * 1. **时间看得懂**：界面上写的是"每天 09:00"而不是 `0 9 * * *`，而且**时区必须露出来**
 *    ——不写出来"每天 9 点"是哪个 9 点就只能猜，而猜错的代价是它在你睡觉时跑；
 * 2. **上一轮的结果三种状态分开说**：跑成了 / 没跑完（撞上步数或时间闸）/ 失败，
 *    第三种带原因。合成一句"上次运行"会让人分不清"它没跑"和"它跑砸了"；
 * 3. **停用之后不再显示"下次"**：停用还挂着下次时间，会让人以为它还会跑。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

const listScheduledTasks = vi.fn()
const runScheduledTaskNow = vi.fn()
const updateScheduledTask = vi.fn()
const deleteScheduledTask = vi.fn()
const createScheduledTask = vi.fn()

vi.mock('@/api/schedules', () => ({
  listScheduledTasks: (...args: unknown[]) => listScheduledTasks(...args),
  createScheduledTask: (...args: unknown[]) => createScheduledTask(...args),
  updateScheduledTask: (...args: unknown[]) => updateScheduledTask(...args),
  deleteScheduledTask: (...args: unknown[]) => deleteScheduledTask(...args),
  runScheduledTaskNow: (...args: unknown[]) => runScheduledTaskNow(...args),
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ notifyError: vi.fn(), notifySuccess: vi.fn(), notifyWarning: vi.fn() }),
}))

vi.mock('@/stores/knowledgeBases', () => ({
  useKnowledgeBaseStore: () => ({ items: [], load: vi.fn(), byId: () => undefined }),
}))

import type { ScheduledTask } from '@/api/schedules'
import SchedulePanel from '@/components/tasks/SchedulePanel.vue'

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'sched_1',
    name: '每日早报',
    prompt: '把昨天的构建日志汇总成三条结论',
    kind: 'cron',
    cron: '0 9 * * *',
    run_at: null,
    next_run_at: '2026-09-21T01:00:00Z',
    enabled: true,
    kb_ids: [],
    conversation_id: null,
    last_run_at: null,
    last_status: '',
    last_error: '',
    run_count: 0,
    schedule_text: '每天 09:00',
    created_at: null,
    updated_at: null,
    ...overrides,
  }
}

async function mountPanel(items: ScheduledTask[] = []) {
  listScheduledTasks.mockResolvedValue({ items, timezone: 'CST UTC+08:00' })
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/chat/:id', component: { template: '<div />' } },
    ],
  })
  await router.push('/')
  await router.isReady()
  const wrapper = mount(SchedulePanel, { global: { plugins: [router] } })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  listScheduledTasks.mockReset()
  runScheduledTaskNow.mockReset()
  updateScheduledTask.mockReset()
  deleteScheduledTask.mockReset()
  createScheduledTask.mockReset()
})

describe('定时任务面板', () => {
  it('没挂过任务时给出空态与例子', async () => {
    const wrapper = await mountPanel([])
    expect(wrapper.text()).toContain('还没有定时任务')
    // 空态要举一个"这句话该写成什么样"的例子：光说"新建一条"没人知道填什么
    expect(wrapper.text()).toContain('每天 9 点')
  })

  it('一行里能看出什么时候跑、上次跑成没跑成', async () => {
    const wrapper = await mountPanel([
      task({ last_status: 'ok', last_run_at: '2026-09-20T01:00:00Z', run_count: 3 }),
    ])
    const text = wrapper.text()
    expect(text).toContain('每日早报')
    expect(text).toContain('每天 09:00')
    expect(text).toContain('下次')
    expect(text).toContain('上次跑成了')
    expect(text).toContain('跑过 3 次')
  })

  it('时区必须显示出来', async () => {
    const wrapper = await mountPanel([task()])
    expect(wrapper.text()).toContain('CST UTC+08:00')
  })

  it('没跑完与失败分开说', async () => {
    const wrapper = await mountPanel([
      task({ id: 'a', last_status: 'degraded', last_run_at: '2026-09-20T01:00:00Z' }),
      task({
        id: 'b',
        name: '周报',
        last_status: 'failed',
        last_run_at: '2026-09-20T01:00:00Z',
        last_error: '上游 500',
      }),
    ])
    const text = wrapper.text()
    expect(text).toContain('上次没跑完')
    expect(text).toContain('上次失败')
    // 失败原因要露出来，不然还得点进去才知道为什么
    expect(text).toContain('上游 500')
  })

  it('停用之后不再显示"下次"', async () => {
    const wrapper = await mountPanel([task({ enabled: false })])
    expect(wrapper.text()).toContain('已停用')
    expect(wrapper.text()).not.toContain('下次 ')
  })

  it('「立即跑一次」入队并提示结果去哪儿看', async () => {
    runScheduledTaskNow.mockResolvedValue({ task_id: 'task_1', detail: '' })
    const wrapper = await mountPanel([task()])
    const button = wrapper.findAll('button').find((item) => item.text().includes('立即跑一次'))
    expect(button).toBeTruthy()
    await button!.trigger('click')
    await flushPromises()
    expect(runScheduledTaskNow).toHaveBeenCalledWith('sched_1')
  })

  it('停用会把这一条改成 enabled=false', async () => {
    updateScheduledTask.mockResolvedValue(task({ enabled: false }))
    const wrapper = await mountPanel([task()])
    const button = wrapper.findAll('button').find((item) => item.text() === '停用')
    await button!.trigger('click')
    await flushPromises()
    expect(updateScheduledTask).toHaveBeenCalledWith('sched_1', { enabled: false })
  })

  it('跑过之后才有「看结果」这个入口', async () => {
    const without = await mountPanel([task()])
    expect(without.text()).not.toContain('看结果')
    const withConversation = await mountPanel([task({ conversation_id: 'conv_1' })])
    expect(withConversation.text()).toContain('看结果')
  })
})
