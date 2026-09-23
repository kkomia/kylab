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
import { getFileUrl } from '@/api/conversations'
import { formatBytes } from '@/lib/format'
import type { ChatArtifact } from '@/api/chat'

import { notifyError } from '../runtime/notify'
import { useChat } from '../runtime/ChatProvider'

/**
 * 打开产物（**预览**）。
 *
 * 旧前端点开的是右侧的文件抽屉（`FileDrawer`，属于知识库域）。抽屉在 React 这边
 * 还没落地，所以这一步先做**等价且可用**的事：换一条签名 URL、在新标签页里内联打开
 * （PDF / 图片 / 纯文本能直接看），换不到链接就退回下载。
 * 抽屉接线之后这里换成打开抽屉即可——**动作的落点**只在这一个函数里。
 */
async function openArtifact(conversationId: string, file: ChatArtifact): Promise<void> {
  try {
    const { url } = await getFileUrl(conversationId, file.artifact_id, 'inline')
    window.open(url, '_blank', 'noopener')
  } catch (cause) {
    notifyError(cause)
  }
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
            onClick={() => void openArtifact(chat.conversationId, file)}
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
            onClick={() => void openArtifact(chat.conversationId, file)}
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
