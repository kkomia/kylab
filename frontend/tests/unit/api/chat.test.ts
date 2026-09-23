import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  chatOnce,
  chatStream,
  decideApproval,
  getContextUsage,
  isAbortError,
  listCommands,
  openLiveTurn,
  type ChatCommandResult,
  type ChatHandlers,
  type ChatPayload,
  type ChatSource,
} from '@/api/chat'
import { clearSessionToken, setSessionToken } from '@/composables/useSessionToken'

/**
 * 协议用例不看显示节流：关掉它，事件立即派发，断言才好写。
 * 节流本身由 displayPacer 的用例覆盖（含一条经 pump 的联调用例）。
 */
function noPace(payload: ChatPayload, handlers: ChatHandlers, signal?: AbortSignal) {
  return chatStream(payload, handlers, signal, { smooth: false })
}

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
    knowledge_base_id: 'kb1',
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
  it('带上登录凭据：这条链路绕过了 client.request，令牌得自己加', async () => {
    // 回归用例。漏掉 Authorization 的表现极具迷惑性——对话页永远回「缺少凭据」，
    // 而其它页面（走 client.request）全部正常，看起来像"对话功能坏了"。
    // 用 setSessionToken 而不是直接写 localStorage：令牌是模块级 ref（登录时写入），
    // 只改存储不会让已加载的模块看到。
    setSessionToken('tok_abc')
    let headers: Record<string, string> = {}
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        headers = init.headers as Record<string, string>
        return sseResponse([events([{ type: 'done', answer: '好' }])])
      }),
    )

    await noPace({ query: 'q', kb_ids: ['kb_1'] }, {})
    await settle()

    expect(headers.Authorization).toBe('Bearer tok_abc')
    clearSessionToken()
  })

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
    await noPace(
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
    await noPace({ query: 'q', kb_ids: ['kb_1'] }, { onDelta: (d) => (text += d) })
    await settle()

    expect(text).toBe('甲乙')
  })

  it('error 事件走 onError，不抛异常', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse([events([{ type: 'error', message: '尚未配置对话模型' }])])),
    )

    let message = ''
    await noPace({ query: 'q', kb_ids: ['kb_1'] }, { onError: (m) => (message = m) })
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

    await expect(noPace({ query: 'q', kb_ids: ['kb_1'] }, {})).rejects.toThrow('对话端点返回 400')
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
    const pending = noPace({ query: 'q', kb_ids: ['kb_1'] }, { onDelta: (d) => (text += d) }).then(
      (value) => {
        handle = value
      },
    )
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
    const pending = noPace({ query: 'q', kb_ids: ['kb_1'] }, {}, controller.signal)
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
    await noPace({ query: 'q', kb_ids: ['kb_1'] }, { onError: (m) => seen.push(m) })
    await settle()

    expect(seen).toEqual(['上游 500'])
  })

  it('流干净结束却没有 done/error 时明确报错，不留一个空回答', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse([''])),
    )

    let message = ''
    await noPace({ query: 'q', kb_ids: ['kb_1'] }, { onError: (m) => (message = m) })
    await settle()

    expect(message).toContain('没有返回任何内容')
  })

  it('流结束但没有 done 时，把增量累积的结果当答案交付', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse([events([{ type: 'delta', text: '半句' }])])),
    )

    let answer = ''
    await noPace({ query: 'q', kb_ids: ['kb_1'] }, { onDone: (a) => (answer = a) })
    await settle()

    expect(answer).toBe('半句')
  })

  it('平滑模式：整段一次到达也分拍显示，排空后才交付全文', async () => {
    vi.useFakeTimers()
    try {
      const body = events([
        { type: 'sources', items: [source(1), source(2)] },
        { type: 'delta', text: 'x'.repeat(1200) },
        { type: 'done', answer: 'x'.repeat(1200) },
      ])
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => sseResponse([body])),
      )

      let text = ''
      let answer = ''
      await chatStream(
        { query: 'q', kb_ids: ['kb_1'] },
        {
          onDelta: (chunk) => (text += chunk),
          onDone: (value) => (answer = value),
        },
      )
      // 100ms：事件早收下了，但节流层只吐了一小截
      await vi.advanceTimersByTimeAsync(100)
      expect(text.length).toBeGreaterThan(0)
      expect(text.length).toBeLessThan(600)
      expect(answer).toBe('')

      await vi.advanceTimersByTimeAsync(6000)
      expect(text).toHaveLength(1200)
      expect(answer).toHaveLength(1200)
    } finally {
      vi.useRealTimers()
    }
  })

  it('approval 事件带齐确认条要显示的东西，并且立刻派发', async () => {
    // 这一条是"后端停下来问了"的唯一信号：漏掉它界面上会什么都没有，
    // 而那一轮在后端一直等到超时（用户看到的就是"卡住了"）
    const body = events([
      {
        type: 'approval',
        approval_id: 'ap_1',
        tool: 'run_command',
        label: '执行命令',
        args: 'git status --short',
        detail: '在 bwrap 隔离里执行；已断网',
        rule: 'Bash(git:*)',
        timeout_seconds: 120,
      },
      { type: 'done', answer: '' },
    ])
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse([body])),
    )

    const seen: unknown[] = []
    await chatStream({ query: 'q', kb_ids: [] }, { onApproval: (approval) => seen.push(approval) })

    expect(seen).toEqual([
      {
        approval_id: 'ap_1',
        tool: 'run_command',
        label: '执行命令',
        args: 'git status --short',
        detail: '在 bwrap 隔离里执行；已断网',
        rule: 'Bash(git:*)',
        timeout_seconds: 120,
      },
    ])
  })

  it('approval 事件里后端没给的可选字段补成空，界面不必到处判空', async () => {
    const body = events([
      { type: 'approval', approval_id: 'ap_2', tool: 'run_command', label: '执行命令', args: 'ls' },
      { type: 'done', answer: '' },
    ])
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse([body])),
    )

    let got: { detail: string; rule: string; timeout_seconds: number } | null = null
    await chatStream(
      { query: 'q', kb_ids: [] },
      {
        onApproval: (approval) => {
          got = approval
        },
      },
    )

    expect(got).toEqual({
      approval_id: 'ap_2',
      tool: 'run_command',
      label: '执行命令',
      args: 'ls',
      detail: '',
      rule: '',
      timeout_seconds: 0,
    })
  })

  it('isAbortError 只认 AbortError', () => {
    expect(isAbortError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true)
    expect(isAbortError(new Error('x'))).toBe(false)
    expect(isAbortError(null)).toBe(false)
  })
})

describe('重连锚点（P2-2）', () => {
  it('每一件带编号的事件都报一次锚点，且**排在那一件之后**', async () => {
    // 顺序不是小事：锚点的语义是"我已经处理到这儿了"。抢在事件之前记，
    // 断在刚收到一半时就会漏掉那一条（下次重连从更早的位置开始，重复一小段）
    const body = events([
      { type: 'sources', items: [source(1)] },
      { type: 'thinking', text: '想', seq: 11 },
      { type: 'step', phase: 'tool', label: '检索知识库', detail: '', status: 'done', seq: 12 },
      { type: 'delta', text: '答' },
      { type: 'done', answer: '答', seq: 13 },
    ])
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse([body])),
    )

    const order: string[] = []
    await noPace(
      { query: 'q', kb_ids: [] },
      {
        onSeq: (seq) => order.push(`seq:${seq}`),
        onStep: () => order.push('step'),
        onDone: () => order.push('done'),
      },
    )
    await settle()

    // 出处与正文增量没有编号（它们按位置跟着补发，不需要自己的号）
    expect(order).toEqual(['seq:11', 'step', 'seq:12', 'done', 'seq:13'])
  })

  it('一段思考的第一条带 logSeq，后继增量不带（界面靠它认段）', async () => {
    const body = events([
      { type: 'thinking', text: '先看看', seq: 3 },
      { type: 'thinking', text: '库里有什么' },
      { type: 'done', answer: '', seq: 4 },
    ])
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse([body])),
    )

    const seen: (number | undefined)[] = []
    const texts: string[] = []
    await noPace(
      { query: 'q', kb_ids: [] },
      {
        onThinking: (text, options) => {
          texts.push(text)
          seen.push(options?.logSeq)
        },
      },
    )

    expect(texts).toEqual(['先看看', '库里有什么'])
    expect(seen).toEqual([3, undefined])
  })

  it('done 带回来的 recovered / detail 原样交给界面（补发收口那一句）', async () => {
    const body = events([
      {
        type: 'done',
        answer: '答案在这里',
        recovered: true,
        detail: '这一轮已经收尾了：补发到此为止（正文增量不重发，这里给的是完整答复）。',
        seq: 9,
      },
    ])
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse([body])),
    )

    let got: { answer: string; recovered: boolean; detail: string } | null = null
    await noPace(
      { query: 'q', kb_ids: [] },
      {
        onDone: (answer, info) =>
          (got = { answer, recovered: info.recovered, detail: info.detail }),
      },
    )

    expect(got).toEqual({
      answer: '答案在这里',
      recovered: true,
      detail: '这一轮已经收尾了：补发到此为止（正文增量不重发，这里给的是完整答复）。',
    })
  })

  it('流断了走 onDropped（交给调用方接回来），没给它的调用方仍然收 onError', async () => {
    // 「断了」与「失败了」是两件事：P2-2 之后后端那一轮不归连接管，
    // 断流的正解是拿锚点接回来，而不是像真失败那样收摊
    const encoder = new TextEncoder()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(events([{ type: 'delta', text: '半截' }])))
            controller.error(new Error('连接被重置'))
          },
        })
        return new Response(stream, { status: 200 })
      }),
    )

    const dropped: string[] = []
    const errors: string[] = []
    await noPace({ query: 'q', kb_ids: [] }, { onDropped: (reason) => dropped.push(reason) })
    await settle()
    expect(dropped).toEqual(['连接被重置'])
    expect(errors).toEqual([])

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error('连接被重置'))
          },
        })
        return new Response(stream, { status: 200 })
      }),
    )
    await noPace({ query: 'q', kb_ids: [] }, { onError: (message) => errors.push(message) })
    await settle()
    expect(errors).toEqual(['连接被重置'])
  })
})

describe('openLiveTurn（P2-2 的重连端点）', () => {
  it('GET 到那条会话的 live 端点，锚点进 after，凭据照样带上', async () => {
    setSessionToken('tok_live')
    let url = ''
    let init: RequestInit = {}
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, options: RequestInit) => {
        url = input
        init = options
        return sseResponse([events([{ type: 'done', answer: '好', seq: 5 }])])
      }),
    )

    const seen: number[] = []
    await openLiveTurn('c 1/2', 42, { onSeq: (seq) => seen.push(seq) }, undefined, {
      smooth: false,
    })
    await settle()

    expect(url).toBe('/api/v1/chat/turns/c%201%2F2/live?after=42')
    expect(init.method).toBe('GET')
    // 这条链路同样绕过了 client.request，令牌得自己加
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok_live')
    expect(seen).toEqual([5])
    clearSessionToken()
  })

  it('锚点是 0 时不带 after（后端默认整圈补发）', async () => {
    let url = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        url = input
        return sseResponse([events([{ type: 'done', answer: '' }])])
      }),
    )

    await openLiveTurn('c1', 0, {}, undefined, { smooth: false })
    expect(url).toBe('/api/v1/chat/turns/c1/live')
  })

  it('端点报错时抛出后端那句文案（接不上的原因要看得见）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ code: 'not_found', message: '会话不存在' }), {
            status: 404,
          }),
      ),
    )

    await expect(openLiveTurn('c1', 0, {})).rejects.toThrow('会话不存在')
  })
})

describe('decideApproval', () => {
  it('POST 到那条确认的端点，并把决定原样放进请求体', async () => {
    // 端点是**按 id 拼出来的**：拼错了等于把决定发给一条不存在的确认（回 409），
    // 而界面上看起来只是"点了没反应"
    let url = ''
    let body = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init: RequestInit) => {
        url = input
        body = String(init.body)
        return new Response(JSON.stringify({ accepted: true, detail: '' }), { status: 200 })
      }),
    )

    const result = await decideApproval('ap 1/2', 'allow_always')

    expect(url).toBe('/api/v1/chat/approvals/ap%201%2F2')
    expect(JSON.parse(body)).toEqual({ decision: 'allow_always' })
    expect(result.accepted).toBe(true)
  })

  it('409（已经超时或点过一次）如实抛出后端那句话，不谎报"已执行"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ code: 'conflict', message: '这条确认已经失效了' }), {
            status: 409,
          }),
      ),
    )

    await expect(decideApproval('ap_1', 'allow_once')).rejects.toThrow('这条确认已经失效了')
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

describe('斜杠命令（P1-2）', () => {
  it('command 事件走 onCommand 单独派发，**不进正文**', async () => {
    // 命令的回话不是"助手说的话"：混进 answer 会让它变成一条回答，
    // 而"命令不进模型历史"这件事在界面上就靠这条分派来体现
    const body = events([
      { type: 'command', name: 'help', text: '可用命令：/mode…', ok: true },
      { type: 'done', answer: '' },
    ])
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse([body])),
    )

    const commands: ChatCommandResult[] = []
    const deltas: string[] = []
    let done: string | null = null
    await noPace(
      { query: '/help', kb_ids: [] },
      {
        onCommand: (result) => commands.push(result),
        onDelta: (text) => deltas.push(text),
        onDone: (answer) => {
          done = answer
        },
      },
    )

    expect(commands).toEqual([{ name: 'help', text: '可用命令：/mode…', ok: true }])
    expect(deltas).toEqual([])
    // 收尾仍然是 done，但**答案为空**——界面据此不建气泡
    expect(done).toBe('')
  })

  it('command 事件里的 action 原样带出来（界面据此开新会话 / 停掉这一轮）', async () => {
    const body = events([
      {
        type: 'command',
        name: 'mode',
        text: '已切到「计划」档',
        ok: true,
        action: { kind: 'mode', mode: 'plan', previousMode: 'build' },
      },
      { type: 'done', answer: '' },
    ])
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse([body])),
    )

    const commands: ChatCommandResult[] = []
    await noPace({ query: '/mode plan', kb_ids: [] }, { onCommand: (item) => commands.push(item) })

    expect(commands[0]?.action).toEqual({ kind: 'mode', mode: 'plan', previousMode: 'build' })
  })

  it('listCommands 只留能用的那批（被遮蔽的与坏掉的不进菜单）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              items: [
                { name: 'help', summary: '列出命令', usage: '/help', group: 'builtin' },
                { name: 'deploy', summary: '发版', usage: '/deploy', group: 'user' },
                // 被内置的同名命令遮蔽：列表端点里看得到（排错用），但菜单里不该出现
                { name: 'mode', usage: '/mode', group: 'user', shadowed_by: 'mode' },
                // 文件名不合法被丢弃：同样只留在列表里
                { name: 'bash_tool', usage: '/bash_tool', group: 'user', error: '命令名不合法' },
              ],
            }),
            { status: 200 },
          ),
      ),
    )

    const items = await listCommands()

    expect(items.map((item) => item.name)).toEqual(['help', 'deploy'])
    expect(items[0]?.short_circuit).toBe(true)
    expect(items[0]?.group).toBe('builtin')
  })

  it('命令端点读不到时返回空列表（菜单是顺手入口，不该把对话页变成错误提示）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ message: '没有这个端点' }), { status: 404 })),
    )

    await expect(listCommands()).resolves.toEqual([])
  })
})

describe('上下文用量（P1-3 的仪表）', () => {
  it('按来源分解：分解项与总数都取接口给的，一个都不自己算', async () => {
    let url = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        url = input
        return new Response(
          JSON.stringify({
            items: [
              { kind: 'messages', label: '对话消息', chars: 1200, tokens: 400, share: 0.5 },
              { kind: 'skills', label: '技能目录', chars: 600, tokens: 200, share: 0.25 },
            ],
            used: 800,
            total: 32000,
            ratio: 0.025,
            compress_at: 25600,
            estimated: true,
            note: '按字符数估算：中日韩 1 字约 1 token…',
          }),
          { status: 200 },
        )
      }),
    )

    const usage = await getContextUsage('c 1')

    expect(url).toBe('/api/v1/chat/context-usage?conversation_id=c+1')
    expect(usage.used).toBe(800)
    expect(usage.total).toBe(32000)
    expect(usage.compress_at).toBe(25600)
    expect(usage.items.map((item) => [item.kind, item.label, item.tokens, item.share])).toEqual([
      ['messages', '对话消息', 400, 0.5],
      ['skills', '技能目录', 200, 0.25],
    ])
    // 估算这件事由接口说了算（界面上要把它照原样说出来）
    expect(usage.estimated).toBe(true)
    expect(usage.note).toContain('估算')
  })

  it('读不到就如实抛：不拿 0 冒充（那与"上下文是空的"看起来一模一样）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ message: '会话不存在' }), { status: 404 })),
    )

    await expect(getContextUsage('c1')).rejects.toThrow('会话不存在')
  })
})
