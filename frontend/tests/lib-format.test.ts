/**
 * 纯格式化函数（`lib/format.ts`）——**从旧 Vue 版 `tests/unit/composables/useFormat.test.ts`
 * 逐条搬来的**（实现是同一份代码，只换了 import 路径）。
 *
 * 迁移期新前端漏了它：这些函数是纯的、又处处在用（体积 / 相对时间 / 时长 / 千分位），
 * 缺值该显示占位符还是 0、"只给两级"这些口径一旦被顺手改掉，界面会悄悄变得误导。
 */
import { describe, expect, it } from 'vitest'

import {
  formatAge,
  formatBytes,
  formatCount,
  formatDate,
  formatDuration,
  formatMillis,
  formatRelativeTime,
  formatScore,
  summarizeDocuments,
} from '@/lib/format'

describe('formatBytes', () => {
  it('按 1024 进制换算，保留一位小数', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })

  it('缺值显示占位符而不是 0 B', () => {
    // 0 与"不知道"是两件事：列表里把未知体积显示成 0 B 会误导
    expect(formatBytes(null)).toBe('—')
    expect(formatBytes(undefined)).toBe('—')
    expect(formatBytes(0)).toBe('0 B')
  })
})

describe('formatRelativeTime', () => {
  it('按距离现在的远近分档', () => {
    const now = Date.now()
    expect(formatRelativeTime(new Date(now - 10_000).toISOString())).toBe('刚刚')
    expect(formatRelativeTime(new Date(now - 5 * 60_000).toISOString())).toBe('5 分钟前')
    expect(formatRelativeTime(new Date(now - 3 * 3600_000).toISOString())).toBe('3 小时前')
    expect(formatRelativeTime(new Date(now - 2 * 86400_000).toISOString())).toBe('2 天前')
  })

  it('超过一周退回绝对日期', () => {
    const old = new Date(Date.now() - 30 * 86400_000)
    expect(formatRelativeTime(old.toISOString())).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  })

  it('空值与非时间字符串都给占位符', () => {
    expect(formatRelativeTime(null)).toBe('—')
    expect(formatRelativeTime('不是时间')).toBe('—')
  })
})

describe('formatDate', () => {
  it('补零到分钟', () => {
    expect(formatDate(new Date(2026, 0, 5, 9, 7))).toBe('2026-01-05 09:07')
  })

  it('空值给占位符', () => {
    expect(formatDate(null)).toBe('—')
  })
})

describe('formatScore', () => {
  it('融合分数统一三位小数', () => {
    expect(formatScore(0.033333)).toBe('0.033')
    expect(formatScore(1)).toBe('1.000')
  })

  it('缺值给占位符', () => {
    expect(formatScore(null)).toBe('—')
  })
})

describe('formatAge', () => {
  const now = new Date('2026-09-10T12:00:00').getTime()

  it('一分钟内按秒计，且能区分先后', () => {
    // 会话历史里"刚刚 / 刚刚"分不出顺序，所以要精确到秒
    expect(formatAge(now - 8_000, now)).toBe('8 秒前')
    expect(formatAge(now - 59_000, now)).toBe('59 秒前')
  })

  it('超过一分钟按分钟计', () => {
    expect(formatAge(now - 60_000, now)).toBe('1 分钟前')
    expect(formatAge(now - 25 * 60_000, now)).toBe('25 分钟前')
  })

  it('时钟偏差导致的未来时间不会显示成负数', () => {
    expect(formatAge(now + 5_000, now)).toBe('0 秒前')
  })
})

describe('summarizeDocuments', () => {
  it('按知识库分组统计条数与最近更新时间', () => {
    const stats = summarizeDocuments([
      { knowledge_base_id: 'kb-1', updated_at: '2026-09-01T09:00:00' },
      { knowledge_base_id: 'kb-1', updated_at: '2026-09-08T09:00:00' },
      { knowledge_base_id: 'kb-2', updated_at: '2026-09-05T09:00:00' },
    ])

    expect(stats['kb-1']).toEqual({ count: 2, updatedAt: '2026-09-08T09:00:00' })
    expect(stats['kb-2']).toEqual({ count: 1, updatedAt: '2026-09-05T09:00:00' })
  })

  it('更新时间缺失的文档仍计入条数', () => {
    // 没跑完的文档也是文档：少算会让"文档数"这一列骗人
    const stats = summarizeDocuments([
      { knowledge_base_id: 'kb-1', updated_at: null },
      { knowledge_base_id: 'kb-1', updated_at: '2026-09-08T09:00:00' },
    ])

    expect(stats['kb-1']).toEqual({ count: 2, updatedAt: '2026-09-08T09:00:00' })
  })

  it('没有任何文档时返回空表，由调用方决定显示占位符', () => {
    expect(summarizeDocuments([])).toEqual({})
  })
})

describe('formatCount', () => {
  it('给大数加千分位', () => {
    // 用量动辄六位数，不分位读不出量级——而"这个月是不是烧太快了"
    // 正是看这组数字时要回答的问题
    expect(formatCount(1234567)).toBe('1,234,567')
    expect(formatCount(1000)).toBe('1,000')
  })

  it('小数取整', () => {
    expect(formatCount(999.6)).toBe('1,000')
  })

  it('零与小数照常显示', () => {
    expect(formatCount(0)).toBe('0')
    expect(formatCount(42)).toBe('42')
  })

  it('拿不到值时给占位符而不是 NaN', () => {
    expect(formatCount(null)).toBe('—')
    expect(formatCount(undefined)).toBe('—')
    expect(formatCount(Number.NaN)).toBe('—')
    expect(formatCount(Number.POSITIVE_INFINITY)).toBe('—')
  })
})

describe('formatDuration', () => {
  it('只给两级：再多的位数没人读', () => {
    expect(formatDuration(134)).toBe('2 分 14 秒')
    expect(formatDuration(3782)).toBe('1 小时 3 分')
    expect(formatDuration(45)).toBe('45 秒')
  })

  it('整除时不留一个多余的 0', () => {
    // "3 分 0 秒"读起来像缺了点什么；"3 分"就是 3 分
    expect(formatDuration(180)).toBe('3 分')
    expect(formatDuration(7200)).toBe('2 小时')
  })

  it('不足一秒说"不到 1 秒"而不是 0 秒', () => {
    // 进度条上写 0 秒会让人以为这一步没跑
    expect(formatDuration(0)).toBe('不到 1 秒')
    expect(formatDuration(0.4)).toBe('不到 1 秒')
  })

  it('拿不到值时给占位符而不是 NaN 分', () => {
    expect(formatDuration(null)).toBe('—')
    expect(formatDuration(undefined)).toBe('—')
    expect(formatDuration(Number.NaN)).toBe('—')
  })

  it('毫秒版只在这里除以 1000', () => {
    // 后端时间线给毫秒；转换散到各处就会有人忘掉一次
    expect(formatMillis(134000)).toBe('2 分 14 秒')
    expect(formatMillis(null)).toBe('—')
  })
})
