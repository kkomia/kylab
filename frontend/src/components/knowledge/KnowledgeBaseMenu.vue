<script setup lang="ts">
/**
 * 知识库的「⋯」菜单：重命名 / 删除（v13 后补的库级管理入口）。
 *
 * 抽成一个组件而不是在两个页面各写一遍：知识库列表（卡片形态与行形态）与
 * 知识库详情页都需要它，里面的"删除前先看影响清单"这套交互更不该复制三份。
 *
 * 父组件只负责"变了之后去哪儿"（列表刷新 / 详情页跳走），通过 `changed` 事件表达。
 */
import { ref } from 'vue'

import { getKnowledgeBaseImpact, type KnowledgeBase } from '@/api/knowledgeBases'
import type { ImpactReport } from '@/api/documents'
import AppButton from '@/components/ui/AppButton.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppModal from '@/components/ui/AppModal.vue'
import RowMenu from '@/components/ui/RowMenu.vue'
import { formatBytes } from '@/composables/useFormat'
import { useToast } from '@/composables/useToast'
import { useKnowledgeBaseStore } from '@/stores/knowledgeBases'

const props = defineProps<{ kb: KnowledgeBase }>()
const emit = defineEmits<{ changed: [action: 'renamed' | 'deleted'] }>()

const store = useKnowledgeBaseStore()
const { notifyError, notifySuccess } = useToast()

const renameOpen = ref(false)
const draft = ref('')
const renaming = ref(false)

const deleteOpen = ref(false)
const impact = ref<ImpactReport | null>(null)
const deleting = ref(false)

function openRename(close: () => void): void {
  close()
  draft.value = props.kb.name
  renameOpen.value = true
}

async function submitRename(): Promise<void> {
  const name = draft.value.trim()
  if (!name) {
    notifyError('知识库名称不能为空')
    return
  }
  if (name === props.kb.name) {
    renameOpen.value = false
    return
  }
  renaming.value = true
  try {
    await store.rename(props.kb.id, name)
    renameOpen.value = false
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
async function openDelete(close: () => void): Promise<void> {
  close()
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
  <RowMenu :label="`${kb.name} 的管理操作`">
    <template #default="{ close }">
      <button type="button" @click="openRename(close)">重命名</button>
      <button class="menu-item-danger" type="button" @click="openDelete(close)">删除知识库</button>
    </template>
  </RowMenu>

  <AppModal v-model:open="renameOpen" title="重命名知识库">
    <p class="kb-menu-lead">给「{{ kb.name }}」换一个名字：</p>
    <AppInput v-model="draft" placeholder="知识库名称" @keydown.enter="submitRename" />
    <template #footer>
      <AppButton @click="renameOpen = false">取消</AppButton>
      <AppButton variant="primary" :disabled="renaming" @click="submitRename">
        {{ renaming ? '保存中…' : '保存' }}
      </AppButton>
    </template>
  </AppModal>

  <AppModal v-model:open="deleteOpen" title="删除知识库">
    <p class="kb-menu-lead">确定删除知识库「{{ kb.name }}」？</p>

    <p v-if="!impact" class="kb-menu-note">正在统计影响…</p>
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

    <p class="kb-menu-danger">
      此操作不可恢复：整个知识库连同其中的文档、切块与向量都会被删除，不会进回收站。
    </p>

    <template #footer>
      <AppButton @click="deleteOpen = false">取消</AppButton>
      <AppButton variant="danger" :disabled="deleting" @click="confirmDelete">
        {{ deleting ? '删除中…' : '删除知识库' }}
      </AppButton>
    </template>
  </AppModal>
</template>

<style scoped>
.kb-menu-lead {
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

.kb-menu-note {
  margin: 0;
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
}

/* 不可恢复的警示：比普通说明重一档，但不做成大红块——文案本身已经够明确 */
.kb-menu-danger {
  margin: 0;
  font-size: var(--text-meta-size);
  line-height: 1.7;
  color: var(--status-danger);
}
</style>
