/**
 * 目录选择器（v0.35）——与旧前端 `components/workspaces/DirectoryPickerDialog.vue` 对应。
 *
 * ## 为什么不是客户端的目录选择器
 *
 * 工作区根目录是**服务器上**的路径（后端跑在 NAS 上），而浏览器能拿到的只有客户端
 * 本机的东西：`<input type="file" webkitdirectory>` 给的是相对路径、
 * `showDirectoryPicker` 给的是一个句柄——两者指向的都是**另一台机器**。
 * 所以"选择"只能是"服务端列给你看"，走 `GET /workspaces/browse`（管理员专属）。
 *
 * ## 先看到"哪儿能建"，再动手（v0.41）
 *
 * 旧版给人的体感是"显示了又不给建"：目录列了满屏，点开"新建文件夹"才报错。
 * 现在**能不能建 / 能不能改名直接标在行上**（`creatable` / `renamable` + 原因，
 * 判定与真去动手时同一份），能建的地方集中在一处——服务端给的**专用区域**（`area`）。
 *
 * ## 四条交互约定
 *
 * 1. **点一行 = 进去**，不是"选中"：目录树里"进下一层"才是最常用的动作，
 *    而"就选它"由底部那颗按钮负责（与系统的文件夹选择器一致）；
 * 2. **不可选的目录照样能进去看**：灰的是底部那颗"选这个目录"，不是那一行；
 * 3. **路径一律由服务端给**（`path` 字段），前端不自己拼字符串：
 *    Windows 的反斜杠、Linux 的根、网络路径的写法各不一样，拼错一次就是"找不到"；
 * 4. **新建 / 改名都是内联一行输入**，且**建完直接进去**。
 */
import { useEffect, useState } from 'react'
import { FolderPlus, Pencil } from 'lucide-react'

import {
  browseDirectories,
  createDirectory,
  renameDirectory,
  type DirectoryEntry,
  type WorkspaceBrowse,
} from '@/api/workspaces'
import { useSessionStore } from '@/lib/session'

import { Button, IconButton, Modal, SkeletonBlock, TextInput } from '../shared/ui'

export function DirectoryPickerDialog({
  open,
  start,
  onClose,
  onPick,
}: {
  open: boolean
  /** 打开时从哪儿起步（一般是当前填着的路径）；空则落在服务端的专用区域。 */
  start?: string
  onClose: () => void
  onPick: (path: string) => void
}) {
  const isAdmin = useSessionStore((store) => store.currentUser?.role === 'admin')

  const [view, setView] = useState<WorkspaceBrowse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  /** 正在新建 / 正在改名的那一行。**同一时刻只允许一处**，免得两个输入框抢焦点。 */
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [renaming, setRenaming] = useState('')
  const [renameName, setRenameName] = useState('')
  const [busy, setBusy] = useState(false)
  /** 动作自己的错（重名、名字非法…）：显示在列表上方，不覆盖整个列表。 */
  const [actionError, setActionError] = useState('')

  /** 当前这一层自己：**服务端说了算**（`current`），界面不自己判。 */
  const currentEntry: DirectoryEntry | null = view?.current ?? null

  /**
   * 当前这一层能不能新建目录：同样**服务端说了算**。
   *
   * 判据写成 `!== false`（而不是 `=== true`）：字段是 v0.41 才加的，万一界面比后端
   * 先上，旧响应里没有这个字段——那时宁可按旧行为放行（点了由后端拒），
   * 也不要凭空把按钮锁死。
   */
  const canCreate = view !== null && currentEntry?.creatable !== false
  const isArea = view !== null && view.path === view.area

  async function load(path?: string): Promise<void> {
    setLoading(true)
    setError('')
    cancelEditing()
    try {
      setView(await browseDirectories(path))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '读不到目录')
      setView(null)
    } finally {
      setLoading(false)
    }
  }

  function cancelEditing(): void {
    setCreating(false)
    setNewName('')
    setRenaming('')
    setRenameName('')
    setActionError('')
  }

  useEffect(() => {
    if (!open) return
    setView(null)
    setError('')
    cancelEditing()
    void load(start?.trim() || undefined)
    // 每一次打开都重新读一次：服务器上的目录可能被别处改过
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  /**
   * 新建 → **建完直接进去**。
   *
   * 建目录的真实意图是"我要一个放新项目的目录"，所以建完停在这一层、让他再点一次
   * "进去"是多余的一步；而进去之后路径那一行就摆着他刚建的那个目录，也算一种确认。
   */
  async function submitCreate(): Promise<void> {
    const parent = view?.path
    const name = newName.trim()
    if (!parent || !name || busy) return
    setBusy(true)
    setActionError('')
    try {
      const entry = await createDirectory(parent, name)
      setCreating(false)
      setNewName('')
      await load(entry.path)
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : '建不了')
    } finally {
      setBusy(false)
    }
  }

  /** 改名 → **留在原地刷新**（改的是这一行，不是"进去"）。 */
  async function submitRename(): Promise<void> {
    const path = renaming
    const name = renameName.trim()
    if (!path || !name || busy) return
    setBusy(true)
    setActionError('')
    try {
      await renameDirectory(path, name)
      setRenaming('')
      setRenameName('')
      await load(view?.path)
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : '改不了')
    } finally {
      setBusy(false)
    }
  }

  if (!isAdmin) {
    // 目录浏览是管理员专属（列出的是服务器上的目录树）。成员不该看到这颗按钮，
    // 万一被打开，这里给一句明确的话而不是一个转圈的空白。
    return (
      <Modal open={open} title="选择目录" onClose={onClose}>
        <p className="m-muted">目录浏览只对管理员开放，请直接填写服务器上的路径。</p>
      </Modal>
    )
  }

  const pickable = view !== null && currentEntry?.selectable !== false

  return (
    <Modal
      open={open}
      title="选择目录"
      onClose={onClose}
      size="md"
      height="tall"
      footer={
        <>
          <span className="m-footer-left m-picker-note">
            {currentEntry && !currentEntry.selectable
              ? currentEntry.reason
              : '进到你想用的那一层，再点右边的按钮'}
          </span>
          <Button onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            disabled={!pickable}
            onClick={() => {
              if (!view) return
              onPick(view.path)
              onClose()
            }}
          >
            选这个目录
          </Button>
        </>
      }
    >
      <div className="m-picker">
        {/* 当前位置：等宽字体 + 可选中的文本（路径会被复制去别处用） */}
        <p className="m-picker-where">{view?.path || '读取中…'}</p>

        {/* 起点：家目录 / 盘符 / 已有工作区。路径很深时不用从根一路点下来 */}
        {view && view.roots.length > 0 && (
          <div className="m-roots">
            {view.roots.map((root) => (
              <button
                key={root.path}
                type="button"
                className="m-root-btn"
                title={root.path}
                onClick={() => void load(root.path)}
              >
                {root.name}
              </button>
            ))}
          </div>
        )}

        {error ? (
          <p className="m-error-line">{error}</p>
        ) : (
          actionError && <p className="m-error-line">{actionError}</p>
        )}
        {loading && <SkeletonBlock variant="list" rows={4} />}

        {!loading && view && (
          <>
            {isArea && (
              <p className="m-notice" style={{ margin: 0 }}>
                <FolderPlus size={13} />
                这是「工作区」区域：服务器上专门放工作区的地方，也是唯一能新建文件夹的地方。
                在里面建一个，再选中它。
              </p>
            )}

            <div className="m-picker-head">
              <Button
                size="sm"
                variant="subtle"
                disabled={!view.parent}
                onClick={() => view.parent && void load(view.parent)}
              >
                上一级
              </Button>
              {view.note && <span className="m-picker-note">{view.note}</span>}
              {/* 新建就在这里（不再弹第二个框）：它建的是"当前这一层"下的目录。
                  区域外**灰着**——服务端早说了哪儿能建（creatable + 原因） */}
              <span className="m-picker-new">
                <Button
                  size="sm"
                  disabled={busy || !canCreate}
                  title={canCreate ? undefined : currentEntry?.create_reason}
                  icon={<FolderPlus size={14} />}
                  onClick={() => {
                    cancelEditing()
                    setCreating(true)
                  }}
                >
                  新建文件夹
                </Button>
              </span>
            </div>

            {/* "为什么不能建"就摆在刚灰掉的那颗按钮下面，而不是等点下去才说 */}
            {!canCreate && <p className="m-why-line">{currentEntry?.create_reason}</p>}

            {creating && (
              <div className="m-edit-row">
                <TextInput
                  value={newName}
                  onValueChange={setNewName}
                  placeholder="文件夹名"
                  aria-label="新文件夹名"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void submitCreate()
                    if (event.key === 'Escape') cancelEditing()
                  }}
                />
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy || !newName.trim()}
                  onClick={() => void submitCreate()}
                >
                  建
                </Button>
                <Button size="sm" variant="ghost" onClick={cancelEditing}>
                  取消
                </Button>
              </div>
            )}

            {view.entries.length > 0 ? (
              <ul className="m-dirs">
                {view.entries.map((entry) => (
                  <li key={entry.path} className="m-dir-row">
                    {renaming === entry.path ? (
                      <>
                        <TextInput
                          value={renameName}
                          onValueChange={setRenameName}
                          aria-label={`把「${entry.name}」改名`}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') void submitRename()
                            if (event.key === 'Escape') cancelEditing()
                          }}
                        />
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={busy || !renameName.trim()}
                          onClick={() => void submitRename()}
                        >
                          改
                        </Button>
                        <Button size="sm" variant="ghost" onClick={cancelEditing}>
                          取消
                        </Button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="m-dir-btn"
                          title={entry.path}
                          onClick={() => void load(entry.path)}
                        >
                          <span className="m-dir-name">{entry.name}</span>
                          {/* 能不能建、能不能选**都标在行上**：进去之后是什么情况，
                              站在外面就知道。"只读"只说一遍，完整原因在 title 里 */}
                          {entry.creatable === false && (
                            <span className="m-dir-flag" title={entry.create_reason}>
                              只读
                            </span>
                          )}
                          {!entry.selectable && <span className="m-dir-why">{entry.reason}</span>}
                        </button>
                        {/* 悬停才出现：一行一个图标会把列表压得很吵。
                            改不了名时**灰着并说明原因**——不让用户点了才知道 */}
                        <IconButton
                          label={
                            entry.renamable === false
                              ? entry.rename_reason
                              : `把「${entry.name}」改名`
                          }
                          icon={<Pencil size={13} />}
                          disabled={entry.renamable === false}
                          onClick={() => {
                            cancelEditing()
                            setRenaming(entry.path)
                            setRenameName(entry.name)
                          }}
                        />
                      </>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="m-muted">这个目录里没有子目录。</p>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
