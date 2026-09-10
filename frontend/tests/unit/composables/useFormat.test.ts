import { describe, expect, it } from 'vitest'

import { formatBytes, formatDate, formatRelativeTime, formatScore } from '@/composables/useFormat'

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
