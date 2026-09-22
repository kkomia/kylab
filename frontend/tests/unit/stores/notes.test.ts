import { describe, expect, it } from 'vitest'

import type { NoteListItem } from '@/api/notes'
import { latestNoteId, plainPreview } from '@/stores/notes'

function item(id: string, updatedAt: string | null, pinned = false): NoteListItem {
  return {
    id,
    title: id,
    content_md: '',
    source_kind: 'manual',
    source_ref: null,
    kb_id: null,
    doc_id: null,
    pinned,
    tags: [],
    created_at: null,
    updated_at: updatedAt,
    preview: '',
  }
}

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
    const items = [item('no-time', null), item('has-time', '2020-01-01T00:00:00Z')]

    expect(latestNoteId(items)).toBe('has-time')
  })

  it('更新时间相同时保持稳定（取先遇到的那条）', () => {
    const items = [item('a', '2026-09-13T00:00:00Z'), item('b', '2026-09-13T00:00:00Z')]

    expect(latestNoteId(items)).toBe('a')
  })
})

describe('plainPreview', () => {
  it('配图连尺寸后缀一起丢掉，预览里不漏出 {width=…}', () => {
    // 正文里的样子来自编辑器拖拽缩放（见 components/notes/noteImage.ts）
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

  it('没有尺寸的普通配图照旧丢掉', () => {
    expect(plainPreview('前\n\n![图](https://example.test/a.png)\n\n后')).not.toContain(
      'example.test',
    )
  })
})
