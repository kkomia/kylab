/**
 * 「当前打开的那张来源卡片」这一个小状态（D11-③）。
 *
 * **为什么是一个模块级的单例而不是每个徽章各带一张卡**：用户的要求是"只保留一处渲染"。
 * 一枚徽章一张卡，等于一篇文章里塞进几十个浮层组件；而同时**只可能**有一张卡开着。
 * 所以：徽章只负责"报坐标 + 报是哪一条"，卡片由宿主（`SourceCardHost`，每条回答一个）
 * 统一画在同一个位置。
 *
 * 这一层不认识 React（`subscribe` 是最朴素的订阅），所以"贴边翻转"这类判断可以单独单测。
 */

import type { WebCitation } from '@/features/chat/model/sourceCitations'

export interface ActiveCitation {
  citation: WebCitation
  /** 徽章那个元素（卡片贴着它放）。 */
  anchor: HTMLElement | null
}

let active: ActiveCitation | null = null
const listeners = new Set<() => void>()
let pending: ReturnType<typeof setTimeout> | null = null

/**
 * 关闭的**宽限**（用户 2026-09-29："hover 有概率鬼畜抖动"）。
 *
 * 为什么需要：胶囊与卡片是**两个元素**（卡片由 `SourceCardHost` 统一画在别处），
 * 指针从胶囊挪到卡片上时必然经过中间那 8px 空隙——没有宽限的话，
 * 离开胶囊的那一刻就 `hideCitation()` → 卡片被卸掉 → 指针落空 → 悬停状态反复开合 ✗。
 * 140ms 够人手挪过那 8px，又短到"移开就消失"仍然干脆。
 */
export const CLOSE_GRACE_MS = 140

function cancelPending(): void {
  if (pending === null) return
  clearTimeout(pending)
  pending = null
}

function notify(): void {
  for (const listener of listeners) listener()
}

/** 打开（或换成另一条）。**先撤掉待关闭**——胶囊与卡片谁后报到都不该被关掉。 */
export function showCitation(citation: WebCitation, anchor: HTMLElement | null): void {
  cancelPending()
  active = { citation, anchor }
  notify()
}

/**
 * 请求关闭：**延迟 `CLOSE_GRACE_MS`** 再真的关。
 *
 * 延迟期间任何一侧（胶囊 / 卡片）再 `showCitation` 都会把它撤掉 —— 这就是
 * "触发区与卡片共享一份开放状态 + 一小段宽限"那条修法。
 * 想立刻关（Esc、点走）用 `hideCitationNow`。
 */
export function hideCitation(): void {
  if (!active || pending !== null) return
  pending = setTimeout(() => {
    pending = null
    if (!active) return
    active = null
    notify()
  }, CLOSE_GRACE_MS)
}

/** 立刻关（Esc / 换会话）。 */
export function hideCitationNow(): void {
  cancelPending()
  if (!active) return
  active = null
  notify()
}

export function activeCitation(): ActiveCitation | null {
  return active
}

export function subscribeCitation(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 用例之间归零（模块级状态不该在用例之间带）。 */
export function resetCitation(): void {
  cancelPending()
  active = null
  listeners.clear()
}

/** 卡片尺寸（宽固定、高按内容；量出来之前先用这两个值算位置）。 */
export const CARD_WIDTH = 320
export const CARD_MARGIN = 8

export interface Placement {
  left: number
  top: number
  /** 卡片在徽章**上方**（贴底时翻转）。 */
  above: boolean
  /** 卡片右边与徽章右边对齐（贴右时翻转）。 */
  alignEnd: boolean
}

/**
 * 卡片摆哪儿（纯函数：给三个矩形，回一个位置）。
 *
 * 两条"贴边翻转"，都是用户点名的要求（**卡片不许被抽屉/滚动容器裁掉**）：
 *
 * 1. 徽章下方放不下（离视口底不足一卡高）→ 放**上方**；
 * 2. 徽章靠右（右边到视口右不足一卡宽）→ 卡片**右对齐**（往左伸），
 *    再不够就夹在视口内。
 *
 * 竖直方向取的是 `fixed` 坐标系（`clientX/Y` 那一套），因为面板与正文都在滚动容器里，
 * 用 `absolute` 会被裁。
 */
export function cardPlacement(
  anchor: { top: number; bottom: number; left: number; right: number },
  card: { width: number; height: number },
  viewport: { width: number; height: number },
): Placement {
  const below = anchor.bottom + CARD_MARGIN
  const fitsBelow = below + card.height + CARD_MARGIN <= viewport.height
  const above = !fitsBelow
  const top = above ? Math.max(CARD_MARGIN, anchor.top - card.height - CARD_MARGIN) : below

  const alignEnd = anchor.left + card.width + CARD_MARGIN > viewport.width
  const left = alignEnd ? anchor.right - card.width : anchor.left
  return {
    left: Math.min(
      Math.max(CARD_MARGIN, left),
      Math.max(CARD_MARGIN, viewport.width - card.width - CARD_MARGIN),
    ),
    top,
    above,
    alignEnd,
  }
}
