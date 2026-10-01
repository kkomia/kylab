/**
 * 工具链块（ToolchainFlow）的用例——《对话UI-重做-设计》§4 的回归防线。
 *
 * 钉住的是**新结构的行为默认值**：
 *
 * 1. 直接作答（无步骤/无思考/无来源）整块不画（legacy 兜底行不算数）；
 * 2. 头的总名（`使用 N 个工具`；右侧没有计数；**总标题不加图标**）；
 *    点块头 = 点宿主的开合开关；
 * 3. running 行 = 流光 +「进行中」+ 图标位那枚**半月 dot**（`.ch-loading-dot`）；
 *    行级耗时**全撤**（单步行与组行都不印，只有整轮那一处总计报耗时本身）；
 *    被拦下/等确认的行**前置展开**；
 * 4. 同工具并组（「N 次」、没碰过的组看"还在跑就摊开"、他点过的组听他的——
 *    开合状态在宿主手里，这里的夹具就是它的替身）；
 * 5. 行体（入参/返回/思考）默认**不上 DOM**，点开才挂（`everOpened` 的 DOM 开销纪律）；
 *    **联网那两档（联网搜索 / 抓取网页）的展开只有一张网页清单**（2026-09-30 用户批注
 *    原话"搜索网页的不显示 request 和 response，只显示网页列表"）：没有 Request /
 *    Response 面板，也没有原先接在清单下面那段原文；其余工具行（`find_tools` 等）
 *    那两块面板照旧。**清单也解不出来时这一行不给"能点开"的许诺**（判据在 `StepRow`）；
 * 6. 整轮思考（老消息兜底）与来源清单各自成行、默认收起；思考行的标题跟着开合走
 *    （收起是描述性首行、点开固定「思考已完成」）；来源行带 `data-source`
 *    与 `data-flash`（点正文徽标那条链路的物证）。
 * 7. **2026-10-01 用户批注（批三）在这块上的口径**：头部总名只剩「使用 N 个工具」
 *    （原话"写法太复杂了 就写使用了多少工具就行，只统计工具"）；联网搜索那一行的详情
 *    只说 `N 个结果`（"这不要写检索词 就写多少个结果就行"）；联网搜索那一组的展开
 *    直接就是合并后的网页清单（"不要在联网搜索里面搞个 list 再去放联网搜索"）；
 *    读技能那一步的展开只剩一行字（"如果是读技能的话 就显示 Gained some skills from
 *    the file. 就行"）；「加载全部」按钮整档撤掉（返回恒铺 600 字预览）。
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { useState, type ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { ChatSource, ChatStep } from '@/api/chat'
import { makeMessage, type ObservedStep, type Turn } from '@/features/chat/model/turns'
import { ToolchainFlow } from '@/features/chat/ui/ToolchainFlow'

function step(overrides: Partial<ChatStep> = {}): ChatStep {
  return {
    phase: 'tool',
    label: '联网搜索',
    detail: '',
    status: 'done',
    tool: 'web_search',
    ...overrides,
  }
}

function source(overrides: Partial<ChatSource> = {}): ChatSource {
  return {
    index: 1,
    chunk_id: 'ck1',
    document_id: 'doc1',
    document_name: '眼轴监测指南.pdf',
    heading_path: null,
    page: null,
    score: 0.9,
    preview: '…',
    knowledge_base_id: '',
    ...overrides,
  }
}

function flowOf(
  reply: ReturnType<typeof makeMessage>,
  open = true,
  extra: Partial<ComponentProps<typeof ToolchainFlow>> = {},
) {
  const turn: Turn = { user: null, reply }
  const onToggle = vi.fn()
  const onOpenSource = vi.fn()
  /** 宿主那两份开合表（openSteps / openGroups）的夹具替身。 */
  function Harness() {
    const [rows, setRows] = useState<ReadonlySet<string>>(new Set())
    const [groups, setGroups] = useState<ReadonlyMap<string, boolean>>(new Map())
    const [cites, setCites] = useState(false)
    return (
      <ToolchainFlow
        turn={turn}
        turnIndex={0}
        open={open}
        onToggle={onToggle}
        expansion={{
          isOpen: (key) => rows.has(key),
          toggle: (key) =>
            setRows((prev) => {
              const next = new Set(prev)
              if (next.has(key)) next.delete(key)
              else next.add(key)
              return next
            }),
          groupChoice: (key) => groups.get(key),
          chooseGroup: (key, value) => setGroups((prev) => new Map(prev).set(key, value)),
        }}
        citesOpen={cites}
        onToggleCites={() => setCites((prev) => !prev)}
        onOpenSource={onOpenSource}
        {...extra}
      />
    )
  }
  render(<Harness />)
  return { onToggle, onOpenSource }
}

describe('工具链块', () => {
  it('直接作答：没有步骤、思考与来源时整块不画', () => {
    const turn: Turn = { user: null, reply: makeMessage('assistant', '答案') }
    const { container } = render(
      <ToolchainFlow
        turn={turn}
        turnIndex={0}
        open
        onToggle={() => {}}
        expansion={{
          isOpen: () => false,
          toggle: () => {},
          groupChoice: () => undefined,
          chooseGroup: () => {},
        }}
        citesOpen={false}
        onToggleCites={() => {}}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('头的总名只剩「使用 N 个工具」；点头 = 点宿主的开合开关', () => {
    const { onToggle } = flowOf(
      makeMessage('assistant', '答案', {
        steps: [step(), step({ label: '抓取网页', tool: 'fetch' })],
      }),
    )
    /*
      头部是**动作态**总名（2026-09-30 R3 批注，照 Kimi「使用 19 个工具，生成今日早报…」）：
      `使用 {T} 个工具`——T 是**原始工具步数**（聚合前每一次调用都算）。
      右侧**没有**「N 步」计数（计数已在这一句里）。

      **2026-10-01 用户批注之后只剩这一个计数**：原话"写法太复杂了 就写使用了多少工具
      就行，只统计工具"——改前那句尾巴（`，联网搜索、抓取网页` 那串动作短语）整档撤掉，
      所以这里连带钉住"短语不在"（`phrases` / `seen` 那套已从 `toolTotal` 里删掉）。
    */
    const toggle = screen.getByRole('button', { name: /使用 2 个工具/ })
    expect(toggle).toHaveTextContent('使用 2 个工具')
    expect(toggle).not.toHaveTextContent('联网搜索、抓取网页')
    // 右侧原先那枚「N 步」计数撤掉了（R3）：计数已经在这一句里
    expect(toggle).not.toHaveTextContent(/\d+ 步/)
    /*
      **总标题不加图标**（2026-09-30 用户批注，推翻此前"Kimi 是图标 + 摘要"那条）：
      头部只剩总名 + chevron——原先段首那格 `.ch-head-icon`（`<FileText>`）整个拿掉，
      所以头部里除了箭头那枚 svg，不该再有别的图标位（`data-icon` 一个都没有）。
    */
    expect(toggle.querySelector('.ch-head-icon')).toBeNull()
    expect(toggle.querySelector('[data-icon]')).toBeNull()
    fireEvent.click(toggle)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('头部总名的口径：T 数的是**原始调用次数**（同一工具并组前的那几次都算）', () => {
    flowOf(
      makeMessage('assistant', '答案', {
        steps: [
          // 三次同一个工具 → 并成一行（组里的 3 次仍算 3 个工具）
          step({ label: '检索知识库', tool: 'search', detail: '命中 1 条' }),
          step({ label: '检索知识库', tool: 'search', detail: '命中 2 条' }),
          step({ label: '检索知识库', tool: 'search', detail: '命中 3 条' }),
          // 只调用一次的工具不并（也算 1 个）
          step({ label: '导出文档', tool: 'export_document', detail: '已导出' }),
        ],
      }),
    )
    const toggle = screen.getByTestId('trace-toggle')
    // T = 3 + 1 = 4（**调用次数**，不是聚合后的行数）；2026-10-01 批注之后头部只有这一个数
    expect(toggle).toHaveTextContent('使用 4 个工具')
  })

  it('只有「组织回答」那一步的轮次：**整块不画**（R4：那一行没有可展开的内容）', () => {
    /*
      R4 批注：落定之后的「组织回答」行不再渲染（用户原话"没有内容展开，没有意义显示"），
      于是纯直接作答那一轮链上一个链项都不剩——**整块 ToolchainFlow 不画**
      （Kimi 直接作答本来就没有块），头部与「共 N 字」footer 自然也不在。
      流式中的那一行仍然保留（它是"正在组织回答"的活动指示），见 `visibleEntries`。
    */
    const { container } = render(
      <ToolchainFlow
        turn={{
          user: null,
          reply: makeMessage('assistant', '答案', {
            steps: [{ phase: 'answer', label: '已生成回答', detail: '', status: 'done' }],
          }),
        }}
        turnIndex={0}
        open
        onToggle={() => {}}
        expansion={{
          isOpen: () => false,
          toggle: () => {},
          groupChoice: () => undefined,
          chooseGroup: () => {},
        }}
        citesOpen={false}
        onToggleCites={() => {}}
      />,
    )
    expect(container.firstChild).toBeNull()
    expect(screen.queryByTestId('trace-toggle')).toBeNull()
    expect(screen.queryByTestId('trace-total')).toBeNull()
  })

  it('有来源但没工具步的那一轮：块还在（来源行），头部仍是「直接作答」', () => {
    flowOf(
      makeMessage('assistant', '答案', {
        steps: [{ phase: 'answer', label: '已生成回答', detail: '', status: 'done' }],
        sources: [source()],
      }),
    )
    // 「直接作答」的语义没变（这一轮没调工具）；「拒识 / 命中」那些结果态文案不再进头部
    // ——哪怕这一轮有出处（`sources`），头部也只说这一句，不发「检索完成 · 引用了 N 个片段」
    const toggle = screen.getByTestId('trace-toggle')
    expect(toggle).toHaveTextContent('直接作答')
    expect(toggle).not.toHaveTextContent(/命中|检索完成/)
  })

  it('档位：open=false 时折叠体是 data-open=false（内容从没展开过则不上 DOM）', () => {
    /*
      夹具用**非联网的那一档**（读文件）：联网搜索 / 抓取网页的展开只剩网页清单
      （2026-09-30 用户批注），"入参上不上 DOM"要在还会画 Request 面板的行上看
      ——否则这条用例验的是一个本来就不会出现的东西。
    */
    flowOf(
      makeMessage('assistant', '答案', {
        steps: [step({ label: '读取文件', tool: 'read_file', args: '{"path":"a.md"}' })],
      }),
      false,
    )
    const fold = document.querySelector('.ch-flow > .ch-clp')
    expect(fold).toHaveAttribute('data-open', 'false')
    // 从没展开过：行体里的入参不在文档里
    expect(screen.queryByText('{"path":"a.md"}')).not.toBeInTheDocument()
  })

  it('running 的行是流光 +「进行中」+ 图标位那枚半月 dot；行级耗时不再印', () => {
    flowOf(
      makeMessage('assistant', '', {
        streaming: true,
        // running 的那步必须在**最后**（`settleStaleRunning` 的口径：后面还有步骤的
        // running 是后端没收尾的占位，会被收成 done）
        steps: [
          { ...step({ label: '检索知识库', tool: 'search' }), durationMs: 1234 } as ObservedStep,
          step({ label: '抓取网页', tool: 'fetch', status: 'running' }),
        ],
      }),
    )
    const runningRow = screen.getByText('抓取网页').closest('.ch-row')!
    expect(runningRow.querySelector('.ch-live')).not.toBeNull()
    /*
      图标位换成那枚**半月旋转 dot**（2026-09-30 用户批注，照 kimi.com 的
      `widget-loading-dot`）：类名精确是 `ch-loading-dot`（样式在 `flow.css`，
      组件这一侧只挂 DOM）。它取代的是"这一步是哪种工具"那一枚，所以原来那枚
      `data-icon` 不在这一格里了。
    */
    expect(runningRow.querySelector('.ch-loading-dot')).not.toBeNull()
    expect(runningRow.querySelector('.ch-icon-slot [data-icon]')).toBeNull()
    expect(screen.getByText('进行中')).toBeInTheDocument()
    /*
      行级耗时全撤（同一条批注）：`data-duration` 这两处（单步行 / 组行）都不再渲染，
      而**跑完的那一行**（检索知识库，界面真量到 1234ms）也不印。
    */
    expect(document.querySelector('[data-duration]')).toBeNull()
    expect(screen.queryByText('1.2 秒')).toBeNull()
  })

  it('半月 dot 只属于"还在跑"那一档：落定之后图标位恢复原图标', () => {
    // 同一条「抓取网页」，这一次是 done（历史回放、或这一轮已经跑完）
    flowOf(
      makeMessage('assistant', '答案', { steps: [step({ label: '抓取网页', tool: 'fetch' })] }),
    )
    const row = screen.getByText('抓取网页').closest('.ch-row')!
    expect(row.querySelector('.ch-loading-dot')).toBeNull()
    expect(row.querySelector('.ch-icon-slot [data-icon]')).not.toBeNull()
  })

  it('组行还在跑时同样换成那枚半月 dot，组级的状态灯照挂', () => {
    flowOf(
      makeMessage('assistant', '', {
        streaming: true,
        steps: [
          step({ label: '抓取网页', tool: 'fetch', outcome: 'failed', detail: '第一次' }),
          step({ label: '抓取网页', tool: 'fetch', detail: '第二次', status: 'running' }),
        ],
      }),
    )
    const groupRow = document.querySelector('button[aria-controls^="flow-group-"]') as HTMLElement
    expect(groupRow.querySelector('.ch-loading-dot')).not.toBeNull()
    // outcome badge 照常挂（它说的是"这一组里有一次不成"，与"还在跑"是两件事）
    expect(groupRow.querySelector('[data-testid="step-outcome"]')).not.toBeNull()
    // 组级耗时那一格也撤了
    expect(groupRow.querySelector('[data-duration]')).toBeNull()
  })

  it('被拦下/等确认的行：着色 + 前置展开（不用点开）', () => {
    flowOf(
      makeMessage('assistant', '', {
        steps: [
          step({
            label: '执行命令',
            tool: 'run_command',
            outcome: 'awaiting',
            detail: '这条命令要你先点头',
            result: '等待确认',
          }),
        ],
      }),
    )
    const row = screen.getByText('执行命令').closest('.ch-row')!
    expect(row).toHaveAttribute('data-outcome', 'awaiting')
    // 行体已经摊开（FlowFold data-open=true），返回内容在文档里
    const fold = row.parentElement!.querySelector('.ch-clp')
    expect(fold).toHaveAttribute('data-open', 'true')
    expect(screen.getByText('等待确认')).toBeInTheDocument()
  })

  it('联网搜索组：行上只写结果数，点开直接是一张合并的网页清单（不再套子行），同 url 跨步去重', () => {
    flowOf(
      makeMessage('assistant', '答案', {
        steps: [
          // 两次搜索各带一段真能解析出结果行的返回（`[n] 标题 / 网址 / 摘要`，后端 `_web_search` 的形状）。
          // 第一条网址**两边都有**：合并时按 url 去重，只该出现一次。
          step({
            detail: '第一次',
            result: [
              '检索词：agent skills，共 1 条：',
              '[1] Anthropic 的官方仓库',
              'https://github.com/anthropics/skills',
              '官方维护的仓库。',
            ].join('\n'),
          }),
          step({
            detail: '第二次',
            result: [
              '检索词：agent skills 论文，共 2 条：',
              '[1] 同一条结果（重号又同址）',
              'https://github.com/anthropics/skills',
              '又被搜到一次。',
              '[2] 一篇论文',
              'https://arxiv.org/abs/2401.00001',
              '工具调用可靠性的综述。',
            ].join('\n'),
          }),
        ],
      }),
    )
    /*
      组头按钮按"只有组行才有的 `aria-controls`"查，不按名字查：头部把工具数写进总名、
      组行标题里也有「联网搜索」，按名字查会命中不止一处。
    */
    const groupRow = document.querySelector('button[aria-controls^="flow-group-"]') as HTMLElement
    /*
      行上那一句按 **2026-10-01 用户批注（批四）** 换成「结果数」这一档（原话"这儿就显示
      联网搜索（xx个结果）就可以了"）：`联网搜索（N 个结果）`，N 是**合并后清单**的条数
      （下面那两条去重之后是 2）——不再是 `groupHeading` 那句「联网搜索 2 个关键词 · …」，
      于是**详情格也没有**（关键词在这张清单里逐条列着，行上再复述一遍是噪声）。
    */
    expect(groupRow.querySelector('.ch-row-label')).toHaveTextContent('联网搜索（2 个结果）')
    expect(groupRow.querySelector('.ch-row-detail')).toBeNull()
    /* 行尾那排站点牌整档撤掉（同一条批注，原话"联网搜索这里不要显示网址啊，这个去掉"）。 */
    expect(groupRow.querySelector('[data-testid="web-sites"]')).toBeNull()
    const bodyId = groupRow.getAttribute('aria-controls') as string
    fireEvent.click(groupRow)
    /*
      **组体直接是那张合并清单**（2026-10-01 用户批注："不要在联网搜索里面搞个 list
      再去放联网搜索，点开里面就直接是网页的 list"）：没有子步行（那一排 5px 圆点与
      「联网搜索」按钮都不在），只有网页行；两次搜索的编号会撞号（各自的 `[1]`），
      所以合并是按 **url 去重、保序**——两次都搜到的那条只出现一次。
    */
    const body = document.getElementById(bodyId) as HTMLElement
    expect(body.querySelectorAll('.ch-sub-dot')).toHaveLength(0)
    expect(body.querySelectorAll('button')).toHaveLength(0)
    const hits = [...body.querySelectorAll('.ch-hit')] as HTMLAnchorElement[]
    expect(hits.map((hit) => hit.getAttribute('href'))).toEqual([
      'https://github.com/anthropics/skills',
      'https://arxiv.org/abs/2401.00001',
    ])
    expect(hits[0]).toHaveTextContent('Anthropic 的官方仓库')
    expect(body.querySelector('[data-testid="web-sites"]')).toBeNull()
  })

  it('整轮思考（老消息兜底）：收起时标题是正文首段首行，点开后固定「思考已完成」', () => {
    flowOf(makeMessage('assistant', '答案', { thinkingText: '先想第一段。\n\n再想第二段。' }))
    /*
      标题跟着开合走（2026-09-30 用户批注，照 kimi.com 实测）：**收起时是描述性文字**
      （`thinkingTitle` 在模型层派生：首个非空段落的首行，截 30 字），**点开之后**才换成
      固定那一句「思考已完成」。「 · N 字」那个字数详情一并撤掉。
    */
    const row = screen.getByText('先想第一段。').closest('.ch-row')!
    expect(row.querySelector('.ch-row-label')).toHaveTextContent('先想第一段。')
    expect(row.querySelector('.ch-row-detail')).toBeNull()
    fireEvent.click(row)
    // 点开之后：标题换成固定那一句，正文两段都落在灰字里（标题不再重复正文首行）
    expect(row.querySelector('.ch-row-label')).toHaveTextContent('思考已完成')
    expect(document.querySelector('[data-thinking]')).toHaveTextContent('先想第一段。')
    expect(screen.getByText('再想第二段。')).toBeInTheDocument()
  })

  it('整轮思考的标题截到 30 字：一行标题不是把正文抄一遍', () => {
    const first = '这一段的开头就很长很长很长很长很长很长很长很长很长，后面还有内容。'
    flowOf(makeMessage('assistant', '答案', { thinkingText: `${first}\n\n第二段。` }))
    expect(screen.getByText(`${first.slice(0, 30)}…`)).toBeInTheDocument()
    // 第二段不上标题（只取首段首行）；「取不到就回退固定那一句」那一档在模型层钉
    // （`toolchain-flow` 这一侧到不了：整串只剩空白时这一行根本不画）
    expect(screen.queryByText('第二段。')).toBeNull()
  })

  it('流式中的整轮思考：文案是「思考中…」且带流光', () => {
    flowOf(makeMessage('assistant', '', { streaming: true, thinkingText: '正在想' }))
    const label = screen.getByText('思考中…')
    expect(label.className).toContain('ch-live')
  })

  it('来源行：默认收起；展开出文档名，行上带 data-source，点一条交给宿主', () => {
    const { onOpenSource } = flowOf(makeMessage('assistant', '答案', { sources: [source()] }))
    const row = screen.getByTestId('flow-sources')
    // 默认收起：文档名不在文档里
    expect(screen.queryByText('眼轴监测指南.pdf')).not.toBeInTheDocument()
    fireEvent.click(row)
    const item = screen.getByText('眼轴监测指南.pdf').closest('.ch-src')!
    expect(item).toHaveAttribute('data-source', '1')
    expect(item).not.toHaveAttribute('data-flash')
    fireEvent.click(item)
    expect(onOpenSource).toHaveBeenCalledWith(expect.objectContaining({ chunk_id: 'ck1' }))
  })

  it('单步自带思考：展开那一行，灰字段落在里面（不进正文）', () => {
    flowOf(
      makeMessage('assistant', '答案', {
        steps: [step({ thinking: '先想这一步。\n\n再调工具。' })],
      }),
    )
    const row = screen.getByText('联网搜索').closest('.ch-row') as HTMLElement
    // 默认收起：思考不在文档里；点开才挂上
    expect(screen.queryByText('先想这一步。')).not.toBeInTheDocument()
    fireEvent.click(row)
    expect(screen.getByText('先想这一步。')).toBeInTheDocument()
    expect(screen.getByText('再调工具。').closest('[data-thinking]')).not.toBeNull()
  })

  it('入参里的 art_* 键缀上真实文件名（键保留：那才是传给工具的值）', () => {
    /*
      走**非联网**的一行（导出文档）：联网那两档的展开只剩网页清单（2026-09-30 用户批注），
      Request 面板（入参）只在其余工具行上画。
    */
    flowOf(
      makeMessage('assistant', '答案', {
        steps: [
          step({
            label: '导出文档',
            tool: 'export_document',
            args: '{"file": "art_ab12", "q": "x"}',
          }),
        ],
      }),
      true,
      { artifactNames: new Map([['art_ab12', '季度报告.docx']]) },
    )
    fireEvent.click(screen.getByText('导出文档'))
    const args = document.querySelector('[data-args]')!
    expect(args.textContent).toContain('art_ab12（季度报告.docx）')
  })

  it('行详情不印原始 JSON：`find_tools` 那种返回换成它 `found` 里的工具名', () => {
    /*
      病灶：后端没有摘要时会**回退到返回的开头**（`ToolOutcome.step_detail()`，裁到 120 字），
      于是 `find_tools` 那一步的行里铺的是半截 JSON。2026-09-30 用户批注：这一格不印 JSON
      ——里面唯一对得上用户脑子的东西是 `found` 那段工具名，换成它；取不到就空着。
    */
    flowOf(
      makeMessage('assistant', '答案', {
        steps: [
          step({
            label: '查找工具',
            tool: 'find_tools',
            detail:
              '{"found": ["web_search", "web_fetch"], "note": "这些工具现在可以用了：用 `use_tool` 调',
          }),
        ],
      }),
    )
    const row = screen.getByText('查找工具').closest('.ch-row') as HTMLElement
    expect(row.querySelector('.ch-row-detail')).toHaveTextContent('web_search、web_fetch')
    expect(row.textContent).not.toContain('{')
  })

  it('行详情不印原始 JSON：取不到工具名（别的工具那种 JSON）就整格不画', () => {
    flowOf(
      makeMessage('assistant', '答案', {
        steps: [
          step({
            label: '导出文档',
            tool: 'export_document',
            detail: '{"artifact_id": "art_89cb", "name": "报告.md"}',
          }),
        ],
      }),
    )
    const row = screen.getByText('导出文档').closest('.ch-row') as HTMLElement
    // 宁可这一行什么都不写，也不要把 JSON 当句子印出来（原始载荷在「返回」里，一条没丢）
    expect(row.querySelector('.ch-row-detail')).toBeNull()
    expect(row.textContent).not.toContain('artifact_id')
  })

  it('普通结论一字不动（`displayDetail` 只拦原始 JSON 那一档）', () => {
    /*
      夹具刻意用**非联网**的一行：联网搜索那一档的行详情现在只说 `N 个结果`
      （2026-10-01 用户批注），后端那段原文本来就不再进这一格——"普通结论原样印出来"
      这件事只剩非联网的行还走 `displayDetail` 这条直路。
    */
    flowOf(
      makeMessage('assistant', '答案', {
        steps: [step({ label: '检索知识库', tool: 'search', detail: '「眼轴」命中 3 条' })],
      }),
    )
    const row = screen.getByText('检索知识库').closest('.ch-row') as HTMLElement
    expect(row.querySelector('.ch-row-detail')).toHaveTextContent('「眼轴」命中 3 条')
  })

  it('读技能那一档：展开只有一行字，行详情只剩技能名（2026-10-01 用户批注）', () => {
    /*
      用户两条原话：「如果是读技能的话 就显示 Gained some skills from the file. 就行」。
      于是这一行**展开不再是 Request / Response**（改前是入参面板 + Response 原文——
      那份原文是一整份技能的正文，等同于提示词），只剩一句话；
      **行详情也只留技能名**：后端把返回拼成 `【技能 name】\n正文…`，裁到 120 字之后
      这一格原本是"技能名 + 正文的一截尾巴"，现在截到 `】` 为止（`displayDetail`）。
    */
    flowOf(
      makeMessage('assistant', '答案', {
        steps: [
          step({
            label: '读技能',
            tool: 'read_skill',
            args: '{"name": "kylab-office-export"}',
            detail: '【技能 kylab-office-export】\n正文第一段：这份技能负责把对话导出成文档…',
            result: '【技能 kylab-office-export】\n技能正文：先看产物类型，再选导出通道…',
          }),
        ],
      }),
    )
    const row = screen.getByText('读技能').closest('.ch-row') as HTMLElement
    expect(row.querySelector('.ch-row-detail')).toHaveTextContent('【技能 kylab-office-export】')
    // 正文尾巴不进这一格（它说的是"读了哪个技能"，不是"技能里写了什么"）
    expect(row).not.toHaveTextContent('正文第一段')
    fireEvent.click(screen.getByText('读技能'))
    expect(screen.getByText('Gained some skills from the file.')).toBeInTheDocument()
    // 展开体里**没有**任何面板：Request（入参）与 Response（那份技能正文）都不画
    expect(document.querySelectorAll('.ch-panel-head')).toHaveLength(0)
    expect(document.querySelector('[data-args]')).toBeNull()
    expect(screen.queryByText('{"name": "kylab-office-export"}')).toBeNull()
    expect(screen.queryByText(/技能正文/)).toBeNull()
  })

  it('老快照的读技能（没有工具名，只有标签「读技能」）走同一档', () => {
    /*
      v0.26 之前落库的步骤没有 `tool`，只有后端当时发的中文标签（`LEGACY_LABEL_KINDS`
      与 `displayDetail` 都认它）——这一档的判据两路都认（新数据看工具名、老数据看标签），
      否则用户手上正开着的那批会话会退回"Request + 技能正文"那一版。
    */
    flowOf(
      makeMessage('assistant', '答案', {
        steps: [
          step({
            label: '读技能',
            tool: undefined,
            detail: '【技能 weekly-report】\n正文第一段：这份技能负责写周报…',
            result: '【技能 weekly-report】\n技能正文：先汇总本周进展…',
          }),
        ],
      }),
    )
    const row = screen.getByText('读技能').closest('.ch-row') as HTMLElement
    expect(row.querySelector('.ch-row-detail')).toHaveTextContent('【技能 weekly-report】')
    fireEvent.click(screen.getByText('读技能'))
    expect(screen.getByText('Gained some skills from the file.')).toBeInTheDocument()
    expect(document.querySelectorAll('.ch-panel-head')).toHaveLength(0)
  })

  it('整轮总计：只报耗时本身（「共 N 字」与「用时」前缀都撤了）', () => {
    flowOf(
      makeMessage('assistant', '答案', {
        steps: [
          {
            ...step({ label: '检索知识库', tool: 'search', detail: '命中 3 条' }),
            durationMs: 120_000,
          } as ObservedStep,
          {
            ...step({ label: '导出文档', tool: 'export_document', detail: '已导出' }),
            durationMs: 56_000,
          } as ObservedStep,
        ],
      }),
    )
    // 各步耗时之和 = 2 分 56 秒；这一行只有这一个读数
    const total = screen.getByTestId('trace-total')
    expect(total).toHaveTextContent('2 分 56 秒')
    expect(total).not.toHaveTextContent('用时')
    expect(total).not.toHaveTextContent(/\d+ 字/)
  })

  it('整轮总计：一步都没量到耗时（历史回放、刷新回来的轮次）时**整行不画**', () => {
    flowOf(makeMessage('assistant', '答案', { steps: [step({ detail: '命中 3 条' })] }))
    expect(screen.queryByTestId('trace-total')).toBeNull()
    // 不印一个 0 秒：`durationMs` 只有"界面当场看着跑完"的步才有（见 TraceStep 的口径）
  })

  it('长返回：只铺 600 字预览——「加载全部」那一档整档撤了（2026-10-01 用户批注）', () => {
    /*
      这一档是**非联网行**的行为（Response 面板的预览）：联网那两档的展开只剩网页清单
      （2026-09-30 用户批注），长原文本来就不再铺，所以夹具换成读文件那一档。
      改前被裁掉的那一档还会给一个「加载全部（N 字）/ 收起」的按钮——2026-10-01 用户批注
      之后按钮、`showAll` state 与那一支分支一并删，预览**就是屏幕上给的全部**。
    */
    const long = '这一段很长。'.repeat(200) // 1200 字 > 预览上限 600
    flowOf(
      makeMessage('assistant', '答案', {
        steps: [step({ label: '读取文件', tool: 'read_file', result: long })],
      }),
    )
    fireEvent.click(screen.getByText('读取文件'))
    // 预览在（前 600 字）、全文不在，按钮也不在（点它本来也没别的地方可去）
    expect(screen.getByText(long.slice(0, 600))).toBeInTheDocument()
    expect(screen.queryByText(long)).not.toBeInTheDocument()
    expect(screen.queryByText(/加载全部/)).toBeNull()
    expect(screen.queryByText('收起')).toBeNull()
    expect(document.querySelector('.ch-more')).toBeNull()
  })

  it('抓页那一档：favicon 与页数收进详情位，行尾不再挂那组站点牌（R4）', () => {
    flowOf(
      makeMessage('assistant', '答案', {
        steps: [
          step({
            label: '抓取网页',
            tool: 'web_fetch',
            args: '{"url": "https://moonshot.cn/news"}',
          }),
          step({ label: '检索知识库', tool: 'search' }),
        ],
      }),
    )
    const fetchRow = screen.getByText('抓取网页').closest('.ch-row') as HTMLElement
    /*
      R4 批注：抓页那一行的行级展示对齐 Kimi「获取网页 | 🔴 1 个网页」——
      favicon 与页数都进 label 右侧的详情位（`.ch-row-detail--sites`）。
      **这一格是 2026-10-01 批注（批四）点名保留的那一档**：同一批批注把行尾那排
      **站点牌**（`web-sites`，联网搜索行上那些带域名的牌子）整档撤了，而抓页这里
      `[favicon] N 个网页` 一字未动。
    */
    expect(fetchRow.querySelector('.ch-row-detail--sites')).not.toBeNull()
    expect(fetchRow.querySelector('[data-domain="moonshot.cn"]')).not.toBeNull()
    expect(fetchRow).toHaveTextContent('1 个网页')
    expect(screen.queryByTestId('web-sites')).toBeNull()
    // 知识库检索那行什么都没有（只有联网类工具才认站点）
    expect(
      screen.getByText('检索知识库').closest('.ch-row')!.querySelector('[data-site]'),
    ).toBeNull()
  })

  it('抓页那一档展开：**只留网页清单**（favicon + 完整 URL，Kimi 的 fetch-urls-item）', () => {
    flowOf(
      makeMessage('assistant', '答案', {
        steps: [
          step({
            label: '抓取网页',
            tool: 'web_fetch',
            args: '{"url": "https://moonshot.cn/news"}',
            result: [
              '【Moonshot 新闻页】',
              '来源：https://moonshot.cn/news',
              '',
              '正文第一段。',
            ].join('\n'),
          }),
        ],
      }),
    )
    const row = screen.getByText('抓取网页').closest('.ch-row') as HTMLElement
    // 行图标是抓页那一枚（2026-09-30 用户批注：获取网页与搜索网页分家），data-icon 如实报新档
    expect(row.querySelector('[data-icon="fetch"]')).not.toBeNull()
    fireEvent.click(screen.getByText('抓取网页'))
    /*
      展开 = **一张网页清单**（用户批注"搜索网页的不显示 request 和 response，只显示网页列表"、
      "注意看获取网页列表的样式"、"注意网页 logo 的显示"）：一行 = favicon 16px +
      **完整 URL**（链接色），整行可点、新标签打开——不是"标题 + 域名"那一套。
    */
    const item = document.querySelector('.ch-fetch') as HTMLAnchorElement
    expect(item).toHaveAttribute('href', 'https://moonshot.cn/news')
    expect(item).toHaveAttribute('target', '_blank')
    expect(item).toHaveTextContent('https://moonshot.cn/news')
    expect(item.querySelector('.ch-hit-logo')).not.toBeNull()
    // 这一档**没有** Request / Response 面板，也没有"去掉抬头之后的正文"那段原文
    expect(document.querySelectorAll('.ch-panel-head')).toHaveLength(0)
    expect(screen.queryByText('正文第一段。')).toBeNull()
    expect(screen.queryByText('【Moonshot 新闻页】')).toBeNull()
  })

  it('联网搜索那一档展开：只留搜索结果清单（Request / Response 与列表外的原文都不画）', () => {
    flowOf(
      makeMessage('assistant', '答案', {
        steps: [
          step({
            args: '{"query": "agent skills"}',
            result: [
              '检索词：agent skills，共 2 条：',
              '[1] Anthropic 的官方仓库',
              'https://github.com/anthropics/skills',
              '官方维护的仓库。',
              '[2] 一篇论文',
              'https://arxiv.org/abs/2401.00001',
              '工具调用可靠性的综述。',
              '',
              '【前 2 条的正文开头】（每条最多 2000 字；要读全文用 web_fetch）',
              '【Anthropic 的官方仓库】https://github.com/anthropics/skills',
              '仓库正文……',
            ].join('\n'),
          }),
        ],
      }),
    )
    const row = screen.getByText('联网搜索').closest('.ch-row') as HTMLElement
    /*
      行详情那一格只说结果数（2026-10-01 用户批注："这不要写检索词 就写多少个结果就行"）：
      这一段返回里有 2 条结果，于是印 `2 个结果`——后端那段原文（"检索词：…共 2 条：[1]…"）
      不再铺在这一格里（`displayDetail` 的读技能那一支同理，见下一条）。
    */
    expect(row.querySelector('.ch-row-detail')).toHaveTextContent('2 个结果')
    expect(row.querySelector('.ch-row-detail')).not.toHaveTextContent('检索词')
    fireEvent.click(screen.getByText('联网搜索'))
    // 搜索结果清单照旧（favicon + 标题 + 域名 + 可点）：这一档**一个字没动**
    const hits = [...document.querySelectorAll('.ch-hit')] as HTMLAnchorElement[]
    expect(hits).toHaveLength(2)
    expect(hits[0]).toHaveTextContent('Anthropic 的官方仓库')
    expect(hits[0]).toHaveTextContent('github.com')
    expect(hits[0]).toHaveAttribute('href', 'https://github.com/anthropics/skills')
    // 这一档没有 Request / Response，也没有"前 N 条的正文开头"那段原文（用户批注原话）
    expect(document.querySelectorAll('.ch-panel-head')).toHaveLength(0)
    expect(screen.queryByText('{"query": "agent skills"}')).toBeNull()
    expect(screen.queryByText(/前 2 条的正文开头/)).toBeNull()
    expect(screen.queryByText('仓库正文……')).toBeNull()
  })

  it('联网那一档解不出清单时**不给"能点开"的许诺**（展开区里本来就没东西了）', () => {
    /*
      联网两档的展开只剩清单之后，"有没有东西可展开"就要照清单算：返回解不出清单时
      （比如搜索没做成、后端只回一句人话），这一行不再挂行尾箭头、`aria-expanded` 也不给
      ——否则点开的是一个空盒子。

      行详情那一格**也不再铺后端原文**（2026-10-01 用户批注：这一档只写结果数）：解不出
      结果就是"没有结果数可说"，那一格空着——"联网搜索没做成…"是后端的结果态文案，
      不是用户在这一行要找的东西（原来它靠 `displayDetail` 回退到这里）。
      **失败那一档是例外**（`outcome` 非空，前端置展开的行）——那一种要印原因，
      见下面那条用例。
    */
    flowOf(
      makeMessage('assistant', '答案', {
        steps: [
          step({
            detail: '联网搜索没做成：没有可用的搜索服务',
            result: '联网搜索没做成：没有可用的搜索服务',
          }),
        ],
      }),
    )
    const row = screen.getByText('联网搜索').closest('.ch-row') as HTMLElement
    expect(row).toHaveAttribute('aria-disabled', 'true')
    expect(row).not.toHaveAttribute('aria-expanded')
    expect(row.querySelector('.ch-chev')).toBeNull()
    expect(row.querySelector('.ch-row-detail')).toBeNull()
    expect(row).not.toHaveTextContent('联网搜索没做成')
  })

  it('失败的联网搜索行：行详情回退印那句失败交代（2026-10-01 架构师审查补的口子）', () => {
    /*
      批注撤的是"检索词原文"，**不是失败交代**：被拦下 / 等确认 / 出错那三档
      （`outcomeOf` 非空：failed / blocked / awaiting）这一步**没有别的路说原因**——
      它的返回解不出清单，于是展开体根本不给（`hasBody`，行尾也没有箭头），详情格再空着，
      用户连"为什么没成"都看不到（这是批注第一版改出来的回归）。所以这一档回退到
      `displayDetail(step)` 印出后端那句原因。
    */
    flowOf(
      makeMessage('assistant', '答案', {
        steps: [
          step({
            outcome: 'failed',
            detail: '联网搜索没做成：没有可用的搜索服务',
            result: '联网搜索没做成：没有可用的搜索服务',
          }),
        ],
      }),
    )
    const row = screen.getByText('联网搜索').closest('.ch-row') as HTMLElement
    expect(row.querySelector('.ch-row-detail')).toHaveTextContent('联网搜索没做成')
    // 没有可展开的东西（解不出清单），所以原因只能挂在这一格里（箭头也不该有）
    expect(row).toHaveAttribute('aria-disabled', 'true')
    expect(row.querySelector('.ch-chev')).toBeNull()
  })

  it('联网搜索组解不出清单时**回退子行渲染**（不把一个空盒子摊给用户）', () => {
    /*
      组体换成合并清单的前提是"合得出来"：全组都是联网搜索、但各步的返回里都没有可解析的
      编号列表（半截返回、或这一步压根没做成）时**回退现行子行渲染**——一行一次调用，
      与普通的工具组一模一样（`toolTotal` 那块头部的数也因此仍是 2）。
    */
    flowOf(
      makeMessage('assistant', '答案', {
        steps: [step({ detail: '第一次' }), step({ detail: '第二次' })],
      }),
    )
    const groupRow = document.querySelector('button[aria-controls^="flow-group-"]') as HTMLElement
    fireEvent.click(groupRow)
    const body = document.getElementById(groupRow.getAttribute('aria-controls') as string)!
    // 没有清单可合 → 子行照旧（5px 圆点那一条轴，一行一次调用）
    const rows = [...body.querySelectorAll('button.ch-row')]
    expect(rows).toHaveLength(2)
    expect(rows.map((item) => item.textContent)).toEqual(['联网搜索', '联网搜索'])
    expect(body.querySelectorAll('.ch-sub-dot')).toHaveLength(2)
    expect(body.querySelector('.ch-hit')).toBeNull()
    /*
      顺带钉住同一条批注的另一半：**子行的详情格也不印后端原文**（联网搜索那一档的行
      详情只说 `N 个结果`，这里解不出结果，于是这一格空着）——夹具给的 `第一次` / `第二次`
      一个字都不该出现在页面里。
    */
    expect(screen.queryByText('第一次')).toBeNull()
    expect(screen.queryByText('第二次')).toBeNull()
  })

  it('点正文徽标那一路：来源清单开着时块体也跟着开（否则滚不到那一行）', () => {
    const turn: Turn = {
      user: null,
      reply: makeMessage('assistant', '答案', { sources: [source()] }),
    }
    // open=false（完成轮收起）但 citesOpen=true（revealSource 刚点过）→ 块体必须开
    render(
      <ToolchainFlow
        turn={turn}
        turnIndex={0}
        open={false}
        onToggle={() => {}}
        expansion={{
          isOpen: () => false,
          toggle: () => {},
          groupChoice: () => undefined,
          chooseGroup: () => {},
        }}
        citesOpen
        onToggleCites={() => {}}
        flashSource="0:1"
      />,
    )
    const fold = document.querySelector('.ch-flow > .ch-clp')
    expect(fold).toHaveAttribute('data-open', 'true')
    expect(screen.getByText('眼轴监测指南.pdf').closest('.ch-src')).toHaveAttribute(
      'data-flash',
      'true',
    )
  })
})

/**
 * 2026-10-01 用户批注（批四）在联网搜索这一块上的四条：
 * **行尾那排站点牌整档撤掉**（原话"联网搜索这里不要显示网址啊，这个去掉"）、
 * **搜索组的标题只写结果数**（"这儿就显示 联网搜索（xx个结果）就可以了"）、
 * **连续的联网搜索并成一行**（"多轮，连续的网络搜索做合并处理。把多轮网络搜索的结果放到
 * 一个列表里面。如果两轮之间有其他工具的 这种就正常该怎么样就怎么样"）。
 *
 * 夹具形状的一条说明（下面几条都用得到）：`traceEntries` 是**按非工具步切块**的，搜索组
 * 只在同一块里形成；而要让"两段搜索"到渲染这一层**相邻**，中间那些非工具步必须是
 * `visibleEntries` 会拿掉的那一档——**落定的「组织回答」**。所以这些夹具里 `phase: 'answer'`
 * 那几步是刻意摆出来的隔断（`answerStep()`），不是为了模拟后端一定这么发；批注说的现象是
 * 每日简报那种"一轮里十几组联网搜索连着"的会话。
 */
describe('联网搜索：站点牌、标题与连续合并（2026-10-01 批注批四）', () => {
  /** 一次能解析出结果的联网搜索（`[n] 标题 / 网址 / 摘要`，后端 `_web_search` 的形状）。 */
  function search(title: string, url: string, detail = ''): ChatStep {
    return step({
      detail,
      result: [`检索词：${title}，共 1 条：`, `[1] ${title}`, url, '摘要。'].join('\n'),
    })
  }

  /**
   * 拦在两段搜索之间的那一步：**落定的「组织回答」**。
   * 它是非工具步（`traceEntries` 在这里切块），而 `visibleEntries` 又把落定的它拿掉——
   * 于是被它隔开的搜索到合并那一步已经相邻。
   */
  function answerStep(): ChatStep {
    return { phase: 'answer', label: '组织回答', detail: '', status: 'done' }
  }

  /** 过程块里**顶层**的行（`.ch-sub` 是组内子行，不算一条）。 */
  function topRows(): HTMLElement[] {
    return [...document.querySelectorAll('.ch-body > .ch-item')] as HTMLElement[]
  }

  it('行尾那排站点牌整档撤掉：单步行与组行都不挂（网站在展开的清单里）', () => {
    /*
      原话两条："联网搜索这里不要显示网址啊，这个去掉"、"这种都不需要啊，不要再没展开的时候
      显示，这个直接去掉"。改前这两处（`StepRow` 与 `GroupRow`）各挂一排
      `WebSiteList`（favicon + 域名 + `+N`），现在都删了——**行上不再说"查了哪些站点"**。

      夹具里**故意让两步测试与组都带着真能解析出网址的返回**：改前正是这种数据会在行尾
      挂出牌子来，所以这里断言的"没有牌子"是有对象的（不是"本来就没网址可挂"）。
      中间那一步「检索知识库」是**非联网**的普通工具行，顺带把两段搜索隔开
      （否则它们会被下面那一条的合并收成一行）。
    */
    flowOf(
      makeMessage('assistant', '答案', {
        steps: [
          search('Anthropic 的官方仓库', 'https://github.com/anthropics/skills'),
          step({ label: '检索知识库', tool: 'search', detail: '「眼轴」命中 3 条' }),
          answerStep(),
          search('一篇论文', 'https://arxiv.org/abs/2401.00001'),
          search('维基百科', 'https://zh.wikipedia.org/wiki/Agent'),
        ],
      }),
    )
    const rows = topRows()
    expect(rows).toHaveLength(3)
    const [single, plain, group] = rows as [HTMLElement, HTMLElement, HTMLElement]

    // 单步行：标签 + 「N 个结果」照旧（2026-10-01 批三那一档），但**没有站点牌**
    expect(single.querySelector('.ch-row-label')).toHaveTextContent('联网搜索')
    expect(single.querySelector('.ch-row-detail')).toHaveTextContent('1 个结果')
    expect(single.querySelector('[data-testid="web-sites"]')).toBeNull()
    expect(single.querySelector('[data-site], [data-domain]')).toBeNull()

    // 非联网那一行本来就没有站点可言（钉住"撤牌子没有误伤别的行"）
    expect(plain.querySelector('[data-testid="web-sites"]')).toBeNull()

    // 组行：标签是批四的新形态（「联网搜索（N 个结果）」），也没有站点牌
    expect(group.querySelector('.ch-row-label')).toHaveTextContent('联网搜索（2 个结果）')
    expect(group.querySelector('[data-testid="web-sites"]')).toBeNull()
    expect(group.querySelector('[data-site], [data-domain]')).toBeNull()

    // 整页一处都不该有（`web-sites` 这个 testid 在批四之后已经没有任何调用方）
    expect(screen.queryByTestId('web-sites')).toBeNull()
  })

  it('搜索组的标题只写结果数：`联网搜索（N 个结果）`，连详情格都不画', () => {
    /*
      原话"这儿就显示 联网搜索（xx个结果）就可以了"。N 是**合并后清单**的条数（跨步去重之后），
      与点开看到的条目数对得上；改前这里是 `groupHeading` 那句
      「联网搜索 2 个关键词 · 关键词…」——关键词在这张清单里逐条列着，行上再复述是噪声，
      所以这一档**没有详情格**（`.ch-row-detail` 一个都不画）。
    */
    flowOf(
      makeMessage('assistant', '答案', {
        steps: [
          search('Anthropic 的官方仓库', 'https://github.com/anthropics/skills'),
          // 同一条网址又搜到一次：清单按 url 去重，所以下面写的是「2」不是「3」
          search('同一条结果', 'https://github.com/anthropics/skills'),
          search('一篇论文', 'https://arxiv.org/abs/2401.00001'),
        ],
      }),
    )
    const groupRow = document.querySelector('button[aria-controls^="flow-group-"]') as HTMLElement
    expect(groupRow.querySelector('.ch-row-label')).toHaveTextContent('联网搜索（2 个结果）')
    expect(groupRow.querySelector('.ch-row-detail')).toBeNull()
    expect(groupRow.querySelector('.ch-row-sep')).toBeNull()
    // 头部那个数还是**调用次数**（并的是行，不是工具计数）
    expect(screen.getByTestId('trace-toggle')).toHaveTextContent('使用 3 个工具')
  })

  it('连续的联网搜索并成一行：两搜索组夹一个搜索单步 → 一行，清单跨组按 url 去重', () => {
    /*
      一次调用里的几个关键词本来并成一组；**连着的几组**（每日简报那种一轮十几组）在批四
      之后并成**一行**——点开就是那张网页清单，跨组按 url 去重（同一条结果被两次搜到时
      只出现一次，见 `mergedSearchHits`）。

      夹具的隔断就是那两步落定的「组织回答」：`traceEntries` 拿它们切块（于是两侧各成一组），
      `visibleEntries` 又拿掉它们（于是到这里三段搜索已经相邻，正是"连续"该有的样子）。
    */
    flowOf(
      makeMessage('assistant', '答案', {
        steps: [
          search('Anthropic 的官方仓库', 'https://github.com/anthropics/skills'),
          search('一篇论文', 'https://arxiv.org/abs/2401.00001'),
          answerStep(),
          // 单步那一段（这一块里只有一次搜索）：它也是要并进来的一份
          search('同一条结果（又一次）', 'https://github.com/anthropics/skills'),
          answerStep(),
          search('维基百科', 'https://zh.wikipedia.org/wiki/Agent'),
          search('MDN 的文档', 'https://developer.mozilla.org/en-US/docs/Web/API'),
        ],
      }),
    )
    // 三段并成**一行**：整个过程块里只有一个组行（其余非搜索的步一条都没有）
    const rows = topRows()
    expect(rows).toHaveLength(1)
    const merged = rows[0]!
    expect(merged.querySelector('.ch-row-label')).toHaveTextContent('联网搜索（4 个结果）')
    // 5 次调用仍算 5 个工具（合成组原样持有它并掉的那些步骤）
    expect(screen.getByTestId('trace-toggle')).toHaveTextContent('使用 5 个工具')

    fireEvent.click(merged.querySelector('button.ch-row')!)
    const hits = [...merged.querySelectorAll('a.ch-hit')] as HTMLAnchorElement[]
    /*
      跨组去重、保序：github 那条在三段里出现过两次（第二段那次同址），只该出现一次；
      剩下三条按"第一次搜到的先后"排。
    */
    expect(hits.map((hit) => hit.getAttribute('href'))).toEqual([
      'https://github.com/anthropics/skills',
      'https://arxiv.org/abs/2401.00001',
      'https://zh.wikipedia.org/wiki/Agent',
      'https://developer.mozilla.org/en-US/docs/Web/API',
    ])
    // 并成一行之后组体里**没有子行**（点开就是清单，2026-10-01 批三那一档）
    expect(merged.querySelectorAll('.ch-sub')).toHaveLength(0)
    // 行上仍然没有站点牌（批四的另一半）
    expect(merged.querySelector('[data-testid="web-sites"]')).toBeNull()
  })

  it('抓取网页打断连续搜索：它是"其他工具"那一档，两段搜索各自成行', () => {
    /*
      原话的后半句"如果两轮之间有其他工具的 这种就正常该怎么样就怎么样"。抓页那一步是
      **非搜索条目**（`isWebStep && !isFetchStep` 才算搜索），所以它把两段搜索挡开——
      它自己也照旧单独一行（R4 那一档：favicon + 页数收在详情位里）。
    */
    flowOf(
      makeMessage('assistant', '答案', {
        steps: [
          search('Anthropic 的官方仓库', 'https://github.com/anthropics/skills'),
          answerStep(),
          step({
            label: '抓取网页',
            tool: 'web_fetch',
            args: '{"url": "https://moonshot.cn/news"}',
          }),
          answerStep(),
          search('一篇论文', 'https://arxiv.org/abs/2401.00001'),
        ],
      }),
    )
    const rows = topRows()
    expect(rows).toHaveLength(3)
    expect(rows.map((row) => row.querySelector('.ch-row-label')?.textContent)).toEqual([
      '联网搜索',
      '抓取网页',
      '联网搜索',
    ])
    // 一行都没并起来：一个组行都没有（组只在 ≥2 个连续搜索条目时才出现）
    expect(document.querySelectorAll('button[aria-controls^="flow-group-"]')).toHaveLength(0)
    // 抓页那一行照旧：`[favicon] N 个网页`（批四点名保留的那一档）
    const fetchRow = rows[1]!.querySelector('.ch-row') as HTMLElement
    expect(fetchRow.querySelector('.ch-row-detail--sites')).not.toBeNull()
    expect(fetchRow.querySelector('[data-domain="moonshot.cn"]')).not.toBeNull()
    expect(fetchRow).toHaveTextContent('1 个网页')
  })

  it('含失败步的条目不并：没成的那一次要单独露脸（否则被并进大组就等于看不见了）', () => {
    /*
      判据在 `mergeSearchRuns`：**任何含 `forceExpand(step)` 的条目都打断**。失败 / 被拦下 /
      等确认的行按 R4 是前置展开且着色的（"这一步说的不是成功"），把它们并进一大组里
      等于把唯一能看见问题的那一行藏起来。
    */
    flowOf(
      makeMessage('assistant', '答案', {
        steps: [
          step({
            outcome: 'failed',
            detail: '联网搜索没做成：没有可用的搜索服务',
            result: '联网搜索没做成：没有可用的搜索服务',
          }),
          answerStep(),
          search('Anthropic 的官方仓库', 'https://github.com/anthropics/skills'),
          search('一篇论文', 'https://arxiv.org/abs/2401.00001'),
        ],
      }),
    )
    const rows = topRows()
    expect(rows).toHaveLength(2)
    /*
      失败那一次自己一行：`outcome` 落在行上（`data-outcome="failed"`，行因此是前置展开那一档），
      原因写在详情格里——这一步的返回解不出清单，展开体本来就不给（`hasBody` 为假），
      所以"没成"只有这一行说得出（2026-10-01 架构师审查补的口子，见上面那一条用例）。
    */
    const failed = rows[0]!.querySelector('.ch-row') as HTMLElement
    expect(failed).toHaveAttribute('data-outcome', 'failed')
    expect(failed.querySelector('.ch-row-detail')).toHaveTextContent('联网搜索没做成')
    // 失败那一步**不把后面那一段拖下水**：它是自己一个条目（一段），后面那两次搜索照常合成一组
    expect(rows[1]!.querySelector('.ch-row-label')).toHaveTextContent('联网搜索（2 个结果）')
  })

  it('只有一组时不并：单独一个搜索组照旧是它自己那一行（键都还是它自己的）', () => {
    /*
      判据"一段连续 ≥ 2 个条目才并"这一半。单独一组时不走合并那一路——证据看**键**：
      合并出来的组键是 `searchrun:` 开头（取首条目首步的 key），而 `traceEntries` 自己那一组
      是 `group:` 开头。键只在这一层是"实现细节"，但它决定的是**用户看得见的那件事**：
      "他点开过没有"记在宿主上（`ChatProvider` 的 openGroups），键换了 = 他点过的状态丢了。

      行上那一句仍是批四的新形态（并且是**另一个组**：上面那条用例管的是 ≥2 个条目）。
    */
    flowOf(
      makeMessage('assistant', '答案', {
        steps: [
          search('Anthropic 的官方仓库', 'https://github.com/anthropics/skills'),
          search('一篇论文', 'https://arxiv.org/abs/2401.00001'),
          step({ label: '写笔记', tool: 'create_note', detail: '已建笔记「摘要」' }),
        ],
      }),
    )
    const groupRow = document.querySelector('button[aria-controls^="flow-group-"]') as HTMLElement
    expect(groupRow.querySelector('.ch-row-label')).toHaveTextContent('联网搜索（2 个结果）')
    const controls = groupRow.getAttribute('aria-controls') as string
    expect(controls).toContain(':group:')
    expect(controls).not.toContain('searchrun')
  })
})
