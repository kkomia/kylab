/**
 * 测试环境的最小补丁。
 *
 * **jsdom 不实现 `ResizeObserver`**，而组件确实需要它做尺寸自适应
 * （图表的绘图区宽度、记忆图谱的节点间距）。缺了它，这类组件一挂载就抛
 * "ResizeObserver is not defined"，用例只能退化成"不挂载"——而尺寸自适应
 * 恰恰是它们要覆盖的东西。
 *
 * 这里给一个能用的最小实现：记录回调与观察目标，由用例用 `resizeTo()`
 * 手动喂一个尺寸。**不用自动触发**：jsdom 没有布局引擎，自己编一个宽度
 * 只会让断言依赖"编出来的那个数"，不如让用例显式说要多宽。
 */

interface Registration {
  callback: ResizeObserverCallback
  targets: Element[]
}

const registrations: Registration[] = []

class StubResizeObserver implements ResizeObserver {
  private readonly entry: Registration

  constructor(callback: ResizeObserverCallback) {
    this.entry = { callback, targets: [] }
    registrations.push(this.entry)
  }

  observe(target: Element): void {
    this.entry.targets.push(target)
  }

  unobserve(target: Element): void {
    this.entry.targets = this.entry.targets.filter((item) => item !== target)
  }

  disconnect(): void {
    this.entry.targets = []
    const index = registrations.indexOf(this.entry)
    if (index >= 0) registrations.splice(index, 1)
  }
}

globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver

/**
 * 把当前挂载的组件"量"成给定宽度（触发一次 observe 回调）。
 *
 * 只喂宽度：这里没有布局引擎，高度的意义不大，而组件的自适应只用到宽度。
 */
export function resizeTo(width: number, height = 400): void {
  for (const registration of registrations) {
    const entries = registration.targets.map(
      (target) =>
        ({
          target,
          contentRect: { width, height, top: 0, left: 0, right: width, bottom: height },
        }) as unknown as ResizeObserverEntry,
    )
    if (entries.length) registration.callback(entries, {} as ResizeObserver)
  }
}

/** 清掉上一个用例留下的注册（避免跨用例互相触发）。 */
export function resetResizeObservers(): void {
  registrations.length = 0
}

/**
 * `HTMLDialogElement` 的开关（v0.25 提到全局）。
 *
 * **jsdom 不实现原生 `<dialog>` 的 `showModal()` / `close()`**，而 `AppModal`
 * 正是靠它们进出 top-layer。缺了它，任何挂载 `AppModal` 的用例都会抛
 * "element.showModal is not a function"。
 *
 * 原先三个用例文件各抄了一份（ChatView / KnowledgeBaseView / 别处），
 * 而 `SettingsModal.test.ts` 没有——它一直是靠一个巧合在跑：`AppModal` 只在
 * `open` **变化**时才调 `showModal()`，而那些用例挂载时 `open` 就已经是真，
 * watcher 从不触发，于是那道调用从没发生过。`AppModal` 补上"挂载时同步一次"
 * 之后（为了让 `<AppModal v-if="X" v-model:open="X">` 能打开），这个巧合就没了。
 *
 * 放到全局：**让 jsdom 里挂载任何弹窗的行为都一致**，不再依赖各文件记不记得抄。
 */
HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
  this.open = true
}

HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement): void {
  this.open = false
}

/**
 * **jsdom 不实现 `scrollIntoView`**（连空函数都没有，属性直接不存在）。
 *
 * 点行内引用徽标那一步会调它（把视线滚到对应的出处），于是任何走到那条路的用例
 * 都会以"未处理拒绝"的形态把整套测试判红——而这跟被测代码没关系。
 * 与上面几条同一个处置：**在全局补一次**，别让每个用例自己记得。
 *
 * 注意它只是个空实现：这个桩**测不了**"有没有真的滚过去"，想验滚动位置得在真浏览器里做。
 */
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {}
}

/**
 * **jsdom 的 `Range` 没有 `getClientRects` / `getBoundingClientRect`**，两个方法都不存在。
 *
 * 而 ProseMirror 把光标滚进视野时要量"光标所在那一段文字"的矩形
 * （`coordsAtPos` → `singleRect(textRange(...))`），走的就是这两个方法。
 * 缺了它们，`.focus()`（任何带 `scrollIntoView` 的命令）会在 **rAF 回调里**
 * 抛 `TypeError: target.getClientRects is not a function`——异步抛出，用例本身照样过，
 * 但整套测试会多一条"未处理错误"（v0.1.1 给笔记截图粘贴加用例时踩到）。
 * 与上面几条同一个处置：**在全局补一次**，别让每个用例自己记得。
 *
 * 空矩形是这个环境下唯一诚实的答案：真的量出位置得有布局引擎。
 * 于是"滚过去了没有"仍然测不了（同 `scrollIntoView` 那条注记）。
 */
const ZERO_RECT = {
  x: 0,
  y: 0,
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  width: 0,
  height: 0,
  toJSON: () => ({}),
} as DOMRect

if (typeof Range.prototype.getClientRects !== 'function') {
  Range.prototype.getClientRects = function getClientRects(): DOMRectList {
    return Object.assign([], { item: () => null }) as unknown as DOMRectList
  }
  Range.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
    return ZERO_RECT
  }
}
