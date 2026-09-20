import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import AppAvatar from '@/components/ui/AppAvatar.vue'

/**
 * 头像（v0.29）。
 *
 * 三件事值得钉住，因为它们的失效方式都是"看起来还行、其实认不出人"：
 *
 * 1. **没有图不等于没有身份**：默认那张是名字的首字，不是一枚灰色小人；
 * 2. **同一个名字永远同一个颜色**（列表里靠颜色认人，每次换个色就等于没这功能）；
 * 3. **图挂了要退回生成的那张**，而不是留一个破图。
 */
describe('AppAvatar', () => {
  it('中文取第一个字，西文取两个词的首字母', () => {
    expect(mount(AppAvatar, { props: { name: '小又' } }).text()).toBe('小')
    expect(mount(AppAvatar, { props: { name: 'Ada Lovelace' } }).text()).toBe('AL')
    // 单个西文词取前两位（"这个头像属于谁"仍然看得出）
    expect(mount(AppAvatar, { props: { name: 'kkomia' } }).text()).toBe('KK')
  })

  it('名字为空时给一个占位，而不是空白圆', () => {
    expect(mount(AppAvatar, { props: { name: '' } }).text()).toBe('?')
  })

  it('同一个名字颜色稳定，不同名字大概率不同', () => {
    const tone = (name: string) =>
      (mount(AppAvatar, { props: { name } }).element as HTMLElement).style.background

    expect(tone('小又')).toBe(tone('小又'))
    expect(tone('小又')).not.toBe(tone('另一个人'))
  })

  it('有链接就渲染 <img>，没有就渲染首字', () => {
    const withImage = mount(AppAvatar, { props: { name: '小又', url: '/api/v1/avatars/u1?sig=x' } })

    expect(withImage.find('img').attributes('src')).toContain('/api/v1/avatars/u1')
    expect(withImage.find('.avatar-initials').exists()).toBe(false)

    const without = mount(AppAvatar, { props: { name: '小又' } })
    expect(without.find('img').exists()).toBe(false)
    expect(without.text()).toBe('小')
  })

  it('图加载失败（链接过期 / 文件没了）就退回生成的那张', async () => {
    const wrapper = mount(AppAvatar, { props: { name: '小又', url: '/bad.png' } })

    await wrapper.find('img').trigger('error')

    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.text()).toBe('小')
  })
})
