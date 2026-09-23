/**
 * 文档详情抽屉（旧 `components/knowledge/DocumentDrawer.vue` 的行为逐条对齐）。
 *
 * **从右侧滑出、盖在文档列表上**——列表样式一点不动。为什么不是独立页面：
 * 一份 PDF 放在整页里只占左半边，右边全是空白；而"这份文档长什么样"本来就是
 * **从列表里点开看一眼**的动作，看完就回去继续扫列表。
 *
 * 内容分区参考 WeKnora 的文档侧栏：**基本信息**（上传时间 / 类型 / 大小 / 状态…）
 * 与**文件内容**（片段数 + 阅读/切块/处理明细三个视角）。
 *
 * 预览的是**后端真实的切块文本**（`GET /documents/{id}/chunks`）：它本来就是给检索
 * 用的原料，让人看见真实产物比做一层漂亮的假渲染诚实。
 *
 * 原文下载走签名 URL（架构 §6.5）：链接由后端签发、带过期时间，界面上不出现任何永久直链，
 * 所以两个下载按钮每次都现取一条新链接。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronRight, Download, FileText, Pencil, Trash2, X } from 'lucide-react'

import {
  RENDERABLE_KINDS,
  deleteChunk,
  downloadDocument,
  getDocument,
  getDocumentPreview,
  listDocumentChunks,
  setChunkDisabled,
  updateChunk,
  type DocumentChunk,
  type DocumentPreview,
  type DocumentSummary,
  type DownloadFormat,
} from '@/api/documents'
import { FilePreview } from '@/features/preview'
import {
  Button,
  ConfirmDialog,
  IconButton,
  MenuItem,
  RowMenu,
  Skeleton,
  StatusTag,
} from '@/features/knowledge/primitives'
import { ProcessingTimeline } from '@/features/knowledge/ProcessingTimeline'
import { messageOf, notify } from '@/features/knowledge/store'
import { documentStageView } from '@/features/knowledge/status'
import { formatBytes, formatDate } from '@/lib/format'

/** 预览最多拉几块：再多就该去库内检索面板，而不是在这一页翻。 */
const PREVIEW_LIMIT = 5

type DrawerView = 'read' | 'chunks' | 'progress'

const VIEW_TABS: { key: DrawerView; label: string; hint: string }[] = [
  { key: 'read', label: '阅读', hint: '原文渲染，日常看这个' },
  { key: 'chunks', label: '切块', hint: '解析产物，等宽带块号，调解析用' },
  // 第三个视角（§12.115）：这份文档走到哪一步了、每步各花多久
  { key: 'progress', label: '处理明细', hint: '环节与耗时，排查"卡住"用' },
]

const SOURCE_TABS = [
  { key: 'original' as const, label: '原文版式' },
  { key: 'parsed' as const, label: '解析文本' },
]

/** 收起动画时长。与样式里的 `transition` 保持一致——对不上的话会"滑一半就消失"。 */
const LEAVE_MS = 180

interface DocumentDrawerProps {
  documentId: string
  onClose: () => void
  /**
   * 要直接落到的页码（PDF）。对话页的引用抽屉走这条（那条路径上没有 `?page=`）；
   * 不给时回落到 `?page=`（库页的用法，由宿主读 URL 后传进来）。
   */
  page?: number | null
  /** 打开时落在哪个页签（列表行上的「处理明细」直接把人送过来）。 */
  initialTab?: DrawerView | null
}

export function DocumentDrawer({
  documentId,
  onClose,
  page = null,
  initialTab = null,
}: DocumentDrawerProps) {
  const [document, setDocument] = useState<DocumentSummary | null>(null)
  const [chunks, setChunks] = useState<DocumentChunk[]>([])
  const [chunkTotal, setChunkTotal] = useState(0)
  const [preview, setPreview] = useState<DocumentPreview | null>(null)
  const [previewError, setPreviewError] = useState('')
  const [previewLoading, setPreviewLoading] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [downloading, setDownloading] = useState<DownloadFormat | null>(null)
  const [view, setView] = useState<DrawerView>(initialTab ?? 'read')
  /** 「阅读」里的两个来源：原件版式 / 解析文本。默认看原件（用户想看的就是那个文件）。 */
  const [previewSource, setPreviewSource] = useState<'original' | 'parsed'>('parsed')
  const previewCache = useRef<Record<'original' | 'parsed', DocumentPreview | null>>({
    original: null,
    parsed: null,
  })
  /** 正在编辑的块 id（空 = 没有在编辑）与它的草稿。 */
  const [editing, setEditing] = useState('')
  const [draft, setDraft] = useState('')
  const [savingChunk, setSavingChunk] = useState(false)
  const [chunkDeleteTarget, setChunkDeleteTarget] = useState<DocumentChunk | null>(null)
  const [chunkDeleting, setChunkDeleting] = useState(false)
  /** 正在收起：挡住重复触发（连点两下会排两次定时器）。 */
  const [closing, setClosing] = useState(false)
  const leaveTimer = useRef<number | undefined>(undefined)

  /** 收起抽屉：**先滑回去，再通知宿主流掉它**（出来是滑出来的，回去也该滑回去）。 */
  function requestClose(): void {
    if (closing) return
    setClosing(true)
    leaveTimer.current = window.setTimeout(() => onClose(), LEAVE_MS)
  }

  useEffect(
    () => () => {
      if (leaveTimer.current !== undefined) window.clearTimeout(leaveTimer.current)
    },
    [],
  )

  // Esc 收起：挂在 window 上而不是元素上——抽屉里的焦点可能在 iframe（PDF 预览）里，
  // 只监听根元素的 keydown 会经常收不到
  useEffect(() => {
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') requestClose()
    }
    window.addEventListener('keydown', onKeydown)
    return () => window.removeEventListener('keydown', onKeydown)
  })

  const canRenderOriginal = document !== null && RENDERABLE_KINDS.includes(document.original_kind)
  /** 原件能渲染 + 有解析产物 → 两个视角都成立，才给切换（否则切过去是空的）。 */
  const canSwitchSource = canRenderOriginal && (document?.chunk_count ?? 0) > 0

  const loadChunks = useCallback(async () => {
    try {
      const body = await listDocumentChunks(documentId, PREVIEW_LIMIT)
      setChunks(body.items)
      setChunkTotal(body.total)
    } catch (cause) {
      setPreviewError(messageOf(cause, '切块预览加载失败'))
    }
  }, [documentId])

  const loadReadingView = useCallback(
    async (source: 'original' | 'parsed') => {
      const cached = previewCache.current[source]
      if (cached) {
        setPreview(cached)
        return
      }
      setPreviewLoading(true)
      try {
        const body = await getDocumentPreview(
          documentId,
          source === 'original' ? 'original' : 'auto',
        )
        previewCache.current[source] = body
        setPreview(body)
      } catch {
        // 阅读视角的失败**不写进 previewError**：那是切块视角的报错位
        setPreview(null)
      } finally {
        setPreviewLoading(false)
      }
    },
    [documentId],
  )

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    // 换文档时先清空：否则加载期间头部还挂着上一份的名字，看起来像"点了没反应"
    setDocument(null)
    setChunks([])
    setChunkTotal(0)
    setPreviewError('')
    setPreview(null)
    previewCache.current = { original: null, parsed: null }
    try {
      const loaded = await getDocument(documentId)
      setDocument(loaded)
      const source = RENDERABLE_KINDS.includes(loaded.original_kind) ? 'original' : 'parsed'
      setPreviewSource(source)
      setLoading(false)
      await Promise.all([loadChunks(), loadReadingView(source)])
    } catch (cause) {
      setError(messageOf(cause, '文档加载失败'))
      setLoading(false)
    }
  }, [documentId, loadChunks, loadReadingView])

  useEffect(() => {
    void load()
  }, [load])

  /** 下载原文或解析产物。成功不弹提示（浏览器自己会显示进度），失败必须说清原因。 */
  async function download(format: DownloadFormat): Promise<void> {
    if (downloading) return
    setDownloading(format)
    try {
      await downloadDocument(documentId, format)
    } catch (cause) {
      notify.error(messageOf(cause, '下载失败'))
    } finally {
      setDownloading(null)
    }
  }

  function replaceChunk(updated: DocumentChunk): void {
    setChunks((current) =>
      current.map((item) => (item.chunk_id === updated.chunk_id ? updated : item)),
    )
  }

  /** 保存正文改动：后端会**重新向量化**这一块，所以不能乐观更新，必须用返回的记录替换。 */
  async function saveChunk(chunk: DocumentChunk): Promise<void> {
    const text = draft.trim()
    if (!text || savingChunk) return
    setSavingChunk(true)
    try {
      replaceChunk(await updateChunk(documentId, chunk.ordinal, text))
      setEditing('')
      setDraft('')
      notify.success('切块已更新，检索会按新内容生效')
    } catch (cause) {
      notify.error(messageOf(cause, '保存失败'))
    } finally {
      setSavingChunk(false)
    }
  }

  async function toggleChunk(chunk: DocumentChunk): Promise<void> {
    try {
      const updated = await setChunkDisabled(documentId, chunk.ordinal, !chunk.disabled)
      replaceChunk(updated)
      notify.success(updated.disabled ? '已禁用，该块不再参与检索' : '已恢复参与检索')
    } catch (cause) {
      notify.error(messageOf(cause, '操作失败'))
    }
  }

  async function confirmRemoveChunk(): Promise<void> {
    const chunk = chunkDeleteTarget
    if (!chunk || chunkDeleting) return
    setChunkDeleting(true)
    try {
      await deleteChunk(documentId, chunk.ordinal)
      setChunkDeleteTarget(null)
      // 服务端删完会重排序号，所以整段重拉，不能只从本地列表里摘掉那一条
      await loadChunks()
      notify.success('切块已删除')
    } catch (cause) {
      notify.error(messageOf(cause, '删除失败'))
    } finally {
      setChunkDeleting(false)
    }
  }

  const stage = document
    ? documentStageView(document.stage)
    : { label: '', tone: 'neutral' as const }

  /** "这是前 5 块，共 137 块"——不说清的话，用户会把预览当成全文。 */
  const previewNote =
    chunkTotal > chunks.length
      ? `该文档共 ${chunkTotal} 块，这里只显示前 ${chunks.length} 块。`
      : `该文档共 ${chunkTotal} 块，已全部显示。`

  /**
   * 出题情况一句话（v24）。数字取自**文档级统计**，不是当前这几块的合计——
   * 预览只拉了前几块，拿它数会少报。
   */
  function questionSummary(): string {
    if (!document || document.chunk_count === 0) return '还没有切块，无法出题。'
    if (document.question_count === 0) {
      return '还没有为切块生成问题。在文档列表里选中这份，点「生成问题」补上。'
    }
    return `已为 ${document.questioned_chunk_count}/${document.chunk_count} 段出题，共 ${document.question_count} 条；下面每块的问题列在正文之后。`
  }

  const activeHint = VIEW_TABS.find((tab) => tab.key === view)?.hint ?? ''

  return (
    <>
      <aside
        className={['kb-drawer', closing ? 'kb-drawer-closing' : ''].filter(Boolean).join(' ')}
        role="dialog"
        aria-label="文档详情"
      >
        <header className="kb-drawer-head">
          <div className="kb-drawer-title">
            <FileText size={16} aria-hidden="true" />
            <h2 className="kb-drawer-name" style={{ fontSize: 'inherit', margin: 0 }}>
              {document?.name ?? '文档详情'}
            </h2>
          </div>
          <div className="kb-drawer-actions">
            {/*
              两个下载**必须一眼分得清**：原先都只画一个下载图标，解析过的文档会并排
              出现两个长得一样的按钮，用户根本不知道哪个是哪个
            */}
            {document ? (
              <Button
                size="sm"
                icon={Download}
                disabled={downloading !== null}
                onClick={() => void download('original')}
              >
                {downloading === 'original' ? '准备中…' : '下载原文'}
              </Button>
            ) : null}
            {document && document.chunk_count > 0 ? (
              <Button
                size="sm"
                icon={Download}
                disabled={downloading !== null}
                onClick={() => void download('markdown')}
              >
                {downloading === 'markdown' ? '准备中…' : '下载 Markdown'}
              </Button>
            ) : null}
            <IconButton
              icon={ChevronRight}
              label="收起"
              disabled={closing}
              onClick={requestClose}
            />
          </div>
        </header>

        <div className="kb-drawer-body">
          {error ? <p className="kb-error-line">{error}</p> : null}
          {loading ? <Skeleton variant="text" rows={5} /> : null}

          {!loading && document ? (
            <>
              <h3 className="kb-section-title">基本信息</h3>
              <dl className="kb-meta">
                <div>
                  <dt>状态</dt>
                  <dd>
                    <StatusTag label={stage.label} tone={stage.tone} />
                  </dd>
                </div>
                <div>
                  <dt>大小</dt>
                  <dd>{formatBytes(document.size_bytes)}</dd>
                </div>
                <div>
                  <dt>切块数</dt>
                  <dd>{document.chunk_count}</dd>
                </div>
                <div>
                  <dt>页数</dt>
                  <dd>{document.page_count ?? '—'}</dd>
                </div>
                <div>
                  <dt>来源</dt>
                  <dd>{document.source_kind}</dd>
                </div>
                <div>
                  <dt>更新时间</dt>
                  <dd>{formatDate(document.updated_at)}</dd>
                </div>
              </dl>

              {document.error ? <p className="kb-error-line">{document.error}</p> : null}

              <h3 className="kb-section-title">
                文件内容
                {chunkTotal > 0 ? (
                  <span className="kb-section-badge">共 {chunkTotal} 个切块</span>
                ) : null}
              </h3>

              <div className="kb-tabs" role="tablist" aria-label="查看方式">
                {VIEW_TABS.map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    role="tab"
                    aria-selected={view === tab.key}
                    className={['kb-tab', view === tab.key ? 'kb-tab-on' : '']
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => setView(tab.key)}
                  >
                    {tab.label}
                  </button>
                ))}
                <span className="kb-tabs-hint">{activeHint}</span>
              </div>

              {/* 摘要放在视角之上：它是"这份文档是什么"的一句话答案 */}
              {document.summary ? (
                <p className="kb-summary">
                  <span className="kb-summary-label">摘要</span>
                  {document.summary}
                </p>
              ) : null}

              {view === 'read' ? (
                <>
                  {canSwitchSource && !previewLoading ? (
                    <div className="kb-source-switch" role="tablist" aria-label="内容来源">
                      {SOURCE_TABS.map((option) => (
                        <button
                          key={option.key}
                          type="button"
                          role="tab"
                          aria-selected={previewSource === option.key}
                          className={[
                            'kb-source-tab',
                            previewSource === option.key ? 'kb-source-tab-on' : '',
                          ]
                            .filter(Boolean)
                            .join(' ')}
                          onClick={() => {
                            if (previewSource === option.key) return
                            setPreviewSource(option.key)
                            void loadReadingView(option.key)
                          }}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  ) : null}

                  {previewLoading ? <p className="kb-muted">正在加载原文…</p> : null}
                  {/*
                    预览交给 `@/features/preview` 的 <FilePreview/>（P3 起它已就绪）：
                    按 `preview.kind` 分派到 Markdown / 等宽文本 / 图片 / PDF（iframe，
                    页内跳页）/ Office 三件套（docx-preview 等，按需动态加载）。
                    本页只负责"取哪一份"（原件版式 vs 解析文本）与页码。
                  */}
                  {!previewLoading && preview ? (
                    <FilePreview preview={preview} page={page} />
                  ) : null}
                </>
              ) : null}

              {view === 'chunks' ? (
                <>
                  {document.chunk_count === 0 ? (
                    <p className="kb-muted">
                      还没有切块产物：文档尚未处理完成，或处理失败。回到列表页可以重新摄入。
                    </p>
                  ) : null}
                  {previewError ? <p className="kb-muted">{previewError}</p> : null}
                  {chunks.length > 0 ? (
                    <>
                      <p className="kb-preview-note">{previewNote}</p>
                      <p
                        className={[
                          'kb-question-summary',
                          document.question_count === 0 ? 'kb-question-summary-empty' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                      >
                        {questionSummary()}
                      </p>
                      <ol className="kb-chunk-list">
                        {chunks.map((chunk) => (
                          <li
                            key={chunk.chunk_id}
                            className={['kb-chunk', chunk.disabled ? 'kb-chunk-disabled' : '']
                              .filter(Boolean)
                              .join(' ')}
                          >
                            <div className="kb-chunk-head">
                              <span className="tabular">第 {chunk.ordinal + 1} 块</span>
                              {chunk.heading_path ? (
                                <>
                                  <span className="sep">·</span>
                                  {chunk.heading_path}
                                </>
                              ) : null}
                              {chunk.page !== null ? (
                                <>
                                  <span className="sep">·</span>第 {chunk.page} 页
                                </>
                              ) : null}
                              {chunk.disabled ? <StatusTag tone="warning" label="已禁用" /> : null}

                              {/* 行内操作：解析器一定会出错，所以"用户能自己修"是质量的最后兜底 */}
                              <RowMenu label="切块操作" className="kb-chunk-menu">
                                {(close) => (
                                  <>
                                    <MenuItem
                                      icon={Pencil}
                                      onClick={() => {
                                        setEditing(chunk.chunk_id)
                                        setDraft(chunk.text)
                                        close()
                                      }}
                                    >
                                      编辑正文
                                    </MenuItem>
                                    <MenuItem
                                      icon={X}
                                      onClick={() => {
                                        void toggleChunk(chunk)
                                        close()
                                      }}
                                    >
                                      {chunk.disabled ? '恢复参与检索' : '禁用（不参与检索）'}
                                    </MenuItem>
                                    <MenuItem
                                      icon={Trash2}
                                      danger
                                      onClick={() => {
                                        setChunkDeleteTarget(chunk)
                                        close()
                                      }}
                                    >
                                      删除
                                    </MenuItem>
                                  </>
                                )}
                              </RowMenu>
                            </div>

                            {/* 编辑态：显式保存。改正文要重新向量化，是有代价的操作，不该边打字边存 */}
                            {editing === chunk.chunk_id ? (
                              <div className="kb-chunk-editor">
                                <textarea
                                  className="kb-textarea"
                                  rows={6}
                                  aria-label={`第 ${chunk.ordinal + 1} 块正文`}
                                  value={draft}
                                  onChange={(event) => setDraft(event.target.value)}
                                />
                                <div className="kb-chunk-actions">
                                  <span className="kb-chunk-hint">
                                    保存后会重新向量化这一块，检索随即按新内容生效。
                                  </span>
                                  <Button
                                    disabled={savingChunk}
                                    onClick={() => {
                                      setEditing('')
                                      setDraft('')
                                    }}
                                  >
                                    取消
                                  </Button>
                                  <Button
                                    variant="primary"
                                    disabled={savingChunk || !draft.trim()}
                                    onClick={() => void saveChunk(chunk)}
                                  >
                                    {savingChunk ? '保存中…' : '保存'}
                                  </Button>
                                </div>
                              </div>
                            ) : (
                              <pre className="kb-chunk-text">{chunk.text}</pre>
                            )}

                            {/* 这一段生成的问题：只读展示，用户据此判断"出题质量如何" */}
                            {chunk.questions.length > 0 ? (
                              <ul className="kb-chunk-questions">
                                {chunk.questions.map((question) => (
                                  <li key={question} className="kb-chunk-question">
                                    {question}
                                  </li>
                                ))}
                              </ul>
                            ) : null}
                          </li>
                        ))}
                      </ol>
                    </>
                  ) : null}
                </>
              ) : null}

              {view === 'progress' ? (
                <ProcessingTimeline documentId={documentId} active={view === 'progress'} />
              ) : null}
            </>
          ) : null}
        </div>
      </aside>

      {/* 删除切块：不可恢复，且"其实想禁用"的人不少——后果说明里把替代方案写出来 */}
      <ConfirmDialog
        open={chunkDeleteTarget !== null}
        title="删除切块"
        lead={`确定删除第 ${(chunkDeleteTarget?.ordinal ?? 0) + 1} 块？`}
        note="会从检索索引与向量库中一并移除，无法恢复。只想让它暂时不出现在检索里，用「禁用」，随时可以恢复。"
        busy={chunkDeleting}
        busyLabel="删除中…"
        onConfirm={() => void confirmRemoveChunk()}
        onClose={() => setChunkDeleteTarget(null)}
      />
    </>
  )
}
