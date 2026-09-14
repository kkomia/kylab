/**
 * 模型注册面板读的是**共享注册表 store**，不是自己的一份私有副本。
 *
 * 这正是"设置里登记完模型、向量化的默认模型下拉却看不到"的根因：面板当时
 * 自己 `getRegistry()` 存了一个 ref，刷新只刷新自己那份。这条用例把"外部改了
 * 共享缓存，面板要跟着变"钉住——旧实现下它不会变。
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
  }
})

import type { Registry, RegisteredModel } from '@/api/modelRegistry'
import ModelRegistryPanel from '@/components/settings/ModelRegistryPanel.vue'
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

function model(modelId: string): RegisteredModel {
  return {
    id: `mdl_${modelId}`,
    provider_id: 'prov_1',
    provider_name: '测试源',
    provider_kind: 'llm',
    model_id: modelId,
    label: '',
    dim: null,
    capabilities: ['embedding'],
    options: {},
    created_at: null,
    updated_at: null,
    bound_slots: [],
  }
}

function registry(models: RegisteredModel[]): Registry {
  return {
    providers: [PROVIDER],
    models,
    slots: [],
    provider_kinds: {},
    capabilities: {},
    provider_presets: [],
  }
}

describe('ModelRegistryPanel', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    getRegistry.mockReset()
  })

  it('共享注册表变化时列表跟着更新（读的是共享缓存）', async () => {
    getRegistry.mockResolvedValue(registry([model('text-embedding-3-small')]))
    const store = useModelRegistryStore()
    const wrapper = mount(ModelRegistryPanel)
    await flushPromises()

    expect(wrapper.text()).toContain('text-embedding-3-small')

    // 另一处（比如登记接口返回后）刷新了共享缓存
    store.registry = registry([model('bge-m3')])
    store.loaded = true
    await flushPromises()

    expect(wrapper.text()).toContain('bge-m3')
    expect(wrapper.text()).not.toContain('text-embedding-3-small')
  })
})
