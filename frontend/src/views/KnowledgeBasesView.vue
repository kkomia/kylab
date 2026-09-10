<script setup lang="ts">
/**
 * 知识库（卡片）。
 *
 * 为什么这里用卡片、而文档清单用行：知识库是**容器型对象且数量少**，
 * 用户的动作是"挑一个进去"（扫视比较），不是"在长列表里找某一条"。
 * 卡片给每个库一个独立边界，正好承载"名称 + 规模 + 模型 + 入口"这一小簇信息。
 * 条目多起来时（>12）切回行——这条判定规则原本就写在规范 §5.1，这一轮把它落实。
 *
 * 页头留了一个**对话入口**的位置：知识库问答（拿库内容直接提问）是下一步，
 * 这里先放一个禁用态的入口与一句说明，不做点了没反应的假控件。
 */
import { computed, onMounted, ref } from 'vue'

import IconChat from '@/components/icons/IconChat.vue'
import IconPlus from '@/components/icons/IconPlus.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppModal from '@/components/ui/AppModal.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import PageShell from '@/components/ui/PageShell.vue'
import SkeletonBlock from '@/components/ui/SkeletonBlock.vue'
import { formatRelativeTime } from '@/composables/useFormat'
import { useToast } from '@/composables/useToast'
import { useKnowledgeBaseStore } from '@/stores/knowledgeBases'

/** 规范 §5.1 的阈值：超过 12 个容器就用行而不是卡片，避免格子被挤窄。 */
const CARD_LIMIT = 12

const store = useKnowledgeBaseStore()
const { notifyError, notifySuccess } = useToast()

const createOpen = ref(false)
const draftName = ref('')
const creating = ref(false)

const hasItems = computed(() => store.items.length > 0)
const useCards = computed(() => store.items.length <= CARD_LIMIT)

const summaryLine = computed(() => {
  if (!hasItems.value) return undefined
  const counts = Object.values(store.summaries)
  if (counts.length === 0) return `${store.items.length} 个知识库`
  const total = counts.reduce((sum, item) => sum + item.count, 0)
  return `${store.items.length} 个知识库 · 共 ${total} 篇文档`
})

onMounted(() => {
  void store.load().then(() => store.loadSummaries())
})

async function submitCreate(): Promise<void> {
  const name = draftName.value.trim()
  if (!name) {
    notifyError('知识库名称不能为空')
    return
  }
  creating.value = true
  try {
    const created = await store.create({ name })
    notifySuccess(`已创建知识库「${created.name}」`)
    createOpen.value = false
    draftName.value = ''
    void store.loadSummaries()
  } catch (error) {
    notifyError(error instanceof Error ? error.message : '创建失败')
  } finally {
    creating.value = false
  }
}

function initial(name: string): string {
  return name.trim().slice(0, 1).toUpperCase()
}

function statsOf(kbId: string) {
  return store.summaries[kbId]
}
</script>

<template>
  <PageShell title="知识库" :description="summaryLine">
    <template #actions>
      <AppButton variant="primary" @click="createOpen = true">
        <template #icon><IconPlus /></template>
        新建知识库
      </AppButton>
    </template>

    <!--
      对话入口横幅：以前这里是"尚未开放"的禁用按钮——现在对话已经通了（/chat），
      留着禁用按钮就是在告诉用户一个不成立的事实。改成真正的入口。
      「在此库检索」仍然保留：它回答"哪个块最像"，对话回答"这些资料怎么说"，
      两者不是替代关系（界面信息架构草案 §2）。
    -->
    <RouterLink class="ask-slot" to="/chat">
      <span class="ask-icon" aria-hidden="true"><IconChat /></span>
      <span class="ask-text">
        <span class="ask-title">对话式快速检索</span>
        <span class="ask-hint">
          选一个或多个知识库直接提问，回答只依据库里的原文，并逐条标出出处。
        </span>
      </span>
      <span class="ask-go">去提问</span>
    </RouterLink>

    <p v-if="store.error" class="error-line">{{ store.error }}</p>
    <SkeletonBlock v-if="store.loading && !hasItems" variant="card" :rows="4" />

    <EmptyState
      v-else-if="!hasItems"
      title="还没有知识库"
      hint="知识库是最外层的容器，每个库对应一套 embedding 模型与一组切分参数。"
    >
      <AppButton variant="primary" @click="createOpen = true">
        <template #icon><IconPlus /></template>
        新建知识库
      </AppButton>
    </EmptyState>

    <!-- 卡片网格：容器型对象、条目少，用卡片承载"挑一个进去"这个动作 -->
    <ul v-else-if="useCards" class="kb-cards">
      <li v-for="kb in store.items" :key="kb.id">
        <RouterLink class="kb-card" :to="`/kb/${kb.id}`">
          <span class="kb-card-head">
            <span class="kb-mark" aria-hidden="true">{{ initial(kb.name) }}</span>
            <span class="kb-card-title">
              <span class="kb-name">{{ kb.name }}</span>
              <span class="kb-model">{{ kb.embedding_model_id }}</span>
            </span>
          </span>

          <span class="kb-card-stats">
            <span class="stat">
              <span class="stat-value tabular">{{ statsOf(kb.id)?.count ?? '—' }}</span>
              <span class="stat-label">文档</span>
            </span>
            <span class="stat">
              <span class="stat-value tabular">{{ kb.embedding_dim }}</span>
              <span class="stat-label">维度</span>
            </span>
            <span class="stat">
              <span class="stat-value tabular">{{ kb.chunk_size }}</span>
              <span class="stat-label">块长</span>
            </span>
          </span>

          <span class="kb-card-foot">
            最近更新 {{ formatRelativeTime(statsOf(kb.id)?.updatedAt ?? null) }}
          </span>
        </RouterLink>
      </li>
    </ul>

    <!-- 超过阈值切回列表：格子被挤窄之后，"挑一个"反而更慢 -->
    <div v-else class="panel">
      <div class="panel-head kb-head" aria-hidden="true">
        <span class="col-name">知识库</span>
        <span class="col-num">文档</span>
        <span class="col-time">最近更新</span>
      </div>
      <ul class="kb-rows">
        <li v-for="kb in store.items" :key="kb.id" class="kb-row panel-row">
          <RouterLink class="kb-link" :to="`/kb/${kb.id}`">
            <span class="col-name">
              <span class="kb-mark-sm" aria-hidden="true">{{ initial(kb.name) }}</span>
              <span class="kb-name">{{ kb.name }}</span>
              <span class="kb-model">{{ kb.embedding_model_id }}</span>
            </span>
            <span class="col-num tabular">{{ statsOf(kb.id)?.count ?? '—' }}</span>
            <span class="col-time tabular">
              {{ formatRelativeTime(statsOf(kb.id)?.updatedAt ?? null) }}
            </span>
          </RouterLink>
        </li>
      </ul>
    </div>

    <AppModal v-model:open="createOpen" title="新建知识库">
      <label class="field-label" for="kb-name">名称</label>
      <AppInput
        id="kb-name"
        v-model="draftName"
        placeholder="例如：产品手册"
        @keyup.enter="submitCreate"
      />
      <p class="field-hint">
        模型与切分参数用服务端默认值。库内已有向量后再改模型会被拒绝，详见架构 §6.4。
      </p>
      <template #footer>
        <AppButton @click="createOpen = false">取消</AppButton>
        <AppButton variant="primary" :disabled="creating" @click="submitCreate">
          {{ creating ? '创建中…' : '创建' }}
        </AppButton>
      </template>
    </AppModal>
  </PageShell>
</template>

<style scoped>
.error-line {
  margin: var(--space-4) 0;
  color: var(--status-danger);
}

/* 对话入口：从"虚线预留位"改成实心可点横幅。
   虚线 + 禁用按钮原本是表达"还没做"，现在功能已经有了，虚线反而读成"这里不重要"。 */
.ask-slot {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-5);
  padding: var(--space-3) var(--space-4);
  color: inherit;
  text-decoration: none;
  background: var(--accent-soft);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-panel);
  transition: border-color 120ms ease;
}

.ask-slot:hover {
  border-color: var(--accent);
}

.ask-slot:hover .ask-go {
  background: var(--accent-selected);
}

.ask-icon {
  display: inline-flex;
  color: var(--accent);
}

.ask-text {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: var(--space-1);
}

/* 入场动作：它是横幅的"该点这里"，用文字而非按钮——整条横幅都可点，
   再放一个按钮会出现两个可点目标指向同一个地方 */
.ask-go {
  flex: 0 0 auto;
  padding: var(--space-1) var(--space-3);
  font-size: var(--text-meta-size);
  font-weight: 500;
  color: var(--accent-text);
  border-radius: var(--radius-control);
  transition: background-color 120ms ease;
}

.ask-title {
  font-size: var(--text-body-size);
  font-weight: 500;
  color: var(--text-primary);
}

.ask-hint {
  font-size: var(--text-micro-size);
  color: var(--text-secondary);
}

/* 卡片网格：列宽自适应，窄屏退化为单列。
   用 `auto-fit` 而不是 `auto-fill`：`auto-fill` 会**保留空轨道**——实测 1112px 容器
   划出 4 列各 269px，只有 2 个库时右边 558px 全是空的，看起来像"没铺满"。
   `auto-fit` 把没有内容的轨道折叠掉，卡片自己撑开占满整行。 */
.kb-cards {
  display: grid;
  gap: var(--space-3);
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  margin: var(--space-5) 0 0;
  padding: 0;
  list-style: none;
}

.kb-card {
  display: flex;
  height: 100%;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-4);
  color: inherit;
  text-decoration: none;
  background: var(--bg-canvas);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-panel);
  transition:
    border-color 120ms ease,
    background-color 120ms ease;
}

/* hover 只换边框与底色：不做位移/缩放——卡片跳一下是最廉价的动效 */
.kb-card:hover {
  background: var(--bg-surface);
  border-color: var(--border-strong);
  text-decoration: none;
}

.kb-card-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}

.kb-mark,
.kb-mark-sm {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  font-weight: 500;
  color: var(--text-secondary);
  background: var(--bg-surface);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-row);
}

.kb-mark {
  width: 36px;
  height: 36px;
  font-size: 15px;
}

.kb-mark-sm {
  width: 24px;
  height: 24px;
  font-size: var(--text-meta-size);
  border-radius: var(--radius-control);
}

.kb-card-title {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: var(--space-1);
}

.kb-name {
  overflow: hidden;
  font-size: 15px;
  font-weight: 500;
  letter-spacing: -0.005em;
  color: var(--text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kb-model {
  overflow: hidden;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 三个小统计：卡片里唯一的"数字区"，靠一条 hairline 与标题分开 */
.kb-card-stats {
  display: flex;
  gap: var(--space-6);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-hairline);
}

.stat {
  display: flex;
  flex-direction: column;
  /* 数字与标签要读成一个整体，用成对间距令牌（base.css §间距） */
  gap: var(--space-pair);
}

.stat-value {
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--text-primary);
}

.stat-label {
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.kb-card-foot {
  margin-top: auto;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

/* 行形态（超过 12 个时） */
.kb-head,
.kb-link {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}

.kb-head {
  padding: 0 var(--space-4);
}

.kb-rows {
  margin: 0;
  padding: 0;
  list-style: none;
}

.kb-link {
  padding: var(--space-3) var(--space-4);
  color: inherit;
  text-decoration: none;
  border-radius: var(--radius-row);
}

.kb-link:hover {
  text-decoration: none;
}

.col-name {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex: 1;
  min-width: 0;
}

.col-num {
  flex: 0 0 72px;
  text-align: right;
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
}

.col-time {
  flex: 0 0 120px;
  text-align: right;
  font-size: var(--text-meta-size);
  color: var(--text-tertiary);
}

.field-label {
  display: block;
  margin-bottom: var(--space-2);
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
}

.field-hint {
  margin: var(--space-3) 0 0;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}
</style>
