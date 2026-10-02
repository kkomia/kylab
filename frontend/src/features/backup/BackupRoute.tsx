/**
 * 「备份」页的路由守卫（M5 阶段 7）。
 *
 * ## 它挡住什么（只有一条，而且**不是**"提供者连不上"）
 *
 * 判据是**这一档有没有本机后端**（`backupGateApplies()`），不是"备份提供者 ready"：
 * 连不上的时候**正是**要看"有几份没备上去、为什么没成"的时候，把它挡在门外是最糟的
 * 处置（`GET /local/backup` 那半本机账与提供者状态无关，是后端刻意分开给的两半）。
 *
 * | 情形 | 这一层怎么处置 |
 * | --- | --- |
 * | **不是本机档**（服务器档 / 浏览器档 / 显式关掉本机数据面） | 一句说明顶上，不渲染页面（这一档的备份就是它自己） |
 * | 本机档、**还没读到第一份结论** | 一行"正在确认…"（首屏那次读的窗口，不闪一个报错的页面） |
 * | 本机档、读到过结论 | **放行**——哪怕 `state` 是 `unavailable` / `unconfigured` |
 *
 * 为什么不照知识库那条守卫（不可用就重定向 + toast）：那条挡的是"页面本身打不开"
 * （知识库内容全在 NAS 上）；这一页的内容**一半在本机**，而且"出事了"正是它的主场景。
 * 服务器档那一档也不重定向：那一档 `/backup` 根本不是一条错地址，给一句说明比把人
 * 弹去对话页更清楚（与设置里那一节"只有本机档才有"的说法同一口径）。
 */
import { useBackupStatus } from '@/api/backup'

import { PageShell, SkeletonBlock } from '@/features/misc/shared/composites'

export function BackupRoute({ children }: { children: React.ReactNode }) {
  const view = useBackupStatus()

  if (!view.gate) {
    return (
      <PageShell title="备份">
        <p className="m-row-note">
          「备份」只有本机档（桌面壳）才有：这一档的数据在这台机器上，备份的目的地是别处。
        </p>
      </PageShell>
    )
  }

  if (!view.settled) {
    return (
      <PageShell title="备份">
        <SkeletonBlock variant="text" rows={3} />
      </PageShell>
    )
  }

  return <>{children}</>
}
