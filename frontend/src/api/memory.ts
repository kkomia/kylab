/**
 * 记忆接口（对应后端 `/api/v1/memory`，v0.14 三期）。
 *
 * **两个概念别混**（见 `docs/设计/记忆层设计-v0.1.md` §2.1）：记忆是"你说的"
 * （无出处、可改、高频写），知识库是"文献说的"。所以这里没有任何字段指向文档、
 * 片段或向量——记忆页只碰记忆那一侧的 Markdown 文件。
 *
 * `content` 是**原文**（含 frontmatter）：编辑器存回去要逐字还原，
 * 因此这一层进出的都是完整 Markdown 字符串，不解析、不结构化。
 */

import { request } from './client'

/** 文件分类，按它在工作区里的位置分（位置就是它的分层）。 */
export type MemoryKind = 'core' | 'daily' | 'digest' | 'other'

export interface MemoryFile {
  path: string
  name: string
  title: string
  kind: MemoryKind
  summary: string
  tags: string[]
  size_bytes: number
  modified_at: string
  /** 正文里的 `[[…]]` 目标（原文，含写错的那些）。 */
  links: string[]
  /**
   * `recall` 找不找得到它。
   *
   * **只有 `daily/` 与 `digest/` 为 true**：它们是召回池。`MEMORY.md` / `SOUL.md`
   * 走注入（每轮进 system prompt），其余目录既不召回也不注入。界面上必须说清这条，
   * 否则用户改完一个文件搜不到，会以为是检索坏了。
   */
  retrievable: boolean
  /** 每轮对话会不会被注入 system prompt（只有两个核心文件）。 */
  injected: boolean
  /** `daily` 专有：有没有被 `digest/` 里的文件链到（= 是否已被整合）。 */
  consolidated: boolean
}

export interface MemoryFileDetail extends Omit<MemoryFile, 'consolidated'> {
  content: string
  /** frontmatter 解析结果。**解析失败时是空对象**（正文原样返回，用户能修）。 */
  meta: Record<string, unknown>
  truncated: boolean
  /** 读单个文件时**恒为 null**（= 没算）：整合状态要跨文件才知道。 */
  consolidated: null
}

/**
 * 记忆的本地状态。**没有"连没连上"这一项**：记忆跑在后端自己的进程里，
 * 没有第二个进程可连，所以也没有可探测的东西。
 */
export interface MemoryStatus {
  enabled: boolean
  workspace: string
  core_file_exists: boolean
  detail: string
  /** 工作区里的记忆文件份数。 */
  file_count: number
  /** 其中进入召回池的份数（`daily/` 与 `digest/`）。 */
  retrievable_count: number
  /** **可召回的条数**（召回池按行切出来的块数）。 */
  entry_count: number
  /** 记忆内容最后一次改动的时间（界面上写"上次更新"）。 */
  last_changed_at: string
  /** `daily/` 里还没被 `digest/` 链到的条数。 */
  unconsolidated_count: number
}

export interface MemoryOverview {
  status: MemoryStatus
  files: MemoryFile[]
  /** 文件数到扫描上限被截断——列表不完整这件事要让用户知道。 */
  truncated: boolean
}

export interface MemoryHit {
  text: string
  path: string
  start_line: number | null
  end_line: number | null
  /** 排序用的分。**只在本条查询内可比**（跟工作区里有几块正文有关）。 */
  score: number | null
  /** 命中判据：查询里的实词有多少比例出现在这一块（0–1）。 */
  coverage: number | null
}

export interface MemoryLink {
  path: string
  direction: 'out' | 'in'
  name: string
}

export interface MemoryRecall {
  query: string
  hits: MemoryHit[]
  links: MemoryLink[]
  note: string
}

export interface MemoryGraphNode {
  path: string
  title: string
  kind: MemoryKind
  degree: number
}

export interface MemoryGraph {
  nodes: MemoryGraphNode[]
  edges: [string, string][]
  /** 写了但没解析到文件的链接 `[来自哪份, 原始目标]`。 */
  dangling: [string, string][]
}

export interface MemoryRemember {
  saved: boolean
  entries: number
  reason: string
}

export function getMemory(): Promise<MemoryOverview> {
  return request<MemoryOverview>('/memory')
}

/**
 * 读一个文件的原文。
 *
 * **路径按段编码**（每段单独 `encodeURIComponent`）：`digest/wiki/x.md` 里的
 * 斜杠是路径分隔符、必须原样留着，靠 `:path` 参数接住；而文件名里可能有
 * `#`、`?`、空格这类会截断 URL 的字符，那些要编码。
 */
export function getMemoryFile(path: string): Promise<MemoryFileDetail> {
  return request<MemoryFileDetail>(`/memory/files/${encodePath(path)}`)
}

export function writeMemoryFile(path: string, content: string): Promise<MemoryFileDetail> {
  return request<MemoryFileDetail>(`/memory/files/${encodePath(path)}`, {
    method: 'PUT',
    body: JSON.stringify({ content }),
  })
}

export function deleteMemoryFile(path: string): Promise<void> {
  return request<void>(`/memory/files/${encodePath(path)}`, { method: 'DELETE' })
}

export function getMemoryGraph(): Promise<MemoryGraph> {
  return request<MemoryGraph>('/memory/graph')
}

/** 在记忆里召回。**与知识库检索是两条路**，结果不合并。 */
export function recallMemory(query: string, limit?: number): Promise<MemoryRecall> {
  return request<MemoryRecall>('/memory/recall', {
    method: 'POST',
    body: JSON.stringify({ query, limit: limit ?? null }),
  })
}

export function rememberMemory(content: string, tags: string[] = []): Promise<MemoryRemember> {
  return request<MemoryRemember>('/memory/remember', {
    method: 'POST',
    body: JSON.stringify({ content, tags }),
  })
}

function encodePath(path: string): string {
  return path
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}
