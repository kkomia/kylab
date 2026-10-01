/**
 * 站点真实 logo 的**取图那一层**（D11-②/③ 共用）。
 *
 * 两处都要它：过程面板里的**抓页 favicon 那一格**（`ui/WebSiteList.tsx` 的 `WebSiteIcons`
 * / `CompactLogo`）与最终回答里的来源胶囊（`ui/SourceCard.tsx` 的 `BadgeLogo`，引用与
 * 普通外链两档共用）。取法只有一条：向我们自己的源要（`GET /api/v1/site-icons?domain=…`），
 * 浏览器**不直连第三方站点**（隐私与稳定，理由见 `backend/app/services/site_icons.py`）。
 *
 * （`WebSiteList` 那个"带站点名的牌子"与只服务它的 `SiteLogo` 已在 2026-10-01 批四删掉：
 * 行上不再说"查了哪些站点"，留下的只有抓页那一格，见 `WebSiteList.tsx` 的文件头。）
 *
 * 几点刻意的做法：
 *
 * 1. **缓存的是 Promise**（不是结果）：同一个站点在好几行、好几枚徽章里出现，
 *    同时来的第二个调用直接等同一个请求；
 * 2. **`ObjectURL` 不回收**：活到页面结束。最多几十个对象（真实结果里的站点就那么多），
 *    比"卸载时回收、再挂载时重新请求"省事也省流量；
 * 3. **取不到就回 `null`**：调用方自己决定退化成站点字牌还是通用地球——
 *    这里不抛、不打印（控制台零 error 是验收项）；
 * 4. 用 `fetch` + `Blob` 而不是 `<img src>`：这一组端点要凭据，而 `<img>` 带不了
 *    `Authorization`；顺带也避免了 404 在控制台留下"加载图片失败"。
 */

import { useEffect, useState } from 'react'

import { API_BASE, authHeaders } from '@/api/client'
import type { WebSite } from '@/features/chat/model/webSites'

const iconCache = new Map<string, Promise<string | null>>()

/** 用例之间清缓存（模块级缓存不该把上一个用例的结果带进下一个）。 */
export function resetSiteIconCache(): void {
  iconCache.clear()
}

export function loadSiteIcon(domain: string): Promise<string | null> {
  const cached = iconCache.get(domain)
  if (cached) return cached
  const task = fetchSiteIcon(domain)
  iconCache.set(domain, task)
  return task
}

async function fetchSiteIcon(domain: string): Promise<string | null> {
  // 测试环境（jsdom）与很老的浏览器没有它：直接退化，不抛
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null
  try {
    const response = await fetch(`${API_BASE}/site-icons?domain=${encodeURIComponent(domain)}`, {
      headers: authHeaders(),
    })
    if (!response.ok) return null
    return URL.createObjectURL(await response.blob())
  } catch {
    // 网络报错也好、401 也好，都只是"这次没有真实 logo"
    return null
  }
}

/**
 * 一枚站点的真实 logo（异步）；没有就回 `null`（调用方自己退化）。
 *
 * **只要 `site.domain` 非空就发请求**（domain 空才不发）。本机站点表（`webSites.ts`）
 * 只决定"显示成什么名字与字牌"，**不决定准不准抓**——改前表外的域名一次请求都不发，
 * 于是真实结果里绝大多数站点（`opendatalab.github.io` 这种）只剩一枚字母圆，
 * 2026-10-01 用户："这个为啥抓不到真实的图标呢，你放个字母标在这儿没意义啊"。
 * 后端那张同源的白名单也已撤（见 `backend/app/services/site_icons.py`），
 * "该不该抓"由那边的 `check_public_url` 逐跳兜住。
 */
export function useSiteLogo(site: Pick<WebSite, 'domain'>): string | null {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!site.domain) {
      setUrl(null)
      return
    }
    let alive = true
    void loadSiteIcon(site.domain).then((value) => {
      if (alive) setUrl(value)
    })
    return () => {
      alive = false
    }
  }, [site.domain])

  return url
}
