/**
 * 记忆页（档案卡 + 变更流）的用例。
 *
 * 这一页在档案制三期被整页重做（`docs/设计/记忆档案-设计-v0.1.md` §6）：
 * 从"文件 / 图谱 / 召回"三分段换成**一页两块**——档案卡与变更流时间线。
 *
 * 用例按"用户能看见的那件事"分组：
 * 1. 档案卡：四个分区、项目分组、行内编辑/删除、读数格式与变色、未知分区标记；
 * 2. 变更流：倒序、旧值/新值、还原；
 * 3. 原文与旧记忆：只读展示；
 * 4. 迁移：入口显隐、报告、草稿提示。
 *
 * ## 被删掉的旧用例与理由（§6.3 下线清单）
 *
 * 旧页对应的那些用例不是"顺手删的"，每一条都有一句为什么——原来它们钉住的界面
 * 已经不存在了，留着只会变成对不存在功能的断言：
 *
 * - **文件列表 / 整份文件编辑**（`改了草稿点保存`、`有未保存改动时切文件先弹确认`、
 *   `保存失败时草稿仍留在编辑器里`、`列表行：标题即路径…`）——`PUT /memory/files/{path}`
 *   已经删掉，整份覆盖是绕过预算与变更流的后门（§6.3）；档案的写入只有按条目这一条路；
 * - **图谱页**（`布局纯函数：同一份输入算两次一致` 等两条）——`MemoryGraph.tsx` /
 *   `GET /memory/graph` 一起退场，被删的组件没有可断言的界面；
 * - **召回试验框**（`召回结果给出处与判据…`）——那一格是"试一下搜不搜得到"，档案全量
 *   进了上下文之后它不再是一个用户要做的动作；
 * - **待整合 / 已整合标记**（`按固定顺序分组…`、`状态只说本地事实…`）——`daily`/`digest`
 *   与整合那一层随档案制退场，标记没有对象了；
 * - **页签原语**（`页签的当前态由原语自己画`）——一页两块不再有页签。
 *
 * 保留下来的两条旧口径，换成新形状继续钉：**界面不解释机制**（`不出现实现细节`）与
 * **界面凭据不落到这一页**。
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/memory', () => ({
  getMemory: vi.fn(),
  getMemoryFile: vi.fn(),
  getMemoryArchive: vi.fn(),
  getMemoryChanges: vi.fn(),
  rememberMemory: vi.fn(),
  forgetMemory: vi.fn(),
  restoreMemory: vi.fn(),
  renameMemoryGroup: vi.fn(),
  migrateMemory: vi.fn(),
  organizeMemoryDraft: vi.fn(),
  recallMemory: vi.fn(),
}))

vi.mock('@/api/settings', () => ({
  getSettings: vi.fn(async () => ({ groups: [] })),
  updateSettings: vi.fn(),
}))

import {
  forgetMemory,
  getMemory,
  getMemoryArchive,
  getMemoryChanges,
  getMemoryFile,
  migrateMemory,
  organizeMemoryDraft,
  rememberMemory,
  restoreMemory,
  type MemoryArchive,
  type MemoryChange,
  type MemoryEntry,
  type MemoryOverview,
  type MemorySection,
} from '@/api/memory'
import { resetLocalBackendForTest, setLocalBackendForTest } from '@/api/local'
import { MemoryPage } from '@/features/misc/memory/MemoryPage'
import { renderMisc } from '@/features/misc/testing/harness'
import { resetToasts } from '@/features/misc/shared/toast'
import { useSessionStore } from '@/lib/session'

const getMemoryMock = vi.mocked(getMemory)
const getMemoryFileMock = vi.mocked(getMemoryFile)
const getMemoryArchiveMock = vi.mocked(getMemoryArchive)
const getMemoryChangesMock = vi.mocked(getMemoryChanges)
const rememberMock = vi.mocked(rememberMemory)
const forgetMock = vi.mocked(forgetMemory)
const restoreMock = vi.mocked(restoreMemory)
const migrateMock = vi.mocked(migrateMemory)
const organizeMock = vi.mocked(organizeMemoryDraft)

/** 档案卡的数据是可变的：写入之后后端读到的是新的一份，用例模拟这件事。 */
let archiveState: MemoryArchive
let changesState: MemoryChange[]

function entryOf(text: string, extra: Partial<MemoryEntry> = {}): MemoryEntry {
  return { text, group: '', source: '', change_at: '', change_index: -1, ...extra }
}

function sectionOf(overrides: Partial<MemorySection> & { name: string }): MemorySection {
  return {
    known: true,
    entries: 0,
    chars: 0,
    limit: 20,
    suggested_chars: 800,
    group_limit: 0,
    groups: [],
    items: [],
    ...overrides,
  }
}

function archiveOf(overrides: Partial<MemoryArchive> = {}): MemoryArchive {
  return {
    path: 'PROFILE.md',
    updated: '2026-10-04',
    budget: { entries: 4, chars: 80, entry_limit: 60, char_limit: 4000 },
    sections: [
      sectionOf({
        name: '身份与称呼',
        limit: 10,
        suggested_chars: 400,
        entries: 1,
        chars: 10,
        items: [entryOf('用户叫小又。')],
      }),
      sectionOf({
        name: '长期偏好与风格',
        entries: 1,
        chars: 30,
        items: [
          entryOf('用户要求回答先给结论。', {
            source: '界面',
            change_at: '2026-10-04 09:00',
            change_index: 1,
          }),
        ],
      }),
      sectionOf({
        name: '进行中的项目',
        limit: 0,
        group_limit: 8,
        groups: [{ name: '内网知识库', entries: 1 }],
        entries: 1,
        chars: 20,
        items: [entryOf('用户的目标是把知识库放在内网。', { group: '内网知识库' })],
      }),
      sectionOf({ name: '工具与环境', limit: 12, suggested_chars: 480 }),
    ],
    draft: { exists: false, path: 'import-draft.md', entries: 0 },
    migration_available: false,
    ...overrides,
  }
}

function overviewOf(overrides: Partial<MemoryOverview> = {}): MemoryOverview {
  return {
    status: {
      enabled: true,
      workspace: 'D:\\kylab\\memory',
      core_file_exists: true,
      detail: '',
      file_count: 2,
      last_changed_at: '2026-10-04T09:00:00Z',
    },
    files: [
      {
        path: 'PROFILE.md',
        name: 'PROFILE.md',
        title: 'PROFILE.md',
        kind: 'core',
        summary: '',
        tags: [],
        size_bytes: 100,
        modified_at: '2026-10-04T09:00:00Z',
        injected: true,
      },
      {
        path: 'MEMORY.md',
        name: 'MEMORY.md',
        title: 'MEMORY.md',
        kind: 'core',
        summary: '',
        tags: [],
        size_bytes: 80,
        modified_at: '2026-10-01T09:00:00Z',
        injected: false,
      },
    ],
    truncated: false,
    ...overrides,
  }
}

/**
 * 找到某个分区的元素（多个同名 testid 时按 `data-section` 定位）。 */
function sectionEl(name: string): HTMLElement {
  const found = screen
    .getAllByTestId('archive-section')
    .find((node) => node.getAttribute('data-section') === name)
  if (!found) throw new Error(`找不到分区：${name}`)
  return found
}

beforeEach(() => {
  vi.clearAllMocks()
  resetToasts()
  useSessionStore.setState({ token: '' })

  archiveState = archiveOf()
  changesState = []

  getMemoryMock.mockImplementation(async () => overviewOf())
  getMemoryArchiveMock.mockImplementation(async () => archiveState)
  getMemoryChangesMock.mockImplementation(async () => changesState)
  getMemoryFileMock.mockImplementation(async (path) => ({
    path,
    name: path,
    title: path,
    kind: 'core',
    summary: '',
    tags: [],
    size_bytes: 10,
    modified_at: '2026-10-04T09:00:00Z',
    links: [],
    retrievable: false,
    injected: path === 'PROFILE.md',
    consolidated: null,
    content: path === 'import-draft.md' ? '- 旧条目甲\n- 旧条目乙\n' : `# ${path}\n\n正文\n`,
    meta: {},
    truncated: false,
  }))
  rememberMock.mockResolvedValue({
    action: 'replaced',
    receipt: '改成：新（旧的已留档，可还原）',
    text: '新',
    section: '',
    replaced: '',
    entries: 4,
  })
  forgetMock.mockResolvedValue({
    action: 'forgotten',
    receipt: '忘掉了：X（旧的已留档，可还原）',
    text: 'X',
    section: '',
    replaced: 'X',
    entries: 3,
  })
  restoreMock.mockResolvedValue({
    action: 'restored',
    receipt: '还原成：旧',
    text: '旧',
    section: '',
    replaced: '',
    entries: 4,
  })
  migrateMock.mockResolvedValue({
    added: 5,
    replaced: 1,
    existing: 2,
    dropped_sensitive: 3,
    downgraded: 4,
    trimmed: 2,
    skipped: false,
    archive_changed: true,
    draft_entries: 6,
    per_source: [],
  })
})

describe('记忆页 · 档案卡', () => {
  it('按后端给的顺序画四个分区，项目区按组显示', async () => {
    renderMisc(<MemoryPage />)

    const sections = await screen.findAllByTestId('archive-section')
    expect(sections.map((node) => node.getAttribute('data-section'))).toEqual([
      '身份与称呼',
      '长期偏好与风格',
      '进行中的项目',
      '工具与环境',
    ])
    expect(within(sectionEl('进行中的项目')).getByTestId('archive-group')).toHaveAttribute(
      'data-group',
      '内网知识库',
    )
  })

  it('改一条：失焦保存走一次顶替，条目变成新值', async () => {
    const user = userEvent.setup()
    renderMisc(<MemoryPage />)

    await user.click(await screen.findByText('用户叫小又。'))
    const input = screen.getByTestId('archive-entry-input')
    await user.clear(input)
    await user.type(input, '用户叫小柚。')

    rememberMock.mockImplementation(async () => {
      archiveState = archiveOf({
        sections: [
          sectionOf({
            name: '身份与称呼',
            limit: 10,
            suggested_chars: 400,
            entries: 1,
            chars: 10,
            items: [entryOf('用户叫小柚。')],
          }),
        ],
      })
      return {
        action: 'replaced',
        receipt: '改成：用户叫小柚。',
        text: '用户叫小柚。',
        section: '身份与称呼',
        replaced: '用户叫小又。',
        entries: 1,
      }
    })
    fireEvent.blur(input)

    await waitFor(() =>
      expect(rememberMock).toHaveBeenCalledWith('用户叫小柚。', {
        section: '身份与称呼',
        replaces: '用户叫小又。',
      }),
    )
    await waitFor(() => expect(screen.getByText('用户叫小柚。')).toBeInTheDocument())
  })

  it('删除一条：走忘掉，条目消失', async () => {
    const user = userEvent.setup()
    renderMisc(<MemoryPage />)

    const line = (await screen.findByText('用户叫小又。')).closest('li') as HTMLElement

    forgetMock.mockImplementation(async () => {
      archiveState = archiveOf({
        sections: [
          sectionOf({ name: '身份与称呼', limit: 10, suggested_chars: 400 }),
          sectionOf({ name: '长期偏好与风格' }),
          sectionOf({ name: '进行中的项目', limit: 0, group_limit: 8 }),
          sectionOf({ name: '工具与环境', limit: 12, suggested_chars: 480 }),
        ],
      })
      return {
        action: 'forgotten',
        receipt: '忘掉了：用户叫小又。',
        text: '用户叫小又。',
        section: '身份与称呼',
        replaced: '用户叫小又。',
        entries: 3,
      }
    })
    await user.click(within(line).getByTestId('archive-entry-delete'))

    await waitFor(() => expect(forgetMock).toHaveBeenCalledWith('用户叫小又。'))
    await waitFor(() => expect(screen.queryByText('用户叫小又。')).not.toBeInTheDocument())
  })

  it('读数按 X/Y 条 · X/Y 字的格式渲染，接近上限变色', async () => {
    archiveState = archiveOf({
      budget: { entries: 29, chars: 100, entry_limit: 60, char_limit: 4000 },
      sections: [
        sectionOf({ name: '身份与称呼', limit: 10, suggested_chars: 400, entries: 9, chars: 300 }),
        sectionOf({ name: '长期偏好与风格', entries: 20, chars: 900, suggested_chars: 800 }),
      ],
    })
    renderMisc(<MemoryPage />)

    expect(await screen.findByTestId('archive-budget')).toHaveTextContent('29/60 条 · 100/4000 字')
    // 全局读数没到八成 → 不变色
    expect(screen.getByTestId('archive-budget')).toHaveAttribute('data-tone', 'ok')

    const reads = screen.getAllByTestId('archive-section-readout')
    expect(reads[0]).toHaveTextContent('9/10 条 · 300/400 字')
    expect(reads[0]).toHaveAttribute('data-tone', 'warn')
    expect(reads[1]).toHaveAttribute('data-tone', 'over')
  })

  it('未知分区照常显示，并标「分区不认识」', async () => {
    archiveState = archiveOf({
      sections: [
        sectionOf({ name: '身份与称呼', limit: 10, suggested_chars: 400 }),
        sectionOf({
          name: '朋友与家人',
          known: false,
          limit: 0,
          suggested_chars: 0,
          entries: 1,
          chars: 12,
          items: [entryOf('用户有个弟弟在读书。')],
        }),
      ],
    })
    renderMisc(<MemoryPage />)

    const unknown = await waitFor(() => sectionEl('朋友与家人'))
    expect(within(unknown).getByTestId('archive-unknown-section')).toHaveTextContent('分区不认识')
    expect(within(unknown).getByText('用户有个弟弟在读书。')).toBeInTheDocument()
  })

  it('「原文」只读展示 PROFILE.md 全文与磁盘路径', async () => {
    const user = userEvent.setup()
    renderMisc(<MemoryPage />)

    await user.click(await screen.findByTestId('archive-original'))

    await waitFor(() =>
      expect(screen.getByTestId('archive-original-path')).toHaveTextContent(
        'D:\\kylab\\memory/PROFILE.md',
      ),
    )
    expect(screen.getByTestId('archive-original-content')).toHaveTextContent('# PROFILE.md')
  })

  it('来源小字点击后高亮变更流里那一条', async () => {
    const user = userEvent.setup()
    changesState = [
      {
        index: 1,
        at: '2026-10-04 09:00',
        action: '顶替',
        section: '长期偏好与风格',
        source: '界面',
        old: '旧偏好',
        new: '用户要求回答先给结论。',
        restorable: true,
      },
    ]
    renderMisc(<MemoryPage />)

    await user.click(await screen.findByTestId('archive-entry-source'))

    await waitFor(() =>
      expect(screen.getByTestId('change-item')).toHaveAttribute('data-highlight', 'true'),
    )
  })
})

describe('记忆页 · 变更流', () => {
  it('倒序（最新在最前），旧值/新值各一行', async () => {
    changesState = [
      {
        index: 1,
        at: '2026-10-04 09:30',
        action: '顶替',
        section: '长期偏好与风格',
        source: '界面',
        old: '旧偏好',
        new: '新偏好',
        restorable: true,
      },
      {
        index: 0,
        at: '2026-10-04 09:00',
        action: '新增',
        section: '身份与称呼',
        source: '显式',
        old: '',
        new: '用户叫小又。',
        restorable: false,
      },
    ]
    renderMisc(<MemoryPage />)

    const items = await screen.findAllByTestId('change-item')
    // 后端已经倒序给，前端不重排
    expect(items.map((node) => node.getAttribute('data-action'))).toEqual(['顶替', '新增'])
    expect(items[0]).toHaveTextContent('新偏好')
    expect(within(items[0]).getByTestId('change-old')).toHaveTextContent('旧偏好')
  })

  it('「还原」把那条的旧值写回去', async () => {
    const user = userEvent.setup()
    changesState = [
      {
        index: 0,
        at: '2026-10-04 09:30',
        action: '忘掉',
        section: '长期偏好与风格',
        source: '界面',
        old: '用户不看客套话。',
        new: '',
        restorable: true,
      },
    ]
    renderMisc(<MemoryPage />)

    await user.click(await screen.findByTestId('change-restore'))

    await waitFor(() => expect(restoreMock).toHaveBeenCalledWith('用户不看客套话。'))
  })

  it('没有可还原的旧值时不显示还原按钮', async () => {
    changesState = [
      {
        index: 0,
        at: '2026-10-04 09:00',
        action: '新增',
        section: '身份与称呼',
        source: '显式',
        old: '',
        new: '用户叫小又。',
        restorable: false,
      },
    ]
    renderMisc(<MemoryPage />)

    await screen.findByTestId('change-item')
    expect(screen.queryByTestId('change-restore')).not.toBeInTheDocument()
  })
})

describe('记忆页 · 迁移与旧档', () => {
  it('可迁移时出现入口，跑完展示迁移报告', async () => {
    const user = userEvent.setup()
    archiveState = archiveOf({ migration_available: true })
    renderMisc(<MemoryPage />)

    await user.click(await screen.findByTestId('migration-run'))

    await waitFor(() => expect(migrateMock).toHaveBeenCalled())
    const report = await screen.findByTestId('migration-report')
    // 折叠 = 新增 + 顶替 = 5 + 1
    expect(report).toHaveTextContent('折叠')
    expect(report).toHaveTextContent('6 条')
    expect(report).toHaveTextContent('丢弃')
    expect(report).toHaveTextContent('3 条')
    expect(report).toHaveTextContent('降级进草稿')
    expect(report).toHaveTextContent('4 条')
    expect(report).toHaveTextContent('裁剪')
    expect(report).toHaveTextContent('2 条')
  })

  it('没有可折叠的旧数据时不出现迁移入口', async () => {
    renderMisc(<MemoryPage />)

    await screen.findByTestId('archive-card')
    expect(screen.queryByTestId('migration-entry')).not.toBeInTheDocument()
  })

  it('草稿有货时提示还有几条，展开可只读查看', async () => {
    const user = userEvent.setup()
    archiveState = archiveOf({
      migration_available: false,
      draft: { exists: true, path: 'import-draft.md', entries: 3 },
    })
    renderMisc(<MemoryPage />)

    expect(await screen.findByTestId('draft-count')).toHaveTextContent('还有 3 条旧条目没进档案')
    await user.click(within(screen.getByTestId('draft-hint')).getByRole('button', { name: '展开' }))
    await waitFor(() => expect(screen.getByTestId('draft-content')).toHaveTextContent('旧条目甲'))
  })

  it('「整理初稿」先给预览，点「写进档案」才逐条写入（§8.3）', async () => {
    const user = userEvent.setup()
    organizeMock.mockResolvedValue({
      items: [{ text: '用户要求先给结论。', section: '长期偏好与风格' }],
      note: '这些还只是建议。',
    })
    rememberMock.mockResolvedValue({
      action: 'added',
      receipt: '记下了：用户要求先给结论。',
      text: '用户要求先给结论。',
      section: '长期偏好与风格',
      replaced: '',
      entries: 5,
    })
    archiveState = archiveOf({ draft: { exists: true, path: 'import-draft.md', entries: 2 } })
    renderMisc(<MemoryPage />)

    await user.click(await screen.findByTestId('draft-organize'))

    const preview = await screen.findByTestId('draft-preview')
    expect(preview).toHaveTextContent('用户要求先给结论。')
    expect(rememberMock).not.toHaveBeenCalled()

    await user.click(screen.getByTestId('draft-apply'))

    await waitFor(() =>
      expect(rememberMock).toHaveBeenCalledWith('用户要求先给结论。', {
        section: '长期偏好与风格',
      }),
    )
    await waitFor(() => expect(screen.queryByTestId('draft-preview')).not.toBeInTheDocument())
  })

  it('旧记忆（只读）按 injected=false 识别并展示', async () => {
    renderMisc(<MemoryPage />)

    const block = await screen.findByTestId('old-memory')
    await waitFor(() =>
      expect(within(block).getByTestId('old-memory-content')).toHaveTextContent('MEMORY.md'),
    )
  })
})

describe('记忆页 · 去解释化', () => {
  it('不在界面上解释机制，也不出现服务地址/端口/版本号', async () => {
    renderMisc(<MemoryPage />)
    await screen.findByTestId('archive-card')

    const text = document.body.textContent ?? ''
    for (const word of ['注入', '提示词', 'token', '接口', '服务', '127.0.0.1', 'localhost']) {
      expect(text).not.toContain(word)
    }
  })

  it('档案编辑不看开关：未启用时照样能改', async () => {
    getMemoryMock.mockImplementation(async () =>
      overviewOf({
        status: {
          ...overviewOf().status,
          enabled: false,
        },
      }),
    )
    renderMisc(<MemoryPage />)

    expect(await screen.findByTestId('archive-card')).toBeInTheDocument()
    expect(screen.getAllByTestId('archive-entry-delete')[0]).toBeEnabled()
  })

  it('页面上不再有图谱、召回试验、待整合或新建文件这些入口', async () => {
    renderMisc(<MemoryPage />)
    await screen.findByTestId('archive-card')

    for (const word of ['图谱', '召回', '待整合', '已整合', '新建记忆文件']) {
      expect(screen.queryByText(word)).not.toBeInTheDocument()
    }
  })

  it('没有本机后端那一档看不到「设置」入口（那一档的记忆一族不在本机）', async () => {
    // 「不是管理员」现在只剩这一种现场（`lib/useIsAdmin`：本机档的用户就是管理员）
    setLocalBackendForTest('absent')
    renderMisc(<MemoryPage />)
    await screen.findByTestId('archive-card')
    expect(screen.queryByRole('button', { name: '设置' })).not.toBeInTheDocument()
    resetLocalBackendForTest()
  })
})

// 本机档单列一条：与上面那条相对，钉住入口按"有没有本机后端"显隐
describe('记忆页 · 设置入口', () => {
  it('本机档（本机主人）能看到「设置」', async () => {
    setLocalBackendForTest('local')
    renderMisc(<MemoryPage />)
    await screen.findByTestId('archive-card')
    expect(screen.getByRole('button', { name: '设置' })).toBeInTheDocument()
    resetLocalBackendForTest()
  })
})
