/**
 * 记忆页（v0.57；后端是 mem0。2026-10-09 按 mem0 生态的形态重排）。
 *
 * 从上到下就是用户做事的顺序，四块：
 *
 * 1. **页头**：标题 + 极简读数（`N 条 · 上次更新 …` + 一个状态点）+ 两个动作
 *    （「加一条」是**唯一**的写入口、「设置」开记忆那一组引擎配置）；
 * 2. **检索行**：回车才检索（一次语义检索，不是在本地数组上扫一遍）；
 * 3. **分类筛选行**：条目上已有的分区标签，单选即过滤（本地过滤，一条 ≤200 条）；
 * 4. **条目列表**：正文行内编辑、行尾历史与删除（见 `MemoryItemList`）。
 *
 * 三条纪律写在页面的每个角落：
 *
 * 1. **只给读数与事实**：条数、时间、分区标签、来源；不解释分区是干什么的，
 *    不说它会被注入提示词，不显示 token；
 * 2. **记忆的读写不看开关**：`memory.enabled` 关着时这一页照旧能改，
 *    只有注入与检索停下——所以这里没有"未启用就不能编辑"这种闸。
 *    **搜索那一条不同**：它就是检索，关着时后端会明确报错（如实说出来）；
 * 3. **旧档案只剩一条一次性的路**：`GET /memory` 说"还有可导的"时页头上出现一条
 *    横幅（搬完或不再需要就消失），不再是一个常驻入口。
 *
 * **人设文件不在这里**（`SOUL.md` / `AGENTS.md` 是每轮在场的设定，属于人设层）：
 * 原先这页上那节只读的「人设文件」连同 `GET /memory/files/{path}` 一起删了
 * ——它们是"设定"，不是"记忆"，摆在记忆页上只会让人以为改那里等于改记忆。
 */
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, Plus, Settings2, X } from 'lucide-react'

import {
  createMemoryItem,
  getMemory,
  getMemoryItems,
  importLegacyMemory,
  type MemoryImport,
} from '@/api/memory'
import { formatDate, formatRelativeTime } from '@/lib/format'
import { useIsAdmin } from '@/lib/useIsAdmin'
import { Button } from '@/ui/button'
import { Input } from '@/ui/input'
import { Textarea } from '@/ui/textarea'

import { SettingGroupPanel } from '../settings/SettingGroupPanel'
import { Modal, Notice, PageShell, SkeletonBlock } from '../shared/composites'
import { notifyError, notifySuccess } from '../shared/toast'
import { MemoryItemList } from './MemoryItemList'

export function MemoryPage() {
  const queryClient = useQueryClient()
  /**
   * 页头那颗「设置」（记忆那一组字段）只给管理员：它是管理员端点 `/settings`。
   */
  const isAdmin = useIsAdmin()

  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  /** 分区筛选：空串 = 全部（单选）。 */
  const [section, setSection] = useState('')
  const [adding, setAdding] = useState(false)
  const [addDraft, setAddDraft] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  const [report, setReport] = useState<MemoryImport | null>(null)
  /**
   * "不再需要这条横幅"：只活在这一屏（刷新即回到后端的事实）。
   * 后端说没了（搬过 / 本来就没有）时它自己就消失，这个标记只是让不想导的人也能收掉它。
   */
  const [bannerClosed, setBannerClosed] = useState(false)

  const overview = useQuery({ queryKey: ['memory', 'overview'], queryFn: getMemory })
  const items = useQuery({
    queryKey: ['memory', 'items', query],
    queryFn: () => getMemoryItems(query),
  })

  const migrate = useMutation({
    mutationFn: importLegacyMemory,
    onSuccess: async (result) => {
      setReport(result)
      setReportOpen(true)
      await queryClient.invalidateQueries({ queryKey: ['memory', 'items'] })
      await queryClient.invalidateQueries({ queryKey: ['memory', 'overview'] })
      notifySuccess(result.skipped ? '没有新的旧条目' : `导入 ${result.imported} 条`)
    },
    onError: (error: unknown) => notifyError(messageOf(error)),
  })

  const add = useMutation({
    mutationFn: (content: string) => createMemoryItem(content),
    onSuccess: async (result) => {
      setAdding(false)
      setAddDraft('')
      await queryClient.invalidateQueries({ queryKey: ['memory', 'items'] })
      await queryClient.invalidateQueries({ queryKey: ['memory', 'overview'] })
      // `existing` / `rejected` 也不是错误，回执照旧弹出来（后端说清了为什么）
      notifySuccess(result.receipt)
    },
    onError: (error: unknown) => notifyError(messageOf(error)),
  })

  const status = overview.data?.status ?? null
  const all = useMemo(() => items.data?.items ?? [], [items.data])
  /**
   * 分区标签从**当前这一屏的条目**上取（后端不另给一份分区清单），
   * 顺序是它们在列表里第一次出现的顺序——列表是"最近改的在前"，
   * 于是最常动的那一区排在最前，不必在前端硬编一份分区顺序。
   */
  const sections = useMemo(() => {
    const seen: string[] = []
    for (const item of all) {
      if (item.section && !seen.includes(item.section)) seen.push(item.section)
    }
    return seen
  }, [all])
  const visible = section ? all.filter((item) => item.section === section) : all

  /** 检索与"全部"是两种视图：换一次检索就把分区筛选收回去（它属于上一屏）。 */
  const runSearch = (value: string) => {
    setQuery(value)
    setSection('')
  }

  const statusTone = status?.enabled ? 'ok' : 'off'
  const statusLabel = !status ? '读取中' : status.enabled ? '已启用' : '未启用'

  return (
    <PageShell
      title="记忆"
      actions={
        <>
          <span className="m-status" data-testid="memory-status">
            <span
              className="m-status-dot"
              data-testid="memory-status-dot"
              data-tone={statusTone}
              role="img"
              aria-label={statusLabel}
              title={statusLabel}
            />
            {status && (
              <>
                <span className="m-readout" data-testid="memory-count">
                  {status.items} 条
                </span>
                {status.last_changed_at && (
                  <>
                    <span className="m-readout" aria-hidden="true">
                      ·
                    </span>
                    <span
                      className="m-readout"
                      data-testid="memory-updated"
                      title={formatDate(status.last_changed_at)}
                    >
                      上次更新 {formatRelativeTime(status.last_changed_at)}
                    </span>
                  </>
                )}
                {status.development && (
                  <span className="m-muted" data-testid="memory-development">
                    还没配嵌入模型，检索只按字面重合（开发兜底）
                  </span>
                )}
              </>
            )}
          </span>
          <Button data-testid="memory-add" onClick={() => setAdding(true)}>
            <Plus size={14} />
            加一条
          </Button>
          {isAdmin && (
            <Button
              variant="outline"
              data-testid="memory-settings"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings2 size={14} />
              设置
            </Button>
          )}
        </>
      }
    >
      <div className="m-page-body">
        {overview.isError && (
          <Notice tone="error" icon={<AlertCircle size={15} />}>
            {messageOf(overview.error)}
          </Notice>
        )}

        {status?.legacy_import_available && !bannerClosed && (
          <div className="m-migrate" data-testid="migration-banner">
            <span>旧档案里还有没搬过来的记忆，可以一次性搬进来（旧文件不动）。</span>
            <Button
              variant="outline"
              size="sm"
              data-testid="migration-run"
              disabled={migrate.isPending}
              onClick={() => migrate.mutate()}
            >
              {migrate.isPending ? '导入中…' : '导入旧档案'}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="不再导入"
              data-testid="migration-dismiss"
              onClick={() => setBannerClosed(true)}
            >
              <X size={14} />
            </Button>
          </div>
        )}

        {adding && (
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
        )}

        <div className="m-search">
          <Input
            data-testid="memory-search"
            placeholder="搜记忆…（回车检索）"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                runSearch(search.trim())
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                setSearch('')
                runSearch('')
              }
            }}
          />
          {(query || search) && (
            <Button
              variant="ghost"
              size="sm"
              data-testid="memory-search-clear"
              onClick={() => {
                setSearch('')
                runSearch('')
              }}
            >
              清空
            </Button>
          )}
        </div>

        {sections.length > 0 && (
          <div className="m-filters" data-testid="memory-sections">
            <button
              type="button"
              className={section ? 'm-filter' : 'm-filter m-filter-on'}
              data-testid="memory-section-chip"
              aria-pressed={!section}
              onClick={() => setSection('')}
            >
              全部
            </button>
            {sections.map((name) => (
              <button
                type="button"
                className={section === name ? 'm-filter m-filter-on' : 'm-filter'}
                data-testid="memory-section-chip"
                aria-pressed={section === name}
                key={name}
                onClick={() => setSection(name)}
              >
                {name}
              </button>
            ))}
          </div>
        )}

        {items.isError ? (
          <div data-testid="memory-items-error">
            <Notice tone="error" icon={<AlertCircle size={15} />}>
              {messageOf(items.error)}
            </Notice>
          </div>
        ) : items.isLoading ? (
          <SkeletonBlock variant="list" rows={4} />
        ) : (
          <MemoryItemList items={visible} searching={Boolean(query)} query={query} />
        )}
      </div>

      <Modal open={reportOpen} title="导入报告" onClose={() => setReportOpen(false)} size="sm">
        {report && (
          <dl className="m-report" data-testid="migration-report">
            <div>
              <dt>读到</dt>
              <dd>{report.entries} 条</dd>
            </div>
            <div>
              <dt>导入</dt>
              <dd>{report.imported} 条</dd>
            </div>
            {report.existing > 0 && (
              <div>
                <dt>已有</dt>
                <dd>{report.existing} 条</dd>
              </div>
            )}
            {report.dropped_sensitive > 0 && (
              <div>
                <dt>丢弃（敏感）</dt>
                <dd>{report.dropped_sensitive} 条</dd>
              </div>
            )}
            <div>
              <dt>源文件</dt>
              <dd>{report.source || '（没有）'}</dd>
            </div>
          </dl>
        )}
      </Modal>

      <Modal open={settingsOpen} title="记忆设置" onClose={() => setSettingsOpen(false)} size="md">
        <SettingGroupPanel keys={['memory']} />
      </Modal>
    </PageShell>
  )
}

/**
 * 时间**一律按本机时区显示**（两个件都来自 `lib/format`）。
 *
 * 后端给的是 ISO（UTC），上一代直接把它切成 `YYYY-MM-DD HH:mm` 打在界面上——
 * 那串数字是 UTC，比本机早 8 小时（用户看到的"上次更新"永远对不上自己的表）。
 * 现在读数与条目行尾用 `formatRelativeTime`（刚刚 / 3 分钟前 / 超过一周给本地日期），
 * 想把确切时刻拿在手上就 hover——`title` 里是 `formatDate` 给的本地绝对时间。
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
