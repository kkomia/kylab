/**
 * 变更流时间线（§6.2）：倒序，每条 `时间 · 动作 · 分区 · 旧值 → 新值 · 来源`，
 * 带一个「还原」（把旧值写回档案，新值作为一次新的顶替进流）。
 *
 * 两条刻意的口径：
 *
 * 1. **不可编辑、不可删除**（§6.2 建议）：它是记录，不是第二个可写清单——要改档案
 *    去档案卡上改，这里只回答"改过什么、能不能退回去"；
 * 2. **倒序由后端给**（`GET /memory/changes` 已经倒序）：前端不重排，免得两个
 *    "最新的在哪头"各说各的。`index` 是它在文件里的位置（最旧为 0），
 *    档案卡的来源小字靠它指过来。
 */
import { useEffect } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { RotateCcw } from 'lucide-react'

import { restoreMemory, type MemoryChange } from '@/api/memory'
import { Button } from '@/ui/button'

import { EmptyState } from '../shared/composites'
import { notifyError, notifySuccess } from '../shared/toast'

export interface ChangeTimelineProps {
  changes: MemoryChange[]
  /** 从档案卡跳过来的那一条（高亮并滚到视野内）。 */
  highlight: number | null
}

export function ChangeTimeline({ changes, highlight }: ChangeTimelineProps) {
  const queryClient = useQueryClient()

  const restore = useMutation({
    mutationFn: (text: string) => restoreMemory(text),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['memory', 'archive'] })
      await queryClient.invalidateQueries({ queryKey: ['memory', 'changes'] })
      await queryClient.invalidateQueries({ queryKey: ['memory', 'overview'] })
      notifySuccess(result.receipt)
    },
    onError: (error: unknown) => notifyError(messageOf(error)),
  })

  useEffect(() => {
    if (highlight === null) return
    document.getElementById(`change-${highlight}`)?.scrollIntoView({ block: 'nearest' })
  }, [highlight])

  return (
    <section className="m-timeline" data-testid="change-timeline" aria-label="变更流">
      <h2 className="m-timeline-title">变更流</h2>
      {changes.length === 0 ? (
        <EmptyState title="还没有改动" hint="在档案卡上改一条，这里就会出现它的旧值。" />
      ) : (
        <ol className="m-changes">
          {changes.map((change) => (
            <li
              className="m-change"
              data-testid="change-item"
              data-action={change.action}
              data-highlight={change.index === highlight}
              id={`change-${change.index}`}
              key={change.index}
            >
              <div className="m-change-head">
                <span className="m-change-meta">
                  <span className="tabular">{change.at}</span>
                  <span className="m-change-action">{change.action}</span>
                  {change.section && <span>{change.section}</span>}
                  {change.source && <span>{change.source}</span>}
                </span>
                {change.restorable && (
                  <Button
                    variant="outline"
                    size="xs"
                    data-testid="change-restore"
                    disabled={restore.isPending}
                    onClick={() => restore.mutate(change.old)}
                  >
                    <RotateCcw size={12} />
                    还原
                  </Button>
                )}
              </div>
              <dl className="m-change-values">
                {change.old && (
                  <div className="m-change-line">
                    <dt>旧</dt>
                    <dd data-testid="change-old">{change.old}</dd>
                  </div>
                )}
                {change.new && (
                  <div className="m-change-line">
                    <dt>新</dt>
                    <dd data-testid="change-new">{change.new}</dd>
                  </div>
                )}
              </dl>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
