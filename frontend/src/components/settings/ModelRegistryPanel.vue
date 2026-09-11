<script setup lang="ts">
/**
 * 模型（供应商 → 模型 → 用途）（调研报告 G1）。
 *
 * **为什么改成列表而不是一组输入框**：原先的模型配置是每个用途一组固定字段，
 * 三处卡住：
 * 1. 同一个供应商下要用多个模型（便宜的做向量化、贵的做对话），而字段只能填一个；
 * 2. 换模型要覆盖旧凭据，想切回来得重填一遍 key；
 * 3. 看不出"这条模型是干什么用的"。
 *
 * 所以这里按成熟产品（6/6）的做法分三层，**顺序从上到下就是用户的心智顺序**：
 * 先决定"哪个用途用哪个模型"，再管理供应商，最后是供应商下面的模型清单。
 *
 * 密钥纪律：只显示掩码。**改名字时不回传掩码**——那会把密钥写成掩码。
 */
import { computed, onMounted, ref } from 'vue'

import {
  bindSlot,
  createProvider,
  deleteModel,
  deleteProvider,
  getRegistry,
  registerModel,
  testProvider,
  updateModel,
  updateProvider,
  type Provider,
  type RegisteredModel,
  type Registry,
  type Slot,
} from '@/api/modelRegistry'
import IconEdit from '@/components/icons/IconEdit.vue'
import IconPlus from '@/components/icons/IconPlus.vue'
import IconShieldCheck from '@/components/icons/IconShieldCheck.vue'
import IconTrash from '@/components/icons/IconTrash.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppSelect from '@/components/ui/AppSelect.vue'
import InfoTip from '@/components/ui/InfoTip.vue'
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

/** 正在编辑的模型 id。 */
const editingModel = ref('')
const modelEdit = ref({ model_id: '', label: '', dim: '', capabilities: [] as string[] })

const providers = computed(() => registry.value?.providers ?? [])
const slots = computed(() => registry.value?.slots ?? [])
const kinds = computed(() => registry.value?.provider_kinds ?? {})
const capabilities = computed(() => registry.value?.capabilities ?? {})

/** 某个供应商下的模型。 */
function modelsOf(providerId: string): RegisteredModel[] {
  return (registry.value?.models ?? []).filter((item) => item.provider_id === providerId)
}

/** 用途键 → 中文名。界面上不能出现 `用于chat` 这种半中半英的混排。 */
function slotLabel(key: string): string {
  return slots.value.find((item) => item.slot === key)?.label ?? key
}

/** 可以绑到某个用途的模型：声明了该能力，或压根没声明（旧数据不拦）。 */
function bindableModels(slot: Slot): RegisteredModel[] {
  return (registry.value?.models ?? []).filter((item) => {
    const owner = providers.value.find((p) => p.id === item.provider_id)
    if (!owner || !owner.enabled) return false
    return item.capabilities.length === 0 || item.capabilities.includes(slot.capability)
  })
}

/** 用途下拉的选项：空值 = 不绑定，其余是"模型名 · 供应商"。 */
function slotOptions(slot: Slot): { value: string; label: string }[] {
  return [
    { value: '', label: '（不指定，走精细配置）' },
    ...bindableModels(slot).map((model) => ({
      value: model.id,
      label: `${model.label || model.model_id} · ${model.provider_name}`,
    })),
  ]
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

// ------------------------------------------------------------------ 用途绑定

async function onBind(slot: Slot, value: string): Promise<void> {
  busy.value = `slot:${slot.slot}`
  try {
    await bindSlot(slot.slot, value || null)
    await load()
    notifySuccess(value ? `${slot.label}已绑定` : `${slot.label}已解绑，回退到精细配置`)
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '绑定失败')
  } finally {
    busy.value = ''
  }
}

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

async function onDeleteProvider(provider: Provider): Promise<void> {
  const confirmed = window.confirm(
    `删除供应商「${provider.name}」？\n\n` +
      `它下面的 ${provider.model_count} 个模型会被一并删除，` +
      '引用这些模型的用途会自动解绑。',
  )
  if (!confirmed) return
  busy.value = `provider:${provider.id}`
  try {
    await deleteProvider(provider.id)
    await load()
    notifySuccess('供应商已删除')
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '删除失败')
  } finally {
    busy.value = ''
  }
}

// ------------------------------------------------------------------ 模型

function startAddModel(providerId: string): void {
  addingModelFor.value = providerId
  modelDraft.value = { model_id: '', label: '', dim: '', capabilities: [] }
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

async function onDeleteModel(model: RegisteredModel): Promise<void> {
  const bound = model.bound_slots.length > 0
  const confirmed = window.confirm(
    `删除模型「${model.label || model.model_id}」？` +
      (bound ? `\n\n它正被 ${model.bound_slots.length} 个用途使用，删除后会自动解绑。` : ''),
  )
  if (!confirmed) return
  busy.value = `model:${model.id}`
  try {
    await deleteModel(model.id)
    await load()
    notifySuccess('模型已删除')
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '删除失败')
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
      <!-- 第一部分：用途分配。**放最上面**，因为这才是用户每天要改的东西 -->
      <section class="block">
        <h3 class="block-title">
          用途分配
          <InfoTip text="为每种用途指定用哪个模型；未指定的用途走「精细」配置里的字段。" />
        </h3>

        <div v-for="item in slots" :key="item.slot" class="slot-row">
          <div class="slot-name">
            <span class="slot-label">{{ item.label }}</span>
            <StatusTag v-if="item.source === 'registry'" tone="success" label="已绑定" />
            <StatusTag v-else-if="item.source === 'settings'" tone="neutral" label="走精细配置" />
            <StatusTag v-else tone="warning" label="未配置" />
          </div>

          <AppSelect
            class="slot-select"
            :model-value="item.bound_model_pk ?? ''"
            :options="slotOptions(item)"
            :disabled="busy === `slot:${item.slot}`"
            :aria-label="`为「${item.label}」指定模型`"
            @update:model-value="onBind(item, $event)"
          />
        </div>
      </section>

      <!-- 第二部分：供应商 -->
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
            <template #icon><IconPlus v-if="!addingProvider" :size="14" /></template>
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
          <div class="provider-head">
            <span class="provider-name">{{ provider.name }}</span>
            <span class="provider-kind">{{ kinds[provider.kind] ?? provider.kind }}</span>
            <StatusTag v-if="!provider.enabled" tone="warning" label="已停用" />
            <span class="provider-key tabular">
              {{ provider.api_key_configured ? provider.api_key_hint : '未配密钥' }}
            </span>
            <span class="provider-count tabular">{{ provider.model_count }} 个模型</span>

            <span class="provider-actions">
              <!-- 探活放在供应商这一层（评审批注 4）：登记时最会填错的就是地址与凭据 -->
              <AppButton
                :disabled="!provider.api_key_configured || busy === `test:${provider.id}`"
                @click="onTestProvider(provider)"
              >
                <template #icon><IconShieldCheck :size="14" /></template>
                {{ busy === `test:${provider.id}` ? '测试中…' : '测试' }}
              </AppButton>
              <AppButton @click="startEditProvider(provider)">
                <template #icon><IconEdit :size="14" /></template>
                编辑
              </AppButton>
              <AppButton @click="onToggleProvider(provider)">
                {{ provider.enabled ? '停用' : '启用' }}
              </AppButton>
              <AppButton @click="startAddModel(provider.id)">
                <template #icon><IconPlus :size="14" /></template>
                加模型
              </AppButton>
              <AppButton @click="onDeleteProvider(provider)">
                <IconTrash />
              </AppButton>
            </span>
          </div>

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
                <AppInput v-model="modelDraft.model_id" placeholder="deepseek-chat" />
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
              <span class="model-name">{{ model.label || model.model_id }}</span>
              <span class="model-id tabular">{{ model.model_id }}</span>
              <span v-if="model.dim" class="model-dim tabular">{{ model.dim }} 维</span>
              <StatusTag
                v-for="cap in model.capabilities"
                :key="cap"
                tone="neutral"
                :label="capabilities[cap] ?? cap"
              />
              <!-- 正被哪些用途用着：一眼能看出"删了会影响什么" -->
              <StatusTag
                v-for="slot in model.bound_slots"
                :key="slot"
                tone="success"
                :label="`用于${slotLabel(slot)}`"
              />
              <span class="model-actions">
                <AppButton @click="startEditModel(model)">编辑</AppButton>
                <AppButton @click="onDeleteModel(model)"><IconTrash /></AppButton>
              </span>

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

/* ---- 用途分配 ---- */

.slot-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) 0;
}

.slot-row + .slot-row {
  border-top: 1px solid var(--border-hairline);
}

.slot-name {
  display: flex;
  flex: 0 0 180px;
  align-items: center;
  gap: var(--space-2);
}

.slot-label {
  font-size: var(--text-meta-size);
  color: var(--text-primary);
}

/* 只留布局：外观由 AppSelect 统一（《界面评审与改进计划》§1） */
.slot-select {
  flex: 1;
  min-width: 0;
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
  gap: var(--space-2);
  flex-wrap: wrap;
}

.provider-name {
  font-size: var(--text-meta-size);
  font-weight: 500;
  color: var(--text-primary);
}

.provider-kind {
  padding: 0 var(--space-1);
  font-size: var(--text-micro-size);
  color: var(--text-secondary);
  background: var(--bg-canvas);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-control);
}

.provider-key,
.provider-count {
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.provider-actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin-left: auto;
}

/* 图标按钮（删除）要和文字按钮有同样的命中宽度：
   一个只包住 16px 图标的按钮，在触屏上几乎点不中 */
.provider-actions :deep(.button),
.model-actions :deep(.button) {
  min-width: var(--hit-target);
  justify-content: center;
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

.model-name {
  font-size: var(--text-meta-size);
  color: var(--text-primary);
}

.model-id,
.model-dim {
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.model-actions {
  display: flex;
  gap: var(--space-1);
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
</style>
