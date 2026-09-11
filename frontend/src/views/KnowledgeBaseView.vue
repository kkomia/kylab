<script setup lang="ts">
/**
 * 知识库详情页：文档列表（《前端设计规范 v0.3》§6）。
 *
 * 形态：文档是"条目型"对象且会很多，用**列表**而不是卡片。
 * 每行 = 类型图标 + 名称 + 状态（文字 + 语义色）+ 时间；大文件可展开子文件树。
 *
 * 上传走"提交后轮询"：后端是异步流水线（架构 §4），界面必须能看见任务在动，
 * 否则用户会以为"点了没反应"。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

import {
  deleteDocument,
  getDocumentImpact,
  listDocumentParts,
  listDocuments,
  moveDocument,
  reprocessDocument,
  type ImpactReport,
  type DocumentPart,
  type DocumentSummary,
} from '@/api/documents'
import { createFolder, deleteFolder, listFolders, renameFolder, type Folder } from '@/api/folders'
import IconChevronDown from '@/components/icons/IconChevronDown.vue'
import IconChevronRight from '@/components/icons/IconChevronRight.vue'
import IconEdit from '@/components/icons/IconEdit.vue'
import IconFile from '@/components/icons/IconFile.vue'
import IconFolder from '@/components/icons/IconFolder.vue'
import IconPlus from '@/components/icons/IconPlus.vue'
import IconRefresh from '@/components/icons/IconRefresh.vue'
import IconTrash from '@/components/icons/IconTrash.vue'
import IconSearch from '@/components/icons/IconSearch.vue'
import IconShare from '@/components/icons/IconShare.vue'
import IconUpload from '@/components/icons/IconUpload.vue'
import KbSearchPanel from '@/components/search/KbSearchPanel.vue'
import ShareDialog from '@/components/knowledge/ShareDialog.vue'
import SourcePanel from '@/components/knowledge/SourcePanel.vue'
import UploadDialog from '@/components/knowledge/UploadDialog.vue'
import RowMenu from '@/components/ui/RowMenu.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppModal from '@/components/ui/AppModal.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import PageShell from '@/components/ui/PageShell.vue'
import SkeletonBlock from '@/components/ui/SkeletonBlock.vue'
import StatusTag from '@/components/ui/StatusTag.vue'
import { documentStageView } from '@/components/ui/status'
import { formatBytes, formatRelativeTime } from '@/composables/useFormat'
import { MAX_UPLOAD_MB, UPLOAD_FORMAT_HINT } from '@/composables/uploadLimits'
import { roster } from '@/composables/useOperator'
import { useToast } from '@/composables/useToast'
import { useKnowledgeBaseStore } from '@/stores/knowledgeBases'

const POLL_INTERVAL_MS = 2000
/** 处于这些阶段的文档还在动，需要轮询刷新。 */
const ACTIVE_STAGES = new Set([
  'uploaded',
  'probing',
  'parsing',
  'parsed',
  'chunking',
  'chunked',
  'embedding',
  'enriching',
])

const route = useRoute()
const store = useKnowledgeBaseStore()
const { notifyError, notifySuccess } = useToast()

/**
 * 删除确认（M6 / T6.4）。
 *
 * 三段状态：目标 → 影响清单 → 提交。**清单要在确认之前拿到**——
 * 否则那个弹窗只是个"你确定吗"的摆设，而用户根本不知道自己会失去什么。
 */
const deleteOpen = ref(false)
const deleteTarget = ref<DocumentSummary | null>(null)
const impact = ref<ImpactReport | null>(null)
const deleting = ref(false)

/** 从行内菜单点删除：先开弹窗（带上目标），再去取影响清单。 */
function onDeleteClick(close: () => void, document: DocumentSummary): void {
  close()
  deleteTarget.value = document
  impact.value = null
  deleteOpen.value = true
  void loadImpact(document.id)
}

async function loadImpact(documentId: string): Promise<void> {
  try {
    impact.value = await getDocumentImpact(documentId)
  } catch {
    // 拿不到清单不阻断删除：弹窗会停在"正在统计影响…"，
    // 用户仍能取消——总比卡住不给动好
    impact.value = null
  }
}

async function confirmDelete(): Promise<void> {
  const target = deleteTarget.value
  if (!target || deleting.value) return
  deleting.value = true
  try {
    await deleteDocument(target.id)
    deleteOpen.value = false
    notifySuccess('已删除，原文在回收站保留 7 天')
    await refreshAll()
    void store.loadSummaries()
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '删除失败')
  } finally {
    deleting.value = false
  }
}

const kbId = computed(() => String(route.params.kbId ?? ''))
const knowledgeBase = computed(() => store.byId(kbId.value))

const documents = ref<DocumentSummary[]>([])
const loading = ref(false)
const error = ref('')
const searchOpen = ref(false)
const uploadOpen = ref(false)
const shareOpen = ref(false)
const expanded = ref<Record<string, DocumentPart[] | undefined>>({})

// ------------------------------------------------------------------ 目录（v13）

/**
 * 目录筛选的三种取值：
 * - `''`：全部（默认，也是本功能之前的行为）
 * - `ROOT_FILTER`：只看未归档的
 * - 其余：某个目录 id
 */
const ROOT_FILTER = '__root__'
const folders = ref<Folder[]>([])
const activeFolder = ref('')

/** 新建/重命名目录的表单（同一个表单，靠 `folderEditingId` 区分两种模式）。 */
const folderFormOpen = ref(false)
const folderEditingId = ref('')
const folderDraft = ref('')
const folderSaving = ref(false)

/** 移动到目录的弹窗。 */
const moveTarget = ref<DocumentSummary | null>(null)
const moveChoice = ref('')
const moving = ref(false)
const moveOpen = computed({
  get: () => moveTarget.value !== null,
  set: (value: boolean) => {
    if (!value) moveTarget.value = null
  },
})

/** 空状态文案随筛选范围变——"这个库还没有文档"在目录里看到会误导。 */
const emptyTitle = computed(() => {
  if (activeFolder.value === ROOT_FILTER) return '根目录下还没有文档'
  if (activeFolder.value) return '这个目录里还没有文档'
  return '这个知识库里还没有文档'
})

/** 上传目标目录：只有选中了具体目录时才带上（"全部/未归档"都算根目录）。 */
const uploadFolderId = computed(() =>
  activeFolder.value && activeFolder.value !== ROOT_FILTER ? activeFolder.value : undefined,
)

let timer: ReturnType<typeof setInterval> | null = null

const hasActive = computed(() =>
  documents.value.some((document) => ACTIVE_STAGES.has(document.stage)),
)

async function refresh(): Promise<void> {
  if (!kbId.value) return
  try {
    const filter =
      activeFolder.value === ROOT_FILTER
        ? { root: true }
        : activeFolder.value
          ? { folderId: activeFolder.value }
          : {}
    documents.value = (await listDocuments(kbId.value, filter)).items
    error.value = ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '文档列表加载失败'
  }
}

async function loadFolders(): Promise<void> {
  if (!kbId.value) return
  try {
    folders.value = (await listFolders(kbId.value)).items
  } catch {
    // 目录读不到不该挡住文档列表：退化成"还没有目录"
    folders.value = []
  }
}

/** 文档 + 目录一起刷（新建/删除/移动之后计数与列表都得跟着变）。 */
async function refreshAll(): Promise<void> {
  await Promise.all([refresh(), loadFolders()])
}

async function loadFirst(): Promise<void> {
  loading.value = true
  await refreshAll()
  loading.value = false
}

/** 只在有活儿在跑时轮询：全绿之后停表，避免无意义的持续请求。 */
function syncPolling(): void {
  if (hasActive.value && timer === null) {
    timer = setInterval(() => void refresh(), POLL_INTERVAL_MS)
  } else if (!hasActive.value && timer !== null) {
    clearInterval(timer)
    timer = null
  }
}

watch(hasActive, syncPolling)
watch(activeFolder, () => {
  void refresh()
})
watch(kbId, () => {
  expanded.value = {}
  activeFolder.value = ''
  void loadFirst()
})

onMounted(async () => {
  if (store.items.length === 0) await store.load()
  await loadFirst()
})

onBeforeUnmount(() => {
  if (timer !== null) clearInterval(timer)
})

async function onUploaded(): Promise<void> {
  // 弹窗自己负责**逐文件的结果**（哪个重复、哪个失败），这里只负责开始盯进度。
  // 不再发 toast：批量上传时 toast 会连成一片，"哪几个没成功"根本看不清，
  // 而那恰恰是用户唯一需要看的部分——那份清单留在弹窗里。
  await refreshAll()
  syncPolling()
}

// ------------------------------------------------------------------ 目录动作

function startCreateFolder(): void {
  folderEditingId.value = ''
  folderDraft.value = ''
  folderFormOpen.value = true
}

function startRenameFolder(folder: Folder): void {
  folderEditingId.value = folder.id
  folderDraft.value = folder.name
  folderFormOpen.value = true
}

function cancelFolderForm(): void {
  folderFormOpen.value = false
  folderEditingId.value = ''
  folderDraft.value = ''
}

async function submitFolder(): Promise<void> {
  const name = folderDraft.value.trim()
  if (!name) {
    notifyError('请输入目录名')
    return
  }
  folderSaving.value = true
  try {
    if (folderEditingId.value) await renameFolder(folderEditingId.value, name)
    else await createFolder(kbId.value, name)
    cancelFolderForm()
    await loadFolders()
    notifySuccess('目录已保存')
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '保存失败')
  } finally {
    folderSaving.value = false
  }
}

async function removeFolder(folder: Folder): Promise<void> {
  if (!window.confirm(`删除目录「${folder.name}」？`)) return
  try {
    await deleteFolder(folder.id)
    // 正在看的目录被删了：回到「全部」，否则列表会停在一个不存在的筛选上
    if (activeFolder.value === folder.id) activeFolder.value = ''
    await refreshAll()
    notifySuccess('目录已删除')
  } catch (cause) {
    // 目录非空时后端会拒绝，消息里带"还有 N 篇"——原样透给用户，他才好决定下一步
    notifyError(cause instanceof Error ? cause.message : '删除失败')
  }
}

function onMoveClick(close: () => void, document: DocumentSummary): void {
  close()
  moveTarget.value = document
  // 默认落在它当前所在的位置：多数人是想改到别处，而不是先看到"根目录"
  moveChoice.value = document.folder_id ?? ''
}

async function confirmMove(): Promise<void> {
  const target = moveTarget.value
  if (!target || moving.value) return
  moving.value = true
  try {
    await moveDocument(target.id, moveChoice.value || null)
    moveTarget.value = null
    await refreshAll()
    notifySuccess('已移动')
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '移动失败')
  } finally {
    moving.value = false
  }
}

async function toggleParts(document: DocumentSummary): Promise<void> {
  if (expanded.value[document.id]) {
    expanded.value = { ...expanded.value, [document.id]: undefined }
    return
  }
  try {
    const parts = (await listDocumentParts(document.id)).items
    expanded.value = { ...expanded.value, [document.id]: parts }
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '子文件加载失败')
  }
}

async function reprocess(document: DocumentSummary): Promise<void> {
  try {
    await reprocessDocument(document.id)
    notifySuccess(`已重新提交「${document.name}」`)
    await refresh()
    syncPolling()
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '重跑失败')
  }
}

function stageOf(document: DocumentSummary) {
  return documentStageView(document.stage)
}

/** 先在模板里摊平：`@click` 里写多语句会被模板编译器拒绝（分号/换行解析不了）。 */
function onReprocessClick(close: () => void, document: DocumentSummary): void {
  close()
  void reprocess(document)
}
</script>

<template>
  <PageShell :title="knowledgeBase?.name ?? '知识库'">
    <template v-if="knowledgeBase" #description>
      {{ documents.length }} 篇文档<span class="sep">·</span>{{ knowledgeBase.embedding_model_id
      }}<span class="sep">·</span>{{ knowledgeBase.embedding_dim }} 维<span class="sep">·</span>切分
      {{ knowledgeBase.chunk_size }}<span class="sep">/</span>重叠
      {{ knowledgeBase.chunk_overlap }}
    </template>

    <template #actions>
      <AppButton :disabled="documents.length === 0" @click="searchOpen = true">
        <template #icon><IconSearch /></template>
        在此库检索
      </AppButton>
      <!-- 分享入口只对 owner / 管理员出现：can_manage 由后端算，前端不重复判定 -->
      <AppButton v-if="knowledgeBase?.can_manage" @click="shareOpen = true">
        <template #icon><IconShare /></template>
        分享
      </AppButton>
      <!-- 只读分享的成员看得到内容，但没有写入口（can_write 由后端算） -->
      <AppButton v-if="knowledgeBase?.can_write" variant="primary" @click="uploadOpen = true">
        <template #icon><IconUpload /></template>
        上传文档
      </AppButton>
    </template>

    <p v-if="error" class="error-line">{{ error }}</p>

    <p v-if="knowledgeBase && !knowledgeBase.can_write" class="readonly-note">
      这是别人分享给你的库，你是只读权限：可以检索与查看，不能上传或删除。
    </p>

    <!-- 目录（v13）：单层分类。默认「全部」＝这个功能之前的行为，不打扰老用户 -->
    <div v-if="knowledgeBase && !loading" class="folder-bar">
      <span class="folder-label">目录</span>
      <button
        type="button"
        class="folder-chip"
        :class="{ 'folder-chip-on': activeFolder === '' }"
        @click="activeFolder = ''"
      >
        全部
      </button>
      <button
        type="button"
        class="folder-chip"
        :class="{ 'folder-chip-on': activeFolder === ROOT_FILTER }"
        @click="activeFolder = ROOT_FILTER"
      >
        未归档
      </button>
      <span v-for="folder in folders" :key="folder.id" class="folder-item">
        <button
          type="button"
          class="folder-chip"
          :class="{ 'folder-chip-on': activeFolder === folder.id }"
          @click="activeFolder = folder.id"
        >
          <IconFolder :size="14" />
          <span class="folder-name">{{ folder.name }}</span>
          <span class="folder-count tabular">{{ folder.document_count }}</span>
        </button>
        <RowMenu v-if="knowledgeBase?.can_write" :label="`${folder.name} 的操作`">
          <template #default="{ close }">
            <button type="button" @click="(startRenameFolder(folder), close())">
              <IconEdit :size="14" /> 重命名
            </button>
            <button class="menu-danger" type="button" @click="(removeFolder(folder), close())">
              <IconTrash :size="14" /> 删除目录
            </button>
          </template>
        </RowMenu>
      </span>
      <AppButton v-if="knowledgeBase?.can_write" size="sm" @click="startCreateFolder">
        <template #icon><IconPlus /></template>
        新建目录
      </AppButton>
    </div>

    <!-- 新建/重命名共用一个表单：靠 folderEditingId 区分两种模式，交互与"添加供应商"一致 -->
    <div v-if="folderFormOpen" class="folder-form">
      <AppInput
        v-model="folderDraft"
        placeholder="目录名，例如：合同"
        @keydown.enter="submitFolder"
      />
      <AppButton variant="primary" :disabled="folderSaving" @click="submitFolder">
        {{ folderSaving ? '保存中…' : '保存' }}
      </AppButton>
      <AppButton @click="cancelFolderForm">取消</AppButton>
    </div>

    <SkeletonBlock v-if="loading && documents.length === 0" variant="list" :rows="4" />

    <EmptyState
      v-else-if="documents.length === 0"
      :title="emptyTitle"
      :hint="`${UPLOAD_FORMAT_HINT}；单文件上限 ${MAX_UPLOAD_MB}MB。`"
    >
      <AppButton v-if="knowledgeBase?.can_write" variant="primary" @click="uploadOpen = true">
        <template #icon><IconUpload /></template>
        上传文档
      </AppButton>
    </EmptyState>

    <template v-else>
      <!-- 列头：让右侧那串数字有名字，不必靠猜 -->
      <div class="panel">
        <div class="panel-head list-head" aria-hidden="true">
          <span class="head-file">文件</span>
          <span class="head-number">切块</span>
          <span class="head-size">大小</span>
          <span class="head-time">更新时间</span>
          <span class="head-menu" />
        </div>

        <ul class="doc-rows">
          <li v-for="document in documents" :key="document.id" class="doc-row-group">
            <div class="doc-row panel-row">
              <button
                v-if="document.is_split"
                class="expander"
                type="button"
                :aria-label="expanded[document.id] ? '收起子文件' : '展开子文件'"
                :aria-expanded="Boolean(expanded[document.id])"
                @click="toggleParts(document)"
              >
                <IconChevronDown v-if="expanded[document.id]" />
                <IconChevronRight v-else />
              </button>
              <span v-else class="expander-placeholder" />

              <IconFile class="row-icon" />

              <span class="row-main">
                <RouterLink class="row-name" :to="`/documents/${document.id}`">
                  {{ document.name }}
                </RouterLink>
                <StatusTag
                  :label="stageOf(document).label"
                  :tone="stageOf(document).tone"
                  :running="ACTIVE_STAGES.has(document.stage)"
                  :title="document.error ?? undefined"
                />
                <!-- 谁传的（G6）。没记到时显示"未记录"而不是留空——
                     留空会让人以为是界面没渲染出来 -->
                <span v-if="roster.length" class="row-uploader">
                  {{ document.uploaded_by_name || '未记录' }}
                </span>
              </span>

              <span class="row-number">{{ document.chunk_count }}</span>
              <span class="row-size">{{ formatBytes(document.size_bytes) }}</span>
              <span class="row-time">{{ formatRelativeTime(document.updated_at) }}</span>

              <RowMenu v-if="knowledgeBase?.can_write" v-slot="{ close }" class="row-menu">
                <button type="button" @click="onMoveClick(close, document)">
                  <IconFolder :size="14" /> 移动到目录
                </button>
                <button type="button" @click="onReprocessClick(close, document)">
                  <IconRefresh :size="14" /> 重新摄入
                </button>
                <!-- 删除（M6 / T6.4）。**先进回收站**：删错是常事，
                     而原文一旦没了就只能重新上传 -->
                <button class="menu-danger" type="button" @click="onDeleteClick(close, document)">
                  <IconTrash :size="14" /> 删除
                </button>
              </RowMenu>
              <!-- 只读分享：占住同一列宽，数字列才不会比表头右移 -->
              <span v-else class="row-menu" />
            </div>

            <p v-if="document.error" class="row-error">{{ document.error }}</p>

            <ul v-if="expanded[document.id]?.length" class="part-rows">
              <li v-for="part in expanded[document.id]" :key="part.id" class="part-row">
                <span class="part-name">分片 P{{ part.part_index + 1 }}</span>
                <span class="part-pages">第 {{ part.page_start }}–{{ part.page_end }} 页</span>
                <StatusTag
                  :label="documentStageView(part.stage).label"
                  :tone="documentStageView(part.stage).tone"
                />
              </li>
            </ul>
          </li>
        </ul>
      </div>
    </template>

    <!-- 检索是这个库的动作，不是另一个页面：在这里开，范围天然就是当前库 -->
    <!-- 数据源（M6）：与文档列表同页——它们都是"这个库里有什么"的来源 -->
    <SourcePanel
      v-if="knowledgeBase"
      :kb-id="kbId"
      :can-write="knowledgeBase.can_write"
      @changed="refresh"
    />

    <KbSearchPanel
      v-if="knowledgeBase"
      v-model:open="searchOpen"
      :kb-id="kbId"
      :kb-name="knowledgeBase.name"
    />

    <!--
      上传（M6 / M5 收口）。**弹窗而不是"选完就传"**：
      批量上传的重复/失败必须留在屏幕上让人逐个处理，toast 做不到这件事。
    -->
    <UploadDialog
      v-if="knowledgeBase"
      v-model:open="uploadOpen"
      :kb-id="kbId"
      :kb-name="knowledgeBase.name"
      :folder-id="uploadFolderId"
      @uploaded="onUploaded"
    />

    <!-- 分享（v10）：私有是默认，想让别人看到就必须显式授出 -->
    <ShareDialog
      v-if="knowledgeBase"
      v-model:open="shareOpen"
      :kb-id="kbId"
      :kb-name="knowledgeBase.name"
    />
    <!-- 移动到目录（v13）。目录可能很多，所以用单选清单而不是"一行一个按钮" -->
    <AppModal v-model:open="moveOpen" title="移动到目录">
      <p class="move-lead">把「{{ moveTarget?.name }}」移到：</p>
      <div class="move-options">
        <label class="move-option">
          <input v-model="moveChoice" type="radio" value="" />
          <span>根目录（未归档）</span>
        </label>
        <label v-for="folder in folders" :key="folder.id" class="move-option">
          <input v-model="moveChoice" type="radio" :value="folder.id" />
          <span>{{ folder.name }}</span>
        </label>
      </div>
      <p v-if="folders.length === 0" class="move-note">
        还没有目录。先关掉这里，用页面上方的「新建目录」建一个。
      </p>
      <template #footer>
        <AppButton @click="moveOpen = false">取消</AppButton>
        <AppButton variant="primary" :disabled="moving" @click="confirmMove">
          {{ moving ? '移动中…' : '移动' }}
        </AppButton>
      </template>
    </AppModal>

    <!--
      删除确认（M6 / T6.4）。**先给人看影响清单再动手**：
      "删除该文档"没人会有感觉，"3 份文档、412 个切块"才会让人停一下。
      这是《界面信息架构草案》§2"破坏性动作必须二次确认"的落点。
    -->
    <AppModal v-model:open="deleteOpen" title="删除文档">
      <p class="delete-lead">确定删除「{{ deleteTarget?.name }}」？</p>

      <p v-if="!impact" class="delete-note">正在统计影响…</p>
      <dl v-else class="delete-impact">
        <div>
          <dt>切块</dt>
          <dd class="tabular">{{ impact.chunks }}</dd>
        </div>
        <div>
          <dt>占用的空间</dt>
          <dd class="tabular">{{ formatBytes(impact.size_bytes) }}</dd>
        </div>
        <div>
          <dt>进行中的任务</dt>
          <dd class="tabular">{{ impact.running_tasks }}</dd>
        </div>
      </dl>

      <p class="delete-note">
        {{
          impact?.restorable
            ? '原文会移入回收站保留 7 天，期间可以恢复。切块与向量会立即清除——删除后立刻搜不到。'
            : '此操作不可恢复。'
        }}
      </p>

      <template #footer>
        <AppButton @click="deleteOpen = false">取消</AppButton>
        <AppButton variant="danger" :disabled="deleting" @click="confirmDelete">
          {{ deleting ? '删除中…' : '删除' }}
        </AppButton>
      </template>
    </AppModal>
  </PageShell>
</template>

<style scoped>
/* 菜单里的删除：红色文字表示破坏性，但**不填充红底**——
   填充会让它在下拉里最显眼，而它恰恰是最不该被顺手点到的那个 */
.menu-danger {
  color: var(--status-danger);
}

.delete-lead {
  margin: 0 0 var(--space-3);
  color: var(--text-primary);
}

/* 影响清单：三项并排，数字比标签显眼——用户扫的是"会失去多少" */
.delete-impact {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-3);
  margin: 0 0 var(--space-3);
  padding: var(--space-3);
  background: var(--bg-subtle);
  border-radius: var(--radius-panel);
}

.delete-impact dt {
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.delete-impact dd {
  margin: var(--space-1) 0 0;
  font-size: var(--text-section-size);
  color: var(--text-primary);
}

.delete-note {
  margin: 0;
  font-size: var(--text-meta-size);
  line-height: 1.7;
  color: var(--text-secondary);
}

.error-line {
  margin: 0 0 var(--space-4);
  color: var(--status-danger);
}

/* 只读分享的说明条：中性色，不是错误——它解释"为什么没有上传按钮" */
.readonly-note {
  margin: 0 0 var(--space-4);
  padding: var(--space-2) var(--space-3);
  font-size: var(--text-meta-size);
  line-height: 1.6;
  color: var(--text-secondary);
  background: var(--bg-subtle);
  border-radius: var(--radius-control);
}

/* ---- 目录（v13）---- */

.folder-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}

.folder-label {
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.folder-item {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}

/* 目录胶囊：未选是描边、选中用浅品牌底——与本产品其它"切换范围"的形态一致
   （对话页的知识库胶囊也是这个样子） */
.folder-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  height: 26px;
  max-width: 200px;
  padding: 0 var(--space-3);
  font-size: var(--text-micro-size);
  color: var(--text-secondary);
  border: 1px solid var(--border-hairline);
  border-radius: 999px;
}

.folder-chip:hover {
  color: var(--text-primary);
  border-color: var(--border-strong);
}

.folder-chip-on {
  color: var(--accent-text);
  background: var(--accent-soft);
  border-color: transparent;
}

/* 目录名可能很长：省略号收口，别把整行挤走 */
.folder-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.folder-count {
  flex: 0 0 auto;
  color: var(--text-tertiary);
}

.folder-form {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}

.folder-form :deep(.field) {
  width: 260px;
}

/* ---- 移动到目录 ---- */

.move-lead {
  margin: 0 0 var(--space-3);
  font-size: var(--text-meta-size);
  color: var(--text-primary);
}

.move-options {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  max-height: 280px;
  overflow-y: auto;
}

.move-option {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-control);
  cursor: pointer;
}

.move-option:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.move-option input {
  flex: 0 0 auto;
  accent-color: var(--text-secondary);
}

.move-note {
  margin: var(--space-3) 0 0;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

/* 列头与行共用同一套列宽，数字才会真的排在一条竖轴上 */
.list-head,
.doc-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

/* 表头区：底色来自 .panel-head，这里只管列宽与对齐 */
.list-head {
  padding: 0 var(--space-4);
}

/* 与文件名起点对齐：命中区 24px + gap（列头没有展开器，自己让出来） */
.head-file {
  flex: 1;
  padding-left: calc(var(--hit-target) + var(--space-3));
}

.head-number {
  flex: 0 0 56px;
  text-align: right;
}

.head-size {
  flex: 0 0 72px;
  text-align: right;
}

.head-time {
  flex: 0 0 96px;
  text-align: right;
}

.head-menu {
  flex: 0 0 24px;
}

.doc-rows {
  margin: 0;
  padding: 0;
  list-style: none;
}

.doc-row-group + .doc-row-group {
  border-top: 1px solid var(--border-hairline);
}

.doc-row {
  padding: 0 var(--space-4);
}

/* 展开器给足 24px 命中区：20px 在触屏上点不中 */
.expander,
.expander-placeholder {
  display: inline-flex;
  flex: 0 0 var(--hit-target);
  align-items: center;
  justify-content: center;
  width: var(--hit-target);
  height: var(--hit-target);
  color: var(--text-tertiary);
  border-radius: var(--radius-control);
}

.expander:hover {
  background: var(--bg-active);
  color: var(--text-primary);
}

.row-icon {
  flex: 0 0 auto;
  color: var(--text-tertiary);
}

/* 文件名与状态同处一列：状态跟着文件走，而不是飘在右边的孤立列 */
.row-main {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex: 1;
  min-width: 0;
}

/* 链接撑满整行高度：文字本身只有 23px 高，做成整行可点才够得着。
   必须写在 .row-main 之下：`.row-main { align-items }` 会覆盖单独一条 `.row-name` 的 align-self。 */
.row-main .row-name {
  display: inline-flex;
  align-items: center;
  align-self: stretch;
  min-height: var(--hit-target);
  overflow: hidden;
  color: var(--text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 数字列：等宽 + 右对齐，沿一条竖轴排下来 */
.row-number {
  flex: 0 0 56px;
  text-align: right;
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
}

.row-size {
  flex: 0 0 72px;
  text-align: right;
  font-size: var(--text-meta-size);
  color: var(--text-tertiary);
}

/* 上传者（G6）：比时间弱一档。它是"谁"，属于旁注，
   不该与文件名抢注意力 */
.row-uploader {
  flex: 0 0 auto;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.row-time {
  flex: 0 0 96px;
  text-align: right;
  font-size: var(--text-meta-size);
  color: var(--text-tertiary);
}

.row-menu {
  flex: 0 0 24px;
}

.row-error {
  margin: 0;
  padding: 0 var(--space-3) var(--space-2) var(--space-12);
  font-size: var(--text-meta-size);
  color: var(--status-danger);
}

/* 子文件树：缩进一级（§6） */
.part-rows {
  margin: 0;
  padding: 0 var(--space-3) var(--space-2) var(--space-12);
  list-style: none;
}

.part-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  height: var(--row-height-compact);
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
}

.part-name {
  color: var(--text-primary);
}

.part-pages {
  color: var(--text-tertiary);
}
</style>
