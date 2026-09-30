/**
 * 回答里 `[n]` 那枚**站点徽章**要用的数据：编号 → 网页引用（D11-③）。
 *
 * 用户要的样子（照 Kimi）：行内是一枚**小圆角徽章 = 站点真实 logo + 域名**，
 * 悬停/聚焦出一张卡片：站点 + 域名 / 页面标题 / 一两行摘要 / 可点可复制的 URL。
 *
 * ## 数据从哪来（**不新增后端字段**）
 *
 * 知识库出处的 `ChatSource`（`document_name / heading_path / page / preview`）里
 * **没有 URL、没有站点**——它是一条文档片段，画不出"站点徽章"。而网页引用的
 * 标题 / 网址 / 摘要**本来就在库里**：`web_search` 那一步的返回就是后端渲染好的
 * 编号列表（`services/tools.py::_web_search`）：
 *
 * ```
 * 检索词：agent skills，共 3 条：
 * [1] Anthropic 的官方仓库
 * https://github.com/anthropics/skills
 * 摘要…
 * ```
 *
 * 于是这里只做一件事：把**已经有**的那段文本解析成引用（摘要就是搜索结果自带的那行
 * snippet），站点标识复用 `webSites.ts` 那张表。**不新开接口、不动搜索与抓取链路。**
 *
 * ## 只认这一种形状
 *
 * 只解析 `[n] 标题 / 网址 / 摘要` 的编号列表（`web_search` 的返回）。`web_fetch` 的返回
 * 不是编号列表（它是"【标题】网址 + 正文"），回答里的 `[n]` 也不会指它——所以那不解析，
 * 宁可少一枚徽章，也不猜一个编号对应哪一页。
 */

import { hostOfUrl, siteOfDomain, type WebSite } from './webSites'

/** 一枚网页引用（回答里那个编号指的东西）。 */
export interface WebCitation {
  /** 回答里的编号（`[3]` → 3）。 */
  index: number
  /** 搜索结果给的页面标题。 */
  title: string
  /** 页面网址（可点、可复制）。 */
  url: string
  /** 网址的域名（徽章上写的那个，如 `github.com`）。 */
  domain: string
  /** 搜索结果给的摘要（取不到就是空串——那就只显示标题与 URL）。 */
  snippet: string
  /** 站点标识（本机表给的 logo/名字；未命中时 `id` 为空，界面退化成通用地球）。 */
  site: WebSite
}

/** 摘要最多留多少字：卡片里只给"一两行"，多的交给 URL 与原文。 */
export const SNIPPET_MAX_CHARS = 160

/** `[3] 标题` 那一行。 */
const HIT_RE = /^\[(\d+)\]\s*(.*)$/

/** 正文节选那一段的抬头：到了这里搜索结果就结束了（后面是顺带抓回来的正文）。 */
const EXCERPT_MARK = '【前'

/** 一步一步从搜索返回里挑出引用（纯函数，输入是那一步的 `result` 文本）。 */
function citationsFromResult(text: string, into: Map<number, WebCitation>): void {
  const lines = text.replace(/\\\//g, '/').split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim()
    if (line.startsWith(EXCERPT_MARK)) return
    const matched = HIT_RE.exec(line)
    if (!matched) continue
    const number = Number(matched[1])
    if (!Number.isInteger(number) || into.has(number)) continue
    // 标题 / 网址 / 摘要 三行是**连续**的（后端就是这么渲染的）：先找网址那一行
    let url = ''
    let urlAt = -1
    for (let cursor = index + 1; cursor < Math.min(index + 4, lines.length); cursor += 1) {
      const candidate = lines[cursor]!.trim()
      if (/^https?:\/\//i.test(candidate)) {
        url = candidate
        urlAt = cursor
        break
      }
      if (HIT_RE.test(candidate)) break
    }
    if (!url) continue
    const domain = hostOfUrl(url)
    if (!domain) continue
    const snippet = (lines[urlAt + 1] ?? '').trim().slice(0, SNIPPET_MAX_CHARS)
    into.set(number, {
      index: number,
      title: matched[2]!.trim(),
      url,
      domain,
      snippet,
      site: siteOfDomain(domain),
    })
  }
}

/**
 * 这些步骤里能解析出来的网页引用（编号 → 引用）。
 *
 * 只认联网搜索那两步（`web_search` / `web_fetch`，与站点那一行同一个判据来源），
 * 而且只在返回文本里找**编号列表**。多个搜索步骤时**先出现的编号先占**：
 * 一条回答里的编号是模型按它看到的顺序写的，后来的那次搜索用的是新的序号区间。
 */
export function webCitationsOfSteps(
  steps: readonly { tool?: string; label?: string; result?: string }[],
): Map<number, WebCitation> {
  const found = new Map<number, WebCitation>()
  for (const step of steps) {
    if (!isSearchStep(step)) continue
    citationsFromResult(step.result ?? '', found)
  }
  return found
}

/** 这一步是不是"网上搜了一次"（与 `webSites.ts::isWebStep` 同一份口径，只是排除抓页）。 */
function isSearchStep(step: { tool?: string; label?: string }): boolean {
  if (step.tool) return step.tool === 'web_search'
  return step.label === '联网搜索'
}

/**
 * 编号列表**之后**那一段原文（`【前 N 条的正文开头】…`），没有就给空串。
 *
 * 为什么单独取这一段：搜索步展开时，编号列表已经由 `ui/SearchHits.tsx` 画成清单了
 * （标题 / 域名 / 可点），再铺一遍原文是同一件事说两遍；而**正文开头那几段清单里没有**
 * （它不是"一条结果"，是被抓回来的页面内容）。所以列表画列表的、这一段照旧给原文，
 * 两者合起来才是这一步返回的全部内容（不丢信息）。
 *
 * 判据就是解析时用的那个抬头（`EXCERPT_MARK`）：解析到它就停，这里从它开始取。
 */
export function searchExcerptTail(result: string): string {
  const at = result.indexOf(EXCERPT_MARK)
  return at < 0 ? '' : result.slice(at).trim()
}
