/**
 * 空状态（旧 `ChatView` 的 `.welcome`）：品牌字标 + 标语 + 推荐问题。
 *
 * 三点取舍都是用户的决定，照着搬：
 * 1. **字标替掉了原来那句「Hi，我是 KYLAB…」**——自我介绍占着整页最贵的一块位置说
 *    一件已知的事；Kimi 的空态只有一个字标。标语留着（它是品牌定位，不是解释性小字）；
 * 2. **推荐问题整块跟着"有没有选中知识库"出现/消失**：没有库就没有依据，
 *    给一排点了答不上的样例是在骗人；
 * 3. **一个库都没有时指路**，而不是给一排点了没反应的样例。
 *
 * 推荐问题那一块的排布（v0.28，第二批评审 A5）：**一列，每行一条，左对齐**。
 * 改之前是"居中 + 自动折行"的一堆胶囊——四条问题被折成四行、每行左起点都不一样
 * （居中把每条的长度差摊到了两端），看起来像四句散落的灰字，而它们其实是**可以点的
 * 入口**。一条一行之后：起点对齐、一眼数得清有几条、点哪一条不会点错。
 */
import { RefreshCw } from 'lucide-react'

import { Logo } from './Logo'
import { useChat } from '../runtime/ChatProvider'

export function Welcome() {
  const chat = useChat()

  return (
    <div className="flex w-full flex-col items-center gap-[var(--space-4)] px-[var(--space-2)] py-[var(--space-6)] text-center">
      <span className="text-[var(--accent)]">
        <Logo variant="wordmark" size={34} />
      </span>
      <p className="m-0 text-[length:var(--text-meta-size)] text-[var(--text-secondary)]">
        让你的知识触手可及
      </p>

      {chat.showSuggestions ? (
        /**
         * 一条一行、左对齐、整列与消息列同宽（`--chat-measure`）：
         * 推荐问题是**入口**，不是装饰——一排居中的散句读起来像"随便看看"，
         * 而左对齐的等宽行读起来像一份清单（`text-left` 是必须的：这一层上面是
         * `text-center`，不写回来的话每一条问题都会在框里居中）。
         */
        <div className="mt-[var(--space-2)] flex w-full max-w-[var(--chat-measure)] flex-col items-stretch gap-[var(--space-2)] text-left">
          <div className="inline-flex items-center gap-[var(--space-1)] text-[length:var(--text-meta-size)] text-[var(--text-tertiary)]">
            <span>你可以这样问我</span>
            <button
              type="button"
              className="inline-flex h-[22px] w-[22px] cursor-pointer items-center justify-center rounded-[var(--radius-control)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-50"
              aria-label="换一批示例问题"
              title="换一批"
              disabled={chat.suggestionsLoading}
              onClick={chat.shuffleSuggestions}
            >
              <RefreshCw size={14} />
            </button>
          </div>
          <div
            data-testid="suggestion-list"
            className={`flex flex-col gap-[var(--space-2)] ${chat.suggestionsLoading ? 'opacity-50' : ''}`}
          >
            {chat.suggestions.map((sample) => (
              <button
                key={sample}
                type="button"
                // 有边框、有底色、悬停变深：它是**能点的**（改之前与页面上的普通灰字
                // 没有区别，全靠"猜"才知道能按）
                className="w-full cursor-pointer rounded-[var(--radius-panel)] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-[var(--space-4)] py-[var(--space-3)] text-left text-[length:var(--text-meta-size)] text-[var(--text-secondary)] [transition:var(--transition-ui)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                onClick={() => chat.useSample(sample)}
              >
                {sample}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {/* 一个库都没有时，提问无从谈起：指路比给一排点了没反应的样例好 */}
      {chat.kbs.length === 0 && !chat.kbLoading ? (
        <a
          className="text-[length:var(--text-meta-size)] text-[var(--accent-text)] hover:underline"
          href="/knowledge-bases"
        >
          还没有知识库，先去建一个并上传文档
        </a>
      ) : null}
    </div>
  )
}
