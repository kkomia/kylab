/**
 * 回答渲染（`model/markdown.tsx`）——**旧前端的 54 条用例逐条搬过来**，另加 P1 新增的
 * 那几件（`<Answer>` 组件形态、按钮回调、KaTeX/高亮）。
 *
 * 源：`frontend/tests/unit/composables/useMarkdown.test.ts`。
 *
 * 搬法：**每条用例的功能点与断言一字不丢**，只有两处收尾上的改写——
 *
 * 1. 旧实现导出的是 HTML 字符串，直接 `toBe('…')`；新实现（react-markdown）落成 DOM，
 *    所以统一过一层 `html()`（渲染到容器再取 `innerHTML`），断言仍然逐字比对；
 * 2. `<br>` / `<hr>` 这类空标签，React 按 HTML5 出（`<br>`），旧实现按 XHTML 出
 *    （`<br />`）——`html()` 把它们归一成旧写法，**除此之外一个字符都不改**
 *    （所以下面那批 `toBe` 与旧用例是同一串文本）。结构上确有一处不同：
 *    `blockquote` 的内容现在被 remark 包在 `<p class="md-p">` 里（旧实现是直接铺行）。
 *
 * P5 之前还有一处**口径变化**：公式改走 `remark-math` + `rehype-katex` 的标准口径
 * （原先那个自写的 `rehypeInlineMath` 撤了）。受影响的两条用例已按新口径重写，
 * 并在用例里写明了"为什么变"；差异表在 `src/features/chat/model/README.md`。
 */

import { fireEvent, render } from '@testing-library/react'
import { createElement, Fragment, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import {
  Answer,
  renderAnswerMarkdown,
  renderAnswerWithCitations,
  renderPlainMarkdown,
  shortDocumentName,
  type CitationSource,
} from '@/features/chat/model/markdown'

/**
 * 渲染后的**纯文本**（`textContent`）。
 *
 * 代码高亮（`rehype-highlight`）会把代码切成一片 span，所以"代码内容还在不在"
 * 这类断言要走文本，而不是比 HTML 串。
 */
function text(node: ReactNode): string {
  const { container } = render(createElement(Fragment, null, node))
  return container.textContent ?? ''
}

/** 渲染成 HTML 字符串：新实现是 React 元素，用例在这一层比对（与旧用例同一串文本）。 */
function html(node: ReactNode): string {
  const { container } = render(createElement(Fragment, null, node))
  // 旧实现按 XHTML 出空标签（`<br />`），React 按 HTML5 出（`<br>`）：只归一这一处
  return container.innerHTML.replace(/<(br|hr)([^>]*)>/g, '<$1$2 />')
}

describe('renderAnswerMarkdown', () => {
  it('空文本不产出任何标签', () => {
    expect(html(renderAnswerMarkdown(''))).toBe('')
  })

  it('普通段落原样保留', () => {
    expect(html(renderAnswerMarkdown('眼轴长度是主要参数。'))).toBe(
      '<p class="md-p">眼轴长度是主要参数。</p>',
    )
  })

  it('段落内的换行折成 br，而不是各起一段', () => {
    expect(html(renderAnswerMarkdown('第一行\n第二行'))).toBe(
      '<p class="md-p">第一行<br />第二行</p>',
    )
  })

  it('空行分段', () => {
    expect(html(renderAnswerMarkdown('甲\n\n乙'))).toBe(
      '<p class="md-p">甲</p><p class="md-p">乙</p>',
    )
  })

  it('加粗与行内代码', () => {
    expect(html(renderAnswerMarkdown('**监测意义**：见 `AL`'))).toBe(
      '<p class="md-p"><strong>监测意义</strong>：见 <code>AL</code></p>',
    )
  })

  it('无序列表：连着的项目合成一个 ul', () => {
    const markup = html(renderAnswerMarkdown('- 甲\n- 乙\n- 丙'))
    expect(markup).toBe('<ul class="md-ul"><li>甲</li><li>乙</li><li>丙</li></ul>')
  })

  it('项目符号换了（`-` 接 `*`）就是**另一个列表**——CommonMark 的口径，内容不丢', () => {
    // 旧的自研解析器把三种符号归成一个列表；CommonMark 按符号分段。
    // 功能点（每一行都是一条 li）不变，只是一分为二
    const markup = html(renderAnswerMarkdown('- 甲\n- 乙\n* 丙'))
    expect(markup.match(/<ul class="md-ul">/g)).toHaveLength(2)
    for (const item of ['甲', '乙', '丙']) expect(markup).toContain(`<li>${item}</li>`)
  })

  it('列表后接段落时正确断开', () => {
    const markup = html(renderAnswerMarkdown('- 甲\n\n总结：可行。'))
    expect(markup).toBe('<ul class="md-ul"><li>甲</li></ul><p class="md-p">总结：可行。</p>')
  })

  it('标题保留原始层级', () => {
    // 层级要留着：阅读视角里一份长文档全靠它区分结构。
    // 原先一律渲染成 h4，于是 119 块的长文从头到尾同一个字号。
    // h1 留给页面标题（文档名已在页头），所以从 `#` 起映射到 h2
    expect(html(renderAnswerMarkdown('# 一级'))).toBe('<h2 class="md-h md-h2">一级</h2>')
    expect(html(renderAnswerMarkdown('## 二级'))).toBe('<h3 class="md-h md-h3">二级</h3>')
    expect(html(renderAnswerMarkdown('### 三级'))).toBe('<h4 class="md-h md-h4">三级</h4>')
  })

  it('更深的层级并到 h4（实际语料里极罕见）', () => {
    expect(html(renderAnswerMarkdown('##### 五级'))).toBe('<h4 class="md-h md-h4">五级</h4>')
    expect(html(renderAnswerMarkdown('###### 六级'))).toBe('<h4 class="md-h md-h4">六级</h4>')
  })

  it('转义 HTML：模型吐出的尖括号不能变成标签', () => {
    const markup = html(renderAnswerMarkdown('<img src=x onerror="alert(1)">'))
    expect(markup).not.toContain('<img')
    expect(markup).toContain('&lt;img')
  })

  it('转义 script 与引号，`&` 只转一次', () => {
    const markup = html(renderAnswerMarkdown('<script>alert("x")</script> & <b>'))
    expect(markup).not.toContain('<script')
    expect(markup).not.toContain('<b>')
    expect(markup).toContain('&lt;script&gt;')
    expect(markup).toContain('&amp;')
    expect(markup).not.toContain('&amp;amp;')
  })

  it('加粗里的 HTML 同样被转义', () => {
    expect(html(renderAnswerMarkdown('**<b>x</b>**'))).toBe(
      '<p class="md-p"><strong>&lt;b&gt;x&lt;/b&gt;</strong></p>',
    )
  })

  it('流式中途的半截标记不吞掉后文', () => {
    // 增量切在 `**` 中间时，剩下的一颗星要原样显示，不能把后面全变粗体
    const markup = html(renderAnswerMarkdown('**监测'))
    expect(markup).toContain('**监测')
  })

  it('同文本重复渲染结果一致，不同文本不串味（渲染结果有缓存）', () => {
    // 模板里是逐条内联调用：一次重渲染会把所有历史消息都算一遍，
    // 所以按文本缓存了结果。缓存只允许"更快"，不允许改变输出。
    const source = '# 标题\n\n- 一\n- 二'
    const first = html(renderAnswerMarkdown(source))
    const again = html(renderAnswerMarkdown(source))
    const other = html(renderAnswerMarkdown('# 标题\n\n- 一\n- 三'))

    expect(again).toBe(first)
    expect(other).not.toBe(first)
    expect(other).toContain('三')
  })
})

describe('renderAnswerWithCitations', () => {
  const sources = [
    { index: 1, document_name: '指南.pdf', heading_path: '3 监测', page: 4 },
    { index: 2, document_name: '共识.md', heading_path: null, page: null },
  ]

  it('把 [N] 换成带 data-cite-index 的可点击徽标', () => {
    const markup = html(renderAnswerWithCitations('眼轴是主要参数[1]。', sources))

    expect(markup).toContain('class="md-cite"')
    expect(markup).toContain('data-cite-index="1"')
    expect(markup).toContain('role="button"')
    expect(markup).not.toContain('[1]')
  })

  it('徽标显示文档短名（去掉扩展名）而不是序号，省略交给 CSS', () => {
    const markup = html(renderAnswerWithCitations('眼轴是主要参数[1]。', sources))

    // 名字进内层 span：inline-flex 容器自己设 overflow 时省略号在部分浏览器不生效
    expect(markup).toContain('<span class="md-cite-name">指南</span>')
    expect(markup).not.toContain('指南.pdf</span>')
    // 完整名字仍在 title 里，悬停能看到
    expect(markup).toContain('title="指南.pdf · 3 监测 › 第 4 页"')
  })

  it('徽标的悬浮说明带文件名与页码，用户能预判点了会去哪', () => {
    const markup = html(renderAnswerWithCitations('见[1]', sources))

    expect(markup).toContain('title="指南.pdf · 3 监测 › 第 4 页"')
  })

  it('一次点一串的写法也照顾：`[1,2]` 拆成两个徽标', () => {
    const markup = html(renderAnswerWithCitations('两种资料[1,2]都提到', sources))

    expect(markup.match(/data-cite-index=/g)).toHaveLength(2)
  })

  it('找不到对应出处的编号原样留着——点了没反应的徽标比不换更糟', () => {
    const markup = html(renderAnswerWithCitations('凭空引用[7]', sources))

    expect(markup).toContain('[7]')
    expect(markup).not.toContain('data-cite-index')
  })

  it('`[1,9]` 里只要有一个对不上，整组都不换（换一半会把原意读歪）', () => {
    const markup = html(renderAnswerWithCitations('混合[1,9]', sources))

    expect(markup).toContain('[1,9]')
    expect(markup).not.toContain('data-cite-index')
  })

  it('没有出处时退回普通渲染，不无端加一堆徽标', () => {
    expect(html(renderAnswerWithCitations('眼轴[1]', []))).toBe(
      html(renderAnswerMarkdown('眼轴[1]')),
    )
  })

  it('模型写进 title 的引号/尖括号被转义，不能逃出属性', () => {
    const markup = html(
      renderAnswerWithCitations('见[1]', [
        { index: 1, document_name: 'a" onmouseover="alert(1)', heading_path: null, page: null },
      ]),
    )

    expect(markup).not.toContain('onmouseover="alert(1)"')
    expect(markup).toContain('&quot;')
  })

  it('同文本同出处重复渲染结果一致（引用渲染也有缓存）', () => {
    const first = html(renderAnswerWithCitations('眼轴[1]', sources))
    const again = html(renderAnswerWithCitations('眼轴[1]', sources))

    expect(again).toBe(first)
  })
})

describe('shortDocumentName（引用徽标上的短名）', () => {
  it('去掉常见扩展名，大小写不敏感', () => {
    expect(shortDocumentName('指南.pdf')).toBe('指南')
    expect(shortDocumentName('共识.MD')).toBe('共识')
    expect(shortDocumentName('数据.xlsx')).toBe('数据')
    expect(shortDocumentName('报告.docx')).toBe('报告')
    expect(shortDocumentName('幻灯片.PPTX')).toBe('幻灯片')
  })

  it('没有扩展名时原样保留（比如目录名或已去掉后缀的标题）', () => {
    expect(shortDocumentName('干眼共识')).toBe('干眼共识')
  })

  it('去掉目录前缀：整目录上传的批次号不该占掉徽标的开头', () => {
    expect(shortDocumentName('markdown_20260908-140833_110files/共识.md')).toBe('共识')
    expect(shortDocumentName('a\\b\\指南.pdf')).toBe('指南')
  })

  it('压平空白：换行/连续空格不该把徽标撑成两行', () => {
    expect(shortDocumentName('  中国干眼  临床\n共识  ')).toBe('中国干眼 临床 共识')
  })

  it('空名兜底成"文档"，不给一个空徽标', () => {
    expect(shortDocumentName('')).toBe('文档')
    expect(shortDocumentName('   ')).toBe('文档')
  })
})

describe('块级增强（v17）', () => {
  it('围栏代码块：内容原样保留，语言名在头部带里、不在代码里', () => {
    const markup = html(renderAnswerMarkdown('```python\nprint("hi")\n```'))

    // v0.25：语言名从 `<pre data-lang>` 挪到了头部带的一个 span 里
    // （原先用 `::before` 绝对定位在右上角，代码一长就从它底下穿过去）
    expect(markup).toContain('<span class="md-code-lang">python</span>')
    // 高亮（`rehype-highlight`）会给 `<code>` 挂上 `hljs language-python`
    expect(markup).toContain('<pre class="md-pre"><code class="hljs language-python">')
    // 内容原样在（被高亮切成 span 之后要看文本）
    expect(text(renderAnswerMarkdown('```python\nprint("hi")\n```'))).toBe('pythonprint("hi")')
    // 代码块内部不再做行内标记：`**` 与反引号在代码里就是字面量
    expect(markup).not.toContain('<strong>')
  })

  it('代码块带复制按钮；语言名在 `<pre>` **之外**，不会被复制进去', () => {
    const markup = html(renderAnswerMarkdown('```bash\nls -la\n```'))

    expect(markup).toContain('data-copy-code')
    expect(markup.indexOf('md-code-lang')).toBeLessThan(markup.indexOf('<pre'))
  })

  it('表格带复制与下载，且整体是一个有头部的块（圆角与描边才有地方挂）', () => {
    const markup = html(renderAnswerMarkdown('| A | B |\n| --- | --- |\n| 1 | 2 |'))

    expect(markup).toContain('md-table-block')
    expect(markup).toContain('data-copy-table')
    expect(markup).toContain('data-download-table')
    expect(markup).toContain('<span class="md-code-lang">表格</span>')
  })

  it('代码块里的 HTML 被转义（不能让模型用代码块注入标签）', () => {
    const markup = html(renderAnswerMarkdown('```\n<script>alert(1)</script>\n```'))

    expect(markup).not.toContain('<script')
    expect(markup).toContain('&lt;script&gt;')
  })

  it('流式中途没有闭合围栏也按代码块渲染', () => {
    // 否则代码会先以纯文本闪一下，再在闭合时"跳"成代码块
    const markup = html(renderAnswerMarkdown('```js\nconst a = 1'))

    expect(markup).toContain('<span class="md-code-lang">js</span>')
    expect(text(renderAnswerMarkdown('```js\nconst a = 1'))).toContain('const a = 1')
  })

  it('剥掉代码块前后的空行', () => {
    const markup = html(renderAnswerMarkdown('前文\n\n```\ncode\n```\n\n后文'))

    expect(markup).toContain('<p class="md-p">前文</p>')
    expect(markup).toContain('<p class="md-p">后文</p>')
  })

  it('有序列表与无序列表各自成块，不会混在一起', () => {
    const markup = html(renderAnswerMarkdown('1. 甲\n2. 乙\n\n- 丙'))

    expect(markup).toContain('<ol class="md-ol"><li>甲</li><li>乙</li></ol>')
    expect(markup).toContain('<ul class="md-ul"><li>丙</li></ul>')
  })

  it('引用块：连续的行合成一个 blockquote', () => {
    // **与旧实现的唯一结构差别**：remark 会把引用里的那段包进 `<p class="md-p">`，
    // 旧实现是直接铺 `第一行<br />第二行`。功能点（一个 blockquote、行内换行成 br）不变
    const markup = html(renderAnswerMarkdown('> 第一行\n> 第二行'))

    expect(markup).toContain('<blockquote class="md-quote"><p class="md-p">第一行<br />第二行</p>')
  })

  it('表格：表头 + 分隔行才认，并对齐列数', () => {
    const markup = html(renderAnswerMarkdown('| 年龄 | 参考值 |\n| --- | --- |\n| 6 岁 | 22.5mm |'))

    expect(markup).toContain('<table class="md-table">')
    expect(markup).toContain('<th>年龄</th>')
    expect(markup).toContain('<td>22.5mm</td>')
  })

  it('正文里孤零零的竖线不会被当表格切碎', () => {
    const markup = html(renderAnswerMarkdown('a | b 只是文字'))

    expect(markup).toContain('<p class="md-p">a | b 只是文字</p>')
    expect(markup).not.toContain('md-table')
  })

  it('分隔线渲染成 hr，且不与列表项混淆', () => {
    expect(html(renderAnswerMarkdown('---'))).toContain('<hr class="md-hr" />')
    expect(html(renderAnswerMarkdown('- 甲'))).toContain('<ul class="md-ul">')
  })

  it('链接只放行 http(s) 与 mailto', () => {
    expect(html(renderAnswerMarkdown('[看这个](https://example.com/a)'))).toContain(
      '<a class="md-link" href="https://example.com/a"',
    )
    // javascript: 是执行代码，必须原样留着（可读、不可点）
    const danger = html(renderAnswerMarkdown('[点我](javascript:alert(1))'))
    expect(danger).not.toContain('href')
    expect(danger).toContain('[点我]')
  })

  it('加粗里的链接仍能识别（先加粗会让链接语法被拆开）', () => {
    const markup = html(renderAnswerMarkdown('**[标题](https://example.com)**'))

    expect(markup).toContain('md-link')
    expect(markup).toContain('<strong>')
  })
})

describe('缓存分层（流式渲染的开销，v0.2）', () => {
  it('逐字流式追加：每一步都是该前缀的正确输出', () => {
    // 缓存的前提是"同内容必然同输出"。逐步断言把这个前提钉住——
    // 中途任何一步错了，都说明缓存复用了不该复用的东西。
    expect(html(renderAnswerMarkdown('# 标题'))).toBe('<h2 class="md-h md-h2">标题</h2>')
    expect(html(renderAnswerMarkdown('# 标题\n\n- 一'))).toBe(
      '<h2 class="md-h md-h2">标题</h2><ul class="md-ul"><li>一</li></ul>',
    )
    expect(html(renderAnswerMarkdown('# 标题\n\n- 一\n- 二'))).toBe(
      '<h2 class="md-h md-h2">标题</h2><ul class="md-ul"><li>一</li><li>二</li></ul>',
    )
  })

  it('块被别的文本喂过之后，各文本结果互不影响（块键不许串味）', () => {
    const first = html(renderAnswerMarkdown('甲\n\n乙\n\n- 丙'))
    // 前缀相同、尾块不同：缓存最容易在这里串味
    html(renderAnswerMarkdown('甲\n\n丁'))
    html(renderAnswerMarkdown('甲\n\n乙\n\n- 戊'))
    const again = html(renderAnswerMarkdown('甲\n\n乙\n\n- 丙'))

    expect(again).toBe(first)
    expect(again).toContain('丙')
    expect(again).not.toContain('戊')
  })

  it('文本级缓存被挤掉之后重建，结果仍与首次完全一致', () => {
    // 上限是 300：灌满把目标挤出去，逼下一次渲染重走一遍解析。
    // 淘汰写错（或键串味）都会让这一条红。
    const target = '甲\n\n乙\n\n| 列 | 值 |\n| --- | --- |\n| 1 | 2 |\n\n```js\nconst a = 1\n```'
    const first = html(renderAnswerMarkdown(target))
    for (let i = 0; i < 400; i += 1) html(renderAnswerMarkdown(`噪声 ${i}\n\n第二段 ${i}`))

    expect(html(renderAnswerMarkdown(target))).toBe(first)
  })
})

describe('引用徽标不碰代码（v17）', () => {
  const sources = [{ index: 1, document_name: '指南.pdf', heading_path: null, page: null }]

  it('行内代码里的 [1] 保持原样', () => {
    const markup = html(renderAnswerWithCitations('用 `arr[1]` 取第二项，依据见 [1]', sources))

    expect(markup).toContain('arr[1]')
    // 代码之外的那个才变成徽标
    expect(markup.match(/data-cite-index/g)).toHaveLength(1)
  })

  it('代码块里的 [1] 不会被换成徽标（改坏代码 + 误导读者）', () => {
    const markup = html(
      renderAnswerWithCitations('示例：\n\n```python\nx = a[1]\n```\n\n见 [1]', sources),
    )

    // 高亮把 `a[1]` 切成了 span，所以内容走文本断言
    expect(
      text(renderAnswerWithCitations('示例：\n\n```python\nx = a[1]\n```\n\n见 [1]', sources)),
    ).toContain('a[1]')
    expect(markup.match(/data-cite-index/g)).toHaveLength(1)
  })
})

describe('正文里的裸链接（v0.26）', () => {
  it('直接写在正文里的网址变成可点的链接', () => {
    // 模型常这么写：Markdown 的 `[文字](链接)` 只有它主动写才有，其余只能手抄
    const markup = html(
      renderAnswerMarkdown('来源：https://www.cnblogs.com/amap_tech/p/17533047.html'),
    )

    expect(markup).toContain('class="md-link"')
    expect(markup).toContain('href="https://www.cnblogs.com/amap_tech/p/17533047.html"')
    expect(markup).toContain('target="_blank"')
    expect(markup).toContain('rel="noopener noreferrer"')
  })

  it('句子末尾的句号、逗号、中文标点**不属于网址**', () => {
    // 不剥的话链接点开就是 404，而用户完全看不出为什么
    const markup = html(
      renderAnswerMarkdown('详见 https://example.com/a。另外 https://example.com/b, 也在。'),
    )

    expect(markup).toContain('href="https://example.com/a"')
    expect(markup).not.toContain('href="https://example.com/a。"')
    expect(markup).toContain('href="https://example.com/b"')
    // 剥下来的句号还在正文里，只是不在链接里
    expect(markup).toContain('>。')
  })

  it('`www.` 开头补上协议：不带协议的 href 会被当成站内相对路径', () => {
    const markup = html(renderAnswerMarkdown('看 www.example.com/x'))

    expect(markup).toContain('href="https://www.example.com/x"')
    // 显示的还是原样那一段，不凭空多出一个 https://
    expect(markup).toContain('>www.example.com/x</a>')
  })

  it('代码段里的网址**保持字面量**：那是代码，点了就跑偏了', () => {
    const markup = html(renderAnswerMarkdown('用 `curl https://api.example.com/v1` 调它'))

    expect(markup).toContain('<code>curl https://api.example.com/v1</code>')
    expect(markup).not.toContain('md-link')
  })

  it('已经写好的 Markdown 链接不会被再包一层（那会把 href 撕开）', () => {
    const markup = html(renderAnswerMarkdown('[文档](https://example.com/doc)'))

    expect(markup.match(/<a /g)).toHaveLength(1)
    expect(markup).toContain('>文档</a>')
  })

  it('javascript: 之类的伪协议不会因为"像网址"而被放行', () => {
    // 裸链接只认 http(s):// 与 www. 开头，所以这条本来就是安全的；
    // 这条用例钉的是**别哪天为了"更聪明"把它放宽**
    const markup = html(renderAnswerMarkdown('点 javascript:alert(1) 试试'))

    expect(markup).not.toContain('<a ')
  })

  it('邮箱不猜（GFM 自己那套 autolink 也挡掉）：me@example.com 保持纯文本', () => {
    // 旧实现只认 `http(s)://` 与 `www.` 开头——**不猜邮箱、不猜裸域名**。
    // remark-gfm 的 autolink literal 会顺手把邮箱链成 mailto，所以
    // `rehypeUnwrapLinks` 先把解析器猜出来的链接退回原文，再由旧正则重新成链
    const markup = html(renderAnswerMarkdown('联系 me@example.com 或看 README.md'))

    expect(markup).not.toContain('mailto')
    expect(markup).not.toContain('md-link')
    expect(markup).toContain('me@example.com')
    expect(markup).toContain('README.md')
  })
})

describe('裁断的网址不给链接（v0.26）', () => {
  it('拖着省略号的网址保持纯文本：点过去是个不存在的地址', () => {
    // 工具结果那一行由后端裁到 120 字，一条长结果里的网址大多只剩半截。
    // 做成链接比不给链接更糟——用户会以为是自己网络的问题。
    const markup = html(renderAnswerMarkdown('来源：https://www.cnblogs.com/amap_tech/p/175330…'))

    expect(markup).not.toContain('md-link')
    expect(markup).toContain('https://www.cnblogs.com/amap_tech/p/175330…')
  })

  it('两种结尾分得开：句号是句法的（剥掉照链），省略号是裁断的（不链）', () => {
    const markup = html(
      renderAnswerMarkdown('见 https://example.com/a。再看 https://example.com/b…'),
    )

    expect(markup).toContain('href="https://example.com/a"')
    expect(markup).not.toContain('href="https://example.com/b"')
    expect(markup).toContain('https://example.com/b…')
  })
})

/* ------------------------------------------------- P1 新增：组件形态与动作 */

describe('<Answer>：组件形态（P1）', () => {
  const sources: CitationSource[] = [
    { index: 1, document_name: '指南.pdf', heading_path: null, page: null },
  ]

  it('点了行内徽标回调的是它的编号（旧的委托接法仍然能用）', () => {
    const onOpenSource = vi.fn()
    const { container } = render(createElement(Answer, { text: '见[1]', sources, onOpenSource }))

    fireEvent.click(container.querySelector('[data-cite-index="1"]')!)
    expect(onOpenSource).toHaveBeenCalledWith(1)
  })

  it('键盘也能开（徽标是 role=button，Enter / 空格都要能用）', () => {
    const onOpenSource = vi.fn()
    const { container } = render(createElement(Answer, { text: '见[1]', sources, onOpenSource }))

    fireEvent.keyDown(container.querySelector('[data-cite-index="1"]')!, { key: 'Enter' })
    expect(onOpenSource).toHaveBeenCalledWith(1)
  })

  it('没给回调时徽标是**纯标记**：data-cite-index 在、点击不冒泡出事', () => {
    // 页面沿旧做法在容器上监听 `[data-cite-index]` 时，这一块一个字节都不受影响
    const { container } = render(createElement(Answer, { text: '见[1]', sources }))

    expect(container.querySelector('[data-cite-index="1"]')).not.toBeNull()
    fireEvent.click(container.querySelector('[data-cite-index="1"]')!)
  })

  it('复制代码给的是**代码原文**：没有语言名、也没有高亮补的那个收尾换行', () => {
    const onCopyCode = vi.fn()
    const { container } = render(
      createElement(Answer, { text: '```python\nprint("hi")\n```', onCopyCode }),
    )

    fireEvent.click(container.querySelector('[data-copy-code]')!)
    // 与旧实现同一个口径：`body.join('\n')` 出来的是逐行拼的那份，不带收尾空行
    expect(onCopyCode).toHaveBeenCalledWith('print("hi")')
  })

  it('复制表格给的是制表符分隔的正文（粘进表格会被拆成单元格）', () => {
    const onCopyTable = vi.fn()
    const { container } = render(
      createElement(Answer, { text: '| A | B |\n| --- | --- |\n| 1 | 2 |', onCopyTable }),
    )

    fireEvent.click(container.querySelector('[data-copy-table]')!)
    expect(onCopyTable).toHaveBeenCalledWith('A\tB\n1\t2')
  })

  it('下载表格给的是表头与各行（CSV / 文件名归页面那一层）', () => {
    const onDownloadTable = vi.fn()
    const { container } = render(
      createElement(Answer, { text: '| A | B |\n| --- | --- |\n| 1 | 2 |', onDownloadTable }),
    )

    fireEvent.click(container.querySelector('[data-download-table]')!)
    expect(onDownloadTable).toHaveBeenCalledWith({ header: ['A', 'B'], rows: [['1', '2']] })
  })

  it('`className` 给了才包一层容器：没给就是 Fragment（不许凭空多一层）', () => {
    const { container: bare } = render(createElement(Answer, { text: '一句' }))
    expect(bare.innerHTML).toBe('<p class="md-p">一句</p>')

    const { container: wrapped } = render(
      createElement(Answer, { text: '一句', className: 'reply-text' }),
    )
    expect(wrapped.innerHTML).toBe('<div class="reply-text"><p class="md-p">一句</p></div>')
  })

  it('空文本什么都不渲染（旧实现返回空串）', () => {
    const { container } = render(createElement(Answer, { text: '' }))
    expect(container.innerHTML).toBe('')
  })

  it('同一段文本给两个调用方：各拿各的回调（渲染缓存不许串味）', () => {
    // 缓存的是"文本 → 元素"，回调走 Context——这条钉住"缓存与回调无关"这件事：
    // 缓存若把回调也焊进去，第二个调用方点出来的就是第一个的函数（实测最容易踩的那种）
    const first = vi.fn()
    const second = vi.fn()
    const a = render(createElement(Answer, { text: '见[1]', sources, onOpenSource: first }))
    fireEvent.click(a.container.querySelector('[data-cite-index="1"]')!)
    const b = render(createElement(Answer, { text: '见[1]', sources, onOpenSource: second }))
    fireEvent.click(b.container.querySelector('[data-cite-index="1"]')!)

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })
})

describe('只读渲染（文件预览）与数学（P1）', () => {
  it('`renderPlainMarkdown` 不挂复制 / 下载按钮（预览是"看"，不是"操作"）', () => {
    const markup = html(renderPlainMarkdown('```js\nconst a = 1\n```\n\n| A |\n| --- |\n| 1 |'))

    expect(markup).toContain('md-pre')
    expect(markup).toContain('md-table')
    expect(markup).not.toContain('data-copy-code')
    expect(markup).not.toContain('data-copy-table')
    expect(markup).not.toContain('data-download-table')
  })

  it('认得出的 `$…$` 交给 KaTeX 排版（rehype-katex）', () => {
    const markup = html(renderAnswerMarkdown('当 $x^{2}$ 时'))

    expect(markup).toContain('class="katex"')
    expect(markup).not.toContain('$x^{2}$')
  })

  it('整式 `$$…$$`：**围栏自成一行**才是块级排版（标准口径的 display 判据）', () => {
    // 口径变了（remark-math 标准口径，差异表见 `model/README.md`）：display 不是
    // "看到 `$$` 就是了"，而是"`$$` 自成一行"（GitHub 的写法）——单行写成
    // `$$ … $$` 时它只是**行内**公式。旧的自写插件按"`$$` 配对"直接给 math-display，
    // 于是单行 `$$…$$` 也会整块居中
    const display = html(renderAnswerMarkdown('推导\n\n$$\n\\frac{1}{2}\n$$\n\n结束'))
    expect(display).toContain('katex-display')

    const inline = html(renderAnswerMarkdown('推导 $$\\frac{1}{2}$$ 结束'))
    expect(inline).toContain('class="katex"')
    expect(inline).not.toContain('katex-display')
  })

  it('价格那种写法**不排**：收尾 `$` 前是空格，按 GitHub 口径不是公式', () => {
    // 这条原来钉的是"标准口径的代价：价格会被排成公式"。补上边界规则之后不再如此：
    // `$5 到 $10` 的收尾 `$` 前是空格，而 GitHub 的实现要求 `$` 紧挨内容
    // （`rehypeMathSpacing`，见 `markdown.tsx` 里那个插件的注释与 `model/README.md`）。
    const markup = html(renderAnswerMarkdown('价格从 $5 到 $10 不等'))

    expect(markup).not.toContain('katex')
    expect(markup).toContain('价格从 $5 到 $10 不等')
  })

  it('转义过的美元号仍是字面量：`\\$5` 不是公式（价格这样写就安全）', () => {
    const markup = html(renderAnswerMarkdown('价格从 \\$5 到 \\$10 不等'))

    expect(markup).toContain('价格从 $5 到 $10 不等')
    expect(markup).not.toContain('katex')
  })

  it('只有转义符的公式也认（`$52.7\\%$`）——旧口径下这一类认不出来', () => {
    // 旧口径的已知边界：Markdown 解析阶段先把 `\%` 还原成 `%`，到 rehype 那一步
    // 就看不出它是公式了，于是连 `$` 一起留在正文里。标准路线在**解析期**就认公式、
    // 把原文（含 `\%`）原样交给 KaTeX，所以这一类现在正常排版（差异表见 `model/README.md`）
    const markup = html(renderAnswerMarkdown('占比 $52.7\\%$ 左右'))

    expect(markup).toContain('class="katex"')
    expect(markup).toContain('左右')
  })

  it('代码块里的 `$` 不动：那是字面量，不是公式', () => {
    const markup = html(renderAnswerMarkdown('```bash\necho $HOME\n```'))

    expect(text(renderAnswerMarkdown('```bash\necho $HOME\n```'))).toContain('echo $HOME')
    expect(markup).not.toContain('katex')
  })

  it('一条真实的回答：标题 / 列表 / 代码 / 表格 / 引用 / 公式 / 裸链接一起过', () => {
    // 上线的形态长这样：一条回答里同时有这些东西。这里钉的是**整条流水线不打架**
    // （几条文本级规则的顺序、KaTeX 最后跑、代码与公式互不干扰）
    const answer = [
      '## 结论[1]',
      '',
      '- 眼轴是关键指标，见 https://example.com/axis。',
      '- 公式 $x^{2}$ 与 `arr[1]`',
      '',
      '| 年龄 | 参考值 |',
      '| --- | --- |',
      '| 6 岁 | 22.5mm[2] |',
      '',
      '> 资料中没有找到。',
      '',
      '```python',
      'print("$1")',
      '```',
    ].join('\n')
    const markup = html(
      renderAnswerWithCitations(answer, [
        { index: 1, document_name: '指南.pdf', heading_path: null, page: null },
        { index: 2, document_name: '共识.md', heading_path: '3 监测', page: 4 },
      ]),
    )

    expect(markup).toContain('<h3 class="md-h md-h3">')
    expect(markup).toContain('<li>')
    expect(markup).toContain('md-link') // 裸链接
    expect(markup).toContain('class="katex"') // 公式
    expect(markup).toContain('md-table-block') // 表格
    expect(markup).toContain('md-quote') // 引用
    expect(markup).toContain('md-code') // 代码块
    // 两个出处各成徽标：正文一处、表格单元里一处
    expect(markup.match(/data-cite-index=/g)).toHaveLength(2)
    // 代码里的 `arr[1]` / `$1` 一个都没被改
    expect(text(renderAnswerMarkdown('```python\nprint("$1")\n```'))).toContain('print("$1")')
  })
})

describe('行内公式的边界（GitHub 口径：`$` 与内容之间不留空格）', () => {
  // 这一节的由来：换标准路线（remark-math）之后，"价格区间"会被整段排成公式。
  // 补的这条边界是**主流口径**（GitHub 的实现要求 `$` 紧挨内容），
  // 于是 `$x$` 照排、`$5 到 $10` 与 `$ x $` 退回普通文本。
  it('紧挨内容的 `$x$` 照排', () => {
    const out = html(renderAnswerMarkdown('眼轴 $24\mathrm{mm}$ 上下。'))

    expect(out).toContain('katex')
    expect(out).not.toContain('$24')
  })

  it('`$5 到 $10` 不排：退回原文，一个字符都不改', () => {
    const out = html(renderAnswerMarkdown('价格在 $5 到 $10 之间。'))

    expect(out).not.toContain('katex')
    expect(out).toContain('$5 到 $10')
  })

  it('**已知边界**：`$ x $`（两侧留空）仍会被排——左侧那个空格在解析期就被去掉了', () => {
    // 试过判它：`remark-math` 在 mdast 里把公式体去了首尾空白，转换到 hast 之后
    // 左边的空格已经不可考（右边那个还在），所以"左侧留空"这条判不出来。
    // 它与 GitHub 的口径差一处，但形状罕见（要字面量就写 `\$`），不值得为它再上一层扫描。
    const out = html(renderAnswerMarkdown('这样写 $ x + y $ 不算公式。'))

    expect(out).toContain('katex')
    expect(out).toContain('不算公式。')
  })

  it('只带转义符的 `$52.7\%$` 照排（旧口径反而认不出来）', () => {
    const out = html(renderAnswerMarkdown('占比 $52.7\%$ 上下。'))

    expect(out).toContain('katex')
  })
})
