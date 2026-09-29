/*
 * 引导页的逻辑（`shell/src/index.html` 引它，`resources.rs` 把它一起嵌进 exe）。
 *
 * 两个职责：
 * ① 把真实前端从**本地资源目录**拉起来（`app://`）；
 * ② 拉不起来时，给用户一个"连接 / 更换服务器"的入口。
 *
 * **连接即登录（P4-4 片①）**：壳要拿去调服务器的是**长期凭据**（API Key）。
 * 所以表单除了地址还收一次**用户名 + 密码**——它只用来换一把钥匙，之后
 * 壳一直用那把钥匙；**密码与会话令牌都不落盘**（配置文件里没有密码那一栏）。
 * 已经有钥匙时这两栏可以留空（启动自动连接走的就是"直接复用钥匙"那条路）。
 *
 * 与 Rust 的通道是 `window.__TAURI__.core.invoke`（靠 `tauri.conf.json` 的
 * `withGlobalTauri: true`）。没有 `__TAURI__` 时（用浏览器直接打开这一页调样式）
 * **不报错、不装死**：表单照常显示，只在点连接时说清"要在桌面壳里"。
 *
 * 为什么是独立文件而不是内联 `<script>`：CSP 是 `script-src 'self' app:`，
 * 内联脚本会被直接拦掉（`'unsafe-inline'` 我们刻意不给）。代价是这一份要**跟着
 * exe 一起嵌**（见 `resources.rs` 的 `BOOT_ASSETS`），否则兜底路径上取不到它。
 */

const tauri = window.__TAURI__ && window.__TAURI__.core
const invoke = tauri ? tauri.invoke : null

/** 本地资源加载用的入口 URL。**由 Rust 给**（平台不同写法不同，见 `resources::app_url`）。 */
let APP_URL = 'app://localhost/'

const el = (id) => document.getElementById(id)
const spinner = el('spinner')
const title = el('title')
const sub = el('sub')
const form = el('form')
const address = el('address')
const username = el('username')
const password = el('password')
const confirm = el('confirm')
const confirmField = el('confirm-field')
const submit = el('submit')
const status = el('status')
const error = el('error')
const recentBox = el('recent')
const recentList = el('recent-list')
const version = el('version')

let busy = false
/** 这台服务器还没有任何账号（`/auth/status` 的 `needs_setup`）：文案与"确认密码"看它。 */
let needsSetup = false

/** 口令下限：与后端 `services/auth.py::MIN_PASSWORD_CHARS` 对齐。 */
const MIN_PASSWORD_CHARS = 8

function note(message) {
  if (invoke) void invoke('note', { message }).catch(() => {})
  else console.info('[kylab-shell]', message)
}

function setBusy(next, message) {
  busy = next
  address.disabled = next
  username.disabled = next
  password.disabled = next
  confirm.disabled = next
  submit.disabled = next
  status.hidden = !message
  status.textContent = message || ''
}

function showError(message) {
  error.hidden = false
  error.textContent = message
}

/**
 * 问一句"这台服务器要不要先建管理员"，据此换文案与"确认密码"栏。
 *
 * **失败不打扰用户**：查不到就按"登录"显示——真正的报错该由点连接那一步给出来
 * （那一步才会把地址、网络、401 一起说清）。
 */
async function refreshSignInState() {
  if (!invoke) return
  const target = address.value.trim()
  try {
    const info = await invoke('signin_status', { address: target })
    needsSetup = info && info.needs_setup === true
  } catch (cause) {
    note('登录状态没查到（' + cause + '），按"登录"显示')
    needsSetup = false
  }
  applySignInCopy()
}

/** 文案与按钮跟着 `needsSetup` 走（只在表单那一屏有意义）。 */
function applySignInCopy() {
  confirmField.hidden = !needsSetup
  submit.textContent = needsSetup ? '创建管理员并进入' : '连接并进入'
  if (needsSetup) {
    title.textContent = '首次设置管理员'
    sub.textContent =
      '这台 KYLAB 还没有账号：第一个账号就是管理员。登录后壳会领一把长期钥匙存下来（密码不存）。'
  }
}

function renderRecent(items) {
  recentList.replaceChildren()
  recentBox.hidden = !items || items.length === 0
  for (const item of items || []) {
    const li = document.createElement('li')
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = item
    button.title = item
    button.addEventListener('click', () => {
      if (busy) return
      address.value = item
      void refreshSignInState()
      void run(item, true, null)
    })
    li.append(button)
    recentList.append(li)
  }
}

/**
 * 走一次连接：Rust 那边 探活 → 登录（没有钥匙时）→ 领钥匙 → 把主窗导航到
 * `app://`（本地资源，不再是远端 URL）。
 *
 * `credentials` 为 `null` 或空串 = **复用已存下的钥匙**（不登录）。
 */
async function run(target, remember, credentials) {
  if (busy) return
  if (!invoke) {
    showError('这是浏览器里的预览：真正的连接要在桌面壳里点')
    return
  }
  error.hidden = true
  error.textContent = ''
  const who = credentials && credentials.username ? '（账号 ' + credentials.username + '）' : ''
  setBusy(true, '正在连接 ' + target + who + ' …')
  note('开始连接 ' + target + who + (remember ? '（用户主动改）' : '（启动自动连）'))
  try {
    const result = await invoke('connect', {
      address: target,
      remember,
      username: (credentials && credentials.username) || '',
      password: (credentials && credentials.password) || '',
    })
    setBusy(false)
    if (result && result.signed_in) {
      note('已领到钥匙：' + (result.key_name || '?') + ' / ' + (result.key_prefix || '?'))
    }
  } catch (message) {
    setBusy(false)
    showError(String(message))
    note('连接失败：' + message)
    address.focus()
    address.select()
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault()
  const target = address.value.trim()
  if (!target) {
    showError('请填写服务器地址')
    address.focus()
    return
  }
  const user = username.value.trim()
  const secret = password.value
  const repeated = confirm.value

  // 两栏都空 = 用已经存下的钥匙（首次连接时 Rust 那边会说"这台机器还没有钥匙"）
  if (!user && !secret) {
    void run(target, true, null)
    return
  }
  if (!user) {
    showError('请填用户名')
    username.focus()
    return
  }
  if (!secret) {
    showError('请填密码')
    password.focus()
    return
  }
  if (needsSetup) {
    if (secret.length < MIN_PASSWORD_CHARS) {
      showError('密码至少 ' + MIN_PASSWORD_CHARS + ' 位')
      password.focus()
      return
    }
    if (secret !== repeated) {
      showError('两次输入的密码不一样')
      confirm.focus()
      confirm.select()
      return
    }
  }
  void run(target, true, { username: user, password: secret })
})

// 地址填完就问一句"要不要先建管理员"（不打扰：失败按"登录"显示）
address.addEventListener('blur', () => {
  if (!busy) void refreshSignInState()
})

async function main() {
  if (!invoke) {
    spinner.hidden = true
    title.textContent = 'KYLAB 桌面壳'
    sub.textContent = '这是浏览器预览（没有壳的通道）；表单可以调样式，连接要在壳里点。'
    form.hidden = false
    version.textContent = '浏览器预览'
    address.focus()
    return
  }

  let info
  try {
    info = await invoke('startup')
  } catch (cause) {
    spinner.hidden = true
    title.textContent = '壳与页面对不上话'
    sub.textContent = String(cause)
    return
  }

  version.textContent = 'KYLAB 桌面壳 ' + info.shell_version
  renderRecent(info.recent)
  if (info.server) address.value = info.server
  // 入口 URL 由 Rust 给：Windows 是 http://app.localhost/，macOS/Linux 才是 app://localhost/
  if (info.app_url) APP_URL = info.app_url

  const resources = info.resources || {}

  /*
   * 主窗 + 地址已配 + **本地有可用资源** + **手里有钥匙** → 直接进应用（`app://`）。
   * 这一跳是"切页面不再等网络"的起点：之后所有 `.js` / `.css` 都由协议层
   * 从本地磁盘给，只有 `/api/**` 转发到远端那台服务器。
   *
   * 为什么要 `has_key`：没有钥匙时进了应用也连不上服务器（边车拿不到 token），
   * 不如当场让用户登录一次——那一次之后 `has_key` 就一直是真。
   */
  const canUseLocalApp =
    info.role === 'main' && info.server && info.has_key === true && resources.has_app === true
  if (canUseLocalApp) {
    note('引导：本地资源就绪（' + (resources.version || '未知版本') + '），跳 app://')
    sub.textContent = '正在从本地加载界面（' + (resources.version || '') + '）…'
    window.location.replace(APP_URL)
    return
  }

  // 否则显示表单：要么没配过地址，要么本地资源还没就位，要么还没有钥匙
  spinner.hidden = true
  form.hidden = false
  if (info.role === 'main' && info.server && !resources.has_app) {
    title.textContent = '还没有可用的界面资源'
    sub.textContent = '本地资源目录里没有前端产物；填服务器地址照常可用（后端 API 在远端）。'
    note('引导：本地资源缺失（' + (resources.root || '') + '），留在配置页')
  } else if (info.server && info.has_key !== true) {
    title.textContent = '登录这台 KYLAB'
    sub.textContent = '地址已经填好；登录一次，壳会领一把长期钥匙存下来（密码不存）。'
  } else if (info.server) {
    title.textContent = '更换服务器'
    sub.textContent = '地址已经填好，改完点连接。'
  } else {
    title.textContent = '连接到 KYLAB'
    sub.textContent = '填上你 NAS 上那台 KYLAB 的地址，再用服务器上的账号登录一次。'
  }
  if (info.user_name || info.key_name) {
    note('壳里已存钥匙：' + (info.user_name || '?') + ' / ' + (info.key_name || '?'))
  }
  // 地址已经填好就顺手问一句"要不要先建管理员"，好把文案与"确认密码"摆对
  if (address.value.trim()) void refreshSignInState()
  address.focus()
  address.select()
}

void main()
