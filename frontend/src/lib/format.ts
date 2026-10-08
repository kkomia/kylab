/**
 * 展示层格式化（《前端设计规范 v0.3》§4）。
 *
 * 前端不引 dayjs 之类的库：界面上要的时间只有"刚刚 / 3 分钟前 / 具体日期"三档，
 * 自己写比多一个依赖划算。
 *
 * 2026-10-09：随账号死面与「概览」那一页，这一份里**只被旧页面用过的几条**删掉了
 * （`summarizeDocuments` / `DocStats` / `formatLatency` / `formatScore` / `formatAge` /
 * `formatMillis`）——它们的生产调用点随那两轮一起消失，只剩用例在钉。留下的都是
 * 界面上真在用的：体积 / 千分位 / 百分比 / 相对时间 / 绝对时间 / 时长。
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** 相对时间：7 天内说"多久之前"，更久直接给日期。 */
export function formatRelativeTime(value: string | null | undefined): string {
  if (!value) return '—'
  const moment = new Date(value)
  if (Number.isNaN(moment.getTime())) return '—'

  const diff = Date.now() - moment.getTime()
  if (diff < 0) return formatDate(moment)
  if (diff < MINUTE) return '刚刚'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} 天前`
  return formatDate(moment)
}

/** 绝对时间：`2026-09-10 18:07`。 */
export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—'
  const moment = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(moment.getTime())) return '—'
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${moment.getFullYear()}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())} ` +
    `${pad(moment.getHours())}:${pad(moment.getMinutes())}`
  )
}

/**
 * 文件体积：1024 进制，最多一位小数。
 *
 * 进位按**取整后的读数**判（不是按原值）：`1048575 B` 的原始换算是 `1023.999 KB`，
 * 一位小数会写成一个 `1024.0 KB`，而列表里紧挨着的另一行是 `1.0 MB`——两个数其实
 * 一样大，却像差了一个量级。所以先算到一位小数，够 1024 就抬一档。
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let index = 0
  while (index < units.length - 1 && Number(value.toFixed(1)) >= 1024) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(1)} ${units[index]}`
}

/**
 * 百分比：**10% 以上取整，10% 以下留一位小数**。
 *
 * 两头的理由不一样：
 * - 大数取一位小数是噪音：`37.4%` 与 `37%` 对"要不要处置"没有任何区别，而读数越长越难扫；
 * - 小数**必须**留一位：内存占用常态在 1% 以下，取整会把 `0.6%` 写成 `1%`（差近一倍），
 *   把 `0.04%` 写成 `0%`——那是在说"没有"，而它有。
 * 一位小数仍会被抹平时写 `<0.1%`，不写 `0.0%`。
 * 末尾的 `.0` 一律收掉（`2.0%` → `2%`），与 10% 以上那一档写法一致。
 */
export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  if (abs >= 10) return `${Math.round(value)}%`
  if (abs === 0) return '0%'
  const tenth = value.toFixed(1)
  if (Number(tenth) === 0) return `${value > 0 ? '<' : '>-'}0.1%`
  return `${tenth.endsWith('.0') ? tenth.slice(0, -2) : tenth}%`
}

/**
 * 千分位计数。
 *
 * 用量动辄六位数（几十万 token），不分位根本读不出量级——
 * 而"这个月是不是烧太快了"正是看这组数字时要回答的问题。
 */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  // `+ 0` 收掉 -0：`Math.round(-0.4)` 是 -0，直接分位会写出一个读不通的「-0」
  return (Math.round(value) + 0).toLocaleString('zh-CN')
}

/**
 * 时长：`2 分 14 秒` / `1 小时 3 分` / `不到 1 秒`。
 *
 * **只给两级**（最大单位 + 下一级）：再多的位数没人读，"1 小时 3 分 12 秒"里的后两位
 * 从来不影响判断。而进度条那一栏要同时看**多个**时长（总耗时 + 各环节耗时），
 * 每个都写全三位会立刻挤成一团。
 *
 * 入参是**秒**——调用点只有 `LoadPanel`，那边给的本来就是秒。
 * （原先还有一条 `formatMillis`（毫秒版，给旧知识库那几页用）：它随 `summarizeDocuments`
 * 一并 2026-10-09 删了，那条"ms 只在一处除以 1000"的口径也随之作废。）
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—'
  const total = Math.max(0, Math.round(seconds))
  if (total < 1) return '不到 1 秒'
  if (total < 60) return `${total} 秒`
  if (total < 3600) {
    const minutes = Math.floor(total / 60)
    const rest = total % 60
    return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`
  }
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  return minutes === 0 ? `${hours} 小时` : `${hours} 小时 ${minutes} 分`
}
