/**
 * **交付物**（v0.26）：这一轮产出的文件摆在正文之后、动作之前。
 *
 * 改之前它们挂在各自那一步下面——交付物出现在过程面板**中间**，
 * 要往下翻十来步工具调用才看得到，而面板一收起卡片就跟着没了。
 * 交付物是这个回合的**结果**，不是过程的中间产物。
 *
 * **流式中先不摆**（v0.41）：导出那一步一跑完，卡片就冒出来了，而正文还在
 * 一个字一个字地出——看起来像"回答还没写完，东西就先交了"。现在等这一轮收尾再交付；
 * 过程面板里那一步照旧写着「导出文档 · 已导出」，中间状态并不丢。
 */
import { formatBytes } from '@/lib/format'
import type { ChatArtifact } from '@/api/chat'

import { useChat, type ChatApi } from '../runtime/ChatProvider'

/**
 * 打开产物（**预览**）：开文件区抽屉，并**直落这一份**。
 *
 * 旧前端点开的就是右侧的文件抽屉（`FileDrawer` 的 `initialKey` / `initialEntry`），
 * 这里现在也是了——不再换一条签名链接丢到新标签页里（那会让人离开对话上下文，
 * 而 Office 三件套还得靠浏览器的下载行为）。
 *
 * `name` 与 `kind` **必须跟着 key 一起给**：产物在临时区的 key 就是 `artifact_id`，
 * 一串没有后缀的标识符，抽屉光看它猜不出该用哪个渲染器——不给的话，同一份文件
 * 从产物卡片点开说"不能预览"，从文件区列表点开却好好的（旧版用户报的就是这个）。
 */
function openArtifact(chat: ChatApi, file: ChatArtifact): void {
  chat.openFiles({ key: file.artifact_id, name: file.name, kind: file.format })
}

export function Deliverables({ files }: { files: ChatArtifact[] }) {
  const chat = useChat()
  if (files.length === 0) return null

  return (
    <ul className="m-0 mt-[var(--space-4)] flex list-none flex-col gap-[var(--space-2)] p-0">
      {files.map((file) => (
        <li
          key={file.artifact_id}
          className="flex items-center gap-[var(--space-3)] rounded-[var(--radius-row)] border border-[var(--border)] bg-[var(--bg-surface)] px-[var(--space-3)] py-[var(--space-2)]"
        >
          <span className="flex h-[28px] w-[40px] shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-[var(--bg-subtle)] text-[length:var(--text-c2-size)] font-medium text-[var(--text-tertiary)]">
            {file.format.toUpperCase()}
          </span>
          <button
            type="button"
            className="min-w-0 flex-1 cursor-pointer text-left"
            onClick={() => openArtifact(chat, file)}
          >
            <span className="block truncate text-[length:var(--text-meta-size)] text-[var(--text-primary)]">
              {file.name}
            </span>
            <span className="tabular block text-[length:var(--text-micro-size)] text-[var(--text-tertiary)]">
              {formatBytes(file.size_bytes)}
              {file.where ? ` · ${file.where}` : ''}
            </span>
          </button>
          <button
            type="button"
            className="shrink-0 cursor-pointer text-[length:var(--text-micro-size)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            onClick={() => openArtifact(chat, file)}
          >
            预览
          </button>
          {/*
            「存进知识库」**一定要经过那一步弹窗**，不让服务端替用户挑库：
            "放进哪个库"是他的事，而弹窗就是他回答这件事的地方。
          */}
          {file.knowledge_base_id ? (
            <span
              className="shrink-0 text-[length:var(--text-micro-size)] text-[var(--text-tertiary)]"
              title={chat.kbName(file.knowledge_base_id)}
            >
              已存进知识库
              {chat.kbName(file.knowledge_base_id)
                ? `「${chat.kbName(file.knowledge_base_id)}」`
                : ''}
            </span>
          ) : (
            <button
              type="button"
              className="shrink-0 cursor-pointer text-[length:var(--text-micro-size)] text-[var(--accent-text)] hover:underline"
              onClick={() => chat.openIngest(file)}
            >
              存进知识库
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}
