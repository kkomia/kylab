/**
 * 能力层接口：技能（`/api/v1/skills`）与 MCP 服务（`/api/v1/mcp-servers`），v0.15。
 *
 * 两者一起放这里是因为它们在界面上是同一件事的两半——**这个 Agent 会什么**：
 * 技能是"流程"（写在磁盘上的 SKILL.md），MCP 是"工具"（外部的服务）。
 *
 * 两个约定值得在类型上写清楚：
 *
 * 1. 技能被安全扫描拦下时 `used_by_prompt` 为 false，`flagged` 给出理由。
 *    **界面要显示它**（连着原因），否则用户会以为技能没装上。
 * 2. MCP 的凭据**只在写入时上行**，读出来只有 `secret_keys`（键名）。
 *    所以"改配置"时不要把读到的值回填进表单——那会把 key 写成一个掩码串。
 */

import { request } from './client'

// ------------------------------------------------------------------ 技能

export interface Skill {
  name: string
  description: string
  /**
   * **中文简介**（v0.28）。空 = 没有（随代码发布的、手放的技能都没有）。
   *
   * 它只是界面上那一行说明：技能的 `SKILL.md` 一个字都没改——`description`
   * 是模型判断"何时该用"的触发文本，翻译它会影响功能。
   */
  summary: string
  source: 'builtin' | 'user'
  path: string
  directory: string
  /** 会不会进 system prompt 的技能目录。被安全扫描拦下的为 false。 */
  used_by_prompt: boolean
  /** 没进目录的原因（人话）。空 = 没问题。 */
  flagged: string[]
}

export interface SkillDetail extends Skill {
  /** 正文（frontmatter 之后的部分）——**按需展开的那一段**。 */
  body: string
}

export function listSkills(): Promise<{ items: Skill[]; usable: number }> {
  return request<{ items: Skill[]; usable: number }>('/skills')
}

export function getSkill(name: string): Promise<SkillDetail> {
  return request<SkillDetail>(`/skills/${encodeURIComponent(name)}`)
}

// ------------------------------------------------------------------ MCP

export type MCPPolicy = 'allow' | 'ask' | 'deny'

export interface MCPTool {
  name: string
  /** 限定名 `mcp__<服务>__<工具>`：外部工具名我们无法约束，必须加前缀。 */
  qualified: string
  description: string
  server_id: string
  server_name: string
}

export interface MCPServer {
  id: string
  name: string
  transport: 'stdio' | 'http'
  target: string
  args: string[]
  policy: MCPPolicy
  enabled: boolean
  /** 配过凭据的**键名**（不含值）。界面据此显示"已配置"。 */
  secret_keys: string[]
  has_secrets: boolean
  tool_prefix: string
  /** 只有探活（probe）会给：`null` = 没探过。 */
  reachable: boolean | null
  detail: string
  tools: MCPTool[]
  created_at: string | null
  updated_at: string | null
}

export interface MCPServerPayload {
  name: string
  transport: 'stdio' | 'http'
  target: string
  args?: string[]
  env?: Record<string, string>
  headers?: Record<string, string>
  policy?: MCPPolicy
}

export function listMCPServers(): Promise<{ items: MCPServer[] }> {
  return request<{ items: MCPServer[] }>('/mcp-servers')
}

export function createMCPServer(payload: MCPServerPayload): Promise<MCPServer> {
  return request<MCPServer>('/mcp-servers', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function updateMCPServer(
  serverId: string,
  payload: Partial<MCPServerPayload> & { enabled?: boolean },
): Promise<MCPServer> {
  return request<MCPServer>(`/mcp-servers/${serverId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
}

export function deleteMCPServer(serverId: string): Promise<void> {
  return request<void>(`/mcp-servers/${serverId}`, { method: 'DELETE' })
}

/**
 * 探活 + 发现工具。
 *
 * **连不上也是 200**：它是「测试连接」，失败会体现在 `reachable: false`
 * 与 `detail` 里——这样界面能分清"连不上"与"没工具"，而不是只有一句"请求失败"。
 */
export function probeMCPServer(serverId: string): Promise<MCPServer> {
  return request<MCPServer>(`/mcp-servers/${serverId}/probe`, { method: 'POST' })
}

/**
 * 调一个外部工具。
 *
 * `ask` 策略下第一次会拿到 **409**（"要先确认"）：界面据此弹确认框，
 * 确认后带 `approved: true` 再调一次。409 不是错误，是流程的一步。
 */
export function callMCPTool(
  serverId: string,
  tool: string,
  args: Record<string, unknown>,
  approved = false,
): Promise<{ server_id: string; tool: string; text: string }> {
  return request<{ server_id: string; tool: string; text: string }>(
    `/mcp-servers/${serverId}/call`,
    { method: 'POST', body: JSON.stringify({ tool, arguments: args, approved }) },
  )
}

/** 所有启用中服务的工具汇总（带限定名）。某个服务连不上会被后端口跳过。 */
export function listAllMCPTools(): Promise<MCPTool[]> {
  return request<MCPTool[]>('/mcp-servers/tools')
}

// ------------------------------------------------------------------ 技能源（v0.27）
//
// 与上面那组"从地址装"的区别：这里的源是**一个线上仓库**（GitHub），
// 流程是"浏览 → 看文件清单 → 按 commit SHA 装"。三条与界面直接相关的约定：
//
// 1. **出站全在后端**：GitHub 匿名配额 60 次/小时，前端直连一分钟就打爆；
// 2. **装之前一定先 `inspect`**：那份文件清单是用户判断"我在装什么"的唯一依据
//    （技能目录里的 `scripts/` 是会被执行的代码）；
// 3. `sha` 是**安装时用的那个版本**：界面上要显示出来，用户才知道自己装的是哪一版。

/** 一个可浏览的技能源（就是"一个 GitHub 仓库"）。 */
export interface SkillSource {
  id: string
  name: string
  /** `owner/repo`。与显示名分开：名字会改，仓库地址不会。 */
  repo: string
  /** 分支 / 标签。空 = 用仓库的默认分支。 */
  ref: string
  /** 只在仓库的这个子目录里找技能（空 = 全仓递归扫）。 */
  subpath: string
  /** 内置源（我们审过的清单）不能删，只能停用。 */
  builtin: boolean
  enabled: boolean
  /** 为什么内置它（一句话）。用户自己加的源为空。 */
  why: string
}

/** 浏览结果里的一条（还没装）。 */
export interface MarketSkill {
  name: string
  description: string
  /** 中文简介（v0.28）。空 = 没翻成，界面退回 `description`。 */
  summary: string
  /** 技能目录在仓库里的相对路径。安装时按它取文件。 */
  path: string
  source_id: string
  repo: string
  installed: boolean
}

export interface SkillFile {
  path: string
  size: number
  /** `doc` / `code` / `asset`。**code 要在界面上显眼地标出来**。 */
  kind: 'doc' | 'code' | 'asset'
}

/** 装之前摊开的那一屏：文件清单 + 版本 + 体积。 */
export interface SkillBundle {
  source_id: string
  repo: string
  /** 40 位 commit SHA。安装按它取——分支会在两步之间变。 */
  sha: string
  path: string
  name: string
  description: string
  ref: string
  license: string
  files: SkillFile[]
  total_bytes: number
  /** 中文简介（v0.28）：装完会跟着记进清单，能力页上还能看到。 */
  summary: string
  /** 其中会被当作代码执行的文件数。 */
  code_count: number
  /** 仓库太大、GitHub 的文件树被截断：清单可能不全。 */
  truncated: boolean
}

export function listSkillSources(): Promise<{ items: SkillSource[] }> {
  return request<{ items: SkillSource[] }>('/skills/market/sources')
}

/** 加一个自定义源：`owner/repo`，或 GitHub 上那个仓库（含子目录）的 URL。 */
export function addSkillSource(repo: string): Promise<SkillSource> {
  return request<SkillSource>('/skills/market/sources', {
    method: 'POST',
    body: JSON.stringify({ repo }),
  })
}

export function setSkillSourceEnabled(sourceId: string, enabled: boolean): Promise<SkillSource> {
  return request<SkillSource>(`/skills/market/sources/${encodeURIComponent(sourceId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
  })
}

export function deleteSkillSource(sourceId: string): Promise<void> {
  return request<void>(`/skills/market/sources/${encodeURIComponent(sourceId)}`, {
    method: 'DELETE',
  })
}

/**
 * 浏览一个源里的技能。
 *
 * `refresh` 会忽略服务端缓存（GitHub 匿名配额 60 次/小时，默认那条路是走缓存的）。
 */
export function browseSkillSource(
  sourceId: string,
  refresh = false,
): Promise<{ source: SkillSource; items: MarketSkill[]; cached: boolean }> {
  return request<{ source: SkillSource; items: MarketSkill[]; cached: boolean }>(
    '/skills/market/browse',
    { method: 'POST', body: JSON.stringify({ source_id: sourceId, refresh }) },
  )
}

/** 看某个技能的文件清单（安装前的那一步，会打网络取文件树）。 */
export function inspectMarketSkill(sourceId: string, path: string): Promise<SkillBundle> {
  return request<SkillBundle>('/skills/market/inspect', {
    method: 'POST',
    body: JSON.stringify({ source_id: sourceId, path }),
  })
}

/** 安装：后端按同一个 SHA 取文件、扫描、落盘、记版本锁。 */
export function installMarketSkill(sourceId: string, path: string): Promise<Skill> {
  return request<Skill>('/skills/market/install-source', {
    method: 'POST',
    body: JSON.stringify({ source_id: sourceId, path }),
  })
}

/**
 * 上传一个技能：**选文件夹**（多个文件 + 相对路径）或**选压缩包**（一个 .zip）。
 *
 * 走同一套后端检查（白名单、扫描、拒绝覆盖）——本地上传不是"信得过的后门"，
 * 它是别人给的包最常见的一种到达方式（见 skill_market 的模块头）。
 */
export function uploadSkill(files: File[], paths: string[]): Promise<Skill> {
  const body = new FormData()
  for (const file of files) body.append('files', file)
  body.append('paths', JSON.stringify(paths))
  return request<Skill>('/skills/market/upload', { method: 'POST', body })
}

/** 已从市场装的技能：`技能名 → 来源`。用来显示来源与"能不能卸"。 */
export function listInstalledSkills(): Promise<{ items: Record<string, string>; total: number }> {
  return request<{ items: Record<string, string>; total: number }>('/skills/market/installed')
}

/** 卸载一个从市场装的技能（仓库自带的删不掉，后端会 404 说明）。 */
export function uninstallSkill(name: string): Promise<void> {
  return request<void>(`/skills/market/installed/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  })
}

/** 把安装记录里的来源整理成人话：`github:owner/repo@sha#path` → `owner/repo`。 */
export function sourceLabel(origin: string): string {
  if (!origin) return ''
  const match = /^github:([^@]+)@/.exec(origin)
  if (match) return match[1]
  if (origin.startsWith('http')) return origin.replace(/^https?:\/\//, '').split('/')[0]
  return origin.split('#')[0]
}
