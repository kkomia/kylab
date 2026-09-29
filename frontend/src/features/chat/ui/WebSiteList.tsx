/**
 * 「这一步查了哪些站点」那一排小牌子（§12.334 第二节，web 步骤专用）。
 *
 * 数据全部来自 `model/webSites.ts`（纯函数 + 本机站点表）：这一层只画，
 * 不判断"哪些算站点"——那一件事（`webSitesOfSteps` / `isWebStep`）在两个渲染位置
 * （单步那一行、同类并成的一组那一行）都要用，只能有一处。
 *
 * 画法两条：
 *
 * 1. **认出来的站点**给一枚字母/字牌 + 站点名（`GitHub` / `arXiv` / `知乎`…）——
 *    "logo"在本产品里的形态就是这枚牌子：不向被查站点发任何请求（理由见
 *    `model/webSites.ts` 的模块说明）；
 * 2. **没认出来的**退化成**域名文字本身** + 一枚通用地球——不编名字，
 *    用户照样看得出在查哪个站。
 *
 * `data-site` / `data-domain` 供断言：前者只在"认出来"时有值，正好把第 2 条钉住。
 */
import { Globe } from 'lucide-react'

import type { WebSites } from '@/features/chat/model/webSites'
import { formatCount } from '@/lib/format'

import { SITE_CHIP, SITE_MORE, SITE_STRIP, SITE_TILE } from './traceStyles'

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
          {site.badge ? (
            <span className={SITE_TILE} aria-hidden>
              {site.badge}
            </span>
          ) : (
            <Globe className={SITE_TILE} size={11} aria-hidden />
          )}
          {site.name}
        </span>
      ))}
      {more > 0 ? <span className={SITE_MORE}>+{formatCount(more)}</span> : null}
    </span>
  )
}
