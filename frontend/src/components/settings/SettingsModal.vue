<script setup lang="ts">
/**
 * 设置弹窗（《前端设计规范》§5、《界面信息架构草案》§3）。
 *
 * 为什么设置从页面变成弹窗：设置是**动作**——改完就走，不需要一个常驻的地址，
 * 也不需要用户在改完模型之后还要"离开设置页"。侧栏底部一个入口点开即可，
 * 改完关掉，回到他原来在看的页面。
 *
 * 内部用左侧分组菜单 + 右侧内容：
 * - 模型配置（向量化 / 重排）
 * - 对话模型（LLM / 对话行为）
 * - 服务配置（MinerU / PaddleOCR）
 * - 存储配置（只读）
 * - 系统与安全（只读）
 *
 * 密钥永不回显明文：接口给掩码，输入框留空表示"不改动"。
 */
import { computed, onMounted, ref, watch } from 'vue'

import { fetchHealth, type HealthResponse } from '@/api/health'
import {
  getSettings,
  testConnection,
  updateSettings,
  type SettingGroup,
  type SettingsView,
} from '@/api/settings'
import IconCheck from '@/components/icons/IconCheck.vue'
import IconRefresh from '@/components/icons/IconRefresh.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppModal from '@/components/ui/AppModal.vue'
import StatusTag from '@/components/ui/StatusTag.vue'
import { useToast } from '@/composables/useToast'
import { useKnowledgeBaseStore } from '@/stores/knowledgeBases'

const open = defineModel<boolean>('open', { required: true })

type SectionKey = 'models' | 'llm' | 'services' | 'storage' | 'system'

const SECTIONS: { key: SectionKey; label: string; hint: string }[] = [
  { key: 'models', label: '模型配置', hint: '向量化与重排' },
  { key: 'llm', label: '对话模型', hint: 'LLM 与提示词' },
  { key: 'services', label: '服务配置', hint: '云端解析节点' },
  { key: 'storage', label: '存储配置', hint: '元数据与向量' },
  { key: 'system', label: '系统与安全', hint: '版本与鉴权' },
]

const store = useKnowledgeBaseStore()
const { notifySuccess, notifyError } = useToast()

const section = ref<SectionKey>('models')
const health = ref<HealthResponse | null>(null)
const healthError = ref('')
const config = ref<SettingsView | null>(null)
const loadError = ref('')

/** 正在编辑的分组（null = 仍在浏览态）。 */
const editing = ref<SettingGroup | null>(null)
const draft = ref<Record<string, string>>({})
const saving = ref(false)
const testing = ref(false)
const testResult = ref<{ ok: boolean; detail: string } | null>(null)

// 每次打开都重新读一次：配置可能被另一个标签页改过，也可能后端刚重启
watch(open, (value) => {
  if (value) void refresh()
})

onMounted(() => {
  if (open.value) void refresh()
})

async function refresh(): Promise<void> {
  try {
    health.value = await fetchHealth()
    healthError.value = ''
  } catch (error) {
    healthError.value = error instanceof Error ? error.message : '后端不可达'
  }
  try {
    config.value = await getSettings()
    loadError.value = ''
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : '配置读取失败'
  }
}

function group(key: string): SettingGroup | undefined {
  return config.value?.groups.find((item) => item.key === key)
}

function fieldValue(groupKey: string, fieldKey: string): string {
  return group(groupKey)?.fields.find((item) => item.key === fieldKey)?.value ?? ''
}

function isConfigured(groupKey: string, fieldKey: string): boolean {
  return group(groupKey)?.fields.find((item) => item.key === fieldKey)?.configured ?? false
}

function secretSummary(groupKey: string, fieldKey: string): string {
  return isConfigured(groupKey, fieldKey) ? fieldValue(groupKey, fieldKey) : '未配置'
}

const embeddingConfigured = computed(() => isConfigured('embedding', 'embedding.api_key'))

/**
 * 浏览态的对话模型连通性测试。
 *
 * 与编辑态的 `testResult` 分开：编辑态测的是"输入框里这一份"，浏览态测的是
 * "线上正在用的这一份"。共用一个变量的话，在编辑态点过测试再返回，
 * 浏览态会继续显示上一份配置的结论——那比不显示更容易误导。
 */
const llmTest = ref<{ ok: boolean; detail: string } | null>(null)
const llmTesting = ref(false)

async function testLlm(): Promise<void> {
  llmTesting.value = true
  try {
    llmTest.value = await testConnection('llm')
  } catch (error) {
    llmTest.value = { ok: false, detail: error instanceof Error ? error.message : '测试失败' }
  } finally {
    llmTesting.value = false
  }
}

/** 「对话行为」一行里显示提示词的开头：它只是给个印象，完整内容在编辑态里。 */
const PROMPT_SNIPPET = 40

const promptSummary = computed(() => {
  const value = fieldValue('chat', 'chat.system_prompt').trim()
  if (!value) return '用内置提示词'
  return value.length > PROMPT_SNIPPET ? `${value.slice(0, PROMPT_SNIPPET)}…` : value
})

function openEdit(target: SettingGroup): void {
  editing.value = target
  testResult.value = null
  const next: Record<string, string> = {}
  for (const field of target.fields) {
    next[field.key] = field.type === 'secret' ? '' : field.value
  }
  draft.value = next
}

async function save(): Promise<void> {
  if (!editing.value) return
  const values = editing.value.fields.map((field) => ({
    key: field.key,
    value: draft.value[field.key] ?? '',
  }))

  saving.value = true
  try {
    const result = await updateSettings(values)
    if (result.rejected.length > 0) {
      notifyError(`以下配置项不被接受：${result.rejected.join('、')}`)
      return
    }
    notifySuccess('配置已保存，下一个任务即刻生效')
    editing.value = null
    await refresh()
  } catch (error) {
    notifyError(error instanceof Error ? error.message : '保存失败')
  } finally {
    saving.value = false
  }
}

async function runTest(target: string): Promise<void> {
  testing.value = true
  testResult.value = null
  try {
    testResult.value = await testConnection(target)
  } catch (error) {
    testResult.value = {
      ok: false,
      detail: error instanceof Error ? error.message : '测试失败',
    }
  } finally {
    testing.value = false
  }
}
</script>

<template>
  <AppModal v-model:open="open" size="wide" height="tall" title="设置">
    <div class="settings">
      <!-- 左：分组菜单。设置项会越来越多，平铺下去没人找得到 -->
      <nav class="settings-nav" aria-label="设置分组">
        <button
          v-for="item in SECTIONS"
          :key="item.key"
          class="nav-entry"
          :class="{ 'nav-entry-active': section === item.key }"
          type="button"
          @click="((section = item.key), (editing = null))"
        >
          <span class="nav-label">{{ item.label }}</span>
          <span class="nav-hint">{{ item.hint }}</span>
        </button>
      </nav>

      <!-- 右：内容 -->
      <div class="settings-body">
        <p v-if="loadError" class="error-line">{{ loadError }}</p>

        <!-- 模型配置 -->
        <template v-if="section === 'models'">
          <template v-if="editing?.key === 'embedding' || editing?.key === 'rerank'">
            <h3 class="section-title">编辑 {{ editing.label }}</h3>
            <div class="edit-form">
              <label v-for="field in editing.fields" :key="field.key" class="edit-field">
                <span class="edit-label">
                  {{ field.label }}
                  <span v-if="field.type === 'secret' && field.configured" class="edit-current">
                    当前 {{ field.value }}
                  </span>
                </span>
                <AppInput
                  v-model="draft[field.key]"
                  :type="field.type === 'int' ? 'number' : 'text'"
                  :placeholder="field.type === 'secret' ? '留空表示不改动' : ''"
                />
              </label>
              <p v-if="editing.key === 'embedding'" class="edit-hint">
                维度必须与模型实际输出一致（bge-m3 为 1024）。库内已有向量后再改模型会被拒绝（架构
                §6.4）。
              </p>
              <div
                v-if="testResult"
                class="test-result"
                :class="testResult.ok ? 'test-ok' : 'test-bad'"
              >
                <IconCheck v-if="testResult.ok" :size="14" />
                <span>{{ testResult.detail }}</span>
              </div>
            </div>
            <div class="edit-actions">
              <AppButton :disabled="testing" @click="runTest(editing.key)">
                <template #icon><IconRefresh /></template>
                {{ testing ? '测试中…' : '测试连接' }}
              </AppButton>
              <AppButton @click="editing = null">返回</AppButton>
              <AppButton variant="primary" :disabled="saving" @click="save">
                {{ saving ? '保存中…' : '保存' }}
              </AppButton>
            </div>
          </template>

          <template v-else>
            <h3 class="section-title">模型配置</h3>
            <div class="row">
              <div class="row-main">
                <span class="row-label">向量化</span>
                <span class="row-value">
                  {{ fieldValue('embedding', 'embedding.model_id') || '未指定模型'
                  }}<span class="sep">·</span>{{ config?.embedding_dim ?? '—' }} 维<span class="sep"
                    >·</span
                  ><span :class="{ 'text-warn': !embeddingConfigured }">{{
                    secretSummary('embedding', 'embedding.api_key')
                  }}</span>
                </span>
              </div>
              <StatusTag
                v-if="config"
                :tone="config.embedding_is_development ? 'warning' : 'success'"
                :label="config.embedding_is_development ? '开发兜底' : '已启用'"
              />
              <AppButton v-if="group('embedding')" @click="openEdit(group('embedding')!)">
                编辑
              </AppButton>
            </div>
            <p v-if="config?.embedding_is_development" class="row-note">
              未配置 API Key，当前用确定性哈希兜底：只有词面重叠、没有语义，检索质量不代表真实效果。
            </p>

            <div class="row">
              <div class="row-main">
                <span class="row-label">重排 rerank</span>
                <span class="row-value">
                  {{ fieldValue('rerank', 'rerank.model_id') || '未指定模型'
                  }}<span class="sep">·</span>{{ secretSummary('rerank', 'rerank.api_key') }}
                </span>
              </div>
              <StatusTag
                :tone="config?.rerank_enabled ? 'success' : 'neutral'"
                :label="config?.rerank_enabled ? '已启用' : '未启用'"
              />
              <AppButton v-if="group('rerank')" @click="openEdit(group('rerank')!)">编辑</AppButton>
            </div>
            <p class="row-note">
              未配置时整体跳过重排，不影响检索可用性（失败也会退回 RRF 顺序）。
            </p>
          </template>
        </template>

        <!-- 对话模型：LLM 与提示词 -->
        <template v-else-if="section === 'llm'">
          <template v-if="editing">
            <h3 class="section-title">编辑 {{ editing.label }}</h3>
            <div class="edit-form">
              <template v-for="field in editing.fields" :key="field.key">
                <!--
                  布尔项不能走 AppInput：文本域里的 "false" 是非空字符串，
                  一不小心就写成了"开启"。复选框是唯一不会说反的控件。
                -->
                <label v-if="field.type === 'bool'" class="edit-check">
                  <input
                    type="checkbox"
                    :checked="draft[field.key] === 'true'"
                    @change="
                      draft[field.key] = ($event.target as HTMLInputElement).checked
                        ? 'true'
                        : 'false'
                    "
                  />
                  <span>{{ field.label }}</span>
                </label>
                <label v-else class="edit-field">
                  <span class="edit-label">
                    {{ field.label }}
                    <span v-if="field.type === 'secret' && field.configured" class="edit-current">
                      当前 {{ field.value }}
                    </span>
                  </span>
                  <AppInput
                    v-model="draft[field.key]"
                    :multiline="field.type === 'textarea'"
                    :rows="5"
                    :type="field.type === 'int' ? 'number' : 'text'"
                    :placeholder="field.type === 'secret' ? '留空表示不改动' : ''"
                  />
                </label>
              </template>

              <p v-if="editing.key === 'llm'" class="edit-hint">
                推理模型打开深度思考后会更慢、更费 token，并且需要把「最大回复长度」调大，
                否则可能只返回思考过程、不返回正文。
              </p>
              <p v-else class="edit-hint">
                留空即恢复内置提示词：内置版本要求模型只依据资料作答，并在引用处标出资料编号。
              </p>

              <div
                v-if="testResult"
                class="test-result"
                :class="testResult.ok ? 'test-ok' : 'test-bad'"
              >
                <IconCheck v-if="testResult.ok" :size="14" />
                <span>{{ testResult.detail }}</span>
              </div>
            </div>
            <div class="edit-actions">
              <AppButton v-if="editing.key === 'llm'" :disabled="testing" @click="runTest('llm')">
                <template #icon><IconRefresh /></template>
                {{ testing ? '测试中…' : '测试连接' }}
              </AppButton>
              <AppButton @click="editing = null">返回</AppButton>
              <AppButton variant="primary" :disabled="saving" @click="save">
                {{ saving ? '保存中…' : '保存' }}
              </AppButton>
            </div>
          </template>

          <template v-else>
            <h3 class="section-title">对话模型（LLM）</h3>
            <p class="section-note">
              对话页用它把检索到的原文读成回答。没配好时「对话」会直接报错，
              不会给出没有依据的答案——这一层是刻意不兜底的。
            </p>

            <div class="row">
              <div class="row-main">
                <span class="row-label">对话模型</span>
                <span class="row-value">
                  {{ fieldValue('llm', 'llm.model_id') || '未指定模型' }}<span class="sep">·</span
                  >{{ secretSummary('llm', 'llm.api_key') }}
                </span>
              </div>
              <StatusTag
                :tone="isConfigured('llm', 'llm.api_key') ? 'success' : 'warning'"
                :label="isConfigured('llm', 'llm.api_key') ? '已配置' : '未配置'"
              />
              <AppButton :disabled="llmTesting" @click="testLlm">
                <template #icon><IconRefresh /></template>
                {{ llmTesting ? '测试中…' : '测试连接' }}
              </AppButton>
              <AppButton v-if="group('llm')" @click="openEdit(group('llm')!)">编辑</AppButton>
            </div>
            <div v-if="llmTest" class="test-result" :class="llmTest.ok ? 'test-ok' : 'test-bad'">
              <IconCheck v-if="llmTest.ok" :size="14" />
              <span>{{ llmTest.detail }}</span>
            </div>
            <p v-if="fieldValue('llm', 'llm.enable_thinking') === 'true'" class="row-note">
              已打开深度思考：回答更慢、更费 token，请确认「最大回复长度」留得足够大。
            </p>

            <h3 class="section-title section-gap">对话行为</h3>
            <div class="row">
              <div class="row-main">
                <span class="row-label">系统提示词</span>
                <span class="row-value">{{ promptSummary }}</span>
              </div>
              <span class="row-value tabular"
                >带入 {{ fieldValue('chat', 'chat.top_k') || '—' }} 条资料</span
              >
              <AppButton v-if="group('chat')" @click="openEdit(group('chat')!)">编辑</AppButton>
            </div>
            <p class="row-note">
              「带入资料的条数」决定一次对话给模型看几段原文：条数越多依据越全，
              但更容易把问题本身挤出上下文。
            </p>
          </template>
        </template>

        <!-- 服务配置 -->
        <template v-else-if="section === 'services'">
          <template v-if="editing && ['mineru', 'paddleocr'].includes(editing.key)">
            <h3 class="section-title">编辑 {{ editing.label }}</h3>
            <div class="edit-form">
              <label v-for="field in editing.fields" :key="field.key" class="edit-field">
                <span class="edit-label">
                  {{ field.label }}
                  <span v-if="field.type === 'secret' && field.configured" class="edit-current">
                    当前 {{ field.value }}
                  </span>
                </span>
                <AppInput
                  v-model="draft[field.key]"
                  type="text"
                  :placeholder="field.type === 'secret' ? '留空表示不改动' : ''"
                />
              </label>
              <div
                v-if="testResult"
                class="test-result"
                :class="testResult.ok ? 'test-ok' : 'test-bad'"
              >
                <IconCheck v-if="testResult.ok" :size="14" />
                <span>{{ testResult.detail }}</span>
              </div>
            </div>
            <div class="edit-actions">
              <AppButton :disabled="testing" @click="runTest(editing.key)">
                <template #icon><IconRefresh /></template>
                {{ testing ? '测试中…' : '测试连接' }}
              </AppButton>
              <AppButton @click="editing = null">返回</AppButton>
              <AppButton variant="primary" :disabled="saving" @click="save">
                {{ saving ? '保存中…' : '保存' }}
              </AppButton>
            </div>
          </template>

          <template v-else>
            <h3 class="section-title">服务配置</h3>
            <p class="section-note">
              两个云端解析节点互为备选：文字型文档优先 MinerU，扫描件与混合型可降级到
              PaddleOCR（架构 §4.1）。
            </p>

            <div class="row">
              <div class="row-main">
                <span class="row-label">MinerU 云端</span>
                <span class="row-value">
                  模型 {{ fieldValue('mineru', 'mineru.model_version') || '—'
                  }}<span class="sep">·</span>{{ secretSummary('mineru', 'mineru.token') }}
                </span>
              </div>
              <StatusTag
                :tone="isConfigured('mineru', 'mineru.token') ? 'success' : 'neutral'"
                :label="isConfigured('mineru', 'mineru.token') ? '已配置' : '未配置'"
              />
              <AppButton v-if="group('mineru')" @click="openEdit(group('mineru')!)">编辑</AppButton>
            </div>
            <p class="row-note">
              版面还原强，负责文字型 PDF 与 Office；单文件上限 200MB / 200 页，每日 1000
              页优先额度。
            </p>

            <div class="row">
              <div class="row-main">
                <span class="row-label">PaddleOCR 云端</span>
                <span class="row-value">
                  {{ fieldValue('paddleocr', 'paddleocr.model') || '—' }}<span class="sep">·</span
                  >{{ secretSummary('paddleocr', 'paddleocr.token') }}
                </span>
              </div>
              <StatusTag
                :tone="isConfigured('paddleocr', 'paddleocr.token') ? 'success' : 'neutral'"
                :label="isConfigured('paddleocr', 'paddleocr.token') ? '已配置' : '未配置'"
              />
              <AppButton v-if="group('paddleocr')" @click="openEdit(group('paddleocr')!)">
                编辑
              </AppButton>
            </div>
            <p class="row-note">扫描件的第二通道；MinerU 不可用时自动接管。</p>
          </template>
        </template>

        <!-- 存储配置（只读） -->
        <template v-else-if="section === 'storage'">
          <h3 class="section-title">存储配置</h3>
          <p class="section-note">
            全内嵌存储，无需外部服务。数据目录由环境变量 <code>KYLAB_DATA_DIR</code> 决定，
            改它要重启后端——这一项不适合放在界面上点。
          </p>
          <div class="row row-static">
            <div class="row-main">
              <span class="row-label">元数据</span>
              <span class="row-value">SQLite（WAL，含运行期配置与任务队列）</span>
            </div>
          </div>
          <div class="row row-static">
            <div class="row-main">
              <span class="row-label">向量</span>
              <span class="row-value">sqlite-vec，按知识库分区，维度随库</span>
            </div>
          </div>
          <div class="row row-static">
            <div class="row-main">
              <span class="row-label">全文检索</span>
              <span class="row-value">FTS5 + jieba 分词</span>
            </div>
          </div>
          <div class="row row-static">
            <div class="row-main">
              <span class="row-label">原文与图片</span>
              <span class="row-value">本地文件系统，按内容 hash 寻址</span>
            </div>
          </div>
          <div class="row row-static">
            <div class="row-main">
              <span class="row-label">知识库数量</span>
              <span class="row-value tabular">{{ store.items.length }}</span>
            </div>
          </div>
        </template>

        <!-- 系统与安全（只读） -->
        <template v-else>
          <h3 class="section-title">系统与安全</h3>
          <div class="row row-static">
            <div class="row-main">
              <span class="row-label">后端状态</span>
              <span class="row-value">
                {{
                  health
                    ? `在线 v${health.version} · ${health.api_version}`
                    : healthError || '检测中'
                }}
              </span>
            </div>
            <StatusTag :tone="health ? 'success' : 'danger'" :label="health ? '在线' : '不可达'" />
          </div>
          <div class="row row-static">
            <div class="row-main">
              <span class="row-label">访问鉴权</span>
              <span class="row-value">当前无鉴权，只应在本机使用</span>
            </div>
            <StatusTag tone="warning" label="未启用" />
          </div>
          <p class="row-note">
            投入局域网之前必须先补 API Key 鉴权与签名
            URL，否则任何能访问端口的人都能读写全部知识库。
          </p>
        </template>
      </div>
    </div>
  </AppModal>
</template>

<style scoped>
/* 左菜单 + 右内容：弹窗内不再滚动整页，而是右侧内容区自己滚。
   高度不再在这里写 `max-height`——统一由 AppModal 的 `height="tall"` 决定：
   本弹窗有左菜单，切换分组时高度必须稳定，否则整块会上下跳。 */
.settings {
  display: grid;
  height: 100%;
  min-height: 0;
  grid-template-columns: 168px 1fr;
  gap: var(--space-5);
}

.settings-nav {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding-right: var(--space-4);
  border-right: 1px solid var(--border-hairline);
}

/* 主标题 + 副标题要读成一个整体，用成对间距令牌（base.css §间距） */
.nav-entry {
  display: flex;
  flex-direction: column;
  gap: var(--space-pair);
  padding: var(--space-2) var(--space-3);
  text-align: left;
  border-radius: var(--radius-control);
}

.nav-entry:hover {
  background: var(--bg-hover);
}

.nav-entry-active {
  background: var(--bg-active);
}

.nav-label {
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
}

.nav-entry-active .nav-label {
  color: var(--text-primary);
  font-weight: 500;
}

.nav-hint {
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.settings-body {
  overflow-y: auto;
  padding-right: var(--space-1);
}

.section-title {
  margin: 0 0 var(--space-2);
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.005em;
}

.section-note {
  margin: 0 0 var(--space-4);
  max-width: 60ch;
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
}

/* 一个分组里放第二块内容时用它拉开：块与块之间的间距要大于块内的行距，
   否则「对话模型」与「对话行为」会读起来像同一张表 */
.section-gap {
  margin-top: var(--space-6);
}

/* 一行配置：左说明、右状态与动作 */
.row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--border-hairline);
}

.row-static {
  padding: var(--space-3) var(--space-4);
}

.row-main {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: var(--space-1);
}

.row-label {
  font-size: var(--text-body-size);
  color: var(--text-primary);
}

.row-value {
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}

.row-note {
  margin: var(--space-2) 0 0;
  max-width: 64ch;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.text-warn {
  color: var(--status-warning);
}

.error-line {
  margin: 0 0 var(--space-3);
  color: var(--status-danger);
}

/* 编辑态 */
.edit-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  margin-bottom: var(--space-4);
}

.edit-field {
  display: block;
}

/* 复选框与它的说明同一行：说明是"这项是什么"，离得太远就变成两条信息 */
.edit-check {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--hit-target);
  font-size: var(--text-meta-size);
  color: var(--text-primary);
}

.edit-check input[type='checkbox'] {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  accent-color: var(--text-secondary);
}

.edit-label {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
  font-size: var(--text-micro-size);
  color: var(--text-secondary);
}

.edit-current {
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}

.edit-hint {
  margin: 0;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}

.test-result {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  font-size: var(--text-meta-size);
  border-radius: var(--radius-control);
}

.test-ok {
  color: var(--status-success);
  background: var(--bg-subtle);
}

.test-bad {
  color: var(--status-danger);
  background: var(--danger-soft);
}

@media (max-width: 720px) {
  .settings {
    grid-template-columns: 1fr;
    height: auto;
  }

  .settings-nav {
    flex-direction: row;
    padding-right: 0;
    padding-bottom: var(--space-2);
    border-right: none;
    border-bottom: 1px solid var(--border-hairline);
  }

  .nav-hint {
    display: none;
  }
}
</style>
