/**
 * 过程面板里的一行（P2-1 的两件：按 kind 带类、超长返回先给预览）。
 *
 * 这一行的两个新行为都不在"数据层"：一个是**样式钩子**（`.step-kind-*` / `data-kind`），
 * 一个是**渲染前先切一刀**（`resultPreview`）。两者都只在组件里成立，
 * 所以钉在这里；种类本身怎么来的（后端推导、老快照翻译）在
 * `useChatTurns.test.ts` 与后端 `test_tool_meta.py` 里钉。
 */
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import TraceStepRow from '@/components/chat/TraceStepRow.vue'
import IconFile from '@/components/icons/IconFile.vue'
import IconSearch from '@/components/icons/IconSearch.vue'
import { RESULT_PREVIEW_CHARS, type TraceStep } from '@/composables/useChatTurns'

/** 图标表由宿主给（真实那一份在 `ChatView`，见那里的 `STEP_ICONS`）。 */
const ICONS = { read: IconFile, search: IconSearch }

function stepAt(extra: Partial<TraceStep> = {}): TraceStep {
  return {
    key: 'k1',
    icon: 'read',
    label: '读文件',
    detail: '读了 12 行',
    tool: 'read_file',
    kind: 'read',
    ...extra,
  }
}

function mountRow(step: TraceStep, open = true) {
  return mount(TraceStepRow, { props: { step, open, icons: ICONS } })
}

describe('按种类上色/画像（P2-1）', () => {
  it('把种类带在类名与 data-kind 上，样式按它选配色', () => {
    const wrapper = mountRow(stepAt())
    const li = wrapper.find('.step')

    expect(li.classes()).toContain('step-kind-read')
    expect(li.attributes('data-kind')).toBe('read')
  })

  it('同一族的另一个工具（图标键相同）画出来一模一样', () => {
    const one = mountRow(stepAt({ tool: 'read_file', label: '读文件' }))
    const other = mountRow(stepAt({ tool: 'list_notes', label: '查看笔记' }))

    expect(one.find('.step').classes()).toEqual(other.find('.step').classes())
    expect(one.find('.step-icon svg').html()).toBe(other.find('.step-icon svg').html())
  })
})

describe('超长返回先给预览（P2-1 的第二级懒加载）', () => {
  it('超 M 字时只铺预览，并报出"仅预览 x/y 字"与「加载全部」', async () => {
    const long = 'x'.repeat(RESULT_PREVIEW_CHARS + 800)
    const wrapper = mountRow(stepAt({ args: '', result: long }))

    expect(wrapper.find('.step-raw-body').text()).toHaveLength(RESULT_PREVIEW_CHARS)
    expect(wrapper.text()).toContain(`仅预览 ${RESULT_PREVIEW_CHARS}/${long.length} 字`)

    const button = wrapper.find('.step-raw-more')
    expect(button.text()).toContain(`加载全部（${long.length} 字）`)

    await button.trigger('click')
    // 点开之后铺全文，按钮变成"收回去"——那个按钮的意义是"我确认要看"
    expect(wrapper.find('.step-raw-body').text()).toHaveLength(long.length)
    expect(wrapper.find('.step-raw-more').text()).toContain('收起')
  })

  it('短结果照原样给（不摆预览与按钮）', () => {
    const wrapper = mountRow(stepAt({ result: '退出码：0' }))

    expect(wrapper.find('.step-raw-body').text()).toBe('退出码：0')
    expect(wrapper.find('.step-raw-more').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('仅预览')
  })
})
