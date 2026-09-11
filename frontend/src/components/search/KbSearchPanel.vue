<script setup lang="ts">
/**
 * 知识库内的检索面板（《前端设计规范》§6）。
 *
 * 检索本来就是"在某个库里查东西"，单独占一个全局页面没有道理：
 * 用户得先去检索台、再从下拉里挑库，而那一刻他其实已经站在那个库里了。
 * 所以检索收进知识库详情页，用弹窗打开——检索是**动作**，不是常驻视图。
 *
 * 面板里刻意把**通道与分数摊开**（向量 / BM25、各自排名与原始分）：
 * 它同时承担"这个库检索质量如何"的验证责任。
 * 服务端没配 embedding API Key 时是确定性哈希兜底（只有词面重叠、没有语义），
 * 此时必须明说"向量召回不可信"，否则用户会把兜底结果当成真实效果。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import { search, type SearchHit, type SearchResponse } from '@/api/search'
import IconImage from '@/components/icons/IconImage.vue'
import IconSearch from '@/components/icons/IconSearch.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppModal from '@/components/ui/AppModal.vue'
import AppSelect from '@/components/ui/AppSelect.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import SkeletonBlock from '@/components/ui/SkeletonBlock.vue'
import { formatAge, formatScore } from '@/composables/useFormat'
import { useToast } from '@/composables/useToast'

interface Turn {
  query: string
  response: SearchResponse | null
  error: string
  /** 发起时间：会话历史里要能看出"这是刚才那次"还是"十分钟前那次"。 */
  at: number
}

const props = defineProps<{ kbId: string; kbName: string }>()
const open = defineModel<boolean>('open', { required: true })

const { notifyError, notifyWarning } = useToast()

const query = ref('')
const mode = ref<'hybrid' | 'vector' | 'fulltext'>('hybrid')

/** 下拉选项：与 AppSelect 的 `{value,label}` 口径一致（《界面评审与改进计划》§1）。 */
const MODE_OPTIONS = [
  { value: 'hybrid', label: '混合（向量 + BM25）' },
  { value: 'vector', label: '仅向量' },
  { value: 'fulltext', label: '仅 BM25' },
]
/** 数字输入留成字符串交给原生 input，提交时再转——避免 v-model.number 与输入框类型打架。 */
const topK = ref('8')
const candidateK = ref('40')
const rerank = ref(false)

const turns = ref<Turn[]>([])
const searching = ref(false)
/** 当前在看第几次检索：会话历史可点，右侧结果跟着切。 */
const activeTurn = ref(-1)

/**
 * 会话历史里的"多久之前"需要一个会走的时钟。
 * 不引定时器的话，模板读到的 Date.now() 不会自己变，标签会一直停在首次渲染的时刻。
 */
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | null = null

/** 只在面板打开时走时钟与保留历史的意义，关掉就停表。 */
watch(open, (isOpen) => {
  if (isOpen && clock === null) {
    clock = setInterval(() => {
      now.value = Date.now()
    }, 10_000)
  } else if (!isOpen && clock !== null) {
    clearInterval(clock)
    clock = null
  }
})

onBeforeUnmount(() => {
  if (clock !== null) clearInterval(clock)
})

const latest = computed(() => turns.value[activeTurn.value] ?? null)

/** 命中过多时正文收成三行摘要：一屏放不下两条结果就没法相互比较。 */
const showFullText = computed(() => (latest.value?.response?.hits.length ?? 0) <= 8)

const embeddingIsDevelopment = computed(
  () => latest.value?.response?.embedding_is_development === true,
)

/** 没配嵌入模型：向量通道被跳过，本次只做了关键词检索。 */
const embeddingMissing = computed(() => latest.value?.response?.embedding_configured === false)

function selectTurn(index: number): void {
  activeTurn.value = index
}

async function runSearch(): Promise<void> {
  const text = query.value.trim()
  if (!text) {
    notifyWarning('请输入检索内容')
    return
  }

  searching.value = true
  const turn: Turn = { query: text, response: null, error: '', at: Date.now() }
  turns.value = [...turns.value, turn]
  activeTurn.value = turns.value.length - 1
  try {
    turn.response = await search({
      query: text,
      kb_ids: [props.kbId],
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
    activeTurn.value = turns.value.length - 1
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
  <AppModal v-model:open="open" size="wide" :title="`在「${kbName}」中检索`">
    <div class="panel">
      <div class="query-col">
        <div class="field">
          <label class="field-label" for="kb-search-input">检索内容</label>
          <AppInput
            id="kb-search-input"
            v-model="query"
            multiline
            :rows="3"
            placeholder="输入问题或关键词，回车检索"
            @keydown.enter.exact.prevent="runSearch"
          />
        </div>

        <div class="field-row">
          <label class="field field-block">
            <span class="field-label">模式</span>
            <AppSelect v-model="mode" :options="MODE_OPTIONS" aria-label="检索模式" />
          </label>
          <label class="field field-block field-narrow">
            <span class="field-label">返回条数</span>
            <AppInput v-model="topK" type="number" />
          </label>
        </div>

        <details class="advanced">
          <summary>高级选项</summary>
          <div class="field-row">
            <label class="field field-block field-narrow">
              <span class="field-label">候选池</span>
              <AppInput v-model="candidateK" type="number" />
            </label>
            <label class="checkbox-field">
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
            <li v-for="(turn, index) in turns" :key="index">
              <button
                class="history-item"
                :class="{ 'history-item-active': index === activeTurn }"
                type="button"
                @click="selectTurn(index)"
              >
                <span class="history-query">{{ turn.query }}</span>
                <span class="history-hits tabular">
                  {{ turn.response ? `${turn.response.hits.length} 条` : '—' }}
                </span>
                <span class="history-age tabular">{{ formatAge(turn.at, now) }}</span>
              </button>
            </li>
          </ul>
        </div>
      </div>

      <div class="hits-col">
        <SkeletonBlock v-if="searching" variant="text" :rows="6" />

        <EmptyState
          v-else-if="!latest"
          title="还没有检索记录"
          hint="左侧输入内容；结果会显示每条命中来自哪条通道、各自排名多少。"
        />

        <p v-else-if="latest.error" class="error-line">{{ latest.error }}</p>

        <template v-else-if="latest.response">
          <div class="hit-summary">
            <span class="summary-main">
              {{ latest.response.hits.length }} 条命中<span class="sep">·</span
              >{{ modeLabel(latest.response.mode) }}
            </span>
            <span v-if="latest.response.reranked" class="summary-note">已 rerank</span>
            <span v-if="latest.response.filtered_out > 0" class="summary-note summary-warn">
              元数据过滤掉 {{ latest.response.filtered_out }} 条
            </span>
          </div>

          <p v-if="embeddingMissing" class="dev-warning">
            <strong>本次只做了关键词检索：</strong>
            服务端未选定嵌入模型，向量通道已跳过。请到「设置 → 向量化」选定默认嵌入模型后重试。
          </p>
          <p v-else-if="embeddingIsDevelopment" class="dev-warning">
            <strong>向量召回不代表真实效果：</strong>
            当前用的是开发用确定性哈希（只反映词面重叠，没有语义）。 BM25
            的结果是可信的，向量分数仅供链路自测。
          </p>

          <!-- 通道耗时：三列对齐，数字沿一条竖轴 -->
          <div v-if="latest.response.stats.length" class="channel-block">
            <div class="channel-head" aria-hidden="true">
              <span class="col-name">通道</span>
              <span class="col-count">候选</span>
              <span class="col-ms">耗时</span>
            </div>
            <ul class="channel-stats">
              <li v-for="stat in latest.response.stats" :key="stat.channel" class="channel-stat">
                <span class="col-name">{{ channelLabel(stat.channel) }}</span>
                <span class="col-count">{{ stat.count }}</span>
                <span class="col-ms">{{ stat.elapsed_ms.toFixed(1) }} ms</span>
              </li>
            </ul>
          </div>

          <EmptyState
            v-if="latest.response.hits.length === 0"
            title="没有命中"
            hint="换关键词、放宽模式到混合检索，或确认文档已经处理到「已索引」。"
          />

          <!-- 命中：引文块 + 右对齐分数轴 -->
          <ol v-else class="hit-list">
            <li v-for="hit in latest.response.hits" :key="hitKey(hit)" class="hit">
              <div class="hit-head">
                <span class="hit-source">
                  <RouterLink class="hit-title" :to="`/documents/${hit.document_id}`">
                    {{ hit.document_name ?? hit.document_id }}
                  </RouterLink>
                  <span v-if="hit.heading_path" class="hit-heading">{{ hit.heading_path }}</span>
                  <span v-if="hit.page !== null" class="hit-page">第 {{ hit.page }} 页</span>
                </span>
                <span class="hit-score" :title="`融合分数 ${formatScore(hit.score)}`">
                  {{ formatScore(hit.score) }}
                </span>
              </div>

              <p class="hit-text" :class="{ 'hit-text-clamped': !showFullText }">{{ hit.text }}</p>

              <!-- 命中通道：三列对齐，一眼看出这条是靠哪条通道捞上来的 -->
              <ul class="hit-channels">
                <li v-for="channel in hit.channels" :key="channel" class="hit-channel">
                  <span class="col-name">{{ channelLabel(channel) }}</span>
                  <span class="col-rank tabular">第 {{ hit.ranks[channel] ?? '—' }} 位</span>
                  <span class="col-raw tabular">{{ formatScore(hit.raw_scores[channel]) }}</span>
                </li>
                <li v-if="hit.image_ids.length" class="hit-images">
                  <IconImage :size="13" />{{ hit.image_ids.length }} 张图
                </li>
              </ul>
            </li>
          </ol>
        </template>
      </div>
    </div>
  </AppModal>
</template>

<style scoped>
/* 左窄右宽：左边是"怎么查"，右边是"查到了什么" */
.panel {
  display: grid;
  grid-template-columns: 280px 1fr;
  gap: var(--space-6);
  min-height: 420px;
  max-height: 66vh;
}

.query-col {
  overflow-y: auto;
  padding-right: var(--space-1);
}

.hits-col {
  overflow-y: auto;
  padding-left: var(--space-6);
  border-left: 1px solid var(--border-hairline);
}

/* 成组容器与标签走全局 .field / .field-label（base.css）；
   这里只保留本面板特有的"块间距"与窄列 */
.field-block {
  margin-bottom: var(--space-4);
}

.field-narrow {
  max-width: 96px;
}

.field-row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
}

.checkbox-field {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--hit-target);
  font-size: var(--text-meta-size);
}

.checkbox-field input[type='checkbox'] {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  accent-color: var(--text-secondary);
}

.advanced {
  margin-bottom: var(--space-4);
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
}

.advanced summary {
  padding: var(--space-1) 0;
  cursor: pointer;
}

.section-label {
  margin: var(--space-6) 0 var(--space-2);
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.history-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.history-item {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-1) var(--space-2);
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
  text-align: left;
  border-radius: var(--radius-control);
}

.history-item:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

/* 选中项用 hover 底 + 左侧 2px：active 底比 hover 深，会把三级灰压到 4.5 以下 */
.history-item-active {
  background: var(--bg-hover);
  color: var(--text-primary);
  box-shadow: inset 2px 0 0 var(--text-secondary);
}

.history-query {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 会话历史里的两列数字用二级灰：三级灰落在 hover 底上会掉到 4.3:1 */
.history-hits,
.history-age {
  flex: 0 0 auto;
  font-size: var(--text-micro-size);
  color: var(--text-secondary);
}

.error-line {
  margin: 0;
  color: var(--status-danger);
}

.hit-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
}

.summary-main {
  color: var(--text-primary);
}

.summary-note {
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.summary-warn {
  color: var(--status-warning);
}

.dev-warning {
  margin: 0 0 var(--space-6);
  padding: var(--space-3) var(--space-4);
  max-width: var(--measure);
  font-size: var(--text-meta-size);
  color: var(--text-primary);
  background: var(--bg-subtle);
  border-left: 2px solid var(--status-warning);
  border-radius: 0 var(--radius-control) var(--radius-control) 0;
}

.channel-block,
.channel-stats,
.hit-channels {
  --grid-name: 64px;
  --grid-count: 56px;
  --grid-number: 72px;
}

.channel-block {
  margin-bottom: var(--space-6);
}

.channel-head,
.channel-stat,
.hit-channel {
  display: grid;
  grid-template-columns: var(--grid-name) var(--grid-count) var(--grid-number);
  gap: var(--space-3);
  align-items: baseline;
}

.channel-head {
  padding-bottom: var(--space-1);
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
  border-bottom: 1px solid var(--border-hairline);
}

.col-name {
  color: var(--text-secondary);
}

.col-count,
.col-ms,
.col-rank,
.col-raw {
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}

.col-count,
.col-ms,
.col-raw {
  text-align: right;
}

.channel-stats {
  margin: 0;
  padding: 0;
  font-size: var(--text-micro-size);
  list-style: none;
}

.channel-stat {
  height: var(--hit-target);
}

.hit-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

/* 命中是一块圆角引文卡：容器给边界，块与块之间只留呼吸 */
.hit {
  padding: var(--space-4);
  background: var(--bg-canvas);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-panel);
}

.hit + .hit {
  margin-top: var(--space-3);
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
  font-size: var(--text-section-size);
  font-weight: 500;
  color: var(--text-primary);
}

.hit-heading,
.hit-page {
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.hit-heading {
  overflow: hidden;
  max-width: 40ch;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hit-score {
  flex: 0 0 auto;
  font-size: var(--text-meta-size);
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}

.hit-text {
  margin: var(--space-2) 0 0;
  max-width: var(--measure);
  color: var(--text-primary);
  white-space: pre-wrap;
}

.hit-text-clamped {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.hit-channels {
  margin: var(--space-3) 0 0;
  padding: 0;
  font-size: var(--text-micro-size);
  list-style: none;
}

.hit-channel {
  height: var(--hit-target);
}

.hit-images {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  height: var(--hit-target);
  color: var(--text-tertiary);
}

/* 窄屏：双栏退化为单栏（§8） */
@media (max-width: 900px) {
  .panel {
    grid-template-columns: 1fr;
    max-height: none;
  }

  .hits-col {
    padding-left: 0;
    padding-top: var(--space-5);
    border-left: none;
    border-top: 1px solid var(--border-hairline);
  }
}
</style>
