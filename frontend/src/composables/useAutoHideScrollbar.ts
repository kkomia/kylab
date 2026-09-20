/**
 * 自动隐藏的滚动条（v0.26，用户报的"左下侧那个滚动条"）。
 *
 * 问题不是"有滚动条"，是**它一直在那儿**：侧栏用一小会儿就会长出滚动条，
 * 而那条灰色的竖线会一直贴在边上——它回答的是"你还能往下滚"，
 * 那件事只在鼠标进到这一栏时才需要被回答。
 *
 * 行为照 macOS 的悬浮滚动条：
 *
 * - 默认**不显示**（滑块透明，但**仍然占位**——见下）；
 * - 滚动时出现；
 * - 鼠标移到滚动条那一条窄带上也出现（否则"知道能滚"和"抓得住它"是两回事）；
 * - 停手一会儿（默认 1.2 秒）自动消失。
 *
 * **为什么不做成真的悬浮（不占位）**：那要自己画一个滑块 + 自己实现拖动、
 * 惯性、命中范围，而"看起来一样"的代价是把浏览器已经做对的事情重做一遍。
 * 这里只切换滑块的颜色，**条槽宽度一直不变**，所以内容不会在出现/消失时左右跳一下
 * ——那种跳动比一条静止的滚动条更烦人。
 *
 * **为什么不纯 CSS**：`:hover` 能让它出现，但做不到"显示一段时间之后自动消失"。
 * 而 `scrollbar-color` / `::-webkit-scrollbar-thumb` 这两个属性只在
 * Chromium 与 Firefox 上生效，这也是它与系统滚动条的取舍点。
 */
import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'

/** 停手之后多久消失。macOS 大约 1 秒；这里略长一点，让"刚滚完想再滚"不至于闪两下。 */
export const SCROLLBAR_LINGER_MS = 1200

/**
 * 滚动条那一条窄带有多宽。
 *
 * 只在**布局宽度量不出条槽**时用它兜底。实测这台机器上的 Chromium
 * （Windows 11）用的是**悬浮滚动条**：`offsetWidth === clientWidth`，
 * 条槽一点都不占位——此时"用布局算条槽"永远是 0，鼠标移过去根本不亮
 * （第一版就是这么写的，实测不生效）。两种情况都由这一条覆盖：
 *
 * - 经典滚动条：`rect.width - clientWidth` 就是真实条槽，取它与 12 的较大者；
 * - 悬浮滚动条：量出来接近 0，退回 CSS 里定的那 12px。
 */
export const SCROLLBAR_ZONE_PX = 12

/**
 * 让一个滚动容器按"用时出现、停手消失"显示滚动条。
 *
 * ``target`` 必须是**真正滚动的那一层**（`overflow-y: auto` 的那个），
 * 不是它的外壳：外壳的 `clientWidth` 与滚动条无关，命中判定会算错。
 */
export function useAutoHideScrollbar(target: Ref<HTMLElement | null>): void {
  /** 出现中。CSS 那边只有这一个 class（`.scroll-quiet` + 它）。 */
  const visible = ref(false)
  let timer: ReturnType<typeof setTimeout> | null = null

  function clear(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  /** 亮一下，并在 ``SCROLLBAR_LINGER_MS`` 之后自己灭掉。 */
  function flash(): void {
    visible.value = true
    clear()
    timer = setTimeout(() => {
      visible.value = false
      timer = null
    }, SCROLLBAR_LINGER_MS)
  }

  /**
   * 鼠标是不是落在**滚动条那一条窄带**上。
   *
   * 不滚动的内容不该因为鼠标划过右边缘就亮一下——那时根本没有滚动条可抓，
   * 所以先判"这一栏现在滚不滚得动"。
   */
  function onPointerMove(event: PointerEvent): void {
    const element = target.value
    if (!element) return
    if (element.scrollHeight <= element.clientHeight) return
    const rect = element.getBoundingClientRect()
    const gutter = Math.max(rect.width - element.clientWidth, SCROLLBAR_ZONE_PX)
    if (event.clientX >= rect.right - gutter) flash()
  }

  function bind(element: HTMLElement): void {
    // 滚动：`passive` —— 这个回调只改一个 class，不该拖慢滚动
    element.addEventListener('scroll', flash, { passive: true })
    element.addEventListener('pointermove', onPointerMove, { passive: true })
  }

  function unbind(element: HTMLElement): void {
    element.removeEventListener('scroll', flash)
    element.removeEventListener('pointermove', onPointerMove)
  }

  onMounted(() => {
    if (target.value) bind(target.value)
  })

  // 容器的 DOM 节点可能被换掉（条件渲染、路由切换）。**与 ref 同步绑定**，
  // 否则事件留在旧节点上，"滚动时出现"就再也不发生了。
  watch(target, (element, previous) => {
    if (previous) unbind(previous)
    if (element) bind(element)
  })

  onBeforeUnmount(() => {
    clear()
    if (target.value) unbind(target.value)
  })

  // class 由这里写到元素上（而不是让调用方到处 :class）：调用方只需要把 ref 给它
  watch(
    visible,
    (on) => {
      target.value?.classList.toggle('is-scroll-visible', on)
    },
    { flush: 'post' },
  )
}
