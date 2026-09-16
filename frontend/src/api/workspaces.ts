/**
 * 工作区接口（对应后端 `/api/v1/workspaces`，v0.15）。
 *
 * 工作区是 **Agent 的项目**：一个用户指定的根目录 + 一组知识库。
 * 它把"这个 Agent 在哪儿干活、能查哪些资料"绑在一起——
 * 所以 `kb_ids` 不是可选装饰，新会话默认继承它（见后端 conversations.py）。
 */

import { request } from './client'

export interface Workspace {
  id: string
  name: string
  /** 用户指定的根目录（绝对路径）。Agent 的文件操作被约束在这里。 */
  root_path: string
  description: string
  /** 这个工作区绑定的知识库。新会话默认继承它们。 */
  kb_ids: string[]
  conversation_count: number
  created_at: string | null
  updated_at: string | null
}

export interface WorkspacePayload {
  name: string
  root_path: string
  description?: string
  kb_ids?: string[]
}

export function listWorkspaces(): Promise<{ items: Workspace[] }> {
  return request<{ items: Workspace[] }>('/workspaces')
}

export function createWorkspace(payload: WorkspacePayload): Promise<Workspace> {
  return request<Workspace>('/workspaces', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function updateWorkspace(
  workspaceId: string,
  payload: Partial<WorkspacePayload>,
): Promise<Workspace> {
  return request<Workspace>(`/workspaces/${workspaceId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
}

/** 删工作区。**里面的会话不会被删**，它们退回"未归档"那一栏。 */
export function deleteWorkspace(workspaceId: string): Promise<void> {
  return request<void>(`/workspaces/${workspaceId}`, { method: 'DELETE' })
}
