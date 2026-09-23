// 来源：shadcn/ui（new-york）@98a1fe6 —— 类名已换成 src/styles/tokens.css 的令牌（映射表见 src/ui/README.md）
import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * 单行输入。高度就是 `--control-height`（32px），与按钮、下拉同一个口径；
 * 文字用 `text-[length:var(--text-body-size)]`（15px，与旧前端 `.field { font: inherit }` 一致，不是上游的 16px）。
 * 悬停/聚焦的描边转色沿用旧前端 `.field` 的两档：hover → `--text-quaternary`，
 * focus → `--text-primary`（墨色；键盘导航时再叠 tokens.css 里那条全局焦点环）。
 */
function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'h-8 w-full min-w-0 rounded-control border border-border bg-surface px-3 py-1 text-[length:var(--text-body-size)] text-text-primary transition-[color,box-shadow,border-color] selection:bg-[var(--accent-selected)] selection:text-text-primary placeholder:text-text-quaternary hover:border-[var(--text-quaternary)] focus:border-[var(--text-primary)] file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-meta file:font-medium file:text-text-primary disabled:cursor-not-allowed disabled:border-[var(--button-disabled-border)] disabled:bg-[var(--button-disabled-bg)] disabled:text-[var(--button-disabled-text)] aria-invalid:border-status-danger',
        className,
      )}
      {...props}
    />
  )
}

export { Input }
