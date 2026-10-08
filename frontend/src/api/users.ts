/**
 * 使用者名册接口（`/api/v1/users`）——**只剩那条名册读**。
 *
 * 两层含义共用一张表（v10）：
 * - **纯名册条目**（`username` 为空）：只回答"这份文档是谁传的"，不能登录；
 * - **账号**（`username` 非空）：可登录，有角色与禁用状态。
 *
 * 名册读取要 `require_read`；写与账号管理是 **控制台级**（`require_console`）。
 *
 * ## 2026-10-09：写那一半（开通 / 重置密码 / 禁用 / 删除）整块删掉
 *
 * 它们原先只服务设置弹窗的「用户」那一节，而那一节随账号死面一起下线了
 * （本机档后端 `local_router` 上没有 `users.router`，界面上也没有第二条能成功的路）。
 * **名册读留着**：`lib/operator.ts` 的归属标注与侧栏靠它认出"这份文档是谁传的"。
 */

import { request } from './client'

export type UserRole = 'admin' | 'member'

export interface RosterUser {
  id: string
  name: string
  note: string
  created_at: string | null
  document_count: number
  /** 头像链接（签名 URL，v0.29）。空 = 用名字生成的默认头像。 */
  avatar_url: string
  username: string | null
  role: UserRole
  disabled: boolean
}

export interface Roster {
  items: RosterUser[]
  /** 操作者应当放在哪个请求头里。由后端给出，免得两边各写一份会漂。 */
  header: string
}

export function listUsers(): Promise<Roster> {
  return request('/users')
}
