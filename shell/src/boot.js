/*
 * 引导页的逻辑（`shell/src/index.html` 引它，`resources.rs` 把它一起嵌进 exe）。
 *
 * 两个职责：
 * ① 把真实前端从**本地资源目录**拉起来（`app://`）；
 * ② 拉不起来时，给用户一个"连接 / 更换服务器"的入口。
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
const submit = el('submit')
const status = el('status')
const error = el('error')
const recentBox = el('recent')
const recentList = el('recent-list')
const version = el('version')

let busy = false

function note(message) {
  if (invoke) void invoke('note', { message }).catch(() => {})
  else console.info('[kylab-shell]', message)
}

function setBusy(next, message) {
  busy = next
  address.disabled = next
  submit.disabled = next
  status.hidden = !message
  status.textContent = message || ''
}

function showError(message) {
  error.hidden = false
  error.textContent = message
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
      void run(item, true)
    })
    li.append(button)
    recentList.append(li)
  }
}

/** 走一次连接。成功后 Rust 会把主窗导航到 `app://`（本地资源），不再是远端 URL。 */
async function run(target, remember) {
  if (busy) return
  if (!invoke) {
    showError('这是浏览器里的预览：真正的连接要在桌面壳里点')
    return
  }
  error.hidden = true
  error.textContent = ''
  setBusy(true, '正在连接 ' + target + ' …')
  note('开始连接 ' + target + (remember ? '（用户主动改）' : '（启动自动连）'))
  try {
    await invoke('connect', { address: target, remember })
    setBusy(false)
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
  void run(target, true)
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
   * 主窗 + 地址已配 + **本地有可用资源** → 直接进应用（`app://`）。
   * 这一跳是"切页面不再等网络"的起点：之后所有 `.js` / `.css` 都由协议层
   * 从本地磁盘给，只有 `/api/**` 转发到远端那台服务器。
   */
  const canUseLocalApp = info.role === 'main' && info.server && resources.has_app === true
  if (canUseLocalApp) {
    note('引导：本地资源就绪（' + (resources.version || '未知版本') + '），跳 app://')
    sub.textContent = '正在从本地加载界面（' + (resources.version || '') + '）…'
    window.location.replace(APP_URL)
    return
  }

  // 否则显示表单：要么没配过地址，要么本地资源还没就位
  spinner.hidden = true
  form.hidden = false
  if (info.role === 'main' && info.server && !resources.has_app) {
    title.textContent = '还没有可用的界面资源'
    sub.textContent = '本地资源目录里没有前端产物；填服务器地址照常可用（后端 API 在远端）。'
    note('引导：本地资源缺失（' + (resources.root || '') + '），留在配置页')
  } else if (info.server) {
    title.textContent = '更换服务器'
    sub.textContent = '地址已经填好，改完点连接。'
  } else {
    title.textContent = '连接到 KYLAB'
    sub.textContent = '填上你 NAS 上那台 KYLAB 的地址。'
  }
  address.focus()
  address.select()
}

void main()
