/**
 * 数据源接口（M6 / T6.1–T6.3）。
 *
 * 一个数据源 = "定期去看某处有没有新内容"。当前支持 RSS 订阅与单页 HTML。
 */

import { request } from './client'

export type SourceKind = 'rss' | 'html'

export interface DataSource {
  id: string
  knowledge_base_id: string
  kind: SourceKind | string
  name: string
  url: string
  max_items: number | null
  enabled: boolean
  /** 上次拉取拿到的 ETag，用于条件 GET。 */
  etag: string | null
  last_pulled_at: string | null
}

export interface SyncResult {
  task_id: string | null
  source_id: string
  fetched: number
  created: number
  duplicates: number
  /** 服务端回了 304：源没有任何变化。 */
  not_modified: boolean
  errors: string[]
}

export function listDataSources(kbId: string): Promise<{ items: DataSource[] }> {
  return request(`/knowledge-bases/${kbId}/data-sources`)
}

export function createDataSource(
  kbId: string,
  payload: { kind: SourceKind; name: string; url: string; max_items?: number | null },
): Promise<DataSource> {
  return request(`/knowledge-bases/${kbId}/data-sources`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function setDataSourceEnabled(id: string, enabled: boolean): Promise<DataSource> {
  return request(`/data-sources/${id}/enabled?enabled=${enabled}`, { method: 'PATCH' })
}

export function deleteDataSource(id: string): Promise<void> {
  return request(`/data-sources/${id}`, { method: 'DELETE' })
}

/**
 * 拉取一次。
 *
 * `wait=true` 会同步跑完并返回统计（界面用这个——用户点了"立即拉取"
 * 就该立刻看到"抓到了几条"，而不是一个任务号）。
 * 后台定时任务走入队那条路。
 */
export function syncDataSource(id: string, wait = true): Promise<SyncResult> {
  return request(`/data-sources/${id}/sync?wait=${wait}`, { method: 'POST' })
}
