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
 */
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
import { downloadFile } from '@/api/conversations'
import type { ChatArtifact } from '@/api/chat'

import { notifyError } from '../runtime/notify'
import { useChat, type ChatApi } from '../runtime/ChatProvider'
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

export function Deliverables({ files }: { files: ChatArtifact[] }) {
  const chat = useChat()
  if (files.length === 0) return null

  // 交付物卡片与正文**同一条行宽**（旧 `.deliverables { max-width: var(--measure) }`，
  // 旧注释原话："这一块与 .reply-text 用同一个 --measure，卡片铺满它"）。
  // 给正文加了限宽却不给卡片加，卡片就会比它下面那段字宽出一截。
  return (
    <ul className="ch-in m-0 mt-[var(--space-4)] flex max-w-[var(--measure)] list-none flex-col gap-[var(--space-2)] p-0">
      {files.map((file) => (
        <li
          key={file.artifact_id}
          className="flex items-center gap-[var(--space-3)] rounded-[12px] border-[0.5px] border-[var(--Separators-S1)] px-[var(--space-3)] py-[var(--space-2-5)]"
        >
          {/* 左侧的**文件类型图标盒**（Kimi 的卡片：方盒 + 按后缀区分的图形）：
              36px 方盒、8px 圆角、`Bg-Secondary` 底（与表格卡片头带同一档灰）。 */}
          <span className="flex h-[36px] w-[36px] shrink-0 items-center justify-center rounded-[8px] bg-[var(--Bg-Secondary)] text-[var(--text-secondary)]">
            <ArtifactIcon format={file.format} />
          </span>
          <button
            type="button"
            className="min-w-0 flex-1 cursor-pointer text-left"
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
              {chat.kbName(file.knowledge_base_id)
                ? `「${chat.kbName(file.knowledge_base_id)}」`
                : ''}
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
        </li>
      ))}
    </ul>
  )
}
