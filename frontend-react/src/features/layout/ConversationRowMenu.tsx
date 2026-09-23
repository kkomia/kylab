/**
 * 会话行操作菜单（「⋯」，v0.25）——与旧前端 `components/layout/ConversationRowMenu.vue`
 * 逐条对应。
 *
 * ## 为什么是一个共用组件
 *
 * 「整理这条会话」这件事**在同一份数据上有两个入口**：侧栏的会话行、历史会话面板的条目。
 * 抽成一个组件之后两边共用**同一份动作、同一套文案、同一套确认**（重命名与删除的弹窗
 * 也在这里），不会出现"面板里删要确认、侧栏里删不确认"这种分叉。
 *
 * ## 动作取自后端的既有字段，不新造概念
 *
 * | 菜单项 | 后端字段 |
 * | --- | --- |
 * | 置顶 / 取消置顶 | `pinned` |
 * | 重命名 | `title` |
 * | 移至项目 | `workspace_id` |
 * | 归档 / 取消归档 | `archived_at` |
 * | 删除 | —— |
 *
 * 旧版参考 kimi 的会话菜单时**没搬**「在新窗口打开」「在文件资源管理器中打开」：
 * 那是桌面客户端的动作，我们没有对应的东西。这一条照旧。
 *
 * ## 两条不能省的谨慎
 *
 * 1. **删除要确认**。它是这一列里唯一不可逆的动作，而菜单是**整行 hover 才出现**的，
 *    误点的代价很高。确认框里写明"消息也会一起删掉"并带出标题；
 * 2. **归档不确认**。它可逆（面板里能取消归档），加确认只会让常用动作变慢；
 *    文案上刻意区分：归档写「归档」不写「删除」，并说清去哪儿找回。
 *
 * ## 与旧实现的三处实现差异（行为不变）
 *
 * - 浮层用 `@/ui/dropdown-menu`（Radix）：Esc 收起、点外部收起、放不下自动翻向；
 * - 三个弹窗按需渲染（`{renaming && …}`），与旧版 `v-if` 同一条：
 *   一屏二十条会话不必挂六十个节点；
 * - 「移至项目」的候选来自工作区清单，且**不假设调用方加载过**（`ensureWorkspacesLoaded`）
 *   ——不加载的话那一项会静默消失，而"菜单里少一项"是没人会去查的那种 bug。
 */
import { useEffect, useState } from 'react'
import {
  Archive,
  ArchiveRestore,
  Ellipsis,
  Folder,
  FolderInput,
  Pencil,
  Pin,
  PinOff,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'

import type { ConversationSummary } from '@/api/conversations'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/ui/alert-dialog'
import { Button } from '@/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu'
import { Input } from '@/ui/input'

import { useConversationStore } from './conversations'
import { ensureWorkspacesLoaded, useWorkspaceStore } from './workspaces'

const ICON = 14

/** 「移至项目」列表里一行：与 `@/ui/dropdown-menu` 的项同高，当前那个用选中底。 */
const MOVE_ROW =
  'flex min-h-9 w-full items-center gap-2 rounded-control px-2 text-left ' +
  'text-[length:var(--text-meta-size)] text-text-primary transition-colors hover:bg-[var(--bg-hover)]'
const MOVE_ROW_CURRENT =
  'flex min-h-9 w-full items-center gap-2 rounded-control bg-[var(--bg-selected)] px-2 text-left ' +
  'text-[length:var(--text-meta-size)] text-text-primary'

export function ConversationRowMenu({
  item,
  align = 'end',
  onChanged,
}: {
  item: ConversationSummary
  /** 浮层贴触发器的哪一边。行内的「⋯」都在右端，所以默认贴右缘。 */
  align?: 'start' | 'end'
  /** 改完之后调用方按需刷新（侧栏不必刷，store 已经就地更新了那一行）。 */
  onChanged?: () => void
}) {
  const rename = useConversationStore((state) => state.rename)
  const setPinned = useConversationStore((state) => state.setPinned)
  const setArchived = useConversationStore((state) => state.setArchived)
  const setWorkspace = useConversationStore((state) => state.setWorkspace)
  const remove = useConversationStore((state) => state.remove)
  const refreshWorkspaceCounts = useWorkspaceStore((state) => state.refreshCounts)
  const workspaces = useWorkspaceStore((state) => state.items)
  const workspacesLoaded = useWorkspaceStore((state) => state.loaded)

  const name = item.title || '未命名对话'

  const [renaming, setRenaming] = useState(false)
  const [renameDraft, setRenameDraft] = useState('')
  const [moving, setMoving] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  // 「移至项目」要有候选才显示；菜单一挂出来就去把清单要回来（拿不到也不影响其它项）
  useEffect(() => {
    void ensureWorkspacesLoaded()
  }, [])

  /**
   * 每条动作都走同一个出口：出错原样透出、成功才通知、最后统一 `onChanged`。
   * 与旧版的 `run(action, fallback, done)` 同一条。
   */
  async function run(action: () => Promise<void>, fallback: string, done?: string): Promise<void> {
    try {
      await action()
      if (done) toast.success(done)
      onChanged?.()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : fallback)
    }
  }

  function openRename(): void {
    setRenameDraft(item.title || '')
    setRenaming(true)
  }

  async function submitRename(): Promise<void> {
    const next = renameDraft.trim()
    setRenaming(false)
    // 空标题与"没改"都不发请求：那是两次点击换一次没意义的写入
    if (!next || next === item.title) return
    await run(() => rename(item.id, next), '重命名失败')
  }

  async function moveTo(workspaceId: string | null): Promise<void> {
    setMoving(false)
    if ((item.workspace_id ?? null) === workspaceId) return
    const label = workspaceId
      ? (workspaces.find((workspace) => workspace.id === workspaceId)?.name ?? '项目')
      : null
    await run(
      async () => {
        await setWorkspace(item.id, workspaceId)
        // 侧栏项目行上的条数是另一个 store 里的数，不同步刷新它就会停在旧值上
        // （旧版实测移进去之后项目还写着 0 条）
        await refreshWorkspaceCounts()
      },
      '移动失败',
      label ? `已移到「${label}」` : '已移出项目',
    )
  }

  async function togglePin(): Promise<void> {
    await run(
      () => setPinned(item.id, !item.pinned),
      '操作失败',
      item.pinned ? '已取消置顶' : '已置顶',
    )
  }

  async function toggleArchive(): Promise<void> {
    const next = !item.archived_at
    await run(
      () => setArchived(item.id, next),
      '操作失败',
      next ? '已归档（可在「查看全部会话」里找回）' : '已取消归档',
    )
  }

  async function confirmDelete(): Promise<void> {
    setConfirmingDelete(false)
    await run(() => remove(item.id), '删除失败', '已删除')
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="inline-flex size-6 items-center justify-center rounded-control text-text-tertiary transition-colors hover:bg-[var(--bg-hover)] hover:text-text-primary"
            aria-label={`${name} 的操作`}
            title={`${name} 的操作`}
          >
            <Ellipsis size={ICON} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align={align} className="w-40">
          <DropdownMenuItem onSelect={() => void togglePin()}>
            {item.pinned ? <PinOff size={ICON} /> : <Pin size={ICON} />}
            {item.pinned ? '取消置顶' : '置顶'}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={openRename}>
            <Pencil size={ICON} /> 重命名
          </DropdownMenuItem>
          {/* 「移至项目」在**已经在某个项目里**时也留着（那时它能改投别处），
              只有"一个项目都没有"才藏起来——点开一个空列表比没有这一项更让人困惑 */}
          {workspacesLoaded && workspaces.length > 0 && (
            <DropdownMenuItem onSelect={() => setMoving(true)}>
              <FolderInput size={ICON} /> 移至项目
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => void toggleArchive()}>
            {item.archived_at ? <ArchiveRestore size={ICON} /> : <Archive size={ICON} />}
            {item.archived_at ? '取消归档' : '归档'}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-status-danger focus:bg-[var(--danger-soft)] focus:text-status-danger [&_svg]:text-status-danger"
            onSelect={() => setConfirmingDelete(true)}
          >
            <Trash2 size={ICON} /> 删除
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {renaming && (
        <Dialog open onOpenChange={(next) => !next && setRenaming(false)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>重命名会话</DialogTitle>
              <DialogDescription className="sr-only">给这条会话起一个新标题</DialogDescription>
            </DialogHeader>
            <label className="flex flex-col gap-2">
              <span className="text-[length:var(--text-meta-size)] text-text-secondary">标题</span>
              <Input
                autoFocus
                value={renameDraft}
                aria-label="会话标题"
                onChange={(event) => setRenameDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void submitRename()
                }}
              />
            </label>
            <DialogFooter>
              <Button onClick={() => setRenaming(false)}>取消</Button>
              <Button onClick={() => void submitRename()}>保存</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* 移至项目：一个列表就够，**不做二级菜单**。kimi 用的是悬浮展开的二级菜单，
          但那需要浮层里再套一层浮层（定位、Esc 先后、点外部关闭三件事都要各写一遍），
          而这里的候选通常只有几个。用弹窗的代价是多一次点击，换来的是
          **"当前在哪个项目"能摆出来**——二级菜单里只能用勾选表示，反而更弱。 */}
      {moving && (
        <Dialog open onOpenChange={(next) => !next && setMoving(false)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>移至项目</DialogTitle>
              <DialogDescription className="sr-only">选择这条会话归属的项目</DialogDescription>
            </DialogHeader>
            <ul className="max-h-[50vh] overflow-y-auto">
              {workspaces.map((workspace) => (
                <li key={workspace.id}>
                  <button
                    type="button"
                    className={workspace.id === item.workspace_id ? MOVE_ROW_CURRENT : MOVE_ROW}
                    onClick={() => void moveTo(workspace.id)}
                  >
                    <Folder size={15} />
                    <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                    {workspace.id === item.workspace_id && (
                      <span className="text-[length:var(--text-micro-size)] text-text-tertiary">
                        当前
                      </span>
                    )}
                  </button>
                </li>
              ))}
              {item.workspace_id && (
                <li>
                  <button type="button" className={MOVE_ROW} onClick={() => void moveTo(null)}>
                    <Folder size={15} />
                    <span className="min-w-0 flex-1 truncate">移出项目</span>
                  </button>
                </li>
              )}
            </ul>
          </DialogContent>
        </Dialog>
      )}

      {confirmingDelete && (
        <AlertDialog open onOpenChange={(next) => !next && setConfirmingDelete(false)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>删除这条会话？</AlertDialogTitle>
              <AlertDialogDescription>
                将删除「{name}」及其全部消息。
                <br />
                删除后不可恢复。只是想把它从列表里收起来的话，用「归档」——归档随时可以取消。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={() => void confirmDelete()}>
                删除
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  )
}
