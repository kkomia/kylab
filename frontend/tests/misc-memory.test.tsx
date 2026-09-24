/**
 * 记忆页（旧 `views/MemoryView.vue`）的用例。
 *
 * 三条来自后端的、这一页最容易"搬着搬着就没了"的事实各有一条用例钉住：
 * 1. 只有 `daily/` 与 `digest/` 会被召回、核心文件走注入——编辑区上方那句说明要按它分叉；
 * 2. 保存走的是**原文**（含 frontmatter）：`writeMemoryFile(path, 草稿原文)`；
 * 3. 有未保存改动时切文件**先问**，不静默丢。
 *
 * 另加一条是 v0.46 的返工：记忆现在是后端**进程内的本地实现**，所以这一页
 * 不能再有"探测记忆服务"那套（曾经把内部地址、端口与异常原文打给用户看过）。
 * 取而代之的是本地状态（几份文件、多少条可召回、上次更新）——下面的用例钉住
 * "界面上不出现任何服务/地址/连通性字样"，以及那三个数字真的渲染出来。
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
}))

vi.mock('@/api/settings', () => ({
  getSettings: vi.fn(async () => ({ groups: [] })),
  updateSettings: vi.fn(),
}))

import {
  getMemory,
  getMemoryFile,
  recallMemory,
  writeMemoryFile,
  type MemoryFile,
  type MemoryOverview,
} from '@/api/memory'
import { layoutGraph } from '@/features/misc/memory/graphLayout'
import { MemoryPage } from '@/features/misc/memory/MemoryPage'
import { renderMisc } from '@/features/misc/testing/harness'
import { resetToasts } from '@/features/misc/shared/toast'
import { useSessionStore } from '@/lib/session'

const getMemoryMock = vi.mocked(getMemory)
const getMemoryFileMock = vi.mocked(getMemoryFile)
const writeMemoryFileMock = vi.mocked(writeMemoryFile)
const recallMemoryMock = vi.mocked(recallMemory)

/** 记忆页的「设置」是管理员档（成员账号连按钮都不该看见）。 */
function asAdmin(): void {
  useSessionStore.setState({
    token: 'st',
    currentUser: { id: 'u1', username: 'admin', name: '管理员', role: 'admin', avatar_url: '' },
    authStatus: null,
    reloginCount: 0,
  })
}

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
      workspace: '/data/memory',
      core_file_exists: true,
      detail: '',
      file_count: 3,
      retrievable_count: 2,
      entry_count: 12,
      last_changed_at: '2026-09-23T09:00:00Z',
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

/**
 * 页签当前态的抓手。
 *
 * jsdom 不算样式，能钉住的只有"谁来画"：Radix 给触发按钮的 `data-state`，
 * 以及**原语自己**那两条当前态（`data-[state=active]:bg-surface` / 主字色）
 * 是否在按钮的 className 里；再确认按钮内**没有**第一批那层临时垫底
 * `span[data-slot=segment-current]`（它只是绕开病根的补丁，根因修好后不该回来）。
 * 真实的底色差由浏览器截图核对（`.shots/batch2/12-memory.png`）。
 */
function tabState(trigger: HTMLElement) {
  return {
    active: trigger.getAttribute('data-state') === 'active',
    // 原语那条当前态规则确实在按钮上（画不画由 `data-state` 决定，所以这条对两档都成立）
    activeRulePresent:
      trigger.className.includes('data-[state=active]:bg-surface') &&
      trigger.className.includes('data-[state=active]:text-text-primary'),
    // 分段自己的内边距：第一批它和 `background` 一起被那条未分层重置压成 0，两段贴着
    padded: trigger.className.includes('px-3'),
    patched: trigger.querySelector('[data-slot="segment-current"]') !== null,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetToasts()
  useSessionStore.setState({ token: '', currentUser: null })
  getMemoryMock.mockResolvedValue(overview())
  recallMemoryMock.mockResolvedValue({ query: '', hits: [], links: [], note: '' })
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
  it('按固定顺序分组，并默认打开核心记忆；右栏先给渲染后的正文', async () => {
    renderMisc(<MemoryPage />)

    expect(await screen.findByText('核心（每轮注入）')).toBeInTheDocument()
    expect(screen.getByText('每日现场（可召回）')).toBeInTheDocument()
    expect(screen.getByText('长期知识（可召回）')).toBeInTheDocument()

    // 首次进入默认打开核心记忆（它是这一页最该被看见的一份）
    const editor = await screen.findByLabelText('记忆编辑器')
    // **读**是默认：标题渲染成标题、行内标记不再以 `#`/`-` 的原文出现
    expect(within(editor).getByRole('heading', { name: '核心' })).toBeInTheDocument()
    expect(within(editor).getByText('偏好简洁')).toBeInTheDocument()
    // 原文那套东西（textarea）这时候不该在 DOM 里
    expect(screen.queryByLabelText('记忆文件正文')).not.toBeInTheDocument()
  })

  it('切到编辑态才给原文的 textarea（逐字还原，frontmatter 在里面）', async () => {
    renderMisc(<MemoryPage />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '编辑' }))

    expect(screen.getByLabelText('记忆文件正文')).toHaveValue('# 核心\n\n- 偏好简洁')
    // 切回阅读：正文又按 Markdown 渲染
    await user.click(screen.getByRole('button', { name: '阅读' }))
    expect(screen.queryByLabelText('记忆文件正文')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '核心' })).toBeInTheDocument()
  })

  it('列表行：标题即路径时不再写第二遍，改动时间在右端，生效标记逐行都有', async () => {
    renderMisc(<MemoryPage />)

    // 核心文件：`title` 就是 `path`（MEMORY.md）——整行里这个名字只该出现一次
    const core = await screen.findByRole('button', { name: /MEMORY\.md/ })
    expect(within(core).getAllByText('MEMORY.md')).toHaveLength(1)
    // 右端那一格是改动时间（不是空、也不是拿不到时间时的占位破折号）
    const time = core.querySelector('.m-file-time')
    expect(time?.textContent?.trim()).not.toBe('')
    expect(time?.textContent).not.toBe('—')
    // 生效标记：核心 = 每轮注入；每日/长期 = 可召回（原先这两类这一格是空的）
    expect(within(core).getByText('每轮注入')).toBeInTheDocument()
    const daily = screen.getByRole('button', { name: /每日 · 09-22/ })
    expect(within(daily).getByText('可召回')).toBeInTheDocument()
    // 每日的整合状态与它并存（两件事，两枚标记）
    expect(within(daily).getByText('待整合')).toBeInTheDocument()
    // 有摘要给摘要；没有摘要且标题即路径时不渲染第二行（这里是日期文件：路径与标题不同）
    const digest = screen.getByRole('button', { name: /结论/ })
    expect(within(digest).getByText('digest/personal/结论.md')).toBeInTheDocument()
    expect(within(digest).getByText('可召回')).toBeInTheDocument()
  })

  it('页签的当前态由原语自己画（白底 + 主字色跟着 data-state 走），不再垫 span', async () => {
    renderMisc(<MemoryPage />)
    const files = await screen.findByRole('tab', { name: /文件/ })
    const recall = screen.getByRole('tab', { name: '召回' })

    // 评审 M5 只缺视觉：aria-selected 与键盘本来就是对的
    expect(files).toHaveAttribute('aria-selected', 'true')
    expect(recall).toHaveAttribute('aria-selected', 'false')
    // 文件数仍挂在那一档上（换掉 SegmentedControl 不能把这个丢了）
    expect(files).toHaveTextContent('3')
    expect(tabState(files)).toEqual({
      active: true,
      activeRulePresent: true,
      padded: true,
      patched: false,
    })
    expect(tabState(recall)).toEqual({
      active: false,
      activeRulePresent: true,
      padded: true,
      patched: false,
    })

    await userEvent.click(recall)
    expect(recall).toHaveAttribute('data-state', 'active')
    expect(files).toHaveAttribute('data-state', 'inactive')
    expect(tabState(recall).patched).toBe(false)
  })

  it('改了草稿点保存：把**原文**交给接口，并按返回内容刷新编辑器', async () => {
    renderMisc(<MemoryPage />)
    // 编辑器是阅读优先：进编辑态才拿到原文的 textarea
    await userEvent.click(await screen.findByRole('button', { name: '编辑' }))
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
    await userEvent.click(await screen.findByRole('button', { name: '编辑' }))
    const editor = await screen.findByLabelText('记忆文件正文')
    await userEvent.type(editor, '\n- 新增一行')

    await userEvent.click(screen.getByRole('button', { name: /每日 · 09-22/ }))

    const dialog = await screen.findByRole('alertdialog')
    // 确认框已经换成 @/ui/alert-dialog：role 是 alertdialog，动作仍是"放弃改动 / 取消"
    expect(dialog).toHaveAttribute('data-slot', 'alert-dialog-content')
    expect(within(dialog).getByText('放弃未保存的改动？')).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: '放弃改动' }))

    await waitFor(() => expect(getMemoryFileMock).toHaveBeenCalledWith('daily/2026-09-22.md'))
    // 真的切过去了：编辑器里换成了那一份的正文
    expect(await screen.findByLabelText('记忆文件正文')).toHaveValue('正文')
  })

  it('空态指的入口在屏幕上找得到：工具栏那颗写着「新增」，空态照它说话（B③）', async () => {
    getMemoryMock.mockResolvedValue(
      overview({
        status: { ...overview().status, file_count: 0, retrievable_count: 0 },
        files: [],
      }),
    )

    renderMisc(<MemoryPage />)

    expect(await screen.findByText('工作区里还没有记忆文件')).toBeInTheDocument()
    // 空态说的"新增"就是工具栏上那颗按钮的字（原先那是一枚只有图标的 ⋮，整页找不到这个词）
    const trigger = screen.getByRole('button', { name: '新增' })
    expect(trigger).toHaveTextContent('新增')
    const hint = document.querySelector('.m-empty-hint') as HTMLElement
    expect(hint.textContent).toContain('「新增」→「新建记忆文件」')
    // 菜单里的两项都还在（入口提成可见之后动作一个都没少）
    await userEvent.click(trigger)
    expect(await screen.findByRole('menuitem', { name: /新建记忆文件/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /记一条事实/ })).toBeInTheDocument()
  })

  it('保存失败时草稿仍留在编辑器里，并把原因摆在上方', async () => {
    writeMemoryFileMock.mockRejectedValueOnce(new Error('磁盘只读'))
    renderMisc(<MemoryPage />)
    await userEvent.click(await screen.findByRole('button', { name: '编辑' }))
    const editor = await screen.findByLabelText('记忆文件正文')

    await userEvent.type(editor, 'x')
    await userEvent.click(screen.getByRole('button', { name: '保存' }))

    expect(
      await screen.findByText(/磁盘只读（你的改动还在编辑器里，可以再存一次）/),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('记忆文件正文')).toHaveValue('# 核心\n\n- 偏好简洁x')
  })

  it('状态只说本地事实：几份文件、多少条可召回、上次更新', async () => {
    renderMisc(<MemoryPage />)

    expect(await screen.findByText('已启用')).toBeInTheDocument()
    const state = await screen.findByTestId('memory-local-state')
    expect(state.textContent).toContain('/data/memory')
    expect(state.textContent).toContain('3 份文件')
    expect(state.textContent).toContain('12 条可召回')
    expect(state.textContent).toContain('上次更新')
    // 没有"重建索引"这种按钮：召回是现扫工作区，没有索引要等
    expect(screen.queryByRole('button', { name: '重建索引' })).toBeNull()
  })

  it('界面上不出现服务地址/端口/连通性这类实现细节', async () => {
    asAdmin()
    renderMisc(<MemoryPage />)
    await screen.findByText('已启用')

    // 曾经真的把 `http://127.0.0.1:2333/health_check` 与异常原文打给用户看过——
    // 这条用例按"整页文本"扫一遍，防止那种文案再溜回来
    const text = document.body.textContent ?? ''
    expect(text).not.toMatch(/http:\/\/|127\.0\.0\.1|localhost/)
    expect(text).not.toMatch(/记忆服务|未连接|连通性/)
    expect(text).not.toContain('WinError')
  })

  it('未启用时标签说「未启用」，并把影响范围说对', async () => {
    getMemoryMock.mockResolvedValue({
      ...overview(),
      status: {
        ...overview().status,
        enabled: false,
        detail: '未启用：过去的对话不会被召回，也不会自动沉淀',
      },
    })

    renderMisc(<MemoryPage />)

    const tag = await screen.findByText('未启用')
    // 范围说对：开关管召回与自动沉淀；四份文件的注入与编辑不受影响
    expect(tag).toHaveAttribute('title', expect.stringContaining('注入与编辑不受影响'))
  })

  it('召回结果给出处与判据：文件、行号、分数、命中比例', async () => {
    recallMemoryMock.mockResolvedValue({
      query: '锂价',
      hits: [
        {
          text: '锂价下跌 10% 会让毛利下降',
          path: 'digest/personal/锂价.md',
          start_line: 8,
          end_line: 8,
          score: 2.7236,
          coverage: 0.75,
        },
      ],
      links: [],
      note: '这是记忆，不是知识库原文。',
    })
    renderMisc(<MemoryPage />)
    await userEvent.click(await screen.findByRole('tab', { name: /召回/ }))
    await userEvent.type(screen.getByLabelText('召回测试'), '锂价')

    await userEvent.click(screen.getByRole('button', { name: '召回' }))

    // 出处（可点开学那一份）+ 行号 + 分数 + **命中判据**（判据才是"算不算相关"）
    expect(await screen.findByText('digest/personal/锂价.md')).toBeInTheDocument()
    expect(screen.getByText(/L8/)).toBeInTheDocument()
    expect(screen.getByText(/2\.724/)).toBeInTheDocument()
    expect(screen.getByText(/命中 75%/)).toBeInTheDocument()
  })

  it('「每轮注入」这句话常驻文件列表上方（改完 SOUL.md 的第一个问题就是它进没进）', async () => {
    renderMisc(<MemoryPage />)

    const note = await screen.findByTestId('memory-inject-note')
    expect(note.textContent).toContain('每轮整份注入提示词')
    expect(note.textContent).toContain('不参与召回')
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
