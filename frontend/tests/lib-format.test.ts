/**
 * 纯格式化函数（`lib/format.ts`）——**从旧 Vue 版 `tests/unit/composables/useFormat.test.ts`
 * 逐条搬来的**（实现是同一份代码，只换了 import 路径）。
 *
 * 迁移期新前端漏了它：这些函数是纯的、又处处在用（体积 / 相对时间 / 千分位），
 * 缺值该显示占位符还是 0、这些口径一旦被顺手改掉，界面会悄悄变得误导。
 *
 * 2026-10-09：「运行负载」面板下线之后，只被它调用的 `formatDuration` 也随之下线，
 * 钉它的那四条用例一并删掉（`formatMillis` 那条更早一轮就随 `summarizeDocuments` 去了）。
 */
import { describe, expect, it } from 'vitest'

import {
  formatBytes,
  formatCount,
  formatDate,
  formatPercent,
  formatRelativeTime,
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

  it('一位小数的进位按读数判，不在下一档边上写出"1024.0 KB"', () => {
    // 1048575 B 的原始换算是 1023.999 KB：旧写法会给出 "1024.0 KB"，
    // 而同一列里紧挨着的 1 MB 文件写的是 "1.0 MB"——两个一样大的数看起来差一档
    expect(formatBytes(1_048_575)).toBe('1.0 MB')
    expect(formatBytes(1_048_576)).toBe('1.0 MB')
    // 还没到进位线的仍是 KB（1023.0 的一位小数不触发抬档）
    expect(formatBytes(1023 * 1024)).toBe('1023.0 KB')
  })
})

describe('formatPercent', () => {
  it('10% 以上取整：一位小数在这个量级上只是噪音', () => {
    expect(formatPercent(37.4)).toBe('37%')
    expect(formatPercent(84.6)).toBe('85%')
    expect(formatPercent(100)).toBe('100%')
  })

  it('10% 以下留一位小数：0.6% 不能被写成 1%', () => {
    // 内存、CPU 的常态读数就在这一档，取整会把它抬成 1%（差近一倍）
    expect(formatPercent(0.6)).toBe('0.6%')
    expect(formatPercent(0.4)).toBe('0.4%')
    expect(formatPercent(9.96)).toBe('10%')
  })

  it('末尾的 .0 收掉：2% 不写成 2.0%', () => {
    expect(formatPercent(2)).toBe('2%')
    expect(formatPercent(9.0)).toBe('9%')
  })

  it('非零但不值 0.1% 时写 <0.1%，不写 0.0%', () => {
    expect(formatPercent(0.04)).toBe('<0.1%')
    expect(formatPercent(-0.04)).toBe('>-0.1%')
  })

  it('零写 0%；负数带上符号而不是被吞掉', () => {
    expect(formatPercent(0)).toBe('0%')
    expect(formatPercent(-12.4)).toBe('-12%')
    expect(formatPercent(-0.6)).toBe('-0.6%')
  })

  it('拿不到值时给占位符而不是 0%', () => {
    expect(formatPercent(null)).toBe('—')
    expect(formatPercent(undefined)).toBe('—')
    expect(formatPercent(Number.NaN)).toBe('—')
    expect(formatPercent(Number.POSITIVE_INFINITY)).toBe('—')
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

  it('负数也分位（差量/欠额这类读数同样要读得出量级）', () => {
    expect(formatCount(-1234)).toBe('-1,234')
    // -0.4 取整是 -0：不能写出一个读不通的「-0」
    expect(formatCount(-0.4)).toBe('0')
  })
})
