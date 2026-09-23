/**
 * 过程面板的**图标表**（按语义种类选图，v0.26 / P2-1）。
 *
 * 键是 `TraceStep.icon` 那个类别（工具步骤就等于后端的 `kind`），值在这里——
 * **只有这个文件 import 图标组件**，逻辑层（`model/turns`）不认识它们
 * （同旧 `ChatView` 里那张 `STEP_ICONS` 的分工）。
 *
 * 改之前所有工具都画同一个服务器方块：七个联网搜索、两个抓网页，
 * 那一列全是同一个图形，扫过去等于没有信息。配色在 `.step-kind-*`（见
 * `ui/traceStyles.ts`）——这张表只说"画哪张图"，颜色交给样式，两处各管一件。
 */
import {
  Bot,
  Check,
  FileText,
  ListChecks,
  MessageSquare,
  Pencil,
  Search,
  Server,
  Sparkles,
  SquareCode,
  Trash,
  type LucideIcon,
} from 'lucide-react'

import type { TraceIcon } from '@/features/chat/model/turns'

export const STEP_ICONS: Record<TraceIcon, LucideIcon> = {
  // 非工具步骤两档
  think: Bot,
  build: Check,
  // 工具步骤：**键就是语义种类**（后端 `tool_meta.kind_of` 给的）
  read: FileText,
  search: Search,
  // 「写入/产出」用笔（建笔记、上传、导出都是"往里放东西"）
  write: Pencil,
  delete: Trash,
  exec: SquareCode,
  skill: ListChecks,
  session: Sparkles,
  message: MessageSquare,
  // 认不出来的（外部 MCP 工具）：中性一档，不猜
  tool: Server,
}

/**
 * 每种类别配一个**可断言、可测**的标记（`data-icon`）。
 *
 * 为什么要在 DOM 上留这一笔：图标是"这一步干了什么"的第一眼线索，而它恰好是
 * 最难在用例里断言的东西（SVG 的形状说明不了它是哪一张）。留一个稳定的
 * 数据属性之后，"联网搜索画的是放大镜"这件事就能被钉住。
 */
export function StepIcon({ icon, size = 13 }: { icon: TraceIcon; size?: number }) {
  const Component = STEP_ICONS[icon] ?? Server
  return <Component size={size} aria-hidden data-icon={icon} />
}
