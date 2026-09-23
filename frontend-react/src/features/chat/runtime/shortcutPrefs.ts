/**
 * 快捷键：对话页这一侧的**只读**入口（迁移计划 §9 的下一步第 4 条）。
 *
 * ## 存储契约与 misc 域共用，键名一字不差
 *
 * 注册表（命令表 + 多绑定 + 冲突提示 + 恢复默认）在
 * `src/features/misc/settings/useShortcuts.ts`，**绑定落在 `localStorage` 的
 * `kylab-shortcuts`**（本机偏好，与 `kylab-sidebar-collapsed` 同一族）。这里的四条命令
 * id、绑定写法（`Mod+Enter` / `Shift+Enter` / `Enter`）、缺省值都与那份注册表**逐字相同**，
 * 所以设置页里改完，对话页这边读到的就是同一份数据。
 *
 * **为什么不直接 import 那个文件**：它属于 misc 域（那边的 owner 正在改自己的域），
 * 两个域同时 import 会让"改一处、两边都得重跑"的耦合变成日常。所以这里按**数据契约**
 * 实现一份极薄的读取层：**只认键名与绑定写法，不认实现**。
 * 契约变了要两边一起改（这也是它写在注释里的原因）。
 *
 * ## 只读，不写
 *
 * 这个文件**不落盘**：设置页那一侧才是写方（多绑定、恢复默认、冲突提示都在它那里）。
 * 对话页只做两件事：**读绑定**、**按绑定匹配键盘事件**。
 *
 * ## 绑定冲突：以注册表的判定为准
 *
 * 注册表的匹配规则是"按命令表顺序取**第一个**命中的命令"（`matchShortcut` 的实现），
 * 所以这里同样按命令表顺序问一遍：`chat.send` 在前，`chat.newline` 在后——用户把
 * `chat.newline` 也绑到 `Enter` 时，回车仍然是**发送**（同一条绑定不被两处抢）。
 * 跨作用域也各归各的：`composer` 的命令只在输入框那个处理函数里问，`global` 的
 * 在窗口上问，且全局那两条会被 `isTypingTarget` 挡在输入框外（见下）。
 */

/** 四条命令的 id（与 misc 域注册表的 `ShortcutId` 一字不差）。 */
export type ChatShortcutId = 'chat.send' | 'chat.newline' | 'chat.new' | 'layout.toggleSidebar'

/** 作用域：`composer` 只在对话输入框上生效，`global` 在窗口上生效。 */
export type ChatShortcutScope = 'composer' | 'global'

interface ChatShortcutCommand {
  id: ChatShortcutId
  scope: ChatShortcutScope
  /** 默认绑定（与注册表同一份值；库里只存"被改过"的那些）。 */
  defaults: string[]
}

/**
 * 命令表（**顺序即匹配优先级**，见模块头"绑定冲突"）。
 *
 * 这里的 `scope` / `defaults` 必须与 misc 域注册表一致：
 * - `chat.send`：`Enter` 与 `Mod+Enter` 两条默认绑定；
 * - `chat.newline`：`Shift+Enter`；
 * - `chat.new`：`Mod+K`（新建会话）；
 * - `layout.toggleSidebar`：`Mod+B`（切换侧栏）。
 */
const COMMANDS: readonly ChatShortcutCommand[] = [
  { id: 'chat.send', scope: 'composer', defaults: ['Enter', 'Mod+Enter'] },
  { id: 'chat.newline', scope: 'composer', defaults: ['Shift+Enter'] },
  { id: 'chat.new', scope: 'global', defaults: ['Mod+K'] },
  { id: 'layout.toggleSidebar', scope: 'global', defaults: ['Mod+B'] },
]

/** 绑定的存储键（与 misc 域共用，键名一字不差）。 */
export const SHORTCUTS_STORAGE_KEY = 'kylab-shortcuts'

/** 侧栏折叠态的存储键（与旧版 `useSidebar` 共用，键名一字不差）。 */
export const SIDEBAR_COLLAPSED_STORAGE_KEY = 'kylab-sidebar-collapsed'

/** 一条绑定解析之后的样子（`Mod` = Ctrl/Cmd）。 */
interface ParsedBinding {
  mod: boolean
  alt: boolean
  shift: boolean
  /** 主键（已小写；`Space` 这类名字保留原样的小写形态）。 */
  key: string
}

/**
 * 解析一条绑定（`Mod+Shift+O`）。
 *
 * 认不出来返回 `null`，调用方据此**忽略**（不是当成某组键）：用户在设置里录坏一行，
 * 最坏的结果该是"这条快捷键不生效"，不是"随便按什么都触发"。
 */
function parseBinding(binding: string): ParsedBinding | null {
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

/** 一次键盘事件是不是这条绑定。**修饰键必须精确对上**（多按一个 Shift 就不算）。 */
function matchesEvent(event: KeyboardEvent, binding: string): boolean {
  const parsed = parseBinding(binding)
  if (!parsed) return false
  if (parsed.mod !== (event.ctrlKey || event.metaKey)) return false
  if (parsed.alt !== event.altKey) return false
  if (parsed.shift !== event.shiftKey) return false
  const key = event.key === ' ' ? 'Space' : event.key
  return key.toLowerCase() === parsed.key
}

type BindingMap = Record<string, string[]>

/** 缺省那份（每条命令都没被改过时的表）。 */
function defaultsMap(): BindingMap {
  const out: BindingMap = {}
  for (const command of COMMANDS) out[command.id] = [...command.defaults]
  return out
}

/**
 * 把 `localStorage` 里那份原文解析成一张绑定表。
 *
 * 三条规矩与注册表一致：
 * - **只认已知的命令、只认字符串数组**：库里可能留着上一版删掉/改名的命令，
 *   或者被手工改坏的内容——那种数据不该让整张表失效；
 * - **缺省值不落盘**：库里只有"被改过"的那些命令，所以缺省那份要在这里补上；
 * - 读不到 / 解析不了就用缺省，不抛。
 */
function parseTable(raw: string | null): BindingMap {
  const table = defaultsMap()
  if (!raw) return table
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return table
    const stored = parsed as Record<string, unknown>
    for (const command of COMMANDS) {
      const value = stored[command.id]
      if (!Array.isArray(value)) continue
      table[command.id] = value.filter((item): item is string => typeof item === 'string')
    }
    return table
  } catch {
    return table
  }
}

/**
 * 缓存：**按 localStorage 里的那份原文**认（原文没变就不重解析）。
 *
 * 为什么要缓存：`matchChatShortcut` 在输入框的每一次按键上都要问一遍（打字也在问），
 * 每次 `JSON.parse` 一遍没必要。为什么要按原文认而不是"进程内只记一次"：
 * 设置页是**另一个域**在写这个键，它改完（甚至用户直接在 devtools 里改）之后，
 * 对话页的下一次按键就该照新的来——验收就是这一条。
 */
let cachedRaw: string | null = null
let cachedTable: BindingMap | null = null

function readRaw(): string | null {
  try {
    return window.localStorage.getItem(SHORTCUTS_STORAGE_KEY)
  } catch {
    // 隐私模式下 localStorage 读不了：退化成缺省那份
    return null
  }
}

function bindingsTable(): BindingMap {
  const raw = readRaw()
  if (cachedTable && raw === cachedRaw) return cachedTable
  cachedRaw = raw
  cachedTable = parseTable(raw)
  return cachedTable
}

/** 一条命令当前的绑定（**总是新数组**：调用方改它不会动到表里那份）。 */
export function bindingsOf(id: ChatShortcutId): string[] {
  return [...(bindingsTable()[id] ?? [])]
}

/**
 * 这次按键是哪条命令（`''` = 不归我们管）。
 *
 * 三条判断（与注册表的 `matchShortcut` 同一套）：
 * 1. **作用域**：`composer` 的只在输入框那个处理函数里问，`global` 的在窗口上问；
 * 2. **输入法组合中的键不算**（`isComposing`）：中文输入法选词时按的回车是给候选框的，
 *    当成"发送"会把用户打一半的字发出去；
 * 3. **按命令表顺序取第一个命中的**：同一条绑定不被两处抢（注册表的判定）。
 */
export function matchChatShortcut(
  event: KeyboardEvent,
  scope: ChatShortcutScope,
): ChatShortcutId | '' {
  if (event.isComposing) return ''
  for (const command of COMMANDS) {
    if (command.scope !== scope) continue
    if (bindingsOf(command.id).some((binding) => matchesEvent(event, binding))) return command.id
  }
  return ''
}

/**
 * 事件是不是打在"正在打字的地方"（输入框、文本域、富文本）。
 *
 * 全局那两条命令（新建会话、切换侧栏）用它挡一下：**输入框里是编辑器的地盘**——
 * `Ctrl/Cmd+K` 在很多编辑器里是删行、`Cmd+B` 是加粗（笔记页的富文本编辑器两样都有）。
 * 这一条与注册表里的同名判断同一份口径。
 */
export function isTypingTarget(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null
  if (!target) return false
  if (target.isContentEditable) return true
  return /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
}

/**
 * 切换侧栏（`layout.toggleSidebar`）。
 *
 * React 的壳里**还没有侧栏**（P5 之前它属于壳那一层，`src/app/**` 由主控接），
 * 所以这里做的是"把偏好翻过来"，两个约定都用旧版那一套：
 *
 * - **存储**：`kylab-sidebar-collapsed`（`'1'` = 收起，其余 = 展开）——与旧
 *   `useSidebar` 一字不差，落地的侧栏读这个键就是接上了；
 * - **事件**：再广播一条 `kylab:sidebar-toggle`（`detail.collapsed`），
 *   已经挂着的侧栏可以据此当场跟着收/开（`storage` 事件只在别的标签页之间派发，
 *   本页自己改的不算——所以要有这一条）。
 *
 * 返回翻转后的状态（用例据此断言，不必自己去读 localStorage）。
 */
export function toggleSidebarPreference(): boolean {
  let collapsed = true
  try {
    collapsed = window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) !== '1'
    if (collapsed) window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, '1')
    else window.localStorage.removeItem(SIDEBAR_COLLAPSED_STORAGE_KEY)
  } catch {
    // 存不上就只在本次会话生效（与旧 `useSidebar` 同一条）
  }
  window.dispatchEvent(new CustomEvent('kylab:sidebar-toggle', { detail: { collapsed } }))
  return collapsed
}
