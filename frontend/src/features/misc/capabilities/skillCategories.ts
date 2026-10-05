/**
 * **技能分类**：把技能列表按"初始技能集"的分类分组（能力页的展示用）。
 *
 * ## 数据从哪来
 *
 * 读的是**镜像**那份 JSON（`./skillCategories.json`）——它是后端
 * `app/services/skill_categories.json` 的逐字节副本，由
 * `python -m app.services.skill_categories --write` 生成后复制过来。
 * **两份必须相同**这件事由后端用例钉着
 * （`backend/tests/unit/services/test_skill_categories.py::test_the_frontend_mirror_is_byte_identical`），
 * 所以前端不需要、也不许自己维护一套分类判据（那会变成第二处真相）。
 * **v0.61 起"每条技能归哪一类"由接口的 `category` 给**（现算、跟着文件走），
 * 这份镜像剩两件事：**顺序与中文名**，以及技能上没带 `category` 时的兜底
 * （见 `resolveCategory` —— 镜像会过时，实测差 25 条）。
 *
 * 为什么不用 Vite 跨目录 import 后端那份：那要赌 `server.fs.allow`（workspace 根之外），
 * 镜像 + 一条字节一致的用例更稳，也是本仓既有的"两处钉一致"手法。
 *
 * ## 这一层只管三件事
 *
 * 1. **顺序**：`order` 是展示顺序（JSON 落盘时键名排过序，光看 `categories` 读不出先后）；
 * 2. **归类**：**后端给的 `category`（v0.61，每条技能自带）优先**，没有才查
 *    `assignments` 里那条按名字的映射（理由见 `resolveCategory`：镜像是一份快照，
 *    实测与后端现算的差 25 条，按镜像分组会让"每类 2 条"错位）；
 * 3. **兜底**：两个来源都查不到（用户自己装的技能、市场新装的）一律进「其他」——
 *    初始技能集之外的东西不该在页面上凭空消失。
 *
 * 分组是**纯函数**（输入输出都是数据），页面只负责画；这样"每类几条、有没有漏"
 * 可以直接用真镜像 JSON 单测，不必起浏览器。
 */

import mapping from './skillCategories.json'

/** 技能上这一层真正用到的字段：名字即身份（与后端 `SkillOut.name` 同值）。 */
export interface NamedSkill {
  name: string
  /**
   * **后端现算的分类**（v0.61 的 `SkillOut.category`，跟着 `SKILL.md` 走）。
   *
   * 有它就以它为准（见 `resolveCategory`）；没有（老后端 / 用例里手搓的对象）
   * 才退回下面那份按名字的镜像映射。
   */
  category?: string
}

/** 一组技能：类别 key、中文名、以及这一组里的技能（保持传入顺序）。 */
export interface SkillGroup<T extends NamedSkill> {
  slug: string
  label: string
  skills: T[]
}

/** 「其他」的 key（映射里也有这一类；这里留常量是给"查不到"那条兜底路径用的）。 */
export const OTHER_CATEGORY = 'other'

type MappingShape = {
  order: string[]
  categories: Record<string, string>
  assignments: Record<string, string>
}

const DATA = mapping as MappingShape

/** 展示顺序（含"其他"，它在最后）。 */
export const CATEGORY_ORDER: readonly string[] = DATA.order

/** 类别 key → 中文名。 */
export const CATEGORY_LABELS: Readonly<Record<string, string>> = DATA.categories

/** 技能名 → 类别 key（初始技能集那 178 条）。 */
export const SKILL_CATEGORY: Readonly<Record<string, string>> = DATA.assignments

/**
 * 这个技能属于哪一类（**镜像那一份的兜底**：只有技能上没带 `category` 时才走到它）。
 *
 * 查不到 → 「其他」（用户自己装的、市场新装的都在这一档）。
 * 查得到一个**没在 `order` 里登记**的类别（映射被改坏/版本不匹配）→ 也归「其他」：
 * 宁可在"其他"里看得见，也不要让它在页面上凭空消失。
 */
export function categoryOfSkill(name: string): string {
  const slug = SKILL_CATEGORY[name]
  if (!slug) return OTHER_CATEGORY
  return slug in CATEGORY_LABELS ? slug : OTHER_CATEGORY
}

/**
 * 一条技能归哪一类：**后端给的 `category` 优先，没有才查镜像**。
 *
 * 为什么优先后端（v0.61 实测的漂）：镜像那份 `assignments` 是**某一次生成的快照**
 * （2026-09-29），而后端的 `category` 是**跟着 `SKILL.md` 现算**的。库里一有新技能
 * 或描述改了，两边就分开——实测 187 条里 **25 条**不一致（产品自带的
 * `pptx`/`docx`/`xlsx`/`pdf` 更是压根不在镜像里，一直挂在「其他」）。
 *
 * 这份漂在页面上是**看得见**的：精选是按后端分类选的，一按镜像分组就会错位——
 * 「商业与金融」「设计与视觉」「营销与增长」各只露 1 条，「表格与数据」「其他」
 * 露 3 条，与"每类 2 条"对不上。所以分组跟着后端走；镜像只剩**顺序与中文名**
 * 这一份展示口径（它没有"这个技能属于哪一类"的发言权了）。
 *
 * 技能上没带 `category`（老后端 / 用例夹具）时照旧查镜像，行为与加这一条之前一致。
 */
function resolveCategory(skill: NamedSkill): string {
  const slug = skill.category || SKILL_CATEGORY[skill.name]
  if (!slug) return OTHER_CATEGORY
  return slug in CATEGORY_LABELS ? slug : OTHER_CATEGORY
}

/**
 * 把一批技能分好组（页面直接用）。
 *
 * - **顺序**按 `CATEGORY_ORDER`（"其他"在最后）；
 * - **归类**按 `resolveCategory`（后端 `category` 优先，见那一段）；
 * - **空组不画**（搜索把某一类筛空之后，留一个"0 条"的头只是噪声）；
 * - 每条技能**只出现一次**（按分类去重；重名在数据里不存在，真出现也只算第一次，
 *   见用例"每条都出现且只出现一次"）；
 * - 传空表 → 空数组（页面搜索到无结果时走的就是这一条，不许崩）。
 */
export function groupSkills<T extends NamedSkill>(skills: readonly T[]): SkillGroup<T>[] {
  const buckets = new Map<string, T[]>()
  for (const item of skills) {
    const slug = resolveCategory(item)
    const bucket = buckets.get(slug)
    if (bucket) bucket.push(item)
    else buckets.set(slug, [item])
  }

  const groups: SkillGroup<T>[] = []
  for (const slug of CATEGORY_ORDER) {
    const bucket = buckets.get(slug)
    if (bucket?.length) {
      groups.push({ slug, label: CATEGORY_LABELS[slug] ?? slug, skills: bucket })
    }
  }
  return groups
}
