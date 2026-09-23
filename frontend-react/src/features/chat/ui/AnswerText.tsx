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
import { AnswerMarkdown, type MarkdownTable } from '@/features/chat/model/markdown'

import { notifyError, notifyWarning } from '../runtime/notify'

export interface AnswerTextProps {
  text: string
  sources: ChatSource[]
  /** 点行内徽标 `[n]`：展开过程面板 → 滚到那一条出处 → 闪一下。 */
  onCite: (sourceIndex: number) => void
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

export function AnswerText({ text, sources, onCite, className }: AnswerTextProps) {
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
    <div data-testid="reply-text" className={className}>
      <AnswerMarkdown
        text={text}
        sources={sources}
        onOpenSource={onCite}
        onCopyCode={(code) => void copyBlock(code, '代码')}
        // 表格进剪贴板用**制表符分隔**而不是 CSV：粘进 Excel / 飞书表格时
        // 它会被直接拆成单元格，而 CSV 粘过去是一整行纯文本
        onCopyTable={(tsv) => void copyBlock(tsv, '表格')}
        onDownloadTable={downloadTable}
      />
    </div>
  )
}
