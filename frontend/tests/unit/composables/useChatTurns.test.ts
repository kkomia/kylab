import { describe, expect, it } from 'vitest'

import type { ChatSource, ChatStep } from '@/api/chat'
import {
  degradedReason,
  buildTurns,
  isTraceOpen,
  LIVE_TAIL_CHARS,
  liveLine,
  makeMessage,
  mergeStep,
  sourcePreview,
  sourceWhere,
  THINKING_EFFORTS,
  replyArtifacts,
  stepIcon,
  traceEntries,
  traceSteps,
  traceSummary,
  wasDegraded,
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

describe('liveLine：流式期间那一行实时状态', () => {
  it('正在跑的工具优先：说"正在抓取网页…"而不是贴思考片段', () => {
    const line = liveLine(
      message('assistant', {
        streaming: true,
        thinkingText: '我想想，先看看这一页讲了什么……',
        steps: [{ phase: 'tool', label: '抓取网页', detail: '', status: 'running' }],
      }),
    )

    expect(line).toBe('正在抓取网页…')
  })

  it('思考中贴的是**最新的那一截**，不是开头', () => {
    const thinking = `${'前面的话。'.repeat(40)}最后一句才是重点。`
    const line = liveLine(message('assistant', { streaming: true, thinkingText: thinking }))

    expect(line.startsWith('…')).toBe(true)
    expect(line.endsWith('最后一句才是重点。')).toBe(true)
    expect(line.length).toBeLessThanOrEqual(LIVE_TAIL_CHARS + 1)
  })

  it('短思考原样给，不加省略号', () => {
    expect(
      liveLine(message('assistant', { streaming: true, thinkingText: ' 先确认  它的定位 ' })),
    ).toBe('先确认 它的定位')
  })

  it('正文开始吐字之后**不再抢这一行**：回到原来的摘要措辞', () => {
    // 注意力已经在正文上了，这一行只是角落里的过程播报
    const line = liveLine(
      message('assistant', { streaming: true, text: '答案是……', thinkingText: '很长很长的思考' }),
    )

    expect(line).toBe('正在处理…')
  })

  it('这一轮结束（不流式）时没有实时行——那一行是"正在发生"才有的', () => {
    expect(liveLine(message('assistant', { streaming: false, thinkingText: '想过' }))).toBe('')
  })
})

describe('traceSummary', () => {
  it('还没出步骤时说"正在处理"，**不说"正在检索"**（那一轮可能压根不查库）', () => {
    expect(traceSummary(message('assistant', { streaming: true }))).toBe('正在处理…')
  })

  it('按片段数与文档数一起说：两个数字都有用', () => {
    const summary = traceSummary(
      message('assistant', {
        sources: [source(1), source(2, { document_id: 'd1' }), source(3, { document_id: 'd2' })],
      }),
    )

    expect(summary).toBe('检索完成 · 引用了 3 个片段 · 2 篇文档')
  })

  it('**没证据就不说"检索完成"**：那一轮可能压根没用工具', () => {
    // 实测报过来的现象：用户关掉了知识库，界面却写着"检索完成 · 没有命中相关内容"，
    // 于是问"我明明没开知识库，为什么还是检索了"。真实情况是那一轮模型直接作答、
    // 一次工具都没调——是这句文案替它编了一段经过。
    expect(traceSummary(message('assistant', { streaming: false }))).toBe('直接作答')
  })

  it('调过工具但没命中资料时，说的是"本轮没有命中资料"', () => {
    const summary = traceSummary(
      message('assistant', {
        steps: [{ phase: 'tool', label: '检索知识库', detail: '命中 0 段原文', status: 'done' }],
      }),
    )

    expect(summary).toBe('本轮没有命中资料')
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

  it('mergeStep：一批并发调用（先全 running、再按序 done）逐条配对', () => {
    // 后端把同一批里的调用**并发**跑，事件顺序因此被定死成"running 全发 →
    // done 按调用顺序回"（见 services/tool_loop.py）。界面靠"同名的第一条 running"
    // 配对，所以这里必须一条不差地对上——配错了，用户点开某一步看到的是另一步的入参。
    const running = () => step('tool', { label: '联网搜索', tool: 'web_search', status: 'running' })
    let steps: ChatStep[] = [running(), running(), running()]
    steps = mergeStep(
      steps,
      step('tool', { label: '联网搜索', tool: 'web_search', detail: '第一条' }),
    )
    steps = mergeStep(
      steps,
      step('tool', { label: '联网搜索', tool: 'web_search', detail: '第二条' }),
    )
    steps = mergeStep(
      steps,
      step('tool', { label: '联网搜索', tool: 'web_search', detail: '第三条' }),
    )

    expect(steps).toHaveLength(3)
    expect(steps.map((item) => item.detail)).toEqual(['第一条', '第二条', '第三条'])
    expect(steps.map((item) => item.status)).toEqual(['done', 'done', 'done'])
  })
})

describe('isTraceOpen', () => {
  it('默认展开（还没吐字时也一样）', () => {
    expect(isTraceOpen(message('assistant', { streaming: true }))).toBe(true)
  })

  it('吐了字也不收起——过程是答案的一部分，不该在用户想看的时候消失', () => {
    expect(isTraceOpen(message('assistant', { streaming: true, text: '开始写了' }))).toBe(true)
    expect(isTraceOpen(message('assistant', { text: '写完了' }))).toBe(true)
  })

  it('用户点过之后完全听用户的（不受流式状态影响）', () => {
    expect(isTraceOpen(message('assistant', { streaming: true, traceOpen: false }))).toBe(false)
    expect(isTraceOpen(message('assistant', { traceOpen: true }))).toBe(true)
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

describe('降级与"这一轮没找到新东西"（v25）', () => {
  it('认出降级的那一步（工具步数用尽）', () => {
    const message = makeMessage('assistant', '答', {
      steps: [
        {
          phase: 'tool',
          label: '工具步数已达上限',
          detail: '本轮最多 6 步，按现有信息作答',
          status: 'done',
          degraded: true,
        },
      ],
    })

    expect(wasDegraded(message)).toBe(true)
  })

  it('把服务端给的原因原样带出来，不在前端写死', () => {
    // v0.32 起降级有两种原因（步数用尽 / 整轮时间用尽），提示语由服务端拼好——
    // 前端再写一句"工具步数用尽"的话，撞时间的用户会被告知是步数的事
    const steps = makeMessage('assistant', '答', {
      steps: [
        {
          phase: 'tool',
          label: '本轮时间已用尽',
          detail: '本轮最多 300 秒，已用 312 秒，按现有信息作答',
          status: 'done',
          degraded: true,
        },
      ],
    })
    expect(degradedReason(steps)).toBe('本轮最多 300 秒，已用 312 秒，按现有信息作答')

    // detail 为空（老会话存下来的、或将来某条新路径忘了拼）——退化成一句不撒谎的话，
    // 而不是在界面上显示出空白
    const bare = makeMessage('assistant', '答', {
      steps: [{ phase: 'tool', label: '降级', detail: '', status: 'done', degraded: true }],
    })
    expect(degradedReason(bare)).toBe('按当时拿到的资料作答')
  })

  it('is not degraded on a normal run', () => {
    const message = makeMessage('assistant', '答', {
      steps: [{ phase: 'tool', label: '检索知识库', detail: '命中 8 段原文', status: 'done' }],
    })

    expect(wasDegraded(message)).toBe(false)
  })

  it('marks a round that added nothing as empty', () => {
    const message = makeMessage('assistant', '答', {
      steps: [
        {
          phase: 'retrieve',
          label: '第 2 轮检索',
          detail: '换个问法 · 新增 0 段',
          status: 'done',
          added: 0,
        },
        {
          phase: 'retrieve',
          label: '第 3 轮检索',
          detail: '再换一个 · 新增 4 段',
          status: 'done',
          added: 4,
        },
      ],
    })

    const steps = traceSteps({ user: null, reply: message })
    expect(steps.map((item) => item.empty)).toEqual([true, false])
  })

  it('**零步骤零出处时不编"检索知识库"**（关掉知识库的闲聊就是这种）', () => {
    // 这条兜底原先是给"回放没有步骤的历史"用的（那时确实检索过），
    // 但 P0 之后"模型直接作答"成了常态，凭空画一条检索步骤会让人以为它去查了。
    const empty = {
      user: message('user', { text: '你好' }),
      reply: message('assistant', { text: '你好！有什么我可以帮你的？' }),
    }

    const steps = traceSteps(empty)

    expect(steps.map((step) => step.key)).toEqual(['answer'])
    expect(steps[0].label).toBe('已生成回答')
  })

  it('有出处的回放仍然补出"检索知识库"（那时确实检索过）', () => {
    const replay = {
      user: message('user', { text: '近视怎么监测' }),
      reply: message('assistant', { text: '看眼轴。', sources: [source(1)] }),
    }

    const steps = traceSteps(replay)

    expect(steps[0].label).toBe('检索知识库')
    expect(steps[0].detail).toContain('1 个片段')
  })
})

describe('同类工具合并（v0.26）', () => {
  /** 一次工具调用：`tool` 是后端给的原始工具名，分组按它来。 */
  function call(tool: string, label: string, detail: string): ChatStep {
    return step('tool', { tool, label, detail })
  }

  function turnWith(steps: ChatStep[]) {
    return {
      user: message('user', { text: '问' }),
      reply: message('assistant', { text: '答', steps }),
    }
  }

  it('同一个块里同一种工具并成一组，**保持首次出现的顺序**', () => {
    // 实测的形态：联网搜索 7 次、抓取网页 2 次，交替出现
    const entries = traceEntries(
      turnWith([
        step('intent', { label: '理解问题' }),
        call('web_search', '联网搜索', '查 A'),
        call('web_fetch', '抓取网页', '读 A'),
        call('web_search', '联网搜索', '查 B'),
        call('web_fetch', '抓取网页', '读 B'),
        call('web_search', '联网搜索', '查 C'),
      ]),
    )

    expect(entries.map((entry) => entry.kind)).toEqual(['step', 'group', 'group'])
    const first = entries[1]
    expect(first.kind === 'group' && first.label).toBe('联网搜索')
    expect(first.kind === 'group' && first.steps.map((item) => item.detail)).toEqual([
      '查 A',
      '查 B',
      '查 C',
    ])
    const second = entries[2]
    expect(second.kind === 'group' && second.steps).toHaveLength(2)
  })

  it('只调一次的不并：一组只有一个成员时，"点开看全部"是个空动作', () => {
    const entries = traceEntries(
      turnWith([call('web_search', '联网搜索', '查 A'), call('list_notes', '查看笔记', '2 条')]),
    )

    expect(entries.map((entry) => entry.kind)).toEqual(['step', 'step'])
  })

  it('非工具步骤是分界：跨过它不合并（否则"什么时候做的"就讲乱了）', () => {
    const entries = traceEntries(
      turnWith([
        call('web_search', '联网搜索', '查 A'),
        call('web_search', '联网搜索', '查 B'),
        step('compress', { label: '压缩上下文' }),
        call('web_search', '联网搜索', '查 C'),
        call('web_search', '联网搜索', '查 D'),
      ]),
    )

    expect(entries.map((entry) => entry.kind)).toEqual(['group', 'step', 'group'])
  })

  it('同一块里混着两种工具：各成一组，按**首次出现**排，组内保序', () => {
    const entries = traceEntries(
      turnWith([
        call('web_search', '联网搜索', '查 A'),
        call('search', '检索知识库', '命中 1 段'),
        call('web_search', '联网搜索', '查 B'),
        call('search', '检索知识库', '命中 2 段'),
      ]),
    )

    expect(entries.map((entry) => (entry.kind === 'group' ? entry.tool : 'single'))).toEqual([
      'web_search',
      'search',
    ])
    const first = entries[0]
    expect(first.kind === 'group' && first.steps.map((item) => item.detail)).toEqual([
      '查 A',
      '查 B',
    ])
    const second = entries[1]
    expect(second.kind === 'group' && second.steps.map((item) => item.detail)).toEqual([
      '命中 1 段',
      '命中 2 段',
    ])
  })

  it('每一条都带着它的工具名：图标靠它选，分组也靠它', () => {
    const steps = traceSteps(
      turnWith([
        call('web_search', '联网搜索', ''),
        call('export_document', '导出文档', ''),
        call('remember', '记住', ''),
      ]),
    )

    expect(steps.map((item) => item.tool)).toEqual(['web_search', 'export_document', 'remember'])
  })
})

describe('工具图标分类（v0.26）', () => {
  it('按"它对外做的那件事"分类，同类工具同一个图标', () => {
    expect(stepIcon({ phase: 'tool', tool: 'web_search' })).toBe('web')
    expect(stepIcon({ phase: 'tool', tool: 'web_fetch' })).toBe('fetch')
    expect(stepIcon({ phase: 'tool', tool: 'search' })).toBe('search')
    expect(stepIcon({ phase: 'tool', tool: 'recall' })).toBe('search')
    expect(stepIcon({ phase: 'tool', tool: 'export_table' })).toBe('file')
    expect(stepIcon({ phase: 'tool', tool: 'create_note' })).toBe('note')
  })

  it('认不出的工具走中性图标，不硬塞一个像样的', () => {
    // 外部 MCP 工具各自是另一家的东西，我们不知道该怎么画
    expect(stepIcon({ phase: 'tool', tool: 'mcp__tavily__search' })).toBe('mcp')
    expect(stepIcon({ phase: 'tool', tool: '某个新工具' })).toBe('tool')
  })

  it('非工具步骤仍按 phase 走', () => {
    expect(stepIcon({ phase: 'intent' })).toBe('think')
    expect(stepIcon({ phase: 'answer' })).toBe('build')
  })
})

describe('老快照的兜底（v0.26）', () => {
  /** v0.26 之前存下的步骤：只有中文标签，没有工具名。 */
  function legacy(label: string, detail = '') {
    return step('tool', { label, detail })
  }

  it('没有工具名时按标签合并——已经存在的对话也要受益', () => {
    // 用户手上正开着的就是这种数据；"只对新对话生效"等于告诉他没修好
    const entries = traceEntries({
      user: message('user', { text: '问' }),
      reply: message('assistant', {
        text: '答',
        steps: [legacy('联网搜索', '查 A'), legacy('联网搜索', '查 B'), legacy('抓取网页', '读 A')],
      }),
    })

    expect(entries.map((entry) => entry.kind)).toEqual(['group', 'step'])
    const first = entries[0]
    expect(first.kind === 'group' && first.label).toBe('联网搜索')
    expect(first.kind === 'group' && first.steps).toHaveLength(2)
  })

  it('图标也认那批老标签，认不出才退回中性图标', () => {
    expect(stepIcon({ phase: 'tool', label: '联网搜索' })).toBe('web')
    expect(stepIcon({ phase: 'tool', label: '抓取网页' })).toBe('fetch')
    // 后端哪天改了措辞，匹配不上就退中性图标——**这是降级，不是显示错的东西**
    expect(stepIcon({ phase: 'tool', label: '某个改过名的步骤' })).toBe('tool')
  })

  it('非工具步骤不进分组：它们没有 group 键', () => {
    const entries = traceEntries({
      user: message('user', { text: '问' }),
      reply: message('assistant', {
        text: '答',
        steps: [step('intent', { label: '理解问题' }), step('compress', { label: '压缩上下文' })],
      }),
    })

    expect(entries.map((entry) => entry.kind)).toEqual(['step', 'step'])
  })
})

describe('一轮产出的文件（v0.26）', () => {
  function withArtifact(artifactId: string) {
    return {
      artifact_id: artifactId,
      name: `${artifactId}.pptx`,
      size_bytes: 10,
      format: 'pptx',
    }
  }

  it('把各步的产物收成一份，按产出先后、按 id 去重', () => {
    const turn = {
      user: message('user', { text: '做个 ppt' }),
      reply: message('assistant', {
        text: '做好了',
        steps: [
          step('tool', { phase: 'tool', label: '导出幻灯', artifacts: [withArtifact('art_1')] }),
          step('tool', { phase: 'tool', label: '记住', artifacts: [] }),
          // 同一个文件在"入库"那一步又被提到一次：只该有一张卡片
          step('tool', { phase: 'tool', label: '存进知识库', artifacts: [withArtifact('art_1')] }),
          step('tool', { phase: 'tool', label: '导出表格', artifacts: [withArtifact('art_2')] }),
        ],
      }),
    }

    expect(replyArtifacts(turn).map((item) => item.artifact_id)).toEqual(['art_1', 'art_2'])
  })

  it('没有产物就是空数组，界面据此不画那一块', () => {
    const turn = {
      user: message('user', { text: '你好' }),
      reply: message('assistant', { text: '你好' }),
    }

    expect(replyArtifacts(turn)).toEqual([])
  })
})
