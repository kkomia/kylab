/**
 * 轮询（§12.116）。
 *
 * 这四条全是**实测出来的浪费**：页面切到后台时每 2 秒照打（一晚约 4 万次请求）、
 * 慢请求层层叠加、切回来要等一个间隔才看到新数据、以及各处自己管生命周期总有一处漏。
 */
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref, type Ref } from 'vue'

import { usePolling } from '@/composables/usePolling'

function withPolling(task: () => void | Promise<void>, active: Ref<boolean>) {
  const Host = defineComponent({
    setup() {
      usePolling(task, { active, intervalMs: 1000 })
      return () => h('div')
    },
  })
  return mount(Host)
}

/** 伪造可见性：jsdom 里 `visibilityState` 是只读的。 */
function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  vi.useFakeTimers()
  setVisibility('visible')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('usePolling', () => {
  it('立刻跑一次，之后按间隔跑', async () => {
    const task = vi.fn()
    withPolling(task, ref(true))

    expect(task).toHaveBeenCalledTimes(1) // 挂载即取数据，别让首屏空等一个间隔
    await vi.advanceTimersByTimeAsync(3000)
    expect(task).toHaveBeenCalledTimes(4)
  })

  it('active 为假时不轮询（全静止时不该还在打接口）', async () => {
    const task = vi.fn()
    withPolling(task, ref(false))

    await vi.advanceTimersByTimeAsync(3000)
    expect(task).not.toHaveBeenCalled()
  })

  it('active 由假变真时立刻跑一次', async () => {
    const task = vi.fn()
    const active = ref(false)
    withPolling(task, active)

    active.value = true
    await vi.advanceTimersByTimeAsync(0)
    expect(task).toHaveBeenCalledTimes(1)
  })

  it('**标签页隐藏时暂停**（这是最省的一条：后台开着过夜不再空打几万次）', async () => {
    const task = vi.fn()
    withPolling(task, ref(true))
    expect(task).toHaveBeenCalledTimes(1)

    setVisibility('hidden')
    await vi.advanceTimersByTimeAsync(5000)
    expect(task).toHaveBeenCalledTimes(1)
  })

  it('切回来时**立刻刷新一次**，不用等下一个间隔', async () => {
    const task = vi.fn()
    withPolling(task, ref(true))
    setVisibility('hidden')
    await vi.advanceTimersByTimeAsync(5000)
    expect(task).toHaveBeenCalledTimes(1)

    setVisibility('visible')

    // 同步就发生了一次刷新：用户切回来看到的不是 5 秒前的旧画面
    expect(task).toHaveBeenCalledTimes(2)
  })

  it('上一轮还没回来时跳过这一拍（慢接口不该被越堆越多）', async () => {
    // 用一个"挂住"的 promise：手动决定第一轮什么时候返回
    let resolveFirst: () => void = () => {}
    const first = new Promise<void>((r) => {
      resolveFirst = r
    })
    const task = vi.fn(() => first)
    withPolling(task, ref(true))
    expect(task).toHaveBeenCalledTimes(1)

    // 第一轮挂着不返回，又过了三个间隔
    await vi.advanceTimersByTimeAsync(3000)
    expect(task).toHaveBeenCalledTimes(1)

    resolveFirst()
    await vi.advanceTimersByTimeAsync(1000)
    expect(task).toHaveBeenCalledTimes(2)
  })

  it('卸载后停表（不会对已卸载的组件继续发请求）', async () => {
    const task = vi.fn()
    const wrapper = withPolling(task, ref(true))
    wrapper.unmount()

    await vi.advanceTimersByTimeAsync(5000)
    expect(task).toHaveBeenCalledTimes(1)
  })
})
