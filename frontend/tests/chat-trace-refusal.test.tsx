/**
 * D22：步骤"是不是不成功"要**看结构化字段**，不再靠匹配句式。
 *
 * 为什么单独钉"接线"：`forceExpand` 是纯函数，单测它容易过——但真正会回归的是
 * `TraceStepRow` 里那一行**有没有用它**（走查 D19 的教训：只测纯函数，把那一行删掉也不会红）。
 * 所以这里渲染真组件，看"默认展开"这条外部行为。
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { forceExpand, TraceStepRow } from '@/features/chat/ui/TraceStepRow'
import type { TraceStep } from '@/features/chat/model/turns'

function step(extra: Partial<TraceStep> = {}): TraceStep {
  return {
    key: 'step-1',
    icon: 'exec',
    label: '跑命令',
    detail: '这一步先不做了',
    args: '{"cmd": "ls"}',
    ...extra,
  }
}

describe('不成功的步骤看结构化字段（D22，2026-09-28 走查）', () => {
  it('中性措辞 + outcome="blocked" → 仍然当成拦截（那一行默认展开）', () => {
    // 病灶：原先只能靠句式认（「没有执行」「等待确认」「拒绝执行」…），
    // 措辞一改，用户就会以为它做了——而这一行是默认展开的，正是为了让人一眼看见拦截。
    render(<TraceStepRow step={step({ outcome: 'blocked' })} open={false} onToggle={vi.fn()} />)

    // 默认展开 = 入参那一块直接看得见
    expect(screen.getByText('入参')).toBeInTheDocument()
  })

  it('正常步骤（没有 outcome、措辞中性）→ 不默认展开', () => {
    render(<TraceStepRow step={step()} open={false} onToggle={vi.fn()} />)

    expect(screen.queryByText('入参')).not.toBeInTheDocument()
  })

  it('老快照（没有 outcome，但措辞是拦截）→ 词表兜底仍然认', () => {
    render(
      <TraceStepRow
        step={step({ detail: '没有执行（模式「只读」拦下）' })}
        open={false}
        onToggle={vi.fn()}
      />,
    )

    expect(screen.getByText('入参')).toBeInTheDocument()
  })

  it('纯判据：outcome 在就听它的，缺省才看措辞', () => {
    expect(forceExpand({ outcome: 'blocked', detail: '随便写' })).toBe(true)
    expect(forceExpand({ outcome: 'awaiting', detail: '随便写' })).toBe(true)
    // 结构化字段说"正常"（`""`），就不该被措辞翻案——虽然措辞看着像拦截
    expect(forceExpand({ outcome: '', detail: '没有执行（模式拦下）' })).toBe(false)
    // **老快照**（没有这个字段）才回退去认句式
    expect(forceExpand({ detail: '没有执行（模式拦下）' })).toBe(true)
    expect(forceExpand({ detail: '跑完了，输出 3 行' })).toBe(false)
  })

  /*
   * 第三次那一档（lane 2）：**工具自己出错**也要默认展开。
   *
   * 它的 `summary` 里就是真原因（「工具内部错误：…」，见 `tool_loop.py` 那条），
   * 可它既不是拦截、措辞也不在词表里——判据只能是结构化字段，后端因此补了
   * `outcome="failed"`。折起来的话，用户看到的就是一行"成功"的工具调用。
   */
  it('outcome="failed"（工具内部错误）→ 那一行默认展开', () => {
    render(
      <TraceStepRow
        step={step({ outcome: 'failed', detail: '工具内部错误：服务连不上' })}
        open={false}
        onToggle={vi.fn()}
      />,
    )

    expect(screen.getByText('入参')).toBeInTheDocument()
  })

  it('纯判据：failed 算"必须看得见"；它不该靠句式认（措辞里一个字都不像拦截）', () => {
    expect(forceExpand({ outcome: 'failed', detail: '工具内部错误：服务连不上' })).toBe(true)
    // 老快照没有 outcome：一句"工具内部错误"认不出来（这正是要补字段的原因）
    expect(forceExpand({ detail: '工具内部错误：服务连不上' })).toBe(false)
  })
})
