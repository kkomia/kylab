<script setup lang="ts">
/**
 * 设置弹窗（《前端设计规范》§5、《界面信息架构草案》§3）。
 *
 * 为什么设置从页面变成弹窗：设置是**动作**——改完就走，不需要一个常驻的地址，
 * 也不需要用户在改完模型之后还要"离开设置页"。侧栏底部一个入口点开即可，
 * 改完关掉，回到他原来在看的页面。
 *
 * 内部用左侧分组菜单 + 右侧内容：
 * - 模型配置（向量化 / 重排）
 * - 对话模型（LLM / 对话行为）
 * - 服务配置（MinerU / PaddleOCR）
 * - 存储配置（只读）
 * - 系统与安全（只读）
 * - **功能**（长期记忆 / 联网 / 沙箱执行…）：这一组**不是手写的菜单**，
 *   而是"后端返回了、但上面几节没有专门渲染"的那些组，自动出现。
 *
 * 密钥永不回显明文：接口给掩码，输入框留空表示"不改动"。
 *
 * **为什么要有自动出现的那一组**：设置组由后端 `SETTING_GROUPS` 定义，
 * 而菜单曾经是一张手写清单（向量化 / 对话模型 / MinerU / PaddleOCR）——
 * 于是后端加一组（长期记忆、联网、沙箱执行）在界面上**根本没有入口**：
 * 用户看到的是"哪里有长期记忆了？"，而别处的提示还写着"到设置里打开它"。
 * 现在没有专门渲染的组会自动出现在「功能」下，**没有人需要记得去改菜单**。
 */
import { computed, onMounted, ref, watch, type Component } from 'vue'

import { MIN_PASSWORD_CHARS } from '@/api/auth'
import { compactStorage, getStorageOverview, type StorageOverview } from '@/api/maintenance'
import { fetchHealth, type HealthResponse } from '@/api/health'
import { bindSlot, type RegisteredModel, type Slot } from '@/api/modelRegistry'
import {
  getAuthStatus,
  getSettings,
  testConnection,
  updateSettings,
  type AuthStatus,
  type SettingGroup,
  type SettingsView,
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
import IconChat from '@/components/icons/IconChat.vue'
import IconCheck from '@/components/icons/IconCheck.vue'
import IconDatabase from '@/components/icons/IconDatabase.vue'
import IconFolder from '@/components/icons/IconFolder.vue'
import IconLogout from '@/components/icons/IconLogout.vue'
import IconRefresh from '@/components/icons/IconRefresh.vue'
import IconRobot from '@/components/icons/IconRobot.vue'
import IconServer from '@/components/icons/IconServer.vue'
import IconSettings from '@/components/icons/IconSettings.vue'
import IconShieldCheck from '@/components/icons/IconShieldCheck.vue'
import IconSun from '@/components/icons/IconSun.vue'
import IconUser from '@/components/icons/IconUser.vue'
import ModelRegistryPanel from '@/components/settings/ModelRegistryPanel.vue'
import AppButton from '@/components/ui/AppButton.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppModal from '@/components/ui/AppModal.vue'
import AppSelect from '@/components/ui/AppSelect.vue'
import InfoTip from '@/components/ui/InfoTip.vue'
import StatusTag from '@/components/ui/StatusTag.vue'
import { formatBytes } from '@/composables/useFormat'
import { useToast } from '@/composables/useToast'
import { useFontScale } from '@/composables/useFontScale'
import { changeOwnPassword, isAdmin } from '@/composables/useSession'
import { currentUser } from '@/composables/useSessionToken'
import { setTheme, themeMode, type ThemeMode } from '@/composables/useTheme'
import { useKnowledgeBaseStore } from '@/stores/knowledgeBases'
import { useModelRegistryStore } from '@/stores/modelRegistry'

const open = defineModel<boolean>('open', { required: true })

/**
 * 退出登录由外壳（SideNav）执行：它还要清空两个 Pinia store 与名册缓存，
 * 而那是"整个会话"的事，不适合塞进一个设置弹窗里。
 */
const emit = defineEmits<{ logout: [] }>()

type SectionKey =
  | 'registry'
  | 'models'
  | 'llm'
  | 'services'
  | 'storage'
  | 'appearance'
  | 'users'
  | 'system'
  | 'features'

/** 已经由上面那些"专门一节"渲染过的设置组；其余自动进「功能」。 */
const RENDERED_GROUP_KEYS = new Set(['embedding', 'llm', 'chat', 'mineru', 'paddleocr'])

/**
 * 左侧菜单（对齐 Kimi 桌面端 / wekora 的设置菜单）：
 * **分组标题 + 图标 + 单行标签**，每项下面不再挂一句小字解释。
 *
 * 之前每项都有 hint，八行并排时八句灰字——扫视时先撞到的是解释，
 * 而菜单要回答的只是"去哪一组"。解释属于内容区，进来再说。
 */
const SECTIONS: {
  key: SectionKey
  label: string
  icon: Component
  adminOnly?: boolean
}[] = [
  // **「模型」放在最前**：它是配置模型的主路径（供应商 → 模型 → 用途）
  { key: 'registry', label: '模型注册', icon: IconRobot },
  // 这两组是回退用的精细字段：没在「模型」里绑定的用途，按这里的字段走
  { key: 'models', label: '向量化', icon: IconDatabase },
  { key: 'llm', label: '对话模型', icon: IconChat },
  { key: 'services', label: '服务配置', icon: IconServer },
  { key: 'storage', label: '存储配置', icon: IconFolder },
  // 只有管理员能看：/users 的写与管理端点是管理员级（`require_admin`）
  { key: 'users', label: '用户', icon: IconUser, adminOnly: true },
  { key: 'system', label: '系统与安全', icon: IconShieldCheck },
  { key: 'appearance', label: '外观', icon: IconSun },
]

/** 菜单分组。分组标题是唯一的小字——它标段落，不解释条目。 */
const NAV_GROUPS: { label: string; keys: SectionKey[]; dynamic?: boolean }[] = [
  { label: '模型', keys: ['registry', 'models', 'llm'] },
  { label: '服务', keys: ['services', 'storage'] },
  // 后端那些"还没有专门一节"的组（长期记忆 / 联网 / 沙箱执行…）
  { label: '功能', keys: [], dynamic: true },
  { label: '账户', keys: ['users', 'system'] },
  { label: '偏好', keys: ['appearance'] },
]

const store = useKnowledgeBaseStore()
const { notifySuccess, notifyError } = useToast()

/** 打开设置落在「模型」——它是配置模型的主路径（供应商 → 模型 → 用途）。 */
const section = ref<SectionKey>('registry')
const health = ref<HealthResponse | null>(null)
const healthError = ref('')
const config = ref<SettingsView | null>(null)
const loadError = ref('')
/** 后端鉴权状态。这个端点本身不鉴权，所以拿不到也不该让设置页报错。 */
const authStatus = ref<AuthStatus | null>(null)
/** 令牌输入框的草稿（保存前不落到存储里）。 */

// 字号是本地偏好，不进后端：直接读 composable，不做 save 流程
const { scale: fontScale, options: fontOptions, setFontScale } = useFontScale()
const currentScaleHint = computed(
  () => fontOptions.find((item) => item.name === fontScale.value)?.hint ?? '',
)

/** 主题三档（第二轮评审批注 2）：与字号同样用卡片式选择器，放在「外观」里。 */
const THEME_OPTIONS: { name: ThemeMode; label: string; hint: string }[] = [
  { name: 'system', label: '跟随系统', hint: '随设备明暗自动切换' },
  { name: 'light', label: '浅色', hint: '始终使用纸白' },
  { name: 'dark', label: '深色', hint: '始终使用近黑' },
]

/**
 * 修改自己的密码（v10 账号体系）。
 *
 * 三处与后端对齐的约束，前端先拦一遍是为了省一次往返、也让错误就近显示：
 * 新密码长度（后端 MIN_PASSWORD_CHARS）、两次一致、当前密码非空。
 * 真正的判定仍在后端——前端校验只是体验，不是安全边界。
 */
const oldPassword = ref('')
const newPassword = ref('')
const confirmNewPassword = ref('')
const changingPassword = ref(false)
const passwordError = ref('')

async function submitPasswordChange(): Promise<void> {
  passwordError.value = ''
  if (!oldPassword.value || !newPassword.value) {
    passwordError.value = '请填写当前密码与新密码'
    return
  }
  if (newPassword.value.length < MIN_PASSWORD_CHARS) {
    passwordError.value = `新密码至少 ${MIN_PASSWORD_CHARS} 个字符`
    return
  }
  if (newPassword.value !== confirmNewPassword.value) {
    passwordError.value = '两次输入的新密码不一致'
    return
  }
  changingPassword.value = true
  try {
    const result = await changeOwnPassword(oldPassword.value, newPassword.value)
    oldPassword.value = ''
    newPassword.value = ''
    confirmNewPassword.value = ''
    notifySuccess(
      result.revoked_sessions > 0
        ? `密码已更新，其他 ${result.revoked_sessions} 处登录已退出`
        : '密码已更新',
    )
  } catch (error) {
    passwordError.value = error instanceof Error ? error.message : '修改失败，请重试'
  } finally {
    changingPassword.value = false
  }
}

// ------------------------------------------------------------------ 用户（v10）

/**
 * 用户分组只对管理员开放。
 *
 * 身份还没验完（`currentUser` 为 null）时**不开放**：v0.11 起没有第二种凭据，
 * null 只可能是"会话正在恢复"。用户管理是管理员专属，宁可晚一拍出现，
 * 也不要在成员登录的一瞬间把管理入口亮出来。
 */
const canManageUsers = computed(() => isAdmin.value)

/**
 * 后端返回、但上面几节没有专门渲染的设置组（长期记忆 / 联网 / 沙箱执行…）。
 *
 * **它是这一段的关键**：菜单原先是手写的，于是后端加一组就等于"界面上没有入口"——
 * 用户的实际反馈就是一句"这哪里有长期记忆了？"，而记忆页与工具报错都还在
 * 指引他"到「设置 → 长期记忆」打开"。这里改成按后端返回的组算，
 * 以后加组的人不需要记得回来改菜单。
 */
const featureGroups = computed(() =>
  (config.value?.groups ?? []).filter((item) => !RENDERED_GROUP_KEYS.has(item.key)),
)

const visibleSections = computed(() => {
  const fixed = SECTIONS.filter((item) => !item.adminOnly || canManageUsers.value)
  if (featureGroups.value.length === 0) return fixed.filter((item) => item.key !== 'features')
  return fixed
})
/** 菜单按分组渲染：组成员被权限过滤掉（如成员的「用户」）后，空组不占位。 */
const visibleGroups = computed(() =>
  NAV_GROUPS.map((group) => ({
    label: group.label,
    items: group.dynamic
      ? featureGroups.value.map((item) => ({
          key: item.key as SectionKey,
          label: item.label,
          icon: IconSettings,
        }))
      : visibleSections.value.filter((item) => group.keys.includes(item.key)),
  })).filter((group) => group.items.length > 0),
)

/** 当前这一节对应哪个后端设置组（「功能」那几节是动态键，直接就是组 key）。 */
const activeGroup = computed(() => group(section.value))

const users = ref<RosterUser[]>([])
const usersLoading = ref(false)
const usersError = ref('')

const ROLE_OPTIONS: { value: UserRole; label: string }[] = [
  { value: 'member', label: '成员' },
  { value: 'admin', label: '管理员' },
]

const newName = ref('')
const newUsername = ref('')
const newAccountPassword = ref('')
const newRole = ref<UserRole>('member')
const creatingUser = ref(false)
const createError = ref('')

/**
 * 开通表单是否展开。**默认收起**：与「添加供应商」同一套交互——
 * 一个四字段的表单常驻在列表上方，会把"成员与名册"推下去，
 * 用户每次进来都先看到一堆空输入框，而他多半只是来看名单的。
 */
const addingUser = ref(false)

function toggleAdding(): void {
  addingUser.value = !addingUser.value
  createError.value = ''
}

async function loadUsers(): Promise<void> {
  usersLoading.value = true
  try {
    users.value = (await listUsers()).items
    usersError.value = ''
  } catch (error) {
    usersError.value = error instanceof Error ? error.message : '用户列表加载失败'
  } finally {
    usersLoading.value = false
  }
}

async function submitCreateUser(): Promise<void> {
  createError.value = ''
  const name = newName.value.trim()
  const username = newUsername.value.trim()
  if (!name) {
    createError.value = '请填写显示名'
    return
  }
  if (!username) {
    createError.value = '请填写登录名'
    return
  }
  if (newAccountPassword.value.length < MIN_PASSWORD_CHARS) {
    createError.value = `初始密码至少 ${MIN_PASSWORD_CHARS} 个字符`
    return
  }
  creatingUser.value = true
  try {
    const created = await createUser({
      name,
      username,
      password: newAccountPassword.value,
      role: newRole.value,
    })
    newName.value = ''
    newUsername.value = ''
    newAccountPassword.value = ''
    newRole.value = 'member'
    // 开通成功就收起表单：接着多半去核对名单，留在原地只会挡住列表
    addingUser.value = false
    notifySuccess(`已开通账号「${created.username}」`)
    await loadUsers()
  } catch (error) {
    createError.value = error instanceof Error ? error.message : '开通失败'
  } finally {
    creatingUser.value = false
  }
}

/** 重置密码（弹窗）：改完会吊销对方所有登录会话，文案要说清。 */
const resetTarget = ref<RosterUser | null>(null)
const resetDraft = ref('')
const resetting = ref(false)
const resetError = ref('')

function openReset(person: RosterUser): void {
  resetTarget.value = person
  resetDraft.value = ''
  resetError.value = ''
}

/** 弹窗用 `:open` + `@update:open` 受控：Esc / 点遮罩关闭时也要把目标清掉。 */
function onResetOpenChange(value: boolean): void {
  if (!value) resetTarget.value = null
}

async function submitReset(): Promise<void> {
  const target = resetTarget.value
  if (!target) return
  if (resetDraft.value.length < MIN_PASSWORD_CHARS) {
    resetError.value = `密码至少 ${MIN_PASSWORD_CHARS} 个字符`
    return
  }
  resetting.value = true
  try {
    await resetUserPassword(target.id, resetDraft.value)
    resetTarget.value = null
    notifySuccess(`已重置「${target.name}」的密码，其登录会话已全部失效`)
    await loadUsers()
  } catch (error) {
    resetError.value = error instanceof Error ? error.message : '重置失败'
  } finally {
    resetting.value = false
  }
}

async function toggleDisabled(person: RosterUser): Promise<void> {
  try {
    const updated = await setUserDisabled(person.id, !person.disabled)
    notifySuccess(updated.disabled ? `已禁用「${updated.name}」` : `已启用「${updated.name}」`)
    await loadUsers()
  } catch (error) {
    notifyError(error instanceof Error ? error.message : '操作失败')
  }
}

/** 删除账号（弹窗确认）：文档保留但归属置空，这一点必须说清。 */
const deleteTarget = ref<RosterUser | null>(null)
const deletingUser = ref(false)

function openDelete(person: RosterUser): void {
  deleteTarget.value = person
}

function onDeleteOpenChange(value: boolean): void {
  if (!value) deleteTarget.value = null
}

async function confirmDeleteUser(): Promise<void> {
  const target = deleteTarget.value
  if (!target) return
  deletingUser.value = true
  try {
    await deleteUser(target.id)
    deleteTarget.value = null
    notifySuccess(`已删除「${target.name}」；其文档保留，归属置空`)
    await loadUsers()
  } catch (error) {
    notifyError(error instanceof Error ? error.message : '删除失败')
  } finally {
    deletingUser.value = false
  }
}

/** 切到用户分组就拉一次；用户可能在别处（另一个标签页）新建过账号。 */
watch(section, (value) => {
  if (value === 'users') void loadUsers()
  if (value === 'storage') void loadStorage()
  // 换一节就把编辑态收掉：留着的话，切到另一节会看到上一节的表单
  editing.value = null
  testResult.value = null
})

// ------------------------------------------------------------------ 存储维护（v17）

const storage = ref<StorageOverview | null>(null)
const storageError = ref('')
const storageLoading = ref(false)
const compacting = ref(false)
const compactConfirmOpen = ref(false)

async function loadStorage(): Promise<void> {
  storageLoading.value = true
  try {
    storage.value = await getStorageOverview()
    storageError.value = ''
  } catch (error) {
    // 权限不足或后端不可达都不该把设置页弄崩：这一块单独显示原因
    storageError.value = error instanceof Error ? error.message : '读取存储信息失败'
  } finally {
    storageLoading.value = false
  }
}

/**
 * 整理存储。**先确认再动手**：VACUUM 会重写整个数据库文件，
 * 大库要几十秒，期间写请求会被 SQLite 挡住。
 */
async function runCompact(): Promise<void> {
  compacting.value = true
  try {
    const before = storage.value?.free_bytes ?? 0
    storage.value = await compactStorage()
    compactConfirmOpen.value = false
    const freed = before - storage.value.free_bytes
    notifySuccess(freed > 0 ? `已回收 ${formatBytes(freed)}` : '存储已整理')
  } catch (error) {
    notifyError(error instanceof Error ? error.message : '整理失败')
  } finally {
    compacting.value = false
  }
}

/** 正在编辑的分组（null = 仍在浏览态）。 */
const editing = ref<SettingGroup | null>(null)
const draft = ref<Record<string, string>>({})
const saving = ref(false)
const testing = ref(false)
const testResult = ref<{ ok: boolean; detail: string } | null>(null)

// 每次打开都重新读一次：配置可能被另一个标签页改过，也可能后端刚重启
watch(open, (value) => {
  if (value) {
    void refresh()
    if (section.value === 'users') void loadUsers()
  }
})

onMounted(() => {
  if (open.value) void refresh()
})

async function refresh(): Promise<void> {
  try {
    health.value = await fetchHealth()
    healthError.value = ''
  } catch (error) {
    healthError.value = error instanceof Error ? error.message : '后端不可达'
  }
  // 鉴权状态：这个端点本身不鉴权，所以拿不到也不该让整个设置页报错
  try {
    authStatus.value = await getAuthStatus()
  } catch {
    authStatus.value = null
  }
  try {
    config.value = await getSettings()
    loadError.value = ''
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : '配置读取失败'
  }
  await loadRegistry()
}

// ------------------------------------------------------------------ 默认模型

/**
 * 模型注册表：本面板只**读**它，用来列出"可以选为默认的模型"。
 *
 * v0.8 归属整理：模型注册只负责登记，"哪个用途用哪个模型"在各自的分组里选
 * （向量化 / 对话模型）。所以这里不再做注册，只做选择。
 *
 * **读写共用 `useModelRegistryStore` 这一份缓存**（原先本弹窗与「模型注册」面板
 * 各存一份，于是刚登记完模型、切到「向量化」下拉里根本没有它，要关掉弹窗重开
 * 才刷新——实测 bug）。现在任何一处登记完都调 `load()` 刷新同一份，
 * 所有引用它的分组、以及知识库页会一起更新。
 */
const modelRegistry = useModelRegistryStore()

const registry = computed(() => modelRegistry.registry)

async function loadRegistry(): Promise<void> {
  // 失败不清空：store 保留上一份可用数据，只在 error 里记一笔
  // （读不到就让选择框退化成"未指定"，比整页报错好）
  await modelRegistry.load()
}

/** 用途 → 当前状态（未绑定时后端也会给一条，`configured` 为假）。 */
function slotOf(key: string): Slot | undefined {
  return registry.value?.slots.find((item) => item.slot === key)
}

/** 可以绑到某个用途的模型：声明了该能力，或压根没声明（旧数据不拦）。 */
function bindableModels(slot: string): RegisteredModel[] {
  const capability = slotOf(slot)?.capability ?? slot
  return (registry.value?.models ?? []).filter((model) => {
    const owner = registry.value?.providers.find((p) => p.id === model.provider_id)
    if (!owner || !owner.enabled) return false
    return model.capabilities.length === 0 || model.capabilities.includes(capability)
  })
}

/** 下拉选项：空值 = 未指定，其余是"模型名 · 供应商"。 */
function slotOptions(slot: string): { value: string; label: string }[] {
  return [
    { value: '', label: '未指定' },
    ...bindableModels(slot).map((model) => ({
      value: model.id,
      label: `${model.label || model.model_id} · ${model.provider_name}`,
    })),
  ]
}

const bindingSlot = ref('')

async function onBindSlot(slot: string, value: string): Promise<void> {
  bindingSlot.value = slot
  try {
    await bindSlot(slot, value || null)
    await refresh()
    notifySuccess(value ? '默认模型已更新' : '已取消默认模型')
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '保存失败')
  } finally {
    bindingSlot.value = ''
  }
}

/** 是否已选定默认嵌入模型。为假时不能建库（与后端同一口径）。 */
const embeddingConfigured = computed(() => slotOf('embedding')?.configured ?? false)
const chatConfigured = computed(() => slotOf('chat')?.configured ?? false)

/**
 * 选中模型的"身份证"：名称 · 维度 · 供应商。
 *
 * 未选定时返回空串——选择器里已经写着「未指定」了，再跟一行同样的字只是噪声。
 */
function slotSummary(slot: string): string {
  const state = slotOf(slot)
  if (!state?.configured) return ''
  const model = registry.value?.models.find((item) => item.id === state.bound_model_pk)
  if (!model) return state.bound_model_label || '—'
  const dim = model.dim ? ` · ${model.dim} 维` : ''
  return `${model.label || model.model_id}${dim} · ${state.provider_name}`
}

function group(key: string): SettingGroup | undefined {
  return config.value?.groups.find((item) => item.key === key)
}

function fieldValue(groupKey: string, fieldKey: string): string {
  return group(groupKey)?.fields.find((item) => item.key === fieldKey)?.value ?? ''
}

function isConfigured(groupKey: string, fieldKey: string): boolean {
  return group(groupKey)?.fields.find((item) => item.key === fieldKey)?.configured ?? false
}

/** select 字段当前值的显示文案。候选值来自后端，前端不做一份映射表。 */
function selectLabel(groupKey: string, fieldKey: string, value: string): string {
  const field = group(groupKey)?.fields.find((item) => item.key === fieldKey)
  return field?.options.find((option) => option.value === value)?.label ?? value
}

function secretSummary(groupKey: string, fieldKey: string): string {
  return isConfigured(groupKey, fieldKey) ? fieldValue(groupKey, fieldKey) : '未配置'
}

/**
 * 动态那一节里，一个字段值的显示文案。
 *
 * 按类型分开写是因为它们**该说的话不一样**：布尔说"开启/关闭"（说成 true/false
 * 等于没翻译），密钥说"已配置/未配置"（值本身是掩码，但"没配"要一眼看出），
 * 其余取值本身。空值统一给个破折号——留空白会让人以为界面坏了。
 */
function fieldSummary(field: SettingGroup['fields'][number]): string {
  if (field.type === 'bool') return field.value === 'true' ? '开启' : '关闭'
  if (field.type === 'secret') return field.configured ? field.value : '未配置'
  if (field.type === 'select') {
    return field.options.find((option) => option.value === field.value)?.label ?? field.value
  }
  return field.value || '—'
}

/** 动态那一节的一句话说明（只给需要解释的几组写，其余不硬凑）。 */
function groupTip(key: string): string {
  const tips: Record<string, string> = {
    memory:
      '长期记忆要单独跑一个记忆服务（ReMe），而且它会调模型（捕获与整合）。' +
      '关着也能用：那四份人设文件是磁盘上的普通文件，照常注入、也能记住东西；' +
      '这道开关管的是另一半——过去的对话会不会被召回、会不会自动沉淀。',
    web: '搜索需要一个服务商密钥（Tavily / 博查）。抓网页不需要密钥，但只访问公网地址。',
    sandbox: '在你这台机器上执行命令。默认「先问」：这是权限最大的一个动作。',
  }
  return tips[key] ?? ''
}

/** 编辑态的那句提示（原来只写死了 llm 与"其它"两句，现在按组给）。 */
function editHint(key: string): string {
  const hints: Record<string, string> = {
    llm: '推理模型打开深度思考后会更慢、更费 token。关掉它更快，但难题上的推导会浅一些。',
    memory: '关掉之后：过去的对话不再被召回、也不会自动沉淀；人设文件与「记住」照常工作。',
    web: '密钥只回显掩码。留空表示不改动；要清掉它请用下方「清除」入口。',
    sandbox: '三张清单的语法照抄 Claude Code：Bash(git status:*) 这样写，拒绝优先于放行。',
  }
  return hints[key] ?? ''
}

/**
 * 浏览态的对话模型连通性测试。
 *
 * 与编辑态的 `testResult` 分开：编辑态测的是"输入框里这一份"，浏览态测的是
 * "线上正在用的这一份"。共用一个变量的话，在编辑态点过测试再返回，
 * 浏览态会继续显示上一份配置的结论——那比不显示更容易误导。
 */
const llmTest = ref<{ ok: boolean; detail: string } | null>(null)
const llmTesting = ref(false)

async function testLlm(): Promise<void> {
  llmTesting.value = true
  try {
    llmTest.value = await testConnection('llm')
  } catch (error) {
    llmTest.value = { ok: false, detail: error instanceof Error ? error.message : '测试失败' }
  } finally {
    llmTesting.value = false
  }
}

function openEdit(target: SettingGroup): void {
  editing.value = target
  testResult.value = null
  const next: Record<string, string> = {}
  for (const field of target.fields) {
    next[field.key] = field.type === 'secret' ? '' : field.value
  }
  draft.value = next
}

async function save(): Promise<void> {
  if (!editing.value) return
  const values = editing.value.fields.map((field) => ({
    key: field.key,
    value: draft.value[field.key] ?? '',
  }))

  saving.value = true
  try {
    const result = await updateSettings(values)
    if (result.rejected.length > 0) {
      notifyError(`以下配置项不被接受：${result.rejected.join('、')}`)
      return
    }
    notifySuccess('配置已保存，下一个任务即刻生效')
    editing.value = null
    await refresh()
  } catch (error) {
    notifyError(error instanceof Error ? error.message : '保存失败')
  } finally {
    saving.value = false
  }
}

async function runTest(target: string): Promise<void> {
  testing.value = true
  testResult.value = null
  try {
    testResult.value = await testConnection(target)
  } catch (error) {
    testResult.value = {
      ok: false,
      detail: error instanceof Error ? error.message : '测试失败',
    }
  } finally {
    testing.value = false
  }
}
</script>

<template>
  <AppModal v-model:open="open" size="wide" height="tall" title="设置">
    <div class="settings">
      <!-- 左：分组菜单（Kimi / wekora 式：分组标题 + 图标 + 单行标签） -->
      <nav class="settings-nav" aria-label="设置分组">
        <template v-for="navGroup in visibleGroups" :key="navGroup.label">
          <p class="nav-group">{{ navGroup.label }}</p>
          <button
            v-for="item in navGroup.items"
            :key="item.key"
            class="nav-entry"
            :class="{ 'nav-entry-active': section === item.key }"
            type="button"
            @click="((section = item.key), (editing = null), (addingUser = false))"
          >
            <component :is="item.icon" class="nav-icon" />
            <span class="nav-label">{{ item.label }}</span>
          </button>
        </template>
      </nav>

      <!-- 右：内容 -->
      <div class="settings-body">
        <p v-if="loadError" class="error-line">{{ loadError }}</p>

        <!-- 模型注册：**只登记模型**（供应商 → 模型清单） -->
        <template v-if="section === 'registry'">
          <ModelRegistryPanel />
        </template>

        <!-- 向量化：只在这里**选**默认模型；登记在「模型注册」里做（v0.8 归属整理） -->
        <template v-else-if="section === 'models'">
          <template v-if="editing?.key === 'embedding'">
            <h3 class="section-title">编辑 {{ editing.label }}</h3>
            <div class="edit-form">
              <label v-for="field in editing.fields" :key="field.key" class="edit-field">
                <span class="edit-label">{{ field.label }}</span>
                <AppInput
                  v-model="draft[field.key]"
                  :type="field.type === 'int' ? 'number' : 'text'"
                />
              </label>
              <p class="edit-hint">批大小影响单次请求的文本条数，太大可能被端点拒绝。</p>
            </div>
            <div class="edit-actions">
              <AppButton @click="editing = null">返回</AppButton>
              <AppButton variant="primary" :disabled="saving" @click="save">
                {{ saving ? '保存中…' : '保存' }}
              </AppButton>
            </div>
          </template>

          <template v-else>
            <h3 class="section-title">
              向量化
              <InfoTip
                text="模型在「模型注册」里登记，这里只负责选默认的那个。新建知识库时也可以为单个库另选（小库用高精度、大库用小模型）。"
              />
            </h3>

            <div class="slot-field">
              <div class="slot-head">
                <span class="slot-label">
                  默认嵌入模型
                  <InfoTip
                    text="库建好即冻结，之后不能换（换模型要新建库）。未指定时无法新建知识库。"
                  />
                </span>
                <StatusTag
                  :tone="embeddingConfigured ? 'success' : 'warning'"
                  :label="embeddingConfigured ? '已选定' : '未选定'"
                />
                <AppButton
                  :disabled="testing || !embeddingConfigured"
                  @click="runTest('embedding')"
                >
                  {{ testing ? '测试中…' : '测试连接' }}
                </AppButton>
              </div>
              <AppSelect
                :model-value="slotOf('embedding')?.bound_model_pk ?? ''"
                :options="slotOptions('embedding')"
                :disabled="bindingSlot === 'embedding'"
                aria-label="默认嵌入模型"
                @update:model-value="onBindSlot('embedding', $event)"
              />
              <p v-if="slotSummary('embedding')" class="slot-value tabular">
                {{ slotSummary('embedding') }}
              </p>
              <p v-if="!embeddingConfigured" class="row-note">
                未选定前不能新建知识库：没有嵌入模型就没有向量空间。如果这里没有可选项，
                先到「模型注册」添加供应商并登记模型。
              </p>
              <div
                v-if="testResult"
                class="test-result"
                :class="testResult.ok ? 'test-ok' : 'test-bad'"
              >
                <IconCheck v-if="testResult.ok" :size="14" />
                <span>{{ testResult.detail }}</span>
              </div>
            </div>

            <div class="slot-field">
              <div class="slot-head">
                <span class="slot-label">
                  重排模型
                  <InfoTip text="可选。不选则整体跳过重排，不影响检索可用性。" />
                </span>
                <StatusTag
                  :tone="slotOf('rerank')?.configured ? 'success' : 'neutral'"
                  :label="slotOf('rerank')?.configured ? '已启用' : '未启用'"
                />
                <AppButton
                  :disabled="testing || !slotOf('rerank')?.configured"
                  @click="runTest('rerank')"
                >
                  {{ testing ? '测试中…' : '测试连接' }}
                </AppButton>
              </div>
              <AppSelect
                :model-value="slotOf('rerank')?.bound_model_pk ?? ''"
                :options="slotOptions('rerank')"
                :disabled="bindingSlot === 'rerank'"
                aria-label="重排模型"
                @update:model-value="onBindSlot('rerank', $event)"
              />
              <p v-if="slotSummary('rerank')" class="slot-value tabular">
                {{ slotSummary('rerank') }}
              </p>
            </div>

            <h3 class="section-title section-gap">高级</h3>
            <div class="row">
              <div class="row-main">
                <span class="row-label">批大小</span>
                <span class="row-value tabular">{{
                  fieldValue('embedding', 'embedding.batch_size') || '—'
                }}</span>
              </div>
              <AppButton v-if="group('embedding')" @click="openEdit(group('embedding')!)">
                编辑
              </AppButton>
            </div>
          </template>
        </template>

        <!-- 对话模型：LLM 与提示词 -->
        <template v-else-if="section === 'llm'">
          <template v-if="editing">
            <h3 class="section-title">编辑 {{ editing.label }}</h3>
            <div class="edit-form">
              <template v-for="field in editing.fields" :key="field.key">
                <!--
                  布尔项不能走 AppInput：文本域里的 "false" 是非空字符串，
                  一不小心就写成了"开启"。复选框是唯一不会说反的控件。
                -->
                <label v-if="field.type === 'bool'" class="edit-check">
                  <input
                    type="checkbox"
                    :checked="draft[field.key] === 'true'"
                    @change="
                      draft[field.key] = ($event.target as HTMLInputElement).checked
                        ? 'true'
                        : 'false'
                    "
                  />
                  <span>{{ field.label }}</span>
                </label>
                <label v-else-if="field.type === 'select'" class="edit-field">
                  <span class="edit-label">{{ field.label }}</span>
                  <AppSelect
                    v-model="draft[field.key]"
                    :options="field.options"
                    :aria-label="field.label"
                  />
                </label>
                <label v-else class="edit-field">
                  <span class="edit-label">
                    {{ field.label }}
                    <span v-if="field.type === 'secret' && field.configured" class="edit-current">
                      当前 {{ field.value }}
                    </span>
                  </span>
                  <AppInput
                    v-model="draft[field.key]"
                    :multiline="field.type === 'textarea'"
                    :rows="5"
                    :type="field.type === 'int' ? 'number' : 'text'"
                    :placeholder="field.type === 'secret' ? '留空表示不改动' : ''"
                  />
                </label>
              </template>

              <p v-if="editing.key === 'llm'" class="edit-hint">
                推理模型打开深度思考后会更慢、更费 token（回复长度不再设上限，
                由模型自己决定何时收尾）。关掉它更快，但难题上的推导会浅一些。
              </p>
              <p v-else class="edit-hint">
                留空即恢复内置提示词：内置版本要求模型只依据资料作答，并在引用处标出资料编号。
              </p>

              <div
                v-if="testResult"
                class="test-result"
                :class="testResult.ok ? 'test-ok' : 'test-bad'"
              >
                <IconCheck v-if="testResult.ok" :size="14" />
                <span>{{ testResult.detail }}</span>
              </div>
            </div>
            <div class="edit-actions">
              <AppButton v-if="editing.key === 'llm'" :disabled="testing" @click="runTest('llm')">
                <template #icon><IconRefresh /></template>
                {{ testing ? '测试中…' : '测试连接' }}
              </AppButton>
              <AppButton @click="editing = null">返回</AppButton>
              <AppButton variant="primary" :disabled="saving" @click="save">
                {{ saving ? '保存中…' : '保存' }}
              </AppButton>
            </div>
          </template>

          <template v-else>
            <h3 class="section-title">
              对话模型（LLM）
              <InfoTip
                text="模型在「模型注册」里登记，这里只选默认的那个。没选时「对话」会直接报错，不会编造没有依据的答案。"
              />
            </h3>

            <div class="slot-field">
              <div class="slot-head">
                <span class="slot-label">默认对话模型</span>
                <StatusTag
                  :tone="chatConfigured ? 'success' : 'warning'"
                  :label="chatConfigured ? '已选定' : '未选定'"
                />
                <AppButton :disabled="llmTesting || !chatConfigured" @click="testLlm">
                  {{ llmTesting ? '测试中…' : '测试连接' }}
                </AppButton>
              </div>
              <AppSelect
                :model-value="slotOf('chat')?.bound_model_pk ?? ''"
                :options="slotOptions('chat')"
                :disabled="bindingSlot === 'chat'"
                aria-label="默认对话模型"
                @update:model-value="onBindSlot('chat', $event)"
              />
              <p v-if="slotSummary('chat')" class="slot-value tabular">
                {{ slotSummary('chat') }}
              </p>
              <p v-if="!chatConfigured" class="row-note">
                未选定时「对话」与标题生成不可用。如果这里没有可选项，先到「模型注册」登记对话模型。
              </p>
              <div v-if="llmTest" class="test-result" :class="llmTest.ok ? 'test-ok' : 'test-bad'">
                <IconCheck v-if="llmTest.ok" :size="14" />
                <span>{{ llmTest.detail }}</span>
              </div>
            </div>

            <h3 class="section-title section-gap">采样与行为</h3>
            <div class="row">
              <div class="row-main">
                <span class="row-label">
                  温度 / 深度思考
                  <InfoTip
                    text="长度上限交给模型：它自己决定什么时候收尾。少数端点不传就会退化成很小的默认值，那种情况在「模型注册」里给该模型加 options.max_tokens。"
                  />
                </span>
                <span class="row-value tabular">
                  温度 {{ fieldValue('llm', 'llm.temperature') || '—' }}<span class="sep">·</span
                  >{{
                    fieldValue('llm', 'llm.enable_thinking') === 'true'
                      ? `思考开（${selectLabel('llm', 'llm.thinking_effort', fieldValue('llm', 'llm.thinking_effort'))}）`
                      : '思考关'
                  }}
                </span>
              </div>
              <AppButton v-if="group('llm')" @click="openEdit(group('llm')!)">编辑</AppButton>
            </div>
            <p v-if="fieldValue('llm', 'llm.enable_thinking') === 'true'" class="row-note">
              更慢、更费 token。
            </p>
            <p v-if="fieldValue('llm', 'llm.enable_thinking') === 'true'" class="row-note">
              更慢、更费 token。
            </p>

            <h3 class="section-title section-gap">对话行为</h3>
            <div class="row">
              <div class="row-main">
                <span class="row-label">检索与生成</span>
                <!--
                  提示词不再在这里配（v0.19）：它跟**知识库**绑定，
                  去「知识库 → 设置 → 回答要求」里改。这里只留一句指路——
                  用户按老印象来这里找，找不到会以为功能被删了。
                -->
                <span class="row-value">回答用的提示词在「知识库 → 设置」里配，每个库一份</span>
              </div>
              <span class="row-value tabular"
                >带入 {{ fieldValue('chat', 'chat.top_k') || '—' }} 条资料</span
              >
              <AppButton v-if="group('chat')" @click="openEdit(group('chat')!)">编辑</AppButton>
            </div>
          </template>
        </template>

        <!-- 服务配置 -->
        <template v-else-if="section === 'services'">
          <template v-if="editing && ['mineru', 'paddleocr'].includes(editing.key)">
            <h3 class="section-title">编辑 {{ editing.label }}</h3>
            <div class="edit-form">
              <label v-for="field in editing.fields" :key="field.key" class="edit-field">
                <span class="edit-label">
                  {{ field.label }}
                  <span v-if="field.type === 'secret' && field.configured" class="edit-current">
                    当前 {{ field.value }}
                  </span>
                </span>
                <AppInput
                  v-model="draft[field.key]"
                  type="text"
                  :placeholder="field.type === 'secret' ? '留空表示不改动' : ''"
                />
              </label>
              <div
                v-if="testResult"
                class="test-result"
                :class="testResult.ok ? 'test-ok' : 'test-bad'"
              >
                <IconCheck v-if="testResult.ok" :size="14" />
                <span>{{ testResult.detail }}</span>
              </div>
            </div>
            <div class="edit-actions">
              <AppButton :disabled="testing" @click="runTest(editing.key)">
                <template #icon><IconRefresh /></template>
                {{ testing ? '测试中…' : '测试连接' }}
              </AppButton>
              <AppButton @click="editing = null">返回</AppButton>
              <AppButton variant="primary" :disabled="saving" @click="save">
                {{ saving ? '保存中…' : '保存' }}
              </AppButton>
            </div>
          </template>

          <template v-else>
            <h3 class="section-title">
              服务配置
              <InfoTip
                text="两个云端节点互为备选：文字型文档优先 MinerU，扫描件与混合型降级到 PaddleOCR。"
              />
            </h3>

            <div class="row">
              <div class="row-main">
                <span class="row-label">MinerU 云端</span>
                <span class="row-value">
                  模型 {{ fieldValue('mineru', 'mineru.model_version') || '—'
                  }}<span class="sep">·</span>{{ secretSummary('mineru', 'mineru.token') }}
                </span>
              </div>
              <StatusTag
                :tone="isConfigured('mineru', 'mineru.token') ? 'success' : 'neutral'"
                :label="isConfigured('mineru', 'mineru.token') ? '已配置' : '未配置'"
              />
              <AppButton v-if="group('mineru')" @click="openEdit(group('mineru')!)">编辑</AppButton>
            </div>

            <div class="row">
              <div class="row-main">
                <span class="row-label">PaddleOCR 云端</span>
                <span class="row-value">
                  {{ fieldValue('paddleocr', 'paddleocr.model') || '—' }}<span class="sep">·</span
                  >{{ secretSummary('paddleocr', 'paddleocr.token') }}
                </span>
              </div>
              <StatusTag
                :tone="isConfigured('paddleocr', 'paddleocr.token') ? 'success' : 'neutral'"
                :label="isConfigured('paddleocr', 'paddleocr.token') ? '已配置' : '未配置'"
              />
              <AppButton v-if="group('paddleocr')" @click="openEdit(group('paddleocr')!)">
                编辑
              </AppButton>
            </div>
          </template>
        </template>

        <!--
          功能（动态）：后端那些没有专门一节的设置组——长期记忆、联网、沙箱执行…
          整块都是按字段渲染的，所以后端加一组、加一个字段，这里自动跟着变。
        -->
        <template v-else-if="activeGroup">
          <template v-if="editing">
            <h3 class="section-title">编辑 {{ editing.label }}</h3>
            <div class="edit-form">
              <template v-for="field in editing.fields" :key="field.key">
                <!-- 布尔项不能走文本输入：里面的 "false" 是非空字符串，一不小心就写成了开启 -->
                <label v-if="field.type === 'bool'" class="edit-check">
                  <input
                    type="checkbox"
                    :checked="draft[field.key] === 'true'"
                    @change="
                      draft[field.key] = ($event.target as HTMLInputElement).checked
                        ? 'true'
                        : 'false'
                    "
                  />
                  <span>{{ field.label }}</span>
                </label>
                <label v-else-if="field.type === 'select'" class="edit-field">
                  <span class="edit-label">{{ field.label }}</span>
                  <AppSelect
                    v-model="draft[field.key]"
                    :options="field.options"
                    :aria-label="field.label"
                  />
                </label>
                <label v-else class="edit-field">
                  <span class="edit-label">
                    {{ field.label }}
                    <span v-if="field.type === 'secret' && field.configured" class="edit-current">
                      当前 {{ field.value }}
                    </span>
                  </span>
                  <AppInput
                    v-model="draft[field.key]"
                    :multiline="field.type === 'textarea'"
                    :rows="5"
                    :type="field.type === 'int' ? 'number' : 'text'"
                    :placeholder="field.type === 'secret' ? '留空表示不改动' : ''"
                  />
                </label>
              </template>
              <p v-if="editHint(editing.key)" class="edit-hint">{{ editHint(editing.key) }}</p>

              <div
                v-if="testResult"
                class="test-result"
                :class="testResult.ok ? 'test-ok' : 'test-bad'"
              >
                <IconCheck v-if="testResult.ok" :size="14" />
                <span>{{ testResult.detail }}</span>
              </div>
            </div>
            <div class="edit-actions">
              <AppButton @click="editing = null">返回</AppButton>
              <AppButton variant="primary" :disabled="saving" @click="save">
                {{ saving ? '保存中…' : '保存' }}
              </AppButton>
            </div>
          </template>

          <template v-else-if="activeGroup">
            <h3 class="section-title">
              {{ activeGroup.label }}
              <InfoTip v-if="groupTip(activeGroup.key)" :text="groupTip(activeGroup.key)" />
            </h3>
            <div v-for="field in activeGroup.fields" :key="field.key" class="row">
              <div class="row-main">
                <span class="row-label">{{ field.label }}</span>
                <span class="row-value">{{ fieldSummary(field) }}</span>
              </div>
              <StatusTag
                v-if="field.type === 'bool'"
                :tone="field.value === 'true' ? 'success' : 'neutral'"
                :label="field.value === 'true' ? '已开启' : '未开启'"
              />
              <StatusTag
                v-else-if="field.type === 'secret'"
                :tone="field.configured ? 'success' : 'neutral'"
                :label="field.configured ? '已配置' : '未配置'"
              />
            </div>
            <div class="edit-actions">
              <AppButton variant="primary" @click="openEdit(activeGroup)">编辑</AppButton>
            </div>
          </template>
        </template>

        <!-- 存储配置（只读） -->
        <template v-else-if="section === 'storage'">
          <h3 class="section-title">
            存储配置
            <InfoTip
              text="全内嵌存储，无需外部服务。数据目录由环境变量 KYLAB_DATA_DIR 决定，改后需重启后端。"
            />
          </h3>
          <div class="row row-static">
            <div class="row-main">
              <span class="row-label">元数据</span>
              <span class="row-value">SQLite（WAL，含运行期配置与任务队列）</span>
            </div>
          </div>
          <div class="row row-static">
            <div class="row-main">
              <span class="row-label">向量</span>
              <span class="row-value">sqlite-vec，按知识库分区，维度随库</span>
            </div>
          </div>
          <div class="row row-static">
            <div class="row-main">
              <span class="row-label">全文检索</span>
              <span class="row-value">FTS5 + jieba 分词</span>
            </div>
          </div>
          <div class="row row-static">
            <div class="row-main">
              <span class="row-label">原文与图片</span>
              <span class="row-value">本地文件系统，按内容 hash 寻址</span>
            </div>
          </div>
          <div class="row row-static">
            <div class="row-main">
              <span class="row-label">知识库数量</span>
              <span class="row-value tabular">{{ store.items.length }}</span>
            </div>
          </div>

          <h3 class="section-title section-gap">空间占用</h3>
          <p v-if="storageError" class="error-line">{{ storageError }}</p>
          <template v-else-if="storage">
            <div class="row row-static">
              <div class="row-main">
                <span class="row-label">数据库文件</span>
                <span class="row-value tabular">{{ formatBytes(storage.file_bytes) }}</span>
              </div>
            </div>
            <div class="row row-static">
              <div class="row-main">
                <span class="row-label">
                  其中可回收
                  <InfoTip
                    text="SQLite 删数据不会让文件变小：删掉的页留在库里等复用，只有「整理存储」才会真正还给磁盘。"
                  />
                </span>
                <span class="row-value tabular">{{ formatBytes(storage.free_bytes) }}</span>
              </div>
            </div>
            <div class="row row-static">
              <div class="row-main">
                <span class="row-label">
                  向量分区
                  <InfoTip text="每个知识库一个向量分区；分区只要写入第一个向量就会预分配 4MB。" />
                </span>
                <span class="row-value tabular">{{ storage.partitions }}</span>
              </div>
            </div>
            <p v-if="storage.orphans.length" class="orphan-note">
              发现 {{ storage.orphans.length }} 个无主的向量分区（知识库已删除、表还留在库里）。
              「整理存储」会把它们清掉。
            </p>
            <div class="row">
              <div class="row-main">
                <span class="row-label">整理存储</span>
                <span class="row-hint">
                  清理无主分区并回收空闲页。会重写数据库文件，大库需要几十秒；期间不要做其他写操作。
                </span>
              </div>
              <AppButton
                :disabled="compacting || storageLoading"
                @click="compactConfirmOpen = true"
              >
                {{ compacting ? '整理中…' : '整理存储' }}
              </AppButton>
            </div>
          </template>
          <p v-else class="row-hint">{{ storageLoading ? '正在读取存储信息…' : '' }}</p>
        </template>

        <!-- 外观（本地偏好，不进后端） -->
        <template v-else-if="section === 'appearance'">
          <h3 class="section-title">
            外观
            <InfoTip text="主题与字号只影响这一台机器的浏览器，存在本地，不写进知识库配置。" />
          </h3>

          <div class="row row-static">
            <div class="row-main">
              <span class="row-label">主题</span>
              <span class="row-value">
                {{ THEME_OPTIONS.find((item) => item.name === themeMode)?.hint ?? '' }}
              </span>
            </div>
          </div>

          <div class="scale-picker" role="group" aria-label="主题">
            <button
              v-for="item in THEME_OPTIONS"
              :key="item.name"
              class="scale-option"
              :class="{ 'scale-option-active': themeMode === item.name }"
              type="button"
              :aria-pressed="themeMode === item.name"
              @click="setTheme(item.name)"
            >
              <span class="scale-label">{{ item.label }}</span>
              <span class="scale-size">{{ item.hint }}</span>
            </button>
          </div>

          <h3 class="section-title section-gap">正文字号</h3>
          <div class="row row-static">
            <div class="row-main">
              <span class="row-label">字号档位</span>
              <span class="row-value">{{ currentScaleHint }}</span>
            </div>
          </div>

          <div class="scale-picker" role="group" aria-label="正文字号">
            <button
              v-for="item in fontOptions"
              :key="item.name"
              class="scale-option"
              :class="{ 'scale-option-active': fontScale === item.name }"
              type="button"
              :aria-pressed="fontScale === item.name"
              @click="setFontScale(item.name)"
            >
              <span class="scale-label">{{ item.label }}</span>
              <span class="scale-size tabular">{{ item.bodySize }}px</span>
            </button>
          </div>
        </template>

        <!-- 用户（v10）：开通账号与成员管理。仅管理员可见 -->
        <template v-else-if="section === 'users'">
          <div class="section-head">
            <h3 class="section-title">
              用户
              <InfoTip
                text="被开通的账号登录后只能看到分享给他的知识库；没有登录名的名册条目只用于标记文档归属。"
              />
            </h3>
            <AppButton @click="toggleAdding">{{ addingUser ? '取消' : '添加用户' }}</AppButton>
          </div>

          <div v-if="addingUser" class="create-card">
            <div class="create-grid">
              <label class="field-label" for="kylab-new-name">显示名</label>
              <AppInput
                id="kylab-new-name"
                v-model="newName"
                placeholder="例如 小王"
                :disabled="creatingUser"
              />
              <label class="field-label" for="kylab-new-username">登录名</label>
              <AppInput
                id="kylab-new-username"
                v-model="newUsername"
                placeholder="用于登录，不区分大小写"
                :disabled="creatingUser"
              />
              <label class="field-label" for="kylab-account-password">初始密码</label>
              <AppInput
                id="kylab-account-password"
                v-model="newAccountPassword"
                type="password"
                :placeholder="`至少 ${MIN_PASSWORD_CHARS} 个字符`"
                :disabled="creatingUser"
              />
              <label class="field-label" for="kylab-new-role">角色</label>
              <AppSelect
                id="kylab-new-role"
                v-model="newRole"
                :options="ROLE_OPTIONS"
                :disabled="creatingUser"
              />
            </div>
            <p v-if="createError" class="form-error" role="alert">{{ createError }}</p>
            <div class="password-actions">
              <AppButton variant="primary" :disabled="creatingUser" @click="submitCreateUser">
                {{ creatingUser ? '开通中…' : '开通账号' }}
              </AppButton>
            </div>
          </div>

          <h3 class="section-title section-gap">成员与名册</h3>
          <p v-if="usersLoading" class="row-note">正在加载…</p>
          <p v-else-if="usersError" class="error-line">{{ usersError }}</p>
          <p v-else-if="users.length === 0" class="row-note">
            还没有任何人。开通一个账号，对方就能登录了。
          </p>
          <ul v-else class="user-list">
            <li v-for="person in users" :key="person.id" class="user-row">
              <span class="user-main">
                <span class="user-name">{{ person.name }}</span>
                <span class="user-meta">
                  <template v-if="person.username"
                    >@{{ person.username }}<span class="sep">·</span></template
                  >{{ person.document_count }} 篇文档
                </span>
              </span>
              <StatusTag
                v-if="person.username"
                :tone="person.role === 'admin' ? 'success' : 'neutral'"
                :label="person.role === 'admin' ? '管理员' : '成员'"
              />
              <StatusTag v-else tone="neutral" label="名册" />
              <StatusTag v-if="person.disabled" tone="danger" label="已禁用" />
              <span class="user-actions">
                <template v-if="person.username">
                  <AppButton size="sm" @click="openReset(person)">重置密码</AppButton>
                  <AppButton
                    v-if="person.id !== currentUser?.id"
                    size="sm"
                    @click="toggleDisabled(person)"
                  >
                    {{ person.disabled ? '启用' : '禁用' }}
                  </AppButton>
                </template>
                <AppButton
                  v-if="person.id !== currentUser?.id"
                  size="sm"
                  variant="danger"
                  @click="openDelete(person)"
                >
                  删除
                </AppButton>
              </span>
            </li>
          </ul>
        </template>

        <!-- 系统与安全 -->
        <template v-else>
          <h3 class="section-title">系统与安全</h3>

          <!-- 账号（v10 主路径）：登录状态下在这里改密、退出。 -->
          <template v-if="currentUser">
            <div class="row row-static">
              <div class="row-main">
                <span class="row-label">当前账号</span>
                <span class="row-value">
                  {{ currentUser.name }}
                  <span class="row-sub">（{{ currentUser.username }}）</span>
                </span>
              </div>
              <StatusTag
                :tone="isAdmin ? 'success' : 'neutral'"
                :label="isAdmin ? '管理员' : '成员'"
              />
            </div>

            <h3 class="section-title section-gap">
              修改密码
              <InfoTip
                text="改密会吊销其他设备上的登录，当前这条保留。忘记密码时可由管理员在「用户」里重置。"
              />
            </h3>
            <div class="password-form">
              <div class="field">
                <label class="field-label" for="kylab-old-password">当前密码</label>
                <AppInput
                  id="kylab-old-password"
                  v-model="oldPassword"
                  type="password"
                  autocomplete="current-password"
                  :disabled="changingPassword"
                />
              </div>
              <div class="field">
                <label class="field-label" for="kylab-new-password">新密码</label>
                <AppInput
                  id="kylab-new-password"
                  v-model="newPassword"
                  type="password"
                  autocomplete="new-password"
                  :placeholder="`至少 ${MIN_PASSWORD_CHARS} 个字符`"
                  :disabled="changingPassword"
                />
              </div>
              <div class="field">
                <label class="field-label" for="kylab-confirm-password">确认新密码</label>
                <AppInput
                  id="kylab-confirm-password"
                  v-model="confirmNewPassword"
                  type="password"
                  autocomplete="new-password"
                  :disabled="changingPassword"
                />
              </div>
              <p v-if="passwordError" class="form-error" role="alert">{{ passwordError }}</p>
              <div class="password-actions">
                <AppButton
                  variant="primary"
                  :disabled="changingPassword"
                  @click="submitPasswordChange"
                >
                  {{ changingPassword ? '提交中…' : '更新密码' }}
                </AppButton>
                <AppButton variant="danger" @click="emit('logout')">
                  <template #icon><IconLogout /></template>
                  退出登录
                </AppButton>
              </div>
            </div>
          </template>

          <div class="row row-static">
            <div class="row-main">
              <span class="row-label">后端状态</span>
              <span class="row-value">
                {{
                  health
                    ? `在线 v${health.version} · ${health.api_version}`
                    : healthError || '检测中'
                }}
              </span>
            </div>
            <StatusTag :tone="health ? 'success' : 'danger'" :label="health ? '在线' : '不可达'" />
          </div>
          <div class="row row-static">
            <div class="row-main">
              <span class="row-label">访问鉴权</span>
              <span class="row-value">
                {{
                  authStatus?.needs_setup
                    ? '尚未初始化：请先创建管理员账号'
                    : '已启用：/api/v1 一律需要登录会话或 API Key'
                }}
              </span>
            </div>
            <StatusTag
              :tone="authStatus?.needs_setup ? 'warning' : 'success'"
              :label="authStatus?.needs_setup ? '未初始化' : '已启用'"
            />
          </div>
        </template>
      </div>
    </div>

    <!--
      重置密码（嵌套弹窗）。放在弹窗里而不是行内展开：一次只处理一个人，
      展开会把"成员与名册"列表推下去，让用户失去上下文。
    -->
    <AppModal :open="resetTarget !== null" title="重置密码" @update:open="onResetOpenChange">
      <p class="share-lead">
        为「{{ resetTarget?.name }}」设置新密码。对方所有已登录的设备会立即退出。
      </p>
      <AppInput
        v-model="resetDraft"
        type="password"
        autocomplete="new-password"
        :placeholder="`至少 ${MIN_PASSWORD_CHARS} 个字符`"
        :disabled="resetting"
      />
      <p v-if="resetError" class="form-error" role="alert">{{ resetError }}</p>
      <template #footer>
        <AppButton @click="resetTarget = null">取消</AppButton>
        <AppButton variant="primary" :disabled="resetting" @click="submitReset">
          {{ resetting ? '提交中…' : '重置密码' }}
        </AppButton>
      </template>
    </AppModal>

    <!-- 删除账号：破坏性动作，按规范 §10.3 二次确认，并说清"文档会怎样" -->
    <AppModal :open="deleteTarget !== null" title="删除用户" @update:open="onDeleteOpenChange">
      <p class="share-lead">确定删除「{{ deleteTarget?.name }}」？</p>
      <p class="row-note">
        对方上传的
        {{ deleteTarget?.document_count ?? 0 }}
        篇文档会保留，但不再归属任何人；账号将无法再登录。不可撤销。
      </p>
      <template #footer>
        <AppButton @click="deleteTarget = null">取消</AppButton>
        <AppButton variant="danger" :disabled="deletingUser" @click="confirmDeleteUser">
          {{ deletingUser ? '删除中…' : '删除' }}
        </AppButton>
      </template>
    </AppModal>
  </AppModal>

  <ConfirmDialog
    v-model:open="compactConfirmOpen"
    title="整理存储"
    lead="清理无主向量分区并回收空闲页？"
    note="只清理无主数据，不动文档、切块与向量。库大时 VACUUM 要几十秒，期间避免其他写操作。"
    confirm-label="开始整理"
    :busy="compacting"
    busy-label="整理中…"
    @confirm="runCompact"
  />
</template>

<style scoped>
/* 左菜单 + 右内容：弹窗内不再滚动整页，而是右侧内容区自己滚。
   高度不再在这里写 `max-height`——统一由 AppModal 的 `height="tall"` 决定：
   本弹窗有左菜单，切换分组时高度必须稳定，否则整块会上下跳。 */
.settings {
  display: grid;
  height: 100%;
  min-height: 0;
  /* 列宽 192px：加图标后 168px 会把「供应商与用途分配」挤成两行 */
  grid-template-columns: 192px 1fr;
  gap: var(--space-5);
}

.settings-nav {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding-right: var(--space-4);
  border-right: 1px solid var(--border-hairline);
}

/* 字号档位：四个并排的按钮。
   每一档都把实际 px 写在下面——"大 / 更大"这种词单独放着没法让人判断合不合适，
   给出数字才可选。 */
.scale-picker {
  display: grid;
  gap: var(--space-2);
  grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
  margin-top: var(--space-3);
}

.scale-option {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-pair);
  padding: var(--space-3);
  text-align: left;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-control);
}

.scale-option:hover {
  background: var(--bg-hover);
}

.scale-option-active {
  color: var(--accent-text);
  background: var(--accent-soft);
  border-color: var(--accent);
}

.scale-label {
  font-size: var(--text-body-size);
}

.scale-size {
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

/* 菜单项：图标 + 单行标签。**不再有第二行小字**——
   八项各挂一句解释时，扫视先撞到的是解释；解释属于内容区。 */
.nav-entry {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: 36px;
  padding: 0 var(--space-3);
  text-align: left;
  border-radius: var(--radius-control);
}

/* 分组标题：菜单里唯一的小字，它标段落、不解释条目 */
.nav-group {
  margin: var(--space-3) 0 var(--space-1);
  padding: 0 var(--space-3);
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.settings-nav .nav-group:first-child {
  margin-top: 0;
}

.nav-icon {
  flex: 0 0 auto;
  color: var(--text-tertiary);
}

.nav-entry:hover {
  background: var(--bg-hover);
}

.nav-entry-active {
  background: var(--accent-soft);
}

.nav-entry-active .nav-icon {
  color: var(--accent);
}

.nav-label {
  overflow: hidden;
  font-size: var(--text-body-size);
  color: var(--text-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nav-entry-active .nav-label {
  color: var(--accent-text);
  font-weight: 500;
}

.settings-body {
  overflow-y: auto;
  padding-right: var(--space-1);
}

.section-title {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin: 0 0 var(--space-2);
  font-size: var(--text-section-size);
  font-weight: 600;
  letter-spacing: -0.005em;
}

/* 一个分组里放第二块内容时用它拉开：块与块之间的间距要大于块内的行距，
   否则「对话模型」与「对话行为」会读起来像同一张表 */
.section-gap {
  margin-top: var(--space-6);
}

/* 一行配置：左说明、右状态与动作 */
.row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--border-hairline);
}

/* 「选默认模型」这一块：标签 + 状态一行，选择器独占一行。
   选择器比按钮宽得多，塞进 .row 的右侧会被压成一条窄缝——所以它不进 .row */
.slot-field {
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--border-hairline);
}

.slot-field + .slot-field {
  border-top: none;
}

.slot-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}

.slot-label {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--text-body-size);
  color: var(--text-primary);
}

/* 选中模型的"身份证"：名称 · 维度 · 供应商。光看选择器里的短标签不够确认 */
.slot-value {
  margin: var(--space-2) 0 0;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.row-static {
  padding: var(--space-3) var(--space-4);
}

.row-main {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: var(--space-1);
}

.row-label {
  font-size: var(--text-body-size);
  color: var(--text-primary);
}

.row-value {
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}

.row-note {
  margin: var(--space-2) 0 0;
  max-width: 64ch;
  font-size: var(--text-micro-size);
  line-height: 1.7;
  color: var(--text-tertiary);
}

/* 账号区里"（登录名）"这类补充信息：比主值再退一档，不与名字抢注意力 */
.row-sub {
  color: var(--text-tertiary);
}

/* 修改密码表单：控件成组走全局 .field（评审 §2.1） */
.password-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-top: var(--space-3);
}

.form-error {
  margin: var(--space-2) 0 0;
  font-size: var(--text-micro-size);
  color: var(--status-danger);
}

.password-actions {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-3);
}

/* 分组标题 + 右侧动作（与「模型注册 → 供应商」同一套排法）：
   标题在左、动作在右，两者顶对齐——标题是两行的，居中对齐会显得飘 */
.section-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
}

/* 开通账号：标签列固定宽，控件列吃剩余——四行标签才会左边对齐 */
.create-card {
  margin-top: var(--space-3);
  padding: var(--space-4);
  background: var(--bg-subtle);
  border-radius: var(--radius-panel);
}

.create-grid {
  display: grid;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  grid-template-columns: 88px minmax(0, 1fr);
}

/* 成员与名册：一行一个人，操作在右端 */
.user-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.user-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--border-hairline);
}

.user-row:last-child {
  border-bottom: none;
}

.user-main {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: var(--space-pair);
}

.user-name {
  overflow: hidden;
  font-size: var(--text-body-size);
  color: var(--text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.user-meta {
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.user-actions {
  display: flex;
  flex: 0 0 auto;
  gap: var(--space-1);
}

/* 嵌套弹窗的引导句（重置/删除）：与分享弹窗同一套语气 */
.share-lead {
  margin: 0 0 var(--space-4);
  font-size: var(--text-meta-size);
  line-height: 1.7;
  color: var(--text-secondary);
}

.text-warn {
  color: var(--status-warning);
}

.error-line {
  margin: 0 0 var(--space-3);
  color: var(--status-danger);
}

/* 编辑态 */
.edit-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  margin-bottom: var(--space-4);
}

.edit-field {
  display: block;
}

/* 复选框与它的说明同一行：说明是"这项是什么"，离得太远就变成两条信息 */
.edit-check {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--hit-target);
  font-size: var(--text-meta-size);
  color: var(--text-primary);
}

.edit-check input[type='checkbox'] {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  accent-color: var(--text-secondary);
}

.edit-label {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
  font-size: var(--text-micro-size);
  color: var(--text-secondary);
}

.edit-current {
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}

.edit-hint {
  margin: 0;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}

.test-result {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  font-size: var(--text-meta-size);
  border-radius: var(--radius-control);
}

.test-ok {
  color: var(--status-success);
  background: var(--bg-subtle);
}

.test-bad {
  color: var(--status-danger);
  background: var(--danger-soft);
}

@media (max-width: 720px) {
  .settings {
    grid-template-columns: 1fr;
    height: auto;
  }

  .settings-nav {
    flex-direction: row;
    padding-right: 0;
    padding-bottom: var(--space-2);
    border-right: none;
    border-bottom: 1px solid var(--border-hairline);
  }

  .nav-hint {
    display: none;
  }
}
</style>
