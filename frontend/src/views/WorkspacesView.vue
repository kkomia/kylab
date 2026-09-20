<script setup lang="ts">
/**
 * 工作区页（v0.15，设计见 `docs/设计/Agent-工作区与能力层设计-v0.1.md`）。
 *
 * 工作区 = **Agent 的项目**：一个用户指定的根目录 + 一组知识库。
 * 左列清单、右侧编辑选中的那一个。
 *
 * **新建改到弹窗里了**（v0.25）：原先它是本页的一个"新建态"（`?new=1`），
 * 右列那套表单从"改现有的"切成"填新的"。三个问题：要离开你在的地方、
 * 表头那颗「保存」同时管着两件事、空表单常驻右侧。现在这一页只负责
 * **浏览与编辑**，新建是 `WorkspaceCreateDialog` 一件事。理由写在那个组件里。
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
import WorkspaceCreateDialog from '@/components/workspaces/WorkspaceCreateDialog.vue'
import WorkspaceKbPicker from '@/components/workspaces/WorkspaceKbPicker.vue'
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
  // `?new=1` 打开新建弹窗——侧栏的「新建项目」走这条（见 SideNav）。
  // **仍然走路由**：侧栏与这一页之间不必再架一份共享状态，
  // 而"链接能直达新建"本身也是有用的（书签、从别处跳过来）。
  if (route.query.new === '1') creating.value = true
  else initialSelection()
})

watch(
  () => route.query.new,
  (value) => {
    if (value === '1') creating.value = true
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

/** 建完：选中它，并把 `?new=1` 从地址里摘掉（否则刷新会又弹一次）。 */
async function onCreated(workspace: Workspace): Promise<void> {
  select(workspace)
  notifySuccess('工作区已创建')
  if (route.query.new === '1') await router.replace({ path: '/workspaces' })
}

/**
 * 弹窗关掉（取消 / Esc）而什么都没建时，**替用户落在一个地方**。
 *
 * 典型路径是侧栏点「新建项目」→ 想想又关掉：这时他人在工作区页上、右列却是空的，
 * 看着像"这一页坏了"。落到第一项上，与直接进这一页时看到的一样。
 */
watch(creating, (isOpen) => {
  if (isOpen || active.value || !workspaces.items.length) return
  select(workspaces.items[0])
})

async function save(): Promise<void> {
  if (saving.value) return
  const target = active.value
  if (!target) return
  saving.value = true
  try {
    const updated = await workspaces.update(target.id, form.value)
    select(updated)
    notifySuccess('已保存')
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
    else {
      activeId.value = ''
      form.value = { name: '', root_path: '', description: '', kb_ids: [] }
    }
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
      <AppButton @click="creating = true">
        <template #icon><IconPlus :size="15" /></template>
        新建工作区
      </AppButton>
      <AppButton v-if="active" variant="primary" :disabled="!dirty || saving" @click="save">
        {{ saving ? '保存中…' : '保存' }}
      </AppButton>
    </template>

    <SkeletonBlock v-if="workspaces.loading && !workspaces.items.length" variant="list" :rows="4" />

    <!-- 清单为空时**不要**摆那个两栏骨架：左列 300px 里塞一段三行的空态文案会挤成
        一行一个残句，右列再补一句"左边还没有可编辑的工作区"就是同一件事说两遍。
         空态铺满整幅，只在有空态这一种情况。 -->
    <EmptyState
      v-else-if="!workspaces.items.length"
      title="还没有工作区"
      hint="建一个，把项目目录和它用的知识库绑在一起；在这个工作区里开的会话会自动带上这些库。"
    >
      <AppButton variant="primary" @click="creating = true">新建工作区</AppButton>
    </EmptyState>

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
      </aside>

      <section v-if="active" class="ws-form" aria-label="工作区设置">
        <h2 class="form-title">{{ active.name }}</h2>

        <label class="field">
          <span class="field-label">名字</span>
          <AppInput v-model="form.name" placeholder="例如：知识库产品化" />
        </label>

        <label class="field">
          <span class="field-label">
            根目录
            <InfoTip
              text="这是 Agent 文件操作的边界：它能读写的位置被约束在这个目录之内。请填一个**已存在的绝对路径**——不存在的路径会被服务端拒绝（不会替你建一个空目录），数据目录与文件系统根也会被拒绝。"
            />
          </span>
          <AppInput v-model="form.root_path" placeholder="例如：E:/code/my-project" />
        </label>

        <label class="field">
          <span class="field-label">描述（可选）</span>
          <AppInput v-model="form.description" placeholder="这个项目是做什么的" />
        </label>

        <WorkspaceKbPicker v-model="form.kb_ids" :items="knowledgeBases.items" />

        <div class="form-actions">
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

      <!-- 清单非空但没选中（典型是 `?new=1` 进来又关掉弹窗）：右列给一句话，
           不摆一张空表单。空表单看起来像"这里可以填"，但我们没有"临时填一张"这回事。 -->
      <section v-else class="ws-blank" aria-label="工作区设置">
        <p class="text-meta">点左边的一项来编辑，或用上方的「新建工作区」建一个。</p>
      </section>
    </div>

    <WorkspaceCreateDialog
      v-model:open="creating"
      :knowledge-bases="knowledgeBases.items"
      @created="onCreated"
    />

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

/* 没选中时的右列：一句话，不摆空表单。用 `align-self` 让它贴顶而不是被
   grid 拉成整行高等高（那会让这句话悬在中间） */
.ws-blank {
  align-self: start;
  min-width: 0;
}

.form-title {
  margin: 0;
  font-size: var(--text-section-size);
  font-weight: 600;
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
