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

/**
 * 「Agent 模式」这一项的键（后端 `chat.mode`）。
 *
 * 四档枚举（`plan / build / edit / yolo`）与每档的语义由后端定，
 * 见 `backend/app/services/modes.py`：**这里不另起名字、也不另定取值**。
 */
export const CHAT_MODE_KEY = 'chat.mode'

export interface ChatModeView {
  /** 当前档；空串 = 后端没给这一项（那种情况不显示控件，见 ModePicker）。 */
  mode: string
  /** 后端登记的四档（取值 + 展示名）。界面按它排列，不自己硬编码顺序。 */
  options: SettingFieldOption[]
}

/**
 * 读当前 Agent 模式与四档候选：**走的就是设置页那一个接口**。
 *
 * 为什么不另开一个 `GET /chat/mode`：模式是运行期配置里的一项，与
 * `sandbox.exec_policy` 完全同构（见 `ExecPolicyControl` 的说明——两处各存一份，
 * 显示的档与引擎用的档迟早会不一致）。
 */
export async function getChatMode(): Promise<ChatModeView> {
  const view = await getSettings()
  const field = view.groups
    .find((group) => group.key === 'chat')
    ?.fields.find((item) => item.key === CHAT_MODE_KEY)
  return { mode: field?.value ?? '', options: field?.options ?? [] }
}

/** 写当前 Agent 模式：改的就是设置页那一项（下一轮生效，不必重启）。 */
export function setChatMode(value: string): Promise<SettingsPatchResult> {
  return updateSettings([{ key: CHAT_MODE_KEY, value }])
}

/** 连通性测试：embedding / mineru / paddleocr。刻意做得很轻，不消耗解析额度。 */
export function testConnection(target: string): Promise<TestConnectionResult> {
  return request(`/settings/test/${target}`, { method: 'POST' })
}

/** `/auth/status` 的返回形状与登录引导状态同一个（定义在 `api/auth.ts`）。 */
export type AuthStatus = AuthBootstrapStatus

/**
 * 鉴权状态。**不需要凭据**：前端靠它判断该显示首次设置还是登录。
 */
export function getAuthStatus(): Promise<AuthStatus> {
  return request('/auth/status')
}
