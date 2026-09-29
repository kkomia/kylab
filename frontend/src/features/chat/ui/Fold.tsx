/**
 * 过程面板里**每一处折叠**共用的那一个容器（§12.335：动效优先）。
 *
 * 三处折叠（面板、组、单步的原文与思考）原先各写各的条件渲染：`open ? <div/> : null`
 * ——于是"收起"是**直落**（内容与行高在同一个提交里变，没有东西可以过渡）。
 * 现在改成 `grid-template-rows: 0fr ↔ 1fr` 的容器：展开与收起**两个方向**都有过渡
 * （200ms、`cubic-bezier(0.4, 0, 0.2, 1)`，类名在 `traceStyles.TRACE_FOLD`，
 * `prefers-reduced-motion` 直落）。
 *
 * 代价是"内容得一直挂在那里"（不然收起的那一刻内容就没了，没有高度可以动），
 * 而这一块装着步骤、思考全文与出处预览，几十轮时 DOM 开销是真的。挡住它的办法是**这一层**：
 *
 * - **没有被展开过** → 子内容**根本不渲染**（`everOpened` 还是假）：历史里那些
 *   从没点开过的一轮，DOM 上只剩这个空容器（三个节点），与改造前同一档；
 * - **展开过一次之后** → 内容常驻：于是"展开 → 收起 → 再展开"每一次都有过渡
 *   （这正是"动效优先"要买的东西），代价只落在**用户真的看过**的那几块上。
 *
 * 收起态与"没有展开过"因此在 DOM 上是两件不同的事，用例也照这个读：
 * `data-fold="closed"` 说的是**收起**（内容可能还挂着），
 * 而"从没展开过"读的是**内容不在文档里**（那一条仍然钉着 DOM 开销，见 `chat-trace-fold`）。
 *
 * 这一层只认"开着还是收着"这一个布尔：档位怎么来的（面板级 `isTraceOpen`、
 * 组级 `forceExpand` 优先、单步的 `forceExpand` 默认）仍旧由调用方各自那**一处**判据决定。
 */
import { useEffect, useState, type HTMLAttributes, type ReactNode } from 'react'

import { TRACE_FOLD, TRACE_FOLD_BODY } from './traceStyles'

/**
 * 「这一块被展开过没有」——**只在展开方向上记一次，永不回退**（回退就等于把动效丢掉）。
 *
 * 写成 `open || everOpened` 而不是只读 state：首次渲染就摊开的那一块（流式中的面板、
 * 强制展开的那几行）**必须当场就有内容**，不能等一次 effect 之后再补上。
 */
function useEverOpened(open: boolean): boolean {
  const [everOpened, setEverOpened] = useState(open)
  useEffect(() => {
    if (open) setEverOpened(true)
  }, [open])
  return open || everOpened
}

export function Fold({
  open,
  className,
  children,
  ...rest
}: { open: boolean; className?: string; children: ReactNode } & HTMLAttributes<HTMLDivElement>) {
  const everOpened = useEverOpened(open)
  return (
    <div
      {...rest}
      // 用例与读屏器都读它：`closed` 时内容**可能还挂着**（那是动效的代价，不是漏了）
      data-fold={open ? 'open' : 'closed'}
      // 过渡写在类里、行高写在内联：内联样式优先级更高，`motion-reduce:transition-none`
      // 就压不住它（与 `ComposerControls` 那条进度圈同一条教训，见 `traceStyles.TRACE_FOLD`）
      className={className ? `${TRACE_FOLD} ${className}` : TRACE_FOLD}
      style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
    >
      <div className={TRACE_FOLD_BODY}>{everOpened ? children : null}</div>
    </div>
  )
}
