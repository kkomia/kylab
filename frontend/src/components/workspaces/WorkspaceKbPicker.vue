<script setup lang="ts">
/**
 * 工作区的「绑定的知识库」勾选组（v0.25 抽出）。
 *
 * 抽出来的原因：新建弹窗与编辑表单**都要用它**，而它的样式不是随手写的一段——
 * 选中的胶囊用 `--bg-selected`（中性 alpha）而不是品牌色，靠底色表达"已绑定"，
 * 这一点两处必须一致，否则同一个控件在弹窗里和页面里长得不一样。
 *
 * 取值口径：胶囊高 `--control-height`（与输入框、按钮同高）、圆角 999（胶囊），
 * 选中态去掉描边——描边 + 底色同时出现会读成"按钮被按下"，而这里表达的是状态。
 */
import InfoTip from '@/components/ui/InfoTip.vue'

const model = defineModel<string[]>({ required: true })

defineProps<{
  items: { id: string; name: string }[]
}>()

function toggle(kbId: string): void {
  const current = model.value
  model.value = current.includes(kbId)
    ? current.filter((item) => item !== kbId)
    : [...current, kbId]
}
</script>

<template>
  <div class="field">
    <span class="field-label">
      绑定的知识库
      <InfoTip
        text="绑定的库会被这个工作区里的新会话自动继承：进入项目，资料范围就定了，不必每次重勾。知识库与记忆仍是两个池子，检索结果不会混。"
      />
    </span>
    <p v-if="!items.length" class="text-micro">还没有知识库可绑。</p>
    <ul v-else class="kb-picks">
      <li v-for="kb in items" :key="kb.id">
        <button
          type="button"
          class="kb-pick"
          :class="{ on: model.includes(kb.id) }"
          :aria-pressed="model.includes(kb.id)"
          @click="toggle(kb.id)"
        >
          <span class="kb-pick-name">{{ kb.name }}</span>
          <span v-if="model.includes(kb.id)" class="kb-pick-mark">已绑定</span>
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.kb-picks {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.kb-pick {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  height: var(--control-height);
  padding: 0 var(--space-3);
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-pill);
  background: none;
  color: var(--text-secondary);
  font-size: var(--text-meta-size);
  cursor: pointer;
  transition: var(--transition-ui);
}

.kb-pick:hover {
  background: var(--bg-hover);
}

.kb-pick.on {
  background: var(--bg-selected);
  color: var(--text-primary);
  border-color: transparent;
}

.kb-pick-mark {
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}
</style>
