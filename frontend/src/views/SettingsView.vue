<script setup lang="ts">
/**
 * 设置页（《前端设计规范 v0.3》§6）：分组列表 + 右对齐控件。
 *
 * 每一项都是"标签 + 描述灰字 + 控件"三段式。当前只读展示服务端配置——
 * 解析节点、API Key 的写入接口排在 M6/M7，这里不放点了没用的假控件。
 */
import { onMounted, ref } from 'vue'

import { fetchHealth, type HealthResponse } from '@/api/health'
import PageHeader from '@/components/ui/PageHeader.vue'
import StatusTag from '@/components/ui/StatusTag.vue'
import { useKnowledgeBaseStore } from '@/stores/knowledgeBases'

const store = useKnowledgeBaseStore()
const health = ref<HealthResponse | null>(null)
const healthError = ref('')

onMounted(async () => {
  if (store.items.length === 0) await store.load()
  try {
    health.value = await fetchHealth()
  } catch (error) {
    healthError.value = error instanceof Error ? error.message : '后端不可达'
  }
})

/** 当前实例的模型信息取自已有知识库：每个库一套 embedding 配置（架构 §6.4）。 */
function modelSummary(): string {
  const models = new Set(
    store.items.map((kb) => `${kb.embedding_model_id} (${kb.embedding_dim} 维)`),
  )
  if (models.size === 0) return '还没有知识库'
  return [...models].join('、')
}
</script>

<template>
  <article class="page">
    <PageHeader
      title="设置"
      description="当前为只读视图：可写配置项随 M6/M7 的配置接口一起开放。"
    />

    <section class="page-body">
      <h2 class="group-title">服务</h2>
      <ul class="setting-list">
        <li class="setting-row">
          <div class="setting-main">
            <span class="setting-label">后端状态</span>
            <span class="setting-hint">Web 控制台通过 /api/v1 访问本机服务</span>
          </div>
          <div class="setting-control">
            <StatusTag v-if="health" tone="success" :label="`在线 · v${health.version}`" />
            <StatusTag v-else tone="danger" :label="healthError || '检测中'" />
          </div>
        </li>
        <li class="setting-row">
          <div class="setting-main">
            <span class="setting-label">接口版本</span>
            <span class="setting-hint">REST 路径统一带版本前缀，避免升级时打断调用方</span>
          </div>
          <div class="setting-control">{{ health?.api_version ?? '—' }}</div>
        </li>
      </ul>

      <h2 class="group-title">检索与模型</h2>
      <ul class="setting-list">
        <li class="setting-row">
          <div class="setting-main">
            <span class="setting-label">embedding 模型</span>
            <span class="setting-hint">
              维度是知识库级属性；库内已有向量后换模型会被拒绝（架构 §6.4）
            </span>
          </div>
          <div class="setting-control setting-control-text">{{ modelSummary() }}</div>
        </li>
        <li class="setting-row">
          <div class="setting-main">
            <span class="setting-label">rerank</span>
            <span class="setting-hint">
              在检索调试台按次开启；rerank 调用失败会自动退回 RRF 顺序，不影响可用性
            </span>
          </div>
          <div class="setting-control">按次开启</div>
        </li>
      </ul>

      <h2 class="group-title">存储</h2>
      <ul class="setting-list">
        <li class="setting-row">
          <div class="setting-main">
            <span class="setting-label">全内嵌存储</span>
            <span class="setting-hint">
              SQLite（元数据）+ sqlite-vec（向量）+ FTS5（全文）+ 本地文件系统（原文与图片）
            </span>
          </div>
          <div class="setting-control">无需外部服务</div>
        </li>
        <li class="setting-row">
          <div class="setting-main">
            <span class="setting-label">知识库数量</span>
            <span class="setting-hint">数据目录由后端 KYLAB_DATA_DIR 决定</span>
          </div>
          <div class="setting-control">{{ store.items.length }}</div>
        </li>
      </ul>

      <h2 class="group-title">尚未开放</h2>
      <ul class="setting-list">
        <li class="setting-row">
          <div class="setting-main">
            <span class="setting-label">解析节点与 API Key</span>
            <span class="setting-hint">云端解析渠道的凭据配置随 M6 一起接入</span>
          </div>
          <div class="setting-control"><StatusTag tone="neutral" label="待接入" /></div>
        </li>
        <li class="setting-row">
          <div class="setting-main">
            <span class="setting-label">访问鉴权</span>
            <span class="setting-hint">
              当前无鉴权，只应在本机使用；投入局域网前必须先补 API Key
            </span>
          </div>
          <div class="setting-control"><StatusTag tone="warning" label="未启用" /></div>
        </li>
      </ul>
    </section>
  </article>
</template>

<style scoped>
.page {
  max-width: var(--content-reading-width);
  margin: 0 auto;
  padding: 32px 24px 64px;
}

.page-body {
  margin-top: 20px;
}

.group-title {
  margin: 24px 0 8px;
  font-size: 16px;
}

.group-title:first-child {
  margin-top: 0;
}

.setting-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 12px 0;
  border-bottom: 1px solid var(--border);
}

.setting-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.setting-label {
  font-size: 14px;
}

.setting-hint {
  font-size: 12px;
  color: var(--text-secondary);
}

.setting-control {
  flex: 0 0 auto;
  color: var(--text-secondary);
}

.setting-control-text {
  max-width: 320px;
  text-align: right;
  overflow-wrap: anywhere;
}
</style>
