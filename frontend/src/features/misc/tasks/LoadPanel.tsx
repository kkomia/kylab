/**
 * 运行负载面板（任务中心顶部，§12.115）——与旧前端 `components/tasks/LoadPanel.vue` 对应。
 *
 * **要回答的是"后台为什么慢"**，而这个问题在任务列表里找不到答案：列表说的是
 * "每个任务怎么了"，慢的原因却常常与任何单个任务无关——是 CPU 满了、并发槽位只有 1 个、
 * 还是云端额度用尽在降级排队。这一格把那些数摊开。
 *
 * 四格的分工（每一格都对应一种**可操作**的结论）：
 * 系统负载 → 降并发；任务并发 → 抬 KYLAB_WORKER_CONCURRENCY；
 * 进程内存 → 重启/查漏；云端额度 → 等次日额度或换本地解析。
 *
 * **CPU 可能是"—"**：后端按两次采样之差算，第一次问就是没有差值。
 * 这不是缺失，界面上如实显示"—"而不是画一根 0% 的环（那会被读成"机器很空闲"）。
 */
import type { SystemLoad } from '@/api/tasks'
import { formatBytes, formatDuration } from '@/lib/format'

import { loadTone, taskKindLabel } from '../shared/status'
import { InfoTip, RingGauge } from '../shared/composites'

/** 中心文字用的百分比。`null` 写"—"而不是 0%。 */
function percentText(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${Math.round(value)}%`
}

export function LoadPanel({ load, live }: { load: SystemLoad | null; live?: boolean }) {
  const hardware = load?.hardware ?? null
  const queue = load?.queue ?? null
  const quota = load?.quota ?? null
  /** 首屏还没拿到数据：**照常画出骨架结构**，不整块消失（否则下面的内容会被推下去）。 */
  const pendingData = load === null

  const cpuPercent = hardware?.cpu_percent ?? null
  const memoryPercent = hardware?.memory_percent ?? null
  const quotaPercent =
    quota?.configured && quota.daily_quota > 0 ? (quota.pages_used / quota.daily_quota) * 100 : null
  const quotaRatio = quotaPercent === null ? 0 : Math.min(quotaPercent / 100, 1)

  const cpuTone = loadTone(cpuPercent)
  const memoryTone = loadTone(memoryPercent, 85, 93)
  /** 额度用尽用 warn 而不是 danger：**它不是故障**，是"变慢"的原因。 */
  const quotaTone = quota?.exhausted ? 'warning' : 'accent'
  /** 槽位占用：跑满了才提示——这正是"该抬并发"的信号。 */
  const slotsTone =
    queue && queue.slots > 0 && queue.running >= queue.slots && queue.pending > 0
      ? 'warning'
      : 'accent'

  /**
   * 在跑数**超过**上限。真会出现：进程被 kill 时它手上的任务还写着 running，
   * 租约到期才回收——在到期之前库里确实有"比消费者还多"的运行中任务。
   * 要说明白，否则"上限 1 却有 2 个在跑"读起来像面板算错了。
   */
  const oversubscribed = queue !== null && queue.slots > 0 && queue.running > queue.slots

  /** 排队任务按类型分布，按条数降序——"积压全是出题"这个结论要一眼看得出来。 */
  const pendingKinds = Object.entries(queue?.pending_by_kind ?? {})
    .map(([kind, count]) => ({ kind, count, label: taskKindLabel(kind) }))
    .sort((left, right) => right.count - left.count)

  const oldestSeconds = queue?.oldest_pending_seconds ?? null
  const oldestWait = oldestSeconds === null ? null : formatDuration(oldestSeconds)

  /** 有没有需要解释的异常状态（停滞 / 逾期）。没有就把那一行整个省掉。 */
  const problems: string[] = []
  if (queue && queue.stalled > 0)
    problems.push(`${queue.stalled} 个任务可能卡住（没有 worker 在续约）`)
  if (queue && queue.overdue > 0) problems.push(`${queue.overdue} 个任务长时间未被领取`)

  /** 槽位格子：一个格子一个并发槽，在跑的几个填实。 */
  const slotSquares =
    queue && queue.slots > 0
      ? Array.from({ length: queue.slots }, (_, index) => index < queue.running)
      : []

  /**
   * 本进程常驻内存占机器内存的比例。给这个数是为了让这一格回答的问题从
   * "这个数是什么"变成"它算不算大"——0.4% 一眼就知道不是瓶颈。
   */
  const processShare =
    hardware && hardware.memory_total_bytes > 0 && hardware.process_rss_bytes !== null
      ? `${((hardware.process_rss_bytes / hardware.memory_total_bytes) * 100).toFixed(1)}%`
      : null

  return (
    <section className="m-load" aria-label="运行负载">
      <header className="m-load-head">
        <h2 className="m-load-title">运行负载</h2>
        {live && <span className="m-load-live">实时刷新中</span>}
      </header>

      <div className="m-gauges">
        <div className="m-gauge">
          <span className="m-gauge-glyph">
            <RingGauge
              ratio={(cpuPercent ?? 0) / 100}
              label={percentText(cpuPercent)}
              tone={cpuTone}
              ariaLabel="CPU 使用率"
            />
          </span>
          <span className="m-gauge-name">CPU</span>
          <span className="m-gauge-detail tabular">
            {hardware ? `${hardware.cpu_count} 核${cpuPercent === null ? ' · 采样中' : ''}` : '—'}
          </span>
        </div>

        <div className="m-gauge">
          <span className="m-gauge-glyph">
            <RingGauge
              ratio={(memoryPercent ?? 0) / 100}
              label={percentText(memoryPercent)}
              tone={memoryTone}
              ariaLabel="内存使用量"
            />
          </span>
          <span className="m-gauge-name">内存</span>
          <span className="m-gauge-detail tabular">
            {hardware
              ? `${formatBytes(hardware.memory_used_bytes)} / ${formatBytes(hardware.memory_total_bytes)}`
              : '—'}
          </span>
        </div>

        <div className="m-gauge">
          <span className="m-gauge-glyph">
            {slotSquares.length > 0 ? (
              <span
                className="m-slots"
                role="img"
                aria-label={`${queue?.running ?? 0} / ${queue?.slots ?? 0} 个并发槽位在使用`}
              >
                {slotSquares.map((busy, index) => (
                  <span
                    key={index}
                    className={busy ? `m-slot m-slot-busy-${slotsTone}` : 'm-slot'}
                  />
                ))}
              </span>
            ) : (
              <span className="m-gauge-blank">—</span>
            )}
          </span>
          <span className="m-gauge-name">并发槽位</span>
          <span className="m-gauge-detail">
            {queue ? (
              <>
                <span className="tabular">
                  {queue.running} / {queue.slots} 在跑
                </span>
                <span className="sep">·</span>排队{' '}
                <strong className="tabular">{queue.pending}</strong> 条
              </>
            ) : (
              '—'
            )}
          </span>
        </div>

        <div className="m-gauge">
          <span className="m-gauge-glyph">
            <RingGauge
              ratio={quotaRatio}
              label={pendingData ? '…' : percentText(quotaPercent)}
              tone={quotaTone}
              ariaLabel="云端解析今日页数"
            />
          </span>
          <span className="m-gauge-name">云端解析额度</span>
          <span className="m-gauge-detail tabular">
            {pendingData
              ? '读取中…'
              : quota?.configured
                ? `${quota.pages_used} / ${quota.daily_quota} 页`
                : '未配置'}
          </span>
        </div>

        <div className="m-gauge">
          <span className="m-gauge-glyph">
            <span className="m-gauge-figure tabular">
              {hardware ? formatBytes(hardware.process_rss_bytes) : '—'}
            </span>
          </span>
          <span className="m-gauge-name">
            本进程常驻内存
            <InfoTip text="切词与向量化都在这个进程里跑，所以它随摄入进度变大是正常的。只涨不落时重启服务即可——那是内存没被释放，不是任务出错了。" />
          </span>
          <span className="m-gauge-detail tabular">
            {processShare ? `占机器内存 ${processShare}` : '—'}
          </span>
        </div>
      </div>

      {/* 排队构成与最久的等待：只在真有积压时出现（平时排队是 0，常驻就是噪音） */}
      {queue && queue.pending > 0 && (pendingKinds.length > 0 || oldestWait) && (
        <p className="m-load-note">
          {pendingKinds.length > 0 && (
            <>排队的构成：{pendingKinds.map((item) => `${item.label} ${item.count}`).join('、')}</>
          )}
          {oldestWait && (
            <>
              {pendingKinds.length > 0 && '，'}最久的已等 <strong>{oldestWait}</strong>
            </>
          )}
        </p>
      )}

      {oversubscribed ? (
        <p className="m-load-hint">
          在跑数超过了上限：多半是有一个刚被中断的任务还没到租约到期时间，回收后它会自己回到队列（约一分钟内）。
        </p>
      ) : (
        queue &&
        queue.pending > 0 &&
        queue.running >= queue.slots && (
          <p className="m-load-hint">
            槽位已占满，后面的要等前一个跑完。上限由 <code>KYLAB_WORKER_CONCURRENCY</code> 决定。
          </p>
        )
      )}
      {quota?.configured && quota.exhausted ? (
        <p className="m-load-hint">
          额度已用尽：云端不再优先处理，解析会明显变慢（<strong>不是失败</strong>）。
        </p>
      ) : (
        !pendingData &&
        quota &&
        !quota.configured && (
          <p className="m-load-hint">未配置云端解析令牌：所有文件都走本地解析，不消耗额度。</p>
        )
      )}

      {problems.length > 0 && <p className="m-load-problem">{problems.join('；')}</p>}
    </section>
  )
}
