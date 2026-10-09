/**
 * 右侧面板「文件」视图里那几件**纯计算**：同层排序、模糊匹配、把已展开的几层摊平、
 * 以及"要点开哪几层才看得见那一份"。
 *
 * 为什么单独一个文件：这四件事全是"输入 → 输出"的函数，没有请求、没有 React
 * （渲染在 `panel/FilesTab.tsx` 与 `panel/FileTree.tsx`）。摆在这里是为了**能被单测**——
 * 树这类东西的错（顺序反了、子目录被排到文件后面、搜到没展开的层、少展开一层）
 * 在界面上都只表现为"看起来不太对"，靠人眼盯不出来。
 *
 * 层与层之间**只按 `path` 认**（服务端给的 `key` 本来就是带相对路径的那一串）：
 * 契约见 `api/conversations.ts` 的 `ConversationFile`——`key` 是这一份在这个范围内的
 * 唯一标识，也是进子目录时交给服务端的那个 `path`。
 */
import type { ConversationFile } from '@/api/conversations'

/** 排序档（与工具栏那个菜单一一对应）。 */
export type FileSort = 'name' | 'modified' | 'type'

/** 落在某一层里的一条：`dir` 是它所在那一层（`''` = 根）。 */
export interface TreeEntry {
  dir: string
  entry: ConversationFile
}

/** 后缀（小写、不带点）；没有后缀就是空串。 */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  // 前导点不算后缀（`.gitignore` 是一份**没后缀**的文件，不是"后缀 gitignore"）
  if (dot <= 0) return ''
  return name.slice(dot + 1).toLowerCase()
}

/** 一层路径下面一层的父路径（`''` = 已经在最上面那一层）。 */
export function parentOf(path: string): string {
  return path.split('/').slice(0, -1).join('/')
}

/** 把一层路径拆成"每往里一层"的那一串（`out/2026` → `['out', 'out/2026']`）。 */
export function chainOf(path: string): string[] {
  const parts = path ? path.split('/') : []
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'))
}

/**
 * 这一层里的**显示顺序**。
 *
 * 两条口径：
 *
 * 1. **目录恒在文件前面**，三个档都如此（Kimi 的文件列表同一条，也是文件管理器的通用做法）：
 *    排序是"同一类里怎么排"，不是"把目录和文件混在一起重排"；
 * 2. **只在同一层内排**：这个函数一次只吃一层（`entries` 就是某一层的清单），
 *    所以排序永远不会把子目录里的东西拎到父层来。
 *
 * 三档各自的次序：
 * - `name`：按显示名，`zh` + 数字感知（`第 10 章` 排在 `第 9 章` 后面，而不是按码位）；
 * - `modified`：**最近的在前**（用户找的通常是刚动过的那个），没有时间戳的排最后；
 * - `type`：按后缀，字母序；同后缀再按名字——不然同目录下一堆 `.png` 之间没有次序。
 */
export function sortEntries(
  entries: readonly ConversationFile[],
  sort: FileSort,
): ConversationFile[] {
  const byName = (a: ConversationFile, b: ConversationFile): number =>
    a.name.localeCompare(b.name, 'zh', { numeric: true, sensitivity: 'base' })

  return [...entries].sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1
    if (sort === 'modified') {
      const left = a.modified_at ?? ''
      const right = b.modified_at ?? ''
      if (left !== right) return right.localeCompare(left)
      return byName(a, b)
    }
    if (sort === 'type') {
      const left = extensionOf(a.name)
      const right = extensionOf(b.name)
      if (left !== right) return left.localeCompare(right)
      return byName(a, b)
    }
    return byName(a, b)
  })
}

/**
 * 模糊匹配的得分（`-1` = 不匹配，越大越靠前）。
 *
 * 判据是**子序列**而不是子串：面板里搜文件多半是"记得几个字母"（`qbrd` 能命中
 * `季度报告.docx`——`q` `b` `r` `d` 按序出现在拼音里当然不行，但 `jdbg` 这种缩写、
 * 或 `rp` 命中 `report.md` 都靠它）。子串匹配在"只记得零散几个字"时一条都搜不出来。
 *
 * 加减分的两条：
 * - **连续命中加分**（`报告` 比 `报…告` 得分高）：成片出现的字符比散落的更像用户找的那个；
 * - **开头命中加分**（前缀最加分，其次是词边界：`-` / `_` / `.` / 空格 / `/` 之后）：
 *   敲 `rep` 时 `report.md` 该在 `my-report.md` 前面。
 */
export function fuzzyScore(query: string, text: string): number {
  const needle = query.trim().toLowerCase()
  if (!needle) return 0
  const haystack = text.toLowerCase()

  let score = 0
  let cursor = 0
  let previous = -1
  for (const char of needle) {
    const hit = haystack.indexOf(char, cursor)
    if (hit < 0) return -1
    score += 1
    if (hit === previous + 1) score += 2
    if (hit === 0 || '-_. /'.includes(haystack[hit - 1] ?? '')) score += 3
    previous = hit
    cursor = hit + 1
  }
  // 命中占整串的比例越高越像"就是它"（`md` 命中 `md` 强过命中 `我的文档.md`）
  return score + Math.round((needle.length / Math.max(haystack.length, 1)) * 10)
}

/**
 * 在**已经摊平的那几层**里搜（`items` 由 `flattenLevels` 给，见它那条"只搜已展开的层"）。
 * 结果按得分降序，同分按原来的层序。
 */
export function searchTree(items: readonly TreeEntry[], query: string, limit = 300): TreeEntry[] {
  const needle = query.trim()
  if (!needle) return []
  const scored: { item: TreeEntry; score: number; order: number }[] = []
  items.forEach((item, order) => {
    // 目录名与文件名都参与匹配：敲 `out` 找的是那个目录
    const score = fuzzyScore(needle, item.entry.name)
    if (score >= 0) scored.push({ item, score, order })
  })
  scored.sort((a, b) => (a.score === b.score ? a.order - b.order : b.score - a.score))
  return scored.slice(0, limit).map((item) => item.item)
}

/**
 * 这一条在不在 `dir` 这一层下面（`dir=''` 时任何 key 都在最上面那层下面）。
 * 定位种子那一段要用它分辨两种"`dirsToReveal` 返回空"：**就在这一层**，还是**不在这里**。
 */
export function isUnder(dir: string, key: string): boolean {
  if (!dir) return true
  return key === dir || key.startsWith(`${dir}/`)
}

/**
 * 把"已经拿到清单的每一层"按树的次序摊平（父层在前，子层紧跟它那个目录项之后）。
 *
 * **这就是"只搜已展开的层"那条口径的落点**：`byDir` 里只有取过数的那些目录，
 * 而只有 `expanded` 里的目录才会往下走——一个目录收起来之后它那份清单还留在
 * `byDir` 里（react-query 的缓存），但那不算"展开着"，所以它里面的东西搜不到。
 * 搜索框上面那句话说的正是这件事（不假装搜了整棵树，用户也不必等一整个目录扫完）。
 */
export function flattenLevels(
  root: string,
  byDir: Readonly<Record<string, readonly ConversationFile[]>>,
  expanded: ReadonlySet<string>,
): TreeEntry[] {
  const out: TreeEntry[] = []
  const walk = (dir: string, depth: number): void => {
    // 树再深也不该递归到爆栈：见下面 `MAX_DEPTH` 的理由
    if (depth > MAX_DEPTH) return
    for (const entry of byDir[dir] ?? []) {
      out.push({ dir, entry })
      if (entry.is_dir && expanded.has(entry.key)) walk(entry.key, depth + 1)
    }
  }
  walk(root, 0)
  return out
}

/**
 * 最深几层就停（服务端一层一层给，层数由数据决定，不由用户决定）。
 * 与 `sidebar` 那类递归同一理由：环状数据（`a/b` 的 key 又指回 `a`）会让 `walk` 转不出来，
 * 而这里**宁可疑心深得离谱的目录，也不能把整页卡死**。
 */
const MAX_DEPTH = 32

/**
 * **要展开哪几层，才看得见 `key` 那一份**（`openFiles` 带种子时的定位）。
 *
 * 判据只有一条：`key` 相对当前层（`dir`）的那一串前缀。当前层**已经在看**，
 * 所以不包含它自己；`key` 就在当前层时返回空（什么都不用展开）。
 *
 * 不在这一层下面（`dir='out'` 而 key 在别处）返回空数组：**不猜**——由调用方决定
 * 要不要换一层看（面板的做法是回到最上面那层再展开，见 `FilesTab` 的 `locate`）。
 */
export function dirsToReveal(dir: string, key: string): string[] {
  const base = dir ? `${dir}/` : ''
  if (!key.startsWith(base)) return []
  const rest = key.slice(base.length)
  const parts = rest.split('/')
  if (parts.length < 2) return []
  const chain: string[] = []
  for (let index = 1; index < parts.length; index += 1) {
    chain.push(base + parts.slice(0, index).join('/'))
  }
  return chain
}

/**
 * 面包屑那几段（每段可点，最后一段是当前层）。
 *
 * **只有路径本身那几段**（2026-10-09 改）：原先首段由调用方给（面板里是「本会话」或
 * 「Workspaces」），而用户指出那颗根按钮与文件范围切换重复——范围页签撤掉之后它一起去掉，
 * 面包屑从**实际路径那一层**开始。根那层因此返回空数组，调用方不必为它摆一段占位。
 */
export function crumbsOf(path: string): { label: string; path: string }[] {
  const segments = path ? path.split('/') : []
  return segments.map((segment, index) => ({
    label: segment,
    path: segments.slice(0, index + 1).join('/'),
  }))
}
