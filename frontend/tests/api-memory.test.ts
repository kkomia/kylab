/**
 * 记忆接口（`api/memory.ts`）——**真发请求、真解析响应**的那条链路
 * （新前端的其它用例都把这层 mock 掉了）。
 *
 * 钉的是 **wire 形状**：URL / 路径编码 / 方法 / 请求体。档案制三期之后这一层
 * 有两件事必须一起钉住：
 *
 * 1. **整份文件覆盖那条路已经删掉**（`PUT`/`DELETE /memory/files/{path}`，§6.3）：
 *    这里不再有 `writeMemoryFile` / `deleteMemoryFile`，也就没有 PUT/DELETE 的断言
 *    —— 留一条"确认没有 PUT"的断言比写一条正向断言更值；
 * 2. **写入只有按条目这一条路**：改一条走 `remember` 带 `replaces`、删一条走 `forget`、
 *    还原走 `restore`、组改名走 `group`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  forgetMemory,
  getMemoryArchive,
  getMemoryChanges,
  getMemoryFile,
  migrateMemory,
  organizeMemoryDraft,
  rememberMemory,
  renameMemoryGroup,
  restoreMemory,
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

  it('档案卡读的是 /memory/archive', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url)
        return jsonResponse({
          path: 'PROFILE.md',
          updated: '2026-10-04',
          budget: { entries: 0, chars: 0, entry_limit: 60, char_limit: 4000 },
          sections: [],
          draft: { exists: false, path: 'import-draft.md', entries: 0 },
          migration_available: false,
        })
      }),
    )

    await getMemoryArchive()

    expect(calls[0]).toContain('/memory/archive')
  })

  it('变更流读的是 /memory/changes，并把 changes 取出来', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url)
        return jsonResponse({
          changes: [
            {
              index: 0,
              at: '2026-10-04 09:00',
              action: '顶替',
              section: '长期偏好与风格',
              source: '界面',
              old: '旧值',
              new: '新值',
              restorable: true,
            },
          ],
        })
      }),
    )

    const changes = await getMemoryChanges()

    expect(calls[0]).toContain('/memory/changes')
    expect(changes[0].action).toBe('顶替')
    expect(changes[0].old).toBe('旧值')
  })

  it('改一条走 remember，带 replaces 与 section', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ action: 'replaced', receipt: '改成：新', text: '新', entries: 1 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await rememberMemory('新', { section: '长期偏好与风格', replaces: '旧' })

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/memory/remember')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({
      content: '新',
      section: '长期偏好与风格',
      replaces: '旧',
    })
    expect(result.action).toBe('replaced')
  })

  it('删一条走 forget，把原文放在 topic 里', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ action: 'forgotten', receipt: '忘掉了：X', text: 'X', entries: 0 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await forgetMemory('X')

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/memory/forget')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ topic: 'X' })
  })

  it('还原把旧值放在 text 里', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ action: 'restored', receipt: '还原成：旧', text: '旧', entries: 1 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await restoreMemory('旧')

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/memory/restore')
    expect(JSON.parse(String(init.body))).toEqual({ text: '旧' })
  })

  it('组改名把老名字与新名字都交给后端', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ action: 'replaced', receipt: '改成：新组', text: '新组', entries: 2 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await renameMemoryGroup('进行中的项目', '内网知识库', '内网部署')

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/memory/group')
    expect(JSON.parse(String(init.body))).toEqual({
      section: '进行中的项目',
      old: '内网知识库',
      new: '内网部署',
    })
  })

  it('迁移是 POST /memory/migrate', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ added: 3, replaced: 0, existing: 1, skipped: false }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const report = await migrateMemory()

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/memory/migrate')
    expect(init.method).toBe('POST')
    expect(report.added).toBe(3)
  })

  it('整理初稿是 POST /memory/draft/organize，把 items 取出来', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        items: [{ text: '用户要求先给结论。', section: '长期偏好与风格' }],
        note: '这些还只是建议。',
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await organizeMemoryDraft()

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/memory/draft/organize')
    expect(init.method).toBe('POST')
    expect(result.items).toEqual([{ text: '用户要求先给结论。', section: '长期偏好与风格' }])
  })
})
