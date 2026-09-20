<!--
  存储配置与空间占用（管理员）。

  **它现在是独立组件**：进来就自己读一次概览（父组件不再管它的加载时机），
  确认弹窗也归它自己——弹窗属于"这个动作"，不属于整个设置弹窗。
  样式用 `settings.css` 里那套分节共用规则，不需要 scoped。
-->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { compactStorage, getStorageOverview, type StorageOverview } from '@/api/maintenance'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import AppButton from '@/components/ui/AppButton.vue'
import InfoTip from '@/components/ui/InfoTip.vue'
import { formatBytes } from '@/composables/useFormat'
import { useToast } from '@/composables/useToast'
import { useKnowledgeBaseStore } from '@/stores/knowledgeBases'

const store = useKnowledgeBaseStore()
const { notifySuccess, notifyError } = useToast()

const storage = ref<StorageOverview | null>(null)
const storageError = ref('')
const storageLoading = ref(false)
const compacting = ref(false)
const compactConfirmOpen = ref(false)

/** 知识库数量直接读 store：它已经在别处加载好了，这里再请求一次只是浪费一次往返。 */
const kbCount = computed(() => store.items.length)

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
 * 整理存储：丢掉无主分区并跑 `VACUUM (ANALYZE)`。
 *
 * **先确认再动手**：它会重写含死元组的表页，大库可能要几十秒。
 * 不阻塞写入（那是 `VACUUM FULL` 才有的代价，本项目不用它），但期间别人的查询会变慢。
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

onMounted(loadStorage)
</script>

<template>
  <h3 class="section-title">
    存储配置
    <InfoTip
      text="元数据、向量与全文都在同一个 PostgreSQL 里；连接串由环境变量 KYLAB_DATABASE_URL 决定，改后需重启后端。"
    />
  </h3>
  <div class="row row-static">
    <div class="row-main">
      <span class="row-label">元数据</span>
      <span class="row-value">PostgreSQL（含运行期配置与任务队列）</span>
    </div>
  </div>
  <div class="row row-static">
    <div class="row-main">
      <span class="row-label">向量</span>
      <span class="row-value">pgvector（HNSW 索引，按知识库分区，维度随库）</span>
    </div>
  </div>
  <div class="row row-static">
    <div class="row-main">
      <span class="row-label">全文检索</span>
      <span class="row-value">tsvector + jieba 分词</span>
    </div>
  </div>
  <div class="row row-static">
    <div class="row-main">
      <span class="row-label">原文与图片</span>
      <span class="row-value">对象存储：本地目录或 S3 兼容服务，按内容 hash 寻址</span>
    </div>
  </div>
  <div class="row row-static">
    <div class="row-main">
      <span class="row-label">知识库数量</span>
      <span class="row-value tabular">{{ kbCount }}</span>
    </div>
  </div>

  <h3 class="section-title section-gap">空间占用</h3>
  <p v-if="storageError" class="error-line">{{ storageError }}</p>
  <template v-else-if="storage">
    <div class="row row-static">
      <div class="row-main">
        <span class="row-label">数据库大小</span>
        <span class="row-value tabular">{{ formatBytes(storage.file_bytes) }}</span>
      </div>
    </div>
    <div class="row row-static">
      <div class="row-main">
        <span class="row-label">
          其中可回收
          <InfoTip
            text="删掉的行只留下死元组，数据库大小不会因此变小；「整理存储」把它们标成可复用，占用不会立刻下降。"
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
          清理无主分区并回收死元组。会重写含死元组的表页，大库需要几十秒（不阻塞写入，但查询会变慢）。
        </span>
      </div>
      <AppButton :disabled="compacting || storageLoading" @click="compactConfirmOpen = true">
        {{ compacting ? '整理中…' : '整理存储' }}
      </AppButton>
    </div>
  </template>
  <p v-else class="row-hint">{{ storageLoading ? '正在读取存储信息…' : '' }}</p>

  <ConfirmDialog
    v-model:open="compactConfirmOpen"
    title="整理存储"
    lead="清理无主向量分区并回收死元组？"
    note="只清理无主数据，不动文档、切块与向量。库大时 VACUUM (ANALYZE) 要几十秒，期间查询会变慢。"
    confirm-label="开始整理"
    :busy="compacting"
    busy-label="整理中…"
    @confirm="runCompact"
  />
</template>
