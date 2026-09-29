/**
 * 回答里的**来源标注**（D11-③，用户："做得优雅，向 Kimi 看齐"）。
 *
 * 两半：
 *
 * 1. **解析**（`model/sourceCitations.ts`）：把联网搜索那一步**已有的返回文本**
 *    （后端渲染的 `[n] 标题 / 网址 / 摘要` 编号列表）解析成引用。**不加后端字段**；
 * 2. **渲染**（`ui/SourceCard.tsx` + `ui/AnswerText.tsx`）：行内一枚小圆角徽章
 *    （站点真实 logo + 域名），悬停/聚焦出**一张**卡片（标题 / 摘要 / 可点可复制的 URL），
 *    Esc 关，贴边翻转，**没有「赞 / 踩」**（后端没有回收反馈的地方，摆假按钮是骗人）。
 *
 * 三条边界在这里钉死：
 * - 解析不出 URL/域名的编号**退回原来那句说明**（`citeFallback`），不出现空徽章 / 破图；
 * - 知识库出处的编号**照旧**（它是文档，不是网页）；
 * - `[n]` 的组里有一个对不上 → 整组不换（既有口径，不动）。
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { webCitationsOfSteps } from '@/features/chat/model/sourceCitations'
import { AnswerText } from '@/features/chat/ui/AnswerText'
import { SourceBadge, SourceCardHost } from '@/features/chat/ui/SourceCard'
import { cardPlacement, resetCitation } from '@/features/chat/ui/sourceCardStore'

/** 后端 `services/tools.py::_web_search` 的返回形状（逐字照抄它渲染的那几行）。 */
const SEARCH_RESULT = [
  '检索词：agent skills，共 3 条：',
  '[1] Anthropic 的官方仓库',
  'https://github.com/anthropics/skills',
  '官方维护的 Agent Skills 仓库，含文档与示例。',
  '[2] 一篇论文',
  'https://arxiv.org/abs/2401.00001',
  '关于工具调用可靠性的综述。',
  '[3] 维基百科',
  'https://en.wikipedia.org/wiki/Agent',
  '智能体的百科条目。',
  '',
  '【前 2 条的正文开头】（每条最多 2000 字；要读全文用 web_fetch）',
  '【Anthropic 的官方仓库】https://github.com/anthropics/skills',
  '仓库正文……',
].join('\n')

afterEach(() => {
  resetCitation()
})

describe('解析：编号 → 网页引用（数据来自联网那一步已有的返回）', () => {
  it('把 [n] 标题 / 网址 / 摘要 解析成引用（域名走本机站点表）', () => {
    const found = webCitationsOfSteps([
      { tool: 'web_search', label: '联网搜索', result: SEARCH_RESULT },
    ])

    expect([...found.keys()]).toEqual([1, 2, 3])
    const first = found.get(1)!
    expect(first.title).toBe('Anthropic 的官方仓库')
    expect(first.url).toBe('https://github.com/anthropics/skills')
    expect(first.domain).toBe('github.com')
    expect(first.site.id).toBe('github')
    expect(first.snippet).toContain('Agent Skills')
    // 子域也归到表里那一条（`en.wikipedia.org` → 维基百科）
    expect(found.get(3)!.site.id).toBe('wikipedia')
  })

  it('"前几条正文开头"那一段不再解析（那里没有编号）', () => {
    const found = webCitationsOfSteps([{ tool: 'web_search', result: SEARCH_RESULT }])

    expect(found.size).toBe(3)
  })

  it('**解析不出域名就整条不要**（宁可退回那句说明，也不出空徽章 / 破图）', () => {
    const found = webCitationsOfSteps([
      {
        tool: 'web_search',
        result:
          '检索词：x，共 2 条：\n[1] 标题\n不是网址\n摘要\n[2] 好的一条\nhttps://github.com/a\n摘要',
      },
    ])

    expect([...found.keys()]).toEqual([2])
  })

  it('只认"网上搜了一次"那一步：抓页 / 知识库检索 / 非工具步骤都不解析', () => {
    expect(
      webCitationsOfSteps([
        { tool: 'web_fetch', label: '抓取网页', result: '[1] 标题\nhttps://github.com/a\n摘要' },
        { tool: 'search', label: '检索知识库', result: SEARCH_RESULT },
      ]).size,
    ).toBe(0)
    // 老快照（没有工具名）按当时的标签认
    expect(webCitationsOfSteps([{ label: '联网搜索', result: SEARCH_RESULT }]).size).toBe(3)
  })

  it('多个搜索步骤：同一个编号先到先得', () => {
    const found = webCitationsOfSteps([
      { tool: 'web_search', result: '[1] 第一次\nhttps://github.com/a\nA' },
      { tool: 'web_search', result: '[1] 第二次\nhttps://arxiv.org/abs/1\nB' },
    ])

    expect(found.get(1)!.title).toBe('第一次')
  })
})

describe('徽章与卡片（一次只挂一张，hover / focus / Esc / aria）', () => {
  const citation = webCitationsOfSteps([{ tool: 'web_search', result: SEARCH_RESULT }]).get(1)!

  function renderBadge(onOpen = vi.fn()) {
    return render(
      <>
        <SourceBadge citation={citation} onOpen={onOpen} />
        <SourceCardHost />
      </>,
    )
  }

  it('徽章写域名、带可访问名字与 aria 关系；卡片默认不在文档里', () => {
    renderBadge()

    const badge = screen.getByRole('button', { name: '来源 1：github.com' })
    expect(badge).toHaveTextContent('github.com')
    expect(badge).toHaveAttribute('aria-expanded', 'false')
    expect(badge).toHaveAttribute('aria-controls', 'source-citation-card')
    expect(screen.queryByTestId('source-card')).not.toBeInTheDocument()
  })

  it('悬停出卡片：标题 / 摘要 / 可点可复制的 URL；**没有「赞 / 踩」**', async () => {
    renderBadge()

    await userEvent.hover(screen.getByRole('button', { name: '来源 1：github.com' }))

    const card = await screen.findByTestId('source-card')
    expect(card).toHaveAttribute('role', 'dialog')
    expect(within(card).getByText('Anthropic 的官方仓库')).toBeInTheDocument()
    expect(within(card).getByText(/Agent Skills 仓库/)).toBeInTheDocument()
    const link = within(card).getByRole('link')
    expect(link).toHaveAttribute('href', 'https://github.com/anthropics/skills')
    expect(link).toHaveAttribute('target', '_blank')
    expect(within(card).getByRole('button', { name: '复制链接' })).toBeInTheDocument()
    // 反馈按钮一个都不许有（后端没有回收它们的地方）
    for (const name of [/赞/, /踩/, /有用/, /无用/]) {
      expect(within(card).queryByRole('button', { name })).toBeNull()
    }
  })

  it('键盘聚焦也能出（Tab 到它就行）', async () => {
    renderBadge()

    await userEvent.tab()

    expect(await screen.findByTestId('source-card')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '来源 1：github.com' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
  })

  it('Esc 关掉卡片', async () => {
    renderBadge()
    await userEvent.hover(screen.getByRole('button', { name: '来源 1：github.com' }))
    expect(await screen.findByTestId('source-card')).toBeInTheDocument()

    await userEvent.keyboard('{Escape}')

    expect(screen.queryByTestId('source-card')).not.toBeInTheDocument()
  })

  it('点了徽章走既有那条路（展开过程面板滚到那条出处）', async () => {
    const onOpen = vi.fn()
    renderBadge(onOpen)

    await userEvent.click(screen.getByRole('button', { name: '来源 1：github.com' }))

    expect(onOpen).toHaveBeenCalledWith(1)
  })

  it('**两条引用只挂一张卡**（徽章只报是哪一条）', async () => {
    const second = webCitationsOfSteps([{ tool: 'web_search', result: SEARCH_RESULT }]).get(2)!
    render(
      <>
        <SourceBadge citation={citation} onOpen={vi.fn()} />
        <SourceBadge citation={second} onOpen={vi.fn()} />
        <SourceCardHost />
      </>,
    )

    await userEvent.hover(screen.getByRole('button', { name: '来源 1：github.com' }))
    await screen.findByTestId('source-card')
    await userEvent.hover(screen.getByRole('button', { name: '来源 2：arxiv.org' }))

    const cards = screen.getAllByTestId('source-card')
    expect(cards).toHaveLength(1)
    expect(cards[0]).toHaveTextContent('arxiv.org')
  })
})

describe('贴边翻转（纯函数，卡片不许被视口/抽屉裁掉）', () => {
  it('下方放不下就翻到上方', () => {
    const at = cardPlacement(
      { top: 900, bottom: 920, left: 100, right: 200 },
      { width: 320, height: 200 },
      { width: 1280, height: 1000 },
    )

    expect(at.above).toBe(true)
    expect(at.top).toBeLessThan(900)
  })

  it('靠右就右对齐，并且夹在视口内', () => {
    const at = cardPlacement(
      { top: 100, bottom: 120, left: 1000, right: 1100 },
      { width: 320, height: 200 },
      { width: 1280, height: 1000 },
    )

    expect(at.alignEnd).toBe(true)
    expect(at.left + 320).toBeLessThanOrEqual(1280)
  })
})

describe('接线：正文里的 [n] 变成站点徽章（知识库那条照旧）', () => {
  const answer = '官方仓库写得很清楚[1]，论文里也有说明[2]，这条对不上[9]。'
  const citations = webCitationsOfSteps([{ tool: 'web_search', result: SEARCH_RESULT }])

  function renderAnswer(fallback?: { title: string; citations?: typeof citations }) {
    return render(
      <AnswerText text={answer} sources={[]} onCite={vi.fn()} citeFallback={fallback} />,
    )
  }

  it('给了 citations：编号渲染成徽章（真实 logo 位 + 域名 + aria），不再是裸 [1]', () => {
    renderAnswer({ title: '联网搜索结果，见过程面板', citations })

    // 徽章的契约：一个可点的按钮，名字是「来源 N：域名」，且与那张卡建立了 aria 关系
    const badge = screen.getByRole('button', { name: '来源 1：github.com' })
    expect(badge).toHaveTextContent('github.com')
    expect(badge).toHaveAttribute('aria-controls', 'source-citation-card')
    expect(screen.getByRole('button', { name: '来源 2：arxiv.org' })).toBeInTheDocument()
    expect(screen.queryByText('[1]')).toBeNull()
    // 那一枚对不上的仍然走原来那句说明（不伪造出处）
    const plain = screen.getByText('[9]')
    expect(plain).toHaveAttribute('title', '联网搜索结果，见过程面板')
  })

  it('没给 citations（老调用方）：照旧是"有说明的非链接"', () => {
    renderAnswer({ title: '联网搜索结果，见过程面板' })

    expect(screen.getByText('[1]')).toHaveAttribute('title', '联网搜索结果，见过程面板')
    expect(screen.queryByText('github.com')).toBeNull()
  })

  it('知识库出处照旧画文档名（它是文档，不是网页）', () => {
    render(
      <AnswerText
        text="见这一段[1]。"
        sources={[
          {
            index: 1,
            chunk_id: 'c1',
            document_id: 'd1',
            document_name: '共识.pdf',
            heading_path: null,
            page: 3,
            score: 0.5,
            preview: '原文',
            knowledge_base_id: 'kb1',
          },
        ]}
        onCite={vi.fn()}
      />,
    )

    expect(screen.getByText('共识')).toBeInTheDocument()
    expect(screen.queryByText('github.com')).toBeNull()
  })

  it('卡片只在正文那一层挂一个（两条引用的回答也只多出一个宿主）', async () => {
    renderAnswer({ title: '联网搜索结果，见过程面板', citations })

    await userEvent.hover(screen.getByText('github.com'))
    await waitFor(() => expect(screen.getAllByTestId('source-card')).toHaveLength(1))
  })
})
