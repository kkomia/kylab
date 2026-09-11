/**
 * 状态 → 文案与语义色的映射（《前端设计规范》§6/§7）。
 *
 * 放在这里而不是各页面各写一份：流水线阶段（架构 §4）一旦增删，
 * 只有这一处需要改，也保证文档页、任务中心、详情页的口径一致。
 *
 * 文字永远在，图标与颜色只是加速识别的辅助（§8 必须项）。
 */

import type { StatusTone } from '@/components/ui/StatusTag.vue'
import type { DocumentStage } from '@/api/documents'
import type { TaskState } from '@/api/tasks'

export interface StatusView {
  label: string
  tone: StatusTone
}

const DOCUMENT_STAGES: Record<DocumentStage, StatusView> = {
  uploaded: { label: '待处理', tone: 'neutral' },
  probing: { label: '探测中', tone: 'info' },
  parsing: { label: '解析中', tone: 'info' },
  parsed: { label: '已解析', tone: 'info' },
  chunking: { label: '切分中', tone: 'info' },
  chunked: { label: '已切分', tone: 'info' },
  embedding: { label: '向量化中', tone: 'info' },
  indexed: { label: '已索引', tone: 'success' },
  enriching: { label: '增强中', tone: 'info' },
  enriched: { label: '已增强', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
  // 取消不是失败：中性色 + 明确说"已取消"，别让它冒充红色故障
  canceled: { label: '已取消', tone: 'neutral' },
}

const TASK_STATES: Record<TaskState, StatusView> = {
  pending: { label: '排队中', tone: 'neutral' },
  running: { label: '执行中', tone: 'info' },
  succeeded: { label: '已完成', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
  canceled: { label: '已取消', tone: 'neutral' },
}

const TASK_KINDS: Record<string, string> = {
  probe: '探测',
  parse: '解析',
  chunk: '切分',
  embed: '向量化',
}

/**
 * 健康判据 → 语义色（M7 / T7.4）。
 *
 * **文字用后端给的 `health_label`，这里只决定颜色**：标签是后端判定的结论
 * （"可能卡住" / "长时间未执行"），前端再翻译一遍就会出现两套说法。
 *
 * `done` 是唯一含糊的一档——它同时覆盖"已完成""已取消""已失败"三种终态，
 * 所以这里给中性色，不让它冒充成功色。**但失败必须能一眼看出来**，
 * 那一格由状态列的红字承担（见 `taskStateView`），两列合起来才读得对：
 * 状态说"发生了什么"，健康说"要不要管"。
 */
const TASK_HEALTH_TONES: Record<string, StatusTone> = {
  running: 'info',
  stalled: 'danger',
  overdue: 'warning',
  idle: 'neutral',
  done: 'neutral',
}

export function taskHealthTone(health: string): StatusTone {
  return TASK_HEALTH_TONES[health] ?? 'neutral'
}

/** 只有这两种是**需要用户做点什么**的；用来决定要不要在行上给一个提示。 */
export function isTaskProblem(health: string): boolean {
  return health === 'stalled' || health === 'overdue'
}

/** 未知识别值兜底成中性文案：后端新增阶段时界面不会空白或崩掉。 */
export function documentStageView(stage: string): StatusView {
  return DOCUMENT_STAGES[stage as DocumentStage] ?? { label: stage, tone: 'neutral' }
}

export function taskStateView(state: string): StatusView {
  return TASK_STATES[state as TaskState] ?? { label: state, tone: 'neutral' }
}

export function taskKindLabel(kind: string): string {
  return TASK_KINDS[kind] ?? kind
}
