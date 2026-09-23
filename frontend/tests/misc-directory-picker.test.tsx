/**
 * 目录选择器（`features/misc/workspaces/DirectoryPickerDialog.tsx`）——**从旧 Vue 版
 * `tests/unit/components/DirectoryPickerDialog.test.ts` 逐条搬来的用例**。
 *
 * 迁移期新测试只覆盖到工作区页那一层（列表 / 改名 / 新建 / 删除），
 * **选择器自己一条都没有**——而它承载着 v0.41 那次"先看到哪儿能建，再动手"的返工
 * （能不能建 / 能不能改名都标在行上，能建的地方集中在服务端给的专用区域）。
 * 这 12 条钉的就是那些约定。
 *
 * 三条最容易做丢的（文件头也写着）：
 * 1. **点一行 = 进去**，不是选中；"就选它"由底部那颗按钮负责；
 * 2. **不可选的目录照样能进去看**，灰的是底部那颗按钮；
 * 3. 路径一律由服务端给（`path` 字段），界面不自己拼。
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/workspaces', () => ({
  browseDirectories: vi.fn(),
  createDirectory: vi.fn(),
  renameDirectory: vi.fn(),
}))

import {
  browseDirectories,
  createDirectory,
  type DirectoryEntry,
  type WorkspaceBrowse,
} from '@/api/workspaces'
import { renderMisc } from '@/features/misc/testing/harness'
import { resetToasts } from '@/features/misc/shared/toast'
import { useSessionStore } from '@/lib/session'
import { DirectoryPickerDialog } from '@/features/misc/workspaces/DirectoryPickerDialog'

const browseMock = vi.mocked(browseDirectories)
const createMock = vi.mocked(createDirectory)

function entry(overrides: Partial<DirectoryEntry> = {}): DirectoryEntry {
  return {
    name: 'projects',
    path: '/vol/projects',
    selectable: true,
    reason: '',
    creatable: false,
    create_reason: '只有「工作区」区域里能新建目录',
    renamable: false,
    rename_reason: '只有「工作区」区域里能改名',
    ...overrides,
  }
}

const AREA = '/vol1/1000/docker/kylab/data/workspaces'

function browse(overrides: Partial<WorkspaceBrowse> = {}): WorkspaceBrowse {
  return {
    path: '/vol',
    current: entry({ name: 'vol', path: '/vol' }),
    parent: '/',
    entries: [entry()],
    roots: [entry({ name: '家目录', path: '/home/me', selectable: false, reason: '不是工作区' })],
    note: '',
    area: AREA,
    ...overrides,
  }
}

function render(
  ui: { start?: string; onPick?: (path: string) => void; onClose?: () => void } = {},
) {
  const onPick = ui.onPick ?? vi.fn()
  const onClose = ui.onClose ?? vi.fn()
  renderMisc(<DirectoryPickerDialog open start={ui.start} onPick={onPick} onClose={onClose} />)
  return { onPick, onClose }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetToasts()
  useSessionStore.setState({
    token: 'st',
    currentUser: { id: 'u1', username: 'admin', name: '管理员', role: 'admin', avatar_url: '' },
    authStatus: null,
    reloginCount: 0,
  })
  browseMock.mockResolvedValue(browse())
})

describe('目录选择器', () => {
  it('打开时按 start 起步，并显示当前位置', async () => {
    render({ start: '/vol/projects' })
    await waitFor(() => expect(browseMock).toHaveBeenCalledWith('/vol/projects'))
    expect(await screen.findByText('/vol')).toBeInTheDocument()
  })

  it('点一行就进下一层（不是选中）', async () => {
    render()
    await screen.findByText('projects')
    browseMock.mockResolvedValue(browse({ path: '/vol/projects', parent: '/vol', entries: [] }))

    await userEvent.click(screen.getByTitle('/vol/projects'))

    await waitFor(() => expect(browseMock).toHaveBeenLastCalledWith('/vol/projects'))
  })

  it('「上一级」回到父目录，到了最上层就置灰', async () => {
    render()
    await screen.findByText('projects')
    browseMock.mockResolvedValue(browse({ path: '/', parent: null }))

    await userEvent.click(screen.getByRole('button', { name: '上一级' }))
    await waitFor(() => expect(browseMock).toHaveBeenLastCalledWith('/'))

    // 到了最上层：按钮灰着，点它也不会再请求
    const calls = browseMock.mock.calls.length
    const up = screen.getByRole('button', { name: '上一级' })
    expect(up).toBeDisabled()
    await userEvent.click(up)
    expect(browseMock.mock.calls.length).toBe(calls)
  })

  it('不可选的目录**照样能点进去**，只是标着原因', async () => {
    browseMock.mockResolvedValue(
      browse({
        entries: [
          entry({ name: '只读目录', path: '/vol/ro', selectable: false, reason: '系统目录' }),
        ],
      }),
    )
    render()
    const row = await screen.findByTitle('/vol/ro')

    expect(within(row).getByText('系统目录')).toBeInTheDocument()
    browseMock.mockResolvedValue(browse({ path: '/vol/ro', parent: '/vol' }))
    await userEvent.click(row)
    await waitFor(() => expect(browseMock).toHaveBeenLastCalledWith('/vol/ro'))
  })

  it('当前这一层不可选时，「选这个目录」是灰的并说明原因', async () => {
    browseMock.mockResolvedValue(
      browse({
        current: entry({
          name: 'vol',
          path: '/vol',
          selectable: false,
          reason: '这里放着系统文件',
        }),
      }),
    )
    render()

    expect(await screen.findByText('这里放着系统文件')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '选这个目录' })).toBeDisabled()
  })

  it('选完把路径交给调用方，并请求关掉自己', async () => {
    const { onPick, onClose } = render()
    await screen.findByText('projects')

    await userEvent.click(screen.getByRole('button', { name: '选这个目录' }))

    expect(onPick).toHaveBeenCalledWith('/vol')
    expect(onClose).toHaveBeenCalled()
  })

  it('起点可以直接跳过去', async () => {
    render()
    await screen.findByText('家目录')
    browseMock.mockResolvedValue(browse({ path: '/home/me' }))

    await userEvent.click(screen.getByRole('button', { name: '家目录' }))

    await waitFor(() => expect(browseMock).toHaveBeenLastCalledWith('/home/me'))
  })

  it('读不到时把服务端那句话显示出来，而不是空白', async () => {
    browseMock.mockRejectedValue(new Error('权限不足，不能浏览这个目录'))
    render()
    expect(await screen.findByText('权限不足，不能浏览这个目录')).toBeInTheDocument()
  })

  it('空目录说清是空的', async () => {
    browseMock.mockResolvedValue(browse({ entries: [] }))
    render()
    expect(await screen.findByText('这个目录里没有子目录。')).toBeInTheDocument()
  })
})

describe('专用区域：默认落在这里，也只有这里能建（v0.41）', () => {
  it('不填 start 时不带路径请求——服务端就把专用区域给回来', async () => {
    browseMock.mockResolvedValue(
      browse({ path: AREA, current: entry({ name: 'workspaces', path: AREA }) }),
    )
    render()
    await waitFor(() => expect(browseMock).toHaveBeenCalledWith(undefined))
    expect(await screen.findByText(AREA)).toBeInTheDocument()
  })

  it('站在区域里时说明这里能建，并把"区域自己不能当工作区"顶到按钮上', async () => {
    browseMock.mockResolvedValue(
      browse({
        path: AREA,
        current: entry({
          name: 'workspaces',
          path: AREA,
          selectable: false,
          reason: '区域本身不是工作区，请在它里面建一个再选',
          creatable: true,
          create_reason: '',
        }),
      }),
    )
    render()

    expect(await screen.findByText(/唯一能新建文件夹的地方/)).toBeInTheDocument()
    expect(screen.getByText('区域本身不是工作区，请在它里面建一个再选')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '选这个目录' })).toBeDisabled()
  })

  it('区域里「新建文件夹」亮着，点得开、建得成，并**直接进去**', async () => {
    browseMock.mockResolvedValue(
      browse({
        path: AREA,
        current: entry({
          name: 'workspaces',
          path: AREA,
          creatable: true,
          create_reason: '',
          renamable: true,
          rename_reason: '',
        }),
        entries: [],
      }),
    )
    createMock.mockResolvedValue(
      entry({ name: '新项目', path: `${AREA}/新项目`, creatable: true, create_reason: '' }),
    )
    render()
    await screen.findByRole('button', { name: '新建文件夹' })

    await userEvent.click(screen.getByRole('button', { name: '新建文件夹' }))
    await userEvent.type(screen.getByLabelText('新文件夹名'), '新项目')
    browseMock.mockResolvedValue(
      browse({
        path: `${AREA}/新项目`,
        current: entry({
          name: '新项目',
          path: `${AREA}/新项目`,
          creatable: true,
          create_reason: '',
        }),
      }),
    )
    await userEvent.click(screen.getByRole('button', { name: '建' }))

    await waitFor(() => expect(createMock).toHaveBeenCalledWith(AREA, '新项目'))
    // 建完直接进去（不是停在原地让用户自己找）
    await waitFor(() => expect(browseMock).toHaveBeenLastCalledWith(`${AREA}/新项目`))
  })
})

describe('非管理员', () => {
  it('给一句明确的话，而不是转圈的空白', async () => {
    useSessionStore.setState({
      currentUser: { id: 'u2', username: 'member', name: '成员', role: 'member', avatar_url: '' },
    })
    render()
    expect(
      await screen.findByText('目录浏览只对管理员开放，请直接填写服务器上的路径。'),
    ).toBeInTheDocument()
    expect(browseMock).not.toHaveBeenCalled()
  })
})
