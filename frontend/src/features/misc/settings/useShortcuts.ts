/**
 * 快捷键注册表（P2-1，照 ZCode 的「命令 + 多绑定 + 作用域 + 冲突提示 + 恢复默认」）。
 *
 * 为什么要有这一层，而不是接着在组件里 `if (event.ctrlKey && key === 'k')`：
 * 全站只有一处硬编码的 Ctrl+K（侧栏的新建会话），而界面上还摆着一枚 `Ctrl K` 的提示
 * ——用户改不了它、两块写法也对不上。ZCode 的做法是把快捷键做成**注册表**：
 * 命令（做什么）与绑定（按哪几个键）分开，绑定可改、可多个、可恢复默认，冲突当场提示。
 *
 * 四件事各有一处真相：
 * - **命令表**（`SHORTCUT_COMMANDS`）：id、名字、作用域、默认绑定；
 * - **绑定存 localStorage**（`kylab-shortcuts`）：与主题、字号同一族"这台机器怎么用"
 *   的偏好，不进后端；
 * - **匹配**（`matchShortcut`）：修饰键**必须精确对上**——不精确的话
 *   "Shift+Enter 换行"会被"Enter 发送"抢走；
 * - **冲突**（`conflictMessage`）：同一个绑定被两条命令用着就说出来，
 *   但**不拦着不让改**——用户完全可能先把 A 改走，再回来给 B 绑上。
 *
 * 与旧前端的差别只在实现：`ref` → `useSyncExternalStore`（React 版的单例订阅），
 * 逻辑（解析、规范化、匹配、冲突）逐条照搬，并按旧版的测试口径（`parseBinding`
 * 与 `canonicalBinding` 是纯函数）保持可单测。
 */
import { useSyncExternalStore } from 'react'

/** 作用域：输入框里的（只在对话输入框上生效）与全局的（在哪都生效）。 */
export type ShortcutScope = 'composer' | 'global'

export type ShortcutId = 'chat.send' | 'chat.newline' | 'chat.new' | 'layout.toggleSidebar'

export interface ShortcutCommand {
  id: ShortcutId
  label: string
  /** 一行说明：这条命令做什么（设置里显示）。 */
  hint: string
  scope: ShortcutScope
  /** 默认绑定，**可以有多条**：用户不必在"我习惯的那组键"与"产品默认的那组键"之间二选一。 */
  defaults: string[]
}

/**
 * 命令表。
 *
 * 四条默认值里有三条是**界面本来就写着**的（回车发送、Shift+回车换行、Ctrl/Cmd+K
 * 新建会话），第四条（切换侧栏 Ctrl/Cmd+B）是补的：侧栏顶上那颗折叠按钮没有快捷键，
 * 而它正是"看一眼内容再收起来"这种高频动作。取 `Mod+B` 而不是 `Mod+N`：
 * 浏览器把 `Ctrl/Cmd+N` 留给了"新窗口"，网页拦不住它。
 */
export const SHORTCUT_COMMANDS: readonly ShortcutCommand[] = [
  {
    id: 'chat.send',
    label: '发送消息',
    hint: '把输入框里的话发出去（也是斜杠命令执行键）',
    scope: 'composer',
    // 两个绑定：主绑定回车，另一个是 Ctrl/Cmd+回车（许多聊天产品的习惯）
    defaults: ['Enter', 'Mod+Enter'],
  },
  {
    id: 'chat.newline',
    label: '输入框换行',
    hint: '在输入框里换行，不发送',
    scope: 'composer',
    defaults: ['Shift+Enter'],
  },
  {
    id: 'chat.new',
    label: '新建会话',
    hint: '开一条新对话（侧栏最上面那一条）',
    scope: 'global',
    defaults: ['Mod+K'],
  },
  {
    id: 'layout.toggleSidebar',
    label: '切换侧栏',
    hint: '收起 / 展开左侧栏',
    scope: 'global',
    defaults: ['Mod+B'],
  },
]

/** 绑定存这儿（本机偏好）。 */
export const SHORTCUTS_STORAGE_KEY = 'kylab-shortcuts'

export interface ParsedBinding {
  /** Ctrl（Windows/Linux）或 Cmd（macOS）——绑定串里写 `Mod`。 */
  mod: boolean
  alt: boolean
  shift: boolean
  /** 主键（已小写）。 */
  key: string
}

/**
 * 解析一条绑定（`Mod+Shift+O`）。
 *
 * 认不出来时返回 `null`：调用方据此**忽略**（而不是当成某组键）——
 * 用户在设置里录坏一行，最坏的结果该是"这条快捷键不生效"，不是"随便按什么都触发"。
 */
export function parseBinding(binding: string): ParsedBinding | null {
  const parts = String(binding || '')
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length === 0) return null
  const parsed: ParsedBinding = { mod: false, alt: false, shift: false, key: '' }
  for (const part of parts) {
    const lower = part.toLowerCase()
    if (lower === 'mod' || lower === 'ctrl' || lower === 'cmd' || lower === 'meta')
      parsed.mod = true
    else if (lower === 'alt' || lower === 'option') parsed.alt = true
    else if (lower === 'shift') parsed.shift = true
    else if (!parsed.key) parsed.key = lower
    else return null // 两个主键（`K+J`）：看不懂，别猜
  }
  return parsed.key ? parsed : null
}

/** 主键的规范写法（用于**冲突比对**与**展示**两处）。 */
function normalizeKey(key: string): string {
  const lower = key.toLowerCase()
  if (lower === ' ' || lower === 'space') return 'Space'
  if (lower.length === 1) return lower.toUpperCase()
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

/** 规范形式（用于**冲突比对**：`shift+mod+k` 与 `Mod+Shift+K` 是同一组键）。 */
export function canonicalBinding(binding: string): string {
  const parsed = parseBinding(binding)
  if (!parsed) return ''
  const parts: string[] = []
  if (parsed.mod) parts.push('Mod')
  if (parsed.alt) parts.push('Alt')
  if (parsed.shift) parts.push('Shift')
  parts.push(normalizeKey(parsed.key))
  return parts.join('+')
}

/**
 * 绑定 → 界面上的小片（Kimi 的 `Ctrl` `K` 两枚 `<kbd>`）。
 *
 * `Mod` 显示成 `Ctrl`：**默认那几条是跨平台写法，而展示只能挑一个**——
 * 挑 Ctrl 是本仓既有的口径。macOS 上按的仍然是 Cmd（匹配那一层认 metaKey）。
 */
export function bindingParts(binding: string): string[] {
  const canonical = canonicalBinding(binding)
  if (!canonical) return []
  return canonical.split('+').map((part) => (part === 'Mod' ? 'Ctrl' : part))
}

/**
 * 一次键盘事件 → 绑定串（设置里"按一下录制"用）。
 *
 * 只按修饰键时返回 `null`：那不是"一组键"，而是用户正在往那组键上按——
 * 录下来会得到一条永远触发不了的绑定。
 */
export function bindingFromEvent(event: KeyboardEvent): string | null {
  const key = event.key
  if (!key || ['Control', 'Shift', 'Alt', 'Meta', 'CapsLock'].includes(key)) return null
  const parts: string[] = []
  if (event.ctrlKey || event.metaKey) parts.push('Mod')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  parts.push(key === ' ' ? 'Space' : key)
  return canonicalBinding(parts.join('+'))
}

// ------------------------------------------------------------------ 绑定表（本机）

type BindingMap = Record<string, string[]>

function defaultsMap(): BindingMap {
  const out: BindingMap = {}
  for (const command of SHORTCUT_COMMANDS) out[command.id] = [...command.defaults]
  return out
}

function readStored(): BindingMap {
  const empty = defaultsMap()
  try {
    const raw = window.localStorage.getItem(SHORTCUTS_STORAGE_KEY)
    if (!raw) return empty
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return empty
    const stored = parsed as Record<string, unknown>
    for (const command of SHORTCUT_COMMANDS) {
      const value = stored[command.id]
      // **只认已知的命令、只认字符串数组**：库里可能留着上一版删掉/改名的命令，
      // 或者被手工改坏的内容——那种数据不该让整张表失效
      if (!Array.isArray(value)) continue
      empty[command.id] = value.filter((item): item is string => typeof item === 'string')
    }
    return empty
  } catch {
    return empty
  }
}

/** 当前的绑定表（模块级单例：设置页与运行时读的是同一份）。 */
let bindings: BindingMap = typeof window === 'undefined' ? defaultsMap() : readStored()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function persist(): void {
  try {
    // 与默认值一模一样的命令**不写**：用户全恢复默认之后，库里那份就该消失
    // （否则以后改默认值的人会发现"改了不生效"——被一条老记录挡着）
    const overrides: BindingMap = {}
    for (const command of SHORTCUT_COMMANDS) {
      const value = bindings[command.id] ?? []
      if (JSON.stringify(value) !== JSON.stringify(command.defaults)) overrides[command.id] = value
    }
    if (Object.keys(overrides).length > 0) {
      window.localStorage.setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify(overrides))
    } else {
      window.localStorage.removeItem(SHORTCUTS_STORAGE_KEY)
    }
  } catch {
    // 存不上就只在本次会话生效
  }
}

function setBindings(id: ShortcutId, value: string[]): void {
  bindings = { ...bindings, [id]: value }
  emit()
  persist()
}

/** 一条命令当前的绑定（**总是新数组**：调用方改它不会动到表里那份）。 */
export function bindingsOf(id: ShortcutId): string[] {
  return [...(bindings[id] ?? [])]
}

/** 改某一条绑定（`index` 越界就追加）。 */
export function setBinding(id: ShortcutId, index: number, binding: string): void {
  const next = bindingsOf(id)
  if (index < 0 || index >= next.length) next.push(binding)
  else next[index] = binding
  setBindings(id, next.filter(Boolean))
}

/** 加一条空位（随后由设置页的"录制"填上）。 */
export function addBinding(id: ShortcutId): number {
  const next = bindingsOf(id)
  next.push('')
  setBindings(id, next)
  return next.length - 1
}

/** 删掉第 `index` 条绑定。 */
export function removeBinding(id: ShortcutId, index: number): void {
  setBindings(
    id,
    bindingsOf(id).filter((_, item) => item !== index),
  )
}

/** 恢复这一条命令的默认绑定。 */
export function resetCommand(id: ShortcutId): void {
  const command = SHORTCUT_COMMANDS.find((item) => item.id === id)
  if (!command) return
  setBindings(id, [...command.defaults])
}

/** 全部恢复默认（把整份本机记录抹掉）。 */
export function resetAllShortcuts(): void {
  bindings = defaultsMap()
  emit()
  try {
    window.localStorage.removeItem(SHORTCUTS_STORAGE_KEY)
  } catch {
    // 同上：存不上也只是"这次没记住"
  }
}

/** 这条绑定是否**被改过**（设置页据此显示"恢复默认"）。 */
export function isCustomized(id: ShortcutId): boolean {
  const command = SHORTCUT_COMMANDS.find((item) => item.id === id)
  if (!command) return false
  return JSON.stringify(bindingsOf(id)) !== JSON.stringify(command.defaults)
}

/** 占了这条绑定的**另一条命令**（没有就是 `null`）。 */
export function conflictingCommand(id: ShortcutId, binding: string): ShortcutCommand | null {
  const canonical = canonicalBinding(binding)
  if (!canonical) return null
  for (const command of SHORTCUT_COMMANDS) {
    if (command.id === id) continue
    if (bindingsOf(command.id).some((item) => canonicalBinding(item) === canonical)) return command
  }
  return null
}

/**
 * 冲突提示文案（有冲突时非空）。
 *
 * 措辞照 ZCode：**先说是谁占着**——只说"冲突了"用户还得自己找是跟谁撞了。
 */
export function conflictMessage(id: ShortcutId, binding: string): string {
  const other = conflictingCommand(id, binding)
  return other ? `已被「${other.label}」占用` : ''
}

// ------------------------------------------------------------------ 匹配

/** 一次事件是不是这条绑定。**修饰键必须精确对上**（多按一个 Shift 就不算）。 */
function matchesEvent(event: KeyboardEvent, binding: string): boolean {
  const parsed = parseBinding(binding)
  if (!parsed) return false
  if (parsed.mod !== (event.ctrlKey || event.metaKey)) return false
  if (parsed.alt !== event.altKey) return false
  if (parsed.shift !== event.shiftKey) return false
  const key = event.key === ' ' ? 'Space' : event.key
  return key.toLowerCase() === parsed.key
}

/**
 * 这次按键是哪条命令（`''` = 不归我们管）。
 *
 * 三条判断：
 * 1. **作用域**：`composer` 的命令只在输入框那个处理函数里问，`global` 的在窗口上问；
 * 2. **输入法组合中的键不算**（`isComposing`）：中文输入法选词时按的回车是给候选框的，
 *    把它当成"发送"会把用户打一半的字发出去；
 * 3. **同名命令里先匹配到的算**：同一命令的多条绑定本来就等价，谁先谁后无影响。
 */
export function matchShortcut(event: KeyboardEvent, scope: ShortcutScope): ShortcutId | '' {
  if (event.isComposing) return ''
  for (const command of SHORTCUT_COMMANDS) {
    if (command.scope !== scope) continue
    if (bindingsOf(command.id).some((binding) => matchesEvent(event, binding))) return command.id
  }
  return ''
}

/**
 * 事件是不是打在"正在打字的地方"（输入框、文本域、富文本）。
 *
 * 全局那两条命令用它挡一下：**输入框里是编辑器的地盘**——`Ctrl/Cmd+K` 在很多编辑器里
 * 是删行、`Cmd+B` 是加粗。这条判断让"全局"这个词的边界**只在这一处**定义。
 */
export function isTypingTarget(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null
  if (!target) return false
  if (target.isContentEditable) return true
  return /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function snapshot(): BindingMap {
  return bindings
}

/** 设置页与运行时共用的一份**只读视图**（React 版：订阅同一份模块级单例）。 */
export function useShortcuts() {
  const table = useSyncExternalStore(subscribe, snapshot, snapshot)
  return {
    commands: SHORTCUT_COMMANDS,
    table,
    bindingsOf,
    setBinding,
    addBinding,
    removeBinding,
    resetCommand,
    resetAllShortcuts,
    isCustomized,
    conflictMessage,
  }
}
