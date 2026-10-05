/**
 * **每类默认露几条**（v0.61）——能力页技能列表里"收起 / 展开 / 搜索"三态的纯函数。
 *
 * ## 精选不由前端算
 *
 * "哪几条该露"是**后端的判断**：`GET /api/v1/skills` 在每条技能上标好了 `featured`
 * （判据见后端 `services/skills.featured_by_category`，每类 2 条）。这里**只做取舍**，
 * 不自己算"前 2 条"——判据写两份就会漂，而用户看到的正是漂的那一份。
 *
 * ## 三条规则
 *
 * 1. **默认只露精选**（有关键词、或用户点了"展开其余 N 条"时除外）；
 * 2. **有关键词就在这一类里搜全部**：搜索问的是"那一条在不在"，拿精选挡着等于搜不到，
 *    连"有没有"都答不了；
 * 3. **降级一律"全露"**：后端一条精选都没标（老后端 / 字段没给）或**这一类**一条精选
 *    都没有（比如整类都被拦下了）时全部显示——宁可多露几张卡，也不能把一类画成空的，
 *    更不能在前端自己定一个"2"（那是第二处真相）。
 *
 * 于是页面只交两个事实（有没有关键词、这一组展开了没），规则只有这一份。
 */

/** 一组技能现在画哪几条：`hidden` 是**收起来的条数**（0 = 现在没有收起来的）。 */
export interface SkillReveal<T> {
  visible: readonly T[]
  hidden: number
  /**
   * 折叠起来**真的会少几条**（这一类有精选，且不是每一条都是精选）。
   *
   * 这是那颗入口（「展开其余 N 条」/「收起」）出不出现的判据：折叠起来什么都不会变的
   * 组不该摆一颗按下去没反应的按钮，而**展开之后 `hidden` 是 0**——只看 `hidden`
   * 会把「收起」这颗也一起吞掉（收藏起来的那几条就再也回不去了）。
   */
  foldable: boolean
}

/**
 * 算出一组技能**现在画哪几条**。
 *
 * @param skills 这一组（已经过搜索过滤，顺序保持传入顺序）
 * @param state `searching` = 有关键词；`expanded` = 用户点了"展开其余 N 条"
 */
export function revealOf<T extends { featured?: boolean }>(
  skills: readonly T[],
  state: { searching: boolean; expanded: boolean },
): SkillReveal<T> {
  const featured = skills.filter((skill) => skill.featured)
  const foldable = featured.length > 0 && featured.length < skills.length
  // 有关键词 / 用户要全部 / 折叠起来什么都不会变（没有精选，或每条都是精选）→ 全露
  const visible = state.searching || state.expanded || !foldable ? skills : featured
  return { visible, hidden: skills.length - visible.length, foldable }
}
