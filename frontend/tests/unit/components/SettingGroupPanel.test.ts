/**
 * 模块页上的设置面板（v0.26）。
 *
 * 它存在的理由是"同一条设置不该有两个说法"：长期记忆的开关原来在总设置里，
 * 而记忆页顶着一句"记忆服务未启用"。现在两边共用这一个组件，
 * 所以这里钉的是它的三条契约：**只渲染你要的那几组**、**按你要的顺序**、
 * **密钥不回显**。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SettingGroup } from '@/api/settings'

const getSettings = vi.fn()
const updateSettings = vi.fn()

vi.mock('@/api/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/settings')>()
  return {
    ...actual,
    getSettings: (...args: unknown[]) => getSettings(...args),
    updateSettings: (...args: unknown[]) => updateSettings(...args),
  }
})

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ notifySuccess: vi.fn(), notifyError: vi.fn(), notifyWarning: vi.fn() }),
}))

import SettingGroupPanel from '@/components/settings/SettingGroupPanel.vue'

function group(key: string, label: string, fields: SettingGroup['fields'] = []): SettingGroup {
  return { key, label, fields }
}

const MEMORY = group('memory', '长期记忆', [
  {
    key: 'memory.enabled',
    label: '启用长期记忆',
    type: 'bool',
    value: 'false',
    configured: false,
    options: [],
  },
  {
    key: 'memory.base_url',
    label: '记忆服务地址',
    type: 'text',
    value: 'http://127.0.0.1:2333',
    configured: false,
    options: [],
  },
])

const WEB = group('web', '联网', [
  {
    key: 'web.search_api_key',
    label: '搜索 API 密钥',
    type: 'secret',
    value: 'tvly-••••',
    configured: true,
    options: [],
  },
])

const SANDBOX = group('sandbox', '沙箱执行', [
  {
    key: 'sandbox.exec_policy',
    label: '总开关',
    type: 'text',
    value: 'ask',
    configured: false,
    options: [],
  },
])

beforeEach(() => {
  vi.clearAllMocks()
  getSettings.mockResolvedValue({ groups: [MEMORY, WEB, SANDBOX] })
  updateSettings.mockResolvedValue({ updated: [], rejected: [] })
})

describe('设置面板', () => {
  it('只渲染要的那几组，顺序按调用方给的来', async () => {
    const wrapper = mount(SettingGroupPanel, { props: { keys: ['sandbox', 'web'] } })
    await flushPromises()

    const titles = wrapper.findAll('.section-title').map((item) => item.text())
    expect(titles).toEqual(['沙箱执行', '联网'])
    // 没要的那一组一个字都不该出现
    expect(wrapper.text()).not.toContain('长期记忆')
  })

  it('浏览态把值翻译成人话：布尔说"未开启"，密钥说"已配置"', async () => {
    const wrapper = mount(SettingGroupPanel, { props: { keys: ['memory', 'web'] } })
    await flushPromises()

    const text = wrapper.text()
    expect(text).toContain('未开启')
    expect(text).toContain('http://127.0.0.1:2333')
    expect(text).toContain('已配置')
    // true/false 与掩码原文都不该直接铺在界面上
    expect(text).not.toContain('false')
  })

  it('密钥编辑时留空（不回显掩码），保存只提交改动过的那份草稿', async () => {
    const wrapper = mount(SettingGroupPanel, { props: { keys: ['web'] } })
    await flushPromises()

    await wrapper.find('.edit-actions button').trigger('click')
    await flushPromises()

    const input = wrapper.find('input[type="text"]')
    expect((input.element as HTMLInputElement).value).toBe('')
    expect(input.attributes('placeholder')).toBe('留空表示不改动')

    await wrapper.findAll('.edit-actions button')[1].trigger('click')
    await flushPromises()

    expect(updateSettings).toHaveBeenCalledWith([{ key: 'web.search_api_key', value: '' }])
  })

  it('布尔项用复选框，勾上保存的是字符串 "true" 而不是"看起来像真"的东西', async () => {
    const wrapper = mount(SettingGroupPanel, { props: { keys: ['memory'] } })
    await flushPromises()

    await wrapper.find('.edit-actions button').trigger('click')
    await flushPromises()

    await wrapper.find('input[type="checkbox"]').setValue(true)
    await wrapper.findAll('.edit-actions button')[1].trigger('click')
    await flushPromises()

    expect(updateSettings).toHaveBeenCalledWith([
      { key: 'memory.enabled', value: 'true' },
      { key: 'memory.base_url', value: 'http://127.0.0.1:2333' },
    ])
  })

  it('读不到配置时说"读不到"，不是留一片空白', async () => {
    // 这些面板背后是管理员端点：成员点进来会拿到 403，
    // 而空白会让人以为"这一组没有可配的项"
    getSettings.mockRejectedValue(new Error('需要管理员权限'))
    const wrapper = mount(SettingGroupPanel, { props: { keys: ['memory'] } })
    await flushPromises()

    expect(wrapper.text()).toContain('需要管理员权限')
  })
})
