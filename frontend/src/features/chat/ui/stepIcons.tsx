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
 * 1. `think → Brain`：思考就该是"脑子"，`Bot` 那只机器人会被读成"智能体/子 Agent"；
 *    `Sparkles` 是"智能润色"的意思（本仓其他页面用它表示"优化/助手"），不是思考；
 * 2. `exec → SquareTerminal`：比原来的 `SquareCode` 少一层"这是代码"的误导——
 *    跑的是命令（`ls` / 构建 / 脚本），不一定是代码；
 * 3. `skill → ScrollText`、`session → MessagesSquare`：技能是"一份写下来的东西"、
 *    会话/子智能体是"几个来回的对话"，都是一眼认得出的形状；
 * 4. **联网单独一枚 `Globe`**（见下面 `StepIcon`）：它与"检索知识库"在后端是同一个
 *    kind（`search`：只读 + 影响面 network，见 `tool_meta._derive_kind`），
 *    但"在库里翻"与"去外面的世界翻"对用户是两件事——后者要认得出"它上网了"。
 */
import {
  Brain,
  Check,
  CircleX,
  FileText,
  Globe,
  Hand,
  MessageSquare,
  MessagesSquare,
  Pencil,
  ScrollText,
  Search,
  Server,
  ShieldX,
  SquareTerminal,
  Trash,
  type LucideIcon,
} from 'lucide-react'

import type { TraceIcon } from '@/features/chat/model/turns'
import { isWebStep } from '@/features/chat/model/webSites'

export const STEP_ICONS: Record<TraceIcon, LucideIcon> = {
  // 非工具步骤两档
  think: Brain,
  build: Check,
  // 工具步骤：**键就是语义种类**（后端 `tool_meta.kind_of` 给的）
  read: FileText,
  // 「找东西」的默认一枚（`search` / `recall` / `search_files`）：
  // **联网那一步不走这里**，见下面 `StepIcon` 的说明
  search: Search,
  // 「写入/产出」用笔（建笔记、上传、导出都是"往里放东西"）
  write: Pencil,
  delete: Trash,
  exec: SquareTerminal,
  skill: ScrollText,
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
 * 「联网」那一枚（§12.334 的选型表把"检索"与"联网"分成两档）。
 *
 * 为什么要单独一层判断：后端 `tool_meta.kind_of('web_search')` 给的是 `search`
 * （只读 + 影响面 network，与"检索知识库"同一个 kind），而 §12.334 要的是
 * "检索 → 放大镜、联网 → 地球"。所以**图形在这里按工具名再分一档**——
 * `TraceStep.icon` 仍是 `search`（纯逻辑层一字不动，`chat-model-turns` 那批
 * `stepIcon` 断言照样绿），只有画的时候换成地球，`data-icon` 也如实报 `web`。
 */
const WEB_ICON: LucideIcon = Globe

/**
 * 每种类别配一个**可断言、可测**的标记（`data-icon`）。
 *
 * 为什么要在 DOM 上留这一笔：图标是"这一步干了什么"的第一眼线索，而它恰好是
 * 最难在用例里断言的东西（SVG 的形状说明不了它是哪一张）。留一个稳定的
 * 数据属性之后，"联网搜索画的是放大镜"这件事就能被钉住。
 *
 * `data-icon` 报的是**画出来的那一张**：联网那两步画的是地球，就写 `web`
 * （`web` 不在逻辑层的 `TraceIcon` 里，它是渲染层的一档，见 `WEB_ICON`）。
 * 要知道它属于哪个语义种类仍然看 `data-kind`（那一栏是纯逻辑层的 `kind`）。
 *
 * `tool` / `label` 只为"是不是联网"这一档存在；都不给就按 `icon` 画。
 */
export function StepIcon({
  icon,
  tool,
  label,
  size = 13,
}: {
  icon: TraceIcon
  /** 原始工具名（`TraceStep.tool`）；只有联网那一档用得上。 */
  tool?: string
  /** 老快照的中文标签（没有工具名时的兜底判据）。 */
  label?: string
  size?: number
}) {
  if (icon === 'search' && isWebStep({ tool, label })) {
    return <WEB_ICON size={size} aria-hidden data-icon="web" />
  }
  const Component = STEP_ICONS[icon] ?? Server
  return <Component size={size} aria-hidden data-icon={icon} />
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
 * 与标签后面那句静态「进行中」（`traceStyles.STEP_RUNNING`）。
 * 见到旧代码引用 `StepSpinner` 时，是"删了"，不是"忘了"。
 */
