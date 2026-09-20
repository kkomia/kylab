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
 * 正文里的**裸链接**（v0.26）。
 *
 * 模型经常直接把网址写在正文里（"来源：https://…"、搜索结果那一段），
 * 而 Markdown 的 `[文字](链接)` 只有它主动写出来才有——那种情况下用户只能手抄。
 *
 * 只认 `http(s)://` 与 `www.` 开头：**不猜邮箱、不猜裸域名**。
 * 猜错一个（把 `README.md` 认成网址）比漏掉几个糟得多，而漏掉的那些还能手抄。
 *
 * 两条边界都是踩出来的：
 * - **前面只要不是字母数字**（`[^\w/@]`）就算开头。原先写的是"前面必须是空白或左括号"，
 *   于是"来源：https://…"里的网址根本不匹配——那个全角冒号不在白名单里，
 *   而这恰恰是模型最常见的写法；
 * - **网址体里不许出现中文标点**。"……详见 https://a.com。另外……"这种句子里，
 *   句号后面紧跟的是下一个句子，不排除的话整个"https://a.com。另外"会被当成一个网址。
 */
const BARE_URL = /(^|[^\w/@])((?:https?:\/\/|www\.)[^\s<>()（）「」『』【】"'。，、；：！？…]+)/g

/**
 * 网址**末尾不该跟着的字符**：句号、逗号、中文标点、右括号。
 *
 * 必须剥掉：模型写的是"…详见 https://example.com/a。"，那个句号属于句子。
 * 括号一律剥（`(a)` 里那个本该属于网址）——中文语境里右括号跟着网址几乎总是句法括号，
 * 剥错了只是让链接短一点，不剥则会让链接点开 404。
 */
const URL_TAIL = /[.,;:!?，。、；：！？）)】」』"']+$/

/** 一个外链。`rel` 与 `target` 与 Markdown 那条规则**完全一致**——两处不能有两种开法。 */
function anchor(href: string, label: string): string {
  return `<a class="md-link" href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`
}

/** 裸链接 → `<a>`。**只处理已经被转义过的文本**（调用点在 `inline` 里）。 */
function linkify(html: string): string {
  return html.replace(BARE_URL, (match, prefix: string, url: string, offset: number) => {
    // **被裁断的网址不做链接**：紧跟一个省略号就说明它只剩半截
    // （工具结果那一行由后端裁到 120 字）。链过去是个不存在的地址，
    // 而用户会以为是自己网络的问题——那比"不能点"糟得多。
    if (html[offset + match.length] === '…') return match
    const trimmed = url.replace(URL_TAIL, '')
    const tail = url.slice(trimmed.length)
    // `www.` 开头的补上协议：不带协议的 href 会被当成站内相对路径
    const href = trimmed.startsWith('www.') ? `https://${trimmed}` : trimmed
    return `${prefix}${anchor(href, trimmed)}${tail}`
  })
}

/**
 * 行内标记：`代码`、**加粗**、[文字](链接)。
 *
 * 顺序要紧：**先换代码**，否则代码里的 `**` 会被当加粗；
 * 而链接放在加粗之后——链接文字里常带加粗（`**[标题](url)**`），
 * 先处理加粗会让链接语法被拆开，反而识别不出来。实测那一版就是这样。
 */
function inline(text: string): string {
  // **摘出来再放回去**：裸链接那一步是正则扫全文的，会把两样东西误伤——
  // ① 代码段里的网址（那是字面量，点了就跑偏了）；② 已经生成好的
  // `href="…"`（在属性里再插一层 `<a>`，整段 HTML 就烂了）。
  // 用占位符把它们先藏起来，最后原样放回。
  const stash: string[] = []
  const keep = (html: string): string => {
    stash.push(html)
    return `\u0000${stash.length - 1}\u0000`
  }

  const html = escapeHtml(text)
    .replace(/`([^`]+)`/g, (_match, code: string) => keep(`<code>${code}</code>`))
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label: string, href: string) => {
      // 链接是模型写的外部内容：只放行 http(s)/mailto，其余原样留着（可读、不可点）
      if (!SAFE_LINK.test(href)) return match
      return keep(anchor(href, label))
    })

  // 占位符用 **NUL**：它是唯一一个不可能出现在正文里的字符，换别的都得先证明
  // "用户不会正好写这个"。下面那条 lint 规则正是为了挡控制字符——这里是刻意用的。
  // eslint-disable-next-line no-control-regex -- 见上
  const placeholder = /\u0000(\d+)\u0000/g
  return linkify(html).replace(placeholder, (_match, index: string) => stash[Number(index)])
}

/**
 * 代码块与表格右上角那两个按钮的图标。
 *
 * **为什么把 SVG 写成字符串**：这段 HTML 是 `v-html` 出来的，模板里的
 * `<IconCopy>` 组件在这里用不上。三个图标都取自仓库里的图标集（同一份路径），
 * 免得"回答里的复制按钮"和"消息上的复制按钮"画得不一样。
 */
const ICON_COPY =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M7 6V3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-3v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zm2 0h8a1 1 0 0 1 1 1v9h2V4H9zM5 8v10h10V8z"/></svg>'
const ICON_DOWNLOAD =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M13 3v10.586l3.293-3.293 1.414 1.414L12 17.414 6.293 11.707 7.707 10.293 11 13.586V3zM5 19h14v2H5z"/></svg>'

/**
 * 代码块与表格的**两段式容器**（头部带 + 内容区）。
 *
 * 头部带里的按钮由 ChatView 用**事件委托**接（`[data-copy-code]` /
 * `[data-copy-table]` / `[data-download-table]`）：`v-html` 出来的节点绑不上 Vue 事件，
 * 而给每块代码单独挂监听又要在渲染后遍历一遍 DOM。
 *
 * 头部**不参与复制**：`data-copy-code` 的处理器从 `closest('.md-code')` 里
 * 只取 `pre` 的文本，所以语言名不会被带进剪贴板。
 */
function codeBlockHtml(lang: string, code: string): string {
  const label = lang ? `<span class="md-code-lang">${escapeHtml(lang)}</span>` : '<span></span>'
  return (
    `<div class="md-code">` +
    `<div class="md-code-head">${label}` +
    `<button type="button" class="md-icon-btn" data-copy-code aria-label="复制代码" title="复制">${ICON_COPY}</button>` +
    `</div>` +
    `<pre class="md-pre"><code>${escapeHtml(code)}</code></pre>` +
    `</div>`
  )
}

function tableBlockHtml(head: string, body: string): string {
  return (
    `<div class="md-table-block">` +
    `<div class="md-code-head"><span class="md-code-lang">表格</span>` +
    `<button type="button" class="md-icon-btn" data-copy-table aria-label="复制表格" title="复制">${ICON_COPY}</button>` +
    `<button type="button" class="md-icon-btn" data-download-table aria-label="下载表格" title="下载 CSV">${ICON_DOWNLOAD}</button>` +
    `</div>` +
    `<div class="md-table-wrap"><table class="md-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>` +
    `</div>`
  )
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

/**
 * ``plain``：渲染成**只读**的 HTML（文件预览用）。
 *
 * 对话里的答案要能复制代码、下载表格，那两个按钮的点击由对话页的事件委托接住；
 * 而文件预览里没有那条委托（也不该有——预览是"看"，不是"操作这份内容"）。
 * 所以同一套解析、两种收尾：``plain`` 只出内容，不出按钮。
 */
function renderBlock(block: Block, plain = false): string {
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
    // 语言名与复制按钮都在**头部带**上（v0.25，照 Kimi 的对话页）：
    // 原先语言名是绝对定位在右上角的，代码一长就从它底下穿过去，
    // 像两样东西叠在一起；而且整块没有复制入口。
    if (plain) return `<pre class="md-pre"><code>${escapeHtml(block.code)}</code></pre>`
    return codeBlockHtml(block.lang, block.code)
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
    if (plain) {
      return `<table class="md-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
    }
    // 外层套一个可横向滚动的容器：宽表格在窄列里必须能滚，否则会把整页撑破
    return tableBlockHtml(head, body)
  }
  if (block.kind === 'hr') return '<hr class="md-hr" />'
  return `<p class="md-p">${block.lines.map(inline).join('<br />')}</p>`
}

/**
 * 两层缓存。**建它们时的理由（"流式重解析是性能热点"）经实测被削弱了**，
 * 数字记在这里，免得后来者按错误的量级继续加复杂度：
 *
 * - **文本级**（`HTML_CACHE`）：模板里是 `v-html="renderAnswerMarkdown(...)"` 逐条内联，
 *   组件每次重渲染都会把所有历史消息重算一遍。按文本缓存后历史消息全部命中——
 *   这一层的收益是实的，长会话下每拍省掉 N 条消息的解析。
 * - **块级**（`BLOCK_CACHE`）：流式时文本级缓存必然落空（每个 tick 的前缀都是新文本），
 *   于是每拍把**已累积的全文**重新解析一遍，总解析量随回答长度平方增长。
 *   加块缓存后追加文本只重算末尾那个块。
 *
 * 对照实测（2026-09-17，同一段 1400 字回答 + 60 条历史的模拟，取 3 次最小值）：
 * 单条回答流式 140 拍 **6.0ms → 4.6ms（1.3x）**、400 拍 **12.4ms → 7.7ms（1.6x）**；
 * 长会话那一组（每拍再渲染 60 条历史）**1.0x，没有可测差异**。
 *
 * 所以：形状是 O(n²)，**绝对量是毫秒级**——分散在几百帧里，每帧 0.1ms 量级，
 * 不是用户能感知的瓶颈。每帧真正的大头在 `v-html` 让浏览器重建 DOM，
 * 那一项与这里无关。这两层缓存当作"顺手做对"即可，不要再当热点优化。
 *
 * 键都是**内容本身**，所以同内容必然同输出：缓存只允许更快，不允许改变结果。
 */
const HTML_CACHE = new Map<string, string>()
/** 只防"聊一整天"把内存撑大，不是性能旋钮（淘汰策略见 `putCapped`）。 */
const HTML_CACHE_LIMIT = 300

const BLOCK_CACHE = new Map<string, string>()
/** 块比整条消息小得多，可以多留一些。 */
const BLOCK_CACHE_LIMIT = 2000

/**
 * 超过上限时淘汰**最旧的一条**，而不是清空整张表。
 *
 * 原先写的是"满了清空"。它的代价不在内存，在**下一次渲染**：清空之后
 * 紧接着的那次重渲染要把整条会话的所有消息重新解析一遍，表现成一个尖峰而不是
 * 平摊的开销。淘汰一条没有这个悬崖，代价只是命中率略低。
 * （实测差距在毫秒级、长会话那一组测不出来——这是一次正确性之外的"做得更像样"。）
 */
function putCapped(cache: Map<string, string>, limit: number, key: string, value: string): void {
  if (!cache.has(key) && cache.size >= limit) {
    // Map 的迭代顺序就是插入顺序：第一个即最旧的
    const oldest = cache.keys().next()
    if (!oldest.done) cache.delete(oldest.value)
  }
  cache.set(key, value)
}

/**
 * 把一段 Markdown 渲染成**只读** HTML（文件预览用）。
 *
 * 与 `renderAnswerMarkdown` 同一套解析，只是不挂复制 / 下载按钮——
 * 那些按钮的点击由对话页的事件委托接住，而预览里没有那条委托，
 * 按钮会变成"点了没反应"的假控件。
 *
 * 不走缓存：它用在文件预览里，一次只渲染一份，没有"每个 tick 重算历史"那种模式。
 */
export function renderPlainMarkdown(text: string): string {
  if (!text) return ''
  return splitBlocks(text)
    .map((block) => renderBlock(block, true))
    .join('')
}

export function renderAnswerMarkdown(text: string): string {
  if (!text) return ''
  const cached = HTML_CACHE.get(text)
  if (cached !== undefined) return cached

  const blocks = splitBlocks(text)
  const last = blocks.length - 1
  const html = blocks
    .map((block, index) => {
      // 末尾块每个 tick 都在变，缓存它等于往表里灌垃圾
      if (index === last) return renderBlock(block)
      // 键用 JSON 而不是拼接：拼接少一次序列化，但分隔符一旦与文本里的字符撞上
      // 就是**两块共用一份 HTML**——缓存串味是正确性问题，不值得为这点开销冒险
      const key = JSON.stringify(block)
      const hit = BLOCK_CACHE.get(key)
      if (hit !== undefined) return hit
      const rendered = renderBlock(block)
      putCapped(BLOCK_CACHE, BLOCK_CACHE_LIMIT, key, rendered)
      return rendered
    })
    .join('')

  putCapped(HTML_CACHE, HTML_CACHE_LIMIT, text, html)
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

  putCapped(CITATION_CACHE, HTML_CACHE_LIMIT, key, html)
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

/** 徽标上显示的文档短名：压平空白 + 去掉目录前缀与扩展名（空名兜底成"文档"）。 */
export function shortDocumentName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, ' ')
  if (!trimmed) return '文档'
  // **目录前缀也要去掉**：整目录上传的文档名带一层批次目录
  // （`markdown_20260908-…_110files/共识.md`），留着它，徽标里最先被看到的就是
  // 那串无意义的批次号——而窄徽标恰恰只显示开头几个字。
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  const base = cut >= 0 ? trimmed.slice(cut + 1) : trimmed
  return base.replace(DOC_EXTENSION, '') || base
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
