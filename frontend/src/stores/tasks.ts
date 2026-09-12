/**
 * 任务列表（任务中心的缓存）。
 *
 * **为什么要有这个 store**：任务中心原来把列表放在组件局部状态里，每次进入都得
 * 重新请求，请求到达前是一屏骨架屏。而其它页面（知识库、对话）读的是已加载的 store，
 * 所以进任务中心总感觉慢半拍——不是接口慢（实测 13–19ms），是**每次都要等一次网络往返**。
 *
 * 这里做两件事：
 * 1. **缓存 + 先渲染旧数据**：已有数据时立刻出内容，后台再刷新（stale-while-revalidate）；
 * 2. **预取**：导航项 hover/聚焦时、以及启动后空闲时各预热一次，多数情况下点进去
 *    数据已经在手里。
 *
 * 并发合并沿用知识库 store 的做法：同一时刻只允许一次在飞请求。
 */

import { defineStore } from 'pinia'

import { listTasks, type TaskSummary } from '@/api/tasks'

interface State {
  items: TaskSummary[]
  /** 是否成功加载过至少一次。界面据此区分"首次加载中"与"刷新中"。 */
  loaded: boolean
  loading: boolean
  error: string
}

let inflight: Promise<void> | null = null

export const useTaskStore = defineStore('tasks', {
  state: (): State => ({
    items: [],
    loaded: false,
    loading: false,
    error: '',
  }),

  getters: {
    /** 还有任务在跑：界面据此决定要不要轮询。 */
    hasActive(state): boolean {
      return state.items.some((task) => task.state === 'pending' || task.state === 'running')
    },
  },

  actions: {
    async load(): Promise<void> {
      if (inflight !== null) return inflight
      this.loading = true
      inflight = (async () => {
        try {
          this.items = (await listTasks()).items
          this.loaded = true
          this.error = ''
        } catch (error) {
          this.error = error instanceof Error ? error.message : '任务列表加载失败'
        } finally {
          this.loading = false
          inflight = null
        }
      })()
      return inflight
    },

    /**
     * 预取：只拉一次，且**失败静默**。
     *
     * 预取是"顺手多做的准备"，不该因为后端抖一下就在用户还没进页面时弹错误提示；
     * 真正进入页面时 `load()` 会照常报错。
     */
    async prefetch(): Promise<void> {
      if (this.loaded || inflight !== null) return
      const previous = this.error
      await this.load()
      this.error = previous
    },
  },
})
