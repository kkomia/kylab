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
 * ## 文件区抽屉：旧 `FileDrawer.vue`（543 行）的四件事都在这一个文件里
 *
 * | 旧 | 这里 |
 * | --- | --- |
 * | **子目录进出一层**：面包屑每段可点、`truncated` 的"只给你看了 300 个" | `path` 状态 + 面包屑 + `listing.parent` 的「上一级」+ 截断说明（**两档都能进**：会话档的层级来自名字里的相对路径，项目档来自真实目录 —— D20） |
 * | **内嵌预览**：按后缀分派（md / 文本 / 图片 / PDF / Office 三件套） | `@/features/preview` 的 `<FilePreview/>`——**签名链接由这里换**（那个域名只认链接、不认 `documentId`，见 `features/preview/README.md` 的第二种调用形） |
 * | **上传**：`uploadFile(conversationId, file)` + 「已放入「X」」 | 多选、**串行**、逐条结果与失败原因留在抽屉里 |
 * | **拖拽引用**：行上写 `application/x-kylab-file` | `onDragStart` 逐字照搬（投放端在 `Composer`，契约没动过） |
 *
 * 三条与旧版不同，都是有意的：
 *
 * - **预览"不能看 / 看不了"的文案不再各写一份**：`@/features/preview` 的 `notes.tsx`
 *   就是"同一份文件从对话页打开与从知识库打开，说明一字不差"的那一处（本文件不另造文案）；
 * - **上传结果留在抽屉里**：旧版单文件 + 一条 toast 够用，多选之后"哪几个没成"必须能
 *   逐个看（与知识库 `UploadDialog` 同一条理由）；
 * - **产物卡片也从这里预览**：`openArtifact` 不再开新标签页，而是"开抽屉 + 直落那一份"
 *   （旧版就是这个口径，`initialEntry` 那段注释写着用户报的那个 bug）。
 *
 * D20 加的那一件事（「项目文件取进本会话」）：项目档每一行多一个**取进本会话**——
 * 用户的原话是"项目文件也没法移到会话"。它与「加入知识库」是两个目的地：这一步只是
 * **复制一份到这条会话**（Agent 这一轮就在文件区里看得见它），项目里那份一个字节不动；
 * 进知识库那条在产物卡片上，走 `ingestArtifact`（见 `api/conversations.ts`）。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, Download, File as FileIcon, Folder, Upload } from 'lucide-react'

import {
  downloadFile,
  getFileUrl,
  importWorkspaceFile,
  uploadFile,
  type ConversationFile,
  type FileScope,
} from '@/api/conversations'
import { FilePreview, resolveRenderer } from '@/features/preview'
import { formatBytes, formatDate } from '@/lib/format'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/ui/sheet'
import { Tabs, TabsList, TabsTrigger } from '@/ui/tabs'

import { notifyError } from '../runtime/notify'
import { FILE_DRAG_TYPE } from '../runtime/prefs'
import { useChat } from '../runtime/ChatProvider'
import { useConversationDetail, useConversationFiles } from '../runtime/useChatData'

/** 收起动画时长：与 `@/ui/sheet` 内容上 `data-[state=closed]:duration-300` 那个 300 对齐。 */
const LEAVE_MS = 300

/** 抽屉的观感：贴右缘、铺满高度、按内容定宽（720px 读得动一份原文，再宽就看丢行）。 */
const DRAWER =
  'w-full gap-0 overflow-hidden p-0 shadow-[var(--shadow-popover)] sm:max-w-[min(720px,92vw)]'
/** 抽屉里那一层可滚动的正文（头部固定，内容自己滚）。 */
const BODY = 'flex min-h-0 flex-1 flex-col gap-[var(--space-3)] overflow-y-auto p-[var(--space-5)]'
/** 一行说明（空态 / 截断 / 读不了）：位置与颜色口径照旧 `FileDrawer` 的 `.drawer-note`。 */
const NOTE = 'm-0 text-[length:var(--text-meta-size)] text-[var(--text-tertiary)]'
const NOTE_BAD = `${NOTE} text-[var(--status-danger)]`
/** 头部那一排动作（上传 / 下载）。 */
const HEAD_ACTION =
  'inline-flex shrink-0 cursor-pointer items-center gap-[var(--space-1)] rounded-[var(--radius-control)] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-[var(--space-2)] py-[var(--space-1)] text-[length:var(--text-meta-size)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:cursor-default disabled:opacity-50'
/** 行尾的小动作（下载）：图标按钮，行里常驻（见旧 `FileDrawer` 的 `.file-download` 注释）。 */
const ROW_ACTION =
  'inline-flex shrink-0 cursor-pointer items-center justify-center rounded-[var(--radius-control)] p-[var(--space-1)] text-[var(--text-tertiary)] hover:bg-[var(--bg-active)] hover:text-[var(--text-primary)]'

/**
 * 收起抽屉：**先滑回去，再通知宿主**。
 *
 * `open` 是抽屉自己的那一位（"现在滑到哪一步"），与宿主的"该不该开着"分开：
 * 宿主是 `ChatProvider.sourceOpen` / `filesOpen`。关的动作**先落在
 * 抽屉自己身上**（Radix 播退出动画），`LEAVE_MS` 之后才回调宿主——反过来会在
 * 滑到一半时把节点摘掉，看起来像"闪一下就没了"（旧 `DocumentDrawer` 同一条做法）。
 *
 * 关一次就锁上 `closing`：连点两下 Esc / 遮罩会排两个定时器，那样宿主要被通知两次。
 *
 * 锁**必须在这一段滑出结束的那一刻放掉**，不能等到 `shouldOpen` 由假翻真：宿主那份
 * "该不该开"是**过了 `LEAVE_MS` 才**收到关闭通知的，所以"关掉之后马上换一条"的这段
 * 时间里它一直是真的、根本不翻面——指望翻面来解锁，等于把用户那一次点击吞掉
 * （他要再点一次才开得出来）。这一段滑出有两种结束方式，两种都要放锁：
 * 走完（定时器那一头）与被撤销（见 `target`）。
 *
 * `target` 是"这一次要看的是哪一条"（出处那份引用 / 文件抽屉要直落的那一份）：
 * 它与 `shouldOpen` 合起来才认得出"宿主又在要求开一条"——收起期间那个位始终是真的
 * （见上），只看它什么也认不出来。
 */
function useSlideOut(
  shouldOpen: boolean,
  onClose: () => void,
  target?: unknown,
): {
  open: boolean
  requestClose: () => void
} {
  const [open, setOpen] = useState(shouldOpen)
  const closing = useRef(false)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (!shouldOpen) return
    /*
      目标换了 = 宿主又点名要看另一条（它那份状态位没变，所以只能从这儿认出来）。
      这一下把正在走的收起**撤销**掉：
      - 待发的关闭通知要撤掉，留着它会在 `LEAVE_MS` 之后把宿主置假，新的一条被一起收走；
      - 锁当场放掉：这段滑出已经不算数了，锁留到"下次翻面"才清的话，用户紧接着按 Esc
        会被 `requestClose` 当成"重复关闭"吞掉；
      - 然后重新展开（Radix 从当前状态滑回来），换上新那条的内容。
    */
    if (timer.current !== undefined) {
      window.clearTimeout(timer.current)
      timer.current = undefined
    }
    closing.current = false
    setOpen(true)
  }, [shouldOpen, target])

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
    timer.current = window.setTimeout(() => {
      timer.current = undefined
      // 滑出到此结束，锁的寿命也到此为止：**先清锁、再通知宿主**。清锁不必等宿主反应
      // （它那份状态位可能压根不翻面，见上），但通知仍然压在这个窗口之后——先滑回去、
      // 再告诉宿主，顺序没动。
      closing.current = false
      onClose()
    }, LEAVE_MS)
  }, [onClose])

  return { open, requestClose }
}

/** 两个抽屉共用的外壳：头部一行（标题 + 动作 + 可选的一条工具行），正文自己滚。 */
function Drawer({
  title,
  open,
  requestClose,
  leading,
  meta,
  actions,
  toolbar,
  children,
}: {
  title: string
  open: boolean
  requestClose: () => void
  /** 标题左边那一个动作（文件抽屉的「回到文件列表」）。 */
  leading?: ReactNode
  /** 紧挨着标题的一句次要信息（文件抽屉里是这份文件有多大）。 */
  meta?: ReactNode
  actions?: ReactNode
  toolbar?: ReactNode
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
      <SheetContent
        side="right"
        className={DRAWER}
        aria-describedby={undefined}
        /*
          抽屉自己**不吃抽屉内的拖放**：文件区的行是从这里拖出去的，
          而抽屉挂在 `Composer` 的 React 子树里（`Sheet` 只是把 DOM portal 到 body，
          事件仍沿 React 树往上冒）——不挡住的话，"把行拖回列表里、又松手"会被上面那层
          当成"落在输入框上"，凭空插一条引用。松手落在这里 = 不改主意了。
        */
        onDragOver={(event) => event.stopPropagation()}
        onDrop={(event) => {
          event.preventDefault()
          event.stopPropagation()
        }}
      >
        <SheetHeader className="gap-[var(--space-2)] border-b border-[var(--border-hairline)] px-[var(--space-5)] py-[var(--space-4)]">
          <div className="flex items-center gap-[var(--space-2)] pr-7">
            {leading}
            <SheetTitle>{title}</SheetTitle>
            {meta}
            {/* 动作排在关闭按钮左边那一块：`pr-7` 就是给它留的位置 */}
            {actions ? (
              <div className="ml-auto flex shrink-0 items-center gap-[var(--space-2)]">
                {actions}
              </div>
            ) : null}
          </div>
          {toolbar}
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
  // 下一次 `openSource` 换进新的引用时，`sourceOpen` 一直在真上（关闭通知还没上去），
  // 所以"换了一条"这件事要由 `activeSource` 自己告诉 `useSlideOut`（见那里的 `target`）
  const { open, requestClose } = useSlideOut(chat.sourceOpen, chat.closeSource, chat.activeSource)
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
 * 预览一份会话文件。
 *
 * 签名链接**由这里换**：`ConversationFile` 只有 key 与后缀，而
 * `@/features/preview` 的 `<FilePreview/>` 只认链接（它不接 `conversationId`，
 * 更不接 `documentId`）。换链接失败时把原因递给它——那句失败说明由预览域统一出。
 *
 * **分派结果是"不能预览"的连链接都不换**（旧 `FilePreview.vue` 同一条）：那种文件
 * 不会画出来，换一条十分钟就过期的签名链接纯属白跑一趟。
 */
function FilePane({ conversationId, file }: { conversationId: string; file: ConversationFile }) {
  const renderer = resolveRenderer({ name: file.name, kind: file.kind })
  const [issued, setIssued] = useState<{ loading: boolean; url: string; reason: string }>({
    loading: renderer !== 'none',
    url: '',
    reason: '',
  })

  useEffect(() => {
    if (renderer === 'none') {
      // 不假装能预览：连链接都不换（旧 `FilePreview.vue` 同一条）
      setIssued({ loading: false, url: '', reason: '' })
      return
    }
    let alive = true
    setIssued({ loading: true, url: '', reason: '' })
    void (async () => {
      try {
        const { url } = await getFileUrl(conversationId, file.key, 'inline')
        if (alive) setIssued({ loading: false, url, reason: '' })
      } catch (cause) {
        if (alive) {
          setIssued({
            loading: false,
            url: '',
            reason: cause instanceof Error ? cause.message : '拿不到预览链接',
          })
        }
      }
    })()
    return () => {
      alive = false
    }
  }, [conversationId, file.key, renderer])

  if (issued.loading) {
    return <p className={NOTE}>正在取预览链接…</p>
  }
  return <FilePreview name={file.name} kind={file.kind} url={issued.url} reason={issued.reason} />
}

/** 面包屑：每一段可点，最后一段是当前目录（旧 `FileDrawer.crumbs` 逐字搬）。 */
function breadcrumbsOf(path: string, label: string): { label: string; path: string }[] {
  const segments = path ? path.split('/') : []
  const trail: { label: string; path: string }[] = [{ label: label || '文件', path: '' }]
  segments.forEach((segment, index) => {
    trail.push({ label: segment, path: segments.slice(0, index + 1).join('/') })
  })
  return trail
}

/** 一层路径的上一级（`''` = 根那一层）。 */
function parentOf(path: string): string {
  return path.split('/').slice(0, -1).join('/')
}

/** 上传的逐条结果：一个是"传到哪一步了"，另一个是"没成的话为什么"。 */
interface UploadItem {
  id: number
  name: string
  status: 'uploading' | 'done' | 'failed'
  message: string
}

/**
 * 产物与文件：这条会话的文件区。
 *
 * **两档视图**（v0.55，见 `FileScope`）：默认「本会话」——用户上传的与 Agent 产出的
 * 都在这里（按会话记账，所以同一项目下不同会话的文件分得开）；挂了项目的会话
 * 还有「项目文件」这一档，读的是那个真实目录。哪一份落在哪儿由服务端算，
 * 这一层只选一档去读、不问也不猜。
 *
 * **两档都能进子目录**（D20）：项目档进的是真实目录；本会话档进的是上传时名字里带的
 * 相对路径那一层（`Composer` 把 `图表/第二季度.png` 当 filename 交过来，服务端原样存着）。
 * 两档在界面上因此是同一个形状：面包屑 + 「上一级」+ 点目录进一层，服务端算 `path`/`parent`。
 *
 * `Composer` 挂它时绑了 `key={conversationId}`：换会话就整个重来
 * （文件区是按会话划的，旧 `FileDrawer` 也是这么绑的）。
 */
export function FilesSheet({
  onClose,
  initialKey = null,
  initialEntry = null,
}: {
  onClose: () => void
  /** 一打开就预览这份（从产物卡片点进来时给）。不给就是直接看目录。 */
  initialKey?: string | null
  /**
   * 那份文件的**名字与种类**（v0.41）。
   *
   * 为什么必须由调用方给：产物在临时区的 key 就是 `artifact_id`——一串没有后缀的
   * 标识符。只按下标猜扩展名，预览会判成"没有可用的渲染器"，于是点「预览」得到一句
   * 「这个格式不能在这里预览」，而同一份文件从工作区（那边列表里有真名字）点开却好好的
   * （用户报的就是这个，见 `ChatProvider.filesSeed`）。
   */
  initialEntry?: { key: string; name: string; kind: string } | null
}) {
  const chat = useChat()
  // 宿主只在"开着"时才挂这一个组件，所以"该开着"恒为真；
  // 关的动作仍然先滑回去、`LEAVE_MS` 之后才回调 `onClose` 让宿主卸掉它。
  // 收起那一段里如果又点了另一份文件的「预览」（`initialKey` 换了），宿主那边
  // `filesOpen` 同样是真、不翻面——所以这份"要直落哪一份"就是这里认"又要开一条"的凭据
  const { open, requestClose } = useSlideOut(true, onClose, initialKey)

  /**
   * 看的是**哪一档**（v0.55）：默认「本会话」——打开文件抽屉先要看到的是"这次对话的
   * 文件"（用户上传的与 Agent 产出的都在这一档），而不是整个项目目录。
   */
  const [scope, setScope] = useState<FileScope>('conversation')
  /** 当前目录：**两档都认**（会话档是名字里的相对路径，项目档是真实目录，D20）。 */
  const [path, setPath] = useState('')
  /** 正在预览的那份文件；`null` = 正在看目录（旧 `FileDrawer.previewing` 同一位）。 */
  const [previewing, setPreviewing] = useState<ConversationFile | null>(null)
  const [uploads, setUploads] = useState<UploadItem[]>([])
  const [uploading, setUploading] = useState(false)
  /**
   * 「取进本会话」正在取的那一份（`entry.key`），以及上一条结果。
   *
   * 与 `uploads` 分开：那条路是**上传**（用户从本机选文件），这条是**从项目里复制**
   * （用户点的是列表里已经有的一行）。两者的结果文案也分开——别让用户以为他刚上传了什么。
   */
  const [taking, setTaking] = useState('')
  const [taken, setTaken] = useState<UploadItem | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const uploadSeq = useRef(0)
  /** 直落的那一份只落一次：落地之后再点面包屑回目录，不该又被拽回去。 */
  const landed = useRef<string | null>(null)

  const queryClient = useQueryClient()
  /**
   * 有没有「项目文件」这一档：**看会话挂没挂工作区**（`workspace_id` 有值才算）。
   * 判据用详情里那个字段，而不是"试拉一次看报不报错"——那样正常会话也会先亮一下红字，
   * 而这里要回答的只是"要不要多画一个 tab"。
   */
  const detail = useConversationDetail(chat.conversationId)
  const hasProject = Boolean(detail.data?.workspace_id)

  const query = useConversationFiles(chat.conversationId, true, path, scope)
  const listing = query.data ?? null

  /** 换档：**清空 `path`**——项目档的面包屑路径带进会话档是错的（那两档的路径不是一回事）。 */
  function switchScope(next: FileScope): void {
    if (next === scope) return
    setPreviewing(null)
    setPath('')
    setScope(next)
  }

  /**
   * 把 `initialKey` 变成可预览的条目（旧 `FileDrawer.openInitial` 逐条照搬）。
   *
   * 先在这一层的 entries 里找（那份名字/种类是服务端按真实文件名算的）；
   * 找不到（工作区里的子目录）才退回调用方给的种子，再造一条最小条目。
   *
   * **等列表到了再落**（旧版也是 `load('')` 之后才落）：列表读不了时不硬造一条——
   * 那份预览本来也要拿同一个服务端的签名链接，与其画一个必定失败的框，
   * 不如把"这个目录读不了"如实说出来。
   */
  useEffect(() => {
    const key = initialKey
    if (!key || landed.current === key || !listing) return
    landed.current = key
    const entry = listing.entries.find((item) => item.key === key)
    if (entry) {
      setPreviewing(entry)
      return
    }
    const seed = initialEntry?.key === key ? initialEntry : null
    setPreviewing({
      key,
      name: seed?.name || key.split('/').pop() || key,
      is_dir: false,
      size_bytes: 0,
      modified_at: null,
      kind: seed?.kind || (key.split('.').pop() || '').toLowerCase(),
    })
  }, [initialKey, initialEntry, listing])

  /** 进一层目录 / 退回某一层 / 回到列表：都只改这两位，取数交给 react-query。 */
  function openEntry(entry: ConversationFile): void {
    if (entry.is_dir) {
      setPreviewing(null)
      setPath(entry.key)
      return
    }
    setPreviewing(entry)
  }

  /**
   * 「取进本会话」（D20）：把项目档这一行**复制**进这条会话的文件区。
   *
   * 与「加入知识库」是两个目的地（见文件头注）：这一步只是"这次对话要用它"——
   * 复制一份进会话档，项目里那份一个字节不动。
   *
   * 成功之后做三件事，顺序有讲究：
   *
   * 1. **失效整片文件区缓存**（不只当前这一层）：刚取的那份在会话档、而项目档那一行
   *    也可能要重画（同名时服务端会退到 `名字 (2).ext`，界面得拿到新名字）；
   * 2. **切到会话档、并落到那份文件所在的那一层**：只把缓存标脏的话，用户还站在
   *    项目档里，看不见"取进来"这件事发生过（这一步与上传那条路刻意不同：上传是
   *    "东西到了就算成"，而这一步的意义就是**到会话档里去看它**）；
   * 3. 把结果这句话留在抽屉里（`已取进本会话：docs/报告.md`），失败给原因——
   *    与上传那一条同一个口径，不让用户去猜。
   */
  async function takeIntoConversation(entry: ConversationFile): Promise<void> {
    setTaking(entry.key)
    try {
      const created = await importWorkspaceFile(chat.conversationId, entry.key)
      setTaken({
        id: (uploadSeq.current += 1),
        name: created.name,
        status: 'done',
        message: `已取进本会话：${created.name}`,
      })
      await queryClient.invalidateQueries({
        queryKey: ['chat', 'files', chat.conversationId],
      })
      setPreviewing(null)
      setScope('conversation')
      // 落到哪一层由**服务端返回的那个名字**算出来（不是复用当前 path）：
      // 两者现在恒等（名字就是项目里的相对路径），但把这条不变量写明，
      // 省得以后名字被改写（例如同名加后缀）时这里悄悄对不上
      setPath(parentOf(created.name))
    } catch (cause) {
      setTaken({
        id: (uploadSeq.current += 1),
        name: entry.name,
        status: 'failed',
        message: cause instanceof Error ? cause.message : '取进本会话失败',
      })
    } finally {
      setTaking('')
    }
  }

  async function download(entry: ConversationFile): Promise<void> {
    try {
      await downloadFile(chat.conversationId, entry.key)
    } catch (cause) {
      notifyError(cause)
    }
  }

  /**
   * 把这一行**拖进对话输入框**（旧 `FileDrawer.onDragStart` 逐字搬）。
   *
   * 拖拽的两种落法是这个功能最容易漏掉的一处（照 ZCode）：从资源管理器拖一份文件进
   * 对话页是"**添加附件**"（它会上传、成为库里的文档），而拖这里已经在文件区里的那份是
   * "**引用此文件**"（只往输入框里插一条 `@路径`，内容一个字都不读）。
   *
   * 两者在浏览器看来都是 `Files`，所以这里要**写一个自定义类型**把"这是文件区里的文件"
   * 这件事带过去——对话页那一侧按它分流（`Composer` 的 `onDragOver` / `onDrop`，
   * 见 `runtime/prefs.FILE_DRAG_TYPE`）。`text/plain` 也一起给上：拖到别的应用
   * （编辑器、聊天窗口）时至少落下一个路径，而不是一个谁都看不懂的 MIME。
   */
  function onDragStart(event: React.DragEvent, entry: ConversationFile): void {
    const transfer = event.dataTransfer
    if (!transfer) return
    transfer.setData(
      FILE_DRAG_TYPE,
      JSON.stringify({ key: entry.key, name: entry.name, is_dir: entry.is_dir }),
    )
    transfer.setData('text/plain', entry.key)
    transfer.effectAllowed = 'copy'
  }

  /**
   * 往这一层放文件（旧 `FileDrawer.onPick` 的多选版）。
   *
   * 上传**一律落会话档**（v0.55）：所以这里不再带 `path`——不管此刻在看哪一档，
   * 新的文件都属于"这次对话"。
   *
   * **串行而不是并发**：名字相同要退到 `名字 (2).ext`，并发上传会让"哪一个变成了 (2)"
   * 无从判断（与知识库 `UploadDialog` 同一条理由）。逐条结果留在抽屉里：多选之后
   * "哪几个没成"必须能逐个看。
   */
  async function onPick(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const input = event.target
    const files = Array.from(input.files ?? [])
    input.value = '' // 同一份文件连传两次也要能触发 change
    if (files.length === 0) return
    setUploading(true)
    for (const file of files) {
      const id = (uploadSeq.current += 1)
      setUploads((current) => [
        ...current,
        { id, name: file.name, status: 'uploading', message: '' },
      ])
      try {
        const entry = await uploadFile(chat.conversationId, file)
        setUploads((current) =>
          current.map((item) =>
            item.id === id ? { ...item, status: 'done', message: `已放入「${entry.name}」` } : item,
          ),
        )
      } catch (cause) {
        setUploads((current) =>
          current.map((item) =>
            item.id === id
              ? {
                  ...item,
                  status: 'failed',
                  message: cause instanceof Error ? cause.message : '上传失败',
                }
              : item,
          ),
        )
      }
    }
    setUploading(false)
    /**
     * 传完失效**这一条会话的文件区整片缓存**（不只是当前这一层）：上传落的是会话档，
     * 而此刻可能正看着项目档——只 `refetch` 当前这层会让会话档留着旧清单（下次切过去
     * 看不到刚传的那份）。按前缀失效把两档一起标脏，react-query 只会重取在用的那些。
     */
    await queryClient.invalidateQueries({ queryKey: ['chat', 'files', chat.conversationId] })
  }

  const shownPath = listing?.path ?? path
  const crumbs = breadcrumbsOf(shownPath, listing?.label ?? '')
  const lastCrumb = crumbs.length - 1
  /**
   * 「上一级」：`parent` 是服务端算的（根那一层是 `null`）。
   * 取数在路上时先按路径自己退一段，免得那一格按钮闪一下才出现。
   */
  const parent = shownPath ? (listing?.parent ?? parentOf(shownPath)) : null
  const loadError = query.error
  const message = loadError instanceof Error ? loadError.message : loadError ? '读不了这个目录' : ''

  return (
    <Drawer
      title={previewing ? previewing.name : '产物与文件'}
      open={open}
      requestClose={requestClose}
      /* 回到目录：预览态的标题行是文件名，这一个箭头是"回去接着翻"（旧版同一位） */
      leading={
        previewing ? (
          <button
            type="button"
            className="inline-flex shrink-0 cursor-pointer items-center justify-center rounded-[var(--radius-control)] p-[var(--space-1)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            aria-label="回到文件列表"
            title="回到文件列表"
            onClick={() => setPreviewing(null)}
          >
            <ChevronLeft size={15} />
          </button>
        ) : null
      }
      /* 这份文件多大（旧 `FileDrawer` 的 `.drawer-size`）；`0` = 还不知道，就不显示 */
      meta={
        previewing?.size_bytes ? (
          <span className="tabular shrink-0 text-[length:var(--text-micro-size)] text-[var(--text-tertiary)]">
            {formatBytes(previewing.size_bytes)}
          </span>
        ) : null
      }
      actions={
        previewing ? (
          <button type="button" className={HEAD_ACTION} onClick={() => void download(previewing)}>
            <Download size={15} />
            下载
          </button>
        ) : (
          <button
            type="button"
            className={HEAD_ACTION}
            disabled={uploading}
            onClick={() => fileInput.current?.click()}
          >
            <Upload size={15} />
            {uploading ? '上传中…' : '上传'}
          </button>
        )
      }
      /*
        两档与面包屑都在**浏览态**出现（预览态的标题行已经写着文件名了，旧 `FileDrawer` 同一条）。

        「项目文件」这一档只有挂了项目的会话才有（`hasProject`）。面包屑与「上一级」
        **两档共用**（D20）：项目档一直在（根那一层就是那个目录），会话档**进了子目录才出现**
        ——根那层只有"本会话的文件"这一段，而档位那个 tab 已经写着这件事，画出来只是多一行。
      */
      toolbar={
        previewing ? null : (
          <div className="flex flex-col gap-[var(--space-2)]">
            {hasProject ? (
              <Tabs value={scope} onValueChange={(next) => switchScope(next as FileScope)}>
                <TabsList aria-label="文件范围">
                  <TabsTrigger value="conversation">本会话</TabsTrigger>
                  <TabsTrigger value="project">项目文件</TabsTrigger>
                </TabsList>
              </Tabs>
            ) : null}
            {scope === 'project' || shownPath ? (
              <nav
                aria-label="路径"
                className="flex items-center gap-[var(--space-1)] overflow-x-auto text-[length:var(--text-meta-size)]"
              >
                {parent !== null ? (
                  <button
                    type="button"
                    className="mr-[var(--space-1)] inline-flex shrink-0 cursor-pointer items-center gap-[var(--space-1)] rounded-[var(--radius-control)] px-[var(--space-1)] py-[1px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                    onClick={() => {
                      setPreviewing(null)
                      setPath(parent)
                    }}
                  >
                    <ChevronLeft size={13} />
                    上一级
                  </button>
                ) : null}
                {crumbs.map((crumb, index) => (
                  <span key={crumb.path || 'root'} className="flex shrink-0 items-center">
                    {index > 0 ? (
                      <ChevronRight size={12} className="shrink-0 text-[var(--text-quaternary)]" />
                    ) : null}
                    <button
                      type="button"
                      className={
                        index === lastCrumb
                          ? 'cursor-default px-[var(--space-1)] py-[1px] text-[var(--text-primary)]'
                          : 'cursor-pointer rounded-[var(--radius-control)] px-[var(--space-1)] py-[1px] whitespace-nowrap text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
                      }
                      aria-current={index === lastCrumb ? 'page' : undefined}
                      disabled={index === lastCrumb}
                      onClick={() => {
                        setPreviewing(null)
                        setPath(crumb.path)
                      }}
                    >
                      {crumb.label}
                    </button>
                  </span>
                ))}
              </nav>
            ) : null}
          </div>
        )
      }
    >
      {previewing ? (
        <FilePane conversationId={chat.conversationId} file={previewing} />
      ) : (
        <>
          {uploads.length > 0 ? (
            <ul className="m-0 flex list-none flex-col gap-[var(--space-1)] p-0">
              {uploads.map((item) => (
                <li
                  key={item.id}
                  className="flex items-center gap-[var(--space-2)] text-[length:var(--text-micro-size)]"
                >
                  <span className="min-w-0 truncate text-[var(--text-secondary)]">{item.name}</span>
                  <span
                    className={
                      item.status === 'failed'
                        ? 'shrink-0 text-[var(--status-danger)]'
                        : 'shrink-0 text-[var(--text-tertiary)]'
                    }
                  >
                    {item.status === 'uploading' ? '上传中…' : item.message}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {/* 「取进本会话」的结果：成功说清"现在它在会话里"（名字可能是服务端改过的），失败给原因 */}
          {taken ? (
            <p
              className={taken.status === 'failed' ? NOTE_BAD : NOTE}
              data-testid="file-taken-note"
            >
              {taken.message}
            </p>
          ) : null}

          {query.isLoading ? (
            <p className={NOTE}>正在读文件区…</p>
          ) : message ? (
            <p className={NOTE_BAD}>{message}</p>
          ) : !listing?.entries.length ? (
            // 空目录要说清"这里是什么、还能怎么放东西进来"，不是留一片白
            <p className={NOTE}>这里还没有文件。让 Agent 做一份，或者自己上传一个。</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-[var(--space-1)] p-0">
              {listing.entries.map((entry) => (
                <li key={entry.key}>
                  {/* 可拖：拖进对话页的输入框就是一条引用（见 `onDragStart`） */}
                  <div
                    className="flex items-center rounded-[var(--radius-row)] hover:bg-[var(--bg-hover)]"
                    draggable
                    onDragStart={(event) => onDragStart(event, entry)}
                  >
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-[var(--space-2)] px-[var(--space-2)] py-[var(--space-1-5)] text-left text-[length:var(--text-meta-size)] text-[var(--text-primary)]"
                      onClick={() => openEntry(entry)}
                    >
                      <span className="shrink-0 text-[var(--text-tertiary)]">
                        {entry.is_dir ? <Folder size={16} /> : <FileIcon size={16} />}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                      {entry.is_dir ? null : (
                        <span className="tabular shrink-0 text-[length:var(--text-micro-size)] text-[var(--text-tertiary)]">
                          {formatBytes(entry.size_bytes)}
                        </span>
                      )}
                      {entry.modified_at ? (
                        <span className="shrink-0 text-[length:var(--text-micro-size)] text-[var(--text-tertiary)]">
                          {formatDate(entry.modified_at)}
                        </span>
                      ) : null}
                    </button>
                    {entry.is_dir ? null : (
                      <>
                        {/*
                          「取进本会话」（D20）**只在项目档**出现：会话档里的东西已经在这条
                          会话里了，再给一个"取进本会话"是个什么都不做的按钮。
                          它与「加入知识库」不是一回事（见文件头注），所以文案里一个"库"字都没有。
                        */}
                        {scope === 'project' ? (
                          <button
                            type="button"
                            className={`${ROW_ACTION} mr-[var(--space-1)] w-auto gap-[var(--space-1)] px-[var(--space-2)] text-[length:var(--text-micro-size)]`}
                            aria-label={`取进本会话：${entry.name}`}
                            title="复制一份到这条会话的文件区（项目里那份不动）"
                            disabled={taking === entry.key}
                            onClick={() => void takeIntoConversation(entry)}
                          >
                            {taking === entry.key ? '取进中…' : '取进本会话'}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className={`${ROW_ACTION} mr-[var(--space-1)]`}
                          aria-label={`下载 ${entry.name}`}
                          onClick={() => void download(entry)}
                        >
                          <Download size={15} />
                        </button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {/* 截断要如实说：不然"这个项目只有 300 个文件"与"我只给你看了 300 个"看起来一模一样 */}
          {!query.isLoading && listing?.truncated ? (
            <p className={NOTE}>这一层文件很多，只显示了前 300 项。</p>
          ) : null}
        </>
      )}

      {/*
        上传的实际落点。**藏起来的 `<input type=file>` 而不是自绘按钮**：
        文件选择器必须由真实的用户手势触发，而原生 input 自带键盘可达与系统对话框。
      */}
      <input
        ref={fileInput}
        className="hidden"
        type="file"
        multiple
        tabIndex={-1}
        aria-label="上传到文件区"
        onChange={(event) => void onPick(event)}
      />
    </Drawer>
  )
}
