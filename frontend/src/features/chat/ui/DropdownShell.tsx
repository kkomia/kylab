/**
 * 那一排触发器的**薄壳**（Radix 的菜单在好几个控件里长得一样）。
 *
 * 抽出来只有一条理由，而且是用户明确报过的毛病：**同一行里两个高度**。
 * 取值只有一处（`--control-height` + `--radius-pill`），谁加进来的控件都跟它对齐。
 * 「菜单由 Radix 提供（浮层定位、键盘、Esc、点击外部关闭）」这件事也就只有一处需要维护。
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ChevronDown } from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * 输入框那一排控件的**统一外形**（高度、形状、底色、悬停）。
 *
 * 高度与形状都收在这里一处：v0.28 的第二批评审（A4）量出来那一行里有四种形状——
 * 12px 圆角的浅底块、没有容器的裸开关、方形图标按钮、实心圆发送键。
 * 现在这一排的**菜单类控件**（加号 / 执行策略 / 模式 / 选库 / 模型 / 上下文仪表）
 * 全部走这一份取值：胶囊 + `--bg-subtle` + 同一种悬停。
 * （发送键与知识库开关也在这条线上，只是各自还有"开关/实心"要表达。）
 *
 * 横内边距 `space-2`（8px，第三批评审 A②）而不是 `space-3`：那一行六个胶囊要在一张
 * 768 的卡片里排成一行，12px 时整行要 751px、卡片只有 742px——多出来的十几像素正是
 * "整格折到第二行"的来源。收窄这一处（六个胶囊同时跟上，仍是一种形状），整行才有
 * 余量：默认字号下，读数那格写比率时留 ~34px，写「上下文读数不可用」时留 ~13px
 * （最长的就是这句）——都够；再往后（更大字号、更窄的窗口）由左组折行接住。
 */
export const CONTROL_TRIGGER =
  'inline-flex h-[var(--control-height)] cursor-pointer items-center gap-[var(--space-1-5)] ' +
  'rounded-[var(--radius-pill)] border border-transparent bg-[var(--bg-subtle)] px-[var(--space-2)] ' +
  'text-[length:var(--text-meta-size)] font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] data-[state=open]:bg-[var(--bg-hover)] data-[state=open]:text-[var(--text-primary)]'

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
        <button type="button" aria-label={ariaLabel} className={CONTROL_TRIGGER}>
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
