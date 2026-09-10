/**
 * 阅读视角里的行内 LaTeX 清理（开发计划 §12 / G2）。
 *
 * **为什么需要**：云端解析器（MinerU 等）把 PDF 里的数学与上标原样输出成 LaTeX，
 * 于是正文里会出现 `$^{[1]}$`、`$52.7\%$` 这样的源码。实测在真实的医学期刊语料里
 * **26% 的 chunk 含行内 LaTeX**，其中 18% 是引用上标——一篇文章里几十处，
 * 阅读时满屏都是美元符号和花括号。
 *
 * **只处理确定安全的几种形态**，认不出的一律**原样保留**：
 * 半吊子的 LaTeX 渲染比不渲染更糟——它会悄悄改掉技术文档里本该精确的内容
 * （把 `\alpha` 显示成别的字母、把上下标顺序搞反）。
 * 所以这里的定位是"去掉噪声"，不是"渲染数学"；真要完整渲染得上 KaTeX（体积代价另说）。
 *
 * 不引入 KaTeX 的理由：行内数学在这份语料里绝大多数是"引用编号 + 百分比"，
 * 上 KaTeX 会让首屏多几百 KB，而收益只是几十处 `\alpha`。
 */

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
 * 处理一个 `$...$` 片段的内容。
 *
 * 返回 ``null`` 表示"**没认出来**"——里面没有任何可识别的 LaTeX 标记。
 * 调用方据此保留原始的 `$...$`（正文里真写了"价格 $5 到 $10"时不能被误改）。
 */
function renderInlineMath(body: string): string | null {
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

  return touched ? text : null
}

/**
 * 清理正文里的行内 LaTeX。
 *
 * 两步，顺序是**公式在前、模式外转义在后**：
 *
 * 1. `$...$` 里能识别出 LaTeX 标记的内容 → 渲染；认不出就原样保留
 *    （正文里真写了"价格 $5 到 $10"时不能被误改）。
 * 2. 剩下的文本里，把 `3\~18岁`、`a\_1` 这类**模式外转义**去掉反斜杠。
 *
 * 为什么公式必须先做：`$3\~18$` 若先被第 2 步抹掉 `\~`，公式那一层就认不出它，
 * 于是连 `$` 一起留在正文里。反过来就不会——第 1 步已经把成对的 `$` 消耗掉了，
 * 第 2 步只需要处理"没被公式接走"的那些反斜杠。
 *
 * 第 2 步只动 `\~` 与 `\_`：`\alpha` 这类命令与 `C:\Users` 这类路径都不受影响
 * （反斜杠后面是字母）。
 */
export function cleanInlineLatex(text: string): string {
  if (!text) return text

  let out = text
  if (out.includes('$')) {
    out = out.replace(/\$([^$\n]{1,200})\$/g, (whole, body: string) => {
      const rendered = renderInlineMath(body)
      return rendered === null ? whole : rendered
    })
  }

  for (const [from, to] of Object.entries(OUTSIDE_ESCAPES)) {
    if (out.includes(from)) out = out.split(from).join(to)
  }
  return out
}
