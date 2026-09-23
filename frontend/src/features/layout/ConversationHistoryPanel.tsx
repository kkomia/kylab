/**
 * 历史会话面板（v0.17）——与旧前端 `components/layout/ConversationHistoryPanel.vue`
 * 逐条对应，版式仍照 kimi 的参考图（那些数字是量出来的，不是估的）。
 *
 * | 元素 | 值 |
 * | --- | --- |
 * | 面板 | 占满内容区，抬起来的白底，右上角一个关闭 × |
 * | 标题「历史会话」 | 24px / 600，距顶 52px |
 * | 搜索框 | 高 48px、圆角 10px、**填充底（无边框）**、放大镜在左 |
 * | 内容列宽 | 上限 940px（再宽一行字太长，回看时读不进去） |
 * | 分组标签（本周） | 14px / 灰、组间留 48px |
 * | 条目标题 | 16px / 500；右侧同为 16px 的日期标签 |
 * | 条目预览 | 14px / 灰 / **两行截断** |
 * | 条目间距 | 上下各 14px（靠留白分隔，**没有分隔线**） |
 *
 * 三处刻意的决定（旧版写下、这里照办）：
 *
 * 1. **预览给的是最近一条回答**，不是提问——回看时想认出的是"这次聊出了什么"；
 * 2. **分组用相对时间**（今天/昨天/本周/本月/更早）而不是月份：回看是"最近聊的那次"
 *    这类模糊记忆，不是"我要找 3 月的记录"；
 * 3. **归档不是删除**：它是"收起来"，所以菜单里写「归档」而不是「删除」，
 *    且归档视图里能一键取消。
 *
 * 取数**自己按需拉一份带预览的清单**（`loadDetailList`），不复用侧栏那份：
 * 侧栏那份不带预览（预览要多一次查询）且只拉 50 条。
 *
 * 两处与旧版实现上的差（行为不变、各修掉一个旧版的粗糙处）：
 *
 * - 左侧让位按**当前**侧栏宽度算（折叠态 60px）：旧版固定写 `--sidebar-width`，
 *   折叠之后面板左边会留一条 180px 的内容区；现在两侧始终贴合；
 * - 列表里的「⋯」用 `@/ui/dropdown-menu`（Radix），Esc / 点外部 / 翻向都由它管，
 *   不必再照抄旧版 `RowMenu` 里那几段手写定位。
 */
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { RiCloseLine, RiPushpin2Line, RiSearchLine } from '@remixicon/react'
import { toast } from 'sonner'

import type { ConversationSummary } from '@/api/conversations'
import { Input } from '@/ui/input'
import { Skeleton } from '@/ui/skeleton'

import { prefetchConversationDetail } from '@/features/chat/runtime/useChatData'
import { ConversationRowMenu } from './ConversationRowMenu'
import { useConversationStore } from './conversations'

/** 与侧栏同一档防抖：300ms。输入时不打请求，停手才打。 */
const SEARCH_DEBOUNCE_MS = 300

const GROUPS = ['今天', '昨天', '本周', '本月', '更早'] as const
type GroupLabel = (typeof GROUPS)[number]

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function startOfDay(at: Date): Date {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate())
}

/** 参考图里右侧那列就是「星期一」这种星期几。 */
function weekdayLabel(at: Date): string {
  return `星期${'日一二三四五六'[at.getDay()]}`
}

/** 一条会话属于哪一组 + 它的日期标签。**相对时间**：回看是模糊记忆。 */
function bucketOf(item: ConversationSummary): { group: GroupLabel; label: string } {
  const raw = item.updated_at
  if (!raw) return { group: '更早', label: '' }
  const at = new Date(raw)
  if (Number.isNaN(at.getTime())) return { group: '更早', label: '' }
  const days = Math.round(
    (startOfDay(new Date()).getTime() - startOfDay(at).getTime()) / 86_400_000,
  )
  if (days <= 0) return { group: '今天', label: '今天' }
  if (days === 1) return { group: '昨天', label: '昨天' }
  if (days < 7) return { group: '本周', label: weekdayLabel(at) }
  if (days < 31) return { group: '本月', label: `${at.getMonth() + 1}月${at.getDate()}日` }
  return {
    group: '更早',
    label: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`,
  }
}

/** 预览：压平 Markdown 记号，只留可读文字（参考图里那两行是纯文本）。 */
export function previewOf(item: ConversationSummary): string {
  return (item.preview || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/[*_`>]/g, '')
    .replace(/^[\s\-*\d.]+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function ConversationHistoryPanel({
  open,
  onClose,
  sidebarWidth,
}: {
  open: boolean
  onClose: () => void
  /** 面板左侧要让给侧栏的宽度（折叠态是 60px）。 */
  sidebarWidth: string
}) {
  const queryClient = useQueryClient()
  const loadDetailList = useConversationStore((state) => state.loadDetailList)
  const detailItems = useConversationStore((state) => state.detailItems)

  const [draft, setDraft] = useState('')
  const [search, setSearch] = useState('')
  const [archivedView, setArchivedView] = useState(false)
  const [loading, setLoading] = useState(false)

  const load = useCallback(
    async (query: string, archived: boolean): Promise<void> => {
      setLoading(true)
      try {
        await loadDetailList({ q: query, archived, withPreview: true })
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '读取会话失败')
      } finally {
        setLoading(false)
      }
    },
    [loadDetailList],
  )

  /**
   * 打开就拉一次（**含"一挂载就是开着的"这个形态**：旧版用 `watch(…, { immediate: true })`
   * 补的就是这一条——少了它，带着 `open=true` 挂载的页面永远是空的）。
   * 同时把搜索词与视图复位：每次打开都该是"全部、没筛选"的初始态。
   *
   * **只有这一个入口负责首拉**：视图切换与搜索各自在事件里显式拉（见下），
   * 不写成"监听 archivedView 的 effect"——那样每次打开都会因为复位而多打一次请求。
   */
  useEffect(() => {
    if (!open) return
    setDraft('')
    setSearch('')
    setArchivedView(false)
    void load('', false)
  }, [open, load])

  /**
   * Esc 收起：与原生 `<dialog>` 和两个抽屉同一套手势（v0.26）。
   *
   * 它是一块盖住内容区的浮层，用户要关掉它不该只剩"去右上角找那个 ×"。
   * 挂在 window 上而不是根元素上：焦点可能在搜索框里，根元素收不到那次 keydown。
   * **开着才处理**——不加这道判断的话，关着的时候按 Esc 也会关一次别的东西。
   *
   * 多一句 `defaultPrevented`：面板里的行菜单会开出重命名 / 删除弹窗，那些弹窗自己
   * 也要吃 Esc（Radix 在 **capture 阶段**就 `preventDefault` 了）。认这一条之后，
   * 一次 Esc 只关最内层那个，面板留在原地——不会连人带面板一起关掉、丢了位置。
   */
  useEffect(() => {
    if (!open) return
    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      onClose()
    }
    window.addEventListener('keydown', onKeydown)
    return () => window.removeEventListener('keydown', onKeydown)
  }, [open, onClose])

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  function onSearchInput(value: string): void {
    setDraft(value)
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      const next = value.trim()
      setSearch(next)
      void load(next, archivedView)
    }, SEARCH_DEBOUNCE_MS)
  }

  function clearSearch(): void {
    if (timer.current !== null) clearTimeout(timer.current)
    setDraft('')
    setSearch('')
    void load('', archivedView)
  }

  /** 切「全部 / 已归档」：立刻按新视图拉一次（不等防抖）。 */
  function changeView(archived: boolean): void {
    if (archived === archivedView) return
    setArchivedView(archived)
    void load(search, archived)
  }

  useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current)
    }
  }, [])

  const grouped = useMemo(
    () =>
      GROUPS.map((group) => ({
        label: group,
        items: detailItems.filter((item) => bucketOf(item).group === group),
      })).filter((entry) => entry.items.length > 0),
    [detailItems],
  )

  if (!open) return null

  const emptyTitle = search ? '没有匹配的会话' : archivedView ? '还没有归档的会话' : '还没有会话'
  const emptyHint = search
    ? '换个关键词试试，或者清空搜索。'
    : archivedView
      ? '归档是把不看了的会话收起来——它不是删除，随时可以取消归档。'
      : '在对话里提问之后，记录会出现在这里。'

  return (
    <section
      role="dialog"
      aria-label="历史会话"
      className="fixed inset-y-0 right-0 z-40 overflow-y-auto bg-[var(--bg-surface)]"
      style={{ left: sidebarWidth }}
    >
      <button
        type="button"
        aria-label="关闭"
        className="absolute top-4 right-5 inline-flex size-9 items-center justify-center rounded-[var(--radius-icon-button)] text-text-secondary transition-colors hover:bg-[var(--bg-hover)] hover:text-text-primary"
        onClick={onClose}
      >
        <RiCloseLine size={20} aria-hidden="true" />
      </button>

      <div className="max-w-[940px] pt-[52px] pr-6 pb-16 pl-[clamp(48px,12%,190px)]">
        <h2 className="mb-8 text-[24px] leading-[1.3] font-semibold">历史会话</h2>

        {/* 搜索框：**填充底、无边框**（参考图里它是一块浅灰），高 48px、圆角 10px */}
        <div className="relative mb-4 flex items-center">
          <RiSearchLine
            size={18}
            className="pointer-events-none absolute left-4 text-text-tertiary"
            aria-hidden="true"
          />
          <Input
            value={draft}
            placeholder="搜索历史会话"
            aria-label="搜索历史会话"
            className="h-12 border-0 bg-[var(--bg-subtle)] pl-[46px] text-[length:var(--text-body-size)] focus-visible:border-0"
            onChange={(event) => onSearchInput(event.target.value)}
          />
          {draft && (
            <button
              type="button"
              aria-label="清除搜索"
              className="absolute right-3 inline-flex size-6 items-center justify-center rounded-control text-text-tertiary transition-colors hover:text-text-primary"
              onClick={clearSearch}
            >
              <RiCloseLine size={16} aria-hidden="true" />
            </button>
          )}
        </div>

        {/* 全部 / 已归档：两枚小切换，安静地待在搜索框下面 */}
        <div className="mb-6 flex gap-1">
          {([false, true] as const).map((archived) => (
            <button
              key={String(archived)}
              type="button"
              className={
                archived === archivedView
                  ? 'h-7 rounded-control bg-[var(--bg-selected)] px-3 text-[length:var(--text-micro-size)] text-text-primary'
                  : 'h-7 rounded-control px-3 text-[length:var(--text-micro-size)] text-text-tertiary transition-colors hover:text-text-primary'
              }
              aria-pressed={archived === archivedView}
              onClick={() => changeView(archived)}
            >
              {archived ? '已归档' : '全部'}
            </button>
          ))}
        </div>

        {loading && (
          <div className="flex flex-col gap-3" aria-hidden="true">
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} className="h-14 w-full rounded-row" />
            ))}
          </div>
        )}

        {!loading && grouped.length === 0 && (
          <div className="flex flex-col gap-2 py-8">
            <p className="text-[length:var(--text-section-size)] text-text-primary">{emptyTitle}</p>
            <p className="text-[length:var(--text-meta-size)] text-text-tertiary">{emptyHint}</p>
          </div>
        )}

        {!loading && grouped.length > 0 && (
          <div className="flex flex-col">
            {grouped.map((group, index) => (
              <section key={group.label} className={index > 0 ? 'mt-12' : undefined}>
                <h3 className="mb-3 text-[length:var(--text-meta-size)] text-text-tertiary">
                  {group.label}
                </h3>
                <ul>
                  {group.items.map((item) => (
                    <li
                      key={item.id}
                      className="ly-entry relative rounded-row transition-colors hover:bg-[var(--bg-hover)]"
                    >
                      {/* 点一条就进去，面板顺手关掉（旧版同一条：进去之后它已经没有意义） */}
                      <Link
                        to={`/chat/${item.id}`}
                        className="flex flex-col gap-2 py-[14px] pr-3 pl-2 text-text-primary no-underline"
                        onClick={onClose}
                        onMouseEnter={() => prefetchConversationDetail(queryClient, item.id)}
                        onFocus={() => prefetchConversationDetail(queryClient, item.id)}
                      >
                        <span className="flex items-baseline justify-between gap-4 pr-6">
                          <span className="inline-flex min-w-0 items-center gap-1.5 overflow-hidden text-[length:var(--text-section-size)] font-medium text-ellipsis whitespace-nowrap text-text-primary">
                            {item.pinned && (
                              <RiPushpin2Line
                                size={13}
                                className="shrink-0 text-text-tertiary"
                                aria-hidden="true"
                              />
                            )}
                            {item.title || '未命名对话'}
                          </span>
                          <span className="shrink-0 text-[length:var(--text-section-size)] text-text-tertiary">
                            {bucketOf(item).label}
                          </span>
                        </span>
                        <span className="ly-entry-preview text-[length:var(--text-meta-size)] leading-[var(--line-ui)] text-text-tertiary">
                          {previewOf(item) || '（还没有回答）'}
                        </span>
                      </Link>

                      {/* 与侧栏**同一个组件**：五个动作、重命名与删除的弹窗都在它里面，
                          两处不会再分叉 */}
                      <div className="ly-entry-menu">
                        <ConversationRowMenu
                          item={item}
                          onChanged={() => void load(search, archivedView)}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
