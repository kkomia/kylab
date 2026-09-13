/**
 * 对话回答的富文本渲染（《前端设计规范》§4「文档优先」）。
 *
 * 为什么不能直接插 `innerHTML`：回答是模型生成的外部文本，里面可能包含 `<` 这类
 * 字符——不转义就等于把注入权交给了上游模型。所以先转义、再只把自己识别出来的
 * 标记变成标签，顺序不能反。
 *
 * 为什么只认这几样：默认提示词要求"简洁分点、用 [1] 标引用"，模型稳定输出的
 * 基本就是**小标题、无序列表、加粗、行内代码**。做一个小而全的 Markdown 解析器
 * 只会引入更多要维护、要测的边界；不认的语法原样保留，读起来仍然是可读的纯文本。
 */

/** 允许渲染的块级形态。 */
type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'ordered'; items: string[] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'code'; lang: string; code: string }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'hr' }
  | { kind: 'paragraph'; lines: string[] }

/** HTML 转义：`&` 必须第一个换，否则会把后面换出来的实体再转一遍。 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 只允许这两种协议：`javascript:` 之类的链接点了就是执行代码，必须挡掉。 */
const SAFE_LINK = /^(https?:\/\/|mailto:)/i

/**
 * 行内标记：`代码`、**加粗**、[文字](链接)。
 *
 * 顺序要紧：**先换代码**，否则代码里的 `**` 会被当加粗；
 * 而链接放在加粗之后——链接文字里常带加粗（`**[标题](url)**`），
 * 先处理加粗会让链接语法被拆开，反而识别不出来。实测那一版就是这样。
 */
function inline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label: string, href: string) => {
      // 链接是模型写的外部内容：只放行 http(s)/mailto，其余原样留着（可读、不可点）
      if (!SAFE_LINK.test(href)) return match
      return `<a class="md-link" href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`
    })
}

/** 表格分隔行：`| --- | :--: |`。用来把"表头 + 分隔行"认成一张表。 */
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/
/** 有序列表项：`1. ` / `2) `。 */
const ORDERED_ITEM = /^\s*\d+[.)]\s+(.*)$/
/** 围栏代码块的开头：``` 或 ~~~，后面可跟语言名。 */
const FENCE = /^\s*(`{3,}|~{3,})\s*([^\s`]*)\s*$/
/** 分隔线：`---` / `***` / `___`（三个以上）。与列表项的 `- ` 不冲突（它要跟空格与内容）。 */
const HR = /^\s*([-*_])\1{2,}\s*$/

/** 拆一行表格：去掉首尾的空单元（外层的竖线），并 trim 每一格。 */
function splitRow(line: string): string[] {
  const cells = line.split('|').map((cell) => cell.trim())
  if (cells.length && cells[0] === '') cells.shift()
  if (cells.length && cells[cells.length - 1] === '') cells.pop()
  return cells
}

/**
 * 先切块再渲染：切块只依赖行首，比"边扫边补标签"少一半状态。
 *
 * 用**下标循环**而不是 `for...of`：表格与代码块需要"往后看几行"
 * （分隔行、闭合围栏），拿不到后续行的写法只能靠状态机硬凑。
 */
function splitBlocks(text: string): Block[] {
  const blocks: Block[] = []
  const lines = text.split('\n')
  let list: string[] | null = null
  let ordered: string[] | null = null
  let quote: string[] | null = null
  let paragraph: string[] | null = null

  const flush = (): void => {
    if (list) {
      blocks.push({ kind: 'list', items: list })
      list = null
    }
    if (ordered) {
      blocks.push({ kind: 'ordered', items: ordered })
      ordered = null
    }
    if (quote) {
      blocks.push({ kind: 'quote', lines: quote })
      quote = null
    }
    if (paragraph) {
      blocks.push({ kind: 'paragraph', lines: paragraph })
      paragraph = null
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trimEnd()
    const fence = FENCE.exec(line)

    // 围栏代码块：**内容原样保留**（只转义），内部不再做任何行内标记。
    // 流式中途还没等到闭合围栏时也照样渲染——否则代码会先以纯文本闪一下再变成代码块
    if (fence) {
      flush()
      const marker = fence[1]
      const lang = fence[2]
      const body: string[] = []
      index += 1
      while (index < lines.length && !new RegExp(`^\\s*${marker[0]}{3,}\\s*$`).test(lines[index])) {
        body.push(lines[index])
        index += 1
      }
      blocks.push({ kind: 'code', lang, code: body.join('\n') })
      continue
    }

    if (HR.test(line)) {
      flush()
      blocks.push({ kind: 'hr' })
      continue
    }

    const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      // **保留原始层级**：原先一律渲染成 h4，于是一份 119 块的长文档
      // 从头到尾是同一个字号，完全看不出结构——那正是"阅读视角"最该提供的东西。
      // 夹到 2–4 级：h1 留给页面标题（文档名已经在页头了），
      // 而解析器输出的 h5/h6 在实际语料里极罕见，统一并到 4 级即可
      const level = Math.min(4, Math.max(2, heading[1].length + 1))
      blocks.push({ kind: 'heading', level, text: heading[2] })
      continue
    }

    // 表格：当前行是表头、下一行是分隔行。**必须是两行都成立**才算表，
    // 否则正文里偶尔出现的 `|`（"a | b"）会被当表格切碎
    if (line.includes('|') && index + 1 < lines.length && TABLE_SEPARATOR.test(lines[index + 1])) {
      flush()
      const header = splitRow(line)
      const rows: string[][] = []
      index += 2
      while (index < lines.length && lines[index].includes('|') && lines[index].trim() !== '') {
        rows.push(splitRow(lines[index]))
        index += 1
      }
      index -= 1
      blocks.push({ kind: 'table', header, rows })
      continue
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
    if (bullet) {
      if (paragraph) {
        blocks.push({ kind: 'paragraph', lines: paragraph })
        paragraph = null
      }
      list = list ?? []
      list.push(bullet[1])
      continue
    }

    const numbered = ORDERED_ITEM.exec(line)
    if (numbered) {
      if (paragraph) {
        blocks.push({ kind: 'paragraph', lines: paragraph })
        paragraph = null
      }
      ordered = ordered ?? []
      ordered.push(numbered[1])
      continue
    }

    const quoted = /^\s*>\s?(.*)$/.exec(line)
    if (quoted) {
      if (paragraph) {
        blocks.push({ kind: 'paragraph', lines: paragraph })
        paragraph = null
      }
      quote = quote ?? []
      quote.push(quoted[1])
      continue
    }

    if (line.trim() === '') {
      flush()
      continue
    }
    if (list) {
      blocks.push({ kind: 'list', items: list })
      list = null
    }
    if (ordered) {
      blocks.push({ kind: 'ordered', items: ordered })
      ordered = null
    }
    if (quote) {
      blocks.push({ kind: 'quote', lines: quote })
      quote = null
    }
    paragraph = paragraph ?? []
    paragraph.push(line)
  }
  flush()
  return blocks
}

function renderBlock(block: Block): string {
  if (block.kind === 'heading') {
    // 同时给 h 标签与类名：h 标签让浏览器/辅助技术知道层级，类名让样式能一致地管
    return `<h${block.level} class="md-h md-h${block.level}">${inline(block.text)}</h${block.level}>`
  }
  if (block.kind === 'list') {
    const items = block.items.map((item) => `<li>${inline(item)}</li>`).join('')
    return `<ul class="md-ul">${items}</ul>`
  }
  if (block.kind === 'ordered') {
    const items = block.items.map((item) => `<li>${inline(item)}</li>`).join('')
    return `<ol class="md-ol">${items}</ol>`
  }
  if (block.kind === 'quote') {
    // 引用块内部仍走行内标记：引用里常带加粗与代码
    const body = block.lines.map((item) => inline(item)).join('<br />')
    return `<blockquote class="md-quote">${body}</blockquote>`
  }
  if (block.kind === 'code') {
    // 语言名放 data 属性、样式里用 ::before 显示：不必额外包一层元素，
    // 也避免把语言名混进可复制的代码文本里
    const lang = block.lang ? ` data-lang="${escapeHtml(block.lang)}"` : ''
    return `<pre class="md-pre"${lang}><code>${escapeHtml(block.code)}</code></pre>`
  }
  if (block.kind === 'table') {
    const head = block.header.map((cell) => `<th>${inline(cell)}</th>`).join('')
    const body = block.rows
      .map(
        (row) =>
          `<tr>${block.header
            .map((_, cellIndex) => `<td>${inline(row[cellIndex] ?? '')}</td>`)
            .join('')}</tr>`,
      )
      .join('')
    // 外层套一个可横向滚动的容器：宽表格在窄列里必须能滚，否则会把整页撑破
    return `<div class="md-table-wrap"><table class="md-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`
  }
  if (block.kind === 'hr') return '<hr class="md-hr" />'
  return `<p class="md-p">${block.lines.map(inline).join('<br />')}</p>`
}

/**
 * 把回答文本转成可安全 `v-html` 的 HTML。
 *
 * **结果按文本缓存**。原先这里不缓存，理由是"流式期间会被反复调用，回答只有几百字"——
 * 那个理由只算了单条消息，漏掉了真实调用方式：模板里是
 * `v-html="renderAnswerMarkdown(message.text)"` 逐条内联，**组件每次重渲染都会
 * 把所有历史消息重算一遍**。流式时每个 token 触发一次重渲染，于是一轮回答的总
 * 解析量随消息数×token 数增长（长会话越聊越卡）。
 *
 * 加上缓存后：正在流式的那一条每 token 命中不到缓存（只解析一条），
 * 其余历史消息全部命中，总开销回到"每条解析一次"。
 * 文本就是缓存键，没有失效问题——同文本必然同输出。
 */
const HTML_CACHE = new Map<string, string>()
/** 上限只是防"聊一整天"把内存撑大；超出直接清空，命中率下降但不会漏结果。 */
const HTML_CACHE_LIMIT = 300

export function renderAnswerMarkdown(text: string): string {
  if (!text) return ''
  const cached = HTML_CACHE.get(text)
  if (cached !== undefined) return cached
  const html = splitBlocks(text).map(renderBlock).join('')
  if (HTML_CACHE.size >= HTML_CACHE_LIMIT) HTML_CACHE.clear()
  HTML_CACHE.set(text, html)
  return html
}

/* ------------------------------------------------------------------ 行内引用 */

/** 引用徽标要用的那一小撮字段（`ChatSource` 的子集，避免这里依赖 api 层）。 */
export interface CitationSource {
  index: number
  document_name: string
  heading_path?: string | null
  page?: number | null
}

/**
 * 回答里的 `[1] [2]` 标号**渲染成可点击的徽标**（参考 WeKnora / Perplexity 的做法）。
 *
 * 为什么不直接在 `inline()` 里处理：标号要能点、要知道它对应哪条出处，
 * 而渲染器不认识 sources——两者是两件事。所以先按老样子渲染出 HTML，
 * 再在这一步把标号替换成带 `data-cite-index` 的徽标，由页面用事件委托接住点击。
 *
 * 只替换**确实存在对应出处**的编号：模型偶尔会写 `[7]` 而检索只给了 6 条，
 * 那种天上掉下来的编号必须原样留着——做成一个点了没反应的徽标比不替换更糟。
 */
export function renderAnswerWithCitations(
  text: string,
  sources: readonly CitationSource[],
): string {
  if (!text || sources.length === 0) return renderAnswerMarkdown(text)

  const known = new Map(sources.map((source) => [source.index, source]))
  const signature = sources
    .map((source) => `${source.index}\u0001${source.document_name}\u0001${source.page ?? ''}`)
    .join('\u0002')
  const key = `${text}\u0000${signature}`
  const cached = CITATION_CACHE.get(key)
  if (cached !== undefined) return cached

  const html = decorateCitations(renderAnswerMarkdown(text), known)

  if (CITATION_CACHE.size >= HTML_CACHE_LIMIT) CITATION_CACHE.clear()
  CITATION_CACHE.set(key, html)
  return html
}

/** `[1]`、`[1,2]`、`[1，2]`——模型这几种写法都见过。 */
const CITE_RE = /\[(\d+(?:\s*[,，]\s*\d+)*)\]/g

/** 代码块与行内代码：**里面的 `[1]` 是代码，不是引用**，替换进去会改坏代码。 */
const CODE_SPAN = /<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>/g

/**
 * 把 `[1]` 换成可点的引用徽标。
 *
 * **跳过代码**：一份讲正则或数组的回答里 `[1]` 极常见，把它换成徽标会
 * ① 改坏代码的字面量 ② 让人以为那是在引用资料。所以先按代码段切开，
 * 只在代码之外做替换。
 */
function decorateCitations(html: string, known: Map<number, CitationSource>): string {
  let result = ''
  let cursor = 0
  CODE_SPAN.lastIndex = 0
  for (let match = CODE_SPAN.exec(html); match; match = CODE_SPAN.exec(html)) {
    result += replaceOutsideCode(html.slice(cursor, match.index), known) + match[0]
    cursor = match.index + match[0].length
  }
  return result + replaceOutsideCode(html.slice(cursor), known)
}

function replaceOutsideCode(segment: string, known: Map<number, CitationSource>): string {
  return segment.replace(CITE_RE, (match, group: string) => {
    const numbers = group
      .split(/[,，]/)
      .map((part) => Number(part.trim()))
      .filter((value) => Number.isInteger(value))
    // 组里有一个对不上就整组不换：`[3, 9]` 换一半会把原意读歪
    if (numbers.length === 0 || numbers.some((value) => !known.has(value))) return match
    return numbers.map((value) => citationChip(known.get(value)!)).join('')
  })
}

/**
 * 常见文档扩展名。
 *
 * 徽标里"这份文件叫什么"比"它是什么格式"更该先被看到，`…专家共识（2024年.pdf`
 * 里的 `.pdf` 只是尾巴；而且它占的那 4 个字符正好是最先被省略号吃掉的位置。
 */
const DOC_EXTENSION = /\.(pdf|docx?|xlsx?|pptx?|md|markdown|txt|csv|json|html?)$/i

/** 徽标上显示的文档短名：压平空白 + 去掉扩展名（空名兜底成"文档"）。 */
export function shortDocumentName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, ' ')
  if (!trimmed) return '文档'
  return trimmed.replace(DOC_EXTENSION, '') || trimmed
}

/**
 * 徽标上的 `title` 给鼠标悬停看"这一条是哪份文件的哪一段"。
 *
 * 徽标**显示文档名而不是序号**：读者要的是"这句依据来自哪份资料"，序号只有回去
 * 数出处列表才有意义。名字太长由内层 span 省略（样式见 ChatView 的 `.md-cite-name`），
 * 完整名字与位置仍在 `title` 里，悬停可见。
 */
function citationChip(source: CitationSource): string {
  const where: string[] = []
  if (source.heading_path) where.push(source.heading_path)
  if (source.page != null) where.push(`第 ${source.page} 页`)
  const title = where.length
    ? `${source.document_name} · ${where.join(' › ')}`
    : source.document_name
  return (
    `<a class="md-cite" data-cite-index="${source.index}" role="button" tabindex="0"` +
    ` title="${escapeHtml(title)}">` +
    `<span class="md-cite-name">${escapeHtml(shortDocumentName(source.document_name))}</span></a>`
  )
}

const CITATION_CACHE = new Map<string, string>()
