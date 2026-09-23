// 来源：shadcn/ui（new-york）@98a1fe6 —— 类名已换成 src/styles/tokens.css 的令牌（映射表见 src/ui/README.md）
import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * 多行输入。多行天然高于控件口径，所以这里只给下限（`min-h-16` = 64px，与旧前端
 * `rows=3` 的实际高度一致）；`field-sizing-content` 让它跟着内容长。
 */
function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'flex field-sizing-content min-h-16 w-full resize-y rounded-control border border-border bg-surface px-3 py-2 text-[length:var(--text-body-size)] text-text-primary transition-[color,box-shadow,border-color] placeholder:text-text-quaternary hover:border-[var(--text-quaternary)] focus:border-[var(--text-primary)] disabled:cursor-not-allowed disabled:border-[var(--button-disabled-border)] disabled:bg-[var(--button-disabled-bg)] disabled:text-[var(--button-disabled-text)] aria-invalid:border-status-danger',
        className,
      )}
      {...props}
    />
  )
}

export { Textarea }
