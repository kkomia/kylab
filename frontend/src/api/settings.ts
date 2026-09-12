/**
 * 运行期配置接口（对应 /api/v1/settings）。
 *
 * 读取只拿得到掩码（`sk-xu…ten`）与"是否已配置"，明文永不回前端；
 * 写入时留空表示"不改动这把密钥"。
 */

import type { AuthBootstrapStatus } from './auth'
import { request } from './client'

export interface SettingFieldOption {
  value: string
  label: string
}

export interface SettingField {
  key: string
  label: string
  type: 'text' | 'secret' | 'int' | 'bool' | 'textarea' | 'select' | string
  value: string
  configured: boolean
  /** `type === 'select'` 时的候选值；由后端给出，前端不硬编码。 */
  options: SettingFieldOption[]
  /** `'range'` = 这一项用滑杆编辑；取值范围由后端给（范围是参数语义的一部分）。 */
  control?: 'range' | null
  min?: number | null
  max?: number | null
  step?: number | null
  /** 代码默认值；滑杆把它画成一个刻度点。 */
  default_value?: string | null
}

export interface SettingGroup {
  key: string
  label: string
  fields: SettingField[]
}

export interface SettingsView {
  groups: SettingGroup[]
  embedding_model_id: string
  embedding_dim: number
  /** 是否已选定嵌入模型。为假时不能建库，界面要给出去哪儿配的指引。 */
  embedding_configured: boolean
  /** 是否为开发用确定性嵌入（仅显式开着开发开关时）：界面提示"检索质量不代表真实效果"。 */
  embedding_is_development: boolean
  rerank_enabled: boolean
}

export interface SettingsPatchResult {
  updated: number
  rejected: string[]
}

export interface TestConnectionResult {
  ok: boolean
  detail: string
}

export function getSettings(): Promise<SettingsView> {
  return request('/settings')
}

export function updateSettings(
  values: { key: string; value: string }[],
): Promise<SettingsPatchResult> {
  return request('/settings', { method: 'PATCH', body: JSON.stringify({ values }) })
}

/** 连通性测试：embedding / mineru / paddleocr。刻意做得很轻，不消耗解析额度。 */
export function testConnection(target: string): Promise<TestConnectionResult> {
  return request(`/settings/test/${target}`, { method: 'POST' })
}

export interface MaxTokensProbeResult {
  /** 模型能接受的最大回复长度；**`null` = 没探到**（不要显示成某个具体数字）。 */
  ceiling: number | null
  detail: string
}

/**
 * 探测对话模型的回复长度上限。
 *
 * 后端用"故意发一个荒谬的 max_tokens、读 400 里的合法区间"实现，**不消耗额度**。
 * 设置页拿它给滑杆定上界：上限是模型自己的属性，各家差别很大。
 */
export function probeMaxTokens(): Promise<MaxTokensProbeResult> {
  return request('/settings/llm/max-tokens-probe', { method: 'POST' })
}

/** `/auth/status` 的返回形状与登录引导状态同一个（定义在 `api/auth.ts`）。 */
export type AuthStatus = AuthBootstrapStatus

/**
 * 鉴权状态。**不需要凭据**：前端靠它判断该显示首次设置还是登录。
 */
export function getAuthStatus(): Promise<AuthStatus> {
  return request('/auth/status')
}
