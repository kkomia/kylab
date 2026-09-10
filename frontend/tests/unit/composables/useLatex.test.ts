import { describe, expect, it } from 'vitest'

import { cleanInlineLatex } from '@/composables/useLatex'

describe('cleanInlineLatex', () => {
  it('把引用上标还原成方括号文本', () => {
    // 医学期刊里最常见的形态：一篇文章几十处
    expect(cleanInlineLatex('眼轴测量$^{[1]}$是主要指标')).toBe('眼轴测量[1]是主要指标')
    expect(cleanInlineLatex('结论已有报道$^{[1-3]}$')).toBe('结论已有报道[1-3]')
    expect(cleanInlineLatex('多篇研究$^{[22]}$')).toBe('多篇研究[22]')
  })

  it('还原百分号转义', () => {
    expect(cleanInlineLatex('占比 $52.7\\%$ 左右')).toBe('占比 52.7% 左右')
  })

  it('还原常用符号', () => {
    expect(cleanInlineLatex('$3 \\times 4$')).toBe('3 × 4')
    expect(cleanInlineLatex('$5 \\pm 2$')).toBe('5 ± 2')
    expect(cleanInlineLatex('$a \\leq b$')).toBe('a ≤ b')
  })

  it('数字上下标转成 Unicode 上下标', () => {
    expect(cleanInlineLatex('$x^{2}$')).toBe('x²')
    expect(cleanInlineLatex('$H_{2}O$')).toBe('H₂O')
  })

  it('分数转成斜杠写法', () => {
    expect(cleanInlineLatex('$\\frac{1}{2}$ 剂量')).toBe('1/2 剂量')
  })

  it('去掉只起排版作用的包装命令', () => {
    // 实测最常见的一类残留：解析器把单位也包进公式里，
    // 于是读数读成「22.79\mathrm{mm}」
    expect(cleanInlineLatex('$22.79\\mathrm{mm}$')).toBe('22.79mm')
    expect(cleanInlineLatex('$61.8\\text{%}$')).toBe('61.8%')
  })

  it('还原反斜杠转义的波浪号与下划线', () => {
    // 实测这类写法**通常不带 `$`**（解析器只在少数地方包公式），
    // 所以 `3\~18岁` 与 `$3\~18$岁` 都要能还原
    expect(cleanInlineLatex('$3\\~18$岁')).toBe('3~18岁')
    expect(cleanInlineLatex('$a\\_b$')).toBe('a_b')
  })

  it('数学模式之外的转义标点也要还原', () => {
    // 只处理公式的那一版会漏掉这类：正文里一路留着反斜杠
    expect(cleanInlineLatex('3\\~18岁儿童青少年')).toBe('3~18岁儿童青少年')
    expect(cleanInlineLatex('变量 a\\_1 与 b\\_2')).toBe('变量 a_1 与 b_2')
  })

  it('不碰代码里的反斜杠与 LaTeX 命令', () => {
    // 反斜杠后面是字母时一律不动：`\alpha` 是命令、`C:\Users` 是路径
    expect(cleanInlineLatex('路径 C:\\Users\\me 与命令 \\alpha')).toBe(
      '路径 C:\\Users\\me 与命令 \\alpha',
    )
  })

  it('不带 $ 的文本原样返回', () => {
    const plain = '没有任何数学标记的一段中文。'
    expect(cleanInlineLatex(plain)).toBe(plain)
  })

  // ------------------------------------------------------------------ 关键：不能误伤

  it('不误伤正文里成对出现的美元符号', () => {
    // **这条是这份实现最容易出错的地方**：`$5 and $10` 会被"成对的 $"
    // 正则匹配到，如果只按"内容变了没有"判断，就会把它改坏。
    // 判据必须是"里面有没有可识别的 LaTeX 标记"。
    const money = '价格从 $5 到 $10 不等'
    expect(cleanInlineLatex(money)).toBe(money)
  })

  it('认不出的 LaTeX 原样保留，不产生半成品', () => {
    // 认不出时保持原样，比输出半吊子渲染安全。
    // `a^{b}` 是刻意的例子：字母上标没有 Unicode 映射，硬转会得到 `a^b` 这种四不像
    expect(cleanInlineLatex('$a^{b}$')).toBe('$a^{b}$')
    expect(cleanInlineLatex('$\\oint_C f$')).toBe('$\\oint_C f$')
  })

  it('希腊字母转成对应字符', () => {
    // 实测医学文本里 `\Delta`（变化量）、`\mu`（微米）出现频繁
    expect(cleanInlineLatex('$\\Delta SE/\\Delta AL$')).toBe('Δ SE/Δ AL')
    // `\ ` 是 LaTeX 的显式空格，转换后就是一个普通空格——保留它，
    // 因为原文确实在那里放了间距
    expect(cleanInlineLatex('$5\\ \\mu m$')).toBe('5 μ m')
    expect(cleanInlineLatex('$\\alpha$ 与 $\\beta$')).toBe('α 与 β')
  })

  it('不跨越换行匹配（避免把整段正文吞进公式）', () => {
    const text = '第一行 $x$\n第二行 $y$'
    expect(cleanInlineLatex(text)).toBe(text)
  })

  it('一段文本里的多处标记都要处理', () => {
    const text = '结论$^{[1]}$与$^{[2]}$一致，占比$61.8\\%^{[3]}$'
    expect(cleanInlineLatex(text)).toBe('结论[1]与[2]一致，占比61.8%[3]')
  })

  it('空串与纯空白不炸', () => {
    expect(cleanInlineLatex('')).toBe('')
    expect(cleanInlineLatex('   ')).toBe('   ')
  })
})
