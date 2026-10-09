/**
 * 记忆页的用例（v0.57 起后端是 mem0；2026-10-09 按 mem0 生态重排）。
 *
 * 这一页从上到下是：**页头读数 + 动作**、检索行、分区筛选、条目列表。用例按
 * "用户能看见的那件事"分组：
 *
 * 1. 页头：条数、上次更新（**本机时区的相对时间**）、状态点，以及兜底提示（平时不出现）；
 * 2. 列表与空态：条目怎么画、**无记忆与搜不到是两条不同的空态**；
 * 3. 搜索：回车才检索（不是每敲一个字发一次）、关着时如实报错；
 * 4. 分区筛选：chip 由条目上的分区生成、单选即本地过滤；
 * 5. 改 / 删：按 id 走、**删除要行内确认**、回执用后端那一句；
 * 6. 历史：只读、按需加载、排成最旧在前的时间线；
 * 7. 加一条：页头那一个入口；
 * 8. 旧档案横幅：只有后端说"有可导的"才出现，导入/不再需要之后消失；
 * 9. 人设那一块**确实不在了**（人是人设层的事，不是记忆）。
 *
 * ## 被删掉的旧用例与理由
 *
 * 那批用例钉的界面已经不存在了（人设文件只读区、常驻的导入入口、变更流卡片），
 * 留着只会变成对不存在功能的断言：
 *
 * - **人设文件**（`persona-file*`、`persona-file-content`、`persona-file-path`）——
 *   整块从记忆页删掉，读文件那个端点也随之删了；
 * - **常驻的「导入旧档案」入口**（`migration-entry`）——改成"后端说有可导的才出现"
 *   的一次性横幅；
 * - **状态横幅 / 工作区路径**（`StatusTag` 那些断言、`memory-workspace`）——
 *   读数收成一行：`N 条 · 上次更新 …` + 一个小状态点；
 * - **档案制措辞**（"档案" / "注入"）与对分区含义的解释——一个不留；
 * - **切出来的 UTC 时间**（`2026-10-04 09:00` 那种写法，其实是后端那串 UTC）——
 *   换成 `lib/format` 的两个件（相对时间 / 本机绝对时间），时间夹具也跟着
 *   从写死的日期改成"相对现在"。
 *
 * 保留下来的旧口径只有两条，换成新形状继续钉：**界面不解释机制**与
 * **界面不出现凭据**。
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/memory', () => ({
  getMemory: vi.fn(),
  getMemoryItems: vi.fn(),
  createMemoryItem: vi.fn(),
  updateMemoryItem: vi.fn(),
  deleteMemoryItem: vi.fn(),
  getMemoryItemHistory: vi.fn(),
  importLegacyMemory: vi.fn(),
}))

vi.mock('@/api/settings', () => ({
  getSettings: vi.fn(async () => ({ groups: [] })),
  updateSettings: vi.fn(),
}))

import {
  createMemoryItem,
  deleteMemoryItem,
  getMemory,
  getMemoryItemHistory,
  getMemoryItems,
  importLegacyMemory,
  updateMemoryItem,
  type MemoryItem,
  type MemoryImport,
  type MemoryOverview,
} from '@/api/memory'
import { setLocalBackendForTest } from '@/api/local'
import { MemoryPage } from '@/features/misc/memory/MemoryPage'
import { renderMisc } from '@/features/misc/testing/harness'
import { resetToasts } from '@/features/misc/shared/toast'
import { formatDate } from '@/lib/format'
import { useSessionStore } from '@/lib/session'

const getMemoryMock = vi.mocked(getMemory)
const getItemsMock = vi.mocked(getMemoryItems)
const createMock = vi.mocked(createMemoryItem)
const updateMock = vi.mocked(updateMemoryItem)
const deleteMock = vi.mocked(deleteMemoryItem)
const historyMock = vi.mocked(getMemoryItemHistory)
const importMock = vi.mocked(importLegacyMemory)

/** 列表数据是可变的：写入之后后端读到新的一份，用例模拟这件事。 */
let itemsState: MemoryItem[]

/**
 * 时间夹具一律**相对现在**（后端给 ISO（UTC），界面按本机时区显示成相对时间）。
 *
 * 写死一个日期不行：`formatRelativeTime` 给的是"刚刚 / 5 分钟前 / 3 天前 / 本地日期"，
 * 同一个日期在不同机器、不同日子上会变成不同的句子——而这一页要钉的正是那句话。
 */
const NOW = Date.now()
const RECENT = new Date(NOW - 5 * 60_000).toISOString() // 5 分钟前
const EARLIER = new Date(NOW - 3 * 3600_000).toISOString() // 3 小时前
const OLD = new Date(NOW - 30 * 86400_000).toISOString() // 超过一周 → 本机日期的绝对时间

function itemOf(id: string, text: string, extra: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id,
    text,
    section: '长期偏好与风格',
    source: '显式',
    created_at: RECENT,
    updated_at: RECENT,
    score: null,
    ...extra,
  }
}

function overviewOf(overrides: Partial<MemoryOverview['status']> = {}): MemoryOverview {
  return {
    status: {
      enabled: true,
      workspace: 'D:\\kylab\\memory',
      detail: '',
      items: itemsState.length,
      last_changed_at: RECENT,
      embedder: 'dev/deterministic-hash',
      development: false,
      legacy_import_available: false,
      ...overrides,
    },
  }
}

function reportOf(overrides: Partial<MemoryImport> = {}): MemoryImport {
  return {
    source: 'PROFILE.md',
    entries: 4,
    imported: 3,
    existing: 1,
    dropped_sensitive: 0,
    skipped: false,
    changed: true,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetToasts()
  useSessionStore.setState({ token: '' })
  // 这些页面走"本机档"那条链（`/memory` 挂在本机后端上）
  setLocalBackendForTest('local')

  itemsState = [
    itemOf('m1', '用户要求回答先给结论'),
    itemOf('m2', '用户的内网有一台 L20', { section: '工具与环境', source: '迁移' }),
  ]

  getMemoryMock.mockImplementation(async () => overviewOf())
  getItemsMock.mockImplementation(async (query = '') =>
    query
      ? {
          query,
          items: itemsState.filter((item) => item.text.includes(query)),
          total: 1,
          note: '这是**长期记忆**，不是知识库原文。',
        }
      : { query: '', items: itemsState, total: itemsState.length, note: '' },
  )
  createMock.mockResolvedValue({
    action: 'added',
    receipt: '记下了：新的一条',
    text: '新的一条',
    section: '长期偏好与风格',
    replaced: '',
    item_id: 'm3',
  })
  updateMock.mockResolvedValue({
    action: 'replaced',
    receipt: '改成：新的一条（旧的留在历史里）',
    text: '新的一条',
    section: '长期偏好与风格',
    replaced: '旧的一条',
    item_id: 'm1',
  })
  deleteMock.mockResolvedValue({
    action: 'forgotten',
    receipt: '忘掉了：用户要求回答先给结论。',
    text: '用户要求回答先给结论',
    section: '长期偏好与风格',
    replaced: '用户要求回答先给结论',
    item_id: 'm1',
  })
  importMock.mockResolvedValue(reportOf())
  historyMock.mockResolvedValue({
    id: 'm1',
    items: [
      {
        at: EARLIER,
        event: 'ADD',
        old: '',
        new: '用户要求回答先给结论',
        deleted: false,
      },
      {
        at: RECENT,
        event: 'UPDATE',
        old: '用户要求回答先给结论',
        new: '用户要求回答简短，先给结论',
        deleted: false,
      },
    ],
  })
})

// ------------------------------------------------------------------ 页头

describe('记忆页 · 页头', () => {
  it('报条数与上次更新，状态点跟着开关走（读数都是后端给的）', async () => {
    renderMisc(<MemoryPage />)

    expect(await screen.findByTestId('memory-count')).toHaveTextContent('2 条')
    const updated = screen.getByTestId('memory-updated')
    expect(updated).toHaveTextContent('上次更新 5 分钟前')
    // 确切时刻仍在：hover 给的是**本机时区**的绝对时间
    expect(updated).toHaveAttribute('title', formatDate(RECENT))
    expect(screen.getByTestId('memory-status-dot')).toHaveAttribute('data-tone', 'ok')
  })

  it('读到的时间按本机时区显示，不是后端那串 UTC', async () => {
    // 上一代的做法是把 ISO 切成 `YYYY-MM-DD HH:mm` 直接显示——那是一串 UTC 数字，
    // 比本机早 8 小时。两条各钉一档：**新鲜的给相对时间**（上面那条），
    // 一天以上的给本机日期（下面这条）。
    itemsState = [itemOf('m1', '很久以前记的一条', { updated_at: OLD })]
    renderMisc(<MemoryPage />)

    const rows = await screen.findAllByTestId('memory-item')
    const meta = within(rows[0]).getByTestId('memory-item-meta')
    expect(meta).toHaveTextContent(formatDate(OLD))
    // 本机就在 UTC 时区跑（`TZ=UTC` 的容器）时，这两串本来就一样——那时这条断言没有
    // 可断的东西，跳过比写死一个只有东八区才成立的期望值诚实
    const utcSlice = OLD.replace('T', ' ').slice(0, 16)
    if (new Date(OLD).getTimezoneOffset() !== 0) {
      expect(meta).not.toHaveTextContent(utcSlice)
    }
  })

  it('关着时状态点是另一档，读数照旧（记忆可编辑，只有注入与检索停）', async () => {
    getMemoryMock.mockImplementation(async () => overviewOf({ enabled: false }))
    renderMisc(<MemoryPage />)

    await screen.findByTestId('memory-count')
    expect(screen.getByTestId('memory-status-dot')).toHaveAttribute('data-tone', 'off')
  })

  it('平时不提示兜底', async () => {
    renderMisc(<MemoryPage />)

    await screen.findByTestId('memory-count')
    expect(screen.queryByTestId('memory-development')).toBeNull()
  })

  it('向量是兜底时用一行小字说清（不是大段横幅）', async () => {
    getMemoryMock.mockImplementation(async () => overviewOf({ development: true }))
    renderMisc(<MemoryPage />)

    const line = await screen.findByTestId('memory-development')

    expect(line.textContent).toContain('兜底')
    // 一行小字：它不再是一块 Notice（横幅那种形态留给"要你动手"的事）
    expect(line.className).toContain('m-muted')
  })

  it('界面不出现实现细节词（token / 向量库 / embedding 这类）', async () => {
    renderMisc(<MemoryPage />)
    await screen.findByTestId('memory-count')

    const text = document.body.textContent ?? ''
    for (const word of ['token', 'qdrant', 'mem0', 'embedding', 'SQLite', '提示词预算']) {
      expect(text).not.toContain(word)
    }
  })

  it('界面不出现凭据', async () => {
    renderMisc(<MemoryPage />)
    await screen.findByTestId('memory-count')

    const text = document.body.textContent ?? ''
    expect(text).not.toContain('sk-')
    expect(text).not.toContain('Bearer')
  })
})

// ------------------------------------------------------------------ 列表与空态

describe('记忆页 · 条目列表', () => {
  it('按后端给的顺序画条目，每条带 id、分区标签与来源', async () => {
    renderMisc(<MemoryPage />)

    const rows = await screen.findAllByTestId('memory-item')
    expect(rows.map((node) => node.getAttribute('data-id'))).toEqual(['m1', 'm2'])
    expect(within(rows[0]).getByTestId('memory-item-text')).toHaveTextContent(
      '用户要求回答先给结论',
    )
    expect(within(rows[0]).getByTestId('memory-item-section')).toHaveTextContent('长期偏好与风格')
    // 来源是事实，不是机制说明
    expect(within(rows[1]).getByTestId('memory-item-meta')).toHaveTextContent('来自旧档案')
  })

  it('一条都没有时说清"还没有记忆"并给出两条开始的路', async () => {
    itemsState = []
    renderMisc(<MemoryPage />)

    expect(await screen.findByText('还没有记忆')).toBeTruthy()
    expect(screen.getByText('说一句『记住…』，或点『加一条』。')).toBeTruthy()
  })
})

// ------------------------------------------------------------------ 搜索

describe('记忆页 · 搜索', () => {
  it('回车才检索（不是每敲一个字发一次）', async () => {
    const user = userEvent.setup()
    renderMisc(<MemoryPage />)
    await screen.findAllByTestId('memory-item')

    const box = screen.getByTestId('memory-search')
    await user.type(box, '先给结论')
    expect(getItemsMock).toHaveBeenCalledTimes(1) // 只有首屏那次

    await user.keyboard('{Enter}')

    await waitFor(() => expect(getItemsMock).toHaveBeenCalledTimes(2))
    expect(getItemsMock).toHaveBeenLastCalledWith('先给结论')
    // 结果里只剩命中的条目：那句"这是长期记忆、不是知识库原文"是给模型看的
    // （工具那一侧用它），**界面上不放**——人不需要被解释这一层是什么
    expect(screen.queryByText(/不是知识库原文/)).toBeNull()
  })

  it('搜不到时的空态与"无记忆"分开，并说清没有提到那句话', async () => {
    const user = userEvent.setup()
    renderMisc(<MemoryPage />)
    await screen.findAllByTestId('memory-item')

    await user.type(screen.getByTestId('memory-search'), '合唱团的排练时间{Enter}')

    expect(await screen.findByText('没有搜到')).toBeTruthy()
    expect(screen.getByText('没有提到「合唱团的排练时间」的记忆，换个说法再搜。')).toBeTruthy()
    expect(screen.queryByText('还没有记忆')).toBeNull()
  })

  it('清空之后回到全部', async () => {
    const user = userEvent.setup()
    renderMisc(<MemoryPage />)
    await screen.findAllByTestId('memory-item')

    await user.type(screen.getByTestId('memory-search'), '先给结论{Enter}')
    await screen.findAllByTestId('memory-item')
    await user.click(screen.getByTestId('memory-search-clear'))

    await waitFor(() => expect(screen.getAllByTestId('memory-item')).toHaveLength(2))
  })

  it('检索结果行尾不给相关度数字（score 只在本条查询内可比）', async () => {
    getItemsMock.mockImplementation(async (query = '') =>
      query
        ? {
            query,
            items: [itemOf('m1', '用户要求回答先给结论', { score: 0.87 })],
            total: 1,
            note: '',
          }
        : { query: '', items: itemsState, total: itemsState.length, note: '' },
    )
    const user = userEvent.setup()
    renderMisc(<MemoryPage />)
    await screen.findAllByTestId('memory-item')

    await user.type(screen.getByTestId('memory-search'), '先给结论{Enter}')
    await screen.findAllByTestId('memory-item')

    expect(document.body.textContent ?? '').not.toContain('0.87')
  })

  it('记忆关着时搜索如实报错（它是检索，受那道闸管）', async () => {
    getItemsMock.mockImplementation(async (query = '') => {
      if (query) throw new Error('未启用长期记忆。请在「设置 → 长期记忆」里打开')
      return { query: '', items: itemsState, total: itemsState.length, note: '' }
    })
    const user = userEvent.setup()
    renderMisc(<MemoryPage />)
    await screen.findAllByTestId('memory-item')

    await user.type(screen.getByTestId('memory-search'), '先给结论{Enter}')

    expect(await screen.findByTestId('memory-items-error')).toHaveTextContent('未启用长期记忆')
  })
})

// ------------------------------------------------------------------ 分区筛选

describe('记忆页 · 分区筛选', () => {
  it('条目有分区时才出现这一行，内容是「全部 + 各分区」', async () => {
    renderMisc(<MemoryPage />)
    await screen.findAllByTestId('memory-item')

    const chips = screen.getAllByTestId('memory-section-chip')
    expect(chips.map((node) => node.textContent)).toEqual(['全部', '长期偏好与风格', '工具与环境'])
    expect(chips[0]).toHaveAttribute('aria-pressed', 'true')
    // 分区是标签，不是名词解释：chip 上只有分区名本身
    expect(screen.queryByText(/分区/)).toBeNull()
  })

  it('一条都没有时这一行不出现（它跟着条目走）', async () => {
    itemsState = []
    renderMisc(<MemoryPage />)

    await screen.findByText('还没有记忆')
    expect(screen.queryByTestId('memory-sections')).toBeNull()
  })

  it('点一个分区只留那一区（本地过滤，不再发请求）', async () => {
    const user = userEvent.setup()
    renderMisc(<MemoryPage />)
    await screen.findAllByTestId('memory-item')
    const calls = getItemsMock.mock.calls.length

    const chips = within(screen.getByTestId('memory-sections'))
    await user.click(chips.getByText('工具与环境'))

    const rows = screen.getAllByTestId('memory-item')
    expect(rows).toHaveLength(1)
    expect(rows[0].getAttribute('data-id')).toBe('m2')
    expect(getItemsMock).toHaveBeenCalledTimes(calls)

    await user.click(chips.getByText('全部'))
    expect(screen.getAllByTestId('memory-item')).toHaveLength(2)
  })

  it('换一次检索就把分区筛选收回去（它属于上一屏）', async () => {
    const user = userEvent.setup()
    renderMisc(<MemoryPage />)
    await screen.findAllByTestId('memory-item')

    await user.click(within(screen.getByTestId('memory-sections')).getByText('工具与环境'))
    await user.type(screen.getByTestId('memory-search'), '先给结论{Enter}')
    await screen.findAllByTestId('memory-item')

    expect(screen.getAllByTestId('memory-item')).toHaveLength(1)
    expect(screen.getByText('全部')).toHaveAttribute('aria-pressed', 'true')
  })
})

// ------------------------------------------------------------------ 改与删

describe('记忆页 · 改一条', () => {
  it('点正文变输入框，失焦保存走一次 PATCH（带上那个 id）', async () => {
    const user = userEvent.setup()
    renderMisc(<MemoryPage />)
    await screen.findAllByTestId('memory-item')

    await user.click(screen.getAllByTestId('memory-item-text')[0])
    const input = screen.getByTestId('memory-item-input')
    await user.clear(input)
    await user.type(input, '新的一条')
    fireEvent.blur(input)

    await waitFor(() => expect(updateMock).toHaveBeenCalledWith('m1', { content: '新的一条' }))
    // 回执是后端那一句，界面不另编
    expect(await screen.findByText(/改成：新的一条/)).toBeTruthy()
  })

  it('Esc 取消：回到只读正文，一个字都不写', async () => {
    const user = userEvent.setup()
    renderMisc(<MemoryPage />)
    await screen.findAllByTestId('memory-item')

    await user.click(screen.getAllByTestId('memory-item-text')[0])
    await user.type(screen.getByTestId('memory-item-input'), '改了一半')
    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByTestId('memory-item-input')).toBeNull())
    expect(updateMock).not.toHaveBeenCalled()
  })

  it('内容没变时不发请求（点开又关掉不该写一次历史）', async () => {
    const user = userEvent.setup()
    renderMisc(<MemoryPage />)
    await screen.findAllByTestId('memory-item')

    await user.click(screen.getAllByTestId('memory-item-text')[0])
    fireEvent.blur(screen.getByTestId('memory-item-input'))

    await waitFor(() => expect(screen.queryByTestId('memory-item-input')).toBeNull())
    expect(updateMock).not.toHaveBeenCalled()
  })
})

describe('记忆页 · 删一条', () => {
  it('删除键先问一句「删除？」，取消就什么都不发生', async () => {
    const user = userEvent.setup()
    renderMisc(<MemoryPage />)
    await screen.findAllByTestId('memory-item')

    await user.click(
      within(screen.getAllByTestId('memory-item')[0]).getByTestId('memory-item-delete'),
    )

    expect(screen.getByText('删除？')).toBeTruthy()
    await user.click(screen.getByTestId('memory-item-delete-cancel'))

    expect(deleteMock).not.toHaveBeenCalled()
    expect(screen.queryByText('删除？')).toBeNull()
  })

  it('确认之后才 DELETE，回执照样弹出来', async () => {
    const user = userEvent.setup()
    renderMisc(<MemoryPage />)
    await screen.findAllByTestId('memory-item')

    await user.click(screen.getAllByTestId('memory-item-delete')[0])
    await user.click(screen.getByTestId('memory-item-delete-confirm'))

    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('m1'))
    expect(await screen.findByText(/忘掉了/)).toBeTruthy()
  })
})

// ------------------------------------------------------------------ 历史

describe('记忆页 · 历史', () => {
  it('点开才读历史，排成最旧在前的时间线（旧 → 新 + 时间）', async () => {
    const user = userEvent.setup()
    renderMisc(<MemoryPage />)
    await screen.findAllByTestId('memory-item')
    expect(historyMock).not.toHaveBeenCalled()

    await user.click(screen.getAllByTestId('memory-item-history')[0])

    await waitFor(() => expect(historyMock).toHaveBeenCalledWith('m1'))
    const rows = await screen.findAllByTestId('memory-history-row')
    expect(rows).toHaveLength(2)
    // 最旧在前：先"记下"，再"改成"
    expect(within(rows[0]).getByText('记下')).toBeTruthy()
    expect(rows[0].getAttribute('data-event')).toBe('ADD')
    expect(within(rows[0]).queryByTestId('memory-history-old')).toBeNull()
    expect(within(rows[1]).getByText('改成')).toBeTruthy()
    expect(within(rows[1]).getByTestId('memory-history-old')).toHaveTextContent(
      '用户要求回答先给结论',
    )
    expect(within(rows[1]).getByTestId('memory-history-new')).toHaveTextContent(
      '用户要求回答简短，先给结论',
    )
    // 时间也是本机时区的相对时间（不是后端那串 UTC），确切时刻在 title 上
    expect(within(rows[0]).getByText('3 小时前')).toBeTruthy()
    expect(within(rows[1]).getByText('5 分钟前')).toHaveAttribute('title', formatDate(RECENT))
    // **只读**：历史里没有任何"还原"入口
    expect(screen.queryByText('还原')).toBeNull()
  })
})

// ------------------------------------------------------------------ 加一条

describe('记忆页 · 加一条', () => {
  it('页头那一个是唯一的入口，走 POST 并把回执弹出来', async () => {
    const user = userEvent.setup()
    renderMisc(<MemoryPage />)
    await screen.findAllByTestId('memory-item')

    // 底部那条已经撤掉：整页只有一个「加一条」
    expect(screen.getAllByTestId('memory-add')).toHaveLength(1)
    await user.click(screen.getByTestId('memory-add'))
    await user.type(screen.getByTestId('memory-add-input'), '新的一条')
    await user.click(screen.getByTestId('memory-add-save'))

    await waitFor(() => expect(createMock).toHaveBeenCalledWith('新的一条'))
    expect(await screen.findByText(/记下了：新的一条/)).toBeTruthy()
  })

  it('空内容时保存键不可点', async () => {
    const user = userEvent.setup()
    renderMisc(<MemoryPage />)
    await screen.findAllByTestId('memory-item')

    await user.click(screen.getByTestId('memory-add'))

    expect(screen.getByTestId('memory-add-save')).toBeDisabled()
  })
})

// ------------------------------------------------------------------ 旧档案横幅

describe('记忆页 · 旧档案横幅', () => {
  it('后端没说有可导的就一个入口都不摆', async () => {
    renderMisc(<MemoryPage />)
    await screen.findAllByTestId('memory-item')

    expect(screen.queryByTestId('migration-banner')).toBeNull()
    expect(screen.queryByText('导入旧档案')).toBeNull()
  })

  it('说有可导的时出现，点一下能导、并把报告弹出来', async () => {
    getMemoryMock.mockImplementation(async () => overviewOf({ legacy_import_available: true }))
    const user = userEvent.setup()
    renderMisc(<MemoryPage />)

    const banner = await screen.findByTestId('migration-banner')
    await user.click(within(banner).getByTestId('migration-run'))

    await waitFor(() => expect(importMock).toHaveBeenCalledTimes(1))
    const report = await screen.findByTestId('migration-report')
    expect(within(report).getByText('3 条')).toBeTruthy()
    expect(within(report).getByText('PROFILE.md')).toBeTruthy()
  })

  it('搬完之后横幅消失（后端说没有了，界面上不留痕迹）', async () => {
    let available = true
    getMemoryMock.mockImplementation(async () => overviewOf({ legacy_import_available: available }))
    importMock.mockImplementation(async () => {
      available = false
      return reportOf()
    })
    const user = userEvent.setup()
    renderMisc(<MemoryPage />)

    await user.click(await screen.findByTestId('migration-run'))

    await waitFor(() => expect(screen.queryByTestId('migration-banner')).toBeNull())
  })

  it('不想导的人也能收掉它（这条标记只活在这一屏）', async () => {
    getMemoryMock.mockImplementation(async () => overviewOf({ legacy_import_available: true }))
    const user = userEvent.setup()
    renderMisc(<MemoryPage />)

    await user.click(await screen.findByTestId('migration-dismiss'))

    expect(screen.queryByTestId('migration-banner')).toBeNull()
    expect(importMock).not.toHaveBeenCalled()
  })
})

// ------------------------------------------------------------------ 人设那一块

describe('记忆页 · 人设不在这一页', () => {
  it('页面上没有人设文件那一节，也没有"注入"这类说法', async () => {
    renderMisc(<MemoryPage />)
    await screen.findAllByTestId('memory-item')

    expect(screen.queryByTestId('memory-persona')).toBeNull()
    expect(screen.queryAllByTestId('persona-file')).toHaveLength(0)
    const text = document.body.textContent ?? ''
    for (const word of ['人设', 'SOUL', 'AGENTS', '注入', '档案（']) {
      expect(text).not.toContain(word)
    }
  })
})
