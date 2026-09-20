<script setup lang="ts">
/**
 * 一组运行期配置的「看 + 改」（v0.26）。
 *
 * 它存在的理由是一次分家：**长期记忆的开关原来挂在「设置 → 功能 → 长期记忆」里**，
 * 而记忆页就在侧栏上、那一页还写着"记忆服务未启用"。同一个东西的说明和开关隔着
 * 两个菜单，用户按指引找过去还得先猜它在哪一组。
 *
 * 所以把"按后端给的字段渲染一组设置"这件事抽成一个组件，
 * 谁家的设置就挂在谁家的页面上：
 *
 * - 记忆页 → `memory`（开关、服务地址、沉淀频率…）；
 * - 能力页 → `web`（联网搜索）与 `sandbox`（执行策略）；
 * - 总设置弹窗 → 仍然用它渲染"后端新加了、还没有专门归属"的那些组。
 *
 * **自取自存**：组件自己 `getSettings()`、自己 `updateSettings()`。让调用方喂数据
 * 会让"打开面板要先读一次配置"变成每个宿主都要记得做的事。
 */
import { onMounted, ref } from 'vue'

import { getSettings, updateSettings, type SettingGroup } from '@/api/settings'
import { editHint, groupTip } from '@/components/settings/groupTips'
import AppButton from '@/components/ui/AppButton.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppSelect from '@/components/ui/AppSelect.vue'
import InfoTip from '@/components/ui/InfoTip.vue'
import StatusTag from '@/components/ui/StatusTag.vue'
import { useToast } from '@/composables/useToast'

const props = defineProps<{
  /** 要显示哪几组（后端 `SETTING_GROUPS` 的键）。顺序照这个数组。 */
  keys: string[]
}>()

const emit = defineEmits<{ saved: [] }>()

const { notifyError, notifySuccess } = useToast()

const groups = ref<SettingGroup[]>([])
const loading = ref(true)
const error = ref('')

async function load(): Promise<void> {
  loading.value = true
  try {
    const view = await getSettings()
    // **按调用方给的顺序取**，不是按后端返回的顺序：面板在页面上的位置是设计过的
    groups.value = props.keys
      .map((key) => view.groups.find((item) => item.key === key))
      .filter((item): item is SettingGroup => item !== undefined)
    error.value = ''
  } catch (cause) {
    // 读不到就说读不到：这些面板背后是管理员端点，成员点进来会拿到 403，
    // 而"一片空白"会让人以为这一组没有设置项
    error.value = cause instanceof Error ? cause.message : '配置读取失败'
  } finally {
    loading.value = false
  }
}

onMounted(load)

const editing = ref<SettingGroup | null>(null)
const draft = ref<Record<string, string>>({})
const saving = ref(false)

function openEdit(target: SettingGroup): void {
  editing.value = target
  const next: Record<string, string> = {}
  for (const field of target.fields) {
    // 密钥**永不回显**：留空表示不改动（与总设置同一口径）
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
    await load()
    emit('saved')
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '保存失败')
  } finally {
    saving.value = false
  }
}

/**
 * 一个字段值的显示文案。
 *
 * 按类型分开写是因为它们**该说的话不一样**：布尔说"开启/关闭"（写成 true/false
 * 等于没翻译），密钥说"已配置/未配置"，其余取值本身。空值统一给破折号——
 * 留空白会让人以为界面坏了。
 */
function fieldSummary(field: SettingGroup['fields'][number]): string {
  if (field.type === 'bool') return field.value === 'true' ? '开启' : '关闭'
  if (field.type === 'secret') return field.configured ? field.value : '未配置'
  if (field.type === 'select') {
    return field.options.find((option) => option.value === field.value)?.label ?? field.value
  }
  return field.value || '—'
}
</script>

<template>
  <!-- `settings-scope` 是"设置里每一节"的样式命名空间（见 settings.css）：
       与总设置弹窗共用同一套行/表单/标题样式，两处长得一样。 -->
  <div class="settings-scope group-panel">
    <p v-if="loading" class="group-note">读取配置中…</p>
    <p v-else-if="error" class="group-note group-note-bad">{{ error }}</p>
    <p v-else-if="!groups.length" class="group-note">这里暂时没有可配置的项。</p>

    <!-- `v-else` 挂在 template 上：v-if 与 v-for 同处一个元素时，Vue 3 里 v-if 优先，
         那样 `v-for` 根本轮不到（这一条是踩过的，不是理论） -->
    <template v-else>
      <section v-for="item in groups" :key="item.key" class="group-block">
        <h3 class="section-title">
          {{ item.label }}
          <InfoTip v-if="groupTip(item.key)" :text="groupTip(item.key)" />
        </h3>

        <template v-if="editing?.key === item.key">
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
          </div>
          <div class="edit-actions">
            <AppButton @click="editing = null">返回</AppButton>
            <AppButton variant="primary" :disabled="saving" @click="save">
              {{ saving ? '保存中…' : '保存' }}
            </AppButton>
          </div>
        </template>

        <template v-else>
          <div v-for="field in item.fields" :key="field.key" class="row">
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
            <AppButton variant="primary" @click="openEdit(item)">编辑</AppButton>
          </div>
        </template>
      </section>
    </template>
  </div>
</template>

<style scoped>
/* 相邻两组之间要断开：这个面板可以一次显示两组（能力页就是联网 + 沙箱） */
.group-block + .group-block {
  margin-top: var(--space-6);
}

.group-note {
  margin: 0;
  color: var(--text-tertiary);
  font-size: var(--text-meta-size);
}

/* 读不到（多半是没有权限）时用警示色：它不是"这里没内容"，是"这次没读到" */
.group-note-bad {
  color: var(--status-danger);
}
</style>
