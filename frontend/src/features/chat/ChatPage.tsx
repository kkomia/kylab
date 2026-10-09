/**
 * 对话页（《前端设计规范》§6）：选库 → 提问 → 带原文引用的回答。
 *
 * 它和库内检索面板的分工：检索回答"**哪个块**最像这个问题"，
 * 对话回答"**这些资料**怎么说这个问题"。所以这里的入口是跨库多选，
 * 结果也不再摊开分数与通道，而是正文 + 引用列表——用户要的是结论，不是排名。
 *
 * 装配只有四层，每一层的职责都在各自文件里写清了：
 *
 * ```
 * ChatProvider   页面状态与动作（消息、发送、过程面板、交付物、浮层）
 * └ ChatRuntime  assistant-ui 的 runtime 适配（外部 store；协议仍是我们自己的）
 *   └ ChatThread 对话区（视口、跟随滚动、欢迎层、消息列表）
 *   └ Composer   输入卡片（附件/技能/模式/执行策略/知识库/模型/仪表/发送）
 * ```
 *
 * 两个浮层挂在页面这一层：`ui/Sheets.tsx` 的两个抽屉（引用原文、产物与文件）。
 *
 * **右端那一列是常驻的面板**（`panel/SidePanel.tsx`：文件树，下一轮接网页）：
 * 它不是浮层，而是与"左列三段"并排的第二列——详细分工见 `panel/panelStore.ts` 的头注。
 *
 * 路由与页面壳由主控接（`src/app/**`）：这一页只管 `/chat/:conversationId?`
 * 那三个参数（会话 id、`?new=1`、`?workspace=<id>`），其余入口一律不改路径。
 */
// 回答正文的排版（`md-p` / `md-ul` / `md-cite` 那一族，渲染器一直在发这些类名）。
// 挂在页面这一层而不是某个组件里：消息列表、过程面板、出处列表都要它
import './ui/chat.css'
import { ChatProvider, useChat } from './runtime/ChatProvider'
import { ChatRuntime } from './runtime/ChatRuntime'
import { PanelSplitter } from './panel/PanelSplitter'
import { PanelToggle } from './panel/PanelToggle'
import { SidePanel } from './panel/SidePanel'
import { usePanelStore } from './panel/panelStore'
import { ChatThread } from './ui/ChatThread'
import { Composer } from './ui/Composer'
import { SourceSheet } from './ui/Sheets'

/**
 * 新会话的落点（`?new=1&workspace=<id>`）：**在第一条消息落下之前**就说清这条会话
 * 归哪个项目。
 *
 * 为什么要单独摆这一条：会话在建起来之前，`ChatHeader` 没有标题可显示（它整条不画），
 * 于是"我刚才点的是哪个项目的新建"在欢迎态里看不见——而落地之后要改就得去
 * 「移至项目」里找补。建完（地址换成 `/chat/<id>`）这一条自然消失，接棒的是
 * `ChatHeader` 那句项目名，两处不会同时出现。
 *
 * 排版与 `ChatHeader` 对齐：同样是内容列外侧的整条、内容按 `--chat-measure` 居中，
 * 视觉上属于"这一页的抬头"而不是对话内容。
 */
function NewChatScope() {
  const chat = useChat()
  if (!chat.pendingWorkspace) return null
  return (
    <div className="flex shrink-0 items-center px-[var(--page-gutter)] pt-[var(--space-2)]">
      <p
        data-testid="new-chat-scope"
        className="mx-auto w-full max-w-[var(--chat-measure)] text-[length:var(--text-micro-size)] text-[var(--text-tertiary)]"
      >
        在项目「{chat.pendingWorkspace.name}」里新建：第一条消息落下后，这条会话就归在它下面
      </p>
    </div>
  )
}

/**
 * 对话页那一行：左边对话列、中间那条拖拽把手、右边面板，右上角那颗开关。
 *
 * 单独一个组件是为了让**只有它**订阅面板的宽度与开合：这一页里最重的东西是对话列
 * （消息列表、输入卡片），宽度一变就重渲染整棵树的话，拖缝会抖成一片。这一层订阅，
 * 重渲染的代价只有"几个布局盒子"（面板自己订阅宽度、改的是它自己的 CSS 变量）。
 *
 * 类名是 `ch-panel-host` 而不是 `ch-panel-row`：**后者已经被文件树那一行占了**
 * （`panel.css` 里 `.ch-panel-row { height: var(--row-height-compact); align-items: center; padding: 0 8px }`
 * ——那是树里的一行文件）。2026-10-09 这里先写成了 `ch-panel-row`，两条规则一撞，
 * 这一行就白拿了一份"32px 高、竖向居中、左右各 8px 内边距"：面板里的东西整块被竖着居中
 * （看着像空态那一屏的居中跑到了别处）、右缘还平白多出 8px。命名撞车的代价一贯如此——
 * 所以这一族新类名（`ch-panel-host` / `ch-panel-splitter` / `ch-panel-corner` /
 * `ch-panel-action` / `ch-panel-tablist`）都先 grep 过一遍 `src`，没人用过才落。
 */
function ChatPageRow({ children }: { children: React.ReactNode }) {
  const open = usePanelStore((state) => state.open)
  const full = usePanelStore((state) => state.full)
  /** 面板开着、而且**有标签**时才有标签条（空态那一屏没有那一行）。 */
  const tabCount = usePanelStore((state) => state.tabs.length)
  /**
   * 全屏态（`data-panel-full`）：对话列在 `panel.css` 里被 `display: none` 收起来、
   * 面板撑满这一行。**面板关着时不算全屏**（`open && full`）——收面板那一下会把 `full`
   * 一起清掉（见 `panelStore.setOpen`），这里再与一下只是不让"关着却把对话列藏了"
   * 这种状态有机会出现。
   */
  const panelFull = open && full

  return (
    <div
      className="ch-panel-host relative flex h-full min-h-0 flex-row text-[var(--text-primary)]"
      data-panel-full={panelFull}
    >
      {children}
      {/* 开关：**页面右上角**，不是对话列里的一格（理由见 `PanelToggle` 头注）。
          面板开着、标签条也在时，这个位置上站着的是标签条右端那颗收起（同一颗按钮、
          同一个坐标），所以那时不画它——不然两颗会叠在一起。没有标签条（面板关着，
          或者开着但一个标签都没有=空态那一屏）时，它就是这一屏唯一的那颗开关。 */}
      {open && tabCount > 0 ? null : (
        <div className="ch-panel-corner">
          <PanelToggle />
        </div>
      )}
    </div>
  )
}

export function ChatPage() {
  return (
    <ChatProvider>
      <ChatRuntime>
        {/* 整页占满内容区：中间滚动、底部固定输入卡片。
            **页头只有一条低权重的会话条**（`ChatHeader`：会话标题 + 项目名，44px）——
            它不重复侧栏的"对话"，只回答"我现在在哪条会话里"；这是 2026-09-24 界面评审
            对着 DeepSeek / Kimi 补上的（原先完全无页头，长会话里滚动后不知道在哪）。
            会话条本身在 `ChatThread` 里、不随消息滚走。

            **右边那一列是常驻的面板**（`SidePanel`：文件树 / 网页），
            所以这一行是横向两列：左边是原来那三段（会话条、消息区、输入卡片），
            右边是面板自己那一列。面板要挤的是**这一行**，不是整页——所以它是
            `relative` 的：窄屏下面板改覆盖式（`position: absolute`）时锚在这一行上，
            贴的是对话区的右缘，不会盖到侧栏上。

            这一行上还有三样**属于页面而不是某一列**的东西（都由 `.ch-panel-*` 管，
            见 `panel/panel.css`）：
            - 两列之间那条**拖拽把手**（`PanelSplitter`，只在面板贴着放时才有：
              浮层态下这两列不是并排的，没有"它们之间那条缝"）；
            - **面板开关**（`PanelToggle`，绝对定位在右上角——它和面板标签条右端那颗
              收起是同一颗，见那个文件的头注）；
            - 全屏态：`data-panel-full` 把对话列收起来、面板撑满（`.ch-panel-chat`
              那份规则在 `panel.css` 里）。 */}
        <ChatPageRow>
          <div className="ch-panel-chat flex min-h-0 min-w-0 flex-1 flex-col">
            <NewChatScope />
            <ChatThread />
            <Composer />
          </div>
          <PanelSplitter />
          <SidePanel />
        </ChatPageRow>
        {/* 引用原文是抽屉（贴边滑出，对话还看得见）。
            挂在这儿而不是页内：抽屉是**页面级浮层**，不该跟着输入卡片一起重挂 */}
        <SourceSheet />
        {/*
          **这一页不许自己挂 `<Toaster/>`**（D32，2026-09-28 走查）。

          原先这里挂了一个（`position="top-center"`），而壳 `app/App.tsx` 里也有一个——
          两个同时挂，**同一条提示会出现两遍**（走查实测：`[data-sonner-toaster]` = 2、
          `[data-sonner-toast]` = 2）。壳那个本来就长在 `@/ui/sonner`，位置也是
          `top-center`（见那个模块头的第 2 条），所以删掉这一个**观感一模一样**，
          只是不再重复。
        */}
      </ChatRuntime>
    </ChatProvider>
  )
}
