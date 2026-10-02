/**
 * 顶栏那条「我的数据在哪」（M2 阶段 4）——**三态都要看得见**。
 *
 * ## 这一份用例的**网络纪律**（阶段 8 门禁收口时加的，别删）
 *
 * 起因：⑮ 那条用例在门禁上红过一次，报出来的 error 是**真网络**的文本
 * （`本机后端未启动：边车不可达…：fetch failed`），而它注入的是另一句话。
 * 真因不是断言写错，而是**请求逃到了真网络**：
 *
 * - `requestLocal()` 的第一次 `fetch` **不在调用点上**：它要先 `resolveLocalBase()`
 *   （问壳要基址 + 探一次活），所以"这几行代码发出去的读"要过几拍才真打出去；
 * - 于是**上一条用例挂出去的读，可能在下一条用例里才打 fetch**。那时 `afterEach` 的
 *   `vi.unstubAllGlobals()` 已经把真 `fetch` 放回了 `globalThis` → 它真打网络。
 *   有边车时那次请求成功、没边车时失败，而失败结果会写进模块状态 →
 *   **这台机器上有没有边车在跑，决定了这条用例红不红**。
 *
 * 三条纪律一起兜住它（缺一条都会漏）：
 *
 * 1. `beforeEach` 先装一层**默认替身**（`/health` 通、其余一律抛错）：哪个用例忘了 stub
 *    也不会静默走真网络；
 * 2. `afterEach` **先把还在飞的链条走完**（`drain()`：让它在用例自己的替身下把 fetch 打完），
 *    再撤替身、装一层**"网络禁用"记账器**——真 `fetch` 从此不回 `globalThis`，
 *    任何漏出来的调用都被记进 `escapes` 并立刻抛错；
 * 3. 每条用例收尾对一次账（`expect(escapes).toEqual([])`）：漏了就是一条**带 URL 的**失败，
 *    而不是一条时红时绿的断言。
 *
 * 产品侧还有一道：`api/backup.ts` 的 `generation`（复位之后的旧请求一律作废），
 * 所以哪怕真有晚到的结论，也盖不掉复位之后摆好的状态。
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

import {
  backupView,
  loadBackupStatus,
  resetBackupStore,
  setBackupStatusForTest,
  type LocalBackup,
} from '@/api/backup'
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

/** 漏出替身的那些请求（按 URL 记下来）。**必须永远是空的**（见文件头那段）。 */
const escapes: string[] = []

/** 让还在飞的链条走完（它在**这一条用例自己的替身**下把 fetch 打完，于是不会漏到外面）。 */
async function drain(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * 这一层的**默认替身**：`/health` 通（探活那一趟），其余一律抛错。
 *
 * 各用例要的那几条（`/local/status`、`/local/provider`、`/local/backup`…）自己再 stub 一层
 * 盖上去；这一层管的是"忘了写的那一条不许静默走真网络"。
 */
function defaultFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const target = String(url)
      if (target.endsWith('/health')) return okJson()
      throw new Error(`这一份用例没预备这条请求：${target}`)
    }),
  )
}

beforeEach(() => {
  resetSidecarProbe()
  setLocalDataForTest(undefined)
  resetProviderStore()
  resetBackupStore()
  resetKbCacheSupport()
  defaultFetch()
})

afterEach(async () => {
  // 先把还在飞的链条走完（此时这一条用例的替身还在），再撤替身
  await drain()
  vi.unstubAllGlobals()
  // **真 `fetch` 不还回 `globalThis`**：换成一层记账器，漏出来的调用一条都跑不掉
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      escapes.push(String(url))
      throw new TypeError('这一份用例里不许打真网络')
    }),
  )
  setLocalDataForTest(undefined)
  resetSidecarProbe()
  resetProviderStore()
  resetBackupStore()
  expect(escapes).toEqual([])
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
    // **这一条自己一个备份请求都不发**（刚摆的状态在 TTL 内，组件不会自己去重读）——
    // 所以屏幕上那句话必须是注入的那句；它被盖掉只可能是**别的用例漏出来的请求**
    // （那正是这次收口要堵的那条缝，见文件头"网络纪律"）
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/local/backup'))).toBe(
      false,
    )
  })
})

/**
 * 晚到的读**不许盖掉复位之后**摆好的状态（`api/backup.ts` 的 `generation`）。
 *
 * 这两条是那次门禁红用例（⑮）的**确定性版本**：不靠机器快慢去赌"上一条用例的请求
 * 什么时候落地"，而是**把那条读攥在手里**——`/health` 那一拍由用例自己放行，
 * "晚到"于是可复现。判据：放行之后那条读无论成功还是失败，都不许写进状态。
 *
 * （真机上这一位管的是"复位之后界面又闪回旧结论"；在这里它把"这台机器上有没有边车"
 * 从这条用例的判据里彻底摘掉。）
 */
describe('晚到的读不许盖掉复位之后的状态（generation）', () => {
  /**
   * 一条"攥在手里"的读：`/health` 卡住直到放行；放行之后回一个**形状不认识**的 200
   * （于是那条读走 `fail` 那一支）。
   *
   * **闸门先建好**（不是等 fetch 被调用时才建）：`requestLocal` 要先 `await` 问壳那一步，
   * 所以"放行"完全可能发生在 fetch 还没被调用的时候——那时闸门已经开着，
   * 这根链条照样会自己走下去（用例不必去猜它走到哪儿了）。
   */
  function stubHeldHealth(): { release: () => void } {
    let open = false
    let openGate: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
      openGate = resolve
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const target = String(url)
        if (target.endsWith('/health')) {
          if (!open) await gate
          return okJson()
        }
        return json({ 这不是备份响应: true })
      }),
    )
    return {
      release: () => {
        open = true
        openGate?.()
      },
    }
  }

  it('① 复位（resetBackupStore）之后：旧请求的失败不许写进 error', async () => {
    stubShell({ port: 8765, base: 'http://127.0.0.1:8765' })
    const held = stubHeldHealth()
    const pending = loadBackupStatus() // 攥住：卡在 /health 上

    resetBackupStore() // 复位（用例之间的常态）
    await drain() // 让那条读走到 /health 上（卡住）
    held.release() // 放行：那条读继续走，最后失败
    await pending
    await drain()

    expect(backupView().error).toBe('')
    expect(backupView().data).toBeNull()
  })

  it('② 直接摆状态（setBackupStatusForTest）之后：旧请求的结论不许盖它', async () => {
    stubShell({ port: 8765, base: 'http://127.0.0.1:8765' })
    const held = stubHeldHealth()
    const pending = loadBackupStatus()

    setBackupStatusForTest(null, { error: '本机后端未启动：边车没有应答' }) // ⑮ 那一档
    await drain()
    held.release()
    await pending
    await drain()

    expect(backupView().error).toContain('边车没有应答')
  })
})
