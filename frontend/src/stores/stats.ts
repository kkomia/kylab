/**
 * 概览统计（驾驶舱的数据）。
 *
 * **为什么要有这个 store**：驾驶舱的两组数据来自两个接口，且都要几十到几百毫秒
 * （服务端 22–26ms，但经开发代理首次请求实测可到 ~300ms）。放在组件里意味着每次
 * 进页面都从零等一次，且先显示一屏骨架。
 *
 * 这里做三件事：
 * 1. **两个接口并行取**：原来 `usage` 要等 `dashboard` 回来才开始（串行，白等一次往返）；
 * 2. **缓存 + 先渲染旧数据**：二次进入立刻出内容，后台刷新（stale-while-revalidate）；
 * 3. **预取**：导航项 hover/聚焦与启动后空闲各预热一次。
 */

import { defineStore } from 'pinia'

import { getDashboard, getUsage, type Dashboard, type Usage } from '@/api/stats'

/** 活跃度观察窗口（天）。与热力图的格子边长一起定的，改它要想清楚版面。 */
export const DASHBOARD_WINDOW_DAYS = 365
/** 用量观察窗口（天）。 */
export const USAGE_WINDOW_DAYS = 30

interface State {
  dashboard: Dashboard | null
  usage: Usage | null
  /** 是否成功加载过驾驶舱数据（用量失败不算，它是旁路）。 */
  loaded: boolean
  loading: boolean
  error: string
}

let inflight: Promise<void> | null = null

export const useStatsStore = defineStore('stats', {
  state: (): State => ({
    dashboard: null,
    usage: null,
    loaded: false,
    loading: false,
    error: '',
  }),

  actions: {
    async load(): Promise<void> {
      if (inflight !== null) return inflight
      this.loading = true
      inflight = (async () => {
        // 并行而不是串行：两者互不依赖，串行会让总时长等于两者之和
        const [dashboard, usage] = await Promise.allSettled([
          getDashboard(DASHBOARD_WINDOW_DAYS),
          getUsage(USAGE_WINDOW_DAYS),
        ])
        if (dashboard.status === 'fulfilled') {
          this.dashboard = dashboard.value
          this.loaded = true
          this.error = ''
        } else {
          this.error = dashboard.reason instanceof Error ? dashboard.reason.message : '统计加载失败'
        }
        // 用量来自另一张表，取不到只是这一块空着，不该让整个驾驶舱报错
        this.usage = usage.status === 'fulfilled' ? usage.value : null
        this.loading = false
        inflight = null
      })()
      return inflight
    },

    /** 预取：只拉一次，失败静默（不在用户进页面之前弹错误）。 */
    async prefetch(): Promise<void> {
      if (this.loaded || inflight !== null) return
      const previous = this.error
      await this.load()
      this.error = previous
    },
  },
})
