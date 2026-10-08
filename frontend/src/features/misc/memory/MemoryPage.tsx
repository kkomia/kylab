/**
 * 记忆页（档案制三期，设计见 `docs/设计/记忆档案-设计-v0.1.md` §6）。
 *
 * **一页两块**：档案卡（主视图）+ 变更流时间线。旧的三分段（文件 / 图谱 / 召回试验）
 * 已下线（§6.3）——文件列表与整份文件编辑、图谱页、召回试验框、待整合标记、
 * 新建文件入口都不在这里了。
 *
 * 这一页只回答两件事：**档案现在是什么**（四个分区、条目、读数）与**它改过什么**
 * （变更流，可还原）。两条纪律写在页面的每个角落：
 *
 * 1. **只给读数与事实**（§6.1 的"不出现实现细节"）：条数、字数、磁盘路径、时间、来源；
 *    不解释分区是干什么的，不说它会被注入提示词，不显示 token；
 * 2. **档案的读写不看开关**（§7.3）：`memory.enabled` 关着时这一页照旧能改，
 *    只有注入与 recall 停下——所以这里没有"未启用就不能编辑"这种闸。
 *
 * 另外两块是迁移入口与只读旧档（§8）：检测到可折叠的旧数据时给「导入旧记忆」，
 * `import-draft.md` 有货时提示还有几条没进档案，`MEMORY.md` 存在时只读展示它
 * （供用户确认折叠结果，不可编辑）。
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, Settings2 } from 'lucide-react'

import {
  getMemory,
  getMemoryArchive,
  getMemoryChanges,
  getMemoryFile,
  migrateMemory,
  organizeMemoryDraft,
  rememberMemory,
  type MemoryDraftSuggestion,
  type MemoryMigration,
} from '@/api/memory'
import { useIsAdmin } from '@/lib/useIsAdmin'
import { Badge } from '@/ui/badge'
import { Button } from '@/ui/button'

import { SettingGroupPanel } from '../settings/SettingGroupPanel'
import {
  EmptyState,
  Modal,
  Notice,
  PageShell,
  SkeletonBlock,
  StatusTag,
} from '../shared/composites'
import { notifyError, notifySuccess } from '../shared/toast'
import { ArchiveCard } from './ArchiveCard'
import { ChangeTimeline } from './ChangeTimeline'

export function MemoryPage() {
  const queryClient = useQueryClient()
  /**
   * 页头那颗「设置」（记忆那一组字段）只给管理员：它是管理员端点 `/settings`。
   * 判据走共享那一条（`lib/useIsAdmin`）——记忆本体就在本机 `data_dir/memory`
   * （`/memory` 挂在本机档的白名单上），这一档的用户就是这台机器的管理员，
   * 按"有没有登录"判会把这一颗藏掉。
   */
  const isAdmin = useIsAdmin()

  const archive = useQuery({ queryKey: ['memory', 'archive'], queryFn: getMemoryArchive })
  const changes = useQuery({ queryKey: ['memory', 'changes'], queryFn: getMemoryChanges })
  const overview = useQuery({ queryKey: ['memory', 'overview'], queryFn: getMemory })

  const [highlight, setHighlight] = useState<number | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  const [report, setReport] = useState<MemoryMigration | null>(null)
  const [draftOpen, setDraftOpen] = useState(false)
  /** 「整理初稿」的**预览**：模型给的建议，确认之前一个字都不写（§8.3）。 */
  const [draftItems, setDraftItems] = useState<MemoryDraftSuggestion[] | null>(null)

  const status = overview.data?.status ?? null

  /** `MEMORY.md` 已退场：它不再进注入，识别口径就是后端给的 `injected=false`。 */
  const oldMemory = (overview.data?.files ?? []).find(
    (item) => item.kind === 'core' && !item.injected,
  )

  const oldMemoryText = useQuery({
    queryKey: ['memory', 'file', oldMemory?.path ?? ''],
    queryFn: () => getMemoryFile(oldMemory!.path),
    enabled: Boolean(oldMemory),
  })

  const draftPath = archive.data?.draft.path ?? ''
  const draftText = useQuery({
    queryKey: ['memory', 'file', draftPath],
    queryFn: () => getMemoryFile(draftPath),
    enabled: draftOpen && Boolean(draftPath),
  })

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['memory', 'archive'] })
    await queryClient.invalidateQueries({ queryKey: ['memory', 'changes'] })
    await queryClient.invalidateQueries({ queryKey: ['memory', 'overview'] })
  }

  const migrate = useMutation({
    mutationFn: migrateMemory,
    onSuccess: async (result) => {
      setReport(result)
      setReportOpen(true)
      await refresh()
      notifySuccess(result.skipped ? '没有新的旧条目' : '折叠完成')
    },
    onError: (error: unknown) => notifyError(messageOf(error)),
  })

  /** 整理初稿：**只拿建议**，预览确认之后才写。 */
  const organize = useMutation({
    mutationFn: organizeMemoryDraft,
    onSuccess: (result) => setDraftItems(result.items ?? []),
    onError: (error: unknown) => notifyError(messageOf(error)),
  })

  /** 把预览里那几条逐条写进档案——**走的就是 remember 那条正规的路**。 */
  const applyDraft = useMutation({
    mutationFn: async (items: MemoryDraftSuggestion[]) => {
      const receipts: string[] = []
      let written = 0
      for (const item of items) {
        const result = await rememberMemory(item.text, { section: item.section })
        if (result.action === 'rejected') receipts.push(result.receipt)
        else written += 1
      }
      return { written, receipts }
    },
    onSuccess: async ({ written, receipts }) => {
      setDraftItems(null)
      await refresh()
      if (receipts.length > 0) notifyError(receipts.join('；'))
      else notifySuccess(`写进档案：${written} 条`)
    },
    onError: (error: unknown) => notifyError(messageOf(error)),
  })

  const statusView = !status
    ? { label: '读取中', tone: 'neutral' as const }
    : !status.enabled
      ? { label: '未启用', tone: 'neutral' as const }
      : { label: '已启用', tone: 'success' as const }

  const draftEntries = archive.data?.draft.entries ?? 0
  const folded = report ? report.added + report.replaced : 0

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
      {archive.isError && (
        <Notice tone="error" icon={<AlertCircle size={15} />}>
          {messageOf(archive.error)}
        </Notice>
      )}

      {overview.isError && (
        <Notice tone="error" icon={<AlertCircle size={15} />}>
          {messageOf(overview.error)}
        </Notice>
      )}

      {archive.isLoading ? (
        <SkeletonBlock variant="list" rows={6} />
      ) : archive.data ? (
        <div className="m-archive-layout">
          <div className="m-archive-main">
            {archive.data.migration_available && (
              <div className="m-migrate" data-testid="migration-entry">
                <span>检测到可折叠的旧记忆</span>
                <Button
                  data-testid="migration-run"
                  disabled={migrate.isPending}
                  onClick={() => migrate.mutate()}
                >
                  {migrate.isPending ? '折叠中…' : '导入旧记忆'}
                </Button>
              </div>
            )}

            {draftEntries > 0 && (
              <div className="m-draft" data-testid="draft-hint">
                <span data-testid="draft-count">还有 {draftEntries} 条旧条目没进档案</span>
                <Button
                  data-testid="draft-organize"
                  variant="ghost"
                  size="sm"
                  disabled={organize.isPending}
                  onClick={() => organize.mutate()}
                >
                  {organize.isPending ? '整理中…' : '整理初稿'}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setDraftOpen((prev) => !prev)}>
                  {draftOpen ? '收起' : '展开'}
                </Button>
                {draftOpen && (
                  <pre className="m-original-body" data-testid="draft-content">
                    {draftText.data?.content ?? ''}
                  </pre>
                )}
                {draftItems !== null && (
                  <div className="m-draft-preview" data-testid="draft-preview">
                    {draftItems.length === 0 ? (
                      <span data-testid="draft-preview-empty">这一轮没有整理出可用的条目</span>
                    ) : (
                      <>
                        <ul>
                          {draftItems.map((item) => (
                            <li
                              key={`${item.section}-${item.text}`}
                              data-testid="draft-preview-item"
                            >
                              <Badge variant="secondary">{item.section}</Badge>
                              {item.text}
                            </li>
                          ))}
                        </ul>
                        <Button
                          data-testid="draft-apply"
                          disabled={applyDraft.isPending}
                          onClick={() => applyDraft.mutate(draftItems)}
                        >
                          {applyDraft.isPending ? '写入中…' : '写进档案'}
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            <ArchiveCard
              archive={archive.data}
              workspace={status?.workspace ?? ''}
              onJumpChange={setHighlight}
            />
          </div>

          <div className="m-archive-side">
            {changes.isLoading ? (
              <SkeletonBlock variant="list" rows={4} />
            ) : changes.data ? (
              <ChangeTimeline changes={changes.data} highlight={highlight} />
            ) : null}

            {oldMemory && (
              <section className="m-old" data-testid="old-memory" aria-label="旧记忆">
                <header className="m-section-head">
                  <h2 className="m-section-title">旧记忆（只读）</h2>
                  <Badge variant="secondary">{oldMemory.path}</Badge>
                </header>
                <pre className="m-original-body" data-testid="old-memory-content">
                  {oldMemoryText.data?.content ?? ''}
                </pre>
              </section>
            )}

            {!oldMemory && <EmptyState title="没有旧记忆文件" hint="折叠完成后这里会显示结果。" />}
          </div>
        </div>
      ) : null}

      <Modal open={reportOpen} title="迁移报告" onClose={() => setReportOpen(false)} size="sm">
        {report && (
          <dl className="m-report" data-testid="migration-report">
            <div>
              <dt>折叠</dt>
              <dd>{folded} 条</dd>
            </div>
            <div>
              <dt>丢弃</dt>
              <dd>{report.dropped_sensitive} 条</dd>
            </div>
            <div>
              <dt>降级进草稿</dt>
              <dd>{report.downgraded} 条</dd>
            </div>
            <div>
              <dt>裁剪</dt>
              <dd>{report.trimmed} 条</dd>
            </div>
            {report.existing > 0 && (
              <div>
                <dt>已有</dt>
                <dd>{report.existing} 条</dd>
              </div>
            )}
          </dl>
        )}
      </Modal>

      <Modal open={settingsOpen} title="记忆设置" onClose={() => setSettingsOpen(false)} size="md">
        <SettingGroupPanel keys={['memory']} />
      </Modal>
    </PageShell>
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
