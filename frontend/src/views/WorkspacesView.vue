<script setup lang="ts">
/**
 * 工作区页（v0.15，设计见 `docs/Agent-工作区与能力层设计-v0.1.md`）。
 *
 * 工作区 = **Agent 的项目**：一个用户指定的根目录 + 一组知识库。
 * 左列清单、右侧表单，与笔记/记忆那两页同一套版式（列表 → 编辑都在本页）。
 *
 * 这一页里有两处刻意的措辞，都值得留着：
 *
 * 1. **根目录是"Agent 能碰哪儿"的边界**，不是"备份目录"。文案要让人明白
 *    它决定了文件操作的落点，而不是一句中性的"工作目录"。
 * 2. **删工作区不删会话**。删除确认里必须写明这一点——用户最怕的是
 *    "删了个壳，里面的对话没了"。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import type { Workspace } from '@/api/workspaces'
import IconAlert from '@/components/icons/IconAlert.vue'
import IconChevronRight from '@/components/icons/IconChevronRight.vue'
import IconFolder from '@/components/icons/IconFolder.vue'
import IconPlus from '@/components/icons/IconPlus.vue'
import IconTrash from '@/components/icons/IconTrash.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppInput from '@/components/ui/AppInput.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import InfoTip from '@/components/ui/InfoTip.vue'
import PageShell from '@/components/ui/PageShell.vue'
import SkeletonBlock from '@/components/ui/SkeletonBlock.vue'
import { useToast } from '@/composables/useToast'
import { useConversationStore } from '@/stores/conversations'
import { useKnowledgeBaseStore } from '@/stores/knowledgeBases'
import { useWorkspaceStore } from '@/stores/workspaces'

const route = useRoute()
const router = useRouter()
const { notifyError, notifySuccess } = useToast()
const workspaces = useWorkspaceStore()
const knowledgeBases = useKnowledgeBaseStore()
const conversations = useConversationStore()

const activeId = ref('')
/** 新建态：表单是空的，但字段与编辑态共用同一份 ref（两套表单会各自漂）。 */
const creating = ref(false)
const saving = ref(false)

/**
 * 表单自己的形状：与 ``WorkspacePayload`` 的区别是**所有字段都必填**。
 * 用它而不是直接复用请求体类型：那边 `description` 是可选（请求可以不带），
 * 而输入框的 v-model 要的是确定的字符串——否则每处绑定都要写一遍 `?? ''`。
 */
interface WorkspaceForm {
  name: string
  root_path: string
  description: string
  kb_ids: string[]
}

const form = ref<WorkspaceForm>({ name: '', root_path: '', description: '', kb_ids: [] })
const confirmDelete = ref(false)

const active = computed(() => workspaces.items.find((item) => item.id === activeId.value) ?? null)
const dirty = computed(() => {
  const current = active.value
  if (creating.value) return Boolean(form.value.name.trim() && form.value.root_path.trim())
  if (!current) return false
  return (
    form.value.name !== current.name ||
    form.value.root_path !== current.root_path ||
    form.value.description !== (current.description ?? '') ||
    !sameIds(form.value.kb_ids, current.kb_ids)
  )
})

/**
 * 进来时选中哪个项目：``?focus=<id>`` > 第一个。
 *
 * ``focus`` 是侧栏「项目」菜单用的（v0.22）：菜单里点某个项目要**落在它身上**，
 * 而不是落在列表第一个——"点谁进谁"是那个菜单存在的意义。
 * 找不到那个 id（被删了、或链接过期）时**退回第一个**，不报错：
 * 用户要的是"进项目页"，不是"看一条错误"。
 */
function initialSelection(): void {
  const wanted = typeof route.query.focus === 'string' ? route.query.focus : ''
  const target = wanted ? workspaces.items.find((item) => item.id === wanted) : undefined
  if (target) select(target)
  else if (workspaces.items.length) select(workspaces.items[0])
}

onMounted(async () => {
  await Promise.all([workspaces.load(), knowledgeBases.load().catch(() => undefined)])
  if (route.query.new === '1') startCreate()
  else initialSelection()
})

watch(
  () => route.query.new,
  (value) => {
    if (value === '1') startCreate()
  },
)

// 侧栏菜单再次点另一个项目时，路由只在 query 上变，组件不会重建——这里跟上
watch(
  () => route.query.focus,
  (value) => {
    const target = workspaces.items.find((item) => item.id === String(value ?? ''))
    if (target) select(target)
  },
)

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && [...left].sort().join() === [...right].sort().join()
}

function select(workspace: Workspace): void {
  activeId.value = workspace.id
  creating.value = false
  form.value = {
    name: workspace.name,
    root_path: workspace.root_path,
    description: workspace.description ?? '',
    kb_ids: [...workspace.kb_ids],
  }
}

function startCreate(): void {
  creating.value = true
  activeId.value = ''
  form.value = { name: '', root_path: '', description: '', kb_ids: [] }
}

function toggleKb(kbId: string): void {
  const current = form.value.kb_ids
  form.value.kb_ids = current.includes(kbId)
    ? current.filter((item) => item !== kbId)
    : [...current, kbId]
}

async function save(): Promise<void> {
  if (saving.value) return
  saving.value = true
  try {
    if (creating.value) {
      const created = await workspaces.create(form.value)
      creating.value = false
      select(created)
      notifySuccess('工作区已创建')
      if (route.query.new === '1') await router.replace({ path: '/workspaces' })
    } else if (active.value) {
      const updated = await workspaces.update(active.value.id, form.value)
      select(updated)
      notifySuccess('已保存')
    }
  } catch (error) {
    // 后端的校验文案是这一层最主要的产出（路径不存在、指向数据目录、是文件系统根），
    // 原样透出来——换成"保存失败"就把唯一有用的信息丢了
    notifyError(error instanceof Error ? error.message : '保存失败')
  } finally {
    saving.value = false
  }
}

async function remove(): Promise<void> {
  const target = active.value
  confirmDelete.value = false
  if (!target) return
  try {
    await workspaces.remove(target.id)
    await conversations.load()
    notifySuccess('工作区已删除，里面的会话已退回未归档')
    if (workspaces.items.length) select(workspaces.items[0])
    else startCreate()
  } catch (error) {
    notifyError(error instanceof Error ? error.message : '删除失败')
  }
}

async function newConversation(): Promise<void> {
  const target = active.value
  if (!target) return
  try {
    const record = await conversations.create([], null, undefined, target.id)
    await workspaces.refreshCounts()
    await router.push(`/chat/${record.id}`)
  } catch (error) {
    notifyError(error instanceof Error ? error.message : '新建会话失败')
  }
}
</script>

<template>
  <PageShell title="工作区">
    <template #actions>
      <AppButton @click="startCreate">
        <template #icon><IconPlus :size="15" /></template>
        新建工作区
      </AppButton>
      <AppButton variant="primary" :disabled="!dirty || saving" @click="save">
        {{ saving ? '保存中…' : '保存' }}
      </AppButton>
    </template>

    <SkeletonBlock v-if="workspaces.loading && !workspaces.items.length" variant="list" :rows="4" />

    <div v-else class="ws-layout">
      <aside class="ws-list" aria-label="工作区清单">
        <p v-if="workspaces.error" class="error-line">{{ workspaces.error }}</p>
        <ul>
          <li v-for="item in workspaces.items" :key="item.id">
            <button
              type="button"
              class="ws-row"
              :class="{ on: item.id === activeId }"
              @click="select(item)"
            >
              <IconFolder :size="15" class="ws-row-icon" />
              <span class="ws-row-main">
                <span class="ws-row-name">{{ item.name }}</span>
                <span class="ws-row-path">{{ item.root_path }}</span>
              </span>
              <span class="ws-row-count tabular">{{ item.conversation_count }}</span>
            </button>
          </li>
        </ul>

        <EmptyState
          v-if="!workspaces.items.length && !creating"
          title="还没有工作区"
          hint="建一个，把项目目录和它用的知识库绑在一起；在这个工作区里开的会话会自动带上这些库。"
        >
          <AppButton variant="primary" @click="startCreate">新建工作区</AppButton>
        </EmptyState>
      </aside>

      <section class="ws-form" aria-label="工作区设置">
        <h2 class="form-title">{{ creating ? '新建工作区' : (active?.name ?? '未选择') }}</h2>

        <label class="field">
          <span class="field-label">名字</span>
          <AppInput v-model="form.name" placeholder="例如：知识库产品化" />
        </label>

        <label class="field">
          <span class="field-label">
            根目录
            <InfoTip
              text="这是 Agent 文件操作的边界：它能读写的位置被约束在这个目录之内。请指向一个真实存在的项目目录，不要指向数据目录或系统根——服务端会拒绝后者。"
            />
          </span>
          <AppInput v-model="form.root_path" placeholder="例如：E:/code/my-project" />
          <span class="text-micro">
            必须是<strong>已存在</strong>的目录（绝对路径）。它决定 Agent 能碰哪儿——
            不存在的路径会被拒绝，而不是建一个空目录。
          </span>
        </label>

        <label class="field">
          <span class="field-label">描述（可选）</span>
          <AppInput v-model="form.description" placeholder="这个项目是做什么的" />
        </label>

        <div class="field">
          <span class="field-label">
            绑定的知识库
            <InfoTip
              text="绑定的库会被这个工作区里的新会话自动继承：进入项目，资料范围就定了，不必每次重勾。知识库与记忆仍是两个池子，检索结果不会混。"
            />
          </span>
          <p v-if="!knowledgeBases.items.length" class="text-micro">还没有知识库可绑。</p>
          <ul v-else class="kb-picks">
            <li v-for="kb in knowledgeBases.items" :key="kb.id">
              <button
                type="button"
                class="kb-pick"
                :class="{ on: form.kb_ids.includes(kb.id) }"
                @click="toggleKb(kb.id)"
              >
                <span class="kb-pick-name">{{ kb.name }}</span>
                <span v-if="form.kb_ids.includes(kb.id)" class="kb-pick-mark">已绑定</span>
              </button>
            </li>
          </ul>
        </div>

        <div v-if="!creating && active" class="form-actions">
          <AppButton variant="primary" @click="newConversation">
            <template #icon><IconChevronRight :size="14" /></template>
            在这个工作区新开会话
          </AppButton>
          <AppButton variant="danger" @click="confirmDelete = true">
            <template #icon><IconTrash :size="14" /></template>
            删除工作区
          </AppButton>
        </div>
      </section>
    </div>

    <ConfirmDialog
      v-model:open="confirmDelete"
      title="删除这个工作区？"
      :lead="`将删除工作区「${active?.name ?? ''}」。`"
      note="里面的会话**不会被删除**，它们会退回侧栏的「未归档会话」那一栏。工作区里的目录与文件也不会被删——那本来就是你自己的目录。"
      confirm-label="删除工作区"
      @confirm="remove"
    />

    <p v-if="workspaces.items.length" class="foot-note">
      <IconAlert :size="14" />
      工作区不复制文件：它只是"指向"你指定的目录。所以删工作区不会动你的文件，
      改根目录也只是换一个指向。
    </p>
  </PageShell>
</template>

<style scoped>
.ws-layout {
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
  gap: var(--space-5);
  align-items: start;
}

.ws-list ul {
  margin: 0;
  padding: 0;
  list-style: none;
}

.ws-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-2) var(--space-2-5);
  border: none;
  background: none;
  border-radius: var(--radius-row);
  text-align: left;
  cursor: pointer;
  transition: var(--transition-ui);
}

.ws-row:hover {
  background: var(--bg-hover);
}

/* 选中用中性 alpha 填充（规范 §7：状态靠填充、动作才靠墨色） */
.ws-row.on {
  background: var(--bg-selected);
}

.ws-row-icon {
  flex-shrink: 0;
  color: var(--text-tertiary);
}

.ws-row-main {
  display: flex;
  flex-direction: column;
  gap: var(--space-0-5);
  min-width: 0;
  flex: 1;
}

.ws-row-name {
  font-size: var(--text-meta-size);
}

.ws-row-path {
  font-family: var(--font-mono);
  font-size: var(--text-c2-size);
  color: var(--text-tertiary);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.ws-row-count {
  flex-shrink: 0;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.ws-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 0;
}

.form-title {
  margin: 0;
  font-size: var(--text-section-size);
  font-weight: 600;
}

.kb-picks {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.kb-pick {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  height: var(--control-height);
  padding: 0 var(--space-3);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-pill);
  background: none;
  color: var(--text-secondary);
  font-size: var(--text-meta-size);
  cursor: pointer;
  transition: var(--transition-ui);
}

.kb-pick:hover {
  background: var(--bg-hover);
}

.kb-pick.on {
  background: var(--bg-selected);
  color: var(--text-primary);
  border-color: transparent;
}

.kb-pick-mark {
  font-size: var(--text-c2-size);
  color: var(--text-tertiary);
}

.form-actions {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.foot-note {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  margin-top: var(--space-6);
  color: var(--text-tertiary);
  font-size: var(--text-micro-size);
}

.error-line {
  margin: 0 0 var(--space-2);
  color: var(--status-danger);
  font-size: var(--text-meta-size);
}
</style>
