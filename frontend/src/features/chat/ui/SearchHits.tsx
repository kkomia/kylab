/**
 * 联网搜索那一步的**结果列表**（Kimi 网页版排版，2026-09-30 用户批注 §3）。
 *
 * 原先这一步展开是一整块等宽原文（`StepResult` 兜底那一档）：
 * `检索词：… [1] 标题 / https://… / 摘要`。信息都在，但**读不出"查到了哪几个网页"**——
 * 网址、标题、摘要在同一行里被等宽字排成一团。Kimi 的做法是一张清单：
 *
 * ```
 * [favicon] 标题（左，单行省略）                    域名（右，灰）
 * ```
 *
 * 数据**不新增任何后端字段**：编号、标题、网址、域名全部来自这一步已有的返回文本
 * （`model/sourceCitations.ts` 解析那张 `[n] 标题 / 网址 / 摘要` 的编号列表），
 * 站点 logo 走本机那一条链路（`siteLogos.ts` → 我们自己的源，浏览器不直连第三方站点）。
 *
 * 三条写下来的口径：
 *
 * 1. **整行可点、新标签打开**：一行就是一个 `<a target="_blank">`（Kimi 同款），
 *    命中区是整行（32px 高），不是标题那几个字；
 * 2. **favicon 16px，取不到就退字母圆**：真实 logo 是异步来的（先画字母圆、拿到图再换，
 *    尺寸逐字相同所以不重排）；拿不到就留在**域名首字母的灰圆**上——
 *    不留空、不报错、不发第三方请求；
 * 3. **超过 8 行内部滚**：8 × 32 = 256px 是 Kimi 那个 `max-height`（设计文档 §8 实测值），
 *    列表自己滚，不把工具链块撑长。
 *
 * 摘要（`citation.snippet`）不占一行（Kimi 的行里也只有标题与域名），挂在整行的
 * `title` 上——悬停仍看得到"这条讲了什么"。那一段"前 N 条的正文开头"更长的原文
 * 不在这里画，由调用方接在列表下面（见 `ToolchainFlow` 的 `searchExcerptTail`）。
 */
import type { WebCitation } from '@/features/chat/model/sourceCitations'

import { useSiteLogo } from './siteLogos'

/**
 * 一枚 favicon 位：**先画字母圆、拿到真实 logo 再换图**（同尺寸，不重排）。
 *
 * 表里认出来的站点用它的字牌（`site.badge`，如 GitHub 的 `G`、知乎的 `知`）；
 * 表外的域名用**域名首字母**——「加载失败用域名首字母灰圆兜底」是用户给的口径。
 */
function HitLogo({ citation }: { citation: WebCitation }) {
  const url = useSiteLogo(citation.site)
  if (url) {
    return (
      <img className="ch-hit-logo" src={url} alt="" aria-hidden data-hit-logo={citation.site.id} />
    )
  }
  const letter = citation.site.badge || citation.domain.slice(0, 1)
  return (
    <span className="ch-hit-logo ch-hit-logo--letter" aria-hidden>
      {letter.toUpperCase()}
    </span>
  )
}

export function SearchHits({ hits }: { hits: readonly WebCitation[] }) {
  if (hits.length === 0) return null
  return (
    <div className="ch-hits" data-result="web">
      {hits.map((hit) => (
        <a
          key={hit.index}
          className="ch-hit"
          href={hit.url}
          target="_blank"
          rel="noreferrer noopener"
          data-hit-index={hit.index}
          data-domain={hit.domain}
          // 摘要不占行：Kimi 的行里只有标题与域名，那"这条讲了什么"就挂在悬停里
          title={[hit.title || hit.domain, hit.snippet, hit.url].filter(Boolean).join('\n')}
        >
          <HitLogo citation={hit} />
          <span className="ch-hit-title">{hit.title || hit.domain}</span>
          <span className="ch-hit-domain">{hit.domain}</span>
        </a>
      ))}
    </div>
  )
}
