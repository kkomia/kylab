<script setup lang="ts">
/**
 * 「推荐问题」的四个设置项（v19），建库弹窗与知识库设置共用同一份。
 *
 * 为什么要抽成组件：这两处**必须完全一致**——同一组设置出现两套控件，
 * 迟早会出现"建库时能关、设置里关不掉"这种说不清的差别。文案与取值范围也只有一份。
 *
 * 四个值都走 `defineModel`，由调用方持有（建库时是提交用的草稿，设置页是脏检查用的草稿）。
 */
import { computed, onMounted } from 'vue'

import {
  SUGGESTED_COUNT_DEFAULT,
  SUGGESTED_COUNT_MAX,
  SUGGESTED_COUNT_MIN,
  SUGGESTED_PROMPT_MAX_CHARS,
} from '@/api/knowledgeBases'
import AppInput from '@/components/ui/AppInput.vue'
import AppSelect from '@/components/ui/AppSelect.vue'
import InfoTip from '@/components/ui/InfoTip.vue'
import RangeField from '@/components/ui/RangeField.vue'
import { useModelRegistryStore } from '@/stores/modelRegistry'

const enabled = defineModel<boolean>('enabled', { required: true })
const count = defineModel<number>('count', { required: true })
/** 出题模型；空串 = 跟随对话页当前选的模型。 */
const modelPk = defineModel<string>('modelPk', { required: true })
/** 自定义出题提示词；空串 = 用内置提示词。 */
const prompt = defineModel<string>('prompt', { required: true })

const registryStore = useModelRegistryStore()

onMounted(() => {
  // 注册表是缓存 + 后台刷新：拿不到就只显示"跟随对话模型"那一项，
  // 不把"没加载出来"演成一个错误
  void registryStore.prefetch()
})

const modelOptions = computed(() => [
  { value: '', label: '跟随对话模型' },
  ...registryStore.chatModels.map((model) => ({
    value: model.id,
    label: model.label || model.model_id,
  })),
])

/** 轨道上的常用值：3 条够试、6 条是默认、8 条是上限。 */
const COUNT_MARKS = [
  { value: 3 },
  { value: SUGGESTED_COUNT_DEFAULT, primary: true },
  { value: SUGGESTED_COUNT_MAX },
]
</script>

<template>
  <div class="suggested">
    <!-- 开关与它那句解释贴在一起（4px），与下一项之间才用大间距 -->
    <div class="suggested-switch">
      <label class="suggested-toggle">
        <input
          type="checkbox"
          :checked="enabled"
          @change="enabled = ($event.target as HTMLInputElement).checked"
        />
        <span>在对话空状态生成推荐问题</span>
      </label>
      <!-- 关掉之后到底发生什么，必须写出来：否则用户以为"关了就再没有示例问题"，
           其实是回退到内置的静态样例 -->
      <p class="suggested-hint">关掉后这个库不参与出题，对话页空状态改用内置的静态示例问题。</p>
    </div>

    <div class="field">
      <span class="field-label">一次生成条数</span>
      <RangeField
        v-model="count"
        :min="SUGGESTED_COUNT_MIN"
        :max="SUGGESTED_COUNT_MAX"
        :marks="COUNT_MARKS"
        aria-label="推荐问题条数"
      />
    </div>

    <div class="field">
      <span class="field-label">
        出题用的模型
        <InfoTip
          text="默认跟随对话页当前选的模型。单独指定一个便宜的小模型可以省 token——出题只需要看出这批资料在讲什么，不需要很强的推理。"
        />
      </span>
      <AppSelect v-model="modelPk" :options="modelOptions" aria-label="出题用的模型" />
    </div>

    <div class="field">
      <span class="field-label">
        自定义出题提示词
        <span class="field-optional">可选</span>
      </span>
      <AppInput
        v-model="prompt"
        multiline
        :rows="4"
        :maxlength="SUGGESTED_PROMPT_MAX_CHARS"
        placeholder="留空使用内置提示词"
        aria-label="自定义出题提示词"
      />
      <p class="suggested-hint">
        留空即用内置提示词。自定义时它会替换内置那句指令，资料片段照旧附在前面； 用
        <code>{n}</code> 表示条数，并请要求模型<strong>每行输出一个问题</strong>。
      </p>
    </div>
  </div>
</template>

<style scoped>
.suggested {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

/* 开关 + 它的解释是一组：贴紧（4px），别用上面那个"项与项之间"的间距 */
.suggested-switch {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

/* 开关用原生复选框（与设置页的布尔项同一手法）：文本域里的 "false" 是非空字符串，
   一不小心就写成了"开启"，复选框是唯一不会说反的控件 */
.suggested-toggle {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  font-size: var(--text-meta-size);
  color: var(--text-secondary);
  cursor: pointer;
}

.suggested-toggle input {
  width: 14px;
  height: 14px;
  accent-color: var(--accent);
  cursor: pointer;
}

/* 说明句一律 margin: 0：它跟在控件下面，间距由父级的 gap 给。
   （早先给了一个负外边距想把"开关那句"拉近，结果连输入框下面那句一起拉了，
   文字会压在 textarea 的下边框上。） */
.suggested-hint {
  margin: 0;
  font-size: var(--text-micro-size);
  line-height: 1.7;
  color: var(--text-tertiary);
}

.suggested-hint code {
  padding: 0 3px;
  font-size: 0.95em;
  background: var(--bg-subtle);
  border-radius: var(--radius-control);
}
</style>
