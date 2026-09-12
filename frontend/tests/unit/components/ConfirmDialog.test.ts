import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'

/** AppModal 在 jsdom 里没有 `<dialog>.showModal()`，换成交通容器（同 UploadDialog 测试）。 */
function mountConfirm(props: Record<string, unknown> = {}) {
  return mount(ConfirmDialog, {
    props: {
      open: true,
      title: '删除目录',
      lead: '删除目录「合同」？',
      ...props,
    },
    global: {
      stubs: {
        AppModal: { template: '<div><slot /><slot name="footer" /></div>' },
      },
    },
  })
}

describe('ConfirmDialog', () => {
  it('呈现标题、直问与后果说明，确认按钮缺省叫「删除」', () => {
    const wrapper = mountConfirm({ note: '目录里的文档不受影响。' })

    expect(wrapper.text()).toContain('删除目录「合同」？')
    expect(wrapper.text()).toContain('目录里的文档不受影响。')
    const buttons = wrapper.findAll('button')
    expect(buttons.map((b) => b.text())).toEqual(['取消', '删除'])
  })

  it('点确认发出 confirm 且不自己关弹窗（关不关由调用方按结果决定）', async () => {
    const wrapper = mountConfirm()
    const confirm = wrapper.findAll('button').find((b) => b.text() === '删除')
    await confirm!.trigger('click')

    expect(wrapper.emitted('confirm')).toHaveLength(1)
    expect(wrapper.emitted('update:open')).toBeUndefined()
  })

  it('busy 时确认按钮禁用并显示进行中文案', () => {
    const wrapper = mountConfirm({ busy: true, busyLabel: '删除中…' })

    const confirm = wrapper.findAll('button').find((b) => b.text().includes('删除中'))
    expect(confirm!.attributes('disabled')).toBeDefined()
  })

  it('confirmLabel 可换文案（取消解析这类不是"删除"的动作）', () => {
    const wrapper = mountConfirm({ confirmLabel: '取消解析' })
    expect(wrapper.findAll('button').map((b) => b.text())).toEqual(['取消', '取消解析'])
  })

  it('默认插槽承载影响清单等附加内容', () => {
    // 影响清单由调用方排版，这里只验证插槽内容会被带出来
    const wrapper = mount(ConfirmDialog, {
      props: { open: true, title: '删除文档', lead: '确定删除？' },
      slots: { default: '<dl class="impact">切块 12</dl>' },
      global: {
        stubs: { AppModal: { template: '<div><slot /><slot name="footer" /></div>' } },
      },
    })
    expect(wrapper.find('.impact').text()).toBe('切块 12')
  })
})
