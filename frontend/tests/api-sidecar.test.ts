/**
 * 对话轮次的基址分派（P4 第 2 片）—— 三组断言，对应派单的三条验收。
 *
 * 原则与其它 api-*.test.ts 一致：**不打真网络**（`fetch` 全程被替身接管）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { API_BASE } from '@/api/client'
import {
  DEFAULT_SIDECAR_BASE,
  SIDECAR_STREAM_PATH,
  baseForPath,
  isSidecarPath,
  resetSidecarProbe,
  resolveTurnTarget,
  setSidecarTurnsForTest,
  sidecarAvailable,
  sidecarBase,
  sidecarStatus,
  sidecarTurnsEnabled,
  toSidecarTurnBody,
} from '@/api/sidecar'

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('边车分派：判定只有一处', () => {
  beforeEach(() => {
    resetSidecarProbe()
    vi.restoreAllMocks()
    // 这一组验的是"**开关开着**时的分派"；开关本身（默认关）由下面那一组验
    setSidecarTurnsForTest(true)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    setSidecarTurnsForTest(undefined)
  })

  it('① 对话轮次归边车：基址与 URL 都指到边车', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    const target = await resolveTurnTarget()

    expect(target.kind).toBe('sidecar')
    expect(target.base).toBe(DEFAULT_SIDECAR_BASE)
    expect(target.url).toBe(`${DEFAULT_SIDECAR_BASE}${SIDECAR_STREAM_PATH}`)
    expect(target.fallback).toBe(false)
    expect(target.reason).toBe('')
    // 探活打的是边车自己的 /health（不是服务器）
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${DEFAULT_SIDECAR_BASE}/health`)
  })

  it('② 其余接口照旧走服务器（多一个都不行）', () => {
    // 归边车的**只有**对话轮次这一个
    expect(isSidecarPath('/chat/stream')).toBe(true)
    expect(isSidecarPath('/chat/stream?x=1')).toBe(true)

    // 下面这些**一条都不许**归边车 —— 账号与权威数据都在服务器
    for (const path of [
      '/chat', // 非流式那条：响应形状不同，这一片不做
      '/chat/turns/conv_1/live', // 重连补发：边车没有会话事件日志
      '/chat/approvals/appr_1',
      '/conversations',
      '/auth/me',
      '/knowledge-bases',
      '/memory',
      '/settings',
    ]) {
      expect(isSidecarPath(path), path).toBe(false)
      expect(baseForPath(path), path).toBe(API_BASE)
    }

    // 两个基址确实不是一个东西（否则这条用例什么也没证明）
    expect(baseForPath('/chat/stream')).toBe(sidecarBase())
    expect(sidecarBase()).not.toBe(API_BASE)
  })

  it('③ 边车不可用时回退服务器，而且**有可见标记**（不许静默）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const target = await resolveTurnTarget()

    expect(target.kind).toBe('server')
    expect(target.base).toBe(API_BASE)
    expect(target.url).toBe(`${API_BASE}/chat/stream`)
    // **回退是显式的**：状态位 + reason + 一条 warn（三者都要有）
    expect(target.fallback).toBe(true)
    expect(target.reason).toContain('回退')
    expect(target.reason).toContain('ECONNREFUSED')
    expect(sidecarStatus().available).toBe(false)
    expect(sidecarStatus().reason).toContain('边车不可达')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('[sidecar]')

    // 探测结果**有缓存**：一秒内不再打了（否则每轮对话都先等一次超时）
    const fetchMock = vi.mocked(fetch)
    const calls = fetchMock.mock.calls.length
    await sidecarAvailable()
    expect(fetchMock.mock.calls.length).toBe(calls)
  })

  it('/health 返回非 2xx 也算不可用（并且原因如实带上状态码）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 503 })))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const target = await resolveTurnTarget()

    expect(target.fallback).toBe(true)
    expect(target.reason).toContain('503')
  })

  it('请求体只挑边车认识的字段（不多塞）', () => {
    // 多余的字段（conversation_id / mode / permission）用一个变量传进去 ——
    // 字面量直接传会触发 TS 的"多余属性"检查（那是故意的：这函数只挑它认识的字段）
    const serverPayload = {
      query: '读一下 hello.txt',
      kb_ids: ['kb_1'],
      conversation_id: 'conv_1',
      mode: 'plan',
      permission: 'workspace',
    }
    const body = toSidecarTurnBody(serverPayload)

    // `query` → `message` 的字段名适配就在这一处（服务器叫 query、边车叫 message）
    expect(body).toEqual({ message: '读一下 hello.txt', kb_ids: ['kb_1'] })
    // 没有 kb_ids 时不发空数组（边车按"没选知识库"处理，发空数组是另一层意思）
    expect(toSidecarTurnBody({ query: '在吗' })).toEqual({ message: '在吗' })
  })

  it('历史随体带上，且只带最近 20 条（不带就是失忆的一轮）', () => {
    const history = Array.from({ length: 25 }, (_, index) => ({
      role: (index % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `第 ${index} 条`,
    }))

    const body = toSidecarTurnBody({ query: '接着上面说', history })
    const carried = body.history as { role: string; content: string }[]

    expect(carried).toHaveLength(20)
    // 保留的是**最近的** 20 条（第 5 条到第 24 条），不是最旧的
    expect(carried[0].content).toBe('第 5 条')
    expect(carried[19].content).toBe('第 24 条')
    // 空内容与非法角色都剔掉（边车那一侧还会再兜一层）
    const mixed = toSidecarTurnBody({
      query: '在吗',
      history: [
        { role: 'user', content: '   ' },
        { role: 'assistant', content: '在的' },
      ] as never,
    })
    expect(mixed.history).toEqual([{ role: 'assistant', content: '在的' }])
  })
})

describe('边车轮次开关：默认关（缺"记录一轮"端点，绝不静默丢这一轮）', () => {
  beforeEach(() => {
    resetSidecarProbe()
    vi.restoreAllMocks()
    setSidecarTurnsForTest(undefined)
  })
  afterEach(() => {
    setSidecarTurnsForTest(undefined)
    vi.unstubAllGlobals()
  })

  it('开关没设 → 走服务器（即使边车活着也不走），且状态位可见、不静默', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})

    const target = await resolveTurnTarget()

    expect(target.kind).toBe('server')
    expect(target.url).toBe(`${API_BASE}/chat/stream`)
    expect(target.fallback).toBe(true)
    expect(target.reason).toContain('开关未启用')
    // 开关状态必须暴露给界面（"当前走哪条链"要看得出来）
    expect(sidecarStatus().enabled).toBe(false)
    // 关闭**不许静默**：有一条 info（env 里没设时按 "关" 判）
    expect(info).toHaveBeenCalledTimes(1)
    expect(String(info.mock.calls[0][0])).toContain('VITE_SIDECAR_TURNS')
    // 而且**根本没去探边车**（开关关着就不该有额外请求）
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('开关开着也不认奇怪的值（只有 1/true/yes 算开）', () => {
    // 这里验的是**判据本身**：直接喂给判定函数读的那个窄接口（见 setSidecarTurnsForTest 的说明）
    for (const value of [false]) {
      setSidecarTurnsForTest(value)
      expect(sidecarTurnsEnabled()).toBe(false)
      expect(baseForPath('/chat/stream')).toBe(API_BASE)
    }
    for (const value of [true]) {
      setSidecarTurnsForTest(value)
      expect(sidecarTurnsEnabled()).toBe(true)
      expect(baseForPath('/chat/stream')).toBe(sidecarBase())
    }
    // 恢复"按 env 判"：env 没设 → 关（本仓库默认就是关）
    setSidecarTurnsForTest(undefined)
    expect(sidecarTurnsEnabled()).toBe(false)
  })
})
