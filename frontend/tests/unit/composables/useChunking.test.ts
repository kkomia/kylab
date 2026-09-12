import { describe, expect, it } from 'vitest'

import { chunkOverlapMax } from '@/api/knowledgeBases'
import { chunkingErrorOf, parseIntOrNull } from '@/composables/useChunking'

describe('parseIntOrNull', () => {
  it('空串给 null，与 0 区分开', () => {
    // 这一条是整套校验的地基：`Number('')` 是 0，会把"还没填"当成"填了 0"
    expect(parseIntOrNull('')).toBeNull()
    expect(parseIntOrNull('   ')).toBeNull()
    expect(parseIntOrNull('0')).toBe(0)
  })

  it('小数与非法输入都算无效', () => {
    expect(parseIntOrNull('12.5')).toBeNull()
    expect(parseIntOrNull('abc')).toBeNull()
  })

  it('接受带空白的整数（用户复制粘贴常带上）', () => {
    expect(parseIntOrNull(' 256 ')).toBe(256)
  })
})

describe('chunkingErrorOf', () => {
  it('默认值通过', () => {
    expect(chunkingErrorOf('512', '64')).toBe('')
  })

  it('块长越界：文案里带上可用区间，用户不用去别处找', () => {
    expect(chunkingErrorOf('10', '0')).toContain('128–2048')
    expect(chunkingErrorOf('99999', '0')).toContain('128–2048')
  })

  it('块长空着也算不合法（不是当成 0）', () => {
    expect(chunkingErrorOf('', '0')).toContain('块长需要在')
  })

  it('重叠超过块长一半：上限随块长变，文案要跟着变', () => {
    expect(chunkingErrorOf('128', '100')).toContain('0–64')
    expect(chunkingErrorOf('512', '300')).toContain('0–256')
    // 边界值合法
    expect(chunkingErrorOf('128', '64')).toBe('')
    expect(chunkingErrorOf('128', '0')).toBe('')
  })

  it('重叠为负不合法', () => {
    expect(chunkingErrorOf('512', '-1')).toContain('0–256')
  })
})

describe('chunkOverlapMax', () => {
  it('是块长的一半（向下取整）', () => {
    expect(chunkOverlapMax(512)).toBe(256)
    expect(chunkOverlapMax(129)).toBe(64)
    // 极小块长也不能给 0：重叠 0 是合法值，但"上限 0"会让用户以为不能设
    expect(chunkOverlapMax(1)).toBe(1)
  })
})
