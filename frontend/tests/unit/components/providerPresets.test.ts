import { describe, expect, it } from 'vitest'

import type { ProviderPreset } from '@/api/modelRegistry'
import {
  mergeModelOptions,
  normalizeUrl,
  presetForProvider,
  presetModelMeta,
  suggestedModels,
} from '@/components/settings/providerPresets'

function preset(overrides: Partial<ProviderPreset> = {}): ProviderPreset {
  return {
    id: 'deepseek',
    label: '深度求索 DeepSeek',
    kind: 'llm',
    base_url: 'https://api.deepseek.com',
    hint: '',
    models: [
      { model_id: 'deepseek-flash', label: 'Flash', capabilities: ['chat'], dim: null },
      { model_id: 'BAAI/bge-m3', label: 'BGE-M3', capabilities: ['embedding'], dim: 1024 },
    ],
    ...overrides,
  }
}

describe('normalizeUrl', () => {
  it('尾部斜杠与首尾空白不算不同', () => {
    expect(normalizeUrl(' https://x.example.com/v1/ ')).toBe('https://x.example.com/v1')
    expect(normalizeUrl('https://x.example.com/v1')).toBe('https://x.example.com/v1')
  })
})

describe('presetForProvider', () => {
  it('按地址匹配，尾部斜杠不同也认得出', () => {
    const provider = { base_url: 'https://api.deepseek.com/' }
    expect(presetForProvider([preset()], provider)?.id).toBe('deepseek')
  })

  it('空地址不匹配任何预设（自定义供应商不该被塞建议）', () => {
    expect(presetForProvider([preset()], { base_url: '' })).toBeNull()
  })

  it('地址改过就匹配不上：宁可不给建议，也不拿错的列表误导', () => {
    expect(
      presetForProvider([preset()], { base_url: 'https://my-gateway.example.com/v1' }),
    ).toBeNull()
  })
})

describe('suggestedModels', () => {
  it('返回该供应商预设里的模型；匹配不上就是空', () => {
    expect(suggestedModels([preset()], { base_url: 'https://api.deepseek.com' })).toHaveLength(2)
    expect(suggestedModels([preset()], { base_url: 'https://other/v1' })).toEqual([])
  })
})

describe('mergeModelOptions', () => {
  const probe = [{ value: 'deepseek-flash', label: 'deepseek-flash' }]

  it('探测到的在前，预设里没被探测到的补在后并标记', () => {
    const merged = mergeModelOptions(probe, [preset()], { base_url: 'https://api.deepseek.com' })

    expect(merged.map((item) => item.value)).toEqual(['deepseek-flash', 'BAAI/bge-m3'])
    expect(merged[0].label).toBe('deepseek-flash')
    expect(merged[1].label).toContain('预设')
  })

  it('探测与预设重复的只留一份', () => {
    const merged = mergeModelOptions(
      [...probe, { value: 'BAAI/bge-m3', label: 'bge' }],
      [preset()],
      { base_url: 'https://api.deepseek.com' },
    )

    expect(merged).toHaveLength(2)
  })

  it('匹配不上预设时原样返回探测结果', () => {
    expect(mergeModelOptions(probe, [preset()], { base_url: 'https://other/v1' })).toEqual(probe)
  })
})

describe('presetModelMeta', () => {
  it('预设里的模型带出能力与维度', () => {
    const meta = presetModelMeta(
      [preset()],
      { base_url: 'https://api.deepseek.com' },
      'BAAI/bge-m3',
    )
    expect(meta?.capabilities).toEqual(['embedding'])
    expect(meta?.dim).toBe(1024)
  })

  it('手写/探测到的模型没有元数据（不替用户猜能力）', () => {
    expect(
      presetModelMeta([preset()], { base_url: 'https://api.deepseek.com' }, 'some-custom-model'),
    ).toBeNull()
  })
})
