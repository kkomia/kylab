<script setup lang="ts">
/**
 * 过程面板里的**一行**（v0.26 抽出）。
 *
 * 抽出来是因为它现在有两个位置：正常的一行，以及"同类工具合并"那一组**展开后的
 * 每一次调用**。同一份标记复制两遍，改一处忘一处只是时间问题——而这里装着的
 * 是"这一步到底做了什么"（结论 / 入参 / 返回 / 产出的文件），最不该出现两份。
 *
 * 图标由调用方给的 `iconClass` 映射决定：**这一层不 import 图标组件**，
 * 它只认 `step.icon` 那个类别键；映射表在 `ChatView`（图标都在那儿 import）。
 */
import { computed } from 'vue'

import type { TraceStep } from '@/composables/useChatTurns'
import IconChevronDown from '@/components/icons/IconChevronDown.vue'
import LinkText from '@/components/ui/LinkText.vue'

const props = defineProps<{
  step: TraceStep
  /** 原文（入参 / 返回）是否展开。由宿主持有——它才管得住"哪几行开着"。 */
  open: boolean
  /** `child` = 某一组展开后的一次调用：缩进一档、图标位换成小圆点。 */
  variant?: 'plain' | 'child'
  /** 类别键 → 图标组件。 */
  icons: Record<string, unknown>
}>()

const emit = defineEmits<{ (event: 'toggle'): void }>()

/** 展开入口只在真有原文时给：没有原文却画个能点的箭头，点了什么都不变。 */
const hasDetail = computed(() => Boolean(props.step.args || props.step.result))

/**
 * 结论那一行是**原始 JSON** 吗（v0.26）。
 *
 * 判据是结构而不是 `JSON.parse`：老快照里那条被裁到 120 字，**根本解析不了**，
 * 而它恰恰是这里要挡的东西。所以只认"以 `{` 开头、紧跟着一个 `"键":`"。
 *
 * 为什么要挡：`ToolOutcome.step_detail()` 在没有摘要时会**回退到结果的开头**，
 * 而 exports / remember 这几个工具回的是 dict —— 于是过程面板里铺出的是
 * `{"artifact_id": "art_89cb…", "name": …}` 这样的原文（用户报的
 * "工具调用的 UI 排版很有问题"）。后端已经给它们补了人话摘要，这一条是给
 * **v0.26 之前存下的快照**兜底，顺带也是"以后哪个工具忘了写摘要"的安全网：
 * 宁可那一行什么都不写，也不要把 JSON 当句子印出来。
 * 原始载荷没丢——点开这一步的「入参 / 返回」就是它。
 */
const detailIsRawJson = computed(() => /^\s*\{\s*"[\w.]+"\s*:/.test(props.step.detail || ''))
</script>

<template>
  <li class="step" :class="{ 'step-empty': step.empty, 'step-child': variant === 'child' }">
    <span v-if="variant === 'child'" class="step-dot" aria-hidden="true" />
    <span v-else class="step-icon">
      <component :is="icons[step.icon]" :size="13" />
    </span>
    <div class="step-body">
      <!--
        **组内的一次调用不再重复工具名**（v0.26）：外面那一行已经写着「联网搜索 8 次」，
        里面八行各再写一遍「联网搜索」只是把同一个词印八次。这里直接给**结果本身**
        （detail：查的什么词、命中几条），要展开原文就点左边那个箭头。
        没有 detail 的（少数工具不给自己的人话摘要）才退回显示标签。
      -->
      <button
        v-if="hasDetail && variant === 'child'"
        type="button"
        class="step-child-toggle"
        :aria-expanded="open"
        :aria-label="`${step.label}的原文`"
        @click="emit('toggle')"
      >
        <IconChevronDown class="step-caret" :class="{ 'step-caret-open': open }" :size="12" />
      </button>

      <!--
        有原文的那一步是**可点的**（v0.25，照 Kimi）：默认只显示 `detail` 那一行结论
        （「命中 8 段」），点开才看模型传了什么参数、工具返回了什么。只给结论的话，
        用户没法判断"检索知识库"这次查的是什么词、为什么没命中。
      -->
      <button
        v-else-if="hasDetail"
        type="button"
        class="step-label step-toggle"
        :aria-expanded="open"
        @click="emit('toggle')"
      >
        {{ step.label }}
        <IconChevronDown class="step-caret" :class="{ 'step-caret-open': open }" :size="12" />
      </button>
      <p v-else-if="!(variant === 'child' && step.detail)" class="step-label">
        {{ step.label }}
      </p>
      <!-- 结论里全是网址（搜索结果的 [1] … https://…）：**渲染成可点的链接**（v0.26）。
           这些是工具的原始摘要、不是 Markdown，所以走 `LinkText` 而不是 Markdown 渲染器——
           套一层 Markdown 会把摘要里的 `*`、`_`、`|` 当成标记吃掉。 -->
      <LinkText v-if="step.detail && !detailIsRawJson" class="step-detail" :text="step.detail" />

      <!-- 入参与返回是**原始载荷**（JSON / 工具正文），所以走等宽 `<pre>`，
           但里面的网址同样要能点（v0.26）——搜索结果的**完整地址只在这一层**，
           上面那行结论早被裁到 120 字、大多只剩半截。 -->
      <div v-if="hasDetail && open" class="step-raw">
        <template v-if="step.args">
          <p class="step-raw-label">入参</p>
          <pre class="step-raw-body"><LinkText :text="step.args" /></pre>
        </template>
        <template v-if="step.result">
          <p class="step-raw-label">返回</p>
          <pre class="step-raw-body"><LinkText :text="step.result" /></pre>
        </template>
      </div>
    </div>
  </li>
</template>

<style scoped src="src/components/chat/trace-row.css"></style>

<style scoped>
/*
 * 这一行**自己的**那点样式（外壳在 `trace-row.css`，与组的表头共用一份）。
 *
 * v0.26 把整行的样式从 `ChatView` 搬进这个组件时，组那一行（还留在 ChatView
 * 的 `.step-group`）没有跟着搬——它的图标掉了圆底、标签起始线也上下错开。
 * 所以外壳那几条现在单独放一份文件，两边 `<style scoped src>` 引同一份。
 */
/* 没有新增资料的检索轮次：压暗一档。它和"找到了新东西"的那几轮价值不同，
   一样重会让人以为每一轮都有收获 */
.step-empty .step-label,
.step-empty .step-detail {
  color: var(--text-tertiary);
}

.step-detail {
  /* `LinkText` 的根是个 `<span>`，而这里要的是**独占一行**（标签可能是 inline-flex 的按钮）。
     不给 `display: block` 的话，结论会跟在标签后面同一行上。 */
  display: block;
  margin: var(--space-pair) 0 0;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
  overflow-wrap: anywhere;
}

/* 可点的那一步：标签本身就是按钮。**不加下划线也不加底色**——
   整块过程面板里已经有"有没有收获"的层级（`.step-empty` 的弱化），
   再给每行加一个可点的装饰，这一列会变成一排按钮。




/* 原文（入参 / 返回）：**限高滚动**。它动辄上千字，全铺出来会把过程面板
   变成一屏 JSON——那正是这一轮要摆脱的东西。 */
/* 原文（入参 / 返回）：**限高滚动**。它动辄上千字，全铺出来会把过程面板
   变成一屏 JSON——那正是这一轮要摆脱的东西。 */

.step-raw {
  margin: var(--space-1) 0 0;
}

.step-raw-label {
  margin: var(--space-2) 0 var(--space-1);
  font-size: var(--text-micro-size);
  color: var(--text-quaternary);
}

.step-raw-body {
  margin: 0;
  padding: var(--space-2);
  max-height: 220px;
  overflow: auto;
  background: var(--bg-subtle);
  border-radius: var(--radius-control);
  font-family: var(--font-mono);
  font-size: var(--text-micro-size);
  line-height: var(--line-code);
  color: var(--text-secondary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
/* 分组展开后的一次调用：缩进一档、图标位换成小圆点。
   点比图标轻——它们归属上面那一行，不该各自再抢一次注意力。 */
.step-child {
  padding-left: var(--space-4);
}

/* 组内那一次的布局：箭头（可点）+ 结果。**箭头在左**，
   与上面那一行的图标位对齐——一列竖着看下来是一条线。 */
.step-child .step-body {
  display: flex;
  align-items: flex-start;
  gap: var(--space-1);
}

.step-child .step-detail {
  margin-top: 0;
  flex: 1;
  min-width: 0;
}

.step-child-toggle {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: var(--radius-control);
  background: none;
  cursor: pointer;
  transition: var(--transition-ui);
}

.step-child-toggle:hover {
  background: var(--bg-hover);
}

/* 展开的原文（入参 / 返回）在孩子里也要占满右边那一列，不能被箭头挤成窄条 */
.step-child .step-raw {
  flex: 1;
  min-width: 0;
  margin-top: 0;
}

.step-dot {
  position: relative;
  z-index: 1;
  flex: 0 0 auto;
  width: 5px;
  height: 5px;
  /* 与 `.step-icon`（21px）的中心对齐：上面那条时间轴的竖线在 left:10px 上 */
  margin: 8px 8px 0;
  border-radius: var(--radius-pill);
  background: var(--border-strong);
}
</style>
