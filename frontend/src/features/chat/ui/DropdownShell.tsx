/**
 * 那一排触发器的**薄壳**（Radix 的菜单在好几个控件里长得一样）。
 *
 * 抽出来只有一条理由，而且是用户明确报过的毛病：**同一行里两个高度**。
 * 取值只有一处（`--control-height` + `--radius-row`），谁加进来的控件都跟它对齐。
 * 「菜单由 Radix 提供（浮层定位、键盘、Esc、点击外部关闭）」这件事也就只有一处需要维护。
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ChevronDown } from 'lucide-react'
import type { ReactNode } from 'react'

export function Dropdown({
  label,
  ariaLabel,
  icon,
  align = 'start',
  children,
}: {
  label: string
  ariaLabel: string
  icon: ReactNode
  align?: 'start' | 'end'
  children: ReactNode
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          className="inline-flex h-[var(--control-height)] cursor-pointer items-center gap-[var(--space-1-5)] rounded-[var(--radius-row)] border border-transparent bg-[var(--bg-subtle)] px-[var(--space-2)] text-[length:var(--text-meta-size)] font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] data-[state=open]:bg-[var(--bg-hover)] data-[state=open]:text-[var(--text-primary)]"
        >
          {icon}
          <span className="max-w-[140px] truncate">{label}</span>
          <ChevronDown size={13} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align={align}
          sideOffset={6}
          className="z-50 min-w-[200px] max-h-[420px] overflow-y-auto rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--bg-menu)] p-[var(--space-2)] shadow-[var(--shadow-popover)]"
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
