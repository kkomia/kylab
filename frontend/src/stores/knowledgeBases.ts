/**
 * 知识库清单（Pinia）。
 *
 * 侧栏、对话页与概览页是同一份清单：放在 store 里只查一次、只存一份，
 * 避免"新建之后这边有、那边没有"这类不同步。
 *
 * `summaries`（每库文档数与最近更新时间）也收在这里：它来自 `listDocuments`，
 * 各页面各查一遍既慢、口径又容易漂。
 */

import { defineStore } from 'pinia'

import { listDocuments, type DocumentSummary } from '@/api/documents'
import {
  createKnowledgeBase,
  listKnowledgeBases,
  type KnowledgeBase,
  type KnowledgeBaseCreate,
} from '@/api/knowledgeBases'
import { summarizeDocuments, type DocStats } from '@/composables/useFormat'

interface State {
  items: KnowledgeBase[]
  /** kbId → 文档数与最近更新时间；拿不到时为 {}，界面显示占位符。 */
  summaries: Record<string, DocStats>
  loading: boolean
  error: string
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
      this.loading = true
      try {
        this.items = (await listKnowledgeBases()).items
        this.error = ''
      } catch (error) {
        this.error = error instanceof Error ? error.message : '知识库列表加载失败'
      } finally {
        this.loading = false
      }
    },

    /** 每个知识库一次列表请求（不是逐文档 N+1）。失败就留空，不阻断清单本身。 */
    async loadSummaries(): Promise<void> {
      if (this.items.length === 0) {
        this.summaries = {}
        return
      }
      try {
        const rows: DocumentSummary[] = []
        for (const kb of this.items) {
          rows.push(...(await listDocuments(kb.id)).items)
        }
        this.summaries = summarizeDocuments(rows)
      } catch {
        this.summaries = {}
      }
    },

    async create(payload: KnowledgeBaseCreate): Promise<KnowledgeBase> {
      const created = await createKnowledgeBase(payload)
      this.items = [...this.items, created]
      return created
    },

    /** 删除接口在 M6 接入；当前只从本地列表移除，保证界面即时一致。 */
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
