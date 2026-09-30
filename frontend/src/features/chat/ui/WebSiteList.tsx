/**
 * 「这一步查了哪些站点」那一排小牌子（§12.334 第二节，web 步骤专用）。
 *
 * 数据全部来自 `model/webSites.ts`（纯函数 + 本机站点表）：这一层只画，
 * 不判断"哪些算站点"——那一件事（`webSitesOfSteps` / `isWebStep`）在两个渲染位置
 * （单步那一行、同类并成的一组那一行）都要用，只能有一处。
 *
 * 画法三条（D11-② 起）：
 *
 * 1. **认出来的站点**先画一枚字母/字牌（**一帧都不空**），同时向我们自己的源要
 *    该站点的**真实 logo**（`GET /api/v1/site-icons?domain=…`）；拿到就换成图，
 *    槽位尺寸逐字相同（`SITE_TILE` / `SITE_TILE_IMG`），所以换图不引起重排；
 * 2. **拿不到就留在字母牌上**（离线、没缓存、站点没有图标…都算）——不留空、不报错、
 *    不在控制台留 error；
 * 3. **没认出来的**退化成**域名文字本身** + 一枚通用地球——不编名字，
 *    用户照样看得出在查哪个站；而且**不发任何请求**。
 *
 * 为什么图标走后端而不是让浏览器直连 `https://<域名>/favicon.ico`：那等于在渲染这一行时
 * 把用户的 IP / UA 交给被查站点（**浏览器只跟我们自己的源说话**）。服务端那一层负责
 * 白名单、公网校验与磁盘缓存，见 `backend/app/services/site_icons.py`。
 *
 * 取图用 `fetch` + `Blob` + `ObjectURL` 而不是 `<img src="…">`：这一组端点要凭据，
 * 而 `<img>` 带不了 `Authorization`；顺带也避免了 404 在控制台留下"加载图片失败"。
 *
 * `data-site` / `data-domain` 供断言：前者只在"认出来"时有值，正好把第 3 条钉住；
 * 换成真实 logo 后多一个 `data-site-logo`（用例据此断言"图真的换上了"）。
 */
import { Globe } from 'lucide-react'
import { useEffect, useState } from 'react'

import { API_BASE, authHeaders } from '@/api/client'
import type { WebSite, WebSites } from '@/features/chat/model/webSites'
import { formatCount } from '@/lib/format'

import { useSiteLogo } from './siteLogos'
import { SITE_CHIP, SITE_MORE, SITE_STRIP, SITE_TILE, SITE_TILE_IMG } from './traceStyles'

/**
 * 图标缓存：**同一个站点只请求一次**。
 *
 * 一个站点会在好几条步骤、好几条会话里出现，而这几行可能同时挂载；
 * 缓存的是 Promise（不是结果）——同时来的第二个调用直接等同一个请求。
 * `ObjectURL` 故意不回收：活到页面结束，最多几十个对象，比"卸载时回收、
 * 再挂载时重新请求"省事也省流量。
 */
const iconCache = new Map<string, Promise<string | null>>()

/** 用例之间清缓存（模块级缓存不该把上一个用例的结果带进下一个）。 */
export function resetSiteIconCache(): void {
  iconCache.clear()
}

function loadSiteIcon(domain: string): Promise<string | null> {
  const cached = iconCache.get(domain)
  if (cached) return cached
  const task = fetchSiteIcon(domain)
  iconCache.set(domain, task)
  return task
}

async function fetchSiteIcon(domain: string): Promise<string | null> {
  // 测试环境（jsdom）与很老的浏览器没有它：直接退回字母牌，不抛
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null
  try {
    const response = await fetch(`${API_BASE}/site-icons?domain=${encodeURIComponent(domain)}`, {
      headers: authHeaders(),
    })
    if (!response.ok) return null
    return URL.createObjectURL(await response.blob())
  } catch {
    // 网络报错也好、401 也好，都只是"这次没有真实 logo"：**不打印**（控制台零 error 是验收项）
    return null
  }
}

/**
 * 一枚站点图标位：固定 1.2em，**先画牌子、拿到 logo 再换图**。
 *
 * 未认出来的站点（`site.id === ''`）根本不发请求——那条路只有通用地球 + 域名文字。
 */
function SiteLogo({ site }: { site: WebSite }) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!site.id) return
    let alive = true
    void loadSiteIcon(site.domain).then((value) => {
      if (alive) setUrl(value)
    })
    return () => {
      alive = false
    }
  }, [site.id, site.domain])

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
  const letter = site.badge || site.domain.slice(0, 1)
  return (
    <span
      className="ch-hit-logo ch-hit-logo--letter"
      aria-hidden
      data-site={site.id || undefined}
      data-domain={site.domain}
    >
      {letter.toUpperCase()}
    </span>
  )
}
