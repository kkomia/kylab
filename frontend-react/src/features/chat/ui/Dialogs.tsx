/**
 * 对话页上的三个弹窗（旧 `ChatView` 的 `AppModal` 那几处）。
 *
 * 浮层用 Radix 的 Dialog（迁移计划 §2：弹窗/下拉/浮层一律走 shadcn 那套原语，
 * 不自己写模态）。`src/ui/**` 还在 vendor 中，所以这里直接用 Radix 包 + 令牌类名，
 * 等原语落地之后把这三块换成它们即可（**取值与结构都不用改**）。
 *
 * 三个弹窗的来历：
 *
 * 1. **引用原文**：出处卡片上只显示 120 字，而"这段到底怎么说的"往往要看全；
 *    就地看全，不必跳去文档页再自己找回来；
 * 2. **存进知识库**：一定要经过这一步，**不让服务端替他挑库**——"放进哪个库"是用户的事，
 *    而这个弹窗就是他回答这件事的地方，成本只有一次点击；
 * 3. **文件区**：这条会话的文件（工作区目录 / 会话临时区）——产物预览与"浏览文件"共用。
 */
import * as Dialog from '@radix-ui/react-dialog'
import { Download, X } from 'lucide-react'

import { downloadFile, getFileUrl, type ConversationFile } from '@/api/conversations'
import { formatBytes } from '@/lib/format'

import { notifyError } from '../runtime/notify'
import { useChat } from '../runtime/ChatProvider'
import { useConversationFiles } from '../runtime/useChatData'

const OVERLAY = 'fixed inset-0 z-50 bg-[var(--MaskBg-Base)]'
const CONTENT =
  'fixed left-1/2 top-1/2 z-50 flex max-h-[80vh] w-[min(720px,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col gap-[var(--space-3)] overflow-y-auto rounded-[var(--radius-overlay)] border border-[var(--border)] bg-[var(--bg-surface)] p-[var(--space-5)] shadow-[var(--shadow-popover)]'
const TITLE = 'm-0 text-[length:var(--text-section-size)] font-semibold text-[var(--text-primary)]'
const BUTTON =
  'inline-flex h-[var(--control-height)] cursor-pointer items-center justify-center rounded-[var(--radius-control)] px-[var(--space-3)] text-[length:var(--text-meta-size)]'
const BUTTON_PRIMARY = `${BUTTON} bg-[var(--accent)] text-[var(--Always-White)] disabled:opacity-60`
const BUTTON_PLAIN = `${BUTTON} border border-[var(--border)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]`

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <Dialog.Close asChild>
      <button
        type="button"
        className="inline-flex h-[var(--control-height)] w-[var(--control-height)] cursor-pointer items-center justify-center rounded-[var(--radius-control)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)]"
        aria-label="关闭"
        title="关闭"
        onClick={onClose}
      >
        <X size={15} />
      </button>
    </Dialog.Close>
  )
}

/** 引用原文（就地看全，不必先跳去文档页）。 */
export function SourceDialog() {
  const chat = useChat()
  const source = chat.activeSource
  if (!source) return null
  return (
    <Dialog.Root open={chat.sourceOpen} onOpenChange={(open) => !open && chat.closeSource()}>
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY} />
        <Dialog.Content className={CONTENT} aria-describedby={undefined}>
          <div className="flex items-start justify-between gap-[var(--space-3)]">
            <Dialog.Title className={TITLE}>引用原文</Dialog.Title>
            <CloseButton onClose={chat.closeSource} />
          </div>
          <p className="m-0 flex flex-wrap items-baseline gap-[var(--space-2)] text-[length:var(--text-meta-size)]">
            <span className="text-[var(--text-primary)]">{source.document_name}</span>
            {sourceWhereText(source) ? (
              <span className="text-[var(--text-quaternary)]">{sourceWhereText(source)}</span>
            ) : null}
          </p>
          <p className="m-0 text-[length:var(--text-body-size)] leading-[var(--line-prose)] whitespace-pre-wrap text-[var(--text-secondary)]">
            {source.preview}
          </p>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function sourceWhereText(source: { heading_path?: string | null; page?: number | null }): string {
  const parts: string[] = []
  if (source.heading_path) parts.push(source.heading_path)
  if (source.page !== null && source.page !== undefined) parts.push(`第 ${source.page} 页`)
  return parts.join(' › ')
}

/**
 * 存进知识库：列出所有库让用户挑一个（预选不等于替他决定——库名看得见，点了确认才算数）。
 */
export function IngestDialog() {
  const chat = useChat()
  const file = chat.ingestTarget
  if (!file) return null
  return (
    <Dialog.Root open onOpenChange={(open) => !open && chat.closeIngest()}>
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY} />
        <Dialog.Content className={CONTENT} aria-describedby={undefined}>
          <div className="flex items-start justify-between gap-[var(--space-3)]">
            <Dialog.Title className={TITLE}>存进知识库</Dialog.Title>
            <CloseButton onClose={chat.closeIngest} />
          </div>
          <p className="m-0 text-[length:var(--text-meta-size)] text-[var(--text-secondary)]">
            把「{file.name}」存一份到知识库，之后它就能被检索到。
            <span className="text-[var(--text-tertiary)]">
              原文件仍然在{file.where || '原处'}，不会被搬走。
            </span>
          </p>
          {chat.kbs.length > 0 ? (
            <ul className="m-0 flex list-none flex-wrap gap-[var(--space-2)] p-0">
              {chat.kbs.map((kb) => (
                <li key={kb.id}>
                  <button
                    type="button"
                    className={`${BUTTON} ${
                      chat.ingestKbId === kb.id
                        ? 'border border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--text-primary)]'
                        : 'border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                    }`}
                    aria-pressed={chat.ingestKbId === kb.id}
                    onClick={() => chat.setIngestKbId(kb.id)}
                  >
                    {kb.name}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="m-0 text-[length:var(--text-meta-size)] text-[var(--text-secondary)]">
              还没有知识库。先去「知识库」建一个，再回来存。
            </p>
          )}
          <div className="flex justify-end gap-[var(--space-2)]">
            <button type="button" className={BUTTON_PLAIN} onClick={chat.closeIngest}>
              取消
            </button>
            <button
              type="button"
              className={BUTTON_PRIMARY}
              disabled={!chat.ingestKbId || chat.ingesting}
              onClick={chat.confirmIngest}
            >
              {chat.ingesting ? '存入中…' : '存进这个库'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/**
 * 文件区（这条会话的工作区目录 / 临时区）。
 *
 * **与旧版 FileDrawer 的差别**：那边是右侧抽屉，自带打包预览（Office 三件套、PDF iframe）
 * 与目录进出；抽屉属于知识库域（迁移计划 §5 的 C 域），React 这边还没落地。
 * 这一版给的是**同一件事的最小可用形态**：列出文件区、点一份就按签名 URL 打开或下载。
 * 抽屉接线之后，这里换成打开抽屉即可——入口与数据都是现成的。
 */
export function FilesDialog({ onClose }: { onClose: () => void }) {
  const chat = useChat()
  const query = useConversationFiles(chat.conversationId, true)
  const entries = query.data ?? []

  async function open(file: ConversationFile, inline: boolean): Promise<void> {
    try {
      if (inline) {
        const { url } = await getFileUrl(chat.conversationId, file.key, 'inline')
        window.open(url, '_blank', 'noopener')
      } else {
        await downloadFile(chat.conversationId, file.key)
      }
    } catch (cause) {
      notifyError(cause)
    }
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY} />
        <Dialog.Content className={CONTENT} aria-describedby={undefined}>
          <div className="flex items-start justify-between gap-[var(--space-3)]">
            <Dialog.Title className={TITLE}>文件</Dialog.Title>
            <CloseButton onClose={onClose} />
          </div>
          {query.isLoading ? (
            <p className="m-0 text-[length:var(--text-meta-size)] text-[var(--text-tertiary)]">
              正在读文件区…
            </p>
          ) : entries.length === 0 ? (
            <p className="m-0 text-[length:var(--text-meta-size)] text-[var(--text-tertiary)]">
              这条会话的文件区还是空的。产物与上传的文件都会落在这里。
            </p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-[var(--space-1)] p-0">
              {entries.map((file) => (
                <li
                  key={file.key}
                  className="flex items-center gap-[var(--space-3)] rounded-[var(--radius-row)] px-[var(--space-2)] py-[var(--space-1-5)] hover:bg-[var(--bg-hover)]"
                >
                  <span className="min-w-0 flex-1 truncate text-[length:var(--text-meta-size)] text-[var(--text-primary)]">
                    {file.name}
                  </span>
                  <span className="tabular shrink-0 text-[length:var(--text-micro-size)] text-[var(--text-tertiary)]">
                    {file.is_dir ? '目录' : formatBytes(file.size_bytes)}
                  </span>
                  {file.is_dir ? null : (
                    <>
                      <button
                        type="button"
                        className="shrink-0 cursor-pointer text-[length:var(--text-micro-size)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                        onClick={() => void open(file, true)}
                      >
                        预览
                      </button>
                      <button
                        type="button"
                        className="inline-flex shrink-0 cursor-pointer items-center gap-[var(--space-1)] text-[length:var(--text-micro-size)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                        onClick={() => void open(file, false)}
                      >
                        <Download size={13} />
                        下载
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
