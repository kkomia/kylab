/**
 * 分段进度的展示口径（§12.115）。
 *
 * 这一层最要紧的两件事：
 *
 * 1. **不给百分比**——"第 3/6 步 · 解析内容"是能对上的信息，百分比对不上；
 * 2. **失败/停滞/重试要说得出区别**——光有进度条看不出"它已经死了"，
 *    而"停下来"与"卡住不动"该做的事完全不同。
 */
import { describe, expect, it } from 'vitest'

import type { DocumentProgress } from '@/api/documents'
import {
  progressCaption,
  progressSegments,
  progressTone,
  showsProgress,
} from '@/composables/useProgress'

function makeProgress(overrides: Partial<DocumentProgress> = {}): DocumentProgress {
  return {
    status: 'running',
    step_index: 3,
    step_total: 6,
    step_label: '解析内容',
    elapsed_ms: 134_000,
    total_ms: 200_000,
    retries: 0,
    stalled: false,
    ...overrides,
  }
}

describe('progressSegments', () => {
  it('每段一个槽：走过的填满、当前段上色、还没到的留空', () => {
    const segments = progressSegments(makeProgress())

    expect(segments).toHaveLength(6)
    // 前两步走过
    expect(segments.slice(0, 2).map((item) => item.fill)).toEqual([1, 1])
    // 当前这一步：填满但不是"完成色"
    expect(segments[2].fill).toBe(1)
    expect(segments[2].tone).toBe('info')
    expect(segments[2].pulsing).toBe(true)
    // 后面三步留空槽——**必须留着**，"共 6 段"这个数是信息
    expect(segments.slice(3).map((item) => item.fill)).toEqual([0, 0, 0])
    expect(segments.slice(3).map((item) => item.tone)).toEqual(['neutral', 'neutral', 'neutral'])
  })

  it('失败的文档只有停下的那一步是红的', () => {
    // 全红就看不出炸在哪一步了
    const segments = progressSegments(
      makeProgress({ status: 'failed', step_index: 3, step_label: '解析内容' }),
    )

    expect(segments[2].tone).toBe('danger')
    expect(segments[0].tone).toBe('accent')
    expect(segments[1].tone).toBe('accent')
  })

  it('停滞单独一档色：它和"失败"要区分的正是"有没有人在处理"', () => {
    expect(progressTone(makeProgress({ stalled: true }))).toBe('danger')
    expect(progressTone(makeProgress({ status: 'failed' }))).toBe('danger')
    expect(progressTone(makeProgress({ status: 'canceled' }))).toBe('neutral')
    expect(progressTone(makeProgress())).toBe('info')
  })

  it('没有数据就不画条（不是画一根空条）', () => {
    expect(progressSegments(null)).toEqual([])
    expect(progressSegments(undefined)).toEqual([])
  })
})

describe('progressCaption', () => {
  it('跑着的文档给"第几步 + 环节名 + 已用多久"', () => {
    expect(progressCaption(makeProgress())).toBe('第 3/6 步 · 解析内容 · 已用 2 分 14 秒')
  })

  it('跑完的文档改说总耗时', () => {
    const caption = progressCaption(
      makeProgress({ status: 'done', step_index: 6, step_label: '完成索引' }),
    )

    expect(caption).toBe('第 6/6 步 · 完成索引 · 共 3 分 20 秒')
  })

  it('停滞要说清"没有 worker 在处理"，而不是只标个红', () => {
    expect(progressCaption(makeProgress({ stalled: true }))).toContain('疑似卡住')
    expect(progressCaption(makeProgress({ stalled: true }))).toContain('没有 worker')
  })

  it('失败说"失败于这一步"——用户要找的是哪一步', () => {
    const caption = progressCaption(makeProgress({ status: 'failed' }))

    expect(caption).toContain('失败于这一步')
    expect(caption).toContain('第 3/6 步')
  })

  it('重试过的要在文字里露头', () => {
    expect(progressCaption(makeProgress({ retries: 2 }))).toContain('已重试 2 次')
    // 没重试过就不提，免得每行都挂一句
    expect(progressCaption(makeProgress({ retries: 0 }))).not.toContain('重试')
  })

  it('没有进度时给空串，不编一句话出来', () => {
    expect(progressCaption(null)).toBe('')
  })
})

describe('showsProgress', () => {
  it('只在还没跑完的文档上显示', () => {
    // 跑完的每段都满，画出来是噪声；而"每篇都多一行"正是上一轮的抱怨
    expect(showsProgress(makeProgress())).toBe(true)
    expect(showsProgress(makeProgress({ status: 'failed' }))).toBe(true)
    expect(showsProgress(makeProgress({ status: 'canceled' }))).toBe(true)
    expect(showsProgress(makeProgress({ status: 'done' }))).toBe(false)
    expect(showsProgress(null)).toBe(false)
  })
})
