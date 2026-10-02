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
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetBackupStore, setBackupStatusForTest, type LocalBackup } from '@/api/backup'
import { resetKbCacheSupport } from '@/api/kbCache'
import { resetProviderStore, setProviderStatusForTest, type ProviderStatus } from '@/api/provider'
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

/**
 * 一份备份读数（M5 阶段 7，`GET /local/backup`）：顶栏第四行的判据。
 *
 * 默认是"ready 且队列空"——那一档**不显示**那一行（两边都安顿好了，不再占一行）。
 */
function backupPayload(overrides: Partial<LocalBackup> = {}): LocalBackup {
  return {
    provider: {
      state: 'ready',
      available: true,
      reason: '',
      checked_at: '2026-10-05T10:00:00Z',
      base_url: 'http://nas:8000',
      credential: 'configured',
      snapshot_available: true,
      snapshot_reason: '',
      enabled: true,
      include_workspace: false,
      every_hours: 24,
    },
    backlog: {
      queued: 0,
      bytes: 0,
      failed: 0,
      discarded: 0,
      oldest_created_at: null,
      last_error: '',
    },
    snapshots: [],
    ...overrides,
  }
}

/**
 * 把"备份那条读"接进替身：本机档里顶栏会顺带问一次 `/local/backup`，
 * 各用例的替身只关心自己那一条，所以统一在这里回一份读数（要别的档就 `setBackupStatusForTest`）。
 */
function withBackup(handler: (target: string) => Response | Promise<Response>) {
  return vi.fn(async (url: string) => {
    const target = String(url)
    if (target.includes('/local/backup')) return json(backupPayload())
    return handler(target)
  })
}

/** 一份 ready 的提供者状态（本机档的那条链）。 */
function providerStatus(overrides: Partial<ProviderStatus> = {}): ProviderStatus {
  return {
    state: 'ready',
    available: true,
    reason: '',
    checked_at: '2026-10-03T10:00:00Z',
    base_url: 'http://nas:8000/api/v1',
    credential: 'configured',
    protocol_version: 1,
    app_version: '0.1.1',
    knowledge_bases: [
      { id: 'kb_1', name: '论文' },
      { id: 'kb_2', name: '手册' },
    ],
    ...overrides,
  }
}

/**
 * 本机档那条完整链的网络替身：`/health` 通、`/local/status` 报 `deployment: 'local'`、
 * `/local/provider` 回提供者状态（`hang` 时永不回答 = "还没探过"那一档）。
 */
function stubProviderFetch(options: { hang?: boolean; provider?: unknown } = {}): void {
  const providerUrl = 'http://127.0.0.1:8765/api/v1/local/provider'
  vi.stubGlobal(
    'fetch',
    withBackup(async (url: string) => {
      const target = String(url)
      if (target.endsWith('/health')) return okJson()
      if (target.includes('/local/provider')) {
        if (options.hang) return new Promise<Response>(() => {})
        return json(options.provider ?? providerStatus())
      }
      if (target.endsWith('/api/v1/local/status')) {
        return json({
          deployment: 'local',
          data_dir: 'D:\\appdata',
          database: 'D:\\appdata\\kylab.db',
          database_exists: true,
          database_bytes: 1024,
          database_wal_bytes: 0,
          server_url: 'http://nas:8000/api/v1',
          imports: [],
          unfinished_imports: 0,
          unimported_file_references: 0,
          note: '会话落在本机 SQLite',
        })
      }
      throw new Error(`用例没预备这条请求：${providerUrl} / ${target}`)
    }),
  )
}

beforeEach(() => {
  resetSidecarProbe()
  setLocalDataForTest(undefined)
  resetProviderStore()
  resetBackupStore()
  resetKbCacheSupport()
})

afterEach(() => {
  vi.unstubAllGlobals()
  setLocalDataForTest(undefined)
  resetSidecarProbe()
  resetProviderStore()
  resetBackupStore()
})

describe('顶栏状态条', () => {
  it('① 本机：写「本机」与真实基址（端口顺延也看得见）', async () => {
    stubShell({ port: 8766, base: 'http://127.0.0.1:8766' })
    vi.stubGlobal(
      'fetch',
      withBackup(async () => okJson()),
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
      withBackup(async () => okJson()),
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
      withBackup(async (url: string) =>
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
      withBackup(async (url: string) =>
        url.endsWith('/api/v1/local/status') ? json({ message: '炸了' }, 500) : okJson(),
      ),
    )

    render(<LocalDataStrip />)

    const line = await screen.findByTestId('local-import-accounts-error')
    expect(line.textContent).toContain('本机状态读不到')
    expect(screen.queryByTestId('local-import-accounts')).toBeNull()
  })

  it('⑥ 知识库提供者 ready：**不**多那一行（可用时长什么样由侧栏那组回答）', async () => {
    stubShell({ port: 8765, base: 'http://127.0.0.1:8765' })
    vi.stubGlobal(
      'fetch',
      withBackup(async (url: string) =>
        url.includes('/local/provider') ? json(providerStatus()) : okJson(),
      ),
    )

    render(<LocalDataStrip />)

    await waitFor(() => expect(screen.getByText('本机')).toBeInTheDocument())
    // 等第一条本机状态行落地之后再断言：那一行**始终不该出现**
    await waitFor(() => expect(screen.queryByTestId('local-provider-line')).toBeNull())
  })

  it('⑦ 提供者连不上：那一行如实写原因，title 带地址/协议版本/库数/上次确认', async () => {
    stubShell({ port: 8765, base: 'http://127.0.0.1:8765' })
    setProviderStatusForTest(
      providerStatus({
        state: 'unavailable',
        available: false,
        reason: '连不上 http://nas:8000：连接被拒绝',
      }),
    )
    stubProviderFetch()

    render(<LocalDataStrip />)

    const line = await screen.findByTestId('local-provider-line')
    expect(line.textContent).toContain('知识库提供者不可用')
    expect(line.textContent).toContain('连接被拒绝')
    // 悬停那层是排障第一眼要看的那四项
    const title = line.getAttribute('title') ?? ''
    expect(title).toContain('http://nas:8000/api/v1')
    expect(title).toContain('协议版本：1')
    expect(title).toContain('看得见的库：2 个')
    expect(title).toContain('上次确认：2026-10-03T10:00:00Z')
  })

  it('⑧ 还没探过：写"正在确认知识库连接…"（不猜好坏）', async () => {
    stubShell({ port: 8765, base: 'http://127.0.0.1:8765' })
    stubProviderFetch({ hang: true })

    render(<LocalDataStrip />)

    const line = await screen.findByTestId('local-provider-line')
    expect(line.textContent).toContain('正在确认知识库连接')
  })

  it('⑨ 服务器档（deployment=server）：一次都不问提供者（那一档没有这个概念）', async () => {
    stubShell({ port: 8765, base: 'http://127.0.0.1:8765' })
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith('/api/v1/local/status')
        ? json({
            deployment: 'server',
            data_dir: 'D:\\appdata',
            database: 'D:\\appdata\\kylab.db',
            database_exists: false,
            database_bytes: 0,
            database_wal_bytes: 0,
            server_url: 'http://nas:8000/api/v1',
            imports: [],
            unfinished_imports: 0,
            unimported_file_references: 0,
            note: '',
          })
        : okJson(),
    )
    vi.stubGlobal('fetch', fetchMock)

    render(<LocalDataStrip />)

    await waitFor(() => expect(screen.getByText('本机')).toBeInTheDocument())
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/local/provider'))).toBe(
        false,
      ),
    )
    expect(screen.queryByTestId('local-provider-line')).toBeNull()
  })
})

/**
 * 非 ready 时那颗**入口**（M4 阶段 6 / D-A）：导航里没有知识库那一组，用户进知识库页
 * 只能靠它。判据是本机快照族那句 `available`——有才给入口（不摆一个点进去被弹回来的）。
 */
describe('顶栏状态条：非 ready 时那条入口', () => {
  /** 带路由的渲染：那颗入口是 `<Link>`（要有 Router 才画得出来）。 */
  function renderStripped() {
    return render(
      <MemoryRouter>
        <LocalDataStrip />
      </MemoryRouter>,
    )
  }

  /** `/local/kb-cache/knowledge-bases` 的替身（那一行的判据就这一条）。 */
  function stubWithSnapshot(available: boolean): void {
    stubShell({ port: 8765, base: 'http://127.0.0.1:8765' })
    vi.stubGlobal(
      'fetch',
      withBackup(async (url: string) => {
        const target = String(url)
        if (target.endsWith('/health')) return okJson()
        if (target.includes('/local/kb-cache/knowledge-bases')) {
          return json({
            available,
            resource: 'kb_list',
            scope_key: '',
            reason: '',
            items: available ? [{ id: 'kb_1', name: '论文' }] : [],
            payload: null,
            version: '',
            source: 'reader',
            fetched_at: available ? new Date(Date.now() - 4 * 60 * 1000).toISOString() : null,
            checked_at: null,
            stale: false,
            last_error: '',
            revalidating: false,
          })
        }
        if (target.includes('/local/provider')) {
          return json(
            providerStatus({
              state: 'unavailable',
              available: false,
              reason: '连不上 http://nas:8000：连接被拒绝',
            }),
          )
        }
        return json({
          deployment: 'local',
          data_dir: 'D:\\appdata',
          database: 'D:\\appdata\\kylab.db',
          database_exists: true,
          database_bytes: 1024,
          database_wal_bytes: 0,
          server_url: 'http://nas:8000/api/v1',
          imports: [],
          unfinished_imports: 0,
          unimported_file_references: 0,
          note: '',
        })
      }),
    )
  }

  it('⑩ 有那一份：多一颗去 `/knowledge-bases` 的入口（时间在悬停那层里）', async () => {
    setProviderStatusForTest(
      providerStatus({ state: 'unavailable', available: false, reason: '连不上' }),
    )
    stubWithSnapshot(true)

    renderStripped()

    const entry = await screen.findByTestId('local-kb-snapshot-entry')
    expect(entry).toHaveAttribute('href', '/knowledge-bases')
    expect(entry.textContent).toContain('看上次看到的知识库')
    const line = screen.getByTestId('local-provider-line')
    expect(line.getAttribute('title') ?? '').toContain('4 分钟前')
  })

  it('⑪ 本机什么都没有：**一个入口都不加**（点进去只会被弹回来）', async () => {
    setProviderStatusForTest(
      providerStatus({ state: 'unavailable', available: false, reason: '连不上' }),
    )
    stubWithSnapshot(false)

    renderStripped()

    const line = await screen.findByTestId('local-provider-line')
    await waitFor(() => expect(screen.queryByTestId('local-kb-snapshot-entry')).toBeNull())
    expect(line.textContent).toContain('知识库提供者不可用')
  })
})

/**
 * 第四行：备份（M5 阶段 7）。
 *
 * 这一行的判据是"**有待传项或提供者非 ready**"——两边都安顿好了（ready 且队列空）
 * 就不显示（重复侧栏与上一行只是噪音）。三档各钉一条，外加那条入口落在 `/backup`。
 */
describe('顶栏状态条：备份那一行（M5 阶段 7）', () => {
  function renderStripped() {
    return render(
      <MemoryRouter>
        <LocalDataStrip />
      </MemoryRouter>,
    )
  }

  it('⑫ ready 且队列空：**不**多那一行', async () => {
    stubShell({ port: 8765, base: 'http://127.0.0.1:8765' })
    setBackupStatusForTest(backupPayload())
    stubProviderFetch()

    renderStripped()

    await waitFor(() => expect(screen.getByText('本机')).toBeInTheDocument())
    await waitFor(() => expect(screen.queryByTestId('local-backup-line')).toBeNull())
  })

  it('⑬ 还有几份没备上去：那一行说清份数，并给一条去 `/backup` 的入口', async () => {
    stubShell({ port: 8765, base: 'http://127.0.0.1:8765' })
    setBackupStatusForTest(
      backupPayload({
        backlog: {
          queued: 2,
          bytes: 4096,
          failed: 1,
          discarded: 1,
          oldest_created_at: null,
          last_error: '连不上远端',
        },
      }),
    )
    stubProviderFetch()

    renderStripped()

    const line = await screen.findByTestId('local-backup-line')
    expect(line.textContent).toContain('还有 2 份没备上去')
    expect(line.textContent).toContain('一共丢过 1 份')
    const entry = within(line).getByRole('link', { name: '去备份页' })
    expect(entry).toHaveAttribute('href', '/backup')
  })

  it('⑭ 提供者连不上（队列空也一样显示）：原因写在这一行里', async () => {
    stubShell({ port: 8765, base: 'http://127.0.0.1:8765' })
    setBackupStatusForTest(
      backupPayload({
        provider: {
          state: 'unavailable',
          available: false,
          reason: '连不上那台 NAS：连接被拒绝',
          checked_at: '2026-10-05T10:00:00Z',
          base_url: 'http://nas:8000',
          credential: 'configured',
          snapshot_available: false,
          snapshot_reason: '',
          enabled: true,
          include_workspace: false,
          every_hours: 24,
        },
      }),
    )
    stubProviderFetch()

    renderStripped()

    const line = await screen.findByTestId('local-backup-line')
    expect(line.textContent).toContain('提供者不可用')
    expect(line.textContent).toContain('连接被拒绝')
    // 悬停那层与显示同一句话（截断的是显示，不是事实）
    expect(line.getAttribute('title')).toContain('没有没备上去的')
  })

  it('⑮ 备份状态读不到：如实写一行（不静默）', async () => {
    stubShell({ port: 8765, base: 'http://127.0.0.1:8765' })
    setBackupStatusForTest(null, { error: '本机后端未启动：边车没有应答' })
    stubProviderFetch()

    renderStripped()

    const line = await screen.findByTestId('local-backup-line')
    expect(line.textContent).toContain('备份状态读不到')
    expect(line.textContent).toContain('边车没有应答')
  })
})
