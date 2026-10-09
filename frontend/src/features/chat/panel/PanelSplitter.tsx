/**
 * 对话列与面板之间那条缝：**它就是拖拽把手**（2026-10-09，用户："缝隙线做成拖拽把手，
 * 拖动即调面板宽度"）。
 *
 * ## 只有"贴着放"（常驻列）时才有它
 *
 * 窄屏下面板是盖在对话列上的浮层（`usePanelLayout` 的 `data-overlay`）：那时两列不是
 * 并排的，没有"它们之间那条缝"可拖，所以这一位自己返回 `null`（判断写在组件里，
 * 调用点就只剩"对话列 | 把手 | 面板"这三个孩子的次序）。
 *
 * ## 线还是那条线，命中区靠 `::after` 撑开
 *
 * 面板原来靠自己的 `border-left: 1px` 画这条边界。现在这条线由把手画（`1px` 宽，
 * 落点与原来分毫不差），而**可点的范围**由它那个 `::after`（左右各探出去 4px）撑着
 * ——把手的宽度不进布局，是因为它一进布局，对话列就会平白窄掉几个像素，
 * 而这一条线的位置本来就是"两列的分界"，不该被"好不好点"改掉。
 *
 * ## 指针事件为主、鼠标事件为辅（两条一起接）
 *
 * - **指针事件**是主路径：`setPointerCapture` 让指针一旦出了把手（拖到 iframe 上、
 *   拖到侧栏上）也照样收得到 `pointermove`。这一条不是可有可无的：面板的「网页」标签
 *   里就是一整块 iframe，而它离这条缝只有 8px——不捕获的话，往右拖一点点，事件就交给
 *   那一页了，拖动当场断在原地（松开那一下还会落在别人手里，"拖着一半的把手"就此卡住）。
 * - **鼠标事件**是辅路径：`window` 上那份 `mousemove` / `mouseup`（`mousedown` 挂在
 *   把手自己身上）。本仓另外两处拖拽（Tiptap 的图片缩放手柄、笔记树的拖拽）就是这一套，
 *   而且 **jsdom 里没有 `PointerEvent`**——用例能拿 `MouseEvent` 发的那一路来验这件事。
 *
 * 两条同时生效不会打架：它们写的是同一份 `from`（第一次按下记的起点）与同一个宽度，
 * 同一次移动算出来的数一样，而 `panelStore.setWidth` 对**相同的值**直接返回
 * （不落盘、不触发渲染）。
 *
 * ## 监听器必须**在按下那一下同步挂上**
 *
 * 不能挂在"`dragging` 变 true 之后跑的 effect"里：一次"按下 → 移动 → 松开"完全可能
 * 落在同一个任务里（合成事件、自动化脚本都是这样），等 effect 就意味着那一下移动与松开
 * 谁也收不到。所以 `begin()` 里同步 `addEventListener`，`stop()` 里同步摘掉；
 * `body` 上的"不许选字"同理，同步设、同步还原。
 *
 * ## 拖的时候不许抖
 *
 * 宽度**只改一处**（`panelStore.width` → 面板自己的 CSS 变量），拖的过程里不重建任何
 * 东西（`SidePanel` 只是换个内联变量的值），所以不会闪。
 *
 * ## 键盘那两下
 *
 * `role="separator"` + `←`/`→`：只靠拖的把手上，键盘用户完全够不着（而这个仓库里
 * 每一处可点控件都给了键盘路径）。方向键一下 16px，`Home`/`End` 直接给到上下限。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import { PANEL_WIDTH_MAX, PANEL_WIDTH_MIN, clampWidth, usePanelStore } from './panelStore'
import { usePanelOverlay } from './usePanelLayout'

/** 方向键一下调多少（比拖慢得多，是"点一点微调"的档）。 */
const STEP = 16

export function PanelSplitter() {
  const width = usePanelStore((state) => state.width)
  const setWidth = usePanelStore((state) => state.setWidth)
  const open = usePanelStore((state) => state.open)
  const overlay = usePanelOverlay()
  const [dragging, setDragging] = useState(false)
  /**
   * 按下那一刻的两个数：起点与当时的宽度（拖动全程按它们算，不累加误差）。
   *
   * `active` 是"这次拖动还在进行"的那一位，它必须是 ref 而不是 `dragging` 这个 state：
   * 挂在 window 上的监听器拿的是**建监听器那一刻**的闭包，读 state 只会读到 `false`
   * （React 里拖拽最常见的那个 bug）。
   */
  const from = useRef({ x: 0, width: 0 })
  const active = useRef(false)
  /** 摘掉 window 上那两个监听器（`begin` 里建、`stop` 里用）。 */
  const detach = useRef<(() => void) | null>(null)
  /** 拖动前 `body` 上那两条内联样式（拖完照原样写回去，别把别人的值冲掉）。 */
  const bodyStyle = useRef<{ userSelect: string; cursor: string } | null>(null)

  const widthAt = useCallback(
    (clientX: number): number => clampWidth(from.current.width + (from.current.x - clientX)),
    [],
  )

  /** 收尾：摘监听、还原 `body`、把"正在拖"熄掉（可以重复调用）。 */
  const stop = useCallback((): void => {
    detach.current?.()
    detach.current = null
    const previous = bodyStyle.current
    if (previous) {
      document.body.style.userSelect = previous.userSelect
      document.body.style.cursor = previous.cursor
      bodyStyle.current = null
    }
    active.current = false
    setDragging(false)
  }, [])

  // 拖到一半这一列被卸载（关面板、切会话）也要把监听与 body 样式收掉
  useEffect(() => stop, [stop])

  const moveTo = useCallback(
    (clientX: number): void => {
      if (!active.current) return
      setWidth(widthAt(clientX))
    },
    [setWidth, widthAt],
  )

  const begin = useCallback(
    (clientX: number): void => {
      if (active.current) return
      from.current = { x: clientX, width }
      active.current = true
      setDragging(true)
      bodyStyle.current = {
        userSelect: document.body.style.userSelect,
        cursor: document.body.style.cursor,
      }
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'col-resize'

      const onMove = (event: MouseEvent): void => moveTo(event.clientX)
      const onUp = (event: MouseEvent): void => {
        if (active.current) setWidth(widthAt(event.clientX))
        stop()
      }
      // 捕获阶段：这一下先于页面上任何"吃掉鼠标事件"的东西（见文件头注）
      window.addEventListener('mousemove', onMove, true)
      window.addEventListener('mouseup', onUp, true)
      detach.current = () => {
        window.removeEventListener('mousemove', onMove, true)
        window.removeEventListener('mouseup', onUp, true)
      }
    },
    [moveTo, setWidth, stop, width, widthAt],
  )

  /** 只有"贴着放"（常驻列）时才有这条缝（见文件头注）。 */
  if (!open || overlay) return null

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    // 面板在右：按 ← 是把这条线往左拖 = 面板变宽
    if (event.key === 'Home') {
      event.preventDefault()
      setWidth(PANEL_WIDTH_MIN)
      return
    }
    if (event.key === 'End') {
      event.preventDefault()
      setWidth(PANEL_WIDTH_MAX)
      return
    }
    const delta = event.key === 'ArrowLeft' ? STEP : event.key === 'ArrowRight' ? -STEP : undefined
    if (delta === undefined) return
    event.preventDefault()
    setWidth(width + delta)
  }

  return (
    <div
      className="ch-panel-splitter"
      data-dragging={dragging}
      role="separator"
      aria-orientation="vertical"
      aria-label="调整面板宽度"
      aria-valuenow={width}
      aria-valuemin={PANEL_WIDTH_MIN}
      aria-valuemax={PANEL_WIDTH_MAX}
      tabIndex={0}
      // 拖拽期间不许触发文本选择与原生拖放
      onMouseDown={(event) => {
        event.preventDefault()
        begin(event.clientX)
      }}
      onPointerDown={(event) => {
        event.preventDefault()
        begin(event.clientX)
        // 指针捕获：拖到 iframe 上、拖到侧栏上照样收得到 pointermove（见文件头注）
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => moveTo(event.clientX)}
      onPointerUp={(event) => {
        if (active.current) setWidth(widthAt(event.clientX))
        stop()
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
      }}
      onPointerCancel={stop}
      onKeyDown={onKeyDown}
    />
  )
}

export default PanelSplitter
