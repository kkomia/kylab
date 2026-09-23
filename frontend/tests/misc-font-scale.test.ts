/**
 * 字号档位（`features/misc/settings/useFontScale.ts`）——**从旧 Vue 版
 * `tests/unit/composables/useFontScale.test.ts` 的 9 条搬来的**。
 *
 * 新前端有一条"外观一节能切主题与字号"的用例覆盖了 happy path，但**规则本身**没人守：
 * 存的档位非法要退回中档、每档正文严格递增（字阶不许乱）、**最小档的辅助字号仍不低于 12px**
 * （字号可调，但不该能调到读不出）、档位表与 `factorOf` 的换算要对得上。
 * 这些是《前端设计规范》§4 的口径，静默改了没人会发现。
 */
import { beforeEach, describe, expect, it } from 'vitest'

import {
  FONT_SCALES,
  FONT_SCALE_STORAGE_KEY,
  applyFontScale,
  factorOf,
  initFontScale,
  setFontScale,
} from '@/features/misc/settings/useFontScale'

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
    // React 版的 hook 是 useSyncExternalStore，组件外读不了；
    // 用模块自己的"已经生效的值"当判据（与上面那条主诉一致）
    expect(initFontScale()).toBe('large')
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
