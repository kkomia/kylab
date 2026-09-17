/**
 * 「登记完模型，向量化的默认模型下拉要立刻能选到它」——用户实测 bug。
 *
 * 原先本弹窗自己 `getRegistry()` 存了一份 ref，「模型注册」面板也存了一份：
 * 面板里加完模型只刷新了它那份，本弹窗的 `slotOptions()` 读的还是旧数据，
 * 必须关掉设置再打开才刷新。
 *
 * 这条用例走的是"另一个消费者刷新了共享缓存"这一步——在旧实现下，
 * 改共享 store 对本弹窗毫无影响，断言会失败。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getRegistry = vi.fn()

vi.mock('@/api/modelRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/modelRegistry')>()
  return {
    ...actual,
    getRegistry: (...args: unknown[]) => getRegistry(...args),
    bindSlot: vi.fn(),
  }
})

vi.mock('@/api/health', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/health')>()
  return { ...actual, fetchHealth: vi.fn().mockResolvedValue({ status: 'ok' }) }
})

vi.mock('@/api/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/settings')>()
  return {
    ...actual,
    getAuthStatus: vi.fn().mockResolvedValue({ needs_setup: false }),
    getSettings: vi.fn().mockResolvedValue({ groups: [] }),
    testConnection: vi.fn(),
    updateSettings: vi.fn(),
  }
})

vi.mock('@/api/users', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/users')>()
  return { ...actual, listUsers: vi.fn().mockResolvedValue({ items: [] }) }
})

import type { Registry } from '@/api/modelRegistry'
import SettingsModal from '@/components/settings/SettingsModal.vue'
import AppSelect from '@/components/ui/AppSelect.vue'
import { useModelRegistryStore } from '@/stores/modelRegistry'

const PROVIDER = {
  id: 'prov_1',
  kind: 'llm',
  name: '测试源',
  base_url: 'https://api.example.com',
  enabled: true,
  created_at: null,
  updated_at: null,
  api_key_configured: true,
  api_key_hint: 'sk-…abc',
  model_count: 1,
}

function registry(models: Registry['models']): Registry {
  return {
    providers: [PROVIDER],
    models,
    slots: [],
    provider_kinds: {},
    capabilities: {},
    provider_presets: [],
  }
}

const EMBEDDING_MODEL = {
  id: 'mdl_1',
  provider_id: 'prov_1',
  provider_name: '测试源',
  provider_kind: 'llm',
  model_id: 'text-embedding-3-small',
  label: '小模型',
  dim: 1536,
  capabilities: ['embedding'],
  options: {},
  created_at: null,
  updated_at: null,
  bound_slots: [],
}

describe('SettingsModal 的默认模型下拉', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    getRegistry.mockReset()
  })

  it('登记完模型后，「向量化」下拉无需重开设置即可选到它', async () => {
    getRegistry.mockResolvedValue(registry([]))
    const wrapper = mount(SettingsModal, { props: { open: true } })
    await flushPromises()

    // 切到「向量化」分组
    const vectorTab = wrapper.findAll('button').find((b) => b.text().trim() === '向量化')
    expect(vectorTab).toBeTruthy()
    await vectorTab!.trigger('click')
    await flushPromises()

    const embeddingSelect = () =>
      wrapper.findAllComponents(AppSelect).find((c) => c.props('ariaLabel') === '默认嵌入模型')
    const labels = () =>
      (embeddingSelect()!.props('options') as { label: string }[]).map((o) => o.label)

    expect(labels()).not.toContain('小模型 · 测试源')

    // 「模型注册」面板登记成功后刷新共享缓存（就是它 `load()` 那一步）
    getRegistry.mockResolvedValue(registry([EMBEDDING_MODEL]))
    await useModelRegistryStore().load()
    await flushPromises()

    expect(labels()).toContain('小模型 · 测试源')
  })
})

/**
 * **每一个后端设置组都要在界面上有入口**（实测报过来的 bug）。
 *
 * 用户的原话是"这哪里有长期记忆了？"：记忆页与工具报错都写着
 * 「到「设置 → 长期记忆」打开」，而设置弹窗的菜单是一张**手写清单**
 * （向量化 / 对话模型 / MinerU / PaddleOCR）——长期记忆、联网、沙箱执行
 * 三组在后端有、在界面上没有，用户根本点不到。
 *
 * 这条用例喂进去一个"后端加了新组"的场景，断言它自动出现在菜单里：
 * 以后加组的那个人的忘性，就是这条用例在替他兜。
 */
describe('设置菜单要覆盖后端返回的每一个组', () => {
  const GROUPS = [
    {
      key: 'memory',
      label: '长期记忆',
      fields: [
        {
          key: 'memory.enabled',
          label: '启用长期记忆',
          type: 'bool',
          value: 'false',
          configured: false,
          options: [],
        },
        {
          key: 'memory.base_url',
          label: '服务地址',
          type: 'text',
          value: 'http://127.0.0.1:2333',
          configured: false,
          options: [],
        },
      ],
    },
    {
      key: 'web',
      label: '联网',
      fields: [
        {
          key: 'web.search_provider',
          label: '搜索服务商',
          type: 'text',
          value: 'tavily',
          configured: false,
          options: [],
        },
        {
          key: 'web.search_api_key',
          label: '搜索 API 密钥',
          type: 'secret',
          value: '',
          configured: false,
          options: [],
        },
      ],
    },
    // 一个"将来才加的"组：没有任何专门渲染，也不该被漏掉
    {
      key: 'brand_new',
      label: '将来才加的一组',
      fields: [
        {
          key: 'brand_new.flag',
          label: '某个开关',
          type: 'bool',
          value: 'true',
          configured: false,
          options: [],
        },
      ],
    },
  ]

  it('后端有、界面没专门渲染的组自动出现在「功能」下，并带开关状态', async () => {
    const { getSettings } = await import('@/api/settings')
    vi.mocked(getSettings).mockResolvedValue({ groups: GROUPS } as never)

    const wrapper = mount(SettingsModal, { props: { open: true } })
    await flushPromises()

    const nav = wrapper.text()
    for (const group of GROUPS) {
      expect(nav).toContain(group.label)
    }
    expect(wrapper.text()).toContain('功能')

    // 点进去：字段与"开着没有"要看得见（布尔项说"已开启/未开启"，不显示 true/false）
    await wrapper
      .findAll('button')
      .find((item) => item.text().includes('长期记忆'))
      ?.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('启用长期记忆')
    expect(wrapper.text()).toContain('未开启')
    expect(wrapper.text()).toContain('http://127.0.0.1:2333')
  })
})
