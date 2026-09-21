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
 * ## 四条交互约定
 *
 * 1. **点一行 = 进去**，不是"选中"：目录树里"进下一层"才是最常用的动作，
 *    而"就选它"由底部那颗按钮负责（与系统的文件夹选择器一致）；
 * 2. **不可选的目录照样能进去看**（灰的是底部那颗"选这个目录"，不是那一行）：
 *    数据目录整个子树都不能当工作区，但"点进去看看"是人的正常动作，
 *    而拦着一个操作只会让人以为界面坏了。灰的那一行会显示服务端给的原因；
 * 3. **路径一律由服务端给**（`path` 字段），前端不自己拼字符串：
 *    Windows 的反斜杠、Linux 的根、网络路径的写法各不一样，拼错一次就是"找不到"；
 * 4. **新建 / 改名都是内联一行输入**（v0.36），不弹第二个框：这两个动作改的都是
 *    "当前这一层里的某个名字"，而那一行就摆在他眼前——再叠一层弹窗只会让人
 *    分不清自己改的是哪一层。**建完直接进去**（"我要一个放新项目的目录"是建目录的
 *    真实意图，让他再点一次"进去"是多余的一步）。
 *
 * ## 建 / 改都在服务器上，所以拒得比浏览多
 *
 * 服务端那边有四条拒绝（文件系统根、数据目录及其内部、**包含数据目录的那个目录**、
 * **某个工作区的根目录**），每条都带具体理由，原样显示在这里——
 * 界面不自己判，也就不会出现"按钮亮着、点了却报错"。
 */
import { computed, ref, watch } from 'vue'

import {
  browseDirectories,
  createDirectory,
  renameDirectory,
  type DirectoryEntry,
  type WorkspaceBrowse,
} from '@/api/workspaces'
import IconChevronLeft from '@/components/icons/IconChevronLeft.vue'
import IconEdit from '@/components/icons/IconEdit.vue'
import IconFolderPlus from '@/components/icons/IconFolderPlus.vue'
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

/** 正在新建 / 正在改名的那一行。**同一时刻只允许一处**，免得两个输入框抢焦点。 */
const creating = ref(false)
const newName = ref('')
const renaming = ref('')
const renameName = ref('')
const busy = ref(false)
/** 动作自己的错（重名、名字非法…）：显示在列表上方，不覆盖整个列表。 */
const actionError = ref('')

const current = computed(() => view.value)
/** 当前这一层自己能不能选：**服务端说了算**（`current`），界面不自己判。 */
const currentEntry = computed<DirectoryEntry | null>(() => current.value?.current ?? null)

async function load(path?: string): Promise<void> {
  loading.value = true
  error.value = ''
  cancelEditing()
  try {
    view.value = await browseDirectories(path)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读不到目录'
    view.value = null
  } finally {
    loading.value = false
  }
}

function cancelEditing(): void {
  creating.value = false
  newName.value = ''
  renaming.value = ''
  renameName.value = ''
  actionError.value = ''
}

function startCreate(): void {
  cancelEditing()
  creating.value = true
}

function startRename(entry: DirectoryEntry): void {
  cancelEditing()
  renaming.value = entry.path
  renameName.value = entry.name
}

/**
 * 新建 → **建完直接进去**。
 *
 * 建目录的真实意图是"我要一个放新项目的目录"，所以建完停在这一层、让他再点一次
 * "进去"是多余的一步；而进去之后路径那一行就摆着他刚建的那个目录，也算一种确认。
 */
async function submitCreate(): Promise<void> {
  const parent = current.value?.path
  const name = newName.value.trim()
  if (!parent || !name || busy.value) return
  busy.value = true
  actionError.value = ''
  try {
    const entry = await createDirectory(parent, name)
    creating.value = false
    newName.value = ''
    await load(entry.path)
  } catch (cause) {
    actionError.value = cause instanceof Error ? cause.message : '建不了'
  } finally {
    busy.value = false
  }
}

/** 改名 → **留在原地刷新**（改的是这一行，不是"进去"）。 */
async function submitRename(): Promise<void> {
  const path = renaming.value
  const name = renameName.value.trim()
  if (!path || !name || busy.value) return
  busy.value = true
  actionError.value = ''
  try {
    await renameDirectory(path, name)
    renaming.value = ''
    renameName.value = ''
    await load(current.value?.path)
  } catch (cause) {
    actionError.value = cause instanceof Error ? cause.message : '改不了'
  } finally {
    busy.value = false
  }
}

watch(open, (isOpen) => {
  if (!isOpen) return
  view.value = null
  error.value = ''
  cancelEditing()
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
      <p v-else-if="actionError" class="error-line">{{ actionError }}</p>
      <SkeletonBlock v-if="loading" variant="list" :rows="4" />

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
          <!-- 新建就在这里（不再弹第二个框）：它建的是"当前这一层"下的目录，
               而"当前这一层"就写在上面那一行 -->
          <button type="button" class="new-dir" :disabled="busy" @click="startCreate">
            <IconFolderPlus :size="14" />
            新建文件夹
          </button>
        </div>

        <!-- 新建：内联一行输入（Enter 确认、Esc 取消） -->
        <div v-if="creating" class="edit-row">
          <input
            v-model="newName"
            class="edit-input"
            placeholder="文件夹名"
            aria-label="新文件夹名"
            @keyup.enter="submitCreate"
            @keyup.esc="cancelEditing"
          />
          <AppButton
            size="sm"
            variant="primary"
            :disabled="busy || !newName.trim()"
            @click="submitCreate"
          >
            建
          </AppButton>
          <AppButton size="sm" variant="ghost" @click="cancelEditing">取消</AppButton>
        </div>

        <ul v-if="current.entries.length" class="dirs">
          <li v-for="entry in current.entries" :key="entry.path" class="dir-row">
            <template v-if="renaming === entry.path">
              <input
                v-model="renameName"
                class="edit-input"
                :aria-label="`把「${entry.name}」改名`"
                @keyup.enter="submitRename"
                @keyup.esc="cancelEditing"
              />
              <AppButton
                size="sm"
                variant="primary"
                :disabled="busy || !renameName.trim()"
                @click="submitRename"
              >
                改
              </AppButton>
              <AppButton size="sm" variant="ghost" @click="cancelEditing">取消</AppButton>
            </template>
            <template v-else>
              <button type="button" class="dir" :title="entry.path" @click="enter(entry)">
                <span class="dir-name">{{ entry.name }}</span>
                <span v-if="!entry.selectable" class="dir-why">{{ entry.reason }}</span>
              </button>
              <!-- 悬停才出现（与侧栏那个「新建」同一个手法）：一行一个图标会把列表压得很吵 -->
              <button
                type="button"
                class="row-action"
                :aria-label="`把「${entry.name}」改名`"
                @click="startRename(entry)"
              >
                <IconEdit :size="13" />
              </button>
            </template>
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

/* 「新建文件夹」推到这一行的最右：左边是"上一级"（导航），右边是"动作" */
.new-dir {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  padding: 2px 8px;
  font: inherit;
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
  background: transparent;
  border: none;
  border-radius: var(--radius-pill);
  cursor: pointer;
}

.new-dir:hover:not(:disabled) {
  color: var(--text);
  background: var(--surface-hover, rgba(0, 0, 0, 0.04));
}

.new-dir:disabled {
  opacity: 0.5;
  cursor: default;
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

/* 一行 = 「进下一层」那颗按钮 + 悬停才出现的改名图标 */
.dir-row,
.edit-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.edit-row {
  padding: 2px 8px;
}

.edit-input {
  flex: 1;
  min-width: 0;
  height: var(--control-height, 32px);
  padding: 0 8px;
  font: inherit;
  font-size: var(--text-meta-size);
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--accent-selected, var(--border));
  border-radius: var(--radius-sm, 6px);
  outline: none;
}

/* 每一行就是"进下一层"：命中区铺满整行，而不是只有一个词能点 */
.dir {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  flex: 1;
  min-width: 0;
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

.row-action {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  padding: 4px;
  color: var(--text-tertiary);
  background: transparent;
  border: none;
  border-radius: var(--radius-sm, 6px);
  cursor: pointer;
  opacity: 0;
}

/* 悬停或键盘走到这一行才露出来 */
.dir-row:hover .row-action,
.dir-row:focus-within .row-action {
  opacity: 1;
}

.row-action:hover {
  color: var(--text);
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
