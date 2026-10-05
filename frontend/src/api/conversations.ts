/**
 * 对话留存接口（`/api/v1/conversations`，开发计划 §11.2）。
 *
 * 与 `chat.ts` 的分工：那边负责"问一个问题"，这边负责"回看问过什么"。
 * 分开是因为前端的提问路径不该被会话状态污染——`/chat` 依然可以完全无状态地调用
 * （脚本、MCP 都走那条），只有界面上的对话才带上 `conversation_id`。
 *
 * ## 这个文件里的类型为什么**手写**了（2026-10-05，NAS 网页端退役）
 *
 * 原先这里有四个类型取自 `./schema.d.ts`（`ConversationOut` / `ChatMessageOut` /
 * `ConversationArtifactOut` / `FileListingOut`）。**服务器档从这一轮起不再挂会话面**
 * （`backend/app/api/v1/router.py`：那一档只留 `/conversations/export`），而生成物
 * （`schema.d.ts` 与《API 接口规范》）是按**服务器档的 OpenAPI** 生成的 ——
 * 于是那四个模型从契约里消失了，而边车那一档照旧提供它们（`local_router`）。
 *
 * 处置按本项目对"只在本机档成立的端点"的既有先例（`api/local.ts` / `api/provider.ts` /
 * `api/backup.ts` 的 `/local/*` 那一族）：**手写 + 写清出处**。字段逐条对着
 * `backend/app/api/v1/schemas.py` 的同名模型抄，**改了后端就回来改这里**
 * （`tests/api-conversations.test.ts` 钉住这一份用到的形状）。
 * 只手写"这一轮从生成物里掉出去"的那四个；`ChatSourceOut` 也一起掉了出去（`/chat/*`
 * 那一族同样从服务器档退役），它的手写版在 `chat.ts` 里，这一份从那里 import。
 */

// 会话 / 消息 / 事件 / 产物 / 文件区**都在本机**（M2 §4.2 的本机白名单）：这一份的接口
// 全部走 `requestLocal`（会话数据的权威面是边车那台的本机库，不是 NAS）；
// 后端回的**相对**签名链接（预览/下载）要过 `localizeUrl` 才打得通，见 `getFileUrl`。
import { requestLocal } from './client'
import { localizeUrl } from './sidecar'
import type { ChatAttachment } from './chat'
import type { ChatSource } from './chat'
import type { ChatSourceOut } from './chat'
import type { ThinkingEffort } from './chat'

/**
 * 会话摘要（`schemas.py::ConversationOut`，逐字段抄；**服务端一定会回全这几项**，
 * 所以这里没有可选字段——原先那个 `Required<…>` 就是把这件事写出来）。
 *
 * `thinking_effort` 按界面的口径收窄成三档：服务端那边是开放字符串（归一化在它那里做），
 * 而界面只认这三档。**这里收窄是刻意的**：契约变宽时应当留下一处要人来判断的地方。
 */
export interface ConversationSummary {
  id: string
  title: string
  kb_ids: string[]
  /** 本条会话选用的对话模型；`null` = 全局默认。 */
  model_pk: string | null
  /** 本条会话是否开启思考；`null` = 全局默认。 */
  thinking: boolean | null
  /** 本条会话的思考强度（v16）；`null` = 跟随全局默认。 */
  thinking_effort: ThinkingEffort | null
  /** 置顶（v17）：置顶的会话排在列表最前，且聊天不改变它的名次。 */
  pinned: boolean
  /** 所属工作区（v0.15）；`null` = 未归档。 */
  workspace_id: string | null
  /** 归档时间（v0.17）。非空 = 已归档——**归档不是删除**。 */
  archived_at: string | null
  /** 最近一条回答的开头一段（历史会话面板的两行预览）。 */
  preview: string
  created_at: string | null
  updated_at: string | null
  message_count: number
}

/** 对话的思考偏好（请求级参数，随会话保存）。 */
export interface ConversationThinking {
  thinking?: boolean | null
  thinking_effort?: 'low' | 'medium' | 'high' | null
}

/**
 * 库里存下的一条消息的**线形状**（`schemas.py::ChatMessageOut`）。
 *
 * `sources` / `attachments` 在这里被 `StoredMessage` 换掉（见下），
 * 所以这个接口只描述"服务端原样回的那几项"。
 */
interface ChatMessageOut {
  id: string
  role: string
  content: string
  sources: ChatSourceOut[]
  steps: Record<string, unknown>[]
  thinking: string
  attachments: ChatAttachment[]
  created_at: string | null
}

/**
 * 库里存下的一条消息（历史回放用；线的形状见上面那个 `ChatMessageOut`）。
 *
 * 三处显式处理，都因为**存下来的数据比后端 schema 老**：
 *
 * - `sources` 用本项目的 `ChatSource` 而不是 schema 里那个字段类型：
 *   快照是**当年写下的**，v25 之前的没有 `document_summary`（见 `ChatSource` 的说明）；
 * - `role` 是开放的 `string`——后端存的是模型给的原文角色，
 *   将来多一种（工具消息之类）时界面不该崩，渲染时按已知的两种分派；
 * - `attachments` **显式留成可选**（v0.55）：老消息没有这一项（后端只对用户消息回填，
 *   而那批数据里没有），必有字段会把它变成"一定有"——那才是替后端"可能不发"背书。
 *   助手消息也恒为空，只有用户消息带它。
 */
export type StoredMessage = Omit<ChatMessageOut, 'sources' | 'attachments'> & {
  sources: ChatSource[]
  attachments?: ChatAttachment[]
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
  return requestLocal(`/conversations?${params.toString()}`)
}

export function createConversation(
  kbIds: string[],
  modelPk?: string | null,
  thinking?: ConversationThinking,
  workspaceId?: string | null,
): Promise<ConversationSummary> {
  return requestLocal('/conversations', {
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
  return requestLocal(`/conversations/${id}`)
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
  return requestLocal(`/conversations/${id}`, {
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
  return requestLocal(`/conversations/${id}/rewind`, {
    method: 'POST',
    body: JSON.stringify({ turns }),
  })
}

export function deleteConversation(id: string): Promise<void> {
  return requestLocal(`/conversations/${id}`, { method: 'DELETE' })
}

// ------------------------------------------------------------------ 会话产物（v0.26）

/**
 * 会话产出的一份文件（`schemas.py::ConversationArtifactOut`，逐字段抄）。
 *
 * `storage` 显式收窄成三档：界面据此决定说"在 工作区「X」"还是"本会话"。
 * 后端那边它是开放的 `string`（那一列存的是服务端自己的词），
 * 而界面只认这几种——多出第四种时应当是一个要人来判断的地方，不是静默显示空白。
 * `document` 那一档是"直接进的库"（外部 MCP 通道导出时走的老路），界面上不再出现。
 */
export interface ConversationArtifact {
  artifact_id: string
  name: string
  size_bytes: number
  /** 扩展名小写（`docx` / `pdf` / …），界面据此选图标。 */
  format: string
  storage: 'workspace' | 'object' | 'document'
  /** 给人看的那句话：「工作区「我的项目」」/「本会话」。 */
  where: string
  /** 工作区那份的绝对路径；对象存储那份没有。 */
  path: string | null
  /** 进了哪个知识库；`null` = 没进，界面据此决定要不要给「存进知识库」。 */
  knowledge_base_id: string | null
  document_id: string | null
  created_at: string | null
}

/**
 * 这条会话产出了哪些文件——**卡片状态的权威来源**。
 *
 * 步骤快照里那份是流式当时的样子（"刚导出"），这份是**现在的样子**（可能已经入库）。
 * 回看历史会话时以这份为准，否则刷新一下，卡片上的"已存进知识库"就退回去了。
 */
export function listArtifacts(conversationId: string): Promise<{ items: ConversationArtifact[] }> {
  return requestLocal(`/conversations/${conversationId}/artifacts`)
}

// ------------------------------------------------------------------ 文件区（v0.26）

/**
 * 一层目录的**线形状**（`schemas.py::FileListingOut` + `FileEntryOut`）。
 *
 * `mode` / `label` 是服务端必回的（它们没有默认值）；其余几项在服务端带默认值，
 * 所以这里写成可选、由下面 `listFiles` 逐个补成 `ConversationFileListing` 里
 * "一定有"的那一份——补默认值的地方只该有一处。
 */
interface FileListing {
  mode: string
  label: string
  path?: string
  parent?: string | null
  entries?: Array<Partial<ConversationFile>>
  truncated?: boolean
}

/**
 * 文件区里的一行。
 *
 * **展开写而不是"照抄那份 schema + 全必有"**：那份 schema 里除了 `key` 全带默认值，
 * 于是"全必有"会把 `modified_at` 变成"一定有值"，而界面确实要构造一种
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
 * 文件区的**两档视图**（v0.55）。
 *
 * 为什么要有两档：这里原先只有"会话挂的那个目录"一种读法，于是同一个项目下所有会话
 * 共用一堆文件，分不出哪份是这次对话传的。现在按**用途**分——用户上传的与 Agent
 * 产出的都算"这次对话的东西"，平铺在 `conversation` 档里、按会话记账；`project` 档
 * 读的是用户**自己的项目目录**（能进子目录），只有挂了工作区才有这一档。界面因此
 * 不必猜"这份属于谁"，只选一档去读。
 */
export type FileScope = 'conversation' | 'project'

/**
 * 这条会话的文件区（`scope` 选哪一档，见 `FileScope`）。
 *
 * `path` **两档都认**（D20 起）：项目档进的是真实子目录；会话档进的是名字里的
 * 相对路径那一层（上传文件夹时 `Composer` 把 `图表/第二季度.png` 当 filename 交过来，
 * 服务端原样存着）——两档因此是同一个形状，界面那套"点目录 → path = entry.key"通用。
 */
export function listFiles(
  conversationId: string,
  path = '',
  scope: FileScope = 'conversation',
): Promise<ConversationFileListing> {
  // scope 显式带上（即使默认档也写清楚）：读请求的人一眼看得出在读哪一档
  const params = new URLSearchParams({ scope })
  if (path) params.set('path', path)
  const query = params.toString()
  return requestLocal<FileListing>(
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

/**
 * 往文件区里放一份文件（界面上的"上传"）。同名不覆盖，服务端会退到 `名字 (2).ext`。
 *
 * **上传一律落会话文件区**（v0.55）：不再写进项目目录——那条路会让同一项目下所有会话
 * 共用一堆文件，且"这份是谁传的"没有记录（用户报的"上传的文件分不开"）。所以这里
 * 不再带 `path`。文件名**可以带相对路径**（`图表/a.png`）：上传文件夹时前端用它保留
 * 目录结构，服务端按它落账。
 */
export function uploadFile(conversationId: string, file: File): Promise<ConversationFile> {
  const body = new FormData()
  body.append('file', file)
  return requestLocal<ConversationFile>(`/conversations/${conversationId}/files`, {
    method: 'POST',
    body,
  })
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
 *
 * 回来的 `url` 要过一遍 `localizeUrl`（M2 §4.3）：本机后端签的是**相对**地址
 * （`/api/v1/...`），它在桌面壳里会落到 `app://localhost` 上、被壳转发去 NAS ✗，
 * 而这份文件在本机对象存储里 —— 表现就是"预览打不开 / 下载 404"。
 */
export async function getFileUrl(
  conversationId: string,
  key: string,
  disposition: 'attachment' | 'inline' = 'attachment',
): Promise<{ url: string; expires_at: number; name: string }> {
  const params = new URLSearchParams({ key, disposition })
  const signed = await requestLocal<{ url: string; expires_at: number; name: string }>(
    `/conversations/${conversationId}/files/download-url?${params.toString()}`,
  )
  return { ...signed, url: await localizeUrl(signed.url) }
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
 * 「取进本会话」（D20）：把**项目档**里的一份文件复制进这条会话的文件区。
 *
 * **与「加入知识库」是两个目的地**（`ingestArtifact`）：这一步进的是**这条会话的
 * 文件区**——Agent 这一轮就能在 `list_conversation_files` 里看到它，别的会话看不到，
 * 删这条会话时一起清；进知识库那条是把它变成长期资料。
 *
 * `path` 就是项目档那一行给的 key（工作区里的相对路径）。服务端只按这条会话自己的
 * 工作区解析它（`..` / 绝对路径 / 符号链接出界都拒），落点与名字也由服务端定。
 * 返回的是**会话文件区里的那一行**（`key` 是新的产物 id），界面据此说清"现在它在会话里"。
 */
export function importWorkspaceFile(
  conversationId: string,
  path: string,
): Promise<ConversationFile> {
  return requestLocal<ConversationFile>(`/conversations/${conversationId}/files/import`, {
    method: 'POST',
    body: JSON.stringify({ path }),
  })
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
  return requestLocal(`/conversations/${conversationId}/artifacts/${artifactId}/ingest`, {
    method: 'POST',
    body: JSON.stringify({ knowledge_base_id: knowledgeBaseId }),
  })
}
