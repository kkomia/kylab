/**
 * 对话留存接口（`/api/v1/conversations`，开发计划 §11.2）。
 *
 * 与 `chat.ts` 的分工：那边负责"问一个问题"，这边负责"回看问过什么"。
 * 分开是因为前端的提问路径不该被会话状态污染——`/chat` 依然可以完全无状态地调用
 * （脚本、MCP 都走那条），只有界面上的对话才带上 `conversation_id`。
 */

import { request } from './client'
import type { ChatSource } from './chat'

export interface ConversationSummary {
  id: string
  title: string
  kb_ids: string[]
  /** 本条会话选用的对话模型（v12）；`null` = 跟随全局默认。界面据此回填模型选择器。 */
  model_pk: string | null
  created_at: string | null
  updated_at: string | null
  message_count: number
}

export interface StoredMessage {
  id: string
  role: 'user' | 'assistant' | string
  content: string
  sources: ChatSource[]
  created_at: string | null
}

export interface ConversationDetail extends ConversationSummary {
  messages: StoredMessage[]
}

export function listConversations(limit = 50): Promise<{ items: ConversationSummary[] }> {
  return request(`/conversations?limit=${limit}`)
}

export function createConversation(
  kbIds: string[],
  modelPk?: string | null,
): Promise<ConversationSummary> {
  return request('/conversations', {
    method: 'POST',
    body: JSON.stringify({ kb_ids: kbIds, model_pk: modelPk ?? null }),
  })
}

export function getConversation(id: string): Promise<ConversationDetail> {
  return request(`/conversations/${id}`)
}

export function renameConversation(id: string, title: string): Promise<ConversationSummary> {
  return request(`/conversations/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  })
}

export function deleteConversation(id: string): Promise<void> {
  return request(`/conversations/${id}`, { method: 'DELETE' })
}
