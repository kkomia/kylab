/**
 * 文档接口（对应后端 /api/v1/knowledge-bases/{kb}/documents 与 /documents/{id}）。
 *
 * `stage` 是后端流水线状态机（架构 §4），前端只做展示映射，不自己发明状态值。
 */

import { request, upload } from './client'

export type DocumentStage =
  | 'uploaded'
  | 'probing'
  | 'parsing'
  | 'parsed'
  | 'chunking'
  | 'chunked'
  | 'embedding'
  | 'indexed'
  | 'enriching'
  | 'enriched'
  | 'failed'

export type DataSourceKind = 'upload' | 'directory' | 'webdav' | 'html' | 'rss'

export interface DocumentSummary {
  id: string
  knowledge_base_id: string
  name: string
  source_kind: DataSourceKind
  stage: DocumentStage
  size_bytes: number
  mime_type: string | null
  page_count: number | null
  is_split: boolean
  error: string | null
  chunk_count: number
  created_at: string | null
  updated_at: string | null
}

export interface DocumentPart {
  id: string
  part_index: number
  page_start: number
  page_end: number
  stage: DocumentStage
  error: string | null
}

export interface DocumentChunk {
  chunk_id: string
  document_id: string
  ordinal: number
  text: string
  heading_path: string | null
  page: number | null
  image_ids: string[]
}

export interface ChunkList {
  items: DocumentChunk[]
  /** 该文档的切块总数；`items` 可能被 limit 截断，界面必须能说清"这是前 N 块"。 */
  total: number
}

export interface UploadAccepted {
  document: DocumentSummary
  is_duplicate: boolean
  task_id: string | null
}

export function listDocuments(kbId: string): Promise<{ items: DocumentSummary[] }> {
  return request(`/knowledge-bases/${kbId}/documents`)
}

export function getDocument(documentId: string): Promise<DocumentSummary> {
  return request(`/documents/${documentId}`)
}

export function listDocumentParts(documentId: string): Promise<{ items: DocumentPart[] }> {
  return request(`/documents/${documentId}/parts`)
}

/** 切块正文（文档详情页的预览）。limit 只截断 items，total 始终是全量。 */
export function listDocumentChunks(documentId: string, limit = 5): Promise<ChunkList> {
  return request(`/documents/${documentId}/chunks?limit=${limit}`)
}

export function uploadDocument(kbId: string, file: File): Promise<UploadAccepted> {
  return upload(`/knowledge-bases/${kbId}/documents`, file)
}

export function reprocessDocument(documentId: string): Promise<UploadAccepted> {
  return request(`/documents/${documentId}/reprocess`, { method: 'POST' })
}
