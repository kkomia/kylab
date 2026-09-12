/**
 * 切分参数的表单校验（知识库设置与新建弹窗共用）。
 *
 * 为什么单独一个函数：同一个校验要在两处出现（改配置、建库），而它给出的文案是
 * **要展示给用户看的**——两处各写一份，迟早出现"这边说 128–2048、那边说 1–8000"。
 *
 * 草稿是**字符串**：输入框被清空（`''`）与填了 `0` 必须分得开，
 * 所以校验在字符串上做，不先 `Number('')` 变成 0 再判断。
 */

import { CHUNK_SIZE_MAX, CHUNK_SIZE_MIN, chunkOverlapMax } from '@/api/knowledgeBases'

/** 解析成整数；空串或非数字给 `null`（与 0 区分）。 */
export function parseIntOrNull(text: string): number | null {
  const trimmed = text.trim()
  if (trimmed === '') return null
  const value = Number(trimmed)
  return Number.isInteger(value) ? value : null
}

/**
 * 返回中文错误文案；空串 = 通过。
 *
 * 文案只说"这一栏该填什么"：用户要的是下一步动作，不是"参数非法"。
 */
export function chunkingErrorOf(sizeText: string, overlapText: string): string {
  const size = parseIntOrNull(sizeText)
  if (size === null || size < CHUNK_SIZE_MIN || size > CHUNK_SIZE_MAX) {
    return `块长需要在 ${CHUNK_SIZE_MIN}–${CHUNK_SIZE_MAX} 之间`
  }
  const max = chunkOverlapMax(size)
  const overlap = parseIntOrNull(overlapText)
  if (overlap === null || overlap < 0 || overlap > max) {
    return `块重叠需要在 0–${max} 之间（不超过块长的一半）`
  }
  return ''
}
