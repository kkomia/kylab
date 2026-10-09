/**
 * 记忆接口（对应后端 `/api/v1/memory`，v0.57 起后端是 mem0）。
 *
 * **两个概念别混**：记忆是"你说的"（无出处、可改、高频写），知识库是"文献说的"。
 * 所以这里没有任何字段指向文档、片段或向量——记忆页只碰记忆这一侧。
 *
 * **一条一条的记忆条目**：库里的本体是 mem0 记下的条目（每条有 id）。
 * 写只有这几条路：加一条 `createMemoryItem`、改一条 `updateMemoryItem`（按 id）、
 * 删一条 `deleteMemoryItem`（按 id），外加把旧档案一次性搬进来的 `importLegacyMemory`。
 * 旧档案制那几个端点（`/archive` `/changes` `/recall` `/remember` `/forget`
 * `/restore` `/group` `/migrate` `/draft/organize`）已经删除，
 * 别在这里把它们加回来。
 *
 * **读文件那一条也删了**（2026-10-09）：`getMemoryFile`（`GET /memory/files/{path}`）
 * 唯一的消费者是记忆页上那节只读的「人设文件」，那一块按设计整块下掉
 * （人设属于人设层，不是记忆），于是前端零消费者、后端的端点连 schemas 一起删。
 *
 * `content` 是**原文**：进出的是完整字符串，不解析、不结构化。
 */

// 记忆本体本来就在本机（`<data_dir>/memory`）→ 全部走 `requestLocal`。
import { requestLocal } from './client'
import type { components } from './schema'

type Schema = components['schemas']

export type MemoryStatus = Schema['MemoryStatusOut']
export type MemoryOverview = Schema['MemoryOverviewOut']
export type MemoryItem = Schema['MemoryItemOut']
export type MemoryItems = Schema['MemoryItemsOut']
export type MemoryWriteResult = Schema['MemoryWriteOut']
export type MemoryHistory = Schema['MemoryHistoryOut']
export type MemoryItemHistory = Schema['MemoryItemHistoryOut']
export type MemoryImport = Schema['MemoryImportOut']

/** 这一层的状态（开没开、库在哪、几条、向量是不是兜底、还有没有旧档案可导）。**只有状态**。 */
export function getMemory(): Promise<MemoryOverview> {
  return requestLocal<MemoryOverview>('/memory')
}

/**
 * 条目列表：给了 `query` 就在库里检索，否则列全部（最近改的在前）。
 *
 * 检索与知识库那条路**是两条路、永不合并**——这里的 `note` 就是提醒这件事的一句话。
 */
export function getMemoryItems(query = '', limit = 0): Promise<MemoryItems> {
  const params = new URLSearchParams()
  if (query.trim()) params.set('query', query.trim())
  if (limit > 0) params.set('limit', String(limit))
  const suffix = params.toString()
  return requestLocal<MemoryItems>(`/memory/items${suffix ? `?${suffix}` : ''}`)
}

/**
 * 记一条（新增或更正）。
 *
 * `replaces` 是"更正一次完成"的入口：填要改掉的那条原文，一次调用完成。
 * 返回体带 `action`（`added` / `replaced` / `existing` / `rejected`）与 `receipt`
 * ——**回执就是给人看的那一句**，界面直接用，不另编。
 */
export function createMemoryItem(
  content: string,
  options: { section?: string; replaces?: string } = {},
): Promise<MemoryWriteResult> {
  return requestLocal<MemoryWriteResult>('/memory/items', {
    method: 'POST',
    body: JSON.stringify({
      content,
      section: options.section ?? '',
      replaces: options.replaces ?? '',
    }),
  })
}

/** 改一条（按 id）：`content` 留空 = 只改分区标签。 */
export function updateMemoryItem(
  id: string,
  changes: { content?: string; section?: string },
): Promise<MemoryWriteResult> {
  return requestLocal<MemoryWriteResult>(`/memory/items/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      content: changes.content ?? '',
      section: changes.section ?? '',
    }),
  })
}

/** 删一条（按 id）。 */
export function deleteMemoryItem(id: string): Promise<MemoryWriteResult> {
  return requestLocal<MemoryWriteResult>(`/memory/items/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

/** 一条记忆的历史（**最旧在前**，只读）。 */
export function getMemoryItemHistory(id: string): Promise<MemoryItemHistory> {
  return requestLocal<MemoryItemHistory>(`/memory/items/${encodeURIComponent(id)}/history`)
}

/** 把旧 `PROFILE.md` 的四区条目搬进新库（**零模型调用**、可重跑、旧文件不动）。 */
export function importLegacyMemory(): Promise<MemoryImport> {
  return requestLocal<MemoryImport>('/memory/import-legacy', { method: 'POST' })
}
