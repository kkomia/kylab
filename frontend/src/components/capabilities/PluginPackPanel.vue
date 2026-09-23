<script setup lang="ts">
/**
 * 插件包一栏（v0.43，设计见 `docs/设计/插件与技能-v0.1.md`）。
 *
 * 与相邻那一栏「插件」（协议上是 MCP 服务）的区别，正是这一栏最要紧的事：
 * 那一栏是**连出去的外部服务**，这一栏是**磁盘上的能力包**——
 * 一个目录 + 一份 `plugin.json`，里面按目录约定装技能/命令/钩子/工具四类东西。
 *
 * 四处刻意的设计：
 *
 * 1. **本地市场就是目录**：把目录显示出来。不然"怎么装一个插件"这件事
 *    只能靠读文档才会，而这一页正是用户来找答案的地方。
 * 2. **加载失败的也列出来，并给出原因**（照 DSH 的"失败的 preset 也列出"）：
 *    静默藏掉会让用户以为插件没装上。
 * 3. **四类能力面各自带着"未实现"的说明**（后端的 `status` 原样显示）：
 *    命令、钩子、工具这一轮只列出，界面不能让人以为点了就能跑。
 * 4. **启停只写状态**：后端不碰插件目录，所以这里不提供"删除"——
 *    卸载是用户在文件系统里的事。
 */
import { computed, onMounted, ref } from 'vue'

import type { PluginPack } from '@/api/plugins'
import { disablePlugin, enablePlugin, listPlugins } from '@/api/plugins'
import IconAlert from '@/components/icons/IconAlert.vue'
import IconArchive from '@/components/icons/IconArchive.vue'
import IconRefresh from '@/components/icons/IconRefresh.vue'
import IconSearch from '@/components/icons/IconSearch.vue'
import AppButton from '@/components/ui/AppButton.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import RowMenu from '@/components/ui/RowMenu.vue'
import SkeletonBlock from '@/components/ui/SkeletonBlock.vue'
import StatusTag from '@/components/ui/StatusTag.vue'
import { isAdmin } from '@/composables/useSession'
import { useToast } from '@/composables/useToast'

/** 状态栏要的数（页头上那一行由父组件画，所以把数交给它）。 */
const emit = defineEmits<{ stats: [value: { total: number; enabled: number; failed: number }] }>()

const { notifyError, notifySuccess } = useToast()

/** 四类能力面的中文名（界面上说人话，kind 是接口里的枚举）。 */
const KIND_LABELS: Record<string, string> = {
  skill: '技能',
  command: '命令',
  hook: '钩子',
  tool: '工具',
}

const items = ref<PluginPack[]>([])
const loading = ref(true)
const userDir = ref('')
const builtinDir = ref('')
const query = ref('')
const filter = ref<'all' | 'enabled' | 'disabled' | 'failed'>('all')
const busy = ref('')
const expanded = ref('')

const visible = computed(() => {
  const word = query.value.trim().toLowerCase()
  return items.value.filter((item) => {
    if (filter.value === 'enabled' && (!item.enabled || !item.loaded)) return false
    if (filter.value === 'disabled' && item.enabled) return false
    if (filter.value === 'failed' && item.loaded) return false
    if (!word) return true
    return `${item.name} ${item.description}`.toLowerCase().includes(word)
  })
})

const FILTERS = computed(() => [
  { key: 'all' as const, label: '全部', count: items.value.length },
  {
    key: 'enabled' as const,
    label: '已启用',
    count: items.value.filter((item) => item.enabled && item.loaded).length,
  },
  {
    key: 'disabled' as const,
    label: '已停用',
    count: items.value.filter((item) => !item.enabled).length,
  },
  {
    key: 'failed' as const,
    label: '加载失败',
    count: items.value.filter((item) => !item.loaded).length,
  },
])

onMounted(() => {
  void load()
})

async function load(): Promise<void> {
  loading.value = true
  try {
    const result = await listPlugins()
    items.value = result.items
    userDir.value = result.user_dir
    builtinDir.value = result.builtin_dir
    emit('stats', { total: result.total, enabled: result.enabled, failed: result.failed })
  } catch (error) {
    notifyError(error instanceof Error ? error.message : '插件列表读取失败')
  } finally {
    loading.value = false
  }
}

async function toggle(record: PluginPack): Promise<void> {
  busy.value = record.name
  try {
    const updated = record.enabled
      ? await disablePlugin(record.name)
      : await enablePlugin(record.name)
    const at = items.value.findIndex((item) => item.name === record.name)
    if (at >= 0) items.value[at] = updated
    // 内置插件停用会**记一条屏蔽**（不是删掉）——这件事得说出来，
    // 否则用户会以为"它被我卸了"
    notifySuccess(updated.enabled ? `已启用「${record.name}」` : `已停用「${record.name}」`)
  } catch (error) {
    notifyError(error instanceof Error ? error.message : '启停失败')
  } finally {
    busy.value = ''
  }
}

/** 来源那一行：两种来源的说法不同，内置的被停用还多一层含义。 */
function sourceLabel(record: PluginPack): string {
  return record.source === 'builtin' ? '随代码发布' : '放在数据目录'
}

function kindsLabel(record: PluginPack): string {
  return record.kinds.map((kind) => KIND_LABELS[kind] ?? kind).join(' / ')
}
</script>

<template>
  <section class="cap-col" role="tabpanel" aria-label="插件包">
    <header class="cap-toolbar">
      <label class="panel-search">
        <IconSearch :size="15" />
        <input v-model="query" type="search" placeholder="搜索插件包" aria-label="搜索插件包" />
      </label>
      <div class="panel-actions">
        <!-- **本地市场就在这个目录里**：把路径摊在工具栏上，用户才知道东西该放哪 -->
        <code class="market-dir" :title="builtinDir ? `内置：${builtinDir}` : '没有内置插件目录'">
          {{ userDir }}
        </code>
        <AppButton size="sm" :disabled="loading" @click="load">
          <template #icon><IconRefresh :size="14" /></template>
          重新扫描
        </AppButton>
      </div>
    </header>

    <div class="panel-filters" role="tablist" aria-label="插件包筛选">
      <button
        v-for="item in FILTERS"
        :key="item.key"
        type="button"
        role="tab"
        class="filter"
        :class="{ 'filter-on': filter === item.key }"
        :aria-selected="filter === item.key"
        @click="filter = item.key"
      >
        {{ item.label }}
        <span class="filter-count tabular">{{ item.count }}</span>
      </button>
    </div>

    <SkeletonBlock v-if="loading" variant="list" :rows="3" />
    <EmptyState
      v-else-if="!visible.length"
      :title="items.length ? '没有匹配的插件包' : '还没有插件包'"
      :hint="
        items.length
          ? '换个关键词，或者把筛选切回「全部」。'
          : `把带 plugin.json 的目录放进 ${userDir}，这里就会列出来。`
      "
    />
    <ul v-else class="card-grid">
      <li v-for="record in visible" :key="record.name" class="card">
        <span class="card-icon"><IconArchive :size="18" /></span>
        <div class="card-body">
          <span class="card-title">{{ record.name }}</span>
          <p class="card-desc">{{ record.description || '（没有描述）' }}</p>
          <div class="card-meta">
            <span class="chip">{{ sourceLabel(record) }}</span>
            <span class="chip tabular">{{ record.version }}</span>
            <span v-if="record.kinds.length" class="chip">{{ kindsLabel(record) }}</span>
            <StatusTag v-if="!record.loaded" label="加载失败" tone="danger" />
            <template v-else>
              <StatusTag v-if="!record.enabled" label="已停用" tone="warning" />
              <!-- 屏蔽（照 ZCode 的标记）：内置的那份被用户停用了，文件还在、列表里也在，
                   只是不会生效——它和"停用"的区别要说出来 -->
              <StatusTag v-if="record.blocked" label="已屏蔽" tone="warning" />
            </template>
            <span v-if="record.user_config.length" class="chip" title="manifest 里声明的配置项">
              配置项 {{ record.user_config.length }}
            </span>
            <button
              v-if="record.components.length"
              type="button"
              class="chip chip-button"
              @click="expanded = expanded === record.name ? '' : record.name"
            >
              {{ expanded === record.name ? '收起' : `提供了 ${record.components.length} 项` }}
            </button>
          </div>

          <!-- 加载失败的原因**原样显示**（这是用户唯一能拿到的那一句） -->
          <ul v-if="record.error" class="flags">
            <li>
              <IconAlert :size="12" />
              {{ record.error }}
            </li>
          </ul>
          <code v-if="record.loaded" class="card-target">{{ record.manifest_path }}</code>

          <ul v-if="expanded === record.name" class="pack-parts">
            <li v-for="part in record.components" :key="`${part.kind}-${part.name}`">
              <span class="chip">{{ KIND_LABELS[part.kind] ?? part.kind }}</span>
              <code>{{ part.name }}</code>
              <span v-if="part.path" class="part-path">{{ part.path }}</span>
              <span class="part-status">{{ part.status }}</span>
            </li>
          </ul>
        </div>

        <RowMenu v-if="isAdmin" class="card-menu" :label="`${record.name} 的操作`" align="right">
          <template #default="{ close }">
            <button
              type="button"
              :disabled="busy === record.name"
              @click="(toggle(record), close())"
            >
              {{ record.enabled ? '停用' : '启用' }}
            </button>
          </template>
        </RowMenu>
      </li>
    </ul>
  </section>
</template>

<style scoped>
/* 工具栏上那个目录：它是"本地市场在哪"，所以做成代码样式（可选中、可复制） */
.market-dir {
  max-width: 22rem;
  overflow: hidden;
  font-size: 0.75rem;
  color: var(--text-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pack-parts {
  display: grid;
  gap: var(--space-1);
  margin: var(--space-2) 0 0;
  padding: 0;
  list-style: none;
}

.pack-parts li {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-2);
  font-size: 0.8125rem;
}

/* 这一类现在能不能用（四类都还没接执行，后端的原话照旧显示） */
.part-status,
.part-path {
  color: var(--text-muted);
}
</style>
