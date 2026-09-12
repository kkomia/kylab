/**
 * 笔记接口（对应后端 `/api/v1/notes`）。
 *
 * `content_md` 是唯一事实源：编辑器只负责把它渲染出来再写回去，
 * 因此这里进出的都是 Markdown 字符串，没有任何编辑器专用的 JSON 形状——
 * 换编辑器时这一层不用改。
 */

import { request } from './client'

export type NoteSourceKind = 'manual' | 'chat' | 'clip'

export interface Note {
  id: string
  title: string
  content_md: string
  source_kind: NoteSourceKind
  source_ref: string | null
  /** 「加入知识库」后指向生成的文档；未入库为 null。 */
  kb_id: string | null
  doc_id: string | null
  pinned: boolean
  tags: string[]
  created_at: string | null
  updated_at: string | null
}

export interface NoteListItem extends Note {
  /** 列表项不带正文（后端置空），带一段压平后的预览。 */
  preview: string
}

export interface NoteList {
  items: NoteListItem[]
  total: number
  limit: number
  offset: number
}

export interface NoteTag {
  tag: string
  count: number
}

export interface NotePayload {
  title?: string
  content_md?: string
  source_kind?: NoteSourceKind
  source_ref?: string | null
  tags?: string[]
}

export interface NoteUpdate {
  title?: string
  content_md?: string
  pinned?: boolean
  tags?: string[]
}

export function listNotes(
  options: { q?: string; tag?: string; limit?: number; offset?: number } = {},
): Promise<NoteList> {
  const params = new URLSearchParams()
  if (options.q) params.set('q', options.q)
  if (options.tag) params.set('tag', options.tag)
  if (options.limit) params.set('limit', String(options.limit))
  if (options.offset) params.set('offset', String(options.offset))
  const suffix = params.toString()
  return request<NoteList>(`/notes${suffix ? `?${suffix}` : ''}`)
}

export function getNote(noteId: string): Promise<Note> {
  return request<Note>(`/notes/${noteId}`)
}

export function createNote(payload: NotePayload): Promise<Note> {
  return request<Note>('/notes', { method: 'POST', body: JSON.stringify(payload) })
}

export function updateNote(noteId: string, payload: NoteUpdate): Promise<Note> {
  return request<Note>(`/notes/${noteId}`, { method: 'PATCH', body: JSON.stringify(payload) })
}

export function deleteNote(noteId: string): Promise<void> {
  return request<void>(`/notes/${noteId}`, { method: 'DELETE' })
}

export function listNoteTags(): Promise<{ items: NoteTag[] }> {
  return request<{ items: NoteTag[] }>('/notes/tags')
}

/** 把笔记作为 Markdown 文档加入知识库，返回回填了 `doc_id`/`kb_id` 的笔记。 */
export function attachNote(noteId: string, kbId: string): Promise<Note> {
  return request<Note>(`/notes/${noteId}/attach`, {
    method: 'POST',
    body: JSON.stringify({ kb_id: kbId }),
  })
}
