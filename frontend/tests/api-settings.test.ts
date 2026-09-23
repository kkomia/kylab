/**
 * 聊天档位（`api/settings.ts`）——**从旧 Vue 版 `tests/unit/api/settings.test.ts` 整份搬来的**
 * （实现同一份代码，只把会话令牌的 import 路径换到 `@/lib/session`）。
 *
 * 新前端的其它用例都把这层 mock 掉了，这一份是**真发请求、真解析响应**的那条链路。
 */
/**
 * 「Agent 模式」在接口层的两个调用（v0.43，§12.225 的 P1-1）。
 *
 * 这一条钉的是**键名**：界面上一切都对、只有键写错了的那种故障（显示"已保存"、
 * 而引擎那一档没变）在别的用例里是看不见的——`ModePicker` 只知道自己调了
 * `setChatMode`，不知道它最终 PATCH 的是哪一项。四档的语义在
 * `backend/app/services/modes.py`，这里只管 wire 上那一项的名字与取值。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SettingsView } from '@/api/settings'
import { CHAT_MODE_KEY, getChatMode, setChatMode } from '@/api/settings'

/** 造一个返回固定 JSON 的响应。 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function view(mode: string, withField = true): SettingsView {
  return {
    groups: [
      {
        key: 'chat',
        label: '对话行为',
        fields: withField
          ? [
              {
                key: CHAT_MODE_KEY,
                label: 'Agent 模式',
                type: 'select',
                value: mode,
                configured: true,
                options: [
                  { value: 'build', label: '构建（变更前确认）' },
                  { value: 'plan', label: '计划（先给计划再动手）' },
                ],
              },
            ]
          : [],
      },
    ],
    embedding_model_id: '',
    embedding_dim: 0,
    embedding_configured: true,
    embedding_is_development: false,
    rerank_enabled: false,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('chat.mode 的读写', () => {
  it('读的是设置页那一项：当前档与四档候选都从 /settings 里取', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(view('plan'))),
    )

    const result = await getChatMode()

    expect(result.mode).toBe('plan')
    expect(result.options.map((option) => option.value)).toEqual(['build', 'plan'])
  })

  it('后端没有这一项时给空值，让控件自己决定不显示（而不是编一个默认档）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(view('', false))),
    )

    const result = await getChatMode()

    expect(result.mode).toBe('')
    expect(result.options).toEqual([])
  })

  it('写的是同一个键：PATCH /settings 带 chat.mode', async () => {
    const bodies: unknown[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)))
        return jsonResponse({ updated: 1, rejected: [] })
      }),
    )

    const result = await setChatMode('yolo')

    expect(bodies[0]).toEqual({ values: [{ key: 'chat.mode', value: 'yolo' }] })
    expect(result.updated).toBe(1)
  })
})
