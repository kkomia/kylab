/**
 * 供应商品牌图标表。
 *
 * 重点是**两侧的 id 不能漂**：后端 `services/provider_presets.py` 下发预设 id，
 * 前端按 id 取图标。少映射一个不会报错，只会让那家供应商显示成通用图标——
 * 属于"看起来正常但悄悄退化了"，所以用测试钉住这份清单。
 */
import { describe, expect, it } from 'vitest'

import { BRAND_ICONS, providerIcon } from '@/components/icons/brands'

/** 与后端预设 id 一一对应（新增预设时这里也要加）。 */
const PRESET_IDS = [
  'deepseek',
  'dashscope',
  'moonshot',
  'zhipu',
  'siliconflow',
  'openai',
  'anthropic',
  'gemini',
  'xai',
  'ollama',
]

describe('providerIcon', () => {
  it('每个预设 id 都有品牌图标', () => {
    for (const id of PRESET_IDS) {
      expect(BRAND_ICONS[id], `预设 ${id} 没有对应图标`).toBeTruthy()
    }
  })

  it('已知 id 返回品牌图标本身', () => {
    expect(providerIcon('deepseek')).toBe(BRAND_ICONS.deepseek)
  })

  it('未知 id（含"自定义"）退回通用图标，而不是空', () => {
    expect(providerIcon('')).toBeTruthy()
    expect(providerIcon('某个没见过的供应商')).toBeTruthy()
  })
})
