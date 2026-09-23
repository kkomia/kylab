# 前端技术栈与 chat UI 重做评估 v0.1

- 日期：2026-09-23
- 动机：用户带来一份《React vs Vue / Next.js 选型》调研，判断"做 agent 产品 2026 年的
  默认答案是 Next.js + TypeScript + React"，并准备**后端继续 Python、前端离开 Vue 改 React**；
  同时明确"**我还是 chat ui 现状十分不满**"。本报告做三件事：核那份调研里可证的事实、
  把我们的现状量清楚、给出可选路线与成本。
- 方法：本仓库**只读取证**（前端/后端代码、开发计划 25 条对话界面条目、既有三份界面文档）
  + 外部事实核验（assistant-ui / CopilotKit / Vercel AI SDK / AG-UI 的官方文档与仓库）。
- 配套：[开发计划 §12.229](../计划与记录/开发计划-v0.1.md)（结论与待决点）、
  [界面评审与改进计划 v0.2](界面评审与改进计划-v0.2.md)、[Kimi 界面逐处对照 v0.1](Kimi-界面逐处对照-v0.1.md)、
  [前端设计规范 v0.14](../规范/前端设计规范-v0.14.md)

**证据分级**（每条都标）：`实测` = 本仓库代码/文档里的可复算数字；
`官方文档` = 厂商文档或仓库 README 原文；`二手` = 榜单/博客类说法，**不作为决策依据**。

---

## 1. 那份调研里哪几条是真的

| 结论 | 判定 | 证据 |
| --- | --- | --- |
| assistant-ui 是 React 专属（React / React Native / Ink），Vue/Svelte/Angular 明确不支持 | **真** | `官方文档`：README 自称 "open-source TypeScript/React library"，只列 React / React Native / Ink 三端 |
| assistant-ui **不要求 JS 后端**，可以接任意自定义后端 | **真** | `官方文档`：支持 "any custom runtime"、"Custom data-stream backend"，后端集成表里有 AG-UI/A2A、LangGraph 等 |
| CopilotKit 的 Vue 支持只是"标着支持、quickstart 还在路上" | **部分不准** | `官方文档`：首页把 Vue 与 React / React SPA / React Native / Angular 并列在支持的前端里；文档密度确实仍压在 React/Next 上 |
| Vercel AI SDK 框架无关（React / Vue / Svelte 都有） | **真** | `官方文档`：入门指南有 Vue.js(Nuxt) 与 Svelte；但 UI 层（`useChat` 那套）的示例与模板几乎全是 Next/React |
| "不存在 Next.js 还是 TS——TS 已是标配" | **纠题正确** | 我们本来就是 TS（`typescript 5.6`、`vue-tsc`、全仓 `.ts`/`.vue` 带类型） |
| AG-UI 是接 assistant-ui 的通用桥 | **打折** | `官方文档`：AG-UI 共 16 类事件、传输无关（SSE/POST）。它**没有序号、没有重放、没有审批中断语义，也没有"来源/斜杠命令"这两类**——见 §3.4 |
| "Next.js 是 AI 产品事实默认、70% 新 React 项目直接上" | **二手，不采信** | 来源是榜单类文章，且对本项目不构成论据（见 §4.2） |

一句话：**那份调研最硬的那条（agent UI 库 React-only）是真的，我们核过了；但它的结论
"所以上 Next.js"对我们不成立**——原因在 §4.2。

---

## 2. 现状：我们有多少 chat UI

### 2.1 前端总量（`实测`，`frontend/src` 64,998 行 / 221 文件）

| 目录 | 文件 | 行数 |
| --- | --- | --- |
| `views/` | 13 | 15,215 |
| `components/` | 148 | 25,023 |
| `composables/` | 21 | 4,190 |
| `stores/` | 7 | 1,076 |
| `api/` | 25 | 18,075（其中 `schema.d.ts` **14,060 是生成物**，手写 4,015） |
| `assets/` 样式（token + 双主题） | 3 | 1,048 |

`.vue` 内部构成：`<script>` 16,645 行、`<template>` 9,361 行、`<style>` 13,011 行。

### 2.2 chat 这一块（要重做的真实体量）

| 文件 | 行数 |
| --- | --- |
| `views/ChatView.vue` | **4,869**（script 2,374 / template 841 / style 1,789，含引用的 `trace-row.css` 141） |
| `components/chat/`（8 组件 + 1 css） | 1,840 |
| `api/chat.ts`（SSE 客户端 + 09 类事件类型 + 10 个 handler） | 1,007 |
| `composables/useChatTurns.ts`（回合模型/过程面板投影） | 832 |
| `composables/useLiveTurn.ts`（常驻流 + 重连状态机） | 586 |
| `stores/conversations.ts` | 362 |
| 小计（**不含**下列共享件） | **≈ 9,500** |

它还会牵出这些（chat 页真的在用）：`useMarkdown.ts` 580（自研，含引用徽标替换）、
`useLatex.ts` 290（自研）、`clipboard.ts` 120、`useFormat.ts` 135、`useShortcuts.ts` 378、
7 个 `components/ui/`（`ModelPicker` 449、`AppModal` 251、`RowMenu` 240、`AppButton` 136、
`SkeletonBlock` 126、`AppInput` 119、`LinkText` 94）、24 个图标组件、
预览链（`DocumentDrawer` 1,293 + `FileDrawer` 543 + `FilePreview` 378 + `OfficePreview` 110）。
**加上这些，chat 页的依赖闭包 ≈ 11,000 行。**

### 2.3 测试与门禁（`实测`）

- 前端 **863 条用例 / 82 个文件**；其中 `ChatView.test.ts` **2,963 行 / 77 条**。
- **没有 e2e、没有视觉回归**（`tests/e2e/` 只有 `.gitkeep`，无 playwright/cypress）。
- 与前端绑定的门禁：eslint + prettier、`vue-tsc` 类型检查、vitest、生产构建、
  emoji 扫描、**界面文案门禁 U1**（`scripts/check_layering.py`，禁 `description=` 与
  `page-/panel-/section- × desc/lead` 类名）。

### 2.4 后端与前端框架的耦合（`实测`）：几乎为零

- **182 个端点 / 137 条唯一路径**，全部挂在 `/api/v1`；**无 WebSocket**。
- 鉴权只有 `Authorization: Bearer <token>`（登录会话 `kylab_st_` 前缀 + API Key 同一条
  `resolve_caller`），前端令牌存在 `localStorage['kylab-session-token']`；
  **没有 cookie、没有 CSRF**，另有一个 `X-Kylab-Operator` 归属标注头。
- 后端**不托管前端**：无 `StaticFiles` / `Jinja` / 模板渲染；生产由前端自己的 nginx
  服务 SPA，`location /api/` 反代后端（`proxy_buffering off` 为 SSE）。
- 桌面壳（Tauri 2）**只认 URL**：探到服务器地址后直接 `window.navigate(url)` 加载远端前端。
- 契约门禁 `scripts/gen_api_types.py --check` 从 OpenAPI 生成 `schema.d.ts`，
  **只依赖后端 spec + Node CLI**，换任何前端都能继续用。
- 设计令牌是**纯 CSS 变量**（`assets/base.css` 75 条 + 亮/暗两份主题）——跨框架可复用。

**结论：换前端框架，后端一个字都不用改；真正的工作量全在 chat 页那一侧。**

### 2.5 必须重接的部分（协议这一层最容易低估）

| 项 | 现状 | 换框架要做什么 |
| --- | --- | --- |
| SSE 9 类事件 | `step` / `sources` / `approval` / `thinking` / `delta` / `done` / `error` / `command` / `ping` | 重写解析 + 10 个回调的语义映射（`api/chat.ts` 1,007 行） |
| 序号与重放 | 每条落库事件带 `seq`；`GET /chat/turns/{id}/live?after=N` 按锚点补发；后台跑 + 240 条环形缓冲 | 重写重连状态机（`useLiveTurn.ts` 586 行）。**AG-UI 没有这一层** |
| 审批 | `POST /chat/approvals/{id}`（独立 JSON 端点，必须不等），超时倒计时 | 重写（AG-UI 最接近的 `RUN_FINISHED.outcome=interrupt` **不带等待/超时语义**） |
| 停止 | 走 `/stop` 斜杠命令，不是独立端点 | 重写 |
| 来源 / 命令 | `sources{items[]}`、`command{name,text,ok,action}` | **AG-UI 没有对应事件**，只能 `CUSTOM` 或自建 runtime |
| 上传 / 签名链接 | multipart + HMAC 签名 URL（`<img>` 带不了头） | 照搬（与框架无关） |

### 2.6 Vue 专属依赖只有 6 个（`实测`）

`vue`、`vue-router`、`pinia`、`@tiptap/vue-3`、`@vue-office/excel`、`@vue-office/pptx`。
框架无关的：`@tiptap/core` 与各扩展、`tiptap-markdown`、`echarts`、`docx-preview`、
`openapi-typescript`。**markdown 与 LaTeX 渲染是我们自研的**（没有第三方依赖）。

---

## 3. "不满"的历史形状（比框架之争更重要）

### 3.1 把开发计划里对话界面相关的条目按时间排，是同一形状重复了 25 次（`实测`）

| § | 用户报的现象（原文摘录） | 根因 | 修法 |
| --- | --- | --- | --- |
| §12.35 | 「**用户给了一张参考图**：对话页空状态是"居中问候 + 示例问题胶囊 + 大圆角输入卡片"」 | 空状态是"选一个知识库，然后提问" | 欢迎层 + 圆角输入卡片 + 示例问题胶囊 |
| §12.36 | 「用户看过上一版后给了五条批注：输入框太宽、页头那个"对话"是多余的、知识库改成下拉多选…」 | 无窄列约束、页头多余 | 960px 居中窄列、去页头、多选、会话级模型 |
| §12.61 | 「一个模型设置就需要三个下拉框，太复杂了」 | 输入区 4 控件 / 3 下拉 | 合并成一个浮层，控件 4→2、下拉 3→1 |
| §12.68 | 「参考 WeKnora 的对话界面，把实际对话的 UI 向成熟产品看齐」 | 无气泡、过程无时间线、引用是纯文本 | 提问气泡、过程面板、行内引用徽标、来源收进面板 |
| §12.90 | 「流式包括检索结果、思考、正文三部分；但有些模型 API 快得离谱，可能一瞬间就全出来了」 | 后端一次吐完 | `displayPacer`：正文 40→600 字/秒自适应 |
| §12.105 | 「回答里的引用序号 `[1]` 改成显示文档名缩写；点文件名从对话页右边**抽屉滑出**，不要再跳去知识库页」；第二版用户嫌「太显眼了，改小一点」 | 跳库页会丢滚动位置 | 徽标短名 + `DocumentDrawer`；两次调强调色 |
| §12.182 | 「左下侧边栏这块的问题我觉得是很严重的」 | 同一栏两条起始线；输入框层级方向搞反 | 组件层逐处对齐 Kimi；规范升 v0.14 |
| §12.189 | 「现在来调整我们对话页面的 ui 美术表现……**像素级抄袭。抄袭不可怕，谁丑谁尴尬 懂吗？**」 | 代码块无复制、表格光秃、过程面板一到第一个字就自动收起 | 代码块两段式、表格头部带、工具调用默认展开、步数上限 6→30 |
| §12.190 | 「回答完成后看不到中间工具调用和思考过程」「执行工具时不断输出行，页面不跟着往下滚」「产物没有落点」 | 步骤与思考**根本没落库**；跟随滚动指纹没算步骤 | 迁移 v9 加 `steps/thinking`；跟随滚动；产物卡片 |
| §12.195 | 「一个回合跑了 12 步…12 行几乎一样的东西堆在过程面板里，而且每一行画的是同一个图标」 | 无分组、无图标语义 | 同工具合并（12 行→4 行）、13 类图标 |
| §12.197 | 「交付物挂在「导出幻灯」那一步（面板中间）」 | 产物位置错 | 产物收成一份摆正文之后、动作之前 |
| §12.201 | （截图）「分组的工具行排版不对」「没开知识库却每轮都去知识库检索」 | v0.26 抽取时样式没跟着搬 | 抽 `trace-row.css` 一份外壳 |
| §12.202 | 「工具调用与思考过程采用流式输出，参考 DeepSeek 的 harness……思考就只显示一行，一行从左到右滚动」 | 思考像一堵墙一样长高 | `LiveLine.vue` |
| §12.205 | （截图）一屏里四条「复制失败，请手动选中后复制」 | 异步剪贴板在无焦点时被拒 | 两级复制 + 失败替用户选中 |
| §12.219/227/228 | 「为啥老是这种情况？」（回答区里是一段 `<tool_call>` 标记） | 收尾那两步不带工具表 | 解析层认标记 + 流式过滤器（本会话刚做完） |

（完整 25 条见开发计划 §12.35–§12.228；另有三份界面文档在推进同一件事：
`界面评审与改进计划-v0.2.md` 392 行、`Kimi-界面逐处对照-v0.1.md` 233 行、
`UI-评估与优化方案-v0.1.md` 186 行。）

### 3.2 归纳：反复出现的只有四类

1. **过程面板的表达力**（多少个字：分组、图标、展开时机、滚动跟随、工具卡字段）——出现 8 次，最近一次 §12.201/§12.228；
2. **正文与周围元素的排布**（气泡、引用徽标、产物位置、抽屉、窄列）——出现 7 次，最近 §12.197；
3. **控件与层级的一致**（下拉框、按钮大小、图标、聚焦、强调色）——出现 6 次，最近 §12.182/§12.189；
4. **文案纪律**（解释性小字、"意义不明的说明"）——出现 4 次，最近 §12.168（并已做成门禁 U1）。

### 3.3 这条归纳意味着什么

**这 25 条没有一条是"Vue 做不到"，全都是"我们手写的那一层细节还不够好"。**
它们在 React 里同样要一条条做——区别只在于 assistant-ui 这类库把**最通用的一层**
（消息列表、输入框、自动滚动、附件、编辑/分支、工具调用的渲染插槽）变成了默认值，
我们不必再从零写到"第 25 版"。

### 3.4 但 assistant-ui 帮不到我们的那些（要预先说清）

按 §2.5 的协议对照，AG-UI 里**没有**：序号/重放、审批中断、来源清单、斜杠命令。
也就是说接 assistant-ui **不是**"装个包就换掉 chat 页"，仍然要：
自建或适配一个 runtime（把我们的 9 类事件喂进去）、把"过程面板/工具卡/交付物/审批条"
用它的插槽重写一遍。**库省下的是通用层，省不下我们最花时间的那一层。**

---

## 4. 三条路线与成本

### 4.1 路线 A：只把 chat 页用 React 重做（推荐）

新建 `frontend-react/`（**Vite + React + TS**，不用 Next），只负责 `/chat/*`；
nginx 按路径前缀分流（`location ^~ /chat` → 新构建的 `index.html`，其余仍走旧的 Vue SPA）；
两套共用同一份 design token（`base.css` 的 CSS 变量直接拷）与同一个 token
（同源 `localStorage` 天然共享）；Tauri 壳与后端**不动**。

- 成本：闭包 ~11,000 行里，**能直接搬的纯逻辑约 4,000–4,500 行**（`api/chat.ts` 的解析、
  `useChatTurns` 的回合模型、`displayPacer`、`useMarkdown`/`useLatex`、`clipboard`）。
  **要在 React 里重写的约 6,500 行**（`ChatView` 4,869 + 8 个 chat 组件 1,840 +
  7 个 ui 组件与 24 个图标 + 预览链 2,324 中的 chat 部分）；
  测试：`ChatView.test.ts` 77 条重写（其中逻辑型用例可搬），其余 786 条不动。
- 收益：拿到 assistant-ui 的 thread / composer / autoscroll / 附件 / 编辑分支，
  以及后续 generative UI、HITL 组件的生态；`/chat` 这一页从此跟 React 社区同步。
- 代价：**两套框架共存**（两套构建 + 两套 lint/文案门禁要一起管）、一个 runtime 适配层
  （我们的 seq/重放/审批要在那里自建）、`@vue-office` 那两个预览在 React 侧要换实现。

### 4.2 路线 B：全量迁 React（那份调研暗示的默认）

65,000 行 + 863 条测试 + 构建/部署/门禁/桌面壳全换。收益是单栈 + 生态；
代价是**数周到一个月**，而**其它页面的用户观感一点都不会变好**（笔记/知识库/设置这些
现在并不难看）。

**为什么不用 Next.js**：我们是登录后的局域网/桌面应用，没有 SEO 与首屏 SSR 的需求；
后端已经是 Python（Next 的 route handler / server action 会多出一层与 FastAPI 重复的
服务端概念），生产是 nginx 托管 SPA + 反代 `/api`，桌面壳直接 navigate 到 URL。
引入 Next 只会多一层 Node 运行时与一套新的路由/缓存心智——**买不到我们需要的任何东西**。

### 4.3 路线 C：继续 Vue，把 chat 页按 assistant-ui 的解剖学重排

不换栈，把 thread / message-parts / composer 三层骨架自己实现，配合既有的 Kimi 对照继续
逐处打磨。成本最低、风险最小（不新增技术栈、测试全留），但拿不到库本身——
**也就是现在这条路**，只是有了更明确的结构参照。

---

## 5. 建议与第一步

**建议 A 作为主线，但第一步不是重写，而是一个 2–3 天的验证件（spike）：**

> 做一个只跑本地的最小 React 页面，接**我们真实的 `/chat/stream`**，把 9 类事件喂进
> assistant-ui 的 runtime，跑通一条完整链路：**发一句 → 流式正文 → 工具步骤（含分组/图标）
> → 引用徽标 → 审批 → 交付物**，并用一条**现有真实会话**（例如那条做 PPT 的）做对照。
>
> 通过标准（三条，缺一条就退回 C）：① 过程面板与工具卡在 assistant-ui 的插槽里能表达出
> 现在我们这版的全部信息（分组、图标、展开、分页、理由与拒绝）；② 重连 + 审批 + 停止
> 在自建 runtime 里跑得通；③ 视觉上不比现在差（用同一套 CSS 变量）。
>
> 跑通的收益是：**后面 6,500 行的重写有了确定的落点**；跑不通的损失只有几天，
> 而不是先花几周重写再发现表达力不够。

**不进 A 的**：笔记/知识库/设置等页面继续留在 Vue（除非将来决定整体重做视觉，
那时再谈 B）；Next.js 不进；`schema.d.ts` 与契约门禁照旧共用。

---

## 6. 待决点（需要用户拍）

1. 走 A（chat 页单换 React）、B（全量）、还是 C（不换栈）；
2. 若走 A：是否接受**两套框架长期共存**（我建议按路由前缀切、样式共用 token）；
3. 若走 A：先做 §5 那个 spike（我建议做），还是直接开始重写 chat 页；
4. 路线定了之后的验收口径：以"同一套设计令牌下，跨对话/长任务/工具密集三种会话，
   观感不劣于现在"为准，还是另立一份对照图（Kimi 那三份文档可继续当参照）。

---

## 附：本报告的取证入口

- 前端规模与组件清单：`frontend/src`（`wc -l` 全量）、`frontend/package.json`、`frontend/vite.config.ts`；
- 协议面：`backend/app/api/v1/chat.py`（SSE 9 类事件）、`services/live_turns.py`（环形缓冲与补发）、
  `frontend/src/api/chat.ts`、`scripts/gen_api_types.py`；
- 抱怨史：`docs/计划与记录/开发计划-v0.1.md` §12.35–§12.228（25 条，本报告 §3.1 摘了 15 条）；
- 既有界面文档：`docs/调研/界面评审与改进计划-v0.2.md`、`Kimi-界面逐处对照-v0.1.md`、
  `UI-评估与优化方案-v0.1.md`、`docs/规范/前端设计规范-v0.14.md`；
- 外部事实：assistant-ui（GitHub README）、CopilotKit（docs 首页）、Vercel AI SDK（docs）、
  AG-UI（docs：16 类事件、传输无关、无重放语义）。
