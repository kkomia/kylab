<script setup lang="ts">
/**
 * 数据源订阅面板（M6 / T6.1–T6.3）。
 *
 * 允许给一个知识库挂上 RSS 订阅或某个网页，之后定时/手动把内容抓进来。
 *
 * **两处刻意的界面决定**：
 * 1. **"登记"与"拉取"分开**：刚登记完不会立刻有文档。合成一个动作会让用户
 *    以为点完就有了，然后在文档列表里找不到东西。
 * 2. **拉取结果显示"取回 / 新入库 / 重复"三个数**：用户看到"取回 20、新入库 0"
 *    时该立刻明白"这个源没更新"，而不是以为抓取失败了。
 */
import { computed, onMounted, ref } from 'vue'

import {
  createDataSource,
  deleteDataSource,
  listDataSources,
  setDataSourceEnabled,
  syncDataSource,
  type DataSource,
  type SourceKind,
} from '@/api/dataSources'
import IconPlus from '@/components/icons/IconPlus.vue'
import IconRefresh from '@/components/icons/IconRefresh.vue'
import IconTrash from '@/components/icons/IconTrash.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppSelect from '@/components/ui/AppSelect.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import StatusTag from '@/components/ui/StatusTag.vue'
import { formatRelativeTime } from '@/composables/useFormat'
import { useToast } from '@/composables/useToast'

const props = withDefaults(defineProps<{ kbId: string; canWrite?: boolean }>(), {
  canWrite: true,
})
const emit = defineEmits<{ changed: [] }>()

const { notifySuccess, notifyError } = useToast()

/** 下拉选项：类型是 SourceKind 的联合，故用 setKind 收口，不让 string 直接落进 ref。 */
const KIND_OPTIONS: { value: SourceKind; label: string }[] = [
  { value: 'rss', label: 'RSS / Atom 订阅' },
  { value: 'html', label: '单个网页' },
]

function setKind(value: string): void {
  draft.value = { ...draft.value, kind: value as SourceKind }
}

const sources = ref<DataSource[]>([])
const loading = ref(true)
const busy = ref('')

const adding = ref(false)
const draft = ref<{ kind: SourceKind; name: string; url: string }>({
  kind: 'rss',
  name: '',
  url: '',
})

const KIND_LABELS: Record<string, string> = { rss: 'RSS 订阅', html: '网页' }

async function load(): Promise<void> {
  loading.value = true
  try {
    sources.value = (await listDataSources(props.kbId)).items
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '数据源加载失败')
  } finally {
    loading.value = false
  }
}

onMounted(load)

async function submit(): Promise<void> {
  const { kind, name, url } = draft.value
  if (!url.trim()) {
    notifyError('请填地址')
    return
  }
  busy.value = 'create'
  try {
    await createDataSource(props.kbId, { kind, name: name.trim(), url: url.trim() })
    draft.value = { kind: 'rss', name: '', url: '' }
    adding.value = false
    await load()
    notifySuccess('已登记。点「立即拉取」把内容抓进来')
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '登记失败')
  } finally {
    busy.value = ''
  }
}

async function sync(source: DataSource): Promise<void> {
  busy.value = `sync:${source.id}`
  try {
    const result = await syncDataSource(source.id, true)
    await load()
    emit('changed')
    if (result.not_modified) {
      notifySuccess('这个源没有更新（服务端返回未修改）')
    } else if (result.created > 0) {
      notifySuccess(
        `取回 ${result.fetched} 条，新入库 ${result.created} 条` +
          (result.duplicates ? `，跳过重复 ${result.duplicates} 条` : ''),
      )
    } else {
      // 取回了一些但都是重复的——要说清是"没有新内容"而不是失败
      notifySuccess(`取回 ${result.fetched} 条，都是已有内容（无新增）`)
    }
    if (result.errors.length) {
      notifyError(`${result.errors.length} 条入库失败：${result.errors[0]}`)
    }
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '拉取失败')
  } finally {
    busy.value = ''
  }
}

async function toggle(source: DataSource): Promise<void> {
  busy.value = `toggle:${source.id}`
  try {
    await setDataSourceEnabled(source.id, !source.enabled)
    await load()
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '操作失败')
  } finally {
    busy.value = ''
  }
}

/** 待确认删除的数据源（统一走 ConfirmDialog）。 */
const deleteTarget = ref<DataSource | null>(null)
const deleteOpen = computed({
  get: () => deleteTarget.value !== null,
  set: (value: boolean) => {
    if (!value) deleteTarget.value = null
  },
})

function requestRemove(source: DataSource): void {
  deleteTarget.value = source
}

async function confirmRemove(): Promise<void> {
  const source = deleteTarget.value
  if (!source) return
  busy.value = `delete:${source.id}`
  try {
    await deleteDataSource(source.id)
    deleteTarget.value = null
    await load()
    notifySuccess('数据源已删除，已抓取的文档保留')
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '删除失败')
  } finally {
    busy.value = ''
  }
}
</script>

<template>
  <div class="sources">
    <div class="sources-head">
      <div>
        <h2 class="sources-title">数据源</h2>
        <p class="sources-hint">
          订阅 RSS 或盯住一个网页，内容会自动抓进这个知识库。
          <strong>登记后不会立刻抓取</strong>：点「立即拉取」，或等定时任务。
        </p>
      </div>
      <AppButton v-if="canWrite" @click="adding = !adding">
        <template #icon><IconPlus /></template>
        {{ adding ? '取消' : '添加数据源' }}
      </AppButton>
    </div>

    <!-- 只读分享：说明为什么没有操作入口，而不是让按钮点了才报 403 -->
    <p v-if="!canWrite" class="muted">只读分享：你可以查看这里的数据源，但不能添加或修改。</p>

    <!-- 登记表单 -->
    <div v-if="adding" class="source-form">
      <div class="form-row">
        <label class="field">
          <span class="field-label">类型</span>
          <AppSelect
            :model-value="draft.kind"
            :options="KIND_OPTIONS"
            aria-label="数据源类型"
            @update:model-value="setKind"
          />
        </label>
        <label class="field">
          <span class="field-label">名称（可选）</span>
          <AppInput v-model="draft.name" placeholder="例如：科技爱好者周刊" />
        </label>
      </div>
      <label class="field">
        <span class="field-label">地址</span>
        <AppInput
          v-model="draft.url"
          :placeholder="
            draft.kind === 'rss' ? 'https://example.com/feed.xml' : 'https://example.com/some-page'
          "
        />
      </label>
      <div class="form-actions">
        <AppButton variant="primary" :disabled="busy === 'create'" @click="submit">
          {{ busy === 'create' ? '登记中…' : '登记' }}
        </AppButton>
      </div>
    </div>

    <p v-if="loading" class="muted">正在加载数据源…</p>
    <p v-else-if="sources.length === 0 && !adding" class="muted">
      还没有数据源。上传文档之外，也可以订阅一个 RSS 源让它自动更新。
    </p>

    <ul v-else-if="sources.length" class="source-list">
      <li v-for="source in sources" :key="source.id" class="source-row">
        <span class="source-main">
          <span class="source-name">{{ source.name }}</span>
          <StatusTag
            :tone="source.kind === 'rss' ? 'neutral' : 'neutral'"
            :label="KIND_LABELS[source.kind] ?? source.kind"
          />
          <StatusTag v-if="!source.enabled" tone="warning" label="已停用" />
        </span>
        <span class="source-url">{{ source.url }}</span>
        <span class="source-time">
          {{ source.last_pulled_at ? formatRelativeTime(source.last_pulled_at) : '从未拉取' }}
        </span>
        <span v-if="canWrite" class="source-actions">
          <AppButton :disabled="busy === `sync:${source.id}`" @click="sync(source)">
            <template #icon><IconRefresh :size="14" /></template>
            {{ busy === `sync:${source.id}` ? '拉取中…' : '立即拉取' }}
          </AppButton>
          <AppButton @click="toggle(source)">
            {{ source.enabled ? '停用' : '启用' }}
          </AppButton>
          <AppButton @click="requestRemove(source)">
            <template #icon><IconTrash :size="14" /></template>
          </AppButton>
        </span>
      </li>
    </ul>
  </div>

  <!-- 删除确认：已抓取的文档保留是关键信息，要写在后果里 -->
  <ConfirmDialog
    v-model:open="deleteOpen"
    title="删除数据源"
    :lead="`删除数据源「${deleteTarget?.name}」？`"
    note="已抓进来的文档会保留：停掉订阅不等于撤销已收集的资料。"
    :busy="busy.startsWith('delete:')"
    busy-label="删除中…"
    @confirm="confirmRemove"
  />
</template>

<style scoped>
.sources {
  margin-top: var(--space-6);
}

.sources-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
}

.sources-title {
  margin: 0;
  font-size: var(--text-section-size);
}

.sources-hint {
  margin: var(--space-1) 0 var(--space-3);
  max-width: 62ch;
  font-size: var(--text-micro-size);
  line-height: 1.7;
  color: var(--text-tertiary);
}

.sources-hint strong {
  font-weight: 500;
  color: var(--text-secondary);
}

.source-form {
  margin-bottom: var(--space-3);
  padding: var(--space-3);
  background: var(--bg-subtle);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-panel);
}

.form-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
}

.field {
  margin-bottom: var(--space-3);
  min-width: 0;
}

.form-actions {
  display: flex;
  justify-content: flex-end;
}

.source-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

/* 一行一个源：名称与标签在左、地址在中、操作在右。
   地址**单独一行并允许换行**——它在窄屏下必然超出，截断会让用户认不出是哪个源 */
.source-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
  padding: var(--space-3) var(--space-4);
  background: var(--bg-canvas);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-panel);
}

.source-row + .source-row {
  margin-top: var(--space-2);
}

.source-main {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 0 1 auto;
  min-width: 0;
}

.source-name {
  font-size: var(--text-meta-size);
  color: var(--text-primary);
}

.source-url {
  flex: 1 1 200px;
  min-width: 0;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
  overflow-wrap: anywhere;
}

.source-time {
  flex: 0 0 auto;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.source-actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin-left: auto;
}

.muted {
  font-size: var(--text-meta-size);
  color: var(--text-tertiary);
}
</style>
