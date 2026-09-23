/**
 * 行内 LaTeX：**识别规则照搬 `useLatex.ts`，渲染交给 KaTeX**（React 迁移 P1）。
 *
 * 源文件：`frontend/src/composables/useLatex.ts`（290 行）。三条东西一条不丢：
 *
 * 1. **哪些写法认成公式**：里面必须含可识别的 LaTeX 标记（转义符、符号表里的命令、
 *    能映射的上下标、`\frac`）才算——`价格 $5 到 $10` 这类正文不能被误改；
 * 2. **`$` 与 `$$` 的边界**：`$…$` 是行内、`$$…$$` 是整式，两者各自配对、不跨换行；
 * 3. **转义**：`\%` `\$` `\&` `\#` `\_` `\{` `\}` `\~` `\,` `\;` `\:` `\!` `\ `
 *    与符号表（`\times` `\pm` `\Delta` …）的还原，以及模式外只动 `\~` `\_` 这一条。
 *
 * ## 与旧实现的两点差别（都是刻意的）
 *
 * - **`cleanInlineLatex` 仍是"文本 → 文本"**，一个 KaTeX 标签都不吐。理由不是兼容，
 *   是流水线：阅读视角那条路是 `renderAnswerMarkdown(cleanInlineLatex(正文))`
 *   （先清 LaTeX，再当 Markdown 渲染）——它要是吐 HTML，下游的 Markdown 解析要么
 *   当成字面量显示、要么得开 `rehype-raw`（那就等于把模型的输出当可信 HTML，安全口径崩了）。
 * - **真渲染走 `renderLatexToHtml`**（`katex.renderToString`）：对话页的正文由
 *   `markdown.tsx` 里的 `rehype-katex` 渲染，阅读视角这类"已经有纯文本"的入口用
 *   `splitInlineLatex` + `renderLatexToHtml` 自己拼。识别判据两条路**共用同一份**
 *   （`toInlineText` 里那本 `touched` 账），所以"哪些写法算公式"永远只有一处。
 *
 * 旧实现里那段"不引入 KaTeX 的理由"（首屏几百 KB 换几十处 `\alpha`）在 React 侧
 * 已经不成立了：KaTeX 随 `rehype-katex` 本来就要进包，于是这一层顺手用上它。
 */

import katex from 'katex'

/** 上标：`^{...}` → 上标字符（能映射的映射，不能的原样降级为普通文本）。 */
const SUPERSCRIPTS: Record<string, string> = {
  '0': '⁰',
  '1': '¹',
  '2': '²',
  '3': '³',
  '4': '⁴',
  '5': '⁵',
  '6': '⁶',
  '7': '⁷',
  '8': '⁸',
  '9': '⁹',
  '+': '⁺',
  '-': '⁻',
  '−': '⁻',
  n: 'ⁿ',
  i: 'ⁱ',
}

/** 下标：只映射数字，字母下标直接降级（`_a` 读起来也不别扭）。 */
const SUBSCRIPTS: Record<string, string> = {
  '0': '₀',
  '1': '₁',
  '2': '₂',
  '3': '₃',
  '4': '₄',
  '5': '₅',
  '6': '₆',
  '7': '₇',
  '8': '₈',
  '9': '₉',
  '+': '₊',
  '-': '₋',
}

/** LaTeX 转义字符 → 它真正想表达的字面量。 */
const ESCAPES: Record<string, string> = {
  '\\%': '%',
  '\\$': '$',
  '\\&': '&',
  '\\#': '#',
  '\\_': '_',
  '\\{': '{',
  '\\}': '}',
  '\\~': '~',
  '\\,': ' ',
  '\\;': ' ',
  '\\:': ' ',
  '\\!': '',
  '\\ ': ' ',
}

/**
 * **只在数学模式之外**替换的转义。
 *
 * 只放 `\~` 与 `\_`：这两个在普通正文里也常被转义（`3\~18岁`、`a\_1`），
 * 而 `\%` `\$` 之类**必须留给公式那一层处理**——在那里替换才算"认出了 LaTeX"，
 * 提前在这里剥掉会让公式看起来"和原文一样"，于是连 `$` 一起留在正文里（踩过）。
 */
const OUTSIDE_ESCAPES: Record<string, string> = {
  '\\~': '~',
  '\\_': '_',
}

/**
 * 只起排版作用、可以直接去掉的包装命令。
 *
 * `\mathrm{mm}` 实测是**最常见的残留**：云端解析器把单位也包进公式里，
 * 于是 `$22.79\mathrm{mm}$` 读出来是"22.79\mathrm{mm}"。
 * 这类命令只是告诉 LaTeX"按正体排"，去掉后语义完全不变。
 *
 * **写成字面量正则而不是拼字符串**：拼的时候要在"字符串转义"与"正则转义"两层里
 * 同时数反斜杠，极容易多一层——实测把 `\{` 写成了 `\\{`，
 * 于是 `{` 从"字面花括号"变成了"量词起始"，正则看着对但永不匹配。
 * 字面量只有一层，不会犯这个错。
 */
const WRAPPER_PATTERNS: readonly RegExp[] = [
  /\\mathrm\{([^{}]*)\}/g,
  /\\text\{([^{}]*)\}/g,
  /\\operatorname\{([^{}]*)\}/g,
  /\\mathbf\{([^{}]*)\}/g,
  /\\mathit\{([^{}]*)\}/g,
  /\\textbf\{([^{}]*)\}/g,
]

/**
 * 常见数学符号与希腊字母。
 *
 * **只收"标准字体里一定有字形"的那些**。希腊字母最初被排除在外（担心把变量名
 * 换成人名混淆），但实测医学文本里 `\Delta`（变化量）、`\mu`（微米）出现频繁，
 * 而希腊字母本身是标准符号、不会引起歧义——留着源码形态反而更难读。
 * 缺字形会掉成方框的风险由"只收常用字母"控制。
 */
const SYMBOLS: Record<string, string> = {
  '\\times': '×',
  '\\cdot': '·',
  '\\pm': '±',
  '\\leq': '≤',
  '\\geq': '≥',
  '\\neq': '≠',
  '\\approx': '≈',
  '\\sim': '~',
  '\\%': '%',
  '\\degree': '°',
  '\\rightarrow': '→',
  '\\to': '→',
  '\\infty': '∞',
  '\\propto': '∝',
  // 希腊字母：医学/统计文本里高频
  '\\Delta': 'Δ',
  '\\delta': 'δ',
  '\\alpha': 'α',
  '\\beta': 'β',
  '\\gamma': 'γ',
  '\\mu': 'μ',
  '\\sigma': 'σ',
  '\\lambda': 'λ',
  '\\theta': 'θ',
  '\\pi': 'π',
}

/** 把一段上标内容转成 Unicode 上标；有任一字符映射不了就返回 null（表示放弃）。 */
function toSuperscript(body: string): string | null {
  let out = ''
  for (const char of body) {
    const mapped = SUPERSCRIPTS[char]
    if (mapped === undefined) return null
    out += mapped
  }
  return out
}

function toSubscript(body: string): string | null {
  let out = ''
  for (const char of body) {
    const mapped = SUBSCRIPTS[char]
    if (mapped === undefined) return null
    out += mapped
  }
  return out
}

/**
 * 引用上标 `^{[1]}` / `^{[1-3]}`：**最常见的形态**，直接还原成普通方括号文本。
 *
 * 不用 Unicode 上标来放它：`¹` 这类字符在很多中文字体里缺字形，会掉成方框；
 * 而 `[1]` 与我们回答里的引用编号写法一致，读者一眼就懂，还能被日后做成可点锚点。
 */
function unwrapCitation(body: string): string | null {
  const trimmed = body.trim()
  return /^\[[\d,\s\-–]+\]$/.test(trimmed) ? trimmed : null
}

/**
 * 处理一个 `$...$` 片段的内容（**纯文本口径**，旧实现逐字照搬）。
 *
 * 返回 `{ text, touched }`：`touched: false` 表示"**没认出来**"——里面没有任何
 * 可识别的 LaTeX 标记。调用方据此保留原始的 `$...$`
 * （正文里真写了"价格 $5 到 $10"时不能被误改）。
 *
 * `touched` 这本账同时就是"哪些写法认成公式"的判据（`isInlineLatex`），
 * 以及 KaTeX 那条路要不要渲染的判据——**一处定义，两处引用**。
 */
function toInlineText(body: string): { text: string; touched: boolean } {
  let text = body.trim()
  let touched = false

  // 1) 排版包装命令：`\mathrm{mm}` → `mm`。先做，否则 `\mathrm` 会被当成认不出的命令
  for (const pattern of WRAPPER_PATTERNS) {
    text = text.replace(pattern, (_whole, inner: string) => {
      touched = true
      return inner
    })
  }

  // 2) 转义字符与符号。
  //
  // **替换前先记账**：`\%` 一旦换成 `%`、`\times` 一旦换成 `×`，
  // 就看不出它们曾是 LaTeX 了，下面的判断也就无从做起——那样本次公式会被
  // 判成"认不出"而整段保留（连 `$` 一起留在正文里）。踩过两次：
  // 第一次漏了 `\%`，第二次补了 `\%` 却漏了同属"符号表"的 `\times`。
  // 所以两张表要用**同一个**记账方式，不能再各写各的。
  const replaceAll = (from: string, to: string): void => {
    if (!text.includes(from)) return
    text = text.split(from).join(to)
    touched = true
  }
  for (const [from, to] of Object.entries(ESCAPES)) replaceAll(from, to)
  for (const [from, to] of Object.entries(SYMBOLS)) replaceAll(from, to)

  // 3) 上标 —— **只有替换真的成功才算 touched**：
  //    认不出映射时保留 `^{...}` 原样，否则会把 `$a^{b}$` 变成 `a^b` 这种更糟的半成品
  text = text.replace(/\^\{([^{}]*)\}/g, (whole, inner: string) => {
    const citation = unwrapCitation(inner)
    if (citation) {
      touched = true
      return citation
    }
    const sup = toSuperscript(inner)
    if (sup) {
      touched = true
      return sup
    }
    return whole
  })
  text = text.replace(/\^(\S)/g, (whole, inner: string) => {
    const sup = toSuperscript(inner)
    if (sup) {
      touched = true
      return sup
    }
    return whole
  })

  // 4) 下标，同样只在映射成功时才认
  text = text.replace(/_\{([^{}]*)\}/g, (whole, inner: string) => {
    const sub = toSubscript(inner)
    if (sub) {
      touched = true
      return sub
    }
    return whole
  })
  text = text.replace(/_(\S)/g, (whole, inner: string) => {
    const sub = toSubscript(inner)
    if (sub) {
      touched = true
      return sub
    }
    return whole
  })

  // 5) 分数：`\frac{a}{b}` → `a/b`
  text = text.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, (_whole, a: string, b: string) => {
    touched = true
    return `${a}/${b}`
  })

  // 6) 只用于排版的分组花括号。**放在最后**，且只在已经确认是 LaTeX 时才剥——
  //    否则 `$5 and $10` 这类正文会被它按"有花括号"误判成公式
  if (touched) text = text.replace(/[{}]/g, '')

  return { text, touched }
}

/**
 * 公式体的长度上限（旧实现写死的 200），也用来挡住"整段正文被当成一个公式"。
 *
 * **正则里那个 `{1,200}` 与它是同一个数**（字面量正则拼不进变量）：改这里要连
 * `MATH_SCAN` 一起改，不然"常量说 200、实际收 200"这句话就成了假话。
 */
export const INLINE_MATH_MAX_CHARS = 200

/**
 * `$…$`（行内）与 `$$…$$`（整式）的边界（P1 起显式区分）。
 *
 * 三条约束都是从旧实现继承的：
 *
 * - **不跨换行**（`[^$\n]`）：否则"第一行 $x$"与"第二行 $y$"会被当成一个公式，
 *   整段正文都被吞掉；
 * - **不跨 `$`**：公式体里不能再出现美元符号，所以配对只可能就近；
 * - **整式优先配对**：旧实现只认单 `$`，于是 `$$52.7\%$$` 会被单 `$` 那条规则
 *   吃掉中间一段、留下两个孤儿 `$`（实测的写法）。把整式那一支放在前头，
 *   同一次左到右扫描里它先被认走，就没有这个残留。
 *
 * 整式那一支前面的 `(^|[^$])` 是为了保证开头的 `$$` 真的是**一对**：
 * 没有它，`$$a$$ $$b$$` 里的第二对会被读成"从上一个收尾的 `$` 开始"的 `$$`。
 * 它吃进来的那个字符要用 `${prefix}` 原样还回去（见 `cleanMath`）。
 */
const MATH_SCAN = /(^|[^$])\$\$([^$\n]{1,200})\$\$(?!\$)|\$([^$\n]{1,200})\$/g

/** 一段正文切出来的片段：普通文本，或一段（已认出的）公式。 */
export type InlineLatexSegment =
  { kind: 'text'; value: string } | { kind: 'math'; value: string; display: boolean }

/**
 * 认不认这段公式体（"哪些写法认成公式"的**唯一判据**）。
 *
 * `false` 的那一半一律原样保留：半吊子的 LaTeX 渲染比不渲染更糟——它会悄悄改掉
 * 技术文档里本该精确的内容（把 `\alpha` 显示成别的字母、把上下标顺序搞反）。
 */
export function isInlineLatex(body: string): boolean {
  return toInlineText(body).touched
}

/**
 * 用 KaTeX 把一段公式渲染成 HTML。
 *
 * **不抛**：`throwOnError: false` 加上这一层兜底，坏公式退化成它自己的原文
 * （KaTeX 自己也会把 ParseError 画成红色的原文，这正是我们要的"别假装渲染成功"）。
 * 输出是 KaTeX 生成的**可信 HTML**（它自己会转义公式里的 `<` `>`），调用方按 HTML 挂。
 */
export function renderLatexToHtml(tex: string, options: { display?: boolean } = {}): string {
  try {
    return katex.renderToString(tex, {
      displayMode: options.display === true,
      throwOnError: false,
      strict: 'ignore',
      // 输出形态**不覆盖**：KaTeX 的默认是 MathML + HTML 两份，与对话页那条
      // `rehype-katex` 的默认一致（只出 HTML 会让读屏软件念不出公式）
    })
  } catch {
    // 连兜底都失败（极端输入）：把原文原样交回去，不造一段假 HTML
    return tex.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }
}

/**
 * 处理一行文本里的公式：**认识的替换（纯文本口径），不认识的原样保留**。
 *
 * 一趟左到右的扫描（见 `MATH_SCAN`）：整式那一支先被认走，所以 `$$…$$` 不会被
 * 单 `$` 那条规则拆成两半。
 */
function cleanMath(text: string): string {
  if (!text.includes('$')) return text
  MATH_SCAN.lastIndex = 0
  return text.replace(
    MATH_SCAN,
    (
      whole,
      prefix: string | undefined,
      displayBody: string | undefined,
      inlineBody: string | undefined,
    ) => {
      const body = displayBody !== undefined ? displayBody : inlineBody
      if (body === undefined) return whole
      const { text: inner, touched } = toInlineText(body)
      if (!touched) return whole
      // 整式那一支把前一个字符也吃进了匹配，这里还回去
      return displayBody !== undefined ? `${prefix}${inner}` : inner
    },
  )
}

/**
 * 清理正文里的行内 LaTeX（**导出的函数名与旧实现一致**）。
 *
 * 两步，顺序是**公式在前、模式外转义在后**：
 *
 * 1. `$...$`（与 `$$...$$`）里能识别出 LaTeX 标记的内容 → 按纯文本还原；认不出就原样保留
 *    （正文里真写了"价格 $5 到 $10"时不能被误改）。
 * 2. 剩下的文本里，把 `3\~18岁`、`a\_1` 这类**模式外转义**去掉反斜杠。
 *
 * 为什么公式必须先做：`$3\~18$` 若先被第 2 步抹掉 `\~`，公式那一层就认不出它，
 * 于是连 `$` 一起留在正文里。反过来就不会——第 1 步已经把成对的 `$` 消耗掉了，
 * 第 2 步只需要处理"没被公式接走"的那些反斜杠。
 *
 * 第 2 步只动 `\~` 与 `\_`：`\alpha` 这类命令与 `C:\Users` 这类路径都不受影响
 * （反斜杠后面是字母）。
 *
 * **它吐的是纯文本**（一个标签都没有）：要真渲染公式走 `renderLatexToHtml` /
 * `splitInlineLatex`，原因见模块头注。
 */
export function cleanInlineLatex(text: string): string {
  if (!text) return text

  const out = cleanMath(text)
  let result = out
  for (const [from, to] of Object.entries(OUTSIDE_ESCAPES)) {
    if (result.includes(from)) result = result.split(from).join(to)
  }
  return result
}

/**
 * 把一行文本切成"普通文本 / 公式"两种片段（React 侧渲染公式用）。
 *
 * 只有**认出来的**才切成 `math`：认不出的照旧留在 `text` 里，
 * 与 `cleanInlineLatex` 同一条纪律（宁可不渲染，不可渲染错）。
 * 相邻的普通文本会被合成一段，调用方不必自己合并。
 */
export function splitInlineLatex(text: string): InlineLatexSegment[] {
  const segments: InlineLatexSegment[] = []
  if (!text) return segments
  const pushText = (value: string): void => {
    if (!value) return
    const last = segments.at(-1)
    if (last?.kind === 'text') last.value += value
    else segments.push({ kind: 'text', value })
  }

  let cursor = 0
  MATH_SCAN.lastIndex = 0
  for (let match = MATH_SCAN.exec(text); match; match = MATH_SCAN.exec(text)) {
    const displayBody: string | undefined = match[2]
    const inlineBody: string | undefined = match[3]
    const display = displayBody !== undefined
    const body = display ? displayBody : inlineBody
    if (body === undefined) continue
    // 公式体前面的那一个字符是"配对保证"用的（见 `MATH_SCAN`），留在普通文本里
    const prefix = display ? match[1] : ''
    const start = match.index + prefix.length
    // 认不出的一律留在普通文本里：与 `cleanInlineLatex` 同一条纪律
    if (!toInlineText(body).touched) continue
    pushText(text.slice(cursor, start))
    // 交给 KaTeX 的是**原文**（`\mathrm{mm}` `\frac{1}{2}` 这些要它自己去排），
    // 不是上面那份"还原成纯文本"的结果——那份是给不能渲染数学的入口用的
    segments.push({ kind: 'math', value: body.trim(), display })
    cursor = start + match[0].length - prefix.length
  }

  pushText(text.slice(cursor))
  return segments
}
