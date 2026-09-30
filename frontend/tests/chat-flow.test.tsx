/**
 * 工具链块（ToolchainFlow）的用例——《对话UI-重做-设计》§4 的回归防线。
 *
 * 钉住的是**新结构的行为默认值**：
 *
 * 1. 直接作答（无步骤/无思考/无来源）整块不画（legacy 兜底行不算数）；
 * 2. 头的摘要 + 步数；点块头 = 点宿主的开合开关；
 * 3. running 行 = 流光 +「进行中」，done 行 = 耗时；被拦下/等确认的行**前置展开**；
 * 4. 同工具并组（「N 次」、没碰过的组看"还在跑就摊开"、他点过的组听他的——
 *    开合状态在宿主手里，这里的夹具就是它的替身）；
 * 5. 行体（入参/返回/思考）默认**不上 DOM**，点开才挂（`everOpened` 的 DOM 开销纪律）；
 * 6. 整轮思考（老消息兜底）与来源清单各自成行、默认收起；来源行带 `data-source`
 *    与 `data-flash`（点正文徽标那条链路的物证）。
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
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

function flowOf(reply: ReturnType<typeof makeMessage>, open = true) {
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

  it('头的摘要行 + 步数；点头 = 点宿主的开合开关', () => {
    const { onToggle } = flowOf(
      makeMessage('assistant', '答案', {
        steps: [step(), step({ label: '抓取网页', tool: 'fetch' })],
      }),
    )
    expect(screen.getByText('2 步')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /本轮没有命中资料/ }))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('档位：open=false 时折叠体是 data-open=false（内容从没展开过则不上 DOM）', () => {
    flowOf(makeMessage('assistant', '答案', { steps: [step({ args: '{"q":"x"}' })] }), false)
    const fold = document.querySelector('.ch-flow > .ch-clp')
    expect(fold).toHaveAttribute('data-open', 'false')
    // 从没展开过：行体里的入参不在文档里
    expect(screen.queryByText('{"q":"x"}')).not.toBeInTheDocument()
  })

  it('running 的行是流光 +「进行中」；done 的行报耗时', () => {
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
    expect(screen.getByText('进行中')).toBeInTheDocument()
    expect(screen.getByText('1 秒')).toBeInTheDocument()
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

  it('同类工具并成一组：「2 次」；展开后子行是圆点，各次仍可再展开看原文', () => {
    flowOf(
      makeMessage('assistant', '答案', {
        steps: [step({ detail: '第一次' }), step({ detail: '第二次', result: '搜索结果正文' })],
      }),
    )
    const groupRow = screen.getByRole('button', { name: /联网搜索/ })
    // 组行标题是聚合句（`groupHeading`：数目数对象、对象列出来），不再是干巴巴的「N 次」
    expect(groupRow.textContent).toContain('联网搜索')
    // 组体展开（没碰过的组看默认档：跑完的组是收起的）
    fireEvent.click(groupRow)
    expect(screen.getByText('第一次')).toBeInTheDocument()
    expect(screen.getByText('第二次')).toBeInTheDocument()
    expect(document.querySelectorAll('.ch-sub-dot').length).toBe(2)
    // 单次的返回默认不上 DOM；点开那一行才挂
    expect(screen.queryByText('搜索结果正文')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('第二次'))
    expect(screen.getByText('搜索结果正文')).toBeInTheDocument()
  })

  it('整轮思考（老消息兜底）：一行「思考已完成 · N 字」，点开是灰字段落', () => {
    flowOf(makeMessage('assistant', '答案', { thinkingText: '先想第一段。\n\n再想第二段。' }))
    const row = screen.getByText(/思考已完成 · /).closest('.ch-row')!
    fireEvent.click(row)
    expect(screen.getByText('先想第一段。')).toBeInTheDocument()
    expect(screen.getByText('再想第二段。')).toBeInTheDocument()
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
