/**
 * 设置弹窗（《前端设计规范》§5）——与旧前端 `components/settings/SettingsModal.vue` 逐条对应。
 *
 * 为什么设置从页面变成弹窗：设置是**动作**——改完就走，不需要一个常驻的地址，
 * 也不需要用户在改完模型之后还要"离开设置页"。侧栏底部一个入口点开即可，
 * 改完关掉，回到他原来在看的页面。
 *
 * 内部用左侧分组菜单 + 右侧内容：
 * - 模型注册 / 向量化 / 对话模型 / 服务配置 / 存储配置 / 用户 / 系统与安全 / 外观 / 快捷键；
 * - **功能**（长期记忆 / 联网 / 沙箱执行…）：这一组**不是手写的菜单**，
 *   而是"后端返回了、但上面几节没有专门渲染"的那些组，自动出现。
 *
 * 密钥永不回显明文：接口给掩码，输入框留空表示"不改动"。
 *
 * **为什么要有自动出现的那一组**：设置组由后端 `SETTING_GROUPS` 定义，而菜单曾经是
 * 一张手写清单——于是后端加一组在界面上**根本没有入口**：用户看到的是"哪里有长期记忆了？"，
 * 而别处的提示还写着"到设置里打开它"。现在没有专门渲染的组会自动出现在「功能」下。
 */
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Activity,
  ChevronRight,
  CircleUser,
  Database,
  Folder,
  Keyboard,
  Languages,
  LogOut,
  Moon,
  Server,
  Settings2,
  Sparkles,
  UserPlus,
  Users,
} from 'lucide-react'
import { useNavigate } from 'react-router'

import {
  changePassword as apiChangePassword,
  logout as apiLogout,
  MIN_PASSWORD_CHARS,
} from '@/api/auth'
import { fetchHealth } from '@/api/health'
import { bindSlot, getRegistry, type RegisteredModel, type Slot } from '@/api/modelRegistry'
import {
  getAuthStatus,
  getSettings,
  testConnection,
  updateSettings,
  type SettingGroup,
} from '@/api/settings'
import {
  createUser,
  deleteUser,
  listUsers,
  resetUserPassword,
  setUserDisabled,
  type RosterUser,
  type UserRole,
} from '@/api/users'
import { clearSessionToken, useSessionStore } from '@/lib/session'

import { notifyError, notifySuccess } from '../shared/toast'
import { Button } from '@/ui/button'
import { Input } from '@/ui/input'
import { Textarea } from '@/ui/textarea'
import {
  Avatar,
  CheckRow,
  ConfirmDialog,
  ErrorLine,
  Field,
  InfoTip,
  Modal,
  OptionSelect,
  SkeletonBlock,
  StatusTag,
} from '../shared/composites'
import { AppearanceSection } from './AppearanceSection'
import { ModelRegistryPanel, REGISTRY_QUERY_KEY } from './ModelRegistryPanel'
import { SettingGroupPanel, SETTINGS_QUERY_KEY } from './SettingGroupPanel'
import { ShortcutsSection } from './ShortcutsSection'
import { StorageSection } from './StorageSection'

type SectionKey =
  | 'registry'
  | 'models'
  | 'llm'
  | 'services'
  | 'storage'
  | 'appearance'
  | 'shortcuts'
  | 'users'
  | 'system'
  | `feature:${string}`

/** 已经由上面那些"专门一节"渲染过的设置组；其余自动进「功能」。 */
const RENDERED_GROUP_KEYS = new Set(['embedding', 'llm', 'chat', 'mineru', 'paddleocr'])

/**
 * **已经有自己家的**设置组（v0.26）：它们从总设置里搬走了，只在模块页出现。
 *
 * 判断标准是"这条设置在说谁"：长期记忆说的是记忆页那一摊，联网与执行策略说的是
 * 能力页那一摊。挂在总设置里的代价很具体——记忆页上写着"记忆服务未启用"，
 * 而开关在另一个菜单的第九项里。**这一组不是"藏起来"而是"搬家"**：
 * 两份都在的话，两处会长得不一样、说得不一样，那就是两个真相。
 */
const MODULE_GROUP_KEYS = new Set(['memory', 'web', 'sandbox'])

const SECTIONS: { key: SectionKey; label: string; icon: typeof Server; adminOnly?: boolean }[] = [
  // **「模型」放在最前**：它是配置模型的主路径（供应商 → 模型 → 用途）
  { key: 'registry', label: '模型注册', icon: Sparkles },
  // 这两组是回退用的精细字段：没在「模型」里绑定的用途，按这里的字段走
  { key: 'models', label: '向量化', icon: Database },
  { key: 'llm', label: '对话模型', icon: Languages },
  { key: 'services', label: '服务配置', icon: Server },
  { key: 'storage', label: '存储配置', icon: Folder },
  { key: 'users', label: '用户', icon: Users, adminOnly: true },
  { key: 'system', label: '系统与安全', icon: CircleUser },
  { key: 'appearance', label: '外观', icon: Moon },
  { key: 'shortcuts', label: '快捷键', icon: Keyboard },
]

const ROLE_OPTIONS: { value: UserRole; label: string }[] = [
  { value: 'member', label: '成员' },
  { value: 'admin', label: '管理员' },
]

export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const currentUser = useSessionStore((store) => store.currentUser)
  const isAdmin = currentUser?.role === 'admin'

  /** 打开设置落在「模型注册」——它是配置模型的主路径。 */
  const [section, setSection] = useState<SectionKey>('registry')
  /** 正在编辑的分组（null = 仍在浏览态）。 */
  const [editing, setEditing] = useState<SettingGroup | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null)
  const [bindingSlot, setBindingSlot] = useState('')

  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmNewPassword, setConfirmNewPassword] = useState('')
  const [passwordError, setPasswordError] = useState('')

  const [usersOpen, setUsersOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newUsername, setNewUsername] = useState('')
  const [newAccountPassword, setNewAccountPassword] = useState('')
  const [newRole, setNewRole] = useState<UserRole>('member')
  const [createError, setCreateError] = useState('')
  const [resetTarget, setResetTarget] = useState<RosterUser | null>(null)
  const [resetDraft, setResetDraft] = useState('')
  const [resetError, setResetError] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<RosterUser | null>(null)

  const settings = useQuery({ queryKey: SETTINGS_QUERY_KEY, queryFn: getSettings })
  const registry = useQuery({ queryKey: REGISTRY_QUERY_KEY, queryFn: getRegistry })

  const health = useQuery({ queryKey: ['health'], queryFn: fetchHealth, retry: false })
  const authStatus = useQuery({
    queryKey: ['auth', 'status'],
    queryFn: getAuthStatus,
    retry: false,
  })

  const users = useQuery({
    queryKey: ['users', 'roster'],
    queryFn: async () => (await listUsers()).items,
    enabled: open && isAdmin && section === 'users',
  })

  const config = settings.data ?? null
  const registryData = registry.data ?? null

  const group = (key: string): SettingGroup | undefined =>
    config?.groups.find((item) => item.key === key)

  const fieldValue = (groupKey: string, fieldKey: string): string =>
    group(groupKey)?.fields.find((item) => item.key === fieldKey)?.value ?? ''

  const isConfigured = (groupKey: string, fieldKey: string): boolean =>
    group(groupKey)?.fields.find((item) => item.key === fieldKey)?.configured ?? false

  const secretSummary = (groupKey: string, fieldKey: string): string =>
    isConfigured(groupKey, fieldKey) ? fieldValue(groupKey, fieldKey) : '未配置'

  /** select 字段当前值的显示文案。候选值来自后端，前端不做一份映射表。 */
  const selectLabel = (groupKey: string, fieldKey: string, value: string): string => {
    const field = group(groupKey)?.fields.find((item) => item.key === fieldKey)
    return field?.options.find((option) => option.value === value)?.label ?? value
  }

  const slotOf = (key: string): Slot | undefined =>
    registryData?.slots.find((item) => item.slot === key)

  /** 可以绑到某个用途的模型：声明了该能力，或压根没声明（旧数据不拦）。 */
  const bindableModels = (slot: string): RegisteredModel[] => {
    const capability = slotOf(slot)?.capability ?? slot
    return (registryData?.models ?? []).filter((model) => {
      const owner = registryData?.providers.find((provider) => provider.id === model.provider_id)
      if (!owner || !owner.enabled) return false
      return model.capabilities.length === 0 || model.capabilities.includes(capability)
    })
  }

  /** 下拉选项：空值 = 未指定，其余是"模型名 · 供应商"。 */
  const slotOptions = (slot: string) => [
    { value: '', label: '未指定' },
    ...bindableModels(slot).map((model) => ({
      value: model.id,
      label: `${model.label || model.model_id} · ${model.provider_name}`,
    })),
  ]

  /**
   * 选中模型的"身份证"：名称 · 维度 · 供应商。
   * 未选定时返回空串——选择器里已经写着「未指定」了，再跟一行同样的字只是噪声。
   */
  const slotSummary = (slot: string): string => {
    const state = slotOf(slot)
    if (!state?.configured) return ''
    const model = registryData?.models.find((item) => item.id === state.bound_model_pk)
    if (!model) return state.bound_model_label || '—'
    const dim = model.dim ? ` · ${model.dim} 维` : ''
    return `${model.label || model.model_id}${dim} · ${state.provider_name}`
  }

  const embeddingConfigured = slotOf('embedding')?.configured ?? false
  const chatConfigured = slotOf('chat')?.configured ?? false

  /**
   * 后端返回、但上面几节没有专门渲染的设置组（长期记忆 / 联网 / 沙箱执行…）。
   *
   * **它是这一段的关键**：菜单原先是手写的，于是后端加一组就等于"界面上没有入口"。
   * 这里改成按后端返回的组算，以后加组的人不需要记得回来改菜单。
   */
  const featureGroups = useMemo(
    () =>
      (config?.groups ?? []).filter(
        (item) => !RENDERED_GROUP_KEYS.has(item.key) && !MODULE_GROUP_KEYS.has(item.key),
      ),
    [config],
  )

  const visibleSections = SECTIONS.filter((item) => !item.adminOnly || isAdmin)
  const navGroups = [
    { label: '模型', keys: ['registry', 'models', 'llm'] as SectionKey[] },
    { label: '服务', keys: ['services', 'storage'] as SectionKey[] },
    { label: '功能', keys: featureGroups.map((item) => `feature:${item.key}` as SectionKey) },
    { label: '账户', keys: ['users', 'system'] as SectionKey[] },
    { label: '偏好', keys: ['appearance', 'shortcuts'] as SectionKey[] },
  ]
    .map((item) => ({
      label: item.label,
      items:
        item.label === '功能'
          ? featureGroups.map((group) => ({
              key: `feature:${group.key}` as SectionKey,
              label: group.label,
              icon: Settings2,
            }))
          : visibleSections.filter((entry) => item.keys.includes(entry.key)),
    }))
    .filter((item) => item.items.length > 0)

  const activeFeatureKey =
    typeof section === 'string' && section.startsWith('feature:') ? section.slice(8) : ''

  const save = useMutation({
    mutationFn: (target: SettingGroup) =>
      updateSettings(
        target.fields.map((field) => ({ key: field.key, value: draft[field.key] ?? '' })),
      ),
    onSuccess: async (result) => {
      if (result.rejected.length > 0) {
        notifyError(`以下配置项不被接受：${result.rejected.join('、')}`)
        return
      }
      notifySuccess('配置已保存，下一个任务即刻生效')
      setEditing(null)
      await queryClient.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY })
    },
    onError: (error: unknown) => notifyError(messageOf(error, '保存失败')),
  })

  async function runTest(target: string): Promise<void> {
    setTesting(true)
    setTestResult(null)
    try {
      setTestResult(await testConnection(target))
    } catch (error) {
      setTestResult({ ok: false, detail: messageOf(error, '测试失败') })
    } finally {
      setTesting(false)
    }
  }

  const bind = useMutation({
    mutationFn: (input: { slot: string; value: string }) =>
      bindSlot(input.slot, input.value || null),
    onMutate: (input) => setBindingSlot(input.slot),
    onSuccess: async (_result, input) => {
      await queryClient.invalidateQueries({ queryKey: REGISTRY_QUERY_KEY })
      notifySuccess(input.value ? '默认模型已更新' : '已取消默认模型')
    },
    onError: (cause: unknown) => notifyError(messageOf(cause, '保存失败')),
    onSettled: () => setBindingSlot(''),
  })

  const changePassword = useMutation({
    mutationFn: () => apiChangePassword(oldPassword, newPassword),
    onSuccess: (result) => {
      setOldPassword('')
      setNewPassword('')
      setConfirmNewPassword('')
      notifySuccess(
        result.revoked_sessions > 0
          ? `密码已更新，其他 ${result.revoked_sessions} 处登录已退出`
          : '密码已更新',
      )
    },
    onError: (error: unknown) => setPasswordError(messageOf(error, '修改失败，请重试')),
  })

  function submitPasswordChange(): void {
    setPasswordError('')
    if (!oldPassword || !newPassword) {
      setPasswordError('请填写当前密码与新密码')
      return
    }
    if (newPassword.length < MIN_PASSWORD_CHARS) {
      setPasswordError(`新密码至少 ${MIN_PASSWORD_CHARS} 个字符`)
      return
    }
    if (newPassword !== confirmNewPassword) {
      setPasswordError('两次输入的新密码不一致')
      return
    }
    changePassword.mutate()
  }

  const createAccount = useMutation({
    mutationFn: () =>
      createUser({
        name: newName.trim(),
        username: newUsername.trim(),
        password: newAccountPassword,
        role: newRole,
      }),
    onSuccess: async (created) => {
      setNewName('')
      setNewUsername('')
      setNewAccountPassword('')
      setNewRole('member')
      // 开通成功就收起表单：接着多半去核对名单，留在原地只会挡住列表
      setUsersOpen(false)
      notifySuccess(`已开通账号「${created.username}」`)
      await queryClient.invalidateQueries({ queryKey: ['users', 'roster'] })
    },
    onError: (error: unknown) => setCreateError(messageOf(error, '开通失败')),
  })

  function submitCreateUser(): void {
    setCreateError('')
    if (!newName.trim()) {
      setCreateError('请填写显示名')
      return
    }
    if (!newUsername.trim()) {
      setCreateError('请填写登录名')
      return
    }
    if (newAccountPassword.length < MIN_PASSWORD_CHARS) {
      setCreateError(`初始密码至少 ${MIN_PASSWORD_CHARS} 个字符`)
      return
    }
    createAccount.mutate()
  }

  const resetPassword = useMutation({
    mutationFn: (person: RosterUser) => resetUserPassword(person.id, resetDraft),
    onSuccess: async (_result, person) => {
      setResetTarget(null)
      notifySuccess(`已重置「${person.name}」的密码，其登录会话已全部失效`)
      await queryClient.invalidateQueries({ queryKey: ['users', 'roster'] })
    },
    onError: (error: unknown) => setResetError(messageOf(error, '重置失败')),
  })

  const toggleDisabled = useMutation({
    mutationFn: (person: RosterUser) => setUserDisabled(person.id, !person.disabled),
    onSuccess: async (updated) => {
      notifySuccess(updated.disabled ? `已禁用「${updated.name}」` : `已启用「${updated.name}」`)
      await queryClient.invalidateQueries({ queryKey: ['users', 'roster'] })
    },
    onError: (error: unknown) => notifyError(messageOf(error, '操作失败')),
  })

  const removeAccount = useMutation({
    mutationFn: (person: RosterUser) => deleteUser(person.id),
    onSuccess: async (_result, person) => {
      setDeleteTarget(null)
      notifySuccess(`已删除「${person.name}」；其文档保留，归属置空`)
      await queryClient.invalidateQueries({ queryKey: ['users', 'roster'] })
    },
    onError: (error: unknown) => notifyError(messageOf(error, '删除失败')),
  })

  /** 退出登录：吊销当前会话并清本地令牌。**服务端失败也清本地**——用户点的是退出。 */
  async function doLogout(): Promise<void> {
    try {
      await apiLogout()
    } catch {
      // 会话可能已过期或被吊销：服务端报错不影响"本地退出"这件事
    }
    clearSessionToken()
    onClose()
    await navigate('/login')
  }

  function openEdit(target: SettingGroup): void {
    setEditing(target)
    setTestResult(null)
    const next: Record<string, string> = {}
    for (const field of target.fields) {
      next[field.key] = field.type === 'secret' ? '' : field.value
    }
    setDraft(next)
  }

  /** 切换一节：换节就把编辑态收掉，免得看到上一节的表单。 */
  function goSection(next: SectionKey): void {
    setSection(next)
    setEditing(null)
    setTestResult(null)
    setUsersOpen(false)
  }

  return (
    <Modal
      open={open}
      title="设置"
      onClose={onClose}
      size="wide"
      height="tall"
      footer={<Button onClick={onClose}>关闭</Button>}
    >
      <div className="m-settings-layout">
        <nav className="m-settings-nav" aria-label="设置分组">
          {navGroups.map((navGroup) => (
            <div key={navGroup.label}>
              <p className="m-nav-group">{navGroup.label}</p>
              {navGroup.items.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={section === item.key ? 'm-nav-entry m-nav-entry-on' : 'm-nav-entry'}
                  onClick={() => goSection(item.key)}
                >
                  <item.icon size={15} />
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="m-settings-body">
          {settings.isError && <ErrorLine>{messageOf(settings.error, '配置读取失败')}</ErrorLine>}
          {settings.isLoading && <SkeletonBlock variant="text" rows={4} />}

          {section === 'registry' && <ModelRegistryPanel />}

          {section === 'models' && (
            <>
              {editing?.key === 'embedding' ? (
                <>
                  <h3 className="m-section-title">编辑 {editing.label}</h3>
                  <div className="m-edit-form">
                    {editing.fields.map((field) => (
                      <label key={field.key} className="m-edit-field">
                        <span className="m-edit-label">{field.label}</span>
                        <Input
                          type={field.type === 'int' ? 'number' : 'text'}
                          value={draft[field.key] ?? ''}
                          onChange={(event) =>
                            setDraft((current) => ({ ...current, [field.key]: event.target.value }))
                          }
                          aria-label={field.label}
                        />
                      </label>
                    ))}
                    <p className="m-edit-hint">
                      批大小影响单次请求的文本条数，太大可能被端点拒绝。
                    </p>
                  </div>
                  <div className="m-edit-actions">
                    <Button onClick={() => setEditing(null)}>返回</Button>
                    <Button disabled={save.isPending} onClick={() => save.mutate(editing)}>
                      {save.isPending ? '保存中…' : '保存'}
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <h3 className="m-section-title">
                    向量化
                    <InfoTip text="模型在「模型注册」里登记，这里只负责选默认的那个。新建知识库时也可以为单个库另选（小库用高精度、大库用小模型）。" />
                  </h3>

                  <div className="m-slot-field">
                    <div className="m-slot-head">
                      <span className="m-slot-label">
                        默认嵌入模型
                        <InfoTip text="库建好即冻结，之后不能换（换模型要新建库）。未指定时无法新建知识库。" />
                      </span>
                      <StatusTag
                        tone={embeddingConfigured ? 'success' : 'warning'}
                        label={embeddingConfigured ? '已选定' : '未选定'}
                      />
                      <Button
                        disabled={testing || !embeddingConfigured}
                        onClick={() => void runTest('embedding')}
                      >
                        {testing ? '测试中…' : '测试连接'}
                      </Button>
                    </div>
                    <OptionSelect
                      value={slotOf('embedding')?.bound_model_pk ?? ''}
                      onValueChange={(value) => bind.mutate({ slot: 'embedding', value })}
                      options={slotOptions('embedding')}
                      disabled={bindingSlot === 'embedding'}
                      label="默认嵌入模型"
                    />
                    {slotSummary('embedding') && (
                      <p className="m-slot-value tabular">{slotSummary('embedding')}</p>
                    )}
                    {!embeddingConfigured && (
                      <p className="m-row-note">
                        未选定前不能新建知识库：没有嵌入模型就没有向量空间。如果这里没有可选项，
                        先到「模型注册」添加供应商并登记模型。
                      </p>
                    )}
                    {testResult && (
                      <div
                        className={
                          testResult.ok ? 'm-test-result m-test-ok' : 'm-test-result m-test-bad'
                        }
                      >
                        <span>{testResult.detail}</span>
                      </div>
                    )}
                  </div>

                  <div className="m-slot-field">
                    <div className="m-slot-head">
                      <span className="m-slot-label">
                        重排模型
                        <InfoTip text="可选。不选则整体跳过重排，不影响检索可用性。" />
                      </span>
                      <StatusTag
                        tone={slotOf('rerank')?.configured ? 'success' : 'neutral'}
                        label={slotOf('rerank')?.configured ? '已启用' : '未启用'}
                      />
                      <Button
                        disabled={testing || !slotOf('rerank')?.configured}
                        onClick={() => void runTest('rerank')}
                      >
                        {testing ? '测试中…' : '测试连接'}
                      </Button>
                    </div>
                    <OptionSelect
                      value={slotOf('rerank')?.bound_model_pk ?? ''}
                      onValueChange={(value) => bind.mutate({ slot: 'rerank', value })}
                      options={slotOptions('rerank')}
                      disabled={bindingSlot === 'rerank'}
                      label="重排模型"
                    />
                    {slotSummary('rerank') && (
                      <p className="m-slot-value tabular">{slotSummary('rerank')}</p>
                    )}
                  </div>

                  <h3 className="m-section-title m-section-gap">高级</h3>
                  <div className="m-row">
                    <div className="m-row-main">
                      <span className="m-row-label">批大小</span>
                      <span className="m-row-value tabular">
                        {fieldValue('embedding', 'embedding.batch_size') || '—'}
                      </span>
                    </div>
                    {group('embedding') && (
                      <Button onClick={() => openEdit(group('embedding')!)}>编辑</Button>
                    )}
                  </div>
                </>
              )}
            </>
          )}

          {section === 'llm' && (
            <>
              {editing ? (
                <>
                  <h3 className="m-section-title">编辑 {editing.label}</h3>
                  <div className="m-edit-form">
                    {editing.fields.map((field) => {
                      // 布尔项不能走文本输入：里面的 "false" 是非空字符串，一不小心就写成了开启
                      if (field.type === 'bool') {
                        return (
                          <CheckRow
                            key={field.key}
                            checked={draft[field.key] === 'true'}
                            onCheckedChange={(next) =>
                              setDraft((current) => ({ ...current, [field.key]: String(next) }))
                            }
                          >
                            {field.label}
                          </CheckRow>
                        )
                      }
                      if (field.type === 'select') {
                        return (
                          <label key={field.key} className="m-edit-field">
                            <span className="m-edit-label">{field.label}</span>
                            <OptionSelect
                              value={draft[field.key] ?? ''}
                              onValueChange={(value) =>
                                setDraft((current) => ({ ...current, [field.key]: value }))
                              }
                              options={field.options}
                              label={field.label}
                            />
                          </label>
                        )
                      }
                      return (
                        <label key={field.key} className="m-edit-field">
                          <span className="m-edit-label">
                            {field.label}
                            {field.type === 'secret' && field.configured && (
                              <span className="m-edit-current">当前 {field.value}</span>
                            )}
                          </span>
                          {field.type === 'textarea' ? (
                            <Textarea
                              rows={5}
                              value={draft[field.key] ?? ''}
                              onChange={(event) =>
                                setDraft((current) => ({
                                  ...current,
                                  [field.key]: event.target.value,
                                }))
                              }
                              aria-label={field.label}
                            />
                          ) : (
                            <Input
                              type={field.type === 'int' ? 'number' : 'text'}
                              placeholder={field.type === 'secret' ? '留空表示不改动' : undefined}
                              value={draft[field.key] ?? ''}
                              onChange={(event) =>
                                setDraft((current) => ({
                                  ...current,
                                  [field.key]: event.target.value,
                                }))
                              }
                              aria-label={field.label}
                            />
                          )}
                        </label>
                      )
                    })}

                    <p className="m-edit-hint">
                      {editing.key === 'llm'
                        ? '推理模型打开深度思考后会更慢、更费 token（回复长度不再设上限，由模型自己决定何时收尾）。关掉它更快，但难题上的推导会浅一些。'
                        : '留空即恢复内置提示词：内置版本要求模型只依据资料作答，并在引用处标出资料编号。'}
                    </p>

                    {testResult && (
                      <div
                        className={
                          testResult.ok ? 'm-test-result m-test-ok' : 'm-test-result m-test-bad'
                        }
                      >
                        <span>{testResult.detail}</span>
                      </div>
                    )}
                  </div>
                  <div className="m-edit-actions">
                    {editing.key === 'llm' && (
                      <Button disabled={testing} onClick={() => void runTest('llm')}>
                        {testing ? '测试中…' : '测试连接'}
                      </Button>
                    )}
                    <Button onClick={() => setEditing(null)}>返回</Button>
                    <Button disabled={save.isPending} onClick={() => save.mutate(editing)}>
                      {save.isPending ? '保存中…' : '保存'}
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <h3 className="m-section-title">
                    对话模型（LLM）
                    <InfoTip text="模型在「模型注册」里登记，这里只选默认的那个。没选时「对话」会直接报错，不会编造没有依据的答案。" />
                  </h3>

                  <div className="m-slot-field">
                    <div className="m-slot-head">
                      <span className="m-slot-label">默认对话模型</span>
                      <StatusTag
                        tone={chatConfigured ? 'success' : 'warning'}
                        label={chatConfigured ? '已选定' : '未选定'}
                      />
                      <Button
                        disabled={testing || !chatConfigured}
                        onClick={() => void runTest('llm')}
                      >
                        {testing ? '测试中…' : '测试连接'}
                      </Button>
                    </div>
                    <OptionSelect
                      value={slotOf('chat')?.bound_model_pk ?? ''}
                      onValueChange={(value) => bind.mutate({ slot: 'chat', value })}
                      options={slotOptions('chat')}
                      disabled={bindingSlot === 'chat'}
                      label="默认对话模型"
                    />
                    {slotSummary('chat') && (
                      <p className="m-slot-value tabular">{slotSummary('chat')}</p>
                    )}
                    {!chatConfigured && (
                      <p className="m-row-note">
                        未选定时「对话」与标题生成不可用。如果这里没有可选项，先到「模型注册」登记对话模型。
                      </p>
                    )}
                    {testResult && (
                      <div
                        className={
                          testResult.ok ? 'm-test-result m-test-ok' : 'm-test-result m-test-bad'
                        }
                      >
                        <span>{testResult.detail}</span>
                      </div>
                    )}
                  </div>

                  <h3 className="m-section-title m-section-gap">采样与行为</h3>
                  <div className="m-row">
                    <div className="m-row-main">
                      <span className="m-row-label">
                        温度 / 深度思考
                        <InfoTip text="长度上限交给模型：它自己决定什么时候收尾。少数端点不传就会退化成很小的默认值，那种情况在「模型注册」里给该模型加 options.max_tokens。" />
                      </span>
                      <span className="m-row-value tabular">
                        温度 {fieldValue('llm', 'llm.temperature') || '—'}
                        <span className="sep">·</span>
                        {fieldValue('llm', 'llm.enable_thinking') === 'true'
                          ? `思考开（${selectLabel(
                              'llm',
                              'llm.thinking_effort',
                              fieldValue('llm', 'llm.thinking_effort'),
                            )}）`
                          : '思考关'}
                      </span>
                    </div>
                    {group('llm') && <Button onClick={() => openEdit(group('llm')!)}>编辑</Button>}
                  </div>
                  {fieldValue('llm', 'llm.enable_thinking') === 'true' && (
                    <p className="m-row-note">更慢、更费 token。</p>
                  )}

                  <h3 className="m-section-title m-section-gap">对话行为</h3>
                  <div className="m-row">
                    <div className="m-row-main">
                      <span className="m-row-label">检索与生成</span>
                      {/* 提示词不再在这里配（v0.19）：它跟**知识库**绑定，
                          去「知识库 → 设置 → 回答要求」里改。这里只留一句指路 */}
                      <span className="m-row-value">
                        回答用的提示词在「知识库 → 设置」里配，每个库一份
                      </span>
                    </div>
                    <span className="m-row-value tabular">
                      带入 {fieldValue('chat', 'chat.top_k') || '—'} 条资料
                    </span>
                    {group('chat') && (
                      <Button onClick={() => openEdit(group('chat')!)}>编辑</Button>
                    )}
                  </div>
                </>
              )}
            </>
          )}

          {section === 'services' && (
            <>
              {editing && (editing.key === 'mineru' || editing.key === 'paddleocr') ? (
                <>
                  <h3 className="m-section-title">编辑 {editing.label}</h3>
                  <div className="m-edit-form">
                    {editing.fields.map((field) => (
                      <label key={field.key} className="m-edit-field">
                        <span className="m-edit-label">
                          {field.label}
                          {field.type === 'secret' && field.configured && (
                            <span className="m-edit-current">当前 {field.value}</span>
                          )}
                        </span>
                        <Input
                          value={draft[field.key] ?? ''}
                          onChange={(event) =>
                            setDraft((current) => ({ ...current, [field.key]: event.target.value }))
                          }
                          placeholder={field.type === 'secret' ? '留空表示不改动' : undefined}
                          aria-label={field.label}
                        />
                      </label>
                    ))}
                    {testResult && (
                      <div
                        className={
                          testResult.ok ? 'm-test-result m-test-ok' : 'm-test-result m-test-bad'
                        }
                      >
                        <span>{testResult.detail}</span>
                      </div>
                    )}
                  </div>
                  <div className="m-edit-actions">
                    <Button disabled={testing} onClick={() => void runTest(editing.key)}>
                      {testing ? '测试中…' : '测试连接'}
                    </Button>
                    <Button onClick={() => setEditing(null)}>返回</Button>
                    <Button disabled={save.isPending} onClick={() => save.mutate(editing)}>
                      {save.isPending ? '保存中…' : '保存'}
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <h3 className="m-section-title">
                    服务配置
                    <InfoTip text="两个云端节点互为备选：文字型文档优先 MinerU，扫描件与混合型降级到 PaddleOCR。" />
                  </h3>

                  <div className="m-row">
                    <div className="m-row-main">
                      <span className="m-row-label">MinerU 云端</span>
                      <span className="m-row-value">
                        模型 {fieldValue('mineru', 'mineru.model_version') || '—'}
                        <span className="sep">·</span>
                        {secretSummary('mineru', 'mineru.token')}
                      </span>
                    </div>
                    <StatusTag
                      tone={isConfigured('mineru', 'mineru.token') ? 'success' : 'neutral'}
                      label={isConfigured('mineru', 'mineru.token') ? '已配置' : '未配置'}
                    />
                    {group('mineru') && (
                      <Button onClick={() => openEdit(group('mineru')!)}>编辑</Button>
                    )}
                  </div>

                  <div className="m-row">
                    <div className="m-row-main">
                      <span className="m-row-label">PaddleOCR 云端</span>
                      <span className="m-row-value">
                        {fieldValue('paddleocr', 'paddleocr.model') || '—'}
                        <span className="sep">·</span>
                        {secretSummary('paddleocr', 'paddleocr.token')}
                      </span>
                    </div>
                    <StatusTag
                      tone={isConfigured('paddleocr', 'paddleocr.token') ? 'success' : 'neutral'}
                      label={isConfigured('paddleocr', 'paddleocr.token') ? '已配置' : '未配置'}
                    />
                    {group('paddleocr') && (
                      <Button onClick={() => openEdit(group('paddleocr')!)}>编辑</Button>
                    )}
                  </div>
                </>
              )}
            </>
          )}

          {section === 'storage' && <StorageSection />}
          {section === 'appearance' && <AppearanceSection />}
          {section === 'shortcuts' && <ShortcutsSection />}

          {/* 功能（动态）：后端那些"没有专门归属"的设置组，在这里自动出现。
              已经各有归属的那几组不在这里（v0.26）：长期记忆在记忆页、
              联网与沙箱执行在能力页。渲染的活交给 `SettingGroupPanel`，
              与模块页共用同一个组件——同一组设置在两处长得不一样是不能接受的 */}
          {activeFeatureKey && <SettingGroupPanel keys={[activeFeatureKey]} />}

          {section === 'users' && (
            <>
              <div className="m-section-head">
                <h3 className="m-section-title">
                  用户
                  <InfoTip text="被开通的账号登录后只能看到分享给他的知识库；没有登录名的名册条目只用于标记文档归属。" />
                </h3>
                <Button
                  onClick={() => {
                    setUsersOpen((value) => !value)
                    setCreateError('')
                  }}
                >
                  <UserPlus size={14} />
                  {usersOpen ? '取消' : '添加用户'}
                </Button>
              </div>

              {usersOpen && (
                <div className="m-create-card">
                  <div className="m-create-grid">
                    <label className="field-label" htmlFor="kylab-new-name">
                      显示名
                    </label>
                    <Input
                      id="kylab-new-name"
                      value={newName}
                      onChange={(event) => setNewName(event.target.value)}
                      placeholder="例如 小王"
                    />
                    <label className="field-label" htmlFor="kylab-new-username">
                      登录名
                    </label>
                    <Input
                      id="kylab-new-username"
                      value={newUsername}
                      onChange={(event) => setNewUsername(event.target.value)}
                      placeholder="用于登录，不区分大小写"
                    />
                    <label className="field-label" htmlFor="kylab-account-password">
                      初始密码
                    </label>
                    <Input
                      id="kylab-account-password"
                      type="password"
                      value={newAccountPassword}
                      onChange={(event) => setNewAccountPassword(event.target.value)}
                      placeholder={`至少 ${MIN_PASSWORD_CHARS} 个字符`}
                    />
                    <label className="field-label" htmlFor="kylab-new-role">
                      角色
                    </label>
                    <OptionSelect
                      id="kylab-new-role"
                      value={newRole}
                      onValueChange={(value) => setNewRole(value as UserRole)}
                      options={ROLE_OPTIONS}
                      label="角色"
                    />
                  </div>
                  {createError && (
                    <p className="m-form-error" role="alert">
                      {createError}
                    </p>
                  )}
                  <div className="m-password-actions">
                    <Button disabled={createAccount.isPending} onClick={submitCreateUser}>
                      {createAccount.isPending ? '开通中…' : '开通账号'}
                    </Button>
                  </div>
                </div>
              )}

              <h3 className="m-section-title m-section-gap">成员与名册</h3>
              {users.isLoading && <p className="m-row-note">正在加载…</p>}
              {users.isError && <ErrorLine>{messageOf(users.error, '用户列表加载失败')}</ErrorLine>}
              {users.data && users.data.length === 0 && (
                <p className="m-row-note">还没有任何人。开通一个账号，对方就能登录了。</p>
              )}
              {users.data && users.data.length > 0 && (
                <ul className="m-user-list">
                  {users.data.map((person) => (
                    <li key={person.id} className="m-user-row">
                      {/* 名册里也带头像：人靠脸认，尤其名字都是中文短名时 */}
                      <Avatar name={person.name} url={person.avatar_url} size={32} />
                      <span className="m-user-main">
                        <span className="m-user-name">{person.name}</span>
                        <span className="m-user-meta">
                          {person.username && (
                            <>
                              @{person.username}
                              <span className="sep">·</span>
                            </>
                          )}
                          {person.document_count} 篇文档
                        </span>
                      </span>
                      {person.username ? (
                        <StatusTag
                          tone={person.role === 'admin' ? 'success' : 'neutral'}
                          label={person.role === 'admin' ? '管理员' : '成员'}
                        />
                      ) : (
                        <StatusTag tone="neutral" label="名册" />
                      )}
                      {person.disabled && <StatusTag tone="danger" label="已禁用" />}
                      <span className="m-user-actions">
                        {person.username && (
                          <>
                            <Button
                              size="sm"
                              onClick={() => {
                                setResetTarget(person)
                                setResetDraft('')
                                setResetError('')
                              }}
                            >
                              重置密码
                            </Button>
                            {person.id !== currentUser?.id && (
                              <Button size="sm" onClick={() => toggleDisabled.mutate(person)}>
                                {person.disabled ? '启用' : '禁用'}
                              </Button>
                            )}
                          </>
                        )}
                        {person.id !== currentUser?.id && (
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => setDeleteTarget(person)}
                          >
                            删除
                          </Button>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {section === 'system' && (
            <>
              <h3 className="m-section-title">系统与安全</h3>

              {/* 账号（v10 主路径）：登录状态下在这里改密、退出 */}
              {currentUser && (
                <>
                  <div className="m-row">
                    <div className="m-row-main">
                      <span className="m-row-label">当前账号</span>
                      <span className="m-row-value">
                        {currentUser.name}
                        <span className="m-row-sub">（{currentUser.username}）</span>
                      </span>
                    </div>
                    <StatusTag
                      tone={isAdmin ? 'success' : 'neutral'}
                      label={isAdmin ? '管理员' : '成员'}
                    />
                  </div>

                  <h3 className="m-section-title m-section-gap">
                    修改密码
                    <InfoTip text="改密会吊销其他设备上的登录，当前这条保留。忘记密码时可由管理员在「用户」里重置。" />
                  </h3>
                  <div className="m-password-form">
                    <Field label="当前密码" htmlFor="kylab-old-password">
                      <Input
                        id="kylab-old-password"
                        type="password"
                        autoComplete="current-password"
                        value={oldPassword}
                        onChange={(event) => setOldPassword(event.target.value)}
                      />
                    </Field>
                    <Field label="新密码" htmlFor="kylab-new-password">
                      <Input
                        id="kylab-new-password"
                        type="password"
                        autoComplete="new-password"
                        placeholder={`至少 ${MIN_PASSWORD_CHARS} 个字符`}
                        value={newPassword}
                        onChange={(event) => setNewPassword(event.target.value)}
                      />
                    </Field>
                    <Field label="确认新密码" htmlFor="kylab-confirm-password">
                      <Input
                        id="kylab-confirm-password"
                        type="password"
                        autoComplete="new-password"
                        value={confirmNewPassword}
                        onChange={(event) => setConfirmNewPassword(event.target.value)}
                      />
                    </Field>
                    {passwordError && (
                      <p className="m-form-error" role="alert">
                        {passwordError}
                      </p>
                    )}
                    <div className="m-password-actions">
                      <Button disabled={changePassword.isPending} onClick={submitPasswordChange}>
                        {changePassword.isPending ? '提交中…' : '更新密码'}
                      </Button>
                      <Button variant="destructive" onClick={() => void doLogout()}>
                        <LogOut size={14} />
                        退出登录
                      </Button>
                    </div>
                  </div>
                </>
              )}

              <div className="m-row">
                <div className="m-row-main">
                  <span className="m-row-label">后端状态</span>
                  <span className="m-row-value">
                    {health.data
                      ? `在线 v${health.data.version} · ${health.data.api_version}`
                      : health.isError
                        ? messageOf(health.error, '不可达')
                        : '检测中'}
                  </span>
                </div>
                <StatusTag
                  tone={health.data ? 'success' : 'danger'}
                  label={health.data ? '在线' : '不可达'}
                />
              </div>

              <div className="m-row">
                <div className="m-row-main">
                  <span className="m-row-label">访问鉴权</span>
                  <span className="m-row-value">
                    {authStatus.data?.needs_setup
                      ? '尚未初始化：请先创建管理员账号'
                      : '已启用：/api/v1 一律需要登录会话或 API Key'}
                  </span>
                </div>
                <StatusTag
                  tone={authStatus.data?.needs_setup ? 'warning' : 'success'}
                  label={authStatus.data?.needs_setup ? '未初始化' : '已启用'}
                />
              </div>

              <p className="m-row-note">
                <Activity size={12} /> API Key 不在这一页：它是给外部程序用的凭据， 走 `/api/v1`
                的鉴权头，与这里的登录会话是两条路（后端 `app/api/auth.py` 是权威）。
                <ChevronRight size={12} />
              </p>
            </>
          )}
        </div>
      </div>

      {/* 重置密码（嵌套弹窗）。一次只处理一个人，展开会把名单推下去 */}
      <Modal
        open={resetTarget !== null}
        title="重置密码"
        onClose={() => setResetTarget(null)}
        footer={
          <>
            <Button onClick={() => setResetTarget(null)}>取消</Button>
            <Button
              disabled={resetPassword.isPending || resetDraft.length < MIN_PASSWORD_CHARS}
              onClick={() => resetTarget && resetPassword.mutate(resetTarget)}
            >
              {resetPassword.isPending ? '提交中…' : '重置密码'}
            </Button>
          </>
        }
      >
        <p className="m-muted">
          为「{resetTarget?.name}」设置新密码。对方所有已登录的设备会立即退出。
        </p>
        <Input
          type="password"
          autoComplete="new-password"
          placeholder={`至少 ${MIN_PASSWORD_CHARS} 个字符`}
          value={resetDraft}
          onChange={(event) => setResetDraft(event.target.value)}
          aria-label="新密码"
        />
        {resetError && (
          <p className="m-form-error" role="alert">
            {resetError}
          </p>
        )}
      </Modal>

      {/* 删除账号：破坏性动作，二次确认，并说清"文档会怎样" */}
      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除用户"
        lead={`确定删除「${deleteTarget?.name ?? ''}」？`}
        note={`对方上传的 ${deleteTarget?.document_count ?? 0} 篇文档会保留，但不再归属任何人；账号将无法再登录。不可撤销。`}
        confirmLabel="删除"
        busy={removeAccount.isPending}
        busyLabel="删除中…"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && removeAccount.mutate(deleteTarget)}
      />
    </Modal>
  )
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}
