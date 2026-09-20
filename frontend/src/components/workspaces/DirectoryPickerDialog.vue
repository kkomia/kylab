<script setup lang="ts">
/**
 * 目录选择器（v0.35）：**在服务器上**挑一个目录当工作区根目录。
 *
 * ## 为什么不是客户端的目录选择器
 *
 * 工作区根目录是**服务器上**的路径（后端跑在 NAS 上），而浏览器能拿到的只有客户端
 * 本机的东西：`<input type="file" webkitdirectory>` 给的是相对路径、`showDirectoryPicker`
 * 给的是一个句柄——两者指向的都是**另一台机器**。所以"选择"只能是"服务端列给你看"，
 * 走 `GET /workspaces/browse`（管理员专属）。
 *
 * ## 三条交互约定
 *
 * 1. **点一行 = 进去**，不是"选中"：目录树里"进下一层"才是最常用的动作，
 *    而"就选它"由底部那颗按钮负责（与系统的文件夹选择器一致）；
 * 2. **不可选的目录照样能进去看**（灰的是底部那颗"选这个目录"，不是那一行）：
 *    数据目录整个子树都不能当工作区，但"点进去看看"是人的正常动作，
 *    而拦着一个操作只会让人以为界面坏了。灰的那一行会显示服务端给的原因；
 * 3. **路径一律由服务端给**（`path` 字段），前端不自己拼字符串：
 *    Windows 的反斜杠、Linux 的根、网络路径的写法各不一样，拼错一次就是"找不到"。
 */
import { computed, ref, watch } from 'vue'

import { browseDirectories, type DirectoryEntry, type WorkspaceBrowse } from '@/api/workspaces'
import IconChevronLeft from '@/components/icons/IconChevronLeft.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppModal from '@/components/ui/AppModal.vue'
import SkeletonBlock from '@/components/ui/SkeletonBlock.vue'

const open = defineModel<boolean>('open', { required: true })

const props = defineProps<{
  /** 打开时从哪儿起步（一般是当前填着的路径）；空则从服务端的默认（家目录）开始。 */
  start?: string
}>()

const emit = defineEmits<{ pick: [path: string] }>()

const view = ref<WorkspaceBrowse | null>(null)
const loading = ref(false)
const error = ref('')

const current = computed(() => view.value)
/** 当前这一层自己能不能选：**服务端说了算**（`current`），界面不自己判。 */
const currentEntry = computed<DirectoryEntry | null>(() => current.value?.current ?? null)

async function load(path?: string): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    view.value = await browseDirectories(path)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读不到目录'
    view.value = null
  } finally {
    loading.value = false
  }
}

watch(open, (isOpen) => {
  if (!isOpen) return
  view.value = null
  error.value = ''
  void load(props.start?.trim() || undefined)
})

function enter(entry: DirectoryEntry): void {
  void load(entry.path)
}

function pick(): void {
  const item = current.value
  if (!item) return
  emit('pick', item.path)
  open.value = false
}
</script>

<template>
  <AppModal v-model:open="open" title="选择目录">
    <div class="picker">
      <!-- 当前位置：等宽字体 + 可选中的文本（路径会被复制去别处用） -->
      <p class="where">
        <code>{{ current?.path || '读取中…' }}</code>
      </p>

      <!-- 起点：家目录 / 盘符 / 已有工作区。路径很深时不用从根一路点下来 -->
      <div v-if="current?.roots.length" class="roots">
        <button
          v-for="root in current.roots"
          :key="root.path"
          type="button"
          class="root"
          :title="root.path"
          @click="enter(root)"
        >
          {{ root.name }}
        </button>
      </div>

      <p v-if="error" class="error-line">{{ error }}</p>
      <SkeletonBlock v-else-if="loading" variant="list" :rows="4" />

      <template v-else-if="current">
        <div class="list-head">
          <button
            type="button"
            class="up"
            :disabled="!current.parent"
            @click="current.parent && load(current.parent)"
          >
            <IconChevronLeft :size="14" />
            上一级
          </button>
          <span v-if="current.note" class="note">{{ current.note }}</span>
        </div>

        <ul v-if="current.entries.length" class="dirs">
          <li v-for="entry in current.entries" :key="entry.path">
            <button type="button" class="dir" :title="entry.path" @click="enter(entry)">
              <span class="dir-name">{{ entry.name }}</span>
              <span v-if="!entry.selectable" class="dir-why">{{ entry.reason }}</span>
            </button>
          </li>
        </ul>
        <p v-else class="empty">这个目录里没有子目录。</p>
      </template>
    </div>

    <template #footer>
      <span class="footer-hint">
        {{
          currentEntry && !currentEntry.selectable
            ? currentEntry.reason
            : '进到你想用的那一层，再点右边的按钮'
        }}
      </span>
      <AppButton @click="open = false">取消</AppButton>
      <AppButton
        variant="primary"
        :disabled="!current || currentEntry?.selectable === false"
        @click="pick"
      >
        选这个目录
      </AppButton>
    </template>
  </AppModal>
</template>

<style scoped>
.picker {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  /* 固定高度：目录长短不一，高度跟着跳会让"上一级"按钮跑掉 */
  min-height: 320px;
}

.where {
  margin: 0;
}

.where code {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: var(--text-meta-size);
  word-break: break-all;
  user-select: text;
}

.roots {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}

.root {
  padding: 3px 10px;
  font: inherit;
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
  background: var(--surface-muted, rgba(0, 0, 0, 0.04));
  border: none;
  border-radius: var(--radius-pill);
  cursor: pointer;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.root:hover {
  color: var(--text);
}

.list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.up {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  font: inherit;
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
  background: transparent;
  border: none;
  border-radius: var(--radius-pill);
  cursor: pointer;
}

.up:disabled {
  opacity: 0.4;
  cursor: default;
}

.note {
  font-size: var(--text-meta-size);
  color: var(--text-tertiary);
}

.dirs {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  max-height: 320px;
  overflow: auto;
}

/* 每一行就是"进下一层"：命中区铺满整行，而不是只有一个词能点 */
.dir {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  width: 100%;
  padding: 6px 8px;
  font: inherit;
  font-size: var(--text-meta-size);
  text-align: left;
  color: var(--text);
  background: transparent;
  border: none;
  border-radius: var(--radius-sm, 6px);
  cursor: pointer;
}

.dir:hover {
  background: var(--surface-hover, rgba(0, 0, 0, 0.04));
}

.dir-name {
  flex-shrink: 0;
}

.dir-why {
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty,
.error-line {
  margin: 0;
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
}

.error-line {
  color: var(--status-danger);
}

.footer-hint {
  margin-right: auto;
  font-size: var(--text-meta-size);
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 320px;
}
</style>
