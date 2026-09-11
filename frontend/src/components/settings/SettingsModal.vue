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
 *
 * 密钥永不回显明文：接口给掩码，输入框留空表示"不改动"。
 */
import { computed, onMounted, ref, watch } from 'vue'

import { MIN_PASSWORD_CHARS } from '@/api/auth'
import { fetchHealth, type HealthResponse } from '@/api/health'
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
import IconCheck from '@/components/icons/IconCheck.vue'
import IconLogout from '@/components/icons/IconLogout.vue'
import IconRefresh from '@/components/icons/IconRefresh.vue'
import ModelRegistryPanel from '@/components/settings/ModelRegistryPanel.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppModal from '@/components/ui/AppModal.vue'
import AppSelect from '@/components/ui/AppSelect.vue'
import StatusTag from '@/components/ui/StatusTag.vue'
import { useToast } from '@/composables/useToast'
import { useConsoleToken } from '@/composables/useConsoleToken'
import { useFontScale } from '@/composables/useFontScale'
import { changeOwnPassword, isAdmin } from '@/composables/useSession'
import { currentUser } from '@/composables/useSessionToken'
import { useKnowledgeBaseStore } from '@/stores/knowledgeBases'

const open = defineModel<boolean>('open', { required: true })

/**
 * 退出登录由外壳（SideNav）执行：它还要清空两个 Pinia store 与名册缓存，
 * 而那是"整个会话"的事，不适合塞进一个设置弹窗里。
 */
const emit = defineEmits<{ logout: [] }>()

/**
 * 打开时定位到的分组（可选）。401 兜底流程靠它直接落到「系统与安全」的
 * 令牌输入框，免得用户在六组菜单里自己找。用 string 而不是 SectionKey：
 * 调用方（侧栏）不该 import 本组件的内部类型。
 */
const props = defineProps<{ initialSection?: string }>()

type SectionKey =
  'registry' | 'models' | 'llm' | 'services' | 'storage' | 'appearance' | 'users' | 'system'

const SECTIONS: { key: SectionKey; label: string; hint: string; adminOnly?: boolean }[] = [
  // **「模型」放在最前**：现在它是配置模型的**主路径**（供应商 → 模型 → 用途），
  // 下面那两组是回退用的精细字段。先主路径、再回退项，顺序才符合用户的心智
  { key: 'registry', label: '模型', hint: '供应商与用途分配' },
  // 保留原有两组作为回退：没在「模型」里绑定的用途，仍然按这里的字段走。
  // 命名上加「（精细）」以免用户以为要两处都填
  { key: 'models', label: '向量化（精细）', hint: '未绑定时生效' },
  { key: 'llm', label: '对话模型（精细）', hint: '未绑定时生效' },
  { key: 'services', label: '服务配置', hint: '云端解析节点' },
  { key: 'storage', label: '存储配置', hint: '元数据与向量' },
  { key: 'appearance', label: '外观', hint: '字号与显示' },
  // 只有管理员（或控制台令牌通道）能看：/users 的写与管理端点是控制台级
  { key: 'users', label: '用户', hint: '账号与成员', adminOnly: true },
  { key: 'system', label: '系统与安全', hint: '版本与鉴权' },
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
const tokenDraft = ref('')

// 字号是本地偏好，不进后端：直接读 composable，不做 save 流程
const { scale: fontScale, options: fontOptions, setFontScale } = useFontScale()
const { token: consoleToken, setConsoleToken, clearConsoleToken } = useConsoleToken()
const currentScaleHint = computed(
  () => fontOptions.find((item) => item.name === fontScale.value)?.hint ?? '',
)

/**
 * 保存控制台令牌并**立刻复验**。
 *
 * 不复验的话，用户粘错一个字符只会看到"已保存"，然后在别处收到一堆 401——
 * 那时他已经不记得自己刚改过什么了。这里存完马上打一次需要鉴权的端点，
 * 失败就当场说清并**把错误的令牌撤掉**，免得它一直污染后续请求。
 */
async function saveToken(): Promise<void> {
  const candidate = tokenDraft.value.trim()
  if (!candidate) return
  setConsoleToken(candidate)
  try {
    await getSettings()
    tokenDraft.value = ''
    notifySuccess('控制台令牌已保存并验证通过')
    await refresh()
  } catch (error) {
    clearConsoleToken()
    notifyError(`令牌未通过验证，已撤销：${error instanceof Error ? error.message : '校验失败'}`)
  }
}

function forgetToken(): void {
  clearConsoleToken()
  tokenDraft.value = ''
  notifySuccess('已清除本机保存的控制台令牌')
}

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
 * `currentUser === null` 时也开放：那是控制台令牌通道（或鉴权未启用的本机开发），
 * 它与管理员同权，没有理由把用户管理藏起来。
 */
const canManageUsers = computed(() => currentUser.value === null || isAdmin.value)
const visibleSections = computed(() =>
  SECTIONS.filter((item) => !item.adminOnly || canManageUsers.value),
)

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
})

/** 正在编辑的分组（null = 仍在浏览态）。 */
const editing = ref<SettingGroup | null>(null)
const draft = ref<Record<string, string>>({})
const saving = ref(false)
const testing = ref(false)
const testResult = ref<{ ok: boolean; detail: string } | null>(null)

/** 应用「打开时定位到某组」的请求：忽略未知分组名，不让调用方的一个错字符串把弹窗搞空。 */
function applyInitialSection(): void {
  const wanted = visibleSections.value.find((item) => item.key === props.initialSection)
  if (wanted) section.value = wanted.key
}

// 每次打开都重新读一次：配置可能被另一个标签页改过，也可能后端刚重启
watch(open, (value) => {
  if (value) {
    applyInitialSection()
    void refresh()
    if (section.value === 'users') void loadUsers()
  }
})

// 弹窗已开着时又收到 401（比如刚粘的令牌没通过验证）：也要把分组切过去
watch(
  () => props.initialSection,
  () => {
    if (open.value) applyInitialSection()
  },
)

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

function secretSummary(groupKey: string, fieldKey: string): string {
  return isConfigured(groupKey, fieldKey) ? fieldValue(groupKey, fieldKey) : '未配置'
}

const embeddingConfigured = computed(() => isConfigured('embedding', 'embedding.api_key'))

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

/** 「对话行为」一行里显示提示词的开头：它只是给个印象，完整内容在编辑态里。 */
const PROMPT_SNIPPET = 40

const promptSummary = computed(() => {
  const value = fieldValue('chat', 'chat.system_prompt').trim()
  if (!value) return '用内置提示词'
  return value.length > PROMPT_SNIPPET ? `${value.slice(0, PROMPT_SNIPPET)}…` : value
})

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
      <!-- 左：分组菜单。设置项会越来越多，平铺下去没人找得到 -->
      <nav class="settings-nav" aria-label="设置分组">
        <button
          v-for="item in visibleSections"
          :key="item.key"
          class="nav-entry"
          :class="{ 'nav-entry-active': section === item.key }"
          type="button"
          @click="((section = item.key), (editing = null))"
        >
          <span class="nav-label">{{ item.label }}</span>
          <span class="nav-hint">{{ item.hint }}</span>
        </button>
      </nav>

      <!-- 右：内容 -->
      <div class="settings-body">
        <p v-if="loadError" class="error-line">{{ loadError }}</p>

        <!-- 模型（G1）：供应商 → 模型 → 用途。这是配置模型的**主路径** -->
        <template v-if="section === 'registry'">
          <ModelRegistryPanel />
        </template>

        <!-- 向量化与重排的精细字段：未在「模型」里绑定对应用途时生效 -->
        <template v-else-if="section === 'models'">
          <template v-if="editing?.key === 'embedding' || editing?.key === 'rerank'">
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
                  :type="field.type === 'int' ? 'number' : 'text'"
                  :placeholder="field.type === 'secret' ? '留空表示不改动' : ''"
                />
              </label>
              <p v-if="editing.key === 'embedding'" class="edit-hint">
                维度必须与模型实际输出一致（bge-m3 为 1024）。库内已有向量后再改模型会被拒绝（架构
                §6.4）。
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
            <h3 class="section-title">模型配置</h3>
            <div class="row">
              <div class="row-main">
                <span class="row-label">向量化</span>
                <span class="row-value">
                  {{ fieldValue('embedding', 'embedding.model_id') || '未指定模型'
                  }}<span class="sep">·</span>{{ config?.embedding_dim ?? '—' }} 维<span class="sep"
                    >·</span
                  ><span :class="{ 'text-warn': !embeddingConfigured }">{{
                    secretSummary('embedding', 'embedding.api_key')
                  }}</span>
                </span>
              </div>
              <StatusTag
                v-if="config"
                :tone="config.embedding_is_development ? 'warning' : 'success'"
                :label="config.embedding_is_development ? '开发兜底' : '已启用'"
              />
              <AppButton v-if="group('embedding')" @click="openEdit(group('embedding')!)">
                编辑
              </AppButton>
            </div>
            <p v-if="config?.embedding_is_development" class="row-note">
              未配置 API Key，当前用确定性哈希兜底：只有词面重叠、没有语义，检索质量不代表真实效果。
            </p>

            <div class="row">
              <div class="row-main">
                <span class="row-label">重排 rerank</span>
                <span class="row-value">
                  {{ fieldValue('rerank', 'rerank.model_id') || '未指定模型'
                  }}<span class="sep">·</span>{{ secretSummary('rerank', 'rerank.api_key') }}
                </span>
              </div>
              <StatusTag
                :tone="config?.rerank_enabled ? 'success' : 'neutral'"
                :label="config?.rerank_enabled ? '已启用' : '未启用'"
              />
              <AppButton v-if="group('rerank')" @click="openEdit(group('rerank')!)">编辑</AppButton>
            </div>
            <p class="row-note">
              未配置时整体跳过重排，不影响检索可用性（失败也会退回 RRF 顺序）。
            </p>
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
                推理模型打开深度思考后会更慢、更费 token，并且需要把「最大回复长度」调大，
                否则可能只返回思考过程、不返回正文。
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
            <h3 class="section-title">对话模型（LLM）</h3>
            <p class="section-note">
              对话页用它把检索到的原文读成回答。没配好时「对话」会直接报错，
              不会给出没有依据的答案——这一层是刻意不兜底的。
            </p>

            <div class="row">
              <div class="row-main">
                <span class="row-label">对话模型</span>
                <span class="row-value">
                  {{ fieldValue('llm', 'llm.model_id') || '未指定模型' }}<span class="sep">·</span
                  >{{ secretSummary('llm', 'llm.api_key') }}
                </span>
              </div>
              <StatusTag
                :tone="isConfigured('llm', 'llm.api_key') ? 'success' : 'warning'"
                :label="isConfigured('llm', 'llm.api_key') ? '已配置' : '未配置'"
              />
              <AppButton :disabled="llmTesting" @click="testLlm">
                <template #icon><IconRefresh /></template>
                {{ llmTesting ? '测试中…' : '测试连接' }}
              </AppButton>
              <AppButton v-if="group('llm')" @click="openEdit(group('llm')!)">编辑</AppButton>
            </div>
            <div v-if="llmTest" class="test-result" :class="llmTest.ok ? 'test-ok' : 'test-bad'">
              <IconCheck v-if="llmTest.ok" :size="14" />
              <span>{{ llmTest.detail }}</span>
            </div>
            <p v-if="fieldValue('llm', 'llm.enable_thinking') === 'true'" class="row-note">
              已打开深度思考：回答更慢、更费 token，请确认「最大回复长度」留得足够大。
            </p>

            <h3 class="section-title section-gap">对话行为</h3>
            <div class="row">
              <div class="row-main">
                <span class="row-label">系统提示词</span>
                <span class="row-value">{{ promptSummary }}</span>
              </div>
              <span class="row-value tabular"
                >带入 {{ fieldValue('chat', 'chat.top_k') || '—' }} 条资料</span
              >
              <AppButton v-if="group('chat')" @click="openEdit(group('chat')!)">编辑</AppButton>
            </div>
            <p class="row-note">
              「带入资料的条数」决定一次对话给模型看几段原文：条数越多依据越全，
              但更容易把问题本身挤出上下文。
            </p>
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
            <h3 class="section-title">服务配置</h3>
            <p class="section-note">
              两个云端解析节点互为备选：文字型文档优先 MinerU，扫描件与混合型可降级到
              PaddleOCR（架构 §4.1）。
            </p>

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
            <p class="row-note">
              版面还原强，负责文字型 PDF 与 Office；单文件上限 200MB / 200 页，每日 1000
              页优先额度。
            </p>

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
            <p class="row-note">扫描件的第二通道；MinerU 不可用时自动接管。</p>
          </template>
        </template>

        <!-- 存储配置（只读） -->
        <template v-else-if="section === 'storage'">
          <h3 class="section-title">存储配置</h3>
          <p class="section-note">
            全内嵌存储，无需外部服务。数据目录由环境变量 <code>KYLAB_DATA_DIR</code> 决定，
            改它要重启后端——这一项不适合放在界面上点。
          </p>
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
        </template>

        <!-- 外观（本地偏好，不进后端） -->
        <template v-else-if="section === 'appearance'">
          <h3 class="section-title">外观</h3>
          <p class="section-note">字号只影响这一台机器的浏览器，存在本地，不写进知识库配置。</p>

          <div class="row row-static">
            <div class="row-main">
              <span class="row-label">正文字号</span>
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

          <p class="row-note">
            小字号占满了界面外壳（侧栏、标签、元信息），正文反倒不突出——
            所以这一版把整条字阶抬了一档，并允许你按屏幕距离微调。 最小档的辅助文字仍是
            12px，再小就会影响辨认。
          </p>
        </template>

        <!-- 用户（v10）：开通账号与成员管理。仅管理员/控制台可见 -->
        <template v-else-if="section === 'users'">
          <h3 class="section-title">用户</h3>
          <p class="section-note">
            开通账号后，对方用自己的登录名登录，且只能看到你分享给他的知识库。没有登录名的名册条目仅用于标记文档归属。
          </p>

          <div class="create-card">
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
            <p class="row-note">
              初始密码由你转告对方；刻意不强制首次登录改密——家庭场景下那只会变成所有人共用同一个密码。
            </p>
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

          <!-- 账号（v10 主路径）：登录状态下在这里改密、退出。
               控制台令牌只留给没有账号的老部署/应急恢复，见下方 v-if 分支。 -->
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

            <h3 class="section-title section-gap">修改密码</h3>
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
              <p class="text-hint">
                改密会吊销其他设备上的登录，当前这条保留。忘记密码时，可由管理员在「用户」里重置。
              </p>
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
                  authStatus?.auth_enabled
                    ? '已启用：/api/v1 需要凭据'
                    : '未启用：仅本机使用，任何能访问端口的人都能读写'
                }}
              </span>
            </div>
            <StatusTag
              :tone="authStatus?.auth_enabled ? 'success' : 'warning'"
              :label="authStatus?.auth_enabled ? '已启用' : '未启用'"
            />
          </div>

          <!-- 凭据输入：**这是控制台在启用鉴权后的唯一入口**。
               没有它，打开鉴权等于把控制台锁死——每个页面都报「缺少凭据」，
               而用户没有任何地方可以填。
               账号体系（v10）落地后它退为**恢复通道**：已有账号时不再显示，
               否则会和"登录"这件事重复，让人以为要两处都配。 -->
          <template v-if="!currentUser">
            <div class="row row-static">
              <div class="row-main">
                <span class="row-label">控制台令牌</span>
                <span class="row-value">
                  {{
                    consoleToken
                      ? '已保存（只存在这台机器的浏览器里）'
                      : '未填写。后端启用鉴权后，控制台需要它才能读写'
                  }}
                </span>
              </div>
              <StatusTag
                :tone="consoleToken ? 'success' : 'neutral'"
                :label="consoleToken ? '已配置' : '未填写'"
              />
            </div>

            <div class="token-row">
              <AppInput
                id="console-token"
                v-model="tokenDraft"
                type="password"
                placeholder="粘贴控制台令牌（kylab_console_…）"
                @keyup.enter="saveToken"
              />
              <AppButton variant="primary" :disabled="!tokenDraft.trim()" @click="saveToken">
                保存
              </AppButton>
              <AppButton v-if="consoleToken" @click="forgetToken">清除</AppButton>
            </div>

            <p class="row-note">
              令牌由后端签发：首次部署时设置 KYLAB_CONSOLE_TOKEN，或调用 POST
              /api/v1/auth/console-token 初始化一条。它只保存在这台机器的浏览器里，
              不写进知识库配置。原文与图片下载走带过期时间的签名 URL，不产生永久直链。
            </p>
          </template>
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
        该用户上传的 {{ deleteTarget?.document_count ?? 0 }} 篇文档会保留，但归属置空；
        对方将无法再登录。此操作不可撤销。
      </p>
      <template #footer>
        <AppButton @click="deleteTarget = null">取消</AppButton>
        <AppButton variant="danger" :disabled="deletingUser" @click="confirmDeleteUser">
          {{ deletingUser ? '删除中…' : '删除' }}
        </AppButton>
      </template>
    </AppModal>
  </AppModal>
</template>

<style scoped>
/* 左菜单 + 右内容：弹窗内不再滚动整页，而是右侧内容区自己滚。
   高度不再在这里写 `max-height`——统一由 AppModal 的 `height="tall"` 决定：
   本弹窗有左菜单，切换分组时高度必须稳定，否则整块会上下跳。 */
.settings {
  display: grid;
  height: 100%;
  min-height: 0;
  grid-template-columns: 168px 1fr;
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

/* 令牌输入：输入框吃掉剩余宽度，两个按钮靠右。
   输入框自带 min-width，所以这里要 min-width:0 允许它收缩。 */
.token-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-3);
}

.token-row :deep(.field) {
  flex: 1;
  min-width: 0;
}

/* 主标题 + 副标题要读成一个整体，用成对间距令牌（base.css §间距） */
.nav-entry {
  display: flex;
  flex-direction: column;
  gap: var(--space-pair);
  padding: var(--space-2) var(--space-3);
  text-align: left;
  border-radius: var(--radius-control);
}

.nav-entry:hover {
  background: var(--bg-hover);
}

.nav-entry-active {
  background: var(--bg-active);
}

.nav-label {
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
}

.nav-entry-active .nav-label {
  color: var(--text-primary);
  font-weight: 500;
}

.nav-hint {
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.settings-body {
  overflow-y: auto;
  padding-right: var(--space-1);
}

.section-title {
  margin: 0 0 var(--space-2);
  font-size: var(--text-section-size);
  font-weight: 600;
  letter-spacing: -0.005em;
}

.section-note {
  margin: 0 0 var(--space-4);
  max-width: 60ch;
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
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

/* 开通账号：标签列固定宽，控件列吃剩余——四行标签才会左边对齐 */
.create-card {
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
