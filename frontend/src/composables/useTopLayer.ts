/**
 * 顶层宿主：把全局浮层渲染进当前打开的 `<dialog>` 里。
 *
 * **为什么需要**：`AppModal` 用原生 `<dialog>.showModal()`，浏览器会把它提升到
 * **top layer**——那一层凌驾于页面上所有 `z-index` 之上。于是挂在 body 上的通知条
 * （`ToastStack`，`z-index:100`）在设置弹窗里推的每一条都被弹窗盖住，
 * 用户只看到"点了没反应"。`z-index` 再大也没用，必须把节点挪进 dialog 内部。
 *
 * 这与 `AppSelect` 的做法是同一个成因的两面：那个组件的浮层"不 Teleport、
 * 原地 + position:fixed"，正是为了留在这个 top-layer 元素里；通知条挂在全局，
 * 只能反过来——把它送进去。
 *
 * 用**栈**：弹窗可以嵌套，后开的在最上面，通知就跟着最上面那个走。
 */
import { computed, ref } from 'vue'

const hosts = ref<HTMLElement[]>([])

export function pushTopLayerHost(element: HTMLElement): void {
  if (!hosts.value.includes(element)) hosts.value = [...hosts.value, element]
}

export function popTopLayerHost(element: HTMLElement): void {
  hosts.value = hosts.value.filter((item) => item !== element)
}

/** 最上层的宿主元素；没有弹窗时为 `null`（通知条回落到 body）。 */
export const topLayerHost = computed<HTMLElement | null>(
  () => hosts.value[hosts.value.length - 1] ?? null,
)
