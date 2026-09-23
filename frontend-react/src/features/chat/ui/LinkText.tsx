/**
 * 把一段**纯文本**里的网址渲染成可点的链接（旧 `components/ui/LinkText.vue` 的 React 版）。
 *
 * 为什么不能套 Markdown 渲染器：它要处理的是工具的原始摘要（搜索结果那一行
 * `[1] 标题 https://…`）与思考过程，里面的 `*`、`_`、`|`、`#` 都是内容而不是标记——
 * 套一层 Markdown 会把它们吃掉。所以这里只做一件事：识别网址、其余原样输出。
 *
 * 链接一律 `target="_blank" rel="noreferrer"`：这些地址指向站外，
 * 在同一个标签页里打开会让用户丢掉正在读的回答。
 */
const URL_PATTERN = /(https?:\/\/[^\s<>"'）)】]+)/g

export function LinkText({ text, className }: { text: string; className?: string }) {
  const parts = text.split(URL_PATTERN)
  return (
    <span className={className}>
      {parts.map((part, index) =>
        // **不用带 `g` 的正则做 `test`**：那个标志会让它带上 `lastIndex`，
        // 逐段判断时结果会随机跳动（同一个 URL 一会儿是链接一会儿不是）
        /^https?:\/\//.test(part) ? (
          <a
            // 这一列是内容而不是列表，用下标当 key 是安全的（同一份文本切出来的顺序稳定）
            key={`${index}-${part.slice(0, 12)}`}
            href={part}
            target="_blank"
            rel="noreferrer"
          >
            {part}
          </a>
        ) : (
          <span key={`${index}-t`}>{part}</span>
        ),
      )}
    </span>
  )
}
