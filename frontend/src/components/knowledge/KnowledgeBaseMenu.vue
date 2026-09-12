<script setup lang="ts">
/**
 * 知识库设置（齿轮按钮 + 弹窗）。
 *
 * 参考 WeKnora：知识库标题旁边一个**设置**按钮，点开是弹窗，而不是把「重命名 /
 * 删除」塞进一个「⋯」下拉。下拉的问题是动作藏得太深、也承载不了"会失去什么"
 * 这种需要版面说明的内容；库级动作一共就两件，做成一个弹窗反而更清楚。
 *
 * 抽成组件而不是在列表（卡片 + 行两种形态）与详情页各写一遍：
 * "删除前先看影响清单"这套交互最不该复制三份。
 *
 * 父组件只负责"变了之后去哪儿"（列表刷新 / 详情页跳走），通过 `changed` 事件表达。
 */
import { computed, ref } from 'vue'

import { getKnowledgeBaseImpact, type KnowledgeBase } from '@/api/knowledgeBases'
import type { ImpactReport } from '@/api/documents'
import IconSettings from '@/components/icons/IconSettings.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppModal from '@/components/ui/AppModal.vue'
import SourcePanel from '@/components/knowledge/SourcePanel.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import { formatBytes } from '@/composables/useFormat'
import { useToast } from '@/composables/useToast'
import { useKnowledgeBaseStore } from '@/stores/knowledgeBases'

const props = defineProps<{ kb: KnowledgeBase }>()
const emit = defineEmits<{ changed: [action: 'renamed' | 'deleted' | 'sources'] }>()

const store = useKnowledgeBaseStore()
const { notifyError, notifySuccess } = useToast()

/** 文档数来自 store 的汇总表（列表页已经拉过）。拿不到就不显示数字，而不是显示 0。 */
const documentCount = computed(() => store.summaries[props.kb.id]?.count ?? null)

const settingsOpen = ref(false)
const draft = ref('')
const descriptionDraft = ref('')
const renaming = ref(false)
const savingDescription = ref(false)

const deleteOpen = ref(false)
const impact = ref<ImpactReport | null>(null)
const deleting = ref(false)

function openSettings(): void {
  draft.value = props.kb.name
  descriptionDraft.value = props.kb.description
  settingsOpen.value = true
}

/** 简介单独保存：它与改名是两个动作，合在一个按钮里会让人以为必须一起改。 */
async function submitDescription(): Promise<void> {
  const description = descriptionDraft.value.trim()
  if (description === props.kb.description) return
  savingDescription.value = true
  try {
    await store.update(props.kb.id, { description })
    notifySuccess('简介已保存')
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '简介保存失败')
  } finally {
    savingDescription.value = false
  }
}

async function submitRename(): Promise<void> {
  const name = draft.value.trim()
  if (!name) {
    notifyError('知识库名称不能为空')
    return
  }
  if (name === props.kb.name) return
  renaming.value = true
  try {
    await store.rename(props.kb.id, name)
    notifySuccess('已重命名')
    emit('changed', 'renamed')
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '重命名失败')
  } finally {
    renaming.value = false
  }
}

/**
 * 删除是**不可恢复**的（不进回收站），所以必须先把"会失去什么"摆出来。
 * 影响清单拿不到也不阻断：弹窗会停在"正在统计"，用户仍能取消。
 */
async function openDelete(): Promise<void> {
  impact.value = null
  deleteOpen.value = true
  try {
    impact.value = await getKnowledgeBaseImpact(props.kb.id)
  } catch {
    impact.value = null
  }
}

async function confirmDelete(): Promise<void> {
  if (deleting.value) return
  deleting.value = true
  try {
    await store.remove(props.kb.id)
    deleteOpen.value = false
    settingsOpen.value = false
    notifySuccess(`已删除知识库「${props.kb.name}」`)
    emit('changed', 'deleted')
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '删除失败')
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <!-- 单根包裹：多根组件无法自动继承父级传进来的 class，
       而调用方要用 class 把它定位到卡片右上角 / 行尾 -->
  <span class="kb-settings-anchor">
    <button
      type="button"
      class="kb-settings"
      :aria-label="`${kb.name} 的设置`"
      title="知识库设置"
      @click="openSettings"
    >
      <IconSettings :size="16" />
    </button>

    <AppModal v-model:open="settingsOpen" title="知识库设置" height="tall">
      <section class="kb-setting">
        <h3 class="kb-setting-title">基本信息</h3>
        <label class="kb-setting-label" for="kb-setting-name">名称</label>
        <div class="kb-setting-row">
          <AppInput
            id="kb-setting-name"
            v-model="draft"
            placeholder="知识库名称"
            @keydown.enter="submitRename"
          />
          <AppButton variant="primary" :disabled="renaming" @click="submitRename">
            {{ renaming ? '保存中…' : '保存' }}
          </AppButton>
        </div>
        <p class="kb-setting-hint">
          只改显示名，不影响这个库的嵌入模型与切分参数（那些在建库时冻结）。
        </p>
      </section>

      <section class="kb-setting">
        <h3 class="kb-setting-title">简介</h3>
        <p class="kb-setting-hint">一句话说明这个库是干什么的，会显示在知识库列表的卡片上。</p>
        <div class="kb-setting-row kb-setting-row-top">
          <AppInput
            id="kb-setting-description"
            v-model="descriptionDraft"
            placeholder="例如：产品说明书与常见问题，面向客服与售前"
          />
          <AppButton
            variant="primary"
            :disabled="savingDescription || descriptionDraft.trim() === kb.description"
            @click="submitDescription"
          >
            {{ savingDescription ? '保存中…' : '保存' }}
          </AppButton>
        </div>
      </section>

      <!-- 库的具体信息（原先挂在页头标题下那一行小字）。放在设置里读，而不是
           每进一次页面就占掉标题下方一整行 -->
      <section class="kb-setting">
        <h3 class="kb-setting-title">库信息</h3>
        <dl class="kb-setting-info">
          <div>
            <dt>文档</dt>
            <dd>{{ documentCount === null ? '—' : `${documentCount} 篇` }}</dd>
          </div>
          <div>
            <dt>嵌入模型</dt>
            <dd>{{ kb.embedding_model_id || '—' }}</dd>
          </div>
          <div>
            <dt>向量维度</dt>
            <dd>{{ kb.embedding_dim || '—' }}</dd>
          </div>
          <div>
            <dt>切分</dt>
            <dd>块长 {{ kb.chunk_size }} / 重叠 {{ kb.chunk_overlap }}</dd>
          </div>
        </dl>
      </section>

      <!--
        数据源（RSS / 网页订阅）。原先它是页头下的次级标签之一，现在收进设置里：
        它不是"每天要看的内容"，而是"这个库怎么持续进货"的配置，与模型、切分同类。
      -->
      <section class="kb-setting">
        <SourcePanel
          :kb-id="kb.id"
          :can-write="kb.can_write"
          @changed="emit('changed', 'sources')"
        />
      </section>

      <section class="kb-setting kb-setting-danger">
        <h3 class="kb-setting-title">删除知识库</h3>
        <p class="kb-setting-hint">
          整个知识库连同其中的文档、切块与向量都会被删除，<strong>不会进回收站</strong>， 无法恢复。
        </p>
        <AppButton variant="danger" @click="openDelete">删除知识库</AppButton>
      </section>
    </AppModal>

    <ConfirmDialog
      v-model:open="deleteOpen"
      title="删除知识库"
      :lead="`确定删除知识库「${kb.name}」？`"
      note="此操作不可恢复：整个知识库连同其中的文档、切块与向量都会被删除，不会进回收站。"
      confirm-label="删除知识库"
      :busy="deleting"
      busy-label="删除中…"
      @confirm="confirmDelete"
    >
      <p v-if="!impact" class="kb-setting-hint">正在统计影响…</p>
      <dl v-else class="kb-menu-impact">
        <div>
          <dt>文档</dt>
          <dd class="tabular">{{ impact.documents }}</dd>
        </div>
        <div>
          <dt>切块</dt>
          <dd class="tabular">{{ impact.chunks }}</dd>
        </div>
        <div>
          <dt>占用的空间</dt>
          <dd class="tabular">{{ formatBytes(impact.size_bytes) }}</dd>
        </div>
      </dl>
    </ConfirmDialog>
  </span>
</template>

<style scoped>
/* 触发器与两个弹窗包在一个单根里，父级的定位 class 才能落到这个 span 上 */
.kb-settings-anchor {
  display: inline-flex;
  align-items: center;
}

/* 齿轮触发器：与页头其它按钮同高（32px），否则会和它们对不齐 */
.kb-settings {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: var(--control-height);
  height: var(--control-height);
  color: var(--text-secondary);
  border-radius: var(--radius-control);
}

.kb-settings:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

/* SourcePanel 自己带页边距（它是按"页面里的一块"写的），进弹窗后要收掉 */
.kb-setting :deep(.sources) {
  margin-top: 0;
}

.kb-setting + .kb-setting {
  margin-top: var(--space-5);
  padding-top: var(--space-5);
  border-top: 1px solid var(--border-hairline);
}

.kb-setting-title {
  margin: 0 0 var(--space-3);
  font-size: var(--text-section-size);
  font-weight: 500;
  color: var(--text-primary);
}

.kb-setting-label {
  display: block;
  margin-bottom: var(--space-2);
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

/* 库信息的只读清单：两列，标签弱、值强 */
.kb-setting-info {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3) var(--space-4);
  margin: 0;
}

.kb-setting-info dt {
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.kb-setting-info dd {
  margin: var(--space-1) 0 0;
  font-size: var(--text-meta-size);
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.kb-setting-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.kb-setting-row :deep(.field) {
  flex: 1;
  min-width: 0;
}

/* 长文案的输入行（简介）：按钮与输入框顶部对齐，多行时看着不歪 */
.kb-setting-row-top {
  align-items: flex-start;
}

.kb-setting-hint {
  margin: var(--space-2) 0 0;
  font-size: var(--text-meta-size);
  line-height: 1.7;
  color: var(--text-secondary);
}

.kb-setting-lead {
  margin: 0 0 var(--space-3);
  color: var(--text-primary);
}

/* 影响清单：三项并排，数字比标签显眼——用户扫的是"会失去多少" */
.kb-menu-impact {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-3);
  margin: 0 0 var(--space-3);
  padding: var(--space-3);
  background: var(--bg-subtle);
  border-radius: var(--radius-panel);
}

.kb-menu-impact dt {
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.kb-menu-impact dd {
  margin: var(--space-1) 0 0;
  font-size: var(--text-section-size);
  color: var(--text-primary);
}

/* 不可恢复的警示：比普通说明重一档，但不做成大红块——文案本身已经够明确 */
.kb-setting-danger-text {
  margin: 0;
  font-size: var(--text-meta-size);
  line-height: 1.7;
  color: var(--status-danger);
}
</style>
