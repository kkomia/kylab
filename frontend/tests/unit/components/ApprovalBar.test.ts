/**
 * 输入框上方那条「这条命令要执行，你同意吗」（v0.41）。
 *
 * 它对应的用户报的问题：**ask 档下界面上什么都没有，直接就拒绝了**。
 * 所以这里钉三件事：
 *
 * 1. 要执行什么**看得见**（命令原文 + 会写下哪条规则）——用户是在核对，不是在点确认；
 * 2. 三个按钮各自 POST 对的取值，且**点完就收起**（后端那一头在等这个回答）；
 * 3. POST 失败（409：已经超时或点过一次）**也收起**，并把后端那句话原样说出来
 *    ——摆着一条点不动的确认，只会让人以为还有机会。
 */
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatApproval } from '@/api/chat'

const decideApproval = vi.fn()
const notifyError = vi.fn()

vi.mock('@/api/chat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/chat')>()
  return { ...actual, decideApproval: (...args: unknown[]) => decideApproval(...args) }
})

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ notifySuccess: vi.fn(), notifyError, notifyWarning: vi.fn() }),
}))

import ApprovalBar from '@/components/chat/ApprovalBar.vue'

function approval(extra: Partial<ChatApproval> = {}): ChatApproval {
  return {
    approval_id: 'ap_1',
    tool: 'run_command',
    label: '执行命令',
    args: 'git push --force',
    detail: '在 bwrap 隔离里执行；已断网',
    rule: 'Bash(git:*)',
    timeout_seconds: 120,
    ...extra,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  decideApproval.mockResolvedValue({ accepted: true, detail: '' })
})

describe('ApprovalBar', () => {
  it('摆出要执行什么、在哪跑、以及会写下哪条规则', () => {
    const wrapper = mount(ApprovalBar, { props: { approval: approval() } })

    expect(wrapper.text()).toContain('执行命令')
    expect(wrapper.text()).toContain('git push --force')
    expect(wrapper.text()).toContain('bwrap')
    // 「这类都允许」写下的那行规则要先给用户看：不摆就是让他盲签
    expect(wrapper.text()).toContain('Bash(git:*)')
    // 超时会被当成拒绝——这句话要说明白，否则用户以为"不点也没事"
    expect(wrapper.text()).toContain('120 秒')
  })

  it('点「允许一次」POST allow_once 给那条确认，然后收起', async () => {
    const wrapper = mount(ApprovalBar, { props: { approval: approval() } })

    const button = wrapper.findAll('button').find((item) => item.text() === '允许一次')!
    await button.trigger('click')

    expect(decideApproval).toHaveBeenCalledWith('ap_1', 'allow_once')
    expect(wrapper.emitted('settled')).toHaveLength(1)
  })

  it('「这类都允许」与「拒绝」各自 POST 对的取值', async () => {
    for (const [text, decision] of [
      ['这类都允许', 'allow_always'],
      ['拒绝', 'deny'],
    ] as const) {
      decideApproval.mockClear()
      const wrapper = mount(ApprovalBar, { props: { approval: approval() } })
      const button = wrapper.findAll('button').find((item) => item.text() === text)!
      await button.trigger('click')
      expect(decideApproval).toHaveBeenCalledWith('ap_1', decision)
    }
  })

  it('POST 失败时如实说出后端那句话，并且**照样收起**', async () => {
    decideApproval.mockRejectedValue(
      new Error('这条确认已经失效了（等太久超时，或者已经点过一次）。'),
    )
    const wrapper = mount(ApprovalBar, { props: { approval: approval() } })

    const button = wrapper.findAll('button').find((item) => item.text() === '允许一次')!
    await button.trigger('click')
    await Promise.resolve()

    expect(notifyError).toHaveBeenCalledWith(expect.stringContaining('已经失效'))
    expect(wrapper.emitted('settled')).toHaveLength(1)
  })

  it('拒绝时填的理由跟着决定一起送出去（P2-1）', async () => {
    const wrapper = mount(ApprovalBar, { props: { approval: approval() } })

    // 理由输入框就摆在这一条上：填一句给模型的话是"拒绝"的搭档动作
    await wrapper.find('#kylab-approval-reason').setValue('这条别动生产库')
    const button = wrapper.findAll('button').find((item) => item.text() === '拒绝')!
    await button.trigger('click')

    expect(decideApproval).toHaveBeenCalledWith('ap_1', 'deny', '这条别动生产库')
  })

  it('**不填理由时调用形状与以前逐字相同**（两个参数）', async () => {
    const wrapper = mount(ApprovalBar, { props: { approval: approval() } })

    const button = wrapper.findAll('button').find((item) => item.text() === '拒绝')!
    await button.trigger('click')

    expect(decideApproval).toHaveBeenCalledWith('ap_1', 'deny')
  })

  it('理由只在「拒绝」上发：允许那两档不带它', async () => {
    const wrapper = mount(ApprovalBar, { props: { approval: approval() } })

    await wrapper.find('#kylab-approval-reason').setValue('顺便提一句')
    const allow = wrapper.findAll('button').find((item) => item.text() === '允许一次')!
    await allow.trigger('click')

    // 放行与"我给模型留句话"是两件事：混在一起模型下一轮会读错（见后端 _with_reason）
    expect(decideApproval).toHaveBeenCalledWith('ap_1', 'allow_once')
  })

  it('后端没给规则/超时（老版本事件）时不摆那两句话，也不报错', () => {
    const wrapper = mount(ApprovalBar, {
      props: { approval: approval({ rule: '', timeout_seconds: 0, detail: '' }) },
    })

    expect(wrapper.text()).not.toContain('放行清单')
    expect(wrapper.text()).not.toContain('秒内不回应')
    expect(wrapper.findAll('button')).toHaveLength(3)
  })
})
