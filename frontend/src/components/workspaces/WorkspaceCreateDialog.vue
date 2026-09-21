<script setup lang="ts">
/**
 * 新建工作区弹窗（v0.25）。
 *
 * ## 为什么从整页改成弹窗
 *
 * 改前：点「新建工作区」是给当前页加一个 `?new=1`，右列那套表单切成"新建态"。
 * 三个问题：**要离开你在的地方**（哪怕只是想边看清单边建一个）、表头那颗「保存」
 * 同时管着"新建"和"改现有的"两件事、空表单常驻在页面右侧。
 *
 * 参考 kimi.com 的做法（`/project/create`）：它的新建项目是一个**专注的单字段界面**
 * ——一个名字输入 + 一排图标，没有清单、没有页面壳。我们比它多两个字段
 * （根目录是必需的：它是 Agent 文件操作的边界，砍不掉），所以形态取"弹窗"而不是
 * "独立页"：同样专注，但不占一次导航。Kimi Work / Kimi Code 没有公开 web 应用
 * （都是桌面端），所以参考的是 kimi.com 自己那一处，见对照文档 §9。
 *
 * ## 为什么这里**不问**绑不绑知识库（v0.41 去掉的）
 *
 * 绑哪些库是工作区**建成之后**的事：它回答的是"这个项目去哪儿找资料"，
 * 而刚建的那一刻用户手上往往还没有这个判断（多数人是先建一个空项目再往里放东西）。
 * 摆在这里等于逼他做一个还没到做的决定，做错了还得回头改。
 * 现在它只在工作区自己的设置里（右栏那组「知识库」），改完当场生效。
 *
 * ## 为什么弹窗自己调接口
 *
 * 它是一次完整的"填 → 校验 → 建"的动作。让调用方先接住表单再转手提交，
 * 会让"提交中"这个状态散到两处（弹窗的按钮要显示"创建中…"，页面也要知道）。
 * 建完只往外抛一个 `created`，调用方负责选中它（并直接开一个新会话进去）。
 */
import { ref, watch } from 'vue'

import type { Workspace } from '@/api/workspaces'
import DirectoryPickerDialog from '@/components/workspaces/DirectoryPickerDialog.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppModal from '@/components/ui/AppModal.vue'
import InfoTip from '@/components/ui/InfoTip.vue'
import { isAdmin } from '@/composables/useSession'
import { useToast } from '@/composables/useToast'
import { useWorkspaceStore } from '@/stores/workspaces'

const open = defineModel<boolean>('open', { required: true })

const emit = defineEmits<{ created: [workspace: Workspace] }>()

const workspaces = useWorkspaceStore()
const { notifyError } = useToast()

const name = ref('')
const rootPath = ref('')
const description = ref('')
const saving = ref(false)
const picking = ref(false)

/** 每次打开都从空白开始：上一次的残值会让人以为"它记住了"，其实只是没清。 */
watch(open, (isOpen) => {
  if (!isOpen) return
  name.value = ''
  rootPath.value = ''
  description.value = ''
})

const ready = () => Boolean(name.value.trim() && rootPath.value.trim())

async function submit(): Promise<void> {
  if (!ready() || saving.value) return
  saving.value = true
  try {
    const created = await workspaces.create({
      name: name.value.trim(),
      root_path: rootPath.value.trim(),
      description: description.value.trim(),
    })
    open.value = false
    emit('created', created)
  } catch (error) {
    // 后端的校验文案是这一层最主要的产出（路径不存在、指向数据目录、是文件系统根），
    // 原样透出来——换成"创建失败"就把唯一有用的信息丢了
    notifyError(error instanceof Error ? error.message : '创建失败')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <AppModal v-model:open="open" title="新建工作区">
    <div class="ws-create">
      <label class="field">
        <span class="field-label">名字</span>
        <AppInput v-model="name" placeholder="例如：知识库产品化" />
      </label>

      <div class="field">
        <span class="field-label">
          根目录
          <InfoTip
            text="这是 Agent 文件操作的边界：它能读写的位置被约束在这个目录之内。要给一个**服务器上已存在**的目录——不存在的路径会被拒绝（不会替你建一个空目录），数据目录与文件系统根也会被拒绝。"
          />
        </span>
        <div class="path-row">
          <AppInput
            v-model="rootPath"
            :placeholder="isAdmin ? '点右边的「浏览…」挑一个' : '例如：/volume1/my-project'"
          />
          <!-- 目录浏览**管理员专属**（它列的是服务器上的目录树）。
               成员直接填路径——与端点那边的判定一致，不做无用的请求 -->
          <AppButton v-if="isAdmin" @click="picking = true">浏览…</AppButton>
        </div>
      </div>

      <label class="field">
        <span class="field-label">描述（可选）</span>
        <AppInput v-model="description" placeholder="这个项目是做什么的" />
      </label>
    </div>

    <DirectoryPickerDialog v-model:open="picking" :start="rootPath" @pick="rootPath = $event" />

    <template #footer>
      <AppButton @click="open = false">取消</AppButton>
      <AppButton variant="primary" :disabled="!ready || saving" @click="submit">
        {{ saving ? '创建中…' : '创建工作区' }}
      </AppButton>
    </template>
  </AppModal>
</template>

<style scoped>
.ws-create {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

/* 路径输入 + 「浏览…」：输入框吃掉剩余宽度，按钮不缩 */
.path-row {
  display: flex;
  gap: var(--space-2);
}

.path-row > :first-child {
  flex: 1;
  min-width: 0;
}
</style>
