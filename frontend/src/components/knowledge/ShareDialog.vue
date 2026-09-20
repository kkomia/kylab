<script setup lang="ts">
/**
 * 知识库分享弹窗（v10「私有 + 可分享」）。
 *
 * 三个刻意的取舍：
 *
 * 1. **按登录名授出，不做成员下拉**：`/users` 是控制台级端点，成员调不通——
 *    而分享恰恰是成员最常用的动作。让 owner 敲对方的登录名，是唯一既不提权、
 *    又不泄露名册全貌的方式（后端 `services/share.py` 的说明）。
 * 2. **档位在行内改**：把"只读 / 可写"做成每行一个下拉，而不是"删了再授"——
 *    调整权限不该产生一次权限真空。
 * 3. **收回不做二次确认**：它是可逆的（再授一次即可），且确认弹窗会挡住
 *    下面的列表，让"我到底给了谁"看不清。破坏性动作的确认口径见规范 §10.3。
 */
import { onMounted, ref, watch } from 'vue'

import { grantShare, listShares, revokeShare, type Share, type SharePermission } from '@/api/shares'
import AppButton from '@/components/ui/AppButton.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppModal from '@/components/ui/AppModal.vue'
import AppSelect from '@/components/ui/AppSelect.vue'
import { useToast } from '@/composables/useToast'

const open = defineModel<boolean>('open', { required: true })

const props = defineProps<{ kbId: string; kbName: string }>()

const { notifyError, notifySuccess } = useToast()

const shares = ref<Share[]>([])
const loading = ref(false)
const loadError = ref('')
const usernameDraft = ref('')
const permissionDraft = ref<SharePermission>('read')
const granting = ref(false)
const grantError = ref('')
/** 正在改档位 / 收回的 user_id：行内按钮据此显示忙碌态。 */
const busyId = ref('')

const PERMISSION_OPTIONS: { value: SharePermission; label: string }[] = [
  { value: 'read', label: '只读' },
  { value: 'write', label: '可写' },
]

async function load(): Promise<void> {
  loading.value = true
  try {
    shares.value = (await listShares(props.kbId)).items
    loadError.value = ''
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : '分享列表加载失败'
  } finally {
    loading.value = false
  }
}

watch(open, (value) => {
  if (value) {
    usernameDraft.value = ''
    permissionDraft.value = 'read'
    grantError.value = ''
    void load()
  }
})

onMounted(() => {
  if (open.value) void load()
})

async function submitGrant(): Promise<void> {
  const username = usernameDraft.value.trim()
  if (!username) {
    grantError.value = '请填写对方的登录名'
    return
  }
  granting.value = true
  grantError.value = ''
  try {
    const share = await grantShare(props.kbId, username, permissionDraft.value)
    usernameDraft.value = ''
    notifySuccess(`已分享给 ${share.name}（${share.username}）`)
    await load()
  } catch (error) {
    grantError.value = error instanceof Error ? error.message : '分享失败'
  } finally {
    granting.value = false
  }
}

async function changePermission(share: Share, permission: string): Promise<void> {
  if (permission === share.permission) return
  busyId.value = share.user_id
  try {
    await grantShare(props.kbId, share.username, permission as SharePermission)
    await load()
  } catch (error) {
    notifyError(error instanceof Error ? error.message : '调整档位失败')
    await load()
  } finally {
    busyId.value = ''
  }
}

async function revoke(share: Share): Promise<void> {
  busyId.value = share.user_id
  try {
    await revokeShare(props.kbId, share.user_id)
    notifySuccess(`已收回「${share.name}」的访问`)
    await load()
  } catch (error) {
    notifyError(error instanceof Error ? error.message : '收回失败')
  } finally {
    busyId.value = ''
  }
}
</script>

<template>
  <AppModal v-model:open="open" title="分享知识库">
    <p class="share-lead">把「{{ kbName }}」分享给其他成员。对方登录后就能在列表里看到它。</p>

    <div class="grant">
      <AppInput
        v-model="usernameDraft"
        placeholder="对方的登录名"
        aria-label="对方的登录名"
        :disabled="granting"
        @keyup.enter="submitGrant"
      />
      <AppSelect
        v-model="permissionDraft"
        class="grant-permission"
        :options="PERMISSION_OPTIONS"
        aria-label="访问档位"
        :disabled="granting"
      />
      <AppButton variant="primary" :disabled="granting" @click="submitGrant">
        {{ granting ? '分享中…' : '分享' }}
      </AppButton>
    </div>
    <p v-if="grantError" class="share-error" role="alert">{{ grantError }}</p>
    <p class="text-hint share-note">
      只读 = 可检索、可对话；可写 = 还能上传与删除。被分享者不能把库再转授给别人。
    </p>

    <h3 class="share-title">已分享给</h3>
    <p v-if="loading" class="text-hint share-note">正在加载…</p>
    <p v-else-if="loadError" class="share-error">{{ loadError }}</p>
    <p v-else-if="shares.length === 0" class="text-hint share-note">
      还没有分享给任何人。这个库目前只有你自己（和管理员）能看到。
    </p>
    <ul v-else class="share-list">
      <li v-for="share in shares" :key="share.user_id" class="share-row">
        <span class="share-person">
          <span class="share-name">{{ share.name }}</span>
          <span class="share-username">{{ share.username }}</span>
        </span>
        <AppSelect
          :model-value="share.permission"
          class="row-permission"
          :options="PERMISSION_OPTIONS"
          :disabled="busyId === share.user_id"
          :aria-label="`调整 ${share.name} 的访问档位`"
          @update:model-value="changePermission(share, $event)"
        />
        <AppButton
          variant="danger"
          size="sm"
          :disabled="busyId === share.user_id"
          @click="revoke(share)"
        >
          收回
        </AppButton>
      </li>
    </ul>
  </AppModal>
</template>

<style scoped>
.share-lead {
  margin: 0 0 var(--space-4);
  font-size: var(--text-meta-size);
  line-height: var(--line-prose);
  color: var(--text-secondary);
}

/* 一行完成"填登录名 → 选档位 → 分享"：输入框吃掉剩余宽度 */
.grant {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.grant :deep(.field) {
  flex: 1;
  min-width: 0;
}

/* 档位下拉按内容定宽：让它吃掉剩余宽度会把"登录名"输入框挤到太窄 */
.grant-permission {
  flex: 0 0 104px;
  width: 104px;
}

.share-error {
  margin: var(--space-2) 0 0;
  font-size: var(--text-micro-size);
  color: var(--status-danger);
}

/* 只给全局 .text-hint 补本弹窗需要的上间距（文案口径见 base.css） */
.share-note {
  margin-top: var(--space-2);
}

.share-title {
  margin: var(--space-5) 0 var(--space-2);
  font-size: var(--text-section-size);
}

.share-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.share-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) 0;
  border-bottom: 1px solid var(--border-hairline);
}

.share-row:last-child {
  border-bottom: none;
}

/* 行内档位下拉同样按内容定宽：它不该与"收回"按钮抢空间 */
.row-permission {
  flex: 0 0 88px;
  width: 88px;
}

/* 显示名 + 登录名两行：后者是"账号标识"，用来核对授对了人 */
.share-person {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: var(--space-pair);
}

.share-name {
  overflow: hidden;
  font-size: var(--text-body-size);
  color: var(--text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.share-username {
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}
</style>
