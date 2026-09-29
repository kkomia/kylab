/**
 * 设置接口（`api/settings.ts`）的 **wire 契约**：真发请求、真解析响应那条链路。
 *
 * 新前端的其它用例都把这层 mock 掉了（界面测试只关心"点了之后调了哪个函数"），
 * 所以这一份专门盯**接口形状**：URL、方法、请求体、响应解析。形状写错时界面那一层
 * 一切正常（照样显示"已保存"），只有真跑起来才发现没生效——这正是这份文件存在的理由。
 *
 * 原先钉的 `getChatMode` / `setChatMode` / `CHAT_MODE_KEY`（v0.43，§12.225 的 P1-1）
 * 在生产代码里**零调用**（全树只有它们自己与这份测试用），本轮清理已删；
 * 文件留下是因为它的存在理由不是那三个名字，而是上面那条"真发请求"的链路：
 * `updateSettings` 仍在三个界面上服役（`PermissionControl` / `SettingGroupPanel` /
 * `SettingsModal`），它钉的形状是 `PATCH /settings` 带 `{ values: [{ key, value }] }`。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { updateSettings } from '@/api/settings'

/** 造一个返回固定 JSON 的响应。 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** 一次请求的形状（写全签名：不写的话 `mock.calls[0]` 是空元组，断言参数时连索引都取不到）。 */
type FetchCall = (url: string, init?: RequestInit) => Promise<Response>

/** 装一个 fetch 替身并把它交出来：断言要看的正是"这次请求长什么样"。 */
function stubFetch(body: () => Response) {
  const fetchMock = vi.fn<FetchCall>(async () => body())
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('updateSettings 的 wire 形状', () => {
  it('PATCH /api/v1/settings，body 是 { values: [{ key, value }] }', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ updated: 2, rejected: [] }))

    const result = await updateSettings([
      { key: 'chat.permission', value: 'workspace' },
      { key: 'retrieval.top_k', value: '8' },
    ])

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/v1/settings')
    expect(init?.method).toBe('PATCH')
    // 顺序与内容原样过去：后端按数组逐项落库，顺序错了两项会互相盖掉
    expect(JSON.parse(String(init?.body))).toEqual({
      values: [
        { key: 'chat.permission', value: 'workspace' },
        { key: 'retrieval.top_k', value: '8' },
      ],
    })
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    // 响应原样解析成 `{ updated, rejected }`：界面用 `rejected` 决定要不要提示
    expect(result).toEqual({ updated: 2, rejected: [] })
  })

  it('空 values 照发（"一项都没改"不是错误，后端回 updated: 0）', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ updated: 0, rejected: [] }))

    const result = await updateSettings([])

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ values: [] })
    expect(result.updated).toBe(0)
  })

  it('后端驳回：rejected 里的键原样回给界面（哪一项没存下要能说清）', async () => {
    stubFetch(() => jsonResponse({ updated: 1, rejected: ['auth.api_key'] }))

    const result = await updateSettings([{ key: 'auth.api_key', value: 'bad' }])

    expect(result.rejected).toEqual(['auth.api_key'])
  })

  it('非 2xx：抛错，文案取后端信封里的 message（不是 HTTP 码）', async () => {
    stubFetch(() => jsonResponse({ code: 'bad_request', message: '值不合法' }, 400))

    await expect(updateSettings([{ key: 'k', value: 'v' }])).rejects.toThrow('值不合法')
  })
})
