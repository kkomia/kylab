/**
 * 知识库页面的路由守卫（M3 阶段 6，`features/knowledge/ProviderRoute.tsx`）。
 *
 * 方案 §3.4「断连后消失」要求的是：**正停在 KB 页面（或直接敲地址进来）时**，
 * 不可用要变成"回到对话页 + 一条含原因的 toast"，而不是白屏、也不是一个点进去报错的死页面。
 * 这一份就把那三句话钉住：
 *
 * 1. `ready` → 页面照常渲染（守卫一个字都不加）；
 * 2. 不可用 → **重定向到 `/chat`**，而且 toast 里**必须有后端给的原因**
 *    （"不静默"这条纪律的全部价值就在那一句原因上：没有它，用户只知道坏了，不知道坏在哪）；
 * 3. **还没结论**（首屏那一次握手还没回来）→ 先等一下，不把一条正常的深链接弹回去；
 * 4. 服务器档（浏览器 / NAS 网页端）→ 守卫**不管**（那一档知识库就是它自己）。
 */
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))

import { toast } from 'sonner'

import { resetProviderStore, setProviderStatusForTest, type ProviderStatus } from '@/api/provider'
import { ProviderRoute, providerBlockedMessage } from '@/features/knowledge/ProviderRoute'

const warning = vi.mocked(toast.warning)

function status(overrides: Partial<ProviderStatus> = {}): ProviderStatus {
  return {
    state: 'ready',
    available: true,
    reason: '',
    checked_at: '2026-10-03T10:00:00Z',
    base_url: 'http://nas:8000/api/v1',
    credential: 'configured',
    ...overrides,
  }
}

/** 让用例能读到"现在在哪个地址"（重定向要断言它）。 */
function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location">{location.pathname}</div>
}

function renderGuarded(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/chat" element={<div>对话页</div>} />
        <Route
          path="/knowledge-bases"
          element={
            <ProviderRoute>
              <div>知识库列表页</div>
            </ProviderRoute>
          }
        />
        <Route
          path="/kb/:kbId"
          element={
            <ProviderRoute>
              <div>知识库详情页</div>
            </ProviderRoute>
          }
        />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  warning.mockClear()
  resetProviderStore()
  // 壳替身（这一档是本机档）＋一个**永不回答**的 fetch：挂载时那一次探测挂在半路，
  // 于是"还没结论"那一档是可复现的（用例自己摆结论，不许网络参与）。
  vi.stubGlobal('__TAURI__', {
    core: { invoke: vi.fn(async () => ({ port: 8766, base: 'http://127.0.0.1:8766' })) },
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {})),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetProviderStore()
})

describe('提供者不可用时：知识库那四条路由走不去', () => {
  it('`unavailable`：重定向到 /chat，toast 里带后端那句原因', async () => {
    setProviderStatusForTest(
      status({ state: 'unavailable', available: false, reason: '连不上这台 NAS（3 秒超时）' }),
    )

    renderGuarded('/kb/kb_1')

    await waitFor(() => expect(screen.getByText('对话页')).toBeInTheDocument())
    expect(screen.getByTestId('location')).toHaveTextContent('/chat')
    expect(screen.queryByText('知识库详情页')).not.toBeInTheDocument()
    // 不静默：原因必须出现在 toast 里（而且说清本机后端还在）
    const message = String(warning.mock.calls[0]?.[0] ?? '')
    expect(message).toContain('连不上这台 NAS（3 秒超时）')
    expect(message).toContain('本机后端仍在运行')
  })

  it('`unconfigured`：同样重定向，但句子说的是"还没接上"（下一步是填地址）', async () => {
    setProviderStatusForTest(
      status({ state: 'unconfigured', available: false, reason: '壳里的 server 是空的' }),
    )

    renderGuarded('/knowledge-bases')

    await waitFor(() => expect(screen.getByText('对话页')).toBeInTheDocument())
    const message = String(warning.mock.calls[0]?.[0] ?? '')
    expect(message).toContain('还没接上知识库提供者')
    expect(message).toContain('壳里的 server 是空的')
  })

  it('toast 只说一遍（状态每次广播都会重渲染，刷屏会把原因淹掉）', async () => {
    setProviderStatusForTest(status({ state: 'unavailable', available: false, reason: '连不上' }))

    renderGuarded('/knowledge-bases')
    await waitFor(() => expect(warning).toHaveBeenCalledTimes(1))

    // 再来一次广播（轮询拿到同一个结论）：不再多说一遍
    setProviderStatusForTest(status({ state: 'unavailable', available: false, reason: '连不上' }))
    await waitFor(() => expect(warning).toHaveBeenCalledTimes(1))
  })

  it('原因缺失时也不许静默：兜底句子写"没给出原因"，但"回到对话页"那句仍在', () => {
    expect(providerBlockedMessage('unavailable', '')).toContain('本机后端没给出原因')
    expect(providerBlockedMessage('unavailable', '')).toContain('已回到对话页')
  })
})

describe('提供者可用 / 这一档不管它时：页面照常', () => {
  it('`ready`：四条路由照常渲染，没有任何 toast', async () => {
    setProviderStatusForTest(status())

    renderGuarded('/kb/kb_1')

    expect(await screen.findByText('知识库详情页')).toBeInTheDocument()
    expect(warning).not.toHaveBeenCalled()
  })

  it('还没结论：先显示"正在确认知识库连接…"，**不**把深链接弹走', async () => {
    // 模块初始态就是"还没探过"（status=null、settled=false）
    renderGuarded('/knowledge-bases')

    expect(await screen.findByTestId('provider-pending')).toBeInTheDocument()
    expect(screen.queryByText('对话页')).not.toBeInTheDocument()
    expect(screen.getByTestId('location')).toHaveTextContent('/knowledge-bases')
    expect(warning).not.toHaveBeenCalled()
  })

  it('服务器档（这一档没有 /local/provider）：守卫一个字都不管', async () => {
    setProviderStatusForTest(null, { unsupported: true })

    renderGuarded('/knowledge-bases')

    expect(await screen.findByText('知识库列表页')).toBeInTheDocument()
    expect(screen.getByTestId('location')).toHaveTextContent('/knowledge-bases')
    expect(warning).not.toHaveBeenCalled()
  })
})
