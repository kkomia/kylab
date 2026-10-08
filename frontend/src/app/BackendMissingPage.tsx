/**
 * 「本机后端未启动」那一页（2026-10-08）。
 *
 * 这是**本机后端门禁**（`App.tsx` 的 `LocalBackendGate`）不放行时唯一的形态：
 * 这份界面背后没有本机后端（在浏览器里打开、边车没起来），会话 / 笔记 / 记忆 / 能力
 * 一件都读不到——如实说这一句，并把「重试」摆在手边（先起边车、再点一下，
 * 比让人刷新一次便宜）。
 *
 * 它顶掉的是两页旧形态：**登录页**（本机档免登录，见 `App.tsx` 文件头）与
 * **"只剩知识库管理台"**那一份（知识库管理台已随剥离搬去 kybase，本界面不再有它）。
 *
 * 形状照 `NotFoundPage` 摆：两页都是"路走到这里就没有下一句"的形态，长得一样，
 * 用户不必重新认。**自带整屏背景**（它不在壳里渲染，没有侧栏与内容卡片那一层）。
 */
import { useState } from 'react'

import { reprobeLocalBackend } from '@/api/local'
import { Button } from '@/ui/button'

export function BackendMissingPage() {
  const [probing, setProbing] = useState(false)

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-[var(--bg-canvas)] px-[var(--page-gutter)] py-[var(--space-12)] text-center">
      <div className="flex flex-col items-center gap-3">
        <h1 className="m-0 text-[length:var(--text-page-title-size)] font-semibold text-text-primary">
          本机后端未启动
        </h1>
        <p className="m-0 max-w-[var(--measure)] text-[length:var(--text-meta-size)] leading-[var(--line-prose)] text-text-secondary">
          界面连不上本机后端。把它启动起来，再点重试。
        </p>
      </div>
      <Button
        type="button"
        disabled={probing}
        onClick={() => {
          setProbing(true)
          void reprobeLocalBackend().finally(() => setProbing(false))
        }}
      >
        {probing ? '正在重试…' : '重试'}
      </Button>
    </div>
  )
}
