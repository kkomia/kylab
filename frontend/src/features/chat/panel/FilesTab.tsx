/**
 * 面板上的「文件」标签：这条会话的文件区，做成**能展开的树**。
 *
 * ## 与文件抽屉（`ui/Sheets.tsx` 的 `FilesSheet`）的分工
 *
 * 两者读的是同一份数据（同一个 `useConversationFiles`、同一个缓存键），但回答的是两个问题：
 *
 * | | 抽屉 | 这里 |
 * | --- | --- | --- |
 * | 回答 | "**文件区里有什么**"（翻、传、拖、下载、取进本会话） | "**刚才那一步产出的那份文件长什么样**" |
 * | 入口 | 加号 → 浏览文件 | 产物卡片 / 随发附件点「预览」（见 `ChatProvider.openFiles`） |
 * | 形状 | 一层一层进出（面包屑 + 上一级） | 树（子目录就地展开） |
 *
 * 上传与拖拽**只在抽屉里**（本轮没搬过来）：那是"往文件区放东西"的动作，
 * 而面板是"看"的地方——混在一起会让"点一行"有两个意思。
 *
 * ## 范围只有一档，而且不必用户挑（2026-10-09 合并）
 *
 * 原先这里有两个页签：「本会话」与「项目文件」。用户说它们本来就是一回事
 * （"会话产物就在项目目录里"），所以那两个页签撤了，改成**一棵树**：
 *
 * | 这条会话 | 树根 |
 * | --- | --- |
 * | 挂了项目（详情里有 `workspace_id`） | 项目目录（产物落在它们真实路径上） |
 * | 没挂项目 | 会话产物目录（后端按会话那份文件区给） |
 *
 * 这件事只有一条判据（`workspace_id`），所以它**不是**存下来的状态：存下来就会出现
 * "这条会话没有项目、而面板记着上一档是项目"这种自相矛盾的组合。`scope` 那一份
 * 状态因此整条去掉（`panelStore.filesView` 现在只剩 `path`）。
 *
 * ## 面包屑从**实际路径**开始
 *
 * 原先首段是「本会话」/「Workspaces」那一颗根按钮，用户指出它与范围页签重复——
 * 页签撤了之后这一颗也一起去掉（同一件事不该有两个说法）。所以 `crumbsOf` 现在只给
 * 路径那几段，根那层**什么都不画**（`ch-panel-bar` 那一行只剩搜索与排序）。
 * 项目名不至于因此丢掉：会话条（`ChatHeader`）本来就写着它。
 *
 * ## 三件要照旧的东西
 *
 * 1. **空态 / 错误 / 截断的文案逐字沿用抽屉**（`Sheets.tsx` 的 `.drawer-note` 那一族）：
 *    同一份文件区不该有两套说法；
 * 2. **预览的签名链接由这一层换**（`getFileUrl(…, 'inline')`），且**分派结果是不能预览的
 *    连链接都不换**——旧 `FilePreview.vue` 同一条：那种文件不会画出来，换一条十分钟就过期的
 *    链接纯属白跑一趟；
 * 3. **定位种子"等列表到了再落"**（`Sheets.tsx:425-443`）：先按 key 把相对的那几层展开，
 *    等那份清单真到了再选中它——名字与种类用服务端的（seed 里那份是调用方给的兜底：
 *    产物在临时区的 key 是 `artifact_id`，一串没有后缀的标识符，光看它猜不出用什么渲染器）。
 *    那一位"已经落过哪个种子"记在**模块级**（`landedSeed`）而不是组件里：它记的是
 *    "这个种子已经被执行过了"，而组件会随标签切换重建——记在组件里的话，切走再切回来
 *    又会把用户按过的「回到文件列表」重新顶掉，看起来就是"回不去列表"（2026-10-09 修）。
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Check, ChevronLeft, ChevronRight, Folder, Search, SlidersHorizontal } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { getFileUrl, type ConversationFile, type FileScope } from '@/api/conversations'
import { ensureWorkspacesLoaded } from '@/features/layout/workspaces'
import { FilePreview, resolveRenderer } from '@/features/preview'

import { FileTypeIcon } from '../model/fileIcons'
import {
  crumbsOf,
  dirsToReveal,
  extensionOf,
  flattenLevels,
  isUnder,
  parentOf,
  searchTree,
  type FileSort,
} from '../model/fileTree'
import { useConversationDetail } from '../runtime/useChatData'
import { MENU_CHECK, MENU_ITEM, MENU_PANEL } from '../ui/DropdownShell'
import { FileLevel } from './FileTree'
import { usePanelStore, type PanelSeed } from './panelStore'

/** 排序档（与 `model/fileTree.ts` 的 `FileSort` 一一对应）。 */
const SORTS: { value: FileSort; label: string }[] = [
  { value: 'name', label: '名称' },
  { value: 'modified', label: '修改时间' },
  { value: 'type', label: '类型' },
]

/** 正在预览的那一份（`FilePreview` 要的三个字段）。 */
type PickedFile = { key: string; name: string; kind: string }

/**
 * **已经落过的那个种子**（`PanelSeed.seq`）。
 *
 * 模块级而不是 `useRef`：见文件头注第 3 条——组件会随标签切换重建，而"这个种子执行过了"
 * 是一句关于**种子**的话，不该跟着组件一起忘掉。
 */
let landedSeed = 0

export function FilesTab() {
  const conversationId = usePanelStore((state) => state.currentConversationId)
  const view = usePanelStore((state) => state.filesView)
  const setFilesView = usePanelStore((state) => state.setFilesView)
  const seed = usePanelStore((state) => state.seed)

  /**
   * 项目名与"这一档是项目目录还是会话产物目录"。
   *
   * `workspace_id` 从**已经取过的会话详情**里读（与 `ChatHeader`、`FilesSheet` 同一个
   * queryKey，命中缓存）；项目名从壳那份工作区清单里查——与 `ChatHeader.tsx` 同一处写法。
   * 挂项目的判据在这里就地变成 `scope`（见文件头那张表）。
   */
  const detail = useConversationDetail(conversationId)
  const workspaceId = detail.data?.workspace_id ?? null
  const scope: FileScope = workspaceId ? 'project' : 'conversation'
  useEffect(() => {
    // 只在真的挂在某个项目下时才去要清单（那一份通常是壳的首屏数据，这里补一次）
    if (workspaceId) void ensureWorkspacesLoaded()
  }, [workspaceId])

  const [sort, setSort] = useState<FileSort>('name')
  const [term, setTerm] = useState('')
  const [selected, setSelected] = useState<PickedFile | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  /** 已经拿到清单的那几层（搜索用；`FileLevel` 取到数就往这里报一次）。 */
  const [byDir, setByDir] = useState<Record<string, ConversationFile[]>>({})
  /** 正在等它那一层清单的那个种子（见文件头注第 3 条）。 */
  const [pending, setPending] = useState<PanelSeed | null>(null)

  const report = useCallback((dir: string, entries: ConversationFile[]): void => {
    setByDir((prev) => (prev[dir] === entries ? prev : { ...prev, [dir]: entries }))
  }, [])

  const toggleDir = useCallback((key: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  /** 打开一份文件：主区换成它的预览。 */
  const openFile = useCallback((file: PickedFile): void => {
    setSelected({ key: file.key, name: file.name, kind: file.kind })
  }, [])

  /**
   * 定位种子（第一拍）：把**相对的那几层**展开。种子不在当前这一层下面时先回到最上面那层
   * ——面板里没有"找不到就什么都不做"这一档（用户刚点的那一下「预览」必须看得见）。
   *
   * 只在**这个种子还没落过**时跑（`landedSeed` 是模块级的，见文件头注第 3 条）。
   */
  useEffect(() => {
    if (!seed || seed.seq === landedSeed) return
    landedSeed = seed.seq
    const here = isUnder(view.path, seed.key)
    const base = here ? view.path : ''
    if (!here) setFilesView({ path: '' })
    setTerm('')
    setPending(seed)
    setExpanded((prev) => new Set([...prev, ...dirsToReveal(base, seed.key)]))
  }, [seed, view.path, setFilesView])

  /** 定位种子（第二拍）：那一层的清单到了才落（名字与种类取服务端那份，见文件头注）。 */
  useEffect(() => {
    if (!pending) return
    const listing = byDir[parentOf(pending.key)]
    if (!listing) return
    const found = listing.find((item) => item.key === pending.key)
    setSelected(
      found
        ? { key: found.key, name: found.name, kind: found.kind }
        : { key: pending.key, name: pending.name, kind: pending.kind },
    )
    setPending(null)
  }, [pending, byDir])

  const root = view.path
  const flat = useMemo(() => flattenLevels(root, byDir, expanded), [root, byDir, expanded])
  const hits = useMemo(() => searchTree(flat, term), [flat, term])
  const searching = Boolean(term.trim())
  // 预览态会**提前返回**（下面那个 `if`），所以这一位要在那之前算出来
  const selectedKey = selected?.key ?? ''

  /** 面包屑：**从实际路径那一层开始**（根那一段不画，见文件头注）。 */
  const crumbs = useMemo(() => crumbsOf(root), [root])

  /* ---------------------------------------------------------------- 预览态 */

  if (selected) {
    return (
      <>
        {/* 与抽屉同一条：预览态的抬头行只剩"回去 + 文件名"（浏览态那两行不占地方） */}
        <div className="ch-panel-bar">
          <div className="ch-panel-preview-head">
            <button
              type="button"
              className="ch-panel-back"
              aria-label="回到文件列表"
              title="回到文件列表"
              onClick={() => setSelected(null)}
            >
              <ChevronLeft size={15} />
            </button>
            <span className="ch-panel-preview-name" title={selected.name}>
              {selected.name}
            </span>
          </div>
        </div>
        <div className="ch-panel-scroll">
          {/* `.ch-panel-preview` 是**宽度稳定且自己不滚**的那个盒子（理由见 panel.css） */}
          <div className="ch-panel-preview">
            <PreviewPane conversationId={conversationId} file={selected} />
          </div>
        </div>
      </>
    )
  }

  /* ---------------------------------------------------------------- 浏览态 */

  return (
    <>
      <div className="ch-panel-bar">
        {/*
          面包屑：**只有进了子目录才有那一段**（根那层不画，见文件头注）。
          根那层因此只剩搜索与排序两样——空的一行 `<nav>` 不画（它会白占那一行的 gap）。
        */}
        {crumbs.length > 0 ? (
          <nav className="ch-panel-crumbs" aria-label="路径">
            {crumbs.map((crumb, index) => (
              <span key={`${crumb.path}-${index}`} className="ch-panel-crumb-seg">
                {index > 0 ? (
                  <ChevronRight size={12} aria-hidden className="ch-panel-crumbs-sep" />
                ) : null}
                <button
                  type="button"
                  className="ch-panel-crumb"
                  aria-current={index === crumbs.length - 1 ? 'page' : undefined}
                  disabled={index === crumbs.length - 1}
                  onClick={() => {
                    setFilesView({ path: crumb.path })
                    setTerm('')
                  }}
                >
                  {crumb.label}
                </button>
              </span>
            ))}
          </nav>
        ) : null}
        <div className="ch-panel-tools">
          <label className="ch-panel-search">
            <Search size={14} aria-hidden />
            <input
              type="search"
              value={term}
              aria-label="搜索文件"
              placeholder="搜索文件"
              onChange={(event) => setTerm(event.target.value)}
            />
          </label>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                className="ch-panel-tool"
                aria-label={`排序：${SORTS.find((item) => item.value === sort)?.label ?? ''}`}
                title="这一层的排列顺序"
              >
                <SlidersHorizontal size={15} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content side="bottom" align="end" sideOffset={6} className={MENU_PANEL}>
                {/* 排序的口径写在这儿：它**不改树的结构**，只排同一层里的次序 */}
                <DropdownMenu.Label className="ch-panel-menu-line">
                  只在同一层内排序，目录始终在最前
                </DropdownMenu.Label>
                <DropdownMenu.RadioGroup
                  value={sort}
                  onValueChange={(value) => setSort(value as FileSort)}
                >
                  {SORTS.map((item) => (
                    <DropdownMenu.RadioItem
                      key={item.value}
                      value={item.value}
                      className={MENU_ITEM}
                      data-sort={item.value}
                    >
                      {/* 勾的格子**永远占着**（与权限菜单同一手法）：三行的档名左边缘才对得齐 */}
                      <span className={MENU_CHECK}>
                        {item.value === sort ? <Check size={14} /> : null}
                      </span>
                      <span>{item.label}</span>
                    </DropdownMenu.RadioItem>
                  ))}
                </DropdownMenu.RadioGroup>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </div>

      <div className="ch-panel-scroll">
        {searching ? (
          <>
            {/* 如实说：搜索的地盘就是**已经展开的那几层**，没展开的目录里有什么它不知道 */}
            <p className="ch-panel-text">只搜已展开的目录</p>
            {hits.length === 0 ? (
              <p className="ch-panel-text">没有匹配的文件</p>
            ) : (
              <ul className="ch-panel-tree">
                {hits.map((hit) => (
                  <li key={`${hit.dir}/${hit.entry.key}`}>
                    <button
                      type="button"
                      className="ch-panel-row"
                      title={hit.entry.name}
                      onClick={() => {
                        if (hit.entry.is_dir) {
                          toggleDir(hit.entry.key)
                          // 点了目录就回树里看（搜索结果里展开一层看不出它在哪儿）
                          setTerm('')
                          return
                        }
                        openFile(hit.entry)
                      }}
                    >
                      <span className="ch-panel-row-icon">
                        {hit.entry.is_dir ? (
                          <Folder size={15} />
                        ) : (
                          <FileTypeIcon
                            format={hit.entry.kind || extensionOf(hit.entry.name)}
                            size={15}
                          />
                        )}
                      </span>
                      <span className="ch-panel-row-name">{hit.entry.name}</span>
                      {/* 命中的地方要说清：同名文件可能有好几份，在哪一层才是它 */}
                      {hit.dir ? <span className="ch-panel-row-meta">{hit.dir}</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <FileLevel
            conversationId={conversationId}
            scope={scope}
            dir={root}
            depth={0}
            sort={sort}
            expanded={expanded}
            selectedKey={selectedKey}
            onToggleDir={toggleDir}
            onOpenFile={openFile}
            onEntries={report}
          />
        )}
      </div>
    </>
  )
}

/**
 * 预览一份文件（纪律见文件头注第 2 条：**分派结果是不能预览的连链接都不换**）。
 *
 * 失败说明由 `@/features/preview` 的 `notes.tsx` 统一出——同一份文件从面板看与从抽屉看，
 * 说明必须一字不差，所以这一层只把原因递过去，不自己写句子。
 */
function PreviewPane({ conversationId, file }: { conversationId: string; file: PickedFile }) {
  const renderer = resolveRenderer({ name: file.name, kind: file.kind })
  const [issued, setIssued] = useState<{ loading: boolean; url: string; reason: string }>({
    loading: renderer !== 'none',
    url: '',
    reason: '',
  })

  useEffect(() => {
    if (renderer === 'none') {
      // 不假装能预览：连链接都不换（旧 `FilePreview.vue` 同一条）
      setIssued({ loading: false, url: '', reason: '' })
      return
    }
    let alive = true
    setIssued({ loading: true, url: '', reason: '' })
    void (async () => {
      try {
        const { url } = await getFileUrl(conversationId, file.key, 'inline')
        if (alive) setIssued({ loading: false, url, reason: '' })
      } catch (cause) {
        if (alive) {
          setIssued({
            loading: false,
            url: '',
            reason: cause instanceof Error ? cause.message : '拿不到预览链接',
          })
        }
      }
    })()
    return () => {
      alive = false
    }
  }, [conversationId, file.key, renderer])

  if (issued.loading) return <p className="ch-panel-text">正在取预览链接…</p>
  return <FilePreview name={file.name} kind={file.kind} url={issued.url} reason={issued.reason} />
}
