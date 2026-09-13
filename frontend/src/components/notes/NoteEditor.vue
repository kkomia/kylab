<script setup lang="ts">
/**
 * 笔记编辑器：**工具栏 + 标题/标签 + 文档画布**（Tiptap，headless）。
 *
 * 为什么是 Tiptap：它是 headless 的，菜单全部自己画，能直接套现有设计令牌，
 * 不会像 Cherry/Vditor 那样自带一套皮肤跟控制台打架（见《笔记功能调研》§2.1）。
 * `content_md` 是唯一事实源——进出这一层的都是 Markdown 字符串，编辑器 JSON 不落库。
 *
 * **画布单独拆成 `NoteCanvas` 并由调用方按 noteId 上 key**：Tiptap v3 自己维护 state，
 * 没有清撤销栈的公开 API（`view.updateState` 改不动它），所以切换笔记只能换实例。
 * 换实例这件事收在画布里，工具栏/标题/动作留在本组件——切换时它们不重建，只换内容。
 *
 * 版式对齐 ima 笔记：工具栏在顶部、标题在文档里、正文走居中窄栏。
 */
import type { Editor } from '@tiptap/core'
import { ref, shallowRef, watch } from 'vue'

import { uploadNoteImage, type NoteAiAction } from '@/api/notes'
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

const props = withDefaults(
  defineProps<{ modelValue: string; editable?: boolean; noteId?: string; aiBusy?: boolean }>(),
  { editable: true, noteId: undefined, aiBusy: false },
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

/** 选图 → 上传到后端 → 以带签名的地址插入。图片标签带不了鉴权头，所以必须签名地址。 */
async function onFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = '' // 允许连续选同一张
  const current = instance.value
  if (!file || !current) return
  if (!props.noteId) {
    emit('notify', { type: 'error', message: '笔记还没保存，先等一下再插图' })
    return
  }
  uploading.value = true
  try {
    const image = await uploadNoteImage(props.noteId, file)
    current.chain().focus().setImage({ src: image.url, alt: image.alt }).run()
  } catch (cause) {
    emit('notify', {
      type: 'error',
      message: cause instanceof Error ? cause.message : '图片上传失败',
    })
  } finally {
    uploading.value = false
  }
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

    <div class="editor-body">
      <div class="editor-column">
        <slot name="header" />
        <!-- 按 noteId 换实例：切换笔记只重建这块画布，工具栏与标题不动。
             撤销栈随实例一起换掉，天然不会跨笔记。 -->
        <NoteCanvas
          :key="noteId ?? 'draft'"
          :model-value="modelValue"
          :editable="editable"
          @update:model-value="emit('update:modelValue', $event)"
          @ready="onReady"
          @change="onCanvasChange"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.note-editor {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}

.toolbar {
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
  gap: 2px;
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
  border-radius: 999px;
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

.editor-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

/* 正文收在一条窄栏里居中：满屏宽的行读起来很累，也不像"写作工具" */
.editor-column {
  max-width: 780px;
  margin: 0 auto;
  padding: var(--space-6) var(--space-6) var(--space-16);
}
</style>
