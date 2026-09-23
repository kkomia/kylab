/*
 * 配置页的逻辑（开发计划 §12.207）。
 *
 * 三种状态，一套流程：
 *
 * 1. **首次使用**（配置里没有地址）：显示表单，光标落在输入框里；
 * 2. **启动**（配置里有地址）：**直接连它**——这正是"配了一次就一直是它"，
 *    用户不该每次开机都看见这张表单；
 * 3. **连不上**：留在这一页，把地址填回输入框、把原因写在下面，再给一个「重试」。
 *    **不清空配置**：地址是用户配的，NAS 关机不是他的错。
 *
 * 这一页在两个窗口里都会跑：`main` 窗按上面的规则来，`connect` 窗（菜单里的
 * 「更换服务器」）永远只显示表单——用户是主动来改地址的，不该被自动连接打断。
 *
 * 与 Rust 的通道是 `window.__TAURI__.core.invoke`（靠 `tauri.conf.json` 的
 * `withGlobalTauri: true` 拿到），**不引打包器**：这一页就一个表单，
 * 为它养一条前端构建链不划算。
 *
 * 没有 `__TAURI__` 时（用浏览器直接打开这一页做样式预览）**不报错、不装死**：
 * 表单照常显示，只是连接按钮说清"要在桌面壳里才能连"。这样改美术不必每次都
 * 编译 Rust——壳里没法 F12，浏览器里可以。
 */

const tauri = window.__TAURI__?.core
const invoke = tauri ? tauri.invoke : null

const form = document.getElementById('form')
const address = document.getElementById('address')
const submit = document.getElementById('submit')
const status = document.getElementById('status')
const error = document.getElementById('error')
const recentBox = document.getElementById('recent')
const recentList = document.getElementById('recent-list')
const version = document.getElementById('version')
const brand = document.getElementById('brand')

let busy = false

/** 把页面这一侧的关键动作写进壳的日志（没有壳时就只打到控制台）。 */
function note(message) {
  if (invoke) {
    void invoke('note', { message }).catch(() => {})
  } else {
    console.info('[kylab-shell]', message)
  }
}

/** 品牌标：与产品同一份 SVG（`logo.svg` 就是从 `chat/ui/Logo.tsx` 的 mark 档取的）。 */
async function loadBrand() {
  try {
    const response = await fetch('logo.svg')
    if (!response.ok) throw new Error(String(response.status))
    brand.innerHTML = await response.text()
  } catch {
    // 取不到标也不影响用：退成一个字标
    brand.innerHTML = '<span class="brand-fallback">KYLAB</span>'
  }
}

function setBusy(next, message) {
  busy = next
  address.disabled = next
  submit.disabled = next
  status.hidden = !message
  status.textContent = message ?? ''
}

function showError(message) {
  error.hidden = false
  error.textContent = message
}

function clearError() {
  error.hidden = true
  error.textContent = ''
}

function renderRecent(items) {
  recentList.replaceChildren()
  recentBox.hidden = items.length === 0
  for (const item of items) {
    const li = document.createElement('li')
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'recent-item'
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

/**
 * 走一次连接。`remember` 只在用户主动给地址时为真（见 Rust 侧的说明）：
 * 启动时的自动连接**不会**改写配置，所以"配了就一直用它"是成立的。
 */
async function run(target, remember) {
  if (busy) return
  if (!invoke) {
    showError('这是浏览器里的预览：真正的连接要在桌面壳里点')
    return
  }
  clearError()
  setBusy(true, `正在连接 ${target} …`)
  note(`开始连接 ${target}（${remember ? '用户主动改' : '启动自动连'}）`)
  try {
    await invoke('connect', { address: target, remember })
    // 成功的话主窗已经被导航走了，这一行通常到不了
    setBusy(false)
  } catch (message) {
    setBusy(false)
    showError(String(message))
    note(`连接失败：${message}`)
    address.focus()
    address.select()
  }
}

function submitForm(event) {
  event.preventDefault()
  const target = address.value.trim()
  if (!target) {
    showError('请填写服务器地址')
    address.focus()
    return
  }
  void run(target, true)
}

async function main() {
  void loadBrand()
  form.addEventListener('submit', submitForm)

  if (!invoke) {
    // 浏览器预览：显示表单，让样式能被看见与调整
    version.textContent = 'KYLAB 桌面壳（浏览器预览，没有壳的通道）'
    address.focus()
    return
  }

  let info
  try {
    info = await invoke('startup')
  } catch (cause) {
    showError(`壳与页面对不上话：${cause}`)
    note(`取启动信息失败：${cause}`)
    return
  }

  version.textContent = `KYLAB 桌面壳 ${info.shell_version}`
  renderRecent(info.recent ?? [])
  if (info.server) {
    address.value = info.server
  }

  if (info.role === 'main' && info.server) {
    note(`启动窗：配置里有地址，直接连它`)
    await run(info.server, false)
    return
  }

  note(`显示配置页（窗口 ${info.role}${info.server ? '，地址已回填' : '，还没配过'}）`)
  address.focus()
  address.select()
}

void main()
