/**
 * 知识库清单（Pinia）。
 *
 * 侧栏、对话页与概览页是同一份清单：放在 store 里只查一次、只存一份，
 * 避免"新建之后这边有、那边没有"这类不同步。
 *
 * `summaries`（每库文档数与最近更新时间）也收在这里：它是知识库列表接口
 * （`GET /knowledge-bases`）带回的 `document_count` / `last_activity`，
 * 各页面各查一遍既慢、口径又容易漂。
 */

import { defineStore } from 'pinia'

import type { ImpactReport } from '@/api/documents'
import {
  createKnowledgeBase,
  deleteKnowledgeBase,
  listKnowledgeBases,
  updateKnowledgeBase,
  type KnowledgeBase,
  type KnowledgeBaseCreate,
} from '@/api/knowledgeBases'
import type { DocStats } from '@/composables/useFormat'

interface State {
  items: KnowledgeBase[]
  /** kbId → 文档数与最近更新时间。**由列表接口一并带回**（`document_count` /
   *  `last_activity`），不再"逐库拉文档列表只为数数"——那是 N 次请求。 */
  summaries: Record<string, DocStats>
  loading: boolean
  error: string
}

/** 一个库的汇总。空库也给 0/None：数字来自后端聚合，是准的，不该退回占位符。
 *  `?? 0` 兜底的是"后端比前端旧"的窗口（列表响应里还没有计数字段）——
 *  否则 undefined 一路传到页头就是"共 NaN 篇"（实测踩到）。 */
/** 正在飞的那次列表请求。**并发调用合并成一次**：侧栏与页面在启动时几乎同时
 *  触发 `load()`，没有这个闸门就会发两遍（实测页面上 `/knowledge-bases` 出现三次）。 */
let inflightLoad: Promise<void> | null = null

function summaryOf(kb: KnowledgeBase): DocStats {
  return { count: kb.document_count ?? 0, updatedAt: kb.last_activity ?? null }
}

export const useKnowledgeBaseStore = defineStore('knowledgeBases', {
  state: (): State => ({
    items: [],
    summaries: {},
    loading: false,
    error: '',
  }),

  actions: {
    async load(): Promise<void> {
      if (inflightLoad !== null) return inflightLoad
      this.loading = true
      inflightLoad = (async () => {
        try {
          this.items = (await listKnowledgeBases()).items
          this.summaries = Object.fromEntries(this.items.map((kb) => [kb.id, summaryOf(kb)]))
          this.error = ''
        } catch (error) {
          this.error = error instanceof Error ? error.message : '知识库列表加载失败'
        } finally {
          this.loading = false
          inflightLoad = null
        }
      })()
      return inflightLoad
    },

    /** 上传/删除/改名之后重取一次列表（一次请求就带回全部计数）。 */
    async refreshSummaries(): Promise<void> {
      await this.load()
    },

    async create(payload: KnowledgeBaseCreate): Promise<KnowledgeBase> {
      const created = await createKnowledgeBase(payload)
      this.items = [...this.items, created]
      this.summaries = { ...this.summaries, [created.id]: summaryOf(created) }
      return created
    },

    /** 改名称/简介并就地更新清单：侧栏、对话页用的是同一份，改完立刻一致。 */
    async update(
      kbId: string,
      patch: { name?: string; description?: string },
    ): Promise<KnowledgeBase> {
      const updated = await updateKnowledgeBase(kbId, patch)
      this.items = this.items.map((item) => (item.id === kbId ? updated : item))
      this.summaries = { ...this.summaries, [kbId]: summaryOf(updated) }
      return updated
    },

    /** 改名的便捷入口（设置弹窗里的常用动作）。 */
    async rename(kbId: string, name: string): Promise<KnowledgeBase> {
      return this.update(kbId, { name })
    },

    /** 删库（不可恢复）并把它从清单与汇总里摘掉。返回影响清单当回执。 */
    async remove(kbId: string): Promise<ImpactReport> {
      const report = await deleteKnowledgeBase(kbId)
      this.forget(kbId)
      return report
    },

    /** 从本地清单与汇总里摘掉（删除成功后调用；也用于其它"这个库没了"的场合）。 */
    forget(kbId: string): void {
      this.items = this.items.filter((item) => item.id !== kbId)
      // 汇总一起清：留着会让"已删除的库"仍在计数
      const rest = { ...this.summaries }
      delete rest[kbId]
      this.summaries = rest
    },

    byId(kbId: string): KnowledgeBase | undefined {
      return this.items.find((item) => item.id === kbId)
    },
  },
})
