/**
 * 记忆接口（对应后端 `/api/v1/memory`，档案制三期）。
 *
 * **两个概念别混**（见 `docs/设计/记忆档案-设计-v0.1.md` §7.1）：记忆是"你说的"
 * （无出处、可改、高频写），知识库是"文献说的"。所以这里没有任何字段指向文档、
 * 片段或向量——记忆页只碰记忆那一侧的 Markdown 文件。
 *
 * **一份档案**：记忆的本体是工作区里的 `PROFILE.md`（四个固定分区），
 * 外加一份 `changes.md`（变更流，不进注入）。档案的写入只有按条目这一条路——
 * 改一条走 `rememberMemory(..., { replaces })`、删一条走 `forgetMemory`、
 * 还原一条走 `restoreMemory`、项目组改名走 `renameMemoryGroup`。
 * **整份文件的覆盖端点已经删掉**（§6.3）：它是一个绕过预算与变更流的后门。
 *
 * `content` 是**原文**（含 frontmatter）：只读展示要逐字还原，所以进出的是完整
 * Markdown 字符串，不解析、不结构化。
 */

// 记忆本体本来就在本机（`<data_dir>/memory`）→ 全部走 `requestLocal`。
import { requestLocal } from './client'
import type { components } from './schema'

type Schema = components['schemas']

export type MemoryFileDetail = Schema['MemoryFileDetailOut']
export type MemoryStatus = Schema['MemoryStatusOut']
export type MemoryOverview = Schema['MemoryOverviewOut']
export type MemoryHit = Schema['MemoryHitOut']
export type MemoryRecall = Schema['MemoryRecallOut']

/** 一次写入的结果与回执（`remember` / `forget` / `restore` / 组改名共用）。 */
export type MemoryWriteResult = Schema['MemoryRememberOut']

export type MemoryEntry = Schema['MemoryEntryOut']
export type MemoryGroup = Schema['MemoryGroupOut']
/**
 * 分区与档案顶层的数组字段在 OpenAPI 里是**可选的**（pydantic 的 `default_factory`），
 * 但后端每次都填它们。这里用 `Omit` 把那一层收成必填，字段本身的形状仍然来自生成物
 * （改名会在编译期报错），只是调用点不必到处 `?? []`。
 */
type RawSection = Schema['MemorySectionOut']
export type MemorySection = Omit<RawSection, 'groups' | 'items'> & {
  groups: NonNullable<RawSection['groups']>
  items: NonNullable<RawSection['items']>
}
export type MemoryArchive = Omit<Schema['MemoryArchiveOut'], 'sections'> & {
  sections: MemorySection[]
}
export type MemoryChange = Schema['MemoryChangeOut']
export type MemoryMigration = Schema['MemoryMigrationOut']
export type MemoryDraftOrganize = Schema['MemoryDraftOrganizeOut']
export type MemoryDraftSuggestion = Schema['MemoryDraftSuggestionOut']

/** 这一层的状态（开没开、工作区在哪、几份文件）。**只有状态**——原先那份文件列表
 * 随记忆页上只读的「旧记忆」一起下掉，这份响应里不再有 `files`。 */
export function getMemory(): Promise<MemoryOverview> {
  return requestLocal<MemoryOverview>('/memory')
}

/**
 * 读一个文件的原文（含 frontmatter）。**只读**——档案卡右下角那个「原文」用它，
 * 迁移草稿查看也用它。
 *
 * **路径按段编码**（每段单独 `encodeURIComponent`）：`digest/wiki/x.md` 里的
 * 斜杠是路径分隔符、必须原样留着，靠 `:path` 参数接住；而文件名里可能有
 * `#`、`?`、空格这类会截断 URL 的字符，那些要编码。
 */
export function getMemoryFile(path: string): Promise<MemoryFileDetail> {
  return requestLocal<MemoryFileDetail>(`/memory/files/${encodePath(path)}`)
}

/** 档案卡：分区、条目、读数，以及迁移入口要的草稿计数与显隐。 */
export function getMemoryArchive(): Promise<MemoryArchive> {
  return requestLocal<MemoryArchive>('/memory/archive')
}

/** 变更流时间线（后端已经倒序给）。 */
export function getMemoryChanges(): Promise<MemoryChange[]> {
  return requestLocal<Schema['MemoryChangesOut']>('/memory/changes').then(
    (body) => body.changes ?? [],
  )
}

/**
 * 记一条（新增或顶替）。
 *
 * `replaces` 是"更正一次完成"的入口（§4.3）：填要顶替的那条原文，一次调用完成。
 * 返回体带 `action`（`added` / `replaced` / `existing` / `rejected`）与 `receipt`
 * ——**回执就是给人看的那一句**，界面直接用，不另编。
 */
export function rememberMemory(
  content: string,
  options: { section?: string; replaces?: string } = {},
): Promise<MemoryWriteResult> {
  return requestLocal<MemoryWriteResult>('/memory/remember', {
    method: 'POST',
    body: JSON.stringify({
      content,
      section: options.section ?? '',
      replaces: options.replaces ?? '',
    }),
  })
}

/** 忘掉一条（界面上行尾的删除）。`topic` 是那一条的原文。 */
export function forgetMemory(topic: string): Promise<MemoryWriteResult> {
  return requestLocal<MemoryWriteResult>('/memory/forget', {
    method: 'POST',
    body: JSON.stringify({ topic }),
  })
}

/** 还原：把变更流里的一条旧值写回档案（§6.2）。 */
export function restoreMemory(text: string): Promise<MemoryWriteResult> {
  return requestLocal<MemoryWriteResult>('/memory/restore', {
    method: 'POST',
    body: JSON.stringify({ text }),
  })
}

/** 项目组改名（§3.1 第 2 条：改名 = 一次顶替）。 */
export function renameMemoryGroup(
  section: string,
  old: string,
  next: string,
): Promise<MemoryWriteResult> {
  return requestLocal<MemoryWriteResult>('/memory/group', {
    method: 'POST',
    body: JSON.stringify({ section, old, new: next }),
  })
}

/** 跑一遍机械折叠迁移（**零模型调用**，§8.3），返回迁移报告。 */
export function migrateMemory(): Promise<MemoryMigration> {
  return requestLocal<MemoryMigration>('/memory/migrate', { method: 'POST' })
}

/**
 * 跑一次模型整理迁移草稿（§8.3）：把旧条目改写成画像条目并给归区建议。
 *
 * **用户点一次才发生**（会花钱的默认关），而它**一个字都不写**：返回的是预览，
 * 确认之后前端逐条打 `rememberMemory`——于是这一次模型调用不可能绕过预算、
 * 顶替判据与变更流，每条的回执也仍然从那一处文案来。
 */
export function organizeMemoryDraft(): Promise<MemoryDraftOrganize> {
  return requestLocal<MemoryDraftOrganize>('/memory/draft/organize', { method: 'POST' })
}

/** 在档案的变更流里查证。**与知识库检索是两条路**，结果不合并。 */
export function recallMemory(query: string, limit?: number): Promise<MemoryRecall> {
  return requestLocal<MemoryRecall>('/memory/recall', {
    method: 'POST',
    body: JSON.stringify({ query, limit: limit ?? null }),
  })
}

function encodePath(path: string): string {
  return path
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}
