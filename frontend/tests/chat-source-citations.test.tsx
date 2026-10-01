/**
 * 回答里的**来源标注**（D11-③，用户："做得优雅，向 Kimi 看齐"）。
 *
 * 两半：
 *
 * 1. **解析**（`model/sourceCitations.ts`）：把联网搜索那一步**已有的返回文本**
 *    （后端渲染的 `[n] 标题 / 网址 / 摘要` 编号列表）解析成引用。**不加后端字段**；
 * 2. **渲染**（`ui/SourceCard.tsx` + `ui/AnswerText.tsx`）：行内一枚小圆角徽章
 *    （站点真实 logo + 域名），**点击直开原文那一页**（2026-09-30 用户定案：Kimi 的
 *    `pua-ref-cite-tag` 就是一个 `<a target="_blank" rel="noopener noreferrer">`；
 *    改前点它是"展开过程面板滚到那条出处"），悬停/聚焦出**一张**卡片
 *    （标题 / 摘要 / 可点可复制的 URL），Esc 关，贴边翻转，
 *    **没有「赞 / 踩」**（后端没有回收反馈的地方，摆假按钮是骗人）。
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
import { SearchHits } from '@/features/chat/ui/SearchHits'
import { SourceBadge, SourceCardHost } from '@/features/chat/ui/SourceCard'
import { WebSiteIcons } from '@/features/chat/ui/WebSiteList'
import { resetSiteIconCache } from '@/features/chat/ui/siteLogos'
import {
  CLOSE_GRACE_MS,
  activeCitation,
  cardPlacement,
  hideCitation,
  hideCitationNow,
  resetCitation,
  showCitation,
} from '@/features/chat/ui/sourceCardStore'

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

/**
 * 一条**本机站点表之外** + 一条表里的结果（2026-10-01 批注那条正好是表外的域名）。
 *
 * `opendatalab.github.io` 是用户批注里点到的那个：改前它显示一枚域名首字母「O」的灰圆，
 * 因为前端带着 `if (!site.id) return` 的守卫、后端还拿一张白名单把表外域名拒了。
 */
const OUTSIDER_RESULT = [
  '检索词：web，共 2 条：',
  '[1] OpenDataLab 的文档站',
  'https://opendatalab.github.io/foo',
  '摘要。',
  '[2] 知乎上的一问',
  'https://www.zhihu.com/question/1',
  '摘要。',
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

  function renderBadge() {
    return render(
      <>
        <SourceBadge citation={citation} />
        <SourceCardHost />
      </>,
    )
  }

  it('徽章是一个锚点（直开原文那一页）+ 可访问名字与 aria 关系；卡片默认不在文档里', () => {
    renderBadge()

    const badge = screen.getByRole('link', { name: '来源 1：github.com' })
    expect(badge).toHaveTextContent('github.com')
    // 用户 2026-09-30 定案：点它就是打开原文那一页（Kimi 的 `pua-ref-cite-tag` 同款）
    expect(badge).toHaveAttribute('href', 'https://github.com/anthropics/skills')
    expect(badge).toHaveAttribute('target', '_blank')
    expect(badge).toHaveAttribute('rel', 'noopener noreferrer')
    expect(badge).toHaveAttribute('aria-expanded', 'false')
    expect(badge).toHaveAttribute('aria-controls', 'source-citation-card')
    expect(screen.queryByTestId('source-card')).not.toBeInTheDocument()
  })

  it('悬停出卡片：标题 / 摘要 / 可点可复制的 URL；**没有「赞 / 踩」**', async () => {
    renderBadge()

    await userEvent.hover(screen.getByRole('link', { name: '来源 1：github.com' }))

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
    expect(screen.getByRole('link', { name: '来源 1：github.com' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
  })

  it('Esc 关掉卡片', async () => {
    renderBadge()
    await userEvent.hover(screen.getByRole('link', { name: '来源 1：github.com' }))
    expect(await screen.findByTestId('source-card')).toBeInTheDocument()

    await userEvent.keyboard('{Escape}')

    expect(screen.queryByTestId('source-card')).not.toBeInTheDocument()
  })

  it('点它就是**打开原文那一页**（改前是"展开过程面板滚到那条出处"，用户拍板换掉）', () => {
    renderBadge()

    const badge = screen.getByRole('link', { name: '来源 1：github.com' })
    // 锚点这一下由**浏览器**负责：这里钉住它确实是那一条原文、而且是新标签新窗口
    expect(badge.tagName).toBe('A')
    expect(badge).toHaveAttribute('href', 'https://github.com/anthropics/skills')
    expect(badge).toHaveAttribute('target', '_blank')
    expect(badge).toHaveAttribute('rel', 'noopener noreferrer')
    /*
      改前那一版点它会展开过程面板（`onOpen` 那个 prop）——现在**那个 prop 已经不存在了**，
      所以"点击"这条路上没有我们自己的副作用：卡片只在悬停 / 聚焦时出现（上一条用例钉着）。
      这一条不去真点：jsdom 里点锚点只会打一行 "Not implemented: navigation"，
      而"打开那一页"是浏览器的事，钉住 `href/target/rel` 才是能验的那一半。
    */
    expect(activeCitation()).toBeNull()
  })

  it('**两条引用只挂一张卡**（徽章只报是哪一条）', async () => {
    const second = webCitationsOfSteps([{ tool: 'web_search', result: SEARCH_RESULT }]).get(2)!
    render(
      <>
        <SourceBadge citation={citation} />
        <SourceBadge citation={second} />
        <SourceCardHost />
      </>,
    )

    await userEvent.hover(screen.getByRole('link', { name: '来源 1：github.com' }))
    await screen.findByTestId('source-card')
    await userEvent.hover(screen.getByRole('link', { name: '来源 2：arxiv.org' }))

    const cards = screen.getAllByTestId('source-card')
    expect(cards).toHaveLength(1)
    expect(cards[0]).toHaveTextContent('arxiv.org')
  })
})

describe('悬停抖动那条修法：共享状态 + 关闭宽限（用户："hover 有概率鬼畜抖动"）', () => {
  const citation = webCitationsOfSteps([{ tool: 'web_search', result: SEARCH_RESULT }]).get(1)!

  it('hideCitation 只是"请求关闭"：宽限内再 show 就撤销（指针从胶囊挪到卡片上不会闪）', () => {
    vi.useFakeTimers()
    try {
      showCitation(citation, null)
      hideCitation()
      // 还没到宽限：仍然开着（否则卡片已被卸掉，指针就落空了）
      expect(activeCitation()).not.toBeNull()

      vi.advanceTimersByTime(CLOSE_GRACE_MS - 20)
      showCitation(citation, null) // 指针挪到卡片上：卡片这一侧报到
      vi.advanceTimersByTime(CLOSE_GRACE_MS * 3)
      expect(activeCitation()).not.toBeNull()

      // 真正离开（不再回来）→ 过了宽限才关
      hideCitation()
      vi.advanceTimersByTime(CLOSE_GRACE_MS - 10)
      expect(activeCitation()).not.toBeNull()
      vi.advanceTimersByTime(20)
      expect(activeCitation()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('Esc 是立刻关（不走宽限）', () => {
    showCitation(citation, null)

    hideCitationNow()

    expect(activeCitation()).toBeNull()
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

    // 徽章的契约：一个**锚点**，名字是「来源 N：域名」，直开那一页，且与那张卡建立了 aria 关系
    const badge = screen.getByRole('link', { name: '来源 1：github.com' })
    expect(badge).toHaveTextContent('github.com')
    expect(badge).toHaveAttribute('href', 'https://github.com/anthropics/skills')
    expect(badge).toHaveAttribute('aria-controls', 'source-citation-card')
    expect(screen.getByRole('link', { name: '来源 2：arxiv.org' })).toBeInTheDocument()
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

describe('站点图标：表外域名照样发请求，兜底画通用地球而不是域名首字母（2026-10-01 用户批注）', () => {
  const found = webCitationsOfSteps([{ tool: 'web_search', result: OUTSIDER_RESULT }])
  /** 表外的那个域名（`opendatalab.github.io`：本机站点表里没有它，后端白名单也已撤）。 */
  const outsider = found.get(1)!
  /** 表里的站点（知乎：名字与「知」这枚字牌用户都认得出）。 */
  const known = found.get(2)!

  const originalFetch = globalThis.fetch

  /**
   * 真实取图那一层（`ui/siteLogos.ts`）与浏览器打两样交道：`fetch` 与
   * `URL.createObjectURL`。**jsdom 没有后者**——而它在取图的第一行就是守卫：
   * 缺了它连请求都不发（那一步正是这条用例要钉住的），所以两样都补上。
   *
   * `ok=false` 模拟"这个站点没有图标"（后端 404）：前端据此退回兜底那一档。
   */
  function stubIconFetcher(ok: boolean): string[] {
    const calls: string[] = []
    ;(URL as unknown as Record<string, unknown>).createObjectURL = vi.fn(() => 'blob:site-icon')
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        calls.push(String(input))
        const response = ok
          ? { ok: true, blob: async () => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]) }
          : { ok: false, blob: async () => new Blob([]) }
        return Promise.resolve(response as Response)
      }),
    )
    return calls
  }

  afterEach(() => {
    // 模块级的 Promise 缓存与被补上的浏览器能力都不该漏到下一个用例里
    resetSiteIconCache()
    vi.stubGlobal('fetch', originalFetch)
    ;(URL as unknown as Record<string, unknown>).createObjectURL = undefined
  })

  it('**表外的域名也发一次 site-icons 请求**（改前被 `useSiteLogo` 的 id 守卫挡着，一次都不发）', async () => {
    const calls = stubIconFetcher(true)

    render(<SourceBadge citation={outsider} />)

    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toContain('/site-icons?domain=opendatalab.github.io')
  })

  it('拿到真实图标就换成图（表外的域名与表里的站点走同一条路）', async () => {
    stubIconFetcher(true)

    const { container } = render(<SourceBadge citation={outsider} />)

    await waitFor(() => expect(container.querySelector('img')).not.toBeNull())
    expect(container.querySelector('img')).toHaveAttribute('src', 'blob:site-icon')
  })

  it('取不到图标：**认不出的站点画通用地球**，不再是域名首字母的灰圆', async () => {
    stubIconFetcher(false)

    const { container } = render(<SourceBadge citation={outsider} />)

    await waitFor(() => expect(container.querySelector('svg.lucide-globe')).not.toBeNull())
    // 徽章里只剩域名：那个「O」没有了（用户："你放个字母标在这儿没意义啊"）
    expect(container.querySelector('a')!.textContent).toBe('opendatalab.github.io')
  })

  it('取不到图标：**认得出的站点仍旧用它的字牌**（知乎的「知」）', async () => {
    stubIconFetcher(false)

    const { container } = render(<SourceBadge citation={known} />)

    await waitFor(() => expect(container.querySelector('svg.lucide-globe')).toBeNull())
    expect(container.querySelector('a')!.textContent).toBe('知zhihu.com')
  })

  it('清单与徽章同一口径：搜索清单与抓页图标位的兜底也是通用地球（圆里没有字母）', async () => {
    stubIconFetcher(false)

    const { container } = render(
      <>
        <SearchHits
          hits={[
            {
              url: outsider.url,
              title: 'OpenDataLab 的文档站',
              domain: outsider.domain,
              site: outsider.site,
            },
          ]}
        />
        <WebSiteIcons sites={[outsider.site]} more={0} />
      </>,
    )

    await waitFor(() => expect(container.querySelectorAll('svg.lucide-globe')).toHaveLength(2))
    for (const tile of container.querySelectorAll('.ch-hit-logo--letter')) {
      expect(tile.textContent).toBe('')
    }
  })
})
