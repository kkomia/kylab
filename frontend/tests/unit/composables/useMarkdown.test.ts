import { describe, expect, it } from 'vitest'

import {
  renderAnswerMarkdown,
  renderAnswerWithCitations,
  shortDocumentName,
} from '@/composables/useMarkdown'

describe('renderAnswerMarkdown', () => {
  it('空文本不产出任何标签', () => {
    expect(renderAnswerMarkdown('')).toBe('')
  })

  it('普通段落原样保留', () => {
    expect(renderAnswerMarkdown('眼轴长度是主要参数。')).toBe(
      '<p class="md-p">眼轴长度是主要参数。</p>',
    )
  })

  it('段落内的换行折成 br，而不是各起一段', () => {
    expect(renderAnswerMarkdown('第一行\n第二行')).toBe('<p class="md-p">第一行<br />第二行</p>')
  })

  it('空行分段', () => {
    expect(renderAnswerMarkdown('甲\n\n乙')).toBe('<p class="md-p">甲</p><p class="md-p">乙</p>')
  })

  it('加粗与行内代码', () => {
    expect(renderAnswerMarkdown('**监测意义**：见 `AL`')).toBe(
      '<p class="md-p"><strong>监测意义</strong>：见 <code>AL</code></p>',
    )
  })

  it('无序列表：连着的项目合成一个 ul', () => {
    const html = renderAnswerMarkdown('- 甲\n- 乙\n* 丙')
    expect(html).toBe('<ul class="md-ul"><li>甲</li><li>乙</li><li>丙</li></ul>')
  })

  it('列表后接段落时正确断开', () => {
    const html = renderAnswerMarkdown('- 甲\n\n总结：可行。')
    expect(html).toBe('<ul class="md-ul"><li>甲</li></ul><p class="md-p">总结：可行。</p>')
  })

  it('标题保留原始层级', () => {
    // 层级要留着：阅读视角里一份长文档全靠它区分结构。
    // 原先一律渲染成 h4，于是 119 块的长文从头到尾同一个字号。
    // h1 留给页面标题（文档名已在页头），所以从 `#` 起映射到 h2
    expect(renderAnswerMarkdown('# 一级')).toBe('<h2 class="md-h md-h2">一级</h2>')
    expect(renderAnswerMarkdown('## 二级')).toBe('<h3 class="md-h md-h3">二级</h3>')
    expect(renderAnswerMarkdown('### 三级')).toBe('<h4 class="md-h md-h4">三级</h4>')
  })

  it('更深的层级并到 h4（实际语料里极罕见）', () => {
    expect(renderAnswerMarkdown('##### 五级')).toBe('<h4 class="md-h md-h4">五级</h4>')
    expect(renderAnswerMarkdown('###### 六级')).toBe('<h4 class="md-h md-h4">六级</h4>')
  })

  it('转义 HTML：模型吐出的尖括号不能变成标签', () => {
    const html = renderAnswerMarkdown('<img src=x onerror="alert(1)">')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  it('转义 script 与引号，`&` 只转一次', () => {
    const html = renderAnswerMarkdown('<script>alert("x")</script> & <b>')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<b>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&amp;')
    expect(html).not.toContain('&amp;amp;')
  })

  it('加粗里的 HTML 同样被转义', () => {
    expect(renderAnswerMarkdown('**<b>x</b>**')).toBe(
      '<p class="md-p"><strong>&lt;b&gt;x&lt;/b&gt;</strong></p>',
    )
  })

  it('流式中途的半截标记不吞掉后文', () => {
    // 增量切在 `**` 中间时，剩下的一颗星要原样显示，不能把后面全变粗体
    const html = renderAnswerMarkdown('**监测')
    expect(html).toContain('**监测')
  })
  it('同文本重复渲染结果一致，不同文本不串味（渲染结果有缓存）', () => {
    // 模板里是逐条内联调用：一次重渲染会把所有历史消息都算一遍，
    // 所以按文本缓存了结果。缓存只允许"更快"，不允许改变输出。
    const source = '# 标题\n\n- 一\n- 二'
    const first = renderAnswerMarkdown(source)
    const again = renderAnswerMarkdown(source)
    const other = renderAnswerMarkdown('# 标题\n\n- 一\n- 三')

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
    const html = renderAnswerWithCitations('眼轴是主要参数[1]。', sources)

    expect(html).toContain('class="md-cite"')
    expect(html).toContain('data-cite-index="1"')
    expect(html).toContain('role="button"')
    expect(html).not.toContain('[1]')
  })

  it('徽标显示文档短名（去掉扩展名）而不是序号，省略交给 CSS', () => {
    const html = renderAnswerWithCitations('眼轴是主要参数[1]。', sources)

    // 名字进内层 span：inline-flex 容器自己设 overflow 时省略号在部分浏览器不生效
    expect(html).toContain('<span class="md-cite-name">指南</span>')
    expect(html).not.toContain('指南.pdf</span>')
    // 完整名字仍在 title 里，悬停能看到
    expect(html).toContain('title="指南.pdf · 3 监测 › 第 4 页"')
  })

  it('徽标的悬浮说明带文件名与页码，用户能预判点了会去哪', () => {
    const html = renderAnswerWithCitations('见[1]', sources)

    expect(html).toContain('title="指南.pdf · 3 监测 › 第 4 页"')
  })

  it('一次点一串的写法也照顾：`[1,2]` 拆成两个徽标', () => {
    const html = renderAnswerWithCitations('两种资料[1,2]都提到', sources)

    expect(html.match(/data-cite-index=/g)).toHaveLength(2)
  })

  it('找不到对应出处的编号原样留着——点了没反应的徽标比不换更糟', () => {
    const html = renderAnswerWithCitations('凭空引用[7]', sources)

    expect(html).toContain('[7]')
    expect(html).not.toContain('data-cite-index')
  })

  it('`[1,9]` 里只要有一个对不上，整组都不换（换一半会把原意读歪）', () => {
    const html = renderAnswerWithCitations('混合[1,9]', sources)

    expect(html).toContain('[1,9]')
    expect(html).not.toContain('data-cite-index')
  })

  it('没有出处时退回普通渲染，不无端加一堆徽标', () => {
    expect(renderAnswerWithCitations('眼轴[1]', [])).toBe(renderAnswerMarkdown('眼轴[1]'))
  })

  it('模型写进 title 的引号/尖括号被转义，不能逃出属性', () => {
    const html = renderAnswerWithCitations('见[1]', [
      { index: 1, document_name: 'a" onmouseover="alert(1)', heading_path: null, page: null },
    ])

    expect(html).not.toContain('onmouseover="alert(1)"')
    expect(html).toContain('&quot;')
  })

  it('同文本同出处重复渲染结果一致（引用渲染也有缓存）', () => {
    const first = renderAnswerWithCitations('眼轴[1]', sources)
    const again = renderAnswerWithCitations('眼轴[1]', sources)

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

  it('压平空白：换行/连续空格不该把徽标撑成两行', () => {
    expect(shortDocumentName('  中国干眼  临床\n共识  ')).toBe('中国干眼 临床 共识')
  })

  it('空名兜底成"文档"，不给一个空徽标', () => {
    expect(shortDocumentName('')).toBe('文档')
    expect(shortDocumentName('   ')).toBe('文档')
  })
})

describe('块级增强（v17）', () => {
  it('围栏代码块：内容原样保留，语言名进 data-lang', () => {
    const html = renderAnswerMarkdown('```python\nprint("hi")\n```')

    expect(html).toContain('<pre class="md-pre" data-lang="python">')
    expect(html).toContain('print(&quot;hi&quot;)')
    // 代码块内部不再做行内标记：`**` 与反引号在代码里就是字面量
    expect(html).not.toContain('<strong>')
  })

  it('代码块里的 HTML 被转义（不能让模型用代码块注入标签）', () => {
    const html = renderAnswerMarkdown('```\n<script>alert(1)</script>\n```')

    expect(html).not.toContain('<script')
    expect(html).toContain('&lt;script&gt;')
  })

  it('流式中途没有闭合围栏也按代码块渲染', () => {
    // 否则代码会先以纯文本闪一下，再在闭合时"跳"成代码块
    const html = renderAnswerMarkdown('```js\nconst a = 1')

    expect(html).toContain('<pre class="md-pre" data-lang="js">')
    expect(html).toContain('const a = 1')
  })

  it('剥掉代码块前后的空行', () => {
    const html = renderAnswerMarkdown('前文\n\n```\ncode\n```\n\n后文')

    expect(html).toContain('<p class="md-p">前文</p>')
    expect(html).toContain('<p class="md-p">后文</p>')
  })

  it('有序列表与无序列表各自成块，不会混在一起', () => {
    const html = renderAnswerMarkdown('1. 甲\n2. 乙\n\n- 丙')

    expect(html).toContain('<ol class="md-ol"><li>甲</li><li>乙</li></ol>')
    expect(html).toContain('<ul class="md-ul"><li>丙</li></ul>')
  })

  it('引用块：连续的行合成一个 blockquote', () => {
    const html = renderAnswerMarkdown('> 第一行\n> 第二行')

    expect(html).toBe('<blockquote class="md-quote">第一行<br />第二行</blockquote>')
  })

  it('表格：表头 + 分隔行才认，并对齐列数', () => {
    const html = renderAnswerMarkdown('| 年龄 | 参考值 |\n| --- | --- |\n| 6 岁 | 22.5mm |')

    expect(html).toContain('<table class="md-table">')
    expect(html).toContain('<th>年龄</th>')
    expect(html).toContain('<td>22.5mm</td>')
  })

  it('正文里孤零零的竖线不会被当表格切碎', () => {
    const html = renderAnswerMarkdown('a | b 只是文字')

    expect(html).toContain('<p class="md-p">a | b 只是文字</p>')
    expect(html).not.toContain('md-table')
  })

  it('分隔线渲染成 hr，且不与列表项混淆', () => {
    expect(renderAnswerMarkdown('---')).toContain('<hr class="md-hr" />')
    expect(renderAnswerMarkdown('- 甲')).toContain('<ul class="md-ul">')
  })

  it('链接只放行 http(s) 与 mailto', () => {
    expect(renderAnswerMarkdown('[看这个](https://example.com/a)')).toContain(
      '<a class="md-link" href="https://example.com/a"',
    )
    // javascript: 是执行代码，必须原样留着（可读、不可点）
    const danger = renderAnswerMarkdown('[点我](javascript:alert(1))')
    expect(danger).not.toContain('href')
    expect(danger).toContain('[点我]')
  })

  it('加粗里的链接仍能识别（先加粗会让链接语法被拆开）', () => {
    const html = renderAnswerMarkdown('**[标题](https://example.com)**')

    expect(html).toContain('md-link')
    expect(html).toContain('<strong>')
  })
})

describe('引用徽标不碰代码（v17）', () => {
  const sources = [{ index: 1, document_name: '指南.pdf', heading_path: null, page: null }]

  it('行内代码里的 [1] 保持原样', () => {
    const html = renderAnswerWithCitations('用 `arr[1]` 取第二项，依据见 [1]', sources)

    expect(html).toContain('arr[1]')
    // 代码之外的那个才变成徽标
    expect(html.match(/data-cite-index/g)).toHaveLength(1)
  })

  it('代码块里的 [1] 不会被换成徽标（改坏代码 + 误导读者）', () => {
    const html = renderAnswerWithCitations('示例：\n\n```python\nx = a[1]\n```\n\n见 [1]', sources)

    expect(html).toContain('a[1]')
    expect(html.match(/data-cite-index/g)).toHaveLength(1)
  })
})
