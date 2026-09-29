/**
 * 过程面板的**折叠档**（P0①：过程默认收起、答案常显）与**单步 / 分组 key 的轮次命名空间**
 * （P0②：单步开合跨轮次串号）。
 *
 * 为什么不走整页渲染（`chat-ui.test.tsx` 那套）：这两条只关心"面板那一块怎么画、
 * 点的是哪一轮的哪一行"，把 `useChat` 换成一份最小的桩就够（同
 * `chat-trace-thinking.test.tsx` 的手法）。
 *
 * 桩里的 `traceOpen` 调的是**真的** `isTraceOpen`——这样钉住的是"面板会不会按判定
 * 结果画"，而不只是纯函数的返回值（D19 的教训：只测纯函数，把那一行删掉也不会红）。
 * 真宿主那一侧的接线（`ChatProvider` 的 `chosen` / 记忆 / 拒绝收起）由
 * `chat-ui.test.tsx` 里那两条整页用例盯。
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { ChatStep } from '@/api/chat'
import {
  isTraceOpen,
  makeMessage,
  traceEntries,
  type Message,
  type TraceOpen,
  type Turn,
} from '@/features/chat/model/turns'
import { TracePanel } from '@/features/chat/ui/TracePanel'

/**
 * 宿主那两张展开表（`ChatProvider` 的 `openSteps` / `openGroups`）。
 * 面板点出来的 key **原样**存进来——"跨轮串号"就是在这张表上露出来的：
 * 两轮的 key 一样，表里就只有一条记录，于是两块一起开。
 */
const openSteps = new Set<string>()
const openGroups = new Set<string>()

/** 判定要用的两件事实：这一轮点过的档位、他手动开过没有（真实实现里分别来自
 *  `traceOpenIds` 与本机记忆）。测试按需摆放，每个用例开头归零。 */
let chosen: TraceOpen | undefined
let userOpened = false

const stubs = {
  // 用真判定：桩只提供事实，规则不许在这里重写一遍
  traceOpen: (message: Message) => isTraceOpen(message, { chosen, userOpened }),
  traceView: (_index: number, turn: Turn) => ({
    // 条目也用真的（分组、key 全是数据层给的），桩不自己造一份
    entries: traceEntries(turn),
    shown: 1,
    total: 1,
    hidden: 0,
  }),
  toggleTrace: vi.fn(),
  isStepOpen: (key: string) => openSteps.has(key),
  toggleStep: (key: string) => {
    if (openSteps.has(key)) openSteps.delete(key)
    else openSteps.add(key)
  },
  isGroupOpen: (key: string) => openGroups.has(key),
  toggleGroup: (key: string) => {
    if (openGroups.has(key)) openGroups.delete(key)
    else openGroups.add(key)
  },
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
  return { phase: 'tool', label: '联网搜索', detail: '查 A', status: 'done', ...extra }
}

function turnOf(steps: ChatStep[], extra: Parameters<typeof makeMessage>[2] = {}): Turn {
  return {
    user: makeMessage('user', '问'),
    reply: makeMessage('assistant', '答', { steps, ...extra }),
  }
}

/** 归零：两张表与两件事实都不许在用例之间互相带。 */
function reset(): void {
  openSteps.clear()
  openGroups.clear()
  chosen = undefined
  userOpened = false
}

describe('面板的默认档（P0①，照 LobeHub WorkflowCollapse）', () => {
  it('流式中摊开、这一轮完成之后收起（同一个界面里两档同时看得见）', () => {
    reset()
    render(
      <>
        <div data-testid="live">
          <TracePanel turnIndex={0} turn={turnOf([step()], { streaming: true })} />
        </div>
        <div data-testid="done">
          <TracePanel turnIndex={1} turn={turnOf([step({ detail: '查完了' })])} />
        </div>
      </>,
    )

    // 流式中：步骤行在文档里（它就是进度条）
    expect(within(screen.getByTestId('live')).getByText('联网搜索')).toBeInTheDocument()
    // 答完：折叠用的是条件渲染，步骤行**不在文档里**（不是被 CSS 藏起来）
    expect(within(screen.getByTestId('done')).queryByText('联网搜索')).toBeNull()
    // 但入口一直在：收起时只剩摘要那一行，点一下就能摊开
    expect(within(screen.getByTestId('done')).getByTestId('trace-toggle')).toHaveAttribute(
      'aria-expanded',
      'false',
    )
  })

  it('用户对这一轮点过就听他的（`chosen` 压过默认档，规则 b 的轮内那一半）', () => {
    reset()
    chosen = 'full'
    render(<TracePanel turnIndex={0} turn={turnOf([step()])} />)

    expect(screen.getByText('联网搜索')).toBeInTheDocument()
  })

  it('规则 c：有待确认的步骤时强制摊开，连用户点过的"收起"也压过去', () => {
    reset()
    chosen = 'collapsed'
    render(
      <TracePanel
        turnIndex={0}
        turn={turnOf([step({ outcome: 'awaiting', label: '执行命令', detail: '等待确认' })])}
      />,
    )

    expect(screen.getByTestId('trace-toggle')).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('执行命令')).toBeInTheDocument()
  })
})

describe('单步 / 分组的开合 key 带轮次（P0②，修跨轮串号）', () => {
  /**
   * 两块面板 + 一张共用展开表的现场。
   *
   * `chosen = 'full'` 让两块都摊开，好让"某一行"本身可点；两轮的步骤形状**完全相同**
   * （这正是真实数据的样子：每轮的第一步都叫 `tool-0`）。
   *
   * `n` 是根元素的 key：点完之后**换 key 重挂载**再画一次。宿主那张表是普通 Set、
   * 不是响应式的，光 `rerender` 同一棵树会被 React 当成"没变"跳过——换 key 之后
   * 两块都按表里的现值重画，"跨轮串号"（另一块也被带着开）这才看得见。
   */
  function twoTurns(steps: ChatStep[], n = 0) {
    return (
      <div key={n}>
        <div data-testid="turn-0">
          <TracePanel turnIndex={0} turn={turnOf(steps)} />
        </div>
        <div data-testid="turn-1">
          <TracePanel turnIndex={1} turn={turnOf(steps)} />
        </div>
      </div>
    )
  }

  it('两轮里的"第 1 步"是两个 key：展开第 1 轮那一步，第 2 轮的不跟着开', async () => {
    reset()
    chosen = 'full'
    const steps = [step({ args: '{"q":"甲"}' })]
    const { rerender } = render(twoTurns(steps))

    await userEvent
      .setup()
      .click(within(screen.getByTestId('turn-0')).getByRole('button', { name: /联网搜索/ }))
    rerender(twoTurns(steps, 1))

    expect(openSteps.size).toBe(1)
    expect(within(screen.getByTestId('turn-0')).getByText('入参')).toBeInTheDocument()
    expect(within(screen.getByTestId('turn-1')).queryByText('入参')).toBeNull()
  })

  it('分组那一行同样带轮次：展开第 1 轮的组，第 2 轮的组不跟着开', async () => {
    reset()
    chosen = 'full'
    // 同名两次才会并成一组；组内两次的结论各不相同，好分辨那一组有没有被展开
    const steps = [step({ detail: '第一轮 A' }), step({ detail: '第一轮 B' })]
    const { rerender } = render(twoTurns(steps))

    // 未展开时组内那两条都不在文档里（合并的是入口，不是信息）
    expect(within(screen.getByTestId('turn-1')).queryByText('第一轮 B')).toBeNull()

    await userEvent
      .setup()
      .click(within(screen.getByTestId('turn-0')).getByRole('button', { name: /联网搜索/ }))
    rerender(twoTurns(steps, 1))

    expect(openGroups.size).toBe(1)
    expect(within(screen.getByTestId('turn-0')).getByText('第一轮 B')).toBeInTheDocument()
    expect(within(screen.getByTestId('turn-1')).queryByText('第一轮 B')).toBeNull()
  })
})
