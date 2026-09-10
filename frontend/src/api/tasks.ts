/**
 * 任务接口（对应后端 GET /api/v1/tasks）：任务中心的数据来源。
 *
 * `attempts` / `max_attempts` / `lease_expires_at` 都原样展示——
 * 用户要能看出"重试了几次、卡在哪一步"，而不是只看到一个转圈（架构 §12）。
 */

import { request } from './client'

export type TaskKind = 'probe' | 'parse' | 'chunk' | 'embed'
export type TaskState = 'pending' | 'running' | 'succeeded' | 'failed'

export interface TaskSummary {
  id: string
  kind: TaskKind
  state: TaskState
  document_id: string | null
  attempts: number
  max_attempts: number
  error: string | null
  next_run_at: string | null
  lease_expires_at: string | null
  created_at: string | null
  updated_at: string | null
}

export function listTasks(state?: TaskState): Promise<{ items: TaskSummary[] }> {
  const query = state ? `?state=${state}` : ''
  return request(`/tasks${query}`)
}
