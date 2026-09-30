/**
 * 「视口贴底了吗」那一格共享位——**只有一处写**（`ChatThread` 的跟随状态机），
 * 读有两处（`Composer` 上沿的「回到最新」浮标、将来的其它跟随提示）。
 *
 * 为什么要从 assistant-ui 的状态钩子换出来：库那枚 `ScrollToBottom` 在贴底时把回调
 * 返回 `null` 接成 `disabled`（于是浮标得靠 `disabled:hidden` 藏），而点它是**瞬时跳**
 * （`behavior:"auto"` 取元素 computed 的 `scroll-behavior`，全仓没给视口设过 smooth）。
 * Kimi 是平滑滚过去（设计文档 §11：点击平滑滚动到底，400ms）——所以浮标换成自己的
 * 按钮，位置由这一格决定；滚动本身提交给 `viewport` 那个节点。
 *
 * `viewport` 由 `ChatThread` 在挂载时交上来（它本来就是那台状态机的宿主）：
 * 浮标点击时对它有两种写法（回贴底 + 平滑滚动），免得在 Composer 里再查一次 DOM。
 */
import { create } from 'zustand'

interface FollowState {
  /** 视口现在贴着底吗（**写只有一处**：ChatThread 的跟随状态机）。 */
  atBottom: boolean
  /** 对话视口的节点（交上来是为了浮标点击时滚它）。 */
  viewport: HTMLDivElement | null
  setAtBottom: (value: boolean) => void
  setViewport: (node: HTMLDivElement | null) => void
}

export const useFollowStore = create<FollowState>((set) => ({
  atBottom: true,
  viewport: null,
  setAtBottom: (value) => set({ atBottom: value }),
  setViewport: (node) => set({ viewport: node }),
}))

/**
 * 点浮标：平滑滚到底（400ms，设计文档 §11）。
 * `prefers-reduced-motion` 下直落——平滑滚动也是"动效"，同样要能被关掉。
 */
export function scrollToLatest(): void {
  const el = useFollowStore.getState().viewport
  if (!el) return
  const reduced =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  el.scrollTo({ top: el.scrollHeight, behavior: reduced ? 'auto' : 'smooth' })
}
