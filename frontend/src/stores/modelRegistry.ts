/**
 * 模型注册表缓存。
 *
 * **为什么要有这个 store**：对话页每次进入都重新拉一次注册表，拉回来之前
 * 模型下拉是空的——于是"未配置对话模型"这个占位文案先闪一下（实测约 430ms），
 * 再跳成真正的模型名，看起来就是模型名在闪烁。注册表本身几乎不变
 * （改配置才动），完全没道理每次进页面都重取。
 *
 * 做法与任务/概览一致：**缓存 + stale-while-revalidate**。已有数据时界面立刻
 * 拿到内容，后台再刷新一次；并发合并且同一时刻只允许一次在飞请求。
 */

import { defineStore } from 'pinia'

import { getRegistry, type Registry } from '@/api/modelRegistry'

interface State {
  registry: Registry | null
  /** 是否成功加载过至少一次。界面据此区分"还没有数据"与"正在刷新"。 */
  loaded: boolean
  loading: boolean
  error: string
}

let inflight: Promise<void> | null = null

export const useModelRegistryStore = defineStore('modelRegistry', {
  state: (): State => ({
    registry: null,
    loaded: false,
    loading: false,
    error: '',
  }),

  actions: {
    /**
     * 拉注册表。已有数据时不阻塞：界面先用手上的那份，这次结果到了再替换。
     *
     * 失败**保留旧数据**（只记 error）——刷新失败让下拉变空，比用一份稍旧的
     * 模型列表糟得多：前者会让"当前用的模型"变成一个无法解析的占位。
     */
    async load(): Promise<void> {
      if (inflight !== null) return inflight
      this.loading = true
      inflight = (async () => {
        try {
          this.registry = await getRegistry()
          this.loaded = true
          this.error = ''
        } catch (error) {
          this.error = error instanceof Error ? error.message : '模型注册表加载失败'
        } finally {
          this.loading = false
          inflight = null
        }
      })()
      return inflight
    },

    /**
     * 预取：只拉一次，失败静默。
     *
     * 预取是"顺手多做的准备"，不该因为后端抖一下就在用户还没进页面时弹错误提示。
     */
    async prefetch(): Promise<void> {
      if (this.loaded || inflight !== null) return
      const previous = this.error
      await this.load()
      this.error = previous
    },
  },
})
