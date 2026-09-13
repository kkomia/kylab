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
  getConversation,
  listConversations,
  updateConversation,
  type ConversationDetail,
  type ConversationSummary,
  type ConversationThinking,
  type StoredMessage,
} from '@/api/conversations'

interface State {
  items: ConversationSummary[]
  loading: boolean
  error: string
  /** `items` 里是不是**未筛选**的完整清单。搜索过的子集不能拿来判断"最近一条"。 */
  loaded: boolean
  /** 当前清单对应的搜索词（空串 = 未筛选）。 */
  query: string
}

/**
 * 列表一页取多少。侧栏那份清单与"最近一条"共用同一个数——
 * 两处各写一个 50，改了其中一个就会出现"侧栏看得到、入口却挑不着"。
 */
const CONVERSATION_PAGE = 50

/**
 * 与后端 `ORDER BY pinned DESC, updated_at DESC` 同一口径。
 *
 * 两边各排一份是有意的：后端那份决定"重新打开页面时看到什么"，
 * 本地这份决定"刚点完置顶后立刻看到什么"。共用一份就得等一个来回，
 * 而置顶是个应该"点完立刻见效"的动作。
 */
function sortConversations(items: ConversationSummary[]): ConversationSummary[] {
  return [...items].sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1
    return (right.updated_at ?? '').localeCompare(left.updated_at ?? '')
  })
}

/**
 * 清单里"最近活动"的那条。
 *
 * 与 `latestNoteId` 同一套口径：取 `updated_at` 最大，而**不是第一行**——
 * 清单是"置顶优先"排的，置顶代表"我想常看"，不代表"我上次在聊哪个"。
 */
export function latestConversationId(items: ConversationSummary[]): string {
  let best: ConversationSummary | null = null
  for (const item of items) {
    if (best === null || (item.updated_at ?? '') > (best.updated_at ?? '')) best = item
  }
  return best?.id ?? ''
}

/**
 * 会话正文缓存：切回看过的会话时**直接画出来**，不再等一个往返。
 *
 * 会话列表只存摘要，正文（消息）按需拉取；而"离开对话页再回来"是最高频的动作之一，
 * 每次回来都空白一下（等 `getConversation`）实在说不过去。所以这里缓存正文：
 * - 命中时同步渲染（调用方零等待），并顺带在侧栏悬停时预取；
 * - 5 分钟内不回源：会话正文只会被**本客户端**追加，而追加结束时本地会把缓存更新掉
 *   （见 `rememberDetailMessages`），所以 TTL 主要是在兜"另一个标签页改过"这种少见情况。
 */
const DETAIL_TTL_MS = 5 * 60_000
const detailCache = new Map<string, { detail: ConversationDetail; at: number }>()
const inflightDetail = new Map<string, Promise<ConversationDetail>>()

/** 测试用：清掉正文缓存，免得用例之间互相污染。 */
export function clearConversationDetailCache(): void {
  detailCache.clear()
  inflightDetail.clear()
}

/**
 * 详情 → 摘要（只差一个 `messages`）。
 *
 * 显式列字段而不是 `{...detail, messages: undefined}`：接口加字段时这里会
 * 因为"缺属性"直接编译不过，提醒把新字段带上，而不是悄悄漏掉。
 */
function summaryOf(detail: ConversationDetail): ConversationSummary {
  return {
    id: detail.id,
    title: detail.title,
    kb_ids: detail.kb_ids,
    model_pk: detail.model_pk,
    thinking: detail.thinking,
    thinking_effort: detail.thinking_effort,
    pinned: detail.pinned,
    created_at: detail.created_at,
    updated_at: detail.updated_at,
    message_count: detail.message_count,
  }
}

export const useConversationStore = defineStore('conversations', {
  state: (): State => ({
    items: [],
    loading: false,
    error: '',
    loaded: false,
    query: '',
  }),

  actions: {
    /** ``q`` 非空时按标题搜索（后端做，见 api 里的说明）。 */
    async load(q?: string): Promise<void> {
      const query = (q ?? '').trim()
      this.loading = true
      try {
        this.items = (await listConversations(CONVERSATION_PAGE, query || undefined)).items
        this.query = query
        // 只有未筛选的那次才算"完整清单"；搜索结果是子集，不能拿它判断全局
        this.loaded = query === ''
        this.error = ''
      } catch (error) {
        // 鉴权开着而没填令牌时这里必然失败——但那是**设置页**要解决的问题，
        // 不该让侧栏弹一堆红字。留空并记下原因即可。
        this.error = error instanceof Error ? error.message : '会话列表加载失败'
      } finally {
        this.loading = false
      }
    },

    async create(
      kbIds: string[],
      modelPk?: string | null,
      thinking?: ConversationThinking,
    ): Promise<ConversationSummary> {
      const created = await createConversation(kbIds, modelPk, thinking)
      // 新会话排在最前：后端按 updated_at 倒序，而它刚建出来就是最新的
      this.items = [created, ...this.items]
      return created
    },

    async rename(id: string, title: string): Promise<void> {
      const updated = await updateConversation(id, { title })
      // 就地替换标题。**不重排**：后端改名不推 updated_at，前端跟着不动，
      // 否则用户整理一遍标题列表，顺序就按"改标题的时间"乱掉了。
      this.items = this.items.map((item) =>
        item.id === id ? { ...item, title: updated.title } : item,
      )
    },

    /**
     * 置顶 / 取消置顶。
     *
     * **本地重排而不是重新拉列表**：顺序是确定的（置顶在前、其余按最近更新），
     * 重排一次就够，而重新拉一次会让侧栏在点击后闪一下（列表整体重建）。
     */
    async setPinned(id: string, pinned: boolean): Promise<void> {
      const updated = await updateConversation(id, { pinned })
      this.items = sortConversations(
        this.items.map((item) => (item.id === id ? { ...item, pinned: updated.pinned } : item)),
      )
    },

    async remove(id: string): Promise<void> {
      await deleteConversation(id)
      detailCache.delete(id)
      this.items = this.items.filter((item) => item.id !== id)
    },

    // ---------------------------------------------------------- 会话正文（缓存）

    /** 取缓存里的会话正文；没有或过期返回 null。**同步**，用于切回时立刻上屏。 */
    cachedDetail(id: string): ConversationDetail | null {
      const hit = detailCache.get(id)
      if (!hit) return null
      if (Date.now() - hit.at > DETAIL_TTL_MS) {
        detailCache.delete(id)
        return null
      }
      return hit.detail
    },

    rememberDetail(detail: ConversationDetail): void {
      detailCache.set(detail.id, { detail, at: Date.now() })
    },

    /** 拉一次会话正文并写进缓存；同一会话的并发请求合并成一次。 */
    async fetchDetail(id: string): Promise<ConversationDetail> {
      const pending = inflightDetail.get(id)
      if (pending) return pending
      const task = getConversation(id)
        .then((detail) => {
          this.rememberDetail(detail)
          return detail
        })
        .finally(() => {
          inflightDetail.delete(id)
        })
      inflightDetail.set(id, task)
      return task
    },

    /**
     * 预取一条会话的正文（侧栏会话行 hover/聚焦时调）。
     * 命中缓存或已在飞就跳过——鼠标扫过列表不该打出一串请求。失败静默。
     */
    async prefetchDetail(id: string): Promise<void> {
      if (!id || this.cachedDetail(id) || inflightDetail.has(id)) return
      await this.fetchDetail(id).catch(() => undefined)
    },

    /**
     * 预取"最近一次会话"的正文：鼠标移到侧栏「对话」上时用。
     *
     * 清单还没拿到就先拉一次（那本来就是进对话页要做的事）；正在搜索时不猜——
     * 搜索结果是子集，猜出来的"最近一条"可能是错的。
     */
    async prefetchLatestDetail(): Promise<void> {
      if (this.query) return
      if (!this.loaded) {
        if (this.loading) return
        await this.load()
      }
      await this.prefetchDetail(latestConversationId(this.items))
    },

    /**
     * 用**本地刚聊完的消息**更新缓存。
     *
     * 一轮结束时会话正文就变成"本地这份"了（后端同刻写完），所以直接覆盖，
     * 免得"聊完切走再切回"看到的还是上一版。缓存里没有这条会话就跳过——
     * 那说明它没被读过，下次读的时候自然是最新的。
     */
    rememberDetailMessages(id: string, messages: StoredMessage[]): void {
      const hit = detailCache.get(id)
      const summary = hit?.detail ?? this.byId(id)
      if (!summary) return
      detailCache.set(id, {
        detail: { ...summary, messages, message_count: messages.length },
        at: Date.now(),
      })
    },

    /**
     * 重新拉一次会话正文：一轮对话结束后标题/条数都变了，顺手也把缓存校准。
     *
     * 一次请求干两件事（原来 `refreshOne` 是拉整张列表只为改一行）：
     * 详情里本来就带着标题、消息数、更新时间。
     */
    async refreshDetail(id: string): Promise<void> {
      let detail: ConversationDetail
      try {
        detail = await getConversation(id)
      } catch (cause) {
        // 只有"确实没了"（404）才从列表里摘掉。
        // 网络抖一下也摘的话，侧栏会莫名其妙少一条，比多一次 404 更让人困惑。
        if ((cause as { status?: number } | null)?.status === 404) {
          this.items = this.items.filter((item) => item.id !== id)
          detailCache.delete(id)
        }
        return
      }
      this.rememberDetail(detail)
      const summary = summaryOf(detail)
      if (this.query) {
        // 搜索态下的清单是子集，只就地替换，别重排（重排会让筛出来的顺序乱掉）
        this.items = this.items.map((item) => (item.id === id ? summary : item))
        return
      }
      // 重新排序而不是直接插到最前：本地的顺序必须与后端 `pinned DESC, updated_at DESC`
      // 一致，否则"刚聊过"会把非置顶会话顶到置顶会话之上，刷新一次顺序就变回去
      this.items = sortConversations([summary, ...this.items.filter((item) => item.id !== id)])
    },

    byId(id: string): ConversationSummary | undefined {
      return this.items.find((item) => item.id === id)
    },

    /**
     * 「对话」入口该落到哪一条：**按最近活动**（`updated_at` 最大）。
     *
     * 三条为什么这么写：
     * 1. 不用 `items[0]`——那份清单是"置顶优先"的（后端与 `sortConversations` 同一口径），
     *    而置顶是人工整理的次序，代表"我想常看"，不代表"我上次在聊哪个"；
     * 2. 也不在**被搜索筛过**的 `items` 里挑——那是子集，挑出来的"最新"可能是错的；
     * 3. 所以：手上是完整的清单（`loaded`）时就本地取最大，**省掉一次往返**；
     *    否则才问后端要一页。置顶优先的排序不影响"取最大"，
     *    只要这一页里含有真正最新的那条——置顶数超过一页才会退化，现实中遇不到。
     *
     * 第 3 条是这次加的性能改动：侧栏早在挂载时就拉过完整清单，而"点对话"是最高频的
     * 动作之一，为一个已经在手里的答案再等一次网络往返，正是"点进去空白一下"的来源。
     */
    async latestId(): Promise<string> {
      if (this.loaded && !this.query) return latestConversationId(this.items)
      const { items } = await listConversations(CONVERSATION_PAGE)
      if (!this.query) {
        // 顺手把清单补成完整的：本来就是没筛过的，下次就能本地取
        this.items = items
        this.loaded = true
      }
      return latestConversationId(items)
    },
  },
})
