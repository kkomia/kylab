import { afterEach, describe, expect, it, vi } from 'vitest'

import { createConversation } from '@/api/conversations'

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

afterEach(() => {
  vi.unstubAllGlobals()
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
