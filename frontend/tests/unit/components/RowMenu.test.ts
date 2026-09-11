/**
 * 行内操作菜单（RowMenu /「⋯」）的交互契约。
 *
 * 原生 `<details>` 只保证"点 summary 开、再点收起"，其余三件事是 v0.8 自己补的，
 * 也正是最容易在重构里悄悄坏掉的部分，所以钉在这里：
 *
 * 1. 点浮层外部收起——菜单展开后飘在页面上不动，是这类控件最常见的抱怨；
 * 2. Esc 收起——键盘用户唯一的退路（原生 details 不响应 Esc）；
 * 3. 下方放不下时向上弹——设置弹窗正文是滚动容器，贴着底边的卡片向下弹会被裁掉，
 *    而「删除」通常是最后一项，裁掉它就等于藏了破坏性操作。
 *
 * 用 `open` 属性 + 手动派发 `toggle` 驱动：jsdom 不实现"点 summary 就切换"，
 * 而契约的关键在 toggle 之后的挂载/定位逻辑。
 */
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'

import RowMenu from '@/components/ui/RowMenu.vue'

function mountMenu(attach = true) {
  return mount(RowMenu, {
    props: { label: '更多操作' },
    slots: { default: '<button class="item" type="button">编辑</button>' },
    attachTo: attach ? document.body : undefined,
  })
}

/** 展开：设 open 再补一次 toggle，等价于浏览器点开 summary 的效果。 */
async function open(wrapper: VueWrapper): Promise<HTMLDetailsElement> {
  const details = wrapper.find('details').element as HTMLDetailsElement
  details.open = true
  details.dispatchEvent(new Event('toggle'))
  // 定位结果写进 class，要等一轮渲染才能断言
  await nextTick()
  return details
}

/** 压窄可见范围，制造"下方放不下、上方放得下"。 */
function stubTightLayout(trigger: HTMLElement, menuHeight: number): void {
  const originalDoc = document.documentElement.getBoundingClientRect
  document.documentElement.getBoundingClientRect = () =>
    ({ top: 0, bottom: 800, left: 0, right: 1200, width: 1200, height: 800 }) as DOMRect
  trigger.getBoundingClientRect = () =>
    ({ top: 700, bottom: 724, left: 0, right: 24, width: 24, height: 24 }) as DOMRect
  const list = trigger.querySelector('.menu-list') as HTMLElement
  Object.defineProperty(list, 'offsetHeight', { value: menuHeight, configurable: true })
  afterEach(() => {
    document.documentElement.getBoundingClientRect = originalDoc
  })
}

describe('RowMenu', () => {
  it('触发器带可访问名，浮层内容来自插槽', () => {
    const wrapper = mountMenu()

    expect(wrapper.find('summary').attributes('aria-label')).toBe('更多操作')
    expect(wrapper.find('.menu-list .item').text()).toBe('编辑')

    wrapper.unmount()
  })

  it('展开后点浮层外部会收起', async () => {
    const wrapper = mountMenu()
    const details = await open(wrapper)

    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))

    expect(details.open).toBe(false)
    wrapper.unmount()
  })

  it('浮层内部的点击不会把它关掉', async () => {
    const wrapper = mountMenu()
    const details = await open(wrapper)

    wrapper
      .find('.menu-list .item')
      .element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))

    expect(details.open).toBe(true)
    wrapper.unmount()
  })

  it('Esc 收起（焦点在触发器上时）', async () => {
    const wrapper = mountMenu()
    const details = await open(wrapper)

    await wrapper.find('summary').trigger('keydown', { key: 'Escape' })

    expect(details.open).toBe(false)
    wrapper.unmount()
  })

  it('下方放不下时向上弹', async () => {
    const wrapper = mountMenu()
    const details = wrapper.find('details').element as HTMLDetailsElement
    stubTightLayout(details, 220)

    await open(wrapper)

    expect(wrapper.find('.menu-list').classes()).toContain('menu-list-up')
    wrapper.unmount()
  })

  it('下方放得下时不向上弹', async () => {
    const wrapper = mountMenu()
    const details = wrapper.find('details').element as HTMLDetailsElement
    stubTightLayout(details, 40)

    await open(wrapper)

    expect(wrapper.find('.menu-list').classes()).not.toContain('menu-list-up')
    wrapper.unmount()
  })

  it('卸载后不再监听外部点击（不会误关已销毁实例）', async () => {
    const wrapper = mountMenu()
    await open(wrapper)
    wrapper.unmount()

    expect(() =>
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })),
    ).not.toThrow()
  })
})
