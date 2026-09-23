/**
 * 对话页的标题栏（会话标题 + 所属项目）。
 *
 * **为什么要它**（v0.28，第二批评审 A2）：消息区原先没有任何顶部上下文——
 * 正文贴到窗口顶端，第一眼看到的是"被切掉半行的一段字"，而"我正在哪条会话里、
 * 它属于哪个项目"这件事只能回头去侧栏里找（侧栏那一条还可能被滚动带出视野）。
 * 这一条是**常驻**的：它在视口之外（不跟着消息滚走），换会话才跟着换。
 *
 * 三点是有意的：
 *
 * 1. **不抢权重**：高 44px（`--row-height` 那一档，比赛道外的页头低一档）、
 *    字号 `--text-meta-size`、无底色差异、无下边框，也不放按钮——它是**这一列的
 *    抬头**，不是页头；侧栏与输入卡片仍是最重的两块；
 * 2. **数据不新拉**：标题与 `workspace_id` 都从**已经取过的会话详情**里读
 *    （`useConversationDetail` 与 `ChatProvider` 共用同一个 queryKey，命中缓存）；
 *    项目名从壳那份工作区清单里查（它由侧栏加载，这里只做"没加载过就补一次"，
 *    与 `ConversationRowMenu` 的「移至项目」同一条口径）；
 * 3. **没有标题就不占位**：新会话（`?new=1`）还没有标题，那时不画这条——
 *    一条空白的常驻栏只是把内容往下推。
 */
import { Folder } from 'lucide-react'
import { useEffect } from 'react'

// 直接引**那个模块**（不走 `@/features/layout` 的出口）：这里只要一份清单，
// 把整个壳域（侧栏、历史面板…）拖进对话页的依赖图没有必要
import { ensureWorkspacesLoaded, useWorkspaceStore } from '@/features/layout/workspaces'

import { useChat } from '../runtime/ChatProvider'
import { useConversationDetail } from '../runtime/useChatData'

export function ChatHeader() {
  const chat = useChat()
  const detail = useConversationDetail(chat.conversationId)
  const workspaceId = detail.data?.workspace_id ?? null
  const project = useWorkspaceStore((state) =>
    workspaceId ? state.items.find((item) => item.id === workspaceId)?.name : undefined,
  )

  useEffect(() => {
    // 只在**这一条会话真的挂在某个项目下**时去要清单：没有项目就没有名字可显示，
    // 而清单本身是壳的首屏数据（这里补的那一下通常命中"已经加载过"）
    if (workspaceId) void ensureWorkspacesLoaded()
  }, [workspaceId])

  const title = (detail.data?.title ?? '').trim()
  if (!title) return null

  return (
    <div className="flex h-[var(--row-height)] shrink-0 items-center px-[var(--page-gutter)]">
      {/* 与消息列同一条 768px 的居中窄列（`--chat-measure`）：抬头与它下面那段正文
          对齐在同一条竖线上，扫视时不会左右跳 */}
      <div className="mx-auto flex w-full min-w-0 items-center gap-[var(--space-2)] max-w-[var(--chat-measure)]">
        <span
          className="min-w-0 truncate text-[length:var(--text-meta-size)] font-medium text-[var(--text-primary)]"
          title={title}
        >
          {title}
        </span>
        {project ? (
          <span className="inline-flex shrink-0 items-center gap-[var(--space-1)] text-[length:var(--text-micro-size)] text-[var(--text-tertiary)]">
            <Folder size={13} aria-hidden />
            <span className="max-w-[12em] truncate" title={project}>
              {project}
            </span>
          </span>
        ) : null}
      </div>
    </div>
  )
}
