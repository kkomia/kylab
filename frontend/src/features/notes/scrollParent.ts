/**
 * 正文的滚动容器：往上找第一个"样式允许滚且确实滚得动"的祖先，找不到就退回页面。
 *
 * 不写死类名是刻意的：并排两列时滚的是笔记页的正文列（`.notes-pane`）；
 * 单栏堆叠（<=900px）时那一列把滚动交回了外层 `main.content`。
 * 笔记页那次"两列各自滚"的改造正是靠这一条没被牵动。
 *
 * 两处调用**必须同一口径**，所以单独放一个模块：
 * 1. `NoteEditor` 记每条笔记的滚动位置（换文档之后要接着看）；
 * 2. `NoteCanvas` 的大纲扩展要拿它当 `scrollParent`（高亮跟随靠它算），
 *    以及点目录跳转时的落点。
 * 两边一旦各写一份，`offsetTop` 的坐标系就会分家（见 `notes.css` 里
 * `.notes-pane { position: relative }` 那条注释）。
 */
export function scrollParentOf(el: HTMLElement | null): HTMLElement | null {
  let node: HTMLElement | null = el
  while (node) {
    const overflowY = getComputedStyle(node).overflowY
    const scrollable = overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay'
    if (scrollable && node.scrollHeight > node.clientHeight + 1) return node
    node = node.parentElement
  }
  return (document.scrollingElement as HTMLElement | null) ?? null
}
