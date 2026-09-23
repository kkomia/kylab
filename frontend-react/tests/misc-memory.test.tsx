/**
 * 记忆页（旧 `views/MemoryView.vue`）的用例。
 *
 * 三条来自后端的、这一页最容易"搬着搬着就没了"的事实各有一条用例钉住：
 * 1. 只有 `daily/` 与 `digest/` 会被召回、核心文件走注入——编辑区上方那句说明要按它分叉；
 * 2. 保存走的是**原文**（含 frontmatter）：`writeMemoryFile(path, 草稿原文)`；
 * 3. 有未保存改动时切文件**先问**，不静默丢。
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/memory', () => ({
  getMemory: vi.fn(),
  getMemoryFile: vi.fn(),
  writeMemoryFile: vi.fn(),
  deleteMemoryFile: vi.fn(),
  getMemoryGraph: vi.fn(),
  recallMemory: vi.fn(),
  rememberMemory: vi.fn(),
  reindexMemory: vi.fn(),
}))

vi.mock('@/api/settings', () => ({
  getSettings: vi.fn(async () => ({ groups: [] })),
  updateSettings: vi.fn(),
}))

import {
  getMemory,
  getMemoryFile,
  writeMemoryFile,
  type MemoryFile,
  type MemoryOverview,
} from '@/api/memory'
import { layoutGraph } from '@/features/misc/memory/graphLayout'
import { MemoryPage } from '@/features/misc/memory/MemoryPage'
import { renderMisc } from '@/features/misc/testing/harness'
import { resetToasts } from '@/features/misc/shared/toast'

const getMemoryMock = vi.mocked(getMemory)
const getMemoryFileMock = vi.mocked(getMemoryFile)
const writeMemoryFileMock = vi.mocked(writeMemoryFile)

function file(overrides: Partial<MemoryFile> = {}): MemoryFile {
  return {
    path: 'MEMORY.md',
    name: 'MEMORY.md',
    title: 'MEMORY.md',
    kind: 'core',
    summary: '',
    tags: [],
    size_bytes: 120,
    modified_at: '2026-09-23T09:00:00Z',
    links: [],
    retrievable: false,
    injected: true,
    consolidated: false,
    ...overrides,
  }
}

function overview(overrides: Partial<MemoryOverview> = {}): MemoryOverview {
  return {
    status: {
      enabled: true,
      base_url: 'http://127.0.0.1:8790',
      workspace: '/data/memory',
      core_file_exists: true,
      reachable: null,
      detail: '',
      file_count: 3,
      retrievable_count: 1,
      unconsolidated_count: 0,
    },
    files: [
      file(),
      file({
        path: 'daily/2026-09-22.md',
        name: '2026-09-22.md',
        title: '每日 · 09-22',
        kind: 'daily',
        retrievable: true,
        injected: false,
      }),
      file({
        path: 'digest/personal/结论.md',
        name: '结论.md',
        title: '结论',
        kind: 'digest',
        retrievable: true,
        injected: false,
      }),
    ],
    truncated: false,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetToasts()
  getMemoryMock.mockResolvedValue(overview())
  getMemoryFileMock.mockImplementation(async (path) => ({
    ...file({
      path,
      retrievable: path.startsWith('digest/') || path.startsWith('daily/'),
      injected: path === 'MEMORY.md',
    }),
    content: path === 'MEMORY.md' ? '# 核心\n\n- 偏好简洁' : '正文',
    meta: {},
    truncated: false,
    consolidated: null,
  }))
  writeMemoryFileMock.mockImplementation(async (path, content) => ({
    ...file({ path }),
    content,
    meta: {},
    truncated: false,
    consolidated: null,
  }))
})

describe('记忆页', () => {
  it('按固定顺序分组，并默认打开核心记忆（说明走"注入"那一支）', async () => {
    renderMisc(<MemoryPage />)

    expect(await screen.findByText('核心（每轮注入）')).toBeInTheDocument()
    expect(screen.getByText('每日现场（可召回）')).toBeInTheDocument()
    expect(screen.getByText('长期知识（可召回）')).toBeInTheDocument()

    // 首次进入默认打开核心记忆（它是这一页最该被看见的一份）
    expect(await screen.findByLabelText('记忆文件正文')).toHaveValue('# 核心\n\n- 偏好简洁')
    expect(
      screen.getByText(/每轮对话都会把它整份注入上下文（不参与检索，所以搜不到是正常的）/),
    ).toBeInTheDocument()
  })

  it('改了草稿点保存：把**原文**交给接口，并按返回内容刷新编辑器', async () => {
    renderMisc(<MemoryPage />)
    const editor = await screen.findByLabelText('记忆文件正文')

    await userEvent.clear(editor)
    await userEvent.type(editor, '# 改过了')
    await userEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(writeMemoryFileMock).toHaveBeenCalledWith('MEMORY.md', '# 改过了'))
    expect(await screen.findByText('已保存')).toBeInTheDocument()
    expect(screen.getByLabelText('记忆文件正文')).toHaveValue('# 改过了')
  })

  it('有未保存改动时切文件先弹确认，放弃之后才真的切过去', async () => {
    renderMisc(<MemoryPage />)
    const editor = await screen.findByLabelText('记忆文件正文')
    await userEvent.type(editor, '\n- 新增一行')

    await userEvent.click(screen.getByRole('button', { name: /每日 · 09-22/ }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('放弃未保存的改动？')).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: '放弃改动' }))

    await waitFor(() => expect(getMemoryFileMock).toHaveBeenCalledWith('daily/2026-09-22.md'))
    expect(await screen.findByText(/会被「召回」（记忆检索）找到/)).toBeInTheDocument()
  })

  it('保存失败时草稿仍留在编辑器里，并把原因摆在上方', async () => {
    writeMemoryFileMock.mockRejectedValueOnce(new Error('磁盘只读'))
    renderMisc(<MemoryPage />)
    const editor = await screen.findByLabelText('记忆文件正文')

    await userEvent.type(editor, 'x')
    await userEvent.click(screen.getByRole('button', { name: '保存' }))

    expect(
      await screen.findByText(/磁盘只读（你的改动还在编辑器里，可以再存一次）/),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('记忆文件正文')).toHaveValue('# 核心\n\n- 偏好简洁x')
  })
})

describe('记忆图谱布局（纯函数，确定性）', () => {
  it('同一份输入算两次完全一致，孤立节点不画（图要回答的是结构）', () => {
    const nodes = [
      { path: 'MEMORY.md', title: '核心', kind: 'core' as const, degree: 2 },
      { path: 'digest/a.md', title: 'a', kind: 'digest' as const, degree: 1 },
      { path: 'digest/b.md', title: 'b', kind: 'digest' as const, degree: 1 },
      { path: 'daily/孤立.md', title: '孤立', kind: 'daily' as const, degree: 0 },
    ]
    const edges: [string, string][] = [
      ['MEMORY.md', 'digest/a.md'],
      ['MEMORY.md', 'digest/b.md'],
    ]

    const first = layoutGraph(nodes, edges)
    const second = layoutGraph(nodes, edges)
    expect(first.viewBox).toBe(second.viewBox)
    expect(first.placed).toEqual(second.placed)
    // 度 0 的那个不进图：一堆散点会把结构淹掉
    expect(first.placed.map((item) => item.node.path)).not.toContain('daily/孤立.md')
    // 枢纽（度最大）放在自己那一格的中心（第 0 环 = 分量中心）
    const hub = first.placed.find((item) => item.node.path === 'MEMORY.md')
    expect(hub && Math.abs(hub.y - first.height / 2)).toBeLessThan(1e-9)
    // 半径随链接数增长，但封顶（度 6 与度 40 一样大）
    expect((hub?.r ?? 0) > (first.placed.find((i) => i.node.path === 'digest/a.md')?.r ?? 0)).toBe(
      true,
    )
  })

  it('给出画布宽度时只把间距放大、不放大字号（上限 1.6 倍）', () => {
    const nodes = [
      { path: 'a.md', title: 'a', kind: 'core' as const, degree: 1 },
      { path: 'b.md', title: 'b', kind: 'digest' as const, degree: 1 },
    ]
    const edges: [string, string][] = [['a.md', 'b.md']]

    const narrow = layoutGraph(nodes, edges, { width: 200 })
    const wide = layoutGraph(nodes, edges, { width: 4000 })
    expect(wide.width).toBeGreaterThan(narrow.width)
    // 上限 1.6 倍：五六个节点的图拉满一屏反而看不出谁和谁抱团
    expect(wide.width / narrow.width).toBeLessThanOrEqual(1.6 + 1e-9)
  })
})
