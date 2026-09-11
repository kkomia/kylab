<script setup lang="ts">
/**
 * 上传文档弹窗（M6 / M5 收口）。
 *
 * **为什么把"选完就传"换成弹窗**：原先点按钮 → 系统文件选择器 → 立刻上传。
 * 两个问题：
 *
 * 1. **批量上传的结果只能发 toast**。传 20 个文件时，用户看到 20 条一闪而过的
 *    提示，其中"哪几个是重复、哪几个失败了"根本记不住。而重复与失败恰恰是他
 *    需要处理的部分。所以这里给一份**逐文件的结果清单**，留在屏幕上不消失。
 * 2. **选错了没法回头**。选完立刻发出去的代价是：发现选错只能等它传完再删。
 *    这里中间加一步"确认"，可以逐个移除。
 *
 * **刻意不做的事**：不提供切块参数。切块策略与块长是**知识库级属性**
 * （建库时定、向量化时冻结模型），放在上传弹窗里会让人以为可以逐文件不同——
 * 那会造成同一库里切法不一致，而检索质量无从解释。
 */
import { computed, ref, watch } from 'vue'

import { uploadDocument } from '@/api/documents'
import IconClose from '@/components/icons/IconClose.vue'
import IconUpload from '@/components/icons/IconUpload.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppModal from '@/components/ui/AppModal.vue'
import { formatBytes } from '@/composables/useFormat'
import {
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_FILES,
  MAX_UPLOAD_MB,
  UPLOAD_FORMAT_HINT,
} from '@/composables/uploadLimits'

const open = defineModel<boolean>('open', { required: true })

const props = defineProps<{ kbId: string; kbName?: string }>()
const emit = defineEmits<{ uploaded: [] }>()

/**
 * `rejected` 与 `failed` 分开，是因为**下一步动作不同**：
 * - `rejected`：本地就不收（超过单文件上限）。原样重试毫无意义，得换个文件。
 * - `failed`：发出去了、后端拒了。可能是一次网络抖动或临时错误，值得重试。
 * 合成一个"失败"会让用户对着一个永远不会成功的文件反复点重试。
 */
type Status = 'pending' | 'uploading' | 'done' | 'duplicate' | 'failed' | 'rejected'

interface Item {
  file: File
  status: Status
  message: string
}

const items = ref<Item[]>([])
const uploading = ref(false)
const dragActive = ref(false)
const input = ref<HTMLInputElement | null>(null)

/** 弹窗内的提醒（如"一次最多 N 个，后面几个没加进来"）。
 *  **不弹 toast**：toast 会飘到弹窗之外，而这句话说的正是弹窗里这份清单，
 *  说给清单听的话就该写在清单旁边。 */
const notice = ref('')

/* 上限与格式清单都在 `composables/uploadLimits.ts`：空状态与这里要说同一句话，
   分散写必然改一处漏一处。界面文案一律引那份常量，不在这里再抄一遍。 */

const pendingCount = computed(() => items.value.filter((i) => i.status === 'pending').length)
const doneCount = computed(
  () => items.value.filter((i) => i.status === 'done' || i.status === 'duplicate').length,
)
const failedCount = computed(() => items.value.filter((i) => i.status === 'failed').length)
const rejectedCount = computed(() => items.value.filter((i) => i.status === 'rejected').length)

/** 值得重试的失败项：只重置 `failed`，`rejected` 重置了还是会被同一把尺子拦下。 */
function retryFailed(): void {
  for (const item of items.value) {
    if (item.status === 'failed') {
      item.status = 'pending'
      item.message = ''
    }
  }
}

const totalBytes = computed(() =>
  items.value.filter((i) => i.status === 'pending').reduce((sum, i) => sum + i.file.size, 0),
)

/** 结果清单是否还值得留在屏幕上——传完之后它才是重点，所以不自动关弹窗。 */
const hasResult = computed(() => items.value.some((i) => i.status !== 'pending'))

/** 能开始上传的前提：有**待上传**的，而且没有正在传的。 */
const canSubmit = computed(() => pendingCount.value > 0 && !uploading.value)

function addFiles(files: File[]): void {
  // 去重要覆盖**同一批里自己重**：`Set` 是随加入一起长的，不是先算完再筛。
  // 写成"先按已有清单算出 fresh、再整个 append"时，同一次拖进来的两个同名同大小的
  // 文件会双双进清单（两个 `a.txt` 看着像界面出了错），而用户完全可能
  // 从两个目录各拖一个同名文件过来。
  const existing = new Set(items.value.map((i) => `${i.file.name}:${i.file.size}`))
  const fresh: File[] = []
  const dupInBatch: string[] = []
  for (const file of files) {
    const key = `${file.name}:${file.size}`
    if (existing.has(key)) {
      dupInBatch.push(file.name)
      continue
    }
    existing.add(key)
    fresh.push(file)
  }

  // 超出一次能处理的量：只取前 N 个，并**明说被砍掉了几个**。
  // 静默丢弃是最坏的处理——用户以为选上了，等传完才发现少文件。
  const overflow = fresh.length > MAX_UPLOAD_FILES
  const taken = overflow ? fresh.slice(0, MAX_UPLOAD_FILES) : fresh

  const prepared: Item[] = taken.map((file) => {
    // 超限在本地就判定，不发出请求：等后端读完 300MB 再回 413，
    // 用户白等的那几十秒完全可以用 file.size 立刻省掉
    if (file.size > MAX_UPLOAD_BYTES) {
      return {
        file,
        status: 'rejected' as Status,
        message: `超过 ${MAX_UPLOAD_MB}MB 上限，请先压缩或切分`,
      }
    }
    return { file, status: 'pending' as Status, message: '' }
  })

  items.value = [...items.value, ...prepared]

  if (overflow) {
    notice.value = `一次最多 ${MAX_UPLOAD_FILES} 个文件，后面的 ${fresh.length - MAX_UPLOAD_FILES} 个没有加入清单`
  } else if (dupInBatch.length) {
    // 说一句"这份文件只算了一次"：不然用户按自己拖了几个数，会觉得界面吞了文件。
    // 真正的去重（同一份**内容**、不同文件名）在后端按内容 hash 做，
    // 这里只是拦住"同一批里的同名同大小"，免得清单上出现两行一模一样的。
    const names = [...new Set(dupInBatch)].join('、')
    notice.value = `「${names}」重复选择，只加入清单一次`
  }
}

function reset(): void {
  items.value = []
  uploading.value = false
  notice.value = ''
}

function onPicked(event: Event): void {
  const target = event.target as HTMLInputElement
  addFiles(Array.from(target.files ?? []))
  // 清空 value 才能连续选同一个文件
  target.value = ''
}

function onDrop(event: DragEvent): void {
  dragActive.value = false
  addFiles(Array.from(event.dataTransfer?.files ?? []))
}

function remove(index: number): void {
  items.value = items.value.filter((_, i) => i !== index)
}

async function submit(): Promise<void> {
  if (uploading.value || pendingCount.value === 0) return
  uploading.value = true

  // **逐个串行**而不是并发：并发上传会让后端同时跑多个摄入任务，
  // 而摄入是 CPU 密集的（切块 + 向量化），并发只会让每个都变慢，
  // 还会让"卡在第几个"无从判断。串行也让进度条是可读的。
  for (const item of items.value) {
    if (item.status !== 'pending') continue
    item.status = 'uploading'
    try {
      const accepted = await uploadDocument(props.kbId, item.file)
      if (accepted.is_duplicate) {
        item.status = 'duplicate'
        item.message = '内容与库中已有文档相同，未重复入库'
      } else {
        item.status = 'done'
        item.message = '已提交，正在后台处理'
      }
    } catch (cause) {
      item.status = 'failed'
      item.message = cause instanceof Error ? cause.message : '上传失败'
    }
  }

  uploading.value = false
  emit('uploaded')
}

/**
 * 关闭时清空。
 *
 * **用 watch 而不是只在"关闭"按钮里清**：Esc、点遮罩、点右上角都能关掉弹窗，
 * 只处理按钮会让另外三条路径留下上次的清单——下次打开看到一堆陈旧的文件，
 * 分不清哪些是这次的。
 */
watch(open, (isOpen) => {
  if (!isOpen) reset()
})
</script>

<template>
  <AppModal v-model:open="open" title="上传文档" size="wide">
    <p class="lead">
      上传到「{{ props.kbName ?? '当前知识库' }}」。选好文件再点「开始上传」，可以先挑掉选错的，
      不必等它传完再删。
    </p>

    <!--
      拖放区是个**容器**而不是按钮：它里面要放一句很长的说明，整块做成 button
      会让辅助技术把那段说明读成按钮名字。
      可点的部分单独一个 AppButton——它自带 Tab 焦点与键盘激活，
      而"整块可点"的 div 键盘用户根本到不了。

      **选完文件后它自己变矮**：这时人在读下面的清单，
      一个 150px 高的拖放区只是在把清单往下挤（那 320px 的清单才是重点）。
    -->
    <div
      class="dropzone"
      :class="{ 'dropzone-active': dragActive, 'dropzone-compact': items.length > 0 }"
      @dragover.prevent="dragActive = true"
      @dragleave.prevent="dragActive = false"
      @drop.prevent="onDrop"
    >
      <IconUpload :size="items.length ? 16 : 24" />
      <AppButton @click="input?.click()">选择文件…</AppButton>
      <span class="dropzone-hint">也可以把文件直接拖到这里</span>
    </div>
    <input
      ref="input"
      class="visually-hidden"
      type="file"
      multiple
      tabindex="-1"
      aria-hidden="true"
      @change="onPicked"
    />

    <!--
      支持范围**写在拖放区外面**：它是这次上传的规则，不是"往这里放东西"的动作，
      塞进虚线框里会把那个框撑成四行。
      位置也讲究——它必须一直在，选完文件后清单可能滚到几百像素长，
      贴在拖放区里就会跟着滚出视野，规则和"为什么这个文件没收"就断了联系。
    -->
    <p class="scope">
      {{ UPLOAD_FORMAT_HINT }}。单个文件不超过 {{ MAX_UPLOAD_MB }}MB、一次最多
      {{ MAX_UPLOAD_FILES }} 个。
      <span class="scope-note">
        切块策略与块长由知识库决定（建库时设定），这里不逐文件调整—— 同一个库里切法不一致
        会让检索质量无从解释。
      </span>
    </p>

    <!-- 提醒写在清单旁边而不是飘成 toast：这句话说的就是下面这份清单 -->
    <p v-if="notice" class="notice">{{ notice }}</p>

    <!--
      行是**四列网格**而不是 flex：flex 下"状态"和"说明"各自的宽度随文字长短变，
      三行的状态就落在三个不同位置，竖着扫下来是锯齿。
      固定列宽之后状态成了一条竖轴，说明文字统一从同一条线开始。
    -->
    <ul v-if="items.length" class="file-list">
      <li
        v-for="(item, index) in items"
        :key="`${item.file.name}:${item.file.size}`"
        class="file-row"
      >
        <span class="file-name" :title="item.file.name">{{ item.file.name }}</span>
        <span class="file-size tabular">{{ formatBytes(item.file.size) }}</span>

        <!-- 状态用文字而不是只靠颜色：色弱与截图场景都要能读 -->
        <span class="file-status" :class="`file-status-${item.status}`">
          <template v-if="item.status === 'pending'">待上传</template>
          <template v-else-if="item.status === 'uploading'">上传中…</template>
          <template v-else-if="item.status === 'done'">已提交</template>
          <template v-else-if="item.status === 'duplicate'">重复，已跳过</template>
          <template v-else-if="item.status === 'rejected'">未接收</template>
          <template v-else>失败</template>
        </span>

        <span class="file-message">{{ item.message }}</span>

        <span class="file-action">
          <AppButton
            v-if="item.status === 'pending'"
            size="sm"
            :aria-label="`移除 ${item.file.name}`"
            @click="remove(index)"
          >
            <template #icon><IconClose :size="14" /></template>
          </AppButton>
        </span>
      </li>
    </ul>

    <template #footer>
      <span class="foot-summary">
        <template v-if="items.length === 0">还没有选择文件</template>
        <template v-else>
          共 {{ items.length }} 个
          <template v-if="pendingCount"
            >· 待上传 {{ pendingCount }}（{{ formatBytes(totalBytes) }}）</template
          >
          <template v-if="doneCount">· 已处理 {{ doneCount }}</template>
          <template v-if="failedCount">· 失败 {{ failedCount }}</template>
          <template v-if="rejectedCount">· 未接收 {{ rejectedCount }}</template>
        </template>
      </span>
      <AppButton v-if="failedCount" @click="retryFailed">重试失败项（{{ failedCount }}）</AppButton>
      <AppButton v-if="hasResult" @click="reset">清空清单</AppButton>
      <AppButton @click="open = false">关闭</AppButton>
      <AppButton variant="primary" :disabled="!canSubmit" @click="submit">
        {{ uploading ? '上传中…' : `开始上传${pendingCount ? `（${pendingCount}）` : ''}` }}
      </AppButton>
    </template>
  </AppModal>
</template>

<style scoped>
.lead {
  margin: 0 0 var(--space-3);
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
}

/* 拖放区：虚线边框表示"这里可以放东西"。
   它是可点区域，所以给足高度并保留 hover/focus 反馈 */
.dropzone {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-5) var(--space-4);
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
  text-align: center;
  background: var(--bg-subtle);
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-panel);
  cursor: pointer;
}

.dropzone:hover,
.dropzone-active {
  color: var(--text-primary);
  border-color: var(--accent);
}

/* 已经有文件之后压成一行：这时视线在下面的清单上，
   拖放区留 150px 高只会把清单顶下去 */
.dropzone-compact {
  flex-direction: row;
  justify-content: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-4);
}

/* 两行说明都用同一档：micro 字号 + 三级文字色。
   它们是**背景知识**而不是操作提示，比"选择文件…"按钮弱一档是对的。 */
.dropzone-hint {
  max-width: 56ch;
  font-size: var(--text-micro-size);
  line-height: 1.7;
  color: var(--text-tertiary);
}

/*
 * 支持范围：整行铺满而不是居中收窄。
 * 它是一句要**读完才有用**的清单（格式 + 两个上限），
 * 居中到 56ch 会折成三行、每行都很短，读起来像诗。
 * 铺满 980px 的弹窗宽度后两行就放下了，也不是居中的"引用"体例。
 */
.scope {
  margin: var(--space-3) 0 0;
  font-size: var(--text-micro-size);
  line-height: 1.7;
  color: var(--text-secondary);
}

/* 切块那段再弱一档：它是"为什么这里没有参数"的解释，
   不是"你要准备什么"的操作要求 */
.scope-note {
  color: var(--text-tertiary);
}

.file-list {
  margin: var(--space-3) 0 0;
  padding: 0;
  list-style: none;
  max-height: 320px;
  overflow-y: auto;
}

/* 提醒用中性文字色而不是红：它说的是"少加了几个"，不是"传失败了" */
.notice {
  margin: var(--space-3) 0 0;
  font-size: var(--text-micro-size);
  color: var(--text-secondary);
}

/* 文件选择器本体必须留在可访问树之外：它有 tabindex="-1" + aria-hidden，
   视觉上只留 1px，真正的入口是上面那个"选择文件…"按钮 */
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

/*
 * 四列网格：名称 + 大小 + 状态 + 说明，最后一列是移除按钮的固定位
 * （即使按钮不存在也占位——否则"待上传"的行比别的行短，右侧对不齐）。
 *
 * 名称列**不取满剩余空间**（`0.55fr` 对说明列的 `1fr`）：让文件名把宽度吃光，
 * 状态与说明就会被推到最右边贴着按钮，中间留一大段空白；
 * 文件名与状态本来就该挨着看。`fr` 之和小于 1 时剩下的空间会平摊，
 * 所以这里的比值是在调"谁长谁短"，不是调"占满多少"。
 */
.file-row {
  display: grid;
  grid-template-columns: minmax(0, 0.55fr) 56px 84px minmax(0, 1fr) 32px;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) 0;
}

.file-row + .file-row {
  border-top: 1px solid var(--border-hairline);
}

.file-name {
  min-width: 0;
  overflow: hidden;
  font-size: var(--text-meta-size);
  color: var(--text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-size {
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
  text-align: right;
}

.file-status {
  font-size: var(--text-micro-size);
}

.file-status-pending {
  color: var(--text-tertiary);
}

.file-status-uploading {
  color: var(--status-info);
}

.file-status-done {
  color: var(--status-success);
}

/* 重复**不是错误**：它是正常结果（同一份内容不该入库两次），
   所以用中性色而不是红色——否则用户会以为传失败了 */
.file-status-duplicate {
  color: var(--text-secondary);
}

.file-status-failed {
  color: var(--status-danger);
}

/* 未接收（本地就拦下的：超上限）也用警示色，但**文案不同**——
   它要传达的是"这个文件得换个方式给"，而不是"服务出问题了" */
.file-status-rejected {
  color: var(--status-warning);
}

.file-message {
  min-width: 0;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
  overflow-wrap: anywhere;
}

.file-action {
  display: flex;
  justify-content: flex-end;
}

.foot-summary {
  margin-right: auto;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}
</style>
