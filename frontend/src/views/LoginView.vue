<script setup lang="ts">
/**
 * 登录 / 首次初始化（v10 账号体系的前端入口）。
 *
 * 一个页面两种模式，由 `/auth/status` 的 `needs_setup` 决定：
 * - **首次设置**：还没有任何可登录账号 → 创建管理员（用户名 + 显示名 + 密码 + 确认）；
 * - **登录**：已有账号 → 用户名 + 密码。
 *
 * 为什么不做成注册页：本产品面向个人与家庭自托管，**不开放注册**——
 * 首个用户即管理员，其余账号由管理员在设置里开通（计划 §12.20 的决策）。
 * 所以"首次设置"是引导，不是注册。
 *
 * 视觉上刻意只留一条窄列：登录页没有可"扫视比较"的内容，
 * 界面越像一份表越好——品牌名、标题、两个字段、一个按钮。
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { MIN_PASSWORD_CHARS } from '@/api/auth'
import IconLogo from '@/components/icons/IconLogo.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppInput from '@/components/ui/AppInput.vue'
import { ensureAuthStatus, login, setup } from '@/composables/useSession'
import { authStatus, hasCredential } from '@/composables/useSessionToken'

const route = useRoute()
const router = useRouter()

/** 已持有凭据时不再要求登录；守卫通常已经拦下了，这里是页内二次确认。 */
const isSetup = computed(() => authStatus.value?.needs_setup === true)

const username = ref('')
const displayName = ref('')
const password = ref('')
const confirmPassword = ref('')
const busy = ref(false)
const error = ref('')

/** 登录后回到用户原本想去的页面（守卫在 query 里带了 redirect）。 */
function redirectTarget(): string {
  const wanted = route.query.redirect
  return typeof wanted === 'string' && wanted.startsWith('/') ? wanted : '/'
}

onMounted(async () => {
  await ensureAuthStatus()
  if (!isSetup.value && hasCredential()) {
    await router.replace(redirectTarget())
  }
})

async function submit(): Promise<void> {
  error.value = ''
  const name = username.value.trim()
  if (!name) {
    error.value = '请填写用户名'
    return
  }
  if (!password.value) {
    error.value = '请填写密码'
    return
  }
  if (isSetup.value) {
    if (password.value.length < MIN_PASSWORD_CHARS) {
      error.value = `密码至少 ${MIN_PASSWORD_CHARS} 个字符`
      return
    }
    if (password.value !== confirmPassword.value) {
      error.value = '两次输入的密码不一致'
      return
    }
  }
  busy.value = true
  try {
    if (isSetup.value) {
      await setup(name, password.value, displayName.value.trim() || undefined)
    } else {
      await login(name, password.value)
    }
    await router.replace(redirectTarget())
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : '操作失败，请重试'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="login">
    <div class="login-panel">
      <div class="login-brand">
        <IconLogo :size="32" />
      </div>

      <h1 class="login-title">{{ isSetup ? '创建管理员账号' : '登录' }}</h1>
      <p class="login-hint">
        {{
          isSetup
            ? '第一次使用：创建管理员账号后即可进入。此前的知识库会自动归到该账号名下。'
            : '用管理员为你开通的账号登录。'
        }}
      </p>

      <form class="login-form" @submit.prevent="submit">
        <div class="field">
          <label class="field-label" for="login-username">用户名</label>
          <AppInput
            id="login-username"
            v-model="username"
            :placeholder="isSetup ? '由你决定，例如 admin' : ''"
            autocomplete="username"
            :disabled="busy"
          />
        </div>

        <div v-if="isSetup" class="field">
          <label class="field-label" for="login-name"
            >显示名 <span class="field-optional">可选</span></label
          >
          <AppInput
            id="login-name"
            v-model="displayName"
            placeholder="界面上显示的名字，留空则用用户名"
            :disabled="busy"
          />
        </div>

        <div class="field">
          <label class="field-label" for="login-password">密码</label>
          <AppInput
            id="login-password"
            v-model="password"
            type="password"
            :placeholder="isSetup ? `至少 ${MIN_PASSWORD_CHARS} 个字符` : ''"
            autocomplete="current-password"
            :disabled="busy"
          />
        </div>

        <div v-if="isSetup" class="field">
          <label class="field-label" for="login-confirm">确认密码</label>
          <AppInput
            id="login-confirm"
            v-model="confirmPassword"
            type="password"
            autocomplete="new-password"
            :disabled="busy"
          />
        </div>

        <p v-if="error" class="login-error" role="alert">{{ error }}</p>

        <AppButton class="login-submit" variant="primary" type="submit" block :disabled="busy">
          {{ busy ? '请稍候…' : isSetup ? '创建并进入' : '登录' }}
        </AppButton>
      </form>
    </div>

    <p class="login-foot">本地优先 · 数据不出机器</p>
  </div>
</template>

<style scoped>
.login {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-6);
  min-height: 100%;
  padding: var(--space-8) var(--space-4);
  background: var(--bg-canvas);
}

.login-panel {
  width: 100%;
  max-width: 360px;
  padding: var(--space-8) var(--space-6) var(--space-6);
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-panel);
}

.login-brand {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--text-primary);
}

.login-title {
  margin: var(--space-6) 0 0;
  font-size: var(--text-page-title-size);
}

.login-hint {
  margin: var(--space-2) 0 0;
  font-size: var(--text-micro-size);
  line-height: 1.6;
  color: var(--text-secondary);
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  margin-top: var(--space-6);
}

/* .field / .field-label / .field-optional 走全局（base.css），
   这里不再各写一套——六处表单标签曾经就是各写一套的（评审 §2.1） */

.login-error {
  margin: 0;
  font-size: var(--text-micro-size);
  line-height: 1.6;
  color: var(--status-danger);
}

/* 占满整列由 AppButton 的 block 负责；这里只留与上方字段的间距 */
.login-submit {
  margin-top: var(--space-1);
}

.login-foot {
  margin: 0;
  font-size: var(--text-micro-size);
  color: var(--text-tertiary);
}
</style>
