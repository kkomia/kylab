/**
 * 会话清单（壳这一层；旧前端 `stores/conversations.ts` 里侧栏用到的那一半）。
 *
 * 侧栏下半部分与历史会话面板共用**同一份清单**——它俩都在"当前有哪些会话、最近聊的是哪个"
 * 这件事上做事，各查一遍必然出现"刚建的会话侧栏还没有"。
 *
 * 三处与旧实现**逐条对齐**的取舍：
 *
 * 1. **只存摘要**（标题、置顶、更新时间）：消息本体归对话页按需拉取；
 * 2. **面板那份与侧栏那份分开存**（`detailItems`）：面板要预览（多一次查询）与更大的窗口，
 *    而侧栏每次渲染都要它那份清单——让侧栏为面板的需求付成本不划算；
 *    面板的搜索/归档视图更不能写回侧栏那份，否则侧栏会跟着变成"只剩搜索结果"；
 * 3. **改完就地更新那一行，不重拉列表**：重拉会让侧栏在点击后闪一下（整份清单重建）。
 *    置顶**例外**——它要重排（顺序即语义），用的是与后端同一口径的
 *    `pinned DESC, updated_at DESC`。
 *
 * 不做的两件事（都不属于壳）：会话正文缓存与"最近一条"的解析——那是对话页的
 * `ChatProvider` 在管，壳里再存一份就是两个真相。
 */
import { create } from 'zustand'

import {
  deleteConversation,
  listConversations,
  updateConversation,
  type ConversationSummary,
} from '@/api/conversations'

/**
 * 列表一页取多少。侧栏那份清单与"最近一条"共用同一个数——
 * 两处各写一个 50，改了其中一个就会出现"侧栏看得到、入口却挑不着"。
 */
const CONVERSATION_PAGE = 50

/** 历史会话面板那一次取多少：它要的是"翻得到旧会话"，比侧栏宽一档。 */
const HISTORY_PAGE = 100

/**
 * 与后端 `ORDER BY pinned DESC, updated_at DESC` 同一口径。
 *
 * 两边各排一份是有意的：后端那份决定"重新打开页面时看到什么"，
 * 本地这份决定"刚点完置顶后立刻看到什么"。共用一份就得等一个来回，
 * 而置顶是个应该"点完立刻见效"的动作。
 */
export function sortConversations(items: ConversationSummary[]): ConversationSummary[] {
  return [...items].sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1
    return (right.updated_at ?? '').localeCompare(left.updated_at ?? '')
  })
}

export interface HistoryQuery {
  q?: string
  archived?: boolean
  withPreview?: boolean
}

interface ConversationState {
  items: ConversationSummary[]
  /** 历史会话面板用的那份清单：**带预览、可含归档**。 */
  detailItems: ConversationSummary[]
  loading: boolean
  error: string
  /** `items` 里是不是**未筛选**的完整清单。搜索过的子集不能拿来判断"最近一条"。 */
  loaded: boolean
  /** 当前清单对应的搜索词（空串 = 未筛选）。 */
  query: string
  load: (q?: string) => Promise<void>
  loadDetailList: (options?: HistoryQuery) => Promise<void>
  rename: (id: string, title: string) => Promise<void>
  setPinned: (id: string, pinned: boolean) => Promise<void>
  setArchived: (id: string, archived: boolean) => Promise<void>
  setWorkspace: (id: string, workspaceId: string | null) => Promise<void>
  remove: (id: string) => Promise<void>
  reset: () => void
}

const EMPTY = {
  items: [] as ConversationSummary[],
  detailItems: [] as ConversationSummary[],
  loading: false,
  error: '',
  loaded: false,
  query: '',
}

export const useConversationStore = create<ConversationState>((set, get) => ({
  ...EMPTY,

  /** ``q`` 非空时按标题搜索（后端做：只在已加载的前 50 条里筛会搜不到更早的会话）。 */
  load: async (q) => {
    const query = (q ?? '').trim()
    set({ loading: true })
    try {
      const result = await listConversations(CONVERSATION_PAGE, query || undefined)
      set({
        items: result.items,
        query,
        // 只有未筛选的那次才算"完整清单"；搜索结果是子集，不能拿它判断全局
        loaded: query === '',
        error: '',
      })
    } catch (error) {
      // 鉴权开着而没填令牌时这里必然失败——但那是**设置页**要解决的问题，
      // 不该让侧栏弹一堆红字。留空并记下原因即可。
      set({ error: error instanceof Error ? error.message : '会话列表加载失败' })
    } finally {
      set({ loading: false })
    }
  },

  /**
   * 历史会话面板的清单。
   *
   * **它只写 `detailItems`，不碰 `items`**：面板里的搜索/归档视图是面板自己的过滤状态，
   * 写进侧栏那份会让侧栏跟着变成"只剩搜索结果"。
   */
  loadDetailList: async (options = {}) => {
    const result = await listConversations(HISTORY_PAGE, options.q, {
      archived: options.archived,
      withPreview: options.withPreview,
    })
    set({ detailItems: result.items })
  },

  rename: async (id, title) => {
    const updated = await updateConversation(id, { title })
    // 就地替换标题。**不重排**：后端改名不推 updated_at，前端跟着不动，
    // 否则用户整理一遍标题列表，顺序就按"改标题的时间"乱掉了。
    set({
      items: get().items.map((item) => (item.id === id ? { ...item, title: updated.title } : item)),
    })
  },

  /**
   * 置顶 / 取消置顶。
   *
   * **本地重排而不是重新拉列表**：顺序是确定的（置顶在前、其余按最近更新），
   * 重排一次就够，而重新拉一次会让侧栏在点击后闪一下（列表整体重建）。
   */
  setPinned: async (id, pinned) => {
    const updated = await updateConversation(id, { pinned })
    set({
      items: sortConversations(
        get().items.map((item) => (item.id === id ? { ...item, pinned: updated.pinned } : item)),
      ),
    })
  },

  /** 归档 / 取消归档：归档不是删除，内容与引用都还在。 */
  setArchived: async (id, archived) => {
    const updated = await updateConversation(id, { archived })
    // 两份清单都就地更新：侧栏那份**移除**（归档了就不该再出现在侧栏），
    // 面板那份按当前视图决定留不留（取消归档后还要能看见它）
    set({
      items: archived
        ? get().items.filter((item) => item.id !== id)
        : get().items.map((item) => (item.id === id ? { ...item, ...updated } : item)),
      detailItems: get().detailItems.map((item) =>
        item.id === id ? { ...item, ...updated } : item,
      ),
    })
  },

  /**
   * 把会话挪进工作区，或（``null``）移出项目。
   *
   * 就地替换那一条而**不重排**：与改名/置顶同理——归类是整理动作，
   * 不该把会话顶到"最近活动"的最前面（后端也不推 ``updated_at``）。
   */
  setWorkspace: async (id, workspaceId) => {
    const updated = await updateConversation(id, { workspace_id: workspaceId })
    set({ items: get().items.map((item) => (item.id === id ? { ...item, ...updated } : item)) })
  },

  remove: async (id) => {
    await deleteConversation(id)
    set({
      items: get().items.filter((item) => item.id !== id),
      detailItems: get().detailItems.filter((item) => item.id !== id),
    })
  },

  reset: () => set({ ...EMPTY }),
}))
