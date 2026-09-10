/**
 * 展示层格式化（《前端设计规范 v0.3》§4）。
 *
 * 前端不引 dayjs 之类的库：知识库界面的时间只需要"刚刚 / 3 分钟前 / 具体日期"三档，
 * 自己写比多一个依赖划算。
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

/** 文件体积：1024 进制，最多一位小数。 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(1)} ${units[index]}`
}

/** 相似度分数：融合分数是相对值（后端按 top 归一化），统一三位小数。 */
export function formatScore(score: number | null | undefined): string {
  if (score === null || score === undefined) return '—'
  return score.toFixed(3)
}
