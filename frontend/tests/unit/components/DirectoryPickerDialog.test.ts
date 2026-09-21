/**
 * 目录选择器（v0.35）：**在服务器上**挑一个目录当工作区根目录。
 *
 * 这一组盯三件事：
 *
 * 1. **点一行 = 进下一层**（不是"选中"）：目录树里"进下一层"才是最常用的动作，
 *    而"就选它"由底部那颗按钮负责——与系统文件夹选择器一致；
 * 2. **不可选的目录照样能进去看**，灰的是"选这个目录"那颗按钮，不是那一行：
 *    数据目录整个子树都不能当工作区，但"点进去看看"是正常动作，拦着只会让人以为界面坏了；
 * 3. **可选性由服务端给**（`current`）：界面不自己判——自己判就会出现
 *    "按钮亮着、点了却建不出来"。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const browseDirectories = vi.fn()
const createDirectory = vi.fn()
const renameDirectory = vi.fn()

vi.mock('@/api/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/workspaces')>()
  return {
    ...actual,
    browseDirectories: (...args: unknown[]) => browseDirectories(...args),
    createDirectory: (...args: unknown[]) => createDirectory(...args),
    renameDirectory: (...args: unknown[]) => renameDirectory(...args),
  }
})

import type { WorkspaceBrowse } from '@/api/workspaces'
import DirectoryPickerDialog from '@/components/workspaces/DirectoryPickerDialog.vue'

function view(overrides: Partial<WorkspaceBrowse> = {}): WorkspaceBrowse {
  return {
    path: 'C:\\Users\\me',
    current: { name: 'me', path: 'C:\\Users\\me', selectable: true, reason: '' },
    parent: 'C:\\Users',
    entries: [
      { name: 'proj', path: 'C:\\Users\\me\\proj', selectable: true, reason: '' },
      { name: 'data', path: 'C:\\Users\\me\\data', selectable: false, reason: '这是数据目录' },
    ],
    roots: [{ name: '家目录', path: 'C:\\Users\\me', selectable: true, reason: '' }],
    note: '',
    ...overrides,
  }
}

async function mountPicker(payload: WorkspaceBrowse = view()) {
  browseDirectories.mockResolvedValue(payload)
  const wrapper = mount(DirectoryPickerDialog, {
    props: { open: false, start: 'C:\\Users\\me' },
  })
  await wrapper.setProps({ open: true })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  browseDirectories.mockReset()
  createDirectory.mockReset()
  renameDirectory.mockReset()
})

describe('目录选择器', () => {
  it('打开时按 start 起步，并显示当前位置', async () => {
    const wrapper = await mountPicker()
    expect(browseDirectories).toHaveBeenCalledWith('C:\\Users\\me')
    expect(wrapper.text()).toContain('C:\\Users\\me')
  })

  it('点一行就进下一层（不是选中）', async () => {
    const wrapper = await mountPicker()
    const row = wrapper.findAll('button').find((item) => item.text().includes('proj'))
    await row!.trigger('click')
    await flushPromises()
    expect(browseDirectories).toHaveBeenLastCalledWith('C:\\Users\\me\\proj')
  })

  it('「上一级」回到父目录，到了最上层就置灰', async () => {
    const wrapper = await mountPicker()
    const up = wrapper.findAll('button').find((item) => item.text().includes('上一级'))
    await up!.trigger('click')
    await flushPromises()
    expect(browseDirectories).toHaveBeenLastCalledWith('C:\\Users')

    browseDirectories.mockResolvedValue(view({ path: 'C:\\', parent: null }))
    await wrapper.setProps({ open: false })
    await wrapper.setProps({ open: true })
    await flushPromises()
    const up2 = wrapper.findAll('button').find((item) => item.text().includes('上一级'))
    expect(up2!.attributes('disabled')).toBeDefined()
  })

  it('不可选的目录**照样能点进去**，只是标着原因', async () => {
    const wrapper = await mountPicker()
    const row = wrapper.findAll('button').find((item) => item.text().includes('data'))
    expect(row!.text()).toContain('这是数据目录')
    await row!.trigger('click')
    await flushPromises()
    expect(browseDirectories).toHaveBeenLastCalledWith('C:\\Users\\me\\data')
  })

  it('当前这一层不可选时，「选这个目录」是灰的并说明原因', async () => {
    const wrapper = await mountPicker(
      view({
        path: 'C:\\Users\\me\\data',
        current: {
          name: 'data',
          path: 'C:\\Users\\me\\data',
          selectable: false,
          reason: '不能把数据目录（或它里面的目录）作为工作区',
        },
      }),
    )
    const pick = wrapper.findAll('button').find((item) => item.text().includes('选这个目录'))
    expect(pick!.attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('不能把数据目录')
  })

  it('选完把路径交给调用方，并请求关掉自己', async () => {
    const wrapper = await mountPicker()
    const pick = wrapper.findAll('button').find((item) => item.text().includes('选这个目录'))
    await pick!.trigger('click')
    expect(wrapper.emitted('pick')).toEqual([['C:\\Users\\me']])
    // `defineModel` 只**请求**关闭（发出 update:open），真正的关由父组件那侧生效
    expect(wrapper.emitted('update:open')).toEqual([[false]])
  })

  it('起点可以直接跳过去', async () => {
    const wrapper = await mountPicker(
      view({
        roots: [
          { name: '家目录', path: 'C:\\Users\\me', selectable: true, reason: '' },
          { name: 'E:', path: 'E:\\', selectable: false, reason: '不能把文件系统根目录作为工作区' },
        ],
      }),
    )
    const root = wrapper.findAll('button').find((item) => item.text() === 'E:')
    await root!.trigger('click')
    await flushPromises()
    expect(browseDirectories).toHaveBeenLastCalledWith('E:\\')
  })

  it('读不到时把服务端那句话显示出来，而不是空白', async () => {
    browseDirectories.mockRejectedValue(new Error('这个目录读不了：拒绝访问'))
    const wrapper = mount(DirectoryPickerDialog, { props: { open: false, start: '' } })
    await wrapper.setProps({ open: true })
    await flushPromises()
    expect(wrapper.text()).toContain('拒绝访问')
  })

  it('空目录说清是空的', async () => {
    const wrapper = await mountPicker(view({ entries: [] }))
    expect(wrapper.text()).toContain('没有子目录')
  })
})

describe('新建与改名（v0.36）', () => {
  it('「新建文件夹」建完**直接进去**（建它就是为了用它）', async () => {
    createDirectory.mockResolvedValue({
      name: '新项目',
      path: 'C:\\Users\\me\\新项目',
      selectable: true,
      reason: '',
    })
    const wrapper = await mountPicker()
    await wrapper
      .findAll('button')
      .find((item) => item.text().includes('新建文件夹'))!
      .trigger('click')
    const input = wrapper.find('input[aria-label="新文件夹名"]')
    await input.setValue('新项目')
    await wrapper
      .findAll('button')
      .find((item) => item.text() === '建')!
      .trigger('click')
    await flushPromises()
    expect(createDirectory).toHaveBeenCalledWith('C:\\Users\\me', '新项目')
    // 建完落在新建的那个目录里
    expect(browseDirectories).toHaveBeenLastCalledWith('C:\\Users\\me\\新项目')
  })

  it('名字为空时「建」是灰的', async () => {
    const wrapper = await mountPicker()
    await wrapper
      .findAll('button')
      .find((item) => item.text().includes('新建文件夹'))!
      .trigger('click')
    const build = wrapper.findAll('button').find((item) => item.text() === '建')!
    expect(build.attributes('disabled')).toBeDefined()
  })

  it('重名时把服务端那句话显示出来，输入框还在（改完能接着试）', async () => {
    createDirectory.mockRejectedValue(new Error('「新项目」已经存在了，换一个名字'))
    const wrapper = await mountPicker()
    await wrapper
      .findAll('button')
      .find((item) => item.text().includes('新建文件夹'))!
      .trigger('click')
    await wrapper.find('input[aria-label="新文件夹名"]').setValue('新项目')
    await wrapper
      .findAll('button')
      .find((item) => item.text() === '建')!
      .trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('已经存在了')
    expect(wrapper.find('input[aria-label="新文件夹名"]').exists()).toBe(true)
  })

  it('Esc 取消输入，什么都不建', async () => {
    const wrapper = await mountPicker()
    await wrapper
      .findAll('button')
      .find((item) => item.text().includes('新建文件夹'))!
      .trigger('click')
    await wrapper.find('input[aria-label="新文件夹名"]').trigger('keyup.esc')
    expect(wrapper.find('input[aria-label="新文件夹名"]').exists()).toBe(false)
    expect(createDirectory).not.toHaveBeenCalled()
  })

  it('改名走 PATCH，改完留在原地刷新', async () => {
    renameDirectory.mockResolvedValue({
      name: 'proj2',
      path: 'C:\\Users\\me\\proj2',
      selectable: true,
      reason: '',
    })
    const wrapper = await mountPicker()
    await wrapper.find('button[aria-label="把「proj」改名"]').trigger('click')
    const input = wrapper.find('input[aria-label="把「proj」改名"]')
    expect((input.element as HTMLInputElement).value).toBe('proj')
    await input.setValue('proj2')
    await wrapper
      .findAll('button')
      .find((item) => item.text() === '改')!
      .trigger('click')
    await flushPromises()
    expect(renameDirectory).toHaveBeenCalledWith('C:\\Users\\me\\proj', 'proj2')
    // 留在原来这一层（改的是这一行，不是"进去"）
    expect(browseDirectories).toHaveBeenLastCalledWith('C:\\Users\\me')
  })

  it('改名被拒时显示原因（比如它是个工作区的根目录）', async () => {
    renameDirectory.mockRejectedValue(
      new Error('「proj」是工作区「老项目」的根目录，改名会让那条工作区失联'),
    )
    const wrapper = await mountPicker()
    await wrapper.find('button[aria-label="把「proj」改名"]').trigger('click')
    await wrapper.find('input[aria-label="把「proj」改名"]').setValue('proj2')
    await wrapper
      .findAll('button')
      .find((item) => item.text() === '改')!
      .trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('工作区')
    expect(wrapper.text()).toContain('失联')
  })
})
