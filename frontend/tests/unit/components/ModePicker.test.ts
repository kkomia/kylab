/**
 * 输入框那一排的「Agent 模式」四档（v0.43，§12.225 的 P1-1）。
 *
 * 这个控件钉三件事：
 *
 * 1. **与设置页同一份数据**：读 `chat.mode`、写也走同一个 `PATCH /settings`
 *    （在这里另存一份的话，界面上的档与引擎用的档迟早不一致）；
 * 2. **四档的名字与那句人话都在菜单里**（"计划"与"全放行"在用户眼里完全是两件事，
 *    只显示一个当前值是让他猜）；
 * 3. 读不到 / 非管理员就**不显示**（它是顺手的入口，不该把对话页变成错误提示，
 *    也不该让成员点一下拿到 403）。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatModeView } from '@/api/settings'

const getChatMode = vi.fn()
const setChatMode = vi.fn()
const notifyError = vi.fn()
const notifySuccess = vi.fn()
const isAdmin = vi.fn(() => true)

vi.mock('@/api/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/settings')>()
  return {
    ...actual,
    getChatMode: (...args: unknown[]) => getChatMode(...args),
    setChatMode: (...args: unknown[]) => setChatMode(...args),
  }
})

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ notifySuccess, notifyError, notifyWarning: vi.fn() }),
}))

vi.mock('@/composables/useSession', () => ({
  get isAdmin() {
    return { value: isAdmin() }
  },
}))

import ModePicker from '@/components/chat/ModePicker.vue'

/** 后端给的候选：取值是权威（`value`），展示名后面带着那句人话的括号。 */
function view(mode = 'build'): ChatModeView {
  return {
    mode,
    options: [
      { value: 'build', label: '构建（变更前确认）' },
      { value: 'edit', label: '编辑（自动编辑）' },
      { value: 'plan', label: '计划（先给计划再动手）' },
      { value: 'yolo', label: '全放行（少确认全放行）' },
    ],
  }
}

async function mounted(mode = 'build') {
  getChatMode.mockResolvedValue(view(mode))
  const wrapper = mount(ModePicker, { attachTo: document.body })
  await flushPromises()
  return wrapper
}

/** 菜单里那一项（按档名找，避开其它按钮）。 */
function itemOf(wrapper: Awaited<ReturnType<typeof mounted>>, name: string) {
  const found = wrapper
    .findAll('button')
    .find((button) => button.find('.mode-name').exists() && button.text().includes(name))
  if (!found) throw new Error(`模式菜单里没有「${name}」`)
  return found
}

beforeEach(() => {
  vi.clearAllMocks()
  isAdmin.mockReturnValue(true)
  setChatMode.mockResolvedValue({ updated: 1, rejected: [] })
})

describe('ModePicker', () => {
  it('显示当前档（读的是设置页那一项）', async () => {
    const wrapper = await mounted('build')

    expect(wrapper.text()).toContain('模式·构建')
    expect(getChatMode).toHaveBeenCalled()
  })

  it('四档都在，每档带一句人话', async () => {
    const wrapper = await mounted('build')

    await wrapper.find('summary').trigger('click')

    expect(wrapper.findAll('.mode-name').map((node) => node.text())).toEqual([
      '构建',
      '编辑',
      '计划',
      '全放行',
    ])
    // 那一句人话是 ZCode 的 UI 文案直译（见 modes.py 的 MODE_DEFS）
    expect(wrapper.text()).toContain('先给计划再动手')
    expect(wrapper.text()).toContain('少确认全放行')
  })

  it('切档时 PATCH 同一个键，改完立刻显示新档', async () => {
    const wrapper = await mounted('build')

    await wrapper.find('summary').trigger('click')
    await itemOf(wrapper, '计划').trigger('click')
    await flushPromises()

    // **键名与取值都要对**：写错一个字母，界面会显示"已保存"而引擎那一档没变
    expect(setChatMode).toHaveBeenCalledWith('plan')
    expect(wrapper.text()).toContain('模式·计划')
    expect(notifySuccess).toHaveBeenCalled()
  })

  it('后端不收这一项时如实报错，并且不改界面上的档', async () => {
    setChatMode.mockResolvedValue({ updated: 0, rejected: ['chat.mode'] })
    const wrapper = await mounted('build')

    await wrapper.find('summary').trigger('click')
    await itemOf(wrapper, '全放行').trigger('click')
    await flushPromises()

    expect(notifyError).toHaveBeenCalled()
    expect(wrapper.text()).toContain('模式·构建')
  })

  it('当前值不在四档里时**照原样显示**，不假装它是别的东西', async () => {
    const wrapper = await mounted('sandbox')

    expect(wrapper.text()).toContain('模式·sandbox')
  })

  it('非管理员不显示：它背后是管理员端点，摆着只会让人点了拿到 403', async () => {
    isAdmin.mockReturnValue(false)
    getChatMode.mockResolvedValue(view())

    const wrapper = mount(ModePicker)
    await flushPromises()

    expect(wrapper.text()).toBe('')
    expect(getChatMode).not.toHaveBeenCalled()
  })

  it('读不到配置时不显示这个控件（它是顺手的入口，不该把对话页变成错误提示）', async () => {
    getChatMode.mockRejectedValue(new Error('403'))
    const wrapper = mount(ModePicker)
    await flushPromises()

    expect(wrapper.text()).toBe('')
    expect(notifyError).not.toHaveBeenCalled()
  })

  it('后端没有这一项时不显示：显示了也写不动，那是个点了没反应的控件', async () => {
    getChatMode.mockResolvedValue({ mode: '', options: [] })
    const wrapper = mount(ModePicker)
    await flushPromises()

    expect(wrapper.text()).toBe('')
  })
})
