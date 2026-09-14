/**
 * 知识库页「新建知识库」入口只有一个（用户实测反馈）。
 *
 * 页头（`PageShell#actions`）与空状态（`EmptyState`）原先各有一个新建按钮。
 * 没有可用嵌入模型时，"不许建库"这条规则只加在页头那个上，空状态里那个照样可点
 * ——点开弹窗才被拦。两个入口对同一件事给出不同答案，用户只会认为"按钮坏了"。
 *
 * 结论是**留一个**：空状态不再自带按钮，页面只保留右上角页头那一个，
 * 提示语改为指路。这条用例钉住"仅一个入口"以及它的禁用判定。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getRegistry = vi.fn()

vi.mock('@/api/modelRegistry', () => ({
  getRegistry: (...args: unknown[]) => getRegistry(...args),
}))

vi.mock('@/stores/knowledgeBases', () => ({
  useKnowledgeBaseStore: () => ({
    items: [],
    summaries: {},
    loading: false,
    error: '',
    load: vi.fn(),
    create: vi.fn(),
  }),
}))

import type { RegisteredModel, Registry, Slot } from '@/api/modelRegistry'
import KnowledgeBasesView from '@/views/KnowledgeBasesView.vue'

function registryWith(models: RegisteredModel[], slots: Slot[]): Registry {
  return {
    providers: [],
    models,
    slots,
    provider_kinds: {},
    capabilities: {},
    provider_presets: [],
  }
}

function embeddingModel(id = 'm1'): RegisteredModel {
  return {
    id,
    provider_id: 'p1',
    provider_name: '测试源',
    provider_kind: 'openai',
    model_id: 'text-embedding-3-small',
    label: '小模型',
    dim: 1536,
    capabilities: ['embedding'],
    options: {},
    created_at: null,
    updated_at: null,
    bound_slots: [],
  }
}

function embeddingSlot(boundModelPk: string | null): Slot {
  return {
    slot: 'embedding',
    label: '默认嵌入模型',
    capability: 'embedding',
    bound_model_pk: boundModelPk,
    bound_model_label: '',
    provider_name: '',
    configured: boundModelPk !== null,
    source: boundModelPk ? 'registry' : 'none',
  }
}

/** 页面上全部「新建知识库」按钮。空状态不再自带一个，这里应当只有一个。 */
function createButtons(wrapper: Awaited<ReturnType<typeof mount>>) {
  return wrapper.findAll('button').filter((b) => b.text().includes('新建知识库'))
}

async function mountView(): Promise<Awaited<ReturnType<typeof mount>>> {
  // 这条用例只关心按钮的禁用状态；列表分支才用 RouterLink，桩掉即可，
  // 免得 Vue 打一条"Failed to resolve component"的噪音警告
  const wrapper = mount(KnowledgeBasesView, { global: { stubs: { RouterLink: true } } })
  await flushPromises()
  return wrapper
}

describe('KnowledgeBasesView 的新建入口', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    getRegistry.mockReset()
  })

  it('空状态下只有一个新建入口（空状态不再自带按钮）', async () => {
    getRegistry.mockResolvedValue(registryWith([], [embeddingSlot(null)]))
    const wrapper = await mountView()

    expect(createButtons(wrapper)).toHaveLength(1)
  })

  it('没有可用嵌入模型时，唯一的新建按钮禁用', async () => {
    getRegistry.mockResolvedValue(registryWith([], [embeddingSlot(null)]))
    const wrapper = await mountView()

    const [button] = createButtons(wrapper)
    expect(button.attributes('disabled')).toBeDefined()
  })

  it('有绑定好的嵌入模型时，唯一的新建按钮可用', async () => {
    getRegistry.mockResolvedValue(registryWith([embeddingModel()], [embeddingSlot('m1')]))
    const wrapper = await mountView()

    const [button] = createButtons(wrapper)
    expect(button.attributes('disabled')).toBeUndefined()
  })
})
