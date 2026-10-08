/**
 * 面板里的**文件树**：一层一层往下展开（目录懒加载）。
 *
 * ## 为什么是"每层一个组件、各自取数"
 *
 * `useConversationFiles` 是按 `(会话, 档, 层)` 缓存的一条查询（缓存键形状**不许新造**，
 * 见 `runtime/useChatData.ts` 那段说明）。树要的正是"每一层各自一条"：
 * `<FileLevel dir="out">` 挂上 = 这一层要显示了 = 该取它的数。折叠起来的目录根本不渲染，
 * 于是**一次往返都不发**（旧 `FileDrawer` 是一层一层点，同一个口径）。
 * react-query 会把这些请求按 key 合并与缓存，所以重复挂载不会变成重复往返。
 *
 * ## 往上报账（`onEntries`）
 *
 * 搜索要在"已经展开的那几层"里找（`model/fileTree.ts::flattenLevels`），而每一层的清单
 * 只有它自己知道。所以每层取到数就往上报一次，父层攒成 `byDir`。这条回路是**收敛**的：
 * react-query 的 `data` 身份稳定（数据没变就是同一个数组），父层收到同一个引用就不写状态。
 *
 * ## 空态与错误
 *
 * 文案与抽屉**逐字相同**（`ui/Sheets.tsx` 的 `.drawer-note` 那一族）：同一份文件区
 * 从抽屉打开与从面板打开，说明不该有两套说法。
 */
import { ChevronRight, Folder, FolderOpen } from 'lucide-react'
import { useEffect, useMemo, type CSSProperties } from 'react'

import type { ConversationFile, FileScope } from '@/api/conversations'
import { formatBytes } from '@/lib/format'

import { FileTypeIcon } from '../model/fileIcons'
import { extensionOf, sortEntries, type FileSort } from '../model/fileTree'
import { useConversationFiles } from '../runtime/useChatData'

export interface FileLevelProps {
  conversationId: string
  scope: FileScope
  /** 这一层的路径（`''` = 最上面那层）。 */
  dir: string
  /** 层数（只用来算缩进）。 */
  depth: number
  sort: FileSort
  expanded: ReadonlySet<string>
  /** 正在预览的那一份的 key（`''` = 没在看）。 */
  selectedKey: string
  onToggleDir: (key: string) => void
  onOpenFile: (entry: ConversationFile) => void
  onEntries: (dir: string, entries: ConversationFile[]) => void
}

/** 缩进用 CSS 变量给（像素值算在 `panel.css` 里，调用点只管层数）。 */
function indentOf(depth: number): CSSProperties {
  return { '--ch-panel-depth': depth } as CSSProperties
}

/** 一份文件的图形按"后端给的 kind，没有就按后缀"——两处都不认时才落到文档那一枚。 */
function iconFormatOf(entry: ConversationFile): string {
  return entry.kind || extensionOf(entry.name)
}

export function FileLevel({
  conversationId,
  scope,
  dir,
  depth,
  sort,
  expanded,
  selectedKey,
  onToggleDir,
  onOpenFile,
  onEntries,
}: FileLevelProps) {
  const query = useConversationFiles(conversationId, true, dir, scope)
  const entries = query.data?.entries ?? null
  const rows = useMemo(() => sortEntries(entries ?? [], sort), [entries, sort])

  useEffect(() => {
    if (entries) onEntries(dir, entries)
  }, [dir, entries, onEntries])

  if (query.isLoading) return <p className="ch-panel-text">正在读文件区…</p>

  if (query.error) {
    const message = query.error instanceof Error ? query.error.message : ''
    return (
      <p className="ch-panel-text" data-tone="bad">
        {message || '读不了这个目录'}
      </p>
    )
  }

  if (rows.length === 0) {
    // 最上面那层空 = "这里还没有文件"（把"能怎么放东西进来"一并说清）；
    // 子目录空 = 只说这一格是空的（那一段话在子目录里念一遍没有意义）
    return (
      <p className="ch-panel-text">
        {depth === 0 ? '这里还没有文件。让 Agent 做一份，或者自己上传一个。' : '这个目录是空的'}
      </p>
    )
  }

  return (
    <>
      <ul className="ch-panel-tree">
        {rows.map((entry) => {
          const open = entry.is_dir && expanded.has(entry.key)
          return (
            <li key={entry.key}>
              <button
                type="button"
                className="ch-panel-row"
                style={indentOf(depth)}
                // 正在看的那一份：底色常驻（与当前标签同一档），扫一眼知道"我看的是哪一行"
                aria-current={!entry.is_dir && entry.key === selectedKey ? 'true' : undefined}
                title={entry.name}
                onClick={() => (entry.is_dir ? onToggleDir(entry.key) : onOpenFile(entry))}
              >
                <span className="ch-panel-chevron" data-open={open} data-empty={!entry.is_dir}>
                  <ChevronRight size={13} />
                </span>
                <span className="ch-panel-row-icon">
                  {entry.is_dir ? (
                    open ? (
                      <FolderOpen size={15} />
                    ) : (
                      <Folder size={15} />
                    )
                  ) : (
                    <FileTypeIcon format={iconFormatOf(entry)} size={15} />
                  )}
                </span>
                <span className="ch-panel-row-name">{entry.name}</span>
                {entry.is_dir ? null : (
                  <span className="ch-panel-row-meta">{formatBytes(entry.size_bytes)}</span>
                )}
              </button>
              {open ? (
                <FileLevel
                  conversationId={conversationId}
                  scope={scope}
                  dir={entry.key}
                  depth={depth + 1}
                  sort={sort}
                  expanded={expanded}
                  selectedKey={selectedKey}
                  onToggleDir={onToggleDir}
                  onOpenFile={onOpenFile}
                  onEntries={onEntries}
                />
              ) : null}
            </li>
          )
        })}
      </ul>
      {query.data?.truncated ? (
        // 截断要如实说：不然"这个目录只有 300 个文件"与"我只给你看了 300 个"看起来一样
        <p className="ch-panel-text">这一层文件很多，只显示了前 300 项。</p>
      ) : null}
    </>
  )
}
