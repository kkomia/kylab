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
  /** 置顶（v17）。置顶的排在列表最前，且聊天不改变它的名次。 */
  pinned: boolean
  /** 所属工作区（v0.15）；`null` = 未归档。 */
  workspace_id: string | null
  /** 归档时间（v0.17）。非空 = 已归档——**归档不是删除**，内容还在，可随时取消。 */
  archived_at?: string | null
  /** 最近一条回答的开头（历史会话面板的两行预览）。只有带 `with_preview` 时才有。 */
  preview?: string
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

/**
 * 会话列表：**置顶优先，其次最近更新**。
 *
 * `q` 交给后端做（标题包含匹配）：只在已加载的前 50 条里筛，会搜不到更早的会话，
 * 而用户搜标题恰恰常常是为了找回很久以前的那条。
 */
export function listConversations(
  limit = 50,
  q?: string,
  filter: {
    workspaceId?: string
    ungrouped?: boolean
    archived?: boolean
    withPreview?: boolean
  } = {},
): Promise<{ items: ConversationSummary[] }> {
  const params = new URLSearchParams({ limit: String(limit) })
  if (q?.trim()) params.set('q', q.trim())
  if (filter.workspaceId) params.set('workspace_id', filter.workspaceId)
  if (filter.ungrouped) params.set('ungrouped', 'true')
  if (filter.archived) params.set('archived', 'true')
  // 预览要多一次查询，所以是**可选**的：侧栏不需要，历史面板需要
  if (filter.withPreview) params.set('with_preview', 'true')
  return request(`/conversations?${params.toString()}`)
}

export function createConversation(
  kbIds: string[],
  modelPk?: string | null,
  thinking?: ConversationThinking,
  workspaceId?: string | null,
): Promise<ConversationSummary> {
  return request('/conversations', {
    method: 'POST',
    body: JSON.stringify({
      kb_ids: kbIds,
      model_pk: modelPk ?? null,
      // 挂到工作区（v0.15）：kb_ids 留空时后端会**继承工作区的库**，
      // 这就是"进入项目，资料范围就定了"落到行为上的样子
      workspace_id: workspaceId ?? null,
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

/**
 * 改会话的标题 / 置顶。**两者都可选**，只传要改的那个。
 */
export function updateConversation(
  id: string,
  patch: {
    title?: string
    pinned?: boolean
    archived?: boolean
    workspace_id?: string | null
  },
): Promise<ConversationSummary> {
  return request(`/conversations/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

/**
 * 回退最近 N 轮问答，返回**被删掉的那句提问**（供「重新生成」重发）。
 *
 * 重发不在这里做：回答是流式的，必须走 `chatStream`。所以这个接口只负责
 * "把会话退回到提问之前"，生成交给对话页那条现成的链路。
 */
export function rewindConversation(
  id: string,
  turns = 1,
): Promise<{ query: string; removed: number }> {
  return request(`/conversations/${id}/rewind`, {
    method: 'POST',
    body: JSON.stringify({ turns }),
  })
}

export function deleteConversation(id: string): Promise<void> {
  return request(`/conversations/${id}`, { method: 'DELETE' })
}
