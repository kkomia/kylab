/**
 * 工作区页（v0.15）——与旧前端 `views/WorkspacesView.vue` 逐条对应。
 *
 * 工作区 = **Agent 的项目**：一个用户指定的根目录 + 一组知识库。左列清单、右侧编辑选中项。
 *
 * 这一页里有两处刻意的措辞，都值得留着：
 * 1. **根目录是"Agent 能碰哪儿"的边界**，不是"备份目录"——文案要让人明白它决定
 *    文件操作的落点；
 * 2. **删工作区不删会话**——删除确认里必须写明这一点，用户最怕的是"删了个壳，对话没了"。
 *
 * 与旧版的差别只有一处：**新建之后直接在里面开一个会话进去**（v0.41）——
 * 建一个工作区的目的就是"在这儿干活"，而空的右栏还不是干活的地方。
 */
import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BadgeInfo, ChevronRight, Folder, Plus, Trash2 } from 'lucide-react'
import { useNavigate, useSearchParams } from 'react-router'

import { createConversation } from '@/api/conversations'
import { deleteWorkspace, listWorkspaces, updateWorkspace, type Workspace } from '@/api/workspaces'

import { notifyError, notifySuccess } from '../shared/toast'
import { useKnowledgeBases } from '../shared/knowledgeBases'
import { formatCount } from '@/lib/format'
import { useSessionStore } from '@/lib/session'
import { Button } from '@/ui/button'
import { Input } from '@/ui/input'
import {
  ConfirmDialog,
  EmptyState,
  ErrorLine,
  Field,
  InfoTip,
  PageShell,
  SkeletonBlock,
} from '../shared/composites'
import { DirectoryPickerDialog } from './DirectoryPickerDialog'
import { WorkspaceCreateDialog } from './WorkspaceCreateDialog'
import { WorkspaceKbPicker } from './WorkspaceKbPicker'
import { WORKSPACES_QUERY_KEY } from './queries'

/**
 * 表单自己的形状：与 ``WorkspacePayload`` 的区别是**所有字段都必填**。
 * 用它而不是直接复用请求体类型：那边 `description` 是可选的（请求可以不带），
 * 而输入框要的是确定的字符串——否则每处绑定都要写一遍 `?? ''`。
 */
interface WorkspaceForm {
  name: string
  root_path: string
  description: string
  kb_ids: string[]
}

const EMPTY_FORM: WorkspaceForm = { name: '', root_path: '', description: '', kb_ids: [] }

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && [...left].sort().join() === [...right].sort().join()
}

export function WorkspacesPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const isAdmin = useSessionStore((store) => store.currentUser?.role === 'admin')

  const [activeId, setActiveId] = useState('')
  const [creating, setCreating] = useState(() => searchParams.get('new') === '1')
  const [picking, setPicking] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [form, setForm] = useState<WorkspaceForm>(EMPTY_FORM)

  const list = useQuery({ queryKey: WORKSPACES_QUERY_KEY, queryFn: listWorkspaces })
  const knowledgeBases = useKnowledgeBases()

  const workspaces = useMemo(() => list.data?.items ?? [], [list.data])
  const active = useMemo(
    () => workspaces.find((item) => item.id === activeId) ?? null,
    [workspaces, activeId],
  )

  const dirty =
    active !== null &&
    (form.name !== active.name ||
      form.root_path !== active.root_path ||
      form.description !== (active.description ?? '') ||
      !sameIds(form.kb_ids, active.kb_ids))

  function select(workspace: Workspace): void {
    setActiveId(workspace.id)
    setCreating(false)
    setForm({
      name: workspace.name,
      root_path: workspace.root_path,
      description: workspace.description ?? '',
      kb_ids: [...workspace.kb_ids],
    })
  }

  /**
   * 进来时选中哪个项目：``?focus=<id>`` > 第一个。
   *
   * ``focus`` 是侧栏「项目」菜单用的：菜单里点某个项目要**落在它身上**，
   * 而不是落在列表第一个——"点谁进谁"是那个菜单存在的意义。找不到那个 id
   * （被删了、或链接过期）时**退回第一个**，不报错。
   */
  useEffect(() => {
    if (workspaces.length === 0) return
    // `?new=1` 进来时**不自动选中**：选中会顺手把新建弹窗关掉（`select` 里那句
    // `setCreating(false)`），用户看到的是"点了新建、弹窗一闪就没了"
    if (searchParams.get('new') === '1') return
    const wanted = searchParams.get('focus') ?? ''
    const target = wanted ? workspaces.find((item) => item.id === wanted) : undefined
    const next = target ?? workspaces[0]
    if (!activeId || !workspaces.some((item) => item.id === activeId)) select(next)
    // 只在列表首次到达时做一次默认选择；之后由用户点击 / ?focus 驱动
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaces])

  // 侧栏菜单再次点另一个项目时，路由只在 query 上变，组件不会重建——这里跟上
  const focus = searchParams.get('focus') ?? ''
  useEffect(() => {
    if (!focus || workspaces.length === 0) return
    const target = workspaces.find((item) => item.id === focus)
    if (target) select(target)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus])

  /** `?new=1` 打开新建弹窗——侧栏的「新建项目」走这条。 */
  useEffect(() => {
    if (searchParams.get('new') === '1') setCreating(true)
  }, [searchParams])

  /**
   * 弹窗关掉（取消 / Esc）而什么都没建时，**替用户落在一个地方**。
   *
   * 典型路径是侧栏点「新建项目」→ 想想又关掉：这时他人在工作区页上、右列却是空的，
   * 看着像"这一页坏了"。落到第一项上，与直接进这一页时看到的一样。
   */
  useEffect(() => {
    if (creating || active || workspaces.length === 0) return
    select(workspaces[0])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creating])

  const save = useMutation({
    mutationFn: () => updateWorkspace(active!.id, form),
    onSuccess: async (updated) => {
      await queryClient.invalidateQueries({ queryKey: WORKSPACES_QUERY_KEY })
      select(updated)
      notifySuccess('已保存')
    },
    // 后端的校验文案是这一层最主要的产出（路径不存在、指向数据目录、是文件系统根），
    // 原样透出来——换成"保存失败"就把唯一有用的信息丢了
    onError: (error: unknown) => notifyError(error instanceof Error ? error.message : '保存失败'),
  })

  const remove = useMutation({
    mutationFn: () => deleteWorkspace(active!.id),
    onSuccess: async () => {
      setConfirmDelete(false)
      await queryClient.invalidateQueries({ queryKey: WORKSPACES_QUERY_KEY })
      notifySuccess('工作区已删除，里面的会话已退回未归档')
      setActiveId('')
      setForm(EMPTY_FORM)
    },
    onError: (error: unknown) => notifyError(error instanceof Error ? error.message : '删除失败'),
  })

  /**
   * 建完：选中它、把 `?new=1` 从地址里摘掉（否则返回时会又弹一次），
   * **然后直接在里面开一个会话进去**。
   *
   * 先摘掉 query 再进对话页：顺序反了的话历史里会留下一条带 `?new=1` 的工作区记录，
   * 从对话页返回就又把弹窗弹出来。
   */
  async function onCreated(workspace: Workspace): Promise<void> {
    select(workspace)
    if (searchParams.get('new') === '1') {
      const next = new URLSearchParams(searchParams)
      next.delete('new')
      setSearchParams(next, { replace: true })
    }
    notifySuccess('工作区已创建')
    await newConversation(workspace)
  }

  async function newConversation(target = active): Promise<void> {
    if (!target) return
    try {
      const record = await createConversation([], null, undefined, target.id)
      await queryClient.invalidateQueries({ queryKey: WORKSPACES_QUERY_KEY })
      await navigate(`/chat/${record.id}`)
    } catch (error) {
      notifyError(error instanceof Error ? error.message : '新建会话失败')
    }
  }

  return (
    <PageShell
      title="工作区"
      actions={
        <>
          <Button onClick={() => setCreating(true)}>
            <Plus size={15} />
            新建工作区
          </Button>
          {active && (
            <Button disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? '保存中…' : '保存'}
            </Button>
          )}
        </>
      }
    >
      {list.isLoading && workspaces.length === 0 && <SkeletonBlock variant="list" rows={4} />}

      {/* 清单为空时**不要**摆那个两栏骨架：左列 300px 里塞一段三行的空态文案会挤成
          一行一个残句，右列再补一句"左边还没有可编辑的工作区"就是同一件事说两遍 */}
      {!list.isLoading && workspaces.length === 0 && (
        <EmptyState
          title="还没有工作区"
          hint="建一个，给它一个项目目录；绑的知识库会作为这个项目里新会话的默认资料范围（不绑也能用：对话里用 @ 点一个库，或用输入框的「知识库」临时勾）。"
        >
          <Button onClick={() => setCreating(true)}>新建工作区</Button>
        </EmptyState>
      )}

      {workspaces.length > 0 && (
        <div className="m-ws-layout">
          <aside aria-label="工作区清单">
            {list.isError && <ErrorLine>{messageOf(list.error)}</ErrorLine>}
            <ul className="m-list">
              {workspaces.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={item.id === activeId ? 'm-ws-row m-ws-row-on' : 'm-ws-row'}
                    onClick={() => select(item)}
                  >
                    <Folder size={15} />
                    <span className="m-ws-row-main">
                      <span className="m-ws-row-name">{item.name}</span>
                      <span className="m-ws-row-path">{item.root_path}</span>
                    </span>
                    <span className="m-ws-row-count tabular">
                      {formatCount(item.conversation_count)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </aside>

          {active ? (
            <section className="m-block" aria-label="工作区设置">
              <h2 className="m-section-title">{active.name}</h2>

              <Field label="名字" htmlFor="ws-name">
                <Input
                  id="ws-name"
                  value={form.name}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, name: event.target.value }))
                  }
                  placeholder="例如：知识库产品化"
                />
              </Field>

              <Field
                label="根目录"
                htmlFor="ws-root"
                tip={
                  <InfoTip text="这是 Agent 文件操作的边界：它能读写的位置被约束在这个目录之内。要给一个**服务器上已存在**的目录——不存在的路径会被拒绝（不会替你建一个空目录），数据目录与文件系统根也会被拒绝。" />
                }
              >
                <div className="m-path-row">
                  <Input
                    id="ws-root"
                    aria-label="根目录"
                    value={form.root_path}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, root_path: event.target.value }))
                    }
                    placeholder={isAdmin ? '点右边的「浏览…」挑一个' : '例如：/volume1/my-project'}
                  />
                  {/* 目录浏览管理员专属（列的是服务器上的目录树），与端点判定一致 */}
                  {isAdmin && <Button onClick={() => setPicking(true)}>浏览…</Button>}
                </div>
              </Field>

              <Field label="描述" optional htmlFor="ws-desc">
                <Input
                  id="ws-desc"
                  value={form.description}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, description: event.target.value }))
                  }
                  placeholder="这个项目是做什么的"
                />
              </Field>

              <WorkspaceKbPicker
                items={knowledgeBases.items}
                value={form.kb_ids}
                onChange={(kb_ids) => setForm((current) => ({ ...current, kb_ids }))}
              />

              <div className="m-form-actions" style={{ marginTop: 'var(--space-2)' }}>
                <Button onClick={() => void newConversation()}>
                  <ChevronRight size={14} />
                  在这个工作区新开会话
                </Button>
                <Button variant="destructive" onClick={() => setConfirmDelete(true)}>
                  <Trash2 size={14} />
                  删除工作区
                </Button>
              </div>
            </section>
          ) : (
            /* 清单非空但没选中：右列给一句话，不摆一张空表单——
               空表单看起来像"这里可以填"，但我们没有"临时填一张"这回事 */
            <section aria-label="工作区设置">
              <p className="text-meta">点左边的一项来编辑，或用上方的「新建工作区」建一个。</p>
            </section>
          )}
        </div>
      )}

      <WorkspaceCreateDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(workspace) => void onCreated(workspace)}
      />

      {/* 编辑表单里的「浏览…」用它；新建弹窗有自己的那一个 */}
      <DirectoryPickerDialog
        open={picking}
        start={form.root_path}
        onClose={() => setPicking(false)}
        onPick={(path) => setForm((current) => ({ ...current, root_path: path }))}
      />

      <ConfirmDialog
        open={confirmDelete}
        title="删除这个工作区？"
        lead={`将删除工作区「${active?.name ?? ''}」。`}
        note="里面的会话**不会被删除**，它们会退回侧栏的「未归档会话」那一栏。工作区里的目录与文件也不会被删——那本来就是你自己的目录。"
        confirmLabel="删除工作区"
        busy={remove.isPending}
        busyLabel="删除中…"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => remove.mutate()}
      />

      {workspaces.length > 0 && (
        <p className="m-foot-note">
          <BadgeInfo size={14} />
          工作区不复制文件：它只是"指向"你指定的目录。所以删工作区不会动你的文件，
          改根目录也只是换一个指向。
        </p>
      )}
    </PageShell>
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '读不到工作区'
}
