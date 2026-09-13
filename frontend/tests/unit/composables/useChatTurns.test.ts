import { describe, expect, it } from 'vitest'

import type { ChatSource, ChatStep } from '@/api/chat'
import {
  buildTurns,
  documentTarget,
  isTraceOpen,
  makeMessage,
  mergeStep,
  sourcePreview,
  sourceWhere,
  THINKING_EFFORTS,
  traceSteps,
  traceSummary,
  type Message,
  type ThinkingEffort,
} from '@/composables/useChatTurns'

function source(index: number, extra: Partial<ChatSource> = {}): ChatSource {
  return {
    index,
    chunk_id: `c${index}`,
    document_id: `d${index}`,
    document_name: `文档${index}.pdf`,
    heading_path: null,
    page: null,
    score: 0.5,
    preview: '原文片段',
    knowledge_base_id: 'kb1',
    ...extra,
  }
}

function message(role: Message['role'], extra: Partial<Message> = {}): Message {
  return makeMessage(role, '', extra)
}

function step(phase: string, extra: Partial<ChatStep> = {}): ChatStep {
  return { phase, label: phase, detail: '', status: 'done', ...extra }
}

describe('buildTurns', () => {
  it('把提问与紧随其后的回答配成一组', () => {
    const turns = buildTurns([
      message('user', { text: '问一' }),
      message('assistant', { text: '答一' }),
      message('user', { text: '问二' }),
      message('assistant', { text: '答二' }),
    ])

    expect(turns).toHaveLength(2)
    expect(turns[0].user?.text).toBe('问一')
    expect(turns[0].reply?.text).toBe('答一')
    expect(turns[1].user?.text).toBe('问二')
  })

  it('流式中的那条回答（还没有正文）也成组', () => {
    const turns = buildTurns([
      message('user', { text: '问题' }),
      message('assistant', { streaming: true }),
    ])

    expect(turns).toHaveLength(1)
    expect(turns[0].reply?.streaming).toBe(true)
  })

  it('没有提问的回答自成一组，不被前一组吞掉', () => {
    const turns = buildTurns([
      message('user', { text: '问' }),
      message('assistant', { text: '答' }),
      message('assistant', { text: '再来一段' }),
    ])

    expect(turns).toHaveLength(2)
    expect(turns[1].user).toBeNull()
    expect(turns[1].reply?.text).toBe('再来一段')
  })
})

describe('traceSummary', () => {
  it('检索还在跑时说"正在检索"，别报一个还没成立的结论', () => {
    expect(traceSummary(message('assistant', { streaming: true }))).toBe('正在检索知识库…')
  })

  it('按片段数与文档数一起说：两个数字都有用', () => {
    const summary = traceSummary(
      message('assistant', {
        sources: [source(1), source(2, { document_id: 'd1' }), source(3, { document_id: 'd2' })],
      }),
    )

    expect(summary).toBe('检索完成 · 引用了 3 个片段 · 2 篇文档')
  })

  it('没命中也要说清楚（不能让"空"读成"还在转"）', () => {
    expect(traceSummary(message('assistant', { streaming: false }))).toBe(
      '检索完成 · 没有命中相关内容',
    )
  })
})

describe('traceSteps', () => {
  const turn = {
    user: message('user', { text: '近视怎么监测' }),
    reply: message('assistant', {
      text: '看眼轴。',
      sources: [source(1)],
      thinking: { enabled: true, effort: 'high' as ThinkingEffort },
    }),
  }

  it('只列真的发生过的步骤：检索、思考、生成', () => {
    const steps = traceSteps(turn)

    expect(steps.map((step) => step.key)).toEqual(['retrieve', 'think', 'answer'])
    expect(steps[0].detail).toContain('近视怎么监测')
    expect(steps[0].detail).toContain('1 个片段')
    expect(steps[1].detail).toBe('强度：高')
    expect(steps[2].label).toBe('已生成回答')
    expect(steps[2].detail).toBe('共 4 字')
  })

  it('这一轮没开思考就不显示思考这一步——不摆假动作', () => {
    const steps = traceSteps({
      ...turn,
      reply: message('assistant', { text: '看眼轴。', sources: [source(1)] }),
    })

    expect(steps.map((step) => step.key)).toEqual(['retrieve', 'answer'])
  })

  it('历史回放拿不到思考档（null），同样不显示那一步', () => {
    const steps = traceSteps({
      user: message('user', { text: '问' }),
      reply: message('assistant', { text: '答', sources: [source(1)], thinking: null }),
    })

    expect(steps.map((step) => step.key)).not.toContain('think')
  })

  it('生成中还标"正在生成回答"', () => {
    const steps = traceSteps({
      user: message('user', { text: '问' }),
      reply: message('assistant', { streaming: true, sources: [source(1)] }),
    })

    expect(steps.at(-1)?.label).toBe('正在生成回答')
  })

  it('过长的提问截断，面板里不该出现整段问题', () => {
    const steps = traceSteps({
      user: message('user', { text: '问题'.repeat(60) }),
      reply: message('assistant', { text: '答', sources: [source(1)] }),
    })

    expect(steps[0].detail).toContain('…')
    expect(steps[0].detail.length).toBeLessThan(80)
  })
})

describe('Agent 步骤（v20）', () => {
  it('summary 按当前步骤说进度，用户能分辨卡在理解还是检索', () => {
    expect(traceSummary(message('assistant', { streaming: true, steps: [step('intent')] }))).toBe(
      '正在理解问题…',
    )
    expect(traceSummary(message('assistant', { streaming: true, steps: [step('rewrite')] }))).toBe(
      '正在优化检索词…',
    )
  })

  it('有 Agent 步骤就照搬，不再编造老的两步', () => {
    const turn = {
      user: message('user', { text: '问' }),
      reply: message('assistant', {
        text: '答',
        sources: [source(1)],
        steps: [
          step('intent', { label: '理解问题', detail: '意图：查事实' }),
          step('rewrite', { label: '优化检索词', detail: '眼轴长度' }),
          step('retrieve', { label: '第 2 轮检索', detail: '眼轴测量频率' }),
          step('answer', { label: '组织回答', status: 'running' }),
        ],
      }),
    }

    const steps = traceSteps(turn)

    expect(steps.map((item) => item.label)).toEqual([
      '理解问题',
      '优化检索词',
      '第 2 轮检索',
      '组织回答',
    ])
    expect(steps.map((item) => item.icon)).toEqual(['think', 'search', 'search', 'build'])
    expect(steps.at(-1)?.detail).toBe('共 1 字') // 回答那一步就地补字数
  })

  it('渲染思考步骤时不与 Agent 步骤里的 think 重复', () => {
    const turn = {
      user: message('user', { text: '问' }),
      reply: message('assistant', {
        text: '答',
        steps: [step('intent', { label: '理解问题' })],
        thinking: { enabled: true, effort: 'low' as ThinkingEffort },
      }),
    }

    const steps = traceSteps(turn)

    expect(steps.filter((item) => item.icon === 'think')).toHaveLength(1)
  })

  it('mergeStep：running 占位被同名收尾就地替换，不出现两行', () => {
    const steps = [step('intent', { label: '理解问题', status: 'running' })]

    const merged = mergeStep(steps, step('intent', { label: '理解问题', detail: '意图：查事实' }))

    expect(merged).toHaveLength(1)
    expect(merged[0].detail).toBe('意图：查事实')
    expect(merged[0].status).toBe('done')
  })

  it('mergeStep：不同标签的检索轮次各自追加', () => {
    const steps = [step('retrieve', { label: '第 2 轮检索' })]

    const merged = mergeStep(steps, step('retrieve', { label: '第 3 轮检索' }))

    expect(merged).toHaveLength(2)
  })
})

describe('isTraceOpen', () => {
  it('流式中还没吐字时默认展开——那几秒它就是进度条', () => {
    expect(isTraceOpen(message('assistant', { streaming: true }))).toBe(true)
  })

  it('第一个字到了就自动收起，把地方让给正文', () => {
    expect(isTraceOpen(message('assistant', { streaming: true, text: '开始写了' }))).toBe(false)
  })

  it('用户点过之后完全听用户的（不受流式状态影响）', () => {
    expect(isTraceOpen(message('assistant', { streaming: true, traceOpen: false }))).toBe(false)
    expect(isTraceOpen(message('assistant', { traceOpen: true }))).toBe(true)
  })
})

describe('documentTarget', () => {
  it('有知识库 id 时直连库页抽屉', () => {
    expect(
      documentTarget(source(1, { knowledge_base_id: 'kb9', document_id: 'd9', page: 7 })),
    ).toEqual({ path: '/kb/kb9', query: { doc: 'd9', page: '7' } })
  })

  it('没有页码就不带 page', () => {
    const target = documentTarget(source(1, { knowledge_base_id: 'kb9' }))
    expect(target).toEqual({ path: '/kb/kb9', query: { doc: 'd1' } })
  })

  it('历史快照缺知识库 id 时退回 /documents 转发一跳', () => {
    expect(documentTarget(source(1, { knowledge_base_id: '' }))).toEqual({
      path: '/documents/d1',
      query: {},
    })
  })
})

describe('出处排版', () => {
  it('章节与页码可能缺，缺了就不占位', () => {
    expect(sourceWhere(source(1))).toBe('')
    expect(sourceWhere(source(1, { heading_path: '3 监测', page: 4 }))).toBe('3 监测 › 第 4 页')
  })

  it('预览按界面用途再切一刀（后端那份 900 字是给模型的）', () => {
    const short = source(1, { preview: '短' })
    const long = source(1, { preview: '长'.repeat(200) })

    expect(sourcePreview(short)).toBe('短')
    expect(sourcePreview(long).length).toBe(121)
    expect(sourcePreview(long).endsWith('…')).toBe(true)
  })
})

describe('THINKING_EFFORTS', () => {
  it('只有三档，与后端归一化口径一致', () => {
    expect(THINKING_EFFORTS.map((item) => item.value)).toEqual(['low', 'medium', 'high'])
  })
})
