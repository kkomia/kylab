/**
 * 驾驶舱统计接口（对应 /api/v1/stats/dashboard）。
 *
 * 一个接口给全量数字：驾驶舱要同时渲染五六块图，分开请求既慢，
 * 又容易出现"上半页是新的、下半页是旧的"。
 */

import { request } from './client'

export interface ActivityPoint {
  day: string
  documents: number
  chunks: number
  tasks: number
}

export interface KbStat {
  id: string
  name: string
  embedding_model_id: string
  embedding_dim: number
  documents: number
  chunks: number
  last_activity: string | null
}

export interface Dashboard {
  generated_at: string
  window_days: number
  total_knowledge_bases: number
  total_documents: number
  total_chunks: number
  indexed_documents: number
  failed_documents: number
  running_tasks: number
  failed_tasks: number
  storage_bytes: number
  recent_documents: number
  activity: ActivityPoint[]
  by_stage: Record<string, number>
  by_suffix: Record<string, number>
  by_source_kind: Record<string, number>
  knowledge_bases: KbStat[]
}

export function getDashboard(windowDays = 120): Promise<Dashboard> {
  return request(`/stats/dashboard?window_days=${windowDays}`)
}
