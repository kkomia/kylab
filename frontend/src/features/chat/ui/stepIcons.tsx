/**
 * 过程面板的**图标表**（按语义种类选图，v0.26 / P2-1；选型按 §12.334 重定）。
 *
 * 键是 `TraceStep.icon` 那个类别（工具步骤就等于后端的 `kind`），值在这里——
 * **只有这个文件 import 图标组件**，逻辑层（`model/turns`）不认识它们
 * （同旧 `ChatView` 里那张 `STEP_ICONS` 的分工）。
 *
 * 改之前所有工具都画同一个服务器方块：七个联网搜索、两个抓网页，
 * 那一列全是同一个图形，扫过去等于没有信息。配色在 `.step-kind-*`（见
 * `ui/traceStyles.ts`）——这张表只说"画哪张图"，颜色交给样式，两处各管一件。
 *
 * 2026-09-29 用户给了参照图之后又重挑了一遍（原话"图标 参考这种 图标和文字搭配形式"）：
 * 换的是**图形本身**，不是"图标换成纯图标"——标签与结论照旧留着（§12.334 第一节）。
 * 四条口径：
 *
 * 1. `think → Lightbulb`：**Kimi chat 同款**（2026-09-30 用户批注"图标全部换成 kimi chat
 *    同款"，参照图上「思考已完成」就是一枚灯泡 💡）；原先的脑子上帝视角太重；
 *    `Bot` 会被读成"智能体/子 Agent"，`Sparkles` 是"智能润色"的意思，都不是思考；
 * 2. `exec → SquareTerminal`：比原来的 `SquareCode` 少一层"这是代码"的误导——
 *    跑的是命令（`ls` / 构建 / 脚本），不一定是代码；
 * 3. `skill → ListTodo`、`session → MessagesSquare`：技能是"一份可以逐条打勾的清单"
 *    （Kimi 待办清单同款），会话/子智能体是"几个来回的对话"，都是一眼认得出的形状；
 * 4. **联网那两枚单独分档**（见下面 `StepIcon`）：联网与"检索知识库"在后端是同一个
 *    kind（`search`：只读 + 影响面 network，见 `tool_meta._derive_kind`），
 *    但"在库里翻"与"去外面的世界翻"对用户是两件事——后者要认得出"它上网了"；
 *    而**联网自己又分两档**（2026-09-30 用户批注"获取网页用的是不同于搜索网页的图标"）：
 *    搜索 = `Globe`、抓页 = `PanelTop`（Kimi 的 Browser 那一枚）。
 */
import {
  CircleX,
  FileText,
  Globe,
  Hand,
  Lightbulb,
  ListTodo,
  MessageSquare,
  MessagesSquare,
  PanelTop,
  Pencil,
  PenLine,
  Search,
  Server,
  ShieldX,
  SquareTerminal,
  Trash,
  type LucideIcon,
} from 'lucide-react'

import type { TraceIcon } from '@/features/chat/model/turns'
import { isFetchStep, isWebStep } from '@/features/chat/model/webSites'

export const STEP_ICONS: Record<TraceIcon, LucideIcon> = {
  /*
    非工具步骤两档（`think` 思考 / `build` 组织回答）。
    ⚠️ **工具链行里这两档不画这张表里的图**：按 2026-09-30 用户批注（§2，"不是钢笔/灯泡"），
    行上画的是 Kimi「思考已完成」那枚**实心小圆点**（`StepDot`）。这张表里那两枚仍然留着，
    是因为 `StepIcon` 本身是这个渲染层的公开件（`tests/chat-trace-icons.test.tsx` 逐档钉着
    "哪一档画哪一枚"），删一格等于把一个已定契约悄悄改掉。
  */
  think: Lightbulb,
  build: PenLine,
  // 工具步骤：**键就是语义种类**（后端 `tool_meta.kind_of` 给的）
  read: FileText,
  // 「找东西」的默认一枚（`search` / `recall` / `search_files`）：
  // **联网那一步不走这里**，见下面 `StepIcon` 的说明
  search: Search,
  // 「写入/产出」用笔（建笔记、上传、导出都是"往里放东西"）
  write: Pencil,
  delete: Trash,
  exec: SquareTerminal,
  // 技能 = Kimi 的「待办清单」形状（一份可以逐条打勾的清单）
  skill: ListTodo,
  session: MessagesSquare,
  message: MessageSquare,
  // 认不出来的（外部 MCP 工具）：中性一档，不猜
  tool: Server,
}

/** 这一步的**结果类别**里"要人看一眼"的三档（§12.334 第二节）。 */
export type StepOutcome = 'failed' | 'blocked' | 'awaiting'

/**
 * 三档状态各一枚（**互斥**：一枚行只挂一枚）。
 *
 * 三枚的语义与"该给什么颜色"是同一个判断的两面，所以放在一张表里：
 *
 * - `failed → CircleX`（红）：这一步**没做成**（工具内部出错），红是"出了问题"；
 * - `blocked → ShieldX`（中性灰）：被模式 / 权限 / 隔离**拦下**——它不是故障，是
 *   有意为之的一道闸，用灰的（红会让人以为系统坏了，去找一个不存在的故障）；
 * - `awaiting → Hand`（警示橙）：**在等你点头**（"要你动手"那一档），橙是本仓
 *   表示"提醒/待处理"的那一档（与 `exec` 的警示色同一口径）。
 */
export const STEP_OUTCOME_ICONS: Record<StepOutcome, LucideIcon> = {
  failed: CircleX,
  blocked: ShieldX,
  awaiting: Hand,
}

const STEP_OUTCOME_CLASS: Record<StepOutcome, string> = {
  failed: 'text-[var(--status-danger)]',
  blocked: 'text-[var(--text-tertiary)]',
  awaiting: 'text-[var(--status-warning)]',
}

/**
 * 「上了一趟网」那两枚（§12.334 的选型表把"检索"与"联网"分成两档；
 * 2026-09-30 用户批注把"联网"再分成"搜"与"抓"两档）。
 *
 * 为什么要单独一层判断：后端 `tool_meta.kind_of('web_search')` 与 `kind_of('web_fetch')`
 * 给的都是 `search`（只读 + 影响面 network，与"检索知识库"同一个 kind），而 §12.334
 * 要的是"检索 → 放大镜、联网 → 地球"。所以**图形在这里按工具名再分档**——
 * `TraceStep.icon` 仍是 `search`（纯逻辑层一字不动，`chat-model-turns` 那批
 * `stepIcon` 断言照样绿），只有画的时候换图形，`data-icon` 也如实报出来。
 *
 * 两枚各自的取法与出处：
 *
 * - **`Globe`（联网搜索）**：去外面的世界翻——"它上网了"；
 * - **`PanelTop`（抓取网页）**：参考 Kimi 的 Browser 那一枚（浏览器窗口形）——
 *   窗口顶上那一条横栏就是地址栏的位置。用户原话"获取网页用的是不同于搜索网页的图标"：
 *   抓页读的是"打开这一页"，与"又搜了一次"是两件事。
 *   备选是 `AppWindow`（窗口 + 三条小竖痕），15px 下那几道小痕糊成一团，故取 `PanelTop`；
 *   两枚都在 `lucide-react` 里（不是自画 SVG），与其余图标同一套画法。
 */
const WEB_ICON: LucideIcon = Globe
const FETCH_ICON: LucideIcon = PanelTop

/**
 * 每种类别配一个**可断言、可测**的标记（`data-icon`）。
 *
 * 为什么要在 DOM 上留这一笔：图标是"这一步干了什么"的第一眼线索，而它恰好是
 * 最难在用例里断言的东西（SVG 的形状说明不了它是哪一张）。留一个稳定的
 * 数据属性之后，"联网搜索画的是放大镜"这件事就能被钉住。
 *
 * `data-icon` 报的是**画出来的那一张**：联网搜索画的是地球就写 `web`、抓取网页画的是
 * 浏览器窗口就写 `fetch`（`web` / `fetch` 都不在逻辑层的 `TraceIcon` 里，它们是渲染层的
 * 两档，见 `WEB_ICON` / `FETCH_ICON`）。要知道它属于哪个语义种类仍然看 `data-kind`
 * （那一栏是纯逻辑层的 `kind`）。
 *
 * `tool` / `label` 只为"是不是联网、是搜还是抓"这两档存在；都不给就按 `icon` 画。
 */
export function StepIcon({
  icon,
  tool,
  label,
  size = 15,
}: {
  icon: TraceIcon
  /** 原始工具名（`TraceStep.tool`）；只有联网那两档用得上。 */
  tool?: string
  /** 老快照的中文标签（没有工具名时的兜底判据）。 */
  label?: string
  size?: number
}) {
  if (icon === 'search' && isWebStep({ tool, label })) {
    // 联网里再分"搜"与"抓"（2026-09-30 用户批注）：判据取自 `model/webSites.ts`
    // 那一份（`isWebStep` 是全集、`isFetchStep` 是抓页那一半），这里不另立词表。
    return isFetchStep({ tool, label }) ? (
      <FETCH_ICON size={size} aria-hidden data-icon="fetch" />
    ) : (
      <WEB_ICON size={size} aria-hidden data-icon="web" />
    )
  }
  const Component = STEP_ICONS[icon] ?? Server
  return <Component size={size} aria-hidden data-icon={icon} />
}

/**
 * 「思考 / 组织回答」那一行的**实心小圆点**（2026-09-30 用户批注 §2）。
 *
 * 为什么换掉钢笔与灯泡：Kimi 的「思考已完成」行前面就是一枚实心小圆点（次要文字色、
 * 六七像素），它读作"这是一条过程记录"，而不是"这里发生了一次某某操作"——
 * 工具行才需要认得出是哪种工具（检索、联网、执行…），收尾那两行没有这个信息量，
 * 给它们一枚形状不同的图标反而把"过程"与"结论"混成一类。
 *
 * 两条实现上的分寸：
 *
 * 1. **槽宽仍是 15px**（与工具图标同宽）：标签因此与上下行对齐，圆点也正好落在
 *    虚线链路那条轴上（见 `flow.css` 的 `--ch-axis`）——圆点只有 7px，直接放进 flex
 *    会让这一行的文字比别的行左移 8px；
 * 2. **圆点走 CSS 而不是图标组件**：它没有图形可言（就是一枚圆），用 `<span>` 能精确给
 *    7px 与主题色（`--Labels-Secondary`），也免得为它引一枚 lucide 图。
 *    `data-icon` 照旧报**逻辑的那一档**（`think` / `build`），与 `StepIcon` 同一口径——
 *    界面与用例读的都是它。
 */
export function StepDot({ icon }: { icon: TraceIcon }) {
  return (
    <span className="ch-dot-slot" data-icon={icon} aria-hidden>
      <span className="ch-dot" />
    </span>
  )
}

/**
 * 「这一步**不是成功**」的那一枚状态灯（§12.334 第二节）。
 *
 * 为什么要有它：这一列原先只有"这一步干了什么"，没有"这一步成没成"——
 * 用户扫过去时默认每一行都做成了，而实际上有的被模式拦下、有的在等他点头、
 * 有的工具自己出错了。三档各一枚，**挂在图标圆底的右下角**。
 *
 * 底色取画布色，把它压出一个小缺口；颜色只取自 `--status-*` 那几枚令牌。
 *
 * **它只是补一眼**：三档的**可见文字一个字都不能省**——失败 / 被拦下 / 在等确认
 * 是"要你动手 / 它没做成"的安全语义，只给一枚小图标、还要悬停才看懂，
 * 等于把最高优先级抹掉（§12.325 与 §12.333）。`data-outcome` 供用例与无障碍读。
 */
export function StepOutcomeBadge({ outcome }: { outcome: StepOutcome }) {
  const Component = STEP_OUTCOME_ICONS[outcome]
  return (
    <Component
      size={12}
      aria-hidden
      data-testid="step-outcome"
      data-outcome={outcome}
      className={`absolute -right-[4px] -bottom-[4px] rounded-[var(--radius-pill)] bg-[var(--bg-canvas)] ${STEP_OUTCOME_CLASS[outcome]}`}
    />
  )
}

/*
 * 「还在跑」那枚**转圈**（`StepSpinner`，`LoaderCircle` + `animate-spin`）**已删除**
 * （2026-09-29 用户："那个蓝色循环圈没有用"）。
 *
 * 删掉的是**图标**，不是状态：并行还留两样——行上的 `data-running`（用例与无障碍）
 * 与工具链块行上那个 `.ch-live`（流光字）——「进行中」现在由它承担。
 * 见到旧代码引用 `StepSpinner` 时，是"删了"，不是"忘了"。
 */
