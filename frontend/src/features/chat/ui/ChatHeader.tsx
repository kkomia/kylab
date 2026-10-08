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
 * 3. **没有标题也占位**（2026-10-05 改）：这一条原先"没有标题就不画"（新会话
 *    `/chat?new=1` 还没有标题，一条空白的常驻栏只是把内容往下推）。但右端那颗
 *    「面板」开关长在这一行的末尾——它一旦跟着藏起来，新会话里就打不开右侧面板
 *    （而"刚进来想翻一下文件"恰恰是新会话里最常发生的事）。所以这一行现在**常驻**，
 *    只是没有标题时左边那一格空着：44px 的代价换"开关永远够得着"。
 */
import { Folder, PanelRight } from 'lucide-react'
import { useEffect } from 'react'

// 直接引**那个模块**（不走 `@/features/layout` 的出口）：这里只要一份清单，
// 把整个壳域（侧栏、历史面板…）拖进对话页的依赖图没有必要
import { ensureWorkspacesLoaded, useWorkspaceStore } from '@/features/layout/workspaces'

import { useChat } from '../runtime/ChatProvider'
import { useConversationDetail } from '../runtime/useChatData'
import { usePanelStore } from '../panel/panelStore'

export function ChatHeader() {
  const chat = useChat()
  const detail = useConversationDetail(chat.conversationId)
  const workspaceId = detail.data?.workspace_id ?? null
  const project = useWorkspaceStore((state) =>
    workspaceId ? state.items.find((item) => item.id === workspaceId)?.name : undefined,
  )
  const panelOpen = usePanelStore((state) => state.open)
  const togglePanel = usePanelStore((state) => state.toggle)
  /**
   * 面板里还有几个**没看过**的标签（agent 抓页建出来的那些，见 `panelStore.unread`）。
   *
   * 只在**面板关着**时露出来：开着的时候那个数在标签条的小圆点上（用户正看着标签条，
   * 再说一遍是重复的）。
   */
  const unseen = usePanelStore((state) => state.unread.length)

  useEffect(() => {
    // 只在**这一条会话真的挂在某个项目下**时去要清单：没有项目就没有名字可显示，
    // 而清单本身是壳的首屏数据（这里补的那一下通常命中"已经加载过"）
    if (workspaceId) void ensureWorkspacesLoaded()
  }, [workspaceId])

  const title = (detail.data?.title ?? '').trim()

  return (
    <div className="flex h-[var(--row-height)] shrink-0 items-center px-[var(--page-gutter)]">
      {/* 与消息列同一条 768px 的居中窄列（`--chat-measure`）：抬头与它下面那段正文
          对齐在同一条竖线上，扫视时不会左右跳 */}
      <div className="mx-auto flex w-full min-w-0 items-center gap-[var(--space-2)] max-w-[var(--chat-measure)]">
        {title ? (
          <span
            className="min-w-0 truncate text-[length:var(--text-meta-size)] font-medium text-[var(--text-primary)]"
            title={title}
          >
            {title}
          </span>
        ) : null}
        {project ? (
          <span className="inline-flex shrink-0 items-center gap-[var(--space-1)] text-[length:var(--text-micro-size)] text-[var(--text-tertiary)]">
            <Folder size={13} aria-hidden />
            <span className="max-w-[12em] truncate" title={project}>
              {project}
            </span>
          </span>
        ) : null}
        {/*
          右侧面板的开关。摆在**这一行的右端**（`ml-auto`）而不是页面右上角：
          对齐的是它下面那条 768 的窄列，不在标题栏里再挖一处新的对齐线。
          `aria-pressed` 说的是"这颗按钮管的那件事现在开着没有"（开关类按钮的口径），
          名字随状态走，读屏念出来就是"收起右侧面板"。

          面板关着、而里面躺着没看过的网页标签时，右上角挂一个 `N` 角标：
          agent 抓页建标签**不抢焦点**（见 `panelStore.unread`），不主动说一声，
          用户不会知道面板里多了东西。角标本身对读屏不可见（`aria-hidden`），
          那个数在 `title` 里说一遍——名字必须留在原来的那句上，否则
          "打开右侧面板"这颗按钮就找不到了（用例与肌肉记忆都认它）。
        */}
        <button
          type="button"
          className="relative ml-auto inline-flex h-[var(--hit-target)] w-[var(--hit-target)] shrink-0 cursor-pointer items-center justify-center rounded-[var(--radius-control)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          aria-pressed={panelOpen}
          aria-label={panelOpen ? '收起右侧面板' : '打开右侧面板'}
          title={
            !panelOpen && unseen > 0
              ? `打开右侧面板（${unseen} 个新页面）`
              : panelOpen
                ? '收起右侧面板'
                : '打开右侧面板'
          }
          onClick={togglePanel}
        >
          <PanelRight size={16} />
          {!panelOpen && unseen > 0 ? (
            <span
              aria-hidden
              data-unseen={unseen}
              className="absolute -top-0.5 -right-0.5 inline-flex h-[14px] min-w-[14px] items-center justify-center rounded-[var(--radius-pill)] bg-[var(--accent)] px-[3px] text-[length:var(--text-micro-size)] leading-none text-[var(--Always-White)]"
            >
              {unseen}
            </span>
          ) : null}
        </button>
      </div>
    </div>
  )
}
