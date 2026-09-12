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
  /** 本条会话是否开启思考（v16）；`null` = 跟随全局默认。界面据此回填思考开关。 */
  thinking: boolean | null
  /** 本条会话的思考强度（v16）；`null` = 跟随全局默认。 */
  thinking_effort: 'low' | 'medium' | 'high' | null
  created_at: string | null
  updated_at: string | null
  message_count: number
}

/** 对话的思考偏好（请求级参数，随会话保存）。 */
export interface ConversationThinking {
  thinking?: boolean | null
  thinking_effort?: 'low' | 'medium' | 'high' | null
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
  thinking?: ConversationThinking,
): Promise<ConversationSummary> {
  return request('/conversations', {
    method: 'POST',
    body: JSON.stringify({
      kb_ids: kbIds,
      model_pk: modelPk ?? null,
      // 不带思考偏好时不发字段：让后端按"跟随全局默认"处理，
      // 而不是把它写成一个我们这边猜出来的值
      ...(thinking?.thinking !== undefined ? { thinking: thinking.thinking } : {}),
      ...(thinking?.thinking_effort ? { thinking_effort: thinking.thinking_effort } : {}),
    }),
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
