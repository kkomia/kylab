/**
 * 预览的两种"说不出口"：还在取、以及取不到 / 画不出来。
 *
 * 三件小事刻意放在一个文件里，因为它们总是一起出现，而且**文案必须一致**：
 * 同一份文件从对话页打开和从知识库打开，看到的失败说明应当一字不差。
 *
 * 两条口径：
 *
 * 1. **失败要说原因，不吞异常**。能拿到后端给的原因（签名链接 403 / 404、
 *    服务端返回的说明）就显示它；只有"确实没有原因"时才退到
 *    `CANNOT_PREVIEW`（"这类文件无法预览"）——一句"加载失败"会把
 *    "网络断了"和"这个格式本来就不支持"混成同一件事。
 * 2. **失败不是白屏**：说清"为什么不能"与"该怎么办"（用下载按钮拿本机程序开），
 *    比给一个空框诚实（旧 `FilePreview.vue` 同一条）。
 */
import { FileText } from 'lucide-react'
import type { ReactNode } from 'react'

/** 没有更具体的原因时用的那句话。 */
export const CANNOT_PREVIEW = '这类文件无法预览'

/** 拿不到内容（链接没给 / fetch 失败 / 解析抛错）时的统一开头。 */
export function loadFailure(reason: string): string {
  return `预览失败（${reason}）`
}

/** 把任意抛出物变成一句能显示的话。 */
export function reasonOf(cause: unknown, fallback = CANNOT_PREVIEW): string {
  if (cause instanceof Error && cause.message) return cause.message
  if (typeof cause === 'string' && cause.trim()) return cause
  return fallback
}

/** 一行说明（加载中 / 失败）。 */
export function PreviewNote({
  children,
  tone = 'muted',
}: {
  children: ReactNode
  tone?: 'muted' | 'bad'
}) {
  return (
    <p className="kylab-note" data-tone={tone}>
      {children}
    </p>
  )
}

/** 「正在取原文」——三个 Office 预览与文本分支共用同一句话。 */
export function PreviewLoading({ label = '正在加载原文' }: { label?: string }) {
  return <PreviewNote>{label}…</PreviewNote>
}

/**
 * 「这份看不了」。`reason` 是**完整的一句话**（`loadFailure(...)` 或 `CANNOT_PREVIEW`），
 * 文件名与"该怎么办"在这里补上，调用方不必各写一遍。
 */
export function PreviewUnavailable({ name, reason }: { name?: string; reason: string }) {
  const prefix = name ? `「${name}」` : ''
  const advice =
    reason === CANNOT_PREVIEW ? '下载它，用本机的程序打开。' : '可以用下载按钮，用本机程序打开它。'
  return (
    <PreviewNote tone="bad">
      {prefix}
      {reason}。{advice}
    </PreviewNote>
  )
}

/**
 * 「这个格式不能在这里预览」（不是失败，是**本来就不打算渲染**）。
 *
 * 与 `PreviewUnavailable` 分开：那个说的是"试过但没成"，这个说的是"没打算试"。
 * 用户看到的东西一样（一句说明 + 下载建议），但代码上分得清，
 * 将来加"为什么不能"的解释时不用去猜是哪一种。
 */
export function PreviewNotSupported({ name }: { name?: string }) {
  return (
    <div className="kylab-none">
      <FileText aria-hidden className="kylab-none-icon" size={28} />
      <p className="kylab-none-title">
        {name ? `「${name}」这个格式不能在这里预览` : CANNOT_PREVIEW}
      </p>
      <p className="kylab-none-note">下载它，用本机的程序打开。</p>
    </div>
  )
}
