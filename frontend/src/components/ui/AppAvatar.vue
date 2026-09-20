<script setup lang="ts">
/**
 * 头像（v0.29）：有图就显示图，没有就用**名字生成**一个。
 *
 * 三处刻意的设计：
 *
 * 1. **没有头像不等于没有身份**。默认那张是名字的首字 + 由名字定下来的底色，
 *    而不是一枚灰色小人图标——"一个叫『用户』的入口"与"这是某某"读起来是两件事。
 *    颜色从名字算（同一个名字永远同一个颜色），所以列表里一眼能分得清谁是谁。
 * 2. **中文取第一个字，英文取前两个词的字母**。"小又" → 「小」，"Ada Lovelace"
 *    → 「AL」。取错了也不会难看，只是辨识度差一点。
 * 3. **尺寸走一个变量**：`--avatar-size`，调用方按场景给（侧栏 28、名册 32）。
 *    圆角固定成圆——它是"脸"，不是方块。
 */
import { computed, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    name: string
    /** 头像链接（后端签发的签名 URL）。空 = 用生成的那张。 */
    url?: string
    /** 像素尺寸；不传就跟 `--avatar-size`（28）。 */
    size?: number
  }>(),
  { url: '', size: undefined },
)

/** 图挂了（链接过期、文件没了）就退回生成的那张——**不要留一个破图**。 */
const failed = ref(false)
watch(
  () => props.url,
  () => {
    failed.value = false
  },
)

const showImage = computed(() => Boolean(props.url) && !failed.value)

/**
 * 名字 → 两个字母（中文一个字、西文两个词首字母、其余取前两位）。
 */
const initials = computed(() => {
  const text = (props.name || '').trim()
  if (!text) return '?'
  if (/[\u4e00-\u9fa5]/.test(text[0])) return text[0]
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
  return text.slice(0, 2).toUpperCase()
})

/**
 * 名字 → 底色。**同一名字永远同一色**：列表里靠颜色认人，
 * 每次渲染换一个色就等于没这个功能。
 *
 * 色相按名字的字符和取模（稳定、分布够散），饱和度与明度固定成同一档——
 * 深浅不一的头像放在一起会显得脏，而那与"这是谁"无关。
 */
const tone = computed(() => {
  let sum = 0
  for (const char of props.name || '?') sum = (sum * 31 + char.codePointAt(0)!) % 360
  return sum
})

const style = computed(() => ({
  ...(props.size ? { '--avatar-size': `${props.size}px` } : {}),
  background: `hsl(${tone.value} 42% 46%)`,
}))
</script>

<template>
  <span class="avatar" :style="style" :title="name">
    <img v-if="showImage" :src="url" :alt="name" @error="failed = true" />
    <span v-else class="avatar-initials" aria-hidden="true">{{ initials }}</span>
  </span>
</template>

<style scoped>
.avatar {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: var(--avatar-size, 28px);
  height: var(--avatar-size, 28px);
  overflow: hidden;
  border-radius: var(--radius-pill);
  color: #fff;
  /* 首字是给"没有图"兜底的，字号按尺寸走——28px 的圆里塞 15px 的字刚好 */
  font-size: calc(var(--avatar-size, 28px) * 0.42);
  font-weight: 600;
  line-height: 1;
  user-select: none;
}

.avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
</style>
