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
  type TraceOpen,
  type Turn,
} from '@/features/chat/model/turns'
import { formatElapsed } from '@/features/chat/ui/TraceStepRow'
import { TracePanel } from '@/features/chat/ui/TracePanel'

/**
 * 宿主那两张展开表；用例自己摆放（与 `chat-trace-fold.test.tsx` 同一手法）。
 * `openGroups` 与真宿主同一档：记的是**"用户选过什么"**（两档都记），
 * 不是"翻转型 Set"——"他收起来"必须记得住（P0 收尾批）。
 */
const openSteps = new Set<string>()
const openGroups = new Map<string, boolean>()

const stubs = {
  // 这一节只关心"一行怎么画"，面板默认给摊开那一档；面板自己的开合规则由
  // `chat-trace-fold` 与 `chat-model-turns` 两个文件盯。
  // 写成 TraceOpen 而不是字面量 'full'：有几条用例要临时改成收起那一档
  // （面板折叠容器的 0fr/1fr 与 a11y 都要两种状态各看一眼）。
  traceOpen: (): TraceOpen => 'full',
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
  groupOpenChoice: (key: string) => openGroups.get(key),
  chooseGroupOpen: (key: string, open: boolean) => {
    openGroups.set(key, open)
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

  it('组里有一次调用还在跑 → 组那一行带 data-running 与转圈，标题写"在做什么 + 进度"', () => {
    reset()
    render(
      <TracePanel
        turnIndex={0}
        turn={turnOf([step({ detail: '第一条' }), step({ detail: '第二条', status: 'running' })])}
      />,
    )

    // 两次同名调用并成一行（合并的是入口）——整块面板里只有一个"组头"按钮。
    // 这正是原先按「2 次」钉住的那件事，现在的措辞是"正在…… 1/2"。
    expect(document.querySelectorAll('button[aria-controls^="trace-group-"]')).toHaveLength(1)
    const group = document.querySelector('li[data-running]')
    expect(group).not.toBeNull()
    expect(group).toHaveTextContent('正在联网搜索 第二条… 1/2')
    expect(within(group as HTMLElement).getByTestId('step-spinner')).toBeInTheDocument()
  })

  it('跑着的组**默认就展开**（组在进行过程中展开）；点一下收起，之后就听用户的', async () => {
    reset()
    const turn = turnOf([step({ detail: '第一条' }), step({ detail: '第二条', status: 'running' })])
    const { rerender } = render(<TracePanel turnIndex={0} turn={turn} />)

    const group = document.querySelector('li[data-running]') as HTMLElement
    // §12.333：组里还有 running 的步骤 → 这一组展开，组内两次调用直接看得见
    const childRows = group.querySelectorAll('li[data-kind="search"] li')
    expect(childRows).toHaveLength(2)
    expect(childRows[0]).not.toHaveAttribute('data-running')
    expect(childRows[1]).toHaveAttribute('data-running')

    // 用户点一下：**完全听他的**（"他收起过，就别自动开"）——即使这一步还在跑
    await userEvent.setup().click(within(group).getByRole('button', { name: /正在联网搜索/ }))
    /*
      桩里那张表不是响应式的（模块级 Map），真宿主那一下是 `setState`（整页用例
      `chat-ui` 盯的就是真宿主那一半）。这里重画一次，让桩的表反映到画面上。
    */
    rerender(<TracePanel turnIndex={0} turn={turn} />)

    expect(document.querySelectorAll('li[data-kind="search"] li')).toHaveLength(0)
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

/*
 * §12.333 的两层尺度是**故意不对称**的，这一节是让那件事安全的那根钉。
 *
 * 组与面板折起来会**一次藏掉整块**（组头一收，组内所有行连同状态一起没了），
 * 所以那两层拒绝收起；**单步**折起来的只有**原文（入参 / 返回）**——标签、结论与
 * 图标圆底上的那枚状态灯都还在。也就是说"这一步没做成 / 在等你确认"这个**事实**
 * 并没有被藏起来，用户折掉的是**原因**（它到底为什么没做成）。
 */
describe('单步级：折起来的一行仍然看得见状态灯（不对称是有道理的）', () => {
  it('outcome="failed" 的一步被用户折起来之后，data-outcome 与状态灯仍在文档里', async () => {
    reset()
    render(
      <TracePanel
        turnIndex={0}
        turn={turnOf([
          step({ detail: '工具内部错误：服务连不上', outcome: 'failed', args: '{"cmd":"ls"}' }),
        ])}
      />,
    )

    // 单步那一行默认展开（`forceExpand`）：先点一下折起来
    await userEvent.setup().click(screen.getByRole('button', { name: /联网搜索/ }))

    // 折起来 = 原文不在文档里（折的是**原因**那一层）
    expect(screen.queryByText('入参')).toBeNull()

    // 但"这一步没做成"这个**事实**没被藏起来：行上的 `data-outcome` 与那枚状态灯都还在
    const row = document.querySelector('li[data-outcome="failed"]') as HTMLElement
    expect(row).not.toBeNull()
    expect(within(row).getByTestId('step-outcome')).toHaveAttribute('data-outcome', 'failed')
    // 结论那一行也照旧在（它不是原文那一段）
    expect(screen.getByText('工具内部错误：服务连不上')).toBeInTheDocument()
  })
})

/*
 * §12.333：组级也按面板级那一条规则——**进行中展开、内容跑完折叠**，
 * 三条约束照旧（用户干预优先 / awaiting 与 failed 强制展开并拒绝收起 / 回答与出处不在折叠里）。
 *
 * 判据不是这里新写的：这一节钉的是**接线**（组件有没有按 `turns` 里那一份判据画），
 * 纯判据本身（`isBlockRunning` / `groupHeading`）由 `chat-model-turns` 那一节盯。
 */
describe('组级开合：进行中展开、内容跑完折叠（§12.333）', () => {
  /** 跑完的两次同名调用：一个正常的组。 */
  const doneGroup = () => turnOf([step({ detail: '第一条' }), step({ detail: '第二条' })])

  it('内容跑完 → 这一组默认折叠（与面板级同一条规则的另一半）', () => {
    reset()
    render(<TracePanel turnIndex={0} turn={doneGroup()} />)

    expect(screen.getByRole('button', { name: /联网搜索/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(screen.queryByText('第一条')).toBeNull()
  })

  it('用户点开跑完的组 → 听他的（宿主记的是"他选过什么"，跨挂载认得）', async () => {
    reset()
    const turn = doneGroup()
    const { rerender } = render(<TracePanel turnIndex={0} turn={turn} />)

    await userEvent.setup().click(screen.getByRole('button', { name: /联网搜索/ }))
    // 桩的表不是响应式的（真宿主那一下是 `setState`，整页用例盯那一半）
    rerender(<TracePanel turnIndex={0} turn={turn} />)

    expect(screen.getByText('第一条')).toBeInTheDocument()
    expect(openGroups.get('t0:group:tool-0:web_search')).toBe(true)
  })

  it('他收起一个"还在跑"的组 → **换挂载之后仍然是收起的**（他选的那一档记在宿主上）', async () => {
    reset()
    const turn = turnOf([step({ detail: '第一条' }), step({ detail: '第二条', status: 'running' })])
    /** 换挂载：根上换 key，整棵卸载重挂——"用户选过什么"必须活在组件之外。 */
    const panel = (mount: number) => (
      <div key={mount}>
        <TracePanel turnIndex={0} turn={turn} />
      </div>
    )

    const { rerender } = render(panel(0))

    // 跑着 → 默认展开；点一下 = 他选"收"
    await userEvent.setup().click(screen.getByRole('button', { name: /正在联网搜索/ }))
    // 桩的表不是响应式的：重画一次让"他选的那一档"反映到画面上（真宿主是 `setState`）
    rerender(panel(0))
    expect(screen.queryByText('第一条')).toBeNull()
    expect(openGroups.get('t0:group:tool-0:web_search')).toBe(false)

    // 换挂载（收起面板再打开 / 换会话再回来那条路）：**仍然按他选的"收"画**——
    // 默认档（还在跑就展开）不许把他那一下盖掉
    rerender(panel(1))
    expect(screen.getByRole('button', { name: /正在联网搜索/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(screen.queryByText('第一条')).toBeNull()

    // 他再点开 → 也记下来，换挂载之后同样算数
    await userEvent.setup().click(screen.getByRole('button', { name: /正在联网搜索/ }))
    rerender(panel(2))
    expect(screen.getByText('第一条')).toBeInTheDocument()
  })

  it('组里有 failed → 强制展开，而且点它**收不起来**（安全语义压过用户这一下点击）', async () => {
    reset()
    // 他早先自己开过这一组（宿主表里有记录）：进入 forced 之后那一下点击**不许把它抹掉**——
    // 否则"拒绝收起"只是当场看着像，等这一步不再 forced 时它会突然自己折起来
    openGroups.set('t0:group:tool-0:web_search', true)
    render(
      <TracePanel
        turnIndex={0}
        turn={turnOf([
          step({ detail: '第一条' }),
          step({ detail: '工具内部错误：服务连不上', outcome: 'failed' }),
        ])}
      />,
    )

    const head = screen.getByRole('button', { name: /联网搜索/ })
    expect(head).toHaveAttribute('aria-expanded', 'true')

    await userEvent.setup().click(head)

    // 拒绝收起：还是摊着；他早先那条记录也一个字没动
    expect(head).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('第一条')).toBeInTheDocument()
    expect(openGroups.get('t0:group:tool-0:web_search')).toBe(true)
  })
})

/*
 * 折叠树的 a11y（§12.333 的收尾项）。
 *
 * 三个开关（面板头、组头、单步原文）里前两个原先只有 `aria-expanded`：
 * 读屏器不知道"展开的那一摊归谁管"，而这一页里同一时刻可能有好几轮、好几组。
 * 所以补上 `aria-controls` + 容器上的 id / 角色 / 名字；图标一律 `aria-hidden`
 * （名字由外面那个交互元素给，这是本仓口径）。
 */
describe('折叠树的 a11y：aria-expanded / aria-controls / role（§12.333）', () => {
  it('面板头：aria-controls 指向面板容器，容器有 id、名字与角色', () => {
    reset()
    render(<TracePanel turnIndex={3} turn={turnOf([step()])} />)

    const toggle = screen.getByTestId('trace-toggle')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const id = toggle.getAttribute('aria-controls')
    expect(id).toBe('trace-panel-3')

    const body = document.getElementById(id as string) as HTMLElement
    expect(body).not.toBeNull()
    expect(body).toHaveAttribute('role', 'group')
    // 容器的名字就是这一行写着的那句（收起态也有名字，不再是个没名字的按钮）
    expect(body).toHaveAttribute('aria-label', '执行过程')
    expect(toggle).toHaveTextContent('执行过程')
  })

  it('组头：aria-controls 指向组的容器；**折叠时容器也在文档里**（id 不许悬空）', () => {
    reset()
    render(
      <TracePanel
        turnIndex={0}
        turn={turnOf([step({ detail: '第一条' }), step({ detail: '第二条' })])}
      />,
    )

    const head = screen.getByRole('button', { name: /联网搜索/ })
    expect(head).toHaveAttribute('aria-expanded', 'false')

    const body = document.getElementById(
      head.getAttribute('aria-controls') as string,
    ) as HTMLElement
    expect(body).not.toBeNull()
    expect(body).toHaveAttribute('role', 'group')
    // 名字跟着组行标题走（同一条句子，不另写一份）
    expect(body).toHaveAttribute('aria-label', '联网搜索 2 个关键词 · 第一条、第二条')
    // 收起时内容不在文档里（条件渲染），但容器在
    expect(body.textContent).toBe('')
  })

  it('图标都是 aria-hidden：名字由外面那个交互元素给', () => {
    reset()
    render(
      <TracePanel
        turnIndex={0}
        turn={turnOf([step({ detail: '第一条' }), step({ detail: '第二条' })])}
      />,
    )

    for (const element of [
      screen.getByTestId('trace-toggle'),
      screen.getByRole('button', { name: /联网搜索/ }),
    ]) {
      expect(element.querySelectorAll('svg:not([aria-hidden="true"])')).toHaveLength(0)
    }
  })
})

/*
 * 面板级的**高度过渡**（§12.333：动效只加这一级，单步级照旧条件渲染）。
 *
 * 收起仍然是条件渲染——这是刻意的（这一块装着步骤、思考全文与出处预览，
 * 几十轮时 DOM 开销一直在，见 `TracePanel` 头注）。所以这里的读法是：
 * 容器一直在、行高在 0fr/1fr 之间；**展开有过渡，收起是直落**。
 * jsdom 不跑 CSS 动画，这一节钉的是"接线"（类名与行高到底挂没挂上），
 * 真实浏览器里的观感要肉眼看（`.shots`）。
 */
describe('面板折叠容器：展开有高度过渡、收起直落（§12.333）', () => {
  it('容器一直在文档里：行高 0fr ↔ 1fr、200ms、减少动态效果时直落', () => {
    reset()
    const { rerender } = render(<TracePanel turnIndex={0} turn={turnOf([step()])} />)

    const open = document.getElementById('trace-panel-0') as HTMLElement
    expect(open.className).toContain('grid')
    expect(open.className).toContain('transition-[grid-template-rows]')
    expect(open.className).toContain('duration-200')
    expect(open.className).toContain('ease-[cubic-bezier(0.4,0,0.2,1)]')
    // 过渡写在类里（不是 style），这一条才压得住它
    expect(open.className).toContain('motion-reduce:transition-none')
    expect(open.style.gridTemplateRows).toBe('1fr')

    stubs.traceOpen = () => 'collapsed'
    try {
      rerender(<TracePanel turnIndex={0} turn={turnOf([step()])} />)

      const collapsed = document.getElementById('trace-panel-0') as HTMLElement
      expect(collapsed.style.gridTemplateRows).toBe('0fr')
      // 收起时**内容仍然不在文档里**：动画没有把条件渲染这个取舍吃掉
      expect(screen.queryByText('联网搜索')).toBeNull()
    } finally {
      stubs.traceOpen = () => 'full'
    }
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
    const turn = turnOf([
      step({
        detail: '第一条',
        args: '{"query":"a"}',
        result: 'https://github.com/anthropics/skills',
      }),
      step({ detail: '第二条', args: '{"query":"b"}', result: 'https://arxiv.org/abs/2401.1' }),
    ])
    const { rerender } = render(<TracePanel turnIndex={0} turn={turn} />)

    await userEvent.setup().click(screen.getByRole('button', { name: /联网搜索/ }))
    // 桩的表不是响应式的（真宿主那一下是 `setState`）
    rerender(<TracePanel turnIndex={0} turn={turn} />)

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

describe('面板那一行：跑着写短名，**跑完没出处也写短名**', () => {
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

  it('跑完又**没有出处**：这一行写固定短名「执行过程」（不再只剩一枚箭头）', () => {
    reset()
    render(<TracePanel turnIndex={0} turn={turnOf([step()])} />)

    const row = screen.getByTestId('trace-toggle')
    // 这一行是唯一能点开过程面板的地方：没有出处时它也得说得出自己叫什么
    expect(row).toHaveTextContent('执行过程')
    // 但**当年那条动态摘要一个字都不许回来**：它是替这一轮编一段经过
    //（"本轮没有命中资料 / 直接作答"），用户原话是"没啥用"；这里补的是**名字**，
    // 不声称任何发生过的事（见 `TracePanel` 里 `TRACE_PANEL_NAME` 的说明）。
    expect(row).not.toHaveTextContent('本轮没有命中资料')
    expect(row).not.toHaveTextContent('直接作答')
  })

  it('有出处时照旧报出处摘要（短名只在"没话说"的时候顶上来）', () => {
    reset()
    render(
      <TracePanel
        turnIndex={0}
        turn={turnOf([step()], {
          sources: [
            {
              index: 1,
              chunk_id: 'c1',
              document_id: 'd1',
              document_name: '报告.pdf',
              heading_path: null,
              page: null,
              score: 0.5,
              preview: '原文',
              knowledge_base_id: 'kb1',
            },
          ],
        })}
      />,
    )

    const row = screen.getByTestId('trace-toggle')
    expect(row).toHaveTextContent('检索完成')
    expect(row).not.toHaveTextContent('执行过程')
  })
})
