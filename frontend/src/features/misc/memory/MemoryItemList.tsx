/**
 * 记忆条目列表（v0.57，设计口径见 D9）。
 *
 * 这一块只回答一件事：**记忆里现在有什么**。一条一行，每行给出
 *
 * - 正文（**点一下变输入框**，失焦保存 = 一次 `PATCH`，按 id 走）；
 * - 分区标签与来源、时间（事实，不解释它们是怎么产生的）；
 * - 行尾两个动作：**看历史**（只读）与**删除**。
 *
 * 三条与界面无关、但决定了这里每一行怎么写的口径：
 *
 * 1. **id 是这条记忆的句柄**：改与删都按它走（`updateMemoryItem` /
 *    `deleteMemoryItem`）——所以列表项上带 `data-id`，而正文可以重复；
 * 2. **回执用后端那一句**：每次写入的结果里带 `receipt`，界面直接把它弹出来，
 *    不另编（模型从工具听到的是同一句）；
 * 3. **不做本地过滤与排序**：列表顺序是后端给的（最近改的在前），
 *    而"查"是**一次检索**（搜索框那一条路），不是在这份数组上扫一遍——
 *    两者混起来会让"搜不到"变成"这一页里没搜到"。
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { History, Plus, Trash2 } from 'lucide-react'

import {
  createMemoryItem,
  deleteMemoryItem,
  getMemoryItemHistory,
  updateMemoryItem,
  type MemoryItem,
} from '@/api/memory'
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
  /** 搜索框里那句话（空态里要说清"没有匹配到 X"）。 */
  query: string
}

export function MemoryItemList({ items, searching, query }: MemoryItemListProps) {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [adding, setAdding] = useState(false)
  const [addDraft, setAddDraft] = useState('')
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
      await refresh()
      notifySuccess(result.receipt)
    },
    onError: (error: unknown) => notifyError(messageOf(error)),
  })

  const add = useMutation({
    mutationFn: (content: string) => createMemoryItem(content),
    onSuccess: async (result) => {
      setAdding(false)
      setAddDraft('')
      await refresh()
      // `existing` / `rejected` 也不是错误，回执照旧弹出来（后端说清了为什么）
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
            title="没有匹配的条目"
            hint={query ? `没有提到「${query}」的条目。` : '换一个说法再搜。'}
          />
        ) : (
          <EmptyState title="记忆还是空的" hint="在下面写一条。" />
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
                  <span className="m-entry-when">
                    {SOURCE_LABELS[item.source] ?? ''}
                    {item.updated_at
                      ? `${item.source ? ' · ' : ''}${shortTime(item.updated_at)}`
                      : ''}
                  </span>
                </div>
              </div>
              <span className="m-entry-actions">
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
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(item.id)}
                >
                  <Trash2 size={14} />
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <div className="m-add-box">
          <Textarea
            data-testid="memory-add-input"
            autoFocus
            rows={2}
            placeholder="一句可复用的事实（怎么称呼对方、他的偏好、定下来的约定……）"
            value={addDraft}
            onChange={(event) => setAddDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                setAdding(false)
                setAddDraft('')
              }
            }}
          />
          <div className="m-add-actions">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setAdding(false)
                setAddDraft('')
              }}
            >
              取消
            </Button>
            <Button
              size="sm"
              data-testid="memory-add-save"
              disabled={!addDraft.trim() || add.isPending}
              onClick={() => add.mutate(addDraft.trim())}
            >
              记下来
            </Button>
          </div>
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          data-testid="memory-add"
          onClick={() => setAdding(true)}
        >
          <Plus size={14} />
          加一条
        </Button>
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
              <ul className="m-changes">
                {history.data.items.map((row) => (
                  <li
                    className="m-change"
                    data-testid="memory-history-row"
                    key={`${row.event}-${row.at}-${row.new}`}
                  >
                    <div className="m-change-meta">
                      <span className="m-change-action">
                        {EVENT_LABELS[row.event] ?? row.event}
                      </span>
                      <span>{shortTime(row.at)}</span>
                    </div>
                    <dl className="m-change-values">
                      {row.old && (
                        <div className="m-change-line">
                          <dt>旧</dt>
                          <dd>{row.old}</dd>
                        </div>
                      )}
                      {row.new && (
                        <div className="m-change-line">
                          <dt>新</dt>
                          <dd>{row.new}</dd>
                        </div>
                      )}
                    </dl>
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

function shortTime(value: string): string {
  // 后端给的是 ISO（UTC）；这里只到分钟——列表上一行里塞秒没有任何用处
  return value ? value.replace('T', ' ').slice(0, 16) : ''
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
