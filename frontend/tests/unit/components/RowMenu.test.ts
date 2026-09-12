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

  it('Esc 被拦在外层之前：吃掉默认行为，不让弹窗跟着关', async () => {
    // 设置弹窗是原生 <dialog>，Esc 会让它触发 cancel。菜单开着时按 Esc 若连弹窗一起关，
    // 用户就丢了位置——所以最内层必须先把它截住。
    const wrapper = mountMenu()
    await open(wrapper)

    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    })
    document.body.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
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

describe('RowMenu 浮层定位（v17，回归）', () => {
  it('展开后写出 fixed 定位的内联坐标', async () => {
    // 回归用例：浮层改成 fixed 之后，位置**只能**靠 place() 写内联样式。
    // 一旦 place() 没跑到（或祖先有 transform 让它变成包含块），浮层会退回到
    // 静态位置——实测跑了 left:-988px，整个飘出视口，而 DOM 上完全看不出异常。
    const wrapper = mountMenu()
    const details = await open(wrapper)
    const list = details.querySelector('.menu-list') as HTMLElement

    const style = list.getAttribute('style') ?? ''
    expect(style).toContain('top:')
    expect(style).toContain('right:')

    wrapper.unmount()
  })

  it('翻向时不再依赖 `bottom`（定位统一由 top 决定）', async () => {
    const wrapper = mountMenu()
    const details = wrapper.find('details').element as HTMLDetailsElement
    stubTightLayout(details, 200)

    details.open = true
    details.dispatchEvent(new Event('toggle'))
    await nextTick()

    const list = details.querySelector('.menu-list') as HTMLElement
    // 用的是 class 标记翻向，而 top 由 place() 算出来（不再是 CSS 的 bottom）
    expect(wrapper.find('.menu-list').classes()).toContain('menu-list-up')
    expect(list.getAttribute('style') ?? '').toContain('top:')

    wrapper.unmount()
  })
})
