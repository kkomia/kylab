/**
 * 笔记正文缓存与预取。
 *
 * 这层是"切换笔记要跟手"的关键：列表接口不带正文，命中缓存就能同步上屏、
 * 不等网络。用例钉住三件事——缓存能命中、有 TTL、预取不会重复打请求。
 */
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Note } from '@/api/notes'

const getNote = vi.fn()
const listNotes = vi.fn()
const listNoteTags = vi.fn()

vi.mock('@/api/notes', () => ({
  getNote: (...args: unknown[]) => getNote(...args),
  listNotes: (...args: unknown[]) => listNotes(...args),
  listNoteTags: (...args: unknown[]) => listNoteTags(...args),
  createNote: vi.fn(),
  updateNote: vi.fn(),
  deleteNote: vi.fn(),
  attachNote: vi.fn(),
}))

import { clearNoteBodyCache, useNoteStore } from '@/stores/notes'

function note(id: string, content = `${id} 的正文`): Note {
  return {
    id,
    title: id,
    content_md: content,
    source_kind: 'manual',
    source_ref: null,
    kb_id: null,
    doc_id: null,
    pinned: false,
    tags: [],
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
  }
}

describe('笔记正文缓存', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    clearNoteBodyCache()
    getNote.mockReset()
    listNotes.mockReset()
    listNoteTags.mockReset()
  })

  it('fetch 之后 cached 能同步拿到正文', async () => {
    getNote.mockResolvedValue(note('n1'))
    const store = useNoteStore()

    expect(store.cached('n1')).toBeNull()
    await store.fetch('n1')

    expect(store.cached('n1')?.content_md).toBe('n1 的正文')
    expect(getNote).toHaveBeenCalledTimes(1)
  })

  it('超过 TTL 视为未缓存，cached 返回 null', async () => {
    vi.useFakeTimers()
    try {
      getNote.mockResolvedValue(note('n1'))
      const store = useNoteStore()
      await store.fetch('n1')
      expect(store.cached('n1')).not.toBeNull()

      vi.advanceTimersByTime(61_000)

      expect(store.cached('n1')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('prefetch 只打一次请求，重复调用与随后的 fetch 都不再回源', async () => {
    let resolve!: (value: Note) => void
    getNote.mockReturnValue(
      new Promise<Note>((res) => {
        resolve = res
      }),
    )
    const store = useNoteStore()

    store.prefetch('n1')
    store.prefetch('n1') // 已在飞：跳过
    expect(getNote).toHaveBeenCalledTimes(1)

    resolve(note('n1'))
    const viaFetch = await store.fetch('n1') // 复用同一个在飞的请求

    expect(getNote).toHaveBeenCalledTimes(1)
    expect(store.cached('n1')?.content_md).toBe('n1 的正文')
    expect(viaFetch.id).toBe('n1')
  })

  it('prefetch 返回取到的笔记，供调用方接着预热文档；命缓存时不再回源', async () => {
    getNote.mockResolvedValue(note('n1'))
    const store = useNoteStore()

    const first = await store.prefetch('n1')
    const second = await store.prefetch('n1')

    expect(first?.content_md).toBe('n1 的正文')
    expect(second?.content_md).toBe('n1 的正文')
    expect(getNote).toHaveBeenCalledTimes(1)
  })

  it('prefetch 失败不抛也不缓存，之后 fetch 会回源', async () => {
    getNote.mockRejectedValueOnce(new Error('断网'))
    const store = useNoteStore()

    store.prefetch('n1')
    await Promise.resolve()
    await Promise.resolve()

    expect(store.cached('n1')).toBeNull()

    getNote.mockResolvedValueOnce(note('n1'))
    const fetched = await store.fetch('n1')
    expect(fetched.id).toBe('n1')
    expect(store.cached('n1')?.id).toBe('n1')
  })

  it('remember 放进来的草稿可以立刻被 cached 取回（本地编辑兜底）', () => {
    const store = useNoteStore()
    store.remember({ ...note('n1'), content_md: '刚敲了一半' })

    expect(store.cached('n1')?.content_md).toBe('刚敲了一半')
  })
})
