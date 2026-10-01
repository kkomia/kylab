/**
 * **交付物**（v0.26）：这一轮产出的文件摆在正文之后、动作之前。
 *
 * 改之前它们挂在各自那一步下面——交付物出现在过程面板**中间**，
 * 要往下翻十来步工具调用才看得到，而面板一收起卡片就跟着没了。
 * 交付物是这个回合的**结果**，不是过程的中间产物。
 *
 * **流式中先不摆**（v0.41）：导出那一步一跑完，卡片就冒出来了，而正文还在
 * 一个字一个字地出——看起来像"回答还没写完，东西就先交了"。现在等这一轮收尾再交付；
 * 过程面板里那一步照旧写着「导出文档 · 已导出」，中间状态并不丢。
 *
 * **图片直接铺出来**（2026-10-01 用户批注）：原话是"如果是图片的话 需要直接可以在网页里面
 * 预览，并且 hover 可以进行小幅度缩放来表达动效"。照 kimi.com 回答里的图片卡
 * （`img.image-main.is-cover`：cover 填充、圆角、直接内联显示），图片产物改成**图片卡**：
 * 上半是一张内联缩略图（宽 100%、最高 200px、`object-fit: cover`、12px 圆角），
 * hover 时轻微放大一点来表达那个动效；点图仍是原来的抽屉预览（不另造 lightbox），
 * 下半那一行仍是名字 / 格式·大小·来源 + 三个动作，**图标盒不摆**（缩略图本身就是
 * 类型说明，下面再摆一枚小图片图标是重复——见 `ArtifactLine` 的 `icon`）。
 * 铺不出来的（链接换不到、图加载失败）
 * 退回**行式卡片**——就是图标盒那一整行，与从前逐字相同；非图片产物照旧只走它。
 *
 * **svg 明确不算图片**：内联 SVG 与本站**同源**，一份带 `<script>` 的 SVG 内联进来
 * 就是存储型 XSS——本仓的安全口径与 `api/conversations.ts::getFileUrl` 那条注释一致
 * （`inline` 只是"请求"，批不批由服务端按后缀复核）。所以这一档只认位图后缀，
 * svg 连试都不试，照旧走行式卡片。
 */
import { useEffect, useState } from 'react'
import {
  FileCode2,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  Presentation,
  type LucideIcon,
} from 'lucide-react'

import { formatBytes } from '@/lib/format'
import { downloadFile, getFileUrl } from '@/api/conversations'
import type { ChatArtifact } from '@/api/chat'

import { notifyError } from '../runtime/notify'
import { useChat, type ChatApi } from '../runtime/ChatProvider'
import { titledWithOrigin } from './localFileOrigin'
import './flow.css'

/**
 * 产物卡片左边那一格图形：**按后缀分档**（Kimi 的文件卡片：代码 `</>`、表格 grid、
 * 幻灯、图片、文档）。
 *
 * 判据取**后缀**而不是 `file.format`：后端给的 `format` 是渲染器那一档
 * （`docx` / `pdf` / `pptx`），而后缀才是"这份文件长什么样"。认不出来的一律给
 * 文档那一枚——不猜、也不留空。改前这一格是格式文字（「DOCX」）压在高 28 的扁盒里，
 * 现在换成图形，格式名挪到副标题那一行（信息一个字没丢）。
 */
const ARTIFACT_ICONS: Record<string, LucideIcon> = {
  // 代码 / 数据：`</>` 与花括号
  js: FileCode2,
  jsx: FileCode2,
  ts: FileCode2,
  tsx: FileCode2,
  py: FileCode2,
  sh: FileTerminal,
  json: FileJson,
  yaml: FileCode2,
  yml: FileCode2,
  html: FileCode2,
  css: FileCode2,
  xml: FileCode2,
  // 表格
  csv: FileSpreadsheet,
  tsv: FileSpreadsheet,
  xlsx: FileSpreadsheet,
  xls: FileSpreadsheet,
  // 幻灯
  pptx: Presentation,
  ppt: Presentation,
  // 图片
  png: FileImage,
  jpg: FileImage,
  jpeg: FileImage,
  webp: FileImage,
  gif: FileImage,
  svg: FileImage,
}

function ArtifactIcon({ format }: { format: string }) {
  const Icon = ARTIFACT_ICONS[format.trim().toLowerCase().replace(/^\./, '')] ?? FileText
  return <Icon size={18} aria-hidden />
}

/**
 * 打开产物（**预览**）：开文件区抽屉，并**直落这一份**。
 *
 * 旧前端点开的就是右侧的文件抽屉（`FileDrawer` 的 `initialKey` / `initialEntry`），
 * 这里现在也是了——不再换一条签名链接丢到新标签页里（那会让人离开对话上下文，
 * 而 Office 三件套还得靠浏览器的下载行为）。
 *
 * `name` 与 `kind` **必须跟着 key 一起给**：产物在临时区的 key 就是 `artifact_id`，
 * 一串没有后缀的标识符，抽屉光看它猜不出该用哪个渲染器——不给的话，同一份文件
 * 从产物卡片点开说"不能预览"，从文件区列表点开却好好的（旧版用户报的就是这个）。
 */
function openArtifact(chat: ChatApi, file: ChatArtifact): void {
  chat.openFiles({ key: file.artifact_id, name: file.name, kind: file.format })
}

/**
 * 下载这一份产物（D18）：换一条签名链接、点一下临时 `<a>`。
 *
 * 与文件抽屉里那个 `download(entry)` 是**同一条路**（`api/conversations.downloadFile`），
 * 连失败处置也照抄：`notifyError` 如实说。产物在文件区的 key 就是 `artifact_id`，
 * 所以这里不需要另给名字。
 */
async function downloadArtifact(chat: ChatApi, file: ChatArtifact): Promise<void> {
  try {
    await downloadFile(chat.conversationId, file.artifact_id)
  } catch (cause) {
    notifyError(cause)
  }
}

/**
 * 能**直接铺成缩略图**的后缀：只有位图这一档。
 *
 * **svg 不在里面，这是刻意的**：内联 SVG 与本站**同源**，一份带 `<script>` 的 SVG
 * 内联进来就是一个执行面（存储型 XSS）——本仓的安全口径与 `getFileUrl` 那条注释一致
 * （`inline` 只是"请求"，批不批由服务端按后缀复核），所以这一档连试都不试它。
 * 判据取**后缀**，与上面 `ARTIFACT_ICONS` 同一个口径（不认 `file.format` 之外的东西）。
 */
const IMAGE_FORMATS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif'])

function isImageArtifact(format: string): boolean {
  return IMAGE_FORMATS.has(format.trim().toLowerCase().replace(/^\./, ''))
}

/**
 * 卡片里**名字 + 三个动作**那一整行（`icon` 那一格在时，左边还带**文件类型图标盒**）。
 *
 * 非图片产物是它，图片卡的下半行也是它——图标盒那一档**与图片卡之前那一版逐字相同**，
 * 单独拎出来只为一件事：图片铺不出来时回退的就是这一整行，两处共用同一段，
 * 不各抄一份（抄两份的话，这条动作线改一处就得记得改两处）。
 *
 * `icon={false}` 是**图片卡的下半行**：缩略图已经把"这是什么"摆明了，
 * 下面再摆一枚小图片图标是重复。名字 / 格式·大小·来源 / 三个动作一格没少
 * ——**只有图标盒这一格不画**，别的都在。
 */
function ArtifactLine({
  chat,
  file,
  icon = true,
}: {
  chat: ChatApi
  file: ChatArtifact
  icon?: boolean
}) {
  return (
    <>
      {icon ? (
        /* 左侧的**文件类型图标盒**（Kimi 的卡片：方盒 + 按后缀区分的图形）：
           36px 方盒、8px 圆角、`Bg-Secondary` 底（与表格卡片头带同一档灰）。 */
        <span className="flex h-[36px] w-[36px] shrink-0 items-center justify-center rounded-[8px] bg-[var(--Bg-Secondary)] text-[var(--text-secondary)]">
          <ArtifactIcon format={file.format} />
        </span>
      ) : null}
      <button
        type="button"
        className="min-w-0 flex-1 cursor-pointer text-left"
        // 这份文件的来源如实写在这里（判据与理由见 `localFileOrigin.ts`）
        title={titledWithOrigin(file.name)}
        onClick={() => openArtifact(chat, file)}
      >
        <span className="block truncate text-[length:var(--text-meta-size)] text-[var(--text-primary)]">
          {file.name}
        </span>
        <span className="tabular block text-[length:var(--text-micro-size)] text-[var(--text-tertiary)]">
          {/* 格式名从左边那一格搬到这里（那一格现在是图形）：一个字的宽度换一眼认得出的类型 */}
          {file.format.toUpperCase()}
          {` · ${formatBytes(file.size_bytes)}`}
          {file.where ? ` · ${file.where}` : ''}
        </span>
      </button>
      <button
        type="button"
        className="shrink-0 cursor-pointer text-[length:var(--text-micro-size)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
        onClick={() => openArtifact(chat, file)}
      >
        预览
      </button>
      {/*
        **直接下载**（D18，2026-09-28 走查）：卡片上原先只有「预览」与「存进知识库」，
        想留一份到本地得先开文件抽屉再找同一条。签名链接与"换链接再点一下"那套
        早就在 `api/conversations.ts` 里（文件抽屉走的就是它），这里只是把入口挪到
        用户真正看着那份文件的地方。失败照旧如实报（与文件抽屉同一句处理）。
      */}
      <button
        type="button"
        className="shrink-0 cursor-pointer text-[length:var(--text-micro-size)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
        onClick={() => void downloadArtifact(chat, file)}
      >
        下载
      </button>
      {/*
        「存进知识库」**一定要经过那一步弹窗**，不让服务端替用户挑库：
        "放进哪个库"是他的事，而弹窗就是他回答这件事的地方。
      */}
      {file.knowledge_base_id ? (
        <span
          className="shrink-0 text-[length:var(--text-micro-size)] text-[var(--text-tertiary)]"
          title={chat.kbName(file.knowledge_base_id)}
        >
          已存进知识库
          {chat.kbName(file.knowledge_base_id) ? `「${chat.kbName(file.knowledge_base_id)}」` : ''}
        </span>
      ) : (
        <button
          type="button"
          className="shrink-0 cursor-pointer text-[length:var(--text-micro-size)] text-[var(--accent-text)] hover:underline"
          onClick={() => chat.openIngest(file)}
        >
          存进知识库
        </button>
      )}
    </>
  )
}

/**
 * 行式卡片：非图片产物的常态，也是**图片铺不出来时的回退**——回到这一整行（含图标盒）。
 */
function ArtifactRow({ chat, file }: { chat: ChatApi; file: ChatArtifact }) {
  return (
    <li className="flex items-center gap-[var(--space-3)] rounded-[12px] border-[0.5px] border-[var(--Separators-S1)] px-[var(--space-3)] py-[var(--space-2-5)]">
      <ArtifactLine chat={chat} file={file} />
    </li>
  )
}

/**
 * 图片产物：**上面一张内联缩略图**（照 kimi.com 的 `image-main is-cover`：填满、圆角、
 * 直接摆出来），下半那一行还是行式卡片那一行。
 *
 * 链接是**这一层换的**（`getFileUrl(…, 'inline')`）。拿到之前先占住同一块高度
 * （`Bg-Secondary` 那块灰，与图标盒同一档），免得图一到位整条消息往上跳一下——
 * 换不到链接（没有会话 id / 后端不给 inline / 网络不通）或图本身没加载出来（`onError`）
 * 就整张卡回退成行式卡片：一份铺不出来的图，不该让这份产物在画面上少掉半截。
 *
 * hover 那一下是 `transform .3s` 的 3% 放大（`transition-transform duration-300` +
 * `hover:scale-[1.03]`），缩放**在圆角框里发生**（按钮上那两笔 `overflow-hidden` +
 * `rounded-[12px]`）——不裁的话那 3% 会漫到卡片边框外面去。
 */
function ArtifactThumb({ chat, file }: { chat: ChatApi; file: ChatArtifact }) {
  const { conversationId } = chat
  const [url, setUrl] = useState('')
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    // 没有会话 id（新建态那个空串）就没有可签名的东西：不白跑一次请求，直接回退
    if (!conversationId) return
    let alive = true
    void (async () => {
      try {
        const issued = await getFileUrl(conversationId, file.artifact_id, 'inline')
        if (alive) setUrl(issued.url)
      } catch {
        if (alive) setFailed(true)
      }
    })()
    return () => {
      alive = false
    }
  }, [conversationId, file.artifact_id])

  if (failed || !conversationId) return <ArtifactRow chat={chat} file={file} />

  return (
    <li
      className="flex flex-col rounded-[12px] border-[0.5px] border-[var(--Separators-S1)] px-[var(--space-3)] py-[var(--space-2-5)]"
      // 整张图片卡上也能问出"这份文件在哪"（下半行那个按钮上同样有一份）
      title={titledWithOrigin(file.name)}
    >
      {/* 点图 = 点「预览」：还是那只文件抽屉、还是直落这一份，不另造一层大图浮层 */}
      <button
        type="button"
        className="block w-full cursor-zoom-in overflow-hidden rounded-[12px]"
        onClick={() => openArtifact(chat, file)}
      >
        {url ? (
          <img
            src={url}
            alt={file.name}
            onError={() => setFailed(true)}
            className="block max-h-[200px] w-full rounded-[12px] bg-[var(--Bg-Secondary)] object-cover transition-transform duration-300 hover:scale-[1.03]"
          />
        ) : (
          // 链接还在路上：先摆一块同高的灰（`Bg-Secondary`）占位
          <span
            aria-hidden
            className="block h-[200px] w-full rounded-[12px] bg-[var(--Bg-Secondary)]"
          />
        )}
      </button>
      {/* 下半那一行：名字 / 格式·大小·来源 + 三个动作——**不摆图标盒**（缩略图就是类型说明） */}
      <div className="mt-[var(--space-2)] flex items-center gap-[var(--space-3)]">
        <ArtifactLine chat={chat} file={file} icon={false} />
      </div>
    </li>
  )
}

export function Deliverables({ files }: { files: ChatArtifact[] }) {
  const chat = useChat()
  if (files.length === 0) return null

  // 交付物卡片与正文**同一条行宽**（旧 `.deliverables { max-width: var(--measure) }`，
  // 旧注释原话："这一块与 .reply-text 用同一个 --measure，卡片铺满它"）。
  // 给正文加了限宽却不给卡片加，卡片就会比它下面那段字宽出一截。
  //
  // 分流只有一条判据：**后缀**（见 `IMAGE_FORMATS`）——图片走图片卡，其余那张行式卡片
  // 一个字没动。
  return (
    <ul className="ch-in m-0 mt-[var(--space-4)] flex max-w-[var(--measure)] list-none flex-col gap-[var(--space-2)] p-0">
      {files.map((file) =>
        isImageArtifact(file.format) ? (
          <ArtifactThumb key={file.artifact_id} chat={chat} file={file} />
        ) : (
          <ArtifactRow key={file.artifact_id} chat={chat} file={file} />
        ),
      )}
    </ul>
  )
}
