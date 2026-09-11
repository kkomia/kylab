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
  | { kind: 'paragraph'; lines: string[] }

/** HTML 转义：`&` 必须第一个换，否则会把后面换出来的实体再转一遍。 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 行内标记：只处理成对的 `**加粗**` 与 `` `代码` ``，代码先换，避免它与加粗互相吃掉。 */
function inline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
}

/** 先切块再渲染：切块只依赖行首，比"边扫边补标签"少一半状态。 */
function splitBlocks(text: string): Block[] {
  const blocks: Block[] = []
  let list: string[] | null = null
  let paragraph: string[] | null = null

  const flush = (): void => {
    if (list) {
      blocks.push({ kind: 'list', items: list })
      list = null
    }
    if (paragraph) {
      blocks.push({ kind: 'paragraph', lines: paragraph })
      paragraph = null
    }
  }

  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
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
    if (bullet) {
      if (paragraph) {
        blocks.push({ kind: 'paragraph', lines: paragraph })
        paragraph = null
      }
      list = list ?? []
      list.push(bullet[1])
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
