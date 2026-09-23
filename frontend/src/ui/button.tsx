// 来源：shadcn/ui（new-york）@98a1fe6 —— 类名已换成 src/styles/tokens.css 的令牌（映射表见 src/ui/README.md）
import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from '@radix-ui/react-slot'

import { cn } from '@/lib/utils'

/**
 * 与上游的三处**有意**偏离（都写在 src/ui/README.md 里）：
 * 1. 高度降到 `h-8`（32px = `--control-height`）——本仓"输入框 / 下拉 / 按钮同一个高度口径"；
 * 2. 禁用态用实色令牌（`--button-disabled-*`）而不是 `opacity-50`：半透明会把文字与底色
 *    一起推向对方，"禁用态写着什么"恰恰最该读得清；
 * 3. `destructive` 是**红字 + 悬停浅红底**，不是红实心——沿用旧前端 `AppButton variant="danger"`
 *    的形态（Kimi 的纪律：动作靠墨色，红只做小面积）。
 */
const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 rounded-control text-[length:var(--text-meta-size)] font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow] disabled:pointer-events-none disabled:cursor-not-allowed disabled:border disabled:border-[var(--button-disabled-border)] disabled:bg-[var(--button-disabled-bg)] disabled:text-[var(--button-disabled-text)] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*="size-"])]:size-4',
  {
    variants: {
      variant: {
        default:
          'bg-[var(--button-primary-bg)] text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)]',
        destructive: 'border border-transparent text-status-danger hover:bg-[var(--danger-soft)]',
        outline: 'border border-border text-text-primary hover:bg-[var(--bg-hover)]',
        secondary: 'bg-[var(--bg-subtle)] text-text-primary hover:bg-[var(--bg-hover)]',
        ghost:
          'border border-transparent text-text-secondary hover:bg-[var(--bg-hover)] hover:text-text-primary',
        link: 'text-accent-text underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-8 px-3 py-1 has-[>svg]:px-2.5',
        xs: 'h-6 gap-1 px-2 text-[length:var(--text-micro-size)] has-[>svg]:px-1.5 [&_svg:not([class*="size-"])]:size-3',
        sm: 'h-7 gap-1.5 px-2.5',
        lg: 'h-9 px-4',
        icon: 'size-8',
        'icon-xs': 'size-6 [&_svg:not([class*="size-"])]:size-3',
        'icon-sm': 'size-7',
        'icon-lg': 'size-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : 'button'

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
}

export { Button, buttonVariants }
