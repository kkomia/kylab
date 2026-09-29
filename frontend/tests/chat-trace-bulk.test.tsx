/**
 * 过程面板的**「全部展开 / 全部收起」**（调研 §5.2 P2：LobeHub 放在消息动作条上、
 * Qwen 给了 `Ctrl+O` / `Alt+T`，十二个样本里没有这一条的只有少数几家）。
 *
 * 五件事要一起钉住，缺一条这个入口就会变成新的坑：
 *
 * 1. **入口在哪儿**：画在面板内容里（完成轮默认收起时它同内容一起不在文档里），
 *    而**不替用户动面板自己那一档**——"全部收起"把整块过程一起折掉的话，
 *    用户连自己刚收起的结果都看不见了；
 * 2. **范围是这一轮、且单步与组两级一起**：只摊开组头、里面还折着等于没省这一步；
 *    范围也不止"当前画出来的前 20 条"（分页切的是渲染，见 `tracePage`），
 *    否则点完「加载更多」后半截又冒出一批折着的行；
 * 3. **`forceExpand` 的那几档一律跳过**（§12.333 约束 2）：`awaiting` / `failed` / `blocked`
 *    的组与单步不许被「全部收起」收掉——安全语义高于用户这一下点击；
 * 4. **写的是宿主原来那两张表**（`openSteps` / `openGroups`），不另造一套记账：
 *    所以"用户选过"那一档照旧跨挂载、跨重挂记得住；
 * 5. 两条规则的反面：**只作用于当前这一轮**，别的轮次一行都不动。
 *
 * 桩的手法与 `chat-trace-fold.test.tsx` 一致（宿主那两张表是模块级变量、不是响应式的，
 * 所以点完要显式重画一次）。`traceOpen` 用的是**真的** `isTraceOpen`：面板的默认档
 * 由 `chat-trace-fold` 那一节钉，这里只需要它照规矩画（完成轮默认收起）。
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { ChatStep } from '@/api/chat'
import {
  isTraceOpen,
  makeMessage,
  traceEntries,
  traceKey,
  type Message,
  type TraceOpen,
  type Turn,
} from '@/features/chat/model/turns'
import { TracePanel } from '@/features/chat/ui/TracePanel'

/** 宿主那两张表：单步是 `Set`（在表里 = 摊开），组是 `Map`（两档都记）。 */
const openSteps = new Set<string>()
const openGroups = new Map<string, boolean>()

/** 面板这一档的事实来源（真宿主里是 `traceOpenIds`；§12.335 起没有"全局豁免"那一支）。 */
let chosen: TraceOpen | undefined
/** 面板头被点过几次：批量动作**一次都不该碰它**（用例钉这一条）。 */
let traceToggles = 0

const stubs = {
  traceOpen: (message: Message) => isTraceOpen(message, { chosen }),
  // 点面板头 = 用户对**这一轮**表态（真宿主那一半由 `chat-ui` 整页用例盯）
  toggleTrace: (message: Message) => {
    traceToggles += 1
    chosen = isTraceOpen(message, { chosen }) === 'full' ? 'collapsed' : 'full'
  },
  traceView: (_index: number, turn: Turn) => {
    // 与真宿主同一档：先画前 20 条（`TRACE_PAGE_SIZE`），其余只报数
    const entries = traceEntries(turn)
    return {
      entries: entries.slice(0, 20),
      shown: entries.length,
      total: entries.length,
      hidden: Math.max(0, entries.length - 20),
    }
  },
  isStepOpen: (key: string) => openSteps.has(key),
  toggleStep: (key: string) => {
    if (openSteps.has(key)) openSteps.delete(key)
    else openSteps.add(key)
  },
  groupOpenChoice: (key: string) => openGroups.get(key),
  chooseGroupOpen: (key: string, open: boolean) => {
    openGroups.set(key, open)
  },
  // 批量那两位：照真宿主的形状写进**同一张表**（一次写整批）
  chooseStepsOpen: (keys: readonly string[], open: boolean) => {
    for (const key of keys) {
      if (open) openSteps.add(key)
      else openSteps.delete(key)
    }
  },
  chooseGroupsOpen: (keys: readonly string[], open: boolean) => {
    for (const key of keys) openGroups.set(key, open)
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
    args: '{"query": "a"}',
    result: '命中 3 条',
    ...extra,
  }
}

function turnOf(steps: ChatStep[]): Turn {
  return {
    user: makeMessage('user', '问'),
    reply: makeMessage('assistant', '答', { steps }),
  }
}

/** 这一轮里各条目在宿主表上的 key（轮次前缀由 `traceKey` 套上，与界面同一份判据）。 */
function keysOf(turn: Turn) {
  const steps: string[] = []
  const groups: string[] = []
  for (const entry of traceEntries(turn)) {
    if (entry.kind === 'step') {
      steps.push(traceKey(0, entry.key))
      continue
    }
    groups.push(traceKey(0, entry.key))
    for (const child of entry.steps) steps.push(traceKey(0, child.key))
  }
  return { steps, groups }
}

/** 组头那一行（`aria-controls` 指着组容器）：组内子行也有按钮，按它取才唯一。 */
function groupHead(): HTMLElement {
  return document.querySelector('button[aria-controls^="trace-group-"]') as HTMLElement
}

/** 某一条结论所在的**那一行**（子行里可能不止一个按钮，所以按行去问）。 */
function rowOf(detail: string): HTMLElement {
  return screen.getByText(detail).closest('li') as HTMLElement
}

function reset(): void {
  openSteps.clear()
  openGroups.clear()
  chosen = undefined
  traceToggles = 0
}

describe('入口的位置与面板自己那一档', () => {
  it('完成轮默认收起 → 两个入口不在文档里；点开面板才出现（面板收起时不顺带摊开）', async () => {
    reset()
    const turn = turnOf([step()])
    const { rerender } = render(<TracePanel turnIndex={0} turn={turn} />)

    // 完成轮默认收起（`isTraceOpen`），这一行也是这一块唯一能点开的地方
    expect(screen.getByTestId('trace-toggle')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('trace-bulk-expand')).toBeNull()
    expect(screen.queryByTestId('trace-bulk-collapse')).toBeNull()

    await userEvent.setup().click(screen.getByTestId('trace-toggle'))
    rerender(<TracePanel turnIndex={0} turn={turn} />)

    // 面板摊开之后才看得见；名字就是可见文字（不另加 aria-label）
    expect(screen.getByRole('button', { name: '全部展开' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '全部收起' })).toBeInTheDocument()
  })

  it('批量动作**不动面板自己那一档**：收起之后面板还开着（否则连结果都看不见）', async () => {
    reset()
    const turn = turnOf([step()])
    chosen = 'full'
    const { rerender } = render(<TracePanel turnIndex={0} turn={turn} />)

    await userEvent.setup().click(screen.getByTestId('trace-bulk-collapse'))
    rerender(<TracePanel turnIndex={0} turn={turn} />)

    expect(screen.getByTestId('trace-toggle')).toHaveAttribute('aria-expanded', 'true')
    // 面板自己那一档是用户那一下点击（`trace-toggle`）的事，批量动作一次都不碰它
    expect(traceToggles).toBe(0)
  })
})

describe('全部展开：单步与组两级一起，写进宿主那两张表', () => {
  it('组里每一次调用与单独那一步都摊开，并记在"用户选过"那两张表上', async () => {
    reset()
    // 两次同名（并成一组）+ 一次只调一次的工具（单独一行）
    const turn = turnOf([
      step({ detail: '第一条' }),
      step({ detail: '第二条' }),
      step({ label: '读文件', tool: 'read_file', detail: '读了 20 行' }),
    ])
    chosen = 'full'
    const { rerender } = render(<TracePanel turnIndex={0} turn={turn} />)

    // 起点：这一轮跑完了 → 组与单步都折着（§12.333 自动规则的另一半）
    expect(groupHead()).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('button', { name: /读文件/ })).toHaveAttribute('aria-expanded', 'false')

    await userEvent.setup().click(screen.getByRole('button', { name: '全部展开' }))
    rerender(<TracePanel turnIndex={0} turn={turn} />)

    // 两级一起：组头摊开、组内每一次的原文也摊开
    expect(groupHead()).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('第一条')).toBeInTheDocument()
    expect(within(rowOf('第一条')).getByRole('button')).toHaveAttribute('aria-expanded', 'true')
    // 单独那一步：箭头摊开，原文（入参）就在它自己那一行里
    const singleRow = screen.getByRole('button', { name: /读文件/ }).closest('li') as HTMLElement
    expect(within(singleRow).getByRole('button')).toHaveAttribute('aria-expanded', 'true')
    expect(within(singleRow).getByText('入参')).toBeInTheDocument()

    // 记的是宿主原来那两张表：组那一档两档都写，单步那档写进 Set
    const { steps, groups } = keysOf(turn)
    expect(groups).toHaveLength(1)
    expect(openGroups.get(groups[0]!)).toBe(true)
    for (const key of steps) expect(openSteps.has(key)).toBe(true)
  })

  it('**没画出来的那些行也算在内**：不然后半截「加载更多」出来又是一批折着的', async () => {
    reset()
    // 25 个各不相同的工具调用（互不并组）→ 一屏只画 20 条，5 条在分页之外
    const steps = Array.from({ length: 25 }, (_, index) =>
      step({ label: `第 ${index + 1} 步`, tool: `tool_${index}`, detail: `结论 ${index + 1}` }),
    )
    const turn = turnOf(steps)
    chosen = 'full'
    render(<TracePanel turnIndex={0} turn={turn} />)

    const hidden = traceEntries(turn).slice(20)
    expect(hidden.length).toBe(5)
    await userEvent.setup().click(screen.getByRole('button', { name: '全部展开' }))

    // 那 5 条现在还没有行（不在文档里），但它们的档已经记下了——「加载更多」之后就照它画
    for (const entry of hidden) expect(openSteps.has(traceKey(0, entry.key))).toBe(true)
  })
})

describe('全部收起：跳过"必须看得见"的那几档', () => {
  it('普通行收掉；`failed` / `awaiting` 的组与单步照旧摊着（安全语义压过这一下点击）', async () => {
    reset()
    const turn = turnOf([
      // 单独一行、正常：这一条要能被收掉
      step({ label: '读文件', tool: 'read_file', detail: '读了 20 行' }),
      // 并成一组：其中一条失败 → 这一组整体强制展开、拒绝收起
      step({ detail: '第一条' }),
      step({ detail: '第二条', outcome: 'failed' }),
      // 单独一行、在等确认 → 强制展开
      step({ label: '执行命令', tool: 'run_command', detail: '等待确认', outcome: 'awaiting' }),
    ])
    chosen = 'full'
    const { rerender } = render(<TracePanel turnIndex={0} turn={turn} />)

    // 起点：强制展开的那两处本来就摊着（`forceExpand`）
    const forcedStep = screen.getByRole('button', { name: /执行命令/ })
    expect(forcedStep).toHaveAttribute('aria-expanded', 'true')

    await userEvent.setup().click(screen.getByRole('button', { name: '全部收起' }))
    rerender(<TracePanel turnIndex={0} turn={turn} />)

    // 正常的一行按用户这一下收掉
    expect(screen.getByRole('button', { name: /读文件/ })).toHaveAttribute('aria-expanded', 'false')

    // `failed` 那一组：组头拒绝收起，而且**组内那条失败的调用本身**也照旧摊着
    expect(groupHead()).toHaveAttribute('aria-expanded', 'true')
    expect(within(rowOf('第二条')).getByRole('button')).toHaveAttribute('aria-expanded', 'true')
    // 同组里**没有**状态位的那一条：它不属于强制那一档，跟着「全部收起」收掉
    expect(within(rowOf('第一条')).getByRole('button')).toHaveAttribute('aria-expanded', 'false')

    // 在等确认的那一步：拒不收起
    expect(screen.getByRole('button', { name: /执行命令/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(screen.getByText('等待确认')).toBeInTheDocument()

    // 被跳过的那些 key **一个字都没写进宿主表**（不是"写了又被拒绝"）。
    // 组那一张是"两档都记"的 `Map`，写了就查得到——所以这一条真的钉住了"跳过"；
    // 单步那一张是 `Set`（只记"摊开着"），"跳过"与"写了 false"在那里本来就是同一个画面。
    const keys = keysOf(turn)
    expect(keys.groups).toHaveLength(1)
    expect(openGroups.has(keys.groups[0]!)).toBe(false)
    expect(openSteps.size).toBe(0)
  })
})

describe('记的是"用户选过"那一档：跨挂载仍然按他选的画', () => {
  it('收起面板再打开（换挂载）之后，还是「全部收起」那一下的档', async () => {
    reset()
    const turn = turnOf([step({ label: '读文件', tool: 'read_file', detail: '读了 20 行' })])
    chosen = 'full'
    /** 根上换 key：整棵卸载重挂 —— "用户选过什么"必须活在组件之外。 */
    const panel = (mount: number) => (
      <div key={mount}>
        <TracePanel turnIndex={0} turn={turn} />
      </div>
    )

    const { rerender } = render(panel(0))
    await userEvent.setup().click(screen.getByRole('button', { name: '全部展开' }))
    rerender(panel(0))
    expect(screen.getByRole('button', { name: /读文件/ })).toHaveAttribute('aria-expanded', 'true')

    await userEvent.setup().click(screen.getByRole('button', { name: '全部收起' }))
    rerender(panel(1))
    expect(screen.getByRole('button', { name: /读文件/ })).toHaveAttribute('aria-expanded', 'false')
  })
})

describe('范围只有当前这一轮', () => {
  it('在第 1 轮点「全部展开」，第 2 轮那一行不动', async () => {
    reset()
    const steps = [step({ label: '读文件', tool: 'read_file', detail: '读了 20 行' })]
    chosen = 'full'
    /** 两轮形状完全相同（真实数据就是这样）：key 只差轮次前缀。 */
    const twoTurns = (mount: number) => (
      <div key={mount}>
        <div data-testid="turn-0">
          <TracePanel turnIndex={0} turn={turnOf(steps)} />
        </div>
        <div data-testid="turn-1">
          <TracePanel turnIndex={1} turn={turnOf(steps)} />
        </div>
      </div>
    )

    const { rerender } = render(twoTurns(0))
    const first = screen.getAllByRole('button', { name: '全部展开' })[0]!
    await userEvent.setup().click(first)
    rerender(twoTurns(1))

    const rows = screen.getAllByRole('button', { name: /读文件/ })
    expect(rows[0]).toHaveAttribute('aria-expanded', 'true')
    expect(rows[1]).toHaveAttribute('aria-expanded', 'false')
    expect(openSteps.size).toBe(1)
  })
})
