/**
 * 对话页上那个**真正的弹窗**：存进知识库。
 *
 * 另外两处（引用原文、产物/文件）已经搬去 `ui/Sheets.tsx` 的**抽屉**里了
 * （旧版本就是右侧滑出，抽屉一就位就该换回去）。留在这儿的这一个**故意还是弹窗**：
 *
 * **它一定要拦一下**——"放进哪个库"是用户的事，不让服务端替他挑；
 * 而弹窗（模态）正好把"先回答这一步，再往下走"这件事表达清楚，
 * 抽屉那种"贴着边、对话还看得见"的形态反而不合适。
 *
 * 浮层走 `@/ui/dialog`（shadcn 那套原语，迁移计划 §2 的"弹窗/下拉/浮层一律走原语，
 * 不自己写模态"）：遮罩、表面、圆角、关闭按钮都是那一位的取值，这一处只管内容。
 */
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/ui/dialog'

import { useChat } from '../runtime/ChatProvider'

const BUTTON =
  'inline-flex h-[var(--control-height)] cursor-pointer items-center justify-center rounded-[var(--radius-control)] px-[var(--space-3)] text-[length:var(--text-meta-size)]'
const BUTTON_PRIMARY = `${BUTTON} bg-[var(--accent)] text-[var(--Always-White)] disabled:opacity-60`
const BUTTON_PLAIN = `${BUTTON} border border-[var(--border)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]`

/**
 * 存进知识库：列出所有库让用户挑一个（预选不等于替他决定——库名看得见，点了确认才算数）。
 *
 * 骨架走 `@/ui/dialog`（shadcn 原语，令牌类名）：标题栏 / 内容区 / 底部各一条分隔线，
 * 内容区自己滚（`max-h-[80vh]` 那套由调用方组合出来，见那份原语的说明）。
 */
export function IngestDialog() {
  const chat = useChat()
  const file = chat.ingestTarget
  if (!file) return null
  return (
    <Dialog open onOpenChange={(open) => !open && chat.closeIngest()}>
      <DialogContent
        className="flex max-h-[80vh] flex-col gap-0 p-0 sm:max-w-[560px]"
        aria-describedby={undefined}
      >
        <DialogHeader className="border-b border-[var(--border-hairline)] px-[var(--space-4)] py-[var(--space-3)]">
          <DialogTitle>存进知识库</DialogTitle>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-[var(--space-3)] overflow-y-auto p-[var(--space-4)]">
          <p className="m-0 text-[length:var(--text-meta-size)] text-[var(--text-secondary)]">
            把「{file.name}」存一份到知识库，之后它就能被检索到。
            <span className="text-[var(--text-tertiary)]">
              原文件仍然在{file.where || '原处'}，不会被搬走。
            </span>
          </p>
          {chat.kbs.length > 0 ? (
            <ul className="m-0 flex list-none flex-wrap gap-[var(--space-2)] p-0">
              {chat.kbs.map((kb) => (
                <li key={kb.id}>
                  <button
                    type="button"
                    className={`${BUTTON} ${
                      chat.ingestKbId === kb.id
                        ? 'border border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--text-primary)]'
                        : 'border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                    }`}
                    aria-pressed={chat.ingestKbId === kb.id}
                    onClick={() => chat.setIngestKbId(kb.id)}
                  >
                    {kb.name}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="m-0 text-[length:var(--text-meta-size)] text-[var(--text-secondary)]">
              还没有知识库。先去「知识库」建一个，再回来存。
            </p>
          )}
        </div>
        <DialogFooter className="border-t border-[var(--border-hairline)] px-[var(--space-4)] py-[var(--space-3)]">
          <button type="button" className={BUTTON_PLAIN} onClick={chat.closeIngest}>
            取消
          </button>
          <button
            type="button"
            className={BUTTON_PRIMARY}
            disabled={!chat.ingestKbId || chat.ingesting}
            onClick={chat.confirmIngest}
          >
            {chat.ingesting ? '存入中…' : '存进这个库'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
