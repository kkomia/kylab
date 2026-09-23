/**
 * 对话页上的两个**抽屉**：引用原文（出处）与产物/文件。
 *
 * 两者原先都是就地弹窗（`ui/Dialogs.tsx` 里的 `SourceDialog` / `FilesDialog`，
 * 用的是居中 Dialog）。旧版是**从右侧滑出的抽屉**——点开它不该把注意力从对话里
 * 拽走：抽屉贴边、对话还看得见，看完顺手就收回去。现在 `src/ui/sheet` 已就绪，
 * 这两个就换成它（同一个 Radix Dialog 原语，无障碍与焦点陷阱都是现成的）。
 *
 * ## 四条行为（旧版逐条如此，这里照旧）
 *
 * 1. **打开时取数**：抽屉只在"打开"时才挂载，数据跟着请求走
 *    （文件区那条走 `useConversationFiles`，出处那条读 `ChatProvider` 里已经在手上的引用）；
 * 2. **Esc 收起**：Radix 原语自带（焦点被关在抽屉里，所以不需要像旧版那样挂 window 监听）；
 * 3. **先滑回去、再通知宿主**：`requestClose` 先把 `open` 置假（Radix 播退出动画），
 *    过 `LEAVE_MS` 才调宿主的 `onClose`/`closeSource`——反过来会在滑到一半时把节点摘掉，
 *    看起来像"闪一下没了"（旧 `DocumentDrawer` 同一条做法）；
 * 4. **不动底下的滚动位置**：抽屉是 portal 到 body 的浮层，聊天视口一个像素都不碰
 *    （正文照旧停在用户刚才看的那一句上）。
 *
 * ## 为什么文件区只有"列出来 + 预览/下载"
 *
 * 旧 `FileDrawer` 还带子目录进出与 Office/PDF 内嵌预览——那套渲染器属于知识库域
 * （迁移计划 §5 的 C 域），React 这边还没落地；这里的口径见 `FilesSheet` 上面的说明。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Download } from 'lucide-react'

import { downloadFile, getFileUrl, type ConversationFile } from '@/api/conversations'
import { formatBytes } from '@/lib/format'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/ui/sheet'

import { notifyError } from '../runtime/notify'
import { useChat } from '../runtime/ChatProvider'
import { useConversationFiles } from '../runtime/useChatData'

/** 收起动画时长：与 `@/ui/sheet` 内容上 `data-[state=closed]:duration-300` 那个 300 对齐。 */
const LEAVE_MS = 300

/** 抽屉的观感：贴右缘、铺满高度、按内容定宽（720px 读得动一份原文，再宽就看丢行）。 */
const DRAWER =
  'w-full gap-0 overflow-hidden p-0 shadow-[var(--shadow-popover)] sm:max-w-[min(720px,92vw)]'
/** 抽屉里那一层可滚动的正文（头部固定，内容自己滚）。 */
const BODY = 'flex min-h-0 flex-1 flex-col gap-[var(--space-3)] overflow-y-auto p-[var(--space-5)]'

/**
 * 收起抽屉：**先滑回去，再通知宿主**。
 *
 * `open` 是抽屉自己的那一位（"现在滑到哪一步"），与宿主的"该不该开着"分开：
 * 宿主是 `ChatProvider.sourceOpen` / `Composer` 的 `filesOpen`。关的动作**先落在
 * 抽屉自己身上**（Radix 播退出动画），`LEAVE_MS` 之后才回调宿主——反过来会在
 * 滑到一半时把节点摘掉，看起来像"闪一下就没了"（旧 `DocumentDrawer` 同一条做法）。
 *
 * 关一次就锁上 `closing`：连点两下 Esc / 遮罩会排两个定时器，那样宿主要被通知两次。
 * `shouldOpen` 变回真（宿主又展开了）就解锁——那时再从收起态滑出来。
 */
function useSlideOut(
  shouldOpen: boolean,
  onClose: () => void,
): {
  open: boolean
  requestClose: () => void
} {
  const [open, setOpen] = useState(shouldOpen)
  const closing = useRef(false)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (!shouldOpen) return
    closing.current = false
    setOpen(true)
  }, [shouldOpen])

  useEffect(
    () => () => {
      if (timer.current !== undefined) window.clearTimeout(timer.current)
    },
    [],
  )

  const requestClose = useCallback(() => {
    if (closing.current) return
    closing.current = true
    setOpen(false)
    timer.current = window.setTimeout(onClose, LEAVE_MS)
  }, [onClose])

  return { open, requestClose }
}

/** 两个抽屉共用的外壳：头部一行标题，正文自己滚。 */
function Drawer({
  title,
  open,
  requestClose,
  children,
}: {
  title: string
  open: boolean
  requestClose: () => void
  children: ReactNode
}) {
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        // Esc / 点遮罩 / 关闭按钮都从这一条进来（Radix 的统一出口）
        if (!next) requestClose()
      }}
    >
      <SheetContent side="right" className={DRAWER} aria-describedby={undefined}>
        <SheetHeader className="border-b border-[var(--border-hairline)] px-[var(--space-5)] py-[var(--space-4)]">
          <SheetTitle>{title}</SheetTitle>
        </SheetHeader>
        <div className={BODY}>{children}</div>
      </SheetContent>
    </Sheet>
  )
}

/**
 * 引用原文：出处卡片上只显示 120 字，而"这段到底怎么说的"往往要看全。
 * 就地看全，不必跳去文档页再自己找回来。
 */
export function SourceSheet() {
  const chat = useChat()
  const source = chat.activeSource
  // 关闭时**不清 `activeSource`**（宿主的口径）：那句话还在，收起只是不看它了；
  // 下一次 `openSource` 换进新的引用、`sourceOpen` 变真，抽屉从收起态再滑出来
  const { open, requestClose } = useSlideOut(chat.sourceOpen, chat.closeSource)
  if (!source) return null
  return (
    <Drawer title="引用原文" open={open} requestClose={requestClose}>
      <p className="m-0 flex flex-wrap items-baseline gap-[var(--space-2)] text-[length:var(--text-meta-size)]">
        <span className="text-[var(--text-primary)]">{source.document_name}</span>
        {sourceWhereText(source) ? (
          <span className="text-[var(--text-quaternary)]">{sourceWhereText(source)}</span>
        ) : null}
      </p>
      <p className="m-0 text-[length:var(--text-body-size)] leading-[var(--line-prose)] whitespace-pre-wrap text-[var(--text-secondary)]">
        {source.preview}
      </p>
    </Drawer>
  )
}

function sourceWhereText(source: { heading_path?: string | null; page?: number | null }): string {
  const parts: string[] = []
  if (source.heading_path) parts.push(source.heading_path)
  if (source.page !== null && source.page !== undefined) parts.push(`第 ${source.page} 页`)
  return parts.join(' › ')
}

/**
 * 产物与文件：这条会话的文件区（工作区目录 / 会话临时区）。
 *
 * 产物与上传的文件都落在这里，所以它是"这一轮交出来的东西在哪"的那个答案。
 *
 * **与旧 `FileDrawer` 的差别只有一处**：那边点一份文件是**抽屉里内嵌预览**
 * （Office 三件套 / PDF iframe），这里换了一条签名 URL 在新标签页里打开——
 * 那套渲染器属于知识库域（迁移计划 §5 的 C 域），React 这边还没落地。
 * 所以产物卡片上的「预览」也照旧走新标签页（`ui/Deliverables.tsx`）：
 * 抽屉是"看文件区里有什么"，预览是"看清这一份"，两者不是同一件事。
 *
 * `Composer` 挂它时绑了 `key={conversationId}`：换会话就整个重来
 * （文件区是按会话划的，旧 `FileDrawer` 也是这么绑的）。
 */
export function FilesSheet({ onClose }: { onClose: () => void }) {
  const chat = useChat()
  // 宿主（`Composer`）只在"开着"时才挂这一个组件（`filesOpen`），所以"该开着"恒为真；
  // 关的动作仍然先滑回去、`LEAVE_MS` 之后才回调 `onClose` 让宿主卸掉它
  const { open, requestClose } = useSlideOut(true, onClose)
  const query = useConversationFiles(chat.conversationId, true)
  const entries = query.data ?? []

  async function openFile(file: ConversationFile, inline: boolean): Promise<void> {
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
    <Drawer title="产物与文件" open={open} requestClose={requestClose}>
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
                    onClick={() => void openFile(file, true)}
                  >
                    预览
                  </button>
                  <button
                    type="button"
                    className="inline-flex shrink-0 cursor-pointer items-center gap-[var(--space-1)] text-[length:var(--text-micro-size)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                    onClick={() => void openFile(file, false)}
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
    </Drawer>
  )
}
