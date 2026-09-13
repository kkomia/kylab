/**
 * 「推荐问题」设置项（v19）。
 *
 * 它被建库弹窗与知识库设置**共用**，所以这里钉的是"四个值都是受控的"——
 * 一旦哪个 v-model 名写错（比如 modelPk 与 model-pk 对不上），
 * 表现是"改了没反应"，而那在两处调用方里都不容易一眼看出来。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/modelRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/modelRegistry')>()
  return {
    ...actual,
    getRegistry: vi.fn().mockResolvedValue({
      providers: [
        { id: 'p1', name: '深度求索', kind: 'deepseek', base_url: '', enabled: true, api_key: '' },
        { id: 'p2', name: '停用的家', kind: 'openai', base_url: '', enabled: false, api_key: '' },
      ],
      models: [
        {
          id: 'mdl_chat',
          provider_id: 'p1',
          provider_name: '深度求索',
          provider_kind: 'deepseek',
          model_id: 'deepseek-chat',
          label: 'deepseek-chat',
          dim: null,
          capabilities: ['chat'],
          options: {},
          created_at: null,
          updated_at: null,
          bound_slots: [],
        },
        {
          id: 'mdl_embed',
          provider_id: 'p1',
          provider_name: '深度求索',
          provider_kind: 'deepseek',
          model_id: 'bge-m3',
          label: 'bge-m3',
          dim: 1024,
          capabilities: ['embedding'],
          options: {},
          created_at: null,
          updated_at: null,
          bound_slots: [],
        },
        {
          id: 'mdl_disabled_provider',
          provider_id: 'p2',
          provider_name: '停用的家',
          provider_kind: 'openai',
          model_id: 'gpt-x',
          label: 'gpt-x',
          dim: null,
          capabilities: ['chat'],
          options: {},
          created_at: null,
          updated_at: null,
          bound_slots: [],
        },
      ],
      slots: [],
    }),
  }
})

import SuggestedQuestionsFields from '@/components/knowledge/SuggestedQuestionsFields.vue'
import AppSelect from '@/components/ui/AppSelect.vue'

function mountFields(
  props: { enabled?: boolean; count?: number; modelPk?: string; prompt?: string } = {},
) {
  return mount(SuggestedQuestionsFields, {
    props: {
      enabled: true,
      count: 6,
      modelPk: '',
      prompt: '',
      ...props,
    },
    global: { plugins: [createPinia()] },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('SuggestedQuestionsFields', () => {
  it('四个控件的初值都来自 v-model（受控）', async () => {
    const wrapper = mountFields({ enabled: false, count: 3, prompt: '按诊断标准出题' })
    await flushPromises()

    const checkbox = wrapper.find('.suggested-toggle input')
    expect((checkbox.element as HTMLInputElement).checked).toBe(false)
    expect(wrapper.find('.range-value').text()).toBe('3')
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('按诊断标准出题')
  })

  it('改开关 / 条数 / 提示词各自回传 update（名字对不上就会"改了没反应"）', async () => {
    const wrapper = mountFields()
    await flushPromises()

    await wrapper.find('.suggested-toggle input').setValue(false)
    await wrapper.find('.range-input').setValue('7')
    await wrapper.find('textarea').setValue('换个问法')

    const emitted = wrapper.emitted()
    expect(emitted['update:enabled']?.at(-1)).toEqual([false])
    expect(emitted['update:count']?.at(-1)).toEqual([7])
    expect(emitted['update:prompt']?.at(-1)).toEqual(['换个问法'])
  })

  it('模型下拉只列能对话的模型，且第一项是"跟随对话模型"', async () => {
    const wrapper = mountFields()
    await flushPromises()

    // 选项只在展开时才进 DOM，所以直接看传下去的 options
    const options = wrapper.findComponent(AppSelect).props('options') as {
      value: string
      label: string
    }[]
    expect(options.map((item) => item.value)).toEqual(['', 'mdl_chat'])
    expect(options[0].label).toBe('跟随对话模型')
    // 向量化模型与"供应商已停用"的模型都不该出现
    expect(options.map((item) => item.value)).not.toContain('mdl_embed')
    expect(options.map((item) => item.value)).not.toContain('mdl_disabled_provider')
  })

  it('关掉时给一句"会发生什么"，而不是让用户猜', async () => {
    const wrapper = mountFields({ enabled: false })
    await flushPromises()

    expect(wrapper.text()).toContain('改用内置的静态示例问题')
  })
})
