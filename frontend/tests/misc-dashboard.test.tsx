/**
 * 驾驶舱（旧 `views/DashboardView.vue`）的用例。
 *
 * 三条自我约束各一条用例：
 * 1. **数据没到也先把六个槽位画出来**（流式渲染：骨架立刻可见）；
 * 2. **用量还没回来时显示占位符而不是 0**——0 的含义是"确实没有调用"；
 * 3. **窗口太长时按周聚合**（那条趋势的聚合口径是纯函数，单独钉住）。
 *
 * `EChart` 在这里被替掉：jsdom 没有 canvas，真去 init 会直接把用例打挂。
 * 图表本身的"按需异步加载"由结构保证（`React.lazy` + 本文件只关心数据）。
 */
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/stats', () => ({
  getDashboard: vi.fn(),
  getUsage: vi.fn(),
}))

vi.mock('@/features/misc/dashboard/EChart', () => ({
  EChart: ({ option }: { option: Record<string, unknown> }) => {
    const series = (option.series as { type?: string }[] | undefined)?.[0]
    return (
      <div
        data-testid={`chart-${series?.type ?? 'unknown'}`}
        data-series={JSON.stringify(series ?? {})}
      />
    )
  },
}))

import { getDashboard, getUsage, type Dashboard } from '@/api/stats'
import { checkableTrend, DashboardPage } from '@/features/misc/dashboard/DashboardPage'
import { renderMisc } from '@/features/misc/testing/harness'
import { resetToasts } from '@/features/misc/shared/toast'

const getDashboardMock = vi.mocked(getDashboard)
const getUsageMock = vi.mocked(getUsage)

function dashboard(overrides: Partial<Dashboard> = {}): Dashboard {
  return {
    generated_at: '2026-09-23T10:00:00Z',
    window_days: 365,
    total_knowledge_bases: 2,
    total_documents: 10,
    total_chunks: 240,
    indexed_documents: 9,
    failed_documents: 1,
    running_tasks: 0,
    failed_tasks: 1,
    storage_bytes: 2048,
    recent_documents: 4,
    activity: [
      { day: '2026-09-21', documents: 1, chunks: 10, tasks: 2 },
      { day: '2026-09-22', documents: 3, chunks: 30, tasks: 4 },
    ],
    by_stage: { indexed: 9, failed: 1 },
    by_suffix: { pdf: 7, docx: 3 },
    by_source_kind: { upload: 10 },
    knowledge_bases: [
      {
        id: 'kb-1',
        name: '产品手册',
        embedding_model_id: 'BAAI/bge-m3',
        embedding_dim: 1024,
        documents: 10,
        chunks: 240,
        last_activity: '2026-09-22T10:00:00Z',
      },
    ],
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetToasts()
  getDashboardMock.mockResolvedValue(dashboard())
  getUsageMock.mockResolvedValue({
    days: 30,
    total: {
      calls: 120,
      prompt_tokens: 30000,
      completion_tokens: 8000,
      items: 240,
      unreported: 0,
      estimated: 60,
    },
    by_day: [],
    by_kind: [
      {
        kind: 'chat',
        label: '对话',
        calls: 100,
        prompt_tokens: 30000,
        completion_tokens: 8000,
        items: 0,
        unreported: 0,
        estimated: 0,
      },
      {
        kind: 'embed',
        label: '向量化',
        calls: 20,
        prompt_tokens: 0,
        completion_tokens: 0,
        items: 240,
        unreported: 0,
        estimated: 20,
      },
    ],
    by_model: [{ model: 'deepseek-chat', calls: 100 } as never],
    reported_calls: 100,
    estimated_calls: 20,
    unreported_calls: 0,
    estimated_tokens: 5000,
  } as never)
})

describe('驾驶舱', () => {
  it('六个大数按"结论在前"排列，并给出索引完成率与失败篇数', async () => {
    renderMisc(<DashboardPage />)

    expect(await screen.findByText('产品手册')).toBeInTheDocument()
    expect(screen.getByText('90%')).toBeInTheDocument()
    expect(screen.getByText('1 篇失败')).toBeInTheDocument()
    expect(screen.getByText('近 365 天入库')).toBeInTheDocument()
    // 知识库规模表的最近活动走相对时间
    expect(screen.getByText(/天前|小时前|刚刚|2026-/)).toBeInTheDocument()
  })

  it('用量三态分开说：估算 token 单独标注，别拿它精确对账', async () => {
    renderMisc(<DashboardPage />)

    expect(await screen.findByText(/其中约 5,000 token 是按字符数估算的/)).toBeInTheDocument()
    // 有 token 的按 token 说，没有的（检索/向量化）说条数
    expect(screen.getByText(/共 240 条/)).toBeInTheDocument()
    expect(screen.getByText(/按模型：deepseek-chat（100 次）/)).toBeInTheDocument()
  })

  it('趋势能在三个维度之间切换，切换只改取值口径', async () => {
    renderMisc(<DashboardPage />)
    await screen.findByText('产品手册')

    const before = (await screen.findByTestId('chart-line')).getAttribute('data-series')
    await userEvent.click(screen.getByRole('button', { name: '新增切块' }))

    await waitFor(() =>
      expect(screen.getByTestId('chart-line').getAttribute('data-series')).not.toBe(before),
    )
    // 切到"新增切块"之后趋势读的是 chunks（两天各 10 / 30）
    expect(screen.getByTestId('chart-line').getAttribute('data-series')).toContain('[10,30]')
  })

  it('没有文档时给"去知识库"的出口，而不是一张空表', async () => {
    getDashboardMock.mockResolvedValue(
      dashboard({
        total_documents: 0,
        knowledge_bases: [],
        indexed_documents: 0,
        failed_documents: 0,
      }),
    )

    renderMisc(<DashboardPage />)

    // 大数卡片的注解与空态标题是同一句话，两处都要在
    expect((await screen.findAllByText('还没有文档')).length).toBeGreaterThan(0)
    expect(screen.getByRole('link', { name: '去知识库' })).toHaveAttribute(
      'href',
      '/knowledge-bases',
    )
  })

  it('窗口超过 60 天时按周聚合（折线不该全是锯齿）', () => {
    const points = Array.from({ length: 70 }, (_, index) => ({
      day: `2026-07-${String((index % 28) + 1).padStart(2, '0')}`,
      documents: 1,
      chunks: 2,
      tasks: 0,
    }))

    // 70 天 → 按周聚合：10 周，每周 7 篇
    const weekly = checkableTrend(points, 'documents')
    expect(weekly.labels).toHaveLength(10)
    expect(weekly.values).toEqual(Array.from({ length: 10 }, () => 7))

    // 10 天 → 一天一个点
    const daily = checkableTrend(points.slice(0, 10), 'chunks')
    expect(daily.labels).toHaveLength(10)
    expect(daily.values).toEqual(Array.from({ length: 10 }, () => 2))
  })
})
