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
import { STEP_LABEL, STEP_TOGGLE } from '@/features/chat/ui/traceStyles'

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
  // 行那一层走的是稳定的那一份（D32 拆分）：同一个桩，字段是超集
  useChatRows: () => stubs,
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

/**
 * 组容器：`aria-controls` 指着它。
 *
 * §12.335 起"收起"**不再等于"内容不在文档里"**（内容为双向动效常驻，见 `Fold`），
 * 所以收起读的是容器上的镜像：`data-fold="closed"` + 行高 `0fr`。
 * "从没展开过就不挂内容"那一条由组容器为空 + `chat-trace-fold` 里那条用例钉。
 */
function groupBody(): HTMLElement {
  const head = document.querySelector('button[aria-controls^="trace-group-"]') as HTMLElement
  return document.getElementById(head.getAttribute('aria-controls') as string) as HTMLElement
}

describe('每一步的真实状态：跑着和跑完不再长得一样', () => {
  it('running 的那一行带 data-running 与那句静态「进行中」；旧的花圈图标不再出现', () => {
    reset()
    // **必须是一轮还在流式**：一轮结束之后就没有"还在跑"这回事了（见下面两条 bug 用例）
    render(
      <TracePanel
        turnIndex={0}
        turn={turnOf([step({ status: 'running' })], { streaming: true })}
      />,
    )

    const row = document.querySelector('li[data-running]')
    expect(row).not.toBeNull()
    // 状态一位都没丢：机器属性 + 一句看得见的文字
    expect(row).toHaveTextContent('进行中')
    // 2026-09-29 用户："那个蓝色循环圈没有用" → 那枚图标整枚删掉
    expect(screen.queryByTestId('step-spinner')).toBeNull()
  })

  it('跑完的那一行没有这一笔（两种状态必须看得出区别）', () => {
    reset()
    render(<TracePanel turnIndex={0} turn={turnOf([step()])} />)

    expect(document.querySelector('li[data-running]')).toBeNull()
    expect(screen.queryByTestId('step-spinner')).toBeNull()
    expect(screen.queryByText('进行中')).toBeNull()
  })

  it('**一轮已经结束**：残留的 running 不再写「进行中」（用户报的那个 bug）', () => {
    reset()
    // 真机原始事实：库里那条消息 `phase:"answer"` 那一步的 status 就是 "running"，
    // 而正文早已完整（后端从不为这一步发 done）——不能再把它当"还在跑"画出来
    render(<TracePanel turnIndex={0} turn={turnOf([step({ status: 'running' })])} />)

    expect(document.querySelector('li[data-running]')).toBeNull()
    expect(screen.queryByText('进行中')).toBeNull()
  })

  it('**后面还有别的步骤**：前面那一步不可能还在跑（步骤是顺序执行的）', () => {
    reset()
    render(
      <TracePanel
        turnIndex={0}
        turn={turnOf(
          [
            step({ status: 'running', detail: '第一条' }),
            step({ detail: '第二条', status: 'done' }),
          ],
          { streaming: true },
        )}
      />,
    )

    // 这一轮还在流式，但最后一步是"第二条"——第一条早跑完了
    const rows = [...document.querySelectorAll('li[data-kind]')]
    expect(rows.some((row) => row.hasAttribute('data-running'))).toBe(false)
    expect(screen.queryByText('进行中')).toBeNull()
  })

  it('组里有一次调用还在跑 → 组那一行带 data-running 与「进行中」，标题写"在做什么 + 进度"', () => {
    reset()
    render(
      <TracePanel
        turnIndex={0}
        turn={turnOf([step({ detail: '第一条' }), step({ detail: '第二条', status: 'running' })], {
          streaming: true,
        })}
      />,
    )

    // 两次同名调用并成一行（合并的是入口）——整块面板里只有一个"组头"按钮。
    // 这正是原先按「2 次」钉住的那件事，现在的措辞是"正在…… 1/2"。
    expect(document.querySelectorAll('button[aria-controls^="trace-group-"]')).toHaveLength(1)
    const group = document.querySelector('li[data-running]')
    expect(group).not.toBeNull()
    expect(group).toHaveTextContent('正在联网搜索 第二条… 1/2')
    expect(within(group as HTMLElement).getByText('进行中')).toBeInTheDocument()
    expect(within(group as HTMLElement).queryByTestId('step-spinner')).toBeNull()
  })

  it('跑着的组**默认就展开**（组在进行过程中展开）；点一下收起，之后就听用户的', async () => {
    reset()
    // 还在跑 = 这一轮还在流式（一轮结束之后残留的 running 会被收掉，见那两条 bug 用例）
    const turn = turnOf(
      [step({ detail: '第一条' }), step({ detail: '第二条', status: 'running' })],
      { streaming: true },
    )
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

    // §12.335：收起读的是行高与 `data-fold`（内容为双向动效常驻，不再卸载）
    expect(groupBody()).toHaveAttribute('data-fold', 'closed')
    expect(groupBody().style.gridTemplateRows).toBe('0fr')
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

    /*
      折起来 = **那一块的原文折成 0fr**（§12.335：内容为双向动效常驻，所以不再用
      "不在文档里"来读收起；`Fold` 的 `data-fold` 就是这个读数）。
      折的是**原因**那一层：原文（入参 / 返回）收起来了。
    */
    expect(screen.getByTestId('step-raw')).toHaveAttribute('data-fold', 'closed')
    expect(screen.getByTestId('step-raw').style.gridTemplateRows).toBe('0fr')

    // 但"这一步没做成"这个**事实**没被藏起来：行上的 `data-outcome` 与那枚状态灯都还在
    const row = document.querySelector('li[data-outcome="failed"]') as HTMLElement
    expect(row).not.toBeNull()
    expect(within(row).getByTestId('step-outcome')).toHaveAttribute('data-outcome', 'failed')
    // 结论那一行也照旧在（它不是原文那一段）
    expect(screen.getByText('工具内部错误：服务连不上')).toBeInTheDocument()
  })

  it('**从没展开过**的一行：原文那一块只有空容器，内容根本不挂（DOM 开销那一条不变）', () => {
    reset()
    render(
      <TracePanel
        turnIndex={0}
        turn={turnOf([step({ detail: '跑完了，输出 3 行', args: '{"cmd":"ls"}' })])}
      />,
    )

    // 容器在（`aria-controls` 要有落点、动效要有东西可动），但里面一个字都没有
    const raw = screen.getByTestId('step-raw')
    expect(raw).toHaveAttribute('data-fold', 'closed')
    expect(raw.textContent).toBe('')
    expect(screen.queryByText('入参')).toBeNull()
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
    const turn = turnOf(
      [step({ detail: '第一条' }), step({ detail: '第二条', status: 'running' })],
      { streaming: true },
    )
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
    // §12.335：收起读的是那一块的行高（内容为双向动效常驻，不再卸载）
    expect(groupBody()).toHaveAttribute('data-fold', 'closed')
    expect(openGroups.get('t0:group:tool-0:web_search')).toBe(false)

    // 换挂载（收起面板再打开 / 换会话再回来那条路）：**仍然按他选的"收"画**——
    // 默认档（还在跑就展开）不许把他那一下盖掉。新挂载里这一组从没展开过，
    // 所以它连内容都不挂（DOM 开销那一条不变），读数仍是"收起"。
    rerender(panel(1))
    expect(screen.getByRole('button', { name: /正在联网搜索/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(groupBody()).toHaveAttribute('data-fold', 'closed')
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
    // 名字仍在（无障碍与用例要有稳定落点）：**但它只活在 aria-label 上**——
    // 可见文字一个都不印（2026-09-29 用户："把「执行过程」那几个字删掉"）。
    expect(body).toHaveAttribute('aria-label', '执行过程')
    expect(toggle).toHaveAttribute('aria-label', '执行过程')
    expect(toggle).not.toHaveTextContent('执行过程')
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
 * 面板级的**高度过渡**（§12.335：面板 / 组 / 单步三处都走 `ui/Fold.tsx`，双向都动）。
 *
 * 这里的读法是：容器一直在、行高在 0fr/1fr 之间、`data-fold` 报开合；
 * **展开与收起两头都有东西可以动**（内容按"展开过一次才常驻"挂着，见 `Fold` 头注）。
 * "从没展开过的那一轮内容根本不挂"（DOM 开销那一条）由 `chat-trace-fold` 那一条钉。
 * jsdom 不跑 CSS 动画，这一节钉的是"接线"（类名与行高到底挂没挂上），
 * 真实浏览器里的观感要肉眼看（`.shots`）。
 */
describe('面板折叠容器：双向都有高度过渡（§12.335）', () => {
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
    expect(open).toHaveAttribute('data-fold', 'open')

    stubs.traceOpen = () => 'collapsed'
    try {
      rerender(<TracePanel turnIndex={0} turn={turnOf([step()])} />)

      const collapsed = document.getElementById('trace-panel-0') as HTMLElement
      expect(collapsed.style.gridTemplateRows).toBe('0fr')
      expect(collapsed).toHaveAttribute('data-fold', 'closed')
      // 收起之后内容**仍然挂着**：§12.335 要的双向过渡就是这么换来的
      expect(screen.getByText('联网搜索')).toBeInTheDocument()
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

describe('面板那一行：可见文字按用户要求删了，名字改由 aria-label 给', () => {
  it('流式期间**不印**那几个字，那条会滚的实时文案也不出现', () => {
    reset()
    // 正在跑一次「联网搜索」——那条老文案在这种情况下会写出「正在联网搜索…」
    render(
      <TracePanel
        turnIndex={0}
        turn={turnOf([step({ status: 'running' })], { streaming: true })}
      />,
    )

    const row = screen.getByTestId('trace-toggle')
    // 可见文字为空：只剩那枚图标与箭头（行仍然是唯一能点开面板的地方，且点得动）
    expect(row).not.toHaveTextContent('执行过程')
    expect(row).toHaveAttribute('aria-label', '执行过程')
    expect(row).not.toHaveTextContent('正在联网搜索…')
  })

  it('跑完又**没有出处**：可见文字同样为空（不再只剩一枚箭头的是"名字"，不是文字）', () => {
    reset()
    render(<TracePanel turnIndex={0} turn={turnOf([step()])} />)

    const row = screen.getByTestId('trace-toggle')
    // 这一行是唯一能点开过程面板的地方：**名字**给得出（aria-label），可见文字为空
    expect(row).toHaveAttribute('aria-label', '执行过程')
    // 当年那条动态摘要一个字都不许回来：它是替这一轮编一段经过
    //（"本轮没有命中资料 / 直接作答"），用户原话是"没啥用"
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

/*
 * D11-①（2026-09-29 用户："工具行里'标签'与'文字'没对齐"）。
 *
 * 病灶是 **`<button>` 的 UA 默认 `text-align: center` + 标签会换行**：
 * 组行那句「联网搜索 11 个关键词 · 2025国庆 重庆到遵义…」实测两行，不写 `text-left` 时
 * 每一行各自居中——首字形落在 x=467.28（容器左边缘 461）、第二行落在 x=732.44，
 * 而它下面的站点行 / 结论都在 461。数字与截图在 `.shots/d11b-align/`。
 *
 * 这里钉**类名**（不起浏览器也能红）：真浏览器那条数字链太贵，而这条回归是
 * "有人顺手把 `text-left` 删了"。与 `chat-ui.test.tsx` 里那几条类名断言同一手法。
 */
describe('标签左对齐（D11-①：换行后每一行各自居中的那条回归）', () => {
  it('两档标签类名都带 text-left（单步的纯文本档 + 可点档）', () => {
    expect(STEP_LABEL.split(' ')).toContain('text-left')
    expect(STEP_TOGGLE.split(' ')).toContain('text-left')
  })

  it('组行那一行真的把它带到了 DOM 上（长标题就是在这里换行的）', () => {
    reset()
    render(
      <TracePanel
        turnIndex={0}
        turn={turnOf([step({ detail: '第一条' }), step({ detail: '第二条' })])}
      />,
    )

    const groupToggle = screen.getByRole('button', { name: /联网搜索/ })
    expect(groupToggle.className).toContain('text-left')
  })
})

/*
 * 2026-09-29 用户两条（②③ 的判据 + ④ 的面板头结构）：
 *
 * - "每一步的 token/字数不标，只在最后标一个总的"；
 * - "这不还是没对齐吗"：面板头那一行改前是「箭头 12 + 间距 4 + 图标 13 + 间距 4」
 *   凑出 461 的——文字对了，但图标落在 444，比行内那条图标线右 16px。
 *   现在面板头与行内**同构**：同一个 21px 圆底（`STEP_ICON`）+ 同一个 `--space-3`。
 *
 * 这里钉**DOM 结构与类名**（真浏览器那条数字链在 `.shots/trace-cleanup/`，
 * 不起浏览器也能红——回归是"顺手改回去"）。
 */
describe('过程总计（②）：只在末尾一处，逐步的字数一个都不印', () => {
  it('末尾那一处按"思考 + 结论 + 入参 + 返回"的字符数给总计', () => {
    reset()
    render(<TracePanel turnIndex={0} turn={turnOf([timed(3200)])} />)

    const total = screen.getByTestId('trace-total')
    // 「先查一下再回答。」(8 个字符) + 「查 A」(3) = 11；args/result 这两处没给
    expect(total).toHaveTextContent('共 11 字')
    // 有耗时（当场看着它跑完的那一轮）才写用时
    expect(total).toHaveTextContent('用时 3.2s')
  })

  it('逐步的「N 字」一个都不印（用户点名的就是那一行）', () => {
    reset()
    render(<TracePanel turnIndex={0} turn={turnOf([timed(3200)])} />)

    // 面板里所有"数字 + 字"的文本，只允许末尾那一条（以及它内部那层 span）
    const charty = screen
      .getAllByText(/[\d,]+ 字/)
      .filter((el) => !el.closest('[data-testid="trace-total"]'))
    expect(charty).toHaveLength(0)
    // 逐步的耗时仍然留着（那不是"字数"，是唯一还说得出的读数）
    expect(screen.getByTestId('step-elapsed')).toHaveTextContent('3.2s')
  })

  it('历史那一轮没有耗时（`durationMs` 缺席）→ 只报字数，**不猜**一个用时', () => {
    reset()
    render(<TracePanel turnIndex={0} turn={turnOf([step()])} />)

    const total = screen.getByTestId('trace-total')
    expect(total).toHaveTextContent('共 3 字')
    expect(total).not.toHaveTextContent('用时')
  })
})

describe('面板头的图标落在行内那条图标线上（④）', () => {
  const withSource = {
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
  }

  it('面板头用同一个图标沟 + 同一个 `--space-3`：三者同构', () => {
    reset()
    // 有出处时这一行才有可见文字（摘要那句），所以拿它量"图标位 + 文字位"两笔
    render(<TracePanel turnIndex={0} turn={turnOf([step()], withSource)} />)

    const toggle = screen.getByTestId('trace-toggle')
    // 图标沟就是行内那一个类名（方形圆底，边长是**那一个变量**，见 `STEP_ICON` / `STEP_BAND`）
    const slot = toggle.querySelector(':scope > span') as HTMLElement
    expect(slot.className).toContain('w-[var(--step-band)]')
    expect(slot.className).toContain('h-[var(--step-band)]')
    // 变量在面板头这一层也声明了（否则 var() 解析不出来 = 0）
    expect(toggle.className).toContain('[--step-band:21px]')
    // 间距是行内那一笔（`--space-3` = 12）——21 + 12 才是标签那条 461 的来历
    expect(toggle.className).toContain('gap-[var(--space-3)]')
    // 箭头排在文字之后（与 `STEP_TOGGLE`「标签 + 箭头」同款），不再自己占一条线
    const tail = toggle.lastElementChild as HTMLElement
    expect(tail.tagName.toLowerCase()).toBe('span')
    expect(tail.querySelector('svg')).not.toBeNull()
    // 面板头那一层不再有"独立排在开头的箭头"（改前它是 12px 的 svg，排在图标之前）
    expect(toggle.firstElementChild?.tagName.toLowerCase()).toBe('span')
  })

  it('没有可见文字时也只剩"图标沟 + 箭头"两个元素（不再多一条线）', () => {
    reset()
    render(<TracePanel turnIndex={0} turn={turnOf([step()])} />)

    const toggle = screen.getByTestId('trace-toggle')
    expect(toggle.children).toHaveLength(2)
    expect((toggle.children[0] as HTMLElement).className).toContain('w-[var(--step-band)]')
    expect(toggle.children[1].tagName.toLowerCase()).toBe('svg')
  })

  it('尺寸只在一处定义：图标盒与所有标签带子都引用同一个变量（D11-②）', () => {
    reset()
    render(<TracePanel turnIndex={0} turn={turnOf([step()], withSource)} />)

    // 行外壳声明变量；标签带子与图标盒引用它 —— 改一处两边一起变（用户："可以动态计算的嘛"）
    const row = document.querySelector('li[data-kind]') as HTMLElement
    expect(row.className).toContain('[--step-band:21px]')
    const slot = row.firstElementChild as HTMLElement
    expect(slot.className).toContain('var(--step-band)')
    // 标签那一档：块级 flex（基线对齐会把 inline-flex 压下约 1.8px —— 真浏览器量到过 −1.59）
    const label = row.querySelector('p, button') as HTMLElement
    expect(label.className).toContain('min-h-[var(--step-band)]')
    expect(label.className).toMatch(/(^|\s)flex(\s|$)/)
    expect(label.className).not.toContain('inline-flex')
  })
})
