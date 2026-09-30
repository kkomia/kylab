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
  sidecarTurnsEnabledFrom,
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
    // 这一组验的是"**开关开着**时的分派"；开关本身（默认开 / 显式关是逃生门）由下面那一组验
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

  it('请求体只挑边车认识的字段：conversation_id 要带，mode/permission 不带', () => {
    // 多余的字段（mode / permission）用一个变量传进去 ——
    // 字面量直接传会触发 TS 的"多余属性"检查（那是故意的：这函数只挑它认识的字段）
    const serverPayload = {
      query: '读一下 hello.txt',
      kb_ids: ['kb_1'],
      conversation_id: 'conv_1',
      mode: 'plan',
      permission: 'workspace',
    }
    const body = toSidecarTurnBody(serverPayload)

    // `query` → `message` 的字段名适配就在这一处（服务器叫 query、边车叫 message）；
    // `conversation_id` **必须带上**：边车靠它写回服务器——不带这一轮刷新就没了（2026-09-30 实测的丢数据）。
    expect(body).toEqual({
      message: '读一下 hello.txt',
      kb_ids: ['kb_1'],
      conversation_id: 'conv_1',
    })
    // mode / permission 边车没有对应语义，仍然不塞（多发只会让人以为它们生效了）
    expect(body).not.toHaveProperty('mode')
    expect(body).not.toHaveProperty('permission')
    // 没有 kb_ids / conversation_id 时不发空值（边车按"没选知识库 / 不写回"处理）
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

/**
 * 开关：**默认开** ✓，**显式关 = 逃生门** ✗。
 *
 * 为什么"默认开"这条能直接量、而"显式关"那条用窄接口：本模块读的是**构建期**那份
 * `import.meta.env` ✓，`vi.stubEnv` 改不到它 ✗（实测：开了 stub 仍然读到空值，
 * 见 `setSidecarTurnsForTest` 的说明 ✓）。所以分两处钉：
 *
 * - **不设变量**这种事**不用改环境** ✓ —— 测试环境里本来就没设（先断言这个前提 ✓）；
 * - **字面量怎么判**用纯函数 `sidecarTurnsEnabledFrom` 逐个喂 ✓，
 *   `resolveTurnTarget()` 那条分支则用同一个 override 驱动 ✓（走的是同一段代码 ✓）。
 */
describe('边车轮次开关：默认开，显式关是逃生门', () => {
  beforeEach(() => {
    resetSidecarProbe()
    vi.restoreAllMocks()
    setSidecarTurnsForTest(undefined)
  })
  afterEach(() => {
    setSidecarTurnsForTest(undefined)
    vi.unstubAllGlobals()
  })

  it('① 不设 VITE_SIDECAR_TURNS → 走边车（默认开），状态位说清打的是哪个基址', async () => {
    // 前提要显式：这个环境里**没设**那个变量（否则这条用例量的就不是"默认"了 ✗）
    expect(
      import.meta.env.VITE_SIDECAR_TURNS as string | undefined,
      '这条用例的前提：测试环境里没有设 VITE_SIDECAR_TURNS',
    ).toBeUndefined()
    const fetchMock = vi.fn().mockResolvedValue(okJson({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    expect(sidecarTurnsEnabled()).toBe(true)
    const target = await resolveTurnTarget()

    expect(target.kind).toBe('sidecar')
    expect(target.base).toBe(DEFAULT_SIDECAR_BASE)
    expect(target.url).toBe(`${DEFAULT_SIDECAR_BASE}${SIDECAR_STREAM_PATH}`)
    expect(target.fallback).toBe(false)
    // 走边车也要**说得清**（不是只有一个布尔值）：状态位带上实际基址
    const status = sidecarStatus()
    expect(status.enabled).toBe(true)
    expect(status.available).toBe(true)
    expect(status.reason).toContain('走边车')
    expect(status.reason).toContain(DEFAULT_SIDECAR_BASE)
  })

  it('② 显式关（逃生门）→ 走服务器，有 reason 与一条 info，且**根本不去探边车**', async () => {
    setSidecarTurnsForTest(false)
    const fetchMock = vi.fn().mockResolvedValue(okJson({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})

    const target = await resolveTurnTarget()

    expect(target.kind).toBe('server')
    expect(target.url).toBe(`${API_BASE}/chat/stream`)
    expect(target.fallback).toBe(true)
    // 文案要能区分"被显式关掉"与"边车没起来"（默认开之后，这两件事长得很像 ✗）
    expect(target.reason).toContain('显式关掉')
    expect(target.reason).toContain('逃生门')
    // 关闭**不许静默**：状态位 + 一条 info
    const status = sidecarStatus()
    expect(status.enabled).toBe(false)
    expect(status.reason).toContain('显式关掉')
    expect(info).toHaveBeenCalledTimes(1)
    expect(String(info.mock.calls[0][0])).toContain('VITE_SIDECAR_TURNS')
    // 开关关着就不该有额外请求（否则每轮白探一次）
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('③ 字面量判据：只有 0/false/no/off 关，其余（含不设、含空、含奇怪值）都开', () => {
    for (const raw of [undefined, '', '   ', '1', 'true', 'TRUE', 'yes', 'on', 'enabled']) {
      expect(sidecarTurnsEnabledFrom(raw), String(raw)).toBe(true)
    }
    for (const raw of ['0', 'false', 'FALSE', 'no', 'No', 'off', 'OFF', ' 0 ', '\tfalse\t']) {
      expect(sidecarTurnsEnabledFrom(raw), String(raw)).toBe(false)
    }
    // 与 override 那条路一致：关掉之后 `/chat/stream` 也回服务器
    setSidecarTurnsForTest(false)
    expect(sidecarTurnsEnabled()).toBe(false)
    expect(baseForPath('/chat/stream')).toBe(API_BASE)
    setSidecarTurnsForTest(true)
    expect(sidecarTurnsEnabled()).toBe(true)
    expect(baseForPath('/chat/stream')).toBe(sidecarBase())
  })

  it('④ 默认开但边车没起来 → 回退服务器，且**回退是显式的**（状态位 + warn）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const target = await resolveTurnTarget()

    expect(target.kind).toBe('server')
    expect(target.fallback).toBe(true)
    expect(target.reason).toContain('回退')
    const status = sidecarStatus()
    expect(status.enabled).toBe(true)
    expect(status.available).toBe(false)
    expect(status.reason).toContain('回退')
    expect(status.reason).toContain('ECONNREFUSED')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('⑤ 还没探过边车时不猜好坏：available=null，但仍然说清默认会先试边车', () => {
    const status = sidecarStatus()

    expect(status.enabled).toBe(true)
    expect(status.available).toBeNull()
    expect(status.reason).toContain('还没探过')
    expect(status.reason).toContain(DEFAULT_SIDECAR_BASE)
    // reason **不许空着**：三种状态都要能据它判断"当前走哪条链"
    expect(status.reason.length).toBeGreaterThan(0)
  })
})
