/**
 * 对话页（P0 占位：确认脚手架能跑通）。
 *
 * P1 阶段这个文件会被真正的对话页替换掉（assistant-ui + 自建 runtime，
 * 见 `docs/计划与记录/React-迁移计划-v0.1.md` §4 的 P1）。
 */
export function ChatPage() {
  return (
    <div className="flex h-dvh items-center justify-center bg-canvas text-text-secondary">
      <p className="text-body">KYLAB · React 前端脚手架已就绪（对话页在 P1 落地）</p>
    </div>
  )
}
