/**
 * D13：会话导出的文稿（纯函数）。
 *
 * 期望值写的是**看得见的样子**（标题、谁说的、出处编号），不是实现细节——
 * 这样"改排版"与"改坏了"能分开。
 */

import { describe, expect, it } from 'vitest'

import type { ChatSource } from '@/api/chat'
import { transcriptFileName, transcriptMarkdown } from '@/features/chat/model/transcript'

function source(index: number, extra: Partial<ChatSource> = {}): ChatSource {
  return {
    index,
    chunk_id: `c${index}`,
    document_id: `d${index}`,
    document_name: `文档${index}.pdf`,
    heading_path: null,
    page: null,
    score: 0.5,
    preview: '原文片段',
    knowledge_base_id: 'kb1',
    ...extra,
  }
}

const AT = new Date('2026-09-29T10:05:00')

describe('会话导出成 Markdown（D13，2026-09-28 走查）', () => {
  it('标题、导出时刻、谁说的、正文都在', () => {
    const text = transcriptMarkdown(
      '眼科随访',
      [
        { role: 'user', content: '眼轴随访怎么看？' },
        { role: 'assistant', content: '先看随访月数。' },
      ],
      AT,
    )

    expect(text).toContain('# 眼科随访')
    expect(text).toContain('> 导出于 2026-09-29 10:05')
    expect(text).toContain('## 我\n\n眼轴随访怎么看？')
    expect(text).toContain('## 助手\n\n先看随访月数。')
  })

  it('出处带编号带出处名（正文里的 [n] 导出去仍然对得上）', () => {
    const text = transcriptMarkdown(
      '带出处',
      [
        {
          role: 'assistant',
          content: '结论见 [1]。',
          sources: [source(1), source(2, { page: 7 })],
        },
      ],
      AT,
    )

    expect(text).toContain('- [1] 文档1.pdf —— 原文片段')
    expect(text).toContain('- [2] 文档2.pdf 第 7 页 —— 原文片段')
  })

  it('没有标题、空正文、没出处都不留空白段', () => {
    const text = transcriptMarkdown('', [{ role: 'assistant', content: '   ' }], AT)

    expect(text).toContain('# 未命名对话')
    expect(text).toContain('（这条没有内容）')
    expect(text).not.toContain('出处：')
  })

  it('文件名清掉路径分隔符（标题里带 / 不该被当成目录）', () => {
    expect(transcriptFileName('2026/09 眼科：随访 * 记录')).toBe('2026_09 眼科：随访 _ 记录.md')
    expect(transcriptFileName('   ')).toBe('未命名对话.md')
  })
})
