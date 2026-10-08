/**
 * 设置弹窗（《前端设计规范》§5）——与旧前端 `components/settings/SettingsModal.vue` 逐条对应。
 *
 * 为什么设置从页面变成弹窗：设置是**动作**——改完就走，不需要一个常驻的地址，
 * 也不需要用户在改完模型之后还要"离开设置页"。侧栏底部一个入口点开即可，
 * 改完关掉，回到他原来在看的页面。
 *
 * 内部用左侧分组菜单 + 右侧内容：
 * - 模型注册 / 向量化 / 对话模型 / 服务配置 / 存储配置 / **知识库连接**（本机档专属，M3）/
 *   系统与安全 / 外观 / 快捷键；
 * - **功能**（长期记忆 / 联网 / 沙箱执行…）：这一组**不是手写的菜单**，
 *   而是"后端返回了、但上面几节没有专门渲染"的那些组，自动出现。
 *
 * 2026-10-09：原先还有「用户」那一节（名册 / 开通账号 / 重置密码…）与「系统与安全」里的
 * 账号那一块（当前账号 / 修改密码 / 退出登录）——账号死面整块删了，见下面 `SECTIONS`
 * 之前那一段。
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
  Archive,
  BookOpen,
  CircleUser,
  Database,
  Folder,
  KeyRound,
  Keyboard,
  Languages,
  Moon,
  Server,
  Settings,
  Sparkles,
} from 'lucide-react'
import { useNavigate } from 'react-router'

import { useBackupStatus } from '@/api/backup'
import { useKnowledgeProviderStatus } from '@/api/provider'
import { fetchHealth } from '@/api/health'
import { bindSlot, getRegistry, type RegisteredModel, type Slot } from '@/api/modelRegistry'
import {
  getSettings,
  testConnection,
  updateSettings,
  type SettingGroup,
} from '@/api/settings'

import { notifyError, notifySuccess } from '../shared/toast'
import { Button } from '@/ui/button'
import { Input } from '@/ui/input'
import { Textarea } from '@/ui/textarea'
import {
  CheckRow,
  ErrorLine,
  InfoTip,
  Modal,
  OptionSelect,
  SkeletonBlock,
  StatusTag,
} from '../shared/composites'
import { AppearanceSection } from './AppearanceSection'
import { BackupSection } from './BackupSection'
import { CredentialsSection } from './CredentialsSection'
import { KnowledgeConnectionSection } from './KnowledgeConnectionSection'
import { ModelRegistryPanel, REGISTRY_QUERY_KEY } from './ModelRegistryPanel'
import { SettingGroupPanel, SETTINGS_QUERY_KEY, settingsPayloadOf } from './SettingGroupPanel'
import { ShortcutsSection } from './ShortcutsSection'
import { StorageSection } from './StorageSection'

type SectionKey =
  | 'registry'
  | 'models'
  | 'llm'
  | 'services'
  | 'storage'
  | 'knowledge'
  | 'backup'
  | 'credentials'
  | 'appearance'
  | 'shortcuts'
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

/*
 * ------------------------------------------------------- 账号那一节（2026-10-09 删）
 *
 * 设置弹窗原先的「账号」那一块（当前账号 / 修改密码 / 退出登录）与它的「用户」一节
 * （名册 / 开通账号 / 重置密码 / 禁用 / 删除）**整块删掉了**：它们打的
 * `/auth/*` 与 `/users/*` 是服务器那一族端点，本机档后端没有它们
 * （`local_router` 上没有 `auth.router` / `users.router`）——登录页删掉之后，
 * 这一族在界面上已经没有任何一条能成功的路。
 *
 * 后端 `/users` 那条**名册读**（`api/users.ts::listUsers`）照旧留着：侧栏的归属标注
 * 与 `lib/operator.ts` 用它，不属于账号管理。
 */
const SECTIONS: { key: SectionKey; label: string; icon: typeof Server }[] = [
  // **「模型」放在最前**：它是配置模型的主路径（供应商 → 模型 → 用途）
  { key: 'registry', label: '模型注册', icon: Sparkles },
  // 这两组是回退用的精细字段：没在「模型」里绑定的用途，按这里的字段走
  { key: 'models', label: '向量化', icon: Database },
  { key: 'llm', label: '对话模型', icon: Languages },
  { key: 'services', label: '服务配置', icon: Server },
  { key: 'storage', label: '存储配置', icon: Folder },
  // **本机档专属**（M3 阶段 6）：知识库在壳里那台 NAS 上，连接状态与地址在这儿看。
  // 浏览器 / NAS 网页端没有这一节（那一档知识库就是它自己）——入口由 `navGroups`
  // 那一层按 `provider.gate` 摘掉，见下面 `visibleSections` 那一段。
  { key: 'knowledge', label: '知识库连接', icon: BookOpen },
  // **同为「本机档专属」的两节**（M5 阶段 7）：备份的四项配置与"库里那几处明文凭据"。
  // 判据同样是本机档（不是"备份提供者 ready"）：远端连不上正是要看队列的时候；
  // 入口由 `visibleSections` 按 `backup.gate` 摘掉。
  { key: 'backup', label: '备份', icon: Archive },
  { key: 'credentials', label: '凭据', icon: KeyRound },
  { key: 'system', label: '系统与安全', icon: CircleUser },
  { key: 'appearance', label: '外观', icon: Moon },
  { key: 'shortcuts', label: '快捷键', icon: Keyboard },
]

export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  /**
   * 知识库提供者（M3 阶段 6）：只用来决定**「知识库连接」这一节有没有入口**——
   * 本机档才有它（浏览器 / NAS 网页端那一档知识库就是它自己）。
   * 真正的读写在那节自己身上（自读自管，与 `StorageSection` 同一形态）。
   */
  const provider = useKnowledgeProviderStatus()
  /**
   * 备份的状态（M5 阶段 7）：**只用来决定「备份」「凭据」两节有没有入口**——
   * 判据是本机档（`gate`），不是"提供者 ready"（那两节在远端连不上时才有用）。
   * 真正的读写在那两节自己身上（自读自管，与 `StorageSection` 同一形态）。
   */
  const backup = useBackupStatus()

  /** 打开设置落在「模型注册」——它是配置模型的主路径。 */
  const [section, setSection] = useState<SectionKey>('registry')
  /** 正在编辑的分组（null = 仍在浏览态）。 */
  const [editing, setEditing] = useState<SettingGroup | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null)
  const [bindingSlot, setBindingSlot] = useState('')

  // 这三条读**都跟着 `open` 走**：这个弹窗**一直挂在树上**（`AccountMenu` 那头关一次只是
  // 把 `open` 置回 false），没有 `enabled` 就是每个页面加载都各白读一趟
  // （`/settings` / 模型注册 / `/health`）——而那三趟**只在这一页用得上**。
  // （2026-10-09：原先这里还有一条 `/auth/status`，随账号死面一起删了。）
  const settings = useQuery({ queryKey: SETTINGS_QUERY_KEY, queryFn: getSettings, enabled: open })
  const registry = useQuery({
    queryKey: REGISTRY_QUERY_KEY,
    queryFn: getRegistry,
    enabled: open,
  })

  const health = useQuery({
    queryKey: ['health'],
    queryFn: fetchHealth,
    retry: false,
    enabled: open,
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

  /**
   * 下拉选项：空值 = 未指定，其余是"模型名 · 维度 · 供应商"。
   *
   * **维度写进选项里**（v0.53）：嵌入/重排原先在选中项下面另跟一行摘要（`slotSummary`）
   * 把同一个模型再报一遍——用户圈着它说"这不就是同一个东西说两遍"。维度是**另一份
   * 信息**，不该连它一起丢，所以并进标签：只说一遍，而且在"选哪个"的那一刻就看得见。
   * 对话模型没有维度，标签与原先一字不差。
   */
  const slotOptions = (slot: string) => [
    { value: '', label: '未指定' },
    ...bindableModels(slot).map((model) => ({
      value: model.id,
      label: [
        model.label || model.model_id,
        model.dim ? `${model.dim} 维` : '',
        model.provider_name,
      ]
        .filter(Boolean)
        .join(' · '),
    })),
  ]

  /**
   * 值的摘要行里把下拉标签搬进来时，要**摘掉「（默认）」**：它只是选项列表里的标记，
   * 搬到摘要里会变成「思考开（中（默认））」这种括号套括号（2026-09-24 用户反馈）。
   * 只摘这一个标记，摘不出东西就原样返回——不去猜别的写法。
   */
  const inlineLabel = (label: string): string => label.replace('（默认）', '').trim() || label

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

  const visibleSections = SECTIONS.filter(
    (item) =>
      // 「知识库连接」只有本机档才有（M3 阶段 6）：服务器档里那一节的入口**不存在**
      // （点了只会看到一句"只有本机档才有"，不如不给入口）
      (item.key !== 'knowledge' || provider.gate) &&
      // 「备份」「凭据」同理（M5 阶段 7），但**判据不是"备份提供者 ready"**：
      // 远端连不上时正是要看"还有几份没备上去"的时候（备份是本地动作）。
      (item.key !== 'backup' || backup.gate) &&
      (item.key !== 'credentials' || backup.gate),
  )
  const navGroups = [
    { label: '模型', keys: ['registry', 'models', 'llm'] as SectionKey[] },
    {
      label: '服务',
      keys: ['services', 'storage', 'knowledge', 'backup', 'credentials'] as SectionKey[],
    },
    { label: '功能', keys: featureGroups.map((item) => `feature:${item.key}` as SectionKey) },
    { label: '系统', keys: ['system'] as SectionKey[] },
    { label: '偏好', keys: ['appearance', 'shortcuts'] as SectionKey[] },
  ]
    .map((item) => ({
      label: item.label,
      items:
        item.label === '功能'
          ? featureGroups.map((group) => ({
              key: `feature:${group.key}` as SectionKey,
              label: group.label,
              // 齿轮 = 设置（与账号菜单里那一项同一颗）。原来用的「双滑杆」在全站
              // 只在这一处出现，读不出"这是一组设置"，也是评审说的那颗"圆点折线"。
              icon: Settings,
            }))
          : visibleSections.filter((entry) => item.keys.includes(entry.key)),
    }))
    .filter((item) => item.items.length > 0)

  const activeFeatureKey =
    typeof section === 'string' && section.startsWith('feature:') ? section.slice(8) : ''

  const save = useMutation({
    // 与 `SettingGroupPanel` 用同一条整理：**留空的密钥不发**。这一页编辑
    // MinerU / PaddleOCR 时会走到它，照发同样会把 token 抹掉（见 `settingsPayloadOf`）
    mutationFn: (target: SettingGroup) => updateSettings(settingsPayloadOf(target, draft)),
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
            <div key={navGroup.label} className="m-nav-block">
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
                  <h3 className="m-section-title">向量化</h3>

                  <div className="m-slot-field">
                    <div className="m-slot-head">
                      <span className="m-slot-label">
                        默认嵌入模型
                        {/* 「建好即冻结」是**选择前必须知道的代价**（不可逆），保留；
                            原来那句"未指定时无法新建知识库"与下面那行状态是同一件事，删 */}
                        <InfoTip text="建好即冻结，之后不能换。" />
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
                    {!embeddingConfigured && <p className="m-row-note">未选定前不能新建知识库。</p>}
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
                      <span className="m-slot-label">重排模型</span>
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
                              /* 「留空即恢复内置提示词」是**这一格的填法**，写进 placeholder */
                              placeholder="留空 = 用内置提示词"
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
                  <h3 className="m-section-title">对话模型（LLM）</h3>

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
                    {/* **三个用途格都不再跟一行摘要**（v0.53 统一）：那一行拼出来的串与
                        下拉里选中的那串是同一个模型，等于把选中值说两遍。对话那一格在
                        2026-09-24 就先删了（「DeepSeek Flash · 深度求索」说两遍）；
                        嵌入/重排当时以"摘要带维度、是另一份信息"为由留着，用户 2026-09-27
                        圈着它说"这不就是同一个东西说两遍"——**维度并进了选项标签**，
                        信息没丢，但只说一遍（见 slotOptions）。 */}
                    {!chatConfigured && (
                      <p className="m-row-note">未选定时「对话」与标题生成不可用。</p>
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
                      <span className="m-row-label">温度 / 深度思考</span>
                      <span className="m-row-value tabular">
                        温度 {fieldValue('llm', 'llm.temperature') || '—'}
                        <span className="sep">·</span>
                        {fieldValue('llm', 'llm.enable_thinking') === 'true'
                          ? `思考开 · ${inlineLabel(
                              selectLabel(
                                'llm',
                                'llm.thinking_effort',
                                fieldValue('llm', 'llm.thinking_effort'),
                              ),
                            )}`
                          : '思考关'}
                      </span>
                    </div>
                    {group('llm') && <Button onClick={() => openEdit(group('llm')!)}>编辑</Button>}
                  </div>
                  {/* 原先这里在思考开着时挂一句「更慢、更费 token。」：那是**替用户下结论**
                      的废话（2026-09-24 删），代价在他的账上，不在界面上 */}
                  <h3 className="m-section-title m-section-gap">对话行为</h3>
                  <div className="m-row">
                    <div className="m-row-main">
                      {/* 提示词不与这一页相干：它跟**知识库**绑定，在「知识库 → 设置 → 回答要求」
                          里改。原先这里挂一句跨页指路的常显文字，2026-09-24 用户反馈后删掉——
                          管别页的事别写到这一页上 */}
                      <span className="m-row-label">检索与生成</span>
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
                  <h3 className="m-section-title">服务配置</h3>

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
          {section === 'knowledge' && <KnowledgeConnectionSection />}
          {/* 「备份」这一节尾部那条入口要能把浮层关掉再跳（R5：它是 `/backup` 唯一入口） */}
          {section === 'backup' && (
            <BackupSection
              onOpenPage={() => {
                onClose()
                void navigate('/backup')
              }}
            />
          )}
          {section === 'credentials' && <CredentialsSection />}
          {section === 'appearance' && <AppearanceSection />}
          {section === 'shortcuts' && <ShortcutsSection />}

          {/* 功能（动态）：后端那些"没有专门归属"的设置组，在这里自动出现。
              已经各有归属的那几组不在这里（v0.26）：长期记忆在记忆页、
              联网与沙箱执行在能力页。渲染的活交给 `SettingGroupPanel`，
              与模块页共用同一个组件——同一组设置在两处长得不一样是不能接受的。
              **`showTips={false}`**（R5）：组提示 / 编辑提示那两行解释在弹窗里不再渲染，
              模块页那边照旧（用户说的是"设置里解释太多了"）。 */}
          {activeFeatureKey && <SettingGroupPanel keys={[activeFeatureKey]} showTips={false} />}

          {section === 'system' && (
            <>
              <h3 className="m-section-title">系统与安全</h3>

              {/* 2026-10-09：这一节原先还有「当前账号 / 修改密码 / 退出登录」那一块与
                  下面那行「访问鉴权」（读 `/auth/status`）——账号死面整块删了，
                  见 `SECTIONS` 之前那一段。**留下的只有"后端在不在"这一行**：
                  它是这一节现在唯一能说、也真说得准的一句话。 */}
              <div className="m-row">
                <div className="m-row-main">
                  <span className="m-row-label">后端状态</span>
                  {/* 原先这里写「在线 v0.1.1 · v1」：版本号是给维护者看的，用户只需要知道在不在
                      （右边的状态点已经说了），异常原文也不该往界面上搬（2026-09-24 用户反馈） */}
                </div>
                <StatusTag
                  tone={health.data ? 'success' : 'danger'}
                  label={health.data ? '在线' : '不可达'}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}
