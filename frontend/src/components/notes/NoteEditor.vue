<script setup lang="ts">
/**
 * 笔记编辑器：**工具栏 + 标题/标签 + 文档画布**（Tiptap，headless）。
 *
 * 为什么是 Tiptap：它是 headless 的，菜单全部自己画，能直接套现有设计令牌，
 * 不会像 Cherry/Vditor 那样自带一套皮肤跟控制台打架（见《笔记功能调研》§2.1）。
 * `content_md` 是唯一事实源——进出这一层的都是 Markdown 字符串，编辑器 JSON 不落库。
 *
 * **画布 `NoteCanvas` 是单实例**：切换笔记靠"原地换文档 + 清撤销栈"（见画布注释），
 * 连文档 DOM 都不重建——只换内容，工具栏/标题/动作/滚动容器全程留在原地。
 *
 * 版式对齐 ima 笔记：工具栏在顶部、标题在文档里、正文走居中窄栏。
 */
import type { Editor } from '@tiptap/core'
import { nextTick, ref, shallowRef, watch } from 'vue'

import { uploadNoteImage, type NoteAiAction, type NoteImage } from '@/api/notes'
import IconAi from '@/components/icons/IconAi.vue'
import IconFormatBold from '@/components/icons/IconFormatBold.vue'
import IconFormatBulletList from '@/components/icons/IconFormatBulletList.vue'
import IconFormatCode from '@/components/icons/IconFormatCode.vue'
import IconFormatH1 from '@/components/icons/IconFormatH1.vue'
import IconFormatH2 from '@/components/icons/IconFormatH2.vue'
import IconFormatItalic from '@/components/icons/IconFormatItalic.vue'
import IconFormatLink from '@/components/icons/IconFormatLink.vue'
import IconFormatOrderedList from '@/components/icons/IconFormatOrderedList.vue'
import IconFormatParagraph from '@/components/icons/IconFormatParagraph.vue'
import IconFormatQuote from '@/components/icons/IconFormatQuote.vue'
import IconFormatStrike from '@/components/icons/IconFormatStrike.vue'
import IconFormatTaskList from '@/components/icons/IconFormatTaskList.vue'
import IconFormatUnderline from '@/components/icons/IconFormatUnderline.vue'
import IconImage from '@/components/icons/IconImage.vue'
import IconRedo from '@/components/icons/IconRedo.vue'
import IconUndo from '@/components/icons/IconUndo.vue'
import NoteCanvas from '@/components/notes/NoteCanvas.vue'
import RowMenu from '@/components/ui/RowMenu.vue'

/** 画布实例的公开面：页面在 hover 预取命中后调它预热文档解析。 */
const canvasRef = ref<InstanceType<typeof NoteCanvas> | null>(null)

const props = withDefaults(
  defineProps<{
    modelValue: string
    editable?: boolean
    noteId?: string
    aiBusy?: boolean
    /** 正在等这条笔记的正文（缓存未命中）：给内容一层"正在换"的过渡，别硬切。 */
    loading?: boolean
  }>(),
  { editable: true, noteId: undefined, aiBusy: false, loading: false },
)
const emit = defineEmits<{
  'update:modelValue': [value: string]
  /** 交给页面去弹提示：编辑器不做全局通知。 */
  notify: [payload: { type: 'error' | 'success'; message: string }]
  /** 请求对本篇做一次 AI 处理；由页面负责保存、调用、写回。 */
  ai: [action: NoteAiAction]
}>()

/** 画布交回来的实例；换笔记时会被替换成新的那个。 */
const instance = shallowRef<Editor | null>(null)

function onReady(editor: Editor | null): void {
  instance.value = editor
  refreshActive()
}

function onCanvasChange(): void {
  refreshActive()
}

/**
 * 各按钮的激活/可用态。
 *
 * Tiptap 实例不在 Vue 的响应式图里，不能直接 `computed(isActive)`——
 * 改成"画布每次交易后通知一次"的普通 ref。
 */
const active = ref({
  paragraph: true,
  h1: false,
  h2: false,
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  bullet: false,
  ordered: false,
  task: false,
  quote: false,
  code: false,
  link: false,
  canUndo: false,
  canRedo: false,
})

function refreshActive(): void {
  const current = instance.value
  if (!current) return
  active.value = {
    paragraph: current.isActive('paragraph'),
    h1: current.isActive('heading', { level: 1 }),
    h2: current.isActive('heading', { level: 2 }),
    bold: current.isActive('bold'),
    italic: current.isActive('italic'),
    underline: current.isActive('underline'),
    strike: current.isActive('strike'),
    bullet: current.isActive('bulletList'),
    ordered: current.isActive('orderedList'),
    task: current.isActive('taskList'),
    quote: current.isActive('blockquote'),
    code: current.isActive('codeBlock'),
    link: current.isActive('link'),
    canUndo: current.can().undo(),
    canRedo: current.can().redo(),
  }
}

function run(action: (editor: Editor) => void): void {
  const current = instance.value
  if (!current) return
  action(current)
}

function toggleLink(): void {
  const current = instance.value
  if (!current) return
  if (current.isActive('link')) {
    current.chain().focus().unsetLink().run()
    return
  }
  const url = window.prompt('链接地址（留空则取消）', 'https://')
  if (!url) return
  current.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
}

const fileInput = ref<HTMLInputElement | null>(null)
const uploading = ref(false)

function pickImage(): void {
  fileInput.value?.click()
}

/**
 * MIME → 后缀。
 *
 * 剪贴板里的图常常**没有文件名**（截图工具给的是空串或 "blob"），而后端按后缀判
 * 白名单，不补一个必然被"不支持的图片格式"挡回来——这条路径的真实拦路虎就是它。
 */
const SUFFIX_BY_TYPE: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
}

/** 给没有后缀的图按 MIME 补一个后缀；已经有后缀（哪怕是别的）就不动，让后端去判。 */
function withSuffixFromType(file: File): File {
  const suffix = SUFFIX_BY_TYPE[file.type.toLowerCase()]
  if (!suffix || /\.[a-z0-9]{2,5}$/i.test(file.name)) return file
  const base = file.name.trim() || '粘贴的图片'
  return new File([file], `${base}${suffix}`, { type: file.type })
}

/**
 * 图片上传的**唯一通道**：工具栏选图与正文粘贴都走它。
 *
 * 失败时返回 null（并弹提示）而**不是**抛异常：调用方据此什么都不插——
 * 半截内容（比如 data URL）留在正文里比"没插上"更糟。
 */
async function uploadImageForEditor(file: File): Promise<NoteImage | null> {
  if (!props.noteId) {
    emit('notify', { type: 'error', message: '笔记还没保存，先等一下再插图' })
    return null
  }
  uploading.value = true
  try {
    return await uploadNoteImage(props.noteId, withSuffixFromType(file))
  } catch (cause) {
    emit('notify', {
      type: 'error',
      message: cause instanceof Error ? cause.message : '图片上传失败',
    })
    return null
  } finally {
    uploading.value = false
  }
}

/** 选图 → 上传到后端 → 以带签名的地址插入。图片标签带不了鉴权头，所以必须签名地址。 */
async function onFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = '' // 允许连续选同一张
  if (!file) return
  const image = await uploadImageForEditor(file)
  // 上传期间笔记可能已经切走（画布换的是文档、实例还在），所以落图前重取一次实例
  const current = instance.value
  if (!image || !current || current.isDestroyed) return
  current.chain().focus().setImage({ src: image.url, alt: image.alt }).run()
}

/** 选定 AI 动作后交给页面执行（页面负责先保存，再替换正文）。 */
function chooseAi(action: NoteAiAction, close: () => void): void {
  close()
  if (props.aiBusy) return
  emit('ai', action)
}

watch(
  () => props.editable,
  (value) => instance.value?.setEditable(value),
)

/** 转发给画布：提前把某篇的正文解析成文档（切换时省掉这段主线程开销）。 */
function warm(markdown: string): void {
  canvasRef.value?.warm(markdown)
}

defineExpose({ warm })

/**
 * 每条笔记记一个滚动位置。
 *
 * 单实例换文档之后，滚动位置不再被重建——如果不主动处理，切到新笔记会**继承上一条
 * 的滚动位置**（长笔记切走再回来停在半中间很突兀，切到短笔记还会因高度骤减而乱跳）。
 * 记住每条自己的位置，回来时接着看，这也是笔记类应用的常规手感。
 *
 * 注意真正的滚动容器**不是 `.editor-body`**：正文区高度随内容增长，本身并不滚。
 * 并排两列时滚的是笔记页的正文列（`.notes-pane`）；单栏堆叠（<=900px）时那一列
 * 也交回了页面，滚的是外层布局的 `main.content`。所以这里往上找
 * 第一个"样式允许滚且确实滚得动"的祖先，而不是写死某个类名——
 * 笔记页那次"两列各自滚"的改造正是靠这一条没被牵动。
 */
const bodyRef = ref<HTMLElement | null>(null)
const scrollByNote = new Map<string, number>()

function scrollParentOf(el: HTMLElement | null): HTMLElement | null {
  let node: HTMLElement | null = el
  while (node) {
    const overflowY = getComputedStyle(node).overflowY
    const scrollable = overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay'
    if (scrollable && node.scrollHeight > node.clientHeight + 1) return node
    node = node.parentElement
  }
  return (document.scrollingElement as HTMLElement | null) ?? null
}

watch(
  () => props.noteId,
  (noteId, previous) => {
    if (previous) {
      const scroller = scrollParentOf(bodyRef.value)
      if (scroller) scrollByNote.set(previous, scroller.scrollTop)
    }
    // 等画布把新正文换完再定位：早一步拿到的是旧文档的高度
    void nextTick(() => {
      const scroller = scrollParentOf(bodyRef.value)
      if (scroller) scroller.scrollTop = (noteId && scrollByNote.get(noteId)) || 0
    })
  },
)
</script>

<template>
  <div class="note-editor">
    <div class="toolbar" role="toolbar" aria-label="排版工具栏">
      <div class="tool-group">
        <button
          type="button"
          class="tool"
          title="撤销"
          :disabled="!active.canUndo"
          @click="run((e) => e.chain().focus().undo().run())"
        >
          <IconUndo :size="15" />
        </button>
        <button
          type="button"
          class="tool"
          title="重做"
          :disabled="!active.canRedo"
          @click="run((e) => e.chain().focus().redo().run())"
        >
          <IconRedo :size="15" />
        </button>
      </div>

      <span class="tool-sep" aria-hidden="true" />

      <div class="tool-group">
        <button
          type="button"
          class="tool"
          :class="{ 'tool-on': active.paragraph }"
          title="正文"
          @click="run((e) => e.chain().focus().setParagraph().run())"
        >
          <IconFormatParagraph :size="15" />
        </button>
        <button
          type="button"
          class="tool"
          :class="{ 'tool-on': active.h1 }"
          title="一级标题"
          @click="run((e) => e.chain().focus().toggleHeading({ level: 1 }).run())"
        >
          <IconFormatH1 :size="15" />
        </button>
        <button
          type="button"
          class="tool"
          :class="{ 'tool-on': active.h2 }"
          title="二级标题"
          @click="run((e) => e.chain().focus().toggleHeading({ level: 2 }).run())"
        >
          <IconFormatH2 :size="15" />
        </button>
      </div>

      <span class="tool-sep" aria-hidden="true" />

      <div class="tool-group">
        <button
          type="button"
          class="tool"
          :class="{ 'tool-on': active.bold }"
          title="粗体"
          @click="run((e) => e.chain().focus().toggleBold().run())"
        >
          <IconFormatBold :size="15" />
        </button>
        <button
          type="button"
          class="tool"
          :class="{ 'tool-on': active.italic }"
          title="斜体"
          @click="run((e) => e.chain().focus().toggleItalic().run())"
        >
          <IconFormatItalic :size="15" />
        </button>
        <button
          type="button"
          class="tool"
          :class="{ 'tool-on': active.underline }"
          title="下划线"
          @click="run((e) => e.chain().focus().toggleUnderline().run())"
        >
          <IconFormatUnderline :size="15" />
        </button>
        <button
          type="button"
          class="tool"
          :class="{ 'tool-on': active.strike }"
          title="删除线"
          @click="run((e) => e.chain().focus().toggleStrike().run())"
        >
          <IconFormatStrike :size="15" />
        </button>
      </div>

      <span class="tool-sep" aria-hidden="true" />

      <div class="tool-group">
        <button
          type="button"
          class="tool"
          :class="{ 'tool-on': active.bullet }"
          title="无序列表"
          @click="run((e) => e.chain().focus().toggleBulletList().run())"
        >
          <IconFormatBulletList :size="15" />
        </button>
        <button
          type="button"
          class="tool"
          :class="{ 'tool-on': active.ordered }"
          title="有序列表"
          @click="run((e) => e.chain().focus().toggleOrderedList().run())"
        >
          <IconFormatOrderedList :size="15" />
        </button>
        <button
          type="button"
          class="tool"
          :class="{ 'tool-on': active.task }"
          title="待办清单"
          @click="run((e) => e.chain().focus().toggleTaskList().run())"
        >
          <IconFormatTaskList :size="15" />
        </button>
      </div>

      <span class="tool-sep" aria-hidden="true" />

      <div class="tool-group">
        <button
          type="button"
          class="tool"
          :class="{ 'tool-on': active.quote }"
          title="引用"
          @click="run((e) => e.chain().focus().toggleBlockquote().run())"
        >
          <IconFormatQuote :size="15" />
        </button>
        <button
          type="button"
          class="tool"
          :class="{ 'tool-on': active.code }"
          title="代码块"
          @click="run((e) => e.chain().focus().toggleCodeBlock().run())"
        >
          <IconFormatCode :size="15" />
        </button>
        <button
          type="button"
          class="tool"
          :class="{ 'tool-on': active.link }"
          title="链接"
          @click="toggleLink"
        >
          <IconFormatLink :size="15" />
        </button>
        <button
          type="button"
          class="tool"
          :disabled="uploading || !noteId"
          :title="noteId ? '插入图片' : '保存后才能插入图片'"
          @click="pickImage"
        >
          <IconImage :size="15" />
        </button>
      </div>

      <div class="toolbar-right">
        <!-- 上传中要有可见反馈：从"粘/选"到图片落进正文之间有一段时间，
             只把按钮置灰的话，用户会以为这次粘贴没被受理 -->
        <span v-if="uploading" class="upload-hint" role="status">图片上传中…</span>
        <!-- 保存状态放在最左：它是"这条笔记当前的状态"，比任何动作都更该先被看到 -->
        <slot name="status" />
        <!-- AI 处理：星芒图标 + 三档动作下拉。放在格式工具栏与右侧动作之间——
             它属于"对内容做什么"，不属于"对这条笔记做什么"。 -->
        <RowMenu label="AI 处理">
          <template #trigger>
            <span
              class="ai-trigger"
              :class="{ 'ai-busy': aiBusy }"
              :title="aiBusy ? 'AI 正在处理…' : 'AI 处理'"
            >
              <span v-if="aiBusy" class="ai-spinner" aria-hidden="true" />
              <IconAi v-else :size="15" />
              <span class="ai-trigger-text">{{ aiBusy ? '处理中' : 'AI' }}</span>
            </span>
          </template>
          <template #default="{ close }">
            <button type="button" :disabled="aiBusy" @click="chooseAi('format', close)">
              <span class="ai-item-label">智能排版</span>
              <span class="ai-item-hint">只调分段与标题，不改文字</span>
            </button>
            <button type="button" :disabled="aiBusy" @click="chooseAi('polish', close)">
              <span class="ai-item-label">内容润色</span>
              <span class="ai-item-hint">只改措辞与标点，不动结构</span>
            </button>
            <button type="button" :disabled="aiBusy" @click="chooseAi('both', close)">
              <span class="ai-item-label">排版并润色</span>
              <span class="ai-item-hint">两件事一起做</span>
            </button>
          </template>
        </RowMenu>
        <slot name="actions" />
      </div>

      <input
        ref="fileInput"
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"
        class="file-input"
        @change="onFileChange"
      />
    </div>

    <div ref="bodyRef" class="editor-body" :class="{ 'is-loading': loading }">
      <div class="editor-column">
        <slot name="header" />
        <!-- 单实例：切换笔记由画布原地换文档并清撤销栈，这里不上 key、不重建 -->
        <NoteCanvas
          ref="canvasRef"
          :model-value="modelValue"
          :editable="editable"
          :note-id="noteId"
          :upload-image="uploadImageForEditor"
          @update:model-value="emit('update:modelValue', $event)"
          @ready="onReady"
          @change="onCanvasChange"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 只管纵向排布：**高度由使用方决定**（笔记页的 `.pane-editor` 让它撑满正文列，
   但随内容长高、不被压矮，见 `.toolbar` 那条注释）。
   这里写死 `height: 100%` 或 `min-height: 0` 都会把滚动归属搞乱：
   前者把这一层钉在列高上，正文只能在 `.editor-body` 里另开一个滚动区、
   把列那层架空；后者允许这一层被压回列高，sticky 的包含块跟着缩到一屏。 */
.note-editor {
  display: flex;
  flex-direction: column;
}

/* 工具栏吸顶：正文再长也不必滚回顶部去点格式按钮。
 *
 * 吸附对象是**正文列**（笔记页的 `.notes-pane`，`overflow-y: auto`）：
 * 工具栏到它之间只有 `.note-editor` 这一级，没有 `overflow: hidden` 之类的裁剪，
 * 所以吸得住。反过来，`.editor-body` 刻意**不设** overflow（见下面那条规则）——
 * 它一旦自己成了滚动区，滚动就发生在工具栏**里面**，
 * 外面那一列永远不动，sticky 就成了写着好看的声明（贴着滚动区的上沿不动）。
 *
 * `z-index` 是必需的：正文在换笔记时带 `opacity` 过渡，那个不透明度会让
 * `.editor-body` 自成一个层叠上下文；不给一个正的层级，它就会盖在工具栏上。
 * 背景必须是不透明色（`--bg-surface` 两套主题都是实色），否则滚动时正文会透出来。 */
.toolbar {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border-hairline);
  background: var(--bg-surface);
}

.tool-group {
  display: flex;
  align-items: center;
  gap: var(--space-pair);
}

.tool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  border-radius: var(--radius-control);
  cursor: pointer;
}

.tool:hover:not(:disabled) {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.tool:disabled {
  color: var(--text-tertiary);
  opacity: 0.45;
  cursor: default;
}

.tool-on {
  color: var(--accent-text);
  background: var(--accent-soft);
}

.tool-sep {
  width: 1px;
  height: 16px;
  margin: 0 var(--space-1);
  background: var(--border);
}

.toolbar-right {
  display: flex;
  gap: var(--space-1);
  align-items: center;
  margin-left: auto;
}

/* 工具栏右侧是一个 28px 的按钮排；AI 入口的外框必须同高，否则文字基线会与邻排错开
   （实测：RowMenu 默认触发器是 24px 的方块，带文字的触发器又只有 21px 行高）
   再把 details 本身也变成 flex 项：inline 级盒子按基线对齐，会与按钮差 1px。 */
.toolbar-right :deep(.menu) {
  display: flex;
  align-items: center;
}

.toolbar :deep(.menu-trigger) {
  min-width: 28px;
  height: 28px;
}

.file-input {
  display: none;
}

/* 上传中的可见反馈（粘贴图片这条路尤其需要：没有它，等待期里界面毫无动静） */
.upload-hint {
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
  white-space: nowrap;
}

/* AI 入口：星芒 + 短标签，用强调色与普通格式按钮区分开 */
.ai-trigger {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  height: 21px;
  font-size: var(--text-micro-size);
  font-weight: 600;
  color: var(--accent-text);
}

.ai-busy {
  opacity: 0.8;
}

/* 运行中的进度圈：把星芒换成一个转圈，用户一眼知道"它在跑" */
.ai-spinner {
  width: 13px;
  height: 13px;
  border: 2px solid var(--accent-soft);
  border-top-color: var(--accent);
  border-radius: var(--radius-pill);
  animation: ai-spin 0.7s linear infinite;
}

@keyframes ai-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  /* 降级成慢转而不是停住：停住就没有"在跑"的信息了 */
  .ai-spinner {
    animation-duration: 1.8s;
  }
}

.ai-item-label {
  display: block;
}

.ai-item-hint {
  display: block;
  margin-top: 2px;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

/* 正文区**不自己滚**：滚动归笔记页的正文列（`.notes-pane`）。
   这里只负责把"列高减去工具栏"剩下的空间吃下来（`flex: 1`），
   于是短笔记也铺满整列的点击区；
   一旦给它 `overflow-y: auto`，它就成了内层滚动容器，把列那层的滚动架空。 */
.editor-body {
  flex: 1;
  transition: opacity 160ms ease;
}

/* 正文还在路上（缓存未命中）时把旧内容轻轻压暗：换笔记就有了过渡而不是硬切，
   而这段时间通常刚好够请求回来——回来即恢复，看不出一道闪。
   延迟 120ms 才加这个类（见 NotesView），所以命中缓存的切换完全不会压暗。 */
.editor-body.is-loading {
  opacity: 0.45;
}

@media (prefers-reduced-motion: reduce) {
  .editor-body {
    transition: none;
  }
}

/* 正文收在一条窄栏里居中：满屏宽的行读起来很累，也不像"写作工具" */
.editor-column {
  max-width: 780px;
  margin: 0 auto;
  padding: var(--space-6) var(--space-6) var(--space-16);
}
</style>
