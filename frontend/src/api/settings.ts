/**
 * 运行期配置接口（对应 /api/v1/settings）。
 *
 * 读取只拿得到掩码（`sk-xu…ten`）与"是否已配置"，明文永不回前端；
 * 写入时留空表示"不改动这把密钥"。
 */

import { request } from './client'

export interface SettingField {
  key: string
  label: string
  type: 'text' | 'secret' | 'int' | string
  value: string
  configured: boolean
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
