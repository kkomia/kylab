import { afterEach, describe, expect, it, vi } from 'vitest'

import { getMemoryFile, getMemoryGraph, writeMemoryFile } from '@/api/memory'

/** 造一个返回固定 JSON 的响应。 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * 记忆接口客户端（v0.14 三期）。
 *
 * 只钉一件事：**路径的编码方式**。它看着琐碎，错了两头都难查——
 * 斜杠编错了后端收不到（`digest/wiki/x.md` 变成一段 `digest%2Fwiki%2Fx.md`，
 * 路由匹配不上，直接 404）；该编的没编，文件名里的 `#` 会把 URL 截断
 * （`a#b.md` 变成路径 `a` 加一段 fragment，于是去读了一个不存在的文件）。
 */
describe('memory api', () => {
  it('路径里的斜杠保持原样，交给后端的 :path 参数接住', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url)
        return jsonResponse({ path: 'digest/wiki/锂价.md', content: '' })
      }),
    )

    await getMemoryFile('digest/wiki/锂价敏感性.md')

    expect(calls[0]).toContain(
      '/memory/files/digest/wiki/%E9%94%82%E4%BB%B7%E6%95%8F%E6%84%9F%E6%80%A7.md',
    )
    // 分隔符不能被编码：编了后端就匹配不到路由
    expect(calls[0]).not.toContain('%2F')
  })

  it('文件名里的 # 与空格要编码，否则 URL 会被截断', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url)
        return jsonResponse({ path: 'digest/a b#c.md', content: '' })
      }),
    )

    await writeMemoryFile('digest/a b#c.md', '# x')

    expect(calls[0]).toContain('/memory/files/digest/a%20b%23c.md')
  })

  it('写入走 PUT，正文放在 content 字段里', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ path: 'MEMORY.md', content: 'hi' }))
    vi.stubGlobal('fetch', fetchMock)

    await writeMemoryFile('MEMORY.md', 'hi')

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/memory/files/MEMORY.md')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(String(init.body))).toEqual({ content: 'hi' })
  })

  it('图谱读的是 /memory/graph', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url)
        return jsonResponse({ nodes: [], edges: [], dangling: [] })
      }),
    )

    await getMemoryGraph()

    expect(calls[0]).toContain('/memory/graph')
  })
})
