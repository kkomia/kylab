/**
 * 面板在**这个宽度**下是挤在右边还是盖在聊天列上。
 *
 * ## 判据为什么是 1100
 *
 * 常驻（挤）的时候面板吃掉一列：侧栏 240 + 面板 380 = **620px**。
 * 窗口 1100 时聊天列还剩 480——比消息列那条 768 窄，但输入卡片仍是一整行；
 * 再窄下去就开始整格折行、发送键跑到视口外（与侧栏 D29 那条同一个病：
 * 420px 时每行 4.53 个字）。所以它比侧栏的 760 高一档：面板比侧栏宽，
 * 且它旁边那一列是要读正文的。
 *
 * 低于这条线时改成**覆盖式**（`panel.css` 的 `data-overlay`）：面板不再从聊天列里
 * 扣宽度，看完点一下收起来就回到原来的样子。这不是"响应式美不美"的问题，
 * 是"768 的窗口里 148px 的聊天列没法用"。
 *
 * ## 写法照 `layout/useSidebar.ts`
 *
 * 同一个形状（常量 + 非组件也能问的函数 + 订阅变化的 hook），两件事都是刻意的：
 * - 初始值 `useState(matchesPanelOverlayViewport)` **同步读一次**，而不是先 `false`
 *   再在 effect 里改——后者会让窄屏上的第一帧先按"挤"渲染，然后整页跳一下；
 * - 挂载时再对一次：`useState` 那次读与这里之间窗口可能已经变了。
 *
 * 为什么不让 CSS 的媒体查询自己干（那本可以一行写完 `data-overlay`）：这一位不只决定
 * 样式，还要决定**行为**——覆盖式下面板是浮在正文之上的，`Esc` 该把它收起来
 * （常驻式下面板是页面的一部分，按 Esc 收掉它会莫名其妙）。那一条在 JS 里
 * （见 `SidePanel` 里那个监听），与这里必须是同一个判据：一处媒体查询、一处 JS
 * 各判一次，早晚会漂。
 */
import { useEffect, useState } from 'react'

/** 窄到"面板不该再挤那一列"的阈值（理由见文件头注）。 */
export const PANEL_OVERLAY_QUERY = '(max-width: 1100px)'

/** 现在是不是覆盖式（**非组件代码**也能问）。 */
export function matchesPanelOverlayViewport(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(PANEL_OVERLAY_QUERY).matches
}

export function usePanelOverlay(): boolean {
  const [overlay, setOverlay] = useState(matchesPanelOverlayViewport)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const media = window.matchMedia(PANEL_OVERLAY_QUERY)
    const onChange = (): void => setOverlay(media.matches)
    onChange()
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])
  return overlay
}
