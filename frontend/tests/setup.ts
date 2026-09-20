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
