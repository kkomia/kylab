/**
 * 笔记域的客户端状态（迁移计划 §2「服务端状态 / 客户端状态」）。
 *
 * 分工：
 * - **服务端状态走 react-query**（`queries.ts`）：列表、标签、知识库名册、
 *   详情与所有写操作；键、失效、重试、同键并发去重都是它的事；
 * - **纯 UI 状态走 zustand**：搜索词与当前标签——它们决定列表请求的键，
 *   但要跨挂载周期留着（切走再回来不该把搜索词清掉，旧 Pinia store 就是这么放的）。
 *
 * **正文缓存**照搬旧实现（`frontend/src/stores/notes.ts` 里那层 + 旧用例
 * `tests/unit/stores/notesBodyCache.test.ts` 的六条），键与失效口径一字未改：
 *
 * | 旧实现 | 这里 |
 * | --- | --- |
 * | 模块级 `Map<noteId, {body, at}>` | react-query 缓存，键 `['note', noteId]` |
 * | `BODY_TTL_MS = 60_000`，超时删条目 | 同一个常量 + 用 `dataUpdatedAt` 判过期 |
 * | `remember(body)` 刷新时间戳 | `setQueryData`（同样把时间戳刷新成现在） |
 * | `prefetch` 已在飞就复用、失败不抛 | `fetchQuery`（同键并发去重）失败吞成 null |
 * | 删除笔记时 `bodyCache.delete(id)` | `removeQueries` |
 *
 * 换成 react-query 之后有两条**行为不变但实现更省**的地方：同一键的并发请求由它
 * 原生合并（旧实现手写 `inflightBody`），过期回源由 `staleTime` 兜住（旧实现手写
 * 时间戳比较）——两处都保留在下面的 `cachedBody` / `fetchBody` 里，方便对照。
 */
import type { QueryClient } from '@tanstack/react-query'
import { create } from 'zustand'

import { getNote, type Note, type NoteListItem } from '@/api/notes'

/** 正文缓存的有效期：60 秒（旧实现同一个数）。 */
export const NOTE_BODY_TTL_MS = 60_000

/** 本机偏好：列表是否折叠。不进后端设置——"这台机器怎么显示"换台机器该重选。 */
export const NOTES_LIST_COLLAPSED_STORAGE_KEY = 'kylab-notes-list-collapsed'

/* ------------------------------------------------------------------ 查询键 */

export const notesQueryKeys = {
  all: ['notes'] as const,
  lists: () => [...notesQueryKeys.all, 'list'] as const,
  list: (filters: { q: string; tag: string }) => [...notesQueryKeys.lists(), filters] as const,
  tags: () => [...notesQueryKeys.all, 'tags'] as const,
  /** 正文缓存：**键就是 noteId**（旧实现 `Map` 的 key），不带任何过滤条件。 */
  body: (noteId: string) => ['note', noteId] as const,
  bodies: () => ['note'] as const,
  knowledgeBases: () => ['knowledge-bases'] as const,
}

/* ------------------------------------------------------- 纯函数（导出给用例） */

/**
 * 把 Markdown 压成列表用的一句预览（与后端 `_preview` 同一口径）。
 *
 * 与旧实现逐字一致：**每次自动保存都会重算一遍预览**（`toListItem`），
 * 口径错了界面上立刻看得见。
 */
export function plainPreview(markdown: string): string {
  const lines = markdown
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*+]\s*\[[ xX]\]|[#>]+|[-*+]|\d+[.)])\s*/, '').trim())
    .filter(Boolean)
  const body = lines
    .join(' ')
    // 图片连同**尺寸后缀**一起丢掉（`![alt](src){width=460}`，见 noteImage.ts）：
    // 只丢图片语法的话，预览里会剩下 `{width=460}`
    .replace(/!\[[^\]]*\]\([^)]*\)(?:\{width=\d+(?:\s+height=\d+)?\})?/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|`{1,3}/g, '')
    .trim()
  return body.slice(0, 120) + (body.length > 120 ? '…' : '')
}

/**
 * 列表里"最新的一条"是哪个。
 *
 * 取 `updated_at` 最大的那条，而**不是列表里的第一条**：列表按"置顶优先"排，
 * 第一条可能是很久以前置顶的旧笔记，而"点进笔记菜单看到最新内容"要的是时间意义上的最新。
 */
export function latestNoteId(items: readonly NoteListItem[]): string {
  let best: NoteListItem | null = null
  for (const item of items) {
    if (best === null || (item.updated_at ?? '') > (best.updated_at ?? '')) best = item
  }
  return best?.id ?? ''
}

/**
 * 列表项由详情记录降级而来（新建/更新后不必整表重取）。
 *
 * `updated_at` 没变就沿用上一条的预览：自动保存每次都会重算预览，
 * 而"预览没变"的时候（比如只改了标签）重算一次纯属白干。
 */
export function toListItem(note: Note, previous?: NoteListItem): NoteListItem {
  if (previous && previous.updated_at === note.updated_at) {
    return { ...note, content_md: '', preview: previous.preview }
  }
  return { ...note, content_md: '', preview: plainPreview(note.content_md) }
}

export interface NoteGroup {
  label: string
  items: NoteListItem[]
}

function timeOf(item: NoteListItem): number {
  return item.updated_at ? new Date(item.updated_at).getTime() : 0
}

/**
 * 置顶单独一组，其余按时间分桶——和 ima 的时间线分组同一套读法。
 *
 * 桶内的先后**沿用后端给的顺序**（列表接口是"置顶优先，其次最近更新"），
 * 这里不再排一次：再排一遍只会让"界面顺序"与"服务端顺序"变成两个可以不一致的口径。
 */
export function groupNotes(items: readonly NoteListItem[]): NoteGroup[] {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const day = 86_400_000
  const buckets: NoteGroup[] = []
  const pinned = items.filter((item) => item.pinned)
  if (pinned.length) buckets.push({ label: '置顶', items: pinned })
  const rest = items.filter((item) => !item.pinned)
  const defs: { label: string; test: (at: number) => boolean }[] = [
    { label: '今天', test: (at) => at >= startOfToday },
    { label: '过去 7 天', test: (at) => at >= startOfToday - 6 * day },
    { label: '过去 30 天', test: (at) => at >= startOfToday - 29 * day },
    { label: '更早', test: () => true },
  ]
  const used = new Set<string>()
  for (const def of defs) {
    const bucket = rest.filter((item) => !used.has(item.id) && def.test(timeOf(item)))
    for (const item of bucket) used.add(item.id)
    if (bucket.length) buckets.push({ label: def.label, items: bucket })
  }
  return buckets
}

/**
 * 已落盘内容的指纹。保存前比一次：没改过就不发请求。
 *
 * 切换笔记时原来会无条件 PATCH 一次（哪怕一个字没动），既是一次白写的数据库事务，
 * 也是切换延迟里的一段。存个指纹就能直接把这次往返省掉；它同时承担
 * "装载不是用户改动"的判据（见 NotesView 的自动保存 effect）。
 */
export function snapshotOf(
  item: Pick<NoteBody, 'title' | 'content_md' | 'tags' | 'pinned'>,
): string {
  return `${item.title}\u0000${item.content_md}\u0000${item.tags.join('\u0001')}\u0000${item.pinned ? '1' : '0'}`
}

/** 同一天只给时间；跨天带上日期——否则"已保存 09:12"看不出是哪天的 09:12。 */
export function formatSavedAt(date: Date, now: Date = new Date()): string {
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return sameDay ? `${hh}:${mm}` : `${date.getMonth() + 1}/${date.getDate()} ${hh}:${mm}`
}

/** 列表项的短日期（`3/14`）：列表尾部那一列只放得下这个。 */
export function shortDate(item: NoteListItem): string {
  const at = timeOf(item)
  if (!at) return ''
  const date = new Date(at)
  return `${date.getMonth() + 1}/${date.getDate()}`
}

/* --------------------------------------------------------------- UI 状态 */

interface NotesUiState {
  /** 当前过滤条件：列表与刷新共用（旧 store 的 `query` / `activeTag`）。 */
  query: string
  activeTag: string
  setFilter(query: string, tag: string): void
}

export const useNotesStore = create<NotesUiState>()((set) => ({
  query: '',
  activeTag: '',
  setFilter: (query, tag) => set({ query, activeTag: tag }),
}))

/* ------------------------------------------------------- 正文缓存（服务端） */

/**
 * 缓存里那份正文的形状（旧实现的 `NoteBody`）。
 *
 * 比 `Note` 少几个字段：页面**离开一条笔记时把当前草稿写进缓存**，
 * 那份草稿没有 `source_kind` / `created_at`（编辑器不碰它们），
 * 所以缓存的形状按"编辑器真正读写的那些字段"定，而不是按服务端契约定。
 * 服务端详情（`Note`）天然满足这个形状。
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

/**
 * 同步取缓存里那条正文；没有或过期返回 null。
 *
 * **同步**是这里的全部意义：命中就能零等待上屏，不必等一个往返。
 */
export function cachedBody(client: QueryClient, noteId: string): NoteBody | null {
  const state = client.getQueryState<NoteBody>(notesQueryKeys.body(noteId))
  if (!state?.data) return null
  if (Date.now() - state.dataUpdatedAt > NOTE_BODY_TTL_MS) {
    // 过期即删：留在缓存里只会让下一次 `cached` 再判一次
    client.removeQueries({ queryKey: notesQueryKeys.body(noteId), exact: true })
    return null
  }
  return state.data
}

/** 把一份正文放进缓存（离开笔记时的本地兜底、保存成功后的回填都走这里）。 */
export function rememberBody(client: QueryClient, body: NoteBody): void {
  client.setQueryData(notesQueryKeys.body(body.id), body)
}

/** 删掉一条正文缓存（笔记被删除时）。 */
export function forgetBody(client: QueryClient, noteId: string): void {
  client.removeQueries({ queryKey: notesQueryKeys.body(noteId), exact: true })
}

/** 测试用：清掉正文缓存，免得用例之间互相污染（旧 `clearNoteBodyCache` 同款）。 */
export function clearNoteBodyCache(client: QueryClient): void {
  client.removeQueries({ queryKey: notesQueryKeys.bodies() })
}

/**
 * 后台预取一条笔记的正文（列表项 hover / 按下时调）。
 *
 * 只填缓存，不改任何界面状态；命中新鲜缓存或已在飞就复用，否则鼠标扫过列表会打出
 * 一串请求。**失败返回 null 而不抛**：预取是尽力而为，真正需要时 `fetchBody` 会再取一次。
 */
export async function prefetchBody(client: QueryClient, noteId: string): Promise<NoteBody | null> {
  const fresh = cachedBody(client, noteId)
  if (fresh) return fresh
  try {
    return await client.fetchQuery<NoteBody>({
      queryKey: notesQueryKeys.body(noteId),
      queryFn: () => getNote(noteId),
      staleTime: NOTE_BODY_TTL_MS,
    })
  } catch {
    return null
  }
}

/**
 * 取一条笔记的正文：命中缓存直接返回，未命中或已过期才回源。
 *
 * 与旧 `fetch` 同一条路径：真实的失败要抛出去（页面据此提示并清空编辑区），
 * 所以这里**不吞异常**；重试交给 react-query 的默认策略。
 */
export function fetchBody(client: QueryClient, noteId: string): Promise<NoteBody> {
  return client.fetchQuery<NoteBody>({
    queryKey: notesQueryKeys.body(noteId),
    queryFn: () => getNote(noteId),
    staleTime: NOTE_BODY_TTL_MS,
  })
}

/* ------------------------------------------------------- 本机偏好：折叠 */

/**
 * 读列表折叠偏好。
 *
 * 隐私模式下 localStorage 不可读：退化成"展开"而不是抛错。
 */
export function readListCollapsed(): boolean {
  try {
    return window.localStorage.getItem(NOTES_LIST_COLLAPSED_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * 写列表折叠偏好。
 *
 * 展开态不写 "0" 而是把键清掉：默认值就是展开，别在存储里留一条无意义的状态。
 */
export function writeListCollapsed(collapsed: boolean): void {
  try {
    if (collapsed) window.localStorage.setItem(NOTES_LIST_COLLAPSED_STORAGE_KEY, '1')
    else window.localStorage.removeItem(NOTES_LIST_COLLAPSED_STORAGE_KEY)
  } catch {
    // 存不上就只在本次会话生效
  }
}
