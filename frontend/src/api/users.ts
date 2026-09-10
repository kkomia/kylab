/**
 * 使用者名册接口（`/api/v1/users`，调研报告 G6）。
 *
 * **名册不是鉴权**：它只回答"是谁传的"，不决定"能做什么"。
 * 伪造一个名字不会获得任何权限，只会让归属记错。
 */

import { request } from './client'

export interface RosterUser {
  id: string
  name: string
  note: string
  created_at: string | null
  document_count: number
}

export interface Roster {
  items: RosterUser[]
  /** 操作者应当放在哪个请求头里。由后端给出，免得两边各写一份会漂。 */
  header: string
}

export function listUsers(): Promise<Roster> {
  return request('/users')
}

export function createUser(name: string, note = ''): Promise<RosterUser> {
  return request('/users', {
    method: 'POST',
    body: JSON.stringify({ name, note }),
  })
}

export function deleteUser(userId: string): Promise<void> {
  return request(`/users/${userId}`, { method: 'DELETE' })
}
