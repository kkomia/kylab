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
 * ChatProvider   页面状态与动作（消息、发送、过程面板、交付物、弹窗）
 * └ ChatRuntime  assistant-ui 的 runtime 适配（外部 store；协议仍是我们自己的）
 *   └ ChatThread 对话区（视口、跟随滚动、欢迎层、消息列表）
 *   └ Composer   输入卡片（附件/技能/模式/执行策略/知识库/模型/仪表/发送）
 * ```
 *
 * 路由与页面壳由主控接（`src/app/**`）：这一页只管 `/chat/:conversationId?`
 * 那两个参数（会话 id 与 `?new=1`），其余入口一律不改路径。
 */
import { Toaster } from 'sonner'

import { ChatProvider } from './runtime/ChatProvider'
import { ChatRuntime } from './runtime/ChatRuntime'
import { ChatThread } from './ui/ChatThread'
import { Composer } from './ui/Composer'
import { IngestDialog, SourceDialog } from './ui/Dialogs'

export function ChatPage() {
  return (
    <ChatProvider>
      <ChatRuntime>
        {/* 整页占满内容区：中间滚动、底部固定输入卡片。**对话页没有页头**——
            侧栏已经写着"对话"，再顶一个同名标题只是重复 */}
        <div className="flex h-dvh flex-col bg-[var(--bg-canvas)] text-[var(--text-primary)]">
          <ChatThread />
          <Composer />
        </div>
        <SourceDialog />
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
