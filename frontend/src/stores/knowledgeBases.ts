/**
 * 知识库清单（Pinia）。
 *
 * 侧栏导航与首页卡片网格是同一份数据：放在 store 里只查一次、只存一份，
 * 避免"新建之后侧栏有、首页没有"这类不同步。
 */

import { defineStore } from 'pinia'

import {
  createKnowledgeBase,
  listKnowledgeBases,
  type KnowledgeBase,
  type KnowledgeBaseCreate,
} from '@/api/knowledgeBases'

interface State {
  items: KnowledgeBase[]
  loading: boolean
  error: string
}

export const useKnowledgeBaseStore = defineStore('knowledgeBases', {
  state: (): State => ({ items: [], loading: false, error: '' }),

  getters: {
    /** §5.1：条目 ≤12 用卡片网格，超过则切列表。 */
    useCardGrid: (state) => state.items.length <= 12,
  },

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

    async create(payload: KnowledgeBaseCreate): Promise<KnowledgeBase> {
      const created = await createKnowledgeBase(payload)
      this.items = [...this.items, created]
      return created
    },

    /** 删除接口在 M6 接入；当前只从本地列表移除，保证界面即时一致。 */
    forget(kbId: string): void {
      this.items = this.items.filter((item) => item.id !== kbId)
    },

    byId(kbId: string): KnowledgeBase | undefined {
      return this.items.find((item) => item.id === kbId)
    },
  },
})
