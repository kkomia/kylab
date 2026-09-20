/**
 * 对话留存接口（`/api/v1/conversations`，开发计划 §11.2）。
 *
 * 与 `chat.ts` 的分工：那边负责"问一个问题"，这边负责"回看问过什么"。
 * 分开是因为前端的提问路径不该被会话状态污染——`/chat` 依然可以完全无状态地调用
 * （脚本、MCP 都走那条），只有界面上的对话才带上 `conversation_id`。
 */

import { request } from './client'
import type { ChatSource } from './chat'
import type { ThinkingEffort } from './chat'
import type { components } from './schema'

/**
 * 会话摘要：**契约来自后端的 OpenAPI**（`./schema.d.ts`，由
 * `scripts/gen_api_types.py` 生成）。
 *
 * 两条约定，这个文件里其余接口也照这个来：
 *
 * - **`Required<…>` 包一层**：后端 schema 里带默认值的字段（`kb_ids` / `pinned` /
 *   `message_count`…）在 OpenAPI 里是**可选**的，但 Pydantic 序列化时一定会带上。
 *   照抄 `?` 会让全站凭空多出几百处空值检查——那是类型在替后端"可能不发"背书，
 *   而它其实每次都发。
 * - **该收窄的显式收窄**：`thinking_effort` 在 schema 里是 `string`（归一化在服务端做），
 *   而界面只认三档。用 `Omit` + 重新声明把它收回来，并写清为什么——
 *   这样"契约变宽"时至少留下了一处需要人判断的地方，而不是静默放松。
 */
type ConversationOut = Required<components['schemas']['ConversationOut']>

export type ConversationSummary = Omit<ConversationOut, 'thinking_effort'> & {
  /** 本条会话的思考强度（v16）；`null` = 跟随全局默认。 */
  thinking_effort: ThinkingEffort | null
}

/** 对话的思考偏好（请求级参数，随会话保存）。 */
export interface ConversationThinking {
  thinking?: boolean | null
  thinking_effort?: 'low' | 'medium' | 'high' | null
}

type ChatMessageOut = Required<components['schemas']['ChatMessageOut']>

/**
 * 库里存下的一条消息（历史回放用）：契约来自后端的 OpenAPI。
 *
 * 两处显式处理，都因为**存下来的数据比 schema 老**：
 *
 * - `sources` 用本项目的 `ChatSource` 而不是 schema 里的那个字段类型：
 *   快照是**当年写下的**，v25 之前的没有 `document_summary`（见 `ChatSource` 的说明）；
 * - `role` 在 schema 里就是开放的 `string`——后端存的是模型给的原文角色，
 *   将来多一种（工具消息之类）时界面不该崩，渲染时按已知的两种分派。
 */
export type StoredMessage = Required<Omit<ChatMessageOut, 'sources'>> & {
  sources: ChatSource[]
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

// ------------------------------------------------------------------ 会话产物（v0.26）

/**
 * 会话产出的一份文件。契约同样来自后端的 OpenAPI。
 *
 * `storage` 显式收窄成三档：界面据此决定说"在 工作区「X」"还是"本会话"。
 * 后端 schema 里它是开放的 `string`（那一列存的是服务端自己的词），
 * 而界面只认这几种——多出第四种时应当是一个要人来判断的地方，不是静默显示空白。
 * `document` 那一档是"直接进的库"（外部 MCP 通道导出时走的老路），界面上不再出现。
 */
type ArtifactOut = Required<components['schemas']['ConversationArtifactOut']>

export type ConversationArtifact = Omit<ArtifactOut, 'storage'> & {
  storage: 'workspace' | 'object' | 'document'
}

/**
 * 这条会话产出了哪些文件——**卡片状态的权威来源**。
 *
 * 步骤快照里那份是流式当时的样子（"刚导出"），这份是**现在的样子**（可能已经入库）。
 * 回看历史会话时以这份为准，否则刷新一下，卡片上的"已存进知识库"就退回去了。
 */
export function listArtifacts(conversationId: string): Promise<{ items: ConversationArtifact[] }> {
  return request(`/conversations/${conversationId}/artifacts`)
}

// ------------------------------------------------------------------ 文件区（v0.26）

type FileListing = components['schemas']['FileListingOut']

/**
 * 文件区里的一行。
 *
 * **展开写而不是 `Required<FileEntry>`**：那份 schema 里除了 `key` 全带默认值，
 * 于是 `Required` 会把 `modified_at` 变成"一定有值"，而界面确实要构造一种
 * "还没从列表里拿到、先按 key 直接预览"的条目（见 `FileDrawer.openInitial`）。
 * 类型逼着那种条目补一个假时间戳，就是在逼代码说谎。
 */
export interface ConversationFile {
  key: string
  name: string
  is_dir: boolean
  size_bytes: number
  modified_at: string | null
  kind: string
}

export interface ConversationFileListing {
  mode: string
  label: string
  path: string
  parent: string | null
  entries: ConversationFile[]
  truncated: boolean
}

/**
 * 这条会话的文件区：**一条会话恰好有一个**。
 *
 * 挂了工作区就是那个真实目录（`mode: "workspace"`，能带 `path` 进子目录）；
 * 没挂就是会话自己的临时区（`mode: "object"`，平铺）。
 * 哪一种是服务端算的——**界面不问、也不猜**，这与"产物落在哪"用的是同一份判断。
 */
export function listFiles(conversationId: string, path = ''): Promise<ConversationFileListing> {
  const params = new URLSearchParams()
  if (path) params.set('path', path)
  const query = params.toString()
  return request<FileListing>(
    `/conversations/${conversationId}/files${query ? `?${query}` : ''}`,
  ).then((raw) => ({
    mode: raw.mode,
    label: raw.label,
    path: raw.path ?? '',
    parent: raw.parent ?? null,
    entries: (raw.entries ?? []) as ConversationFile[],
    truncated: raw.truncated ?? false,
  }))
}

/** 往文件区里放一份文件（界面上的"上传"）。同名不覆盖，服务端会退到 `名字 (2).ext`。 */
export function uploadFile(
  conversationId: string,
  file: File,
  path = '',
): Promise<ConversationFile> {
  const body = new FormData()
  body.append('file', file)
  const params = new URLSearchParams()
  if (path) params.set('path', path)
  const query = params.toString()
  return request<ConversationFile>(
    `/conversations/${conversationId}/files${query ? `?${query}` : ''}`,
    { method: 'POST', body },
  )
}

/**
 * 换一条文件的链接——**预览与下载共用**。
 *
 * **为什么不能直接给路径**：工作区那份是服务器上的绝对路径、临时区那份是对象存储的
 * Key，两者都只有服务端读得到；而 `<iframe>`、`<img>` 与下载按钮都带不了
 * Authorization 头。签名 URL 把"你有权取这份"编码进链接本身，并给它一个到期时间。
 *
 * `disposition: 'inline'` 只是**请求**内联（PDF / 图片要它才能在页面里渲染），
 * 真正批不批由服务端按后缀复核——一份能带 `<script>` 的 SVG 内联在本站 origin 下
 * 就是存储型 XSS。所以这里传了也不算越权。
 */
export function getFileUrl(
  conversationId: string,
  key: string,
  disposition: 'attachment' | 'inline' = 'attachment',
): Promise<{ url: string; expires_at: number; name: string }> {
  const params = new URLSearchParams({ key, disposition })
  return request(`/conversations/${conversationId}/files/download-url?${params.toString()}`)
}

/** 下载：换一条链接，再用一个临时 `<a download>` 点它。 */
export async function downloadFile(conversationId: string, key: string): Promise<void> {
  const { url } = await getFileUrl(conversationId, key)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

/**
 * 把一份产物存进知识库——**显式动作**，用户点了那个按钮才会发生。
 *
 * `knowledgeBaseId` 必须由调用方给：服务端不会替他挑一个，
 * 那正是这一版要修掉的行为。
 */
export function ingestArtifact(
  conversationId: string,
  artifactId: string,
  knowledgeBaseId: string,
): Promise<ConversationArtifact> {
  return request(`/conversations/${conversationId}/artifacts/${artifactId}/ingest`, {
    method: 'POST',
    body: JSON.stringify({ knowledge_base_id: knowledgeBaseId }),
  })
}
