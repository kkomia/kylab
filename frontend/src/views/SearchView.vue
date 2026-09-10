<script setup lang="ts">
/**
 * 检索调试台（《前端设计规范 v0.3》§6）：左查询流 / 右命中面板。
 *
 * 这个页面同时承担"验证检索质量"的责任，所以刻意把**通道与分数摊开**：
 * 每个命中显示它来自哪几条通道（向量 / BM25）、各自排名与原始分。
 * 后端没配 embedding API Key 时是确定性哈希兜底（只有词面重叠、没有语义），
 * 此时界面必须明说"向量召回不可信"，否则用户会把兜底结果当成真实效果。
 */
import { computed, onMounted, ref } from 'vue'

import { search, type SearchHit, type SearchResponse } from '@/api/search'
import IconImage from '@/components/icons/IconImage.vue'
import IconSearch from '@/components/icons/IconSearch.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppInput from '@/components/ui/AppInput.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import PageHeader from '@/components/ui/PageHeader.vue'
import SkeletonBlock from '@/components/ui/SkeletonBlock.vue'
import { formatScore } from '@/composables/useFormat'
import { useToast } from '@/composables/useToast'
import { useKnowledgeBaseStore } from '@/stores/knowledgeBases'

interface Turn {
  query: string
  response: SearchResponse | null
  error: string
}

const store = useKnowledgeBaseStore()
const { notifyError, notifyWarning } = useToast()

const query = ref('')
const mode = ref<'hybrid' | 'vector' | 'fulltext'>('hybrid')
/** 数字输入留成字符串交给原生 input，提交时再转——避免 v-model.number 与输入框类型打架。 */
const topK = ref('8')
const candidateK = ref('40')
const rerank = ref(false)
const selectedKbIds = ref<string[]>([])

const turns = ref<Turn[]>([])
const searching = ref(false)

onMounted(async () => {
  if (store.items.length === 0) await store.load()
  selectedKbIds.value = store.items.map((kb) => kb.id)
})

const latest = computed(() => turns.value[turns.value.length - 1] ?? null)

/** 命中条数多时把正文收成三行摘要：一屏只放得下两条的检索结果没法比较 */
const useHitCards = computed(() => (latest.value?.response?.hits.length ?? 0) <= 12)

const embeddingIsDevelopment = computed(
  () => latest.value?.response?.embedding_is_development === true,
)

function toggleKb(kbId: string): void {
  selectedKbIds.value = selectedKbIds.value.includes(kbId)
    ? selectedKbIds.value.filter((id) => id !== kbId)
    : [...selectedKbIds.value, kbId]
}

async function runSearch(): Promise<void> {
  const text = query.value.trim()
  if (!text) {
    notifyWarning('请输入检索内容')
    return
  }
  if (selectedKbIds.value.length === 0) {
    notifyWarning('至少选择一个知识库')
    return
  }

  searching.value = true
  const turn: Turn = { query: text, response: null, error: '' }
  turns.value = [...turns.value, turn]
  try {
    turn.response = await search({
      query: text,
      kb_ids: selectedKbIds.value,
      mode: mode.value,
      top_k: Number(topK.value) || 8,
      candidate_k: Number(candidateK.value) || 40,
      rerank: rerank.value,
    })
    // 整体替换数组：turn 是普通对象，就地改属性不会触发依赖收集
    turns.value = [...turns.value]
  } catch (cause) {
    turn.error = cause instanceof Error ? cause.message : '检索失败'
    turns.value = [...turns.value]
    notifyError(turn.error)
  } finally {
    searching.value = false
  }
}

function channelLabel(channel: string): string {
  return channel === 'vector' ? '向量' : channel === 'fulltext' ? 'BM25' : channel
}

function modeLabel(value: string): string {
  if (value === 'hybrid') return '混合检索'
  if (value === 'vector') return '仅向量'
  if (value === 'fulltext') return '仅 BM25'
  return value
}

/** 命中条目用 chunk_id 作 key：同一文档可能有多个块命中。 */
function hitKey(hit: SearchHit): string {
  return hit.chunk_id
}
</script>

<template>
  <article class="page">
    <PageHeader
      title="检索调试台"
      description="混合检索 = 向量 + BM25，经 RRF 融合排序；只返回原文与分数，不做任何 LLM 加工。"
    />

    <div class="console">
      <section class="pane pane-query">
        <div class="pane-body">
          <div class="field">
            <label class="field-label" for="search-input">检索内容</label>
            <AppInput
              id="search-input"
              v-model="query"
              multiline
              :rows="3"
              placeholder="输入问题或关键词，回车检索"
              @keydown.enter.exact.prevent="runSearch"
            />
          </div>

          <div class="field">
            <span class="field-label">知识库</span>
            <div v-if="store.items.length === 0" class="muted">还没有知识库</div>
            <div v-else class="kb-picker">
              <label v-for="kb in store.items" :key="kb.id" class="kb-option">
                <input
                  type="checkbox"
                  :checked="selectedKbIds.includes(kb.id)"
                  @change="toggleKb(kb.id)"
                />
                <span>{{ kb.name }}</span>
              </label>
            </div>
          </div>

          <div class="field-row">
            <label class="field">
              <span class="field-label">模式</span>
              <select v-model="mode" class="select">
                <option value="hybrid">混合（向量 + BM25）</option>
                <option value="vector">仅向量</option>
                <option value="fulltext">仅 BM25</option>
              </select>
            </label>
            <label class="field">
              <span class="field-label">返回条数</span>
              <AppInput v-model="topK" type="number" />
            </label>
          </div>

          <details class="advanced">
            <summary>高级选项</summary>
            <div class="field-row">
              <label class="field">
                <span class="field-label">候选池</span>
                <AppInput v-model="candidateK" type="number" />
              </label>
              <label class="field checkbox-field">
                <input v-model="rerank" type="checkbox" />
                <span>启用 rerank（失败自动退回 RRF 顺序）</span>
              </label>
            </div>
          </details>

          <AppButton variant="primary" :disabled="searching" @click="runSearch">
            <template #icon><IconSearch /></template>
            {{ searching ? '检索中…' : '检索' }}
          </AppButton>

          <div v-if="turns.length" class="history">
            <p class="section-label">本次会话</p>
            <ul class="history-list">
              <li v-for="(turn, index) in turns" :key="index" class="history-item">
                {{ turn.query }}
              </li>
            </ul>
          </div>
        </div>
      </section>

      <section class="pane pane-hits">
        <div class="pane-body">
          <SkeletonBlock v-if="searching" variant="text" :rows="6" />

          <EmptyState
            v-else-if="!latest"
            title="还没有检索记录"
            hint="左侧输入内容并选择知识库；结果会显示每条命中来自哪条通道、各自排名多少。"
          />

          <p v-else-if="latest.error" class="error-line">{{ latest.error }}</p>

          <template v-else-if="latest.response">
            <div class="hit-summary">
              <span class="summary-main">
                {{ latest.response.hits.length }} 条命中<span class="summary-sep">·</span
                >{{ modeLabel(latest.response.mode) }}
              </span>
              <span v-if="latest.response.reranked" class="summary-note">已 rerank</span>
              <span v-if="latest.response.filtered_out > 0" class="summary-note summary-warn">
                元数据过滤掉 {{ latest.response.filtered_out }} 条
              </span>
            </div>

            <p v-if="embeddingIsDevelopment" class="dev-warning">
              <strong>向量召回不代表真实效果：</strong>
              服务端未配置 embedding API Key，正在用确定性哈希兜底（只反映词面重叠，没有语义）。
              此模式下 BM25 的结果是可信的，向量分数仅供链路自测。
            </p>

            <ul v-if="latest.response.stats.length" class="channel-stats">
              <li v-for="stat in latest.response.stats" :key="stat.channel" class="channel-stat">
                <span class="stat-name">{{ channelLabel(stat.channel) }}</span>
                <span class="stat-count">{{ stat.count }}</span>
                <span class="stat-ms">{{ stat.elapsed_ms.toFixed(1) }} ms</span>
              </li>
            </ul>

            <EmptyState
              v-if="latest.response.hits.length === 0"
              title="没有命中"
              hint="换关键词、放宽模式到混合检索，或确认文档已经处理到「已索引」。"
            />

            <!-- 命中：引文块 + 右对齐分数轴。分数是这个页面的产物，不该缩成小徽标 -->
            <ol v-else class="hit-list">
              <li v-for="hit in latest.response.hits" :key="hitKey(hit)" class="hit">
                <div class="hit-head">
                  <span class="hit-source">
                    <RouterLink class="hit-title" :to="`/documents/${hit.document_id}`">
                      {{ hit.document_name ?? hit.document_id }}
                    </RouterLink>
                    <span v-if="hit.heading_path" class="hit-heading">
                      {{ hit.heading_path }}
                    </span>
                    <span v-if="hit.page !== null" class="hit-page">第 {{ hit.page }} 页</span>
                  </span>
                  <span class="hit-score" :title="`融合分数 ${formatScore(hit.score)}`">
                    {{ formatScore(hit.score) }}
                  </span>
                </div>

                <p v-if="useHitCards" class="hit-text">{{ hit.text }}</p>
                <p v-else class="hit-text hit-text-clamped">{{ hit.text }}</p>

                <div class="hit-channels">
                  <span v-for="channel in hit.channels" :key="channel" class="channel">
                    {{ channelLabel(channel) }} 第 {{ hit.ranks[channel] ?? '—' }} 位
                  </span>
                  <span v-if="hit.image_ids.length" class="hit-images">
                    <IconImage :size="13" />{{ hit.image_ids.length }} 张图
                  </span>
                </div>
              </li>
            </ol>
          </template>
        </div>
      </section>
    </div>
  </article>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: var(--space-8) var(--page-gutter) var(--space-6);
}

/* 双栏：左查询流 / 右命中面板（§6）。左栏窄而定宽，右栏承接阅读 */
.console {
  display: grid;
  flex: 1;
  min-height: 0;
  grid-template-columns: 288px 1fr;
  margin-top: var(--space-6);
}

.pane {
  overflow-y: auto;
}

.pane-query {
  padding-right: var(--space-6);
  border-right: 1px solid var(--border-hairline);
}

.pane-hits .pane-body {
  padding-left: var(--space-6);
}

.field {
  display: block;
  margin-bottom: var(--space-4);
}

.field-row {
  display: flex;
  gap: var(--space-3);
}

.field-label {
  display: block;
  margin-bottom: var(--space-2);
  font-size: 12.5px;
  color: var(--text-secondary);
}

.select {
  width: 100%;
  height: 32px;
  padding: 0 var(--space-2);
  font: inherit;
  color: var(--text-primary);
  background: var(--bg-surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-control);
}

.kb-picker {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.kb-option,
.checkbox-field {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: 13px;
}

.checkbox-field {
  margin-top: var(--space-5);
}

.advanced {
  margin-bottom: var(--space-4);
  font-size: 13px;
  color: var(--text-secondary);
}

.advanced summary {
  cursor: pointer;
}

.section-label {
  margin: var(--space-5) 0 var(--space-2);
  font-size: 12px;
  color: var(--text-tertiary);
}

.history-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.history-item {
  padding: 3px 0;
  overflow: hidden;
  font-size: 13px;
  color: var(--text-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.muted {
  font-size: 13px;
  color: var(--text-tertiary);
}

.error-line {
  color: var(--status-danger);
}

/* 结果概览：一行文字，不用徽标堆叠 */
.hit-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
  font-size: 13px;
  color: var(--text-secondary);
}

.summary-main {
  color: var(--text-primary);
}

.summary-sep {
  padding: 0 var(--space-1);
  color: var(--border-strong);
}

.summary-note {
  font-size: 12.5px;
  color: var(--text-tertiary);
}

.summary-warn {
  color: var(--status-warning);
}

/* 兜底 embedder 提示：左侧语义色竖条 + 明确文案，不靠颜色单独表意（§8） */
.dev-warning {
  margin: 0 0 var(--space-5);
  padding: var(--space-3) var(--space-4);
  max-width: var(--measure);
  font-size: 13px;
  color: var(--text-primary);
  background: var(--bg-subtle);
  border-left: 2px solid var(--status-warning);
}

/* 通道耗时：名称左、数字右，沿同一竖轴 */
.channel-stats {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-5);
  margin: 0 0 var(--space-5);
  padding: 0;
  font-size: 12.5px;
  list-style: none;
}

.channel-stat {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}

.stat-name {
  color: var(--text-secondary);
}

.stat-count,
.stat-ms {
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}

/* 命中列表：引文块之间只留呼吸与一条 hairline */
.hit-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.hit + .hit {
  border-top: 1px solid var(--border-hairline);
}

.hit {
  padding: var(--space-4) 0;
}

.hit-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-4);
}

.hit-source {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-3);
  min-width: 0;
}

.hit-title {
  font-size: 14.5px;
  font-weight: 600;
  color: var(--text-primary);
}

.hit-heading,
.hit-page {
  font-size: 12.5px;
  color: var(--text-tertiary);
}

.hit-heading {
  overflow: hidden;
  max-width: 40ch;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 分数是这个页面的产物：等宽、右对齐、可扫视 */
.hit-score {
  flex: 0 0 auto;
  font-size: 13px;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}

.hit-text {
  margin: var(--space-2) 0 0;
  max-width: var(--measure);
  color: var(--text-primary);
  white-space: pre-wrap;
}

/* 命中过多时收紧为摘要：三行封顶，避免一屏只放得下两条 */
.hit-text-clamped {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.hit-channels {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-4);
  margin-top: var(--space-2);
  font-size: 12px;
  color: var(--text-tertiary);
}

.channel {
  font-variant-numeric: tabular-nums;
}

.hit-images {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

/* 窄屏：双栏退化为单栏（§8） */
@media (max-width: 900px) {
  .console {
    grid-template-columns: 1fr;
    height: auto;
  }

  .pane-query {
    padding-right: 0;
    padding-bottom: var(--space-5);
    border-right: none;
    border-bottom: 1px solid var(--border-hairline);
  }

  .pane-hits .pane-body {
    padding-left: 0;
  }
}
</style>
