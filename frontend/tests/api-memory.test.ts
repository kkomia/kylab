/**
 * 记忆接口（`api/memory.ts`）——**真发请求、真解析响应**的那条链路
 * （新前端的其它用例都把这层 mock 掉了）。
 *
 * 钉的是 **wire 形状**：URL / 路径编码 / 方法 / 请求体 / 查询参数。v0.57 起后端是
 * mem0，记忆是**一条一条的条目**（每条有 id），所以这一层有两件事必须钉住：
 *
 * 1. **按 id 改 / 删**：`PATCH` / `DELETE /memory/items/{id}`，id 要按段编码；
 * 2. **档案制那几个端点已经删掉**：`/archive` `/changes` `/remember` `/forget`
 *    `/restore` `/group` `/migrate` `/draft/organize` —— 留一条"确认没有它们"的断言
 *    比写一条正向断言更值（它们不该以任何形态回来）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createMemoryItem,
  deleteMemoryItem,
  getMemory,
  getMemoryFile,
  getMemoryItemHistory,
  getMemoryItems,
  importLegacyMemory,
  updateMemoryItem,
} from '@/api/memory'
import { setLocalDataForTest } from '@/api/sidecar'

/** 造一个返回固定 JSON 的响应。 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * 这一份钉的是 **wire 形状**（URL / 路径编码 / 响应解析），与"这份数据在哪台"无关：
 * 把本机数据面**显式关掉**（`VITE_LOCAL_DATA=0` 那条逃生门），`requestLocal` 就退回
 * 服务器那条链，路径仍然是 `/api/v1/...` —— 形状一字不变，下面这些断言才继续说问题。
 */
beforeEach(() => setLocalDataForTest(false))

afterEach(() => {
  vi.unstubAllGlobals()
  setLocalDataForTest(undefined)
})

describe('memory api', () => {
  it('文件路径里的斜杠保持原样，交给后端的 :path 参数接住', async () => {
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

    await getMemoryFile('digest/a b#c.md')

    expect(calls[0]).toContain('/memory/files/digest/a%20b%23c.md')
  })

  it('状态读的是 /memory', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url)
        return jsonResponse({ status: { enabled: true, items: 0 } })
      }),
    )

    const body = await getMemory()

    expect(calls[0]).toContain('/memory')
    expect(body.status.enabled).toBe(true)
  })

  it('列条目不带 query 时是干净的一行 URL', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url)
        return jsonResponse({ query: '', items: [], total: 0, note: '' })
      }),
    )

    const body = await getMemoryItems()

    expect(calls[0]).toContain('/memory/items')
    expect(calls[0]).not.toContain('?')
    expect(body.items).toEqual([])
  })

  it('检索把 query 与 limit 放进查询串（空值不发）', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url)
        return jsonResponse({
          query: '先给结论',
          items: [{ id: 'm1', text: '用户要求先给结论' }],
          total: 1,
          note: '这是**长期记忆**',
        })
      }),
    )

    const body = await getMemoryItems('  先给结论  ', 20)

    expect(calls[0]).toContain('query=%E5%85%88%E7%BB%99%E7%BB%93%E8%AE%BA')
    expect(calls[0]).toContain('limit=20')
    expect(body.items?.[0].id).toBe('m1')
    expect(body.note).toContain('长期记忆')
  })

  it('加一条走 POST /memory/items，带上 section 与 replaces', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ action: 'replaced', receipt: '改成：新', text: '新', item_id: 'm1' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await createMemoryItem('新', { section: '长期偏好与风格', replaces: '旧' })

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/memory/items')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({
      content: '新',
      section: '长期偏好与风格',
      replaces: '旧',
    })
    expect(result.action).toBe('replaced')
    expect(result.item_id).toBe('m1')
  })

  it('加一条不带可选项时两个字段是空串（而不是缺字段）', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ action: 'added', receipt: '记下了' }))
    vi.stubGlobal('fetch', fetchMock)

    await createMemoryItem('新')

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ content: '新', section: '', replaces: '' })
  })

  it('改一条是 PATCH /memory/items/{id}，id 要按段编码', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ action: 'replaced', receipt: '改成：新' }))
    vi.stubGlobal('fetch', fetchMock)

    await updateMemoryItem('a b/c', { content: '新' })

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/memory/items/a%20b%2Fc')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(String(init.body))).toEqual({ content: '新', section: '' })
  })

  it('删一条是 DELETE /memory/items/{id}', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ action: 'forgotten', receipt: '忘掉了：X', text: 'X', item_id: 'm1' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await deleteMemoryItem('m1')

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/memory/items/m1')
    expect(init.method).toBe('DELETE')
    expect(result.action).toBe('forgotten')
  })

  it('历史读的是 /memory/items/{id}/history，把 items 取出来', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url)
        return jsonResponse({
          id: 'm1',
          items: [
            { at: '2026-10-04 09:00', event: 'ADD', old: '', new: '用户要求先给结论' },
            { at: '2026-10-04 09:05', event: 'UPDATE', old: '用户要求先给结论', new: '改成' },
          ],
        })
      }),
    )

    const history = await getMemoryItemHistory('m1')

    expect(calls[0]).toContain('/memory/items/m1/history')
    expect(history.items?.[0].event).toBe('ADD')
    expect(history.items?.[1].old).toBe('用户要求先给结论')
  })

  it('迁移是 POST /memory/import-legacy', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ source: 'PROFILE.md', entries: 4, imported: 3, existing: 1 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const report = await importLegacyMemory()

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/memory/import-legacy')
    expect(init.method).toBe('POST')
    expect(report.imported).toBe(3)
  })

  it('档案制那几个入口不再出现在这一层', async () => {
    // 正向断言谁都写得出，但"它不该回来"只能这样钉：包里的导出项一旦多出一个旧名字，
    // 这里就红——否则它会一路走到线上才以 404 的形式露出来。
    const api = await import('@/api/memory')
    const removed = [
      'getMemoryArchive',
      'getMemoryChanges',
      'rememberMemory',
      'forgetMemory',
      'restoreMemory',
      'renameMemoryGroup',
      'migrateMemory',
      'organizeMemoryDraft',
      'recallMemory',
    ]

    for (const name of removed) {
      expect(Object.keys(api)).not.toContain(name)
    }
  })
})
