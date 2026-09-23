/**
 * misc 域的原语层（按钮/输入/弹窗/标签/骨架/空态/仪表…）。
 *
 * **为什么自己写一层而不是等 `src/ui/**`**：那一层由别的域并行在做，而这一域的
 * 页面今天就要能跑、要能测。这些原语的取值全部来自 `tokens.css` / 主题变量
 * （见 `misc.css`），与那边最终产出的是同一套观感；将来合并只需把实现换成
 * `src/ui/**` 的组件，调用点不用动。
 *
 * 三条与旧前端逐条对齐的口径：
 * 1. **状态必须"图标 + 文字"双编码**（规范 §8）：`StatusTag` 一律带文字，
 *    颜色只是加速识别的辅助——黑白截图与色弱用户那里不能只剩一个色块；
 * 2. **禁用态要看得出来是禁用**：只降透明度在浅色背景下几乎分辨不出（规范 §7）；
 * 3. **弹窗自己管 Esc 与遮罩关闭**，且关闭时把焦点还给打开它的那个元素。
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { X } from 'lucide-react'
import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react'

import './misc.css'

// ------------------------------------------------------------------ 按钮

export type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost' | 'subtle'

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: ButtonVariant
  size?: 'sm' | 'md'
  block?: boolean
  icon?: ReactNode
  children?: ReactNode
}

export function Button({
  variant = 'default',
  size = 'md',
  block,
  icon,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  const classes = ['m-btn']
  if (variant === 'primary') classes.push('m-btn-primary')
  if (variant === 'danger') classes.push('m-btn-danger')
  if (variant === 'ghost' || variant === 'subtle') classes.push('m-btn-ghost')
  if (size === 'sm') classes.push('m-btn-sm')
  if (block) classes.push('m-btn-block')
  return (
    <button type={type} className={classes.join(' ')} {...rest}>
      {icon}
      {children}
    </button>
  )
}

/** 纯图标按钮：`aria-label` 必填（否则屏幕阅读器只念出"按钮"）。 */
export function IconButton({
  label,
  icon,
  ...rest
}: { label: string; icon: ReactNode } & Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'className' | 'children' | 'aria-label'
>) {
  return (
    <button type="button" className="m-icon-btn" aria-label={label} title={label} {...rest}>
      {icon}
    </button>
  )
}

// ------------------------------------------------------------------ 页面外壳

export function PageShell({
  title,
  actions,
  children,
}: {
  /** 空串 = 不画页标题（能力页刻意不要它，左侧菜单已经写着「能力」）。 */
  title: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="page-shell">
      {(title || actions) && (
        <header className="m-page-head">
          {title ? <h1 className="m-page-title">{title}</h1> : <span />}
          {actions && <div className="m-page-actions">{actions}</div>}
        </header>
      )}
      <div className="page-shell-body">{children}</div>
    </div>
  )
}

// ------------------------------------------------------------------ 表单

export function Field({
  label,
  hint,
  optional,
  tip,
  htmlFor,
  children,
}: {
  label: string
  hint?: ReactNode
  optional?: boolean
  tip?: ReactNode
  htmlFor?: string
  children: ReactNode
}) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={htmlFor}>
        {label}
        {optional && <span className="field-optional">（可选）</span>}
        {tip}
      </label>
      {children}
      {hint && <span className="text-hint">{hint}</span>}
    </div>
  )
}

export function TextInput({
  value,
  onValueChange,
  ...rest
}: { value: string; onValueChange: (next: string) => void } & Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'className'
>) {
  return (
    <input
      className="m-input"
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
      {...rest}
    />
  )
}

export function TextArea({
  value,
  onValueChange,
  rows = 3,
  ...rest
}: { value: string; onValueChange: (next: string) => void; rows?: number } & Omit<
  InputHTMLAttributes<HTMLTextAreaElement>,
  'value' | 'onChange' | 'className' | 'rows'
>) {
  return (
    <textarea
      className="m-textarea"
      rows={rows}
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
      {...rest}
    />
  )
}

export interface SelectOption {
  value: string
  label: string
}

/**
 * 原生 `<select>`。
 *
 * **刻意不引弹层选择器**：这一域里的下拉全是"从几个固定值里挑一个"，
 * 原生控件自带键盘可达、移动端原生滚轮与 `aria`，写一个浮层反而要自己补这三样。
 */
export function Select({
  value,
  onValueChange,
  options,
  label,
  disabled,
  id,
}: {
  value: string
  onValueChange: (next: string) => void
  options: readonly SelectOption[]
  label?: string
  disabled?: boolean
  id?: string
}) {
  return (
    <select
      id={id}
      className="m-select"
      value={value}
      aria-label={label}
      disabled={disabled}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

export function Checkbox({
  checked,
  onCheckedChange,
  children,
}: {
  checked: boolean
  onCheckedChange: (next: boolean) => void
  children: ReactNode
}) {
  return (
    <label className="m-check">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onCheckedChange(event.target.checked)}
      />
      <span>{children}</span>
    </label>
  )
}

// ------------------------------------------------------------------ 分段 / 筛选

export function SegmentedControl<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
}: {
  items: readonly { value: T; label: string; count?: number }[]
  value: T
  onChange: (next: T) => void
  ariaLabel: string
}) {
  return (
    <div className="m-tabs" role="tablist" aria-label={ariaLabel}>
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          role="tab"
          aria-selected={value === item.value}
          className={value === item.value ? 'm-tab m-tab-on' : 'm-tab'}
          onClick={() => onChange(item.value)}
        >
          {item.label}
          {item.count !== undefined && <span className="m-tab-count tabular">{item.count}</span>}
        </button>
      ))}
    </div>
  )
}

export function FilterChips<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
}: {
  items: readonly { key: T; label: string; count: number }[]
  value: T
  onChange: (next: T) => void
  ariaLabel: string
}) {
  return (
    <div className="m-filters" role="tablist" aria-label={ariaLabel}>
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="tab"
          aria-selected={value === item.key}
          className={value === item.key ? 'm-filter m-filter-on' : 'm-filter'}
          onClick={() => onChange(item.key)}
        >
          {item.label}
          <span className="tabular">{item.count}</span>
        </button>
      ))}
    </div>
  )
}

// ------------------------------------------------------------------ 标签

export type TagTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

export function StatusTag({
  label,
  tone = 'neutral',
  live,
  title,
}: {
  label: string
  tone?: TagTone
  /** 在跑的状态：加一个脉动圆点（文字仍在，见文件头第 1 条）。 */
  live?: boolean
  title?: string
}) {
  const classes = ['m-tag']
  if (tone !== 'neutral') classes.push(`m-tag-${tone}`)
  return (
    <span className={classes.join(' ')} title={title}>
      {live && <span className="m-dot m-dot-live" aria-hidden="true" />}
      {label}
    </span>
  )
}

export function Chip({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span className="m-chip" title={title}>
      {children}
    </span>
  )
}

export function ChipButton({
  children,
  onClick,
  title,
}: {
  children: ReactNode
  onClick: () => void
  title?: string
}) {
  return (
    <button type="button" className="m-chip m-chip-btn" onClick={onClick} title={title}>
      {children}
    </button>
  )
}

// ------------------------------------------------------------------ 骨架 / 空态

export function SkeletonBlock({
  rows = 3,
  variant = 'list',
}: {
  rows?: number
  variant?: 'list' | 'text' | 'card'
}) {
  if (variant === 'card') {
    return <div className="m-skeleton m-skeleton-card" aria-hidden="true" />
  }
  return (
    <div className="m-skeleton" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="m-skeleton-row"
          style={{ width: variant === 'text' ? `${92 - index * 6}%` : '100%' }}
        />
      ))}
    </div>
  )
}

export function EmptyState({
  title,
  hint,
  center,
  children,
}: {
  title: string
  hint?: string
  center?: boolean
  children?: ReactNode
}) {
  return (
    <div className={center ? 'm-empty m-empty-center' : 'm-empty'}>
      <p className="m-empty-title">{title}</p>
      {hint && <p className="m-empty-hint">{hint}</p>}
      {children}
    </div>
  )
}

export function ErrorLine({ children }: { children: ReactNode }) {
  return <p className="m-error-line">{children}</p>
}

export function Notice({
  tone = 'neutral',
  icon,
  children,
}: {
  tone?: 'neutral' | 'error' | 'warn' | 'ok'
  icon?: ReactNode
  children: ReactNode
}) {
  const classes = ['m-notice']
  if (tone === 'error') classes.push('m-notice-error')
  if (tone === 'warn') classes.push('m-notice-warn')
  if (tone === 'ok') classes.push('m-notice-ok')
  return (
    <div className={classes.join(' ')}>
      {icon}
      <span>{children}</span>
    </div>
  )
}

// ------------------------------------------------------------------ 提示（InfoTip）

/**
 * 行内的一个问号提示。
 *
 * 用 `title` 而不是浮层：里面的文字全是"读一次就够"的说明，浮层要引入定位、
 * 关闭、焦点管理三件事，而收益只有排版好看一点。整句仍可被屏幕阅读器读到
 * （`aria-label`）。
 */
export function InfoTip({ text }: { text: string }) {
  return (
    <span className="m-infotip" role="img" aria-label={text} title={text}>
      <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
        <path d="M8 4.6v.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M8 7v4.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    </span>
  )
}

// ------------------------------------------------------------------ 弹窗

export interface ModalProps {
  open: boolean
  title: string
  onClose: () => void
  size?: 'sm' | 'md' | 'wide'
  height?: 'auto' | 'tall' | 'full'
  footer?: ReactNode
  children: ReactNode
}

export function Modal({ open, title, onClose, size = 'sm', height, footer, children }: ModalProps) {
  const titleId = useId()
  const previousFocus = useRef<Element | null>(null)

  useEffect(() => {
    if (!open) return
    previousFocus.current = document.activeElement
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKeydown)
    return () => {
      document.removeEventListener('keydown', onKeydown)
      // 关闭后把焦点还回去：否则键盘用户的下一步从页面开头重新开始
      const target = previousFocus.current
      if (target instanceof HTMLElement && document.contains(target)) target.focus()
    }
  }, [open, onClose])

  if (!open) return null

  const classes = ['m-modal']
  if (size === 'md') classes.push('m-modal-md')
  if (size === 'wide') classes.push('m-modal-wide')
  if (height === 'tall') classes.push('m-modal-full')
  if (height === 'full') classes.push('m-modal-full')

  return (
    <div
      className="m-modal-backdrop"
      // 点遮罩关闭：命中区是遮罩本身，点在弹窗内部不该关（`currentTarget` 判定）
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className={classes.join(' ')} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="m-modal-head">
          <h2 className="m-modal-title" id={titleId}>
            {title}
          </h2>
          <IconButton label="关闭" icon={<X size={16} />} onClick={onClose} />
        </header>
        <div className="m-modal-body">{children}</div>
        {footer && <footer className="m-modal-foot">{footer}</footer>}
      </div>
    </div>
  )
}

export function ConfirmDialog({
  open,
  title,
  lead,
  note,
  confirmLabel = '确认',
  busyLabel = '处理中…',
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  lead: string
  note?: string
  confirmLabel?: string
  busyLabel?: string
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>取消</Button>
          <Button variant="danger" disabled={busy} onClick={onConfirm}>
            {busy ? busyLabel : confirmLabel}
          </Button>
        </>
      }
    >
      <p className="m-empty-hint">{lead}</p>
      {note && <p className="text-hint">{note}</p>}
    </Modal>
  )
}

// ------------------------------------------------------------------ 菜单

export function RowMenu({
  label,
  align = 'left',
  children,
}: {
  label: string
  align?: 'left' | 'right'
  children: ReactNode
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <IconButton
          label={label}
          icon={
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="3.2" r="1.3" fill="currentColor" />
              <circle cx="8" cy="8" r="1.3" fill="currentColor" />
              <circle cx="8" cy="12.8" r="1.3" fill="currentColor" />
            </svg>
          }
        />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="m-menu-content"
          align={align === 'right' ? 'end' : 'start'}
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

export function MenuItem({
  onSelect,
  danger,
  disabled,
  children,
}: {
  onSelect?: () => void
  danger?: boolean
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <DropdownMenu.Item
      className={danger ? 'm-menu-item m-menu-danger' : 'm-menu-item'}
      disabled={disabled}
      onSelect={() => onSelect?.()}
    >
      {children}
    </DropdownMenu.Item>
  )
}

// ------------------------------------------------------------------ 头像 / 仪表

/** 名字生成的默认头像：同一个人永远同一个底色（按字符码求和取模）。 */
export function Avatar({ name, url, size = 28 }: { name: string; url?: string; size?: number }) {
  const initial = Array.from(name.trim())[0] ?? '?'
  const hue = Array.from(name).reduce((sum, char) => sum + char.codePointAt(0)!, 0) % 360
  return (
    <span
      className="m-avatar"
      style={{
        width: `${size}px`,
        height: `${size}px`,
        fontSize: `${Math.round(size * 0.42)}px`,
        background: `hsl(${hue} 24% 88%)`,
      }}
      aria-hidden="true"
    >
      {url ? <img src={url} alt="" /> : initial}
    </span>
  )
}

export function RingGauge({
  ratio,
  label,
  tone = 'accent',
  ariaLabel,
}: {
  /** 0–1。 */
  ratio: number
  label: string
  tone?: 'accent' | 'warning' | 'danger'
  ariaLabel: string
}) {
  const size = 48
  const stroke = 5
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const clamped = Math.min(Math.max(ratio, 0), 1)
  const color = `var(--${tone === 'accent' ? 'accent' : tone === 'warning' ? 'status-warning' : 'status-danger'})`
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={ariaLabel}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--meter-track)"
        strokeWidth={stroke}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${circumference * clamped} ${circumference}`}
        // 从 12 点方向顺时针画：起点转到正上方，进度才是"从满往里缺"的读法
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text
        x="50%"
        y="53%"
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize="11"
        fill="var(--text-secondary)"
      >
        {label}
      </text>
    </svg>
  )
}
