/**
 * 过程面板里的**思考渲染**（v0.54）。
 *
 * 用户报的问题（原话）："conv_7fa1c406623c……他是把所有思考的内容全部放在一起了。很难看，
 * 我觉得思考就应该对应到他调用得工具里面去。第三个。输出最终结果完毕后。把思考折叠起来。
 * 就显示工具调用信信息就行了。当然用户也可以展开查看。"
 *
 * 三条要求，逐条钉住：
 * 1. 每一步的推理**在它自己那一行里**（不是末尾一整块）；
 * 2. 答完之后**默认折起**（只留工具调用信息）；
 * 3. **可以展开**（用户点一下就看得见）——这是"折起"不变成"看不见"的保证。
 *
 * 为什么不走整页渲染（`chat-ui.test.tsx` 那套）：这一条只关心"一步的思考怎么画"，
 * 直接把 `useChat` 换成一份最小的桩就够，跑得也快——整页那套要拉起整个对话运行时。
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { ChatStep } from '@/api/chat'
import { makeMessage, type Turn } from '@/features/chat/model/turns'
import { TracePanel } from '@/features/chat/ui/TracePanel'

/** `TracePanel` 只从上下文读这几件事；给一份最小的桩就够了。 */
const stubs = {
  // 这一节只关心"一步的思考怎么画"，所以面板一律给摊开那一档（P0 起档位是
  // `'collapsed' | 'full'`，不再是布尔）；面板自己的开合规则由 `chat-model-turns`
  // 与 `chat-trace-fold` 两个文件盯。
  traceOpen: () => 'full' as const,
  traceView: (_index: number, turn: Turn) => ({
    entries: (turn.reply?.steps ?? []).map((step, index) => ({
      kind: 'step' as const,
      key: `${step.phase}-${index}`,
      step: {
        key: `${step.phase}-${index}`,
        icon: 'search' as const,
        label: step.label,
        detail: step.detail,
        args: step.args,
        result: step.result,
        thinking: step.thinking,
      },
    })),
    shown: 1,
    total: 1,
    hidden: 0,
  }),
  toggleTrace: vi.fn(),
  isStepOpen: () => false,
  toggleStep: vi.fn(),
  groupOpenChoice: () => undefined,
  chooseGroupOpen: vi.fn(),
  citesExpanded: () => false,
  toggleCites: vi.fn(),
  showMoreTrace: vi.fn(),
  flashCite: '',
  openSource: vi.fn(),
  contextUsage: { data: undefined },
  turns: [{ user: null, reply: null }],
}

vi.mock('@/features/chat/runtime/ChatProvider', () => ({
  useChat: () => stubs,
}))

function step(extra: Partial<ChatStep> = {}): ChatStep {
  return { phase: 'tool', label: '联网搜索', detail: '共 8 条', status: 'done', ...extra }
}

function turnOf(steps: ChatStep[], extra: Parameters<typeof makeMessage>[2] = {}): Turn {
  return {
    user: makeMessage('user', '问'),
    reply: makeMessage('assistant', '答', { steps, ...extra }),
  }
}

describe('过程面板：思考落在它调用的那个工具上（v0.54）', () => {
  it('每一步的推理画在那一行里，而且答完之后默认是折起的', async () => {
    render(<TracePanel turnIndex={0} turn={turnOf([step({ thinking: '先搜官方发布页。' })])} />)

    // 折叠态：正文不在文档里（用的是条件渲染，不是 CSS 藏起来）
    expect(screen.queryByTestId('step-thinking')).not.toBeInTheDocument()
    // 但那一行仍然在，写着这一步是什么（用户要的"就显示工具调用信息"）
    expect(screen.getByText('联网搜索')).toBeInTheDocument()
    // 折起不等于看不见：入口在，点一下就出来
    const toggle = screen.getByRole('button', { name: '这一步的思考' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(toggle)
    expect(screen.getByTestId('step-thinking')).toHaveTextContent('先搜官方发布页。')
  })

  it('正在生成时它还开着（用户在等，看着它想什么）；答完自动收起', () => {
    const { rerender } = render(
      <TracePanel
        turnIndex={0}
        turn={turnOf([step({ thinking: '边想边说。' })], { streaming: true })}
      />,
    )
    expect(screen.getByTestId('step-thinking')).toBeInTheDocument()
    expect(screen.getByTestId('step-thinking-fold')).toHaveAttribute('data-fold', 'open')

    rerender(<TracePanel turnIndex={0} turn={turnOf([step({ thinking: '边想边说。' })])} />)
    /*
      §12.335 起"答完自动收起"读的是**那一块的行高**：内容为双向动效常驻
      （展开过一次之后不卸载，见 `Fold`），所以不再用"不在文档里"来读收起。
      "从没展开过就不挂内容"那一条另有用例（下面那条 + `chat-trace-step-row`）。
    */
    expect(screen.getByTestId('step-thinking-fold')).toHaveAttribute('data-fold', 'closed')
    expect(screen.getByTestId('step-thinking-fold').style.gridTemplateRows).toBe('0fr')
  })

  it('**从没展开过**的思考：那一块只有空容器，正文根本不挂（DOM 开销那一条不变）', () => {
    render(<TracePanel turnIndex={0} turn={turnOf([step({ thinking: '先搜官方发布页。' })])} />)

    const fold = screen.getByTestId('step-thinking-fold')
    expect(fold).toHaveAttribute('data-fold', 'closed')
    expect(fold.textContent).toBe('')
    expect(screen.queryByTestId('step-thinking')).not.toBeInTheDocument()
  })

  it('这一步没有推理就不摆那个入口（空按钮点了什么都不变）', () => {
    render(<TracePanel turnIndex={0} turn={turnOf([step()])} />)

    expect(screen.queryByRole('button', { name: '这一步的思考' })).not.toBeInTheDocument()
  })

  it('新消息不在末尾再铺一遍整串思考（同一批文字说两遍）', () => {
    render(
      <TracePanel
        turnIndex={0}
        turn={turnOf([step({ thinking: '这一步的理由。' })], { thinkingText: '这一步的理由。' })}
      />,
    )

    expect(screen.queryByTestId('thinking-block')).not.toBeInTheDocument()
  })

  it('老消息的整串思考默认折起、也能展开（那条会话正是这种）', async () => {
    render(
      <TracePanel
        turnIndex={0}
        turn={turnOf([step()], { thinkingText: '很长很长的一整串思考，横跨二十一次工具调用。' })}
      />,
    )

    expect(screen.queryByTestId('thinking-block')).not.toBeInTheDocument()
    const toggle = screen.getByRole('button', { name: /思考过程/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(toggle)
    expect(screen.getByTestId('thinking-block')).toHaveTextContent('很长很长的一整串思考')
  })
})
