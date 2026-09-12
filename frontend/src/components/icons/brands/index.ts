/**
 * 供应商品牌图标（预设 id → 组件）。
 *
 * 后端只下发预设**数据**（id / 名称 / 地址），图标是前端资产，两边按 `id` 对应。
 * 认不出的 id 退回通用服务器图标——界面不该因为注册表里多了一条预设就报错或空着。
 *
 * 图标来源与许可见同目录 README（LobeHub Icons，MIT）。
 */

import type { Component } from 'vue'

import IconServer from '@/components/icons/IconServer.vue'

import IconBrandAnthropic from './IconBrandAnthropic.vue'
import IconBrandBailian from './IconBrandBailian.vue'
import IconBrandDeepseek from './IconBrandDeepseek.vue'
import IconBrandGemini from './IconBrandGemini.vue'
import IconBrandMoonshot from './IconBrandMoonshot.vue'
import IconBrandOllama from './IconBrandOllama.vue'
import IconBrandOpenai from './IconBrandOpenai.vue'
import IconBrandSiliconflow from './IconBrandSiliconflow.vue'
import IconBrandXai from './IconBrandXai.vue'
import IconBrandZhipu from './IconBrandZhipu.vue'

/** 键与 `services/provider_presets.py` 里的预设 id 一一对应。 */
export const BRAND_ICONS: Record<string, Component> = {
  deepseek: IconBrandDeepseek,
  dashscope: IconBrandBailian,
  moonshot: IconBrandMoonshot,
  zhipu: IconBrandZhipu,
  siliconflow: IconBrandSiliconflow,
  openai: IconBrandOpenai,
  anthropic: IconBrandAnthropic,
  gemini: IconBrandGemini,
  xai: IconBrandXai,
  ollama: IconBrandOllama,
}

/** 取品牌图标；未知 id（含"自定义"）给通用图标，不返回空。 */
export function providerIcon(id: string): Component {
  return BRAND_ICONS[id] ?? IconServer
}
