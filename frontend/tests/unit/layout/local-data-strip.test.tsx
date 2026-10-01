/**
 * 顶栏那条「我的数据在哪」（M2 阶段 4）——**三态都要看得见**。
 *
 * 为什么这条状态条值得一组用例：方案 §4.3 把"回退必须可见、不许静默"写成纪律，
 * 而"可见"只有**界面上真的有这句话**才算数（藏在 `console.warn` 里的不算）。
 * 三条断言分别对应三种形态：
 *
 * 1. **本机**（壳里问到边车、`/health` 也通）：说得出打的是哪个基址；
 * 2. **本机后端未启动**（壳在、边车没起来）：那句话与"未回退服务器"都在，
 *    并且给一颗「重试」——那是唯一一种"再试一次可能就好了"的情形；
 * 3. **服务器**（`VITE_LOCAL_DATA=0` 显式关）：说清是哪个变量关的，而且**一次都不探**。
 *
 * 判据与 `api/sidecar.test.ts` 同源（同一份 `localStatus()`），这里验的是**它有没有被显示**。
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetSidecarProbe, setLocalDataForTest } from '@/api/sidecar'
import { LocalDataStrip } from '@/features/layout/LocalDataStrip'

function okJson(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** 一份 JSON 响应（第二行那三笔账要真读一次 `/local/status`）。 */
function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 壳的 IPC 替身（回答可以中途换：那颗「重试」就是靠它验的）。 */
function stubShell(answer: { port?: number; base?: string } | null): void {
  vi.stubGlobal('__TAURI__', {
    core: {
      invoke: vi.fn(async () => answer),
    },
  })
}

beforeEach(() => {
  resetSidecarProbe()
  setLocalDataForTest(undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
  setLocalDataForTest(undefined)
  resetSidecarProbe()
})

describe('顶栏状态条', () => {
  it('① 本机：写「本机」与真实基址（端口顺延也看得见）', async () => {
    stubShell({ port: 8766, base: 'http://127.0.0.1:8766' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson()),
    )

    render(<LocalDataStrip />)

    await waitFor(() => expect(screen.getByText('本机')).toBeInTheDocument())
    const strip = screen.getByRole('status')
    expect(strip.dataset.kind).toBe('local')
    expect(strip.textContent).toContain('http://127.0.0.1:8766')
    // 本机态没有「重试」（边车好好的，没有什么可重试的）
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
  })

  it('② 本机后端未启动：那句话在这儿，会话数据在哪也在这儿', async () => {
    stubShell(null)

    render(<LocalDataStrip />)

    await waitFor(() => expect(screen.getByText('本机后端未启动')).toBeInTheDocument())
    const strip = screen.getByRole('status')
    expect(strip.dataset.kind).toBe('unavailable')
    // reason 与 title 两处都要有（截断的是显示，不是事实）
    expect(strip.textContent).toContain('会话数据在本机，未回退服务器')
    expect(strip.getAttribute('title')).toContain('会话数据在本机，未回退服务器')
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })

  it('② 那颗「重试」真的重问一遍壳：边车起来后就翻成「本机」', async () => {
    stubShell(null)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okJson()),
    )
    render(<LocalDataStrip />)
    await waitFor(() => expect(screen.getByText('本机后端未启动')).toBeInTheDocument())

    // 用户把壳重启了一遍（或边车刚起来）：`force` 让"问壳"这一步重来，而不是吃缓存
    stubShell({ port: 8765, base: 'http://127.0.0.1:8765' })
    await userEvent.click(screen.getByRole('button', { name: '重试' }))

    await waitFor(() => expect(screen.getByText('本机')).toBeInTheDocument())
    expect(screen.getByRole('status').dataset.kind).toBe('local')
  })

  it('③ 显式关：写「服务器」+ 是哪个变量关的，且**一次都不探**', async () => {
    setLocalDataForTest(false)
    const fetchMock = vi.fn(async () => okJson())
    vi.stubGlobal('fetch', fetchMock)

    render(<LocalDataStrip />)

    await waitFor(() => expect(screen.getByText('服务器')).toBeInTheDocument())
    const strip = screen.getByRole('status')
    expect(strip.dataset.kind).toBe('server')
    expect(strip.textContent).toContain('VITE_LOCAL_DATA')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
    // 显式关不读本机那三笔账（那时本机档根本不成立）——第二行不该出现
    expect(screen.queryByTestId('local-import-accounts')).toBeNull()
  })

  it('④ 本机活着：第二行把导入的三笔账写出来（阶段 6）', async () => {
    stubShell({ port: 8765, base: 'http://127.0.0.1:8765' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/api/v1/local/status')
          ? json({
              deployment: 'local',
              data_dir: 'D:\\appdata',
              database: 'D:\\appdata\\kylab.db',
              database_exists: true,
              database_bytes: 1024,
              database_wal_bytes: 0,
              server_url: 'http://nas:8000/api/v1',
              imports: [
                {
                  batch_id: 'imp_1',
                  state: 'done',
                  source: 'http://nas:8000/api/v1',
                  counts: { created: 302, skipped: 0 },
                  error: '',
                  updated_at: null,
                },
              ],
              unfinished_imports: 1,
              unimported_file_references: 128,
              note: '会话落在本机 SQLite',
            })
          : okJson(),
      ),
    )

    render(<LocalDataStrip />)

    const line = await screen.findByTestId('local-import-accounts')
    // 三笔账都要看得见：批次 / 没跑完 / 未随导入的文件引用
    expect(line.textContent).toContain('导入 1 批')
    expect(line.textContent).toContain('新建 302')
    expect(line.textContent).toContain('1 批没跑完')
    expect(line.textContent).toContain('128 个文件引用没随导入')
    // 悬停那层写的是排障细节（库在哪、每一批的 id 与来源）
    expect(line.getAttribute('title')).toContain('D:\\appdata\\kylab.db')
    expect(line.getAttribute('title')).toContain('imp_1')
  })

  it('⑤ 本机活着但状态读不到：如实写一行，不静默', async () => {
    stubShell({ port: 8765, base: 'http://127.0.0.1:8765' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/api/v1/local/status') ? json({ message: '炸了' }, 500) : okJson(),
      ),
    )

    render(<LocalDataStrip />)

    const line = await screen.findByTestId('local-import-accounts-error')
    expect(line.textContent).toContain('本机状态读不到')
    expect(screen.queryByTestId('local-import-accounts')).toBeNull()
  })
})
