/**
 * 存储配置与空间占用（管理员）——与旧前端 `components/settings/StorageSection.vue` 对应。
 *
 * 进来就自己读一次概览（父组件不再管它的加载时机），确认弹窗也归它自己——
 * 弹窗属于"这个动作"，不属于整个设置弹窗。
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { compactStorage, getStorageOverview } from '@/api/maintenance'
import { formatBytes } from '@/lib/format'

import { useKnowledgeBases } from '../shared/knowledgeBases'
import { notifyError, notifySuccess } from '../shared/toast'
import { Button } from '@/ui/button'
import { ConfirmDialog, ErrorLine, InfoTip, SkeletonBlock } from '../shared/composites'

export const STORAGE_QUERY_KEY = ['maintenance', 'storage'] as const

const LAYOUT_ROWS: { label: string; value: string }[] = [
  { label: '元数据', value: 'PostgreSQL（含运行期配置与任务队列）' },
  { label: '向量', value: 'pgvector（HNSW 索引，按知识库分区，维度随库）' },
  { label: '全文检索', value: 'tsvector + jieba 分词' },
  { label: '原文与图片', value: '对象存储：本地目录或 S3 兼容服务，按内容 hash 寻址' },
]

export function StorageSection() {
  const queryClient = useQueryClient()
  const [confirmOpen, setConfirmOpen] = useState(false)
  /** 知识库数量直接读共享缓存：它已经在别处加载好了，这里再请求一次只是浪费一次往返。 */
  const kbCount = useKnowledgeBases().items.length

  const storage = useQuery({ queryKey: STORAGE_QUERY_KEY, queryFn: getStorageOverview })

  /**
   * 整理存储：丢掉无主分区并跑 `VACUUM (ANALYZE)`。
   *
   * **先确认再动手**：它会重写含死元组的表页，大库可能要几十秒。
   * 不阻塞写入（那是 `VACUUM FULL` 才有的代价，本项目不用它），但期间别人的查询会变慢。
   */
  const compact = useMutation({
    mutationFn: compactStorage,
    onSuccess: async (overview, _variables, context) => {
      queryClient.setQueryData(STORAGE_QUERY_KEY, overview)
      setConfirmOpen(false)
      const before = (context as { before?: number } | undefined)?.before ?? 0
      const freed = before - overview.free_bytes
      notifySuccess(freed > 0 ? `已回收 ${formatBytes(freed)}` : '存储已整理')
    },
    onError: (error: unknown) => notifyError(error instanceof Error ? error.message : '整理失败'),
    onMutate: () => ({ before: storage.data?.free_bytes ?? 0 }),
  })

  return (
    <>
      <h3 className="m-section-title">
        存储配置
        <InfoTip text="元数据、向量与全文都在同一个 PostgreSQL 里；连接串由环境变量 KYLAB_DATABASE_URL 决定，改后需重启后端。" />
      </h3>

      {LAYOUT_ROWS.map((row) => (
        <div key={row.label} className="m-row">
          <div className="m-row-main">
            <span className="m-row-label">{row.label}</span>
            <span className="m-row-value">{row.value}</span>
          </div>
        </div>
      ))}

      <div className="m-row">
        <div className="m-row-main">
          <span className="m-row-label">知识库数量</span>
          <span className="m-row-value tabular">{kbCount}</span>
        </div>
      </div>

      <h3 className="m-section-title m-section-gap">空间占用</h3>
      {/* 权限不足或后端不可达都不该把设置页弄崩：这一块单独显示原因 */}
      {storage.isError && <ErrorLine>{messageOf(storage.error)}</ErrorLine>}
      {storage.isLoading && <SkeletonBlock variant="text" rows={2} />}

      {storage.data && (
        <>
          <div className="m-row">
            <div className="m-row-main">
              <span className="m-row-label">数据库大小</span>
              <span className="m-row-value tabular">{formatBytes(storage.data.file_bytes)}</span>
            </div>
          </div>
          <div className="m-row">
            <div className="m-row-main">
              <span className="m-row-label">
                其中可回收
                <InfoTip text="删掉的行只留下死元组，数据库大小不会因此变小；「整理存储」把它们标成可复用，占用不会立刻下降。" />
              </span>
              <span className="m-row-value tabular">{formatBytes(storage.data.free_bytes)}</span>
            </div>
            <Button disabled={compact.isPending} onClick={() => setConfirmOpen(true)}>
              {compact.isPending ? '整理中…' : '整理存储'}
            </Button>
          </div>
        </>
      )}

      <ConfirmDialog
        open={confirmOpen}
        title="整理存储？"
        lead="会丢掉无主向量分区并重写含死元组的表页。库大时可能要几十秒，期间别人的查询会变慢。"
        note="写入不会中断；占用也不会立刻下降——回收的空间留给后续复用。"
        confirmLabel="开始整理"
        busy={compact.isPending}
        busyLabel="整理中…"
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => compact.mutate()}
      />
    </>
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '读取存储信息失败'
}
