/**
 * 项目（工作区）行操作菜单（「⋯」，v0.55）。
 *
 * 用户反馈原话："项目未提供归档 \ 删除 \ 重命名功能"。这三件事原先挂在**已删的
 * 「工作区」页**上（那一页连同它的入口一起没了），于是侧栏的项目行只剩一颗「+」。
 * 这里把菜单补回项目行，动作本身**照抄会话行菜单**（`ConversationRowMenu`）的形态：
 * 同一个「⋯」触发器、同一个 `run(action, fallback, done)` 出口、同一套 Radix 浮层。
 *
 * ## 三条与会话侧对齐的语义（后端已定死，界面照说）
 *
 * 1. **归档不是删除**：可逆（归档视图里能取消），所以**不弹确认**——加确认只会让
 *    常用动作变慢。文案说清去哪儿找回。
 * 2. **删除会二次确认**：它是这一列里唯一不可逆的动作。但它**不删会话**——
 *    后端把里面的会话退回未归档（外键 `ON DELETE SET NULL`），确认框里必须写明这一点，
 *    否则用户会因为怕丢数据而不敢用。
 * 3. **重命名不重排**：改名是整理动作，侧栏不动位置（与会话改名同一口径）。
 */
import { useState } from 'react'
import {
  RiArchiveLine,
  RiDeleteBinLine,
  RiEditLine,
  RiInboxUnarchiveLine,
  RiMoreLine,
} from '@remixicon/react'
import { toast } from 'sonner'

import type { Workspace } from '@/api/workspaces'
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

import { useWorkspaceStore } from './workspaces'

const ICON = 14

export function WorkspaceRowMenu({
  item,
  align = 'end',
  onChanged,
}: {
  item: Workspace
  /** 浮层贴触发器的哪一边。行内的「⋯」都在右端，所以默认贴右缘。 */
  align?: 'start' | 'end'
  /** 改完之后调用方按需刷新（侧栏不必刷，store 已经就地更新了那一行）。 */
  onChanged?: () => void
}) {
  const rename = useWorkspaceStore((state) => state.rename)
  const setArchived = useWorkspaceStore((state) => state.setArchived)
  const remove = useWorkspaceStore((state) => state.remove)

  const [renaming, setRenaming] = useState(false)
  const [renameDraft, setRenameDraft] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  /** 与会话行菜单同一个出口：出错原样透出、成功才通知、最后统一 `onChanged`。 */
  async function run(action: () => Promise<void>, fallback: string, done?: string): Promise<void> {
    try {
      await action()
      if (done) toast.success(done)
      onChanged?.()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : fallback)
    }
  }

  async function submitRename(): Promise<void> {
    const next = renameDraft.trim()
    setRenaming(false)
    // 空名字与"没改"都不发请求：那是两次点击换一次没意义的写入
    if (!next || next === item.name) return
    await run(() => rename(item.id, next), '重命名失败')
  }

  async function toggleArchive(): Promise<void> {
    const next = !item.archived_at
    await run(
      () => setArchived(item.id, next),
      '操作失败',
      next ? '已归档（可在项目清单底部的「已归档」里找回）' : '已取消归档',
    )
  }

  async function confirmDelete(): Promise<void> {
    setConfirmingDelete(false)
    await run(() => remove(item.id), '删除失败', '已删除项目')
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="inline-flex size-6 items-center justify-center rounded-control text-text-tertiary transition-colors hover:bg-[var(--bg-hover)] hover:text-text-primary"
            aria-label={`项目「${item.name}」的操作`}
            title={`项目「${item.name}」的操作`}
          >
            <RiMoreLine size={ICON} aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align={align} className="w-40">
          <DropdownMenuItem
            onSelect={() => {
              setRenameDraft(item.name)
              setRenaming(true)
            }}
          >
            <RiEditLine size={ICON} aria-hidden="true" /> 重命名
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void toggleArchive()}>
            {item.archived_at ? (
              <RiInboxUnarchiveLine size={ICON} aria-hidden="true" />
            ) : (
              <RiArchiveLine size={ICON} aria-hidden="true" />
            )}
            {item.archived_at ? '取消归档' : '归档'}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-status-danger focus:bg-[var(--danger-soft)] focus:text-status-danger [&_svg]:text-status-danger"
            onSelect={() => setConfirmingDelete(true)}
          >
            <RiDeleteBinLine size={ICON} aria-hidden="true" /> 删除
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {renaming && (
        <Dialog open onOpenChange={(next) => !next && setRenaming(false)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>重命名项目</DialogTitle>
              <DialogDescription className="sr-only">给这个项目起一个新名字</DialogDescription>
            </DialogHeader>
            <label className="flex flex-col gap-2">
              <span className="text-[length:var(--text-meta-size)] text-text-secondary">名字</span>
              <Input
                autoFocus
                value={renameDraft}
                aria-label="项目名字"
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

      {confirmingDelete && (
        <AlertDialog open onOpenChange={(next) => !next && setConfirmingDelete(false)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>删除这个项目？</AlertDialogTitle>
              <AlertDialogDescription>
                将删除项目「{item.name}」。
                <br />
                里面的会话不会被删——它们会退回「对话」那一栏，内容与引用都还在。
                只是想把它从侧栏收起来的话，用「归档」——归档随时可以取消。
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
