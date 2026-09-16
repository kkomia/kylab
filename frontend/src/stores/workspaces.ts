/**
 * 工作区清单（Pinia，v0.15）。
 *
 * 侧栏要在导航之上按工作区分组列会话，所以这份清单是**首屏就要有的数据**：
 * 它和会话清单一起决定侧栏长什么样，各查一遍必然出现"新建了工作区但侧栏没变"。
 *
 * **会话不在这里存**：侧栏把会话按 `workspace_id` 分组渲染，用的是会话 store 里
 * 那一份平铺清单（每条自带 `workspace_id`）。两处各存一份会话，
 * "把某条会话挪进工作区"就得同时改两个地方。
 */

import { defineStore } from 'pinia'

import {
  createWorkspace,
  deleteWorkspace,
  listWorkspaces,
  updateWorkspace,
  type Workspace,
  type WorkspacePayload,
} from '@/api/workspaces'

interface State {
  items: Workspace[]
  loading: boolean
  loaded: boolean
  error: string
}

export const useWorkspaceStore = defineStore('workspaces', {
  state: (): State => ({ items: [], loading: false, loaded: false, error: '' }),

  getters: {
    /** id → 工作区。侧栏按会话的 `workspace_id` 找归属时用。 */
    byId(state): Map<string, Workspace> {
      return new Map(state.items.map((item) => [item.id, item]))
    },
  },

  actions: {
    async load(): Promise<void> {
      this.loading = true
      this.error = ''
      try {
        const result = await listWorkspaces()
        this.items = result.items
        this.loaded = true
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error)
      } finally {
        this.loading = false
      }
    },

    async create(payload: WorkspacePayload): Promise<Workspace> {
      const record = await createWorkspace(payload)
      this.items = [record, ...this.items]
      return record
    },

    async update(workspaceId: string, payload: Partial<WorkspacePayload>): Promise<Workspace> {
      const record = await updateWorkspace(workspaceId, payload)
      this.items = this.items.map((item) => (item.id === record.id ? record : item))
      return record
    },

    async remove(workspaceId: string): Promise<void> {
      await deleteWorkspace(workspaceId)
      this.items = this.items.filter((item) => item.id !== workspaceId)
    },

    /** 会话数变了（新建/移动/删除会话）时刷新计数——侧栏那个数字要跟着走。 */
    async refreshCounts(): Promise<void> {
      const result = await listWorkspaces()
      this.items = result.items
    },

    $reset(): void {
      this.items = []
      this.loading = false
      this.loaded = false
      this.error = ''
    },
  },
})
