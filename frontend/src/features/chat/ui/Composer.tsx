/**
 * 输入卡片（旧 `ChatView.vue` 的 `.composer-wrap` + `.composer`）。
 *
 * 五件事都收在这一个容器上，各有各的理由：
 *
 * 1. **拖拽落点**：拖进来的东西有**两种落法**，文案与结果都不同——
 *    "松开以添加附件"是上传，"松开以引用此文件"是插一条引用（照 ZCode）。判据只有
 *    `dataTransfer.types`：`getData` 在 dragover 阶段读不到（浏览器出于安全只在 drop 时给），
 *    所以那一刻分不出"文件还是目录"，两种都按同一句"引用"文案说；
 * 2. **两个菜单 + 键盘**：焦点自始至终在输入框里，菜单不抢焦点——所以 ↑↓ / 回车 / Esc
 *    全绑在 textarea 上，菜单只把"当前高亮"与"选中动作"交回来；
 * 3. **发送与停止同位置**：切到"停止"时按钮不跳动，用户不必重新找它；
 * 4. **审批条与命令回话贴在卡片上沿**：它们不是"对话内容"，而是"轮到你说一句话"
 *    或者"系统对你刚敲的那句话的回话"，所以跟输入框在一起，不跟着消息流滚走；
 * 5. **「回到最新」浮标**也挂在卡片上沿（assistant-ui 的视口状态决定它出现与否）。
 */
import { ThreadPrimitive } from '@assistant-ui/react'
import { ArrowUp, ChevronDown, File as FileIcon, Square, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { FILE_DRAG_TYPE } from '../runtime/prefs'
import { matchChatShortcut } from '../runtime/shortcutPrefs'
import { useChat, type MentionItem } from '../runtime/ChatProvider'
import { ApprovalBar } from './ApprovalBar'
import { KnowledgeBaseControl, ModelPicker, PlusMenu } from './ComposerControls'
import { MentionMenu, SlashMenu, type MenuHandle } from './Menus'
import { PermissionControl } from './PermissionControl'
import { FilesSheet } from './Sheets'

/** 输入框里现在是不是在打一条命令：`/` 开头**且还没打空格**（打了空格就是在写参数了）。 */
function slashFilterOf(text: string): string | null {
  if (!text.startsWith('/') || text.includes('\n')) return null
  const head = text.slice(1)
  if (head.includes(' ')) return null
  return head
}

/**
 * 输入框里现在正在打的引用过滤词（`@` 之后那一段）；没在打就是 `null`。
 *
 * 两条判据与 DSH 的 `@` grammar 对齐：
 * - **`@` 之后不能有空白**：打了空格说明这一句已经写下去了（与 `/` 菜单同一条口径）；
 * - **邮箱里的 `@` 不触发**：前一个字符是 ASCII 词字符（`foo@bar.com`）就不算——
 *   中文里没有空格分隔，所以只排 ASCII，`看看@报告.md` 仍然要能弹。
 *
 * 取**最后一个** `@`：用户在句子里插一句引用时，最近的这个才是他正在打的。
 */
function mentionFilterOf(text: string): string | null {
  const at = text.lastIndexOf('@')
  if (at < 0) return null
  const head = text.slice(at + 1)
  if (head.includes('\n') || /\s/.test(head)) return null
  const previous = at > 0 ? text[at - 1] : ''
  if (previous && /[A-Za-z0-9._-]/.test(previous)) return null
  return head
}

/**
 * 粘贴进来的文件补后缀用的那张表：MIME → 后缀。
 *
 * 为什么要补：浏览器给粘贴的截图**没有可用的名字**（Chrome 一律叫 `image.png`，有的浏览器
 * 连名字都是空的），而后端按**后缀**判类型、判这份东西能不能存——没有后缀的那一份会被直接拒。
 * 表里只收剪贴板里常见的几种，表里没有的按 MIME 子类型兜底（见 `namePastedFile`）。
 */
const PASTE_SUFFIXES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
}

/** 浏览器给粘贴内容的那几个**占位名**：看着有后缀，但两份截图会撞成同一个名字。 */
const PASTE_PLACEHOLDER_NAMES = new Set(['image.png', 'blob', 'image'])

/**
 * 给一份粘贴进来的文件补一个**用得上的名字**再交出去。
 *
 * 判据只有一条：这个名字拿去上传会不会出问题——
 * - 没有后缀（`file.name` 是空的、或者叫 `blob`）：后端按后缀判类型，够不着类型就等于被拒；
 * - 占位名（截图在 Chrome 里一律叫 `image.png`）：后缀够用了，但**两次粘贴在文件区里同名**，
 *   用户看到一排 `image.png`，分不出哪张是哪张。
 *
 * 名字里带**时间戳 + 序号**：同一个粘贴动作里的多份文件、以及过一会儿再粘一张，都不会撞名。
 * 「粘贴的截图 / 粘贴的文件」按 MIME 分：图片那一路是绝大多数情况，非图片的（比如从别处
 * 复制来的 PDF）不该被叫成截图。中文名照用户看得懂的方向取；后端对文件名没有 ASCII 要求，
 * 真有重名它也退到 `名字 (2).ext`。
 */
function namePastedFile(file: File, index: number): File {
  const lower = file.name.toLowerCase()
  if (/\.[a-z0-9]+$/.test(lower) && !PASTE_PLACEHOLDER_NAMES.has(lower)) return file
  const fromMime = file.type.split('/')[1]?.replace(/[^a-z0-9]/g, '') ?? ''
  const suffix = PASTE_SUFFIXES[file.type.toLowerCase()] ?? fromMime
  // 连 MIME 都没有（`file.type` 为空）：猜不出后缀，原样交出去，让后端的报错说清是哪一份不行
  if (!suffix) return file
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const kind = file.type.startsWith('image/') ? '粘贴的截图' : '粘贴的文件'
  return new File([file], `${kind}-${stamp}-${index + 1}.${suffix}`, {
    type: file.type,
    lastModified: file.lastModified,
  })
}

/**
 * 把一份文件**改名成它的相对路径**（`图表/第二季度.png`）再交给暂存。
 *
 * 为什么要改名：上传链路的 filename 就是 `file.name`，而后端按它保留文件夹结构
 * （v0.55，上传文件夹）。改名之后整条链路（`addAttachments` → `send` 里那次上传）
 * 一行都不用动。代价是界面上那张缩略图 / 文件片显示的是带路径的长名字——那正是用户
 * 拖进来的那个文件夹里的相对位置，读得懂，不必再为"显示名"造一层（旧 `FileDrawer` 也没造）。
 */
function asRelativePath(file: File, path: string): File {
  const name = path.replace(/^\/+/, '').trim()
  if (!name) return file
  return new File([file], name, { type: file.type, lastModified: file.lastModified })
}

/** 目录选择的 input 给的是 `webkitRelativePath`（含用户选中的那层文件夹名）。 */
function fromDirectoryInput(file: File): File {
  return asRelativePath(file, file.webkitRelativePath || file.name)
}

/**
 * 读完一个目录项里的**全部**子项。
 *
 * `FileSystemDirectoryReader.readEntries` 是**分批**返回的（每批最多约 100 项），
 * 读到空数组才代表读完了——只读一批会把大文件夹悄悄截断，而界面上看起来"就是这么几个"。
 */
function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = []
    const step = (): void => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all)
          return
        }
        all.push(...batch)
        step()
      }, reject)
    }
    step()
  })
}

/** 把一个文件项读成 `File`（`FileSystemFileEntry.file` 是回调式的）。 */
function readEntryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject))
}

/** 把一个目录项**递归**读成"带相对路径的文件"（相对路径取 `entry.fullPath`，去掉前导 `/`）。 */
async function filesInDirectory(entry: FileSystemDirectoryEntry): Promise<File[]> {
  const found: File[] = []
  for (const child of await readAllEntries(entry.createReader())) {
    if (child.isDirectory) {
      found.push(...(await filesInDirectory(child as FileSystemDirectoryEntry)))
      continue
    }
    const file = await readEntryFile(child as FileSystemFileEntry)
    found.push(asRelativePath(file, child.fullPath))
  }
  return found
}

/**
 * 发送 / 停止那一个圆形按钮（v0.19 起同一个位置、同一种形状）。
 *
 * **禁用态是"灰化"而不是"半透明"**（v0.28，第二批评审 A4）：原先只有
 * `disabled:opacity-40`——蓝底减到四成淡蓝，在浅色下仍像一颗能按的按钮，
 * 而它其实是**空输入时按不动**的那一个状态。这里改用全站主按钮的禁用口径
 * （`--button-disabled-bg` / `--button-disabled-text`，`src/ui/button.tsx` 同款，
 * 取值来自 Kimi 的 `.km-button-primary[disabled]` 实测）：底与字一起退成灰，
 * "现在不能发"一眼能看出来，也不必自己造色值。
 */
const SEND_BUTTON =
  'inline-flex h-[var(--control-height)] w-[var(--control-height)] shrink-0 cursor-pointer items-center justify-center rounded-[var(--radius-send)] bg-[var(--accent)] text-[var(--Always-White)] [transition:var(--transition-ui)] disabled:cursor-default disabled:bg-[var(--button-disabled-bg)] disabled:text-[var(--button-disabled-text)]'

export function Composer() {
  const chat = useChat()
  const field = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)
  const slashHandle = useRef<MenuHandle | null>(null)
  const mentionHandle = useRef<MenuHandle | null>(null)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [mentionDismissed, setMentionDismissed] = useState(false)
  /** 超长粘贴被拦下时的那句话（D06）。空串 = 没有要说的。 */
  const [pasteNotice, setPasteNotice] = useState('')

  /**
   * 单次提问的字数上限（D06，2026-09-28 走查）。
   *
   * 走查实测：一次粘 5.6 万字进输入框——**无上限、无提示、不折叠**，用户只看到一个
   * 两行高的框（配上 D02 那个"不随内容长高"，等于盲写）。而且这么长的提问会吃掉
   * 上下文窗口的一大块，答案质量反而下降。
   *
   * 3.2 万字 ≈ 中文 3.2 万 token，是默认窗口（65536）的一半：再长的东西本来就该
   * **当附件传**（走附件那条路会进知识库、能检索、还能带着出处回答）。
   * 后端 `api/v1/schemas.py` 的 `ChatRequestIn.query` 有**同一条**上限（那边是防线，
   * 这边是提示）；两处必须同步——前端先拦是为了给一句能照做的话，而不是等 422。
   */
  const MAX_QUERY_CHARS = 32_000

  /**
   * 输入框**随内容长高**（D02，2026-09-28 走查），封顶交给 CSS 的 `max-h-[240px]`。
   *
   * 原来只有 `rows={2}`：那是**初始**行数，textarea 自己不会跟着内容长——实测 6400 字时
   * `clientHeight` 仍是 44.09、`scrollHeight` 2954，用户只能在两行高的窗口里翻自己刚写的
   * 东西。这里每次内容变化把 `height` 设成 `scrollHeight`；先置 `auto` 再读，否则删字之后
   * 高度收不回去（`scrollHeight` 会被旧高度撑住）。超过 240px 由 `overflow-y: auto` 接管。
   */
  useEffect(() => {
    const element = field.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${element.scrollHeight}px`
  }, [chat.query])

  /**
   * `webkitdirectory` 是目录选择的非标准属性，React 的类型里没有它——挂载后直接给节点
   * 落一个属性。比写 `@ts-expect-error` 稳：哪天类型补上这个属性，抑制注释会变成"多余"。
   */
  useEffect(() => {
    folderInput.current?.setAttribute('webkitdirectory', '')
  }, [])

  const slashFilter = slashFilterOf(chat.query)
  const mentionFilter = mentionFilterOf(chat.query)
  /** 用户按 Esc 关掉之后，这一条输入里不再弹（改了内容再弹，见下面那个 effect）。 */
  useEffect(() => {
    setSlashDismissed(false)
    setMentionDismissed(false)
    if (slashFilter !== null) chat.loadCommands()
    if (mentionFilter !== null) chat.loadMentions()
    // 只在"过滤词"这一层变化时重置：query 每次按键都变，但菜单该不该弹看的是过滤词。
    // 两个 loader 是稳定的（provider 里 useCallback 过），所以这句不会每次渲染都跑——
    // 否则用户按 Esc 关掉菜单后，紧接着一次渲染又会把它弹回来。
    // `chat` 这个对象故意不进依赖：它每次渲染都是新的，进去就等于"每次渲染都重置菜单"。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slashFilter, mentionFilter, chat.loadCommands, chat.loadMentions])

  const slashVisible = slashFilter !== null && !slashDismissed && chat.commands.length > 0
  const mentionVisible = mentionFilter !== null && !mentionDismissed && chat.mentionItems.length > 0

  /**
   * 输入框上的键盘：菜单开着时先归菜单（↑↓ 选择、回车选中、Esc 关掉），
   * 其余情况交给**快捷键注册表**那套绑定（`chat.send` / `chat.newline`）。
   *
   * **`@` 菜单排在 `/` 之前**：同一个 token 里不可能同时在打命令，两个菜单也不会同时开着
   * （判据互斥），而先问引用那个更贴用户当下的动作。
   *
   * 改之前最后那一段是写死的 `Enter && !shiftKey`。现在"哪组键发送、哪组键换行"由用户在
   * 设置里定（默认仍是回车发送、Shift+回车换行）。**没匹配上的键一律不动**：
   * 交给浏览器，也就是输入框原生的输入与换行——这正是"把发送键改成 Ctrl+回车"之后，
   * 单独按回车仍然能换行的原因。
   */
  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (mentionVisible) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        mentionHandle.current?.move(event.key === 'ArrowDown' ? 1 : -1)
        return
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        // 有过匹配才算"选中"：一条都没匹配上时回车要落到发送上
        if ((mentionHandle.current?.count() ?? 0) > 0) {
          event.preventDefault()
          mentionHandle.current?.pickActive()
          return
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setMentionDismissed(true)
        return
      }
    }
    if (slashVisible) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        slashHandle.current?.move(event.key === 'ArrowDown' ? 1 : -1)
        return
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        // **有过一条匹配才算"选中"**：一条都没匹配上时回车要落到"执行"上，
        // 否则用户打完整条命令再按回车会石沉大海
        if ((slashHandle.current?.count() ?? 0) > 0) {
          event.preventDefault()
          slashHandle.current?.pickActive()
          return
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setSlashDismissed(true)
        return
      }
    }
    // 菜单都关着的时候：交给**快捷键注册表**那套绑定（`runtime/shortcutPrefs`，
    // 存储与 misc 域的注册表共用 `kylab-shortcuts`——见那里的模块头）
    const action = matchChatShortcut(event.nativeEvent, 'composer')
    if (action === 'chat.send') {
      event.preventDefault()
      chat.send()
      return
    }
    if (action === 'chat.newline') {
      event.preventDefault()
      insertLineBreak(event.currentTarget)
    }
  }

  /**
   * 在光标处插一个换行（`chat.newline` 那一条）。
   *
   * 为什么不"不拦着让浏览器自己插"：默认绑定（Shift+回车）确实原生就能换行，
   * 但用户完全可能把它改成别的（Ctrl+J 之类）——那时不拦着就等于"改了不生效"，
   * 而设置页上的提示会说能用。输入框是**受控**的，所以插完要把结果交回
   * `chat.setQuery`（旧 Vue 那边是靠派发 `input` 事件让 v-model 认的，
   * React 这里直接落 state，少一层 DOM 事件绕法）。
   */
  function insertLineBreak(field: HTMLTextAreaElement | null): void {
    if (!field || typeof field.setRangeText !== 'function') return
    const start = field.selectionStart ?? field.value.length
    const end = field.selectionEnd ?? start
    field.setRangeText('\n', start, end, 'end')
    chat.setQuery(field.value)
  }

  /** 插完引用把焦点与光标交回输入框末尾（用户接着就能往下打）。 */
  function focusComposerEnd(): void {
    window.setTimeout(() => {
      const node = field.current
      if (!node) return
      node.focus()
      node.setSelectionRange(node.value.length, node.value.length)
    }, 0)
  }

  /**
   * 命令把一句提问送回了输入框（`/rewind` 的 `refill`，见 `ChatCommandResult.refill`）。
   *
   * 字是 provider 填的（它手上有 `query`），这里只补**用户接着要动手**的那两件事：
   * 焦点进输入框、**光标落在末尾**——否则那句回填的话是"看得见、摸不着"：
   * 用户还得先点一下才改得了，而这条命令要他做的恰恰就是"改一版再发"。
   *
   * 与插引用走同一个 `focusComposerEnd`（同一件事只有一处实现）：它放在 `setTimeout(0)`
   * 里，等 React 把新的 `value` 提交到 DOM 之后再选末尾——早一步的话选中的是旧长度。
   * 依赖只有 `commandRefill` 这一个对象（`seq` 每次都新），所以同一句话连着回填两次也各跑一次。
   */
  useEffect(() => {
    if (!chat.commandRefill) return
    focusComposerEnd()
    // 只认 provider 给的那个信号（`seq` 每次都新）；它之外的依赖一概不看
  }, [chat.commandRefill])

  // —— 拖拽：先判这一拖是哪一种，再把它写成对应那一句文案
  function onDragOver(event: React.DragEvent): void {
    const types = Array.from(event.dataTransfer?.types ?? [])
    const reference = types.includes(FILE_DRAG_TYPE)
    const files = types.includes('Files')
    if (!reference && !files) return
    // 不 preventDefault 浏览器就不会派发 drop（默认动作是"打开这个文件"）
    event.preventDefault()
    chat.setDropKind(reference ? 'reference' : 'attach')
  }

  /** 拖出输入框（含拖到子元素上）：`relatedTarget` 还在里面就不算离开，免得文案闪。 */
  function onDragLeave(event: React.DragEvent): void {
    const host = event.currentTarget as HTMLElement
    const next = event.relatedTarget as Node | null
    if (next && host.contains(next)) return
    chat.setDropKind(null)
  }

  /**
   * 松手：**两种落法在这里分开**。
   *
   * - 工作区里的文件/目录 → 插一条**引用**（不读、也不上传）；
   * - 其余（从资源管理器拖进来的文件）→ 走**既有上传链路**（和「加号 → 添加文件」同一件事）。
   *
   * 拖进来的可能是**文件夹**：`transfer.files` 对目录只给得出目录本身、给不出里面的文件，
   * 所以只要有目录项，就改走 `webkitGetAsEntry` 递归读整棵目录，给每份文件配上相对路径；
   * 只是普通文件时保持原样（那条路最快，也不必等异步）。
   */
  function onDrop(event: React.DragEvent): void {
    chat.setDropKind(null)
    const transfer = event.dataTransfer
    if (!transfer) return
    const payload = transfer.getData(FILE_DRAG_TYPE)
    if (payload) {
      try {
        const info = JSON.parse(payload) as { key?: string; name?: string }
        const value = info.key || info.name || ''
        if (value) {
          chat.insertReference(value)
          focusComposerEnd()
        }
      } catch {
        // 坏 payload（别的应用恰好写了同一个类型）当没发生：它本来就只是一条便利
      }
      return
    }
    const entries = Array.from(transfer.items ?? []).map((item) =>
      typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null,
    )
    if (!entries.some((entry) => entry?.isDirectory)) {
      chat.addAttachments(Array.from(transfer.files ?? []))
      return
    }
    // 读目录是异步的（要逐层等 `readEntries`）：先把整棵读完再一次性交出去，
    // 免得读到一半就进列表、用户看到附件一批批冒出来。
    void (async () => {
      const collected: File[] = []
      for (const entry of entries) {
        if (!entry) continue
        if (entry.isDirectory) {
          collected.push(...(await filesInDirectory(entry as FileSystemDirectoryEntry)))
          continue
        }
        collected.push(
          asRelativePath(await readEntryFile(entry as FileSystemFileEntry), entry.fullPath),
        )
      }
      chat.addAttachments(collected)
    })()
  }

  /**
   * 粘贴上传：**只有剪贴板里真的带了文件才拦**。
   *
   * - **有文件才 `preventDefault`**——这一条是红线。无条件拦下去的话，用户复制一段文字
   *   粘进来会石沉大海（浏览器"把文本插到光标处"的默认动作被吃掉了），这是这个功能最容易
   *   犯的错。所以判据只看 `clipboardData.files`：空的时候这里什么都不做，纯文本照常走原生粘贴。
   * - **文件交给 `chat.addAttachments`，不自己另起一条路**：暂存那一整套（本地预览、
   *   发送时统一上传、失败保留原文）都长在 `ChatProvider.addAttachments` 里，
   *   拖拽落点与「加号 → 添加文件」走的也是它。这里另起一条路等于把那几件事抄一遍，
   *   三条入口迟早各说各话。
   * - **一次粘多份**（`clipboardData.files` 是列表）原样全交给它，它本来就是按列表收的。
   * - **同时带文字与文件时以文件为准**（从网页上复制一张图常常两样都有）：拦掉的正是那一次
   *   粘贴的默认动作，所以附带的那串文字不会落进输入框——截图那条路才是用户此刻的意图
   *   （他复制的就是图）。想粘文字时不带文件，走的是上面那条"什么都不做"。
   */
  function onPaste(event: React.ClipboardEvent<HTMLTextAreaElement>): void {
    const pasted = Array.from(event.clipboardData?.files ?? [])
    if (pasted.length === 0) {
      // 纯文本这条路（D06）：**超长就拦下并说清怎么办**，而不是静默截断——
      // 截断会让人以为"粘进去了"，实际上丢掉的是后半篇。
      const text = event.clipboardData?.getData('text/plain') ?? ''
      if (text.length > MAX_QUERY_CHARS) {
        event.preventDefault()
        setPasteNotice(
          `这次粘贴有 ${text.length.toLocaleString()} 字，超过单次上限 ` +
            `${MAX_QUERY_CHARS.toLocaleString()} 字。这么长的内容请存成文件后用「加号 → 添加文件」` +
            `传进来——那样能进知识库、回答还会带出处。`,
        )
      } else if (pasteNotice) {
        setPasteNotice('')
      }
      return
    }
    event.preventDefault()
    chat.addAttachments(pasted.map(namePastedFile))
  }

  return (
    <div
      /* 下内边距取 `space-5`：旧 `.composer-wrap { padding: 0 var(--page-gutter) var(--space-5) }`
         ——它是输入卡片与窗口底边之间那截呼吸感（"回到最新"浮标也按它定位）。 */
      className="relative w-full px-[var(--page-gutter)] pb-[var(--space-5)]"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/*
        「回到最新」浮标：往上翻旧回答时出现。挂在输入卡片上沿，不跟着内容滚走。

        **贴底时它靠 `disabled:hidden` 消失**（第三批评审 A①，实测修正）：本版
        assistant-ui 的回调在贴底时返回 `null`，而 `createActionButton` 把 `null`
        接成 `disabled`——**按钮仍在文档里、仍然可见**，只是点不动。于是那枚只有图标
        的箭头一直挂在最后一条消息的操作行右边，看着像个没用的残留；点它（此时必然
        贴底）又什么都不会发生。库给的状态钩子就是 `disabled`，用一条工具类接上，
        这一段就回到上面那句原本的意图：**只在能起作用时才出现**。
      */}
      {chat.messages.length > 0 ? (
        <ThreadPrimitive.ScrollToBottom
          className="absolute -top-[calc(var(--space-8)+var(--space-2))] left-1/2 z-[2] inline-flex h-[var(--control-height)] w-[var(--control-height)] -translate-x-1/2 cursor-pointer items-center justify-center rounded-[var(--radius-pill)] border border-[var(--border)] bg-[var(--bg-surface)] text-[var(--text-secondary)] shadow-[var(--shadow-raised)] disabled:hidden"
          aria-label="回到最新"
          title="回到最新"
        >
          <ChevronDown size={18} />
        </ThreadPrimitive.ScrollToBottom>
      ) : null}

      {/*
        后端在等用户点头：**紧挨着输入框、在它上面**——这一条不是"对话内容"，
        而是"轮到你说一句话"，所以它跟输入框在一起，而不是飘在消息流里跟着滚走。
      */}
      {chat.pendingApproval ? (
        <ApprovalBar approval={chat.pendingApproval} onSettled={() => chat.dismissApproval()} />
      ) : null}

      {/*
        命令的回话：也贴在输入卡片上沿。**它不是一条助手回答**——后端那一路不产生回答，
        消息也不落库（带参数的 `/plan` 例外，那种会照常建气泡，见 `mirrorLive`）。
      */}
      {chat.commandResult ? (
        <div
          data-testid="command-result"
          role="status"
          className="mx-auto mb-[var(--space-2)] flex w-full max-w-[var(--chat-measure)] flex-col gap-[var(--space-1)] rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--bg-subtle)] px-[var(--space-4)] py-[var(--space-3)]"
        >
          <div className="flex items-center justify-between">
            <span className="font-mono text-[length:var(--text-meta-size)] text-[var(--text-secondary)]">
              /{chat.commandResult.name}
            </span>
            <button
              type="button"
              className="inline-flex h-[22px] w-[22px] cursor-pointer items-center justify-center rounded-[var(--radius-control)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)]"
              aria-label="收起"
              title="收起"
              onClick={chat.dismissCommandResult}
            >
              <X size={13} />
            </button>
          </div>
          {/*
            命令的回话**原样摆出来**：`/context` `/status` `/skills` 这几条都是多行纯文本
            （一行一项，数字带千分位；后端刻意不用 markdown 表格，见 `_context_lines` 的说明），
            所以是等宽 + `pre-wrap`——换行不塌、行内的数字与缩进对得齐，一块 `<pre>` 就够，
            不为它另造一套卡片。

            `break-words` 是**量出来的**（`.shots/cmd/probe-overflow.cjs`）：真实那些长路径
            会在 `/` 处折行（734/734 不溢出），而一条**没有断点的长 token**（哈希、长 id）
            会把 734 撑到 2111，文字直接跑到面板边框外面去——补上它之后那种极端行也在面板里
            折行。它不改变任何一行的对齐（折的只是放不下的那些）。
          */}
          <pre className="m-0 font-mono text-[length:var(--text-micro-size)] break-words whitespace-pre-wrap text-[var(--text-secondary)]">
            {chat.commandResult.text}
          </pre>
        </div>
      ) : null}

      {/* 两个菜单浮在输入卡片上方，**不抢焦点**（键盘由输入框那一侧转发） */}
      <div className="mx-auto w-full max-w-[var(--chat-measure)]">
        {mentionVisible ? (
          <div className="absolute bottom-[calc(100%-var(--space-4))] left-[var(--page-gutter)] right-[var(--page-gutter)] mx-auto max-w-[var(--chat-measure)]">
            <MentionMenu
              items={chat.mentionItems}
              filter={mentionFilter ?? ''}
              loading={chat.mentionLoading}
              handleRef={mentionHandle}
              onPick={(item: MentionItem) => {
                chat.applyMention(item)
                focusComposerEnd()
              }}
            />
          </div>
        ) : null}
        {slashVisible ? (
          <div className="absolute bottom-[calc(100%-var(--space-4))] left-[var(--page-gutter)] right-[var(--page-gutter)] mx-auto max-w-[var(--chat-measure)]">
            <SlashMenu
              items={chat.commands}
              filter={slashFilter ?? ''}
              handleRef={slashHandle}
              onPick={chat.applyCommand}
            />
          </div>
        ) : null}
      </div>

      {/*
        拖拽提示：**两句不同的文案**就是这个功能的一半。

        `relative z-[60]` 是为了**文件抽屉开着的时候也看得见它**：从文件区里把一份文件
        拖出来时，抽屉（z-50 的浮层 + 遮罩）正盖在对话上，而这条提示长在输入卡片这一侧——
        不抬到它上面，用户眼里就是"拖了但什么都没说"（旧版那层遮罩同样压得住这条提示，
        但那会儿文件区的行本来也拖不到输入框里，见 `Sheets.tsx` 的 `onDragStart`）。
      */}
      {chat.dropKind ? (
        <div
          role="status"
          className="relative z-[60] mx-auto mb-[var(--space-2)] w-full max-w-[var(--chat-measure)] rounded-[var(--radius-panel)] border border-dashed border-[var(--accent)] bg-[var(--accent-soft)] px-[var(--space-4)] py-[var(--space-3)] text-center text-[length:var(--text-meta-size)] text-[var(--text-primary)]"
        >
          {chat.dropKind === 'reference' ? '松开以引用此文件' : '松开以添加附件'}
        </div>
      ) : null}

      <div className="mx-auto flex w-full max-w-[var(--chat-measure)] flex-col gap-[var(--space-1)] rounded-[var(--radius-input)] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-[var(--space-3)] py-[var(--space-2)] shadow-[var(--shadow-input)]">
        {/*
          暂存的附件（v0.55）：**发送前就摆在这里**，图片给缩略图、别的给一个文件片，
          每份都能单独拿掉。用户报的正是这件事——"文件和图片应该通过缩略图的形式保留在
          对话框（agent 产品都是这么做的），而你是直接发送，然后上传到工作区"。

          它们此刻**还没上传**（发送那一刻才落到会话文件区，见 `ChatProvider.send`），
          所以这里画的是本地预览，不产生任何请求。
        */}
        {chat.attachments.length > 0 ? (
          <ul
            className="m-0 flex list-none flex-wrap gap-[var(--space-2)] p-0"
            aria-label="待发送的附件"
          >
            {chat.attachments.map((item) => (
              <li key={item.id} className="relative">
                {item.preview ? (
                  <img
                    src={item.preview}
                    alt={item.file.name}
                    className="h-14 w-14 rounded-[var(--radius-control)] border border-[var(--border-hairline)] object-cover"
                  />
                ) : (
                  <span className="inline-flex h-14 max-w-[180px] items-center gap-[var(--space-2)] rounded-[var(--radius-control)] border border-[var(--border-hairline)] px-[var(--space-2)] text-[length:var(--text-micro-size)] text-[var(--text-secondary)]">
                    <FileIcon size={14} aria-hidden="true" className="shrink-0" />
                    <span className="truncate">{item.file.name}</span>
                  </span>
                )}
                <button
                  type="button"
                  className="absolute -top-1.5 -right-1.5 inline-flex size-4 cursor-pointer items-center justify-center rounded-[var(--radius-pill)] border border-[var(--border-hairline)] bg-[var(--bg-surface)] text-[var(--text-tertiary)] transition-colors hover:text-text-primary"
                  aria-label={`移除 ${item.file.name}`}
                  title="移除"
                  onClick={() => chat.removeAttachment(item.id)}
                >
                  <X size={10} />
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {/*
          输入框**不再挂占位提示**（用户原话："那个提示词干掉，太蠢了"）："这一轮查不查库"
          在下面那排的「知识库」开关上摆着——那是看得见的状态，不必再用一句话在框里复述一遍。

          去掉 `placeholder` 会连带去掉这个输入框**唯一的无障碍名字**（读屏与用例都靠它认框），
          所以补一个不显示的 `aria-label`：界面上看不见，但读屏、以及
          `tests/chat-paste-upload.test.tsx` 这类用例仍然认得出它是哪一个框。
        */}
        {/*
          **超长粘贴的那句话**（D06）：只说事实与下一步，不拦着用户继续做别的。
          放在输入框**上面**：它是"你刚粘的那次没进来"，摆在框上方比塞在下面更像即时反馈。
        */}
        {pasteNotice ? (
          <p
            role="status"
            className="m-0 mb-[var(--space-1)] text-[length:var(--text-micro-size)] leading-[1.5] text-[var(--status-warning)]"
          >
            {pasteNotice}
          </p>
        ) : null}

        <textarea
          id="chat-query"
          ref={field}
          rows={2}
          // 硬上限（与 `MAX_QUERY_CHARS` 同一个数）：打字打到头就停住。
          // 超长**粘贴**在 `onPaste` 里被拦下并给出那一句提示，而不是靠这里静默截断。
          maxLength={MAX_QUERY_CHARS}
          aria-label="消息输入框"
          className="max-h-[240px] min-h-[44px] w-full resize-none border-none bg-transparent text-[length:var(--text-body-size)] text-[var(--text-primary)] outline-none"
          value={chat.query}
          onChange={(event) => chat.setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />

        {/*
          控制行的**预算**与**放不下时的退路**（第三批评审 A②，实测修正）。

          原先它在中档字号、1440 的窗口下就折成两行：「选库」整格掉到第二行，而超出
          只有十几像素（卡片内宽 742，那一行要 751）——折出来的第二行不是排版意图，
          是"放不下"的副作用，还把卡片从 98 撑到 134（实测）。胶囊的横内边距 12→8
          （`DropdownShell` 的 `CONTROL_TRIGGER`，一处取值六个胶囊同时跟上）之后，
          这一排在最宽的那一档才勉强够用；**2026-09-24 起读数那一格是环 + 比率**
          （`ContextGauge`，环 16px 替掉原来那条 28px 的占用条），它自己从 ~111px
          收到 ~65px，是这一排里省得最多的一格。

          **同一天（2026-09-24）左组又省下一整颗**：「知识库」开关与「全部 4 个」选库
          下拉合并成一颗胶囊（`KnowledgeBaseControl`）——它们本来管的是同一件事，
          并排摆着时要用户自己在两颗之间拼出"查不查、查哪几个"。合并前实测那一排
          **折成两行**（`.shots/feedback/laneB-00-row-before.png`：行容器 742×68，
          左组 466.5 里塞不下 473.6 的内容，最后那颗「全部 4 个」被挤到第二行）；
          合并后左组 4 颗走成一行（读数见 `.shots/feedback/laneB-*.json`）。

          **2026-09-27 这一排按旧版收成三颗**（用户拿着旧版截图："我觉得很简洁美观"，
          参照图里只有 `+ 知识库 模型 发送`），同一天**权限轴**那次改动之后定格为：

          `+ 权限 知识库 …… 模型 发送`

          - 「上下文用量」→ 进了**模型浮层**（它回答"还能问多长"，与模型/思考档同类，
            见 `ContextSummary`）；
          - 「权限」（仅查看 / 工作区内编辑 / 完全访问）→ **回到这一排**，位置是用户指定的
            「加号右边、知识库左边」（见 `PermissionControl`）。它把原来那一项
            「命令执行策略」折了进来——"命令能不能跑"从此只有这一个说法；
          - 「任务模式」（目标 / 计划）→ 用户要它"不单独弄一个菜单"，所以回到**设置页**
            （它管的是"怎么干活"，与权限是两根轴）。

          放不下时的退路只剩一层：**右组不折，让模型名出省略号**（它有 aria-label，
          菜单里也能核对），发送键始终是 `shrink-0`。左组很少再有折行的机会
          （两颗），但 `flex-wrap` 留着——字号调到「更大」时它仍然是最后的退路。
          实测（1440）：整行 742×32、一行放下，与收窄前同高。
        */}
        <div className="flex flex-wrap items-center justify-between gap-[var(--space-2)]">
          <div className="flex min-w-0 flex-wrap items-center gap-[var(--space-1)]">
            {/* 「加号」：附件与技能都收在这里（"这一轮给它什么"） */}
            <PlusMenu
              onPickFiles={() => fileInput.current?.click()}
              onPickFolder={() => folderInput.current?.click()}
              onBrowseFiles={() => chat.openFiles()}
            />
            {/* 「权限」：能碰多少（仅查看 / 工作区内编辑 / 完全访问）。位置是用户指定的：
                加号右边、知识库左边。另一根轴（任务模式）在设置页，不占这一排 */}
            <PermissionControl />
            <KnowledgeBaseControl />
          </div>

          {/* 右组：`ml-auto` 是给**换行**那一档用的（窄屏，D29）——它会整组落到第二行，
              而 `justify-between` 在"本行只有一个孩子"时是把它摆在行首的（发送键会跑到
              左边、且与权限胶囊同一行时还会重叠）。`ml-auto` 让它换行之后仍然靠右。 */}
          <div className="ml-auto flex min-w-0 items-center gap-[var(--space-2)]">
            {/* 模型这一格还装着"思考 / 强度 / 上下文读数"（它们是同一个问题的几个面） */}
            <ModelPicker />
            {/* 这两句是行内附注，也**不许折行**（同上：整行只有一行） */}
            {chat.useKb && chat.kbs.length > 0 && chat.selectedKbIds.length === 0 ? (
              <span className="truncate text-[length:var(--text-micro-size)] text-[var(--status-warning)]">
                未选知识库
              </span>
            ) : null}
            {chat.uploading ? (
              <span className="truncate text-[length:var(--text-micro-size)] text-[var(--text-tertiary)]">
                正在上传…
              </span>
            ) : null}
            {/* 发送 / 停止是**同一个位置、同一个形状**的图标按钮 */}
            {chat.sending ? (
              <button
                type="button"
                className={SEND_BUTTON}
                aria-label="停止生成"
                title="停止生成"
                onClick={chat.stop}
              >
                <Square size={14} fill="currentColor" />
              </button>
            ) : (
              <button
                type="button"
                className={SEND_BUTTON}
                aria-label="发送"
                title="发送"
                disabled={!chat.canSend}
                onClick={chat.send}
              >
                <ArrowUp size={17} />
              </button>
            )}
          </div>
        </div>
      </div>

      {/*
        「添加文件和图片」的实际落点。**藏起来的 `<input type=file>` 而不是自绘按钮**：
        文件选择器必须由真实的用户手势触发，而原生 input 自带键盘可达与系统对话框。
      */}
      <input
        ref={fileInput}
        className="hidden"
        type="file"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const input = event.target
          const files = Array.from(input.files ?? [])
          input.value = ''
          chat.addAttachments(files)
        }}
      />

      {/*
        「添加文件夹」的落点。**与上面那份分开两个 input**：目录选择靠 `webkitdirectory`，
        同一个 input 加上它就变成"只能选目录"——两件事放一个节点上做不到。
        `webkitdirectory` 本身在挂载时落上去（见组件顶部那个 effect）。
      */}
      <input
        ref={folderInput}
        className="hidden"
        type="file"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const input = event.target
          const files = Array.from(input.files ?? [])
          input.value = ''
          chat.addAttachments(files.map(fromDirectoryInput))
        }}
      />

      {/*
        「浏览文件」打开的是**抽屉**（产物与上传的文件都落在文件区里）。
        开着与"直落哪一份"都在 `ChatProvider` 里（`filesOpen` / `filesSeed`）：
        产物卡片上的「预览」也要开这一个抽屉，而它在消息流里，够不着这里的内部 state。
        `key` 绑会话 id：换一条会话就整个重来——文件区是按会话划的，
        旧 `FileDrawer` 也是这么绑的（`:key="conversationId"`）
      */}
      {chat.filesOpen ? (
        <FilesSheet
          key={chat.conversationId}
          initialKey={chat.filesSeed?.key ?? null}
          initialEntry={chat.filesSeed}
          onClose={chat.closeFiles}
        />
      ) : null}
    </div>
  )
}
