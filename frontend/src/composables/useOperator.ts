/**
 * 当前使用者（调研报告 G6）。
 *
 * **是本地偏好，不是登录态。** 局域网内几个人共用一台机器，浏览器也不区分人，
 * 所以"我是谁"只能由用户自己声明并存在本地。它不参与鉴权——
 * 伪造一个名字不会获得任何权限，只会让归属记错（契约见后端 services/users.py）。
 *
 * **存 id 不存名字**：请求头只能是 ASCII，而名字是中文。
 * 实测往 `X-Kylab-Operator` 里写"小王"会抛
 * `UnicodeEncodeError: 'ascii' codec can't encode`——浏览器与 curl 一样。
 */

import { computed, ref } from 'vue'

import { listUsers, type RosterUser } from '@/api/users'
import { currentUser } from '@/composables/useSessionToken'

const STORAGE_KEY = 'kylab-operator-id'

/**
 * 当前使用者的 id（空 = 没声明身份，归属记成"未记录"）。
 *
 * **导出 ref 本身**（`export const`）而不是包一层取值函数：界面要把它绑到
 * `<select :value>` 上，绑函数不会建立响应式依赖——刷新后 localStorage 里
 * 明明有值、下拉却显示"未指定"（实测踩到，且现象很像"存储没生效"，
 * 实际是响应式断在了这一层）。
 */
export const operatorId = ref(readStored())

/** 名册缓存：界面与请求头都要用，避免每处各查一次。 */
export const roster = ref<RosterUser[]>([])

/** 当前使用者对象（不在名册里时为 undefined）。 */
export const operator = computed(() => roster.value.find((item) => item.id === operatorId.value))

function readStored(): string {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? ''
  } catch {
    // 隐私模式下 localStorage 会抛；没有身份也能用，退化成"未记录"
    return ''
  }
}

/**
 * 拉名册。
 *
 * 失败不抛：名册是可选的，拿不到就退化成"不记归属"，
 * 不该因此让整个界面报错（比如鉴权开着而没填令牌时）。
 */
export async function loadRoster(): Promise<void> {
  try {
    roster.value = (await listUsers()).items
    // 名册里已经没有这个人了（被管理员删掉）：清掉本地选择，
    // 否则请求头会一直带一个不存在的 id
    if (operatorId.value && !operator.value) setOperator('')
  } catch {
    roster.value = []
  }
}

export function setOperator(id: string): void {
  operatorId.value = id
  try {
    if (id) window.localStorage.setItem(STORAGE_KEY, id)
    else window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // 存不上就只在本次会话生效
  }
}

/** 供 `client.ts` 组装请求头用：**每个请求都带**，不只是上传。 */
export function operatorHeaders(): Record<string, string> {
  // 归属 = 当前用户（用户批注：不在系统里切换使用者）。
  // 登录态下由账号身份决定，"谁传的"与"谁登录着"就永远一致；
  // 只有没有登录态的旧部署（控制台令牌通道）才回退到本地声明。
  const id = currentUser.value?.id ?? operatorId.value
  return id ? { 'X-Kylab-Operator': id } : {}
}
