/**
 * 工作区页（旧 `views/WorkspacesView.vue` + `components/workspaces/**`）的用例。
 *
 * 三件迁移里最容易被做丢的事：
 * 1. **两个入口进来的落点**：`?focus=<id>` 要落在那个项目上（侧栏「项目」菜单靠它）；
 * 2. **保存走 updateWorkspace**，成功后表单与右栏都刷新（不含"新建"那条语义）；
 * 3. **新建之后直接在里面开一个会话**（v0.41）——建完只停在空表单上
 *    等于把用户接下来的第一步丢了。
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/workspaces', () => ({
  listWorkspaces: vi.fn(),
  createWorkspace: vi.fn(),
  updateWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
  browseDirectories: vi.fn(),
  createDirectory: vi.fn(),
  renameDirectory: vi.fn(),
}))

vi.mock('@/api/conversations', () => ({ createConversation: vi.fn() }))
vi.mock('@/api/knowledgeBases', () => ({
  listKnowledgeBases: vi.fn(async () => ({
    items: [{ id: 'kb-1', name: '产品手册' }],
  })),
}))

import { createConversation } from '@/api/conversations'
import {
  createWorkspace,
  deleteWorkspace,
  listWorkspaces,
  updateWorkspace,
  type Workspace,
} from '@/api/workspaces'
import { renderMisc } from '@/features/misc/testing/harness'
import { resetToasts } from '@/features/misc/shared/toast'
import { WorkspacesPage } from '@/features/misc/workspaces/WorkspacesPage'

const listWorkspacesMock = vi.mocked(listWorkspaces)
const updateWorkspaceMock = vi.mocked(updateWorkspace)
const createWorkspaceMock = vi.mocked(createWorkspace)
const deleteWorkspaceMock = vi.mocked(deleteWorkspace)
const createConversationMock = vi.mocked(createConversation)

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-1',
    name: '知识库产品化',
    root_path: '/volume1/projects/kylab',
    description: '把文档流水线做扎实',
    kb_ids: ['kb-1'],
    conversation_count: 3,
    created_at: null,
    updated_at: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetToasts()
  listWorkspacesMock.mockResolvedValue({
    items: [workspace(), workspace({ id: 'ws-2', name: '另一个项目', root_path: '/srv/other' })],
  })
  updateWorkspaceMock.mockResolvedValue(workspace({ name: '改过名字' }))
})

describe('工作区页', () => {
  it('列出工作区，并把 ?focus 指定的那一个选中（侧栏「项目」菜单靠它）', async () => {
    renderMisc(<WorkspacesPage />, { route: '/workspaces?focus=ws-2' })

    const title = await screen.findByRole('heading', { name: '另一个项目' })
    expect(title).toBeInTheDocument()
    expect(screen.getByLabelText('名字')).toHaveValue('另一个项目')
    // 会话数、根目录都在清单行里（不必点进去才知道）
    expect(screen.getByText('/srv/other')).toBeInTheDocument()
  })

  it('改名后保存：调 updateWorkspace 并回填接口返回的那一份', async () => {
    renderMisc(<WorkspacesPage />, { route: '/workspaces?focus=ws-1' })
    const nameInput = await screen.findByLabelText('名字')

    await userEvent.clear(nameInput)
    await userEvent.type(nameInput, '改过名字')
    await userEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() =>
      expect(updateWorkspaceMock).toHaveBeenCalledWith('ws-1', {
        name: '改过名字',
        root_path: '/volume1/projects/kylab',
        description: '把文档流水线做扎实',
        kb_ids: ['kb-1'],
      }),
    )
    expect(await screen.findByText('已保存')).toBeInTheDocument()
  })

  it('`?new=1` 打开新建弹窗：建完选中它并**直接开一个会话进去**', async () => {
    const created = workspace({ id: 'ws-9', name: '新项目', conversation_count: 0 })
    renderMisc(<WorkspacesPage />, { route: '/workspaces?new=1' })

    createWorkspaceMock.mockResolvedValue(created)
    createConversationMock.mockResolvedValue({ id: 'conv-9' } as never)

    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('名字'), '新项目')
    await userEvent.type(within(dialog).getByLabelText('根目录'), '/srv/new')
    await userEvent.click(within(dialog).getByRole('button', { name: '创建工作区' }))

    await waitFor(() =>
      expect(createConversationMock).toHaveBeenCalledWith([], null, undefined, 'ws-9'),
    )
    expect(await screen.findByText('工作区已创建')).toBeInTheDocument()
  })

  it('删除工作区要二次确认，并写明"里面的会话不会被删"', async () => {
    deleteWorkspaceMock.mockResolvedValue(undefined)

    renderMisc(<WorkspacesPage />, { route: '/workspaces?focus=ws-1' })
    await userEvent.click(await screen.findByRole('button', { name: /删除工作区/ }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/里面的会话\*\*不会被删除\*\*/)).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: '删除工作区' }))

    await waitFor(() => expect(deleteWorkspaceMock).toHaveBeenCalledWith('ws-1'))
  })
})
