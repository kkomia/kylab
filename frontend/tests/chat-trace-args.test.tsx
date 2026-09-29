/**
 * D19：工具入参那一行的 `art_*` 要缀上文件名（走查实测原文：`{"key": "art_7e7aecbd2ca0"}`）。
 *
 * 上面几条纯函数用例钉的是"表怎么建、串怎么换"，这一条钉**接线**：
 * 名字表真的传到了行里、真的显示出来了——只测纯函数的话，把那一行删掉也不会红。
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { ChatStep } from '@/api/chat'
import { TraceStepRow } from '@/features/chat/ui/TraceStepRow'

function step(extra: Partial<ChatStep> = {}): ChatStep {
  return { phase: 'read', label: '读上传的文件', detail: '读了 20 行', status: 'done', ...extra }
}

function row(args: string, names?: ReadonlyMap<string, string>) {
  return render(
    <TraceStepRow step={{ ...step(), args } as never} open onToggle={vi.fn()} names={names} />,
  )
}

describe('入参里的 art_* 显示成"key（文件名）"（D19）', () => {
  it('给了名字表 → 键后面缀上文件名（键保留）', () => {
    row('{"key": "art_1"}', new Map([['art_1', '走查样例.md']]))

    expect(screen.getByText(/art_1（走查样例\.md）/)).toBeInTheDocument()
  })

  it('没给名字表 → 原样显示，不编不猜', () => {
    row('{"key": "art_1"}')

    expect(screen.getByText(/art_1/)).toBeInTheDocument()
    expect(screen.queryByText(/走查样例/)).not.toBeInTheDocument()
  })
})
