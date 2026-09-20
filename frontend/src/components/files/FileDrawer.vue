<script setup lang="ts">
/**
 * 文件抽屉：**从右侧滑出**，预览一份文件，或者翻这条会话的文件区（v0.26）。
 *
 * 两个视图共用一个抽屉，因为它们是同一件事的两端：浏览目录是为了找到那份文件，
 * 预览是为了看清它。分成两个面板会让"翻两下再打开、看完回来接着翻"变成
 * 关掉一个开另一个。
 *
 * ## 为什么不做成独立页面
 * 与知识库那份文档抽屉同一条理由：看一份文件是**从对话里点开看一眼**的动作，
 * 看完要继续说话。整页会把人从对话里带走（而对话正是上下文所在），
 * 还会在窄屏上把一份 PDF 挤成一条缝。
 *
 * ## 文件区是"一条会话恰好一个"
 * 挂了工作区就是那个真实目录（能进子目录），没挂就是会话自己的临时区（平铺）。
 * 哪一种是**服务端算的**，这一层不问也不猜——它只按 `mode` 决定显示不显示
 * "进入子目录"这类动作。这份判断与"产物落在哪"是同一份（`ArtifactService.spot_for`）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import {
  downloadFile,
  listFiles,
  uploadFile,
  type ConversationFile,
  type ConversationFileListing,
} from '@/api/conversations'
import FilePreview from '@/components/files/FilePreview.vue'
import IconChevronRight from '@/components/icons/IconChevronRight.vue'
import IconDownload from '@/components/icons/IconDownload.vue'
import IconFile from '@/components/icons/IconFile.vue'
import IconFolder from '@/components/icons/IconFolder.vue'
import IconUpload from '@/components/icons/IconUpload.vue'
import AppButton from '@/components/ui/AppButton.vue'
import SkeletonBlock from '@/components/ui/SkeletonBlock.vue'
import { formatBytes, formatDate } from '@/composables/useFormat'
import { useToast } from '@/composables/useToast'

const props = defineProps<{
  conversationId: string
  /** 一打开就预览这份（从产物卡片点进来时给）。不给就是直接看目录。 */
  initialKey?: string | null
}>()

const emit = defineEmits<{ close: [] }>()

const { notifyError, notifySuccess } = useToast()

/** 当前路径（工作区模式下才有意义）。 */
const path = ref('')
const listing = ref<ConversationFileListing | null>(null)
const loading = ref(false)
const listError = ref('')

/** 正在预览的那份文件；`null` = 正在看目录。 */
const previewing = ref<ConversationFile | null>(null)

const uploading = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

/** 面包屑：每一段可点，最后一段是当前目录。 */
const crumbs = computed(() => {
  const segments = path.value ? path.value.split('/') : []
  const trail: { label: string; path: string }[] = [
    { label: listing.value?.label || '文件', path: '' },
  ]
  segments.forEach((segment, index) => {
    trail.push({ label: segment, path: segments.slice(0, index + 1).join('/') })
  })
  return trail
})

async function load(target = path.value): Promise<void> {
  loading.value = true
  listError.value = ''
  try {
    listing.value = await listFiles(props.conversationId, target)
    path.value = listing.value.path
  } catch (cause) {
    listError.value = cause instanceof Error ? cause.message : '读不了这个目录'
  } finally {
    loading.value = false
  }
}

/** 目录里找一份文件（用来把 `initialKey` 变成可预览的条目）。 */
async function openInitial(): Promise<void> {
  const key = props.initialKey
  if (!key) return
  const entry = listing.value?.entries.find((item) => item.key === key)
  if (entry) {
    previewing.value = entry
    return
  }
  // 不在当前这一层（工作区里的子目录）——构造一份最小条目直接预览：
  // 预览只用到 key / name / kind，而这三样调用方都给了
  previewing.value = {
    key,
    name: key.split('/').pop() || key,
    is_dir: false,
    size_bytes: 0,
    modified_at: null,
    kind: (key.split('.').pop() || '').toLowerCase(),
  }
}

watch(
  () => [props.conversationId, props.initialKey],
  async () => {
    previewing.value = null
    path.value = ''
    await load('')
    await openInitial()
  },
  { immediate: true },
)

/**
 * Esc 收起：与文档抽屉同一套手势（那个也挂在 window 上，理由一样——
 * 焦点可能在 PDF 的 iframe 里，只监听根元素的 keydown 收不到）。
 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

function openEntry(entry: ConversationFile): void {
  if (entry.is_dir) {
    previewing.value = null
    void load(entry.key)
    return
  }
  previewing.value = entry
}

async function download(entry: ConversationFile): Promise<void> {
  try {
    await downloadFile(props.conversationId, entry.key)
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '下载失败')
  }
}

async function onPick(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = '' // 同一份文件连传两次也要能触发 change
  if (!file) return
  uploading.value = true
  try {
    const entry = await uploadFile(props.conversationId, file, path.value)
    notifySuccess(`已放入「${entry.name}」`)
    await load()
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '上传失败')
  } finally {
    uploading.value = false
  }
}
</script>

<template>
  <!-- 抽屉从右侧滑出、盖住内容区。点遮罩关掉（与文档抽屉同一套手势） -->
  <div class="drawer-backdrop" @click.self="emit('close')">
    <aside class="drawer" role="dialog" :aria-label="previewing ? previewing.name : '文件'">
      <header class="drawer-head">
        <div class="drawer-title">
          <button
            v-if="previewing"
            type="button"
            class="drawer-back"
            aria-label="回到文件列表"
            @click="previewing = null"
          >
            <IconChevronRight :size="15" class="back-icon" />
          </button>
          <span class="drawer-name">{{ previewing ? previewing.name : '文件' }}</span>
          <span v-if="previewing && previewing.size_bytes" class="drawer-size tabular">
            {{ formatBytes(previewing.size_bytes) }}
          </span>
        </div>
        <div class="drawer-actions">
          <AppButton v-if="previewing" @click="download(previewing)">
            <template #icon><IconDownload :size="15" /></template>
            下载
          </AppButton>
          <template v-else>
            <AppButton :disabled="uploading" @click="fileInput?.click()">
              <template #icon><IconUpload :size="15" /></template>
              {{ uploading ? '上传中…' : '上传' }}
            </AppButton>
          </template>
          <button type="button" class="drawer-close" aria-label="关闭" @click="emit('close')">
            ×
          </button>
        </div>
      </header>

      <!-- 面包屑只在浏览态出现：预览态的标题行已经写着文件名了 -->
      <nav v-if="!previewing" class="drawer-crumbs" aria-label="路径">
        <template v-for="(crumb, index) in crumbs" :key="crumb.path">
          <IconChevronRight v-if="index > 0" :size="12" class="crumb-sep" />
          <button
            type="button"
            class="crumb"
            :class="{ 'crumb-current': index === crumbs.length - 1 }"
            :disabled="index === crumbs.length - 1"
            @click="load(crumb.path)"
          >
            {{ crumb.label }}
          </button>
        </template>
      </nav>

      <div class="drawer-body">
        <FilePreview
          v-if="previewing"
          :key="previewing.key"
          :conversation-id="conversationId"
          :file="previewing"
        />

        <template v-else>
          <SkeletonBlock v-if="loading" variant="list" :rows="5" />
          <p v-else-if="listError" class="drawer-note drawer-note-bad">{{ listError }}</p>
          <p v-else-if="!listing?.entries.length" class="drawer-note">
            这里还没有文件。让 Agent 做一份，或者自己上传一个。
          </p>
          <ul v-else class="file-list">
            <li v-for="entry in listing.entries" :key="entry.key">
              <div class="file-row">
                <button type="button" class="file-main" @click="openEntry(entry)">
                  <span class="file-icon">
                    <IconFolder v-if="entry.is_dir" :size="16" />
                    <IconFile v-else :size="16" />
                  </span>
                  <span class="file-name">{{ entry.name }}</span>
                  <span v-if="!entry.is_dir" class="file-meta tabular">
                    {{ formatBytes(entry.size_bytes) }}
                  </span>
                  <span v-if="entry.modified_at" class="file-meta">
                    {{ formatDate(entry.modified_at) }}
                  </span>
                </button>
                <button
                  v-if="!entry.is_dir"
                  type="button"
                  class="file-download"
                  :aria-label="`下载 ${entry.name}`"
                  @click="download(entry)"
                >
                  <IconDownload :size="15" />
                </button>
              </div>
            </li>
          </ul>
          <!-- 截断要如实说：不然"这个项目只有 300 个文件"与
               "我只给你看了 300 个"看起来一模一样 -->
          <p v-if="!loading && listing?.truncated" class="drawer-note">
            这一层文件很多，只显示了前 300 项。
          </p>
        </template>
      </div>

      <input ref="fileInput" type="file" class="visually-hidden" @change="onPick" />
    </aside>
  </div>
</template>

<style scoped>
.drawer-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  justify-content: flex-end;
  background: rgb(0 0 0 / 32%);
}

/* 抽屉铺满高度、从右侧进来。宽度按内容定而不是百分比：
   一份 PDF 在 720px 里读得动，而 1200px 宽会让正文行长到看丢行。 */
.drawer {
  display: flex;
  flex-direction: column;
  width: min(720px, 92vw);
  height: 100%;
  background: var(--bg-surface);
  border-left: 1px solid var(--border-hairline);
  box-shadow: var(--shadow-popover);
}

.drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border-hairline);
}

.drawer-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

/* 返回列表的箭头：图标本身是「>」，转 180 度当「<」用——一个图标两处用，
   比再画一个方向相反的同款更不容易画歪 */
.drawer-back {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--hit-target);
  height: var(--hit-target);
  border: none;
  border-radius: var(--radius-control);
  background: none;
  color: var(--text-secondary);
  cursor: pointer;
}

.drawer-back:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.back-icon {
  transform: rotate(180deg);
}

.drawer-name {
  overflow: hidden;
  font-size: var(--text-section-size);
  font-weight: 500;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.drawer-size {
  flex: 0 0 auto;
  color: var(--text-tertiary);
  font-size: var(--text-micro-size);
}

.drawer-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: var(--space-2);
}

.drawer-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--icon-button-height);
  height: var(--icon-button-height);
  border: none;
  border-radius: var(--radius-control);
  background: none;
  color: var(--text-secondary);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}

.drawer-close:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.drawer-crumbs {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--border-hairline);
  font-size: var(--text-meta-size);
  overflow-x: auto;
}

.crumb {
  padding: 2px var(--space-1);
  border: none;
  border-radius: var(--radius-control);
  background: none;
  color: var(--text-secondary);
  white-space: nowrap;
  cursor: pointer;
}

.crumb:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.crumb-current {
  color: var(--text-primary);
  cursor: default;
}

.crumb-sep {
  flex: 0 0 auto;
  color: var(--text-tertiary);
}

.drawer-body {
  flex: 1 1 auto;
  min-height: 0;
  padding: var(--space-4);
  overflow-y: auto;
}

.drawer-note {
  margin: 0;
  color: var(--text-tertiary);
  font-size: var(--text-meta-size);
}

.drawer-note-bad {
  color: var(--status-danger);
}

.file-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.file-row {
  display: flex;
  align-items: center;
  border-radius: var(--radius-row);
  transition: var(--transition-ui);
}

.file-row:hover {
  background: var(--bg-hover);
}

.file-main {
  display: flex;
  flex: 1;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  min-height: 40px;
  padding: 0 var(--space-2);
  border: none;
  background: none;
  color: var(--text-primary);
  font-size: var(--text-meta-size);
  text-align: left;
  cursor: pointer;
}

.file-icon {
  display: inline-flex;
  flex: 0 0 auto;
  color: var(--text-tertiary);
}

.file-name {
  flex: 1;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.file-meta {
  flex: 0 0 auto;
  color: var(--text-tertiary);
  font-size: var(--text-micro-size);
}

/* 下载按钮**每行常驻**：行里只有"打开"一个动作时，想下载得先打开再点上面那个，
   多一步而且看不出差别（图片打开是预览、PDF 打开也是预览） */
.file-download {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: var(--hit-target);
  height: var(--hit-target);
  margin-right: var(--space-1);
  border: none;
  border-radius: var(--radius-control);
  background: none;
  color: var(--text-tertiary);
  cursor: pointer;
}

.file-download:hover {
  background: var(--bg-active);
  color: var(--text-primary);
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}
</style>
