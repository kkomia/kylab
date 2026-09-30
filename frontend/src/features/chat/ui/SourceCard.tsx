/**
 * 来源徽章 + 悬停/聚焦卡片（D11-③，用户："做得优雅，向 Kimi 看齐"）。
 *
 * ## 徽章（行内那枚）
 *
 * `小圆角 + 站点真实 logo + 域名`（Kimi 的 `kimi.com` 那枚）。三个硬要求：
 *
 * 1. **尺寸小、贴着句读**：`inline-flex` + 1em 级别的盒子，`vertical-align` 微调——
 *    真浏览器量过：段落行高**不变**（见 `.shots/d11b-cite/`）；
 * 2. **可点**：点了走既有那条路（展开过程面板并滚到那条出处，`onOpen`）；
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
 * ## hover 加深（不再是"整块反相"）
 *
 * 改前亮色悬停是**反相**（底色近黑、文字转画布色）——那是照 Kimi 引用卡片的观感定的。
 * 用户这次给的批注是"hover **加深**"：一枚小小的行内标签在正文里反相太跳，
 * 所以改成"底色抬一档（`--bg-hover`）+ 描边加重 + 文字提亮"，深浅两套主题同一条规则
 * （Kimi 的引用标签也是这么加深的：底色变深一档，不是反白）。
 *
 * **hover 只许变色，绝不变形/位移** ✗：这里只动 `background-color` / `color` /
 * `border-color`（宽度始终 1px ✓），所以悬停不会改变几何 —— 那正是抖动的常见成因之一。
 *
 * ## 点它是"跳去看出处"，不是"跳走"
 *
 * Kimi 的引用标签点开是新标签页。我们的徽章点了走**既有那条路**（展开过程面板、
 * 滚到那一条出处并闪一下，`onOpen`）——那条链路上有 `data-source` / `data-flash`
 * 两处物证、也有用例钉着（`tests/chat-source-citations.test.tsx`），
 * 而"看这一页原文"的出口就在悬停卡片里（那张卡片底部的 URL 是 `target="_blank"`）。
 * 所以这里**不改点击去向**，只把外观对齐 pill。
 */
export const BADGE_CLASS =
  'md-cite-site inline-flex min-h-[1.5em] items-center gap-[var(--space-1)] ' +
  'align-[-0.2em] rounded-[6px] border border-[var(--border-hairline)] ' +
  'bg-[var(--bg-subtle)] px-[var(--space-1)] text-[length:var(--text-micro-size)] ' +
  'leading-none text-[var(--text-secondary)] no-underline ' +
  'cursor-pointer [transition:var(--transition-ui)] ' +
  'hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)] ' +
  'hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-1 ' +
  'focus-visible:outline-[var(--ring)]'

/** 徽章里那枚 logo（与过程面板那一枚同一套取图与退化）。**默认 1em**：跟字号走 ✓ */
function BadgeLogo({ citation, size = '1em' }: { citation: WebCitation; size?: string }) {
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
 * `onOpen` 是**点击**的去处（与知识库那条引用同一条路：展开过程面板滚到那条出处）；
 * 悬停/聚焦只负责开卡片——"看一眼"与"跳过去"是两件事。
 */
export function SourceBadge({
  citation,
  onOpen,
}: {
  citation: WebCitation
  onOpen: (index: number) => void
}) {
  const active = useSyncExternalStore(subscribeCitation, activeCitation, activeCitation)
  const open = active?.citation.index === citation.index && active?.citation.url === citation.url
  const ref = useRef<HTMLButtonElement | null>(null)

  const show = () => showCitation(citation, ref.current)
  return (
    <button
      ref={ref}
      type="button"
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
      onClick={() => onOpen(citation.index)}
    >
      <BadgeLogo citation={citation} />
      {citation.domain}
    </button>
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
      className="fixed z-[var(--z-popover,60)] flex flex-col gap-[var(--space-2)] rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--bg-menu)] p-[var(--space-3)] text-[length:var(--text-micro-size)] shadow-[var(--shadow-popover)]"
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
