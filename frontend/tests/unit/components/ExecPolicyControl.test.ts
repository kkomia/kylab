/**
 * 输入框那一排的「执行策略」（v0.41）。
 *
 * 用户报的是"策略只在设置里，被拦时直接自动拒绝"。这个控件是那条诉求的前半段：
 * **把入口放到手边**。它钉的是"与设置页同一份数据"这件事——
 * 读的是 `sandbox.exec_policy` 那一项，写走的是同一个 `updateSettings`，
 * 在这里另存一份会让两处的档位悄悄不一致（而"我明明改成允许了"正是最难查的）。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SettingsView } from '@/api/settings'

const getSettings = vi.fn()
const updateSettings = vi.fn()
const notifyError = vi.fn()
const notifySuccess = vi.fn()
const isAdmin = vi.fn(() => true)

vi.mock('@/api/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/settings')>()
  return {
    ...actual,
    getSettings: (...args: unknown[]) => getSettings(...args),
    updateSettings: (...args: unknown[]) => updateSettings(...args),
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

import ExecPolicyControl from '@/components/chat/ExecPolicyControl.vue'

function view(mode: string): SettingsView {
  return {
    groups: [
      {
        key: 'sandbox',
        label: '沙箱执行',
        fields: [
          {
            key: 'sandbox.exec_policy',
            label: '总开关（allow / ask / deny / sandbox）',
            type: 'select',
            value: mode,
            configured: true,
            options: [],
          },
          {
            key: 'sandbox.rules_allow',
            label: '放行清单',
            type: 'text',
            value: '',
            configured: false,
            options: [],
          },
        ],
      },
    ],
    embedding_model_id: '',
    embedding_dim: 0,
    embedding_configured: true,
    embedding_is_development: false,
    rerank_enabled: false,
  }
}

async function mounted(mode = 'ask') {
  getSettings.mockResolvedValue(view(mode))
  const wrapper = mount(ExecPolicyControl, { attachTo: document.body })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  vi.clearAllMocks()
  isAdmin.mockReturnValue(true)
  updateSettings.mockResolvedValue({ updated: 1, rejected: [] })
})

describe('ExecPolicyControl', () => {
  it('显示当前档（读的是设置页那一项）', async () => {
    const wrapper = await mounted('ask')

    expect(wrapper.text()).toContain('执行·需确认')
    expect(getSettings).toHaveBeenCalled()
  })

  it('切换档位时 PATCH 同一个键，改完立刻显示新档', async () => {
    const wrapper = await mounted('ask')

    await wrapper.find('summary').trigger('click')
    const item = wrapper.findAll('button').find((button) => button.text() === '允许')!
    await item.trigger('click')
    await flushPromises()

    // **键名与取值都要对**：写错一个字母，界面上会显示"已保存"而策略没变
    expect(updateSettings).toHaveBeenCalledWith([{ key: 'sandbox.exec_policy', value: 'allow' }])
    expect(wrapper.text()).toContain('执行·允许')
    expect(notifySuccess).toHaveBeenCalled()
  })

  it('后端不收这一项时如实报错，并且不改界面上的档', async () => {
    updateSettings.mockResolvedValue({ updated: 0, rejected: ['sandbox.exec_policy'] })
    const wrapper = await mounted('ask')

    await wrapper.find('summary').trigger('click')
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '拒绝')!
      .trigger('click')
    await flushPromises()

    expect(notifyError).toHaveBeenCalled()
    expect(wrapper.text()).toContain('执行·需确认')
  })

  it('当前值不在三档里（如 sandbox）时**照原样显示**，不假装它是别的东西', async () => {
    const wrapper = await mounted('sandbox')
    expect(wrapper.text()).toContain('执行·sandbox')
  })

  it('非管理员不显示：它背后是管理员端点，摆着只会让人点了拿到 403', async () => {
    isAdmin.mockReturnValue(false)
    getSettings.mockResolvedValue(view('ask'))

    const wrapper = mount(ExecPolicyControl)
    await flushPromises()

    expect(wrapper.text()).toBe('')
    expect(getSettings).not.toHaveBeenCalled()
  })

  it('读不到配置时不显示这个控件（它是顺手的入口，不该把对话页变成错误提示）', async () => {
    getSettings.mockRejectedValue(new Error('403'))
    const wrapper = mount(ExecPolicyControl)
    await flushPromises()

    expect(wrapper.text()).toBe('')
    expect(notifyError).not.toHaveBeenCalled()
  })
})
