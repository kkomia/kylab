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
  /**
   * 能不能在**这一层里**新建目录（v0.41）。
   *
   * 只有专用区域（`WorkspaceBrowse.area`）里为真：容器里除了数据目录几乎处处只读，
   * 与其让用户逐个试，不如把"能建"标在还能建的那一处、把"不能建"的原因标在别的行上。
   */
  creatable: boolean
  /** 不能在这里新建目录的原因（原样显示，界面把它摆在"新建文件夹"旁边）。 */
  create_reason: string
  /** 能不能给它改名（判定与 `renameDirectory` 被拒时同一份）。 */
  renamable: boolean
  /** 不能改名的原因（原样显示）。 */
  rename_reason: string
}

export interface WorkspaceBrowse {
  path: string
  /** **当前这一层自己**（名字 + 能不能选 + 能不能建 + 原因）。服务端给，界面不自己判。 */
  current: DirectoryEntry
  /** 上一级；已经在最上层时为 null。 */
  parent: string | null
  entries: DirectoryEntry[]
  /** 起点（**专用区域** / 家目录 / 盘符 / 已有工作区的目录）。 */
  roots: DirectoryEntry[]
  note: string
  /**
   * 专用可写区域（`<data_dir>/workspaces`）：选择器的默认落脚点，
   * 也是**唯一**能新建/改名目录的地方（v0.41）。
   *
   * 由服务端给而不是前端拼：数据目录在哪只有服务端知道。
   */
  area: string
}

/**
 * 列服务器上的目录（选工作区根目录用，v0.35）。
 *
 * **服务端的活**：工作区根目录是**服务器上**的路径，而浏览器里的目录选择器给的是
 * 客户端本机的东西——指向的是另一台机器。所以"选择"只能是"服务端列给你看"。
 * 管理员专属（成员建工作区只需填路径）。
 *
 * 不给 `path` 时落在**专用区域**：那是唯一能新建目录的地方，也是打开选择器时
 * 最该看到的地方（家目录在容器里往往只读甚至不存在）。
 */
export function browseDirectories(path?: string): Promise<WorkspaceBrowse> {
  const query = path ? `?path=${encodeURIComponent(path)}` : ''
  return request<WorkspaceBrowse>(`/workspaces/browse${query}`)
}

/**
 * 在服务器上新建一个目录（只建一层，重名会被拒）。
 *
 * **只在专用区域里能建**：`parent` 不在区域里时服务端会拒（422），
 * 而界面早就用那一行的 `creatable` / `create_reason` 把按钮灰掉了——
 * 两边判定同一份，所以不会"按钮亮着、点了却报错"。
 */
export function createDirectory(parent: string, name: string): Promise<DirectoryEntry> {
  return request<DirectoryEntry>('/workspaces/dirs', {
    method: 'POST',
    body: JSON.stringify({ parent, name }),
  })
}

/** 给服务器上的目录改名（**只改名，不搬位置**；同样只在专用区域里）。 */
export function renameDirectory(path: string, name: string): Promise<DirectoryEntry> {
  return request<DirectoryEntry>('/workspaces/dirs', {
    method: 'PATCH',
    body: JSON.stringify({ path, name }),
  })
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
