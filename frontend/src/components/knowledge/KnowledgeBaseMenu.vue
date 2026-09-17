<script setup lang="ts">
/**
 * 知识库设置（齿轮按钮 + 弹窗）。
 *
 * 参考 WeKnora 的设置弹窗：**左侧分组导航 + 右侧内容 + 底部统一保存**。
 *
 * 为什么不是一列到底：库级配置会越加越多（名称/简介/库信息/数据源/删除…），
 * 堆成一列时用户得从头滚到尾才能确认"这里都有些什么"，而多数设置是**互不相干**的
 * （改简介的人不关心数据源）。分组导航把"有哪些可设"先摆出来，右侧只呈现当前这一组。
 *
 * 保存收敛到右下**一个**按钮：原先名称与简介各有一个"保存"，两个并列的按钮
 * 会让人以为必须分别点一遍。现在改完任意一项点一次「保存并关闭」即可，
 * 只把真正变了的字段发出去。
 *
 * 抽成组件而不是在列表（卡片 + 行两种形态）与详情页各写一遍：
 * "删除前先看影响清单"这套交互最不该复制三份。
 *
 * 父组件只负责"变了之后去哪儿"（列表刷新 / 详情页跳走），通过 `changed` 事件表达。
 */
import { computed, ref, type Component } from 'vue'
import { useRouter } from 'vue-router'

import {
  CHUNK_DEFAULT_SIZE,
  CHUNK_OVERLAP_MARKS,
  CHUNK_SIZE_MARKS,
  CHUNK_SIZE_MAX,
  CHUNK_SIZE_MIN,
  chunkOverlapMax,
  generateKBPrompt,
  getKnowledgeBaseImpact,
  type KBPromptDraft,
  type KnowledgeBase,
} from '@/api/knowledgeBases'
import { batchDocuments, type ImpactReport } from '@/api/documents'
import IconAi from '@/components/icons/IconAi.vue'
import IconCheck from '@/components/icons/IconCheck.vue'
import IconChevronRight from '@/components/icons/IconChevronRight.vue'
import IconDatabase from '@/components/icons/IconDatabase.vue'
import IconEdit from '@/components/icons/IconEdit.vue'
import IconInbox from '@/components/icons/IconInbox.vue'
import IconLibrary from '@/components/icons/IconLibrary.vue'
import IconRefresh from '@/components/icons/IconRefresh.vue'
import IconSettings from '@/components/icons/IconSettings.vue'
import IconTrash from '@/components/icons/IconTrash.vue'
import SourcePanel from '@/components/knowledge/SourcePanel.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppModal from '@/components/ui/AppModal.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import InfoTip from '@/components/ui/InfoTip.vue'
import RangeField from '@/components/ui/RangeField.vue'
import SuggestedQuestionsFields from '@/components/knowledge/SuggestedQuestionsFields.vue'
import { SUGGESTED_COUNT_DEFAULT } from '@/api/knowledgeBases'
import { chunkingErrorOf, parseIntOrNull } from '@/composables/useChunking'
import { formatBytes } from '@/composables/useFormat'
import { useToast } from '@/composables/useToast'
import { useKnowledgeBaseStore } from '@/stores/knowledgeBases'

const props = defineProps<{ kb: KnowledgeBase }>()
const emit = defineEmits<{ changed: [action: 'renamed' | 'deleted' | 'sources'] }>()

const store = useKnowledgeBaseStore()
const router = useRouter()
const { notifyError, notifySuccess } = useToast()

/** 文档数来自 store 的汇总表（列表页已经拉过）。拿不到就不显示数字，而不是显示 0。 */
const documentCount = computed(() => store.summaries[props.kb.id]?.count ?? null)

/** 简介上限。与后端 `KB_DESCRIPTION_MAX_CHARS` 对齐，超了后端也会拒。 */
const DESCRIPTION_MAX = 200

type SectionKey = 'basic' | 'prompt' | 'chunking' | 'wiki' | 'info' | 'sources' | 'danger'

/** 底部有「取消 / 保存并关闭」的分区：只有会改数据的那些。 */
const SAVE_SECTIONS: SectionKey[] = ['basic', 'prompt', 'chunking', 'wiki']

/**
 * 左侧导航的分组。**分组不是装饰**：它回答"这些设置属于哪一类"，
 * 用户按"我要改什么"去找，而不是按"第几项"去找。
 */
const GROUPS: { label: string; items: { key: SectionKey; label: string; icon: Component }[] }[] = [
  {
    label: '基础',
    items: [
      { key: 'basic', label: '基本信息', icon: IconEdit },
      { key: 'prompt', label: '回答要求', icon: IconAi },
      { key: 'info', label: '库信息', icon: IconDatabase },
    ],
  },
  {
    label: '数据',
    items: [
      { key: 'chunking', label: '切块策略', icon: IconSettings },
      { key: 'wiki', label: 'Wiki', icon: IconLibrary },
      { key: 'sources', label: '数据源', icon: IconInbox },
    ],
  },
  {
    label: '危险操作',
    items: [{ key: 'danger', label: '删除知识库', icon: IconTrash }],
  },
]

const settingsOpen = ref(false)
const section = ref<SectionKey>('basic')
const nameDraft = ref('')
const descriptionDraft = ref('')
const saving = ref(false)

/**
 * 切分参数草稿。**仍然是字符串**：保存、脏检查、与后端记录比对都走这一套
 * （`parseIntOrNull` 分得开"空"与"0"）。滑杆只是它的一个数字视图——见下面两个
 * `computed`，读时转数字、写时转回字符串，校验与保存的代码一行都不用改。
 */
const chunkSizeDraft = ref('')
const chunkOverlapDraft = ref('')

/**
 * 推荐问题草稿（v19）。与切块参数不同，这四个值**立刻生效**——出题发生在对话页
 * 空状态，读的就是这份设置，所以保存后不提示"要重新摄入"。
 */
const sqEnabled = ref(true)
const sqCount = ref(SUGGESTED_COUNT_DEFAULT)
const sqModelPk = ref('')
const sqPrompt = ref('')

/**
 * Wiki 开关草稿（v24）。
 *
 * 与切块参数不同，**不需要"重新摄入"**：它只是允许去 Wiki 页面用**已录入**的内容
 * 生成页面，开关本身不动文档。所以它归在可保存关闭的那一档里。
 */
const wikiEnabled = ref(false)

/** 块长滑杆的值：滑杆只认 number，草稿是 string，这里做那一层转换。 */
const chunkSizeNumber = computed({
  get: () => parseIntOrNull(chunkSizeDraft.value) ?? CHUNK_DEFAULT_SIZE,
  set: (value: number) => {
    chunkSizeDraft.value = String(value)
    // 块长调小以后，原重叠可能超过新上限（不超过块长的一半）。滑杆画不出超上限的值，
    // 就地压回上限——否则会出现"读数 256、滑块却停在 64"的分裂画面
    const max = chunkOverlapMax(value)
    if ((parseIntOrNull(chunkOverlapDraft.value) ?? 0) > max) {
      chunkOverlapDraft.value = String(max)
    }
  },
})

/** 重叠的上限跟着块长走：滑杆的 max 与下面那行提示文案用的是同一个值。 */
const chunkOverlapCap = computed(() =>
  chunkOverlapMax(parseIntOrNull(chunkSizeDraft.value) ?? props.kb.chunk_size),
)

const chunkOverlapNumber = computed({
  get: () => parseIntOrNull(chunkOverlapDraft.value) ?? 0,
  set: (value: number) => {
    chunkOverlapDraft.value = String(value)
  },
})

/** 刚保存过切分参数、但已有文档还是旧切块：面板上会出现"重新摄入"的提示。 */
const chunkingStale = ref(false)
const reingestOpen = ref(false)
const reingesting = ref(false)

const deleteOpen = ref(false)
const impact = ref<ImpactReport | null>(null)
const deleting = ref(false)

/** 切分参数的前端校验（与新建弹窗共用同一份文案，见 `composables/useChunking`）。 */
const chunkingError = computed(() => chunkingErrorOf(chunkSizeDraft.value, chunkOverlapDraft.value))

const chunkingDirty = computed(
  () =>
    parseIntOrNull(chunkSizeDraft.value) !== props.kb.chunk_size ||
    parseIntOrNull(chunkOverlapDraft.value) !== props.kb.chunk_overlap,
)

/** 库级提示词的字数上限。与后端 `SYSTEM_PROMPT_MAX_CHARS` 对齐。 */
const PROMPT_MAX = 4000

/**
 * **库级提示词**（v0.19）：回答这个库的问题时的额外要求。
 *
 * 它原先挂在对话页的全局设置 `chat.system_prompt` 上，但那段文字实质是
 * "这份资料该怎么被使用"——换个库还留着上一个库的规矩，是那个位置解释不了的。
 */
const kbPrompt = ref('')

/** 生成出来的草稿（连带它依据了哪几篇摘要）。`null` = 这一轮还没生成过。 */
const promptDraft = ref<KBPromptDraft | null>(null)
const generating = ref(false)

// `?? ''` 不是防御性摆设：字段缺失时（比如前端比后端新）`kbPrompt` 会被写成
// `undefined`，而模板里有一处 `kbPrompt.trim()` ——于是整块面板**渲染即抛错**，
// Vue 会把这次 patch 整个放弃，表现是"点了菜单但右边还是上一栏"。
// 实测就是这么被抓到的：后端进程比这次改动旧，列表接口不返回 system_prompt。
const promptDirty = computed(() => kbPrompt.value.trim() !== (props.kb.system_prompt ?? ''))

/**
 * 按文档摘要生成一版提示词。
 *
 * 生成结果**直接填进编辑框**（而不是只读展示）：用户要能改。模型写出来的东西
 * 是要过目的草稿，不是可以直接生效的配置——尤其这一段会进每一轮的 system prompt。
 */
async function generatePrompt(): Promise<void> {
  generating.value = true
  try {
    // 用这个库配的出题模型；没配就跟随默认对话模型（后端逐级回退）
    const draft = await generateKBPrompt(props.kb.id, props.kb.suggested_model_pk)
    promptDraft.value = draft
    kbPrompt.value = draft.prompt
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '生成失败')
  } finally {
    generating.value = false
  }
}

/** 推荐问题有没有改动。 */
const suggestedDirty = computed(
  () =>
    sqEnabled.value !== props.kb.suggested_enabled ||
    sqCount.value !== props.kb.suggested_count ||
    sqModelPk.value !== (props.kb.suggested_model_pk ?? '') ||
    sqPrompt.value.trim() !== props.kb.suggested_prompt,
)

/** Wiki 开关有没有改动（布尔，直接比）。 */
const wikiDirty = computed(() => wikiEnabled.value !== props.kb.wiki_enabled)

/** 名称 / 简介 / 切分参数 / 推荐问题 / Wiki 合成一次保存：只有真正变了的字段才发。 */
const dirty = computed(
  () =>
    nameDraft.value.trim() !== props.kb.name ||
    descriptionDraft.value.trim() !== props.kb.description ||
    chunkingDirty.value ||
    promptDirty.value ||
    suggestedDirty.value ||
    wikiDirty.value,
)

function openSettings(): void {
  section.value = 'basic'
  nameDraft.value = props.kb.name
  descriptionDraft.value = props.kb.description
  chunkSizeDraft.value = String(props.kb.chunk_size)
  chunkOverlapDraft.value = String(props.kb.chunk_overlap)
  resetPromptDraft()
  resetSuggestedDraft()
  wikiEnabled.value = props.kb.wiki_enabled
  chunkingStale.value = false
  settingsOpen.value = true
}

function closeSettings(): void {
  settingsOpen.value = false
}

/**
 * 把提示词草稿拉回"库里存的那份"，并丢掉上一次生成留下的溯源。
 *
 * **溯源必须一起丢**：留着它会出现"框里是手写的内容、下面却列着上次生成引用了哪几篇"
 * 这种对不上的画面——那比不显示溯源更糟。
 */
function resetPromptDraft(): void {
  kbPrompt.value = props.kb.system_prompt ?? ''
  promptDraft.value = null
}

/** 把推荐问题草稿拉回"库里存的那份"。 */
function resetSuggestedDraft(): void {
  sqEnabled.value = props.kb.suggested_enabled
  sqCount.value = props.kb.suggested_count
  sqModelPk.value = props.kb.suggested_model_pk ?? ''
  sqPrompt.value = props.kb.suggested_prompt
}

/** 取消：丢掉草稿。不丢的话下次打开会看到上次没存的半截内容。 */
function cancel(): void {
  nameDraft.value = props.kb.name
  descriptionDraft.value = props.kb.description
  chunkSizeDraft.value = String(props.kb.chunk_size)
  chunkOverlapDraft.value = String(props.kb.chunk_overlap)
  resetPromptDraft()
  resetSuggestedDraft()
  wikiEnabled.value = props.kb.wiki_enabled
  chunkingStale.value = false
  closeSettings()
}

async function save(): Promise<void> {
  const name = nameDraft.value.trim()
  if (!name) {
    notifyError('知识库名称不能为空')
    return
  }
  // 参数不合法时**跳到那一栏再说原因**：一个"就是不让你点"的灰按钮
  // 除了让人反复试，什么信息都没给
  if (chunkingError.value) {
    section.value = 'chunking'
    notifyError(chunkingError.value)
    return
  }

  const patch: {
    name?: string
    description?: string
    chunk_size?: number
    chunk_overlap?: number
    suggested_enabled?: boolean
    suggested_count?: number
    suggested_model_pk?: string | null
    suggested_prompt?: string
    system_prompt?: string
    wiki_enabled?: boolean
  } = {}
  if (name !== props.kb.name) patch.name = name
  const description = descriptionDraft.value.trim()
  if (description !== props.kb.description) patch.description = description
  const size = Number(chunkSizeDraft.value)
  const overlap = Number(chunkOverlapDraft.value)
  if (size !== props.kb.chunk_size) patch.chunk_size = size
  if (overlap !== props.kb.chunk_overlap) patch.chunk_overlap = overlap
  const chunkingChanged = patch.chunk_size !== undefined || patch.chunk_overlap !== undefined
  // 分段出题：四个值一起提交（后端也是一次写四个）。空串表示"跟随对话模型"/"用内置提示词"，
  // 所以这里判的是"与库里不同"，而不是"非空"
  const suggestedChanged = suggestedDirty.value
  if (suggestedDirty.value) {
    patch.suggested_enabled = sqEnabled.value
    patch.suggested_count = sqCount.value
    patch.suggested_model_pk = sqModelPk.value
    patch.suggested_prompt = sqPrompt.value.trim()
  }
  // 库级提示词：空串表示"清除"，所以判的是"与库里不同"而不是"非空"
  if (promptDirty.value) patch.system_prompt = kbPrompt.value.trim()
  // Wiki 开关独立提交：它不涉及"重新摄入"，与基础信息同属"存完即生效"
  if (wikiDirty.value) patch.wiki_enabled = wikiEnabled.value

  // 没改就直接关：发一次空 PATCH 除了浪费一个来回没有任何意义
  if (Object.keys(patch).length === 0) {
    closeSettings()
    return
  }

  saving.value = true
  try {
    await store.update(props.kb.id, patch)
    // 改名会让列表/页面标题跟着变，得让宿主知道
    if (patch.name) emit('changed', 'renamed')
    if (suggestedDirty.value) {
      // 保存成功后把草稿对齐到刚提交的值：props 要等父级重新拉数据才更新，
      // 不对齐的话脏检查会一直是 true（"取消"会提示有未保存改动）
      sqPrompt.value = sqPrompt.value.trim()
    }
    if (chunkingChanged || suggestedChanged) {
      // **不关弹窗**：这两件事都发生在**摄入那一步**（切块时写下），已有文档不会
      // 跟着变。让用户停在这一栏，重新摄入的按钮就在眼前——关掉之后靠一句提示
      // 让他自己找回来，那一步多半会丢。
      chunkingStale.value = true
      section.value = 'chunking'
      chunkSizeDraft.value = String(props.kb.chunk_size)
      chunkOverlapDraft.value = String(props.kb.chunk_overlap)
      notifySuccess(chunkingChanged ? '切分参数已保存' : '切块出题设置已保存')
    } else {
      notifySuccess('已保存')
      closeSettings()
    }
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '保存失败')
  } finally {
    saving.value = false
  }
}

/**
 * 整库重新摄入。
 *
 * 由服务端解析全集（`all=true`），这里只负责把代价说清——一次云端解析
 * 要花钱、要时间，所以放在确认弹窗后面，而不是保存参数时自动触发。
 */
async function confirmReingest(): Promise<void> {
  if (reingesting.value) return
  reingesting.value = true
  try {
    const result = await batchDocuments(props.kb.id, 'reprocess', [], null, true)
    reingestOpen.value = false
    chunkingStale.value = false
    if (result.failed > 0) {
      notifyError(`已排队 ${result.succeeded} 篇，${result.failed} 篇没能入队`)
    } else {
      notifySuccess(`已把 ${result.succeeded} 篇文档排入重新摄入队列`)
    }
    emit('changed', 'sources')
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '重新摄入失败')
  } finally {
    reingesting.value = false
  }
}

/**
 * 回车保存。**只对单行输入生效**：描述是多行文本框，那里回车的含义是换行，
 * 顺手提交会让人打不完一段话。
 */
function onEnter(event: KeyboardEvent): void {
  if (!SAVE_SECTIONS.includes(section.value)) return
  if (event.target instanceof HTMLTextAreaElement) return
  void save()
}

/** 复制知识库 ID：给 API 集成用（对接时要拿它指定库）。 */
async function copyId(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.kb.id)
    notifySuccess('知识库 ID 已复制')
  } catch {
    notifyError('复制失败，请手动选中复制')
  }
}

/** 打开这个库的 Wiki 页面（应用内跳转，不留在这个弹窗里）。 */
function openWiki(): void {
  void router.push(`/kb/${props.kb.id}/wiki`)
}

/**
 * 删除是**不可恢复**的（不进回收站），所以必须先把"会失去什么"摆出来。
 * 影响清单拿不到也不阻断：弹窗会停在"正在统计"，用户仍能取消。
 */
async function openDelete(): Promise<void> {
  impact.value = null
  deleteOpen.value = true
  try {
    impact.value = await getKnowledgeBaseImpact(props.kb.id)
  } catch {
    impact.value = null
  }
}

async function confirmDelete(): Promise<void> {
  if (deleting.value) return
  deleting.value = true
  try {
    await store.remove(props.kb.id)
    deleteOpen.value = false
    settingsOpen.value = false
    notifySuccess(`已删除知识库「${props.kb.name}」`)
    emit('changed', 'deleted')
  } catch (cause) {
    notifyError(cause instanceof Error ? cause.message : '删除失败')
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <!-- 单根包裹：多根组件无法自动继承父级传进来的 class，
       而调用方要用 class 把它定位到卡片右上角 / 行尾 -->
  <span class="kb-settings-anchor">
    <button
      type="button"
      class="kb-settings"
      :aria-label="`${kb.name} 的设置`"
      title="知识库设置"
      @click="openSettings"
    >
      <IconSettings :size="16" />
    </button>

    <AppModal
      v-model:open="settingsOpen"
      title="知识库设置"
      size="wide"
      height="full"
      @keydown.enter="onEnter"
    >
      <div class="settings-layout">
        <nav class="settings-nav" aria-label="设置分组">
          <template v-for="group in GROUPS" :key="group.label">
            <p class="nav-group">{{ group.label }}</p>
            <button
              v-for="item in group.items"
              :key="item.key"
              type="button"
              class="nav-item"
              :class="{
                'nav-item-active': section === item.key,
                'nav-item-danger': item.key === 'danger',
              }"
              :aria-current="section === item.key ? 'true' : undefined"
              @click="section = item.key"
            >
              <component :is="item.icon" :size="15" />
              <span>{{ item.label }}</span>
            </button>
          </template>
        </nav>

        <div class="settings-pane">
          <!-- 基本信息 -->
          <template v-if="section === 'basic'">
            <h3 class="pane-title">基本信息</h3>
            <p class="pane-desc">设置知识库的名称和描述信息。</p>

            <div class="field">
              <span class="field-label">知识库 ID</span>
              <div class="field-inline">
                <code class="kb-id">{{ kb.id }}</code>
                <AppButton size="sm" aria-label="复制知识库 ID" @click="copyId"> 复制 </AppButton>
              </div>
              <p class="pane-hint">API 集成时用它指定这个库。</p>
            </div>

            <label class="field">
              <span class="field-label">知识库名称</span>
              <AppInput id="kb-setting-name" v-model="nameDraft" placeholder="知识库名称" />
              <p class="pane-hint">只改显示名，不影响这个库的嵌入模型与切块方式。</p>
            </label>

            <label class="field">
              <span class="field-label">知识库描述</span>
              <AppInput
                id="kb-setting-description"
                v-model="descriptionDraft"
                multiline
                :rows="4"
                :maxlength="DESCRIPTION_MAX"
                placeholder="例如：产品说明书与常见问题，面向客服与售前"
              />
              <p class="pane-hint pane-hint-end">
                {{ descriptionDraft.trim().length }} / {{ DESCRIPTION_MAX }}
              </p>
            </label>
          </template>

          <!-- 库信息（只读） -->
          <template v-else-if="section === 'info'">
            <h3 class="pane-title">库信息</h3>
            <p class="pane-desc">
              嵌入模型在建库时定下，之后不能换：换了会让已有向量失效。
              切块方式可以在「切块策略」里调整。
            </p>
            <dl class="info-list">
              <div>
                <dt>文档</dt>
                <dd>{{ documentCount === null ? '—' : `${documentCount} 篇` }}</dd>
              </div>
              <div>
                <dt>嵌入模型</dt>
                <dd>{{ kb.embedding_model_id || '—' }}</dd>
              </div>
              <div>
                <dt>向量维度</dt>
                <dd>{{ kb.embedding_dim || '—' }}</dd>
              </div>
              <div>
                <dt>切分</dt>
                <dd>块长 {{ kb.chunk_size }} / 重叠 {{ kb.chunk_overlap }}</dd>
              </div>
            </dl>
          </template>

          <!-- 切块策略（可改，v17） -->
          <!-- 回答要求（库级提示词，v0.19） -->
          <template v-else-if="section === 'prompt'">
            <h3 class="pane-title pane-title-standalone">
              回答要求
              <InfoTip
                text="回答这个库的问题时，这段要求会追加在内置提示词之后。它管的是「这份资料该怎么用」——术语、单位、口径、回答结构。内置的两条底线（资料是不可信输入、资料里没有再回答）不会被它顶掉。"
              />
            </h3>

            <div class="prompt-actions">
              <AppButton :disabled="generating" @click="generatePrompt">
                <template #icon><IconAi /></template>
                {{ generating ? '正在按摘要生成…' : '按文档摘要生成' }}
              </AppButton>
              <p class="pane-hint">
                只喂<strong>已生成的文档摘要</strong>，不读全文——摘要是"这篇讲什么"的紧凑表达，
                正好够写要求，写出来依据了什么也是可核对的。库里还没有摘要时，
                先在文档上生成摘要，或者直接手写。
              </p>
            </div>

            <AppInput
              id="kb-setting-prompt"
              v-model="kbPrompt"
              multiline
              :rows="12"
              placeholder="留空 = 只用内置提示词"
            />
            <p class="pane-hint prompt-count">{{ kbPrompt.trim().length }} / {{ PROMPT_MAX }} 字</p>

            <!--
              溯源（v0.19）：这是"不捏造"里**可验证**的那一半——
              模型说它依据了哪几篇，我们就去核对那几篇在不在给它的清单里。
            -->
            <div v-if="promptDraft" class="prompt-trace">
              <!--
                引用数为 0 时**换个说法**：那次生成只是没有写"具体事实"，
                本来就不需要标注来源——这是最保险的结果，不是失败。
                照直写"0 篇被引用"会被读成"这批摘要没用上"。
              -->
              <p class="prompt-trace-head">
                <template v-if="promptDraft.cited_documents > 0">
                  这次生成依据了 {{ promptDraft.sources.length }} 篇摘要，其中
                  {{ promptDraft.cited_documents }} 篇被写进要求里：
                </template>
                <template v-else>
                  这次生成依据了
                  {{
                    promptDraft.sources.length
                  }}
                  篇摘要，但没有写入<strong>需要标注来源的具体事实</strong>——那不是失败，是最保险的结果（摘要只提供了领域背景）：
                </template>
              </p>
              <ul class="prompt-trace-list">
                <li
                  v-for="item in promptDraft.sources"
                  :key="item.document_id"
                  :class="{ 'prompt-trace-cited': item.cited }"
                >
                  <IconCheck v-if="item.cited" :size="12" />
                  <span v-else class="prompt-trace-dot" />
                  <span class="prompt-trace-name">{{ item.name }}</span>
                </li>
              </ul>
              <p v-if="promptDraft.unknown_citations.length" class="prompt-trace-warn">
                这次生成引用了清单里没有的文件（{{ promptDraft.unknown_citations.join('、') }}）。
                那是编造的迹象——请逐句核对后再保存。
              </p>
              <p v-else class="pane-hint">
                没有出现清单以外的引用。仍然建议通读一遍：摘要里没有的具体数字与结论，
                一个字都不该出现在框里。
              </p>
            </div>
          </template>

          <template v-else-if="section === 'chunking'">
            <!-- 解释性文字收进「?」：这段话一屏好几行灰字，真正的两个滑杆反而不突出。
                 想知道的人自己去问——与全仓其余说明同一套做法（见 `InfoTip` 顶部注释）。 -->
            <h3 class="pane-title pane-title-standalone">
              切块与出题
              <InfoTip
                text="块太大：一段里混着好几件事，命中后给模型的上下文会跑题。块太小：句子被切断。中文资料里 512 约一到两段话；重叠留一点，跨块的句子才不会被截断。轨道上的点是常用值，强调色是默认值。"
              />
            </h3>

            <div class="field">
              <label class="field-label" for="kb-chunk-size">块长（字符）</label>
              <RangeField
                id="kb-chunk-size"
                v-model="chunkSizeNumber"
                :min="CHUNK_SIZE_MIN"
                :max="CHUNK_SIZE_MAX"
                :marks="CHUNK_SIZE_MARKS"
              />
            </div>

            <div class="field">
              <label class="field-label" for="kb-chunk-overlap">块重叠（字符）</label>
              <RangeField
                id="kb-chunk-overlap"
                v-model="chunkOverlapNumber"
                :min="0"
                :max="chunkOverlapCap"
                :marks="CHUNK_OVERLAP_MARKS"
              />
              <!-- 这一行留着：上限是个**跟着块长变的数**，工具提示里写不死 -->
              <p class="pane-hint">上限 {{ chunkOverlapCap }}（块长的一半）。</p>
            </div>

            <p v-if="chunkingError" class="pane-error" role="alert">{{ chunkingError }}</p>

            <!-- 改动只对之后摄入的文档生效：这一条必须写出来，否则用户会以为
                 "保存了却没反应"。重新摄入的按钮就放在这段话下面 -->
            <div class="callout" :class="{ 'callout-strong': chunkingStale }">
              <p class="callout-text">
                {{
                  chunkingStale
                    ? '已保存。已有文档还是按旧的切块参数、也没有问题，需要重新摄入才会生效。'
                    : '改动只对之后上传或重新摄入的文档生效；已有文档要重新摄入才会按新参数切块、并补上问题。'
                }}
              </p>
              <AppButton
                size="sm"
                :disabled="reingesting || documentCount === 0"
                @click="reingestOpen = true"
              >
                <IconRefresh :size="14" />
                重新摄入全部文档
              </AppButton>
            </div>

            <!-- 分段出题并在**同一栏**里（v23）：它跟的是分段。同样只对之后摄入的
                 文档生效，所以上面那个「重新摄入」的入口对它也适用 -->
            <div class="pane-divider" role="separator" aria-hidden="true" />
            <SuggestedQuestionsFields
              v-model:enabled="sqEnabled"
              v-model:count="sqCount"
              v-model:model-pk="sqModelPk"
              v-model:prompt="sqPrompt"
            />
          </template>

          <!-- Wiki（v24，库形态之二） -->
          <template v-else-if="section === 'wiki'">
            <h3 class="pane-title pane-title-standalone">
              Wiki
              <InfoTip
                text="把库里已录入的内容整理成分层页面，每个要点标注原文出处。开启只是允许生成，构建要到 Wiki 页点「生成 Wiki」；页面越多，耗时与模型调用越多。"
              />
            </h3>

            <div class="wiki-toggle">
              <label class="wiki-switch">
                <input v-model="wikiEnabled" type="checkbox" />
                <span>为这个知识库开启 Wiki</span>
              </label>
              <!-- 开与关分别发生什么，必须在勾之前说清：这是库级形态，关掉不代表删掉 -->
              <p class="pane-hint">
                老库也能开：开完之后到 Wiki 页面点「生成 Wiki」，用已录入的内容构建。
                关闭只是不再展示与生成，已有页面会保留；想彻底清掉可以在 Wiki 页面里删除。
              </p>
            </div>

            <div class="wiki-open">
              <AppButton :disabled="!kb.wiki_enabled" @click="openWiki">
                <template #icon><IconChevronRight /></template>
                打开 Wiki 页面
              </AppButton>
              <p v-if="!kb.wiki_enabled" class="pane-hint">
                这个库还没开启 Wiki。勾上上面的开关并保存后，入口就会出现。
              </p>
            </div>
          </template>

          <!-- 数据源 -->
          <template v-else-if="section === 'sources'">
            <h3 class="pane-title">数据源</h3>
            <p class="pane-desc">
              订阅 RSS 或盯住一个网页，内容会自动抓进这个知识库。
              登记后不会立刻抓取：点「立即拉取」，或等定时任务。
            </p>
            <SourcePanel
              :kb-id="kb.id"
              :can-write="kb.can_write"
              @changed="emit('changed', 'sources')"
            />
          </template>

          <!-- 删除 -->
          <template v-else>
            <h3 class="pane-title pane-title-danger">删除知识库</h3>
            <p class="pane-desc">
              整个知识库连同其中的文档、切块与向量都会被删除，<strong>不会进回收站</strong>，
              无法恢复。
            </p>
            <AppButton variant="danger" @click="openDelete">删除知识库</AppButton>
          </template>
        </div>
      </div>

      <template #footer>
        <template v-if="SAVE_SECTIONS.includes(section)">
          <AppButton @click="cancel">取消</AppButton>
          <AppButton variant="primary" :disabled="saving || !dirty" @click="save">
            {{ saving ? '保存中…' : '保存并关闭' }}
          </AppButton>
        </template>
        <AppButton v-else @click="closeSettings">关闭</AppButton>
      </template>
    </AppModal>

    <!-- 整库重跑：把代价说清楚再动手（云端解析要花钱、要时间） -->
    <ConfirmDialog
      v-model:open="reingestOpen"
      title="重新摄入全部文档"
      :lead="`把「${kb.name}」里的文档全部重新解析、切块与向量化？`"
      note="这会消耗云端解析额度并占用一段时间；期间知识库照常可检索（旧的切块会保留到新切块写入）。正在处理中的文档会被跳过。"
      confirm-label="开始重新摄入"
      :busy="reingesting"
      busy-label="排队中…"
      @confirm="confirmReingest"
    />

    <ConfirmDialog
      v-model:open="deleteOpen"
      title="删除知识库"
      :lead="`确定删除知识库「${kb.name}」？`"
      note="不可恢复。库里的文档、切块与向量都会删除，不进回收站。"
      confirm-label="删除知识库"
      :busy="deleting"
      busy-label="删除中…"
      @confirm="confirmDelete"
    >
      <p v-if="!impact" class="pane-hint">正在统计影响…</p>
      <dl v-else class="impact">
        <div>
          <dt>文档</dt>
          <dd class="tabular">{{ impact.documents }}</dd>
        </div>
        <div>
          <dt>切块</dt>
          <dd class="tabular">{{ impact.chunks }}</dd>
        </div>
        <div>
          <dt>占用的空间</dt>
          <dd class="tabular">{{ formatBytes(impact.size_bytes) }}</dd>
        </div>
      </dl>
    </ConfirmDialog>
  </span>
</template>

<style scoped>
/* 触发器与弹窗包在一个单根里，父级的定位 class 才能落到这个 span 上 */
.kb-settings-anchor {
  display: inline-flex;
  align-items: center;
}

/* 齿轮触发器：与页头其它按钮同高（32px），否则会和它们对不齐 */
.kb-settings {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: var(--control-height);
  height: var(--control-height);
  color: var(--text-secondary);
  border-radius: var(--radius-control);
}

.kb-settings:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

/* ---------------------------------------------------------------- 左右两栏 */

.settings-layout {
  display: flex;
  align-items: stretch;
  gap: var(--space-5);
  height: 100%;
  min-height: 0;
}

/* 左侧导航：固定宽、自己不滚（项少），滚动留给右侧内容 */
.settings-nav {
  flex: 0 0 168px;
  align-self: flex-start;
}

.nav-group {
  margin: var(--space-4) 0 var(--space-1);
  padding: 0 var(--space-2);
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

/* 第一组的标题不需要上边距，否则导航整体比右侧内容低一截 */
.nav-group:first-child {
  margin-top: 0;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 32px;
  padding: 0 var(--space-2);
  font: inherit;
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
  text-align: left;
  border-radius: var(--radius-row);
  cursor: pointer;
}

.nav-item:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.nav-item-active {
  color: var(--accent);
  background: var(--accent-soft);
}

/* 危险项平时也是中性色，只在选中/悬停时露出红——常驻红色会让整列都在喊 */
.nav-item-danger.nav-item-active {
  color: var(--status-danger);
  background: var(--danger-soft);
}

/* 右侧内容：**滚动只在这里**（弹窗高度是固定的 full 档） */
.settings-pane {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  padding-right: var(--space-2);
  overflow-y: auto;
}

.pane-title {
  margin: 0 0 var(--space-1);
  font-size: var(--text-section-size);
  font-weight: 600;
  color: var(--text-primary);
}

/* 说明收进「?」的面板：标题后面没有 `pane-desc` 垫着，与第一个控件的间距要自己补。
   其余面板靠 `pane-desc` 的 `margin-bottom` 撑开，所以不能统一改 `.pane-title`。 */
.pane-title-standalone {
  margin-bottom: var(--space-5);
}

.pane-title-danger {
  color: var(--status-danger);
}

.pane-desc {
  margin: 0 0 var(--space-5);
  font-size: var(--text-meta-size);
  line-height: 1.7;
  color: var(--text-secondary);
}

.field {
  display: block;
  margin-bottom: var(--space-5);
}

.field-label {
  display: block;
  margin-bottom: var(--space-2);
  font-size: var(--text-meta-size);
  color: var(--text-primary);
}

.field-inline {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

/* 知识库 ID：等宽，方便肉眼比对；长 id 允许换行而不是撑破弹窗 */
.kb-id {
  flex: 1;
  min-width: 0;
  padding: var(--space-2) var(--space-3);
  overflow-wrap: anywhere;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
  background: var(--bg-subtle);
  border-radius: var(--radius-control);
}

.pane-hint {
  margin: var(--space-2) 0 0;
  font-size: var(--text-micro-size);
  line-height: 1.7;
  color: var(--text-tertiary);
}

/* 字数计数右对齐：它跟的是输入框，不是说明文字 */
.pane-hint-end {
  text-align: right;
}

/* 同一栏里两件事（切块参数 / 分段出题）之间的细线 */
.pane-divider {
  margin: var(--space-6) 0 var(--space-5);
  border-top: 1px solid var(--border-hairline);
}

/* ---- Wiki 开关 ---- */

/* 开关 + 它的解释是一组：贴紧，和下面的按钮之间才留大间距 */
.wiki-toggle {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin-bottom: var(--space-5);
}

/* 用原生复选框：文本域里的 "false" 是非空字符串，容易说反，复选框不会 */
.wiki-switch {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
  cursor: pointer;
}

.wiki-switch input {
  width: 14px;
  height: 14px;
  accent-color: var(--accent);
  cursor: pointer;
}

.wiki-open {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-2);
}

/* 参数不合法时的原因。放在字段下面而不是弹 toast：它是"这一栏要改"，
   与输入框在同一视野里才能边看边改 */
.pane-error {
  margin: 0 0 var(--space-4);
  font-size: var(--text-micro-size);
  color: var(--status-danger);
}

/* 「改了不会自动生效」这类提示：它不是说明文字，而是"下一步做什么"，
   所以给底色与边框，让它从一堆 hint 里站出来。参数刚改过时加重一档 */
.callout {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3);
  background: var(--bg-subtle);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-panel);
}

.callout-strong {
  background: var(--status-warning-soft);
  border-color: transparent;
}

.callout-text {
  flex: 1 1 260px;
  margin: 0;
  font-size: var(--text-micro-size);
  line-height: 1.7;
  color: var(--text-secondary);
}

/* 库信息的只读清单：两列，标签弱、值强 */
.info-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3) var(--space-4);
  margin: 0;
}

.info-list dt {
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.info-list dd {
  margin: var(--space-1) 0 0;
  font-size: var(--text-meta-size);
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

/* SourcePanel 自己带页边距（它是按"页面里的一块"写的），进弹窗后要收掉 */
.settings-pane :deep(.sources) {
  margin-top: 0;
}

/* 影响清单：三项并排，数字比标签显眼——用户扫的是"会失去多少" */
.impact {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-3);
  margin: 0 0 var(--space-3);
  padding: var(--space-3);
  background: var(--bg-subtle);
  border-radius: var(--radius-panel);
}

.impact dt {
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

.impact dd {
  margin: var(--space-1) 0 0;
  font-size: var(--text-section-size);
  color: var(--text-primary);
}

/* 窄屏放不下两栏：导航收成一行横排，内容跟在下面 */
@media (max-width: 720px) {
  .settings-layout {
    flex-direction: column;
    gap: var(--space-3);
  }

  .settings-nav {
    display: flex;
    flex: 0 0 auto;
    gap: var(--space-1);
    overflow-x: auto;
  }

  .nav-group {
    display: none;
  }

  .nav-item {
    width: auto;
    white-space: nowrap;
  }
}

/* ------------------------------------------------- 回答要求（库级提示词，v0.19） */

/* 「按摘要生成」与它右边的说明：按钮是动作，说明是前提。
   说明**必须留在按钮旁边**——"只喂摘要、会标出处"是用户决定要不要点的依据。 */
.prompt-actions {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
}

.prompt-actions .pane-hint {
  flex: 1;
  min-width: 0;
  margin: 0;
}

.prompt-count {
  margin: var(--space-2) 0 0;
  text-align: right;
}

/* 溯源列表：被引用的排在前面（模板里的顺序就是库里的文档顺序，
   这里用样式把它顶出来，不改数据顺序——顺序本身也是信息） */
.prompt-trace {
  margin-top: var(--space-4);
  padding: var(--space-3);
  background: var(--bg-subtle);
  border-radius: var(--radius-panel);
}

.prompt-trace-head {
  margin: 0 0 var(--space-2);
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
}

.prompt-trace-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.prompt-trace-list li {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) 0;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}

/* 被引用的用主文字色 + 一个对勾：一眼看出"这几篇真的被写进去了" */
.prompt-trace-cited {
  color: var(--text-primary);
}

/* 没被引用的用一个空心点占位：图标有无不该让名字左右跳动 */
.prompt-trace-dot {
  flex: 0 0 auto;
  width: 12px;
  height: 12px;
  border: 1.5px solid var(--border-strong);
  border-radius: 999px;
}

.prompt-trace-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 引了不存在文件时的警告：用警示色，它是"该核对"而不是"出错了" */
.prompt-trace-warn {
  margin: var(--space-3) 0 0;
  font-size: var(--text-micro-size);
  line-height: 1.6;
  color: var(--status-warning);
}
</style>
