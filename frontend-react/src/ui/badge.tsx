// 来源：shadcn/ui（new-york）@98a1fe6 —— 类名已换成 src/styles/tokens.css 的令牌（映射表见 src/ui/README.md）
import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from '@radix-ui/react-slot'

import { cn } from '@/lib/utils'

/**
 * 小徽章。形状取 tokens.css 里的 `--radius-badge`（**4px 方角，不是胶囊**）：
 * Kimi 的 badge 一律 `4px + padding 1px 4px + 12px 字`，而"状态标签做成胶囊"正是
 * 规范里点名要改掉的那一件事。想回到胶囊形自己加 `rounded-pill` 即可。
 * 默认色是"蓝字 + 蓝的 10% 底"（`--badge-bg` / `--badge-text`）。
 */
const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-[var(--radius-badge)] border border-transparent px-1 py-0.5 text-[length:var(--text-micro-size)] font-medium whitespace-nowrap transition-[color,box-shadow] [&>svg]:pointer-events-none [&>svg]:size-3',
  {
    variants: {
      variant: {
        default: 'bg-[var(--badge-bg)] text-[var(--badge-text)]',
        secondary: 'bg-[var(--bg-subtle)] text-text-secondary',
        destructive: 'bg-[var(--status-danger-soft)] text-status-danger',
        success: 'bg-[var(--status-success-soft)] text-status-success',
        warning: 'bg-[var(--status-warning-soft)] text-status-warning',
        outline: 'border-border text-text-primary',
        ghost: 'text-text-secondary [a&]:hover:bg-[var(--bg-hover)]',
        link: 'text-accent-text underline-offset-4 [a&]:hover:underline',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

function Badge({
  className,
  variant = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'span'

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
