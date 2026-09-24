/**
 * 左栏的文件夹树（v14）：全部 / 未归档 / 用户自己建的层级文件夹。
 *
 * **为什么自己写而不是引轮子**（这一条是经过比较的，不是顺手）：
 *
 * 1. 仓库里没有现成可复用的真树。`KnowledgeBaseView` 那棵"目录"是**两层平铺列表**
 *    （`FolderOut` 没有 `parent_id`、没有 `role=tree`/`treeitem`），这里要的是真层级 +
 *    键盘 + ARIA，它只能借外观、借不到语义；
 * 2. 网络上的成熟轮子（`@headless-tree/react` 1.7、`react-arborist`）能力都对得上，
 *    但引依赖要动 `package.json` 与 `pnpm-lock.yaml`——**这两个文件不属于本次改动的
 *    文件范围**，而"为了一个两百行的树去改依赖清单"本身也该由用户拍板；
 * 3. 这一层需要的树是**受控的、纯展示的**：数据来自 `GET /notes/folders`（个人规模、
 *    几百个节点的量级），不需要虚拟化、不需要拖拽，也不会自己改数据。轮子的收益主要在
 *    "大数据量 + 拖拽 + 非受控状态"这三件事上，这里一件都不沾。
 *
 * **ARIA 走的是"扁平 + aria-level"那条合法写法**（WAI-ARIA 允许 treeitem 用
 * `aria-level` 表达层级，不必嵌 `role=group`）：DOM 顺序、键盘顺序、视觉顺序
 * 都来自**同一个数组**，三者不可能漂；换成递归嵌套渲染之后再单独算一遍键盘顺序，
 * 才是真正容易错的地方（错的那天表现为"方向键跳过一层"，很难查）。
 * `aria-expanded` 只出现在真有子节点的行上（没有子节点的行报展开态是噪音）。
 *
 * 键盘（WAI-ARIA tree pattern 的那一套，不自己发明）：
 * Tab 进树只停**一行**（roving tabindex），之后
 * `↑/↓` 上下走、`→` 展开或进第一个子节点、`←` 收起或回父节点、`Home/End` 首尾、
 * `Enter/Space` 选中、`F2` 重命名、`Delete` 删除、`Shift+F10`（或菜单键）开这一行的菜单。
 *
 * **行内那些按钮（展开箭头、行菜单）都不进 Tab 序**（`tabIndex=-1`）：它们服务鼠标，
 * 键盘那条路是上面那组键。做成可 Tab 的话，Tab 进树会先停在**第一行右侧的菜单按钮**上
 * （真机实测踩到）——因为那枚按钮在 DOM 里排在树的 tab stop 前面，
 * "Tab 进树 = 停在当前那一行"就不成立了，得挨个 Tab 过所有行的菜单才走得到树上。
 */
import {
  ChevronDown,
  ChevronRight,
  Folder as FolderIcon,
  FolderInput,
  FolderPlus,
  Inbox,
  MoreHorizontal,
  Pencil,
  Trash2,
} from 'lucide-react'
import { useCallback, useMemo, useRef, useState } from 'react'

import type { NoteFolder } from '@/api/notes'
import { formatCount } from '@/lib/format'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu'

import { buildFolderTree, folderOptions, visibleFolders, type FolderOption } from './folders'
import { UNFILED_FOLDER } from './store'

/** 树上的两种"虚拟行"的键（它们不是真的文件夹，但和文件夹同处一棵树）。 */
const ALL_KEY = 'scope:all'
const UNFILED_KEY = 'scope:unfiled'

/**
 * 每一层缩进多少（px）。
 *
 * 20 = 展开箭头 16px + 行内 gap 4px：子节点的箭头正好落在父节点**名字的起点**上，
 * 层级才读得出来。用内联样式按 `aria-level` 算而不用 CSS 变量，是因为层级是数据
 * （可以任意深），而 CSS 里没有"按 aria-level 缩进"的办法（`attr()` 在 `padding`
 * 上还不可用）。
 */
const INDENT_PX = 20

/** 树上的基础行：文件夹行由 `visibleFolders` 派生（见组件里那个 useMemo）。 */
interface TreeRow {
  key: string
  /** 1 起：全部 / 未归档与根级文件夹同为 1，子文件夹往下加。 */
  level: number
  label: string
  count: number
  /** 虚拟行为 null：菜单、重命名、删除只对真有文件夹的行开放。 */
  folder: NoteFolder | null
  hasChildren: boolean
  expanded: boolean
  /** 父行的 key；根级（含两行虚拟行）为 null——`←` 靠它回父节点。 */
  parentKey: string | null
}

export interface NoteFolderTreeProps {
  folders: readonly NoteFolder[]
  unfiledCount: number
  totalCount: number
  /** 当前选中：`''` 全部 / `UNFILED_FOLDER` 未归档 / 文件夹 id。 */
  active: string
  onSelect: (scope: string) => void
  onCreateChild: (folder: NoteFolder) => void
  onRename: (folder: NoteFolder) => void
  onDelete: (folder: NoteFolder) => void
  onMove: (folder: NoteFolder, parentId: string | null) => void
}

export function NoteFolderTree({
  folders,
  unfiledCount,
  totalCount,
  active,
  onSelect,
  onCreateChild,
  onRename,
  onDelete,
  onMove,
}: NoteFolderTreeProps) {
  // 收的是"被折叠的 id"：默认全展开——新建出来的子文件夹立刻看得见，不必再点一下
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [focusKey, setFocusKey] = useState<string>(() => rowKeyOfScope(active))
  /** 用键盘（Shift+F10 / 菜单键）打开的那一行菜单——受控，见下面 `FolderRowMenu`。 */
  const [menuKey, setMenuKey] = useState<string | null>(null)
  const rowRefs = useRef(new Map<string, HTMLLIElement>())

  const rows = useMemo<TreeRow[]>(() => {
    const list: TreeRow[] = [
      {
        key: ALL_KEY,
        level: 1,
        label: '全部',
        count: totalCount,
        folder: null,
        hasChildren: false,
        expanded: false,
        parentKey: null,
      },
      {
        key: UNFILED_KEY,
        level: 1,
        label: '未归档',
        count: unfiledCount,
        folder: null,
        hasChildren: false,
        expanded: false,
        parentKey: null,
      },
    ]
    for (const item of visibleFolders(buildFolderTree(folders), collapsed)) {
      list.push({
        key: item.folder.id,
        level: item.level,
        label: item.folder.name,
        count: item.folder.note_count,
        folder: item.folder,
        hasChildren: item.hasChildren,
        expanded: item.expanded,
        parentKey: item.folder.parent_id,
      })
    }
    return list
  }, [folders, collapsed, totalCount, unfiledCount])

  // 落点没有对应行时回到第一行（正在选中的文件夹刚被删掉时就是这个情况）：
  // 一棵没有 tab stop 的树等于键盘进不去。
  const rovingKey = rows.some((row) => row.key === focusKey) ? focusKey : rows[0].key

  const focusRow = useCallback(
    (index: number): void => {
      const row = rows[index]
      if (!row) return
      setFocusKey(row.key)
      rowRefs.current.get(row.key)?.focus()
    },
    [rows],
  )

  const setExpanded = useCallback((key: string, expanded: boolean): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (expanded) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  function selectKey(key: string): void {
    if (key === ALL_KEY) onSelect('')
    else if (key === UNFILED_KEY) onSelect(UNFILED_FOLDER)
    else onSelect(key)
  }

  function onRowKeyDown(event: React.KeyboardEvent<HTMLLIElement>, index: number): void {
    const row = rows[index]
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        focusRow(index + 1)
        return
      case 'ArrowUp':
        event.preventDefault()
        focusRow(index - 1)
        return
      case 'ArrowRight':
        // 收起着的展开；已经展开的，下一行就是它的第一个子节点
        if (!row.hasChildren) return
        event.preventDefault()
        if (row.expanded) focusRow(index + 1)
        else setExpanded(row.key, true)
        return
      case 'ArrowLeft': {
        if (row.hasChildren && row.expanded) {
          event.preventDefault()
          setExpanded(row.key, false)
          return
        }
        if (!row.parentKey) return
        event.preventDefault()
        focusRow(rows.findIndex((item) => item.key === row.parentKey))
        return
      }
      case 'Home':
        event.preventDefault()
        focusRow(0)
        return
      case 'End':
        event.preventDefault()
        focusRow(rows.length - 1)
        return
      case 'Enter':
      case ' ':
        event.preventDefault()
        selectKey(row.key)
        return
      case 'F2':
        // 与文件管理器的习惯一致：重命名不用鼠标也能到
        if (row.folder) {
          event.preventDefault()
          onRename(row.folder)
        }
        return
      case 'Delete':
        // 同样照文件管理器：删除会先弹确认框，所以这一下按错也追得回来
        if (row.folder) {
          event.preventDefault()
          onDelete(row.folder)
        }
        return
      case 'F10':
        // 只有 Shift+F10 算"打开这一行的菜单"（裸 F10 在浏览器里是菜单键）
        if (row.folder && event.shiftKey) {
          event.preventDefault()
          setMenuKey(row.key)
        }
        return
      case 'ContextMenu':
        if (row.folder) {
          event.preventDefault()
          setMenuKey(row.key)
        }
        return
      default:
    }
  }

  return (
    <ul className="folder-tree" role="tree" aria-label="笔记文件夹">
      {rows.map((row, index) => (
        <li
          key={row.key}
          ref={(element) => {
            if (element) rowRefs.current.set(row.key, element)
            else rowRefs.current.delete(row.key)
          }}
          className={`folder-row${row.key === rowKeyOfScope(active) ? ' folder-row-on' : ''}`}
          role="treeitem"
          aria-level={row.level}
          aria-selected={row.key === rowKeyOfScope(active)}
          aria-expanded={row.hasChildren ? row.expanded : undefined}
          tabIndex={rovingKey === row.key ? 0 : -1}
          data-folder-key={row.key}
          title={row.label}
          style={{ paddingLeft: (row.level - 1) * INDENT_PX }}
          onClick={() => selectKey(row.key)}
          onFocus={() => setFocusKey(row.key)}
          onKeyDown={(event) => onRowKeyDown(event, index)}
        >
          {row.hasChildren ? (
            /*
              展开箭头是一个**不进 Tab 序**的按钮（tabIndex=-1）：它服务鼠标，
              键盘那条路是 `→/←`（树的标准做法）。做成可 Tab 的话，
              Tab 一进树就先停在箭头上，与"Tab 进树 = 停在当前那一行"打架。
            */
            <button
              type="button"
              tabIndex={-1}
              className="folder-caret"
              aria-label={`${row.expanded ? '收起' : '展开'} ${row.label}`}
              onClick={(event) => {
                event.stopPropagation()
                setExpanded(row.key, !row.expanded)
              }}
            >
              {row.expanded ? (
                <ChevronDown size={12} aria-hidden="true" />
              ) : (
                <ChevronRight size={12} aria-hidden="true" />
              )}
            </button>
          ) : (
            <span className="folder-caret" aria-hidden="true" />
          )}

          <span className="folder-icon" aria-hidden="true">
            {row.key === ALL_KEY ? <Inbox size={14} /> : <FolderIcon size={14} />}
          </span>
          <span className="folder-label">{row.label}</span>
          <span className="folder-count tabular">{formatCount(row.count)}</span>

          {row.folder && (
            <FolderRowMenu
              folder={row.folder}
              folders={folders}
              open={menuKey === row.key}
              onOpenChange={(open) => setMenuKey(open ? row.key : null)}
              onRename={onRename}
              onDelete={onDelete}
              onMove={onMove}
              onCreateChild={onCreateChild}
            />
          )}
        </li>
      ))}
    </ul>
  )
}

/** 一行的行菜单：新建子文件夹 / 重命名 / 移动到 / 删除。 */
function FolderRowMenu({
  folder,
  folders,
  open,
  onOpenChange,
  onRename,
  onDelete,
  onMove,
  onCreateChild,
}: {
  folder: NoteFolder
  folders: readonly NoteFolder[]
  /** 受控开关：Shift+F10（键盘）与点这一行的「…」是两个入口，状态只有一份。 */
  open: boolean
  onOpenChange: (open: boolean) => void
  onRename: (folder: NoteFolder) => void
  onDelete: (folder: NoteFolder) => void
  onMove: (folder: NoteFolder, parentId: string | null) => void
  onCreateChild: (folder: NoteFolder) => void
}) {
  // 移动的候选里排除自己与自己的子孙：那几个位置的结果就是成环，后端也会拒绝
  const options: FolderOption[] = useMemo(
    () => folderOptions(folders, folder.id),
    [folders, folder.id],
  )
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          /*
            不进 Tab 序（`tabIndex=-1`）：它是鼠标入口，键盘那条路是
            Shift+F10 / 菜单键（见组件头那段说明——做成可 Tab 会把 Tab 进树的落点
            顶到第一行的这个按钮上）。`aria-haspopup` 由 Radix 负责。
          */
          tabIndex={-1}
          className="folder-menu"
          aria-label={`${folder.name} 的操作`}
          title={`${folder.name} 的操作`}
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontal size={14} aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      {/*
        菜单挂在 body 上，但 React 的事件仍会冒泡到这一行（portal 不切断 React 树），
        所以这里必须把 click/keydown 拦住：不然在菜单里按方向键，
        树的 roving 焦点会跟着一起走（两套方向键同时生效）。
      */}
      <DropdownMenuContent
        align="start"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <DropdownMenuItem onSelect={() => onCreateChild(folder)}>
          <FolderPlus aria-hidden="true" />
          新建子文件夹
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onRename(folder)}>
          <Pencil aria-hidden="true" />
          重命名
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <FolderInput aria-hidden="true" />
            移动到
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <DropdownMenuItem onSelect={() => onMove(folder, null)}>根目录</DropdownMenuItem>
            {options.map((option) => (
              <DropdownMenuItem key={option.id} onSelect={() => onMove(folder, option.id)}>
                {option.path}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => onDelete(folder)}>
          <Trash2 aria-hidden="true" />
          删除
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** 作用域取值（`''` / `unfiled` / 文件夹 id）→ 行 key。 */
function rowKeyOfScope(scope: string): string {
  if (scope === '') return ALL_KEY
  if (scope === UNFILED_FOLDER) return UNFILED_KEY
  return scope
}
