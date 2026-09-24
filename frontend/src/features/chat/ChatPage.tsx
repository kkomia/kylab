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
 * 两个浮层挂在页面这一层：`ui/Sheets.tsx` 的两个抽屉（引用原文、产物与文件）与
 * `ui/Dialogs.tsx` 的「存进知识库」弹窗（后者故意还是弹窗，理由见那份文件）。
 *
 * 路由与页面壳由主控接（`src/app/**`）：这一页只管 `/chat/:conversationId?`
 * 那三个参数（会话 id、`?new=1`、`?workspace=<id>`），其余入口一律不改路径。
 */
import { Toaster } from 'sonner'

// 回答正文的排版（`md-p` / `md-ul` / `md-cite` 那一族，渲染器一直在发这些类名）。
// 挂在页面这一层而不是某个组件里：消息列表、过程面板、出处列表都要它
import './ui/chat.css'
import { ChatProvider, useChat } from './runtime/ChatProvider'
import { ChatRuntime } from './runtime/ChatRuntime'
import { ChatThread } from './ui/ChatThread'
import { Composer } from './ui/Composer'
import { IngestDialog } from './ui/Dialogs'
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

export function ChatPage() {
  return (
    <ChatProvider>
      <ChatRuntime>
        {/* 整页占满内容区：中间滚动、底部固定输入卡片。
            **页头只有一条低权重的会话条**（`ChatHeader`：会话标题 + 项目名，44px）——
            它不重复侧栏的"对话"，只回答"我现在在哪条会话里"；这是 2026-09-24 界面评审
            对着 DeepSeek / Kimi 补上的（原先完全无页头，长会话里滚动后不知道在哪）。
            会话条本身在 `ChatThread` 里、不随消息滚走。 */}
        <div className="flex h-dvh flex-col bg-[var(--bg-canvas)] text-[var(--text-primary)]">
          <NewChatScope />
          <ChatThread />
          <Composer />
        </div>
        {/* 引用原文是抽屉（贴边滑出，对话还看得见）；「存进知识库」仍是弹窗（要拦一下）。
            挂在这儿而不是页内：抽屉是**页面级浮层**，不该跟着输入卡片一起重挂 */}
        <SourceSheet />
        <IngestDialog />
        {/*
          Toast 挂在这一页上：P2 的壳会带自己的 Toaster，届时这一个删掉即可
          （两个同时挂会让同一条提示出现两遍）。
        */}
        <Toaster position="top-center" />
      </ChatRuntime>
    </ChatProvider>
  )
}
