/**
 * 笔记域的服务端状态（react-query）。
 *
 * 与旧 Pinia store（`frontend/src/stores/notes.ts`）逐条对应的东西：
 *
 * | 旧 store 的 action | 这里 |
 * | --- | --- |
 * | `load()` | `useNotesList()`——键里带着过滤条件，条件一变自动回源（旧实现手写 `setFilter` → `load`） |
 * | `loadTags()` | `useNoteTags()`（拿不到就当空数组，不打扰用户） |
 * | `create()` | `useCreateNote()`——回填正文缓存 + 让列表与标签失效 |
 * | `save()` | `useSaveNote()`——回填正文缓存 + **就地**改列表项（不整表重取） |
 * | `remove()` | `useDeleteNote()`——删正文缓存 + 就地摘掉那一行 + 标签失效 |
 * | `attach()` | `useAttachNote()`——回填正文缓存 + 就地改列表项 |
 * | `setFilter()` | `useNotesStore().setFilter`（纯 UI 状态），列表键跟着变 |
 *
 * 两条刻意的选择：
 * 1. **保存不 invalidate 列表**：旧实现也是就地改，一次自动保存只发一个 PATCH；
 *    invalidate 会在每次敲字停 800ms 后再补一次列表请求，白白多一份流量；
 * 2. 知识库名册的键**归在 `notes` 命名空间下**（`['notes','kb-options']`）：
 *    它是给"加入知识库"这个下拉用的，与知识库域自己的列表请求不是一份数据口径，
 *    抢同一个键会让两边的 queryFn 互相覆盖。
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'

import { listKnowledgeBases, type KnowledgeBase } from '@/api/knowledgeBases'
import {
  aiTransform,
  attachNote,
  createNote,
  deleteNote,
  listNoteTags,
  listNotes,
  updateNote,
  type Note,
  type NoteAiAction,
  type NoteList,
  type NotePayload,
  type NoteTag,
  type NoteUpdate,
} from '@/api/notes'

import { forgetBody, notesQueryKeys, rememberBody, toListItem } from './store'

/** 列表一次取多少：与旧 `load()` 的 `limit: 100` 一致。 */
const LIST_LIMIT = 100

/** 就地改所有已缓存的列表（不同过滤条件各有一份），不触发请求。 */
function patchLists(client: QueryClient, updater: (list: NoteList) => NoteList): void {
  client.setQueriesData<NoteList>({ queryKey: notesQueryKeys.lists() }, (list) =>
    list ? updater(list) : list,
  )
}

function patchListItem(client: QueryClient, note: Note): void {
  patchLists(client, (list) => ({
    ...list,
    items: list.items.map((item) => (item.id === note.id ? toListItem(note, item) : item)),
  }))
}

export interface NoteFilters {
  q: string
  tag: string
}

export function useNotesList(filters: NoteFilters) {
  return useQuery({
    queryKey: notesQueryKeys.list(filters),
    queryFn: () =>
      listNotes({
        q: filters.q || undefined,
        tag: filters.tag || undefined,
        limit: LIST_LIMIT,
      }),
  })
}

export function useNoteTags() {
  return useQuery<NoteTag[]>({
    queryKey: notesQueryKeys.tags(),
    queryFn: async () => (await listNoteTags()).items,
  })
}

/** 「加入知识库」下拉的候选：所有知识库（按后端返回顺序）。 */
export function useKnowledgeBaseOptions() {
  return useQuery<KnowledgeBase[]>({
    queryKey: notesQueryKeys.knowledgeBases(),
    queryFn: async () => (await listKnowledgeBases()).items,
  })
}

export function useCreateNote() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (payload: NotePayload = {}) => createNote({ content_md: '', ...payload }),
    onSuccess: (created) => {
      rememberBody(client, created)
      // 新建会同时改变列表与标签计数，这两处只能失效重取
      void client.invalidateQueries({ queryKey: notesQueryKeys.lists() })
      void client.invalidateQueries({ queryKey: notesQueryKeys.tags() })
    },
  })
}

export interface SaveNoteInput {
  noteId: string
  payload: NoteUpdate
}

export function useSaveNote() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ noteId, payload }: SaveNoteInput) => updateNote(noteId, payload),
    onSuccess: (updated) => {
      rememberBody(client, updated)
      patchListItem(client, updated)
    },
  })
}

export function useDeleteNote() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (noteId: string) => deleteNote(noteId),
    onSuccess: (_result, noteId) => {
      forgetBody(client, noteId)
      patchLists(client, (list) => ({
        ...list,
        items: list.items.filter((item) => item.id !== noteId),
        total: Math.max(0, list.total - 1),
      }))
      void client.invalidateQueries({ queryKey: notesQueryKeys.tags() })
    },
  })
}

export interface AttachNoteInput {
  noteId: string
  kbId: string
}

export function useAttachNote() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ noteId, kbId }: AttachNoteInput) => attachNote(noteId, kbId),
    onSuccess: (updated) => {
      rememberBody(client, updated)
      patchListItem(client, updated)
    },
  })
}

export interface AiTransformInput {
  noteId: string
  action: NoteAiAction
}

export function useAiTransform() {
  return useMutation({
    mutationFn: ({ noteId, action }: AiTransformInput) => aiTransform(noteId, action),
  })
}
