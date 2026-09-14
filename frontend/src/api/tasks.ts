/**
 * 任务接口（对应后端 GET /api/v1/tasks）：任务中心的数据来源。
 *
 * `attempts` / `max_attempts` / `lease_expires_at` 都原样展示——
 * 用户要能看出"重试了几次、卡在哪一步"，而不是只看到一个转圈（架构 §12）。
 */

import { request } from './client'

export type TaskKind = 'probe' | 'parse' | 'chunk' | 'embed' | 'questions'
export type TaskState = 'pending' | 'running' | 'succeeded' | 'failed' | 'canceled'

/**
 * 后端算出的健康判据（M7 / T7.4）。
 *
 * **为什么由后端算而不是前端猜**：判"卡住"要比较租约到期时间与当前时刻，
 * 还要知道租约时长——那些只有后端有。前端只负责按这个值上色。
 */
export type TaskHealthState = 'running' | 'stalled' | 'overdue' | 'idle' | 'done'

export interface TaskSummary {
  id: string
  kind: TaskKind
  state: TaskState
  document_id: string | null
  /** 任务所属文档的知识库（随列表带回），界面的"按知识库筛选"靠它。 */
  knowledge_base_id: string | null
  /** 关联文档名（后端解析好）。拿它就不必逐库拉文档列表来反查名字。 */
  document_name: string
  attempts: number
  max_attempts: number
  error: string | null
  next_run_at: string | null
  lease_expires_at: string | null
  created_at: string | null
  updated_at: string | null
  health: TaskHealthState
  /** 后端给的中文短标签（"可能卡住"、"长时间未执行"…）。前端不再自己翻译一遍。 */
  health_label: string
  /** 一句解释。**失败任务的原因也在这里**——所以它必须能被完整读到。 */
  health_detail: string
}

export function listTasks(state?: TaskState): Promise<{ items: TaskSummary[] }> {
  const query = state ? `?state=${state}` : ''
  return request(`/tasks${query}`)
}

/** 取消还没结束的任务。两种用法：点名 `taskIds`，或只给 `state` 清空整批排队。 */
export interface TaskCancelResult {
  succeeded: number
  failed: number
  items: { task_id: string; ok: boolean; error: string | null }[]
}

export function cancelTasks(payload: {
  taskIds?: string[]
  state?: 'pending' | 'running' | 'all'
}): Promise<TaskCancelResult> {
  return request('/tasks/cancel', {
    method: 'POST',
    body: JSON.stringify({
      task_ids: payload.taskIds ?? [],
      state: payload.state ?? 'pending',
    }),
  })
}
