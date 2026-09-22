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

/**
 * 把 Markdown 压成列表用的一句预览（与后端 `_preview` 同一口径）。
 *
 * 导出只为用例：它是纯函数，但**每次自动保存都会重算一遍预览**
 * （`save` → `toListItem`），口径错了界面上立刻看得见。
 */
export function plainPreview(markdown: string): string {
  const lines = markdown
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*+]\s*\[[ xX]\]|[#>]+|[-*+]|\d+[.)])\s*/, '').trim())
    .filter(Boolean)
  const body = lines
    .join(' ')
    // 图片连同**尺寸后缀**一起丢掉（`![alt](src){width=460}`，见
    // components/notes/noteImage.ts）：只丢图片语法的话，预览里会剩下 `{width=460}`
    .replace(/!\[[^\]]*\]\([^)]*\)(?:\{width=\d+(?:\s+height=\d+)?\})?/g, '')
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

/**
 * 列表里"最新的一条"是哪个。
 *
 * 取 `updated_at` 最大的那条，而**不是列表里的第一条**：列表按"置顶优先"排，
 * 第一条可能是很久以前置顶的旧笔记，而"点进笔记菜单看到最新内容"要的是时间意义上的最新。
 */
export function latestNoteId(items: NoteListItem[]): string {
  let best: NoteListItem | null = null
  for (const item of items) {
    if (best === null || (item.updated_at ?? '') > (best.updated_at ?? '')) best = item
  }
  return best?.id ?? ''
}

/** 正在飞的那次列表请求：列表页挂载与"默认打开最新"几乎同时触发 `load()`。 */
let inflightLoad: Promise<void> | null = null

/**
 * 正文缓存：切换笔记时**直接拿本地这份画出来**，不再等一个往返。
 *
 * 列表接口刻意不带正文（只给预览），所以"点一条笔记"必然要请求详情。
 * 局域网/远程访问时这个往返肉眼可见，而它换来的内容用户十有八九刚看过或马上要回来。
 * 于是这里做一层短 TTL 缓存：
 * - 鼠标移到列表项上就先取（`prefetch`）——从 hover 到点击通常有百来毫秒，够它落地；
 * - 命中缓存时同步渲染，零等待；未命中才走网络。
 *
 * 为什么带 TTL 而不是永久缓存：正文可能被另一个标签页改掉，
 * 60 秒是"切换手感"与"看到别处改动"之间的折中；超过 TTL 一律回源。
 * 缓存同时是**本地编辑的兜底**：离开一条笔记时把它当时的正文写进来，
 * 所以"改完立刻切走再切回来"不会看到旧版本。
 */
export interface NoteBody {
  id: string
  title: string
  content_md: string
  tags: string[]
  pinned: boolean
  kb_id: string | null
  doc_id: string | null
  updated_at: string | null
}

const BODY_TTL_MS = 60_000
const bodyCache = new Map<string, { body: NoteBody; at: number }>()
const inflightBody = new Map<string, Promise<Note>>()

/** 测试用：清掉正文缓存，免得用例之间互相污染。 */
export function clearNoteBodyCache(): void {
  bodyCache.clear()
  inflightBody.clear()
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
      if (inflightLoad !== null) return inflightLoad
      this.loading = true
      inflightLoad = (async () => {
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
          inflightLoad = null
        }
      })()
      return inflightLoad
    },

    async loadTags(): Promise<void> {
      try {
        this.tags = (await listNoteTags()).items
      } catch {
        // 标签是旁路：拿不到就不显示过滤条，不打扰用户
        this.tags = []
      }
    },

    /** 取缓存里那条正文；没有或过期返回 null。**同步**，用于切换时立刻上屏。 */
    cached(noteId: string): NoteBody | null {
      const hit = bodyCache.get(noteId)
      if (!hit) return null
      if (Date.now() - hit.at > BODY_TTL_MS) {
        bodyCache.delete(noteId)
        return null
      }
      return hit.body
    },

    /** 把一份正文放进缓存（离开笔记时的本地兜底、保存成功后的回填都走这里）。 */
    remember(body: NoteBody): void {
      bodyCache.set(body.id, { body, at: Date.now() })
    },

    /**
     * 后台预取一条笔记的正文（列表项 hover / 按下时调）。
     *
     * 只填缓存，不改任何界面状态；已经在飞或已有新鲜缓存就复用/跳过——
     * 否则鼠标扫过列表会打出一串请求。
     *
     * 返回取到的笔记（供调用方接着做别的预热，比如提前解析文档），
     * 失败返回 null——预取是尽力而为，真正需要时 `fetch` 会再取一次。
     */
    async prefetch(noteId: string): Promise<Note | null> {
      const fresh = this.cached(noteId)
      if (fresh) return fresh as Note
      const existing = inflightBody.get(noteId)
      if (existing) return existing.catch(() => null)
      const task = getNote(noteId)
        .then((note) => {
          this.remember(note)
          return note
        })
        .finally(() => {
          inflightBody.delete(noteId)
        })
      // 显式挂一个 catch，免得"预取失败"变成 unhandled rejection
      task.catch(() => undefined)
      inflightBody.set(noteId, task)
      return task.catch(() => null)
    },

    async fetch(noteId: string): Promise<Note> {
      const pending = inflightBody.get(noteId)
      if (pending) {
        try {
          return await pending
        } catch {
          // 预取失败：回落到自己发一次
        }
      }
      const note = await getNote(noteId)
      this.remember(note)
      return note
    },

    async create(payload: NotePayload = {}): Promise<Note> {
      const created = await createNote({ content_md: '', ...payload })
      this.remember(created)
      await Promise.all([this.load(), this.loadTags()])
      return created
    },

    async save(noteId: string, payload: NoteUpdate): Promise<Note> {
      const updated = await updateNote(noteId, payload)
      this.remember(updated)
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
      bodyCache.delete(noteId)
      this.items = this.items.filter((item) => item.id !== noteId)
      this.total = Math.max(0, this.total - 1)
      await this.loadTags()
    },

    async attach(noteId: string, kbId: string): Promise<Note> {
      const updated = await attachNote(noteId, kbId)
      this.remember(updated)
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
