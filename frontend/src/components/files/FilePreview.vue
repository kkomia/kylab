<script setup lang="ts">
/**
 * 按格式选渲染器的文件预览（v0.26）。
 *
 * 一张表决定一切——**按后缀路由**，每个后缀只归一类，不做"猜内容"：
 *
 * | 后缀 | 怎么渲染 | 为什么 |
 * | --- | --- | --- |
 * | `md` / `markdown` | 自己的 Markdown 渲染器 | 与对话里的答案同一套解析，不另引一个库 |
 * | `txt` / `log` / `csv` / 各种代码 | `<pre>` 等宽 | 这些就该原样看 |
 * | `png` / `jpg` / `gif` / `webp` / `bmp` / `avif` | `<img>` | 浏览器本来就会 |
 * | `pdf` | `<iframe>` 指向签名链接 | 见下 |
 * | `docx` / `pptx` / `xlsx` / `xls` | `OfficePreview` | docx-preview / @vue-office |
 * | 其它 | 一句"下载它" | **不假装能预览** |
 *
 * 两条取舍写在明处：
 *
 * 1. **PDF 不再引 pdf.js**。浏览器的内置阅读器就是它（Chromium 的 PDFium 同族、
 *    Firefox 就是 pdf.js），而自建一层要自己管分页、缩放、文本层与那 1MB 的 worker。
 *    这里给 `<iframe>` 一条 `disposition=inline` 的签名链接即可——
 *    代价是样式跟着浏览器走，换来的是零体积与零维护。
 * 2. **SVG 不在图片那一档**：它能带 `<script>`，内联在本站 origin 下就是存储型 XSS。
 *    服务端按后缀白名单强制 `attachment`（见 `INLINE_SAFE_KINDS`），
 *    所以这里也把它归到"下载看"——**两处口径必须一致**，否则就是
 *    "界面画了一个框，里面永远加载失败"。
 */
import { computed, defineAsyncComponent, onBeforeUnmount, ref, watch } from 'vue'

import { getFileUrl, type ConversationFile } from '@/api/conversations'
import { renderPlainMarkdown } from '@/composables/useMarkdown'
import IconFile from '@/components/icons/IconFile.vue'

/** Office 预览按需加载：它的三个引擎加起来约 900KB，不该进对话页的首屏包。 */
const OfficePreview = defineAsyncComponent(() => import('@/components/knowledge/OfficePreview.vue'))

const props = defineProps<{
  conversationId: string
  file: ConversationFile
}>()

type Renderer = 'markdown' | 'text' | 'image' | 'pdf' | 'docx' | 'pptx' | 'excel' | 'none'

const MARKDOWN = new Set(['md', 'markdown'])
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'])
const OFFICE: Record<string, Renderer> = { docx: 'docx', pptx: 'pptx', xlsx: 'excel', xls: 'excel' }
/** 当纯文本看的：代码、配置、日志、数据。够用就好，不是一张穷举表。 */
const TEXT = new Set([
  'txt',
  'log',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'yaml',
  'yml',
  'toml',
  'ini',
  'conf',
  'env',
  'py',
  'ts',
  'tsx',
  'js',
  'jsx',
  'vue',
  'sh',
  'bash',
  'ps1',
  'bat',
  'sql',
  'go',
  'rs',
  'java',
  'kt',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'rb',
  'php',
  'swift',
  'scala',
  'lua',
  'r',
  'html',
  'htm',
  'xml',
  'css',
  'scss',
  'less',
  'diff',
  'patch',
  'gitignore',
  'dockerfile',
])

const renderer = computed<Renderer>(() => {
  const kind = props.file.kind
  if (MARKDOWN.has(kind)) return 'markdown'
  if (IMAGE.has(kind)) return 'image'
  if (kind === 'pdf') return 'pdf'
  if (OFFICE[kind]) return OFFICE[kind]
  if (TEXT.has(kind)) return 'text'
  return 'none'
})

/** 需要把内容读成文本的两种：Markdown 与纯文本。 */
const needsText = computed(() => renderer.value === 'markdown' || renderer.value === 'text')

const loading = ref(true)
const failure = ref('')
const url = ref('')
const text = ref('')

const markdownHtml = computed(() =>
  renderer.value === 'markdown' ? renderPlainMarkdown(text.value) : '',
)

async function load(): Promise<void> {
  loading.value = true
  failure.value = ''
  url.value = ''
  text.value = ''
  if (renderer.value === 'none') {
    loading.value = false
    return
  }
  try {
    // 除"下载看"以外都要 inline：PDF 与图片要它才能在页面里渲染
    // （服务端还会按后缀复核一遍，这里传了不算越权）
    const issued = await getFileUrl(props.conversationId, props.file.key, 'inline')
    url.value = issued.url
    if (needsText.value) {
      const response = await fetch(issued.url)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      text.value = await response.text()
    }
  } catch (cause) {
    failure.value = cause instanceof Error ? cause.message : '加载失败'
  } finally {
    loading.value = false
  }
}

// 换一份文件就重来。**key 与文件区绑定**：同名不同目录的两份文件是两个 key，
// 只比 name 会让"切到另一个目录里的同名文件"看起来没反应
watch(() => [props.conversationId, props.file.key], load, { immediate: true })

onBeforeUnmount(() => {
  // 大文档的 DOM 很大，离页时主动松手（与 OfficePreview 同一条）
  text.value = ''
  url.value = ''
})
</script>

<template>
  <div class="file-preview">
    <p v-if="loading" class="preview-note">正在加载…</p>

    <p v-else-if="failure" class="preview-note preview-note-bad">
      预览失败（{{ failure }}）。用上面的下载按钮，拿本机程序打开它。
    </p>

    <!-- 不假装能预览：说清"为什么不能"与"该怎么办"，比给一个空白框诚实 -->
    <div v-else-if="renderer === 'none'" class="preview-none">
      <IconFile :size="28" />
      <p class="preview-none-title">这个格式不能在这里预览</p>
      <p class="preview-none-note">下载它，用本机的程序打开。</p>
    </div>

    <!--
      文件里的 Markdown 用 v-html 是刻意的（与对话页同一条口径）：
      `renderPlainMarkdown` 先转义全部 HTML，再只还原它自己识别出的标记——
      `tests/unit/composables/useMarkdown.test.ts` 里有对应的注入用例。
      换成插值等于把 `#` 和 `**` 原样摆给用户看。
    -->
    <!-- eslint-disable vue/no-v-html -->
    <article v-else-if="renderer === 'markdown'" class="preview-markdown" v-html="markdownHtml" />
    <!-- eslint-enable vue/no-v-html -->

    <pre v-else-if="renderer === 'text'" class="preview-text">{{ text }}</pre>

    <img v-else-if="renderer === 'image'" class="preview-image" :src="url" :alt="file.name" />

    <iframe v-else-if="renderer === 'pdf'" class="preview-pdf" :src="url" :title="file.name" />

    <OfficePreview
      v-else
      class="preview-office"
      :kind="renderer === 'excel' ? 'excel' : (renderer as 'docx' | 'pptx')"
      :url="url"
      :filename="file.name"
    />
  </div>
</template>

<style scoped>
.file-preview {
  min-height: 160px;
}

.preview-note {
  margin: 0;
  color: var(--text-tertiary);
  font-size: var(--text-meta-size);
}

.preview-note-bad {
  color: var(--status-danger);
}

.preview-none {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-8) var(--space-4);
  color: var(--text-tertiary);
  text-align: center;
}

.preview-none-title {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--text-body-size);
}

.preview-none-note {
  margin: 0;
  font-size: var(--text-meta-size);
}

/* 文本与代码：等宽、可横向滚、**保留空白**。
   `pre-wrap` 而不是 `pre`：一行的长句子在窄抽屉里应当折行，而不是逼人横向拖。 */
.preview-text {
  margin: 0;
  padding: var(--space-3);
  overflow-x: auto;
  background: var(--bg-subtle);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-row);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: var(--text-meta-size);
  line-height: var(--line-prose);
  white-space: pre-wrap;
  word-break: break-word;
}

/*
 * Markdown 预览的排版。
 *
 * 渲染器（`renderPlainMarkdown`）与对话页共用，但**样式是各写各的**：
 * 对话页那一套挂在 ChatView 的 `.reply-text` 下面（scoped），这里够不着。
 * 没有反过来抽成全局，是因为两处的目标不同——对话里的答案是"读的一段话"，
 * 而这里是一份**文件**，标题层级、表格边框都该更像文档。
 */
.preview-markdown {
  font-size: var(--text-body-size);
  line-height: var(--line-prose);
  color: var(--text-primary);
  word-break: break-word;
}

.preview-markdown :deep(.md-p) {
  margin: 0 0 var(--space-3);
}

.preview-markdown :deep(.md-h) {
  margin: var(--space-5) 0 var(--space-2);
  line-height: 1.35;
}

.preview-markdown :deep(.md-h1) {
  font-size: var(--text-title-size);
}

.preview-markdown :deep(.md-h2) {
  font-size: var(--text-section-size);
}

.preview-markdown :deep(.md-h3),
.preview-markdown :deep(.md-h4) {
  font-size: var(--text-body-size);
}

.preview-markdown :deep(.md-ul),
.preview-markdown :deep(.md-ol) {
  margin: 0 0 var(--space-3);
  padding-left: var(--space-6);
}

.preview-markdown :deep(.md-quote) {
  margin: 0 0 var(--space-3);
  padding-left: var(--space-3);
  border-left: 2px solid var(--border-strong);
  color: var(--text-secondary);
}

.preview-markdown :deep(.md-hr) {
  margin: var(--space-5) 0;
  border: none;
  border-top: 1px solid var(--border-hairline);
}

.preview-markdown :deep(.md-pre) {
  margin: 0 0 var(--space-3);
  padding: var(--space-3);
  overflow-x: auto;
  background: var(--bg-subtle);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-row);
  font-family: var(--font-mono);
  font-size: var(--text-meta-size);
  line-height: var(--line-prose);
}

/* 表格**独立成块**：宽表格在窄抽屉里必须能横向滚，否则会把整页撑破 */
.preview-markdown :deep(.md-table) {
  display: block;
  width: max-content;
  max-width: 100%;
  margin: 0 0 var(--space-3);
  overflow-x: auto;
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-row);
  border-collapse: separate;
  border-spacing: 0;
  font-size: var(--text-meta-size);
}

.preview-markdown :deep(.md-table th),
.preview-markdown :deep(.md-table td) {
  padding: var(--space-2);
  border-bottom: 1px solid var(--border-hairline);
  text-align: left;
}

.preview-markdown :deep(.md-table th) {
  background: var(--bg-group);
  font-weight: 500;
}

.preview-markdown :deep(.md-table tr:last-child td) {
  border-bottom: none;
}

.preview-markdown :deep(.md-table code),
.preview-markdown :deep(.md-p code) {
  padding: 2px 5px;
  background: var(--bg-group);
  border-radius: var(--radius-control);
  font-family: var(--font-mono);
  font-size: 0.92em;
}

.preview-image {
  display: block;
  max-width: 100%;
  border-radius: var(--radius-row);
}

/* PDF 占满抽屉的高度：它是"一页一页翻"的东西，给个 400px 的框等于让人在
   一条缝里读。高度用 vh 是因为抽屉自己就是视口高的一部分。 */
.preview-pdf {
  width: 100%;
  height: calc(100vh - 180px);
  min-height: 420px;
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-row);
  background: var(--bg-subtle);
}

.preview-office {
  width: 100%;
}
</style>
