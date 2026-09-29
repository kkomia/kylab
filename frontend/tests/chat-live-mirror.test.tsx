/**
 * D32（§12.312 定位）那两条**机制级**护栏：常驻流的 store 与镜像。
 *
 * 定位结论把成环拆成三段，前两段各有一条"身份/触发点"的病灶，jsdom 里能钉住的是这两件：
 *
 * 1. **`useLiveTurn()` 的快照函数必须身份稳定**（`liveTurn.ts`）。内联 selector
 *    （`useLiveTurnStore((store) => store.live)`）在 zustand v5 里每次渲染都会新建
 *    `getSnapshot`，而 React 给 `useSyncExternalStore` 压的那个 `updateStoreInstance`
 *    是被动 effect（依赖里含 `getSnapshot`）——于是**每渲染一次就多跑一趟**。
 *    这一条用"每次渲染平均调用几次 `getState`"量：修好之后一次渲染一次，坏的时候两次；
 * 2. **镜像写在"写 store 的同一个同步任务"里**（`subscribeLiveTurn`）。原先它挂在
 *    `ChatProvider` 的被动 effect 上 → 在被动 effect 里 `setMessages` →
 *    `nestedPassiveUpdateCount` 从不归零。这一条钉"监听者在 `update()` 的同一个同步调用里
 *    就被通知到"——真浏览器那边它表现为"每次 store 写入引发的 commit 数"从 2.0 降到 1.0。
 */
import { act, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { chatStream, type ChatHandlers } from '@/api/chat'
import {
  clearLiveTurn,
  liveTurnState,
  startChatTurn,
  subscribeLiveTurn,
  useLiveTurn,
  useLiveTurnStore,
} from '@/features/chat/model/liveTurn'

vi.mock('@/api/chat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/chat')>()
  return { ...actual, chatStream: vi.fn() }
})

/** 抓住一轮的 handlers（与真实链路同一形状）。 */
function capture(): { handlers: ChatHandlers | null } {
  const box: { handlers: ChatHandlers | null } = { handlers: null }
  vi.mocked(chatStream).mockImplementation(async (_payload, handlers) => {
    box.handlers = handlers
    return { abort: () => undefined }
  })
  return box
}

const meta = { conversationId: 'c1', query: '问一句', thinking: null }
const payload = {
  query: '问一句',
  kb_ids: [],
  history: [],
  conversation_id: 'c1',
} as never

afterEach(() => {
  clearLiveTurn()
  vi.clearAllMocks()
})

describe('D32 机制护栏：常驻流 store 与镜像', () => {
  it('镜像监听者在"写 store 的同一个同步任务"里就被通知到（不再等被动 effect）', async () => {
    const box = capture()
    const seen: (string | null)[] = []
    const off = subscribeLiveTurn((state) => seen.push(state ? state.text : null))

    await act(async () => {
      void startChatTurn(payload, meta)
    })
    // 起一轮那一次 `install` 就该通知到（挂载/切页回来时靠它把提问与占位回答画出来）
    expect(seen.at(-1)).toBe('')

    act(() => {
      box.handlers!.onDelta!('甲')
    })
    // **同步**就能看见：这一行之后立刻断言，不 await、不等 React 刷被动 effect ——
    // 这正是"镜像不在被动 effect 里"的可测形式
    expect(seen.at(-1)).toBe('甲')
    expect(liveTurnState()?.text).toBe('甲')

    act(() => {
      box.handlers!.onDelta!('乙')
    })
    expect(seen.at(-1)).toBe('甲乙')

    off()
    act(() => {
      box.handlers!.onDelta!('丙')
    })
    // 注销之后不再收到（ChatProvider 卸载时那条路径）
    expect(seen.at(-1)).toBe('甲乙')
  })

  /**
   * **这一条量的是"这一版实现"本身**（诚实说明，免得被当成两版对照）：`getState` 的调用
   * 计数只在**我们这一版**里可观测——`useLiveTurn` 走的是模块级 `getLiveSnapshot`，
   * 它每次调用都从 `useLiveTurnStore.getState()` 现取；而 zustand 那一版把 `api.getState`
   * 收在自己的闭包里，外面 `vi.spyOn` 拦不到（实测那一版量到的是 0）。
   *
   * 所以这条守卫管的是：**每次渲染的读取次数是有界的**（开发档里 React 一次渲染读两次：
   * 渲染里一次 + 提交后那次一致性检查…… 内联 selector 那一版还会额外多出"每渲染跑一趟
   * `updateStoreInstance`"，换算下来是每次渲染 3 次）。真正的"换掉内联 selector"这条
   * 由 React 源码（那个被动 effect 的依赖里含 `getSnapshot`）与真浏览器的重渲染读数佐证。
   */
  it('useLiveTurn 每次渲染的 getState 读取次数有界（模块级快照函数）', () => {
    const getState = vi.spyOn(useLiveTurnStore, 'getState')
    let renders = 0
    let bump: (() => void) | null = null

    function Probe() {
      renders += 1
      useLiveTurn()
      return null
    }
    function Harness() {
      const [tick, setTick] = useState(0)
      bump = () => setTick((value) => value + 1)
      return (
        <>
          <Probe />
          <span>{tick}</span>
        </>
      )
    }

    render(<Harness />)
    for (let index = 0; index < 5; index += 1) {
      act(() => bump?.())
    }

    const calls = getState.mock.calls.length
    expect(screen.getByText('5')).toBeInTheDocument()
    expect(renders).toBeGreaterThanOrEqual(6)
    // 本版实测 renders=6 / getState=13；上界给到 2×renders+3（内联 selector 那一版会更高）
    expect(calls).toBeLessThanOrEqual(renders * 2 + 3)
    getState.mockRestore()
  })
})
