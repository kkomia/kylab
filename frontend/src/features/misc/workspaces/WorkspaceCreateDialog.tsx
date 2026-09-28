/**
 * 新建项目弹窗——恢复自提交 291fae6 删除前的那一份
 * `frontend/src/features/misc/workspaces/WorkspaceCreateDialog.tsx`（与旧前端
 * `components/workspaces/WorkspaceCreateDialog.vue` 对应）。
 *
 * ## 为什么是"从历史里取回来"而不是重写
 *
 * 用户原话："新增项目 没有按钮可以新增了 ，应该放在 项目菜单那个菜单得右边"。
 * 那个入口原先在 `/workspaces?new=1`（「工作区」页上），随整页一起被删；这一版只把
 * **这一条链路**取回来，落到侧栏「项目」标题右边那颗按钮上（见 `layout/SideNav.tsx`）。
 * 表单形态仍是"弹窗"而不是一页：新建要的是专注，但不值得为它占掉一次导航。
 *
 * ## 与原型的三处偏离（原因都写在这里，免得下次又被当成手滑）
 *
 * 1. **不再走 react-query**。原型是 `useMutation` + `invalidateQueries(WORKSPACES_QUERY_KEY)`，
 *    失效的是 react-query 手里那份工作区清单；而那份缓存（同目录的 `queries.ts`）已经随
 *    「工作区」页一起删了——现在侧栏那份清单住在 zustand 的 `useWorkspaceStore`
 *    （`features/layout/workspaces.ts`）。两套来源并存必然漂一处，而"漂了"的表现正是
 *    **"建完了侧栏没变"**（原型自己的注释里点过这个 bug）。所以这里只负责"调接口 + 把
 *    建好的那条抛出去"，刷新交给调用方（侧栏 `load()`）。
 * 2. **界面里叫「项目」而不是「工作区」**。用户要的是「新增项目」，侧栏那一节、
 *    行菜单的「移至项目」、对话页标题栏也都叫项目；同一个东西在界面上有两个名字，
 *    用户得自己把它们对上。接口与类型仍叫 workspace——那是后端与
 *    `@/api/workspaces` 的名字，不该在这一层改。
 * 3. **根目录那一格不再挂 InfoTip**。原型那段话（"这是 Agent 文件操作的边界……"）
 *    整段在解释这个目录是怎么被约束的、什么会被拒，落在《前端设计规范》§5.1 与
 *    `check_layering.py` U3（解释性长句）里；字段该填什么由标签与占位示例说着，
 *    真填错了后端那句话会原样弹出来（见下面的 `onError`）。
 *
 * ## 为什么这里**不问**绑不绑知识库（v0.41 去掉的，本次照旧）
 *
 * 绑哪些库是项目**建成之后**的事：它回答的是"这个项目去哪儿找资料"，
 * 而刚建的那一刻用户手上往往还没有这个判断。现在它只在项目自己的设置里。
 */
import { useEffect, useState } from 'react'

import { createWorkspace, type Workspace } from '@/api/workspaces'
import { useSessionStore } from '@/lib/session'

import { notifyError } from '../shared/toast'
import { Button } from '@/ui/button'
import { Input } from '@/ui/input'
import { Field, Modal } from '../shared/composites'
import { DirectoryPickerDialog } from './DirectoryPickerDialog'

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

  const [name, setName] = useState('')
  const [rootPath, setRootPath] = useState('')
  const [description, setDescription] = useState('')
  const [picking, setPicking] = useState(false)
  const [creating, setCreating] = useState(false)

  /** 每次打开都从空白开始：上一次的残值会让人以为"它记住了"，其实只是没清。 */
  useEffect(() => {
    if (!open) return
    setName('')
    setRootPath('')
    setDescription('')
  }, [open])

  const ready = name.trim() !== '' && rootPath.trim() !== ''

  async function submit(): Promise<void> {
    if (!ready || creating) return
    setCreating(true)
    try {
      const created = await createWorkspace({
        name: name.trim(),
        root_path: rootPath.trim(),
        description: description.trim(),
      })
      onClose()
      onCreated(created)
    } catch (error) {
      // 后端的校验文案是这一层最主要的产出（路径不存在、指向数据目录、是文件系统根），
      // 原样透出来——换成"创建失败"就把唯一有用的信息丢了
      notifyError(error instanceof Error ? error.message : '创建失败')
    } finally {
      setCreating(false)
    }
  }

  return (
    <Modal
      open={open}
      title="新建项目"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button disabled={!ready || creating} onClick={() => void submit()}>
            {creating ? '创建中…' : '创建项目'}
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

        <Field label="根目录" htmlFor="ws-create-root">
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
