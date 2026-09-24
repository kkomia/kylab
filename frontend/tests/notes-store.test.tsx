/**
 * 笔记域的状态与纯函数。
 *
 * 这是旧前端两个用例文件的合并翻译：
 * - `tests/unit/stores/notesBodyCache.test.ts`——**正文缓存的六条**（命中、TTL、
 *   预取去重、预取失败降级、remember 的本地兜底），键与失效口径一字未改；
 * - `tests/unit/stores/notes.test.ts`——`latestNoteId` 的四条与 `plainPreview` 的两条。
 *
 * 新增的是分组（本页的"排序"）与保存时间格式：它们是页面里唯一还有分支、
 * 又不依赖 DOM 的部分，值得单独钉住。
 */
import { QueryClient } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Note, NoteListItem } from '@/api/notes'

const getNote = vi.fn()

vi.mock('@/api/notes', () => ({
  getNote: (...args: unknown[]) => getNote(...args),
  listNotes: vi.fn(),
  listNoteTags: vi.fn(),
  createNote: vi.fn(),
  updateNote: vi.fn(),
  deleteNote: vi.fn(),
  attachNote: vi.fn(),
  aiTransform: vi.fn(),
  uploadNoteImage: vi.fn(),
}))

import {
  cachedBody,
  clearNoteBodyCache,
  fetchBody,
  formatSavedAt,
  groupNotes,
  latestNoteId,
  plainPreview,
  prefetchBody,
  rememberBody,
  NOTE_BODY_TTL_MS,
} from '@/features/notes/store'

function note(id: string, content = `${id} 的正文`): Note {
  return {
    id,
    title: id,
    content_md: content,
    source_kind: 'manual',
    source_ref: null,
    kb_id: null,
    doc_id: null,
    folder_id: null,
    pinned: false,
    tags: [],
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
  }
}

function item(id: string, updatedAt: string | null, pinned = false): NoteListItem {
  return { ...note(id), updated_at: updatedAt, pinned, content_md: '', preview: '' }
}

function newClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

let client: QueryClient

beforeEach(() => {
  client = newClient()
  clearNoteBodyCache(client)
  getNote.mockReset()
})

describe('笔记正文缓存', () => {
  it('fetch 之后 cached 能同步拿到正文', async () => {
    getNote.mockResolvedValue(note('n1'))

    expect(cachedBody(client, 'n1')).toBeNull()
    await fetchBody(client, 'n1')

    expect(cachedBody(client, 'n1')?.content_md).toBe('n1 的正文')
    expect(getNote).toHaveBeenCalledTimes(1)
  })

  it('超过 TTL 视为未缓存，cached 返回 null 并在下一次回源', async () => {
    vi.useFakeTimers()
    try {
      getNote.mockResolvedValue(note('n1'))
      await fetchBody(client, 'n1')
      expect(cachedBody(client, 'n1')).not.toBeNull()

      vi.advanceTimersByTime(NOTE_BODY_TTL_MS + 1_000)

      expect(cachedBody(client, 'n1')).toBeNull()

      await fetchBody(client, 'n1')
      expect(getNote).toHaveBeenCalledTimes(2)
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

    void prefetchBody(client, 'n1')
    void prefetchBody(client, 'n1') // 已在飞：同一个键，react-query 合并
    expect(getNote).toHaveBeenCalledTimes(1)

    resolve(note('n1'))
    const viaFetch = await fetchBody(client, 'n1') // 复用刚落地的那份

    expect(getNote).toHaveBeenCalledTimes(1)
    expect(cachedBody(client, 'n1')?.content_md).toBe('n1 的正文')
    expect(viaFetch.id).toBe('n1')
  })

  it('prefetch 返回取到的正文，供调用方接着预热文档；命缓存时不再回源', async () => {
    getNote.mockResolvedValue(note('n1'))

    const first = await prefetchBody(client, 'n1')
    const second = await prefetchBody(client, 'n1')

    expect(first?.content_md).toBe('n1 的正文')
    expect(second?.content_md).toBe('n1 的正文')
    expect(getNote).toHaveBeenCalledTimes(1)
  })

  it('prefetch 失败不抛也不缓存，之后 fetch 会回源', async () => {
    getNote.mockRejectedValueOnce(new Error('断网'))

    const failed = await prefetchBody(client, 'n1')
    expect(failed).toBeNull()
    expect(cachedBody(client, 'n1')).toBeNull()

    getNote.mockResolvedValueOnce(note('n1'))
    const fetched = await fetchBody(client, 'n1')
    expect(fetched.id).toBe('n1')
    expect(cachedBody(client, 'n1')?.id).toBe('n1')
  })

  it('remember 放进来的草稿可以立刻被 cached 取回（本地编辑兜底）', () => {
    rememberBody(client, { ...note('n1'), content_md: '刚敲了一半' })

    expect(cachedBody(client, 'n1')?.content_md).toBe('刚敲了一半')
  })
})

describe('latestNoteId', () => {
  it('取更新时间最新的一条，而不是列表第一条', () => {
    // 列表里置顶的旧笔记排第一——"最新"不该被置顶带偏
    const items = [
      item('pinned-old', '2026-01-01T00:00:00Z', true),
      item('new', '2026-09-13T00:00:00Z'),
    ]

    expect(latestNoteId(items)).toBe('new')
  })

  it('空列表返回空串（调用方据此显示空态）', () => {
    expect(latestNoteId([])).toBe('')
  })

  it('没有 updated_at 的条目不会被当成最新', () => {
    expect(latestNoteId([item('no-time', null), item('has-time', '2020-01-01T00:00:00Z')])).toBe(
      'has-time',
    )
  })

  it('更新时间相同时保持稳定（取先遇到的那条）', () => {
    const items = [item('a', '2026-09-13T00:00:00Z'), item('b', '2026-09-13T00:00:00Z')]
    expect(latestNoteId(items)).toBe('a')
  })
})

describe('plainPreview', () => {
  it('配图连尺寸后缀一起丢掉，预览里不漏出 {width=…}', () => {
    // 正文里的样子来自编辑器拖拽缩放（见 noteImage.ts）
    const body = [
      '看图',
      '',
      '![图](/api/v1/notes/n1/images/a.png?expires=1&signature=x){width=460}',
      '',
      '图后面的正文',
    ].join('\n')

    const preview = plainPreview(body)

    expect(preview).not.toContain('{width')
    expect(preview).not.toContain('images/a.png')
    expect(preview).toContain('看图')
    expect(preview).toContain('图后面的正文')
  })

  it('没有尺寸的普通配图照旧丢掉；Markdown 记号被压平', () => {
    const preview = plainPreview(
      '## 小标题\n\n- 一\n- 二\n\n![图](https://example.test/a.png)\n\n**粗**',
    )
    expect(preview).not.toContain('example.test')
    expect(preview).not.toContain('#')
    expect(preview).not.toContain('**')
    expect(preview).toContain('小标题')
    expect(preview).toContain('一 二')
  })
})

describe('列表分组（排序口径）', () => {
  it('置顶单独一组，其余按今天 / 过去 7 天 / 过去 30 天 / 更早分桶', () => {
    const now = new Date()
    const at = (daysAgo: number): string => {
      const date = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12)
      date.setDate(date.getDate() - daysAgo)
      return date.toISOString()
    }
    const groups = groupNotes([
      item('pin', at(400), true),
      item('today', at(0)),
      item('week', at(3)),
      item('month', at(10)),
      item('old', at(90)),
      item('no-time', null),
    ])

    expect(groups.map((group) => group.label)).toEqual([
      '置顶',
      '今天',
      '过去 7 天',
      '过去 30 天',
      '更早',
    ])
    expect(groups[0].items.map((entry) => entry.id)).toEqual(['pin'])
    expect(groups[1].items.map((entry) => entry.id)).toEqual(['today'])
    expect(groups[2].items.map((entry) => entry.id)).toEqual(['week'])
    expect(groups[3].items.map((entry) => entry.id)).toEqual(['month'])
    // 没有时间的条目落进"更早"：它排不进任何一个真实区间
    expect(groups[4].items.map((entry) => entry.id)).toEqual(['old', 'no-time'])
  })

  it('每条只出现在一个桶里；一条都没有时返回空数组', () => {
    const groups = groupNotes([item('a', new Date().toISOString())])
    expect(groups).toHaveLength(1)
    expect(groups[0].items).toHaveLength(1)
    expect(groupNotes([])).toEqual([])
  })
})

describe('已保存时间', () => {
  it('同一天只给时间，跨天带上日期', () => {
    const now = new Date(2026, 8, 23, 15, 0)
    expect(formatSavedAt(new Date(2026, 8, 23, 9, 12), now)).toBe('09:12')
    expect(formatSavedAt(new Date(2026, 8, 20, 9, 12), now)).toBe('9/20 09:12')
  })
})
