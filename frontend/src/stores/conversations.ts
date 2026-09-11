/**
 * 会话清单（Pinia）。
 *
 * 侧栏下半部分与对话页共用同一份清单——它俩都在"当前有哪些会话、最近聊的是哪个"
 * 这件事上做事，各查一遍必然出现"刚建的会话侧栏还没有"。
 *
 * 只存**摘要**（标题、消息数、更新时间）：消息本体按需在对话页拉取。
 * 把每个会话的消息都装进 store，几十次对话之后首屏就白白多几百 KB。
 */

import { defineStore } from 'pinia'

import {
  createConversation,
  deleteConversation,
  listConversations,
  renameConversation,
  type ConversationSummary,
} from '@/api/conversations'

interface State {
  items: ConversationSummary[]
  loading: boolean
  error: string
}

export const useConversationStore = defineStore('conversations', {
  state: (): State => ({
    items: [],
    loading: false,
    error: '',
  }),

  actions: {
    async load(): Promise<void> {
      this.loading = true
      try {
        this.items = (await listConversations()).items
        this.error = ''
      } catch (error) {
        // 鉴权开着而没填令牌时这里必然失败——但那是**设置页**要解决的问题，
        // 不该让侧栏弹一堆红字。留空并记下原因即可。
        this.error = error instanceof Error ? error.message : '会话列表加载失败'
      } finally {
        this.loading = false
      }
    },

    async create(kbIds: string[], modelPk?: string | null): Promise<ConversationSummary> {
      const created = await createConversation(kbIds, modelPk)
      // 新会话排在最前：后端按 updated_at 倒序，而它刚建出来就是最新的
      this.items = [created, ...this.items]
      return created
    },

    async rename(id: string, title: string): Promise<void> {
      const updated = await renameConversation(id, title)
      // 就地替换标题。**不重排**：后端改名不推 updated_at，前端跟着不动，
      // 否则用户整理一遍标题列表，顺序就按"改标题的时间"乱掉了。
      this.items = this.items.map((item) =>
        item.id === id ? { ...item, title: updated.title } : item,
      )
    },

    async remove(id: string): Promise<void> {
      await deleteConversation(id)
      this.items = this.items.filter((item) => item.id !== id)
    },

    /** 一轮对话结束后刷新：标题与消息数都变了，只更新那一条。 */
    async refreshOne(id: string): Promise<void> {
      const fresh = (await listConversations()).items.find((item) => item.id === id)
      if (!fresh) {
        // 会话可能在别处被删了；从列表里摘掉，避免点进去 404
        this.items = this.items.filter((item) => item.id !== id)
        return
      }
      const rest = this.items.filter((item) => item.id !== id)
      // 刚聊过的排到最前，与后端的排序口径一致
      this.items = [fresh, ...rest]
    },

    byId(id: string): ConversationSummary | undefined {
      return this.items.find((item) => item.id === id)
    },
  },
})
