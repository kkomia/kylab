/**
 * 分段进度的展示口径（§12.115）。
 *
 * 列表行的进度条与抽屉里的环节明细**读同一份数据、用同一套判断**，所以解释逻辑
 * 收在这里而不是各写一遍：两处各写一份的话，"失败"在一处是红段、在另一处是黄段，
 * 用户就会以为是两回事。
 *
 * 两条刻意的取舍：
 *
 * 1. **不给百分比**。6 个环节的耗时极不均（解析几分钟、切分几秒），百分比只能
 *    编出一个对不上的数字；"第 3/6 步 · 解析内容"每一项都能和事实对上。
 * 2. **空槽也画出来**。"共 6 段、填到第 3 段"这个形状本身就是信息——
 *    只画已完成的 3 段会看起来像"已经跑完了"。
 */
import type { DocumentProgress } from '@/api/documents'
import type { MeterSegment, MeterTone } from '@/components/ui/MeterBar.vue'
import { formatMillis } from '@/composables/useFormat'

/** 一步的状态（后端给的就是这五种之一）。 */
export type StepState = 'done' | 'running' | 'pending' | 'failed' | 'canceled'

/** 整条流水线的状态 → 色档。 */
export function progressTone(progress: DocumentProgress | null | undefined): MeterTone {
  if (!progress) return 'accent'
  if (progress.stalled) return 'danger'
  if (progress.status === 'failed') return 'danger'
  if (progress.status === 'canceled') return 'neutral'
  if (progress.status === 'done') return 'success'
  return 'info'
}

/**
 * 把进度折成进度条的分段。
 *
 * 每段一种色：**走到过**的是强调色，**当前**那段按状态上色（跑着=信息色 + 呼吸，
 * 失败=红），**还没到**的留空槽。这样一眼能读出"几段、走到哪、在哪停的"。
 */
export function progressSegments(
  progress: DocumentProgress | null | undefined,
  options: { pulsing?: boolean } = {},
): MeterSegment[] {
  if (!progress) return []
  const tone = progressTone(progress)
  return Array.from({ length: progress.step_total }, (_, index) => {
    const position = index + 1
    if (position < progress.step_index) {
      // 已经走过：填满。失败的文档走到过的那几步仍然是"走过"，不改色——
      // 只有**停下的那一步**才是红的，不然整条都是红的，看不出炸在哪
      return { fill: 1, tone: 'accent' as MeterTone }
    }
    if (position === progress.step_index) {
      return {
        // 当前这一步填满：它是"正在进行"，不是"完成了 30%"——环节内部我们并不知道
        // 进度，画成半截就是编数字（这也是整个进度条不给百分比的原因）
        fill: 1,
        tone,
        pulsing: options.pulsing ?? progress.status === 'running',
      }
    }
    return { fill: 0, tone: 'neutral' as MeterTone }
  })
}

/**
 * 那一行文字：`第 3/6 步 · 解析内容 · 已用 2 分 14 秒`。
 *
 * 失败/取消/停滞各自在后面缀一句——**光有进度条看不出"它已经死了"**，
 * 而"停下来"与"卡住不动"要做的处置完全不同。
 */
export function progressCaption(progress: DocumentProgress | null | undefined): string {
  if (!progress) return ''
  const head = `第 ${progress.step_index}/${progress.step_total} 步 · ${progress.step_label}`
  if (progress.status === 'done') {
    return `${head} · 共 ${formatMillis(progress.total_ms)}`
  }
  const elapsed = `已用 ${formatMillis(progress.elapsed_ms)}`
  if (progress.stalled) {
    return `${head} · ${elapsed} · 疑似卡住（没有 worker 在处理）`
  }
  if (progress.status === 'failed') {
    return `${head} · 失败于这一步（已用 ${formatMillis(progress.elapsed_ms)}）`
  }
  if (progress.status === 'canceled') {
    return `${head} · 已取消`
  }
  if (progress.retries > 0) {
    return `${head} · ${elapsed} · 重试 ${progress.retries} 次`
  }
  return `${head} · ${elapsed}`
}

/** 分段进度条只在"还没跑完"的文档上有意义（跑完的每段都满，纯噪声）。 */
export function showsProgress(progress: DocumentProgress | null | undefined): boolean {
  return progress !== null && progress !== undefined && progress.status !== 'done'
}
