/**
 * 过程面板里"每一行长什么样"：**跑着 / 跑完**、**必须看得见**、**耗时**、
 * 以及面板自己那一行在流式期间写什么（四条一起钉）。
 *
 * 四条落在同一处是因为它们回答的其实是同一个问题——用户扫过面板时能不能看出
 * "它现在是什么状态"：
 *
 * 1. 后端一直在发 `status: running` / `done`（`services/tool_loop.py` 先发占位再发结果），
 *    而映射那一层原先把它丢了，于是"正在跑的那一步"与"已经跑完的那一步"长得一模一样；
 * 2. 不成功的步骤（被拦下 / 等确认 / **出错**）必须一眼看得见，判据只有一个
 *    `forceExpand`，单步那一行与组那一行都走它；
 * 3. 思考答完就自动折起，那一行上要留下"想了多久"——**只有当场看着它跑的那一轮
 *    才有这个数**（历史与补发都没有，宁可不显示）；
 * 4. 流式期间面板那一行只写一个**静态**名字：原来那条会滚的实时文案整条删了
 *    （它挂在助手列第一个节点上、与头像齐平），可点开这件事必须看得出来。
 *
 * 为什么不走整页渲染（`chat-ui.test.tsx` 那套）：这里只关心"一行怎么画"，
 * 把 `useChat` 换成一份最小的桩就够；但**数据层要走真的**
 * （`traceEntries` / `agentTraceSteps`）——否则"映射有没有把 `status`、`durationMs`
 * 带下来"这一半就测不到（D19 的教训：只测纯函数，把那一行删掉也不会红）。
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { ChatStep } from '@/api/chat'
import {
  isRunningStep,
  makeMessage,
  traceEntries,
  type ObservedStep,
  type Turn,
} from '@/features/chat/model/turns'
import { formatElapsed } from '@/features/chat/ui/TraceStepRow'
import { TracePanel } from '@/features/chat/ui/TracePanel'

/** 宿主那两张展开表；用例自己摆放（与 `chat-trace-fold.test.tsx` 同一手法）。 */
const openSteps = new Set<string>()
const openGroups = new Set<string>()

const stubs = {
  // 这一节只关心"一行怎么画"，面板一律给摊开那一档；面板自己的开合规则由
  // `chat-trace-fold` 与 `chat-model-turns` 两个文件盯
  traceOpen: () => 'full' as const,
  traceView: (_index: number, turn: Turn) => ({
    // 条目走真的数据层：分组、key、以及 `status` / `durationMs` 的映射都是这里要钉的
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
  return {
    phase: 'tool',
    label: '联网搜索',
    detail: '查 A',
    status: 'done',
    tool: 'web_search',
    kind: 'search',
    ...extra,
  }
}

function turnOf(steps: ChatStep[], extra: Parameters<typeof makeMessage>[2] = {}): Turn {
  return {
    user: makeMessage('user', '问'),
    reply: makeMessage('assistant', '答', { steps, ...extra }),
  }
}

/** 一次"当场看着跑完"的调用：起点与终点都有（`durationMs` 由 `liveTurn` 量出来）。 */
function timed(ms: number): ObservedStep {
  return { ...step(), thinking: '先查一下再回答。', durationMs: ms }
}

function reset(): void {
  openSteps.clear()
  openGroups.clear()
}

describe('每一步的真实状态：跑着和跑完不再长得一样', () => {
  it('running 的那一行带 data-running 与转圈；转圈尊重"减少动态效果"', () => {
    reset()
    render(<TracePanel turnIndex={0} turn={turnOf([step({ status: 'running' })])} />)

    const row = document.querySelector('li[data-running]')
    expect(row).not.toBeNull()
    const spinner = within(row as HTMLElement).getByTestId('step-spinner')
    // 动起来才是"还在跑"最直接的画面；系统说减少动态效果时停住，但**位置仍在**
    expect(spinner).toHaveClass('animate-spin')
    expect(spinner).toHaveClass('motion-reduce:animate-none')
  })

  it('跑完的那一行没有这一笔（两种状态必须看得出区别）', () => {
    reset()
    render(<TracePanel turnIndex={0} turn={turnOf([step()])} />)

    expect(document.querySelector('li[data-running]')).toBeNull()
    expect(screen.queryByTestId('step-spinner')).toBeNull()
  })

  it('组里有一次调用还在跑 → 组那一行也带 data-running 与转圈', () => {
    reset()
    render(
      <TracePanel
        turnIndex={0}
        turn={turnOf([step({ detail: '第一条' }), step({ detail: '第二条', status: 'running' })])}
      />,
    )

    // 两次同名调用并成一行（合并的是入口），那一行代表的是"这一组还在跑"
    const group = document.querySelector('li[data-running]')
    expect(group).not.toBeNull()
    expect(within(group as HTMLElement).getByText('2 次')).toBeInTheDocument()
    expect(within(group as HTMLElement).getByTestId('step-spinner')).toBeInTheDocument()
  })

  it('组展开后：还在跑的那一次自己带 data-running，另外几条不带', async () => {
    reset()
    render(
      <TracePanel
        turnIndex={0}
        turn={turnOf([step({ detail: '第一条' }), step({ detail: '第二条', status: 'running' })])}
      />,
    )

    await userEvent.setup().click(screen.getByRole('button', { name: /联网搜索/ }))

    const childRows = document.querySelectorAll('li[data-kind="search"] li')
    expect(childRows).toHaveLength(2)
    expect(childRows[0]).not.toHaveAttribute('data-running')
    expect(childRows[1]).toHaveAttribute('data-running')
  })

  it('纯判据：只有 running 算在跑', () => {
    expect(isRunningStep({ status: 'running' })).toBe(true)
    expect(isRunningStep({ status: 'done' })).toBe(false)
    // 老快照没有这一位：一律当"跑完了"画，不假装它还在跑
    expect(isRunningStep({})).toBe(false)
  })
})

describe('必须看得见：组那一行也走同一个 forceExpand', () => {
  it('组里有一次失败（outcome="failed"）→ 这一组默认就摊开，不必先点它', () => {
    reset()
    render(
      <TracePanel
        turnIndex={0}
        turn={turnOf([
          step({ detail: '第一条' }),
          step({ detail: '工具内部错误：服务连不上', outcome: 'failed' }),
        ])}
      />,
    )

    // 摊开的证据：组里那两次调用的结论直接看得见（折着的时候一条都没有）
    expect(screen.getByText('工具内部错误：服务连不上')).toBeInTheDocument()
    expect(screen.getByText('第一条')).toBeInTheDocument()
  })

  it('正常的组照旧折着（默认展开不能变成"一律展开"）', () => {
    reset()
    render(
      <TracePanel
        turnIndex={0}
        turn={turnOf([step({ detail: '第一条' }), step({ detail: '第二条' })])}
      />,
    )

    expect(screen.queryByText('第一条')).toBeNull()
    expect(screen.queryByText('第二条')).toBeNull()
  })
})

describe('§12.334：组那一行的状态灯与站点（两件事都要在**折叠态**就看得见）', () => {
  it('组行的 data-outcome 取组内第一条带状态位的那次调用', () => {
    reset()
    render(
      <TracePanel
        turnIndex={0}
        turn={turnOf([
          step({ detail: '第一条' }),
          step({ detail: '工具内部错误：服务连不上', outcome: 'failed' }),
          step({ detail: '等待确认', outcome: 'awaiting' }),
        ])}
      />,
    )

    // 组行（`data-kind` 与单步同源，取组内第一步的种类）
    const group = document.querySelector('li[data-kind="search"]')
    expect(group).toHaveAttribute('data-outcome', 'failed')
    expect(within(group as HTMLElement).getByTestId('step-outcome')).toHaveAttribute(
      'data-outcome',
      'failed',
    )
  })

  it('组里没有状态位 → 组行也不带 data-outcome（不猜）', () => {
    reset()
    render(
      <TracePanel
        turnIndex={0}
        turn={turnOf([step({ detail: '第一条' }), step({ detail: '第二条' })])}
      />,
    )

    expect(document.querySelector('li[data-kind="search"]')).not.toHaveAttribute('data-outcome')
    expect(screen.queryByTestId('step-outcome')).toBeNull()
  })

  it('联网并成一组时，**站点汇总在组行上**：不点开也看得出查了哪些站', () => {
    reset()
    render(
      <TracePanel
        turnIndex={0}
        turn={turnOf([
          step({
            detail: '第一条',
            args: '{"query":"a"}',
            result: 'https://github.com/anthropics/skills',
          }),
          step({ detail: '第二条', args: '{"query":"b"}', result: 'https://arxiv.org/abs/2401.1' }),
        ])}
      />,
    )

    // 默认折着：组内那两条结论都不在文档里
    expect(screen.queryByText('第一条')).toBeNull()
    // 而站点牌子在（这正是用户提这件事的目的：扫一眼看得出在查哪些常见的网页）
    const strip = screen.getByTestId('web-sites')
    expect(within(strip).getByText('GitHub')).toHaveAttribute('data-domain', 'github.com')
    expect(within(strip).getByText('arXiv')).toHaveAttribute('data-domain', 'arxiv.org')
  })

  it('展开之后子行**不重复**画站点（组行已经汇总过一遍）', async () => {
    reset()
    render(
      <TracePanel
        turnIndex={0}
        turn={turnOf([
          step({
            detail: '第一条',
            args: '{"query":"a"}',
            result: 'https://github.com/anthropics/skills',
          }),
          step({ detail: '第二条', args: '{"query":"b"}', result: 'https://arxiv.org/abs/2401.1' }),
        ])}
      />,
    )

    await userEvent.setup().click(screen.getByRole('button', { name: /联网搜索/ }))

    // 两条结论照旧逐条在（合的是入口，不是信息）
    expect(screen.getByText('第一条')).toBeInTheDocument()
    expect(screen.getByText('第二条')).toBeInTheDocument()
    // 但站点那一行只有组行上那一份
    expect(screen.getAllByTestId('web-sites')).toHaveLength(1)
  })
})

describe('思考那一行上的耗时', () => {
  it('当场看着跑完的那一轮：收起摘要有耗时，字数照旧', () => {
    reset()
    render(<TracePanel turnIndex={0} turn={turnOf([timed(3200)])} />)

    // 折起态的摘要那一行：耗时 + 字数
    expect(screen.getByTestId('step-elapsed')).toHaveTextContent('3.2s')
    expect(screen.getByText(/\d+ 字/)).toBeInTheDocument()
  })

  it('没有耗时（历史 / 刷新 / 补发）→ 一个字都不显示，不编数字', () => {
    reset()
    // 同一条步骤，只是没有 `durationMs`（读库读回来的形状就是这样）
    render(<TracePanel turnIndex={0} turn={turnOf([step({ thinking: '先查一下再回答。' })])} />)

    expect(screen.queryByTestId('step-elapsed')).toBeNull()
  })

  it('格式化三档：毫秒 / 秒（一位小数）/ 分秒', () => {
    expect(formatElapsed(123)).toBe('123ms')
    expect(formatElapsed(999)).toBe('999ms')
    expect(formatElapsed(3200)).toBe('3.2s')
    // 59.96 秒不许印成 `60.0s`（那一档该走分钟，而这里取的是**向下**的一位小数）
    expect(formatElapsed(59_960)).toBe('59.9s')
    expect(formatElapsed(65_000)).toBe('1m 5s')
  })
})

describe('面板那一行：执行期间只写一个静态名字', () => {
  it('流式期间写「执行过程」，那条会滚的实时文案一个字都不出现', () => {
    reset()
    // 正在跑一次「联网搜索」——那条老文案在这种情况下会写出「正在联网搜索…」
    render(
      <TracePanel
        turnIndex={0}
        turn={turnOf([step({ status: 'running' })], { streaming: true })}
      />,
    )

    const row = screen.getByTestId('trace-toggle')
    // 这一行是**唯一**能点开过程面板的地方：它必须看得出是什么，不能只剩一枚箭头
    expect(row).toHaveTextContent('执行过程')
    expect(row).not.toHaveTextContent('正在联网搜索…')
  })

  it('跑完之后不再写这个名字（收尾那一行只报出处摘要，没出处就只留箭头）', () => {
    reset()
    render(<TracePanel turnIndex={0} turn={turnOf([step()])} />)

    expect(screen.getByTestId('trace-toggle')).not.toHaveTextContent('执行过程')
  })
})
