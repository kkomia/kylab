import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import * as api from '@/api/modelRegistry'
import { useModelRegistryStore } from '@/stores/modelRegistry'

function registry(modelId: string): api.Registry {
  return {
    providers: [
      {
        id: 'prov_1',
        kind: 'llm',
        name: '深度求索',
        base_url: 'https://api.deepseek.com',
        enabled: true,
        created_at: null,
        updated_at: null,
        api_key_configured: true,
        api_key_hint: 'sk-…abc',
        model_count: 1,
      },
    ],
    models: [
      {
        id: 'mdl_1',
        provider_id: 'prov_1',
        provider_name: '深度求索',
        provider_kind: 'llm',
        model_id: modelId,
        label: '',
        dim: null,
        capabilities: ['chat'],
        options: {},
        created_at: null,
        updated_at: null,
        bound_slots: ['chat'],
      },
    ],
    slots: [],
    provider_kinds: {},
    capabilities: {},
  }
}

describe('useModelRegistryStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.restoreAllMocks()
  })

  it('加载后写入注册表并标记 loaded', async () => {
    vi.spyOn(api, 'getRegistry').mockResolvedValue(registry('deepseek-flash'))
    const store = useModelRegistryStore()

    await store.load()

    expect(store.registry?.models[0].model_id).toBe('deepseek-flash')
    expect(store.loaded).toBe(true)
    expect(store.error).toBe('')
  })

  it('并发 load 合并成一次请求', async () => {
    const get = vi.spyOn(api, 'getRegistry').mockResolvedValue(registry('m'))
    const store = useModelRegistryStore()

    await Promise.all([store.load(), store.load()])

    expect(get).toHaveBeenCalledTimes(1)
  })

  it('刷新失败保留旧数据：下拉不能因为一次抖一下就变空', async () => {
    const get = vi.spyOn(api, 'getRegistry').mockResolvedValue(registry('m1'))
    const store = useModelRegistryStore()
    await store.load()

    get.mockRejectedValue(new Error('后端不可达'))
    await store.load()

    expect(store.registry?.models[0].model_id).toBe('m1')
    expect(store.error).toBe('后端不可达')
  })

  it('prefetch 失败静默，已有缓存时不再请求', async () => {
    const get = vi.spyOn(api, 'getRegistry').mockRejectedValue(new Error('后端不可达'))
    const store = useModelRegistryStore()

    await store.prefetch()

    expect(store.error).toBe('')
    expect(store.loaded).toBe(false)

    get.mockResolvedValue(registry('m'))
    await store.load()
    await store.prefetch()

    expect(get).toHaveBeenCalledTimes(2)
  })
})
