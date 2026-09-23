/**
 * 工作区清单（壳这一层；旧前端 `stores/workspaces.ts` 里侧栏用到的那一半）。
 *
 * 侧栏要在导航之下按工作区分组列会话，所以这份清单是**首屏就要有的数据**：
 * 它和会话清单一起决定侧栏长什么样，各查一遍必然出现"新建了工作区但侧栏没变"。
 *
 * **会话不在这里存**：侧栏把会话按 `workspace_id` 分组渲染，用的是会话那份平铺清单
 * （每条自带 `workspace_id`）。两处各存一份会话，"把某条会话挪进工作区"就得同时改两个地方。
 *
 * 建 / 改 / 删工作区本身留在**工作区页**（那是它的主路径）：壳里只读清单与刷新计数。
 */
import { create } from 'zustand'

import { listWorkspaces, type Workspace } from '@/api/workspaces'

interface WorkspaceState {
  items: Workspace[]
  loading: boolean
  loaded: boolean
  error: string
  load: () => Promise<void>
  /** 会话数变了（新建 / 移动 / 删除会话）时刷新计数——侧栏那个数字要跟着走。 */
  refreshCounts: () => Promise<void>
  reset: () => void
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  items: [],
  loading: false,
  loaded: false,
  error: '',

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

  refreshCounts: async () => {
    const result = await listWorkspaces()
    set({ items: result.items })
  },

  reset: () => set({ items: [], loading: false, loaded: false, error: '' }),
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
