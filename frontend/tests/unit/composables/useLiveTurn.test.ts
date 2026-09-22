import { beforeEach, describe, expect, it, vi } from 'vitest'

import { chatStream, resumeStream, type ChatHandlers } from '@/api/chat'
import {
  abortLiveTurn,
  clearLiveTurn,
  liveTurnState,
  startChatTurn,
  startResumeTurn,
} from '@/composables/useLiveTurn'

/**
 * 「正在流的那一轮」（v0.41）。
 *
 * 这一层存在的理由（用户报的第 4 条）：流不能跟着页面走。所以这里钉三件事——
 * **事件写进模块状态**、**句柄在模块手里**（组件走了也能叫停）、
 * **结束/失败一定会通知调用方**（`onSettled`，组件靠它收尾）。
 */
vi.mock('@/api/chat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/chat')>()
  return { ...actual, chatStream: vi.fn(), resumeStream: vi.fn() }
})

/** 抓走 handlers，测试自己按需要推事件——与真实链路同一形状。 */
function capture(): { handlers: ChatHandlers | null; abort: ReturnType<typeof vi.fn> } {
  const box: { handlers: ChatHandlers | null; abort: ReturnType<typeof vi.fn> } = {
    handlers: null,
    abort: vi.fn(),
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

beforeEach(() => {
  vi.clearAllMocks()
  clearLiveTurn()
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

    expect(liveTurnState.value).toMatchObject({
      conversationId: 'c1',
      mode: 'append',
      query: '问',
      text: '半截',
      thinkingText: '想一下',
      streaming: true,
    })
    expect(liveTurnState.value?.steps).toHaveLength(1)

    // 结束只翻状态——收尾（写缓存、让后端校准）由**当前挂载的组件**看见这个翻转之后做，
    // 见 ChatView 里那个 watcher：曾经这里存过一个"发起者"的回调，用户切走后它会静默跳过
    box.handlers!.onDone!('半截，写完了。')
    expect(liveTurnState.value).toMatchObject({ text: '半截，写完了。', streaming: false })
  })

  it('失败把原因留在状态里，并同样通知收尾（切页之后也看得见）', async () => {
    const box = capture()

    await startChatTurn(
      { query: '问', kb_ids: [], conversation_id: 'c1' },
      { conversationId: 'c1', query: '问', thinking: null },
    )
    box.handlers!.onError!('模型不可用')

    expect(liveTurnState.value).toMatchObject({ error: '模型不可用', streaming: false })
  })

  it('句柄在模块手里：abort 调的是那一条流，且不会把它当成失败', async () => {
    const box = capture()

    await startChatTurn(
      { query: '问', kb_ids: [], conversation_id: 'c1' },
      { conversationId: 'c1', query: '问', thinking: null },
    )
    abortLiveTurn()

    expect(box.abort).toHaveBeenCalledTimes(1)
    // 停止不算失败：已经流出来的部分留着，错误栏也不该冒出红字
    expect(liveTurnState.value?.error).toBe('')
  })

  it('续跑是 patch 落法：不补新的一轮（重放时要靠 mode 区分）', async () => {
    const box = capture()

    await startResumeTurn('c9', { skill_names: [] }, { thinking: null })
    box.handlers!.onDelta!('补完的正文')

    expect(liveTurnState.value).toMatchObject({ mode: 'patch', conversationId: 'c9' })
    expect(liveTurnState.value?.text).toBe('补完的正文')
  })
})
