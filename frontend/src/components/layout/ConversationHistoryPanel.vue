<script setup lang="ts">
/**
 * 历史会话面板（v0.17）——**照 Kimi 的做法**（用户提供的两张截图）。
 *
 * 交互链路：侧栏「对话」一节鼠标移上去出现「查看全部」→ 点开右侧这个面板。
 * 面板里可以搜索、按时间分组浏览、对每条会话置顶 / 重命名 / 归档 / 删除。
 *
 * 版式上逐条对齐参考图（这些数字是量出来的，不是估的）：
 *
 * | 元素 | 值 |
 * | --- | --- |
 * | 面板 | 占满内容区，白底，右上角一个关闭 × |
 * | 标题「历史会话」 | 24px / 600 / 深色，距顶 52px、距左 48px |
 * | 搜索框 | 高 48px、圆角 10px、**填充底（无边框）**、放大镜在左 |
 * | 内容列宽 | 最大 880px（再宽一行字太长，回看时读不进去） |
 * | 分组标签（本周） | 14px / 灰、上方留 40px |
 * | 条目标题 | 16px / 500 / 深色；右侧同为 16px 的日期标签 |
 * | 条目预览 | 14px / 灰 / **两行截断** |
 * | 条目间距 | 上下各 14px（靠留白分隔，**没有分隔线**） |
 *
 * 三处刻意的决定：
 *
 * 1. **预览给的是最近一条回答**，不是提问——回看时想认出的是"这次聊出了什么"，
 *    而问题常常几条都长得像（"帮我看看这个"）；
 * 2. **分组用相对时间**（今天/昨天/本周/本月/更早）而不是月份：回看是"最近聊的那次"
 *    这类模糊记忆，不是"我要找 3 月的记录"；
 * 3. **归档不是删除**：它是"收起来"，所以菜单里写「归档」而不是「删除」，
 *    且归档视图里能一键取消。
 */
import { computed, ref, watch } from 'vue'

import type { ConversationSummary } from '@/api/conversations'
import IconArchive from '@/components/icons/IconArchive.vue'
import IconClose from '@/components/icons/IconClose.vue'
import IconEdit from '@/components/icons/IconEdit.vue'
import IconPin from '@/components/icons/IconPin.vue'
import IconSearch from '@/components/icons/IconSearch.vue'
import IconTrash from '@/components/icons/IconTrash.vue'
import AppInput from '@/components/ui/AppInput.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import RowMenu from '@/components/ui/RowMenu.vue'
import SkeletonBlock from '@/components/ui/SkeletonBlock.vue'
import { useToast } from '@/composables/useToast'
import { useConversationStore } from '@/stores/conversations'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (event: 'close'): void }>()

const conversations = useConversationStore()
const { notifyError, notifySuccess } = useToast()

const searchDraft = ref('')
const search = ref('')
/** 归档视图：看"收起来"的那些。Kimi 的面板里也有这一档。 */
const archivedView = ref(false)
const loading = ref(false)
const renameOpen = ref(false)
const renameTarget = ref<ConversationSummary | null>(null)
const renameDraft = ref('')

/**
 * 取数：面板**自己按需拉一份带预览的清单**，不复用侧栏那份。
 *
 * 为什么不用侧栏那份：侧栏那份不带预览（预览要多一次查询），而且侧栏只拉 50 条。
 * 面板是"我要找一条旧会话"的地方，它需要预览与更大的窗口——
 * 为此让侧栏每次都多付一次预览查询不划算。
 */
async function load(): Promise<void> {
  loading.value = true
  try {
    await conversations.loadDetailList({
      q: search.value,
      archived: archivedView.value,
      withPreview: true,
    })
  } catch (error) {
    notifyError(error instanceof Error ? error.message : '读取会话失败')
  } finally {
    loading.value = false
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      searchDraft.value = ''
      search.value = ''
      void load()
    }
  },
  // **immediate：面板一挂载就是开着的也要拉数据**。少了它，`watch` 只在
  // false→true 的变化上触发，于是"带着 open=true 挂载"这个形态永远空着
  // （组件测试当场抓到：7 条用例的页面是空的，因为一次请求都没发）。
  { immediate: true },
)

watch(archivedView, () => void load())

let timer: number | undefined
function onSearchInput(): void {
  window.clearTimeout(timer)
  // 与侧栏同一档防抖：300ms。输入时不打请求，停手才打。
  timer = window.setTimeout(() => {
    search.value = searchDraft.value.trim()
    void load()
  }, 300)
}

function clearSearch(): void {
  searchDraft.value = ''
  search.value = ''
  void load()
}

/** 条目列表：侧栏那份是"侧栏用的"，这里是"面板用的"（带预览、可含归档）。 */
const items = computed(() => conversations.detailItems)

const GROUPS = ['今天', '昨天', '本周', '本月', '更早'] as const
type GroupLabel = (typeof GROUPS)[number]

/** 一条会话属于哪一组 + 它的日期标签。**相对时间**：回看是模糊记忆，
 *  不是"我要找 3 月的记录"。 */
function bucketOf(item: ConversationSummary): { group: GroupLabel; label: string } {
  const raw = item.updated_at
  if (!raw) return { group: '更早', label: '' }
  const at = new Date(raw)
  if (Number.isNaN(at.getTime())) return { group: '更早', label: '' }
  const day = startOfDay(at)
  const today = startOfDay(new Date())
  const days = Math.round((today.getTime() - day.getTime()) / 86_400_000)
  if (days <= 0) return { group: '今天', label: '今天' }
  if (days === 1) return { group: '昨天', label: '昨天' }
  if (days < 7) return { group: '本周', label: weekendLabel(at) }
  if (days < 31) return { group: '本月', label: `${at.getMonth() + 1}月${at.getDate()}日` }
  return {
    group: '更早',
    label: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`,
  }
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function startOfDay(at: Date): Date {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate())
}

/** 参考图里右侧那列就是「星期一」这种星期几。 */
function weekendLabel(at: Date): string {
  return `星期${'日一二三四五六'[at.getDay()]}`
}

const grouped = computed(() =>
  GROUPS.map((group) => ({
    label: group,
    items: items.value.filter((item) => bucketOf(item).group === group),
  })).filter((entry) => entry.items.length > 0),
)

/** 预览：压平 Markdown 记号，只留可读文字（参考图里那两行是纯文本）。 */
function previewOf(item: ConversationSummary): string {
  return (item.preview || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/[*_`>]/g, '')
    .replace(/^[\s\-*\d.]+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

async function togglePin(item: ConversationSummary): Promise<void> {
  try {
    await conversations.setPinned(item.id, !item.pinned)
    await load()
  } catch (error) {
    notifyError(error instanceof Error ? error.message : '操作失败')
  }
}

function openRename(item: ConversationSummary): void {
  renameTarget.value = item
  renameDraft.value = item.title || ''
  renameOpen.value = true
}

async function submitRename(): Promise<void> {
  const target = renameTarget.value
  renameOpen.value = false
  if (!target) return
  try {
    await conversations.rename(target.id, renameDraft.value)
    await load()
  } catch (error) {
    notifyError(error instanceof Error ? error.message : '重命名失败')
  }
}

async function toggleArchive(item: ConversationSummary): Promise<void> {
  const next = !item.archived_at
  try {
    await conversations.setArchived(item.id, next)
    await load()
    notifySuccess(next ? '已归档' : '已取消归档')
  } catch (error) {
    notifyError(error instanceof Error ? error.message : '操作失败')
  }
}

async function remove(item: ConversationSummary): Promise<void> {
  try {
    await conversations.remove(item.id)
    await load()
    notifySuccess('已删除')
  } catch (error) {
    notifyError(error instanceof Error ? error.message : '删除失败')
  }
}
</script>

<template>
  <Teleport to="body">
    <section v-if="open" class="history" role="dialog" aria-label="历史会话">
      <button type="button" class="close" aria-label="关闭" @click="emit('close')">
        <IconClose :size="20" />
      </button>

      <div class="column">
        <h2 class="title">历史会话</h2>

        <div class="search">
          <IconSearch class="search-icon" :size="18" />
          <AppInput
            v-model="searchDraft"
            placeholder="搜索历史会话"
            aria-label="搜索历史会话"
            @input="onSearchInput"
          />
          <button
            v-if="searchDraft"
            type="button"
            class="search-clear"
            aria-label="清除搜索"
            @click="clearSearch"
          >
            <IconClose :size="16" />
          </button>
        </div>

        <div class="tabs">
          <button type="button" :class="{ on: !archivedView }" @click="archivedView = false">
            全部
          </button>
          <button type="button" :class="{ on: archivedView }" @click="archivedView = true">
            已归档
          </button>
        </div>

        <SkeletonBlock v-if="loading" variant="list" :rows="4" />

        <EmptyState
          v-else-if="!grouped.length"
          :title="search ? '没有匹配的会话' : archivedView ? '还没有归档的会话' : '还没有会话'"
          :hint="
            search
              ? '换个关键词试试，或者清空搜索。'
              : archivedView
                ? '归档是把不看了的会话收起来——它不是删除，随时可以取消归档。'
                : '在对话里提问之后，记录会出现在这里。'
          "
        />

        <div v-else class="groups">
          <section v-for="group in grouped" :key="group.label" class="group">
            <h3 class="group-label">{{ group.label }}</h3>
            <ul>
              <li v-for="item in group.items" :key="item.id" class="entry">
                <RouterLink class="entry-main" :to="`/chat/${item.id}`" @click="emit('close')">
                  <span class="entry-head">
                    <span class="entry-title">
                      <IconPin v-if="item.pinned" :size="13" class="pin" />
                      {{ item.title || '未命名对话' }}
                    </span>
                    <span class="entry-time">{{ bucketOf(item).label }}</span>
                  </span>
                  <span class="entry-preview">{{ previewOf(item) || '（还没有回答）' }}</span>
                </RouterLink>

                <RowMenu class="entry-menu" :label="`${item.title || '未命名对话'} 的操作`">
                  <template #default="{ close }">
                    <button type="button" @click="(togglePin(item), close())">
                      <IconPin :size="14" /> {{ item.pinned ? '取消置顶' : '置顶' }}
                    </button>
                    <button type="button" @click="(openRename(item), close())">
                      <IconEdit :size="14" /> 重命名
                    </button>
                    <button type="button" @click="(toggleArchive(item), close())">
                      <IconArchive :size="14" /> {{ item.archived_at ? '取消归档' : '归档' }}
                    </button>
                    <button class="menu-item-danger" type="button" @click="(remove(item), close())">
                      <IconTrash :size="14" /> 删除
                    </button>
                  </template>
                </RowMenu>
              </li>
            </ul>
          </section>
        </div>
      </div>

      <!-- 重命名：与侧栏共用同一个动作，所以不在这里另开一套接口 -->
      <div v-if="renameOpen" class="rename-backdrop" @click.self="renameOpen = false">
        <div class="rename-card">
          <p class="rename-title">重命名会话</p>
          <AppInput v-model="renameDraft" aria-label="会话标题" @keydown.enter="submitRename" />
          <div class="rename-actions">
            <button type="button" @click="renameOpen = false">取消</button>
            <button type="button" class="primary" @click="submitRename">保存</button>
          </div>
        </div>
      </div>
    </section>
  </Teleport>
</template>

<style scoped>
/* 面板铺满内容区（侧栏仍在）：参考图里它就是一块盖住正文的白底区域 */
.history {
  position: fixed;
  inset: 0 0 0 var(--sidebar-width);
  z-index: 40;
  overflow-y: auto;
  background: var(--bg-surface);
}

.close {
  position: absolute;
  top: var(--space-4);
  right: var(--space-5);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--icon-button-height);
  height: var(--icon-button-height);
  border: none;
  background: none;
  border-radius: var(--radius-icon-button);
  color: var(--text-secondary);
  cursor: pointer;
}

.close:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

/* 48px 左边距 + 880px 上限：参考图里正文列是左对齐且**没有居中**，
   上限只是不让一行字在宽屏上拉到读不进去。 */
.column {
  max-width: 940px;
  /* 左内缩按参考图的比例来（≈ 面板宽的 13%）：那个留白不是随便的，
     它让"标题 + 搜索 + 列表"成为一条左对齐的列，而不是贴着侧栏开始。
     上限 190px 防止超宽屏上整块被推到中间去。 */
  padding: 52px var(--space-6) var(--space-16) clamp(48px, 12%, 190px);
}

.title {
  margin: 0 0 var(--space-8);
  font-size: 24px;
  font-weight: 600;
  line-height: 1.3;
}

/* 搜索框：**填充底、无边框**（参考图里它是一块浅灰），高 48px、圆角 10px */
.search {
  position: relative;
  display: flex;
  align-items: center;
  margin-bottom: var(--space-4);
}

.search-icon {
  position: absolute;
  left: 16px;
  color: var(--text-tertiary);
  pointer-events: none;
}

.search :deep(input) {
  height: 48px;
  padding-left: 46px;
  border: 0;
  border-radius: 10px;
  background: var(--bg-subtle);
  font-size: var(--text-body-size);
}

.search :deep(input:hover),
.search :deep(input:focus) {
  border: 0;
  box-shadow: none;
  background: var(--bg-subtle);
}

.search-clear {
  position: absolute;
  right: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--hit-target);
  height: var(--hit-target);
  border: none;
  background: none;
  border-radius: var(--radius-control);
  color: var(--text-tertiary);
  cursor: pointer;
}

.search-clear:hover {
  color: var(--text-primary);
}

/* 全部 / 已归档：两枚小切换，安静地待在搜索框下面 */
.tabs {
  display: flex;
  gap: var(--space-1);
  margin-bottom: var(--space-6);
}

.tabs button {
  height: 28px;
  padding: 0 var(--space-3);
  border: none;
  background: none;
  border-radius: var(--radius-control);
  color: var(--text-tertiary);
  font-size: var(--text-micro-size);
  cursor: pointer;
}

.tabs button:hover {
  color: var(--text-primary);
}

.tabs button.on {
  background: var(--bg-selected);
  color: var(--text-primary);
}

.groups {
  display: flex;
  flex-direction: column;
}

/* 分组标签上方留 40px：参考图里"本周"与上一组之间是一大段留白 */
.group + .group {
  margin-top: var(--space-12);
}

.group-label {
  margin: 0 0 var(--space-3);
  font-size: var(--text-meta-size);
  font-weight: 400;
  color: var(--text-tertiary);
}

.group ul {
  margin: 0;
  padding: 0;
  list-style: none;
}

/* 条目：靠留白分隔，**没有分隔线**（参考图里就是一片留白） */
.entry {
  position: relative;
  border-radius: var(--radius-row);
  transition: var(--transition-ui);
}

.entry:hover {
  background: var(--bg-hover);
}

.entry-main {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: 14px var(--space-3) 14px var(--space-2);
  text-decoration: none;
  color: inherit;
}

.entry-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-4);
}

.entry-title {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  min-width: 0;
  font-size: 16px;
  font-weight: 500;
  color: var(--text-primary);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.pin {
  flex-shrink: 0;
  color: var(--text-tertiary);
}

/* 右侧那列日期与标题同字号（参考图里「星期一」看起来和标题一样大） */
.entry-time {
  flex-shrink: 0;
  font-size: 16px;
  color: var(--text-tertiary);
}

/* 预览两行截断：这正是参考图里的形态 */
.entry-preview {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: var(--text-meta-size);
  line-height: var(--line-ui);
  color: var(--text-tertiary);
}

/* 行菜单：悬停/聚焦才显示，但**始终可 Tab 到**（规范 §8 禁止 hover-only 的关键操作） */
.entry-menu {
  position: absolute;
  top: var(--space-2);
  right: var(--space-2);
  opacity: 0;
}

.entry:hover .entry-menu,
.entry:focus-within .entry-menu {
  opacity: 1;
}

/* 重命名：一个轻量内联弹层（不走 AppModal，因为它会把整个页面压暗，
   而这里只想在原地改个字） */
.rename-backdrop {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--overlay-scrim);
}

.rename-card {
  width: min(420px, 90vw);
  padding: var(--space-5);
  background: var(--modal-bg);
  border-radius: var(--radius-overlay);
  box-shadow: var(--shadow-popover);
}

.rename-title {
  margin: 0 0 var(--space-3);
  font-size: var(--text-section-size);
  font-weight: 600;
}

.rename-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-4);
}

.rename-actions button {
  height: var(--control-height);
  padding: 0 var(--space-4);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-control);
  background: none;
  color: var(--text-primary);
  cursor: pointer;
}

.rename-actions .primary {
  border-color: transparent;
  background: var(--button-primary-bg);
  color: var(--button-primary-text);
}
</style>
