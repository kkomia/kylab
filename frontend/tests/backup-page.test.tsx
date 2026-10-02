/**
 * 「备份」页（M5 阶段 7，`src/features/backup/BackupPage.tsx` + `RestoreWizard.tsx`）。
 *
 * 这一份钉四块内容里那几条"最容易做错"的事：
 *
 * 1. **三态 + 两件事分开**：`available`（NAS 通不通）与 `snapshot_available`（桶建好没有）
 *    分别显示——"连上了但还收不了快照"不许被说成"连不上"；
 * 2. **不可用时队列照常显示、照常能打**：`GET /local/backup` 那半本机账与提供者状态无关，
 *    而"立即备份"是本地动作（断网也 202）；
 * 3. **恢复向导四步**：预演（dry-run）→ 把 `plan` 如实摆出来（含
 *    `credentials_to_configure`）→ **二次确认**（措辞里有"默认只补不覆盖"）→ 正式恢复
 *    → 轮询进度 → 报告 + 回滚入口；
 * 4. **删除 404 如实说"本来就没有"**（不是一句"失败"）。
 *
 * 网络一律替身：这些用例一条真请求都不发出去。
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), dismiss: vi.fn() },
}))

import { toast } from 'sonner'

import {
  resetBackupStore,
  setBackupStatusForTest,
  type BackupBacklog,
  type BackupPoints,
  type BackupQueueRow,
  type LocalBackup,
} from '@/api/backup'
import { resetSidecarProbe } from '@/api/sidecar'
import { BackupPage } from '@/features/backup/BackupPage'

const SHELL_BASE = 'http://127.0.0.1:8766'
const errorToast = vi.mocked(toast.error)

/* ------------------------------------------------------------------ 假数据 */

function providerStatus(overrides: Partial<LocalBackup['provider']> = {}): LocalBackup['provider'] {
  return {
    state: 'ready',
    available: true,
    reason: '',
    checked_at: '2026-10-05T10:00:00Z',
    base_url: 'http://nas:8000',
    credential: 'configured',
    snapshot_available: true,
    snapshot_reason: '',
    protocol_version: 1,
    app_version: '0.1.1',
    capabilities: { retention: { keep: 3, policy: 'keep_n' } },
    devices: [{ device_id: 'dev-1' }],
    // M5 收口（`f7eb285`）：三栏本机配置（永远出现）
    enabled: true,
    include_workspace: false,
    every_hours: 24,
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
    blob_bytes: 2048,
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

function pointsBody(overrides: Partial<BackupPoints> = {}): BackupPoints {
  return {
    state: 'ready',
    available: true,
    reason: '',
    checked_at: '2026-10-05T10:00:00Z',
    items: [
      {
        device_id: 'dev-1',
        device_name: '小又的笔记本',
        snapshot_id: '2026-10-05T09-00-00Z-aaaa1111',
        created_at: '2026-10-05T09:00:00Z',
        bytes: 4096,
        kind: 'auto',
      },
    ],
    total: 1,
    quota: { policy: 'keep_n', keep: 3, quota_bytes: 1024 * 1024, used_bytes: 4096, snapshots: 1 },
    ...overrides,
  }
}

/** 一份 dry-run 报告（形状照 `RestorePlan.as_dict()`）。 */
function planBody() {
  return {
    device_id: 'dev-1',
    snapshot_id: '2026-10-05T09-00-00Z-aaaa1111',
    source: 'backup://dev-1/2026-10-05T09-00-00Z-aaaa1111',
    created: [
      { conversation_id: 'c1', title: '上周那篇论文', messages: 12, artifacts: 2, reason: '' },
    ],
    replaced: [],
    skipped: [
      {
        conversation_id: 'c2',
        title: '本机改过的那条',
        messages: 3,
        artifacts: 0,
        reason: 'local_newer',
      },
      {
        conversation_id: 'c3',
        title: '已经导过一次的',
        messages: 5,
        artifacts: 0,
        reason: 'already_imported',
      },
    ],
    artifacts: { in_package: 4, object: 3, workspace: 1, missing_from_package: ['b.png'] },
    memory: { in_package: 3, already_here: 1, will_copy: 2, already_here_files: ['MEMORY.md'] },
    settings: { will_fill: ['llm.temperature'], already_here: [], excluded: [] },
    credentials_to_configure: ['模型凭据 1 个（深度求索）：恢复后要重新填一次'],
    counts: { created: 1, replaced: 0, skipped: 2 },
  }
}

/** 恢复完成之后的台账（`counts["restore"]` 那一段）。 */
function restoreCounts() {
  return {
    created: 1,
    replaced: 0,
    skipped: 2,
    restore: {
      memory: { copied: 2, skipped_existing: 1 },
      settings: { filled: ['llm.temperature'], kept_local: [] },
      artifacts: { restored: 3, identical: 1, conflicts: 0, workspace_not_placed: 1 },
      credentials_to_configure: ['NAS 的钥匙：这台机器要重新登录一次'],
      pre_restore_snapshot: 'dev-1-restore-1',
      seconds: 12.5,
    },
  }
}

/* ------------------------------------------------------------------ 网络替身 */

interface Route {
  method?: string
  /** 命中条件（URL 里出现它就算命中）。 */
  match: string
  reply: () => Response
}

let routes: Route[] = []
let calls: string[] = []

function json(body: unknown, code = 200): Response {
  return new Response(JSON.stringify(body), {
    status: code,
    headers: { 'content-type': 'application/json' },
  })
}

function stubNetwork(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const target = String(url)
      const method = init?.method ?? 'GET'
      calls.push(`${method} ${target}`)
      if (target.endsWith('/health')) return json({ ok: true })
      const hit = routes.find(
        (route) => target.includes(route.match) && (route.method ?? 'GET') === method,
      )
      if (!hit) throw new Error(`用例没预备这条请求：${method} ${target}`)
      return hit.reply()
    }),
  )
}

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={['/backup']}>
      <BackupPage />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  calls = []
  routes = [
    // 备份页自己那条读（TTL 内一般不会真发：用例把状态直接摆进模块）
    { match: '/local/backup/points', reply: () => json(pointsBody()) },
    { match: '/local/backup', reply: () => json(payload()) },
  ]
  resetSidecarProbe()
  resetBackupStore()
  errorToast.mockClear()
  vi.stubGlobal('__TAURI__', {
    core: { invoke: vi.fn(async () => ({ port: 8766, base: SHELL_BASE })) },
  })
  stubNetwork()
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetSidecarProbe()
  resetBackupStore()
})

/* ------------------------------------------------------------------ ① 状态块 */

describe('① 状态块：三态 + 两种"不能收快照"分开显示', () => {
  it('ready：连接是"已连接"、能力说"远端可以收快照"', async () => {
    setBackupStatusForTest(payload())

    renderPage()

    const state = await screen.findByTestId('backup-provider-state')
    // 值那一格与状态标签都说"已连接"（两处都读同一份结论）
    expect(within(state).getAllByText('已连接').length).toBeGreaterThan(0)
    const capability = screen.getByTestId('backup-snapshot-capability')
    expect(within(capability).getByText('远端可以收快照')).toBeInTheDocument()
    expect(within(capability).getByText('可以收')).toBeInTheDocument()
  })

  it('NAS 连上了但桶还没建：说"远端还收不了快照"并**带上对面给的下一步**（不说成连不上）', async () => {
    setBackupStatusForTest(
      payload({
        provider: providerStatus({
          snapshot_available: false,
          snapshot_reason: '先在对象存储里把桶建出来',
        }),
      }),
    )

    renderPage()

    const capability = await screen.findByTestId('backup-snapshot-capability')
    expect(
      within(capability).getByText('远端还收不了快照：先在对象存储里把桶建出来'),
    ).toBeInTheDocument()
    expect(within(capability).getByText('还收不了')).toBeInTheDocument()
    // 连接那一块照旧是"已连接"（两件事分开）
    expect(
      within(screen.getByTestId('backup-provider-state')).getAllByText('已连接').length,
    ).toBeGreaterThan(0)
  })

  it('unavailable：连接那一行写原因（后端那句话原样摆出来）', async () => {
    setBackupStatusForTest(
      payload({
        provider: providerStatus({
          state: 'unavailable',
          available: false,
          reason: '连不上那台 NAS：请检查网络',
          snapshot_available: false,
          snapshot_reason: '',
        }),
      }),
    )

    renderPage()

    expect(await screen.findByText('连不上那台 NAS：请检查网络')).toBeInTheDocument()
    expect(
      within(screen.getByTestId('backup-provider-state')).getAllByText('不可用').length,
    ).toBeGreaterThan(0)
  })

  it('unconfigured：说"未配置"，且地址那一行写着"留空 = 用壳里那台 NAS"', async () => {
    setBackupStatusForTest(
      payload({
        provider: providerStatus({
          state: 'unconfigured',
          available: false,
          reason: '还没填地址',
          base_url: '',
        }),
      }),
    )

    renderPage()

    expect(
      within(await screen.findByTestId('backup-provider-state')).getAllByText('未配置').length,
    ).toBeGreaterThan(0)
    expect(screen.getByText('（留空 = 用壳里那台 NAS）')).toBeInTheDocument()
  })

  it('四个可改项各走 PATCH：地址 / 开关 / 间隔 / 含工作区', async () => {
    const user = userEvent.setup()
    setBackupStatusForTest(payload({ provider: providerStatus({ base_url: '' }) }))
    routes.push({
      method: 'PATCH',
      match: '/local/backup',
      reply: () => json(payload({ provider: providerStatus({ base_url: 'http://nas:9000' }) })),
    })

    renderPage()

    await user.type(await screen.findByLabelText('备份地址'), 'http://nas:9000')
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() =>
      expect(calls.some((call) => call === `PATCH ${SHELL_BASE}/api/v1/local/backup`)).toBe(true),
    )

    // 两栏开关是**真值回填**的：拨一下就是 PATCH 那一个键
    await user.click(within(screen.getByTestId('backup-enabled')).getByRole('switch'))
    await user.click(within(screen.getByTestId('backup-include-workspace')).getByRole('switch'))
    // 间隔输入框回填的是当前值（24），改掉再存
    const hoursInput = screen.getByLabelText('每多少小时自动打一份')
    expect(hoursInput).toHaveValue('24')
    await user.clear(hoursInput)
    await user.type(hoursInput, '6')
    await user.click(screen.getByRole('button', { name: '保存间隔' }))

    const fetchMock = vi.mocked(fetch)
    const bodies = fetchMock.mock.calls
      .filter(([, init]) => init?.method === 'PATCH')
      .map(([, init]) => JSON.parse(String(init?.body)))
    expect(bodies).toContainEqual({ base_url: 'http://nas:9000' })
    expect(bodies).toContainEqual({ enabled: false })
    expect(bodies).toContainEqual({ include_workspace: true })
    expect(bodies).toContainEqual({ every_hours: 6 })
  })

  /* ---------------- M5 收口（`f7eb285`）：三栏直接读值，不再从人话反推 ---------------- */

  it('① 三栏按后端给的值渲染（关 / 带上 / 12 小时）', async () => {
    setBackupStatusForTest(
      payload({
        provider: providerStatus({
          enabled: false,
          include_workspace: true,
          every_hours: 12,
        }),
      }),
    )

    renderPage()

    const enabledRow = await screen.findByTestId('backup-enabled')
    expect(within(enabledRow).getByText('关掉了')).toBeInTheDocument()
    // 开关本身就是"关着"那一态（真值回填，不是按钮）
    expect(within(enabledRow).getByRole('switch')).toHaveAttribute('aria-checked', 'false')

    const workspaceRow = screen.getByTestId('backup-include-workspace')
    expect(within(workspaceRow).getByText('带上')).toBeInTheDocument()
    expect(within(workspaceRow).getByRole('switch')).toHaveAttribute('aria-checked', 'true')

    // 间隔输入框回填 12，提示里也说得出来
    expect(screen.getByLabelText('每多少小时自动打一份')).toHaveValue('12')
    expect(screen.getByTestId('backup-every-hours').textContent).toContain(
      '现在是每 12 小时自动打一份',
    )
  })

  it('② 保存之后界面跟着回到新值（PATCH 的响应带回新三栏）', async () => {
    const user = userEvent.setup()
    setBackupStatusForTest(
      payload({
        provider: providerStatus({ enabled: true, include_workspace: false, every_hours: 24 }),
      }),
    )
    routes.push({
      method: 'PATCH',
      match: '/local/backup',
      reply: () =>
        json(
          payload({
            provider: providerStatus({ enabled: false, include_workspace: true, every_hours: 6 }),
          }),
        ),
    })

    renderPage()

    await user.click(within(await screen.findByTestId('backup-enabled')).getByRole('switch'))

    // 拨完之后（PATCH 回来的整包写进模块）三栏都按新值显示
    await waitFor(() =>
      expect(within(screen.getByTestId('backup-enabled')).getByRole('switch')).toHaveAttribute(
        'aria-checked',
        'false',
      ),
    )
    expect(within(screen.getByTestId('backup-enabled')).getByText('关掉了')).toBeInTheDocument()
    expect(
      within(screen.getByTestId('backup-include-workspace')).getByText('带上'),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('每多少小时自动打一份')).toHaveValue('6')
  })

  it('③ 不再依赖那句人话：reason 换一句完全不同的措辞，开关态照旧显示正确', async () => {
    setBackupStatusForTest(
      payload({
        provider: providerStatus({
          state: 'unconfigured',
          available: false,
          // 关掉那一档后端现在给的是别的措辞（这里再换一句更不像的）
          reason: '这台机器还没接备份提供者：去「备份」里填一个地址',
          base_url: '',
          enabled: false,
          include_workspace: false,
          every_hours: 0,
        }),
      }),
    )

    renderPage()

    const row = await screen.findByTestId('backup-enabled')
    // 开关态只看 `enabled`（老实现是从 `base_url` 空 + reason 里有没有"被关掉"推的）
    expect(within(row).getByText('关掉了')).toBeInTheDocument()
    expect(within(row).getByRole('switch')).toHaveAttribute('aria-checked', 'false')

    // 反向也一样：开着的时候，哪怕原因句里带着"关掉"字样，也不许把开关画成关
    cleanup()
    setBackupStatusForTest(
      payload({
        provider: providerStatus({
          state: 'unconfigured',
          available: false,
          reason: '地址是空的（不是被关掉）',
          base_url: '',
          enabled: true,
        }),
      }),
    )
    renderPage()

    const openRow = await screen.findByTestId('backup-enabled')
    expect(within(openRow).getByText('打开')).toBeInTheDocument()
    expect(within(openRow).getByRole('switch')).toHaveAttribute('aria-checked', 'true')
  })
})

/* ------------------------------------------------------------------ ② 队列块 */

describe('② 队列块：连不上远端时照常显示、照常能打', () => {
  it('提供者 unavailable：队列数字与每一行的原因照旧摆着（两半互不掩盖）', async () => {
    setBackupStatusForTest(
      payload({
        provider: providerStatus({ state: 'unavailable', available: false, reason: '断网了' }),
        backlog: backlog({ queued: 2, failed: 1, discarded: 1, last_error: '连不上远端' }),
        snapshots: [
          row({ state: 'failed', last_error: '连不上远端' }),
          row({ id: 'dev-1-...-ffffffff', state: 'discarded' }),
        ],
      }),
    )

    renderPage()

    const block = await screen.findByTestId('backup-backlog')
    expect(within(block).getByText(/还有 2 份没备上去/)).toBeInTheDocument()
    expect(within(block).getByText(/一共丢过 1 份/)).toBeInTheDocument()
    expect(screen.getByText('最近一次没成：连不上远端')).toBeInTheDocument()
    // 每一行的状态与 last_error
    const queue = screen.getByTestId('backup-queue')
    expect(within(queue).getByText('没传上去')).toBeInTheDocument()
    expect(within(queue).getByText('被丢掉')).toBeInTheDocument()
    expect(within(queue).getAllByText(/连不上远端/).length).toBeGreaterThan(0)
    // 「立即备份」照常可点（备份是本地动作）
    expect(within(block).getByRole('button', { name: '立即备份' })).toBeEnabled()
  })

  it('「立即备份」打 POST /local/backup/snapshots，202 之后刷这一页', async () => {
    const user = userEvent.setup()
    setBackupStatusForTest(payload())
    routes.push({
      method: 'POST',
      match: '/local/backup/snapshots',
      reply: () =>
        json(
          {
            snapshot: row({ state: 'failed', last_error: '连不上远端' }),
            backlog: backlog({ queued: 1, failed: 1 }),
          },
          202,
        ),
    })
    // 202 之后页面会 refresh（PATCH 空 body）→ 给一条回答
    routes.push({
      method: 'PATCH',
      match: '/local/backup',
      reply: () => json(payload({ backlog: backlog({ queued: 1, failed: 1 }) })),
    })

    renderPage()

    await user.click(await screen.findByRole('button', { name: '立即备份' }))

    await waitFor(() =>
      expect(
        calls.some((call) => call === `POST ${SHELL_BASE}/api/v1/local/backup/snapshots`),
      ).toBe(true),
    )
    // 入队成功也把原因说出来（"failed"不是"没打成"）
    await waitFor(() =>
      expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
        expect.stringContaining('这一份已经打在盘上、排进队列了'),
      ),
    )
  })
})

/* ------------------------------------------------------------------ ③ 恢复点块 */

describe('③ 恢复点块：取不到说"看不到"，删 404 说"本来就没有"', () => {
  it('available=false：说的是"看不到恢复点"（不是"一份都没有"）', async () => {
    routes[0] = {
      match: '/local/backup/points',
      reply: () =>
        json({
          state: 'unavailable',
          available: false,
          reason: '连不上那台 NAS',
          items: [],
          total: 0,
          quota: {},
        }),
    }
    setBackupStatusForTest(
      payload({ provider: providerStatus({ state: 'unavailable', available: false }) }),
    )

    renderPage()

    expect(await screen.findByText('看不到恢复点：连不上那台 NAS')).toBeInTheDocument()
    expect(screen.queryByTestId('backup-points')).toBeNull()
    expect(screen.queryByText('这台远端上还没有任何恢复点')).toBeNull()
  })

  it('取到了：设备 / 时间 / 大小 / 额度都在，恢复点是列的只读行', async () => {
    setBackupStatusForTest(payload())

    renderPage()

    const list = await screen.findByTestId('backup-points')
    expect(within(list).getByText(/小又的笔记本/)).toBeInTheDocument()
    expect(within(list).getByText(/4\.0 KB/)).toBeInTheDocument()
    expect(within(list).getByRole('button', { name: '恢复到这一份' })).toBeInTheDocument()
    expect(screen.getByTestId('backup-points-summary')).toBeInTheDocument()
  })

  it('删 404：如实说"远端本来就没有这一份"（不是一句"没删掉"）', async () => {
    const user = userEvent.setup()
    setBackupStatusForTest(payload())
    routes.push({
      method: 'DELETE',
      match: '/local/backup/points/',
      reply: () => json({ message: '这条路径上没有恢复点可删' }, 404),
    })

    renderPage()

    await user.click(await screen.findByRole('button', { name: '删除' }))
    await user.click(screen.getByRole('button', { name: '删掉' }))

    await waitFor(() =>
      expect(errorToast).toHaveBeenCalledWith(
        expect.stringContaining('远端本来就没有这一份恢复点'),
      ),
    )
    expect(errorToast.mock.calls[0][0]).toContain('dev-1/2026-10-05T09-00-00Z-aaaa1111')
  })

  it('删成功：说删了几个对象', async () => {
    const user = userEvent.setup()
    setBackupStatusForTest(payload())
    routes.push({
      method: 'DELETE',
      match: '/local/backup/points/',
      reply: () => json({ removed: 2 }),
    })

    renderPage()

    await user.click(await screen.findByRole('button', { name: '删除' }))
    await user.click(screen.getByRole('button', { name: '删掉' }))

    await waitFor(() =>
      expect(vi.mocked(toast.success)).toHaveBeenCalledWith('已删掉这一份恢复点（2 个对象）'),
    )
  })
})

/* ------------------------------------------------------------------ ④ 恢复向导 */

describe('④ 恢复向导：预演 → 二次确认 → 恢复 → 进度 → 报告与回滚', () => {
  /** 把恢复那四条路都备好（预演 / 正式 / 进度 / 回滚）。 */
  function stubRestore(): { plan: () => Response; begin: () => Response } {
    const plan = (): Response =>
      json(
        {
          batch_id: '',
          state: 'planned',
          source: 'backup://dev-1/s1',
          dry_run: true,
          plan: planBody(),
        },
        202,
      )
    const begin = (): Response =>
      json(
        {
          batch_id: 'batch-1',
          state: 'planned',
          source: 'backup://dev-1/s1',
          dry_run: false,
          plan: {},
        },
        202,
      )
    routes.push({ method: 'POST', match: '/local/backup/restore', reply: plan })
    return {
      plan,
      begin: () => {
        // 第二条 POST 起换成正式那一份（先注册的先生效，所以把预演那条替换掉）
        routes = routes.filter((route) => route.match !== '/local/backup/restore')
        routes.push({ method: 'POST', match: '/local/backup/restore', reply: begin })
        return begin()
      },
    }
  }

  it('第一步：点「恢复到这一份」先只预演；报告把会新建 / 会跳过（含原因）/ 产物 / 凭据都摆出来', async () => {
    const user = userEvent.setup()
    setBackupStatusForTest(payload())
    stubRestore()

    renderPage()

    await user.click(await screen.findByRole('button', { name: '恢复到这一份' }))
    // 还没预演：先看到那句"预演只读一遍"与勾选框
    expect(screen.getByText(/预演只读一遍包里有什么/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '开始预演' }))

    // 预演的报告
    expect(await screen.findByTestId('plan-counts')).toHaveTextContent(
      '会新建 1 · 会替换 0 · 会跳过 2',
    )
    expect(screen.getByTestId('plan-created')).toHaveTextContent('上周那篇论文')
    const skipped = screen.getByTestId('plan-skipped')
    expect(skipped).toHaveTextContent('本机这条更新')
    expect(skipped).toHaveTextContent('这一版已经导过一次')
    expect(screen.getByText(/包里 4 份/)).toBeInTheDocument()
    expect(screen.getByText(/这次补 2 份/)).toBeInTheDocument()
    // **要重配的凭据必须显示**（R13）
    const credentials = screen.getByTestId('restore-credentials')
    expect(credentials).toHaveTextContent('模型凭据 1 个（深度求索）：恢复后要重新填一次')
    // 预演只发了一次 dry_run 的 POST
    const fetchMock = vi.mocked(fetch)
    const bodies = fetchMock.mock.calls
      .filter(
        ([url, init]) => String(url).endsWith('/local/backup/restore') && init?.method === 'POST',
      )
      .map(([, init]) => JSON.parse(String(init?.body)))
    expect(bodies).toEqual([
      {
        device_id: 'dev-1',
        snapshot_id: '2026-10-05T09-00-00Z-aaaa1111',
        dry_run: true,
        overwrite_memory: false,
      },
    ])
  })

  it('第二步：确认弹窗里那句"默认只补不覆盖、本机改过的会保留"必须在', async () => {
    const user = userEvent.setup()
    setBackupStatusForTest(payload())
    stubRestore()

    renderPage()

    await user.click(await screen.findByRole('button', { name: '恢复到这一份' }))
    await user.click(screen.getByRole('button', { name: '开始预演' }))
    await user.click(await screen.findByRole('button', { name: '开始恢复' }))

    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('默认只补不覆盖')
    expect(dialog).toHaveTextContent('本机改过的会话也保留')
    // 取消之后一个字都没恢复（dry_run 那一次之外没有第二个 POST）
    await user.click(within(dialog).getByRole('button', { name: '取消' }))
    const fetchMock = vi.mocked(fetch)
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) => String(url).endsWith('/local/backup/restore') && init?.method === 'POST',
      ),
    ).toHaveLength(1)
  })

  it('第三步之后：进度轮询 → 报告 + 回滚入口（回滚也要二次确认）', async () => {
    const user = userEvent.setup()
    setBackupStatusForTest(payload())
    const restore = stubRestore()
    routes.push({
      match: '/local/import/batch-1',
      reply: () =>
        json({
          batch_id: 'batch-1',
          state: 'done',
          source: 'backup://dev-1/s1',
          dry_run: false,
          counts: restoreCounts(),
          error: '',
          updated_at: null,
        }),
    })
    routes.push({
      method: 'POST',
      match: '/local/import/batch-1/rollback',
      reply: () =>
        json({
          batch_id: 'batch-1',
          state: 'rolled_back',
          source: 'backup://dev-1/s1',
          dry_run: false,
          counts: { scanned: 3, deleted: 1, restored: 0, kept: 1, missing: 0, no_snapshot: 0 },
          error: '',
          updated_at: null,
        }),
    })

    renderPage()

    await user.click(await screen.findByRole('button', { name: '恢复到这一份' }))
    await user.click(screen.getByRole('button', { name: '开始预演' }))
    await user.click(await screen.findByRole('button', { name: '开始恢复' }))
    restore.begin()
    await user.click(await screen.findByRole('button', { name: '确认恢复' }))

    // 进度：轮询那一条立刻跑一次，回来就是终态 → 报告
    expect(await screen.findByTestId('restore-report')).toHaveTextContent('已完成')
    const report = screen.getByTestId('restore-counts')
    expect(report).toHaveTextContent('记忆：补上 2 份')
    expect(report).toHaveTextContent('工作区产物 1 份没有落位')
    // 报告里也带"要重配的凭据"
    expect(screen.getByTestId('restore-credentials')).toHaveTextContent('NAS 的钥匙')

    // 回滚入口 → 二次确认 → 回滚结论
    await user.click(screen.getByRole('button', { name: '回滚这一次恢复' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('本机改过的那几条保留')
    await user.click(within(dialog).getByRole('button', { name: '确认' }))

    expect(await screen.findByTestId('restore-rolled-back')).toHaveTextContent(
      '删掉 1 条 · 还原 0 条 · 保留 1 条',
    )
  })

  it('恢复失败：原因与那一段报告都摆出来，**回滚入口照给**（跑了一半的也能撤）', async () => {
    const user = userEvent.setup()
    setBackupStatusForTest(payload())
    const restore = stubRestore()
    routes.push({
      match: '/local/import/batch-1',
      reply: () =>
        json({
          batch_id: 'batch-1',
          state: 'failed',
          source: 'backup://dev-1/s1',
          dry_run: false,
          counts: { created: 1, restore: { error: '会话那一步失败了：包里那条读不出来' } },
          error: '包里那条读不出来',
          updated_at: null,
        }),
    })

    renderPage()

    await user.click(await screen.findByRole('button', { name: '恢复到这一份' }))
    await user.click(screen.getByRole('button', { name: '开始预演' }))
    await user.click(await screen.findByRole('button', { name: '开始恢复' }))
    restore.begin()
    await user.click(await screen.findByRole('button', { name: '确认恢复' }))

    const report = await screen.findByTestId('restore-report')
    expect(report).toHaveTextContent('失败')
    expect(report).toHaveTextContent('包里那条读不出来')
    expect(screen.getByTestId('restore-counts')).toHaveTextContent('包里那条读不出来')
    expect(screen.getByRole('button', { name: '回滚这一次恢复' })).toBeInTheDocument()
  })

  it('预演失败（上游取不到包 → 502）：把那句原因摆出来，不进下一步', async () => {
    const user = userEvent.setup()
    setBackupStatusForTest(payload())
    routes.push({
      method: 'POST',
      match: '/local/backup/restore',
      reply: () => json({ message: '取不到这份恢复点的清单', code: 'upstream_error' }, 502),
    })

    renderPage()

    await user.click(await screen.findByRole('button', { name: '恢复到这一份' }))
    await user.click(screen.getByRole('button', { name: '开始预演' }))

    expect(await screen.findByText('取不到这份恢复点的清单')).toBeInTheDocument()
    // 还是第一步（没有报告、也没有"开始恢复"）
    expect(screen.queryByTestId('plan-counts')).toBeNull()
    expect(errorToast).toHaveBeenCalledWith('取不到这份恢复点的清单')
  })

  it('「记忆也覆盖」是可选的那一项：勾上之后 dry_run 的请求体里带上它', async () => {
    const user = userEvent.setup()
    setBackupStatusForTest(payload())
    stubRestore()

    renderPage()

    await user.click(await screen.findByRole('button', { name: '恢复到这一份' }))
    await user.click(screen.getByLabelText(/记忆也覆盖/))
    await user.click(screen.getByRole('button', { name: '开始预演' }))
    await screen.findByTestId('plan-counts')

    const fetchMock = vi.mocked(fetch)
    const body = fetchMock.mock.calls
      .filter(
        ([url, init]) => String(url).endsWith('/local/backup/restore') && init?.method === 'POST',
      )
      .map(([, init]) => JSON.parse(String(init?.body)))[0]
    expect(body.overwrite_memory).toBe(true)
  })
})
