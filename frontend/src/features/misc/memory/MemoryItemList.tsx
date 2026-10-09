/**
 * 记忆条目列表（v0.57，设计口径见 D9；2026-10-09 加行内二次确认、历史改时间线）。
 *
 * 这一块只回答一件事：**记忆里现在有什么**。一条一行，每行给出
 *
 * - 正文（**点一下变输入框**，失焦保存 = 一次 `PATCH`，按 id 走；`Esc` 取消）；
 * - 分区标签与来源、时间（事实，不解释它们是怎么产生的）；
 * - 行尾两个动作：**看历史**（只读，最旧在前的时间线）与**删除**
 *   （**行内二次确认**：先变成「删除？确认 / 取消」，点确认才发 `DELETE`）。
 *
 * **时间一律按本机时区**（`lib/format` 的 `formatRelativeTime` / `formatDate`）：
 * 后端给的是 ISO（UTC），上一代直接把那串数字切出来显示，于是"3 分钟前改的"看起来
 * 比本机的表早 8 小时。行尾小字用相对时间（超过一周自动退回本地日期），
 * `title` 里放 `formatDate` 的本地绝对时间——确切时刻仍然拿得到。
 *
 * 三条与界面无关、但决定了这里每一行怎么写的口径：
 *
 * 1. **id 是这条记忆的句柄**：改与删都按它走（`updateMemoryItem` /
 *    `deleteMemoryItem`）——所以列表项上带 `data-id`，而正文可以重复；
 * 2. **回执用后端那一句**：每次写入的结果里带 `receipt`，界面直接把它弹出来，
 *    不另编（模型从工具听到的是同一句）；
 * 3. **列表顺序是后端给的**（最近改的在前），这里不重排。"查"是上面搜索框那条
 *    检索路（一次语义检索），分区筛选那条本地过滤由页面做——两者都不改顺序。
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { History, Trash2 } from 'lucide-react'

import {
  deleteMemoryItem,
  getMemoryItemHistory,
  updateMemoryItem,
  type MemoryItem,
} from '@/api/memory'
import { formatDate, formatRelativeTime } from '@/lib/format'
import { Badge } from '@/ui/badge'
import { Button } from '@/ui/button'
import { Textarea } from '@/ui/textarea'

import { EmptyState, Modal } from '../shared/composites'
import { notifyError, notifySuccess } from '../shared/toast'

/** 来源 → 界面上那句话（事实，不解释它怎么发生的）。
    `隐式` 已经不会再有新的（自动捕获那条链 2026-10-09 删了），
    但库里可能还有按它写下的老行——映射留着，那是**历史数据**的读法。 */
const SOURCE_LABELS: Record<string, string> = {
  显式: '来自会话',
  隐式: '来自会话',
  界面: '界面直改',
  迁移: '来自旧档案',
}

/** 历史里那三步的名字（mem0 的动作名，翻成人话）。 */
const EVENT_LABELS: Record<string, string> = {
  ADD: '记下',
  UPDATE: '改成',
  DELETE: '删掉',
}

export interface MemoryItemListProps {
  items: MemoryItem[]
  /** 这一轮列表是"搜出来的"还是"全部"——决定空态那句话。 */
  searching: boolean
  /** 搜索框里那句话（空态里要说清"没有提到 X"）。 */
  query: string
}

export function MemoryItemList({ items, searching, query }: MemoryItemListProps) {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  /** 哪一个条目正在等"确认删除"（同一时刻只可能有一个）。 */
  const [confirming, setConfirming] = useState<string | null>(null)
  const [historyOf, setHistoryOf] = useState<MemoryItem | null>(null)

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['memory', 'items'] })
    await queryClient.invalidateQueries({ queryKey: ['memory', 'overview'] })
  }

  const save = useMutation({
    mutationFn: (payload: { id: string; content: string }) =>
      updateMemoryItem(payload.id, { content: payload.content }),
    onSuccess: async (result) => {
      setEditing(null)
      await refresh()
      notifySuccess(result.receipt)
    },
    onError: (error: unknown) => notifyError(messageOf(error)),
  })

  const remove = useMutation({
    mutationFn: (id: string) => deleteMemoryItem(id),
    onSuccess: async (result) => {
      setConfirming(null)
      await refresh()
      notifySuccess(result.receipt)
    },
    onError: (error: unknown) => notifyError(messageOf(error)),
  })

  /**
   * 历史是一条**按需读的只读查询**：没点开那一条就不发请求（靠 `enabled`）。
   * key 与列表那个 `['memory','items']` 分开——看历史不该让整页重新拉一遍。
   */
  const history = useQuery({
    queryKey: ['memory', 'item-history', historyOf?.id ?? ''],
    queryFn: () => getMemoryItemHistory(String(historyOf?.id)),
    enabled: historyOf !== null,
  })

  const submitEdit = () => {
    if (!editing) return
    const next = draft.trim()
    const current = items.find((item) => item.id === editing)
    if (!next || next === current?.text) {
      setEditing(null)
      return
    }
    save.mutate({ id: editing, content: next })
  }

  return (
    <section className="m-items" data-testid="memory-items">
      {items.length === 0 ? (
        searching ? (
          <EmptyState
            title="没有搜到"
            hint={query ? `没有提到「${query}」的记忆，换个说法再搜。` : '换个说法再搜。'}
          />
        ) : (
          <EmptyState title="还没有记忆" hint="说一句『记住…』，或点『加一条』。" />
        )
      ) : (
        <ul className="m-entries">
          {items.map((item) => (
            <li className="m-entry" data-testid="memory-item" data-id={item.id} key={item.id}>
              <div className="m-entry-body">
                {editing === item.id ? (
                  <Textarea
                    className="m-entry-input"
                    data-testid="memory-item-input"
                    autoFocus
                    rows={2}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={submitEdit}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        event.preventDefault()
                        setEditing(null)
                      }
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="m-entry-text"
                    data-testid="memory-item-text"
                    onClick={() => {
                      setEditing(item.id)
                      setDraft(item.text)
                    }}
                  >
                    {item.text}
                  </button>
                )}
                <div className="m-entry-meta" data-testid="memory-item-meta">
                  {item.section && (
                    <Badge variant="secondary" data-testid="memory-item-section">
                      {item.section}
                    </Badge>
                  )}
                  <span className="m-entry-when" title={formatDate(item.updated_at)}>
                    {SOURCE_LABELS[item.source] ?? ''}
                    {item.updated_at
                      ? `${item.source ? ' · ' : ''}${formatRelativeTime(item.updated_at)}`
                      : ''}
                  </span>
                </div>
              </div>
              <span className="m-entry-actions">
                {confirming === item.id ? (
                  <>
                    <span className="m-entry-ask">删除？</span>
                    <Button
                      variant="ghost"
                      size="xs"
                      data-testid="memory-item-delete-confirm"
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(item.id)}
                    >
                      确认
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      data-testid="memory-item-delete-cancel"
                      onClick={() => setConfirming(null)}
                    >
                      取消
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="历史"
                      data-testid="memory-item-history"
                      onClick={() => setHistoryOf(item)}
                    >
                      <History size={14} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="删除"
                      data-testid="memory-item-delete"
                      onClick={() => setConfirming(item.id)}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={historyOf !== null}
        title="这条记忆的历史"
        onClose={() => setHistoryOf(null)}
        size="md"
      >
        {historyOf && (
          <div className="m-history" data-testid="memory-history">
            <p className="m-history-lead" data-testid="memory-history-text">
              {historyOf.text}
            </p>
            {history.data?.items?.length ? (
              <ul className="m-timeline" data-testid="memory-history-rows">
                {history.data.items.map((row) => (
                  <li
                    className="m-timeline-item"
                    data-testid="memory-history-row"
                    data-event={row.event}
                    key={`${row.event}-${row.at}-${row.new}`}
                  >
                    <div className="m-timeline-meta">
                      <span className="m-timeline-action">
                        {EVENT_LABELS[row.event] ?? row.event}
                      </span>
                      <span title={formatDate(row.at)}>{formatRelativeTime(row.at)}</span>
                    </div>
                    <div className="m-timeline-values">
                      {row.old && (
                        <span className="m-timeline-old" data-testid="memory-history-old">
                          {row.old}
                        </span>
                      )}
                      {row.old && row.new && (
                        <span className="m-timeline-arrow" aria-hidden="true">
                          →
                        </span>
                      )}
                      {row.new && (
                        <span className="m-timeline-new" data-testid="memory-history-new">
                          {row.new}
                        </span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="m-history-empty" data-testid="memory-history-empty">
                {history.isLoading ? '读取中…' : '没有可看的历史'}
              </p>
            )}
          </div>
        )}
      </Modal>
    </section>
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
