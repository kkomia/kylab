/**
 * 技能市场（`features/misc/capabilities/SkillMarketDialog.tsx`）——
 * **从旧 Vue 版 `tests/unit/components/SkillMarketDialog.test.ts` 的 4 条搬来的**。
 *
 * 这四条是它存在的理由（文件头第 2、3 条）：**两级：清单 → 详情**，
 * 以及**装之前一定先看清单**（`scripts/`、hooks 这类文件要显眼地标成「代码」）。
 * 迁移期新测试覆盖到了能力页那一层，但市场弹窗自己的这条流一条都没有。
 */
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/capabilities', () => ({
  listSkillSources: vi.fn(),
  browseSkillSource: vi.fn(),
  inspectMarketSkill: vi.fn(),
  installMarketSkill: vi.fn(),
  addSkillSource: vi.fn(),
  deleteSkillSource: vi.fn(),
  setSkillSourceEnabled: vi.fn(),
  uploadSkill: vi.fn(),
}))

import {
  browseSkillSource,
  inspectMarketSkill,
  installMarketSkill,
  listSkillSources,
  type MarketSkill,
  type SkillBundle,
  type SkillSource,
} from '@/api/capabilities'
import { renderMisc } from '@/features/misc/testing/harness'
import { resetToasts } from '@/features/misc/shared/toast'
import { SkillMarketDialog } from '@/features/misc/capabilities/SkillMarketDialog'

const listSourcesMock = vi.mocked(listSkillSources)
const browseMock = vi.mocked(browseSkillSource)
const inspectMock = vi.mocked(inspectMarketSkill)
const installMock = vi.mocked(installMarketSkill)

function source(overrides: Partial<SkillSource> = {}): SkillSource {
  return {
    id: 'src-1',
    name: '官方技能源',
    repo: 'anthropics/skills',
    ref: '',
    subpath: '',
    builtin: true,
    enabled: true,
    why: '审过的清单',
    ...overrides,
  }
}

function skill(overrides: Partial<MarketSkill> = {}): MarketSkill {
  return {
    name: 'pdf-tools',
    description: 'PDF 处理',
    summary: '拆合与提文本',
    path: 'skills/pdf-tools',
    source_id: 'src-1',
    repo: 'anthropics/skills',
    installed: false,
    ...overrides,
  }
}

function bundle(overrides: Partial<SkillBundle> = {}): SkillBundle {
  return {
    source_id: 'src-1',
    repo: 'anthropics/skills',
    sha: 'a'.repeat(40),
    path: 'skills/pdf-tools',
    name: 'pdf-tools',
    description: 'PDF 处理',
    ref: 'main',
    license: 'MIT',
    files: [
      { path: 'SKILL.md', size: 1200, kind: 'doc' },
      { path: 'scripts/split.py', size: 800, kind: 'code' },
    ],
    total_bytes: 2000,
    summary: '拆合与提文本',
    code_count: 1,
    truncated: false,
    ...overrides,
  }
}

function renderDialog() {
  const onClose = vi.fn()
  const onInstalled = vi.fn()
  renderMisc(<SkillMarketDialog open onClose={onClose} onInstalled={onInstalled} />)
  return { onClose, onInstalled }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetToasts()
  listSourcesMock.mockResolvedValue({ items: [source()] })
  browseMock.mockResolvedValue({ source: source(), items: [skill()], cached: false })
  inspectMock.mockResolvedValue(bundle())
  installMock.mockResolvedValue({
    name: 'pdf-tools',
    description: 'PDF 处理',
    summary: '拆合与提文本',
    source: 'user',
    path: 'skills/pdf-tools',
    directory: '/data/skills/pdf-tools',
    used_by_prompt: true,
    flagged: [],
    discarded: false,
  })
})

describe('技能市场', () => {
  it('打开就列出当前源里的技能', async () => {
    renderDialog()
    expect(await screen.findByText('pdf-tools')).toBeInTheDocument()
    expect(screen.getByText('skills/pdf-tools')).toBeInTheDocument()
    expect(await screen.findByText(/共 1 个技能/)).toBeInTheDocument()
  })

  it('点一个技能**先看文件清单**，而不是直接装', async () => {
    renderDialog()
    await userEvent.click(await screen.findByText('pdf-tools'))

    // 进了详情：文件名与"代码"标记都要在，安装还没发生
    expect(await screen.findByText('SKILL.md')).toBeInTheDocument()
    expect(await screen.findByText('scripts/split.py')).toBeInTheDocument()
    expect(inspectMock).toHaveBeenCalledWith('src-1', 'skills/pdf-tools')
    expect(installMock).not.toHaveBeenCalled()
  })

  it('装完之后回到清单，并且那一条标成「已安装」', async () => {
    browseMock
      .mockResolvedValueOnce({ source: source(), items: [skill()], cached: false })
      .mockResolvedValue({
        source: source(),
        items: [skill({ installed: true })],
        cached: false,
      })
    renderDialog()

    await userEvent.click(await screen.findByText('pdf-tools'))
    await screen.findByText('SKILL.md')
    await userEvent.click(screen.getByRole('button', { name: '安装' }))

    await waitFor(() => expect(installMock).toHaveBeenCalledWith('src-1', 'skills/pdf-tools'))
    // 回到清单（详情那一屏的「返回清单」不在了），并且那一条已经标成已安装
    expect(await screen.findByText(/已装 1 个/)).toBeInTheDocument()
    expect(await screen.findByText('已安装')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '返回清单' })).toBeNull()
  })

  it('浏览失败时把原因**就地**写出来（不是一闪而过）', async () => {
    browseMock.mockRejectedValue(new Error('连不上 GitHub：仓库不存在或没有权限'))
    renderDialog()
    expect(await screen.findByText('连不上 GitHub：仓库不存在或没有权限')).toBeInTheDocument()
  })
})
