/**
 * 回合模型与过程面板数据（`model/turns.ts`）——**从旧前端的 60 条用例逐条搬过来**。
 *
 * 源：`frontend/tests/unit/composables/useChatTurns.test.ts`。搬法：只改 import 路径
 * （`@/composables/useChatTurns` → `@/features/chat/model/turns`），
 * 断言与注释一字不动——这一层是纯函数，行为必须与旧实现逐条一致。
 */

import { describe, expect, it } from 'vitest'

import type { ChatSource, ChatStep } from '@/api/chat'
import {
  degradedReason,
  hasToolCallMarkup,
  buildTurns,
  isTraceOpen,
  readTraceOpenMemory,
  writeTraceOpenMemory,
  resultPreview,
  LIVE_TAIL_CHARS,
  liveLine,
  makeMessage,
  mergeStep,
  sourcePreview,
  sourceWhere,
  THINKING_EFFORTS,
  TRACE_PAGE_SIZE,
  thinkingParagraphs,
  usedWebSearch,
  replyArtifacts,
  stepIcon,
  traceEntries,
  tracePage,
  traceSteps,
  traceSummary,
  wasDegraded,
  RESULT_PREVIEW_CHARS,
  type Message,
  type ThinkingEffort,
} from '@/features/chat/model/turns'

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

describe('过程面板的收起态可记忆（P2-1）', () => {
  it('没表过态时默认仍是展开（v0.25 的选择不改）', () => {
    window.localStorage.clear()
    expect(readTraceOpenMemory()).toBeUndefined()
    // 兜底值仍是 true：**"过程常驻在正文里"是刻意的决定**，这次不推翻它
    expect(isTraceOpen(message('assistant'), readTraceOpenMemory() ?? true)).toBe(true)
  })

  it('用户收起过之后，新的一轮就按收起画（刷新也还在）', () => {
    writeTraceOpenMemory(false)
    expect(readTraceOpenMemory()).toBe(false)
    expect(isTraceOpen(message('assistant'), readTraceOpenMemory() ?? true)).toBe(false)
  })

  it('**这一轮自己点开的态优先**：全局记忆不覆盖用户当场的那一下', () => {
    writeTraceOpenMemory(false)
    const opened = message('assistant', { traceOpen: true })
    expect(isTraceOpen(opened, readTraceOpenMemory() ?? true)).toBe(true)
    window.localStorage.clear()
  })
})

describe('大输出两级懒加载（P2-1）', () => {
  /** 30 次调用、每次不同工具名（同名会被并成一组，那样条数就上不去）。 */
  function manySteps(count: number) {
    return Array.from({ length: count }, (_, index) =>
      step('tool', {
        label: `工具${index}`,
        tool: `tool_${index}`,
        kind: 'read',
        detail: `第 ${index} 次`,
      }),
    )
  }

  function turnWithSteps(steps: ChatStep[]) {
    return { user: message('user', { text: '问' }), reply: message('assistant', { steps }) }
  }

  it('超过 N 条时先只给前 N 条，并说清"已显示 X/Y"', () => {
    const page = tracePage(turnWithSteps(manySteps(30)))

    expect(page.total).toBe(30)
    expect(page.shown).toBe(TRACE_PAGE_SIZE)
    expect(page.hidden).toBe(30 - TRACE_PAGE_SIZE)
    expect(page.entries).toHaveLength(TRACE_PAGE_SIZE)
  })

  it('没超过 N 条就全画，也不摆那行计数（多一行字是噪声）', () => {
    const page = tracePage(turnWithSteps(manySteps(3)))

    expect(page.shown).toBe(3)
    expect(page.total).toBe(3)
    expect(page.hidden).toBe(0)
  })

  it('「加载更多」就是**把 limit 调大**（数据一条不少，只是先不画）', () => {
    const turn = turnWithSteps(manySteps(50))
    const first = tracePage(turn, TRACE_PAGE_SIZE)
    const second = tracePage(turn, TRACE_PAGE_SIZE * 2)

    expect(second.shown).toBe(TRACE_PAGE_SIZE * 2)
    expect(second.entries.slice(0, TRACE_PAGE_SIZE)).toEqual(first.entries)
    // 翻到头之后 shown 就停在总数上，那行计数与按钮随之消失
    const last = tracePage(turn, TRACE_PAGE_SIZE * 10)
    expect(last.shown).toBe(50)
    expect(last.hidden).toBe(0)
  })

  it('计数按**工具调用**算，不按行数（并成一行的那 30 次仍是 30 条）', () => {
    // 同名调用会被并成一个入口（v0.26），但它代表的是**它里面那几次**——
    // 按行报数会说成"1 条"，那是个假数字（界面上的措辞是"条工具调用"）
    const steps = Array.from({ length: 30 }, (_, index) =>
      step('tool', {
        label: '联网搜索',
        tool: 'web_search',
        kind: 'search',
        detail: `查 ${index}`,
      }),
    )
    const page = tracePage(turnWithSteps(steps))

    expect(page.entries).toHaveLength(1)
    expect(page.total).toBe(30)
    expect(page.shown).toBe(30)
    expect(page.hidden).toBe(0)
  })

  it('单条返回超长时先只给预览，并报出"仅预览 x/y 字"', () => {
    const long = 'x'.repeat(RESULT_PREVIEW_CHARS + 1000)

    expect(resultPreview(long)).toHaveLength(RESULT_PREVIEW_CHARS)
    // 短结果不给预览（调用方据此不给那个按钮）
    expect(resultPreview('短')).toBeNull()
    expect(resultPreview('')).toBeNull()
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

  it('认出"模型把工具调用写进正文"的老消息（§12.227）', () => {
    // 后端从 §12.227 起会把这类标记剥掉，所以新回答不该再出现；这一层守的是
    // **修复之前落库的那些**（实测 5 条）与将来某个没见过的形状——它们不该被当人话读
    const shapes = [
      '<tool_call>\n{"name": "web_search"}\n</tool_call>',
      '先查一下。\n<tool_call>web_search\n{"query": "眼轴"}',
      '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>web_search<｜tool▁call▁end｜>',
      '<|DSML| invoke name="web_fetch">',
      '<function=web_search>{"query": "眼轴"}</function>',
    ]
    for (const text of shapes) {
      expect(hasToolCallMarkup(text), text).toBe(true)
    }
  })

  it('正常回答不误伤：引用这个标签、或普通带尖括号的正文照旧是回答', () => {
    // 假阳性只是多一行说明，假阴性是用户又把那段标记当成了回答；但也不能反过来
    // 把正常回答标成标记——问"<tool_call> 是什么"的那种回答里就会出现这个标签
    expect(hasToolCallMarkup('那个 `<tool_call>` 标签是模型想调工具时写的。')).toBe(false)
    expect(hasToolCallMarkup('眼轴长度是 24mm 上下。')).toBe(false)
    expect(hasToolCallMarkup('')).toBe(false)
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

describe('步骤图标＝语义种类（P2-1）', () => {
  it('后端给了 kind 就用它——**同类工具同一个图标，与工具名无关**', () => {
    // 这一条是 P2-1 的验收①：卡片的样子由 kind 决定（照 ZCode 的四元组）
    expect(stepIcon({ phase: 'tool', tool: 'web_search', kind: 'search' })).toBe('search')
    expect(stepIcon({ phase: 'tool', tool: 'search', kind: 'search' })).toBe('search')
    expect(stepIcon({ phase: 'tool', tool: 'read_file', kind: 'read' })).toBe('read')
    expect(stepIcon({ phase: 'tool', tool: 'list_notes', kind: 'read' })).toBe('read')
    expect(stepIcon({ phase: 'tool', tool: 'create_note', kind: 'write' })).toBe('write')
    expect(stepIcon({ phase: 'tool', tool: 'run_command', kind: 'exec' })).toBe('exec')
    expect(stepIcon({ phase: 'tool', tool: 'delete_document', kind: 'delete' })).toBe('delete')
  })

  it('kind 是词表外的取值（后端加了新档）当没有，不崩', () => {
    expect(stepIcon({ phase: 'tool', tool: 'web_search', kind: 'brand-new' })).toBe('search')
  })

  it('认不出的工具走中性图标，不硬塞一个像样的', () => {
    // 外部 MCP 工具各自是另一家的东西，我们不知道该怎么画
    expect(stepIcon({ phase: 'tool', tool: 'mcp__tavily__search' })).toBe('tool')
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
    // 联网搜索与抓取网页现在同归 search（P2-1 按语义种类画，不再一个找、一个取）
    expect(stepIcon({ phase: 'tool', label: '联网搜索' })).toBe('search')
    expect(stepIcon({ phase: 'tool', label: '抓取网页' })).toBe('search')
    expect(stepIcon({ phase: 'tool', label: '读文件' })).toBe('read')
    // 后端哪天改了措辞，匹配不上就退中性图标——**这是降级，不是显示错的东西**
    expect(stepIcon({ phase: 'tool', label: '某个改过名的步骤' })).toBe('tool')
  })

  it('老快照按工具名翻译成种类，新数据与它同档（迁移期两批数据长得一样）', () => {
    // P2-1 之前落库的步骤只有工具名，没有 kind：这里按工具名翻译一次，
    // 于是**同一轮里新旧两批数据画出来是同一个样子**（不然刷新前后会变脸）
    expect(stepIcon({ phase: 'tool', tool: 'web_fetch' })).toBe('search')
    expect(stepIcon({ phase: 'tool', tool: 'recall' })).toBe('search')
    expect(stepIcon({ phase: 'tool', tool: 'read_file' })).toBe('read')
    expect(stepIcon({ phase: 'tool', tool: 'export_table' })).toBe('write')
    expect(stepIcon({ phase: 'tool', tool: 'spawn_subagent' })).toBe('session')
    expect(stepIcon({ phase: 'tool', tool: 'list_skills' })).toBe('skill')
    expect(stepIcon({ phase: 'tool', tool: 'run_command' })).toBe('exec')
    expect(stepIcon({ phase: 'tool', tool: 'delete_document' })).toBe('delete')
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

/**
 * 思考正文按段切开（v0.28，第二批评审 A3）。
 *
 * 界面把思考正文渲染成 `white-space: pre-wrap` 的一块——空行就是一个**整行高**的空档
 * （12px 字号下 19px），比正文的段距（12px）还松，主次是反的。切开之后每段占一行、
 * 段距由界面给（`--space-2`），过程才真的比答案紧。
 */
describe('thinkingParagraphs：思考正文按空行切段', () => {
  it('连续空行切段，段内换行原样留着', () => {
    expect(thinkingParagraphs('先看问题\n再想一步\n\n第二段\n\n\n第三段')).toEqual([
      '先看问题\n再想一步',
      '第二段',
      '第三段',
    ])
  })

  it('只吃段与段之间的空行，段首的缩进不动（思考里常有对齐过的列表）', () => {
    expect(thinkingParagraphs('  缩进过的第一段\n\n  - 一条\n  - 两条')).toEqual([
      '  缩进过的第一段',
      '  - 一条\n  - 两条',
    ])
  })

  it('空串与纯空白给出空数组——界面据此不画那一块', () => {
    expect(thinkingParagraphs('')).toEqual([])
    expect(thinkingParagraphs('\n\n  \n')).toEqual([])
  })

  it('没有空行时就是一段（一个字都不改）', () => {
    expect(thinkingParagraphs('一句话的思考。')).toEqual(['一句话的思考。'])
  })
})

/**
 * 这一轮跑过联网搜索没有（v0.28，第二批评审 A6）。
 *
 * 正文里对不上出处的 `[6][2]` 怎么画，全看这个判据：跑过联网搜索 → 给一句
 * "见过程面板"的说明（那些编号指的是那一次搜索的返回，它本身是带编号的）；
 * 没跑过 → 什么都不说，不替模型编一个来源。
 */
describe('usedWebSearch：这一轮跑过联网搜索没有', () => {
  it('认工具名（v0.26 起的步骤）', () => {
    const reply = message('assistant', {
      text: '看[1]',
      steps: [step('tool', { phase: 'tool', label: '联网搜索', tool: 'web_search' })],
    })

    expect(usedWebSearch(reply)).toBe(true)
  })

  it('老快照没有工具名时认后端当时发的标签', () => {
    const reply = message('assistant', {
      text: '看[1]',
      steps: [step('tool', { phase: 'tool', label: '联网搜索' })],
    })

    expect(usedWebSearch(reply)).toBe(true)
  })

  it('只查了知识库（或什么都没调）时是 false', () => {
    expect(
      usedWebSearch(
        message('assistant', {
          text: '看[1]',
          steps: [step('tool', { phase: 'tool', label: '检索知识库', tool: 'search' })],
        }),
      ),
    ).toBe(false)
    expect(usedWebSearch(message('assistant', { text: '直接答' }))).toBe(false)
  })

  it('非工具步骤上的同名标签不算（不许把"思考"里的一行字当成联网）', () => {
    const reply = message('assistant', {
      text: '看[1]',
      steps: [step('intent', { phase: 'intent', label: '联网搜索', tool: 'web_search' })],
    })

    expect(usedWebSearch(reply)).toBe(false)
  })
})
