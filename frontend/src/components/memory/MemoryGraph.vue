<script setup lang="ts">
/**
 * 记忆图谱（wikilink 关系，v0.14 三期）。
 *
 * 这一层只管**画**：节点怎么摆、分量怎么排全在 `graphLayout.ts` 里算好了
 * （纯函数、确定性、可单测）。放在那里是因为"摆得对不对"是这一页最该被钉住的
 * 东西，而它不该需要挂载一个组件才能测。
 *
 * 颜色只作辅助（《前端设计规范》§7）：节点类别另有图例，每个节点还有 title 提示。
 *
 * **尺寸用固有值**（`width`/`height` 属性 + `max-width: 100%`），不是 `width: 100%`：
 * 后者会让浏览器按 viewBox 把整张图放大到铺满，节点与文字一起变成巨型、标签被裁
 * （实测过）。放不下时才按比例缩小——缩小没问题，放大才是错的。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import type { MemoryGraph } from '@/api/memory'
import { layoutGraph } from '@/components/memory/graphLayout'

const props = withDefaults(defineProps<{ graph: MemoryGraph; selected?: string | null }>(), {
  selected: null,
})

const emit = defineEmits<{ (event: 'select', path: string): void }>()

const canvas = ref<HTMLElement | null>(null)
const available = ref(0)
let observer: ResizeObserver | null = null

/**
 * 量一下画布有多宽，交给布局去决定间距放大多少（见 `LayoutOptions.width`）。
 *
 * 用 ResizeObserver 而不是读一次 `clientWidth`：侧栏折叠、窗口缩放、
 * 设置弹窗改变内边距都会让宽度变，读一次的话图就停在旧尺寸上了。
 */
onMounted(() => {
  const element = canvas.value
  if (!element) return
  available.value = element.clientWidth
  observer = new ResizeObserver((entries) => {
    const width = entries[0]?.contentRect.width ?? 0
    if (width > 0) available.value = width
  })
  observer.observe(element)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
})

const layout = computed(() =>
  layoutGraph(props.graph.nodes, props.graph.edges, { width: available.value }),
)
</script>

<template>
  <div class="graph">
    <!-- 画布铺满整行（图在里面居中）：灰色底只包住图本身时，一张两三个节点的图
         会在页面上留下一小块"孤岛"，看起来像没画完。 -->
    <div ref="canvas" class="graph-canvas">
      <svg
        v-if="layout.placed.length"
        :viewBox="layout.viewBox"
        :width="layout.width"
        :height="layout.height"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="记忆之间的链接关系图"
      >
        <g class="graph-links">
          <line
            v-for="link in layout.links"
            :key="link.key"
            :x1="link.x1"
            :y1="link.y1"
            :x2="link.x2"
            :y2="link.y2"
          />
        </g>
        <g class="graph-nodes">
          <g
            v-for="item in layout.placed"
            :key="item.node.path"
            class="graph-node"
            :class="[`kind-${item.node.kind}`, { selected: selected === item.node.path }]"
            :transform="`translate(${item.x} ${item.y})`"
            role="button"
            tabindex="0"
            @click="emit('select', item.node.path)"
            @keydown.enter="emit('select', item.node.path)"
          >
            <circle :r="item.r" />
            <title>{{ `${item.node.path}（${item.node.degree} 条链接）` }}</title>
            <text v-if="item.labelled" :y="item.r + 14">
              {{ item.node.title || item.node.path }}
            </text>
          </g>
        </g>
      </svg>

      <p v-else class="graph-empty">
        还没有链接。在记忆正文里写 <code>[[另一份记忆]]</code>，两份记忆就会连起来。
      </p>
    </div>

    <div class="graph-foot">
      <ul class="graph-legend">
        <li><span class="dot kind-core"></span>核心（注入）</li>
        <li><span class="dot kind-daily"></span>每日现场（可召回）</li>
        <li><span class="dot kind-digest"></span>长期知识（可召回）</li>
        <li><span class="dot kind-other"></span>其它</li>
      </ul>
      <p class="text-micro">圆越大 = 连的链接越多。点一个节点可跳到那份记忆。</p>
    </div>

    <p v-if="graph.dangling.length" class="graph-dangling">
      有 {{ graph.dangling.length }} 条链接指向不存在的文件：
      <span
        v-for="(item, at) in graph.dangling"
        :key="`${item[0]}-${item[1]}-${at}`"
        class="dangling-item"
      >
        <code>{{ item[0] }}</code> → <code>{{ item[1] }}</code>
      </span>
    </p>
  </div>
</template>

<style scoped>
.graph {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.graph-canvas {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 300px;
  padding: var(--space-4);
  /* 用 Bg-Secondary 而不是 BgGp-Secondary：后者在浅色下就是 #fff，
     与面板同色，整条画布会"消失"（看不出边界）。 */
  background: var(--bg-subtle);
  border-radius: var(--radius-panel);
}

.graph-canvas svg {
  display: block;
  /* 只在放不下时缩小（见组件头：放大是错的）。
     宽度超过容器时，二者共同作用会保持长宽比地缩放。 */
  max-width: 100%;
  height: auto;
}

.graph-links line {
  stroke: var(--Separators-S1);
  stroke-width: 1;
}

/* 节点用中性填充、类别靠图例分辨；悬停/选中用品牌蓝描边（小面积强调）。
   填充取 Fills-F3 而不是 Fills-F2：后者在浅色下叠在 #f5f5f5 上几乎看不见，
   而"看不见的节点"比"颜色不够讲究"糟得多。颜色只作辅助（规范 §7），
   所以每个节点都有 title，类别另有图例。 */
.graph-node circle {
  fill: var(--Fills-F3);
  stroke: var(--Separators-S1);
  stroke-width: 1;
  cursor: pointer;
  transition: var(--transition-ui);
}

.graph-node.kind-core circle {
  fill: var(--Labels-Primary);
}

.graph-node.kind-digest circle {
  fill: var(--heat-2);
}

.graph-node:hover circle,
.graph-node.selected circle {
  stroke: var(--Colors-KMBlue);
  stroke-width: 2;
}

.graph-node text {
  fill: var(--text-secondary);
  /* 用 micro（12px）而不是 c2（10px）：10px 在 1:1 的画布上几乎读不出来，
     而在这里读不出名字就等于没有名字。 */
  font-size: var(--text-micro-size);
  text-anchor: middle;
  pointer-events: none;
}

.graph-empty {
  margin: 0;
  padding: var(--space-8) 0;
  color: var(--text-secondary);
}

.graph-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
}

.graph-legend {
  display: flex;
  gap: var(--space-4);
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: var(--text-micro-size);
  color: var(--text-secondary);
}

.graph-legend li {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--Separators-S1);
  background: var(--Fills-F3);
}

.dot.kind-core {
  background: var(--Labels-Primary);
}

.dot.kind-digest {
  background: var(--heat-2);
}

.graph-dangling {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin: 0;
  font-size: var(--text-micro-size);
  color: var(--text-secondary);
}

.dangling-item code {
  font-family: var(--font-mono);
}
</style>
