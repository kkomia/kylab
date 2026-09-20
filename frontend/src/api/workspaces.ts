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

/** 目录浏览里的一行：一个子目录，或一个"起点"。 */
export interface DirectoryEntry {
  name: string
  path: string
  /** 能不能直接拿它当工作区。**与建工作区时同一份判定**，所以灰掉的也建不出来。 */
  selectable: boolean
  /** 不能选的原因（原样显示）。 */
  reason: string
}

export interface WorkspaceBrowse {
  path: string
  /** **当前这一层自己**（名字 + 能不能选 + 不能选的原因）。服务端给，界面不自己判。 */
  current: DirectoryEntry
  /** 上一级；已经在最上层时为 null。 */
  parent: string | null
  entries: DirectoryEntry[]
  /** 起点（家目录 / 盘符 / 已有工作区的目录）。 */
  roots: DirectoryEntry[]
  note: string
}

/**
 * 列服务器上的目录（选工作区根目录用，v0.35）。
 *
 * **服务端的活**：工作区根目录是**服务器上**的路径，而浏览器里的目录选择器给的是
 * 客户端本机的东西——指向的是另一台机器。所以"选择"只能是"服务端列给你看"。
 * 管理员专属（成员建工作区只需填路径）。
 */
export function browseDirectories(path?: string): Promise<WorkspaceBrowse> {
  const query = path ? `?path=${encodeURIComponent(path)}` : ''
  return request<WorkspaceBrowse>(`/workspaces/browse${query}`)
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
