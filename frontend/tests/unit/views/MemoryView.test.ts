/**
 * 记忆页的一处归属（v0.26）。
 *
 * 「长期记忆」那一组设置从总设置搬到了这一页，理由是这一页顶着一句
 * "记忆服务未启用"——同一个东西的说明和开关隔着两个菜单，用户按指引找过去
 * 还得先猜它在哪一组。这里钉住搬家后的两件事：**入口在**、**只给管理员**。
 *
 * 面板本身（怎么渲染、怎么保存）由 `SettingGroupPanel.test.ts` 覆盖，
 * 这里换成桩：这一条要证的是"这一页把它挂上了"。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getMemory = vi.fn()
const getMemoryFile = vi.fn()
const getMemoryGraph = vi.fn()

vi.mock('@/api/memory', () => ({
  getMemory: (...a: unknown[]) => getMemory(...a),
  getMemoryFile: (...a: unknown[]) => getMemoryFile(...a),
  getMemoryGraph: (...a: unknown[]) => getMemoryGraph(...a),
  recallMemory: vi.fn(),
  reindexMemory: vi.fn(),
  rememberMemory: vi.fn(),
  writeMemoryFile: vi.fn(),
  deleteMemoryFile: vi.fn(),
}))

// `vi.mock` 会被提升到文件顶部，工厂里**不能引用普通的顶层变量**
// （那样拿到的是"还没初始化"）。所以 ref 在工厂里现建，
// 测试再从被 mock 的模块里把它拿出来改。
//
// **必须是真的 ref**，不能图省事给个 `{ value: true }`：模板里的 `v-if="isAdmin"`
// 只对 ref 做自动解包，普通对象永远是 truthy——那样"成员看不到入口"这条会假通过。
vi.mock('@/composables/useSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/composables/useSession')>()
  const { ref } = await import('vue')
  return { ...actual, isAdmin: ref(true) }
})

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ notifyError: vi.fn(), notifySuccess: vi.fn(), notifyWarning: vi.fn() }),
}))

import MemoryView from '@/views/MemoryView.vue'
import { isAdmin } from '@/composables/useSession'

const adminFlag = isAdmin as unknown as { value: boolean }

const OVERVIEW = {
  enabled: false,
  detail: '记忆服务未启用',
  workspace: 'memory',
  files: [],
  capture_every: 6,
}

function mountView() {
  return mount(MemoryView, {
    global: {
      stubs: {
        // 桩要**真的按 `open` 开合**：否则"点按钮有没有把它打开"这件事就测不到了
        AppModal: { props: ['open', 'title'], template: '<div v-if="open"><slot /></div>' },
        SettingGroupPanel: {
          name: 'SettingGroupPanel',
          props: { keys: { type: Array, default: () => [] } },
          template: '<div class="panel-stub">{{ keys.join(",") }}</div>',
        },
        PageShell: {
          props: ['title'],
          template: '<div><slot name="actions" /><slot /></div>',
        },
        SkeletonBlock: true,
        MemoryGraph: true,
        InfoTip: true,
      },
    },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  adminFlag.value = true
  getMemory.mockResolvedValue(OVERVIEW)
  getMemoryGraph.mockResolvedValue({ nodes: [], edges: [] })
})

describe('记忆页的设置入口', () => {
  it('管理员能看到「设置」，点开是长期记忆那一组', async () => {
    const wrapper = mountView()
    await flushPromises()

    const button = wrapper.findAll('button').find((item) => item.text().includes('设置'))
    expect(button).toBeTruthy()
    // 没点之前面板不在（弹窗关着）
    expect(wrapper.find('.panel-stub').exists()).toBe(false)

    await button!.trigger('click')
    await flushPromises()

    expect(wrapper.find('.panel-stub').text()).toBe('memory')
  })

  it('成员看不到这个入口：/settings 是管理员端点，露出来只会点出一句 403', async () => {
    adminFlag.value = false
    const wrapper = mountView()
    await flushPromises()

    const button = wrapper.findAll('button').find((item) => item.text().includes('设置'))
    expect(button).toBeUndefined()
  })
})
