/**
 * 工具返回**按类型分派**渲染（调研 §5.2 P2：MaxKB 的 `kw[content.type]`、
 * WeKnora 的 `displayType`、Coze 的 `enhancedContentConfigList.rule` —— 三家共有）。
 *
 * 两组用例，缺一组就会漏掉一半：
 *
 * 1. **纯判据**（`model/resultDisplay.ts`）：JSON / Markdown 表格 / 其余三档怎么分，
 *    以及**半截的**（后端把返回裁到 2000 字、界面上还可能只给 600 字预览）为什么必须
 *    落回第三档——解析失败、列数对不上、只剩表头，一律退回等宽 `<pre>`，不抛、不猜；
 * 2. **接线**（`TraceStepRow` → `StepResult`）：三档真的画出来了，而且**旧行为一条没丢**——
 *    220px 限高、`data-result` 如实报档、原文一个字不改、网址照样点得到、
 *    预览态的「仅预览 x/y 字」与「加载全部」照旧在。
 *
 * 为什么第二条要渲染真组件：D19 的教训是"只测纯函数，把那一行删掉也不会红"。
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { TraceStep } from '@/features/chat/model/turns'
import { displayType, parseJsonResult, parseTableResult } from '@/features/chat/model/resultDisplay'
import { TraceStepRow } from '@/features/chat/ui/TraceStepRow'

describe('displayType：三档的判据（纯函数）', () => {
  it('对象 / 数组走 JSON 那一档', () => {
    expect(displayType('{"name": "报告.pdf"}')).toBe('json')
    expect(displayType('[1, 2, 3]')).toBe('json')
    expect(displayType('  \n {"a": {"b": 1}}  ')).toBe('json')
  })

  it('Markdown 表格那一档：表头 + 分隔行 + 数据行', () => {
    expect(displayType('| 名称 | 页数 |\n| --- | --- |\n| 报告.pdf | 3 |')).toBe('table')
    expect(displayType('| a | b |\n|:--|--:|\n| 1 | 2 |\n| 3 | 4 |')).toBe('table')
  })

  it('其余一律第三档（网页正文、日志、代码片段）', () => {
    expect(displayType('没有搜到结果')).toBe('text')
    expect(displayType('检索词：agent skills，共 3 条：\n[1] 标题\nhttps://github.com/a')).toBe(
      'text',
    )
    expect(displayType('')).toBe('text')
  })

  it('**标量不是 JSON 那一档**：缩进排版对它们没有意义（同一行字的画法不许随内容乱跳）', () => {
    expect(displayType('"一句话"')).toBe('text')
    expect(displayType('12')).toBe('text')
    expect(displayType('true')).toBe('text')
    expect(displayType('null')).toBe('text')
    expect(parseJsonResult('12')).toBeNull()
  })

  it('JSON 那一档给的是**缩进排版好**的文本', () => {
    expect(parseJsonResult('{"a":1,"b":[1,2]}')).toBe(
      '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}',
    )
  })
})

describe('半截的返回必须安全退回第三档（不抛、不猜）', () => {
  /*
   * 这一节钉的是那条前提：**返回是发到界面时被截过的字符串**
   * （后端 `MAX_STEP_PREVIEW_CHARS = 2000`，界面上预览态只给 600）。
   * 截断点常落在用户要的那一段之前，于是"半截"是常态而不是异常路径。
   */
  it('半截 JSON：解析不了 → 第三档（`null`，不抛）', () => {
    expect(parseJsonResult('{"a": 1, "b": [1, 2')).toBeNull()
    expect(parseJsonResult('["a", "b')).toBeNull()
    expect(displayType('{"a": 1, "b": [1, 2')).toBe('text')
    // 开头像 JSON、内容却是别的东西，也不认
    expect(displayType('{未完成')).toBe('text')
  })

  it('半截表格：最后一行没有收尾竖线 → 第三档', () => {
    expect(parseTableResult('| 名称 | 页数 |\n| --- | --- |\n| 报告.pdf | 3')).toBeNull()
    expect(displayType('| 名称 | 页数 |\n| --- | --- |\n| 报告.pdf | 3')).toBe('text')
  })

  it('只剩表头（还没写到数据行就断了）→ 第三档：一张空表比原文更难读', () => {
    expect(displayType('| 名称 | 页数 |\n| --- | --- |')).toBe('text')
    expect(displayType('| 名称 | 页数 |\n| --- | --- |\n')).toBe('text')
  })

  it('列数与表头对不上 → 第三档（半截的那一行正是这样）', () => {
    expect(displayType('| a | b |\n| --- | --- |\n| 1 |')).toBe('text')
    expect(displayType('| a | b |\n| --- | --- |\n| 1 | 2 | 3 |')).toBe('text')
  })

  it('第二行不是分隔行 → 第三档（那可能就是一段用竖线写的正文）', () => {
    expect(displayType('| a | b |\n| 1 | 2 |')).toBe('text')
    // 只有一列也说不上是表
    expect(displayType('| a |\n| --- |\n| 1 |')).toBe('text')
  })

  it('一整段里夹着一张表 → 第三档：这一档只认"整段就是一张表"', () => {
    expect(displayType('结果如下：\n| a | b |\n| --- | --- |\n| 1 | 2 |')).toBe('text')
  })
})

/** 一行"读文件"，返回由用例给（`args` 留空，好让断言只看返回那一块）。 */
function step(result: string): TraceStep {
  return { key: 'tool-0', icon: 'read', label: '读文件', detail: '读了 20 行', result }
}

function renderResult(result: string) {
  const { container } = render(<TraceStepRow step={step(result)} open onToggle={vi.fn()} />)
  return container
}

/** 原文那一块共同的取舍：**220px 限高**（换的是排版，不是"看一眼就好"这件事）。 */
function expectCapped(element: Element | null): void {
  expect(element).not.toBeNull()
  expect(element?.className).toContain('max-h-[220px]')
  expect(element?.className).toContain('overflow-auto')
}

describe('接线：三档真的画出来了，而且旧行为一条没丢', () => {
  it('JSON → 缩进排版 + 等宽，并如实报 data-result="json"', () => {
    const container = renderResult('{"name":"报告.pdf","pages":3}')

    const json = container.querySelector('[data-result="json"]')
    expectCapped(json)
    expect(json?.tagName).toBe('PRE')
    // 缩进真的排了（原文那一坨没有换行）
    expect(json?.textContent).toContain('"name": "报告.pdf"')
    expect(json?.textContent).toContain('\n')
    // 标签那一行照旧（"这一段是原文"）
    expect(screen.getByText('返回')).toBeInTheDocument()
  })

  it('Markdown 表格 → 真表格：表头进 th[scope=col]，单元格按列排', () => {
    const container = renderResult(
      [
        '| 站点 | 链接 |',
        '| --- | --- |',
        '| GitHub | https://github.com/a |',
        '| arXiv | https://arxiv.org/b |',
      ].join('\n'),
    )

    const wrap = container.querySelector('[data-result="table"]')
    expectCapped(wrap)
    const table = within(wrap as HTMLElement).getByRole('table')
    const heads = within(table).getAllByRole('columnheader')
    expect(heads.map((cell) => cell.textContent)).toEqual(['站点', '链接'])
    expect(heads[0]).toHaveAttribute('scope', 'col')
    expect(
      within(table)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['GitHub', 'https://github.com/a', 'arXiv', 'https://arxiv.org/b'])
    // 单元格里的网址照样点得到（换排版不许把链接弄丢）
    expect(within(table).getByRole('link', { name: 'https://github.com/a' })).toHaveAttribute(
      'href',
      'https://github.com/a',
    )
  })

  it('其余 → 现状那块等宽 `<pre>`（data-result="text"），网址照旧可点', () => {
    const container = renderResult('见 https://news.example.com/a 这一篇')

    const text = container.querySelector('[data-result="text"]')
    expectCapped(text)
    expect(text?.tagName).toBe('PRE')
    expect(text?.textContent).toBe('见 https://news.example.com/a 这一篇')
    expect(screen.getByRole('link', { name: 'https://news.example.com/a' })).toHaveAttribute(
      'href',
      'https://news.example.com/a',
    )
  })

  it('**半截 JSON**（预览态与全文态都是半截）→ 退回 `<pre>` 原文；提示与「加载全部」照旧在', async () => {
    /*
      造一段"后端已经裁过一刀"的返回（`MAX_STEP_PREVIEW_CHARS = 2000` 切在字符串中间）：
      界面上先给前 600 字预览，点「加载全部」拿到的那 2000 字**仍然是半截**——
      两处都不许抛、不许显示"解析中"，必须原样退回等宽 `<pre>`。
    */
    const items = Array.from({ length: 120 }, (_, index) => ({ index, name: `第 ${index} 项` }))
    const result = JSON.stringify({ items }).slice(0, 2000)
    expect(result.length).toBe(2000)

    const container = renderResult(result)

    const preview = container.querySelector('[data-result="text"]')
    expectCapped(preview)
    // 原文照旧看得见（截断处就在这一段的中间），连"解析中"这类假状态都没有
    expect(preview?.textContent?.startsWith('{"items":')).toBe(true)
    expect(screen.getByText(/仅预览/)).toBeInTheDocument()
    expect(screen.queryByText(/解析中/)).toBeNull()

    await userEvent.setup().click(screen.getByRole('button', { name: /加载全部/ }))

    // 全文态：还是半截 JSON，还是那块等宽 `<pre>`（这一段没有"更大的真相"可给）
    const full = container.querySelector('[data-result="text"]')
    expectCapped(full)
    expect(full?.textContent).toHaveLength(2000)
    expect(screen.queryByText(/解析中/)).toBeNull()
  })
})
