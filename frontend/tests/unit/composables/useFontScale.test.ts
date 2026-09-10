import { beforeEach, describe, expect, it } from 'vitest'

import {
  FONT_SCALES,
  FONT_SCALE_STORAGE_KEY,
  applyFontScale,
  factorOf,
  initFontScale,
  setFontScale,
  useFontScale,
} from '@/composables/useFontScale'

/** 读根节点上实际生效的系数——这是"真的改了字号"的唯一判据。 */
function appliedFactor(): number {
  return Number.parseFloat(document.documentElement.style.getPropertyValue('--font-scale'))
}

describe('useFontScale', () => {
  beforeEach(() => {
    window.localStorage.clear()
    document.documentElement.style.removeProperty('--font-scale')
  })

  it('无保存值时用中档', () => {
    expect(initFontScale()).toBe('medium')
    expect(appliedFactor()).toBe(1)
  })

  it('优先使用已保存的档位', () => {
    window.localStorage.setItem(FONT_SCALE_STORAGE_KEY, 'xlarge')

    expect(initFontScale()).toBe('xlarge')
    expect(appliedFactor()).toBeCloseTo(1.2, 5)
  })

  it('保存的档位非法时退回中档', () => {
    window.localStorage.setItem(FONT_SCALE_STORAGE_KEY, '巨大无比')

    expect(initFontScale()).toBe('medium')
  })

  it('setFontScale 写根节点并落盘', () => {
    setFontScale('large')

    expect(appliedFactor()).toBeCloseTo(1.1, 5)
    expect(window.localStorage.getItem(FONT_SCALE_STORAGE_KEY)).toBe('large')
    expect(useFontScale().scale.value).toBe('large')
  })

  it('以"已经生效的值"为准，而不是再读一次存储', () => {
    // 模拟首屏脚本先按 xlarge 设好了根节点，而存储此刻读到的是别的值。
    // 若这里再去读存储，就会出现"渲染成一个档位、选择器高亮另一个档位"。
    document.documentElement.style.setProperty('--font-scale', String(factorOf('xlarge')))
    window.localStorage.setItem(FONT_SCALE_STORAGE_KEY, 'small')

    expect(initFontScale()).toBe('xlarge')
  })

  it('最小档的辅助字号仍不低于 12px', () => {
    // 字阶在 base.css 里是 calc(13px * var(--font-scale))，这是同一口径的下限校验。
    // 中文低于 12px 在常规显示器上已经影响辨认，字号可调不该能调到不可读。
    const microBase = 13
    const smallest = Math.min(...FONT_SCALES.map((item) => factorOf(item.name)))

    expect(microBase * smallest).toBeGreaterThanOrEqual(12)
  })

  it('每一档的正文都严格大于上一档', () => {
    const sizes = FONT_SCALES.map((item) => item.bodySize)
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b))
    expect(new Set(sizes).size).toBe(sizes.length)
  })

  it('档位表里每一项都能被 factorOf 正确换算', () => {
    for (const item of FONT_SCALES) {
      expect(factorOf(item.name)).toBeCloseTo(item.bodySize / 15, 5)
    }
  })

  it('applyFontScale 不改存储（纯应用）', () => {
    applyFontScale('large')
    expect(window.localStorage.getItem(FONT_SCALE_STORAGE_KEY)).toBeNull()
  })
})
