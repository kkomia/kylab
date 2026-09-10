/**
 * 字号档位（《前端设计规范》§4 字阶 / 开发计划 §11.1）。
 *
 * 存在的理由来自一条实际反馈：「web 字体偏小」。查下来**不是基线值低**
 * （正文本就是 14px，与同类产品一致），而是**分布**——`--text-meta-size` 用了 43 处、
 * `--text-micro-size` 35 处，而 `--text-body-size` 只有 4 处。小字号占满了界面外壳，
 * 正文反倒只是众多字号里的一个。所以这一轮做两件事：先把基线抬一档，再给用户一个可调档位。
 *
 * 与主题一样落在 `document.documentElement` 的 CSS 变量上（`--font-scale`），
 * **不进后端 app_settings**：这是观看偏好，不是知识库配置；换台机器该重新选。
 *
 * 为什么只调正文、不整体缩放：整体缩放会让页面标题在最大档涨到 40px 以上，
 * 宽屏下反而更难扫。正文是"读得累不累"的关键，标题本来就够大。
 */

import { readonly, ref } from 'vue'

export type FontScaleName = 'small' | 'medium' | 'large' | 'xlarge'

export interface FontScaleOption {
  name: FontScaleName
  label: string
  /** 中文字号阶梯**不用百分比表达**：写"15px / 22px"比"+7%"更能让人判断合不合适。 */
  bodySize: number
  hint: string
}

export const FONT_SCALE_STORAGE_KEY = 'kylab-font-scale'

export const FONT_SCALES: readonly FontScaleOption[] = [
  { name: 'small', label: '小', bodySize: 14, hint: '信息密度优先，一屏看得更多' },
  { name: 'medium', label: '中', bodySize: 15, hint: '默认。长时间阅读不累' },
  { name: 'large', label: '大', bodySize: 16.5, hint: '屏幕较远或视力一般时用' },
  { name: 'xlarge', label: '更大', bodySize: 18, hint: '投屏演示或需要更大字时用' },
] as const

/** 中档的正文大小。缩放系数以它为基准，改这里要同步 base.css 的默认值。 */
const BASE_BODY_SIZE = 15

const DEFAULT_SCALE: FontScaleName = 'medium'

function optionOf(name: FontScaleName): FontScaleOption {
  return FONT_SCALES.find((item) => item.name === name) ?? FONT_SCALES[1]
}

/** 档位 → 缩放系数。CSS 侧的 `--font-delta` 由它推出。 */
export function factorOf(name: FontScaleName): number {
  return optionOf(name).bodySize / BASE_BODY_SIZE
}

function readStored(): FontScaleName | null {
  try {
    const saved = window.localStorage.getItem(FONT_SCALE_STORAGE_KEY)
    return FONT_SCALES.some((item) => item.name === saved) ? (saved as FontScaleName) : null
  } catch {
    return null
  }
}

/**
 * 读取**当前生效**的档位。
 *
 * index.html 的首屏脚本已经按 localStorage 设好了 `--font-scale`；这里从那个实算值
 * 反推档位，而不是自己再读一遍 localStorage。
 *
 * 为什么要反推：两处各读一次，一旦有一处读到的不是同一个值（存储被别的标签页改过、
 * 或首屏脚本先跑而存储不可写），就会**渲染成一个档位、选择器高亮另一个档位**。
 * 实测踩到过：页面按 1.2 渲染，而四个档位一个都没高亮。以"已经生效的值"为唯一
 * 事实来源，这种分叉就不可能发生。
 */
function readApplied(): FontScaleName | null {
  if (typeof document === 'undefined') return null
  const applied = document.documentElement.style.getPropertyValue('--font-scale')
  const factor = Number.parseFloat(applied)
  if (!Number.isFinite(factor) || factor <= 0) return null

  const matched = FONT_SCALES.find((item) => Math.abs(factorOf(item.name) - factor) < 0.001)
  return matched?.name ?? null
}

const scale = ref<FontScaleName>(DEFAULT_SCALE)

/** 把档位写成根节点上的 `--font-scale`；字阶各档在 base.css 里乘这个系数。 */
export function applyFontScale(next: FontScaleName): void {
  scale.value = next
  if (typeof document !== 'undefined') {
    document.documentElement.style.setProperty('--font-scale', String(factorOf(next)))
  }
}

export function initFontScale(): FontScaleName {
  // 顺序要紧：先信首屏脚本已经写好的值，它没有才退回 localStorage
  const initial = readApplied() ?? readStored() ?? DEFAULT_SCALE
  applyFontScale(initial)
  return initial
}

export function setFontScale(next: FontScaleName): FontScaleName {
  applyFontScale(next)
  try {
    window.localStorage.setItem(FONT_SCALE_STORAGE_KEY, next)
  } catch {
    // 隐私模式下不可写：不记忆即可，不影响本次会话
  }
  return next
}

export function useFontScale() {
  return {
    scale: readonly(scale),
    options: FONT_SCALES,
    setFontScale,
  }
}
