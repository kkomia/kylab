/**
 * 左栏文件夹树的**纯函数**（不碰 React、不碰网络，可以直接对拍用例）。
 *
 * 为什么单独一层：树的形状、可见顺序、子树范围这三件事在**好几处**要用
 * （渲染、键盘走位、移动菜单里要排除自己的子孙、删除确认里要数"会删掉几个"），
 * 各写一遍的结果一定是"某处少了某个子孙"——而那类错只有在特定形状的树上才看得见。
 *
 * 有一条约定贯穿全文件：**列表顺序就是名字顺序**（后端 `ORDER BY lower(name)`），
 * 这里只做"把子节点挂到父节点下面"，不在前端重排一次——重排会让界面顺序与
 * 服务端顺序变成两个可以不一致的口径。
 */
import type { NoteFolder } from '@/api/notes'

/** 树上的一个节点：文件夹 + 它的子节点（子节点同样按名字顺序）。 */
export interface FolderNode {
  folder: NoteFolder
  children: FolderNode[]
}

/**
 * 把扁平列表拼成树。
 *
 * 两种**必须兜住**的坏输入（界面上看不到，但真出现时不能让节点凭空消失）：
 *
 * - **父不在这一份列表里**（父是别人的、或另一处刚删掉它）：挂到根级。
 *   悄悄丢掉它会让整个子树从界面上消失——而库里的笔记还挂在那些文件夹上；
 * - **成环**（`a.parent = b`、`b.parent = a`）：成环的那一环挂到根级。
 *   不做这个判断的话下面的递归会转不出来（接口层已经挡了"移进自己的子孙"，
 *   但库里可能存着早期版本写进去的环，那种库不该让界面直接白屏）。
 */
export function buildFolderTree(folders: readonly NoteFolder[]): FolderNode[] {
  const nodes = new Map<string, FolderNode>()
  for (const folder of folders) nodes.set(folder.id, { folder, children: [] })

  const parentOf = new Map<string, string | null>()
  for (const folder of folders) {
    // 指向不存在的父（含指向自己）一律当根级：否则这个节点永远挂不上
    const parent = folder.parent_id
    parentOf.set(folder.id, parent && parent !== folder.id && nodes.has(parent) ? parent : null)
  }

  const rootIds: string[] = []
  for (const folder of folders) {
    const parentId = parentOf.get(folder.id) ?? null
    if (parentId === null || hasAncestor(parentId, folder.id, parentOf)) {
      rootIds.push(folder.id)
      continue
    }
    nodes.get(parentId)!.children.push(nodes.get(folder.id)!)
  }
  return rootIds.map((id) => nodes.get(id)!)
}

/** `candidate` 的祖先链上有没有 `target`（用来识别"这一挂上去就成环"）。 */
function hasAncestor(
  candidate: string,
  target: string,
  parentOf: ReadonlyMap<string, string | null>,
): boolean {
  const seen = new Set<string>()
  let cursor: string | null = candidate
  while (cursor !== null && !seen.has(cursor)) {
    if (cursor === target) return true
    seen.add(cursor)
    cursor = parentOf.get(cursor) ?? null
  }
  return false
}

/** 树上的一行（键盘走位用的**可见**顺序：折叠起来的子树不在里面）。 */
export interface VisibleFolder {
  folder: NoteFolder
  /** 1 起（全部 / 未归档那两行也是 1，文件夹按深度往下排）。 */
  level: number
  /** 折叠态下"这一行下面还有子节点"——它决定 `aria-expanded` 出不出现。 */
  hasChildren: boolean
  expanded: boolean
}

/**
 * 展开态下的可见行，**先序遍历**（父在子前面，与 DOM 顺序一致）。
 *
 * `collapsed` 收的是"被折叠的 id"而不是"被展开的 id"：默认全展开时，
 * 新建出来的文件夹自然就在展开态里，不必每建一个就往集合里补一笔。
 */
export function visibleFolders(
  nodes: readonly FolderNode[],
  collapsed: ReadonlySet<string>,
  level = 1,
): VisibleFolder[] {
  const out: VisibleFolder[] = []
  for (const node of nodes) {
    const expanded = !collapsed.has(node.folder.id)
    out.push({
      folder: node.folder,
      level,
      hasChildren: node.children.length > 0,
      expanded,
    })
    if (node.children.length && expanded) {
      out.push(...visibleFolders(node.children, collapsed, level + 1))
    }
  }
  return out
}

/** 某个文件夹的全部子孙 id（**不含它自己**）：移动菜单里要排除它们，防止成环。 */
export function descendantIds(folders: readonly NoteFolder[], folderId: string): Set<string> {
  const childrenOf = new Map<string, string[]>()
  for (const folder of folders) {
    if (!folder.parent_id) continue
    const list = childrenOf.get(folder.parent_id) ?? []
    list.push(folder.id)
    childrenOf.set(folder.parent_id, list)
  }
  const found = new Set<string>()
  const queue = [...(childrenOf.get(folderId) ?? [])]
  while (queue.length) {
    const id = queue.shift() as string
    if (found.has(id)) continue // 坏数据成环时不会转死
    found.add(id)
    queue.push(...(childrenOf.get(id) ?? []))
  }
  return found
}

/** 文件夹的完整路径（`工作 / 会议`）：同名文件夹在不同层时，只有路径说得清是哪一个。 */
export function folderPath(folders: readonly NoteFolder[], folderId: string): string {
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const names: string[] = []
  const seen = new Set<string>()
  let cursor = byId.get(folderId)
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id)
    names.unshift(cursor.name)
    cursor = cursor.parent_id ? byId.get(cursor.parent_id) : undefined
  }
  return names.join(' / ')
}

/** 菜单里的候选（先序遍历）：`path` 是给人看的，`depth` 只用来缩进。 */
export interface FolderOption {
  id: string
  name: string
  path: string
  depth: number
}

/**
 * 菜单用的扁平行（含完整路径），**按树的先序**排——与左栏那棵树读起来是同一个顺序。
 *
 * `exclude` 传某个文件夹时，它的整棵子树都不出现（移动菜单用：
 * 那些位置的结果就是成环，不该出现在候选里）。
 */
export function folderOptions(folders: readonly NoteFolder[], exclude?: string): FolderOption[] {
  const skip = exclude ? new Set([exclude, ...descendantIds(folders, exclude)]) : undefined
  const out: FolderOption[] = []
  const walk = (nodes: readonly FolderNode[], depth: number, prefix: string): void => {
    for (const node of nodes) {
      if (skip?.has(node.folder.id)) continue
      const path = prefix ? `${prefix} / ${node.folder.name}` : node.folder.name
      out.push({ id: node.folder.id, name: node.folder.name, path, depth })
      walk(node.children, depth + 1, path)
    }
  }
  walk(buildFolderTree(folders), 0, '')
  return out
}

/**
 * 删一个文件夹会带走什么：子文件夹数、里面的笔记数（含子孙的）。
 *
 * 前台要用它把确认框写清楚（"N 个子文件夹会一起删掉，M 篇笔记会回到未归档"）——
 * 数错了就等于骗用户，而这句话正是他按下删除键之前唯一能看到的后果。
 */
export function subtreeStats(
  folders: readonly NoteFolder[],
  folderId: string,
): { folders: number; notes: number } {
  const descendants = descendantIds(folders, folderId)
  const inside = folders.filter((folder) => folder.id === folderId || descendants.has(folder.id))
  return {
    folders: descendants.size,
    notes: inside.reduce((sum, folder) => sum + folder.note_count, 0),
  }
}
