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
 * | 文件夹（v14，无旧实现） | `useNoteFolders()` / `useCreateNoteFolder()` / `useRenameNoteFolder()` / `useMoveNoteFolder()` / `useDeleteNoteFolder()` / `useMoveNote()` |
 *
 * 三处刻意的选择：
 * 1. **保存不 invalidate 列表**：旧实现也是就地改，一次自动保存只发一个 PATCH；
 *    invalidate 会在每次敲字停 800ms 后再补一次列表请求，白白多一份流量；
 * 2. 知识库名册的键**归在 `notes` 命名空间下**（`['notes','kb-options']`）：
 *    它是给"加入知识库"这个下拉用的，与知识库域自己的列表请求不是一份数据口径，
 *    抢同一个键会让两边的 queryFn 互相覆盖；
 * 3. **移动笔记与增删文件夹整片失效**（不就地改）：它们改的是"这条笔记属于哪个筛选"，
 *    而就地改只能改列表里那一行、改不掉"它该不该出现在这个列表里"。
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'

import { listKnowledgeBases, type KnowledgeBase } from '@/api/knowledgeBases'
import {
  aiTransform,
  attachNote,
  createNote,
  createNoteFolder,
  deleteNote,
  deleteNoteFolder,
  listNoteFolders,
  listNoteTags,
  listNotes,
  moveNote,
  moveNoteFolder,
  renameNoteFolder,
  updateNote,
  type Note,
  type NoteAiAction,
  type NoteFolder,
  type NoteFolderList,
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
  folder: string
}

export function useNotesList(filters: NoteFilters) {
  return useQuery({
    queryKey: notesQueryKeys.list(filters),
    queryFn: () =>
      listNotes({
        q: filters.q || undefined,
        tag: filters.tag || undefined,
        // `''`（全部）不带这个参数；其余取值原样传给后端（含 `unfiled` 哨兵）
        folder: filters.folder || undefined,
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

/** 文件夹树 + 三个数字（未归档 / 总数）。 */
export function useNoteFolders() {
  return useQuery<NoteFolderList>({
    queryKey: notesQueryKeys.folders(),
    queryFn: listNoteFolders,
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

/* ------------------------------------------------------------------ 文件夹（v14） */

export interface CreateFolderInput {
  name: string
  /** 建在哪个文件夹下（"新建子文件夹"）；留空 = 根级。 */
  parentId?: string | null
}

/** 建/改名/换位置：三者的响应都只是"这棵树变了"，统一按"整棵树失效重取"。 */
function useFolderMutation<Input>(
  mutationFn: (input: Input) => Promise<NoteFolder>,
  after?: (client: QueryClient, result: NoteFolder, input: Input) => void,
) {
  const client = useQueryClient()
  return useMutation({
    mutationFn,
    onSuccess: (result, input) => {
      // 树上的**条数**也要重新算：建/改名/换位置后面板上的数字都会变
      void client.invalidateQueries({ queryKey: notesQueryKeys.folders() })
      after?.(client, result, input)
    },
  })
}

export function useCreateNoteFolder() {
  return useFolderMutation((input: CreateFolderInput) =>
    createNoteFolder({ name: input.name, parent_id: input.parentId ?? null }),
  )
}

export interface RenameFolderInput {
  folderId: string
  name: string
}

export function useRenameNoteFolder() {
  return useFolderMutation((input: RenameFolderInput) =>
    renameNoteFolder(input.folderId, input.name),
  )
}

export interface MoveFolderInput {
  folderId: string
  /** 目标父级；null = 挪回根级。 */
  parentId: string | null
}

export function useMoveNoteFolder() {
  return useFolderMutation((input: MoveFolderInput) =>
    moveNoteFolder(input.folderId, input.parentId),
  )
}

export function useDeleteNoteFolder() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (folderId: string) => deleteNoteFolder(folderId),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: notesQueryKeys.folders() })
      // 子树里的笔记回到了未归档：**所有**列表都可能变（正选着这个文件夹时列表会
      // 直接空掉——那正是必须重取的原因），所以整片失效而不是就地改一行。
      // "当前选中的文件夹被删掉了，退回全部"是页面自己的收尾（只有它知道选中的是谁）。
      void client.invalidateQueries({ queryKey: notesQueryKeys.lists() })
    },
  })
}

export interface MoveNoteInput {
  noteId: string
  /** 目标文件夹；null = 移回未归档。 */
  folderId: string | null
}

export function useMoveNote() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ noteId, folderId }: MoveNoteInput) => moveNote(noteId, folderId),
    onSuccess: (updated) => {
      rememberBody(client, updated)
      // 归属变了 → 当前这个筛选里它就未必还在：整片列表失效重取，
      // 而不是就地改（就地改会把移出去的笔记留在"这个文件夹"的列表里）
      void client.invalidateQueries({ queryKey: notesQueryKeys.lists() })
      // 两个文件夹的条数都变了
      void client.invalidateQueries({ queryKey: notesQueryKeys.folders() })
    },
  })
}
