import { describe, expect, it } from 'vitest'

import {
  documentStageView,
  isTaskProblem,
  taskHealthTone,
  taskKindLabel,
  taskStateView,
} from '@/components/ui/status'

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

/**
 * 健康判据的语义色（M7 / T7.4）。
 *
 * 这一组的分工是：**状态列说"发生了什么"，健康列说"要不要管"**。
 * 所以 `done` 必须是中性色——它同时覆盖"已完成""已取消""已失败"三种终态，
 * 给成功色会让失败任务在列表里显得一切正常。
 */
describe('taskHealthTone', () => {
  it('五种健康值都有语义色', () => {
    expect(taskHealthTone('running')).toBe('info')
    expect(taskHealthTone('stalled')).toBe('danger')
    expect(taskHealthTone('overdue')).toBe('warning')
    expect(taskHealthTone('idle')).toBe('neutral')
  })

  it('done 必须是中性色，不能是成功色', () => {
    // done 里混着"已失败"。给 success 的话，失败任务在列表上看着一切正常，
    // 而健康列正是用来扫"有没有事"的那一列
    expect(taskHealthTone('done')).toBe('neutral')
    // 踩住这个坑：真正区分成败的是状态列
    expect(taskStateView('failed').tone).toBe('danger')
  })

  it('后端新增健康值时退化为中性而不是崩掉', () => {
    expect(taskHealthTone('degraded')).toBe('neutral')
  })
})

describe('isTaskProblem', () => {
  it('只有卡住与逾期需要用户做点什么', () => {
    expect(isTaskProblem('stalled')).toBe(true)
    expect(isTaskProblem('overdue')).toBe(true)
    // 这两个都不需要动手：一个在正常跑、一个刚排上队
    expect(isTaskProblem('running')).toBe(false)
    expect(isTaskProblem('idle')).toBe(false)
    // 终态也不需要——该发生的已经发生了（失败的原因在详情里看）
    expect(isTaskProblem('done')).toBe(false)
  })
})
