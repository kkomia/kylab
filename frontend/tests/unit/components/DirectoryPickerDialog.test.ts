/**
 * 目录选择器（v0.35）：**在服务器上**挑一个目录当工作区根目录。
 *
 * 这一组盯四件事：
 *
 * 1. **点一行 = 进下一层**（不是"选中"）：目录树里"进下一层"才是最常用的动作，
 *    而"就选它"由底部那颗按钮负责——与系统文件夹选择器一致；
 * 2. **不可选的目录照样能进去看**，灰的是"选这个目录"那颗按钮，不是那一行：
 *    数据目录整个子树都不能当工作区，但"点进去看看"是正常动作，拦着只会让人以为界面坏了；
 * 3. **可选性 / 可建性 / 可改名都由服务端给**（`current` 与每一行的三个布尔 + 原因）：
 *    界面不自己判——自己判就会出现"按钮亮着、点了却建不出来"；
 * 4. **"为什么不能建"要在点下去之前就说**（v0.41）：区域外那颗「新建文件夹」灰着、
 *    旁边摆着原因；能建的地方是服务端的专用区域，也是打开时的默认落脚点。
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

import type { DirectoryEntry, WorkspaceBrowse } from '@/api/workspaces'
import DirectoryPickerDialog from '@/components/workspaces/DirectoryPickerDialog.vue'

/** 服务端给的专用区域（选择器的默认落脚点，也是唯一能新建目录的地方）。 */
const AREA = 'C:\\data\\workspaces'
const INSIDE = `${AREA}\\proj`
const OUTSIDE = 'C:\\Users\\me'

/** 区域外那句原因（服务端原样给，界面原样显示）。 */
const ONLY_AREA = '只有「工作区」区域里能新建目录：区域外只读浏览，起点里有「工作区区域」那一项'
const ONLY_AREA_RENAME = '只有「工作区」区域里的目录能改名；区域外只读浏览'

/** 一行目录。默认是"区域里、什么都能干"，例外的那几项按需覆盖。 */
function dir(name: string, path: string, overrides: Partial<DirectoryEntry> = {}): DirectoryEntry {
  return {
    name,
    path,
    selectable: true,
    reason: '',
    creatable: true,
    create_reason: '',
    renamable: true,
    rename_reason: '',
    ...overrides,
  }
}

/** 专用区域这一层：**能建**（唯一能建的地方），但区域本身不是工作区（它是容器）。 */
function areaView(overrides: Partial<WorkspaceBrowse> = {}): WorkspaceBrowse {
  return {
    path: AREA,
    area: AREA,
    current: dir('workspaces', AREA, {
      selectable: false,
      reason: '「工作区」区域本身不能当工作区：它是所有工作区的容器',
      renamable: false,
      rename_reason: '「工作区」区域本身不能改名：它是选择器的默认落脚点',
    }),
    parent: 'C:\\data',
    entries: [
      dir('proj', INSIDE),
      dir('data', 'C:\\data', {
        selectable: false,
        reason: '不能把数据目录（或它里面的目录）作为工作区',
        creatable: false,
        create_reason: ONLY_AREA,
        renamable: false,
        rename_reason: ONLY_AREA_RENAME,
      }),
    ],
    roots: [
      dir('工作区区域', AREA),
      dir('家目录', OUTSIDE),
      dir('E:', 'E:\\', { selectable: false, reason: '不能把文件系统根目录作为工作区' }),
    ],
    note: '',
    ...overrides,
  }
}

/** 区域里的一个子目录这一层：能选、能建、能改名，全都亮着。 */
function insideView(overrides: Partial<WorkspaceBrowse> = {}): WorkspaceBrowse {
  return {
    path: INSIDE,
    area: AREA,
    current: dir('proj', INSIDE),
    parent: AREA,
    entries: [dir('a', `${INSIDE}\\a`), dir('b', `${INSIDE}\\b`)],
    roots: [dir('工作区区域', AREA)],
    note: '',
    ...overrides,
  }
}

/** 区域外的某一层（家目录那种）：能看、能选，但**建不了也改不了名**。 */
function outsideView(overrides: Partial<WorkspaceBrowse> = {}): WorkspaceBrowse {
  return {
    path: OUTSIDE,
    area: AREA,
    current: dir('me', OUTSIDE, {
      creatable: false,
      create_reason: ONLY_AREA,
      renamable: false,
      rename_reason: ONLY_AREA_RENAME,
    }),
    parent: 'C:\\Users',
    entries: [
      dir('proj', `${OUTSIDE}\\proj`, {
        creatable: false,
        create_reason: ONLY_AREA,
        renamable: false,
        rename_reason: ONLY_AREA_RENAME,
      }),
    ],
    roots: [dir('工作区区域', AREA)],
    note: '',
    ...overrides,
  }
}

async function mountPicker(payload: WorkspaceBrowse = areaView(), start = AREA) {
  browseDirectories.mockResolvedValue(payload)
  const wrapper = mount(DirectoryPickerDialog, { props: { open: false, start } })
  await wrapper.setProps({ open: true })
  await flushPromises()
  return wrapper
}

type Wrapper = ReturnType<typeof mount>

/**
 * 按文字找按钮。这几种按钮都没有稳定的测试 id，文字就是它们的"名字"。
 *
 * ``exact`` 是给「建」「改」这种单字按钮用的：`includes` 会把「新建文件夹」也算进去
 * （它里面有个"建"），于是选中的是另一颗按钮——那正是"测试选错元素"的经典坑。
 */
function button(wrapper: Wrapper, text: string, exact = false): ReturnType<Wrapper['findAll']>[0] {
  const found = wrapper
    .findAll('button')
    .find((item) => (exact ? item.text().trim() === text : item.text().includes(text)))
  if (!found) throw new Error(`没有这个按钮：${text}`)
  return found
}

beforeEach(() => {
  browseDirectories.mockReset()
  createDirectory.mockReset()
  renameDirectory.mockReset()
})

describe('目录选择器', () => {
  it('打开时按 start 起步，并显示当前位置', async () => {
    const wrapper = await mountPicker(insideView(), INSIDE)
    expect(browseDirectories).toHaveBeenCalledWith(INSIDE)
    expect(wrapper.text()).toContain(INSIDE)
  })

  it('点一行就进下一层（不是选中）', async () => {
    const wrapper = await mountPicker()
    await button(wrapper, 'proj').trigger('click')
    await flushPromises()
    expect(browseDirectories).toHaveBeenLastCalledWith(INSIDE)
  })

  it('「上一级」回到父目录，到了最上层就置灰', async () => {
    const wrapper = await mountPicker()
    await button(wrapper, '上一级').trigger('click')
    await flushPromises()
    expect(browseDirectories).toHaveBeenLastCalledWith('C:\\data')

    browseDirectories.mockResolvedValue(areaView({ path: 'C:\\', parent: null }))
    await wrapper.setProps({ open: false })
    await wrapper.setProps({ open: true })
    await flushPromises()
    expect(button(wrapper, '上一级').attributes('disabled')).toBeDefined()
  })

  it('不可选的目录**照样能点进去**，只是标着原因', async () => {
    const wrapper = await mountPicker()
    const row = button(wrapper, 'data')
    expect(row.text()).toContain('不能把数据目录')
    await row.trigger('click')
    await flushPromises()
    expect(browseDirectories).toHaveBeenLastCalledWith('C:\\data')
  })

  it('当前这一层不可选时，「选这个目录」是灰的并说明原因', async () => {
    const wrapper = await mountPicker(
      outsideView({
        current: dir('data', OUTSIDE, {
          selectable: false,
          reason: '不能把数据目录（或它里面的目录）作为工作区',
        }),
      }),
    )
    const pick = button(wrapper, '选这个目录')
    expect(pick.attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('不能把数据目录')
  })

  it('选完把路径交给调用方，并请求关掉自己', async () => {
    const wrapper = await mountPicker(insideView(), INSIDE)
    await button(wrapper, '选这个目录').trigger('click')
    expect(wrapper.emitted('pick')).toEqual([[INSIDE]])
    // `defineModel` 只**请求**关闭（发出 update:open），真正的关由父组件那侧生效
    expect(wrapper.emitted('update:open')).toEqual([[false]])
  })

  it('起点可以直接跳过去', async () => {
    const wrapper = await mountPicker()
    await button(wrapper, 'E:').trigger('click')
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
    const wrapper = await mountPicker(areaView({ entries: [] }))
    expect(wrapper.text()).toContain('没有子目录')
  })
})

describe('专用区域：默认落在这里，也只有这里能建（v0.41）', () => {
  it('不填 start 时不带路径请求——服务端就把专用区域给回来', async () => {
    const wrapper = await mountPicker(areaView(), '')
    // 不自己拼区域路径：数据目录在哪只有服务端知道（拼错了就是"找不到"）
    expect(browseDirectories).toHaveBeenCalledWith(undefined)
    expect(wrapper.text()).toContain(AREA)
  })

  it('站在区域里时说明这里能建，并把"区域自己不能当工作区"顶到按钮上', async () => {
    const wrapper = await mountPicker()
    expect(wrapper.text()).toContain('唯一能新建文件夹')
    // 区域是**容器**不是项目：底部那颗按钮灰着，原因照旧由服务端给
    const pick = button(wrapper, '选这个目录')
    expect(pick.attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('区域本身不能当工作区')
  })

  it('区域里「新建文件夹」亮着，点得开、建得成', async () => {
    createDirectory.mockResolvedValue(dir('新项目', `${AREA}\\新项目`))
    const wrapper = await mountPicker()
    const newDir = button(wrapper, '新建文件夹')
    expect(newDir.attributes('disabled')).toBeUndefined()

    await newDir.trigger('click')
    await wrapper.find('input[aria-label="新文件夹名"]').setValue('新项目')
    await button(wrapper, '建', true).trigger('click')
    await flushPromises()

    expect(createDirectory).toHaveBeenCalledWith(AREA, '新项目')
    // 建完直接进去（建它就是为了用它），"选这个目录"这时才亮
    expect(browseDirectories).toHaveBeenLastCalledWith(`${AREA}\\新项目`)
  })

  it('区域外：「新建文件夹」灰着，原因就写在旁边，点了也弹不出输入框', async () => {
    const wrapper = await mountPicker(outsideView(), OUTSIDE)
    const newDir = button(wrapper, '新建文件夹')
    expect(newDir.attributes('disabled')).toBeDefined()
    expect(newDir.attributes('title')).toBe(ONLY_AREA)
    expect(wrapper.text()).toContain(ONLY_AREA)

    await newDir.trigger('click')
    expect(wrapper.find('input[aria-label="新文件夹名"]').exists()).toBe(false)
  })

  it('区域外那一层仍然**可以选**（只读不等于不能选）', async () => {
    const wrapper = await mountPicker(outsideView(), OUTSIDE)
    const pick = button(wrapper, '选这个目录')
    expect(pick.attributes('disabled')).toBeUndefined()
    await pick.trigger('click')
    expect(wrapper.emitted('pick')).toEqual([[OUTSIDE]])
  })

  it('行上标着「只读」，完整原因在 title 里', async () => {
    const wrapper = await mountPicker()
    const row = button(wrapper, 'data')
    expect(row.text()).toContain('只读')
    // 能建的那一行没有这个标
    expect(button(wrapper, 'proj').text()).not.toContain('只读')
  })
})

describe('新建与改名（v0.36）', () => {
  it('「新建文件夹」建完**直接进去**（建它就是为了用它），「选这个目录」当场就亮了', async () => {
    const created = `${AREA}\\新项目`
    createDirectory.mockResolvedValue(dir('新项目', created))
    const wrapper = await mountPicker()
    // 建完会重新浏览刚建好的那一层
    browseDirectories.mockResolvedValueOnce(
      insideView({ path: created, current: dir('新项目', created), parent: AREA, entries: [] }),
    )

    await button(wrapper, '新建文件夹').trigger('click')
    await wrapper.find('input[aria-label="新文件夹名"]').setValue('新项目')
    await button(wrapper, '建', true).trigger('click')
    await flushPromises()

    expect(createDirectory).toHaveBeenCalledWith(AREA, '新项目')
    expect(browseDirectories).toHaveBeenLastCalledWith(created)
    // 验收：在区域里建目录 → 选中它当工作区，一步成功
    expect(button(wrapper, '选这个目录').attributes('disabled')).toBeUndefined()
  })

  it('名字为空时「建」是灰的', async () => {
    const wrapper = await mountPicker()
    await button(wrapper, '新建文件夹').trigger('click')
    expect(button(wrapper, '建', true).attributes('disabled')).toBeDefined()
  })

  it('重名时把服务端那句话显示出来，输入框还在（改完能接着试）', async () => {
    createDirectory.mockRejectedValue(new Error('「新项目」已经存在了，换一个名字'))
    const wrapper = await mountPicker()
    await button(wrapper, '新建文件夹').trigger('click')
    await wrapper.find('input[aria-label="新文件夹名"]').setValue('新项目')
    await button(wrapper, '建', true).trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('已经存在了')
    expect(wrapper.find('input[aria-label="新文件夹名"]').exists()).toBe(true)
  })

  it('Esc 取消输入，什么都不建', async () => {
    const wrapper = await mountPicker()
    await button(wrapper, '新建文件夹').trigger('click')
    await wrapper.find('input[aria-label="新文件夹名"]').trigger('keyup.esc')
    expect(wrapper.find('input[aria-label="新文件夹名"]').exists()).toBe(false)
    expect(createDirectory).not.toHaveBeenCalled()
  })

  it('改名走 PATCH，改完留在原地刷新', async () => {
    renameDirectory.mockResolvedValue(dir('proj2', `${AREA}\\proj2`))
    const wrapper = await mountPicker()
    await wrapper.find('button[aria-label="把「proj」改名"]').trigger('click')
    const input = wrapper.find('input[aria-label="把「proj」改名"]')
    expect((input.element as HTMLInputElement).value).toBe('proj')
    await input.setValue('proj2')
    await button(wrapper, '改', true).trigger('click')
    await flushPromises()
    expect(renameDirectory).toHaveBeenCalledWith(INSIDE, 'proj2')
    // 留在原来这一层（改的是这一行，不是"进去"）
    expect(browseDirectories).toHaveBeenLastCalledWith(AREA)
  })

  it('区域外的行：改名图标灰着，原因写在图标上（不让用户点了才知道）', async () => {
    const wrapper = await mountPicker(outsideView(), OUTSIDE)
    const rename = wrapper.find(`button[aria-label="${ONLY_AREA_RENAME}"]`)
    expect(rename.exists()).toBe(true)
    expect(rename.attributes('disabled')).toBeDefined()
    expect(rename.attributes('title')).toBe(ONLY_AREA_RENAME)
  })

  it('改名被拒时显示原因（比如它是个工作区的根目录）', async () => {
    renameDirectory.mockRejectedValue(
      new Error('「proj」是工作区「老项目」的根目录，改名会让那条工作区失联'),
    )
    const wrapper = await mountPicker()
    await wrapper.find('button[aria-label="把「proj」改名"]').trigger('click')
    await wrapper.find('input[aria-label="把「proj」改名"]').setValue('proj2')
    await button(wrapper, '改', true).trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('工作区')
    expect(wrapper.text()).toContain('失联')
  })
})
