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
