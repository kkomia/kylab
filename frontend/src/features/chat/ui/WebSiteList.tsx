/**
 * 「这一步查了哪些站点」那一排小牌子（§12.334 第二节，web 步骤专用）。
 *
 * 数据全部来自 `model/webSites.ts`（纯函数 + 本机站点表）：这一层只画，
 * 不判断"哪些算站点"——那一件事（`webSitesOfSteps` / `isWebStep`）在两个渲染位置
 * （单步那一行、同类并成的一组那一行）都要用，只能有一处。
 *
 * 画法三条（D11-② 起）：
 *
 * 1. **先画一枚兜底牌子**（**一帧都不空**），同时向我们自己的源要该站点的
 *    **真实 logo**（`GET /api/v1/site-icons?domain=…`）；拿到就换成图，
 *    槽位尺寸逐字相同（`SITE_TILE` / `SITE_TILE_IMG`），所以换图不引起重排；
 * 2. **拿不到就留在兜底牌上**（离线、没缓存、站点没有图标…都算）——不留空、不报错、
 *    不在控制台留 error。兜底分两档：**表里认得出的站点**用它的字牌（知乎「知」），
 *    **认不出的画一枚通用地球**（**域名首字母那一档 2026-10-01 撤了**：用户
 *    "你放个字母标在这儿没意义啊"）；
 * 3. **认不出的站点照样去要真实图标**——"已知站点表"只决定显示成什么名字与字牌，
 *    不再决定"准不准抓"（后端那张同源的白名单也已撤，见 `services/site_icons.py`）；
 *    域名本身就认不出来时才连请求都不发（`site.domain` 为空）。
 *
 * 为什么图标走后端而不是让浏览器直连 `https://<域名>/favicon.ico`：那等于在渲染这一行时
 * 把用户的 IP / UA 交给被查站点（**浏览器只跟我们自己的源说话**）。服务端那一层负责
 * 公网校验（`check_public_url`）与磁盘缓存，见 `backend/app/services/site_icons.py`。
 *
 * 取图用 `fetch` + `Blob` + `ObjectURL` 而不是 `<img src="…">`：这一组端点要凭据，
 * 而 `<img>` 带不了 `Authorization`；顺带也避免了 404 在控制台留下"加载图片失败"。
 * 取图那一层只有一份（`siteLogos.ts`）——这个文件里原先还有一份**复制粘贴的**
 * `iconCache` / `loadSiteIcon` / `fetchSiteIcon`，没有任何调用方，随这次改动删掉。
 *
 * `data-site` / `data-domain` 供断言：前者只在"认出来"时有值，正好把第 3 条钉住；
 * 换成真实 logo 后多一个 `data-site-logo`（用例据此断言"图真的换上了"）。
 */
import { Globe } from 'lucide-react'

import type { WebSite, WebSites } from '@/features/chat/model/webSites'
import { formatCount } from '@/lib/format'

import { useSiteLogo } from './siteLogos'
import { SITE_CHIP, SITE_MORE, SITE_STRIP, SITE_TILE, SITE_TILE_IMG } from './traceStyles'

/**
 * 一枚站点图标位：固定 1.2em，**先画兜底牌、拿到 logo 再换图**。
 *
 * 兜底链：字牌（表里认得出的站点）→ 通用地球。**没有域名首字母那一档**
 * （2026-10-01 用户："你放个字母标在这儿没意义啊"）。
 */
function SiteLogo({ site }: { site: WebSite }) {
  const url = useSiteLogo(site)

  if (url) {
    return <img className={SITE_TILE_IMG} src={url} alt="" aria-hidden data-site-logo={site.id} />
  }
  if (site.badge) {
    return (
      <span className={SITE_TILE} aria-hidden>
        {site.badge}
      </span>
    )
  }
  return <Globe className={SITE_TILE} size={11} aria-hidden />
}

export function WebSiteList({ sites, more }: WebSites) {
  // 一个站点都没有就什么都不画（非 web 步骤、以及联网那步没带回任何网址时）
  if (sites.length === 0) return null

  return (
    <span className={SITE_STRIP} data-testid="web-sites">
      {sites.map((site) => (
        <span
          key={site.domain}
          className={SITE_CHIP}
          data-site={site.id || undefined}
          data-domain={site.domain}
          title={`${site.name}（${site.domain}）`}
        >
          <SiteLogo site={site} />
          {site.name}
        </span>
      ))}
      {more > 0 ? <span className={SITE_MORE}>+{formatCount(more)}</span> : null}
    </span>
  )
}

/**
 * **只有 favicon 的一排**（不带站点名）——抓页那一档行上用（2026-09-30 R4 批注：
 * Kimi 的行是「获取网页 | 🔴 1 个网页」）。
 *
 * 与 `WebSiteList` 的差别只有"写不写站点名"：抓页行那一格要同时放下 favicon 与页数，
 * 写名字会把这一行撑长；站点名与域名仍在 `title` 里，悬停看得到。
 *
 * 尺寸取 `SearchHits` 那一枚 favicon 的类（16px 圆）——行内的那一枚与展开清单里的
 * 那几枚因此是同一副样子。
 */
export function WebSiteIcons({ sites, more }: WebSites) {
  if (sites.length === 0) return null
  return (
    <span className="ch-site-icons" data-testid="web-site-icons">
      {sites.map((site) => (
        <CompactLogo key={site.domain} site={site} />
      ))}
      {more > 0 ? <span className="ch-site-icons-more">+{formatCount(more)}</span> : null}
    </span>
  )
}

function CompactLogo({ site }: { site: WebSite }) {
  const url = useSiteLogo(site)
  if (url) {
    return (
      <img
        className="ch-hit-logo"
        src={url}
        alt=""
        aria-hidden
        data-site={site.id || undefined}
        data-domain={site.domain}
        data-site-logo={site.id}
      />
    )
  }
  if (site.badge) {
    return (
      <span
        className="ch-hit-logo ch-hit-logo--letter"
        aria-hidden
        data-site={site.id || undefined}
        data-domain={site.domain}
      >
        {site.badge}
      </span>
    )
  }
  return (
    <span
      className="ch-hit-logo ch-hit-logo--letter"
      aria-hidden
      data-site={site.id || undefined}
      data-domain={site.domain}
    >
      <Globe size={11} />
    </span>
  )
}
