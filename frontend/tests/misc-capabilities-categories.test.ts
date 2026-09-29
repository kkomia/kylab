/**
 * 技能分类分组：**用真镜像 JSON** 钉"每类条数之和 = 178、每条只出现一次、兜底"。
 *
 * 镜像同构：`src/features/misc/capabilities/skillCategories.ts` → 本文件。
 *
 * 为什么用**真**映射而不是手写桩：这一层的输入就是那份 JSON，
 * 手写一份假的等于把"映射里到底有几条"这件事测成自己的假设
 * （而且它还会与后端那份漂开）。所以这里读的就是页面读的那份文件，
 * 技能清单也从它的 `assignments` 的键取——**178 条是数据说的，不是用例编的**。
 */
import { describe, expect, it } from 'vitest'

import mapping from '@/features/misc/capabilities/skillCategories.json'
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  OTHER_CATEGORY,
  categoryOfSkill,
  groupSkills,
} from '@/features/misc/capabilities/skillCategories'

/** 真映射里那 178 条技能（拿名字造一份最小技能对象；分组只认名字）。 */
const ALL_SKILLS = Object.keys(mapping.assignments).map((name) => ({ name }))
const TOTAL = Object.keys(mapping.assignments).length

describe('分类映射本身（真 JSON）', () => {
  it('178 条、每类都有中文名、顺序里登记了每一个类别且「其他」在最后', () => {
    expect(TOTAL).toBe(178)
    expect(ALL_SKILLS).toHaveLength(178)
    expect(CATEGORY_ORDER.at(-1)).toBe(OTHER_CATEGORY)
    // 顺序表与中文名表覆盖同一批 key（漂一个就会红）
    expect([...CATEGORY_ORDER].sort()).toEqual(Object.keys(CATEGORY_LABELS).sort())
    for (const slug of CATEGORY_ORDER) {
      expect(CATEGORY_LABELS[slug]).toBeTruthy()
    }
  })
})

describe('按分类分组（页面用的纯函数）', () => {
  it('每类条数之和 = 178，且每条技能**出现且只出现一次**', () => {
    const groups = groupSkills(ALL_SKILLS)

    const sum = groups.reduce((total, group) => total + group.skills.length, 0)
    expect(sum).toBe(TOTAL)

    const seen = groups.flatMap((group) => group.skills.map((skill) => skill.name))
    expect(seen).toHaveLength(TOTAL)
    expect(new Set(seen).size).toBe(TOTAL)
    expect(new Set(seen)).toEqual(new Set(ALL_SKILLS.map((skill) => skill.name)))
  })

  it('顺序按 CATEGORY_ORDER，"其他"在最后', () => {
    const slugs = groupSkills(ALL_SKILLS).map((group) => group.slug)
    expect(slugs).toEqual(CATEGORY_ORDER.filter((slug) => slugs.includes(slug)))
    if (slugs.includes(OTHER_CATEGORY)) expect(slugs.at(-1)).toBe(OTHER_CATEGORY)
  })

  it('空组不画：某一类被搜索筛空之后，那一类的头也不出现', () => {
    const groups = groupSkills([{ name: 'pdf-pro' }])

    expect(groups).toHaveLength(1)
    expect(groups[0].slug).toBe('documents')
    expect(groups[0].skills).toHaveLength(1)
  })

  it('未知分类兜到「其他」（用户自己装的、市场新装的都不许消失）', () => {
    expect(categoryOfSkill('my-own-skill')).toBe(OTHER_CATEGORY)
    expect(categoryOfSkill('')).toBe(OTHER_CATEGORY)

    const groups = groupSkills([{ name: 'pdf-pro' }, { name: 'my-own-skill' }])
    const other = groups.find((group) => group.slug === OTHER_CATEGORY)
    expect(other?.skills.map((skill) => skill.name)).toEqual(['my-own-skill'])
  })

  it('空结果不崩（搜索无结果时走的就是这一条）', () => {
    expect(groupSkills([])).toEqual([])
  })

  it('保持传入顺序（页面上的先后由过滤后的清单决定）', () => {
    const groups = groupSkills([{ name: 'slide-skill' }, { name: 'mocky' }, { name: 'pdf-pro' }])
    const slides = groups.find((group) => group.slug === 'slides')
    expect(slides?.skills.map((skill) => skill.name)).toEqual(['slide-skill', 'mocky'])
  })
})
