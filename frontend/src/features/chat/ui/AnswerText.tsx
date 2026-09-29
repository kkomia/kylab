/**
 * 回答正文（Markdown + 行内引用徽标）。
 *
 * 渲染器在 `model/markdown.tsx` 里（`react-markdown` + `remark-gfm` + `rehype-katex` +
 * `rehype-highlight`，规则与旧 `useMarkdown.ts` 对齐）。这里只做两件界面上的事：
 *
 * 1. **把动作接上去**：点行内徽标 `[1]` → 展开过程面板并滚到那条出处；代码块 / 表格上的
 *    三个按钮（复制代码、复制表格、下载表格）走既有那条剪贴板链路。渲染器把动作设计成
 *    props（`MarkdownActions`），所以这里不必再自己挂事件委托——旧实现要在 `v-html`
 *    出来的节点上做委托，是因为那时候回调进不去；
 * 2. **两个降级**：正文还没吐字时别画一个空盒子；复制失败时**如实说**，
 *    并且把"已经收到的字"留着（这一点由调用方保证）。
 */
import { useCallback } from 'react'

import { copyText } from '@/lib/clipboard'
import type { ChatSource } from '@/api/chat'
import {
  AnswerMarkdown,
  type CiteFallback,
  type MarkdownTable,
} from '@/features/chat/model/markdown'
import type { WebCitation } from '@/features/chat/model/sourceCitations'

import { notifyError, notifyWarning } from '../runtime/notify'
import { SourceBadge, SourceCardHost } from './SourceCard'

export interface AnswerTextProps {
  text: string
  /**
   * 这一轮**还在流，而且一个字都还没到**（D27，2026-09-28 走查）。
   *
   * 为什么要给它一个落点：正文区在首字之前**完全是空白**——走查实测长文提问后 1s / 3s / 9s
   * 三个采样点都是 `replyTextLen = 0`、`replyTextChildElements = 0`，同一时刻只有过程面板在动
   * （`lastAssistantText` 里有"正在处理…｜深度思考｜正在生成回答"，那些都在**面板**里）。
   * 用户在正文这一栏看到的就是"什么都没有"，像是没反应。
   */
  pending?: boolean
  sources: ChatSource[]
  /** 点行内徽标 `[n]`：展开过程面板 → 滚到那一条出处 → 闪一下。 */
  onCite: (sourceIndex: number) => void
  /**
   * 查不到对应出处的编号怎么画（v0.28）。这一轮跑过联网搜索时给一句说明，
   * 那些编号就渲染成"有说明的非链接"而不是裸数字（见 `model/markdown.tsx` 的
   * `CiteFallback`）。没给就照旧原样留着。
   */
  citeFallback?: CiteFallback
  className?: string
}

/**
 * 表格 → CSV（与旧 `downloadTable` 逐条一致）。
 *
 * **必须带 BOM**：Excel 打开不带 BOM 的 UTF-8 CSV 会把中文读成乱码，
 * 而"导出给别人用 Excel 打开"正是这个按钮唯一的用途。字段里的引号按 CSV 规矩翻倍，
 * 含逗号/引号/换行的字段整体加引号。
 */
function toCsv(table: MarkdownTable): string {
  const escape = (value: string): string => {
    const flat = value.replace(/\s+/g, ' ').trim()
    return /[",\n]/.test(flat) ? `"${flat.replace(/"/g, '""')}"` : flat
  }
  const rows = [table.header, ...table.rows].map((row) => row.map(escape).join(','))
  return rows.join('\r\n')
}

export function AnswerText({
  text,
  pending,
  sources,
  onCite,
  citeFallback,
  className,
}: AnswerTextProps) {
  const copyBlock = useCallback(async (body: string, what: string) => {
    if (await copyText(body)) return
    // 连兜底那条路都没成：如实说，别假装复制成功
    notifyWarning(`${what}没复制上，请手动选中后复制`)
  }, [])

  const downloadTable = useCallback((table: MarkdownTable) => {
    try {
      const blob = new Blob(['\uFEFF' + toCsv(table)], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `表格-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`
      link.click()
      URL.revokeObjectURL(url)
    } catch (cause) {
      notifyError(cause)
    }
  }, [])

  return (
    // `md-body`：正文排版的根（段距 / 列表符号 / 小标题那几条在 `chat.css` 里）。
    // 它只是**作用域**，不是布局——行宽与字号仍由调用方给的 `className` 说了算
    <div data-testid="reply-text" className={`md-body ${className ?? ''}`}>
      {/*
        首字之前的那一行（D27）。**只在"还在流 + 一个字都没有"时出现**：
        正文一旦到了就撤掉，收尾之后也不再留（那时要么有正文、要么走错误/降级那两条路）。

        写成一句朴素的话而不是骨架块：这一栏随后的内容是文字，摆几条灰条反而更晃眼；
        `animate-pulse` 让它有"在动"的意思，`motion-reduce:animate-none` 尊重系统里
        那个"减少动态效果"（与样式层同一条口径）。
      */}
      {pending && !text ? (
        <p className="md-p animate-pulse text-[var(--text-tertiary)] motion-reduce:animate-none">
          正在生成…
        </p>
      ) : null}
      <AnswerMarkdown
        text={text}
        sources={sources}
        citeFallback={citeFallback}
        onOpenSource={onCite}
        // 网页引用那一枚（D11-③）：真实 logo + 域名，悬停/聚焦出卡片。
        // **渲染函数由界面给**：`model/` 不认识界面组件（分层纪律）。
        renderWebCitation={(citation: WebCitation, open: (index: number) => void) => (
          <SourceBadge citation={citation} onOpen={open} />
        )}
        onCopyCode={(code) => void copyBlock(code, '代码')}
        // 表格进剪贴板用**制表符分隔**而不是 CSV：粘进 Excel / 飞书表格时
        // 它会被直接拆成单元格，而 CSV 粘过去是一整行纯文本
        onCopyTable={(tsv) => void copyBlock(tsv, '表格')}
        onDownloadTable={downloadTable}
      />
      {/*
        卡片**这一条回答只挂一个**（D11-③）：徽章只负责"报是哪一条 + 报坐标"，
        卡片在这里统一画——一枚徽章一张卡，一篇文章就会塞进几十个浮层组件。
      */}
      <SourceCardHost />
    </div>
  )
}
