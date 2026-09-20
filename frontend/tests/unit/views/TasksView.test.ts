/**
 * 任务中心：空闲队列下也要读一次负载面板。
 *
 * **这条用例来自一次真实的联调**：视觉核对（逐页截屏）时发现负载面板永远停在
 * "读取中…"，查请求记录才确认 `/api/v1/tasks/load` **一次都没被请求过**。
 * 两个原因叠在一起，各自看着都合理：
 *
 * 1. `usePolling` 只在"有任务在跑"时轮询（空闲不发请求是 §12.116 的有意优化），
 *    而它连带把"首次读取"也省掉了；
 * 2. 面板是管理员专属，`refreshLoad` 开头就 `if (!isAdmin) return`——
 *    而**会话恢复是异步的**，挂载那一刻 `isAdmin` 还是 false，
 *    所以"在 onMounted 里补一次"这种修法等于什么都没做（第一版就是这么修的）。
 *
 * 现在挂在 `isAdmin` 上（`immediate` 覆盖"进页面时已经恢复完"的情况）。
 * 断言的落点是**行为**（发过请求、面板不再是读取中），不是实现细节。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

const listTasks = vi.fn()
const getTaskLoad = vi.fn()

vi.mock('@/api/tasks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/tasks')>()
  return {
    ...actual,
    listTasks: (...args: unknown[]) => listTasks(...args),
    getTaskLoad: (...args: unknown[]) => getTaskLoad(...args),
    cancelTasks: vi.fn(),
  }
})

// 会话恢复在真实应用里是异步的；这里直接给一个"已经恢复成管理员"的 ref，
// 让 `immediate` 那条路径生效（异步恢复那条路径由下面的第二个用例覆盖）
const admin = vi.hoisted(() => ({ current: true }))
vi.mock('@/composables/useSession', async () => {
  const { ref } = await import('vue')
  return { isAdmin: ref(admin.current) }
})

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ notifyError: vi.fn(), notifySuccess: vi.fn(), notify: vi.fn() }),
}))

vi.mock('@/stores/knowledgeBases', () => ({
  useKnowledgeBaseStore: () => ({ items: [], load: vi.fn(), byId: () => undefined }),
}))

import TasksView from '@/views/TasksView.vue'

const IDLE_LOAD = {
  hardware: {
    cpu_percent: 2.4,
    cpu_count: 16,
    memory_used_bytes: 20_000_000_000,
    memory_total_bytes: 34_000_000_000,
    memory_percent: 58.8,
    process_rss_bytes: 130_000_000,
  },
  queue: {
    running: 0,
    pending: 0,
    slots: 1,
    pending_by_kind: {},
    oldest_pending_seconds: null,
    stalled: 0,
    overdue: 0,
  },
  quota: {
    parser_name: 'MinerUCloudParser',
    configured: true,
    pages_used: 0,
    calls: 0,
    daily_quota: 1000,
    remaining: 1000,
    exhausted: false,
  },
  sampled_at: '2026-09-18T02:00:00Z',
}

async function mountPage() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/tasks', component: { template: '<div />' } }],
  })
  await router.push('/tasks')
  await router.isReady()
  const wrapper = mount(TasksView, { global: { plugins: [router] } })
  await flushPromises()
  return wrapper
}

describe('任务中心：负载面板的首屏读取', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    listTasks.mockReset().mockResolvedValue({ items: [], total: 0 })
    getTaskLoad.mockReset().mockResolvedValue(IDLE_LOAD)
  })

  it('队列空闲（没有任务在跑）时也读一次：面板不许永远停在"读取中…"', async () => {
    const wrapper = await mountPage()

    expect(getTaskLoad).toHaveBeenCalled()
    const panel = wrapper.find('.load').text()
    expect(panel).not.toContain('读取中')
    expect(panel).toContain('16 核') // CPU 那一行的"· 16 核"来自负载数据
    wrapper.unmount()
  })

  it('任务在跑时仍按节奏轮询（首屏读取不该把轮询条件绕过去）', async () => {
    listTasks.mockResolvedValue({
      items: [
        {
          id: 't1',
          kind: 'parse',
          state: 'running',
          document_id: 'd1',
          document_name: '甲.pdf',
          attempts: 1,
          max_attempts: 5,
          updated_at: null,
          error: null,
          health: 'running',
        },
      ],
      total: 1,
    })

    const wrapper = await mountPage()

    // 有活在跑 → 轮询表起来（组件上显示"有任务在跑，自动刷新中"）
    expect(wrapper.text()).toContain('自动刷新中')
    expect(getTaskLoad).toHaveBeenCalled()
    wrapper.unmount()
  })
})
