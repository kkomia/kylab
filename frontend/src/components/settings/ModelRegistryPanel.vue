<script setup lang="ts">
/**
 * 模型注册：供应商 → 模型清单（调研报告 G1 / v0.8 归属整理）。
 *
 * **这里只做一件事：把模型登记进来。** 地址、凭据、模型名、维度都在这儿填。
 * "哪个用途用哪个模型"不在这儿绑——向量化的默认模型在「设置 → 向量化」里选，
 * 对话的在「设置 → 对话模型」里选。理由是**注册入口必须唯一**：
 * 同一件事（这家供应商的这把钥匙）能在两个地方写，就必然会漂。
 *
 * 模型行上仍会显示「用于向量化」这类标记，但那是**只读的状态**：
 * 让用户删模型之前知道会影响什么。
 *
 * 密钥纪律：只显示掩码。**改名字时不回传掩码**——那会把密钥写成掩码。
 */
import { computed, onMounted, ref } from 'vue'

import {
  createProvider,
  deleteModel,
  deleteProvider,
  getRegistry,
  listAvailableModels,
  registerModel,
  testProvider,
  updateModel,
  updateProvider,
  type AvailableModel,
  type Provider,
  type RegisteredModel,
  type Registry,
} from '@/api/modelRegistry'
import AppButton from '@/components/ui/AppButton.vue'
import AppCombobox from '@/components/ui/AppCombobox.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppSelect from '@/components/ui/AppSelect.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import InfoTip from '@/components/ui/InfoTip.vue'
import RowMenu from '@/components/ui/RowMenu.vue'
import StatusTag from '@/components/ui/StatusTag.vue'
import { useToast } from '@/composables/useToast'

const { notifySuccess, notifyError } = useToast()

const registry = ref<Registry | null>(null)
const loading = ref(true)
const busy = ref('')

/** 新建供应商的表单是否展开。 */
const addingProvider = ref(false)
const providerDraft = ref({ kind: 'llm', name: '', base_url: '', api_key: '' })

/** 正在编辑的供应商 id（空 = 没有在编辑）。 */
const editingProvider = ref('')
const providerEdit = ref({ name: '', base_url: '', api_key: '' })

/** 正在给哪个供应商加模型（空 = 无）。 */
const addingModelFor = ref('')
const modelDraft = ref({ model_id: '', label: '', dim: '', capabilities: [] as string[] })

/** 「添加模型」的候选：来自上游探测，**不落库**。 */
const availableModels = ref<AvailableModel[]>([])
const loadingAvailable = ref(false)
const availableError = ref('')
/** 候选属于哪个供应商——避免上一个供应商的列表串进下一个的表单。 */
const availableFor = ref('')

/** 候选下拉项：`模型 ID · 归属`（归属只是旁注，上游不一定给）。 */
const availableOptions = computed(() =>
  availableModels.value.map((item) => ({
    value: item.model_id,
    label: item.owned_by ? `${item.model_id} · ${item.owned_by}` : item.model_id,
  })),
)

/** 正在编辑的模型 id。 */
const editingModel = ref('')
const modelEdit = ref({ model_id: '', label: '', dim: '', capabilities: [] as string[] })

const providers = computed(() => registry.value?.providers ?? [])
const kinds = computed(() => registry.value?.provider_kinds ?? {})
const capabilities = computed(() => registry.value?.capabilities ?? {})
const slots = computed(() => registry.value?.slots ?? [])

/** 某个供应商下的模型。 */
function modelsOf(providerId: string): RegisteredModel[] {
  return (registry.value?.models ?? []).filter((item) => item.provider_id === providerId)
}

/**
 * 用途键 → 中文名。
 *
 * **只用于模型行上的「用于向量化」标记**：绑定动作在「向量化 / 对话模型」面板里做
 * （v0.8 归属整理：注册只有一个入口，选择在各自的分组里），但"这个模型正被谁用着"
 * 要在这里看得见——删它之前得知道会影响什么。
 */
function slotLabel(key: string): string {
  return slots.value.find((item) => item.slot === key)?.label ?? key
}

/** 供应商类别下拉（键值对由后端给出，避免前端硬编码类别名）。 */
const kindOptions = computed(() =>
  Object.entries(kinds.value).map(([value, label]) => ({ value, label })),
)

async function load(): Promise<void> {
  loading.value = true
  try {
    registry.value = await getRegistry()
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '模型配置加载失败')
  } finally {
    loading.value = false
  }
}

onMounted(load)

/**
 * 探活供应商（第二轮评审批注 4）。
 *
 * 从"每个用途行一颗测试按钮"挪到这里：那条按钮挤在行尾被裁掉，
 * 而且"这个地址与凭据对不对"本来就是**注册供应商时**要回答的问题；
 * 用途行只该做"选哪个模型"这一件事。
 */
async function onTestProvider(provider: Provider): Promise<void> {
  busy.value = `test:${provider.id}`
  try {
    const result = await testProvider(provider.id)
    notifySuccess(result.detail)
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '测试失败')
  } finally {
    busy.value = ''
  }
}

// ------------------------------------------------------------------ 供应商

async function submitProvider(): Promise<void> {
  const draft = providerDraft.value
  if (!draft.name.trim()) {
    notifyError('请填供应商名称')
    return
  }
  busy.value = 'provider:create'
  try {
    await createProvider({
      kind: draft.kind,
      name: draft.name,
      base_url: draft.base_url,
      api_key: draft.api_key,
    })
    providerDraft.value = { kind: 'llm', name: '', base_url: '', api_key: '' }
    addingProvider.value = false
    await load()
    notifySuccess('供应商已添加')
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '添加失败')
  } finally {
    busy.value = ''
  }
}

function startEditProvider(provider: Provider): void {
  editingProvider.value = provider.id
  // **密钥栏留空**：留空 = 不改。把掩码填进去会被当成新密钥
  providerEdit.value = { name: provider.name, base_url: provider.base_url, api_key: '' }
}

async function submitProviderEdit(provider: Provider): Promise<void> {
  const draft = providerEdit.value
  busy.value = `provider:${provider.id}`
  try {
    await updateProvider(provider.id, {
      name: draft.name,
      base_url: draft.base_url,
      // 只有用户真填了才带上 api_key；留空表示保持原值
      ...(draft.api_key ? { api_key: draft.api_key } : {}),
    })
    editingProvider.value = ''
    await load()
    notifySuccess('供应商已更新')
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '更新失败')
  } finally {
    busy.value = ''
  }
}

async function onToggleProvider(provider: Provider): Promise<void> {
  busy.value = `provider:${provider.id}`
  try {
    await updateProvider(provider.id, { enabled: !provider.enabled })
    await load()
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '操作失败')
  } finally {
    busy.value = ''
  }
}

/** 待确认的删除目标（供应商 / 模型共用一个 ConfirmDialog，用可辨识联合区分）。 */
type DeleteTarget =
  { kind: 'provider'; provider: Provider } | { kind: 'model'; model: RegisteredModel }

const deleteTarget = ref<DeleteTarget | null>(null)
const deleteOpen = computed({
  get: () => deleteTarget.value !== null,
  set: (value: boolean) => {
    if (!value) deleteTarget.value = null
  },
})
const deleteLead = computed(() => {
  const target = deleteTarget.value
  if (!target) return ''
  return target.kind === 'provider'
    ? `删除供应商「${target.provider.name}」？`
    : `删除模型「${target.model.label || target.model.model_id}」？`
})
const deleteNote = computed(() => {
  const target = deleteTarget.value
  if (!target) return ''
  return target.kind === 'provider'
    ? `它下面的 ${target.provider.model_count} 个模型会被一并删除，引用这些模型的用途会自动解绑。`
    : target.model.bound_slots.length > 0
      ? `它正被 ${target.model.bound_slots.length} 个用途使用，删除后会自动解绑。`
      : ''
})

function requestDelete(target: DeleteTarget): void {
  deleteTarget.value = target
}

async function confirmDelete(): Promise<void> {
  const target = deleteTarget.value
  if (!target) return
  busy.value =
    target.kind === 'provider' ? `provider:${target.provider.id}` : `model:${target.model.id}`
  try {
    if (target.kind === 'provider') {
      await deleteProvider(target.provider.id)
      notifySuccess('供应商已删除')
    } else {
      await deleteModel(target.model.id)
      notifySuccess('模型已删除')
    }
    deleteTarget.value = null
    await load()
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '删除失败')
  } finally {
    busy.value = ''
  }
}

// ------------------------------------------------------------------ 模型

function startAddModel(provider: Provider): void {
  addingModelFor.value = provider.id
  modelDraft.value = { model_id: '', label: '', dim: '', capabilities: [] }
  void loadAvailable(provider)
}

/**
 * 拉取该供应商上游可用的模型，喂给「添加模型」的下拉框。
 *
 * **失败不弹错误通知**：手写模型 ID 这条出路一直在，探测失败只该是一句就地提示，
 * 不该打断"我要手填"这个动作。用户要求下拉可搜索、同时保留手写，就是为这种情况。
 */
async function loadAvailable(provider: Provider): Promise<void> {
  availableFor.value = provider.id
  loadingAvailable.value = true
  availableError.value = ''
  availableModels.value = []
  try {
    const result = await listAvailableModels(provider.id)
    if (availableFor.value !== provider.id) return // 用户已经切走，别写回旧列表
    availableModels.value = result.models
  } catch (cause) {
    if (availableFor.value !== provider.id) return
    availableError.value = cause instanceof Error ? cause.message : '拉取失败'
  } finally {
    if (availableFor.value === provider.id) loadingAvailable.value = false
  }
}

async function submitModel(providerId: string): Promise<void> {
  const draft = modelDraft.value
  if (!draft.model_id.trim()) {
    notifyError('请填模型 ID')
    return
  }
  busy.value = 'model:create'
  try {
    await registerModel({
      provider_id: providerId,
      model_id: draft.model_id,
      label: draft.label,
      dim: draft.dim ? Number(draft.dim) : null,
      capabilities: draft.capabilities,
    })
    addingModelFor.value = ''
    availableModels.value = []
    availableError.value = ''
    await load()
    notifySuccess('模型已登记')
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '登记失败')
  } finally {
    busy.value = ''
  }
}

function startEditModel(model: RegisteredModel): void {
  editingModel.value = model.id
  modelEdit.value = {
    model_id: model.model_id,
    label: model.label,
    dim: model.dim === null ? '' : String(model.dim),
    capabilities: [...model.capabilities],
  }
}

async function submitModelEdit(model: RegisteredModel): Promise<void> {
  const draft = modelEdit.value
  busy.value = `model:${model.id}`
  try {
    await updateModel(model.id, {
      model_id: draft.model_id,
      label: draft.label,
      dim: draft.dim ? Number(draft.dim) : null,
      capabilities: draft.capabilities,
    })
    editingModel.value = ''
    await load()
    notifySuccess('模型已更新')
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '更新失败')
  } finally {
    busy.value = ''
  }
}

/** 勾选/取消一个能力标记。 */
function toggleCapability(target: { capabilities: string[] }, name: string): void {
  target.capabilities = target.capabilities.includes(name)
    ? target.capabilities.filter((item) => item !== name)
    : [...target.capabilities, name]
}

defineExpose({ load })
</script>

<template>
  <div class="registry">
    <p v-if="loading" class="muted">正在加载模型配置…</p>

    <template v-else>
      <!-- 供应商 → 模型清单。「用哪个模型」不在这里绑定：
           向量化的默认模型在「向量化」里选，对话的在「对话模型」里选（v0.8 归属整理） -->
      <section class="block">
        <div class="block-head">
          <div>
            <h3 class="block-title">
              供应商
              <InfoTip
                text="一个供应商 = 一个接口地址 + 一把凭据；同一个地址下可以登记多个模型。"
              />
            </h3>
          </div>
          <AppButton @click="addingProvider = !addingProvider">
            {{ addingProvider ? '取消' : '添加供应商' }}
          </AppButton>
        </div>

        <div v-if="addingProvider" class="form-card">
          <div class="form-grid">
            <label class="field">
              <span class="field-label">类别</span>
              <AppSelect
                v-model="providerDraft.kind"
                :options="kindOptions"
                aria-label="供应商类别"
              />
            </label>
            <label class="field">
              <span class="field-label">名称</span>
              <AppInput v-model="providerDraft.name" placeholder="例如：深度求索" />
            </label>
            <label class="field field-wide">
              <span class="field-label">接口地址</span>
              <AppInput v-model="providerDraft.base_url" placeholder="https://api.deepseek.com" />
            </label>
            <label class="field field-wide">
              <span class="field-label">API Key</span>
              <AppInput v-model="providerDraft.api_key" type="password" placeholder="sk-…" />
            </label>
          </div>
          <div class="form-actions">
            <AppButton
              variant="primary"
              :disabled="busy === 'provider:create'"
              @click="submitProvider"
            >
              {{ busy === 'provider:create' ? '添加中…' : '添加' }}
            </AppButton>
          </div>
        </div>

        <p v-if="providers.length === 0 && !addingProvider" class="muted">
          还没有供应商。不添加也能用「精细」配置。
        </p>

        <div v-for="provider in providers" :key="provider.id" class="provider-card">
          <!-- 卡内三段式（规范 §7）：标题 → 元信息 → 次要操作。
               操作全部收进右上角「⋯」——五个按钮平铺会把卡片变成按钮墙。 -->
          <div class="provider-head">
            <div class="provider-title">
              <span class="provider-name">{{ provider.name }}</span>
              <StatusTag v-if="!provider.enabled" tone="warning" label="已停用" />
            </div>
            <RowMenu :label="`${provider.name} 的操作`">
              <template #default="{ close }">
                <!-- 探活放在供应商这一层（评审批注 4）：登记时最会填错的就是地址与凭据 -->
                <button
                  type="button"
                  :disabled="!provider.api_key_configured || busy === `test:${provider.id}`"
                  @click="(onTestProvider(provider), close())"
                >
                  测试连接
                </button>
                <button type="button" @click="(startEditProvider(provider), close())">编辑</button>
                <button type="button" @click="(startAddModel(provider), close())">添加模型</button>
                <button type="button" @click="(onToggleProvider(provider), close())">
                  {{ provider.enabled ? '停用' : '启用' }}
                </button>
                <button
                  class="menu-item-danger"
                  type="button"
                  @click="(requestDelete({ kind: 'provider', provider }), close())"
                >
                  删除
                </button>
              </template>
            </RowMenu>
          </div>

          <p class="provider-meta">
            <span>{{ kinds[provider.kind] ?? provider.kind }}</span>
            <span class="sep">·</span>
            <span class="tabular">{{
              provider.api_key_configured ? provider.api_key_hint : '未配密钥'
            }}</span>
            <span class="sep">·</span>
            <span class="tabular">{{ provider.model_count }} 个模型</span>
          </p>
          <p v-if="provider.base_url" class="provider-url">{{ provider.base_url }}</p>

          <!-- 编辑供应商 -->
          <div v-if="editingProvider === provider.id" class="form-card">
            <div class="form-grid">
              <label class="field">
                <span class="field-label">名称</span>
                <AppInput v-model="providerEdit.name" />
              </label>
              <label class="field field-wide">
                <span class="field-label">接口地址</span>
                <AppInput v-model="providerEdit.base_url" />
              </label>
              <label class="field field-wide">
                <span class="field-label">API Key</span>
                <AppInput
                  v-model="providerEdit.api_key"
                  type="password"
                  placeholder="留空表示不修改"
                />
              </label>
            </div>
            <div class="form-actions">
              <AppButton @click="editingProvider = ''">取消</AppButton>
              <AppButton
                variant="primary"
                :disabled="busy === `provider:${provider.id}`"
                @click="submitProviderEdit(provider)"
              >
                保存
              </AppButton>
            </div>
          </div>

          <!-- 加模型 -->
          <div v-if="addingModelFor === provider.id" class="form-card">
            <div class="form-grid">
              <label class="field">
                <span class="field-label">模型 ID</span>
                <AppCombobox
                  v-model="modelDraft.model_id"
                  :options="availableOptions"
                  :loading="loadingAvailable"
                  :aria-label="`${provider.name} 的模型 ID`"
                  placeholder="选择或直接输入，如 BAAI/bge-m3"
                  empty-text="没探测到候选，可直接输入模型 ID"
                />
              </label>
              <label class="field">
                <span class="field-label">显示名（可选）</span>
                <AppInput v-model="modelDraft.label" placeholder="对话主力" />
              </label>
              <label class="field">
                <span class="field-label">向量维度</span>
                <AppInput v-model="modelDraft.dim" placeholder="仅向量化模型需要" />
              </label>
              <div class="field field-wide">
                <span class="field-label">能力</span>
                <div class="cap-row">
                  <label v-for="(label, key) in capabilities" :key="key" class="cap-item">
                    <input
                      type="checkbox"
                      :checked="modelDraft.capabilities.includes(key)"
                      @change="toggleCapability(modelDraft, key)"
                    />
                    {{ label }}
                  </label>
                </div>
              </div>
            </div>
            <!-- 候选来自上游探测：说清"有没有的选"，失败/为空都指明手写这条出路 -->
            <p class="source-note">
              <template v-if="loadingAvailable">正在从供应商拉取候选模型…</template>
              <template v-else-if="availableError">
                拉取候选失败：{{ availableError }}。可直接输入模型 ID。
              </template>
              <template v-else-if="availableModels.length">
                已拉取到 {{ availableModels.length }} 个候选，可搜索选择，也可直接输入。
              </template>
              <template v-else>该供应商没有返回模型列表，请直接输入模型 ID。</template>
              <button
                v-if="!loadingAvailable"
                type="button"
                class="source-refresh"
                @click="loadAvailable(provider)"
              >
                重新拉取
              </button>
            </p>
            <div class="form-actions">
              <AppButton @click="addingModelFor = ''">取消</AppButton>
              <AppButton
                variant="primary"
                :disabled="busy === 'model:create'"
                @click="submitModel(provider.id)"
              >
                登记
              </AppButton>
            </div>
          </div>

          <!-- 模型清单 -->
          <ul v-if="modelsOf(provider.id).length" class="model-list">
            <li v-for="model in modelsOf(provider.id)" :key="model.id" class="model-row">
              <div class="model-title">
                <span class="model-name">{{ model.label || model.model_id }}</span>
                <span class="model-meta">
                  <span class="tabular">{{ model.model_id }}</span>
                  <template v-if="model.dim"
                    ><span class="sep">·</span
                    ><span class="tabular">{{ model.dim }} 维</span></template
                  >
                  <template v-for="cap in model.capabilities" :key="cap"
                    ><span class="sep">·</span><span>{{ capabilities[cap] ?? cap }}</span></template
                  >
                </span>
              </div>
              <!-- 正被哪些用途用着：一眼能看出"删了会影响什么" -->
              <StatusTag
                v-for="slot in model.bound_slots"
                :key="slot"
                tone="success"
                :label="`用于${slotLabel(slot)}`"
              />
              <RowMenu class="model-menu" :label="`${model.label || model.model_id} 的操作`">
                <template #default="{ close }">
                  <button type="button" @click="(startEditModel(model), close())">编辑</button>
                  <button
                    class="menu-item-danger"
                    type="button"
                    @click="(requestDelete({ kind: 'model', model }), close())"
                  >
                    删除
                  </button>
                </template>
              </RowMenu>

              <div v-if="editingModel === model.id" class="form-card model-edit">
                <div class="form-grid">
                  <label class="field">
                    <span class="field-label">模型 ID</span>
                    <AppInput v-model="modelEdit.model_id" />
                  </label>
                  <label class="field">
                    <span class="field-label">显示名</span>
                    <AppInput v-model="modelEdit.label" />
                  </label>
                  <label class="field">
                    <span class="field-label">向量维度</span>
                    <AppInput v-model="modelEdit.dim" />
                  </label>
                  <div class="field field-wide">
                    <span class="field-label">能力</span>
                    <div class="cap-row">
                      <label v-for="(label, key) in capabilities" :key="key" class="cap-item">
                        <input
                          type="checkbox"
                          :checked="modelEdit.capabilities.includes(key)"
                          @change="toggleCapability(modelEdit, key)"
                        />
                        {{ label }}
                      </label>
                    </div>
                  </div>
                </div>
                <div class="form-actions">
                  <AppButton @click="editingModel = ''">取消</AppButton>
                  <AppButton
                    variant="primary"
                    :disabled="busy === `model:${model.id}`"
                    @click="submitModelEdit(model)"
                  >
                    保存
                  </AppButton>
                </div>
              </div>
            </li>
          </ul>
          <p v-else-if="addingModelFor !== provider.id" class="muted model-empty">
            还没有登记模型。
          </p>
        </div>
      </section>
    </template>
  </div>

  <!-- 删除供应商 / 删除模型：两者的后果不同，由 computed 按目标拼出来 -->
  <ConfirmDialog
    v-model:open="deleteOpen"
    title="删除确认"
    :lead="deleteLead"
    :note="deleteNote || undefined"
    :busy="busy.startsWith('provider:') || busy.startsWith('model:')"
    busy-label="删除中…"
    @confirm="confirmDelete"
  />
</template>

<style scoped>
.block + .block {
  margin-top: var(--space-6);
  padding-top: var(--space-5);
  border-top: 1px solid var(--border-hairline);
}

.block-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
}

.block-title {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin: 0;
  font-size: var(--text-section-size);
}

/* ---- 供应商 ---- */

.provider-card {
  margin-top: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--bg-subtle);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-panel);
}

.provider-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.provider-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.provider-name {
  font-size: var(--text-meta-size);
  font-weight: 500;
  color: var(--text-primary);
}

/* 元信息压成一行低对比小字：类别 · 凭据 · 模型数。
   三段挤在标题行会跟「⋯」抢位置，也会让卡片第一眼没有主次。 */
.provider-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-1);
  margin: var(--space-1) 0 0;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.provider-url {
  margin: var(--space-1) 0 0;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
  overflow-wrap: anywhere;
}

/* ---- 模型 ---- */

.model-list {
  margin: var(--space-2) 0 0;
  padding: 0;
  list-style: none;
}

.model-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  padding: var(--space-2) 0;
  border-top: 1px solid var(--border-hairline);
}

.model-title {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
}

.model-name {
  font-size: var(--text-meta-size);
  color: var(--text-primary);
}

/* 模型 ID / 维度 / 能力合并成标题下的一行小字，
   而不是三个并列的标签——标签一多，表格就散了 */
.model-meta {
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.model-menu {
  margin-left: auto;
}

.model-edit {
  flex: 0 0 100%;
}

.model-empty {
  margin: var(--space-2) 0 0;
}

/* ---- 表单 ---- */

.form-card {
  margin-top: var(--space-3);
  padding: var(--space-3);
  background: var(--bg-canvas);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-control);
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
}

/* 成组容器用全局 .field；这里只补本面板特有的跨列 */
.field-wide {
  grid-column: 1 / -1;
}

.cap-row {
  display: flex;
  gap: var(--space-4);
  padding-top: var(--space-1);
}

.cap-item {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-3);
}

.muted {
  font-size: var(--text-meta-size);
  color: var(--text-tertiary);
}

/* 候选来源说明：一行小字 + 一颗纯文字「重新拉取」 */
.source-note {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: var(--space-3) 0 0;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.source-refresh {
  font-size: var(--text-micro-size);
  color: var(--accent);
}

.source-refresh:hover {
  text-decoration: underline;
}
</style>
