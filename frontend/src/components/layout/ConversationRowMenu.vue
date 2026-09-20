<script setup lang="ts">
/**
 * 会话行操作菜单（「⋯」，v0.25）。
 *
 * ## 为什么抽成一个组件
 *
 * 「整理这条会话」这件事**在同一份数据上有两个入口**：侧栏的会话行、历史会话面板的条目。
 * 之前只有面板里有菜单，侧栏里要整理一条会话得先打开面板找到它——多一步，而且
 * 从侧栏点进去的人根本不知道面板里能做这些。
 *
 * 抽出来之后两边共用**同一份动作、同一套文案、同一套确认**（重命名与删除的弹窗
 * 也在这里），不会出现"面板里删要确认、侧栏里删不确认"这种分叉。
 *
 * ## 动作取自后端的既有字段，不新造概念
 *
 * | 菜单项 | 后端字段 |
 * | --- | --- |
 * | 置顶 | `pinned` |
 * | 重命名 | `title` |
 * | 移至项目 | `workspace_id` |
 * | 归档 | `archived_at` |
 * | 删除 | —— |
 *
 * 参考 kimi 的会话菜单（置顶 / 移至项目 / 重命名 / 归档 / 删除），
 * **它的「在新窗口打开」「在文件资源管理器中打开」没有搬**：那是桌面客户端的动作，
 * 我们没有对应的东西，加进来就是两个点不动的菜单项。
 *
 * ## 两条不能省的谨慎
 *
 * 1. **删除要确认**。它是这一列里唯一不可逆的动作，而菜单是**整行 hover 才出现**的，
 *    误点的代价很高。确认框里写明"消息也会一起删掉"，且把标题带出来
 *    （"删除「XXX」？"）——去掉标题的话，连删的是哪条都得回头看一眼。
 * 2. **归档不确认**。它可逆（面板里能取消归档），加确认只会让常用动作变慢。
 *    文案上刻意区分：归档写「归档」不写「删除」（面板的注释里已经立过这条）。
 */
import { computed, onMounted, ref } from 'vue'

import type { ConversationSummary } from '@/api/conversations'
import IconArchive from '@/components/icons/IconArchive.vue'
import IconEdit from '@/components/icons/IconEdit.vue'
import IconFolder from '@/components/icons/IconFolder.vue'
import IconPin from '@/components/icons/IconPin.vue'
import IconTrash from '@/components/icons/IconTrash.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppModal from '@/components/ui/AppModal.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import RowMenu from '@/components/ui/RowMenu.vue'
import { useToast } from '@/composables/useToast'
import { useConversationStore } from '@/stores/conversations'
import { useWorkspaceStore } from '@/stores/workspaces'

/**
 * 这个组件的根是**多块**（菜单 + 按需出现的三个弹窗），属性没法自动落到某一块上，
 * 所以显式转到菜单的根节点上——调用方写的 `class="entry-menu"` 之类的定位样式
 * 才不会静默失效（Vue 只会打一句 warn 然后丢掉）。
 */
defineOptions({ inheritAttrs: false })

const props = defineProps<{
  item: ConversationSummary
  /** 浮层贴触发器的哪一边（侧栏靠右缘时用默认的 `right`）。 */
  align?: 'right' | 'left'
}>()

/** 改完之后调用方按需刷新（侧栏不必刷，store 已经就地更新了那一行）。 */
const emit = defineEmits<{ changed: [] }>()

const conversations = useConversationStore()
const workspaces = useWorkspaceStore()
const { notifyError, notifySuccess } = useToast()

const name = computed(() => props.item.title || '未命名对话')

/**
 * 三个弹窗都**按需渲染**（`v-if`），不是常驻。
 * 一屏可能有二十条会话，每条挂三个 `<dialog>` 就是六十个节点——
 * 虽然关着的 `dialog` 不绘制，但没有理由让它进 DOM。
 */
const renaming = ref(false)
const renameDraft = ref('')
const moving = ref(false)
const confirmingDelete = ref(false)

/** 每条动作都走同一个出口：出错原样透出、成功才通知、最后统一 `emit('changed')`。 */
async function run(action: () => Promise<void>, fallback: string, done?: string): Promise<void> {
  try {
    await action()
    if (done) notifySuccess(done)
    emit('changed')
  } catch (error) {
    notifyError(error instanceof Error ? error.message : fallback)
  }
}

/**
 * 「移至项目」的候选来自工作区清单。侧栏已经加载过它（在 `onMounted` 里 `load`），
 * 但**这个组件不假设调用方加载过**——不加载的话那一项会静默消失，
 * 而"菜单里少一项"是没人会去查的那种 bug。
 */
onMounted(() => {
  if (!workspaces.loaded) void workspaces.load()
})

function openRename(): void {
  renameDraft.value = props.item.title || ''
  renaming.value = true
}

async function submitRename(): Promise<void> {
  const next = renameDraft.value.trim()
  renaming.value = false
  if (!next || next === props.item.title) return
  await run(() => conversations.rename(props.item.id, next), '重命名失败')
}

async function moveTo(workspaceId: string | null): Promise<void> {
  moving.value = false
  if ((props.item.workspace_id ?? null) === workspaceId) return
  const label = workspaceId
    ? (workspaces.items.find((item) => item.id === workspaceId)?.name ?? '项目')
    : null
  await run(
    async () => {
      await conversations.setWorkspace(props.item.id, workspaceId)
      // 侧栏项目行上的条数是另一个 store 里的数，不同步刷新它就会停在旧值上
      // （实测移进去之后项目还写着 0 条）
      await workspaces.refreshCounts()
    },
    '移动失败',
    label ? `已移到「${label}」` : '已移出项目',
  )
}

async function togglePin(): Promise<void> {
  await run(
    () => conversations.setPinned(props.item.id, !props.item.pinned),
    '操作失败',
    props.item.pinned ? '已取消置顶' : '已置顶',
  )
}

async function toggleArchive(): Promise<void> {
  const next = !props.item.archived_at
  await run(
    () => conversations.setArchived(props.item.id, next),
    '操作失败',
    next ? '已归档（可在「查看全部会话」里找回）' : '已取消归档',
  )
}

async function remove(): Promise<void> {
  confirmingDelete.value = false
  await run(() => conversations.remove(props.item.id), '删除失败', '已删除')
}
</script>

<template>
  <RowMenu v-bind="$attrs" class="row-menu" :align="props.align" :label="`${name} 的操作`">
    <template #default="{ close }">
      <button type="button" @click="(togglePin(), close())">
        <IconPin :size="14" /> {{ props.item.pinned ? '取消置顶' : '置顶' }}
      </button>
      <button type="button" @click="(openRename(), close())"><IconEdit :size="14" /> 重命名</button>
      <!-- 「移至项目」在**已经在某个项目里**时也留着（那时它能改投别处），
           只有"一个项目都没有"才藏起来——点开一个空列表比没有这一项更让人困惑 -->
      <button v-if="workspaces.items.length" type="button" @click="((moving = true), close())">
        <IconFolder :size="14" /> 移至项目
      </button>
      <button type="button" @click="(toggleArchive(), close())">
        <IconArchive :size="14" /> {{ props.item.archived_at ? '取消归档' : '归档' }}
      </button>
      <button class="menu-item-danger" type="button" @click="((confirmingDelete = true), close())">
        <IconTrash :size="14" /> 删除
      </button>
    </template>
  </RowMenu>

  <AppModal v-if="renaming" v-model:open="renaming" title="重命名会话">
    <label class="field">
      <span class="field-label">标题</span>
      <AppInput v-model="renameDraft" aria-label="会话标题" @keydown.enter="submitRename" />
    </label>
    <template #footer>
      <AppButton @click="renaming = false">取消</AppButton>
      <AppButton variant="primary" @click="submitRename">保存</AppButton>
    </template>
  </AppModal>

  <!-- 移至项目：一个列表就够，**不做二级菜单**。
       kimi 用的是悬浮展开的二级菜单，但那需要浮层里再套一层浮层（定位、Esc 先后、
       点外部关闭三件事都要各写一遍），而这里的候选通常只有几个。
       代价是多一次点击，换来的是"当前在哪个项目"这件事能摆出来——
       二级菜单里只能用勾选表示，反而更弱。 -->
  <AppModal v-if="moving" v-model:open="moving" title="移至项目">
    <ul class="move-list">
      <li v-for="workspace in workspaces.items" :key="workspace.id">
        <button
          type="button"
          class="move-row"
          :class="{ on: workspace.id === props.item.workspace_id }"
          @click="moveTo(workspace.id)"
        >
          <IconFolder :size="15" />
          <span class="move-name">{{ workspace.name }}</span>
          <span v-if="workspace.id === props.item.workspace_id" class="move-mark">当前</span>
        </button>
      </li>
      <li v-if="props.item.workspace_id">
        <button type="button" class="move-row" @click="moveTo(null)">
          <IconFolder :size="15" />
          <span class="move-name">移出项目</span>
        </button>
      </li>
    </ul>
  </AppModal>

  <ConfirmDialog
    v-if="confirmingDelete"
    v-model:open="confirmingDelete"
    title="删除这条会话？"
    :lead="`将删除「${name}」及其全部消息。`"
    note="删除后不可恢复。只是想把它从列表里收起来的话，用「归档」——归档随时可以取消。"
    confirm-label="删除"
    @confirm="remove"
  />
</template>

<style scoped>
.move-list {
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 50vh;
  overflow-y: auto;
}

.move-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: var(--menu-item-height);
  padding: 0 var(--space-2);
  border: none;
  border-radius: var(--menu-item-radius);
  background: none;
  color: var(--text-primary);
  font-size: var(--text-meta-size);
  text-align: left;
  cursor: pointer;
  transition: var(--transition-ui);
}

.move-row:hover {
  background: var(--bg-hover);
}

.move-row.on {
  background: var(--bg-selected);
}

.move-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.move-mark {
  flex: 0 0 auto;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}
</style>
