/**
 * 网页标签要读的两份**服务端状态**（抓回来的正文、嵌入探测的结论）。
 *
 * ## 为什么钩子在面板这一层，键却还是 `['chat', …]`
 *
 * 键沿用对话域那套前缀（`['chat', 'web', …]`，与 `runtime/useChatData.ts` 的
 * `['chat', 'files', …]` 同一形状）：缓存的归属是"对话页这张脸"，清缓存、失效范围
 * 都按那个前缀算。而**钩子住在面板里**是因为它只有这一个调用方——网页标签没了，
 * 这两条查询就没人读（放进 `useChatData.ts` 会让"面板这一块"散在两个目录里）。
 *
 * ## 两条查询的性情完全不同，缓存策略也就不同
 *
 * - **正文**（`useWebPage`）：一次网络往返、可能几百 KB、内容会变但变得慢。
 *   `staleTime` 给一分钟（在面板里点来点去、来回切标签不该反复重抓）。**不设重试**：
 *   失败原因（400 被闸拦 / 502 上游挂了）用户要立刻看到，重试三次只是让他多等几秒；
 * - **探测**（`useWebEmbed`）：轻（只读响应头）、而且它的结论是"要不要挂 iframe"的
 *   **闸门**——界面在它回来之前不挂 iframe（HTTP 错误对 iframe 也是一次"成功加载"，
 *   靠 `onError` 认不出来），所以这一条要快、要新。`staleTime` 给 5 分钟够用，
 *   同样不重试（探不到就是"不能嵌"，后端已经把它做成 200 + false 了）。
 *
 * 两条都把**地址本身**放进 `queryKey`：换一个地址就是另一份数据（面板的历史栈里前后翻，
 * 翻回看过的那个就直接命中缓存，不重跑）。
 */

import { useQuery } from '@tanstack/react-query'

import { checkWebEmbed, fetchWebPage, type WebEmbedCheck, type WebPage } from '@/api/web'

/**
 * 一页的正文。
 *
 * `enabled` 由调用方给：**嵌入档不抓正文**（那一档画的是原页本身，抓回来的 Markdown
 * 一个字都用不上，白跑一趟还可能拉回几百 KB）。所以"要不要抓"是界面那一档说了算，
 * 这里只声明"抓什么"。
 */
export function useWebPage(url: string, enabled: boolean) {
  return useQuery({
    queryKey: ['chat', 'web', 'page', url],
    queryFn: (): Promise<WebPage> => fetchWebPage(url),
    enabled: enabled && Boolean(url),
    staleTime: 60_000,
    // 抓不到就**如实报**（400 被闸拦 / 502 上游挂了），重试只会让用户多等
    retry: false,
  })
}

/** 这一页能不能嵌（挂 iframe 之前必须先有结论，见文件头）。 */
export function useWebEmbed(url: string, enabled: boolean) {
  return useQuery({
    queryKey: ['chat', 'web', 'embed', url],
    queryFn: (): Promise<WebEmbedCheck> => checkWebEmbed(url),
    enabled: enabled && Boolean(url),
    staleTime: 300_000,
    retry: false,
  })
}
