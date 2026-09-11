/**
 * 知识库接口（对应后端 /api/v1/knowledge-bases）。
 * 字段与后端 `api/v1/schemas.py` 一一对应，改后端时同步改这里。
 */

import { request } from './client'

export interface KnowledgeBase {
  id: string
  name: string
  embedding_model_id: string
  embedding_dim: number
  chunk_strategy: string
  chunk_size: number
  chunk_overlap: number
  created_at: string | null
  /** 当前账号能否管理这个库的分享（owner / 管理员 / 控制台令牌）。判定在后端。 */
  can_manage: boolean
  /** 能否写入（上传/删除）。只读分享的成员看得见但写不动，界面据此收起写入口。 */
  can_write: boolean
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
