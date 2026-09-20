<script setup lang="ts">
/**
 * 一段文本，里面的网址渲染成**可点的链接**（v0.26）。
 *
 * 用在**不适合走 Markdown 渲染**的地方——过程面板里每一步的结论
 * （「检索词：… 共 8 条： [1] … https://…」）。那些是工具的原始摘要，
 * 不是 Markdown；套一层 Markdown 渲染会把里面的 `*`、`_`、`|` 当成标记吃掉。
 *
 * **刻意不用 `v-html`**：这条路径上的文本来自**外部网页与模型**，
 * 而这里要做的事只是"把网址挑出来"，一件用模板就能做完的事。
 * 用 `v-html` 就得自己再写一遍转义与白名单，多一处能出错的地方。
 * 这里的做法是**切成段**：普通文字走插值（Vue 自己转义），网址走 `<a>`。
 *
 * 只认 `http(s)://` 与 `www.` 开头，末尾的句号、逗号、中文标点、右括号一律剥掉——
 * 与 `useMarkdown` 里那套口径**必须一致**：同一个网址在正文里和在过程里
 * 点开的是同一个地址，不能一处带句号一处不带。
 */
import { computed } from 'vue'

const props = defineProps<{ text: string }>()

/**
 * 与 `useMarkdown.BARE_URL` **同源**：`http(s)://` 或 `www.` 打头，
 * 到空白、括号或**任何中文标点**为止（中文标点出现在网址里是句子结束，不是地址的一部分）。
 */
const URL_RE = /(https?:\/\/|www\.)[^\s<>()（）「」『』【】"'。，、；：！？…]+/g

/** 网址末尾的句读一律不属于它。 */
const URL_TAIL = /[.,;:!?，。、；：！？）)】」』"']+$/

type Segment = { kind: 'text' | 'link'; value: string; href?: string }

const segments = computed<Segment[]>(() => {
  const out: Segment[] = []
  let cursor = 0
  // `matchAll` 而不是 `exec` + `lastIndex`：后者把游标存在**模块级正则对象**上，
  // 一个 computed 顺手改共享状态，是那种"两处同时渲染才发作"的 bug。
  // `matchAll` 按规范会克隆一份正则，天然没有这个问题。
  for (const match of props.text.matchAll(URL_RE)) {
    const raw = match[0]
    // **后面紧跟省略号 = 这段网址是被裁断的**：过程面板那一行由后端裁到 120 字
    // （`ToolOutcome.step_detail`），一条长结果里的网址大多只剩半截。
    // 把它做成链接，点过去只会到一个不存在的地址——**比不给链接更糟**：
    // 用户以为是自己网络的问题。跳过它，让它老老实实当一段文字。
    if (props.text[match.index + raw.length] === '…') continue
    const trimmed = raw.replace(URL_TAIL, '')
    if (!trimmed) continue
    // 网址前面的普通文字：连同被剥掉的句读一起，留给下一段
    if (match.index > cursor) {
      out.push({ kind: 'text', value: props.text.slice(cursor, match.index) })
    }
    out.push({
      kind: 'link',
      value: trimmed,
      href: trimmed.startsWith('www.') ? `https://${trimmed}` : trimmed,
    })
    cursor = match.index + trimmed.length
  }
  if (cursor < props.text.length) out.push({ kind: 'text', value: props.text.slice(cursor) })
  return out
})
</script>

<template>
  <span class="link-text"
    ><template v-for="(segment, index) in segments" :key="index"
      ><a
        v-if="segment.kind === 'link'"
        class="md-link"
        :href="segment.href"
        target="_blank"
        rel="noopener noreferrer"
        >{{ segment.value }}</a
      ><template v-else>{{ segment.value }}</template></template
    ></span
  >
</template>

<style scoped>
/* 链接的着色与下划线由宿主给（`.md-link` 是全局口径，各处 :deep 里自己定），
   这里只管它是个行内块——`overflow-wrap` 让长网址在窄列里**折行而不是撑破**。 */
.link-text {
  overflow-wrap: anywhere;
}

.link-text :deep(.md-link) {
  color: var(--accent-text);
  text-decoration: none;
}

.link-text :deep(.md-link:hover) {
  text-decoration: underline;
}
</style>
