import { describe, expect, it } from 'vitest'

import { renderAnswerMarkdown, renderAnswerWithCitations } from '@/composables/useMarkdown'

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
