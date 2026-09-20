<script setup lang="ts">
/**
 * 知识库 Wiki 页：左侧页面树 + 右侧文章。
 *
 * 参考的是现代文档站（GitBook / Notion / Outline）的读法，但只取它**读长文**的那一面：
 * 左边是一棵稳定的目录（读一篇时位置不变），右边是正文 + 出处。不做编辑器、
 * 不做拖拽排序——这里的页面是模型从库内容里整理出来的，用户要的是"读与溯源"。
 *
 * 三个关键取舍：
 * 1. **总览与单页分开拉**。总览只带标题/摘要（左边树要的是轻量数据），
 *    正文按选中页单独取。否则书一厚，"进页面"就要等一本全传完。
 * 2. **选中页写进 URL 查询参数 `page`**，与文档页的 `doc` 同一约定：
 *    刷新、分享、后退都能回到同一页，而不是只记在内存里。
 * 3. **生成是异步任务**：点完「生成 Wiki」拿到 202 就该轮询总览，
 *    直到状态不再 `generating`——否则用户会以为"点了没反应"。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter, type LocationQuery, type LocationQueryRaw } from 'vue-router'

import {
  clearWiki,
  generateWiki,
  getWiki,
  getWikiPage,
  type WikiOverview,
  type WikiPageDetail,
  type WikiPageSummary,
  type WikiSource,
} from '@/api/wiki'
import IconChevronDown from '@/components/icons/IconChevronDown.vue'
import IconChevronRight from '@/components/icons/IconChevronRight.vue'
import IconFile from '@/components/icons/IconFile.vue'
import IconRefresh from '@/components/icons/IconRefresh.vue'
import AppButton from '@/components/ui/AppButton.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import PageShell from '@/components/ui/PageShell.vue'
import SkeletonBlock from '@/components/ui/SkeletonBlock.vue'
import StatusTag, { type StatusTone } from '@/components/ui/StatusTag.vue'
import { formatDate, formatRelativeTime } from '@/composables/useFormat'
import { renderAnswerWithCitations } from '@/composables/useMarkdown'
import { usePolling } from '@/composables/usePolling'
import { useToast } from '@/composables/useToast'
import { useKnowledgeBaseStore } from '@/stores/knowledgeBases'

const POLL_INTERVAL_MS = 3000

/** 整库状态 → 文案与语义色。文字永远在，颜色只是加速识别（与全仓状态口径一致）。 */
const OVERVIEW_STATUS: Record<
  WikiOverview['status'],
  { label: string; tone: StatusTone; running?: boolean }
> = {
  idle: { label: '未生成', tone: 'neutral' },
  generating: { label: '生成中…', tone: 'info', running: true },
  ready: { label: '已生成', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
}

/** 单页状态。整库生成时逐页落库，树/文章里可能出现"整库好了但某页还在生成"。 */
const PAGE_STATUS: Record<
  WikiPageDetail['status'],
  { label: string; tone: StatusTone; running?: boolean }
> = {
  ready: { label: '已生成', tone: 'success' },
  generating: { label: '生成中…', tone: 'info', running: true },
  failed: { label: '生成失败', tone: 'danger' },
}

const route = useRoute()
const router = useRouter()
const store = useKnowledgeBaseStore()
const { notifyError, notifySuccess } = useToast()

/** 库 id 从路径取，与 KnowledgeBaseView 同一口径。 */
const kbId = computed(() => String(route.params.kbId ?? ''))
const knowledgeBase = computed(() => store.byId(kbId.value))
const kbName = computed(() => knowledgeBase.value?.name ?? '知识库')

const overview = ref<WikiOverview | null>(null)
const loading = ref(true)
const error = ref('')

/** 选中的页 id 走 URL 查询参数，刷新/分享/后退都能回到同一页。 */
const selectedPageId = computed(() => String(route.query.page ?? ''))
const detail = ref<WikiPageDetail | null>(null)
const detailLoading = ref(false)
const detailError = ref('')

const generating = ref(false)
const confirmRegenerateOpen = ref(false)
const confirmClearOpen = ref(false)
const clearing = ref(false)

/** 收起/展开的父页 id。默认都展开：刚生成完时用户最想先看全貌。 */
const collapsed = ref<Record<string, boolean>>({})

const hasPages = computed(() => (overview.value?.pages.length ?? 0) > 0)
const statusView = computed(() => OVERVIEW_STATUS[overview.value?.status ?? 'idle'])
const pageStatusView = computed(() =>
  detail.value ? PAGE_STATUS[detail.value.status] : PAGE_STATUS.ready,
)

/** 「生成中…」既包含"刚点完、总览还没翻到 generating"，也包含后端已进入生成态。 */
const busyGenerating = computed(() => generating.value || overview.value?.status === 'generating')
const generateLabel = computed(() => {
  if (busyGenerating.value) return '生成中…'
  return hasPages.value ? '重新生成' : '生成 Wiki'
})

/** 页面详情请求的序号：快速连点两页时，只认最后一次的响应，避免旧响应盖掉新页面。 */
let pageRequest = 0

async function loadOverview(): Promise<void> {
  try {
    overview.value = await getWiki(kbId.value)
    error.value = ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Wiki 加载失败'
  }
}

async function loadPage(pageId: string): Promise<void> {
  if (!pageId) {
    detail.value = null
    detailError.value = ''
    return
  }
  const token = ++pageRequest
  detailLoading.value = true
  detailError.value = ''
  try {
    const data = await getWikiPage(pageId)
    if (token !== pageRequest) return
    detail.value = data
  } catch (cause) {
    if (token !== pageRequest) return
    detail.value = null
    detailError.value = cause instanceof Error ? cause.message : '页面加载失败'
  } finally {
    if (token === pageRequest) detailLoading.value = false
  }
}

watch(selectedPageId, (pageId) => void loadPage(pageId), { immediate: true })

function selectPage(pageId: string): void {
  if (!pageId || pageId === selectedPageId.value) return
  void router.push({ path: route.path, query: { ...route.query, page: pageId } })
}

function withoutPage(query: LocationQuery): LocationQueryRaw {
  const next: LocationQueryRaw = {}
  for (const [key, value] of Object.entries(query)) {
    if (key !== 'page' && value !== null) next[key] = value
  }
  return next
}

/**
 * 有页面但 URL 里没指定看哪一篇时，自动选第一篇。
 *
 * 用 `replace` 而不是 `push`：它是"补一个默认值"，不是用户的一次跳转——
 * 写进历史会让后退键先退到"没有选中页"再退回来，白按两下。
 */
function ensureSelection(): void {
  if (selectedPageId.value) return
  const first = overview.value?.pages[0]
  if (first) void router.replace({ path: route.path, query: { ...route.query, page: first.id } })
}

/** 只在生成中时轮询：落定之后停表，不做无意义的持续请求（同文档列表页）。 */
async function poll(): Promise<void> {
  await loadOverview()
  if (overview.value?.status === 'generating') return
  // 生成刚结束：补一次选中（首次生成时树是从空变出来的），并刷新当前页
  ensureSelection()
  if (selectedPageId.value) await loadPage(selectedPageId.value)
}

/** 生成中才轮询。节奏 / 隐藏暂停 / 防叠加都由 `usePolling` 统一负责（§12.116）。 */
const wikiGenerating = computed(() => overview.value?.status === 'generating')
usePolling(poll, { active: wikiGenerating, intervalMs: POLL_INTERVAL_MS })

async function runGenerate(): Promise<void> {
  if (generating.value) return
  generating.value = true
  try {
    await generateWiki(kbId.value)
    confirmRegenerateOpen.value = false
    notifySuccess('已开始生成 Wiki，页面会陆续出现')
    // 立刻翻一次总览拿到 `generating`：这样状态标签与轮询都是马上对的
    await loadOverview()
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '发起生成失败')
  } finally {
    generating.value = false
  }
}

/** 已有页面时重新生成会覆盖它们，先确认；首次生成没有可失去的，直接开始。 */
function requestGenerate(): void {
  if (hasPages.value) {
    confirmRegenerateOpen.value = true
    return
  }
  void runGenerate()
}

async function confirmClear(): Promise<void> {
  if (clearing.value) return
  clearing.value = true
  try {
    await clearWiki(kbId.value)
    confirmClearOpen.value = false
    detail.value = null
    await loadOverview()
    // 选中页已经不存在了：把 `page` 从地址里摘掉，否则会被拉着去请求一个 404
    if (route.query.page) {
      await router.replace({ path: route.path, query: withoutPage(route.query) })
    }
    notifySuccess('已清除 Wiki 页面')
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '清除失败')
  } finally {
    clearing.value = false
  }
}

/* ------------------------------------------------------------------ 导航树 */

interface NavRow {
  page: WikiPageSummary
  depth: number
  hasChildren: boolean
}

/**
 * 把扁平页面摊成带层级的可见行。
 *
 * 后端给的是 `parent_id` + `level` + `ord` 三件套，这里按 `parent_id` 还原树、
 * 用 `ord` 排序；`level` 只作兜底（父页缺失时按它缩进，至少还看得出层级）。
 * 用摊平的一维数组而不是递归组件：一个页面里的递归渲染要额外的自我引用，
 * 而这里只需要"行 + 缩进"这一种表现。
 */
const navRows = computed<NavRow[]>(() => {
  const pages = overview.value?.pages ?? []
  const children = new Map<string, WikiPageSummary[]>()
  const roots: WikiPageSummary[] = []
  for (const page of pages) {
    if (page.parent_id) {
      const bucket = children.get(page.parent_id) ?? []
      bucket.push(page)
      children.set(page.parent_id, bucket)
    } else {
      roots.push(page)
    }
  }
  const byOrd = (a: WikiPageSummary, b: WikiPageSummary): number =>
    a.ord - b.ord || a.title.localeCompare(b.title, 'zh')
  roots.sort(byOrd)
  for (const bucket of children.values()) bucket.sort(byOrd)

  const rows: NavRow[] = []
  const visited = new Set<string>()
  const walk = (list: WikiPageSummary[], depth: number): void => {
    for (const page of list) {
      // 后端数据一旦出现环（自己指向自己、A→B→A），没有这个守卫就会无限递归
      if (visited.has(page.id)) continue
      visited.add(page.id)
      const kids = children.get(page.id) ?? []
      rows.push({ page, depth, hasChildren: kids.length > 0 })
      if (kids.length > 0 && !collapsed.value[page.id]) walk(kids, depth + 1)
    }
  }
  walk(roots, 0)

  // 父页缺失/指向不存在的页：这些页既不在 roots 也不可达。补在末尾，
  // 否则它们在导航里会彻底消失——数据脏不该表现为"页面丢了"
  for (const page of pages) {
    if (visited.has(page.id)) continue
    visited.add(page.id)
    rows.push({ page, depth: Math.max(0, page.level - 1), hasChildren: false })
  }
  return rows
})

function toggleCollapse(pageId: string): void {
  collapsed.value = { ...collapsed.value, [pageId]: !collapsed.value[pageId] }
}

/** 缩进只用间距阶梯（`--space-3`），不写死像素。 */
function indentStyle(depth: number): Record<string, string> {
  return depth > 0 ? { paddingLeft: `calc(${depth} * var(--space-3))` } : {}
}

/* ------------------------------------------------------------------ 正文与出处 */

/** 页面标题 → 页面 id，用来解析正文里的 `[[标题]]` 双链。 */
const pageIdByTitle = computed(() => {
  const map = new Map<string, string>()
  for (const page of overview.value?.pages ?? []) {
    if (!map.has(page.title)) map.set(page.title, page.id)
  }
  return map
})

/** 代码块/行内代码里不替换——那里的 `[[x]]` 是代码，不是链接（同引用徽标的处理）。 */
const CODE_SPAN = /<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>/g
const WIKILINK = /\[\[([^[\]]+)\]\]/g

/** 把 `&amp;` 这类实体还原回字符，好与页面标题做比较。 */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
}

/**
 * 把 `[[标题]]` 换成可点的站内双链。
 *
 * 只对**解析得到的标题**建链：标题对不上（页面还没生成、写错字）就原样留着，
 * 让人读到 `[[标题]]` 也比给一个点了没反应的死链强——规范的原文留白比假控件好。
 * 渲染器已经把整段文本转义过，捕获到的标题可以直接放进 HTML。
 */
function decorateWikiLinks(html: string, byTitle: Map<string, string>): string {
  if (!html.includes('[[')) return html
  const replaceSegment = (segment: string): string =>
    segment.replace(WIKILINK, (match, rawTitle: string) => {
      const id = byTitle.get(decodeEntities(rawTitle).trim())
      if (!id) return match
      return `<a class="wiki-link" data-wiki-page="${id}" role="button" tabindex="0">${rawTitle}</a>`
    })
  let result = ''
  let cursor = 0
  CODE_SPAN.lastIndex = 0
  for (let match = CODE_SPAN.exec(html); match; match = CODE_SPAN.exec(html)) {
    result += replaceSegment(html.slice(cursor, match.index)) + match[0]
    cursor = match.index + match[0].length
  }
  return result + replaceSegment(html.slice(cursor))
}

const contentHtml = computed(() => {
  const page = detail.value
  if (!page) return ''
  return decorateWikiLinks(
    renderAnswerWithCitations(page.content_md, page.sources),
    pageIdByTitle.value,
  )
})

const sourceCount = computed(() => detail.value?.sources.length ?? 0)

const metaTitle = computed(() => formatDate(detail.value?.generated_at ?? null))
const metaLine = computed(() => {
  const page = detail.value
  if (!page) return ''
  // 模型名后端目前不回（生成用的是全局默认对话模型），此时只说生成时间——
  // 写「生成模型：—」像一处坏掉的数据，还不如不提。
  const when = `生成时间：${formatRelativeTime(page.generated_at)}`
  return page.model ? `生成模型：${page.model} · ${when}` : when
})

/** 出处落点：标题路径 + 页码，可用的那部分才拼。 */
function sourceWhere(source: WikiSource): string {
  const parts: string[] = []
  if (source.heading_path) parts.push(source.heading_path)
  if (source.page != null) parts.push(`第 ${source.page} 页`)
  return parts.join(' · ')
}

const sourcesRef = ref<HTMLElement | null>(null)
/** 正在闪的出处序号（点正文徽标跳过来时给个落点）。 */
const flashIndex = ref<number | null>(null)
let flashTimer: number | undefined

function citeIndexFrom(target: EventTarget | null): number | null {
  const element = target instanceof Element ? target.closest('[data-cite-index]') : null
  const value = Number(element?.getAttribute('data-cite-index'))
  return Number.isInteger(value) ? value : null
}

function wikiPageFrom(target: EventTarget | null): string | null {
  const element = target instanceof Element ? target.closest('[data-wiki-page]') : null
  return element?.getAttribute('data-wiki-page') ?? null
}

async function revealSource(index: number): Promise<void> {
  flashIndex.value = index
  await nextTick()
  sourcesRef.value
    ?.querySelector(`[data-source="${index}"]`)
    ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  window.clearTimeout(flashTimer)
  flashTimer = window.setTimeout(() => {
    if (flashIndex.value === index) flashIndex.value = null
  }, 1400)
}

/**
 * 点正文：双链走站内跳转，`[n]` 徽标滚到出处。
 *
 * 都由文章容器**事件委托**接住，而不是给每个 `<a>` 绑处理器——正文是 v-html
 * 注入的字符串，没有 Vue 的模板绑定可用。键盘与鼠标走同一条判定，
 * 徽标/双链都带 `role="button" tabindex="0"`。
 */
function handleArticleActivate(event: Event): void {
  const wikiId = wikiPageFrom(event.target)
  if (wikiId) {
    event.preventDefault()
    selectPage(wikiId)
    return
  }
  const index = citeIndexFrom(event.target)
  if (index !== null) {
    event.preventDefault()
    void revealSource(index)
  }
}

function onArticleClick(event: MouseEvent): void {
  handleArticleActivate(event)
}

function onArticleKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' && event.key !== ' ') return
  handleArticleActivate(event)
}

/** 点出处里的文件名：回知识库详情页并打开文档抽屉（带页码落到那一页）。 */
function openDocument(source: WikiSource): void {
  const query: LocationQueryRaw = { doc: source.document_id }
  if (source.page != null) query.page = String(source.page)
  void router.push({ path: `/kb/${kbId.value}`, query })
}

/* ------------------------------------------------------------------ 生命周期 */

onMounted(async () => {
  // `store.load()` 带回库名（面包屑用）；直接刷新到本页时 store 还是空的
  if (store.items.length === 0) await store.load()
  await loadOverview()
  ensureSelection()
  loading.value = false
})

onBeforeUnmount(() => {
  window.clearTimeout(flashTimer)
})

watch(kbId, async () => {
  // 同一个组件被复用到另一个库（路由记录相同、只有 params 变）时，
  // 上一库的树/正文必须清掉，否则会短暂显示"B 库的壳里装着 A 库的文章"
  overview.value = null
  detail.value = null
  collapsed.value = {}
  loading.value = true
  if (route.query.page) {
    await router.replace({ path: route.path, query: withoutPage(route.query) })
  }
  await loadOverview()
  ensureSelection()
  loading.value = false
})
</script>

<template>
  <PageShell title="Wiki">
    <template #breadcrumb>
      <RouterLink :to="`/kb/${kbId}`">{{ kbName }}</RouterLink>
      <IconChevronRight :size="13" />
      <span>Wiki</span>
    </template>

    <template #actions>
      <StatusTag
        v-if="overview"
        :label="statusView.label"
        :tone="statusView.tone"
        :running="statusView.running"
      />
      <AppButton
        v-if="overview?.enabled"
        variant="primary"
        :disabled="busyGenerating"
        @click="requestGenerate"
      >
        <template #icon><IconRefresh /></template>
        {{ generateLabel }}
      </AppButton>
    </template>

    <p v-if="error" class="error-line">{{ error }}</p>

    <SkeletonBlock v-if="loading" variant="list" :rows="5" />

    <!-- 库没开 Wiki：给"去哪儿开"的引导，不是一个空树 -->
    <div v-else-if="overview && !overview.enabled" class="wiki-empty">
      <EmptyState
        title="这个知识库还没有开启 Wiki"
        hint="Wiki 是库形态的一种：开启后可以用已录入的内容整理出一套带出处的百科式页面。请到「知识库设置 → Wiki」打开。"
      >
        <AppButton @click="router.push(`/kb/${kbId}`)">回到知识库</AppButton>
      </EmptyState>
    </div>

    <template v-else-if="overview">
      <!-- 失败原因原样给出来：用户才知道是额度、模型还是内容的问题 -->
      <p v-if="overview.status === 'failed' && overview.last_error" class="error-line">
        {{ overview.last_error }}
      </p>

      <!-- 正在生成且还没有页面：给"在动"的画面，而不是一个空状态 -->
      <div v-if="!hasPages && overview.status === 'generating'" class="generating-state">
        <SkeletonBlock variant="list" :rows="4" />
        <p class="generating-hint">
          正在整理库里的内容，页面会陆续出现。页面越多耗时越长，可以先去忙别的。
        </p>
      </div>

      <div v-else-if="!hasPages" class="wiki-empty">
        <EmptyState
          title="还没有 Wiki 页面"
          hint="把库里已录入的内容整理成一套百科式页面，每个要点都带原文出处。"
        >
          <div class="empty-extra">
            <p class="empty-cost">会调用对话模型，页面越多越久。</p>
            <AppButton variant="primary" :disabled="busyGenerating" @click="requestGenerate">
              <template #icon><IconRefresh /></template>
              {{ generateLabel }}
            </AppButton>
          </div>
        </EmptyState>
      </div>

      <div v-else class="wiki-body">
        <aside class="wiki-nav" aria-label="页面目录">
          <div class="nav-head">
            <span class="nav-title">页面 · {{ overview.page_count }}</span>
            <!-- 清除是低频且不可恢复的动作：平时只留一行小字，确认弹窗才说清代价 -->
            <button type="button" class="nav-clear" @click="confirmClearOpen = true">清除</button>
          </div>
          <ul class="nav-list">
            <li v-for="row in navRows" :key="row.page.id">
              <div
                class="nav-row"
                :class="{ 'nav-row-on': row.page.id === selectedPageId }"
                :style="indentStyle(row.depth)"
              >
                <button
                  v-if="row.hasChildren"
                  type="button"
                  class="nav-caret"
                  :aria-expanded="!collapsed[row.page.id]"
                  :aria-label="collapsed[row.page.id] ? '展开子页面' : '收起子页面'"
                  @click="toggleCollapse(row.page.id)"
                >
                  <IconChevronDown v-if="!collapsed[row.page.id]" :size="14" />
                  <IconChevronRight v-else :size="14" />
                </button>
                <span v-else class="nav-caret" aria-hidden="true" />
                <button
                  type="button"
                  class="nav-node"
                  :aria-current="row.page.id === selectedPageId ? 'true' : undefined"
                  :title="row.page.title"
                  @click="selectPage(row.page.id)"
                >
                  <IconFile :size="14" />
                  <span class="nav-label">{{ row.page.title }}</span>
                </button>
              </div>
            </li>
          </ul>
        </aside>

        <section class="wiki-article">
          <SkeletonBlock v-if="detailLoading && !detail" variant="text" :rows="8" />

          <p v-else-if="detailError" class="error-line">{{ detailError }}</p>

          <template v-else-if="detail">
            <header class="article-head">
              <h2 class="article-title">
                {{ detail.title }}
                <StatusTag
                  v-if="detail.status !== 'ready'"
                  :label="pageStatusView.label"
                  :tone="pageStatusView.tone"
                  :running="pageStatusView.running"
                />
              </h2>
              <p v-if="detail.brief" class="article-brief">{{ detail.brief }}</p>
              <p class="article-meta" :title="metaTitle">{{ metaLine }}</p>
            </header>

            <!-- 正文是模型生成的外部 Markdown：renderAnswerWithCitations 会先转义、
                 再只还原自己识别出的标记，`[n]` 也在这里变成可点徽标。 -->
            <!-- eslint-disable vue/no-v-html -->
            <div
              class="article-text"
              @click="onArticleClick"
              @keydown="onArticleKeydown"
              v-html="contentHtml"
            />
            <!-- eslint-enable vue/no-v-html -->

            <section v-if="sourceCount" ref="sourcesRef" class="sources" aria-label="出处">
              <h3 class="sources-title">出处</h3>
              <ol class="sources-list">
                <li
                  v-for="source in detail.sources"
                  :key="source.chunk_id"
                  class="source"
                  :class="{ 'source-flash': flashIndex === source.index }"
                  :data-source="source.index"
                >
                  <span class="source-index tabular">[{{ source.index }}]</span>
                  <button type="button" class="source-doc" @click="openDocument(source)">
                    {{ source.document_name }}
                  </button>
                  <span v-if="sourceWhere(source)" class="source-where">{{
                    sourceWhere(source)
                  }}</span>
                </li>
              </ol>
            </section>
          </template>

          <EmptyState v-else title="从左侧选择一篇页面" hint="文章正文与出处会显示在这里。" />
        </section>
      </div>
    </template>

    <ConfirmDialog
      v-model:open="confirmRegenerateOpen"
      title="重新生成 Wiki"
      :lead="`重新生成会覆盖现有的 ${overview?.page_count ?? 0} 篇页面。`"
      note="已有页面在生成完成前仍然可读；生成过程会调用对话模型，页面越多耗时越长。"
      confirm-label="重新生成"
      :busy="generating"
      busy-label="生成中…"
      @confirm="runGenerate"
    />

    <ConfirmDialog
      v-model:open="confirmClearOpen"
      title="清除 Wiki 页面"
      lead="确定清除这个知识库已生成的 Wiki 页面？"
      note="只删除整理出来的页面，不影响文档、切块与向量；清除后可以重新生成。"
      confirm-label="清除"
      :busy="clearing"
      busy-label="清除中…"
      @confirm="confirmClear"
    />
  </PageShell>
</template>

<style scoped>
.error-line {
  margin: var(--space-4) 0;
  color: var(--status-danger);
}

/* 两栏：左侧页面树 + 右侧文章。与知识库详情页同一手法（贯穿的侧栏，
   只用一条右侧分隔线），让"Wiki 属于这个库"这件事在版式上也能读出来。 */
.wiki-body {
  display: flex;
  align-items: stretch;
  gap: var(--space-5);
}

.wiki-nav {
  flex: 0 0 240px;
  padding: 0 var(--space-4) 0 0;
  border-right: 1px solid var(--border-hairline);
}

.wiki-article {
  flex: 1;
  min-width: 0;
  /* 正文限宽：一行超过 66ch 眼睛会找不到换行点（规范 §4） */
  max-width: var(--measure);
}

.nav-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2);
  margin-bottom: var(--space-1);
}

.nav-title {
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.nav-clear {
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.nav-clear:hover {
  color: var(--status-danger);
}

.nav-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.nav-row {
  display: flex;
  align-items: center;
  gap: var(--space-pair);
  min-height: 30px;
  border-radius: var(--radius-control);
}

.nav-row:hover {
  background: var(--bg-hover);
}

.nav-row-on {
  background: var(--accent-soft);
}

.nav-row-on .nav-node {
  color: var(--accent-text);
}

.nav-caret {
  display: inline-flex;
  flex: 0 0 20px;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 30px;
  color: var(--text-tertiary);
  border-radius: var(--radius-control);
}

button.nav-caret:hover {
  color: var(--text-primary);
}

.nav-node {
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: center;
  gap: var(--space-2);
  height: 30px;
  padding: 0 var(--space-2) 0 0;
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
  text-align: left;
  border-radius: var(--radius-control);
}

.nav-node:hover {
  color: var(--text-primary);
}

.nav-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 窄窗口把树收窄，但不折到上方：折上去它就不再是"贯穿的侧栏"了 */
@media (max-width: 960px) {
  .wiki-nav {
    flex-basis: 180px;
  }
}

/* ---- 文章 ---- */

.article-head {
  margin-bottom: var(--space-5);
  padding-bottom: var(--space-4);
  border-bottom: 1px solid var(--border-hairline);
}

/* 文章标题用 h2 级语义（页面已有 h1「Wiki」），但视觉上要撑得起"这是本篇的名字" */
.article-title {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin: 0;
  font-size: var(--text-page-title-size);
  font-weight: 600;
  letter-spacing: -0.018em;
}

.article-brief {
  margin: var(--space-2) 0 0;
  color: var(--text-secondary);
}

.article-meta {
  margin: var(--space-3) 0 0;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

/* Markdown 由 v-html 注入，作用域属性加不上去，只能 :deep 透进去 */
.article-text :deep(.md-h) {
  margin: var(--space-5) 0 var(--space-2);
  font-size: var(--text-section-size);
  color: var(--text-primary);
}

.article-text :deep(.md-h:first-child) {
  margin-top: 0;
}

.article-text :deep(.md-p) {
  margin: 0;
  white-space: pre-wrap;
}

.article-text :deep(.md-p + .md-p) {
  margin-top: var(--space-3);
}

.article-text :deep(.md-ul),
.article-text :deep(.md-ol) {
  margin: var(--space-2) 0 0;
  padding-left: var(--space-5);
}

.article-text :deep(.md-ul li + li),
.article-text :deep(.md-ol li + li) {
  margin-top: var(--space-1);
}

.article-text :deep(.md-quote) {
  margin: var(--space-3) 0;
  padding: var(--space-2) var(--space-3);
  color: var(--text-secondary);
  border-left: 3px solid var(--border);
}

/* 代码块横向滚动而不是折行：折行会让缩进失真，而代码靠缩进读结构 */
.article-text :deep(.md-pre) {
  margin: var(--space-3) 0;
  padding: var(--space-3);
  overflow-x: auto;
  font-size: var(--text-micro-size);
  line-height: var(--line-code);
  background: var(--bg-subtle);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-control);
}

.article-text :deep(.md-pre code) {
  padding: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: none;
}

.article-text :deep(.md-table-wrap) {
  margin: var(--space-3) 0;
  overflow-x: auto;
}

.article-text :deep(.md-table) {
  border-collapse: collapse;
  font-size: var(--text-meta-size);
}

.article-text :deep(.md-table th),
.article-text :deep(.md-table td) {
  padding: var(--space-2) var(--space-3);
  text-align: left;
  border: 1px solid var(--border-hairline);
}

.article-text :deep(.md-table th) {
  font-weight: 600;
  color: var(--text-primary);
  background: var(--bg-subtle);
}

.article-text :deep(.md-hr) {
  margin: var(--space-5) 0;
  border: 0;
  border-top: 1px solid var(--border);
}

.article-text :deep(.md-link) {
  color: var(--accent-text);
  text-decoration: none;
}

.article-text :deep(.md-link:hover) {
  text-decoration: underline;
}

.article-text :deep(code) {
  padding: 0 var(--space-1);
  font-size: var(--text-meta-size);
  background: var(--bg-subtle);
  border-radius: var(--radius-control);
}

/* 行内引用徽标：与对话页同一形态（可点、可键盘激活），但在文章里它是**主入口**
   ——读者要顺着它去看出处，所以保留名字与悬停可读的完整位置。 */
.article-text :deep(.md-cite) {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  max-width: 8.5em;
  height: 16px;
  margin: 0 2px;
  padding: 0 5px;
  font-size: var(--text-micro-size);
  line-height: 1;
  color: var(--text-tertiary);
  background: var(--bg-subtle);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-control);
  cursor: pointer;
  vertical-align: -2px;
}

.article-text :deep(.md-cite:hover) {
  color: var(--text-secondary);
  background: var(--bg-hover);
  border-color: var(--border);
}

/* 文件名前的小图标：拿 IconFile 的路径做 mask、currentColor 上色，
   与对话页同一个手法（渲染器不该管画什么图，也自动跟主题色） */
.article-text :deep(.md-cite::before) {
  flex: 0 0 auto;
  width: 11px;
  height: 11px;
  content: '';
  background: currentColor;
  -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M21 8v12.993A1 1 0 0 1 20.007 22H3.993A.993.993 0 0 1 3 21.008V2.992C3 2.455 3.449 2 4.002 2h10.995zm-2 1h-5V4H5v16h14zM8 7h3v2H8zm0 4h8v2H8zm0 4h8v2H8z'/%3E%3C/svg%3E");
  mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M21 8v12.993A1 1 0 0 1 20.007 22H3.993A.993.993 0 0 1 3 21.008V2.992C3 2.455 3.449 2 4.002 2h10.995zm-2 1h-5V4H5v16h14zM8 7h3v2H8zm0 4h8v2H8zm0 4h8v2H8z'/%3E%3C/svg%3E");
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
  -webkit-mask-size: contain;
  mask-size: contain;
}

.article-text :deep(.md-cite-name) {
  overflow: hidden;
  min-width: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 站内双链：用强调色 + 下划线区分于普通链接，读者一眼知道"点了会换一页" */
.article-text :deep(.wiki-link) {
  color: var(--accent-text);
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}

.article-text :deep(.wiki-link:hover) {
  background: var(--accent-soft);
}

/* ---- 出处 ---- */

.sources {
  margin-top: var(--space-8);
  padding-top: var(--space-4);
  border-top: 1px solid var(--border-hairline);
}

.sources-title {
  margin: 0 0 var(--space-2);
  font-size: var(--text-section-size);
  font-weight: 600;
  color: var(--text-primary);
}

.sources-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.source {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-control);
}

.source + .source {
  margin-top: var(--space-1);
}

/* 点正文徽标跳过来的那一条闪一下底色，给眼睛一个落点 */
.source-flash {
  background: var(--accent-soft);
}

.source-index {
  flex: 0 0 auto;
  color: var(--text-secondary);
}

/* 文件名是按钮：点了回知识库详情页打开文档抽屉看原文（不是新开页面） */
.source-doc {
  overflow: hidden;
  max-width: 34ch;
  font-weight: 500;
  color: var(--text-primary);
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-doc:hover {
  color: var(--accent-text);
  text-decoration: underline;
}

.source-where {
  overflow: hidden;
  max-width: 48ch;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---- 空状态与生成中 ---- */

/* 整页空状态：水平居中、上方留足空间——这一屏除了它没有别的内容，
   居中的一句话比贴着左边缘更像个"起点"（阅读页里那处空状态不在此列） */
.wiki-empty {
  display: flex;
  justify-content: center;
  padding-top: var(--space-8);
}

.wiki-empty :deep(.empty) {
  align-items: center;
  padding-top: 0;
  text-align: center;
}

.wiki-empty :deep(.empty-hint) {
  text-align: center;
}

.empty-extra {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-3);
}

.empty-cost {
  margin: 0;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.generating-state {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding-top: var(--space-2);
}

.generating-hint {
  margin: 0;
  max-width: var(--measure);
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
}
</style>
