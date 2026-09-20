<!--
  外观（本地偏好，不进后端）。

  **它现在是独立组件**：主题与字号都是本地偏好，读的是 composable、不碰设置接口——
  所以这一节不需要任何 props/emits，也不需要自己的样式（分节共用样式在
  `settings.css` 里按 `.settings …` 命名空间生效，见那个文件的头注）。
-->
<script setup lang="ts">
import { computed } from 'vue'

import { setTheme, themeMode, type ThemeMode } from '@/composables/useTheme'
import { useFontScale } from '@/composables/useFontScale'
import InfoTip from '@/components/ui/InfoTip.vue'

// 字号是本地偏好，不进后端：直接读 composable，不做 save 流程
const { scale: fontScale, options: fontOptions, setFontScale } = useFontScale()
const currentScaleHint = computed(
  () => fontOptions.find((item) => item.name === fontScale.value)?.hint ?? '',
)

/** 主题三档：与字号同样用卡片式选择器。 */
const THEME_OPTIONS: { name: ThemeMode; label: string; hint: string }[] = [
  { name: 'system', label: '跟随系统', hint: '随设备明暗自动切换' },
  { name: 'light', label: '浅色', hint: '始终使用纸白' },
  { name: 'dark', label: '深色', hint: '始终使用近黑' },
]
</script>

<template>
  <h3 class="section-title">
    外观
    <InfoTip text="主题与字号只影响这一台机器的浏览器，存在本地，不写进知识库配置。" />
  </h3>

  <div class="row row-static">
    <div class="row-main">
      <span class="row-label">主题</span>
      <span class="row-value">
        {{ THEME_OPTIONS.find((item) => item.name === themeMode)?.hint ?? '' }}
      </span>
    </div>
  </div>

  <div class="scale-picker" role="group" aria-label="主题">
    <button
      v-for="item in THEME_OPTIONS"
      :key="item.name"
      class="scale-option"
      :class="{ 'scale-option-active': themeMode === item.name }"
      type="button"
      :aria-pressed="themeMode === item.name"
      @click="setTheme(item.name)"
    >
      <span class="scale-label">{{ item.label }}</span>
      <span class="scale-size">{{ item.hint }}</span>
    </button>
  </div>

  <h3 class="section-title section-gap">正文字号</h3>
  <div class="row row-static">
    <div class="row-main">
      <span class="row-label">字号档位</span>
      <span class="row-value">{{ currentScaleHint }}</span>
    </div>
  </div>

  <div class="scale-picker" role="group" aria-label="正文字号">
    <button
      v-for="item in fontOptions"
      :key="item.name"
      class="scale-option"
      :class="{ 'scale-option-active': fontScale === item.name }"
      type="button"
      :aria-pressed="fontScale === item.name"
      @click="setFontScale(item.name)"
    >
      <span class="scale-label">{{ item.label }}</span>
      <span class="scale-size tabular">{{ item.bodySize }}px</span>
    </button>
  </div>
</template>
