/**
 * 来源徽章 + 悬停/聚焦卡片（D11-③，用户："做得优雅，向 Kimi 看齐"）。
 *
 * ## 徽章（行内那枚）
 *
 * `小圆角 + 站点真实 logo + 域名`（Kimi 的 `kimi.com` 那枚）。三个硬要求：
 *
 * 1. **尺寸小、贴着句读**：`inline-flex` + 1em 级别的盒子，`vertical-align` 微调——
 *    真浏览器量过：段落行高**不变**（见 `.shots/d11b-cite/`）；
 * 2. **可点**：锚点直开原文那一页（新标签，Kimi 的 `pua-ref-cite-tag` 同款；
 *    见下面"点它 = 直开原文"一节）；
 * 3. **可访问**：`aria-label="来源 1：github.com"`、`aria-expanded`、`aria-controls`，
 *    Tab 到它、回车/空格就能开卡片。
 *
 * ## 卡片（全篇只挂一张）
 *
 * 内容自上而下：`站点 logo + 域名 + 淡色对勾` / **页面标题** / 一两行摘要 / URL（可点、可复制）。
 *
 * - **不做「赞 / 踩」**：Kimi 有，但我们的后端没有回收这些反馈的地方，摆两个假按钮是骗人；
 * - **对勾的意思是我们真的核对过**：徽章只在"编号对得上本轮联网搜索里的第 n 条"时才出现
 *   （解析见 `model/sourceCitations.ts`），所以这枚对勾说的是"这条引用有出处"，
 *   而不是"这个网页可信"——`title` 里写着这句话，不含糊；
 * - 悬停**和**键盘聚焦都能出；`Esc` 关；贴视口底/右时翻转（`sourceCard.cardPlacement`）。
 */

import { Check, Copy, ExternalLink, Globe } from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

import { copyText } from '@/lib/clipboard'
import type { WebCitation } from '@/features/chat/model/sourceCitations'

import { notifyWarning } from '../runtime/notify'
import {
  CARD_WIDTH,
  activeCitation,
  cardPlacement,
  hideCitation,
  hideCitationNow,
  showCitation,
  subscribeCitation,
} from './sourceCardStore'
import { useSiteLogo } from './siteLogos'

/** 卡片这一块的抓点（用例与 `aria-controls` 共用）。 */
export const CITATION_CARD_ID = 'source-citation-card'

/**
 * 行内胶囊的类名。
 *
 * 形态按 2026-09-30 用户批注 §5 对齐 Kimi 正文里的 `pua-ref-cite-tag`：
 * **12px 字 / 圆角 6px / 灰底 / 内含站点名（我们给的是域名）/ hover 加深**。
 * 五项尺寸都不写死 px（12px 走 `--text-micro-size` 令牌），字号跟随全局 `--font-scale`。
 *
 * | 项 | 值 | 依据 |
 * | --- | --- | --- |
 * | 高度 | `min-h-[1.5em]` | 字号 12px → **18px**；`em` 跟着字号走 ✓ |
 * | 左右内边距 | `px-[var(--space-1)]` | 4px 令牌 |
 * | 图标与文字间距 | `gap-[var(--space-1)]` | 4px 令牌 |
 * | 字号 | `--text-micro-size` | 12px 令牌（Kimi 同值） |
 * | 圆角 | `rounded-[6px]` | Kimi `pua-ref-cite-tag` 的 6px（改前是整圆胶囊 `--radius-pill`） |
 *
 * **`em` 而不是 `calc(… * 1.5)`**：Tailwind 的任意值里带 `*` / `/` 生成不出类名 ✗
 * （这一族已经踩过一次：尺寸必须逐字相同，见 `WebSiteList` 里那对同尺寸类名）。
 *
 * ## 形态：生产 `.pua-ref-cite-tag` 原文（2026-09-30 第二版按其纠偏）
 *
 * | 项 | 值 |
 * | --- | --- |
 * | 底色 | `--Fills-F2`（浅 `#0000000d` / 深 `#ffffff1a`） |
 * | 圆角 | **24px（整颗胶囊）** |
 * | 尺寸 | `min-width:18px` / `max-width:100px` / `height:24px` |
 * | 内外距 | `padding:5px 8px`、左右 `margin:0 4px` |
 * | 字号 | `--ui-C1` 12px（`--text-micro-size`） |
 * | 文字色 | `--Labels-Secondary` |
 * | 图标 | 14×14（生产 `.pua-ref-cite-tag__icon`） |
 * | 基线 | `position:relative; top:1px`（文字型那一档是 `top:-1px`） |
 * | hover / `.show` | **反相**：底 `--Labels-Primary`、字 `--Bg-Primary` |
 * | 过渡 | `color .3s, background-color .3s` |
 *
 * ⚠️ 上一版按批注做的两组值（圆角 6px、hover「加深」而不是反相）**与生产不符**，这一版
 * 按生产改回：Kimi 的这枚标签在悬停时就是整块反相（黑底白字 / 深色下白底黑字）。
 * 几何仍然是"只变色、不变形"——`margin` / 宽高 / 圆角一个都没进 hover 规则。
 *
 * `max-w-[100px]` + `min-w-[18px]` 逐字照抄生产：这一枚是"域名"那么长的东西，
 * 不设上限会被长域名撑成一条横条。
 *
 * ## 点它 = **直开原文**（Kimi 同款，2026-09-30 用户定案）
 *
 * Kimi 的 `pua-ref-cite-tag` 就是一个 `<a target="_blank" rel="noopener noreferrer">`
 * ——点了直开那一页。我们改前点它是"展开过程面板、滚到那条出处并闪一下"
 * （`revealSource` 那条链路，有 `data-source` / `data-flash` 两处物证），现在交给锚点。
 * 「看这一页原文」在悬停卡片里仍然留着（卡片底部那条 URL 是 `target="_blank"`），
 * 所以两个出口都在，只是把**点击**这一下去处换成了用户指的那一个。
 *
 * **知识库那一族出处不受影响**：它们没有 URL（是文档片段），仍旧走 `revealSource`
 * 就地滑出原文（见 `model/markdown.tsx` 的 `citationChip`）。
 */
export const BADGE_CLASS =
  'md-cite-site relative top-[1px] inline-flex h-[24px] min-w-[18px] max-w-[100px] ' +
  'items-center justify-center gap-[var(--space-1)] mx-[var(--space-1)] ' +
  'rounded-[24px] bg-[var(--Fills-F2)] px-[var(--space-2)] ' +
  'text-[length:var(--text-micro-size)] leading-none text-[var(--Labels-Secondary)] ' +
  'no-underline cursor-pointer select-none ' +
  '[transition:color_.3s,background-color_.3s] ' +
  'hover:bg-[var(--Labels-Primary)] hover:text-[var(--Bg-Primary)] ' +
  'focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--ring)]'

/**
 * 徽章里那枚 logo（与过程面板那一枚同一套取图与退化）。
 * **14×14**：生产 `.pua-ref-cite-tag__icon` 就是这个尺寸（上一版写 `1em`，跟着字号变）。
 */
function BadgeLogo({ citation, size = '14px' }: { citation: WebCitation; size?: string }) {
  const url = useSiteLogo(citation.site)
  const box = { width: size, height: size }
  if (url) {
    return <img src={url} alt="" aria-hidden style={box} className="shrink-0 object-contain" />
  }
  if (citation.site.badge) {
    return (
      <span
        aria-hidden
        style={box}
        className="inline-flex shrink-0 items-center justify-center rounded-[2px] bg-[var(--bg-subtle)] text-[0.72em] leading-none text-[var(--text-tertiary)]"
      >
        {citation.site.badge}
      </span>
    )
  }
  return <Globe aria-hidden style={box} className="shrink-0 text-[var(--text-quaternary)]" />
}

/**
 * 行内徽章。
 *
 * **点它 = 打开原文，走的是 Kimi 那条路**（2026-09-30 用户定案）：Kimi 正文里的
 * `pua-ref-cite-tag` 就是一个 `<a target="_blank" rel="noopener noreferrer">`，
 * 点了直开那一页。改前我们点它是"展开过程面板、滚到那条出处"——同一个动作有两个去处
 * （原文那一页 / 我们的清单），用户拍板换成前者。
 *
 * 三条没变：悬停与聚焦仍旧出卡片（标题 / 摘要 / 可点可复制的 URL）、
 * 卡片底部那条原文链接照留、`data-cite-*` 与 `aria-label` 一个字不改
 * （用例与页面上的 `[data-cite-index]` 委托读的都是它们）。
 */
export function SourceBadge({ citation }: { citation: WebCitation }) {
  const active = useSyncExternalStore(subscribeCitation, activeCitation, activeCitation)
  const open = active?.citation.index === citation.index && active?.citation.url === citation.url
  const ref = useRef<HTMLAnchorElement | null>(null)

  const show = () => showCitation(citation, ref.current)
  return (
    <a
      ref={ref}
      // 直开原文（新标签）：`noopener noreferrer` 与正文里别处的外链同一条口径
      href={citation.url}
      target="_blank"
      rel="noopener noreferrer"
      className={BADGE_CLASS}
      data-cite-index={citation.index}
      data-cite-site={citation.site.id || undefined}
      data-cite-domain={citation.domain}
      aria-label={`来源 ${citation.index}：${citation.domain}`}
      aria-expanded={open}
      aria-controls={CITATION_CARD_ID}
      onMouseEnter={show}
      onFocus={show}
      onMouseLeave={hideCitation}
      onBlur={hideCitation}
    >
      <BadgeLogo citation={citation} />
      {citation.domain}
    </a>
  )
}

/**
 * 那条回答里的**唯一**一张卡片（`AnswerText` 挂一次）。
 *
 * 位置用 `fixed`：正文与过程面板都在滚动容器里，`absolute` 会被裁掉
 * （用户点名的"卡片不许被抽屉/滚动容器裁掉"）。
 */
export function SourceCardHost() {
  const active = useSyncExternalStore(subscribeCitation, activeCitation, activeCitation)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const [placement, setPlacement] = useState({ left: 0, top: 0 })

  const open = active !== null
  useEffect(() => {
    if (!open) return
    const measure = () => {
      const anchor = active?.anchor?.getBoundingClientRect()
      if (!anchor) return
      const box = cardRef.current?.getBoundingClientRect()
      const at = cardPlacement(
        anchor,
        { width: box?.width || CARD_WIDTH, height: box?.height || 180 },
        { width: window.innerWidth, height: window.innerHeight },
      )
      setPlacement({ left: at.left, top: at.top })
    }
    measure()
    // 滚动或改窗口时跟着走：不然卡片会停在半空
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [open, active])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      // Esc 是**立刻关**（不走那 140ms 宽限）：键盘用户按了就该马上消失
      if (event.key === 'Escape') hideCitationNow()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!active) return null
  const { citation } = active

  return (
    <div
      ref={cardRef}
      id={CITATION_CARD_ID}
      role="dialog"
      aria-label={`来源 ${citation.index}：${citation.title || citation.domain}`}
      data-testid="source-card"
      className="fixed z-[var(--z-popover,60)] flex max-w-[340px] flex-col gap-[var(--space-2)] rounded-[16px] border-[0.5px] border-[var(--Separators-S1)] bg-[var(--BgGp-Secondary)] p-[var(--space-4)] text-[length:var(--text-micro-size)] shadow-[0_5.05px_5.32px_#00000006,0_16.98px_17.87px_#00000009,0_64px_80px_#0000000f]"
      style={{ left: placement.left, top: placement.top, width: CARD_WIDTH }}
      onMouseEnter={() => showCitation(citation, active.anchor)}
      onMouseLeave={hideCitation}
    >
      <div className="flex items-center gap-[var(--space-2)]">
        <BadgeLogo citation={citation} size="16px" />
        <span className="min-w-0 truncate text-[var(--text-secondary)]">{citation.domain}</span>
        <span
          // 这枚对勾说的是"这条引用对得上本轮搜索里的第 n 条"，不是"这个网页可信"
          title={`对得上本轮联网搜索的第 ${citation.index} 条结果`}
          className="inline-flex shrink-0 items-center"
        >
          <Check size={12} aria-hidden className="text-[var(--text-quaternary)]" />
          <span className="sr-only">对得上本轮联网搜索的第 {citation.index} 条结果</span>
        </span>
      </div>

      {citation.title ? (
        <p className="m-0 text-[length:var(--text-meta-size)] leading-[var(--line-ui)] text-[var(--text-primary)]">
          {citation.title}
        </p>
      ) : null}

      {citation.snippet ? (
        <p className="m-0 line-clamp-2 text-[var(--text-tertiary)] leading-[var(--line-prose)]">
          {citation.snippet}
        </p>
      ) : null}

      <div className="flex items-center gap-[var(--space-2)]">
        <a
          href={citation.url}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex min-w-0 items-center gap-[var(--space-1)] text-[var(--accent-text)] hover:underline"
        >
          <ExternalLink size={12} aria-hidden className="shrink-0" />
          <span className="truncate">{citation.url}</span>
        </a>
        <button
          type="button"
          aria-label="复制链接"
          className="ml-auto inline-flex shrink-0 cursor-pointer items-center gap-[var(--space-1)] p-0 text-[var(--text-tertiary)] [transition:var(--transition-ui)] hover:text-[var(--text-primary)]"
          onClick={() => {
            void copyText(citation.url).then((ok) => {
              if (!ok) notifyWarning('链接没复制上，请手动选中后复制')
            })
          }}
        >
          <Copy size={12} aria-hidden />
          复制
        </button>
      </div>
    </div>
  )
}
