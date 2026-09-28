/**
 * 工作区（项目）清单（壳这一层；旧前端 `stores/workspaces.ts` 里侧栏用到的那一半）。
 *
 * 侧栏要在导航之下按项目分组列会话，所以这份清单是**首屏就要有的数据**：
 * 它和会话清单一起决定侧栏长什么样，各查一遍必然出现"新建了项目但侧栏没变"。
 *
 * **会话不在这里存**：侧栏把会话按 `workspace_id` 分组渲染，用的是会话那份平铺清单
 * （每条自带 `workspace_id`）。两处各存一份会话，"把某条会话挪进项目"就得同时改两个地方。
 *
 * **项目的建 / 改 / 删 / 归档都在这里**（v0.55）：原先这几件事挂在「工作区」页上，
 * 而那一页已经删掉（用户报的"项目没有重命名 / 归档 / 删除"）——入口改到项目行菜单里，
 * 数据操作就跟着落到这一份 store 上，改完**就地更新 `items`**（与会话那份 store 同一条纪律：
 * 不重拉整份清单，那会让侧栏闪一下）。
 */
import { create } from 'zustand'

import { deleteWorkspace, listWorkspaces, updateWorkspace, type Workspace } from '@/api/workspaces'

/** 按最近更新倒序（与后端 `list_workspaces` 的 ORDER BY 同口径）。 */
function byUpdatedDesc(a: Workspace, b: Workspace): number {
  return (b.updated_at ?? '').localeCompare(a.updated_at ?? '')
}

interface WorkspaceState {
  items: Workspace[]
  loading: boolean
  loaded: boolean
  error: string
  /** 已归档的项目（归档视图；与会话那份"已归档"同一口径）。 */
  archived: Workspace[]
  archivedLoaded: boolean
  load: () => Promise<void>
  /** 拉一次已归档的项目（侧栏那行「已归档（N）」要知道有没有、有几条）。 */
  loadArchived: () => Promise<void>
  /** 会话数变了（新建 / 移动 / 删除会话）时刷新计数——侧栏那个数字要跟着走。 */
  refreshCounts: () => Promise<void>
  /** 重命名（v0.55）。**就地改名字**，不重排：改名是整理动作，不该把项目顶到最前面。 */
  rename: (id: string, name: string) => Promise<void>
  /** 归档 / 取消归档（v0.55）。**不是删除**：里面的会话与内容都还在。 */
  setArchived: (id: string, archived: boolean) => Promise<void>
  /** 删除（v0.55）。后端把里面的会话**退回未归档**，不跟着删。 */
  remove: (id: string) => Promise<void>
  reset: () => void
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  items: [],
  loading: false,
  loaded: false,
  error: '',
  archived: [],
  archivedLoaded: false,

  load: async () => {
    set({ loading: true, error: '' })
    try {
      const result = await listWorkspaces()
      set({ items: result.items, loaded: true })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
    } finally {
      set({ loading: false })
    }
  },

  loadArchived: async () => {
    try {
      const result = await listWorkspaces(true)
      set({ archived: result.items, archivedLoaded: true })
    } catch {
      // 归档视图是"找回来"的入口，拿不到不该把侧栏弄成错误态：保持上一次的样子
    }
  },

  refreshCounts: async () => {
    const result = await listWorkspaces()
    set({ items: result.items })
  },

  rename: async (id, name) => {
    const updated = await updateWorkspace(id, { name })
    set((state) => ({
      items: state.items.map((item) => (item.id === id ? { ...item, name: updated.name } : item)),
      archived: state.archived.map((item) =>
        item.id === id ? { ...item, name: updated.name } : item,
      ),
    }))
  },

  setArchived: async (id, archived) => {
    const updated = await updateWorkspace(id, { archived })
    set((state) => ({
      items: archived
        ? state.items.filter((item) => item.id !== id)
        : [...state.items.filter((item) => item.id !== id), updated].sort(byUpdatedDesc),
      // 归档列表只在**拉过**之后维护：没拉过就等用户点开那一下现拉（`loadArchived`）
      archived: state.archivedLoaded
        ? archived
          ? [updated, ...state.archived.filter((item) => item.id !== id)]
          : state.archived.filter((item) => item.id !== id)
        : state.archived,
    }))
  },

  remove: async (id) => {
    await deleteWorkspace(id)
    set((state) => ({
      items: state.items.filter((item) => item.id !== id),
      archived: state.archived.filter((item) => item.id !== id),
    }))
  },

  reset: () =>
    set({
      items: [],
      loading: false,
      loaded: false,
      error: '',
      archived: [],
      archivedLoaded: false,
    }),
}))

/**
 * 加载过就不再重复拉。
 *
 * 侧栏与每一个行菜单的「移至项目」都要这份清单，而这个函数把"该不该发请求"收在一处：
 * 行菜单**不假设调用方加载过**——不加载的话那一项会静默消失，而"菜单里少一项"
 * 是没人会去查的那种 bug（旧 `ConversationRowMenu` 同一条）。
 */
export async function ensureWorkspacesLoaded(): Promise<void> {
  const state = useWorkspaceStore.getState()
  if (state.loaded || state.loading) return
  await state.load()
}
