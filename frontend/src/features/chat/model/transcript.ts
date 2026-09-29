/**
 * 会话导出（D13，2026-09-28 走查）：把一条会话变成一份 Markdown 文稿。
 *
 * 走查实测：会话**没有任何导出 / 分享出口** —— 用户想把一次对话留档、或者贴给别人，
 * 只能一条条手抄。这里先做"留档"那一半（分享链接要后端配合，是另一件事）。
 *
 * **纯函数**：`(标题, 消息[], 导出时刻) -> 字符串`，不碰 DOM、不碰网络。所以它能单测；
 * 也所以下载那一步（Blob + 临时 `<a download>`）留在调用方 —— 与「产物下载」那条路
 * （签名链接）不同：这里没有服务端文件，文稿是**当场拼出来的**。
 *
 * 三处取舍：
 *
 * 1. **收的是"消息"而不是我们界面那份完整模型**：形状只要 `role` / `content` / `sources`，
 *    与后端 `ChatMessageOut` 结构兼容，于是调用方不必先把详情翻译一遍
 *    （翻译一层就会漂一层）；
 * 2. **过程面板不进文稿**：那是"它怎么做的"，导出多半是给人读的"它说了什么"。
 *    工具原文动辄几千字，塞进去只会把文稿变成日志；
 * 3. **出处留在正文里**：回答里那些 `[1]` 没有出处就是悬空的 —— 而"这段话哪来的"
 *    恰恰是导出去给别人看时最需要交代的一件事。
 */

/** 文稿需要的最小输入形状（与后端 `ChatMessageOut` 结构兼容，不必先翻译）。 */
export interface TranscriptMessage {
  role: string
  content: string
  sources?: readonly TranscriptSource[]
}

/**
 * 出处的最小形状。
 *
 * **不直接用 `ChatSource`**：库里存的那份是**当时的快照**，字段比流式那会儿少
 * （没有 `score` / `chunk_id` 之类）；按完整接口要求的话，调用方得先补一堆假字段
 * 才能导出——那是"为了类型而编数据"。这里只声明文稿真正用到的四个。
 */
export interface TranscriptSource {
  index?: number
  document_name?: string
  page?: number | null
  preview?: string
}

/** 中文标题栏：谁说的。 */
const ROLE_LABEL: Record<string, string> = { user: '我', assistant: '助手' }

/** 一条消息的正文（空的那种给一句占位，别在文稿里留一段莫名其妙的空白）。 */
function bodyOf(content: string): string {
  const text = content.trim()
  return text || '（这条没有内容）'
}

/**
 * 一条消息的出处清单。
 *
 * 编号与正文里的 `[n]` **同一套**（后端给的 `index`）：导出去之后，「[2] 出自哪篇」
 * 仍然对得上——这正是"留档"与"随手复制"的差别。
 */
function sourcesOf(sources: readonly TranscriptSource[] | undefined): string[] {
  if (!sources || sources.length === 0) return []
  const lines = ['', '出处：']
  for (const source of sources) {
    const where = source.page
      ? `${source.document_name} 第 ${source.page} 页`
      : source.document_name
    const preview = (source.preview || '').trim().replace(/\s+/g, ' ')
    lines.push(`- [${source.index}] ${where}${preview ? ` —— ${preview}` : ''}`)
  }
  return lines
}

/**
 * 整条会话 → 一份 Markdown。
 *
 * 文件头两行是**给将来的人看的**：这是哪条会话、什么时候导的。少了第二行，
 * 一份躺了半年的文稿就说不清"这是当时的样子还是后来又聊过"。
 */
export function transcriptMarkdown(
  title: string,
  messages: readonly TranscriptMessage[],
  exportedAt: Date,
): string {
  const heading = title.trim() || '未命名对话'
  const stamp = `${exportedAt.getFullYear()}-${String(exportedAt.getMonth() + 1).padStart(2, '0')}-${String(
    exportedAt.getDate(),
  ).padStart(2, '0')} ${String(exportedAt.getHours()).padStart(2, '0')}:${String(
    exportedAt.getMinutes(),
  ).padStart(2, '0')}`
  const blocks = messages.map((message) => {
    const who = ROLE_LABEL[message.role] ?? message.role
    return [`## ${who}`, '', bodyOf(message.content), ...sourcesOf(message.sources)].join('\n')
  })
  return [
    `# ${heading}`,
    '',
    `> 导出于 ${stamp}`,
    '',
    ...blocks.flatMap((block) => [block, '']),
  ].join('\n')
}

/** 文件名：标题里的路径分隔符与控制字符要换掉，否则在某些系统上会被当成路径。 */
export function transcriptFileName(title: string): string {
  const safe = (title.trim() || '未命名对话')
    .replace(/[\\/:*?"<>|]/g, '_')
    // 控制字符**逐字滤掉**，不写进正则：`no-control-regex` 把后者当笔误拦下
    // ——那条规则有道理（控制字符出现在正则里几乎总是写错），而这里确实要滤它们。
    .split('')
    .filter((char) => char.charCodeAt(0) >= 32)
    .join('')
  return `${safe.slice(0, 60)}.md`
}
