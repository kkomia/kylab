<!--
  快捷键（本机偏好，不进后端）。

  **它现在是独立组件**，与 `AppearanceSection` 同一个理由：读的是 composable、
  不碰设置接口，所以这一节不需要任何 props/emits——分节样式在 `settings.css` 里按
  `.settings …` 命名空间生效。

  这一节是 P2-1 抄 ZCode 的那条「快捷键：命令 + 多绑定 + 冲突提示 + 恢复默认」的
  用户界面。四件事在这里都能做：**看**（命令、绑定、作用域）、**改**（点「修改」再按一下）、
  **加/删绑定**（一条命令可以绑好几组键）、**恢复默认**（单条或全部）。
  冲突不拦着不让改，只在那一条下面说实话（见 `useShortcuts` 的模块头）。
-->
<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'

import AppButton from '@/components/ui/AppButton.vue'
import InfoTip from '@/components/ui/InfoTip.vue'
import {
  addBinding,
  bindingFromEvent,
  bindingParts,
  conflictMessage,
  isCustomized,
  removeBinding,
  resetAllShortcuts,
  resetCommand,
  setBinding,
  useShortcuts,
  type ShortcutCommand,
  type ShortcutId,
} from '@/composables/useShortcuts'

const { commands, bindingsOf } = useShortcuts()

/** 正在"录制"的那一条（命令 + 第几个绑定）；`null` = 没在录。 */
const recording = ref<{ id: ShortcutId; index: number } | null>(null)

const SCOPE_LABEL: Record<ShortcutCommand['scope'], string> = {
  composer: '输入框',
  global: '全局',
}

/**
 * 录制：**接下来按下的那一组键就是新绑定**（照 ZCode 的"录制"）。
 *
 * 监听挂在 window 的**捕获阶段**：全局那几条快捷键是在 window 的冒泡阶段处理的
 * （见 `SideNav.onShortcut`），不抢在它前面的话，用户想录 `Ctrl+K` 会先开出
 * 一个新会话。Esc 取消录制（它是设置里唯一"不录进去"的键——不然没法退出）。
 */
function startRecording(id: ShortcutId, index: number): void {
  recording.value = { id, index }
}

function onRecordKey(event: KeyboardEvent): void {
  const target = recording.value
  if (!target) return
  event.preventDefault()
  event.stopPropagation()
  if (event.key === 'Escape') {
    // 新建的那个空位要收回去：取消录制之后留一条空绑定，界面上会多一个空的键位
    if (!currentBinding(target.id, target.index)) removeBinding(target.id, target.index)
    recording.value = null
    return
  }
  const binding = bindingFromEvent(event)
  if (!binding) return // 只按了修饰键：继续等（那不是一组键）
  setBinding(target.id, target.index, binding)
  recording.value = null
}

function currentBinding(id: ShortcutId, index: number): string {
  return bindingsOf(id)[index] ?? ''
}

function stopRecording(): void {
  const target = recording.value
  if (target && !currentBinding(target.id, target.index)) {
    removeBinding(target.id, target.index)
  }
  recording.value = null
}

/** 加一条绑定 = 先占一个空位，再立刻进入录制（不录的空位没有意义）。 */
function addAndRecord(id: ShortcutId): void {
  const index = addBinding(id)
  startRecording(id, index)
}

watch(recording, (value) => {
  if (value) window.addEventListener('keydown', onRecordKey, true)
  else window.removeEventListener('keydown', onRecordKey, true)
})

onBeforeUnmount(() => window.removeEventListener('keydown', onRecordKey, true))
</script>

<template>
  <h3 class="section-title">
    快捷键
    <InfoTip
      text="只影响这一台机器的浏览器，存在本地，不写进后端配置。全局那两条在输入框里不生效——那里是编辑器（笔记正文）的地盘。"
    />
  </h3>

  <div v-for="command in commands" :key="command.id" class="shortcut-row">
    <div class="shortcut-main">
      <span class="shortcut-label">
        {{ command.label }}
        <span class="shortcut-scope">{{ SCOPE_LABEL[command.scope] }}</span>
      </span>
      <span class="shortcut-hint">{{ command.hint }}</span>
    </div>

    <div class="shortcut-keys">
      <template v-for="(binding, index) in bindingsOf(command.id)" :key="index">
        <span class="shortcut-binding">
          <button
            type="button"
            class="shortcut-keys-btn"
            :class="{ 'is-recording': recording?.id === command.id && recording?.index === index }"
            :aria-label="`修改「${command.label}」的第 ${index + 1} 组快捷键`"
            @click="startRecording(command.id, index)"
          >
            <template v-if="recording?.id === command.id && recording?.index === index">
              <kbd class="shortcut-recording">按下新快捷键…</kbd>
            </template>
            <template v-else-if="binding">
              <kbd v-for="(part, partIndex) in bindingParts(binding)" :key="partIndex">
                {{ part }}
              </kbd>
            </template>
            <template v-else>
              <kbd>未设置</kbd>
            </template>
          </button>
          <!-- 冲突**就说出来是谁占着**（ZCode 的冲突提示）：只说"冲突了"，
               用户还得自己在这一屏里找是跟哪一条撞了 -->
          <span v-if="conflictMessage(command.id, binding)" class="shortcut-conflict">
            {{ conflictMessage(command.id, binding) }}
          </span>
          <button
            v-if="bindingsOf(command.id).length > 1"
            type="button"
            class="shortcut-remove"
            :aria-label="`删除「${command.label}」的这一组快捷键`"
            @click="removeBinding(command.id, index)"
          >
            删除
          </button>
        </span>
      </template>
      <AppButton size="sm" :disabled="recording !== null" @click="addAndRecord(command.id)">
        添加
      </AppButton>
      <AppButton
        v-if="isCustomized(command.id)"
        size="sm"
        :disabled="recording !== null"
        @click="resetCommand(command.id)"
      >
        恢复默认
      </AppButton>
    </div>
  </div>

  <p v-if="recording" class="row-note" role="status">
    正在录制「{{ commands.find((item) => item.id === recording?.id)?.label }}」：按下一组键即可， 按
    Esc 取消。
    <button type="button" class="shortcut-cancel" @click="stopRecording">取消</button>
  </p>

  <div class="shortcut-foot">
    <AppButton size="sm" @click="resetAllShortcuts">全部恢复默认</AppButton>
  </div>
</template>

<style scoped>
.shortcut-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--border-hairline);
}

.shortcut-row:last-of-type {
  border-bottom: none;
}

.shortcut-main {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.shortcut-label {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-body-size);
  color: var(--text-primary);
}

/* 作用域标在名字旁边（输入框 / 全局）：它决定"这一条在哪管用"，
   是这个页面上最容易被忽略、又最影响判断的一件信息 */
.shortcut-scope {
  padding: 0 var(--space-2);
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
  background: var(--bg-subtle);
  border-radius: var(--radius-badge);
}

.shortcut-hint {
  font-size: var(--text-micro-size);
  color: var(--text-secondary);
}

.shortcut-keys {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
}

.shortcut-binding {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}

/* 一组键是两枚独立的小片（与侧栏那处同一形状）：分开才能各自有底色与圆角 */
.shortcut-keys-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-height: var(--control-height);
  padding: 0 var(--space-2);
  border-radius: var(--radius-control);
  transition: var(--transition-ui);
}

.shortcut-keys-btn:hover {
  background: var(--bg-hover);
}

.shortcut-keys-btn.is-recording {
  background: var(--accent-soft);
}

kbd {
  min-width: 20px;
  padding: 1px var(--space-1);
  font-family: var(--font-mono);
  font-size: var(--text-micro-size);
  text-align: center;
  color: var(--text-secondary);
  background: var(--bg-subtle);
  border-radius: var(--radius-badge);
}

.shortcut-recording {
  min-width: 120px;
  color: var(--accent-text);
}

.shortcut-conflict {
  font-size: var(--text-micro-size);
  color: var(--status-warning);
}

.shortcut-remove,
.shortcut-cancel {
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
  transition: var(--transition-ui);
}

.shortcut-remove:hover,
.shortcut-cancel:hover {
  color: var(--text-primary);
}

.shortcut-cancel {
  margin-left: var(--space-2);
  color: var(--accent-text);
}

.shortcut-foot {
  display: flex;
  justify-content: flex-end;
  margin-top: var(--space-4);
}
</style>
