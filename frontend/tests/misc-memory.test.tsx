/**
 * 记忆页（条目列表）的用例。v0.57 起后端是 mem0，这一页从"档案卡 + 变更流"
 * 换成了**一屏条目**：搜索框、条目（改 / 删 / 看历史）、加一条、迁移入口、
 * 人设文件只读查看。
 *
 * 用例按"用户能看见的那件事"分组：
 * 1. 列表与状态：条目怎么画、空态说什么、兜底提示什么时候出现；
 * 2. 搜索：回车才检索（不是每敲一个字发一次）、关着时如实报错；
 * 3. 按 id 改与删：走的是那个 id、回执用后端那一句；
 * 4. 历史：只读、按需加载；
 * 5. 加一条与迁移：入口与报告；
 * 6. 人设文件：只读打开、`PROFILE.md` 明确写"不再注入"。
 *
 * ## 被删掉的旧用例与理由
 *
 * 那批用例钉的界面已经不存在了（档案制下线），留着只会变成对不存在功能的断言：
 *
 * - **分区读数与变色**（`按后端给的顺序画四个分区，项目区按组显示`、读数格式）——
 *   分区不再是界面上的组织方式（条目列表按时间倒序），预算那一层也退场了；
 * - **项目组与组改名**（`archive-group*`）——mem0 没有"组"这个概念；
 * - **变更流与还原**（`倒序给`、`还原`）——变更流随档案制退场，历史改成
 *   点开某一条时按需读（只读，没有"还原"）；
 * - **迁移草稿与「整理初稿」**——那一步是一次模型整理，已经删掉；
 *   现在只有"导入旧档案"这一条零模型调用的路。
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
  getMemoryFile: vi.fn(),
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
  getMemoryFile,
  getMemoryItemHistory,
  getMemoryItems,
  importLegacyMemory,
  updateMemoryItem,
  type MemoryItem,
  type MemoryOverview,
} from '@/api/memory'
import { setLocalBackendForTest } from '@/api/local'
import { MemoryPage } from '@/features/misc/memory/MemoryPage'
import { renderMisc } from '@/features/misc/testing/harness'
import { resetToasts } from '@/features/misc/shared/toast'
import { useSessionStore } from '@/lib/session'

const getMemoryMock = vi.mocked(getMemory)
const getItemsMock = vi.mocked(getMemoryItems)
const getFileMock = vi.mocked(getMemoryFile)
const createMock = vi.mocked(createMemoryItem)
const updateMock = vi.mocked(updateMemoryItem)
const deleteMock = vi.mocked(deleteMemoryItem)
const historyMock = vi.mocked(getMemoryItemHistory)
const importMock = vi.mocked(importLegacyMemory)

/** 列表数据是可变的：写入之后后端读到新的一份，用例模拟这件事。 */
let itemsState: MemoryItem[]

function itemOf(id: string, text: string, extra: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id,
    text,
    section: '长期偏好与风格',
    source: '显式',
    created_at: '2026-10-04T09:00:00+00:00',
    updated_at: '2026-10-04T09:00:00+00:00',
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
      last_changed_at: '2026-10-04T09:00:00+00:00',
      embedder: 'dev/deterministic-hash',
      development: false,
      ...overrides,
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetToasts()
  useSessionStore.setState({ token: '' })
  // 这些页面走"本机档"那条链（`/memory` 挂在本机后端上）
  setLocalBackendForTest('local')

  itemsState = [itemOf('m1', '用户要求回答先给结论')]

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
  getFileMock.mockImplementation(async (path) => ({
    path,
    name: path,
    title: path,
    kind: 'core',
    summary: '',
    tags: [],
    size_bytes: 10,
    modified_at: '2026-10-04T09:00:00Z',
    content: `# ${path}\n\n正文\n`,
    meta: {},
    truncated: false,
  }))
  createMock.mockResolvedValue({
    action: 'added',
    receipt: '记下了：新的一条',
    text: '新的一条',
    section: '长期偏好与风格',
    replaced: '',
    item_id: 'm2',
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
  importMock.mockResolvedValue({
    source: 'PROFILE.md',
    entries: 4,
    imported: 3,
    existing: 1,
    dropped_sensitive: 0,
    skipped: false,
    changed: true,
  })
  historyMock.mockResolvedValue({
    id: 'm1',
    items: [
      {
        at: '2026-10-04T09:00:00+00:00',
        event: 'ADD',
        old: '',
        new: '用户要求回答先给结论',
        deleted: false,
      },
      {
        at: '2026-10-04T09:05:00+00:00',
        event: 'UPDATE',
        old: '用户要求回答先给结论',
        new: '用户要求回答简短，先给结论',
        deleted: false,
      },
    ],
  })
})

// ------------------------------------------------------------------ 列表与状态

describe('记忆页 · 条目列表', () => {
  it('按后端给的顺序画条目，每条带 id、分区标签与来源', async () => {
    itemsState = [itemOf('m1', '第一条'), itemOf('m2', '第二条', { source: '迁移' })]
    renderMisc(<MemoryPage />)

    const rows = await screen.findAllByTestId('memory-item')
    expect(rows.map((node) => node.getAttribute('data-id'))).toEqual(['m1', 'm2'])
    expect(within(rows[0]).getByTestId('memory-item-text')).toHaveTextContent('第一条')
    expect(within(rows[0]).getByTestId('memory-item-section')).toHaveTextContent('长期偏好与风格')
    // 来源是事实，不是机制说明
    expect(within(rows[1]).getByTestId('memory-item-meta')).toHaveTextContent('来自旧档案')
  })

  it('状态报条数、路径与上次更新（读数都是后端给的）', async () => {
    renderMisc(<MemoryPage />)

    expect(await screen.findByTestId('memory-count')).toHaveTextContent('1 条')
    expect(screen.getByTestId('memory-workspace')).toHaveTextContent('D:\\kylab\\memory')
    expect(screen.getByTestId('memory-updated')).toHaveTextContent('2026-10-04 09:00')
  })

  it('一条都没有时说清"还是空的"，而不是画一块空白', async () => {
    itemsState = []
    renderMisc(<MemoryPage />)

    expect(await screen.findByText('记忆还是空的')).toBeTruthy()
  })

  it('平时不提示兜底', async () => {
    renderMisc(<MemoryPage />)

    await screen.findByTestId('memory-count')
    expect(screen.queryByTestId('memory-development')).toBeNull()
  })

  it('向量是兜底时明说这件事（免得用户把词面重合当语义）', async () => {
    getMemoryMock.mockImplementation(async () => overviewOf({ development: true }))
    renderMisc(<MemoryPage />)

    const notice = await screen.findByTestId('memory-development')

    expect(notice.textContent).toContain('兜底')
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

// ------------------------------------------------------------------ 搜索

describe('记忆页 · 搜索', () => {
  it('回车才检索（不是每敲一个字发一次）', async () => {
    const user = userEvent.setup()
    renderMisc(<MemoryPage />)
    await screen.findByTestId('memory-item')

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

  it('清空之后回到列表（并说明"没有匹配"是检索的空态）', async () => {
    const user = userEvent.setup()
    renderMisc(<MemoryPage />)
    await screen.findByTestId('memory-item')

    await user.type(screen.getByTestId('memory-search'), '不相干的话{Enter}')

    expect(await screen.findByText('没有匹配的条目')).toBeTruthy()
    await user.click(screen.getByTestId('memory-search-clear'))
    expect(await screen.findByTestId('memory-item')).toBeTruthy()
  })

  it('记忆关着时搜索如实报错（它是检索，受那道闸管）', async () => {
    getItemsMock.mockImplementation(async (query = '') => {
      if (query) throw new Error('未启用长期记忆。请在「设置 → 长期记忆」里打开')
      return { query: '', items: itemsState, total: itemsState.length, note: '' }
    })
    const user = userEvent.setup()
    renderMisc(<MemoryPage />)
    await screen.findByTestId('memory-item')

    await user.type(screen.getByTestId('memory-search'), '先给结论{Enter}')

    expect(await screen.findByTestId('memory-items-error')).toHaveTextContent('未启用长期记忆')
  })
})

// ------------------------------------------------------------------ 改与删

describe('记忆页 · 改与删', () => {
  it('改一条：点正文变输入框，失焦保存走一次 PATCH（带上那个 id）', async () => {
    const user = userEvent.setup()
    renderMisc(<MemoryPage />)
    await screen.findByTestId('memory-item')

    await user.click(screen.getByTestId('memory-item-text'))
    const input = screen.getByTestId('memory-item-input')
    await user.clear(input)
    await user.type(input, '新的一条')
    fireEvent.blur(input)

    await waitFor(() => expect(updateMock).toHaveBeenCalledWith('m1', { content: '新的一条' }))
    // 回执是后端那一句，界面不另编
    expect(await screen.findByText(/改成：新的一条/)).toBeTruthy()
  })

  it('内容没变时不发请求（点开又关掉不该写一次历史）', async () => {
    const user = userEvent.setup()
    renderMisc(<MemoryPage />)
    await screen.findByTestId('memory-item')

    await user.click(screen.getByTestId('memory-item-text'))
    fireEvent.blur(screen.getByTestId('memory-item-input'))

    await waitFor(() => expect(screen.queryByTestId('memory-item-input')).toBeNull())
    expect(updateMock).not.toHaveBeenCalled()
  })

  it('删一条按 id 走，回执照样弹出来', async () => {
    const user = userEvent.setup()
    renderMisc(<MemoryPage />)
    await screen.findByTestId('memory-item')

    await user.click(screen.getByTestId('memory-item-delete'))

    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('m1'))
    expect(await screen.findByText(/忘掉了/)).toBeTruthy()
  })
})

// ------------------------------------------------------------------ 历史

describe('记忆页 · 历史', () => {
  it('点开才读历史，画成"旧 → 新"', async () => {
    const user = userEvent.setup()
    renderMisc(<MemoryPage />)
    await screen.findByTestId('memory-item')
    expect(historyMock).not.toHaveBeenCalled()

    await user.click(screen.getByTestId('memory-item-history'))

    await waitFor(() => expect(historyMock).toHaveBeenCalledWith('m1'))
    const rows = await screen.findAllByTestId('memory-history-row')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).getByText('记下')).toBeTruthy()
    expect(within(rows[1]).getByText('改成')).toBeTruthy()
    expect(within(rows[1]).getByText('用户要求回答先给结论')).toBeTruthy()
    // **只读**：历史里没有任何"还原"入口
    expect(screen.queryByText('还原')).toBeNull()
  })
})

// ------------------------------------------------------------------ 加一条与迁移

describe('记忆页 · 加一条', () => {
  it('加一条走 POST 并把回执弹出来', async () => {
    const user = userEvent.setup()
    renderMisc(<MemoryPage />)
    await screen.findByTestId('memory-item')

    await user.click(screen.getByTestId('memory-add'))
    await user.type(screen.getByTestId('memory-add-input'), '新的一条')
    await user.click(screen.getByTestId('memory-add-save'))

    await waitFor(() => expect(createMock).toHaveBeenCalledWith('新的一条'))
    expect(await screen.findByText(/记下了：新的一条/)).toBeTruthy()
  })

  it('空内容时保存键不可点', async () => {
    const user = userEvent.setup()
    renderMisc(<MemoryPage />)
    await screen.findByTestId('memory-item')

    await user.click(screen.getByTestId('memory-add'))

    expect(screen.getByTestId('memory-add-save')).toBeDisabled()
  })
})

describe('记忆页 · 迁移', () => {
  it('导入旧档案之后弹出报告（计数与源文件）', async () => {
    const user = userEvent.setup()
    renderMisc(<MemoryPage />)

    await user.click(await screen.findByTestId('migration-run'))

    await waitFor(() => expect(importMock).toHaveBeenCalledTimes(1))
    const report = await screen.findByTestId('migration-report')
    expect(within(report).getByText('3 条')).toBeTruthy()
    expect(within(report).getByText('PROFILE.md')).toBeTruthy()
  })
})

// ------------------------------------------------------------------ 人设文件

describe('记忆页 · 人设文件（只读）', () => {
  it('列出真的读得到的那几份，并把"不再注入"写在旧档案上', async () => {
    getFileMock.mockImplementation(async (path) => {
      if (path === 'SOUL.md') throw new Error('记忆文件不存在：SOUL.md')
      return {
        path,
        name: path,
        title: path,
        kind: 'core',
        summary: '',
        tags: [],
        size_bytes: 10,
        modified_at: '2026-10-04T09:00:00Z',
        content: `# ${path}\n`,
        meta: {},
        truncated: false,
      }
    })
    renderMisc(<MemoryPage />)

    const files = await screen.findAllByTestId('persona-file')
    // 读不到的（SOUL.md）不显示；读得到的两份都在
    expect(files.map((node) => node.textContent)).toEqual([
      expect.stringContaining('AGENTS.md'),
      expect.stringContaining('PROFILE.md'),
    ])
    const old = files.find((node) => node.textContent?.includes('PROFILE.md'))
    expect(old?.textContent).toContain('不再注入')
  })

  it('点开只读展示原文，路径是工作区里的那一条', async () => {
    const user = userEvent.setup()
    renderMisc(<MemoryPage />)
    await screen.findAllByTestId('persona-file')

    await user.click(screen.getAllByTestId('persona-file-open')[0])

    expect(await screen.findByTestId('persona-file-content')).toHaveTextContent('# SOUL.md')
    expect(screen.getByTestId('persona-file-path')).toHaveTextContent('D:\\kylab\\memory/SOUL.md')
  })
})
