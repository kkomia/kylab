/**
 * 「正在流的那一轮」（v0.41）+「断线重连」（P2-2）——**从旧前端的 15 条用例逐条搬过来**。
 *
 * 源：`frontend/tests/unit/composables/useLiveTurn.test.ts`。两处**非逻辑**的改写：
 *
 * 1. import 路径换成 `@/features/chat/model/liveTurn`；
 * 2. 旧实现的状态是个 Vue `ref`，用例里读 `liveTurnState.value`；新实现里同名的
 *    `liveTurnState()` 是**命令式读取**（组件订阅走 `useLiveTurn()`），所以
 *    `.value` 一律去掉——断言的值与时机一字不动。
 */

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import { chatStream, openLiveTurn, resumeStream, type ChatHandlers } from '@/api/chat'
import {
  abortLiveTurn,
  attachLiveTurn,
  clearLiveAnchors,
  clearLiveTurn,
  liveAnchor,
  liveTurnState,
  settleLiveApproval,
  startChatTurn,
  startResumeTurn,
} from '@/features/chat/model/liveTurn'

/**
 * 「正在流的那一轮」（v0.41）+「断线重连」（P2-2，开发计划 §12.225）。
 *
 * 这一层存在的理由（用户报的第 4 条）：流不能跟着页面走。所以这里钉三件事——
 * **事件写进模块状态**、**句柄在模块手里**（组件走了也能叫停）、
 * **结束/失败一定会通知调用方**。
 *
 * P2-2 起再加三件（后端在 `services/live_turns.py` 那一半是"跑在后台 + 环形缓冲"）：
 * **锚点**（最后收到的 seq）、**接回来**（`attachLiveTurn` 用锚点补发 + 接着流）、
 * **收口**（`done(recovered)` 之后不再等，正文以后端给的全文为准）。
 */
vi.mock('@/api/chat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/chat')>()
  return {
    ...actual,
    chatStream: vi.fn(),
    resumeStream: vi.fn(),
    openLiveTurn: vi.fn(),
  }
})

/**
 * 抓走 handlers，测试自己按需要推事件——与真实链路同一形状。
 *
 * `abort` 写成 `vi.fn<() => void>()`（而不是裸 `vi.fn()`）：这份测试在新前端里
 * **会被 `tsc` 一起检查**（`tsconfig` 的 include 含 `tests`），而 `Mock<Procedure | Constructable>`
 * 与句柄声明的 `() => void` 不兼容。断言与旧用例一字不动。
 */
function capture(): { handlers: ChatHandlers | null; abort: Mock<() => void> } {
  const box: { handlers: ChatHandlers | null; abort: Mock<() => void> } = {
    handlers: null,
    abort: vi.fn<() => void>(),
  }
  vi.mocked(chatStream).mockImplementation(async (_payload, handlers) => {
    box.handlers = handlers
    return { abort: box.abort }
  })
  vi.mocked(resumeStream).mockImplementation(async (_id, _payload, handlers) => {
    box.handlers = handlers
    return { abort: box.abort }
  })
  return box
}

/** 重连那条路（`openLiveTurn`）：抓 handlers，并记下每次调的 `(会话, 锚点)`。 */
function captureLive(): {
  handlers: ChatHandlers | null
  abort: Mock<() => void>
  calls: [string, number][]
} {
  const box: {
    handlers: ChatHandlers | null
    abort: Mock<() => void>
    calls: [string, number][]
  } = { handlers: null, abort: vi.fn<() => void>(), calls: [] }
  vi.mocked(openLiveTurn).mockImplementation(async (id, after, handlers) => {
    box.calls.push([id, after])
    box.handlers = handlers
    return { abort: box.abort }
  })
  return box
}

/** 空事件的 done（直播那条路不带 recovered / detail）。 */
const liveDone = { recovered: false, detail: '' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(openLiveTurn).mockReset()
  clearLiveTurn()
  // 锚点也是模块作用域的（它**故意**不随状态清空，见那个模块的说明）：
  // 用例之间必须自己清，否则上一条用例读到 20 会让下一条的重连带着 20 去补
  clearLiveAnchors()
})

describe('useLiveTurn', () => {
  it('事件一路写进模块状态，done 通知调用方收尾', async () => {
    const box = capture()

    const running = startChatTurn(
      { query: '问', kb_ids: [], conversation_id: 'c1' },
      {
        conversationId: 'c1',
        query: '问',
        thinking: { enabled: true, effort: 'medium' },
      },
    )

    box.handlers!.onThinking!('想一下')
    box.handlers!.onDelta!('半截')
    box.handlers!.onSources!([{ index: 1, chunk_id: 'k1' } as never])
    box.handlers!.onStep!({ label: '检索知识库', phase: 'tool', status: 'done' } as never)
    await running

    expect(liveTurnState()).toMatchObject({
      conversationId: 'c1',
      mode: 'append',
      query: '问',
      text: '半截',
      thinkingText: '想一下',
      streaming: true,
    })
    expect(liveTurnState()?.steps).toHaveLength(1)

    // 结束只翻状态——收尾（写缓存、让后端校准）由**当前挂载的组件**看见这个翻转之后做，
    // 见 ChatView 里那个 watcher：曾经这里存过一个"发起者"的回调，用户切走后它会静默跳过
    box.handlers!.onDone!('半截，写完了。', liveDone)
    expect(liveTurnState()).toMatchObject({ text: '半截，写完了。', streaming: false })
  })

  it('失败把原因留在状态里，并同样通知收尾（切页之后也看得见）', async () => {
    const box = capture()

    await startChatTurn(
      { query: '问', kb_ids: [], conversation_id: 'c1' },
      { conversationId: 'c1', query: '问', thinking: null },
    )
    box.handlers!.onError!('模型不可用')

    expect(liveTurnState()).toMatchObject({ error: '模型不可用', streaming: false })
  })

  it('句柄在模块手里：abort 调的是那一条流，把它收口但不当成失败', async () => {
    const box = capture()

    await startChatTurn(
      { query: '问', kb_ids: [], conversation_id: 'c1' },
      { conversationId: 'c1', query: '问', thinking: null },
    )
    box.handlers!.onDelta!('半截正文')
    abortLiveTurn()

    expect(box.abort).toHaveBeenCalledTimes(1)
    // 停止不算失败：已经流出来的部分留着，错误栏也不该冒出红字
    expect(liveTurnState()).toMatchObject({
      error: '',
      text: '半截正文',
      // **界面要收口**：P2-2 之后断开连接不再取消那一轮，所以"不再等它"是这一侧的决定；
      // `stopped` 那个标记还顺带把重连关掉了（用户刚说过不看了）
      streaming: false,
      stopped: true,
    })
  })

  it('续跑是 patch 落法：不补新的一轮（重放时要靠 mode 区分）', async () => {
    const box = capture()

    await startResumeTurn('c9', { skill_names: [] }, { thinking: null })
    box.handlers!.onDelta!('补完的正文')

    expect(liveTurnState()).toMatchObject({ mode: 'patch', conversationId: 'c9' })
    expect(liveTurnState()?.text).toBe('补完的正文')
  })

  it('待确认存在模块状态里：切页回来（组件重建）那条确认还在', async () => {
    // 它和流一样是"还没结束的状态"：放在组件里的话，用户切走再回来就看不到这条确认了，
    // 而后端一直在等（见 services/approvals.py）——那一轮会一直卡到超时
    const box = capture()
    await startChatTurn(
      { query: '问', kb_ids: [], conversation_id: 'c1' },
      { conversationId: 'c1', query: '问', thinking: null },
    )

    box.handlers!.onApproval!({
      approval_id: 'ap_1',
      tool: 'run_command',
      label: '执行命令',
      args: 'ls',
      detail: '',
      rule: 'Bash(ls:*)',
      timeout_seconds: 120,
    })

    expect(liveTurnState()?.approval?.approval_id).toBe('ap_1')
    // 决定交出去之后收起（组件点完按钮调它）
    settleLiveApproval()
    expect(liveTurnState()?.approval).toBeNull()
  })

  it('这一轮结束时确认条一起收：后端到点会自己按"没有回应"往下跑', async () => {
    const box = capture()
    await startChatTurn(
      { query: '问', kb_ids: [], conversation_id: 'c1' },
      { conversationId: 'c1', query: '问', thinking: null },
    )
    box.handlers!.onApproval!({
      approval_id: 'ap_1',
      tool: 'run_command',
      label: '执行命令',
      args: 'ls',
      detail: '',
      rule: 'Bash(ls:*)',
      timeout_seconds: 120,
    })

    box.handlers!.onDone!('答完了', liveDone)

    expect(liveTurnState()?.approval).toBeNull()
  })
})

describe('重连锚点与接回来（P2-2）', () => {
  it('锚点跟着事件走：最后收到的那个 seq 就是下次重连的 after', async () => {
    const box = capture()
    await startChatTurn(
      { query: '问', kb_ids: [], conversation_id: 'c1' },
      { conversationId: 'c1', query: '问', thinking: null },
    )

    box.handlers!.onSeq!(4)
    box.handlers!.onSeq!(9)
    expect(liveAnchor('c1')).toBe(9)
    // 别的会话各记各的（锚点是**按会话**的：重连问的是"这条会话我读到哪了"）
    expect(liveAnchor('c2')).toBe(0)
  })

  it('挂载时接回来：补发的事件按同一套 handler 落进状态，接着流的新事件照旧进来', async () => {
    const box = captureLive()

    await attachLiveTurn('c1')
    // 刷新之后锚点没了（模块作用域不持久化）→ `after=0`，把这一圈都补给我
    expect(box.calls).toEqual([['c1', 0]])
    expect(liveTurnState()).toMatchObject({
      conversationId: 'c1',
      mode: 'recover',
      // **第一条事件之前不算"在跑"**：多数打开会话的时刻根本没有在跑的一轮，
      // 这个窗口里先亮成流式中的话，输入框会闪一下「停止」
      streaming: false,
    })

    // 补发的三条：一条步骤（带编号）、一段**合并过的**思考（带编号）、出处（没有编号）
    box.handlers!.onSeq!(12)
    box.handlers!.onStep!({
      phase: 'tool',
      label: '检索知识库',
      detail: '命中 2 段',
      status: 'done',
    } as never)
    box.handlers!.onThinking!('先看看库里有什么', { logSeq: 13 })
    box.handlers!.onSeq!(13)
    box.handlers!.onSources!([{ index: 1, chunk_id: 'k1' } as never])

    expect(liveTurnState()).toMatchObject({ streaming: true, mode: 'recover' })
    expect(liveTurnState()?.steps).toHaveLength(1)
    expect(liveTurnState()?.thinkingText).toBe('先看看库里有什么')
    expect(liveTurnState()?.sources).toHaveLength(1)

    // **接着流**：正文增量照常到（补发里没有 delta——它是"这一轮还活着"的证据）
    box.handlers!.onDelta!('半截正文')
    expect(liveTurnState()?.text).toBe('半截正文')

    // 同一次思考的后继增量（不带编号）追加；而**重发的那一段合并文本**（同编号）替换
    // ——不认段号的话，断线之前那半段会显示两遍
    box.handlers!.onThinking!('，再查一遍')
    expect(liveTurnState()?.thinkingText).toBe('先看看库里有什么，再查一遍')
    box.handlers!.onThinking!('先看看库里有什么，再查一遍', { logSeq: 13 })
    expect(liveTurnState()?.thinkingText).toBe('先看看库里有什么，再查一遍')

    // 再接一次时锚点已经是补发到的那一条：只补之后的（不重复给整圈）
    expect(liveAnchor('c1')).toBe(13)
  })

  it('补发到一条**已经收尾**的轮次：done(recovered) 收口，正文以全文为准（不追加）', async () => {
    const box = captureLive()
    await attachLiveTurn('c1')

    box.handlers!.onSeq!(20)
    box.handlers!.onStep!({
      phase: 'tool',
      label: '导出文档',
      detail: '已导出',
      status: 'done',
    } as never)
    // 断线前已经收到过一段（补发不会重发它）
    box.handlers!.onDelta!('半截')
    box.handlers!.onDone!('这是完整答复。', {
      recovered: true,
      detail: '这一轮已经收尾了：补发到此为止（正文增量不重发，这里给的是完整答复）。',
    })

    expect(liveTurnState()).toMatchObject({
      text: '这是完整答复。',
      streaming: false,
      recovered: true,
    })
    // 收口之后不再挂着任何东西（界面据此停止等待）
    expect(liveTurnState()?.error).toBe('')
  })

  it('真实 emit 顺序（先 dispatch 再报锚点）：done 之后跟来的 onSeq 不许把状态抬回「流式中」', async () => {
    // 这条钉的是一个**真的把人卡住过**的缺陷：`api/chat.ts` 的 `emit` 先把事件交给
    // 界面、再报锚点，所以 `done` 那一事件的 `onSeq` 是在收尾**之后**到的。重连补发
    // 一条已经结束的轮次时（`done(recovered)` 是最后一条），那个尾随的 `onSeq` 会把
    // `streaming` 又抬成 true —— 输入框从此永远停在「停止生成」上：刷新（或重进）
    // 任何"环形缓冲里还留着刚跑完那一轮"的会话都会复现，按什么都没用。
    //
    // 上面几条用例的调用顺序是**反的**（先 onSeq 再类型 handler），所以它们看不见这个
    // 缺陷——顺序本身也是这里要守住的东西。
    const box = captureLive()
    await attachLiveTurn('c1')

    box.handlers!.onStep!({
      phase: 'tool',
      label: '检索知识库',
      detail: '命中 1 段',
      status: 'done',
    } as never)
    box.handlers!.onSeq!(30)
    expect(liveTurnState()?.streaming).toBe(true)

    box.handlers!.onDone!('完整答复。', { recovered: true, detail: '这一轮已经收尾了' })
    box.handlers!.onSeq!(31)

    expect(liveTurnState()).toMatchObject({ streaming: false, recovered: true })
  })

  it('真断线：按锚点接回来（after=最后收到的 seq），新事件继续进来', async () => {
    vi.useFakeTimers()
    try {
      const first = capture()
      const live = captureLive()
      await startChatTurn(
        { query: '问', kb_ids: [], conversation_id: 'c1' },
        { conversationId: 'c1', query: '问', thinking: null },
      )
      first.handlers!.onSeq!(7)
      first.handlers!.onDelta!('前半段')

      // 流断了（既不是 done / error，也不是用户取消）
      first.handlers!.onDropped!('对话中断')
      // 还没收摊：正等着接回来
      expect(liveTurnState()?.streaming).toBe(true)
      expect(liveTurnState()?.error).toBe('')

      await vi.advanceTimersByTimeAsync(1000)
      // **带着锚点**去补：不是重新要整条会话
      expect(live.calls).toEqual([['c1', 7]])

      // 补发的那几条 + 接着流的正文
      live.handlers!.onSeq!(9)
      live.handlers!.onStep!({
        phase: 'tool',
        label: '联网搜索',
        detail: '8 条',
        status: 'done',
      } as never)
      live.handlers!.onDelta!('后半段')
      expect(liveTurnState()).toMatchObject({ text: '前半段后半段', streaming: true })
      expect(liveTurnState()?.steps).toHaveLength(1)

      live.handlers!.onDone!('前半段后半段', liveDone)
      expect(liveTurnState()).toMatchObject({ text: '前半段后半段', streaming: false })
    } finally {
      vi.useRealTimers()
    }
  })

  it('接不上：试够次数才如实报错（不假装还在跑）', async () => {
    vi.useFakeTimers()
    try {
      const first = capture()
      vi.mocked(openLiveTurn).mockRejectedValue(new Error('网络不通'))
      await startChatTurn(
        { query: '问', kb_ids: [], conversation_id: 'c1' },
        { conversationId: 'c1', query: '问', thinking: null },
      )

      first.handlers!.onDropped!('对话中断')
      // 每一轮重连自己又失败一次 → 再排一次，直到预算用尽
      for (let round = 0; round < 6; round += 1) await vi.advanceTimersByTimeAsync(1000)

      expect(liveTurnState()).toMatchObject({ streaming: false, error: '网络不通' })
      expect(vi.mocked(openLiveTurn).mock.calls.length).toBeLessThanOrEqual(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('用户按了「停止」之后不重连（他刚说过不看了）', async () => {
    vi.useFakeTimers()
    try {
      const first = capture()
      const live = captureLive()
      await startChatTurn(
        { query: '问', kb_ids: [], conversation_id: 'c1' },
        { conversationId: 'c1', query: '问', thinking: null },
      )
      abortLiveTurn()
      // 那条流随后报"断了"（用户自己断的，服务端看起来也是断线）——不该接回来
      first.handlers!.onDropped!('对话中断')
      await vi.advanceTimersByTimeAsync(3000)
      expect(live.calls).toEqual([])
      expect(liveTurnState()?.stopped).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('挂载时接不上：画面上什么都不留（不留一个假的"在跑"）', async () => {
    vi.mocked(openLiveTurn).mockRejectedValue(new Error('这条会话上没有在跑的一轮'))
    await attachLiveTurn('c1')
    expect(liveTurnState()).toBeNull()
  })

  it('手上那条流还在跑时，不重复建连（挂载与切回会话会前后脚都问一次）', async () => {
    const box = captureLive()
    await attachLiveTurn('c1')
    box.handlers!.onDelta!('在跑的正文')
    await attachLiveTurn('c1')
    expect(box.calls).toHaveLength(1)
  })

  it('手上跑着**别的**会话：不抢它的位置（这一格只放当前那一轮）', async () => {
    const box = captureLive()
    await attachLiveTurn('c1')
    box.handlers!.onDelta!('c1 的正文')
    await attachLiveTurn('c2')
    expect(box.calls).toEqual([['c1', 0]])
    expect(liveTurnState()?.conversationId).toBe('c1')
  })
})
