/**
 * 按格式选渲染器的文件预览（React 版，v0.26 那张表的对照实现）。
 *
 * 分派规则**不在这个文件里**，在 `./kinds.ts`——那里是唯一一份表，界面与测试都对着它。
 * 这里只做三件事：把规则的结果接到具体组件上、给"取不到内容"一个统一的失败态、
 * 把文本类的内容取回来。
 *
 * 与旧 `frontend/src/components/files/FilePreview.vue` 的对照（逐条）：
 *
 * | 后缀 / kind | 旧实现 | 这里 |
 * | --- | --- | --- |
 * | `md` / `markdown` | `renderPlainMarkdown` | `react-markdown` + `remark-gfm` |
 * | `txt` / `log` / `csv` / 各种代码 | `<pre>` | `<pre class="kylab-text">` |
 * | `png` / `jpg` / `gif` / `webp` / `bmp` / `avif` | `<img>` | `<img>` |
 * | `pdf` | `<iframe>` 指向签名链接 | `<iframe>` 指向签名链接 |
 * | `docx` | `OfficePreview` + docx-preview | `DocxPreview` |
 * | `pptx` | `OfficePreview` + `@vue-office/pptx` | `PptxPreview` |
 * | `xlsx` / `xls` | `OfficePreview` + `@vue-office/excel` | `SpreadsheetPreview`（exceljs） |
 * | 其它 | 一句"下载它" | `PreviewNotSupported` |
 *
 * **两处刻意的差别**（都写在 `kinds.ts` 的头注里）：SVG 仍不进图片那一档
 * （它能在本站 origin 下执行脚本，服务端也不给它 `inline`）；`csv` 的落点取决于
 * 调用方给的是后缀还是后端 kind——两份输入本来就不一样。
 *
 * 一条安全说明：Markdown 分支用 react-markdown，**不开 `rehype-raw`**，
 * 所以文档里的 HTML 不会被当标记执行（与旧前端"先整体转义、再白名单还原"同一个结果）。
 */
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import type { DocumentPreview } from '@/api/documents'

import { DocxPreview } from './DocxPreview'
import { PptxPreview } from './PptxPreview'
import { SpreadsheetPreview } from './SpreadsheetPreview'
import { resolveRenderer } from './kinds'
import {
  PreviewLoading,
  PreviewNote,
  PreviewNotSupported,
  PreviewUnavailable,
  loadFailure,
} from './notes'
import { NO_URL, useRemoteText } from './usePreviewSource'
import './preview.css'

export interface FilePreviewProps {
  /** 文件名（含扩展名）。分派与报错文案都用它；给 `preview` 时可以省。 */
  name?: string | null
  /**
   * 种类：后端的 `PreviewKind`（`docx` / `excel` / `binary`…）或文件后缀
   * （`md` / `png`…，会话文件区给的就是后缀）。缺省时按 `mime` 与文件名后缀判。
   */
  kind?: string | null
  /** 媒体类型：只在前两者都认不出来时兜底。 */
  mime?: string | null
  /** 后端签发的签名链接。图片/PDF 直接用它，Office 用它取字节。 */
  url?: string | null
  /** 文本类**已经内联**的内容（文档接口的阅读视角直接回 `text`，不必再取一次）。 */
  text?: string | null
  /** 取不到内容时上层给出的原因；没有时用"拿不到预览链接"。 */
  reason?: string | null
  /**
   * 文档接口「阅读视角」的整份返回（`getDocumentPreview`）。
   *
   * 给了它就按它取名字/种类/链接/文本——**文档页不必把四个字段拆开来传**，
   * 而它本来就是"这一页要渲染什么"的完整回答（`kind` / `url` / `text` / `filename`）。
   * 显式传的 `name` / `kind` / `url` / `text` 优先于它（调用方点名要的算数）。
   *
   * 不需要另外传 `documentId`：签名链接就在这份返回里（`url`）。
   */
  preview?: DocumentPreview | null
  /**
   * PDF 的跳页锚点（1-based）。
   *
   * `#page=N` 是浏览器内置阅读器的 PDF Open Parameters，**零依赖**就能从引用直接
   * 落到那一页；`#` 之后是片段，不会发给服务端（旧 `DocumentDrawer.vue` 的做法）。
   */
  page?: number | null
}

/** 空链接的统一说明：区分"后端没给"与"给了但取不到"（后者由各自的 hook 报）。 */
function missingReason(reason?: string | null): string {
  return reason?.trim() ? reason.trim() : NO_URL
}

/**
 * Markdown：与对话页同一套规则（GFM），HTML 不解析（见文件头注）。
 *
 * 内容是**取回来的**：文档接口的阅读视角会内联给 `text`，会话文件区只有链接，
 * 两条路都在 `useRemoteText` 里（内联优先，不会再跑一趟网络）。
 */
function MarkdownPane({
  url,
  inline,
  name,
}: {
  url?: string | null
  inline?: string | null
  name: string
}) {
  const { loading, failure, text } = useRemoteText(url, inline)
  if (failure) return <PreviewUnavailable name={name} reason={loadFailure(failure)} />
  if (loading) return <PreviewLoading />
  return (
    <div className="kylab-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  )
}

/** 文本与代码：等宽、保留空白（旧 `FilePreview.vue` 的 `.preview-text`）。 */
function TextPane({
  url,
  inline,
  name,
}: {
  url?: string | null
  inline?: string | null
  name: string
}) {
  const { loading, failure, text } = useRemoteText(url, inline)
  if (failure) return <PreviewUnavailable name={name} reason={loadFailure(failure)} />
  if (loading) return <PreviewLoading />
  return <pre className="kylab-text">{text}</pre>
}

/** "要签名链接才能画"的四种（图片 / PDF / Office 三件套）共用的一句失败说明。 */
function MissingUrl({ name, reason }: { name: string; reason?: string | null }) {
  return <PreviewUnavailable name={name} reason={loadFailure(missingReason(reason))} />
}

export function FilePreview({
  name,
  kind,
  mime,
  url,
  text,
  reason,
  preview,
  page,
}: FilePreviewProps) {
  // `preview`（文档接口的整份返回）是这四个字段的完整来源；显式传的优先
  // ——调用方点名要的算数，没点的从那份返回里补
  const source = {
    name: name ?? preview?.filename ?? '',
    kind: kind ?? preview?.kind ?? null,
    url: url ?? preview?.url ?? null,
    text: text ?? preview?.text ?? null,
  }
  const renderer = resolveRenderer({ name: source.name, kind: source.kind, mime })
  // PDF 跳页锚点：只对 PDF 有意义（`#` 之后是片段，不会发给服务端）
  const frameUrl =
    source.url && page && page > 0 ? `${source.url}#page=${page}` : (source.url ?? '')

  switch (renderer) {
    case 'none':
      return (
        <div className="kylab-preview">
          <PreviewNotSupported name={source.name} />
        </div>
      )

    case 'markdown':
      return (
        <div className="kylab-preview">
          <MarkdownPane url={source.url} inline={source.text} name={source.name} />
        </div>
      )

    case 'text':
      return (
        <div className="kylab-preview">
          <TextPane url={source.url} inline={source.text} name={source.name} />
        </div>
      )

    case 'image':
      return (
        <div className="kylab-preview">
          {source.url ? (
            <img className="kylab-image" src={source.url} alt={source.name} />
          ) : (
            <MissingUrl name={source.name} reason={reason} />
          )}
        </div>
      )

    case 'pdf':
      return (
        <div className="kylab-preview">
          {frameUrl ? (
            // `key` 绑在最终地址上：签名链接会过期，重新签发后必须**重建** iframe，
            // 否则它还在用旧 src；页码变了也要重建，否则已加载的 PDF 不会重新定位
            // （片段变化不会让原生阅读器跳页——旧 `DocumentDrawer.vue` 踩过同一个坑）
            <iframe key={frameUrl} className="kylab-pdf" src={frameUrl} title={source.name} />
          ) : (
            <MissingUrl name={source.name} reason={reason} />
          )}
        </div>
      )

    case 'docx':
      return (
        <div className="kylab-preview">
          {source.url ? (
            <DocxPreview url={source.url} name={source.name} />
          ) : (
            <MissingUrl name={source.name} reason={reason} />
          )}
        </div>
      )

    case 'pptx':
      return (
        <div className="kylab-preview">
          {source.url ? (
            <PptxPreview url={source.url} name={source.name} />
          ) : (
            <MissingUrl name={source.name} reason={reason} />
          )}
        </div>
      )

    case 'sheet':
      return (
        <div className="kylab-preview">
          {source.url ? (
            <SpreadsheetPreview url={source.url} name={source.name} />
          ) : (
            <MissingUrl name={source.name} reason={reason} />
          )}
        </div>
      )

    default:
      // 分派表是穷举的联合类型：走到这里说明加了新预览器却忘了接上，
      // 与其静默留白，不如说清是哪一种没接上
      return (
        <div className="kylab-preview">
          <PreviewNote>
            「{source.name}」的预览器（{String(renderer)}）还没有接上。
          </PreviewNote>
        </div>
      )
  }
}
