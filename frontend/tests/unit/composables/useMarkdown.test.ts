import { describe, expect, it } from 'vitest'

import { renderAnswerMarkdown } from '@/composables/useMarkdown'

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
})
