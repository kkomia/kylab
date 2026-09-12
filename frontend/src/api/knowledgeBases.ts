/**
 * 知识库接口（对应后端 /api/v1/knowledge-bases）。
 * 字段与后端 `api/v1/schemas.py` 一一对应，改后端时同步改这里。
 */

import { request } from './client'
import type { ImpactReport } from './documents'

export interface KnowledgeBase {
  id: string
  name: string
  /** 库简介（v15）。空串 = 未填写，卡片显示"暂无简介"。 */
  description: string
  embedding_model_id: string
  embedding_dim: number
  chunk_strategy: string
  chunk_size: number
  chunk_overlap: number
  created_at: string | null
  /** 当前账号能否管理这个库的分享（owner / 管理员）。判定在后端。 */
  can_manage: boolean
  /** 能否写入（上传/删除）。只读分享的成员看得见但写不动，界面据此收起写入口。 */
  can_write: boolean
  /** 库内文档数。由列表接口一次聚合带回，前端不必逐库拉文档列表。 */
  document_count: number
  /** 库内文档的最近更新时间；空库为 null。 */
  last_activity: string | null
}

export interface KnowledgeBaseCreate {
  name: string
  chunk_size?: number
  chunk_overlap?: number
  /** 建库时选定的嵌入模型（注册表主键）。留空 = 用服务端默认。
   *  嵌入模型是知识库属性：库内向量化之后不可更换（换模型要新建库）。 */
  embedding_model_pk?: string
}

export function listKnowledgeBases(): Promise<{ items: KnowledgeBase[] }> {
  return request('/knowledge-bases')
}

export function createKnowledgeBase(payload: KnowledgeBaseCreate): Promise<KnowledgeBase> {
  return request('/knowledge-bases', { method: 'POST', body: JSON.stringify(payload) })
}

export function getKnowledgeBase(kbId: string): Promise<KnowledgeBase> {
  return request(`/knowledge-bases/${kbId}`)
}

/**
 * 修改知识库的名称 / 简介 / 切分参数。**各项都可选**，只传要改的那个
 * （传 `{ description: '' }` 是清空简介）。
 *
 * 切分参数（v17）只影响**之后摄入**的文档：已切好的块不会自己变，
 * 所以界面要提示"已有文档需要重新摄入"。
 */
export function updateKnowledgeBase(
  kbId: string,
  patch: { name?: string; description?: string; chunk_size?: number; chunk_overlap?: number },
): Promise<KnowledgeBase> {
  return request(`/knowledge-bases/${kbId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

/**
 * 切分参数的可用区间。**与后端 `services/chunking.py` 的常量一一对应**。
 *
 * 前端先校验是为了让用户当场看到中文原因，而不是等一个 422 回来；
 * 权威仍在后端（服务层会再校验一次，两处都改才算改完）。
 */
export const CHUNK_SIZE_MIN = 128
export const CHUNK_SIZE_MAX = 2048
export const CHUNK_OVERLAP_RATIO_MAX = 0.5

/** 给定块长时，重叠的上限。默认块长（512）下就是 256。 */
export function chunkOverlapMax(size: number): number {
  return Math.max(1, Math.floor(size * CHUNK_OVERLAP_RATIO_MAX))
}

/** 删除这个知识库会波及什么（界面要在动手之前把它显示出来）。 */
export function getKnowledgeBaseImpact(kbId: string): Promise<ImpactReport> {
  return request(`/knowledge-bases/${kbId}/impact`)
}

/**
 * 删除知识库。**不可恢复**（不进回收站），返回影响清单当回执。
 */
export function deleteKnowledgeBase(kbId: string): Promise<ImpactReport> {
  return request(`/knowledge-bases/${kbId}`, { method: 'DELETE' })
}
