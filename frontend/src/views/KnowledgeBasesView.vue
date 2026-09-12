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

import { getRegistry, type Registry } from '@/api/modelRegistry'
import IconPlus from '@/components/icons/IconPlus.vue'
import KnowledgeBaseMenu from '@/components/knowledge/KnowledgeBaseMenu.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppModal from '@/components/ui/AppModal.vue'
import AppSelect from '@/components/ui/AppSelect.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import InfoTip from '@/components/ui/InfoTip.vue'
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
const draftModel = ref('')
const creating = ref(false)

/**
 * 可选的嵌入模型：从注册表里筛出声明了 embedding 能力的。
 *
 * **为什么建库才选**（用户提出的设计调整）：嵌入模型原先全局一套，所有库共用，
 * 于是"文档量小的库用高精度模型、量大的用小模型提速"做不到。现在它是知识库属性，
 * 建库时定、随库冻结（库内一旦有向量就不能换，换模型要新建库）。
 *
 * **没有模型就不许建库**（v0.8 取消哈希兜底）：向量空间是库的地基，
 * 与其建出一个检索不了的库，不如在这里挡住并说清去哪儿配。
 */
const registry = ref<Registry | null>(null)

/** 注册表是否已拉过。**"还在加载"与"确实没有模型"必须分开**：
 *  否则进页面的一瞬间 embeddingModels 是空的，页头会先闪一下"还没有可用的嵌入模型"
 *  再消失（实测到的 bug）。 */
const modelsLoaded = ref(false)

const embeddingModels = computed(() =>
  (registry.value?.models ?? []).filter(
    (model) => model.capabilities.length === 0 || model.capabilities.includes('embedding'),
  ),
)

/** 注册表里为「向量化」选定的默认模型（设置 → 向量化 里选的那个）。 */
const defaultModelPk = computed(
  () => registry.value?.slots.find((item) => item.slot === 'embedding')?.bound_model_pk ?? '',
)

const defaultModel = computed(() =>
  embeddingModels.value.find((model) => model.id === defaultModelPk.value),
)

const defaultLabel = computed(() => {
  const model = defaultModel.value
  if (!model) return ''
  return `${model.label || model.model_id}${model.dim ? ` · ${model.dim} 维` : ''}`
})

async function loadModels(): Promise<void> {
  try {
    registry.value = await getRegistry()
  } catch {
    // 拿不到注册表不该让整页报错：退化成"没有可选模型"，创建入口会被挡住
    registry.value = null
  } finally {
    modelsLoaded.value = true
  }
}

const embeddingOptions = computed(() => [
  ...(defaultModel.value ? [{ value: '', label: `默认（${defaultLabel.value}）` }] : []),
  ...embeddingModels.value.map((model) => ({
    value: model.id,
    label: `${model.label || model.model_id}${model.dim ? ` · ${model.dim} 维` : ''}`,
  })),
])

/** 没有任何可用的嵌入模型：建库入口整体挡掉，并指路「模型注册」。
 *  **加载完成前不算"没有"**——那是闪一下的误报。 */
const noEmbeddingModel = computed(() => modelsLoaded.value && embeddingModels.value.length === 0)

/** 有模型但没选默认：必须明确挑一个（没有"不指定"这条路了）。 */
const mustPickModel = computed(() => !defaultModel.value && embeddingModels.value.length > 0)

const canCreate = computed(
  () => draftName.value.trim().length > 0 && (Boolean(draftModel.value) || !mustPickModel.value),
)

function openCreate(): void {
  createOpen.value = true
  draftModel.value = ''
  void loadModels().then(() => {
    // 没有默认模型时预选第一个：让"能选就选"的路径最短，而不是让用户先撞一次校验
    if (mustPickModel.value && embeddingModels.value[0]) {
      draftModel.value = embeddingModels.value[0].id
    }
  })
}

const hasItems = computed(() => store.items.length > 0)
const useCards = computed(() => store.items.length <= CARD_LIMIT)

const summaryLine = computed(() => {
  if (!hasItems.value) return undefined
  const counts = Object.values(store.summaries)
  if (counts.length === 0) return `${store.items.length} 个知识库`
  // count 缺失按 0 算：直接相加会把 undefined 变成 NaN，页头上写"共 NaN 篇"（实测踩到）
  const total = counts.reduce(
    (sum, item) => sum + (Number.isFinite(item.count) ? item.count : 0),
    0,
  )
  return `${store.items.length} 个知识库 · 共 ${total} 篇文档`
})

onMounted(() => {
  // 计数随列表一起回来，不必再单独拉一轮汇总
  void store.load()
  // 提前把注册表拉回来：这样"没有可用嵌入模型"能在点开弹窗**之前**就显示在页头上，
  // 用户不必先填完名称才发现建不了
  void loadModels()
})

async function submitCreate(): Promise<void> {
  const name = draftName.value.trim()
  if (!name) {
    notifyError('知识库名称不能为空')
    return
  }
  if (mustPickModel.value && !draftModel.value) {
    notifyError('请先选择一个嵌入模型')
    return
  }
  creating.value = true
  try {
    const created = await store.create({
      name,
      embedding_model_pk: draftModel.value || undefined,
    })
    notifySuccess(`已创建知识库「${created.name}」`)
    createOpen.value = false
    draftName.value = ''
    draftModel.value = ''
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
      <AppButton variant="primary" :disabled="noEmbeddingModel" @click="openCreate">
        <template #icon><IconPlus /></template>
        新建知识库
      </AppButton>
    </template>

    <!-- 没有嵌入模型时**页面级**就说清原因：等用户填完名字再报错，白填一遍 -->
    <p v-if="noEmbeddingModel" class="blocked-note">
      还没有可用的嵌入模型，暂时无法新建知识库。请到「设置 → 模型注册」添加供应商并登记向量化模型，
      再到「设置 → 向量化」把它选为默认。
    </p>

    <p v-if="store.error" class="error-line">{{ store.error }}</p>
    <SkeletonBlock v-if="store.loading && !hasItems" variant="card" :rows="4" />

    <EmptyState
      v-else-if="!hasItems"
      title="还没有知识库"
      hint="知识库是最外层的容器，每个库对应一套 embedding 模型与一组切分参数。"
    >
      <AppButton variant="primary" @click="openCreate">
        <template #icon><IconPlus /></template>
        新建知识库
      </AppButton>
    </EmptyState>

    <!-- 卡片网格：容器型对象、条目少，用卡片承载"挑一个进去"这个动作 -->
    <ul v-else-if="useCards" class="kb-cards">
      <li v-for="kb in store.items" :key="kb.id" class="kb-card-item">
        <RouterLink class="kb-card" :to="`/kb/${kb.id}`">
          <span class="kb-card-head">
            <span class="kb-mark" aria-hidden="true">{{ initial(kb.name) }}</span>
            <span class="kb-card-title">
              <span class="kb-name">{{ kb.name }}</span>
              <span class="kb-model">{{ kb.embedding_model_id }}</span>
            </span>
          </span>

          <!--
            卡片主体只用两样东西说清一个库：**一个数字 + 一段概述**。
            维度和块长是建库时就定了的实现细节，卡片上不参与"挑哪个库"这个决定，
            挤在数字行里反而把简介的位置占了。
          -->
          <span class="kb-card-body">
            <span class="kb-doc-count">
              <span class="kb-doc-value tabular">{{ statsOf(kb.id)?.count ?? '—' }}</span>
              <span class="kb-doc-unit">篇文档</span>
            </span>
            <!-- 空简介不留空白：写"暂无简介"，让人知道这里是"没填"而不是"没加载出来" -->
            <span class="kb-description" :class="{ 'kb-description-empty': !kb.description }">
              {{ kb.description || '暂无简介' }}
            </span>
          </span>

          <span class="kb-card-foot">
            最近更新 {{ formatRelativeTime(statsOf(kb.id)?.updatedAt ?? null) }}
          </span>
        </RouterLink>
        <!-- 管理入口挂在卡片右上角：写权限才有（与后端"删库属于写"一致） -->
        <KnowledgeBaseMenu v-if="kb.can_write" class="kb-menu-corner" :kb="kb" />
      </li>
    </ul>

    <!-- 超过阈值切回列表：格子被挤窄之后，"挑一个"反而更慢 -->
    <div v-else class="panel">
      <div class="panel-head kb-head" aria-hidden="true">
        <span class="col-name">知识库</span>
        <span class="col-num">文档</span>
        <span class="col-time">最近更新</span>
        <span class="col-menu" />
      </div>
      <ul class="kb-rows">
        <li v-for="kb in store.items" :key="kb.id" class="kb-row panel-row">
          <RouterLink class="kb-link" :to="`/kb/${kb.id}`">
            <span class="col-name">
              <span class="kb-mark-sm" aria-hidden="true">{{ initial(kb.name) }}</span>
              <span class="kb-row-text">
                <span class="kb-row-top">
                  <span class="kb-name">{{ kb.name }}</span>
                  <span class="kb-model">{{ kb.embedding_model_id }}</span>
                </span>
                <span v-if="kb.description" class="kb-description-one-line">
                  {{ kb.description }}
                </span>
              </span>
            </span>
            <span class="col-num tabular">{{ statsOf(kb.id)?.count ?? '—' }}</span>
            <span class="col-time tabular">
              {{ formatRelativeTime(statsOf(kb.id)?.updatedAt ?? null) }}
            </span>
          </RouterLink>
          <KnowledgeBaseMenu v-if="kb.can_write" class="kb-row-menu" :kb="kb" />
          <span v-else class="kb-row-menu" />
        </li>
      </ul>
    </div>

    <AppModal v-model:open="createOpen" title="新建知识库">
      <div class="field">
        <label class="field-label" for="kb-name">名称</label>
        <AppInput
          id="kb-name"
          v-model="draftName"
          placeholder="例如：产品手册"
          @keyup.enter="submitCreate"
        />
      </div>
      <div class="field">
        <label class="field-label" for="kb-embedding">
          嵌入模型
          <InfoTip
            text="嵌入模型决定这个库的向量空间，建库时定、之后不能更换。文档量小的库可以选精度更高的模型；量大的选小模型以提升速度与存储效率。切分参数用服务端默认值。"
          />
        </label>
        <AppSelect
          v-if="!noEmbeddingModel"
          id="kb-embedding"
          v-model="draftModel"
          :options="embeddingOptions"
        />
        <!-- 没有可选项时给的是**下一步动作**，不是一个空下拉 -->
        <p v-else class="modal-note">
          还没有可用的嵌入模型，无法建库。请先到「设置 → 模型注册」添加供应商并登记向量化模型，
          再到「设置 → 向量化」把它选为默认。
        </p>
      </div>
      <template #footer>
        <AppButton @click="createOpen = false">取消</AppButton>
        <AppButton
          variant="primary"
          :disabled="creating || noEmbeddingModel || !canCreate"
          @click="submitCreate"
        >
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

/* 缺前置条件时的常驻提示：不是错误（用户没做错什么），所以用警告色而不是红色 */
.blocked-note {
  margin: var(--space-4) 0 0;
  padding: var(--space-3) var(--space-4);
  font-size: var(--text-meta-size);
  line-height: 1.7;
  color: var(--text-secondary);
  background: var(--bg-subtle);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-panel);
}

.modal-note {
  margin: 0;
  font-size: var(--text-meta-size);
  line-height: 1.7;
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
  font-size: var(--text-section-size);
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
  font-size: var(--text-section-size);
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

/* 行形态：名字 + 模型一行，简介一行（超出省略） */
.kb-row-text {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.kb-row-top {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  min-width: 0;
}

.kb-description-one-line {
  overflow: hidden;
  font-size: var(--text-micro-size);
  color: var(--text-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 卡片主体：一个数字 + 一段概述，靠一条 hairline 与标题分开。
   简介固定两行高度（-webkit-line-clamp: 2），这样一行简介与三行简介的卡片一样高——
   网格里高度参差比"文字被截断"更显乱。 */
.kb-card-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-hairline);
}

.kb-doc-count {
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
}

/* 数字是卡片里唯一的"规模"信号：给足字号，单位弱一档 */
.kb-doc-value {
  font-size: var(--text-figure-size);
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--text-primary);
}

.kb-doc-unit {
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.kb-description {
  display: -webkit-box;
  overflow: hidden;
  min-height: calc(var(--text-meta-size) * 1.7 * 2);
  font-size: var(--text-meta-size);
  line-height: 1.7;
  color: var(--text-secondary);
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

/* 没填简介时弱化：它是"暂无"，不是内容 */
.kb-description-empty {
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

/* 卡片右上角的管理入口：绝对定位，不挤压卡片内容 */
.kb-card-item {
  position: relative;
}

.kb-menu-corner {
  position: absolute;
  top: var(--space-2);
  right: var(--space-2);
}

.kb-rows {
  margin: 0;
  padding: 0;
  list-style: none;
}

/* 行 = 链接 + 菜单：菜单列定宽，右侧数字列才不会比表头右移 */
.kb-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.kb-row-menu {
  display: inline-flex;
  flex: 0 0 var(--control-height);
  align-items: center;
  justify-content: center;
}

.col-menu {
  flex: 0 0 var(--control-height);
}

.kb-link {
  flex: 1;
  min-width: 0;
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

.field-hint {
  margin: var(--space-3) 0 0;
  font-size: var(--text-micro-size);
  line-height: 1.7;
  color: var(--text-tertiary);
}
</style>
