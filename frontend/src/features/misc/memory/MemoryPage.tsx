/**
 * 记忆页（v0.57；后端是 mem0，设计口径见 D9）。
 *
 * 一页三块：**条目列表**（主视图）+ 搜索框 + 迁移入口与人设文件。
 * 旧的两块（档案卡 / 变更流时间线）随档案制一起下线——分区读数、预算、变更流、
 * 还原、项目组改名都不是这一层的事实了。
 *
 * 这一页只回答两件事：**记忆里现在有什么**（条目，可改可删可看历史）与
 * **它在哪、是不是兜底**（状态读数）。两条纪律写在页面的每个角落：
 *
 * 1. **只给读数与事实**：条数、磁盘路径、时间、来源、分区标签；不解释分区是干什么的，
 *    不说它会被注入提示词，不显示 token；
 * 2. **记忆的读写不看开关**：`memory.enabled` 关着时这一页照旧能改，
 *    只有注入与检索停下——所以这里没有"未启用就不能编辑"这种闸。
 *    **搜索那一条不同**：它就是检索，关着时后端会明确报错（如实说出来）。
 *
 * 底下那两节是**辅助**：迁移入口（把旧 `PROFILE.md` 的四区条目一次性搬进来）与
 * 人设文件的只读查看（`SOUL.md` / `AGENTS.md` 仍每轮注入；`PROFILE.md` 不再注入，
 * 标签上写清这一点——不然用户会以为它还在起作用）。
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, FileText, Settings2 } from 'lucide-react'

import {
  getMemory,
  getMemoryFile,
  getMemoryItems,
  importLegacyMemory,
  type MemoryFileDetail,
  type MemoryImport,
} from '@/api/memory'
import { useIsAdmin } from '@/lib/useIsAdmin'
import { Button } from '@/ui/button'
import { Input } from '@/ui/input'

import { SettingGroupPanel } from '../settings/SettingGroupPanel'
import { Modal, Notice, PageShell, SkeletonBlock, StatusTag } from '../shared/composites'
import { notifyError, notifySuccess } from '../shared/toast'
import { MemoryItemList } from './MemoryItemList'

/**
 * 人设那一节的固定清单（**只读**）。
 *
 * 名字写死在这里是因为后端没有"列记忆文件"那个端点了：这三份是**我们知道会存在**
 * 的（`SOUL.md` / `AGENTS.md` 由启动时播种，`PROFILE.md` 是旧盘上那份）。
 * 逐份读、读不到就不显示——不做一份新端点只为喂一个三行的清单。
 *
 * `injected` 是那一份**进不进每轮提示词**：人设两份进，旧档案不进（它已经不是
 * 记忆本体了）。界面必须说清这件事，否则用户会以为改它还管用。
 */
export const PERSONA_FILES: { name: string; label: string; injected: boolean }[] = [
  { name: 'SOUL.md', label: '人格', injected: true },
  { name: 'AGENTS.md', label: '操作规程', injected: true },
  { name: 'PROFILE.md', label: '旧档案（不再注入）', injected: false },
]

export function MemoryPage() {
  const queryClient = useQueryClient()
  /**
   * 页头那颗「设置」（记忆那一组字段）只给管理员：它是管理员端点 `/settings`。
   */
  const isAdmin = useIsAdmin()

  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  const [report, setReport] = useState<MemoryImport | null>(null)
  const [fileOpen, setFileOpen] = useState<string | null>(null)

  const overview = useQuery({ queryKey: ['memory', 'overview'], queryFn: getMemory })
  const items = useQuery({
    queryKey: ['memory', 'items', query],
    queryFn: () => getMemoryItems(query),
  })
  const persona = useQuery({ queryKey: ['memory', 'persona'], queryFn: loadPersonaFiles })
  const original = useQuery({
    queryKey: ['memory', 'file', fileOpen ?? ''],
    queryFn: () => getMemoryFile(String(fileOpen)),
    enabled: fileOpen !== null,
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

  const status = overview.data?.status ?? null
  const statusView = !status
    ? { label: '读取中', tone: 'neutral' as const }
    : !status.enabled
      ? { label: '未启用', tone: 'neutral' as const }
      : { label: '已启用', tone: 'success' as const }

  return (
    <PageShell
      title="记忆"
      actions={
        <>
          <StatusTag label={statusView.label} tone={statusView.tone} />
          {isAdmin && (
            <Button onClick={() => setSettingsOpen(true)}>
              <Settings2 size={15} />
              设置
            </Button>
          )}
        </>
      }
    >
      {overview.isError && (
        <Notice tone="error" icon={<AlertCircle size={15} />}>
          {messageOf(overview.error)}
        </Notice>
      )}

      {status && (
        <div className="m-status" data-testid="memory-status">
          <span className="m-readout" data-testid="memory-count">
            {status.items} 条
          </span>
          <span className="m-path" data-testid="memory-workspace">
            {status.workspace}
          </span>
          {status.last_changed_at && (
            <span className="m-status-when" data-testid="memory-updated">
              上次更新 {status.last_changed_at.replace('T', ' ').slice(0, 16)}
            </span>
          )}
        </div>
      )}

      {status?.development && (
        <div data-testid="memory-development">
          <Notice tone="warn">
            还没配嵌入模型，检索走的是开发兜底（只按字面重合）。登记一个向量化模型之后，
            换说法说同一件事也能被搜到。
          </Notice>
        </div>
      )}

      <div className="m-search">
        <Input
          data-testid="memory-search"
          placeholder="搜一条记忆，回车检索（留空看全部）"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              setQuery(search.trim())
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              setSearch('')
              setQuery('')
            }
          }}
        />
        {query && (
          <Button
            variant="ghost"
            size="sm"
            data-testid="memory-search-clear"
            onClick={() => {
              setSearch('')
              setQuery('')
            }}
          >
            清空
          </Button>
        )}
      </div>

      {items.isError ? (
        <div data-testid="memory-items-error">
          <Notice tone="error" icon={<AlertCircle size={15} />}>
            {messageOf(items.error)}
          </Notice>
        </div>
      ) : items.isLoading ? (
        <SkeletonBlock variant="list" rows={4} />
      ) : (
        <MemoryItemList items={items.data?.items ?? []} searching={Boolean(query)} query={query} />
      )}

      <section className="m-persona" data-testid="memory-persona">
        <h2 className="m-section-title">人设文件（只读）</h2>
        {persona.data?.length ? (
          <ul className="m-persona-list">
            {persona.data.map((file) => (
              <li className="m-persona-item" data-testid="persona-file" key={file.name}>
                <button
                  type="button"
                  className="m-persona-open"
                  data-testid="persona-file-open"
                  onClick={() => setFileOpen(file.name)}
                >
                  <FileText size={14} />
                  {file.label}
                </button>
                <span className="m-persona-name" data-testid="persona-file-note">
                  {file.name}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-persona-empty" data-testid="memory-persona-empty">
            还没有人设文件（启动时会自动铺 `SOUL.md` 与 `AGENTS.md`）。
          </p>
        )}
      </section>

      <section className="m-migrate" data-testid="migration-entry">
        <span>旧档案（`PROFILE.md`）里那些条目可以一次性搬进来，旧文件不动。</span>
        <Button
          variant="outline"
          size="sm"
          data-testid="migration-run"
          disabled={migrate.isPending}
          onClick={() => migrate.mutate()}
        >
          {migrate.isPending ? '导入中…' : '导入旧档案'}
        </Button>
      </section>

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

      <Modal
        open={fileOpen !== null}
        title={fileOpen ?? ''}
        onClose={() => setFileOpen(null)}
        size="md"
      >
        <p className="m-original-path" data-testid="persona-file-path">
          {status?.workspace ? `${status.workspace}/${fileOpen}` : fileOpen}
        </p>
        <pre className="m-original-body" data-testid="persona-file-content">
          {original.data?.content ?? ''}
        </pre>
      </Modal>
    </PageShell>
  )
}

/**
 * 逐份读那三份人设文件，**读得到的才返回**。
 *
 * 404 是正常情况（新盘上没有 `PROFILE.md`），所以这里吞掉单个失败、只留成功的那几份；
 * 真实错误（500、网络）也同样吞掉——这一节是辅助信息，它读不出来不该让整页报错，
 * 而"某一份读不到"与"它不存在"在界面上是一回事（都是不显示）。
 */
export async function loadPersonaFiles(): Promise<
  { name: string; label: string; injected: boolean; detail: MemoryFileDetail }[]
> {
  const found = await Promise.all(
    PERSONA_FILES.map(async (file) => {
      try {
        return { ...file, detail: await getMemoryFile(file.name) }
      } catch {
        return null
      }
    }),
  )
  return found.filter((item) => item !== null)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
