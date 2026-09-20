<script setup lang="ts">
/**
 * 记忆页（v0.14 三期，见 `docs/设计/记忆层设计-v0.1.md` §3）。
 *
 * 一个视图、三块内容：**文件**（浏览与编辑）、**图谱**（wikilink 结构）、
 * **召回**（试一下搜不搜得到）。三块各回答一个问题，所以用分段控件切开，
 * 而不是全摊在一屏上。
 *
 * 三条来自后端的、必须让用户看见的事实（写在这里是因为这一页的可用性全压在它们上）：
 *
 * 1. **只有 `daily/` 与 `digest/` 会被召回**（只有它们进了记忆服务的索引守护范围）。
 *    `MEMORY.md` / `SOUL.md` 走**注入**——每轮对话都进 system prompt，但不参与检索。
 *    不写清楚的话，"改了却搜不到"会被当成 bug。
 * 2. **编辑后索引会自己跟上**（记忆服务的文件守护，实测 5 秒 debounce），
 *    所以保存路径上没有"正在重建索引"这种等待；`重建索引` 只是手动兜底。
 * 3. **记忆目前是整个部署共用的一份**（设计文档 §5 的已知边界），不按账号隔离。
 *    页头明说，不用一道假的门禁暗示它已经分好了。
 *
 * 编辑器用**纯 textarea** 而不是复用笔记那套富文本编辑器：记忆文件是要逐字还原的
 * Markdown（frontmatter 在里面），富文本"顺手格式化"一下就把用户的排版改了；
 * 而那点排版能力在这里也没人需要——这些文件本来就是要被 Agent 读的。
 */
import { computed, onMounted, ref } from 'vue'

import type {
  MemoryFile,
  MemoryFileDetail,
  MemoryGraph as GraphData,
  MemoryOverview,
} from '@/api/memory'
import {
  deleteMemoryFile,
  getMemory,
  getMemoryFile,
  getMemoryGraph,
  recallMemory,
  reindexMemory,
  rememberMemory,
  writeMemoryFile,
} from '@/api/memory'
import IconAlert from '@/components/icons/IconAlert.vue'
import IconChevronDown from '@/components/icons/IconChevronDown.vue'
import IconFile from '@/components/icons/IconFile.vue'
import IconPlus from '@/components/icons/IconPlus.vue'
import IconRefresh from '@/components/icons/IconRefresh.vue'
import IconRobot from '@/components/icons/IconRobot.vue'
import IconSettings from '@/components/icons/IconSettings.vue'
import IconSearch from '@/components/icons/IconSearch.vue'
import IconTrash from '@/components/icons/IconTrash.vue'
import MemoryGraph from '@/components/memory/MemoryGraph.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppInput from '@/components/ui/AppInput.vue'
import SettingGroupPanel from '@/components/settings/SettingGroupPanel.vue'
import AppModal from '@/components/ui/AppModal.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import InfoTip from '@/components/ui/InfoTip.vue'
import PageShell from '@/components/ui/PageShell.vue'
import RowMenu from '@/components/ui/RowMenu.vue'
import SkeletonBlock from '@/components/ui/SkeletonBlock.vue'
import StatusTag from '@/components/ui/StatusTag.vue'
import { isAdmin } from '@/composables/useSession'
import { useToast } from '@/composables/useToast'
import { formatBytes, formatDate } from '@/composables/useFormat'

type Tab = 'files' | 'graph' | 'recall'

const { notifyError, notifySuccess } = useToast()

/** 记忆设置弹窗（v0.26）：长期记忆那一组从总设置搬到了这里。 */
const settingsOpen = ref(false)

const overview = ref<MemoryOverview | null>(null)
const loading = ref(true)
const listError = ref('')

const tab = ref<Tab>('files')
const activePath = ref('')
const detail = ref<MemoryFileDetail | null>(null)
const draft = ref('')
const detailLoading = ref(false)
const saving = ref(false)
/** 保存失败的原因原样留在编辑器上方：**不能默默丢掉用户刚写的东西**。 */
const saveError = ref('')

/** 未保存时点别的文件：记下目标，等确认框的答复（见 `onDiscard`）。 */
const pendingPath = ref('')

const filter = ref('')

const graph = ref<GraphData | null>(null)
const graphLoading = ref(false)

const recallQuery = ref('')
const recallHits = ref<Awaited<ReturnType<typeof recallMemory>> | null>(null)
const recallError = ref('')
const recalling = ref(false)

const newOpen = ref(false)
const newPath = ref('digest/personal/')
const noteOpen = ref(false)
const noteText = ref('')

const confirm = ref<{ open: boolean; kind: 'discard' | 'delete'; target: MemoryFile | null }>({
  open: false,
  kind: 'discard',
  target: null,
})

/** 草稿与已保存内容不一致 = 有未保存的改动。 */
const dirty = computed(() => detail.value !== null && draft.value !== detail.value.content)

const files = computed(() => overview.value?.files ?? [])

/**
 * 按类别分组，**顺序固定**（核心 → 每日现场 → 长期知识 → 其它）。
 *
 * 不用"按时间倒序的扁平列表"（笔记那样）：记忆的读法跟笔记不同——
 * 用户来这里多半是找"我知道的那个东西"，位置（它在哪一层）本身就是线索。
 */
const GROUPS: { kind: MemoryFile['kind']; label: string }[] = [
  { kind: 'core', label: '核心（每轮注入）' },
  { kind: 'daily', label: '每日现场（可召回）' },
  { kind: 'digest', label: '长期知识（可召回）' },
  { kind: 'other', label: '其它（不参与）' },
]

const groups = computed(() => {
  const keyword = filter.value.trim().toLowerCase()
  return GROUPS.map((group) => ({
    label: group.label,
    kind: group.kind,
    items: files.value.filter((item) => {
      if (item.kind !== group.kind) return false
      if (!keyword) return true
      return (
        item.path.toLowerCase().includes(keyword) ||
        item.title.toLowerCase().includes(keyword) ||
        item.summary.toLowerCase().includes(keyword)
      )
    }),
  })).filter((group) => group.items.length > 0)
})

const status = computed(() => overview.value?.status ?? null)

const statusView = computed(() => {
  const current = status.value
  if (!current) return { label: '读取中', tone: 'neutral' as const }
  if (!current.enabled) return { label: '未启用', tone: 'neutral' as const }
  // `reachable === null` = **这次没探测**（GET /memory 不打远端）：
  // 这时只能说"已启用"，不能说"未连接"——那是替一个没发生过的检查下结论。
  if (current.reachable === null) return { label: '已启用', tone: 'neutral' as const }
  return current.reachable
    ? { label: '记忆服务正常', tone: 'success' as const }
    : { label: '记忆服务未连接', tone: 'warning' as const }
})

/** 当前文件在"能不能被召回"这条轴上的位置，用一句人话讲清。 */
const retrievalNote = computed(() => {
  const file = detail.value
  if (!file) return ''
  if (file.injected) {
    return '每轮对话都会把它整份注入上下文（不参与检索，所以搜不到是正常的）。'
  }
  if (file.retrievable) {
    return '会被「召回」（记忆检索）找到。保存后索引由记忆服务自动跟上，约几秒。'
  }
  return '这个位置的文件既不注入也不参与检索，只是一份可编辑的文本。'
})

onMounted(load)

async function load(): Promise<void> {
  loading.value = true
  listError.value = ''
  try {
    overview.value = await getMemory()
    // 首次进入默认打开核心记忆：它是这一页最该被看见的一份
    const first = files.value.find((item) => item.kind === 'core') ?? files.value[0]
    if (first && !activePath.value) await openFile(first.path)
  } catch (error) {
    listError.value = messageOf(error)
  } finally {
    loading.value = false
  }
}

async function openFile(path: string, force = false): Promise<void> {
  if (path === activePath.value && detail.value && !force) return
  if (dirty.value && !force) {
    confirm.value = { open: true, kind: 'discard', target: null }
    pendingPath.value = path
    return
  }
  activePath.value = path
  detailLoading.value = true
  saveError.value = ''
  try {
    detail.value = await getMemoryFile(path)
    draft.value = detail.value.content
  } catch (error) {
    detail.value = null
    draft.value = ''
    notifyError(`打开失败：${messageOf(error)}`)
  } finally {
    detailLoading.value = false
  }
}

function onDiscard(): void {
  const target = pendingPath.value
  pendingPath.value = ''
  confirm.value = { open: false, kind: 'discard', target: null }
  if (target) void openFile(target, true)
}

async function save(): Promise<void> {
  if (!detail.value || saving.value || !dirty.value) return
  saving.value = true
  saveError.value = ''
  try {
    detail.value = await writeMemoryFile(detail.value.path, draft.value)
    draft.value = detail.value.content
    await load()
    notifySuccess('已保存')
  } catch (error) {
    // 保存失败**不清空草稿**：用户刚写的东西必须还在编辑器里
    saveError.value = messageOf(error)
  } finally {
    saving.value = false
  }
}

function revert(): void {
  if (detail.value) draft.value = detail.value.content
}

function askDelete(): void {
  if (!detail.value) return
  confirm.value = {
    open: true,
    kind: 'delete',
    target: files.value.find((item) => item.path === detail.value?.path) ?? null,
  }
}

async function doDelete(): Promise<void> {
  const path = detail.value?.path
  confirm.value = { open: false, kind: 'delete', target: null }
  if (!path) return
  try {
    await deleteMemoryFile(path)
    notifySuccess('已删除')
    detail.value = null
    activePath.value = ''
    draft.value = ''
    await load()
  } catch (error) {
    notifyError(`删除失败：${messageOf(error)}`)
  }
}

async function createFile(): Promise<void> {
  const path = newPath.value.trim()
  if (!path) return
  if (!path.toLowerCase().endsWith('.md')) {
    notifyError('文件名要以 .md 结尾')
    return
  }
  try {
    await writeMemoryFile(path, `# ${path.split('/').pop()?.replace(/\.md$/, '') ?? '新记忆'}\n\n`)
    newOpen.value = false
    newPath.value = 'digest/personal/'
    await load()
    await openFile(path, true)
    tab.value = 'files'
    notifySuccess('已新建')
  } catch (error) {
    notifyError(`新建失败：${messageOf(error)}`)
  }
}

async function submitNote(): Promise<void> {
  const text = noteText.value.trim()
  if (!text) return
  try {
    const result = await rememberMemory(text)
    noteOpen.value = false
    noteText.value = ''
    await load()
    await openFile('MEMORY.md', true)
    notifySuccess(result.saved ? '已记进 MEMORY.md' : '这条已经在核心记忆里了')
  } catch (error) {
    notifyError(`没记下来：${messageOf(error)}`)
  }
}

async function openGraph(): Promise<void> {
  tab.value = 'graph'
  if (graph.value || graphLoading.value) return
  graphLoading.value = true
  try {
    graph.value = await getMemoryGraph()
  } catch (error) {
    notifyError(`图谱读不出来：${messageOf(error)}`)
  } finally {
    graphLoading.value = false
  }
}

function pickFromGraph(path: string): void {
  tab.value = 'files'
  void openFile(path, !dirty.value)
}

async function runRecall(): Promise<void> {
  const query = recallQuery.value.trim()
  if (!query || recalling.value) return
  recalling.value = true
  recallError.value = ''
  // 每次召回都先清空上一次的结果：留着旧结果而新结果还没到，两者会被看成一回事
  recallHits.value = null
  try {
    recallHits.value = await recallMemory(query)
  } catch (error) {
    // 关着或服务没起时后端**明确报错**（不返回空）——原样显示这句话，
    // 它说的就是"去哪儿把它弄好"
    recallHits.value = null
    recallError.value = messageOf(error)
  } finally {
    recalling.value = false
  }
}

async function reindex(): Promise<void> {
  try {
    const result = await reindexMemory()
    notifySuccess(result.detail || '已请记忆服务重建索引')
  } catch (error) {
    notifyError(messageOf(error))
  }
}

function onEditorKeydown(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    void save()
  }
}

function openFromList(path: string): void {
  tab.value = 'files'
  void openFile(path)
}

/** 菜单项拿到的是 RowMenu 的 `close`：**先收菜单再开弹窗**——
    否则弹窗关掉后菜单还开着，用户看到的是"点了两下才回到页面"。 */
function openNoteModal(close: () => void): void {
  close()
  noteOpen.value = true
}

function openNewModal(close: () => void): void {
  close()
  newOpen.value = true
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
</script>

<template>
  <PageShell title="记忆">
    <template #actions>
      <StatusTag
        :label="statusView.label"
        :tone="statusView.tone"
        :title="status?.detail || undefined"
      />
      <!--
        「设置」就在这一页（v0.26）：开关与服务地址原先挂在「总设置 → 功能 → 长期记忆」，
        而这一页顶着一句"记忆服务未启用"——同一个东西的说明和开关隔着两个菜单，
        用户按指引找过去还得先猜它在哪一组。
        **只给管理员**，与侧栏那个设置入口同一档：后端 `/settings` 是管理员端点。
      -->
      <AppButton v-if="isAdmin" @click="settingsOpen = true">
        <template #icon><IconSettings :size="15" /></template>
        设置
      </AppButton>
      <AppButton v-if="status?.enabled" @click="reindex">
        <template #icon><IconRefresh :size="15" /></template>
        重建索引
      </AppButton>
      <!-- 同时要 `#trigger`（自定义触发器）和默认插槽的 `close` 时，**默认插槽必须
           写成 `<template #default>`**：在组件标签上写 `v-slot` 又在其内部写具名
           `<template #trigger>`，Vue 的编译器会直接报
           "Codegen node is missing for element/if/for node"——而且报的是整个
           template 编译失败（表现为该文件里所有模板引用都被报成"未使用"），
           从错误信息完全看不出是这一行的 slot 写法。 -->
      <RowMenu label="新增">
        <template #trigger>
          <span class="add-trigger">
            <IconPlus :size="15" />新增<IconChevronDown :size="13" />
          </span>
        </template>
        <template #default="{ close }">
          <button type="button" @click="openNoteModal(close)">
            <IconRobot :size="14" /> 记一条事实
          </button>
          <button type="button" @click="openNewModal(close)">
            <IconFile :size="14" /> 新建记忆文件
          </button>
        </template>
      </RowMenu>
      <AppButton variant="primary" :disabled="!dirty || saving" @click="save">
        {{ saving ? '保存中…' : '保存' }}
      </AppButton>
    </template>

    <p v-if="listError" class="notice notice-error">
      <IconAlert :size="15" />
      <span>{{ listError }}</span>
    </p>

    <SkeletonBlock v-if="loading" variant="list" :rows="6" />

    <template v-else>
      <div class="tabs" role="tablist">
        <button
          type="button"
          role="tab"
          :aria-selected="tab === 'files'"
          :class="{ on: tab === 'files' }"
          @click="tab = 'files'"
        >
          文件<span v-if="status" class="tab-count tabular">{{ status.file_count }}</span>
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="tab === 'graph'"
          :class="{ on: tab === 'graph' }"
          @click="openGraph"
        >
          图谱
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="tab === 'recall'"
          :class="{ on: tab === 'recall' }"
          @click="tab = 'recall'"
        >
          召回
        </button>
      </div>

      <!-- ------------------------------------------------------------- 文件 -->
      <div v-if="tab === 'files'" class="files">
        <aside class="file-list" aria-label="记忆文件">
          <div class="search-box">
            <IconSearch :size="14" class="search-icon" />
            <AppInput
              v-model="filter"
              placeholder="按路径、标题、摘要过滤"
              aria-label="过滤记忆文件"
            />
          </div>

          <p v-if="overview?.truncated" class="list-hint">
            文件太多，这里只列出了前面 {{ status?.file_count }} 个。
          </p>

          <EmptyState
            v-if="!groups.length"
            :title="files.length ? '没有匹配的文件' : '工作区里还没有记忆文件'"
            :hint="
              files.length
                ? '换个关键词，或者清空过滤。'
                : '记忆服务开启后，对话会自动沉淀出每日笔记；也可以先手动新建一份。'
            "
          />

          <div v-else class="file-groups">
            <section v-for="group in groups" :key="group.label" class="file-group">
              <p class="group-label">{{ group.label }}</p>
              <ul>
                <li v-for="item in group.items" :key="item.path">
                  <button
                    type="button"
                    class="file-item"
                    :class="{ 'file-item-on': item.path === activePath }"
                    @click="openFromList(item.path)"
                  >
                    <span class="file-item-title">{{ item.title }}</span>
                    <span class="file-item-path">{{ item.path }}</span>
                    <span class="file-item-meta">
                      <span
                        v-if="item.kind === 'daily'"
                        class="chip"
                        :class="{ warn: !item.consolidated }"
                      >
                        {{ item.consolidated ? '已整合' : '待整合' }}
                      </span>
                      <span v-else-if="!item.retrievable && !item.injected" class="chip"
                        >不参与</span
                      >
                      <span class="tabular">{{ formatBytes(item.size_bytes) }}</span>
                    </span>
                  </button>
                </li>
              </ul>
            </section>
          </div>

          <p v-if="status" class="list-foot text-micro">
            工作区：<code>{{ status.workspace }}</code>
          </p>
        </aside>

        <section class="editor" aria-label="记忆编辑器">
          <SkeletonBlock v-if="detailLoading" variant="text" :rows="6" />

          <EmptyState
            v-else-if="!detail"
            title="选一份记忆开始读"
            hint="左边是工作区里的全部 Markdown：核心记忆、每日现场、整合后的长期知识。"
          />

          <template v-else>
            <header class="editor-head">
              <div class="editor-title">
                <h2>{{ detail.title }}</h2>
                <!-- 核心文件的标题就是文件名（MEMORY.md），再摆一行路径是重复的 -->
                <code v-if="detail.path !== detail.title" class="path">{{ detail.path }}</code>
              </div>
              <div class="editor-actions">
                <span v-if="dirty" class="dirty-dot" title="有未保存的改动">未保存</span>
                <AppButton v-if="dirty" size="sm" @click="revert">还原</AppButton>
                <AppButton size="sm" variant="danger" @click="askDelete">
                  <template #icon><IconTrash :size="14" /></template>
                  删除
                </AppButton>
              </div>
            </header>

            <p class="editor-note text-micro">
              {{ retrievalNote }}
              <InfoTip
                text="记忆分两路生效：核心文件（MEMORY.md / SOUL.md）每轮整份注入上下文；每日现场与长期知识进检索索引，由召回工具按需取片段。其余位置的文件只是可编辑文本。"
              />
            </p>

            <p v-if="saveError" class="notice notice-error">
              <IconAlert :size="15" />
              <span>{{ saveError }}（你的改动还在编辑器里，可以再存一次）</span>
            </p>

            <textarea
              v-model="draft"
              class="editor-body"
              spellcheck="false"
              aria-label="记忆文件正文"
              @keydown="onEditorKeydown"
            ></textarea>

            <footer class="editor-foot text-micro">
              <span class="tabular"
                >{{ formatBytes(detail.size_bytes) }} · 改动于
                {{ formatDate(detail.modified_at) }}</span
              >
              <span v-if="detail.truncated" class="truncated-warn">
                文件过大，这里只读出了前一部分——保存会覆盖掉后面的内容，请先用别的编辑器处理。
              </span>
              <span class="tabular">{{ dirty ? 'Ctrl/Cmd + S 保存' : '已是最新' }}</span>
            </footer>
          </template>
        </section>
      </div>

      <!-- ------------------------------------------------------------- 图谱 -->
      <div v-else-if="tab === 'graph'" class="graph-tab">
        <SkeletonBlock v-if="graphLoading" variant="list" :rows="5" />
        <EmptyState
          v-else-if="graph && !graph.nodes.length"
          title="还没有连起来的记忆"
          hint="在正文里写 [[另一份记忆]]，两份记忆就建立了一条链接；图谱按链接画出结构。"
        />
        <MemoryGraph
          v-else-if="graph"
          :graph="graph"
          :selected="activePath"
          @select="pickFromGraph"
        />
      </div>

      <!-- ------------------------------------------------------------- 召回 -->
      <div v-else class="recall-tab">
        <form class="recall-form" @submit.prevent="runRecall">
          <AppInput
            v-model="recallQuery"
            placeholder="例如：用户偏好什么样的回答风格"
            aria-label="召回测试"
          />
          <AppButton variant="primary" type="submit" :disabled="recalling || !recallQuery.trim()">
            {{ recalling ? '召回中…' : '召回' }}
          </AppButton>
        </form>

        <p v-if="recallError" class="notice notice-error">
          <IconAlert :size="15" />
          <span>{{ recallError }}</span>
        </p>

        <template v-else-if="recallHits">
          <EmptyState
            v-if="!recallHits.hits.length"
            title="没有召回任何记忆"
            hint="这代表记忆里没有相关的内容，不是出错。可以换个说法再试，或者先把这条记下来。"
          />

          <template v-else>
            <p class="text-micro">{{ recallHits.note }}</p>
            <ul class="hit-list">
              <li v-for="(hit, at) in recallHits.hits" :key="`${hit.path}-${at}`" class="hit">
                <div class="hit-head">
                  <button
                    v-if="hit.path"
                    type="button"
                    class="hit-path"
                    @click="openFromList(hit.path)"
                  >
                    {{ hit.path }}
                  </button>
                  <span v-else class="hit-path">（没有出处）</span>
                  <span class="hit-score tabular">
                    <template v-if="hit.start_line !== null">
                      L{{ hit.start_line
                      }}<template v-if="hit.end_line">–{{ hit.end_line }}</template>
                    </template>
                    <template v-if="hit.score !== null">· {{ hit.score.toFixed(2) }}</template>
                  </span>
                </div>
                <p class="hit-text">{{ hit.text }}</p>
              </li>
            </ul>

            <div v-if="recallHits.links.length" class="link-block">
              <p class="group-label">顺着链接可以走到</p>
              <ul class="link-list">
                <li v-for="(link, at) in recallHits.links" :key="`${link.path}-${at}`">
                  <button type="button" class="hit-path" @click="openFromList(link.path)">
                    {{ link.name || link.path }}
                  </button>
                  <span class="text-micro">{{ link.direction === 'out' ? '出链' : '入链' }}</span>
                </li>
              </ul>
            </div>
          </template>
        </template>
      </div>
    </template>

    <!-- ----------------------------------------------------------- 对话框 -->
    <AppModal v-model:open="newOpen" title="新建记忆文件">
      <p class="modal-lead text-meta">
        放在哪个目录决定它怎么生效：<code>digest/</code> 下会被召回， <code>memory/</code>（或
        <code>daily/</code>）下是每日现场，根下只当作普通文本。
      </p>
      <label class="field">
        <span class="field-label">文件路径</span>
        <AppInput v-model="newPath" placeholder="digest/personal/某条结论.md" />
      </label>
      <div class="presets">
        <button type="button" @click="newPath = 'digest/personal/'">个人知识</button>
        <button type="button" @click="newPath = 'digest/procedure/'">可复用流程</button>
        <button type="button" @click="newPath = 'digest/wiki/'">主题综述</button>
      </div>
      <template #footer>
        <AppButton @click="newOpen = false">取消</AppButton>
        <AppButton variant="primary" @click="createFile">新建</AppButton>
      </template>
    </AppModal>

    <AppModal v-model:open="noteOpen" title="记一条事实">
      <p class="modal-lead text-meta">
        写进 <code>MEMORY.md</code> 的「核心长期记忆」，每轮对话都会带上它。
        一句话能说完的才放这里（最多 500 字）——更长的内容该写成笔记或记忆文件。
      </p>
      <AppInput
        v-model="noteText"
        multiline
        :rows="4"
        placeholder="例如：发布前必须先跑一遍后端门禁脚本。"
      />
      <template #footer>
        <AppButton @click="noteOpen = false">取消</AppButton>
        <AppButton variant="primary" @click="submitNote">记下来</AppButton>
      </template>
    </AppModal>

    <ConfirmDialog
      v-model:open="confirm.open"
      :title="confirm.kind === 'delete' ? '删除这份记忆？' : '放弃未保存的改动？'"
      :lead="
        confirm.kind === 'delete'
          ? `将删除 ${detail?.path ?? ''}。记忆文件没有回收站，删除后只能从备份找回。`
          : '当前文件有改动还没保存，切换过去就会丢掉。'
      "
      :note="confirm.kind === 'delete' ? '如果只是想改内容，取消后直接编辑即可。' : undefined"
      :confirm-label="confirm.kind === 'delete' ? '删除' : '放弃改动'"
      @confirm="confirm.kind === 'delete' ? doDelete() : onDiscard()"
    />
  </PageShell>

  <!-- 记忆的设置：只有一组（长期记忆），所以是一个小弹窗而不是一整页 -->
  <AppModal v-model:open="settingsOpen" title="记忆设置">
    <SettingGroupPanel :keys="['memory']" />
  </AppModal>
</template>

<style scoped>
.notice {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: 0 0 var(--space-4);
  padding: var(--space-3) var(--space-4);
  background: var(--bg-subtle);
  border-radius: var(--radius-row);
  color: var(--text-secondary);
  font-size: var(--text-meta-size);
  line-height: var(--line-ui);
}

.notice p,
.notice span {
  margin: 0;
}

.notice code,
.path,
.list-foot code {
  font-family: var(--font-mono);
  font-size: var(--text-micro-size);
}

.notice-error {
  color: var(--status-danger);
}

.add-trigger {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--text-meta-size);
}

/* 分段控件：中性底 + 选中用纸白抬起（与外壳的选中态同一套语言） */
.tabs {
  display: flex;
  gap: var(--space-1);
  padding: var(--space-0-5);
  background: var(--bg-subtle);
  border-radius: var(--radius-control);
  width: fit-content;
  margin-bottom: var(--space-4);
}

.tabs button {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  height: var(--control-height);
  padding: 0 var(--space-3);
  border: none;
  background: none;
  border-radius: var(--radius-control);
  color: var(--text-secondary);
  font-size: var(--text-meta-size);
  cursor: pointer;
  transition: var(--transition-ui);
}

.tabs button:hover {
  color: var(--text-primary);
}

.tabs button.on {
  background: var(--bg-surface);
  color: var(--text-primary);
  font-weight: 500;
}

.tab-count {
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

/* 文件：左列表 + 右编辑器。列表定宽，编辑器吃掉剩下的宽度 */
.files {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  gap: var(--space-5);
  align-items: start;
}

.file-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  position: sticky;
  top: var(--space-4);
}

.search-box {
  position: relative;
}

.search-icon {
  position: absolute;
  left: var(--space-3);
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-tertiary);
  pointer-events: none;
}

.search-box :deep(input) {
  padding-left: var(--space-8);
}

.list-hint,
.list-foot {
  margin: 0;
  color: var(--text-secondary);
}

.list-foot code {
  word-break: break-all;
}

.file-groups {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.group-label {
  margin: 0 0 var(--space-1-5);
  font-size: var(--text-micro-size);
  color: var(--text-secondary);
}

.file-group ul,
.hit-list,
.link-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.file-item {
  display: flex;
  flex-direction: column;
  gap: var(--space-0-5);
  width: 100%;
  padding: var(--space-2) var(--space-2-5);
  border: none;
  background: none;
  border-radius: var(--radius-row);
  text-align: left;
  cursor: pointer;
  transition: var(--transition-ui);
}

/* 选中用中性 alpha 填充，不用蓝色：状态靠填充、动作才靠墨色（规范 §7） */
.file-item:hover {
  background: var(--bg-hover);
}

.file-item-on {
  background: var(--bg-selected);
}

.file-item-title {
  font-size: var(--text-meta-size);
  color: var(--text-primary);
}

.file-item-path {
  font-family: var(--font-mono);
  font-size: var(--text-c2-size);
  color: var(--text-tertiary);
  word-break: break-all;
}

.file-item-meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-c2-size);
  color: var(--text-tertiary);
}

.chip {
  padding: 0 var(--space-1);
  border-radius: var(--radius-badge);
  background: var(--bg-group);
}

.chip.warn {
  background: var(--status-warning-soft);
  color: var(--text-primary);
}

/* 编辑器 */
.editor {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
}

.editor-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
}

.editor-title h2 {
  margin: 0 0 var(--space-1);
  font-size: var(--text-section-size);
  font-weight: 600;
}

.editor-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-shrink: 0;
}

.dirty-dot {
  font-size: var(--text-micro-size);
  color: var(--text-secondary);
}

.editor-note {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin: 0;
  color: var(--text-secondary);
}

.editor-body {
  width: 100%;
  min-height: 420px;
  padding: var(--space-4);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-panel);
  background: var(--bg-surface);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: var(--text-meta-size);
  line-height: var(--line-prose);
  resize: vertical;
}

.editor-body:focus-visible {
  outline: 2px solid var(--Colors-KMBlue);
  outline-offset: -1px;
}

.editor-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  color: var(--text-tertiary);
  flex-wrap: wrap;
}

.truncated-warn {
  color: var(--status-danger);
}

/* 图谱 / 召回 */
.graph-tab,
.recall-tab {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.modal-lead {
  margin: 0;
  color: var(--text-secondary);
  max-width: var(--measure);
}

.recall-form {
  display: flex;
  gap: var(--space-2);
  max-width: 640px;
}

.hit {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-3) 0;
}

.hit + .hit {
  border-top: 1px solid var(--border-hairline);
}

.hit-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
}

.hit-path {
  padding: 0;
  border: none;
  background: none;
  font-family: var(--font-mono);
  font-size: var(--text-micro-size);
  color: var(--Colors-KMBlue);
  cursor: pointer;
  text-align: left;
}

.hit-path:hover {
  text-decoration: underline;
}

.hit-score {
  font-size: var(--text-c2-size);
  color: var(--text-tertiary);
  flex-shrink: 0;
}

.hit-text {
  margin: 0;
  max-width: var(--measure);
  white-space: pre-wrap;
}

.link-list li {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}

.presets {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-3);
}

.presets button {
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-pill);
  background: none;
  color: var(--text-secondary);
  font-size: var(--text-micro-size);
  cursor: pointer;
}

.presets button:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
</style>
