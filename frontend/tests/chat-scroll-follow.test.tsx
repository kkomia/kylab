/**
 * 流式滚动（D31）：**用户往上翻之后，程序不许再把他拽回底部**（走查项 D31）。
 *
 * "没被拽回"这件事只有真浏览器能作数——jsdom 不算版面、也不会做滚动锚定，所以**验收**
 * 是探针（`.shots/d31-follow-fix.cjs`：真流式 + 真实滚轮 + 逐次采样的原始数字）。
 * 这一层钉的是**判据本身**，三个入口各有一个，删掉任何一个这里都会红：
 *
 * 1. 往上翻的那一下（`wheel` 的方向）要真的把跟随停掉，而且**已经排队的那一帧也要撤掉**
 *    （上一轮查到的那次回拽就是"滚轮之前排上的帧照跑了"）；
 * 2. 停止跟随时，内容继续长**一次都不许写 `scrollTop`**；
 * 3. 滚回贴底之后跟随要接回来，后面继续贴在底部。
 *
 * 另外钉住 `overflow-anchor: none`：不关掉浏览器滚动锚定，`scrollTop` 会被浏览器自己挪动
 * （实测一次滚轮之后 JS 一次没写、位置却挪了 324px），上面三条就都守不住了。
 * jsdom 不跑 CSS，类名是这一层唯一钉得住的形式（与 `ui/` 那条 `flex-1 + min-h-0` 同一手法）。
 *
 * 渲染的是**真宿主**：`ChatRuntime`（assistant-ui 的 runtime 适配）+ `ChatThread`
 * （跟跟随滚动那一带）。只把 `useChat` 换成桩——它给的是消息与动作，与滚动无关；
 * 滚动那一路（视口、监听、观察者、落底）逐字都是产品代码。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** `useChat` 的桩：只备 `ChatThread`/`ChatHeader`/`MessageView` 渲染时读到的那些字段。 */
const chatStub = {
  messages: [] as unknown[],
  welcome: false,
  pendingEntry: false,
  // 空 id：抬头那条取详情的 query 就不会发出去（`enabled` 判的就是它），
  // 这一层也就不用给 `@/api/conversations` 补一堆桩
  conversationId: '',
  copiedKey: '',
  sending: false,
  regenerating: false,
  resuming: false,
  turns: [] as unknown[],
  savedTurns: [] as number[],
  send: () => undefined,
  stop: () => undefined,
  copyMessage: () => undefined,
  openFiles: () => undefined,
  regenerate: () => undefined,
  resumeTurn: () => undefined,
  retryTurn: () => undefined,
  revealSource: () => undefined,
  saveAsNote: () => undefined,
  // 过程面板无条件读这两个；桩直接接**产品里那两个纯函数**，判据不在这里重写一遍
  traceOpen: (message: Message) => isTraceOpen(message),
  toggleTrace: () => undefined,
  traceView: (_turnIndex: number, turn: Turn) => tracePage(turn),
}

vi.mock('@/features/chat/runtime/ChatProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/chat/runtime/ChatProvider')>()
  return { ...actual, useChat: () => chatStub }
})

import { ChatRuntime } from '@/features/chat/runtime/ChatRuntime'
import {
  isTraceOpen,
  makeMessage,
  tracePage,
  type Message,
  type Turn,
} from '@/features/chat/model/turns'
import { ChatThread } from '@/features/chat/ui/ChatThread'

/** 一条消息：字段用产品里那个工厂补齐（`convertMessage` 只读 id / role / text）。 */
function message(id: string, role: 'user' | 'assistant', text: string) {
  return { ...makeMessage(role, text), id }
}

/**
 * 把视口做成一个"能滚的假盒子"。
 *
 * jsdom 的 `scrollHeight` / `clientHeight` 恒为 0，不自己给数就量不出"贴不贴底"；
 * `scrollTop` 也照着浏览器那条语义夹在 `[0, 最大可滚位置]`。
 */
function fakeScroll(viewport: HTMLElement, startHeight = 2000, client = 600) {
  let height = startHeight
  let top = height - client

  Object.defineProperty(viewport, 'scrollHeight', { configurable: true, get: () => height })
  Object.defineProperty(viewport, 'clientHeight', { configurable: true, get: () => client })
  Object.defineProperty(viewport, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = Math.min(Math.max(0, Number(value)), Math.max(0, height - client))
    },
  })

  return {
    get top() {
      return top
    },
    get max() {
      return Math.max(0, height - client)
    },
    /**
     * 内容长高一截。**改一个既有文本节点**（不是往视口里塞新节点）：
     * 流式那一个字在浏览器里就是 `characterData` 变更，也正是这里被观察的那一类；
     * 顺带不往 React 管的子树里塞外来节点。
     */
    grow(px = 400) {
      height += px
      const walker = document.createTreeWalker(viewport, NodeFilter.SHOW_TEXT)
      const texts: Text[] = []
      for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node as Text)
      const tail = texts[texts.length - 1]
      if (tail) tail.data += '字'
    },
    /** 用户自己滚到某处（浏览器那头是滚轮干的事，这里只把数字摆好）。 */
    move(value: number) {
      top = Math.min(Math.max(0, value), Math.max(0, height - client))
    },
    /** 滚到底，并让 `scroll` 事件按真实链路到达视口。 */
    toBottom() {
      top = Math.max(0, height - client)
      viewport.dispatchEvent(new Event('scroll'))
    },
  }
}

async function settle(ms = 100) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

beforeEach(() => {
  // jsdom 没有 `Element.prototype.scrollTo`（库那条"到某个时刻落底"的路会调它）
  Element.prototype.scrollTo = () => undefined
  chatStub.messages = []
})

describe('流式滚动（D31）：往上翻之后不再被拽回', () => {
  it('往上翻之后内容继续长也不写 scrollTop；滚回贴底才恢复跟随', async () => {
    chatStub.messages = [
      message('m1', 'user', '问一段长的'),
      message('m2', 'assistant', '答一段长的'),
    ]
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ChatRuntime>
          <ChatThread />
        </ChatRuntime>
      </QueryClientProvider>,
    )
    const viewport = await screen.findByLabelText('对话内容')
    await screen.findByTestId('message-list')

    // 关掉滚动锚定这件事必须落在类名上：不然浏览器会自己挪 `scrollTop`
    expect(viewport.className).toContain('overflow-anchor:none')

    const box = fakeScroll(viewport)

    // 贴底那一档：内容长大 → 一帧内补到新的底部
    box.grow()
    await waitFor(() => expect(box.top).toBe(box.max))

    // 真实滚轮往上翻 400px（浏览器随后会补一次 `scroll`，这里照实重放）
    fireEvent.wheel(viewport, { deltaY: -400 })
    box.move(box.top - 400)
    viewport.dispatchEvent(new Event('scroll'))
    const afterWheel = box.top
    expect(afterWheel).toBe(box.max - 400)

    // 内容再长两截：**一次都不许写**——写一次就是把刚翻上去的人拽回去了
    box.grow()
    box.grow()
    await settle()
    expect(box.top).toBe(afterWheel)

    // 自己滚回贴底 → 跟随接回来，后面继续贴在底部
    box.toBottom()
    box.grow()
    await waitFor(() => expect(box.top).toBe(box.max))
  })
})
