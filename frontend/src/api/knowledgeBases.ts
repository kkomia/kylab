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
  /** 入库时是否为每个分段生成推荐问题（v23）。**默认关**：生成要花模型调用。 */
  suggested_enabled: boolean
  /** 每个分段生成几条。 */
  suggested_count: number
  /** 出题用哪个对话模型（注册表主键）。null = 跟随对话页当前选的模型。 */
  suggested_model_pk: string | null
  /** 自定义出题提示词；空串 = 用内置提示词。 */
  suggested_prompt: string
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
  /** 分段问题生成（v19/v23）。建库时就能定，之后在「知识库设置 → 切块策略」里改。 */
  suggested_enabled?: boolean
  suggested_count?: number
  /** 出题模型；空串 / 不传 = 跟随对话模型。 */
  suggested_model_pk?: string | null
  suggested_prompt?: string
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
 * 修改知识库的名称 / 简介 / 切分参数 / 推荐问题设置。**各项都可选**，只传要改的那个
 * （传 `{ description: '' }` 是清空简介；`{ suggested_model_pk: '' }` 是"跟随对话模型"）。
 *
 * 切分参数（v17）只影响**之后摄入**的文档：已切好的块不会自己变，
 * 所以界面要提示"已有文档需要重新摄入"。推荐问题设置（v19）不同，**立刻生效**。
 */
export function updateKnowledgeBase(
  kbId: string,
  patch: {
    name?: string
    description?: string
    chunk_size?: number
    chunk_overlap?: number
    suggested_enabled?: boolean
    suggested_count?: number
    suggested_model_pk?: string | null
    suggested_prompt?: string
  },
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

/**
 * 后端默认值（`services/chunking.py` 的 `DEFAULT_CHUNK_SIZE` / `DEFAULT_OVERLAP`）。
 * 界面上它有两个用处：新建弹窗的初值，以及滑杆轨道上那个「默认」刻度点。
 * 两处都从这里取——写死在两个组件里，迟早有一个忘了改。
 */
export const CHUNK_DEFAULT_SIZE = 512
export const CHUNK_DEFAULT_OVERLAP = 64

/**
 * 滑杆轨道上的刻度点（常用值）。`primary` = 默认值，画成强调色。
 *
 * 放这里而不是各自的组件里：新建弹窗与知识库设置用的是**同两个参数**，
 * 刻度给得不一样会让人以为它们是两回事。越界的点由 `RangeField` 丢掉——
 * 重叠的上限跟着块长走，块长调小时 128/256 必须自动消失。
 *
 * 两块长都**不标最小值**（128 / 0 那种）：线性轴上 128 与 256 只差 6.7%，
 * 新建弹窗（轨道约 400px）里两个数值标签只剩 3px 间隙，挤成一团；
 * 而轴的两端本来就是"范围"，说明文字里已经写了。最大值可以标——它离前一个点足够远。
 */
export const CHUNK_SIZE_MARKS: { value: number; primary?: boolean }[] = [
  { value: 256 },
  { value: CHUNK_DEFAULT_SIZE, primary: true },
  { value: 1024 },
  { value: CHUNK_SIZE_MAX },
]

export const CHUNK_OVERLAP_MARKS: { value: number; primary?: boolean }[] = [
  { value: 0 },
  { value: 32 },
  { value: CHUNK_DEFAULT_OVERLAP, primary: true },
  { value: 128 },
  { value: 256 },
]

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

/**
 * 分段问题生成的可用区间与默认值。**与后端 `services/suggested_questions.py`
 * 的常量一一对应**（那里是权威，这里只是让用户当场看到中文原因）。
 *
 * `SUGGESTED_COUNT_*` 指的是**每个分段生成几条**（v23 起；v22 时曾是"空状态显示几条"）。
 */
export const SUGGESTED_COUNT_MIN = 1
export const SUGGESTED_COUNT_MAX = 5
export const SUGGESTED_COUNT_DEFAULT = 3
export const SUGGESTED_PROMPT_MAX_CHARS = 2000
