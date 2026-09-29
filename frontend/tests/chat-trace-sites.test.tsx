/**
 * 联网那几步的**站点标识**（§12.334 第二节）。
 *
 * 用户的原话："网页搜索 一定要把 网页的 logo 给显示出来。这样用户大致可以知道
 * 在查询哪些常见的网页。" 所以这里钉三件事：
 *
 * 1. **域名从这一步已有的数据里取**（`args` / `result`），不新增后端字段——
 *    `web_fetch` 的网址在入参里，`web_search` 的网址在返回里（后端把结果渲染成
 *    "标题 / 网址 / 摘要"的编号文本），两处都要认；
 * 2. **认不出来就退化成域名文字**（不编名字、也不向那个站点发任何请求）；
 * 3. **不是 web 工具就不画**（读文件读到的正文里也有链接，那不算"它在查哪些网页"）。
 *
 * 第三组是**接线**：纯函数全对而那一行没画出来，等于没做（D19 的教训）。
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TraceStep } from '@/features/chat/model/turns'
import {
  KNOWN_DOMAINS,
  MAX_WEB_SITES,
  hostOfUrl,
  siteOfDomain,
  urlsIn,
  webSitesOfSteps,
} from '@/features/chat/model/webSites'
import { TraceStepRow } from '@/features/chat/ui/TraceStepRow'
import { resetSiteIconCache } from '@/features/chat/ui/WebSiteList'

/** 后端 `_web_search` 的返回形状：编号 + 标题 + 网址 + 摘要。 */
const WEB_RESULT = [
  '检索词：agent skills，共 3 条：',
  '[1] Anthropic 的官方仓库',
  'https://github.com/anthropics/skills',
  '摘要…',
  '[2] 一篇论文',
  'https://arxiv.org/abs/2401.00001',
  '摘要…',
  '[3] 维基百科',
  'https://en.wikipedia.org/wiki/Agent',
].join('\n')

describe('域名解析：网址 → 站点（纯函数）', () => {
  it('hostOfUrl：去 www、去端口、小写；认不出来给空串', () => {
    expect(hostOfUrl('https://www.Example.com:443/a?b=1')).toBe('example.com')
    expect(hostOfUrl('http://arxiv.org/abs/2401.1')).toBe('arxiv.org')
    // 单标签主机（本机 / 内网名）没有"站点"可言，也没有 favicon 可认
    expect(hostOfUrl('http://localhost:8000/health')).toBe('')
    // 不是 http(s) 的一律不算（这是"网页搜索"，不是任意 URI）
    expect(hostOfUrl('ftp://example.com/a')).toBe('')
    expect(hostOfUrl('随手写的一句话')).toBe('')
  })

  it('urlsIn：认得转义过的斜杠，也吃得下中文句读粘在网址后面', () => {
    // 有些模型把 JSON 里的斜杠转义着发出来（`https:\/\/…`）
    expect(urlsIn('{"url": "https:\\/\\/example.com/a"}')).toEqual(['https://example.com/a'])
    // 中文句号直接粘在网址后面时，域名要能截干净
    expect(hostOfUrl(urlsIn('见 https://example.com。')[0]!)).toBe('example.com')
  })

  it('siteOfDomain：本机表命中给标识/名字/牌子，子域也算命中', () => {
    expect(siteOfDomain('github.com')).toEqual({
      id: 'github',
      domain: 'github.com',
      name: 'GitHub',
      badge: 'G',
    })
    // 子域匹配（`en.wikipedia.org` 与 `mp.weixin.qq.com` 都归到那一条）
    expect(siteOfDomain('en.wikipedia.org').id).toBe('wikipedia')
    expect(siteOfDomain('mp.weixin.qq.com').name).toBe('微信公众号')
    // 最具体的那一条优先：`developer.mozilla.org` 不能被更短的键认走
    expect(siteOfDomain('developer.mozilla.org').id).toBe('mdn')
  })

  it('siteOfDomain：**未命中就如实退回域名**（id 与牌子都空）', () => {
    expect(siteOfDomain('example.com')).toEqual({
      id: '',
      domain: 'example.com',
      name: 'example.com',
      badge: '',
    })
    // 长得像但不是：不能被后缀匹配误认成 github
    expect(siteOfDomain('notgithub.com').id).toBe('')
  })
})

describe('这一步查了哪些站点：两处取域名、去重、保序、截断', () => {
  it('web_search：入参只有检索词，域名从**返回**里取', () => {
    const { sites, more } = webSitesOfSteps([
      {
        tool: 'web_search',
        label: '联网搜索',
        args: '{"query": "agent skills"}',
        result: WEB_RESULT,
      },
    ])

    expect(sites.map((site) => site.domain)).toEqual([
      'github.com',
      'arxiv.org',
      'en.wikipedia.org',
    ])
    expect(sites.map((site) => site.name)).toEqual(['GitHub', 'arXiv', '维基百科'])
    expect(more).toBe(0)
  })

  it('web_fetch：网址在**入参**里（一次能给多个网址）', () => {
    const { sites } = webSitesOfSteps([
      {
        tool: 'web_fetch',
        label: '抓取网页',
        args: '{"urls": ["https://news.example.com/a", "https://stackoverflow.com/q/1"]}',
      },
    ])

    // 未命中的那个排在前面，如实显示域名；命中的给站点名
    expect(sites.map((site) => site.name)).toEqual(['news.example.com', 'Stack Overflow'])
    expect(sites[0]!.id).toBe('')
    expect(sites[1]!.id).toBe('stackoverflow')
  })

  it('同一个站点的多页只算一个（去重），顺序按出现先后', () => {
    const { sites } = webSitesOfSteps([
      { tool: 'web_fetch', label: '抓取网页', args: '{"url":"https://github.com/a"}' },
      { tool: 'web_fetch', label: '抓取网页', args: '{"url":"https://github.com/b"}' },
      { tool: 'web_fetch', label: '抓取网页', args: '{"url":"https://arxiv.org/x"}' },
    ])

    expect(sites.map((site) => site.domain)).toEqual(['github.com', 'arxiv.org'])
  })

  it('超过上限就收成 +N（一行不能比结论还长）', () => {
    const urls = ['a.example.com', 'b.example.com', 'c.example.com', 'd.example.com'].map(
      (host) => `https://${host}/x`,
    )
    const { sites, more } = webSitesOfSteps([
      { tool: 'web_fetch', label: '抓取网页', args: JSON.stringify({ urls }) },
    ])

    expect(sites).toHaveLength(MAX_WEB_SITES)
    expect(more).toBe(1)
  })

  it('**不是 web 工具就不认**：哪怕返回里全是网址', () => {
    const local = [
      // 在文件里搜（`search_files`）与读文件读到的正文里都可能有链接
      { tool: 'search_files', label: '在文件里搜', result: WEB_RESULT },
      { tool: 'read_file', label: '读文件', result: WEB_RESULT },
      { tool: 'search', label: '检索知识库', result: WEB_RESULT },
    ]

    expect(webSitesOfSteps(local)).toEqual({ sites: [], more: 0 })
  })

  it('是 web 工具、但这一轮没带回任何网址 → 一个站点都没有', () => {
    expect(
      webSitesOfSteps([
        { tool: 'web_search', label: '联网搜索', args: '{"query": "x"}', result: '没搜到' },
      ]),
    ).toEqual({ sites: [], more: 0 })
  })

  it('老快照（没有工具名）按当时的标签认：联网搜索 / 抓取网页', () => {
    expect(webSitesOfSteps([{ label: '联网搜索', result: WEB_RESULT }]).sites.length).toBe(3)
    expect(webSitesOfSteps([{ label: '检索知识库', result: WEB_RESULT }]).sites).toEqual([])
  })
})

/** 一行（`TraceStepRow`）的桩：这一层不认识上下文，只有步骤本身。 */
function step(extra: Partial<TraceStep> = {}): TraceStep {
  return {
    key: 'tool-0',
    icon: 'search',
    label: '联网搜索',
    detail: '「agent skills」命中 3 条',
    tool: 'web_search',
    kind: 'search',
    ...extra,
  }
}

function row(extra: Partial<TraceStep>) {
  return render(<TraceStepRow step={step(extra)} open={false} onToggle={vi.fn()} />)
}

describe('接线：站点那一行真的画在一行上（不是只有纯函数对）', () => {
  it('命中的站点给"牌子 + 站点名"，并留下 data-site / data-domain', () => {
    row({ result: WEB_RESULT })

    const strip = screen.getByTestId('web-sites')
    const github = within(strip).getByText('GitHub')
    expect(github).toHaveAttribute('data-site', 'github')
    expect(github).toHaveAttribute('data-domain', 'github.com')
    // 牌子上的那一个字（本机表给的标识）
    expect(within(github).getByText('G')).toBeInTheDocument()
    // 排在第二、第三的两个站也在这一行上
    expect(within(strip).getByText('arXiv')).toBeInTheDocument()
    expect(within(strip).getByText('维基百科')).toBeInTheDocument()
  })

  it('**未命中退化成域名文字**：没有 data-site，写的就是域名', () => {
    row({ result: '见 https://news.example.com/a 这一篇' })

    const strip = screen.getByTestId('web-sites')
    const chip = within(strip).getByText('news.example.com')
    expect(chip).not.toHaveAttribute('data-site')
    expect(chip).toHaveAttribute('data-domain', 'news.example.com')
  })

  it('args 里没有网址、返回里也没有 → 不画这一行', () => {
    row({ args: '{"query": "x"}', result: '没有搜到结果' })

    expect(screen.queryByTestId('web-sites')).toBeNull()
  })

  it('不是 web 工具 → 不画（哪怕返回里全是网址）', () => {
    row({ tool: 'search_files', label: '在文件里搜', result: WEB_RESULT })

    expect(screen.queryByTestId('web-sites')).toBeNull()
  })

  it('文案照旧：标签与结论一个字都没少（换成图标不是换成纯图标）', () => {
    row({ result: WEB_RESULT })

    expect(screen.getByText('联网搜索')).toBeInTheDocument()
    expect(screen.getByText(/命中 3 条/)).toBeInTheDocument()
  })
})

/**
 * 真实 logo（D11-②）。
 *
 * 用户原话："网页搜索 一定要把 网页的 logo 给显示出来"——这一版把"本机表给的字母牌"
 * 升级成"站点真实 logo"，但**走我们自己的源**（`/api/v1/site-icons`）：浏览器不直连第三方，
 * 也不在每次重绘时发请求。所以这里钉四件事：
 *
 * 1. 请求发给我们自己、而且**只发给表里的站点**；
 * 2. 拿到图就换掉字母牌，**外框尺寸逐字相同**（不引起重排跳动）；
 * 3. 取不到（404 / 网络错 / 环境不支持 ObjectURL）**一律退回字母牌**，不抛、不打印；
 * 4. 两张表（前端已知站点、后端白名单）必须一起动——漂了只会在界面上悄悄退回字母牌。
 */
describe('真实 logo：向自己的源要图，取不到退回字母牌', () => {
  const okResponse = () =>
    ({ ok: true, blob: async () => new Blob([new Uint8Array([1, 2, 3])]) }) as unknown as Response
  const logo = () => document.querySelector('[data-site-logo="github"]')
  /** 抓住**原始**的 URL：直接给全局那一个塞属性会留到后面的用例里（stubGlobal 只还原绑定）。 */
  const RealURL = URL

  function stubObjectUrl(): void {
    class FakeURL extends RealURL {}
    Object.assign(FakeURL, { createObjectURL: () => 'blob:site-icon' })
    vi.stubGlobal('URL', FakeURL)
  }

  beforeEach(() => {
    resetSiteIconCache()
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    resetSiteIconCache()
  })

  it('命中的站点：请求发给我们自己的源，拿到图就换成真实 logo（外框尺寸不变）', async () => {
    stubObjectUrl()
    const fetchMock = vi.fn(async () => okResponse())
    vi.stubGlobal('fetch', fetchMock)

    row({ result: WEB_RESULT })

    await waitFor(() => expect(logo()).not.toBeNull())
    const [url] = fetchMock.mock.calls[0] as unknown as [string]
    expect(url).toBe('/api/v1/site-icons?domain=github.com')
    // **尺寸逐字相同**：换图前后都是那枚 1.2em 的方框（否则这一行会抖一下）
    const img = logo() as HTMLElement
    expect(img.className).toContain('h-[1.2em]')
    expect(img.className).toContain('w-[1.2em]')
    // 这一行有三个命中站点，各请求一次（同一个域名只发一次）
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('未命中的站点**一次请求都不发**（表外的域名不出我们的源）', () => {
    stubObjectUrl()
    const fetchMock = vi.fn(async () => okResponse())
    vi.stubGlobal('fetch', fetchMock)

    row({ result: '见 https://news.example.com/a 这一篇' })

    expect(screen.getByTestId('web-sites')).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('取不到（404）→ 退回字母牌，不留空、不抛', async () => {
    stubObjectUrl()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false }) as unknown as Response),
    )

    row({ result: WEB_RESULT })

    const strip = screen.getByTestId('web-sites')
    expect(within(strip).getByText('G')).toBeInTheDocument()
    expect(logo()).toBeNull()
  })

  it('网络报错 → 也是字母牌，而且**控制台一声不响**（验收项：零 error）', async () => {
    stubObjectUrl()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('Failed to fetch')
      }),
    )
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    row({ result: WEB_RESULT })
    await waitFor(() => expect(logo()).toBeNull())

    const strip = screen.getByTestId('web-sites')
    expect(within(strip).getByText('G')).toBeInTheDocument()
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('环境没有 ObjectURL（老浏览器）→ 直接退化，不发请求', () => {
    class FakeURL extends RealURL {}
    Object.assign(FakeURL, { createObjectURL: undefined })
    vi.stubGlobal('URL', FakeURL)
    const fetchMock = vi.fn(async () => okResponse())
    vi.stubGlobal('fetch', fetchMock)
    expect(typeof URL.createObjectURL).toBe('undefined')

    row({ result: WEB_RESULT })

    expect(screen.getByText('G')).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('两张表必须一起动：前端已知站点表 = 后端图标白名单', () => {
  it('域名集合逐项相同（漂了不会报错，只会让某些站点的 logo 悄悄退回字母牌）', () => {
    // vitest 的工作目录就是 `frontend/`（见 vite.config.ts 的 root），所以后端文件在 `../` 下
    const source = readFileSync(
      join(process.cwd(), '..', 'backend', 'app', 'services', 'site_icons.py'),
      'utf8',
    )
    const block = source.slice(
      source.indexOf('ALLOWED_DOMAINS: frozenset'),
      source.indexOf('ICON_PATHS'),
    )
    // 只认"长得像域名的"引号串：这一段里还夹着中文注释（注释里的引号不该混进来）
    const backend = new Set(
      [...block.matchAll(/"([a-z0-9.-]+\.[a-z]{2,})"/g)].map((match) => match[1]),
    )

    expect([...backend].sort()).toEqual([...KNOWN_DOMAINS].sort())
  })
})
