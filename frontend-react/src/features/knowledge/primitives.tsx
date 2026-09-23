/**
 * 知识库域的原语（占位版）。
 *
 * **这些是临时的**：`src/ui/**`（P2 域，shadcn/Radix 原语）落地后，本文件应当被删掉，
 * 各页面改成从 `@/ui/*` 取按钮/输入框/弹窗/下拉/状态标签。现在自己实现一份的理由是
 * 本域不能等别人：知识库的交互（批量选择、抽屉、设置弹窗）今天就要能用。
 *
 * 视觉与旧前端的 `components/ui/*.vue` 对齐（同类名、同令牌），所以换原语时
 * 观感不会跳。刻意**不引 Radix**：这里的弹窗/菜单只需要"Esc 关、点外面关"两条，
 * 自己写比多一层 Portal/合成事件更可控，测试里也少一层不确定性。
 */
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { CircleHelp, MoreHorizontal, X, type LucideIcon } from 'lucide-react'

import './knowledge.css'

/* ---------------------------------------------------------------- 按钮 */

type ButtonVariant = 'default' | 'primary' | 'ghost' | 'subtle' | 'danger'

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  default: '',
  primary: 'kb-btn-primary',
  ghost: 'kb-btn-ghost',
  subtle: 'kb-btn-subtle',
  danger: 'kb-btn-danger',
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: 'sm' | 'md'
  icon?: LucideIcon
}

export function Button({
  variant = 'default',
  size = 'md',
  icon: Icon,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  const classes = ['kb-btn', size === 'sm' ? 'kb-btn-sm' : '', BUTTON_VARIANTS[variant], className]
    .filter(Boolean)
    .join(' ')
  return (
    <button type={type} className={classes} {...rest}>
      {Icon ? <Icon size={size === 'sm' ? 14 : 16} aria-hidden="true" /> : null}
      {children}
    </button>
  )
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon
  /** 读屏器与测试用的名字：纯图标按钮必须有一个。 */
  label: string
  size?: number
  title?: string
}

export function IconButton({
  icon: Icon,
  label,
  size = 16,
  title,
  className,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      className={['kb-icon-btn', className].filter(Boolean).join(' ')}
      {...rest}
    >
      <Icon size={size} aria-hidden="true" />
    </button>
  )
}

/* ---------------------------------------------------------------- 输入 */

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
}

export function Input({ className, ...rest }: InputProps) {
  return <input className={['kb-input', className].filter(Boolean).join(' ')} {...rest} />
}

export function Textarea({
  className,
  ...rest
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={['kb-textarea', className].filter(Boolean).join(' ')} {...rest} />
}

export interface SelectOption {
  value: string
  label: string
}

interface SelectProps {
  value: string
  options: readonly SelectOption[]
  onChange: (value: string) => void
  'aria-label'?: string
  disabled?: boolean
  className?: string
  id?: string
}

/**
 * 原生 `<select>`（占位）。
 *
 * 旧前端有一个自绘的 AppSelect；这里先用原生元素——它自带键盘、读屏与移动端行为，
 * 换成 shadcn 的 Select 时只需要替换本组件。
 */
export function Select({ value, options, onChange, className, ...rest }: SelectProps) {
  return (
    <select
      className={['kb-select', className].filter(Boolean).join(' ')}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      {...rest}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

/* ---------------------------------------------------------------- 提示 */

/** 标题旁的「?」：点开/悬停才显示的解释性文字（《前端设计规范》§5.1 的保留项）。 */
export function InfoTip({ text }: { text: string }) {
  return (
    <button type="button" className="kb-infotip" aria-label={text} title={text}>
      <CircleHelp size={13} aria-hidden="true" />
    </button>
  )
}

/* ---------------------------------------------------------------- 状态标签 */

export type StatusTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info'

interface StatusTagProps {
  label: string
  tone?: StatusTone
  /** 还在动：不给底色，改用呼吸的圆点。 */
  running?: boolean
  title?: string
}

export function StatusTag({ label, tone = 'neutral', running = false, title }: StatusTagProps) {
  const classes = ['kb-tag', `kb-tag-${tone}`, running ? 'kb-tag-running' : '']
    .filter(Boolean)
    .join(' ')
  return (
    <span className={classes} title={title}>
      <span className="kb-tag-dot" aria-hidden="true" />
      <span>{label}</span>
    </span>
  )
}

/* ---------------------------------------------------------------- 骨架 / 空态 */

export function Skeleton({ variant, rows }: { variant: 'card' | 'list' | 'text'; rows: number }) {
  const itemClass =
    variant === 'card' ? 'kb-skeleton-card' : variant === 'text' ? 'kb-skeleton-text' : ''
  return (
    <div className="kb-skeleton" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className={['kb-skeleton-row', itemClass].filter(Boolean).join(' ')} />
      ))}
    </div>
  )
}

export function EmptyState({
  title,
  hint,
  children,
}: {
  title: string
  hint?: string
  children?: ReactNode
}) {
  return (
    <div className="kb-empty">
      <p className="kb-empty-title">{title}</p>
      {hint ? <p className="kb-empty-hint">{hint}</p> : null}
      {children}
    </div>
  )
}

/* ---------------------------------------------------------------- 进度条 */

export type MeterTone = 'accent' | 'info' | 'success' | 'warning' | 'danger' | 'neutral'

export interface MeterSegment {
  fill: number
  tone?: MeterTone
  pulsing?: boolean
}

interface MeterBarProps {
  segments: MeterSegment[]
  tone?: MeterTone
  size?: 'sm' | 'md'
  valueLabel?: string
  ariaLabel?: string
}

/** 分段进度条：每段一种色，空槽也画出来（"共 6 段、走到第 3 段"本身就是信息）。 */
export function MeterBar({
  segments,
  tone = 'accent',
  size = 'md',
  valueLabel,
  ariaLabel,
}: MeterBarProps) {
  const ratio = segments.length
    ? segments.reduce((sum, segment) => sum + Math.max(0, Math.min(segment.fill, 1)), 0) /
      segments.length
    : 0
  return (
    <div
      className={['kb-meter', size === 'sm' ? 'kb-meter-sm' : 'kb-meter-md'].join(' ')}
      role="progressbar"
      aria-label={ariaLabel}
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={valueLabel}
    >
      {segments.map((segment, index) => (
        <span
          key={index}
          className={[
            'kb-segment',
            `kb-segment-${segment.tone ?? tone}`,
            segment.pulsing ? 'kb-segment-pulsing' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <span
            className="kb-segment-fill"
            style={{ width: `${Math.min(Math.max(segment.fill, 0), 1) * 100}%` }}
          />
        </span>
      ))}
    </div>
  )
}

/* ---------------------------------------------------------------- 弹窗 */

interface ModalProps {
  open: boolean
  title: string
  onClose: () => void
  size?: 'md' | 'wide'
  height?: 'auto' | 'full'
  /** 回车提交（旧 AppModal 的 `@keydown.enter`）：只在需要"随手回车保存"的弹窗上给。 */
  onEnter?: () => void
  children: ReactNode
  footer?: ReactNode
}

export function Modal({
  open,
  title,
  onClose,
  size = 'md',
  height = 'auto',
  onEnter,
  children,
  footer,
}: ModalProps) {
  useEffect(() => {
    if (!open) return undefined
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeydown)
    return () => window.removeEventListener('keydown', onKeydown)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="kb-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className={[
          'kb-modal',
          size === 'wide' ? 'kb-modal-wide' : '',
          height === 'full' ? 'kb-modal-full' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && onEnter) {
            if (event.target instanceof HTMLTextAreaElement) return
            onEnter()
          }
        }}
      >
        <div className="kb-modal-head">
          <h2 className="kb-modal-title">{title}</h2>
          <IconButton icon={X} label="关闭弹窗" onClick={onClose} />
        </div>
        <div className="kb-modal-body">{children}</div>
        {footer ? <div className="kb-modal-foot">{footer}</div> : null}
      </div>
    </div>
  )
}

interface ConfirmDialogProps {
  open: boolean
  title: string
  lead: string
  note?: string
  confirmLabel?: string
  busy?: boolean
  busyLabel?: string
  onConfirm: () => void
  onClose: () => void
  children?: ReactNode
}

export function ConfirmDialog({
  open,
  title,
  lead,
  note,
  confirmLabel = '确定',
  busy = false,
  busyLabel = '处理中…',
  onConfirm,
  onClose,
  children,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" onClick={onConfirm} disabled={busy}>
            {busy ? busyLabel : confirmLabel}
          </Button>
        </>
      }
    >
      <p className="kb-lead">{lead}</p>
      {note ? <p className="kb-modal-note">{note}</p> : null}
      {children}
    </Modal>
  )
}

/* ---------------------------------------------------------------- 行菜单 */

interface RowMenuProps {
  label: string
  /** 渲染成菜单项：调用方给一个函数，`close()` 由菜单提供。 */
  children: (close: () => void) => ReactNode
  icon?: LucideIcon
  className?: string
}

/**
 * 行尾的操作菜单。
 *
 * 菜单项本身由调用方写（它们是 `<button>`），这里只负责开合、点外面关、Esc 关。
 * 关掉之后焦点不自动回触发器——旧实现也没做，而这里多一层焦点管理在测试里
 * 会多一层不确定性。
 */
export function RowMenu({ label, children, icon: Icon = MoreHorizontal, className }: RowMenuProps) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(event.target as Node)) setOpen(false)
    }
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeydown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeydown)
    }
  }, [open])

  return (
    <span className={['kb-menu-wrap', className].filter(Boolean).join(' ')} ref={wrap}>
      <IconButton
        icon={Icon}
        label={label}
        size={16}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      />
      {open ? (
        <div className="kb-menu" role="menu" aria-label={label}>
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </span>
  )
}

/** 行菜单里的一项（统一间距与破坏性配色）。 */
export function MenuItem({
  onClick,
  danger = false,
  disabled = false,
  icon: Icon,
  children,
}: {
  onClick: () => void
  danger?: boolean
  disabled?: boolean
  icon?: LucideIcon
  children: ReactNode
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      className={['kb-menu-item', danger ? 'kb-menu-item-danger' : ''].filter(Boolean).join(' ')}
      onClick={onClick}
    >
      {Icon ? <Icon size={14} aria-hidden="true" /> : null}
      {children}
    </button>
  )
}
