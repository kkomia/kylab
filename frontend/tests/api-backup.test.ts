/**
 * 备份的状态层（M5 阶段 7，`src/api/backup.ts`）。
 *
 * 这一份钉六件事——它们在界面上都"看不见"，但错了会处处不对：
 *
 * 1. **"还没读到"不猜**：`data` 初值必须是 `null`（界面按缺席渲染，不许先编一个
 *    "连不上"再改口）；三态（unconfigured → unavailable → ready）每一次结论都落状态；
 * 2. **两半各是各的**：`available`（NAS 通不通）与 `snapshot_available`（桶建好没有）
 *    分开带上来；而 `backlog` 与提供者状态**互不掩盖**（提供者不可用时队列照常有账）；
 * 3. **TTL 内不重读 / 强制重探走 PATCH**：`GET /local/backup` 没有 `refresh` 参数，
 *    「立即重探」= `PATCH` 空 body（后端端点自己的契约）；
 * 4. **广播**：PATCH 回来的整包立刻写进模块，订阅者当场看到（设置里那一节、备份页、
 *    顶栏那一行读的是同一份）；
 * 5. **轮询只在有事时**：提供者非 ready、或队列里还有没传上去的才每 30s 重读；
 *    两边都安顿好了不问；
 * 6. **这一档有没有这个概念**：服务器档里 `/local/backup` 是 404 → `gate` 为假
 *    （导航与设置那两节的入口都由它摘掉）。
 *
 * 网络一律替身（`fetch` + 壳的 IPC）：这些用例一条真请求都不该发出去。
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  BACKUP_POLL_MS,
  BACKUP_TTL_MS,
  backupGateApplies,
  backupView,
  createBackupSnapshot,
  deleteBackupPoint,
  getBackupPoints,
  getLocalBackup,
  loadBackupStatus,
  patchLocalBackup,
  refreshBackup,
  resetBackupStore,
  restoreBackupPoint,
  setBackupStatusForTest,
  useBackupStatus,
  type BackupBacklog,
  type BackupQueueRow,
  type LocalBackup,
} from '@/api/backup'
import { isLocalPath, LOCAL_PATHS, resetSidecarProbe, setLocalDataForTest } from '@/api/sidecar'

const SHELL_BASE = 'http://127.0.0.1:8766'
const BACKUP_URL = `${SHELL_BASE}/api/v1/local/backup`

function providerStatus(overrides: Partial<LocalBackup['provider']> = {}): LocalBackup['provider'] {
  return {
    state: 'ready',
    available: true,
    reason: '',
    checked_at: '2026-10-05T10:00:00Z',
    base_url: SHELL_BASE,
    credential: 'configured',
    snapshot_available: true,
    snapshot_reason: '',
    protocol_version: 1,
    app_version: '0.1.1',
    capabilities: { snapshot: { available: true, max_blob_bytes: 2 * 1024 ** 3 } },
    devices: [{ device_id: 'dev-1', snapshots: 1 }],
    ...overrides,
  }
}

function backlog(overrides: Partial<BackupBacklog> = {}): BackupBacklog {
  return {
    queued: 0,
    bytes: 0,
    failed: 0,
    discarded: 0,
    oldest_created_at: null,
    last_error: '',
    ...overrides,
  }
}

function row(overrides: Partial<BackupQueueRow> = {}): BackupQueueRow {
  return {
    id: 'dev-1-2026-10-05T10-00-00Z-abcdef12',
    created_at: '2026-10-05T10:00:00Z',
    kind: 'manual',
    state: 'pending',
    blob_bytes: 1024,
    attempts: 0,
    next_attempt_at: null,
    last_error: '',
    uploaded_at: null,
    remote_device_id: null,
    remote_snapshot_id: null,
    ...overrides,
  }
}

function payload(overrides: Partial<LocalBackup> = {}): LocalBackup {
  return { provider: providerStatus(), backlog: backlog(), snapshots: [], ...overrides }
}

function json(body: unknown, code = 200): Response {
  return new Response(JSON.stringify(body), {
    status: code,
    headers: { 'content-type': 'application/json' },
  })
}

/** 预备给 `/local/backup` 那条主路的回答队列（取空之后再被问到 = 用例写错了，直接炸）。 */
let answers: Array<Response | (() => Response)> = []
/** 打出去的那些请求。 */
let calls: string[] = []
/** 别的路径（恢复点 / 立即备份 / 恢复）按这个表回答。 */
let routes: Record<string, () => Response> = {}

function stubNetwork(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const target = String(url)
      const method = init?.method ?? 'GET'
      calls.push(`${method} ${target}`)
      if (target.endsWith('/health')) return json({ ok: true })
      const extra = Object.keys(routes).find((key) => target.includes(key))
      if (extra) return routes[extra]()
      if (!target.includes('/local/backup')) throw new Error(`用例没预备这条请求：${target}`)
      const next = answers.shift()
      if (!next) throw new Error(`用例没预备这条回答：${target}`)
      return typeof next === 'function' ? next() : next
    }),
  )
}

function backupCalls(): string[] {
  return calls.filter((call) => call.includes('/local/backup'))
}

beforeEach(() => {
  calls = []
  answers = []
  routes = {}
  resetSidecarProbe()
  resetBackupStore()
  setLocalDataForTest(undefined)
  vi.stubGlobal('__TAURI__', {
    core: { invoke: vi.fn(async () => ({ port: 8766, base: SHELL_BASE })) },
  })
  stubNetwork()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  resetSidecarProbe()
  resetBackupStore()
})

describe('① "还没读到"不猜 / 三态 / 两半各是各的', () => {
  it('还没读过：data 是 null、settled 是假（界面按缺席渲染，不先编一个"连不上"）', () => {
    expect(backupView().data).toBeNull()
    expect(backupView().provider).toBeNull()
    expect(backupView().settled).toBe(false)
    expect(backupView().ready).toBe(false)
  })

  it('三次迁移都落在模块状态上，且 ready 与 snapshotReady 是两个位', async () => {
    answers.push(
      json(
        payload({
          provider: providerStatus({ state: 'unconfigured', available: false, reason: '还没接上' }),
        }),
      ),
      json(
        payload({
          provider: providerStatus({
            state: 'unavailable',
            available: false,
            reason: '连不上那台 NAS',
          }),
        }),
      ),
      // ready 但**桶还没建好**：这两件事分开报，界面不许把它说成"连不上"
      json(
        payload({
          provider: providerStatus({ snapshot_available: false, snapshot_reason: '先把桶建出来' }),
        }),
      ),
    )

    await refreshBackup()
    expect(backupView().state).toBe('unconfigured')
    expect(backupView().ready).toBe(false)

    await refreshBackup()
    expect(backupView().state).toBe('unavailable')
    expect(backupView().reason).toBe('连不上那台 NAS')

    await refreshBackup()
    expect(backupView().ready).toBe(true)
    expect(backupView().snapshotReady).toBe(false)
    expect(backupView().provider?.snapshot_reason).toBe('先把桶建出来')
  })

  it('提供者不可用时队列照样有账（两半互不掩盖）', async () => {
    answers.push(
      json(
        payload({
          provider: providerStatus({
            state: 'unavailable',
            available: false,
            reason: '断网',
            snapshot_available: false,
          }),
          backlog: backlog({ queued: 2, failed: 1, discarded: 1, last_error: '连不上' }),
          snapshots: [row(), row({ id: 'b', state: 'failed', last_error: '连不上' })],
        }),
      ),
    )

    await loadBackupStatus()

    expect(backupView().ready).toBe(false)
    expect(backupView().backlog?.queued).toBe(2)
    expect(backupView().backlog?.discarded).toBe(1)
    expect(backupView().snapshots).toHaveLength(2)
    expect(backupView().snapshots[1]?.last_error).toBe('连不上')
  })

  it('响应形状不认识时当"读不到"处理（不把版本错配变成崩溃）', async () => {
    answers.push(json({ ok: true }))

    await loadBackupStatus()

    expect(backupView().data).toBeNull()
    expect(backupView().error).toContain('响应不认识')
  })

  it('一次读失败不清掉上一次的读数（队列数字不许闪成 0）', async () => {
    answers.push(json(payload({ backlog: backlog({ queued: 3 }) })))
    await loadBackupStatus()
    expect(backupView().backlog?.queued).toBe(3)

    // 下一次读失败（这一份用例没预备回答 = 网络那一层炸了）
    await refreshBackup()

    expect(backupView().backlog?.queued).toBe(3)
    expect(backupView().error).not.toBe('')
  })
})

describe('② 读数与重探走的是哪一条（GET 读结论 / PATCH 空 body 重探）', () => {
  it('loadBackupStatus 打 GET /local/backup', async () => {
    answers.push(json(payload()))

    await loadBackupStatus()

    expect(backupCalls()).toHaveLength(1)
    expect(backupCalls()[0]).toBe(`GET ${BACKUP_URL}`)
  })

  it('refreshBackup 走 PATCH 空 body（GET 那一条没有 refresh 参数）', async () => {
    answers.push(json(payload()))

    await refreshBackup()

    expect(backupCalls()).toHaveLength(1)
    expect(backupCalls()[0]).toBe(`PATCH ${BACKUP_URL}`)
    const fetchMock = vi.mocked(fetch)
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')
    expect(String(patch?.[1]?.body)).toBe('{}')
  })

  it(`TTL（${BACKUP_TTL_MS / 1000}s）内连着问两次只打一个请求`, async () => {
    answers.push(json(payload()))

    await loadBackupStatus()
    await loadBackupStatus()

    expect(backupCalls()).toHaveLength(1)
  })

  it('TTL 过了才肯再读一次', async () => {
    vi.useFakeTimers()
    answers.push(json(payload()), json(payload()))

    await loadBackupStatus()
    await vi.advanceTimersByTimeAsync(BACKUP_TTL_MS + 1_000)
    await loadBackupStatus()

    expect(backupCalls()).toHaveLength(2)
  })

  it('单飞：同一次重探并发发起也只打一个 PATCH', async () => {
    answers.push(json(payload()))

    await Promise.all([refreshBackup(), refreshBackup(), refreshBackup()])

    expect(backupCalls()).toHaveLength(1)
  })
})

describe('③ PATCH 白名单四键与广播', () => {
  it('四个键照发，回来的整包立刻写进模块（订阅者当场看到）', async () => {
    answers.push(json(payload({ provider: providerStatus({ base_url: 'http://nas:9000' }) })))
    setBackupStatusForTest(
      payload({ provider: providerStatus({ state: 'unavailable', available: false }) }),
    )
    /** 订阅者每次重渲染都记一笔：广播必须发生（设置里那一节与顶栏那一行靠它）。 */
    const seen: string[] = []
    const view = renderHook(() => {
      const current = useBackupStatus()
      seen.push(current.state)
      return current
    })
    const before = backupCalls().length

    await act(async () => {
      await patchLocalBackup({
        base_url: 'http://nas:9000',
        enabled: true,
        include_workspace: true,
        every_hours: 6,
      })
    })

    expect(backupCalls()[before]).toBe(`PATCH ${BACKUP_URL}`)
    const fetchMock = vi.mocked(fetch)
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({
      base_url: 'http://nas:9000',
      enabled: true,
      include_workspace: true,
      every_hours: 6,
    })
    expect(backupView().provider?.base_url).toBe('http://nas:9000')
    expect(seen).toContain('ready')
    view.unmount()
  })

  it('恢复默认：base_url 空串照发（空 = 回继承）', async () => {
    answers.push(json(payload({ provider: providerStatus({ base_url: '' }) })))
    const fetchMock = vi.mocked(fetch)

    await patchLocalBackup({ base_url: '' })

    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ base_url: '' })
  })
})

describe('④ 另外四条调用（立即备份 / 恢复点 / 删除 / 恢复）', () => {
  it('立即备份：POST /local/backup/snapshots，断网也会回 202（那一行 + 队列读数）', async () => {
    routes['/local/backup/snapshots'] = () =>
      json(
        {
          snapshot: row({ state: 'failed', last_error: '连不上远端' }),
          backlog: backlog({ queued: 1, failed: 1, last_error: '连不上远端' }),
        },
        202,
      )

    const result = await createBackupSnapshot()

    expect(calls.at(-1)).toBe(`POST ${SHELL_BASE}/api/v1/local/backup/snapshots`)
    expect(result.snapshot.state).toBe('failed')
    expect(result.backlog.queued).toBe(1)
  })

  it('恢复点清单：GET /local/backup/points，refresh=true 才带强制重取', async () => {
    routes['/local/backup/points'] = () =>
      json({
        state: 'ready',
        available: true,
        reason: '',
        items: [{ device_id: 'dev-1', snapshot_id: 's1', bytes: 10, created_at: 'x' }],
        total: 1,
        quota: { keep: 3, used_bytes: 10, quota_bytes: 100 },
      })

    const plain = await getBackupPoints()
    const forced = await getBackupPoints(true)

    const pointCalls = calls.filter((call) => call.includes('/local/backup/points'))
    expect(pointCalls[0]).toBe(`GET ${SHELL_BASE}/api/v1/local/backup/points`)
    expect(pointCalls[1]).toBe(`GET ${SHELL_BASE}/api/v1/local/backup/points?refresh=true`)
    expect(plain.items).toHaveLength(1)
    expect(forced.total).toBe(1)
  })

  it('恢复点清单取不到也是 200：判据是 available + reason（不是空清单）', async () => {
    routes['/local/backup/points'] = () =>
      json({
        state: 'unavailable',
        available: false,
        reason: '连不上那台 NAS',
        items: [],
        total: 0,
      })

    const result = await getBackupPoints()

    expect(result.available).toBe(false)
    expect(result.reason).toBe('连不上那台 NAS')
    expect(result.items).toEqual([])
  })

  it('删除：DELETE 那条路径，404 原样抛给调用方（界面据此说"本来就没有"）', async () => {
    routes['/local/backup/points/dev-1/s1'] = () => json({ message: '没有这一份' }, 404)

    await expect(deleteBackupPoint('dev-1', 's1')).rejects.toMatchObject({ status: 404 })
    expect(calls.at(-1)).toBe(`DELETE ${SHELL_BASE}/api/v1/local/backup/points/dev-1/s1`)
  })

  it('恢复：dry_run 与 overwrite_memory 照发，预演回来的 plan 原样带回', async () => {
    routes['/local/backup/restore'] = () =>
      json(
        {
          batch_id: '',
          state: 'planned',
          source: 'backup://dev-1/s1',
          dry_run: true,
          plan: { created: [{ conversation_id: 'c1' }], credentials_to_configure: ['NAS 的钥匙'] },
        },
        202,
      )
    const fetchMock = vi.mocked(fetch)

    const receipt = await restoreBackupPoint({
      device_id: 'dev-1',
      snapshot_id: 's1',
      dry_run: true,
      overwrite_memory: true,
    })

    const post = fetchMock.mock.calls.find(
      ([url, init]) => String(url).endsWith('/local/backup/restore') && init?.method === 'POST',
    )
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      device_id: 'dev-1',
      snapshot_id: 's1',
      dry_run: true,
      overwrite_memory: true,
    })
    expect(receipt.plan.credentials_to_configure).toEqual(['NAS 的钥匙'])
  })
})

describe('⑤ 本机档判据（不是"提供者 ready"）', () => {
  it('壳里（桌面档）：gate 为真——提供者连不上也算（那正是要看队列的时候）', async () => {
    answers.push(
      json(
        payload({
          provider: providerStatus({ state: 'unavailable', available: false }),
          backlog: backlog({ queued: 1 }),
        }),
      ),
    )

    await refreshBackup()

    expect(backupGateApplies()).toBe(true)
    expect(backupView().gate).toBe(true)
    expect(backupView().ready).toBe(false)
  })

  it('404（服务器档 / NAS 网页端）→ 不按备份显隐：那一档的备份就是它自己', async () => {
    answers.push(json({ message: 'Not Found' }, 404))

    await loadBackupStatus()

    expect(backupView().settled).toBe(true)
    expect(backupView().gate).toBe(false)
    // 但错误本身**如实留着**（界面要能说清"读不到"）
    expect(backupView().error).not.toBe('')
  })

  it('没有壳、也没读到过结论 → 不算本机档', () => {
    delete (globalThis as { __TAURI__?: unknown }).__TAURI__

    expect(backupGateApplies()).toBe(false)
  })

  it('浏览器里真答过一次 → 算本机档（开发形态直连边车那一条）', async () => {
    delete (globalThis as { __TAURI__?: unknown }).__TAURI__
    answers.push(json(payload()))

    await loadBackupStatus()

    expect(backupGateApplies()).toBe(true)
  })

  it('显式关掉本机数据面（逃生门）→ 不算本机档', async () => {
    setLocalDataForTest(false)
    answers.push(json(payload()))

    await loadBackupStatus()

    expect(backupGateApplies()).toBe(false)
  })
})

describe('⑥ 轮询与焦点（只在有事时问）', () => {
  it('提供者非 ready 时每 30s 重读一次（"NAS 又连上了"要能自己回来）', async () => {
    vi.useFakeTimers()
    answers.push(
      json(payload({ provider: providerStatus({ state: 'unavailable', available: false }) })),
      json(payload()),
    )
    const view = renderHook(() => useBackupStatus())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(backupCalls()).toHaveLength(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(BACKUP_POLL_MS)
    })

    expect(backupCalls()).toHaveLength(2)
    expect(backupCalls()[1].startsWith('PATCH')).toBe(true)
    expect(view.result.current.ready).toBe(true)
    view.unmount()
  })

  it('队列里还有没传上去的 → 继续问（联网之后补传要看得见）', async () => {
    vi.useFakeTimers()
    answers.push(
      json(payload({ backlog: backlog({ queued: 1 }) })),
      json(payload({ backlog: backlog({ queued: 0 }) })),
    )
    const view = renderHook(() => useBackupStatus())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(BACKUP_POLL_MS)
    })

    expect(backupCalls()).toHaveLength(2)
    expect(view.result.current.backlog?.queued).toBe(0)
    view.unmount()
  })

  it('ready 且队列空 → **不轮询**（问不出新东西）', async () => {
    vi.useFakeTimers()
    answers.push(json(payload()))
    const view = renderHook(() => useBackupStatus())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(backupCalls()).toHaveLength(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(BACKUP_POLL_MS * 3)
    })

    expect(backupCalls()).toHaveLength(1)
    view.unmount()
  })

  it('窗口重新获得焦点 → 强制重探一次（PATCH）', async () => {
    answers.push(json(payload({ backlog: backlog({ queued: 1 }) })), json(payload()))
    const view = renderHook(() => useBackupStatus())
    await waitFor(() => expect(backupCalls()).toHaveLength(1))

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })

    await waitFor(() => expect(backupCalls()).toHaveLength(2))
    expect(backupCalls()[1].startsWith('PATCH')).toBe(true)
    view.unmount()
  })

  it('enabled=false 时不订阅也不读（顶栏那条非本机档靠它做到一次都不问）', async () => {
    const view = renderHook(() => useBackupStatus({ enabled: false }))
    await act(async () => {
      await Promise.resolve()
    })

    expect(backupCalls()).toHaveLength(0)
    view.unmount()
  })

  it('最后一个订阅者走了就把计时器摘掉', async () => {
    vi.useFakeTimers()
    answers.push(json(payload({ backlog: backlog({ queued: 1 }) })))
    const view = renderHook(() => useBackupStatus())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    view.unmount()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(BACKUP_POLL_MS * 2)
    })

    expect(backupCalls()).toHaveLength(1)
  })
})

describe('⑦ 订阅契约（M4 那条"渲染一次 + 挂订阅之间状态变了没人听见"的坑）', () => {
  it('挂载那一帧就读到模块里已有的结论（不是先给一个空的再补）', () => {
    setBackupStatusForTest(payload({ backlog: backlog({ queued: 5 }) }))

    const view = renderHook(() => useBackupStatus())

    expect(view.result.current.data).not.toBeNull()
    expect(view.result.current.backlog?.queued).toBe(5)
    view.unmount()
  })

  it('挂订阅之后再对一次表：订阅前一刻写进状态的那份，订阅者立刻看得见', async () => {
    answers.push(json(payload()))
    const view = renderHook(() => useBackupStatus())
    await act(async () => {
      await Promise.resolve()
    })
    // 组件已经挂上订阅：此刻广播必须到达它（这一条钉的是"订阅后重读"那一句）
    act(() => {
      setBackupStatusForTest(payload({ backlog: backlog({ queued: 9 }) }))
    })

    expect(view.result.current.backlog?.queued).toBe(9)
    view.unmount()
  })
})

describe('⑧ LOCAL_PATHS 没加错（备份这一族只走本机）', () => {
  it('六条路的路径都在本机前缀表里', () => {
    expect(LOCAL_PATHS).toContain('/local')
    for (const path of [
      '/local/backup',
      '/local/backup/snapshots',
      '/local/backup/points',
      '/local/backup/points/dev-1/s1',
      '/local/backup/restore',
      '/local/import/batch-1',
      '/local/import/batch-1/rollback',
    ]) {
      expect(isLocalPath(path)).toBe(true)
    }
  })

  it('真打出去的基址是**边车**那台（不是壳转发的服务器地址）', async () => {
    routes['/local/backup/points'] = () =>
      json({ state: 'ready', available: true, reason: '', items: [], total: 0, quota: {} })
    answers.push(json(payload()))

    await getLocalBackup()
    await getBackupPoints()

    for (const call of backupCalls()) expect(call).toContain(SHELL_BASE)
    expect(calls.some((call) => call.includes('/local/backup/points'))).toBe(true)
    // 服务器那条基址（相对路径，由壳转发）**一个都没用**
    expect(calls.every((call) => !call.includes('GET /api/v1'))).toBe(true)
  })
})
