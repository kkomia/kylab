/**
 * 会话接口（`api/conversations.ts`）——**从旧 Vue 版 `tests/unit/api/conversations.test.ts` 整份搬来的**
 * （实现同一份代码，只把会话令牌的 import 路径换到 `@/lib/session`）。
 *
 * 新前端的其它用例都把这层 mock 掉了，这一份是**真发请求、真解析响应**的那条链路。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createConversation, importWorkspaceFile, listFiles } from '@/api/conversations'
import { setLocalDataForTest } from '@/api/sidecar'

function ok(): Response {
  return new Response(JSON.stringify({ id: 'conv_1' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function lastBody(): Record<string, unknown> {
  const call = vi.mocked(fetch).mock.calls.at(-1)
  return JSON.parse(String(call?.[1]?.body ?? '{}'))
}

/** 最后一次请求的地址（`request` 里的路径是相对的，`API_BASE` 已经拼上）。 */
function lastUrl(): string {
  return String(vi.mocked(fetch).mock.calls.at(-1)?.[0] ?? '')
}

/**
 * 这一份钉的是 **wire 形状**（URL / 方法 / 请求体 / 响应解析），与"这份数据在哪台"无关：
 * 把本机数据面**显式关掉**（`VITE_LOCAL_DATA=0` 那条逃生门），`requestLocal` 就退回
 * 服务器那条链，路径仍然是 `/api/v1/...` —— 形状一字不变，下面这些断言才继续说问题。
 *
 * 本机档那条（真实基址、`/health` 先探一次、拿不到就**不回退**）由
 * `tests/unit/api/sidecar.test.ts` 钉 —— 判据在那边。
 */
beforeEach(() => setLocalDataForTest(false))

afterEach(() => {
  vi.unstubAllGlobals()
  setLocalDataForTest(undefined)
})

describe('createConversation', () => {
  it('带上思考偏好时写进请求体', async () => {
    const fetchMock = vi.fn(async () => ok())
    vi.stubGlobal('fetch', fetchMock)

    await createConversation(['kb_1'], 'mdl_1', {
      thinking: false,
      thinking_effort: 'high',
    })

    expect(lastBody()).toMatchObject({
      kb_ids: ['kb_1'],
      model_pk: 'mdl_1',
      thinking: false,
      thinking_effort: 'high',
    })
  })

  it('不带思考偏好时不发字段：让后端按"跟随全局默认"处理', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok()),
    )

    await createConversation(['kb_1'], null)

    const body = lastBody()
    expect(body).not.toHaveProperty('thinking')
    expect(body).not.toHaveProperty('thinking_effort')
    expect(body.model_pk).toBeNull()
  })

  it('thinking 为 false 也要发出去（不能被当成"没表态"丢掉）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok()),
    )

    await createConversation(['kb_1'], null, { thinking: false })

    expect(lastBody().thinking).toBe(false)
  })
})

/** 文件区一层目录的回答（字段给全，避免解析那一段掩盖了地址本身）。 */
function listing(): Response {
  return new Response(
    JSON.stringify({
      mode: 'object',
      label: '本会话的文件',
      path: '图表',
      parent: '',
      entries: [],
      truncated: false,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

describe('listFiles：两档的 path 都发出去（D20）', () => {
  it('会话档也带 path —— 会话档的层级在上传时那个相对路径里', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => listing()),
    )

    await listFiles('conv_1', '图表', 'conversation')

    // 这就是 D20 之前那处坏点：那时 `path` 只在 project 档才发，会话档点进目录永远是根
    expect(lastUrl()).toBe(
      '/api/v1/conversations/conv_1/files?scope=conversation&path=%E5%9B%BE%E8%A1%A8',
    )
  })

  it('根那层不带 path（少一个空参数）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => listing()),
    )

    await listFiles('conv_1', '', 'conversation')

    expect(lastUrl()).toBe('/api/v1/conversations/conv_1/files?scope=conversation')
  })
})

describe('importWorkspaceFile：「取进本会话」只把来源路径交给服务端', () => {
  it('POST 到 /files/import，体里只有 path，返回的是会话文件区那一行', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              key: 'art_9',
              name: 'docs/报告.md',
              is_dir: false,
              size_bytes: 6,
              modified_at: null,
              kind: 'md',
            }),
            { status: 201, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    )

    const entry = await importWorkspaceFile('conv_1', 'docs/报告.md')

    expect(lastUrl()).toBe('/api/v1/conversations/conv_1/files/import')
    expect(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.method).toBe('POST')
    expect(lastBody()).toEqual({ path: 'docs/报告.md' })
    expect(entry.key).toBe('art_9')
  })
})
