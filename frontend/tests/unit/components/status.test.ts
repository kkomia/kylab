import { describe, expect, it } from 'vitest'

import { documentStageView, taskKindLabel, taskStateView } from '@/components/ui/status'

describe('documentStageView', () => {
  it('覆盖架构 §4 的整条流水线', () => {
    const stages = [
      'uploaded',
      'probing',
      'parsing',
      'parsed',
      'chunking',
      'chunked',
      'embedding',
      'indexed',
      'enriching',
      'enriched',
      'failed',
    ] as const

    for (const stage of stages) {
      const view = documentStageView(stage)
      expect(view.label, `${stage} 缺少中文文案`).not.toBe(stage)
      expect(view.label.length).toBeGreaterThan(0)
    }
  })

  it('只有终态与失败用语义色，中间态保持信息色', () => {
    expect(documentStageView('indexed').tone).toBe('success')
    expect(documentStageView('enriched').tone).toBe('success')
    expect(documentStageView('failed').tone).toBe('danger')
    expect(documentStageView('parsing').tone).toBe('info')
    expect(documentStageView('uploaded').tone).toBe('neutral')
  })

  it('后端新增未知阶段时退化为中性而不是崩掉', () => {
    // 前后端发版不同步是常态：旧前端遇到新阶段要能显示原文
    expect(documentStageView('summarizing')).toEqual({ label: 'summarizing', tone: 'neutral' })
  })
})

describe('taskStateView', () => {
  it('四种状态都有文案与语义色', () => {
    expect(taskStateView('pending')).toEqual({ label: '排队中', tone: 'neutral' })
    expect(taskStateView('running')).toEqual({ label: '执行中', tone: 'info' })
    expect(taskStateView('succeeded')).toEqual({ label: '已完成', tone: 'success' })
    expect(taskStateView('failed')).toEqual({ label: '失败', tone: 'danger' })
  })

  it('未知状态退化为中性', () => {
    expect(taskStateView('cancelled').tone).toBe('neutral')
  })
})

describe('taskKindLabel', () => {
  it('任务类型有中文名，未知类型回显原值', () => {
    expect(taskKindLabel('parse')).toBe('解析')
    expect(taskKindLabel('embed')).toBe('向量化')
    expect(taskKindLabel('delete')).toBe('delete')
  })
})
