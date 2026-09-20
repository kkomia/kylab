<script setup lang="ts">
/**
 * 技能市场（v0.27，调研见 `docs/调研/技能仓库与技能市场调研-v0.1.md`）。
 *
 * 一件被调研钉死的事：**没有统一的技能市场协议**（`SKILL.md` 是事实标准，
 * 但分发各家一台自己的插件市场）。所以这里的"市场"不是某个站点，
 * 而是**一组 GitHub 仓库**——浏览 = 递归找仓库里所有 SKILL.md
 * （写在子目录里也算，各家的目录约定都不一样），
 * 装 = 按 commit SHA 把那个技能目录整个取下来。好处是任意合规仓库都能用，
 * 用户粘一个 `owner/repo` 就行。
 *
 * 五处刻意的设计：
 *
 * 1. **弹窗，不是新页面**。逛市场是"找一样东西然后回来"，离开当前页会让
 *    "我刚才是从哪儿来的"变成一个新问题（侧栏也没为它留位置）。
 * 2. **两级：清单 → 详情**，在同一个弹窗里切换。清单回答"这个源里有什么"，
 *    详情回答"我到底要装什么"——后者是调研 §4.6 的硬要求：
 *    skill 目录里的 `scripts/` 是**会被执行的代码**，装之前必须摊开给人看。
 * 3. **装之前一定先看清单**：`scripts/`、hooks 这类文件在这里被标成「代码」并
 *    单独提示，而按钮上写的是这个版本（短 SHA）——分支会在两步之间变，
 *    用户确认的是他看到的这一版。
 * 4. **源是一等公民**：内置 12 个（默认开 5 个）+ 用户自己粘的仓库，
 *    都能启停、删得掉（内置的只能停用）。一屏二十个源对"我想找个技能"没有帮助。
 * 5. **报错要给出下一步**：GitHub 的匿名配额是 60 次/小时，撞上了要说
 *    "等一会儿或配 KYLAB_GITHUB_TOKEN"，而不是把 HTTP 403 甩给用户。
 */
import { computed, ref, watch } from 'vue'

import type { MarketSkill, SkillBundle, SkillSource } from '@/api/capabilities'
import {
  addSkillSource,
  browseSkillSource,
  deleteSkillSource,
  inspectMarketSkill,
  installMarketSkill,
  listSkillSources,
  setSkillSourceEnabled,
  uploadSkill,
} from '@/api/capabilities'
import IconAlert from '@/components/icons/IconAlert.vue'
import IconArchive from '@/components/icons/IconArchive.vue'
import IconCheck from '@/components/icons/IconCheck.vue'
import IconFolder from '@/components/icons/IconFolder.vue'
import IconChevronLeft from '@/components/icons/IconChevronLeft.vue'
import IconPlus from '@/components/icons/IconPlus.vue'
import IconRefresh from '@/components/icons/IconRefresh.vue'
import IconRobot from '@/components/icons/IconRobot.vue'
import IconSearch from '@/components/icons/IconSearch.vue'
import IconTrash from '@/components/icons/IconTrash.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppModal from '@/components/ui/AppModal.vue'
import AppSelect from '@/components/ui/AppSelect.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import SkeletonBlock from '@/components/ui/SkeletonBlock.vue'
import StatusTag from '@/components/ui/StatusTag.vue'
import { useToast } from '@/composables/useToast'

const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ installed: [name: string] }>()

const { notifySuccess } = useToast()

type View = 'list' | 'detail' | 'sources'
const view = ref<View>('list')

const sources = ref<SkillSource[]>([])
const sourcesLoading = ref(false)
const sourceId = ref('')
const skills = ref<MarketSkill[]>([])
const cached = ref(true)
const loading = ref(false)
const refreshing = ref(false)
/** 出错时就地显示（不是一闪而过的 toast）：这里的错误大多带"下一步怎么做"。 */
const error = ref('')
const query = ref('')

const bundle = ref<SkillBundle | null>(null)
const inspecting = ref('')
const installing = ref(false)

/** 新源输入框：空串 = 收着。 */
const newRepo = ref('')
const addingSource = ref(false)

/**
 * 本地上传（v0.28）：选文件夹或选压缩包。
 *
 * 两个 `<input type="file">` 藏在按钮后面——`webkitdirectory` 那个是**选目录**的
 * 唯一办法（浏览器不给别的入口），而它只有 Chromium 系支持；Firefox 的用户走压缩包。
 */
const folderInput = ref<HTMLInputElement | null>(null)
const zipInput = ref<HTMLInputElement | null>(null)
const uploading = ref(false)

const enabledSources = computed(() => sources.value.filter((item) => item.enabled))
const currentSource = computed(
  () => sources.value.find((item) => item.id === sourceId.value) ?? null,
)
const sourceOptions = computed(() =>
  enabledSources.value.map((item) => ({ value: item.id, label: `${item.name} · ${item.repo}` })),
)
const visibleSkills = computed(() => {
  const word = query.value.trim().toLowerCase()
  if (!word) return skills.value
  return skills.value.filter((item) =>
    `${item.name} ${item.description}`.toLowerCase().includes(word),
  )
})
const installedCount = computed(() => skills.value.filter((item) => item.installed).length)

/** 列表与详情上显示哪一句：**中文优先**（英文描述对中文用户等于没有）。 */
function blurb(item: { description: string; summary?: string }): string {
  return item.summary?.trim() || item.description
}

// `immediate` 是为了"挂载时就已经是打开状态"那一种用法（外面用 `v-if` 包着它，
// 或者像测试里那样直接给 `open: true`）——没有它，那种情况下永远不加载。
watch(
  open,
  (isOpen) => {
    if (!isOpen) return
    view.value = 'list'
    query.value = ''
    bundle.value = null
    error.value = ''
    if (!sources.value.length) void loadSources()
    else if (!skills.value.length && sourceId.value) void loadSkills(false)
  },
  { immediate: true },
)

async function loadSources(): Promise<void> {
  sourcesLoading.value = true
  error.value = ''
  try {
    sources.value = (await listSkillSources()).items
    if (!sources.value.some((item) => item.id === sourceId.value && item.enabled)) {
      sourceId.value = enabledSources.value[0]?.id ?? ''
    }
    if (sourceId.value) await loadSkills(false)
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : '源列表读取失败'
  } finally {
    sourcesLoading.value = false
  }
}

async function loadSkills(refresh: boolean): Promise<void> {
  if (!sourceId.value) return
  if (refresh) refreshing.value = true
  else loading.value = true
  error.value = ''
  try {
    const result = await browseSkillSource(sourceId.value, refresh)
    skills.value = result.items
    cached.value = result.cached
  } catch (failure) {
    skills.value = []
    error.value = failure instanceof Error ? failure.message : '浏览失败'
  } finally {
    loading.value = false
    refreshing.value = false
  }
}

function pickSource(value: string): void {
  sourceId.value = value
  query.value = ''
  void loadSkills(false)
}

async function addSource(): Promise<void> {
  const text = newRepo.value.trim()
  if (!text || addingSource.value) return
  addingSource.value = true
  error.value = ''
  try {
    const source = await addSkillSource(text)
    sources.value = (await listSkillSources()).items
    newRepo.value = ''
    pickSource(source.id)
    notifySuccess(`已添加源「${source.repo}」`)
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : '添加失败'
  } finally {
    addingSource.value = false
  }
}

async function toggleSource(source: SkillSource): Promise<void> {
  error.value = ''
  try {
    // 停用的正好是当前这个：换到还开着的第一个，免得停在一个"已经不在下拉里"的源上。
    // 判断要用**改之前**的值（`source` 是改动前那份列表里的对象）。
    const wasCurrentAndOn = source.id === sourceId.value && source.enabled
    await setSkillSourceEnabled(source.id, !source.enabled)
    sources.value = (await listSkillSources()).items
    if (wasCurrentAndOn) pickSource(enabledSources.value[0]?.id ?? '')
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : '操作失败'
  }
}

async function removeSource(source: SkillSource): Promise<void> {
  error.value = ''
  try {
    await deleteSkillSource(source.id)
    sources.value = (await listSkillSources()).items
    if (source.id === sourceId.value) pickSource(enabledSources.value[0]?.id ?? '')
    notifySuccess('已删除这个源')
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : '删除失败'
  }
}

async function openDetail(skill: MarketSkill): Promise<void> {
  inspecting.value = skill.path
  bundle.value = null
  error.value = ''
  view.value = 'detail'
  try {
    bundle.value = await inspectMarketSkill(skill.source_id, skill.path)
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : '读取文件清单失败'
  } finally {
    inspecting.value = ''
  }
}

async function install(): Promise<void> {
  const target = bundle.value
  if (!target || installing.value) return
  installing.value = true
  error.value = ''
  try {
    const record = await installMarketSkill(target.source_id, target.path)
    skills.value = skills.value.map((item) =>
      item.path === target.path ? { ...item, installed: true } : item,
    )
    notifySuccess(`已安装「${record.name}」`)
    emit('installed', record.name)
    view.value = 'list'
    bundle.value = null
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : '安装失败'
  } finally {
    installing.value = false
  }
}

/**
 * 选文件夹：浏览器把**每个文件**连同它的相对路径（`webkitRelativePath`）一起给出来。
 *
 * 相对路径要一起上行：技能的目录结构（`scripts/`、`references/`）是它的一部分，
 * 只传文件名会把它们全平铺到根下。
 */
async function onFolderPicked(event: Event): Promise<void> {
  const picked = (event.target as HTMLInputElement).files
  if (!picked?.length) return
  const files = Array.from(picked)
  await runUpload(
    files,
    files.map(
      (file) => (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
    ),
  )
  if (folderInput.value) folderInput.value.value = ''
}

async function onZipPicked(event: Event): Promise<void> {
  const picked = (event.target as HTMLInputElement).files
  if (!picked?.length) return
  await runUpload(Array.from(picked), [])
  if (zipInput.value) zipInput.value.value = ''
}

async function runUpload(files: File[], paths: string[]): Promise<void> {
  if (uploading.value) return
  uploading.value = true
  error.value = ''
  try {
    const record = await uploadSkill(files, paths)
    notifySuccess(`已添加「${record.name}」`)
    emit('installed', record.name)
    // 装完就关上：用户的目的是"把它加进来"，加完该看到的是能力页上那一张卡片
    open.value = false
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : '上传失败'
  } finally {
    uploading.value = false
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const KIND_LABELS: Record<string, string> = { code: '代码', doc: '文本', asset: '资源' }
</script>

<template>
  <AppModal v-model:open="open" title="添加技能" size="wide" height="full">
    <!-- 顶部一行：选源（左）+ 动作（右）。**与技能页那条工具行同一条起始线**，
         这样"从哪儿挑/挑什么"与"要不要刷新"各自有固定的位置。 -->
    <div class="market-bar">
      <span v-if="sourceOptions.length" class="source-pick">
        <AppSelect
          :model-value="sourceId"
          :options="sourceOptions"
          aria-label="技能源"
          @update:model-value="pickSource"
        />
      </span>
      <span v-else class="market-hint">还没有启用的源——先添加一个仓库，或到「管理源」里打开。</span>
      <div class="market-actions">
        <AppButton size="sm" @click="view = view === 'sources' ? 'list' : 'sources'">
          {{ view === 'sources' ? '返回清单' : `管理源 ${sources.length}` }}
        </AppButton>
        <AppButton
          v-if="view !== 'sources' && sourceId"
          size="sm"
          :disabled="refreshing"
          @click="loadSkills(true)"
        >
          <template #icon><IconRefresh :size="14" /></template>
          {{ refreshing ? '刷新中…' : '刷新' }}
        </AppButton>
      </div>
    </div>

    <p v-if="currentSource && view !== 'sources'" class="source-note">
      {{ currentSource.why || currentSource.repo }}
      <span v-if="!cached" class="source-cache">· 刚从 GitHub 拉的最新清单</span>
      <span v-else class="source-cache">· 用的是缓存（几小时内不会重复请求 GitHub）</span>
    </p>

    <!-- 错误**就地显示**：这里的错误大多带下一步（配 token、换个源、稍后再试） -->
    <p v-if="error" class="market-error" role="alert">
      <IconAlert :size="14" />
      {{ error }}
    </p>

    <!-- ---------------------------------------------------------- 管理源 -->
    <template v-if="view === 'sources'">
      <!-- 从本地添加（v0.28）：文件夹或压缩包。
           **放在"管理源"这一屏**：它们回答的是同一个问题——"技能从哪儿来"。
           压缩包那条路也给 Firefox 用户留着（`webkitdirectory` 只有 Chromium 系支持）。 -->
      <div class="local-add">
        <span class="local-title">从本机添加</span>
        <div class="local-actions">
          <AppButton size="sm" :disabled="uploading" @click="folderInput?.click()">
            <template #icon><IconFolder :size="14" /></template>
            {{ uploading ? '添加中…' : '选文件夹' }}
          </AppButton>
          <AppButton size="sm" :disabled="uploading" @click="zipInput?.click()">
            <template #icon><IconArchive :size="14" /></template>
            选压缩包
          </AppButton>
        </div>
        <input
          ref="folderInput"
          class="local-input"
          type="file"
          webkitdirectory
          multiple
          aria-label="选择技能文件夹"
          @change="onFolderPicked"
        />
        <input
          ref="zipInput"
          class="local-input"
          type="file"
          accept=".zip,application/zip"
          aria-label="选择技能压缩包"
          @change="onZipPicked"
        />
      </div>
      <p class="add-hint">
        文件夹或 .zip 都行：里面要有一个带 name 的 SKILL.md（
        <code>my-skill/SKILL.md</code> 这种一层目录就好）。
      </p>

      <div class="add-source">
        <AppInput
          v-model="newRepo"
          placeholder="owner/repo，或 GitHub 上那个仓库（含子目录）的链接"
          aria-label="添加技能源"
          @keyup.enter="addSource"
        />
        <AppButton variant="primary" :disabled="!newRepo.trim() || addingSource" @click="addSource">
          <template #icon><IconPlus :size="14" /></template>
          添加
        </AppButton>
      </div>
      <p class="add-hint">任意公开仓库都行——我们扫的是仓库里的 SKILL.md，所以不必等谁去做适配。</p>

      <SkeletonBlock v-if="sourcesLoading" variant="list" :rows="4" />
      <ul v-else class="source-list">
        <li v-for="item in sources" :key="item.id" class="source-row">
          <div class="source-main">
            <span class="source-name">{{ item.name }}</span>
            <code class="source-repo">{{ item.repo }}</code>
            <span v-if="item.builtin" class="chip">内置</span>
            <span v-if="item.subpath" class="chip">子目录 {{ item.subpath }}</span>
          </div>
          <div class="source-actions">
            <button type="button" class="chip chip-button" @click="toggleSource(item)">
              {{ item.enabled ? '已启用' : '已停用' }}
            </button>
            <button
              v-if="!item.builtin"
              type="button"
              class="icon-button"
              :aria-label="`删除源 ${item.name}`"
              @click="removeSource(item)"
            >
              <IconTrash :size="14" />
            </button>
          </div>
        </li>
      </ul>
    </template>

    <!-- ------------------------------------------------------------ 清单 -->
    <template v-else-if="view === 'list'">
      <label class="panel-search">
        <IconSearch :size="15" />
        <input
          v-model="query"
          type="search"
          placeholder="在这个源里搜索技能"
          aria-label="搜索技能"
        />
      </label>

      <!-- 骨架屏要盖住"还没读完"这一段：**读之前不能先说"这个源里没有技能"**——
           那是一句会自己消失的错话（实测：首帧就是这么闪一下的） -->
      <SkeletonBlock v-if="sourcesLoading || loading" variant="list" :rows="4" />
      <EmptyState
        v-else-if="!visibleSkills.length"
        :title="skills.length ? '没有匹配的技能' : '这个源里没有技能'"
        :hint="
          skills.length
            ? '换个关键词再找找。'
            : '它可能不是一个技能仓库，或者技能放在了别处——换个源试试。'
        "
      />
      <template v-else>
        <p class="list-count">
          共 {{ skills.length }} 个技能<span v-if="installedCount"
            >，已装 {{ installedCount }} 个</span
          >
        </p>
        <ul class="market-list">
          <li v-for="skill in visibleSkills" :key="skill.path">
            <button type="button" class="market-item" @click="openDetail(skill)">
              <span class="item-icon"><IconRobot :size="16" /></span>
              <span class="item-body">
                <span class="item-head">
                  <span class="item-name">{{ skill.name }}</span>
                  <StatusTag v-if="skill.installed" label="已安装" tone="success" />
                </span>
                <span class="item-desc">{{ blurb(skill) || '（这个技能没写说明）' }}</span>
                <code class="item-path">{{ skill.path }}</code>
              </span>
            </button>
          </li>
        </ul>
      </template>
    </template>

    <!-- ------------------------------------------------------------ 详情 -->
    <template v-else>
      <button type="button" class="back" @click="((view = 'list'), (bundle = null))">
        <IconChevronLeft :size="14" />
        返回清单
      </button>

      <SkeletonBlock v-if="inspecting" variant="list" :rows="5" />
      <template v-else-if="bundle">
        <h3 class="detail-name">{{ bundle.name }}</h3>
        <p v-if="blurb(bundle)" class="detail-desc">{{ blurb(bundle) }}</p>
        <!-- 原文照旧给出来（不折叠成提示）：它可能比中文更精确，
             而"这句是谁写的"是用户判断可信度时要看的 -->
        <p v-if="bundle.summary && bundle.description" class="detail-origin">
          {{ bundle.description }}
        </p>
        <p class="detail-meta">
          <code>{{ bundle.repo }}</code>
          <span>·</span>
          <code>{{ bundle.sha.slice(0, 7) }}</code>
          <span v-if="bundle.license">· {{ bundle.license }}</span>
          <span>· {{ formatSize(bundle.total_bytes) }}</span>
        </p>

        <!-- 代码文件**单独提示**：技能目录里的脚本是会被 agent 执行的代码，
             这是用户在装之前唯一能判断"我在装什么"的地方（调研 §4.6） -->
        <p v-if="bundle.code_count" class="code-warn">
          <IconAlert :size="14" />
          里面有 {{ bundle.code_count }} 个脚本文件（下面标着「代码」的那些）——
          技能用到它们时会在你的机器上执行。装之前不妨先看一眼。
        </p>
        <p v-if="bundle.truncated" class="code-warn">
          <IconAlert :size="14" />
          这个仓库太大，GitHub 只给了部分文件树——下面这份清单**可能不全**。
        </p>

        <ul class="file-list">
          <li v-for="file in bundle.files" :key="file.path">
            <span class="file-kind" :class="`kind-${file.kind}`">{{
              KIND_LABELS[file.kind] ?? file.kind
            }}</span>
            <code class="file-path">{{ file.path }}</code>
            <span class="file-size">{{ formatSize(file.size) }}</span>
          </li>
        </ul>

        <p class="detail-foot">
          装的是 <code>{{ bundle.sha.slice(0, 7) }}</code> 这一版。
          <span v-if="bundle.files.some((item) => item.kind === 'code')">
            落盘后它只是文件，不会自己跑起来——用不用、怎么用由对话里的工具策略决定。
          </span>
        </p>
      </template>
    </template>

    <!-- 底部动作**必须挂在这一层**（AppModal 的直接子节点）：放进上面任何一个
         v-if 分支里，Vue 就不会把它当成具名插槽，那一栏会静默消失 -->
    <template #footer>
      <AppButton v-if="view !== 'detail'" @click="open = false">关闭</AppButton>
      <template v-else>
        <AppButton @click="((view = 'list'), (bundle = null))">返回</AppButton>
        <AppButton variant="primary" :disabled="!bundle || installing" @click="install">
          <template #icon><IconCheck :size="14" /></template>
          {{ installing ? '安装中…' : '安装' }}
        </AppButton>
      </template>
    </template>
  </AppModal>
</template>

<style scoped>
/* 顶部一行：选源（左）+ 动作（右）。与技能页那条工具行同一条起始线 */
.market-bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}

.market-bar :deep(button) {
  flex: 1;
  min-width: 0;
}

.market-actions {
  display: flex;
  flex: 0 0 auto;
  gap: var(--space-1-5);
}

.market-hint {
  flex: 1;
  color: var(--text-tertiary);
  font-size: var(--text-meta-size);
}

/* 当前源的一句说明 + 这份清单是不是缓存 */
.source-note {
  margin: 0 0 var(--space-3);
  color: var(--text-tertiary);
  font-size: var(--text-meta-size);
}

.source-cache {
  color: var(--text-tertiary);
}

.market-error {
  display: flex;
  align-items: flex-start;
  gap: var(--space-1-5);
  margin: 0 0 var(--space-3);
  padding: var(--space-2);
  border-radius: var(--radius-control);
  background: var(--status-danger-soft);
  color: var(--status-danger);
  font-size: var(--text-meta-size);
}

/* --------------------------------------------------------------- 管理源 */

/* 从本机添加：与"加一个源"是不同的动作（一个是本地文件，一个是线上仓库），
   所以各占一段，中间留一档间距 */
.local-add {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin-bottom: var(--space-1-5);
}

.local-title {
  color: var(--text-primary);
  font-size: var(--text-meta-size);
  font-weight: 600;
}

.local-actions {
  display: flex;
  gap: var(--space-1-5);
}

/* 两个选择器藏在按钮后面（浏览器只给 `<input type=file>` 这一个入口） */
.local-input {
  display: none;
}

.add-source {
  display: flex;
  gap: var(--space-2);
  margin-bottom: var(--space-1);
}

.add-hint {
  margin: 0 0 var(--space-3);
  color: var(--text-tertiary);
  font-size: var(--text-micro-size);
}

.source-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.source-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) 0;
  border-bottom: 1px solid var(--border-hairline);
}

.source-main {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1-5);
  min-width: 0;
}

.source-name {
  color: var(--text-primary);
  font-size: var(--text-body-size);
}

.source-repo {
  color: var(--text-tertiary);
  font-size: var(--text-meta-size);
}

.source-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: var(--space-1-5);
}

/* --------------------------------------------------------------- 清单 */
.panel-search {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  margin-bottom: var(--space-3);
  padding: 0 var(--space-2);
  height: var(--hit-target);
  border-radius: var(--radius-control);
  background: var(--bg-group);
  color: var(--text-tertiary);
}

.panel-search input {
  flex: 1;
  min-width: 0;
  border: none;
  background: none;
  color: var(--text-primary);
  font-size: var(--text-meta-size);
  outline: none;
}

.panel-search input::placeholder {
  color: var(--text-tertiary);
}

.panel-search input::-webkit-search-cancel-button {
  display: none;
}

.list-count {
  margin: 0 0 var(--space-2);
  color: var(--text-tertiary);
  font-size: var(--text-micro-size);
}

.market-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

/* 一行一个技能（**不是卡片网格**）：技能描述是整句文本，列表里一行读完最省眼；
   而网格里每张卡都要重复"路径、来源"这些一样的东西 */
.market-item {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-2);
  border: none;
  border-radius: var(--radius-control);
  background: none;
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: var(--transition-ui);
}

.market-item:hover {
  background: var(--bg-group);
}

.item-icon {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  border-radius: var(--radius-control);
  background: var(--bg-group);
  color: var(--text-secondary);
}

.item-body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.item-head {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
}

.item-name {
  color: var(--text-primary);
  font-size: var(--text-body-size);
  font-weight: 600;
}

.item-desc {
  display: -webkit-box;
  overflow: hidden;
  color: var(--text-secondary);
  font-size: var(--text-meta-size);
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.item-path {
  color: var(--text-tertiary);
  font-size: var(--text-micro-size);
}

/* --------------------------------------------------------------- 详情 */
.back {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  margin-bottom: var(--space-2);
  padding: 0;
  border: none;
  background: none;
  color: var(--text-secondary);
  font-size: var(--text-meta-size);
  cursor: pointer;
}

.back:hover {
  color: var(--text-primary);
}

.detail-name {
  margin: 0 0 var(--space-1);
  color: var(--text-primary);
  font-size: var(--text-title-size);
}

.detail-desc {
  margin: 0 0 var(--space-2);
  color: var(--text-secondary);
  font-size: var(--text-meta-size);
}

/* 英文原文：中文简介下面那一行小字。弱一档，但**不藏起来**——
   "这句是谁写的"是用户判断可信度时要看的 */
.detail-origin {
  margin: 0 0 var(--space-2);
  color: var(--text-tertiary);
  font-size: var(--text-micro-size);
}

.detail-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1-5);
  margin: 0 0 var(--space-3);
  color: var(--text-tertiary);
  font-size: var(--text-micro-size);
}

.code-warn {
  display: flex;
  align-items: flex-start;
  gap: var(--space-1-5);
  margin: 0 0 var(--space-2);
  padding: var(--space-2);
  border-radius: var(--radius-control);
  background: var(--status-warning-soft);
  color: var(--status-warning);
  font-size: var(--text-meta-size);
}

.file-list {
  margin: 0 0 var(--space-3);
  padding: 0;
  list-style: none;
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-panel);
}

.file-list li {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1-5) var(--space-2);
  border-bottom: 1px solid var(--border-hairline);
}

.file-list li:last-child {
  border-bottom: none;
}

.file-kind {
  flex: 0 0 auto;
  min-width: 2.5rem;
  padding: 0 var(--space-1);
  border-radius: var(--radius-pill);
  background: var(--bg-group);
  color: var(--text-tertiary);
  font-size: var(--text-micro-size);
  text-align: center;
}

/* 代码那一类要**一眼看得出来**：它是这一屏里唯一需要用户多看一眼的东西 */
.kind-code {
  background: var(--status-warning-soft);
  color: var(--status-warning);
}

.file-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  font-size: var(--text-meta-size);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-size {
  flex: 0 0 auto;
  color: var(--text-tertiary);
  font-size: var(--text-micro-size);
}

.detail-foot {
  margin: 0;
  color: var(--text-tertiary);
  font-size: var(--text-micro-size);
}

/* 图标按钮（删源）：与卡片上那些次要动作同一档 */
.icon-button {
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

.icon-button:hover {
  background: var(--bg-group);
  color: var(--status-danger);
}

/* 「已启用 / 已停用」这类小按钮：复用胶囊的观感，但它是能点的 */
.chip-button {
  border: none;
  cursor: pointer;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 0 var(--space-1-5);
  border-radius: var(--radius-pill);
  background: var(--bg-group);
  color: var(--text-secondary);
  font-size: var(--text-micro-size);
}
</style>
