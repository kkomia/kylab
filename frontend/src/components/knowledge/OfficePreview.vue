<script setup lang="ts">
/**
 * Office 原版式预览（docx / xlsx / pptx）。
 *
 * 浏览器不会原生显示这三种格式，所以要前端库来画。三个库都不小
 * （docx ~20KB gzip，xlsx ~470KB，pptx ~430KB），因此：
 *
 * - 本组件只被 `DocumentView` 在**确实要看 Office 原件**时挂载；
 * - 两个大块走 `defineAsyncComponent` 动态 import，各自成独立 chunk，
 *   不进首屏包，也不互相拖累（看 Word 不会下载 Excel 的引擎）。
 *
 * 字节由我们自己取：签名链接是相对路径、不带鉴权头，`fetch` 拿到 ArrayBuffer
 * 再交给渲染器——比让库各自去猜怎么取更可控，也让"取不到"有统一的报错位。
 */
import { defineAsyncComponent, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'

const props = defineProps<{
  kind: 'docx' | 'pptx' | 'excel'
  /** 后端签发的原件链接。 */
  url: string
  filename: string
}>()

/** Excel 渲染器自带一套 x-spreadsheet 样式，跟着它的 chunk 一起按需加载。 */
const VueOfficeExcel = defineAsyncComponent(async () => {
  await import('@vue-office/excel/lib/v3/index.css')
  return import('@vue-office/excel')
})
const VueOfficePptx = defineAsyncComponent(() => import('@vue-office/pptx'))

const loading = ref(true)
const failure = ref('')
const buffer = shallowRef<ArrayBuffer | null>(null)
/** docx-preview 是命令式的：给它一个容器，它把 DOM 写进去。 */
const host = ref<HTMLElement | null>(null)

async function load(): Promise<void> {
  loading.value = true
  failure.value = ''
  buffer.value = null
  try {
    const response = await fetch(props.url)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    buffer.value = await response.arrayBuffer()
    loading.value = false
    // docx 的容器要等 `loading=false` 之后才渲染出来，所以拿 DOM 得再等一拍
    await nextTick()
    if (props.kind === 'docx') await renderDocx()
  } catch (cause) {
    failure.value = cause instanceof Error ? cause.message : '加载失败'
    loading.value = false
  }
}

async function renderDocx(): Promise<void> {
  const data = buffer.value
  if (!data || !host.value) return
  try {
    const { renderAsync } = await import('docx-preview')
    host.value.innerHTML = ''
    await renderAsync(data, host.value, undefined, {
      className: 'docx-preview',
      inWrapper: true,
    })
  } catch (cause) {
    failure.value = cause instanceof Error ? cause.message : '解析失败'
  }
}

watch(() => [props.kind, props.url], load, { immediate: true })

onBeforeUnmount(() => {
  // 大文档的 DOM 很大，离页时主动松手
  if (host.value) host.value.innerHTML = ''
})
</script>

<template>
  <div class="office-preview">
    <p v-if="loading" class="office-note">正在加载原文…</p>
    <p v-else-if="failure" class="office-note">
      「{{ filename }}」预览失败（{{ failure }}）。可以用右上角的下载按钮，用本机 Office 打开。
    </p>
    <div v-else-if="kind === 'docx'" ref="host" class="office-docx" />
    <VueOfficeExcel v-else-if="kind === 'excel' && buffer" :src="buffer" />
    <VueOfficePptx v-else-if="buffer" :src="buffer" />
  </div>
</template>

<style scoped>
.office-preview {
  width: 100%;
  min-height: 200px;
}

.office-note {
  margin: 0;
  font-size: var(--text-meta-size);
  color: var(--text-tertiary);
}

/* docx-preview 会写一整个页面宽的容器；给它一条边框，读起来像一页纸 */
.office-docx {
  padding: var(--space-3);
  overflow-x: auto;
  background: var(--bg-subtle);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-row);
}
</style>
