/**
 * 模型注册表的加载语义（`features/knowledge/store.ts`）——**从旧 Vue 版
 * `tests/unit/stores/modelRegistry.test.ts` 的 4 条搬来的**（Pinia → zustand + 模块级状态）。
 *
 * 这四条钉的是**手写的加载逻辑**（不是 react-query 那套自动行为），每条都对应一个
 * 用户看得见的后果：
 * 1. 加载成功要写进状态并标记 loaded（界面据此不再显示骨架屏）；
 * 2. **并发 load 合并成一次请求**（进页面时好几处同时要注册表）；
 * 3. **刷新失败保留旧数据**——"下拉不能因为一次抖一下就变空"；
 * 4. prefetch 失败静默（它是顺手多做的准备，不该在用户还没进页面时弹错误），
 *    且已有缓存时不再回源。
 *
 * 状态在模块级，所以每个用例都用 `vi.resetModules()` 拿一份新的模块图
 * （mock 也会跟着重建，所以 `getRegistry` 的引用要从新图里取）。
 */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/modelRegistry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/modelRegistry')>()),
  getRegistry: vi.fn(),
}))

function registry(modelId: string) {
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
    provider_presets: [],
  }
}

/** 每个用例一份新的模块图（状态在模块级），并把新图里的 getRegistry 一起取出来。 */
async function setup() {
  vi.resetModules()
  const store = await import('@/features/knowledge/store')
  const api = await import('@/api/modelRegistry')
  const { result } = renderHook(() => store.useModelRegistry())
  return { get: vi.mocked(api.getRegistry), result }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('模型注册表的加载语义', () => {
  it('加载后写入注册表并标记 loaded', async () => {
    const { get, result } = await setup()
    get.mockResolvedValue(registry('deepseek-flash') as never)

    await act(async () => {
      await result.current.load()
    })

    expect(result.current.registry?.models[0].model_id).toBe('deepseek-flash')
    expect(result.current.modelOptionsLoaded).toBe(true)
    expect(result.current.error).toBe('')
  })

  it('并发 load 合并成一次请求', async () => {
    const { get, result } = await setup()
    get.mockResolvedValue(registry('m') as never)

    await act(async () => {
      await Promise.all([result.current.load(), result.current.load()])
    })

    expect(get).toHaveBeenCalledTimes(1)
  })

  it('刷新失败保留旧数据：下拉不能因为一次抖一下就变空', async () => {
    const { get, result } = await setup()
    get.mockResolvedValue(registry('m1') as never)
    await act(async () => {
      await result.current.load()
    })

    get.mockRejectedValue(new Error('后端不可达'))
    await act(async () => {
      await result.current.load()
    })

    expect(result.current.registry?.models[0].model_id).toBe('m1')
    expect(result.current.error).toBe('后端不可达')
  })

  it('prefetch 失败静默，已有缓存时不再请求', async () => {
    const { get, result } = await setup()
    get.mockRejectedValue(new Error('后端不可达'))

    await act(async () => {
      await result.current.prefetch()
    })

    expect(result.current.error).toBe('')
    expect(result.current.modelOptionsLoaded).toBe(false)

    get.mockResolvedValue(registry('m') as never)
    await act(async () => {
      await result.current.load()
      await result.current.prefetch()
    })

    expect(get).toHaveBeenCalledTimes(2)
  })
})
