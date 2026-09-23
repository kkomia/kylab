/**
 * 空状态（旧 `ChatView` 的 `.welcome`）：品牌字标 + 标语 + 推荐问题。
 *
 * 三点取舍都是用户的决定，照着搬：
 * 1. **字标替掉了原来那句「Hi，我是 KYLAB…」**——自我介绍占着整页最贵的一块位置说
 *    一件已知的事；Kimi 的空态只有一个字标。标语留着（它是品牌定位，不是解释性小字）；
 * 2. **推荐问题整块跟着"有没有选中知识库"出现/消失**：没有库就没有依据，
 *    给一排点了答不上的样例是在骗人；
 * 3. **一个库都没有时指路**，而不是给一排点了没反应的样例。
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
        <div className="flex flex-col items-center gap-[var(--space-2)]">
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
            className={`flex max-w-[860px] flex-wrap justify-center gap-[var(--space-2)] ${
              chat.suggestionsLoading ? 'opacity-50' : ''
            }`}
          >
            {chat.suggestions.map((sample) => (
              <button
                key={sample}
                type="button"
                className="cursor-pointer rounded-[var(--radius-pill)] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-meta-size)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
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
