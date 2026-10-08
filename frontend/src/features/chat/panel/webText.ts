/**
 * 网页那一档要用到的**两条纯文本规矩**（不认识 React、也不发请求）。
 *
 * 单独一份而不是塞进 `WebTab.tsx`：它们都是"输入字符串 → 输出字符串"的纯函数，
 * 用例能逐条钉（`tests/chat-panel-web.test.tsx` 里那一组），而塞进组件里就只能靠渲染去验。
 */

/** 认得出的协议（只有这两个算"绝对地址"）。 */
const HTTP_SCHEME = /^https?:\/\//i

/**
 * 用户输入的那一行 → 一个能抓的绝对地址；认不出来给空串。
 *
 * 三条边界：
 *
 * 1. **没写协议的补 `https://`**：地址栏里手打的是 `example.com`，那是常态，
 *    而 `example.com` 交给后端只会被当成不合法的地址（它要 http/https）；
 * 2. **只认 http(s)**：`javascript:` / `file:` / `data:` 一律给空串——这个地址会被送去
 *    后端抓、也会被交给 iframe，两种去处都只能吃这两种协议（与本仓链接白名单
 *    `markdown.tsx` 的 `SAFE_LINK` 同一条口径）；
 * 3. **必须有主机名**（`https:///path` 这种给空串）：否则抓的一定是错东西，
 *    与其让后端回一条看不懂的错，不如在地址栏这一层就说不认。
 */
export function normalizeWebUrl(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  const withScheme = HTTP_SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const parsed = new URL(withScheme)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
    if (!parsed.hostname) return ''
    return parsed.href
  } catch {
    return ''
  }
}

/** Markdown 里的一张图：`![说明](地址)`（说明里不许有 `]`，与 CommonMark 的口径一致）。 */
const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g

/**
 * 把正文里的**图片语法降级成链接**（`![说明](地址)` → `[说明](地址)`）。
 *
 * 为什么必须在这一层做掉：抓回来的正文是 Markdown，而 `renderPlainMarkdown` 会把它渲染成
 * 真正的 `<img src>`——浏览器于是**照着那张图去访问第三方站点**：用户的 IP、UA、
 * 访问时刻全都交出去了（还可能带 referer），而他只是想在面板里读一眼这一页的正文。
 * 这与本仓那条既有纪律是同一条（`model/webSites.ts`：站点的 logo 只向**我们自己的源**要，
 * 浏览器不直连第三方；`ui/siteLogos.ts` 同一句）。
 *
 * 两条分寸：
 *
 * - **图还在**：降级成链接而不是删掉——读者仍然点得到它（点了就是"我确实要看这张图"，
 *   由他决定，而那时是**标签内导航**，见 `WebTab` 的链接接管）；
 * - **说明文字留在原位**：`![](...)` 说明为空时只留一个地址链接，不为它编一句"图片"；
 *   **相对地址的图连链接都不做**（只留说明文字）：它相对的是**我们这一页**而不是那一页
 *   （`/img/x.png` 指不到对方服务器的任何东西），点开只会是一张裂图。
 */
export function demoteImageSyntax(text: string): string {
  return text.replace(MARKDOWN_IMAGE, (whole, alt: string, target: string) =>
    HTTP_SCHEME.test(target) ? `[${alt || target}](${target})` : alt || target || whole,
  )
}
