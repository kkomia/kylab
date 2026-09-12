<script setup lang="ts">
/**
 * 文档详情页（《前端设计规范》§6）：面包屑 + 标题 + 状态 + 元信息行 + 切块预览。
 *
 * 预览的是**后端真实的切块文本**（`GET /documents/{id}/chunks`），按等宽排版呈现：
 * 它本来就是给检索用的原料，不是渲染好的文档。让人看见真实产物，
 * 比做一层漂亮的假渲染诚实——用户要判断"这个文件解析得对不对"，就得看到切出来的东西。
 *
 * 原文下载走签名 URL（架构 §6.5、开发计划 T4.5）：链接由后端签发、带过期时间，
 * 所以页面上不出现任何永久直链——两个下载按钮每次都现取一条新链接。
 */
import { computed, onMounted, ref } from 'vue'

import { useRoute } from 'vue-router'

import {
  RENDERABLE_KINDS,
  deleteChunk,
  downloadDocument,
  getDocument,
  getDocumentPreview,
  listDocumentChunks,
  setChunkDisabled,
  updateChunk,
  type DocumentPreview,
  type DownloadFormat,
  type DocumentChunk,
  type DocumentSummary,
} from '@/api/documents'
import OfficePreview from '@/components/knowledge/OfficePreview.vue'
import IconChevronRight from '@/components/icons/IconChevronRight.vue'
import AppButton from '@/components/ui/AppButton.vue'
import PageShell from '@/components/ui/PageShell.vue'
import RowMenu from '@/components/ui/RowMenu.vue'
import SkeletonBlock from '@/components/ui/SkeletonBlock.vue'
import StatusTag from '@/components/ui/StatusTag.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import { documentStageView } from '@/components/ui/status'
import { cleanInlineLatex } from '@/composables/useLatex'
import { renderAnswerMarkdown } from '@/composables/useMarkdown'
import { formatBytes, formatDate } from '@/composables/useFormat'
import { useToast } from '@/composables/useToast'

/** 预览最多拉几块：再多就该去库内检索面板，而不是在这一页翻。 */
const PREVIEW_LIMIT = 5

/**
 * 两个视角。默认「阅读」——
 * 用户打开一份文档，第一动作是"看它是什么"，而不是"看它被切成了几块"。
 */
const VIEW_TABS = [
  { key: 'read' as const, label: '阅读', hint: '原文渲染，日常看这个' },
  { key: 'chunks' as const, label: '切块', hint: '解析产物，等宽带块号，调解析用' },
]

/** 「阅读」里的两个来源：原件版式 / 解析文本。 */
const SOURCE_TABS = [
  { key: 'original' as const, label: '原文版式' },
  { key: 'parsed' as const, label: '解析文本' },
]

const route = useRoute()
const { notifyError, notifySuccess } = useToast()

const documentId = computed(() => String(route.params.documentId ?? ''))
const document = ref<DocumentSummary | null>(null)
const chunks = ref<DocumentChunk[]>([])
const chunkTotal = ref(0)
const previewError = ref('')
const loading = ref(true)
const error = ref('')
const downloading = ref<DownloadFormat | null>(null)
const view = ref<'read' | 'chunks'>('read')
const preview = ref<DocumentPreview | null>(null)
const previewLoading = ref(false)

const activeTabHint = computed(() => VIEW_TABS.find((tab) => tab.key === view.value)?.hint ?? '')

/**
 * 下载原文或解析产物。
 *
 * 两个按钮而不是一个下拉：这是**两个不同的东西**（原文件 vs 我们加工的 Markdown），
 * 而用户在这一页想知道的主要就是"解析成了什么"——把它藏进二级菜单等于藏起了答案。
 *
 * 成功**不弹提示**：浏览器自己会显示下载进度与完成，再弹一条只是噪音。
 * 失败必须说清原因——链接要经鉴权签发，最常见的是没配签名密钥或会话过期，
 * 静默失败会让用户以为按钮坏了。
 *
 * ``downloading`` 挡的是"取链接"那段空档：按钮已经响应了点击，但真正开始下载
 * 要等接口回来，这期间再点会重复签发（并多弹一次错误）。
 */
async function download(format: DownloadFormat): Promise<void> {
  if (downloading.value) return
  downloading.value = format
  try {
    await downloadDocument(documentId.value, format)
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '下载失败')
  } finally {
    downloading.value = null
  }
}

onMounted(async () => {
  try {
    document.value = await getDocument(documentId.value)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '文档加载失败'
  } finally {
    loading.value = false
  }
  // 能看原件就先看原件：用户打开一份 PDF/Office，想看的首先是那个文件本身。
  // 解析文本是"核对解析得对不对"的第二视角，摆在切换里。
  // 没有原件版式可渲染时才回落到解析文本（纯文本类文件就是这种）。
  previewSource.value = canRenderOriginal.value ? 'original' : 'parsed'
  await Promise.all([loadPreview(), loadReadingView()])
})

/** 切块预览是补充信息：拿不到不影响状态与元信息。 */
async function loadPreview(): Promise<void> {
  try {
    const body = await listDocumentChunks(documentId.value, PREVIEW_LIMIT)
    chunks.value = body.items
    chunkTotal.value = body.total
  } catch (cause) {
    previewError.value = cause instanceof Error ? cause.message : '切块预览加载失败'
  }
}

/**
 * 阅读视角的内容来源。
 *
 * 默认**看原件版式**：用户打开一份 PDF/Office，想看的首先是那个文件本身。
 * 「解析文本」是给"核对解析得对不对"用的第二视角——只在既有解析产物、
 * 原件又能渲染时才给这个切换（否则切过去是空的，等于给个假入口）。
 */
const previewSource = ref<'original' | 'parsed'>('parsed')
/** 两个来源各自缓存：来回切不该反复取（PDF 每次都会重新签发链接）。 */
const previewCache = ref<Record<'original' | 'parsed', DocumentPreview | null>>({
  original: null,
  parsed: null,
})

const canRenderOriginal = computed(
  () => !!document.value && RENDERABLE_KINDS.includes(document.value.original_kind),
)

/**
 * 原件能渲染 + 有解析产物 → 两个视角都成立，才给切换。
 *
 * 用 ``chunk_count > 0`` 判断"有没有解析产物"：切块是摄入的产物，
 * 没有块就说明还没解析成功（或解析失败），此时"解析文本"那一侧是空的。
 */
const canSwitchSource = computed(
  () => canRenderOriginal.value && (document.value?.chunk_count ?? 0) > 0,
)

/** 阅读视角。失败**不写进 previewError**——那是切块视角的报错位，
    两个视角的失败原因不同，混在一起会让用户看到"切块加载失败"却在看阅读页。 */
async function loadReadingView(): Promise<void> {
  const source = previewSource.value
  const cached = previewCache.value[source]
  if (cached) {
    preview.value = cached
    return
  }
  previewLoading.value = true
  try {
    const body = await getDocumentPreview(
      documentId.value,
      source === 'original' ? 'original' : 'auto',
    )
    previewCache.value[source] = body
    preview.value = body
  } catch {
    preview.value = null
  } finally {
    previewLoading.value = false
  }
}

function showSource(source: 'original' | 'parsed'): void {
  if (previewSource.value === source) return
  previewSource.value = source
  void loadReadingView()
}

/**
 * PDF 预览的跳页锚点。
 *
 * 用浏览器原生 PDF 查看器的 PDF Open Parameters（`#page=N`）——
 * 零依赖，就能从引用直接落到那一页。`#` 之后是片段，不会发给服务端。
 */
const pdfFrameUrl = computed(() => {
  const base = preview.value?.url ?? ''
  const page = Number(route.query.page ?? 0)
  return base && page > 0 ? `${base}#page=${page}` : base
})

// ------------------------------------------------------------------ 切块干预（G3）

/** 正在编辑的块 id（空 = 没有在编辑）。 */
const editing = ref('')
const draft = ref('')
const savingChunk = ref(false)

function cancelEdit(): void {
  editing.value = ''
  draft.value = ''
}

/**
 * 保存正文改动。
 *
 * 后端会**重新向量化**这一块，所以这里不能乐观更新——必须用返回的记录
 * 替换本地那条，否则界面显示的文本与检索依据的向量可能不一致。
 */
async function saveChunk(chunk: DocumentChunk): Promise<void> {
  const text = draft.value.trim()
  if (!text || savingChunk.value) return
  savingChunk.value = true
  try {
    const updated = await updateChunk(documentId.value, chunk.ordinal, text)
    replaceChunk(updated)
    cancelEdit()
    notifySuccess('切块已更新，检索会按新内容生效')
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '保存失败')
  } finally {
    savingChunk.value = false
  }
}

/** 禁用 / 恢复。改动只影响检索，所以就地更新标记即可。 */
async function toggleChunk(chunk: DocumentChunk): Promise<void> {
  try {
    const updated = await setChunkDisabled(documentId.value, chunk.ordinal, !chunk.disabled)
    replaceChunk(updated)
    notifySuccess(updated.disabled ? '已禁用，该块不再参与检索' : '已恢复参与检索')
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '操作失败')
  }
}

/**
 * 删除一个块。
 *
 * **要二次确认**：这是破坏性动作，而且用户很可能只是想"禁用"——
 * 确认弹窗的后果说明里把这一点写清楚，比让人在原生 confirm 里读到强。
 */
const chunkDeleteTarget = ref<DocumentChunk | null>(null)
const chunkDeleting = ref(false)
const chunkDeleteOpen = computed({
  get: () => chunkDeleteTarget.value !== null,
  set: (value: boolean) => {
    if (!value) chunkDeleteTarget.value = null
  },
})

function requestRemoveChunk(chunk: DocumentChunk): void {
  chunkDeleteTarget.value = chunk
}

async function confirmRemoveChunk(): Promise<void> {
  const chunk = chunkDeleteTarget.value
  if (!chunk || chunkDeleting.value) return
  chunkDeleting.value = true
  try {
    await deleteChunk(documentId.value, chunk.ordinal)
    chunkDeleteTarget.value = null
    // 服务端删完会重排序号，所以整段重拉，不能只从本地列表里摘掉那一条
    await loadPreview()
    if (document.value) {
      document.value = { ...document.value, chunk_count: chunkTotal.value }
    }
    notifySuccess('切块已删除')
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '删除失败')
  } finally {
    chunkDeleting.value = false
  }
}

function replaceChunk(updated: DocumentChunk): void {
  chunks.value = chunks.value.map((item) => (item.chunk_id === updated.chunk_id ? updated : item))
}

/** "这是前 5 块，共 137 块"——不说清的话，用户会把预览当成全文。 */
const previewNote = computed(() =>
  chunkTotal.value > chunks.value.length
    ? `该文档共 ${chunkTotal.value} 块，这里只显示前 ${chunks.value.length} 块。`
    : `该文档共 ${chunkTotal.value} 块，已全部显示。`,
)

/**
 * 阅读视角的正文。
 *
 * 先清 LaTeX 再交给 Markdown 渲染器：云端解析器把 PDF 里的上标原样输出成
 * `$^{[1]}$`，实测真实的医学语料里 **26% 的 chunk 含行内 LaTeX**。
 * **顺序不能反**——清理要去掉排版花括号，先过 Markdown 渲染会让 `**` 之类的规则
 * 先把公式内部动一遍。
 */
const readerHtml = computed(() => renderAnswerMarkdown(cleanInlineLatex(preview.value?.text ?? '')))

const stage = computed(() =>
  document.value
    ? documentStageView(document.value.stage)
    : { label: '', tone: 'neutral' as const },
)
</script>

<template>
  <PageShell :title="document?.name ?? '文档详情'" narrow>
    <template #breadcrumb>
      <RouterLink
        class="breadcrumb-link"
        :to="document ? `/kb/${document.knowledge_base_id}` : '/'"
      >
        {{ document ? '文档列表' : '知识库' }}
      </RouterLink>
      <IconChevronRight class="breadcrumb-sep" :size="14" />
      <span class="breadcrumb-current">{{ document?.name ?? '文档详情' }}</span>
    </template>

    <template #actions>
      <AppButton v-if="document" :disabled="downloading !== null" @click="download('original')">
        {{ downloading === 'original' ? '准备中…' : '下载原文件' }}
      </AppButton>
      <AppButton
        v-if="document && document.chunk_count > 0"
        :disabled="downloading !== null"
        @click="download('markdown')"
      >
        {{ downloading === 'markdown' ? '准备中…' : '下载 Markdown' }}
      </AppButton>
      <RouterLink v-if="document" :to="`/kb/${document.knowledge_base_id}`">
        <AppButton>回列表重跑</AppButton>
      </RouterLink>
    </template>

    <p v-if="error" class="error-line">{{ error }}</p>
    <SkeletonBlock v-if="loading" variant="text" :rows="5" />

    <template v-else-if="document">
      <dl class="meta">
        <div class="meta-item">
          <dt>状态</dt>
          <dd>
            <StatusTag :label="stage.label" :tone="stage.tone" />
          </dd>
        </div>
        <div class="meta-item">
          <dt>大小</dt>
          <dd>{{ formatBytes(document.size_bytes) }}</dd>
        </div>
        <div class="meta-item">
          <dt>切块数</dt>
          <dd>{{ document.chunk_count }}</dd>
        </div>
        <div class="meta-item">
          <dt>页数</dt>
          <dd>{{ document.page_count ?? '—' }}</dd>
        </div>
        <div class="meta-item">
          <dt>来源</dt>
          <dd>{{ document.source_kind }}</dd>
        </div>
        <div class="meta-item">
          <dt>更新时间</dt>
          <dd>{{ formatDate(document.updated_at) }}</dd>
        </div>
      </dl>

      <p v-if="document.error" class="error-line">{{ document.error }}</p>

      <!--
        两个视角刻意并存：
        - 阅读：原文长什么样（渲染件，日常用）
        - 切块：解析成了什么（等宽文本带块号，调试用）
        成熟产品（RAGFlow / MaxKB / Open WebUI）都有前者；我们原先只有后者——
        「只看切块」适合调试期，但进入日常使用后，用户第一动作是"确认原文长什么样"。
      -->
      <div class="view-tabs" role="tablist" aria-label="查看方式">
        <button
          v-for="tab in VIEW_TABS"
          :key="tab.key"
          class="view-tab"
          :class="{ 'view-tab-active': view === tab.key }"
          type="button"
          role="tab"
          :aria-selected="view === tab.key"
          @click="view = tab.key"
        >
          {{ tab.label }}
        </button>
        <span class="view-tabs-hint">{{ activeTabHint }}</span>
      </div>

      <!-- 阅读视角 -->
      <template v-if="view === 'read'">
        <!-- 原件版式 / 解析文本：两个都成立时才出现。默认看原件，
             解析文本是"核对解析得对不对"用的第二视角 -->
        <div v-if="canSwitchSource && !previewLoading" class="source-switch" role="tablist">
          <button
            v-for="option in SOURCE_TABS"
            :key="option.key"
            type="button"
            class="source-tab"
            :class="{ 'source-tab-active': previewSource === option.key }"
            role="tab"
            :aria-selected="previewSource === option.key"
            @click="showSource(option.key)"
          >
            {{ option.label }}
          </button>
        </div>

        <p v-if="previewLoading" class="muted">正在加载原文…</p>
        <p v-else-if="previewError" class="muted">{{ previewError }}</p>
        <template v-else-if="preview">
          <p v-if="preview.kind === 'binary'" class="muted">
            「{{ preview.filename }}」这个格式不能在线预览，请用右上角的下载按钮 用本机应用打开。
          </p>

          <!-- Markdown / 纯文本：直接渲染。复用对话页那套渲染器，
               它先整体转义再白名单还原标记，所以文档里带 HTML 也不会被注入 -->
          <!-- eslint-disable vue/no-v-html -->
          <div v-else-if="preview.kind === 'markdown'" class="reader" v-html="readerHtml" />
          <!-- eslint-enable vue/no-v-html -->

          <!-- PDF：交给浏览器原生渲染器。不引 PDF.js 是刻意的——
               原生查看器自带翻页、缩放、搜索、文本选择，还没有体积成本；
               需要按引用高亮时才值得引库。
               `#page=N` 是原生查看器的 PDF Open Parameters：从引用点进来直接落到那一页 -->
          <!-- `:key` 绑到 url：签名链接会过期（默认 10 分钟），重新取到新链接时
               要让 iframe **重建**而不是沿用旧 src——否则长时间停留后翻页会去请求
               一条已过期的链接 -->
          <iframe
            v-else-if="preview.kind === 'pdf'"
            :key="preview.url ?? ''"
            class="reader-frame"
            :src="pdfFrameUrl"
            :title="preview.filename"
          />

          <img
            v-else-if="preview.kind === 'image'"
            class="reader-image"
            :src="preview.url ?? ''"
            :alt="preview.filename"
          />

          <!-- Office 三件套：浏览器不会原生显示，交前端库按需渲染
               （组件内部再按 kind 动态 import，看 Word 不必下 Excel 的引擎） -->
          <OfficePreview
            v-else-if="
              preview.kind === 'docx' || preview.kind === 'pptx' || preview.kind === 'excel'
            "
            :kind="preview.kind"
            :url="preview.url ?? ''"
            :filename="preview.filename"
          />
        </template>
      </template>

      <!-- 切块视角 -->
      <template v-else>
        <p v-if="document.chunk_count === 0" class="muted">
          还没有切块产物：文档尚未处理完成，或处理失败。回到列表页可以重新摄入。
        </p>
        <p v-else-if="previewError" class="muted">{{ previewError }}</p>
        <template v-else-if="chunks.length">
          <p class="preview-note">{{ previewNote }}</p>
          <ol class="preview">
            <li
              v-for="chunk in chunks"
              :key="chunk.chunk_id"
              class="preview-block"
              :class="{ 'preview-block-disabled': chunk.disabled }"
            >
              <div class="preview-head">
                <span class="tabular">第 {{ chunk.ordinal + 1 }} 块</span>
                <template v-if="chunk.heading_path"
                  ><span class="sep">·</span>{{ chunk.heading_path }}</template
                >
                <template v-if="chunk.page !== null"
                  ><span class="sep">·</span>第 {{ chunk.page }} 页</template
                >
                <StatusTag v-if="chunk.disabled" tone="warning" label="已禁用" />

                <!-- 行内操作：解析器一定会出错，所以"用户能自己修"是质量的最后兜底。
                     三个动作语义分开——禁用是"先藏起来"（可恢复），删除是"这是垃圾"。 -->
                <RowMenu class="chunk-menu" label="切块操作">
                  <template #default="{ close }">
                    <button
                      class="menu-item"
                      type="button"
                      @click="((editing = chunk.chunk_id), (draft = chunk.text), close())"
                    >
                      编辑正文
                    </button>
                    <button class="menu-item" type="button" @click="(toggleChunk(chunk), close())">
                      {{ chunk.disabled ? '恢复参与检索' : '禁用（不参与检索）' }}
                    </button>
                    <button
                      class="menu-item menu-item-danger"
                      type="button"
                      @click="(requestRemoveChunk(chunk), close())"
                    >
                      删除
                    </button>
                  </template>
                </RowMenu>
              </div>

              <!-- 编辑态：显式保存。改正文要重新向量化，是有代价的操作，
                   不该边打字边存 -->
              <div v-if="editing === chunk.chunk_id" class="chunk-editor">
                <textarea v-model="draft" class="chunk-textarea" rows="6" />
                <div class="chunk-actions">
                  <span class="chunk-hint"> 保存后会重新向量化这一块，检索随即按新内容生效。 </span>
                  <AppButton :disabled="savingChunk" @click="cancelEdit">取消</AppButton>
                  <AppButton
                    variant="primary"
                    :disabled="savingChunk || !draft.trim()"
                    @click="saveChunk(chunk)"
                  >
                    {{ savingChunk ? '保存中…' : '保存' }}
                  </AppButton>
                </div>
              </div>
              <pre v-else class="preview-text">{{ chunk.text }}</pre>
            </li>
          </ol>
        </template>
      </template>
    </template>
  </PageShell>

  <!-- 删除切块：不可恢复，且"其实想禁用"的人不少——后果说明里把替代方案写出来 -->
  <ConfirmDialog
    v-model:open="chunkDeleteOpen"
    title="删除切块"
    :lead="`确定删除第 ${chunkDeleteTarget && chunkDeleteTarget.ordinal + 1} 块？`"
    note="它会从检索索引与向量库中一并移除，无法恢复。如果只是想让它在检索时暂时不出现，用「禁用」更好——禁用可以随时恢复。"
    :busy="chunkDeleting"
    busy-label="删除中…"
    @confirm="confirmRemoveChunk"
  />
</template>

<style scoped>
/* 视角切换：两个标签贴在一起，用底边表示选中。
   不用大按钮——它们是"同一份内容的两种看法"，不是两个动作，
   做得像按钮会让人以为点了会跳走。 */
.view-tabs {
  display: flex;
  align-items: baseline;
  gap: var(--space-4);
  margin-top: var(--space-5);
  border-bottom: 1px solid var(--border-hairline);
}

.view-tab {
  padding: var(--space-2) 0;
  font-size: var(--text-body-size);
  color: var(--text-secondary);
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
}

.view-tab:hover {
  color: var(--text-primary);
}

.view-tab-active {
  color: var(--text-primary);
  border-bottom-color: var(--accent);
}

/* 右侧一句"这个视角是干什么的"：两个视角的差别（渲染件 vs 解析产物）
   不解释一下，用户不知道为什么会有两个 */
.view-tabs-hint {
  margin-left: auto;
  padding-bottom: var(--space-2);
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

/* 原件 / 解析：次级切换，用分段控件而不是下划线标签页——它跟视角标签页
   不是一层：视角决定"看什么"（阅读 / 切块），来源决定"看哪一份"（原件 / 解析） */
.source-switch {
  display: inline-flex;
  gap: 2px;
  margin-top: var(--space-4);
  padding: 2px;
  background: var(--bg-subtle);
  border-radius: var(--radius-row);
}

.source-tab {
  height: 26px;
  padding: 0 var(--space-3);
  font: inherit;
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
  background: none;
  border: 0;
  border-radius: var(--radius-control);
  cursor: pointer;
}

.source-tab:hover {
  color: var(--text-primary);
}

.source-tab-active {
  color: var(--text-primary);
  background: var(--bg-surface);
  box-shadow: 0 1px 2px rgb(0 0 0 / 10%);
}

/* 阅读区：限宽到 --measure（66ch），与文档详情页"阅读内容限宽"的口径一致 */
.reader {
  max-width: var(--measure);
  margin-top: var(--space-5);
  color: var(--text-primary);
}

/* 三级标题的字号阶梯。
   **间距随层级递减**（上下留白比字号更能表达"归属关系"）：
   h2 隔开大段、h3 隔开小节、h4 只是段前提示。
   字号用乘法而不是再定义一套令牌：标题是内容的一部分，
   应当跟着用户选的字号一起缩放。 */
.reader :deep(.md-h) {
  margin: var(--space-6) 0 var(--space-2);
  line-height: 1.4;
  color: var(--text-primary);
}

.reader :deep(.md-h2) {
  font-size: calc(var(--text-section-size) * 1.25);
}

.reader :deep(.md-h3) {
  font-size: calc(var(--text-section-size) * 1.08);
}

.reader :deep(.md-h4) {
  font-size: var(--text-section-size);
}

/* 首个标题不留上边距：紧贴页头时那一大块空白看着像内容没加载出来 */
.reader :deep(.md-h:first-child) {
  margin-top: 0;
}

.reader :deep(.md-p) {
  margin: 0;
  white-space: pre-wrap;
}

.reader :deep(.md-p + .md-p) {
  margin-top: var(--space-3);
}

.reader :deep(.md-ul) {
  margin: var(--space-2) 0 0;
  padding-left: var(--space-5);
}

.reader :deep(.md-ul li + li) {
  margin-top: var(--space-1);
}

.reader :deep(code) {
  padding: 0 var(--space-1);
  font-size: var(--text-meta-size);
  background: var(--bg-subtle);
  border-radius: var(--radius-control);
}

/* PDF：给足高度。原生查看器在这个高度下能显示整页并自带翻页 */
.reader-frame {
  width: 100%;
  height: 70vh;
  margin-top: var(--space-5);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-panel);
  background: var(--bg-subtle);
}

/* 图片：**不放大**。放大到容器宽度会让小图糊掉，原尺寸更诚实 */
.reader-image {
  display: block;
  max-width: 100%;
  height: auto;
  margin-top: var(--space-5);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-panel);
}

.breadcrumb-link {
  display: inline-flex;
  align-items: center;
  min-height: var(--hit-target);
  color: var(--text-secondary);
}

.breadcrumb-link:hover {
  color: var(--text-primary);
}

.breadcrumb-sep {
  color: var(--text-tertiary);
}

.breadcrumb-current {
  overflow: hidden;
  color: var(--text-tertiary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 元信息用一块圆角面板装起来：它是"这张纸的页眉"，不是散落的标签 */
.meta {
  display: grid;
  gap: var(--space-3) var(--space-6);
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  margin: 0;
}

/* 元信息与切块预览各装进一个圆角面板：整页不再是散落的文字 */
.meta {
  display: grid;
  gap: var(--space-4) var(--space-6);
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  margin: 0;
  padding: var(--space-4) var(--space-5);
  background: var(--bg-canvas);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-panel);
}

.meta-item dt {
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.meta-item dd {
  margin: var(--space-1) 0 0;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}

.error-line {
  margin: var(--space-3) 0 0;
  color: var(--status-danger);
}

.muted {
  margin: var(--space-4) 0 0;
  max-width: var(--measure);
  color: var(--text-secondary);
}

/* 预览区：用大留白与元信息分开，它是"产物"，不是正文本身 */
.preview-title {
  margin: var(--space-8) 0 var(--space-3);
}

.preview-note {
  margin: 0 0 var(--space-4);
  font-size: var(--text-meta-size);
  color: var(--text-tertiary);
}

.preview {
  margin: 0;
  padding: 0;
  list-style: none;
}

.preview-block {
  padding: var(--space-4) var(--space-5);
  background: var(--bg-canvas);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-panel);
}

.preview-block + .preview-block {
  margin-top: var(--space-3);
}

/* 块抬头标的是"这段从哪来"，属于元信息，不该盖过正文 */
.preview-head {
  margin: 0 0 var(--space-2);
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.preview-text {
  margin: 0;
  font-size: var(--text-meta-size);
  line-height: 1.7;
  color: var(--text-primary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* 抬头一行：块号在左，操作菜单推到最右。
   菜单常驻可见（不是 hover 才出现）——触屏与新用户都要能直接看到入口。 */
.preview-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.chunk-menu {
  margin-left: auto;
}

/* 已禁用的块：整块降透明度 + 左边一条警示竖线。
   **仍然完整可读**——用户要能看清禁掉的是什么，才能决定要不要恢复。 */
.preview-block-disabled {
  background: var(--bg-subtle);
  border-left: 2px solid var(--status-warning);
}

.preview-block-disabled .preview-text {
  color: var(--text-secondary);
}

/* 编辑态：输入框吃掉整块宽度，按钮靠右 */
.chunk-editor {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.chunk-textarea {
  width: 100%;
  min-height: 120px;
  padding: var(--space-3);
  font-family: inherit;
  font-size: var(--text-meta-size);
  line-height: 1.7;
  color: var(--text-primary);
  background: var(--bg-surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-control);
  resize: vertical;
}

.chunk-textarea:focus-visible {
  border-color: var(--accent);
}

.chunk-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

/* 说清"保存会重新向量化"：这是三个动作里唯一有实际代价的，
   用户该在点之前知道 */
.chunk-hint {
  flex: 1;
  min-width: 0;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}
</style>
