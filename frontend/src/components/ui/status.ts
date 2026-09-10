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
}

const TASK_STATES: Record<TaskState, StatusView> = {
  pending: { label: '排队中', tone: 'neutral' },
  running: { label: '执行中', tone: 'info' },
  succeeded: { label: '已完成', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
}

const TASK_KINDS: Record<string, string> = {
  probe: '探测',
  parse: '解析',
  chunk: '切分',
  embed: '向量化',
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
