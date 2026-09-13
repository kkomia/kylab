/**
 * 笔记清单（Pinia）。
 *
 * 列表页与编辑器共用同一份数据：新建/删除/改名之后就地在 store 里更新，
 * 不必让两个视图各自再拉一次。标签是列表的过滤维度，与笔记一起维护。
 */

import { defineStore } from 'pinia'

import {
  attachNote,
  createNote,
  deleteNote,
  getNote,
  listNoteTags,
  listNotes,
  updateNote,
  type Note,
  type NoteListItem,
  type NotePayload,
  type NoteTag,
  type NoteUpdate,
} from '@/api/notes'

interface State {
  items: NoteListItem[]
  tags: NoteTag[]
  total: number
  loading: boolean
  error: string
  /** 当前过滤条件：列表与刷新共用。 */
  query: string
  activeTag: string
}

/** 把 Markdown 压成列表用的一句预览（与后端 `_preview` 同一口径）。 */
function plainPreview(markdown: string): string {
  const lines = markdown
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*+]\s*\[[ xX]\]|[#>]+|[-*+]|\d+[.)])\s*/, '').trim())
    .filter(Boolean)
  const body = lines
    .join(' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|`{1,3}/g, '')
    .trim()
  return body.slice(0, 120) + (body.length > 120 ? '…' : '')
}

/** 列表项由详情记录降级而来（新建/更新后不必整表重取）。 */
function toListItem(note: Note, previous?: NoteListItem): NoteListItem {
  if (previous && previous.updated_at === note.updated_at) {
    return { ...note, content_md: '', preview: previous.preview }
  }
  return { ...note, content_md: '', preview: plainPreview(note.content_md) }
}

export const useNoteStore = defineStore('notes', {
  state: (): State => ({
    items: [],
    tags: [],
    total: 0,
    loading: false,
    error: '',
    query: '',
    activeTag: '',
  }),

  actions: {
    async load(): Promise<void> {
      this.loading = true
      try {
        const result = await listNotes({
          q: this.query || undefined,
          tag: this.activeTag || undefined,
          limit: 100,
        })
        this.items = result.items
        this.total = result.total
        this.error = ''
      } catch (error) {
        this.error = error instanceof Error ? error.message : '笔记加载失败'
      } finally {
        this.loading = false
      }
    },

    async loadTags(): Promise<void> {
      try {
        this.tags = (await listNoteTags()).items
      } catch {
        // 标签是旁路：拿不到就不显示过滤条，不打扰用户
        this.tags = []
      }
    },

    async fetch(noteId: string): Promise<Note> {
      return getNote(noteId)
    },

    async create(payload: NotePayload = {}): Promise<Note> {
      const created = await createNote({ content_md: '', ...payload })
      await Promise.all([this.load(), this.loadTags()])
      return created
    },

    async save(noteId: string, payload: NoteUpdate): Promise<Note> {
      const updated = await updateNote(noteId, payload)
      const index = this.items.findIndex((item) => item.id === noteId)
      if (index >= 0) {
        const next = [...this.items]
        next[index] = toListItem(updated, next[index])
        this.items = next
      }
      return updated
    },

    async remove(noteId: string): Promise<void> {
      await deleteNote(noteId)
      this.items = this.items.filter((item) => item.id !== noteId)
      this.total = Math.max(0, this.total - 1)
      await this.loadTags()
    },

    async attach(noteId: string, kbId: string): Promise<Note> {
      const updated = await attachNote(noteId, kbId)
      const index = this.items.findIndex((item) => item.id === noteId)
      if (index >= 0) {
        const next = [...this.items]
        next[index] = toListItem(updated, next[index])
        this.items = next
      }
      return updated
    },

    async setFilter(query: string, tag: string): Promise<void> {
      this.query = query
      this.activeTag = tag
      await this.load()
    },
  },
})
