/**
 * 「网页」那两条本机端点（对话页右侧面板的网页标签用）。
 *
 * | 端点 | 回答什么 |
 * | --- | --- |
 * | `GET /web/page?url=` | 把一页的正文抓回来（Markdown）——**阅读模式渲染的那一份** |
 * | `GET /web/embed-check?url=` | 这一页能不能被浏览器嵌进 iframe（探一次响应头） |
 *
 * ## 为什么类型手写（与 `api/conversations.ts` 同一套做法）
 *
 * 这一族**只挂本机档**（`backend/app/api/v1/router.py` 的 `local_router.include_router(web.router)`），
 * 而生成物（`schema.d.ts` 与《API 接口规范》）是按**服务器档的 OpenAPI** 生成的 ——
 * 服务器档没有这一族，模型也就不会出现在生成物里。处置照本仓对"只在本机档成立的端点"的
 * 既有先例（`api/local.ts` / `api/provider.ts` / `api/backup.ts` 的 `/local/*` 那一族）：
 * **手写 + 写清出处**。
 *
 * 字段逐条对着 `backend/app/api/v1/web.py` 的两个 `BaseModel` 抄
 * （`WebPageOut` / `EmbedCheckOut`），**改了后端就回来改这里**：
 *
 * - `fetched_at` 后端是 `datetime`（UTC，带时区），线上就是 ISO 字符串 —— 界面只拿它
 *   报"什么时候抓的"，不自己再解析成一门日期库里的一等公民；
 * - `x_frame_options` / `frame_ancestors` 是**对方的原话**（没有就是空串）：要说明
 *   "对方为什么不让嵌"时直接显示它，界面不再解析一遍（判定只有后端 `_judge_embeddable` 一处）。
 *
 * ## 三条状态码的含义（界面上各有各的说法）
 *
 * - **400**：内网 / 本机 / 云元数据地址被 SSRF 闸拦了（`check_public_url`），
 *   或者重定向跳到了这类地址 —— `message` 是后端那句原话，照原样显示；
 * - **502**：上游出问题（对方 4xx/5xx、超时、拿回来的不是网页正文）—— "重试还是换个地址"
 *   由用户自己判；
 * - **`/embed-check` 的 `embeddable: false` 不是错误**：连不上 / 超时 / 对方跳走了也是
 *   **200 + false**，那是"阅读模式该走另一条路"的正常答案，不是这次请求失败。
 *
 * 两条都走 `requestLocal`：抓取与探测都在这台机器上跑（隐私与 SSRF 闸都在本机），
 * 判定只有 `api/sidecar.ts` 的 `LOCAL_PATHS` 一处。
 */

import { requestLocal } from './client'

/** `WebPageOut`：一页的正文（`backend/app/api/v1/web.py`，字段逐条照抄）。 */
export interface WebPage {
  /** 请求的那个地址（后端回的是它校验并归一之后的那一份）。 */
  url: string
  /** 真正读到的那一页；当前等于 `url`（服务层没把跳转后的地址传出来，见后端模块头）。 */
  final_url: string
  /** 页面标题（取不到时是地址本身）。 */
  title: string
  /** 正文（Markdown；超长已截断，尾部有后端留的那句说明）。 */
  text: string
  /** 正文是不是被截断了（界面上要如实说一句"只读了前一段"）。 */
  truncated: boolean
  /** 取回的时刻（UTC，ISO 字符串）。 */
  fetched_at: string
}

/** `EmbedCheckOut`：这一页能不能被嵌进来（同上，字段逐条照抄）。 */
export interface WebEmbedCheck {
  url: string
  /** 浏览器会不会拒载这一页。`false` 可能是"对方不让"，也可能只是"没探到"。 */
  embeddable: boolean
  /** 为什么（对方的原话 + 下一步）——`embeddable` 为真时也有话说（`X-Frame-Options` 那条）。 */
  reason: string
  /** 对方设的 `X-Frame-Options`（没有就是空串）。 */
  x_frame_options: string
  /** 对方 CSP 里 `frame-ancestors` 那几句的值（没有就是空串）。 */
  frame_ancestors: string
}

/** 抓一页正文（阅读模式的料；内网 / 本机地址会被 400 拦下，上游问题 502）。 */
export function fetchWebPage(url: string): Promise<WebPage> {
  return requestLocal<WebPage>(`/web/page?url=${encodeURIComponent(url)}`)
}

/**
 * 问一句"对方让不让嵌"。
 *
 * `embeddable: true` 只表示"那两条响应头没拦我们"：对方还可能用 JS 自检、或者干脆是个
 * 登录页 —— 所以这条端点的用途是**少走一次白等**（界面在挂 iframe 之前先拿到一个结论），
 * 不是保证。
 */
export function checkWebEmbed(url: string): Promise<WebEmbedCheck> {
  return requestLocal<WebEmbedCheck>(`/web/embed-check?url=${encodeURIComponent(url)}`)
}
