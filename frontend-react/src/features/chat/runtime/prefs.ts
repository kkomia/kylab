/**
 * 对话页存在本机的几条偏好（键名与旧前端逐字一致）。
 *
 * 为什么键名要一致：用户从旧前端切过来时，这些"平时怎么用"的选择不该丢
 * （上次用哪个模型、开不开知识库、钉了哪几个技能）。旧前端的键都在
 * `kylab-*` 这一族里，搬过来时**不改名**就是最好的向后兼容。
 */
import type { ThinkingEffort } from '@/api/chat'

/** 上次选过的对话模型（换会话/刷新之后仍然沿用）。 */
export const LAST_MODEL_KEY = 'kylab-last-chat-model'
export const LAST_THINKING_KEY = 'kylab-last-thinking'
export const LAST_EFFORT_KEY = 'kylab-last-thinking-effort'
/** 「使用知识库」开关：这是"我平时怎么用"，不是某一轮的一次性选择。 */
export const KB_SWITCH_KEY = 'kylab-chat-use-kb'
/** 本轮钉住的技能（勾了就每一轮都展开它的正文）。 */
export const PINNED_SKILLS_KEY = 'kylab-chat-pinned-skills'

/**
 * 工作区文件/目录拖拽时带的自定义类型（与旧前端同一个值）。
 *
 * **必须是一个自定义 MIME**：OS 拖进来的文件与工作区里的文件都是 `Files`，
 * 只有"谁写的这个 payload"能区分它们——而这两种拖拽要做的事完全不同
 * （上传 vs 插一条引用）。
 */
export const FILE_DRAG_TYPE = 'application/x-kylab-file'

/** 读一条本机偏好。隐私模式（localStorage 抛错）下当作没有。 */
export function readStored(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

export function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // 隐私模式：不记忆即可
  }
}

/** 三档思考强度只在契约里定过取值范围，非法值（改过 localStorage）退回默认。 */
export function readStoredEffort(): ThinkingEffort {
  const raw = readStored(LAST_EFFORT_KEY)
  return raw === 'low' || raw === 'high' ? raw : 'medium'
}

/** 钉住的技能名（逗号分隔，与旧前端同一种写法）。 */
export function readPinnedSkills(): string[] {
  return readStored(PINNED_SKILLS_KEY)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

export function writePinnedSkills(names: string[]): void {
  writeStored(PINNED_SKILLS_KEY, names.join(','))
}
