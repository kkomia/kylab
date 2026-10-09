/**
 * 右侧面板「文件」视图里那几件纯计算（`features/chat/model/fileTree.ts` 与
 * `fileIcons.tsx`）。
 *
 * 为什么要单开一份：树、排序、搜索的错都**只表现为"看起来不太对"**——子目录被排到文件
 * 后面、搜到没展开的层、少展开一层导致"点了预览什么都没发生"。这些在界面上盯不出来，
 * 所以把判据抽成纯函数，在这里逐条钉住。
 *
 * 用例里的条目形状就是 `api/conversations.ts` 的 `ConversationFile`（`key` 是带相对路径
 * 的那一串，也是进子目录时交给服务端的那个 `path`）。
 */
import { describe, expect, it } from 'vitest'
import {
  FileCode2,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  Presentation,
} from 'lucide-react'

import type { ConversationFile } from '@/api/conversations'
import { fileIconFor } from '@/features/chat/model/fileIcons'
import {
  crumbsOf,
  dirsToReveal,
  extensionOf,
  flattenLevels,
  fuzzyScore,
  isUnder,
  parentOf,
  searchTree,
  sortEntries,
  type TreeEntry,
} from '@/features/chat/model/fileTree'

/** 一份文件（只写用得上的字段，其余按契约给默认值）。 */
function file(key: string, extra: Partial<ConversationFile> = {}): ConversationFile {
  return {
    key,
    name: key.split('/').pop() ?? key,
    is_dir: false,
    size_bytes: 1024,
    modified_at: null,
    kind: extensionOf(key),
    ...extra,
  }
}

/** 一个目录（`key` 就是它的路径）。 */
function dir(key: string): ConversationFile {
  return {
    key,
    name: key.split('/').pop() ?? key,
    is_dir: true,
    size_bytes: 0,
    modified_at: null,
    kind: '',
  }
}

const names = (items: readonly ConversationFile[]): string[] =>
  items.map((item) => (item.is_dir ? `${item.name}/` : item.name))

describe('同层排序', () => {
  const level = [
    file('b.md', { modified_at: '2026-10-01T00:00:00Z' }),
    dir('out'),
    file('a.png', { modified_at: '2026-10-03T00:00:00Z' }),
    file('c.txt', { modified_at: null }),
    dir('docs'),
  ]

  it('三档都是**目录恒在最前**（排序说的是同类里怎么排，不是把目录和文件混着重排）', () => {
    for (const sort of ['name', 'modified', 'type'] as const) {
      const sorted = sortEntries(level, sort)
      expect(sorted.slice(0, 2).map((item) => item.is_dir)).toEqual([true, true])
    }
  })

  it('名称：按显示名，数字感知（第 9 章排在 第 10 章 前面，而不是按码位）', () => {
    const sorted = sortEntries([file('第10章.md'), file('第9章.md')], 'name')
    expect(names(sorted)).toEqual(['第9章.md', '第10章.md'])
  })

  it('修改时间：**最近的在前**；没有时间戳的排最后', () => {
    const sorted = sortEntries(level, 'modified')
    expect(names(sorted)).toEqual(['docs/', 'out/', 'a.png', 'b.md', 'c.txt'])
  })

  it('类型：按后缀分组，同后缀再按名字', () => {
    const sorted = sortEntries([file('b.md'), file('a.png'), file('a.md')], 'type')
    expect(names(sorted)).toEqual(['a.md', 'b.md', 'a.png'])
  })

  it('不改原数组（它是 react-query 缓存里那一份，改它等于改共享状态）', () => {
    const before = names(level)
    sortEntries(level, 'type')
    expect(names(level)).toEqual(before)
  })
})

describe('模糊匹配', () => {
  it('子序列能命中（记得几个零散字母也搜得到）', () => {
    expect(fuzzyScore('rp', 'report.md')).toBeGreaterThan(0)
    expect(fuzzyScore('rpt', 'report.md')).toBeGreaterThan(0)
  })

  it('顺序不对、或有字符压根不在里面 = 不匹配（-1）', () => {
    expect(fuzzyScore('oe', 'report.md')).toBe(-1)
    expect(fuzzyScore('z', 'report.md')).toBe(-1)
  })

  it('成片命中 > 散落命中；开头/词边界命中 > 中间命中', () => {
    expect(fuzzyScore('rep', 'report.md')).toBeGreaterThan(fuzzyScore('r_e_p', 'report.md'))
    expect(fuzzyScore('rep', 'report.md')).toBeGreaterThan(fuzzyScore('rep', 'my-report.md'))
  })

  it('空查询得 0（调用方据此短路，不当成"命中全部"）', () => {
    expect(fuzzyScore('   ', 'report.md')).toBe(0)
  })
})

describe('搜索只吃"已经摊平的那几层"', () => {
  const items: TreeEntry[] = [
    { dir: '', entry: dir('out') },
    { dir: '', entry: file('report.md') },
    { dir: 'out', entry: file('out/quarterly.docx') },
  ]

  it('空查询给空结果（不是"全部列出来"）', () => {
    expect(searchTree(items, '  ')).toEqual([])
  })

  it('高分在前，同分保持原来的层序', () => {
    const hits = searchTree(items, 'report')
    expect(hits.map((hit) => hit.entry.name)).toEqual(['report.md'])
  })

  it('超过上限就截断（面板里不摆一屏搜不完的清单）', () => {
    const many: TreeEntry[] = Array.from({ length: 10 }, (_, index) => ({
      dir: '',
      entry: file(`report-${index}.md`),
    }))
    expect(searchTree(many, 'report', 3)).toHaveLength(3)
  })
})

describe('已经展开的那几层摊平（搜索的地盘）', () => {
  const byDir: Record<string, ConversationFile[]> = {
    '': [dir('out'), file('a.md')],
    out: [dir('out/2026'), file('out/b.md')],
    'out/2026': [file('out/2026/c.md')],
  }

  it('只往**展开着**的目录里走：收起来的目录，它那份缓存的清单也不算数', () => {
    const collapsed = flattenLevels('', byDir, new Set())
    expect(collapsed.map((item) => item.entry.key)).toEqual(['out', 'a.md'])

    const halfOpen = flattenLevels('', byDir, new Set(['out']))
    expect(halfOpen.map((item) => item.entry.key)).toEqual(['out', 'out/2026', 'out/b.md', 'a.md'])

    const allOpen = flattenLevels('', byDir, new Set(['out', 'out/2026']))
    expect(allOpen.map((item) => item.entry.key)).toEqual([
      'out',
      'out/2026',
      'out/2026/c.md',
      'out/b.md',
      'a.md',
    ])
  })

  it('根那一层是当前目录（不是永远的空串）：换到子目录之后就只摊它下面', () => {
    expect(
      flattenLevels('out', byDir, new Set(['out', 'out/2026'])).map((item) => item.entry.key),
    ).toEqual(['out/2026', 'out/2026/c.md', 'out/b.md'])
  })
})

describe('续层定位：要展开哪几层才看得见那一份', () => {
  it('从最上面那层出发：逐段展开', () => {
    expect(dirsToReveal('', 'out/2026/report.docx')).toEqual(['out', 'out/2026'])
  })

  it('已经在子目录里：只展开它下面那几段（当前层本来就在看着）', () => {
    expect(dirsToReveal('out', 'out/2026/report.docx')).toEqual(['out/2026'])
  })

  it('就在当前层：什么都不用展开', () => {
    expect(dirsToReveal('', 'report.docx')).toEqual([])
    expect(dirsToReveal('out', 'out/b.md')).toEqual([])
  })

  it('不在这一层下面：给空（不猜，由调用方决定换不换一层）', () => {
    expect(dirsToReveal('out', 'other/b.md')).toEqual([])
    // 前缀陷阱：`out2/...` 不是 `out` 下面的东西
    expect(dirsToReveal('out', 'out2/b.md')).toEqual([])
  })

  it('`isUnder` 与它认同一件事（两处判据必须一致，不然"在不在这一层"会有两种答案）', () => {
    expect(isUnder('', 'anything')).toBe(true)
    expect(isUnder('out', 'out/b.md')).toBe(true)
    expect(isUnder('out', 'out2/b.md')).toBe(false)
    expect(isUnder('out', 'out')).toBe(true)
  })
})

describe('路径那几件小事', () => {
  it('后缀：前导点不算后缀（`.gitignore` 是一份没后缀的文件）', () => {
    expect(extensionOf('report.md')).toBe('md')
    expect(extensionOf('REPORT.DOCX')).toBe('docx')
    expect(extensionOf('.gitignore')).toBe('')
    expect(extensionOf('README')).toBe('')
  })

  it('上一级：根那一层是空串', () => {
    expect(parentOf('out/2026/c.md')).toBe('out/2026')
    expect(parentOf('a.md')).toBe('')
  })

  it('面包屑：**只有路径那几段**（根不占一段），每段的 `path` 就是那一层', () => {
    expect(crumbsOf('out/2026')).toEqual([
      { label: 'out', path: 'out' },
      { label: '2026', path: 'out/2026' },
    ])
    // 根那层没有任何一段：面板里那一颗根按钮随范围页签一起去掉了（只说路径）
    expect(crumbsOf('')).toEqual([])
  })
})

describe('文件图标的分派（产物卡片与文件树共用同一张表）', () => {
  it('按后缀分档：代码 / 表格 / 幻灯 / 图片 / 数据', () => {
    expect(fileIconFor('ts')).toBe(FileCode2)
    expect(fileIconFor('sh')).toBe(FileTerminal)
    expect(fileIconFor('json')).toBe(FileJson)
    expect(fileIconFor('xlsx')).toBe(FileSpreadsheet)
    expect(fileIconFor('pptx')).toBe(Presentation)
    expect(fileIconFor('png')).toBe(FileImage)
  })

  it('大小写与前导点都归一（产物卡片给的是 `format`，文件树给的是 `kind`）', () => {
    expect(fileIconFor('.PNG')).toBe(FileImage)
    expect(fileIconFor('  Md ')).toBe(FileText)
  })

  it('认不出来的一律给文档那一枚（不猜、也不留空）', () => {
    expect(fileIconFor('')).toBe(FileText)
    expect(fileIconFor('zip')).toBe(FileText)
  })
})
