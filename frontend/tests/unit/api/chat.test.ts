import { afterEach, describe, expect, it, vi } from 'vitest'

import { chatOnce, chatStream, isAbortError, type ChatSource } from '@/api/chat'

function source(index: number): ChatSource {
  return {
    index,
    chunk_id: `c${index}`,
    document_id: `d${index}`,
    document_name: `文档${index}.pdf`,
    heading_path: '第一章',
    page: 3,
    score: 0.5,
    preview: '预览文字',
  }
}

/** 造一个把 SSE 文本切成分片的 ReadableStream——用来验证"增量切在 JSON 中间"。 */
function sseResponse(chunks: string[], close = true): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      if (close) controller.close()
    },
  })
  return new Response(stream, { status: 200 })
}

function events(payloads: unknown[]): string {
  return payloads.map((item) => `data: ${JSON.stringify(item)}\n\n`).join('')
}

/** 等待正文把预期的事件派发完（pump 是脱离 await 的，断言前要给它一点时间）。 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30))

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('chatStream', () => {
  it('解析 sources / delta / done 三类事件', async () => {
    const body = events([
      { type: 'sources', items: [source(1)] },
      { type: 'delta', text: '眼轴' },
      { type: 'delta', text: '长度' },
      { type: 'done', answer: '眼轴长度' },
    ])
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse([body])),
    )

    const seen: string[] = []
    const answers: string[] = []
    let sources: ChatSource[] = []
    await chatStream(
      { query: 'q', kb_ids: ['kb_1'] },
      {
        onSources: (items) => {
          sources = items
        },
        onDelta: (text) => seen.push(text),
        onDone: (text) => answers.push(text),
      },
    )
    await settle()

    expect(sources).toHaveLength(1)
    expect(seen).toEqual(['眼轴', '长度'])
    expect(answers).toEqual(['眼轴长度'])
  })

  it('事件被切在任意字节位置也能解析（SSE 分片是常态）', async () => {
    const body = events([
      { type: 'delta', text: '甲' },
      { type: 'delta', text: '乙' },
      { type: 'done', answer: '甲乙' },
    ])
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse([...body])),
    )

    let text = ''
    await chatStream({ query: 'q', kb_ids: ['kb_1'] }, { onDelta: (d) => (text += d) })
    await settle()

    expect(text).toBe('甲乙')
  })

  it('error 事件走 onError，不抛异常', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse([events([{ type: 'error', message: '尚未配置对话模型' }])])),
    )

    let message = ''
    await chatStream({ query: 'q', kb_ids: ['kb_1'] }, { onError: (m) => (message = m) })
    await settle()

    expect(message).toBe('尚未配置对话模型')
  })

  it('HTTP 407/502 时取后端 message，与 client.ts 的文案格式一致', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ code: 'chat_error', message: '对话端点返回 400' }), {
            status: 502,
          }),
      ),
    )

    await expect(chatStream({ query: 'q', kb_ids: ['kb_1'] }, {})).rejects.toThrow(
      '对话端点返回 400',
    )
  })

  it('响应头一到就交出句柄：正文还没结束时「停止」已经可用', async () => {
    const encoder = new TextEncoder()
    let close: () => void = () => undefined
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: unknown, init?: RequestInit) =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                close = () => {
                  try {
                    controller.close()
                  } catch {
                    // 关过了
                  }
                }
                controller.enqueue(encoder.encode('data: {"type":"delta","text":"甲"}\n\n'))
                // 真 fetch 在 signal 取消时结束响应体；jsdom 不会替我们做这一步
                init?.signal?.addEventListener('abort', close)
              },
            }),
          ),
        ),
      ),
    )

    let text = ''
    let handle: { abort: () => void } | null = null
    // 正文永远不结束：handle 必须仍然拿得到
    const pending = chatStream(
      { query: 'q', kb_ids: ['kb_1'] },
      { onDelta: (d) => (text += d) },
    ).then((value) => {
      handle = value
    })
    await settle()

    expect(handle).not.toBeNull()
    expect(text).toBe('甲')

    handle!.abort()
    await pending
    await settle()

    // 取消之后流结束，且已经流出来的字还在
    expect(text).toBe('甲')
  })

  it('调用方自带的 signal 取消时，抛出的错误可被 isAbortError 识别', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            )
          }),
      ),
    )

    const controller = new AbortController()
    const pending = chatStream({ query: 'q', kb_ids: ['kb_1'] }, {}, controller.signal)
    controller.abort()

    const error = await pending.catch((cause: unknown) => cause)
    expect(isAbortError(error)).toBe(true)
  })

  it('流内已经报过错时不再补一条通用报错（避免两条红字说同一件事）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse([events([{ type: 'error', message: '上游 500' }])])),
    )

    const seen: string[] = []
    await chatStream({ query: 'q', kb_ids: ['kb_1'] }, { onError: (m) => seen.push(m) })
    await settle()

    expect(seen).toEqual(['上游 500'])
  })

  it('流干净结束却没有 done/error 时明确报错，不留一个空回答', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse([''])),
    )

    let message = ''
    await chatStream({ query: 'q', kb_ids: ['kb_1'] }, { onError: (m) => (message = m) })
    await settle()

    expect(message).toContain('没有返回任何内容')
  })

  it('流结束但没有 done 时，把增量累积的结果当答案交付', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse([events([{ type: 'delta', text: '半句' }])])),
    )

    let answer = ''
    await chatStream({ query: 'q', kb_ids: ['kb_1'] }, { onDone: (a) => (answer = a) })
    await settle()

    expect(answer).toBe('半句')
  })

  it('isAbortError 只认 AbortError', () => {
    expect(isAbortError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true)
    expect(isAbortError(new Error('x'))).toBe(false)
    expect(isAbortError(null)).toBe(false)
  })
})

describe('chatOnce', () => {
  it('返回 answer 与 sources', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ answer: '回答', sources: [source(1)] }), { status: 200 }),
      ),
    )

    const result = await chatOnce({ query: 'q', kb_ids: ['kb_1'] })

    expect(result.answer).toBe('回答')
    expect(result.sources[0].document_name).toBe('文档1.pdf')
  })
})
