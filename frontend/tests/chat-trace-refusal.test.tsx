/**
 * D22：步骤"是不是不成功"要**看结构化字段**，不再靠匹配句式。
 *
 * 为什么单独钉"接线"：`forceExpand` 是纯函数，单测它容易过——但真正会回归的是
 * `TraceStepRow` 里那一行**有没有用它**（走查 D19 的教训：只测纯函数，把那一行删掉也不会红）。
 * 所以这里渲染真组件，看"默认展开"这条外部行为。
 *
 * §12.334 起同一个字段还多挂了一枚**状态灯**（`data-outcome` / 右下角那枚小图标）：
 * 判据收敛在 `stepOutcome` 一处，`forceExpand` 也问它——所以这一节同时钉三件事：
 * 默认展开、`data-outcome` 那一笔、以及**三档的可见文字一个字都没少**
 * （用户刚拍过：失败 / 被拦下 / 在等确认是安全语义，只给一枚小图标等于抹掉）。
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { forceExpand, stepOutcome, TraceStepRow } from '@/features/chat/ui/TraceStepRow'
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

describe('状态灯与 data-outcome（§12.334 第二节）', () => {
  it('纯判据：三档认得出来，其余一律"没有状态位"', () => {
    expect(stepOutcome({ outcome: 'failed' })).toBe('failed')
    expect(stepOutcome({ outcome: 'blocked' })).toBe('blocked')
    expect(stepOutcome({ outcome: 'awaiting' })).toBe('awaiting')
    // 正常（`""`）与老快照（没有这个字段）都不是状态位
    expect(stepOutcome({ outcome: '' })).toBeUndefined()
    expect(stepOutcome({})).toBeUndefined()
    // 后端将来多出来的取值不猜（三枚状态灯是互斥的，挑一枚等于把猜的结论画成事实）
    expect(stepOutcome({ outcome: 'weird' })).toBeUndefined()
  })

  it.each([
    ['failed', '工具内部错误：服务连不上'],
    ['blocked', '没有执行（模式「只读」拦下）'],
    ['awaiting', '等待确认'],
  ])('outcome=%s → 行上带 data-outcome，右下角挂一枚状态灯', (outcome, detail) => {
    const { container } = render(
      <TraceStepRow step={step({ outcome, detail })} open={false} onToggle={vi.fn()} />,
    )

    const row = container.querySelector('li')
    expect(row).toHaveAttribute('data-outcome', outcome)
    const badge = screen.getByTestId('step-outcome')
    expect(badge).toHaveAttribute('data-outcome', outcome)
    // 那一格只挂一枚（三档互斥）
    expect(screen.getAllByTestId('step-outcome')).toHaveLength(1)
    // **文字照旧**：这三档是"要你动手 / 它没做成"的安全语义，不能被一枚小图标顶掉
    expect(screen.getByText('跑命令')).toBeInTheDocument()
  })

  it('正常的一步：没有 data-outcome，也不挂状态灯', () => {
    const { container } = render(
      <TraceStepRow step={step({ detail: '跑完了，输出 3 行' })} open={false} onToggle={vi.fn()} />,
    )

    expect(container.querySelector('li')).not.toHaveAttribute('data-outcome')
    expect(screen.queryByTestId('step-outcome')).toBeNull()
  })

  it('老快照（没有 outcome，只有拦截措辞）：照旧默认展开，但**不挂状态灯**——句式分不出是哪一档', () => {
    const { container } = render(
      <TraceStepRow
        step={step({ detail: '没有执行（模式「只读」拦下）' })}
        open={false}
        onToggle={vi.fn()}
      />,
    )

    expect(screen.getByText('入参')).toBeInTheDocument()
    expect(container.querySelector('li')).not.toHaveAttribute('data-outcome')
    expect(screen.queryByTestId('step-outcome')).toBeNull()
  })

  it('结构化字段说"正常"（`""`）时，句式不许翻案：不默认展开，也不挂状态灯', () => {
    const { container } = render(
      <TraceStepRow
        step={step({ outcome: '', detail: '没有执行（模式拦下）' })}
        open={false}
        onToggle={vi.fn()}
      />,
    )

    expect(screen.queryByText('入参')).not.toBeInTheDocument()
    expect(container.querySelector('li')).not.toHaveAttribute('data-outcome')
  })

  it('状态灯压过转圈：同一格只放一枚（"不是成功"比"还在跑"重要）', () => {
    render(
      <TraceStepRow
        step={step({ outcome: 'failed', status: 'running', detail: '工具内部错误：服务连不上' })}
        open={false}
        onToggle={vi.fn()}
      />,
    )

    expect(screen.getByTestId('step-outcome')).toBeInTheDocument()
    expect(screen.queryByTestId('step-spinner')).toBeNull()
  })
})
