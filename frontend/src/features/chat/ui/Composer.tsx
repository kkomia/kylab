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
import { ArrowUp, ChevronDown, Square, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { FILE_DRAG_TYPE } from '../runtime/prefs'
import { matchChatShortcut } from '../runtime/shortcutPrefs'
import { useChat, type MentionItem } from '../runtime/ChatProvider'
import { ApprovalBar } from './ApprovalBar'
import { ContextGauge, KnowledgeBaseControl, ModelPicker, PlusMenu } from './ComposerControls'
import { ExecPolicyControl } from './ExecPolicyControl'
import { MentionMenu, SlashMenu, type MenuHandle } from './Menus'
import { ModePicker } from './ModePicker'
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
  const slashHandle = useRef<MenuHandle | null>(null)
  const mentionHandle = useRef<MenuHandle | null>(null)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [mentionDismissed, setMentionDismissed] = useState(false)

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
    chat.uploadFiles(Array.from(transfer.files ?? []))
  }

  const placeholder = chat.useKb
    ? '向知识库提问…（回车发送，Shift + 回车换行）'
    : '纯对话，不查知识库…（回车发送，Shift + 回车换行）'

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
        <textarea
          id="chat-query"
          ref={field}
          rows={2}
          className="max-h-[240px] min-h-[44px] w-full resize-none border-none bg-transparent text-[length:var(--text-body-size)] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-quaternary)]"
          placeholder={placeholder}
          value={chat.query}
          onChange={(event) => chat.setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />

        {/*
          控制行的**预算**与**放不下时的退路**（第三批评审 A②，实测修正）。

          原先它在中档字号、1440 的窗口下就折成两行：「选库」整格掉到第二行，而超出
          只有十几像素（卡片内宽 742，那一行要 751）——折出来的第二行不是排版意图，
          是"放不下"的副作用，还把卡片从 98 撑到 134（实测）。两处收窄之后默认档一行
          放得下，还留 ~30px：胶囊的横内边距 12→8（`DropdownShell` 的 `CONTROL_TRIGGER`，
          一处取值六个胶囊同时跟上）、仪表那一格只放比率（`ContextGauge`，见那里的说明）。

          放不下时的退路分两层，**顺序不能反**：
          1. **左组折行**（`flex-wrap` 留着）：加号 / 执行策略 / 模式 / 知识库 / 选库
              是"这一轮给什么"，字数少、整格移动不丢词——折行比把它们的标签截短可读；
          2. **右组不折，读数那一格出省略号**（`min-w-0` + `truncate`）：上下文读数 /
              模型 / 发送是"怎么生成、发出去"，读数截短可认（完整数字在悬停与菜单里），
              而发送键与那条细占用条是钉住的（`shrink-0`）——它们被压扁就什么都不剩了。

          于是：默认字号一行；字号调到「更大」或窗口很窄时，是**左组折行、右组完整**，
          没有哪一格的字会被压成两行（那正是这张卡片这一轮要修的毛病）。
        */}
        <div className="flex items-center justify-between gap-[var(--space-2)]">
          <div className="flex min-w-0 flex-wrap items-center gap-[var(--space-1)]">
            {/* 「加号」：附件与技能都收在这里 */}
            <PlusMenu
              onPickFiles={() => fileInput.current?.click()}
              onBrowseFiles={() => chat.openFiles()}
            />
            {/* 「执行策略」与「Agent 模式」并排：两件都是"这一轮它有多放手" */}
            <ExecPolicyControl />
            <ModePicker />
            <KnowledgeBaseControl />
          </div>

          <div className="flex min-w-0 items-center gap-[var(--space-2)]">
            {/* 上下文仪表摆在这一端：它与模型/思考档是同一类信息（"还能问多长"） */}
            <ContextGauge />
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
          chat.uploadFiles(files)
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
