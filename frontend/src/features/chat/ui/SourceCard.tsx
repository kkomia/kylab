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
  showCitation,
  subscribeCitation,
} from './sourceCardStore'
import { useSiteLogo } from './siteLogos'

/** 卡片这一块的抓点（用例与 `aria-controls` 共用）。 */
export const CITATION_CARD_ID = 'source-citation-card'

/** 行内徽章的类名：小圆角、固定高度、不参与行高计算（`leading-none`）。 */
export const BADGE_CLASS =
  'md-cite-site inline-flex items-center gap-[0.28em] align-[-0.18em] rounded-[var(--radius-control)] ' +
  'border border-[var(--border-hairline)] bg-[var(--bg-subtle)] px-[0.34em] py-[0.06em] ' +
  'text-[0.78em] leading-none text-[var(--text-secondary)] no-underline ' +
  'cursor-pointer [transition:var(--transition-ui)] hover:border-[var(--border)] ' +
  'hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-1 ' +
  'focus-visible:outline-[var(--ring)]'

/** 徽章里那枚 logo（与过程面板那一枚同一套取图与退化）。 */
function BadgeLogo({ citation, size = '0.92em' }: { citation: WebCitation; size?: string }) {
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
        className="inline-flex shrink-0 items-center justify-center rounded-[2px] bg-[var(--bg-surface)] text-[0.72em] leading-none text-[var(--text-tertiary)]"
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
      if (event.key === 'Escape') hideCitation()
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
      className="fixed z-[var(--z-popover,60)] flex flex-col gap-[var(--space-2)] rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--bg-surface)] p-[var(--space-3)] text-[length:var(--text-micro-size)] shadow-[var(--shadow-popover)]"
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
