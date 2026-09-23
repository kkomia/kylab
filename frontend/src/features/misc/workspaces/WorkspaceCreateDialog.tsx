/**
 * 新建工作区弹窗（v0.25）——与旧前端 `components/workspaces/WorkspaceCreateDialog.vue` 对应。
 *
 * ## 为什么从整页改成弹窗
 *
 * 改前：点「新建工作区」是给当前页加一个 `?new=1`，右列那套表单切成"新建态"。
 * 三个问题：**要离开你在的地方**、表头那颗「保存」同时管着两件事、空表单常驻右侧。
 * 表单形态取"弹窗"而不是"独立页"：同样专注，但不占一次导航。
 *
 * ## 为什么这里**不问**绑不绑知识库（v0.41 去掉的）
 *
 * 绑哪些库是工作区**建成之后**的事：它回答的是"这个项目去哪儿找资料"，
 * 而刚建的那一刻用户手上往往还没有这个判断。现在它只在工作区自己的设置里。
 *
 * ## 为什么弹窗自己调接口
 *
 * 它是一次完整的"填 → 校验 → 建"的动作。让调用方先接住表单再转手提交，
 * 会让"提交中"这个状态散到两处。建完只往外抛一个 `created`，调用方负责选中它。
 */
import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { createWorkspace, type Workspace } from '@/api/workspaces'
import { useSessionStore } from '@/lib/session'

import { notifyError } from '../shared/toast'
import { Button } from '@/ui/button'
import { Input } from '@/ui/input'
import { Field, InfoTip, Modal } from '../shared/composites'
import { DirectoryPickerDialog } from './DirectoryPickerDialog'
import { WORKSPACES_QUERY_KEY } from './queries'

export function WorkspaceCreateDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: (workspace: Workspace) => void
}) {
  const isAdmin = useSessionStore((store) => store.currentUser?.role === 'admin')
  const queryClient = useQueryClient()

  const [name, setName] = useState('')
  const [rootPath, setRootPath] = useState('')
  const [description, setDescription] = useState('')
  const [picking, setPicking] = useState(false)

  /** 每次打开都从空白开始：上一次的残值会让人以为"它记住了"，其实只是没清。 */
  useEffect(() => {
    if (!open) return
    setName('')
    setRootPath('')
    setDescription('')
  }, [open])

  const create = useMutation({
    mutationFn: () =>
      createWorkspace({
        name: name.trim(),
        root_path: rootPath.trim(),
        description: description.trim(),
      }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: WORKSPACES_QUERY_KEY })
      onClose()
      onCreated(created)
    },
    // 后端的校验文案是这一层最主要的产出（路径不存在、指向数据目录、是文件系统根），
    // 原样透出来——换成"创建失败"就把唯一有用的信息丢了
    onError: (error: unknown) => notifyError(error instanceof Error ? error.message : '创建失败'),
  })

  const ready = name.trim() !== '' && rootPath.trim() !== ''

  return (
    <Modal
      open={open}
      title="新建工作区"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button disabled={!ready || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? '创建中…' : '创建工作区'}
          </Button>
        </>
      }
    >
      <div className="m-form">
        <Field label="名字" htmlFor="ws-create-name">
          <Input
            id="ws-create-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：知识库产品化"
          />
        </Field>

        <Field
          label="根目录"
          htmlFor="ws-create-root"
          tip={
            <InfoTip text="这是 Agent 文件操作的边界：它能读写的位置被约束在这个目录之内。要给一个**服务器上已存在**的目录——不存在的路径会被拒绝（不会替你建一个空目录），数据目录与文件系统根也会被拒绝。" />
          }
        >
          <div className="m-path-row">
            <Input
              id="ws-create-root"
              aria-label="根目录"
              value={rootPath}
              onChange={(event) => setRootPath(event.target.value)}
              placeholder={isAdmin ? '点右边的「浏览…」挑一个' : '例如：/volume1/my-project'}
            />
            {isAdmin && <Button onClick={() => setPicking(true)}>浏览…</Button>}
          </div>
        </Field>

        <Field label="描述" optional htmlFor="ws-create-desc">
          <Input
            id="ws-create-desc"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="这个项目是做什么的"
          />
        </Field>
      </div>

      <DirectoryPickerDialog
        open={picking}
        start={rootPath}
        onClose={() => setPicking(false)}
        onPick={setRootPath}
      />
    </Modal>
  )
}
