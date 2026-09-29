# 工具调用 UI 对标调研 · 附：Coze Studio / WeKnora / MaxKB 证据索引 v0.1

> **这是《[工具调用 UI 对标调研 v0.1](工具调用UI-对标调研-v0.1.md)》的第二份附录**，装**事实与证据路径**，不重复结论。
> 结论与逐项取舍见主文档 **§4.1（WeKnora）/ §4.2（MaxKB）/ §4.3（含 Coze Studio 与本组横向）**。
> 原始调研报告曾落在 `docs/agent-toolcall-ui-benchmark.md`（不在五个子文件夹内），
> 按《项目工程规范》§2.3 收进本文；**逐行证据表已压缩为"事实 + 证据路径"**，其余未改。

**取数时点**：2026-09-29 ｜ **取数方式**：公开源码（`raw.githubusercontent.com` / GitHub Contents API / jsDelivr）+ 公开文档；无本地 clone、未运行产品
**证据级别**：`源码级` / `文档级` / `截图级` / `推断` / `未查到公开依据`

| 产品 | 版本 / commit | 栈 | 对话工具调用 UI |
| --- | --- | --- | --- |
| Coze Studio（字节） | v0.5.1 `72cecff8` | React + Rush | **存在但极简**：正文仅一行「using {插件名}」 |
| WeKnora（腾讯） | v0.8.2 `3e8b0bfc` | Vue3 + TDesign | **存在且最完整**：正文内联可折叠时间线 |
| MaxKB（1Panel） | v2.10.6-lts `9d6a5df3`（分支 v2） | Vue3 + Element Plus | **存在**：正文折叠卡 + 右侧「执行详情」面板 |

---

## 一、Coze Studio — 关键事实

- **位置与容器**：正文内作为独立一条消息渲染，**不是可折叠卡片、无外框底色**。`ContentBox` 判定 `message.type === 'function_call' && isSimpleFunctionEnable` → `<SimpleFunctionContent/>`；容器 `coz-fg-hglt select-none flex items-center max-w-[230px] text-xxl leading-[26px]`（**最大宽 230px**）。
- **单步**：仅 `IconCozLoading`（`animate-spin`）+ `copywriting?.using ?? 'using'` + 插件名（加粗、超长省略 + Tooltip）。组件全文约 66 行，**只读 `message.content`** ⇒ **running 与 done 无任何区别**。
- **分组聚合 / 展开折叠 / 动效**：**均不存在**（无 state、无 chevron、无 Collapse；唯一动画是 loading 图标）。
- **结果展示**：**正文完全不显示结果**。`ContentBox` 只认 TEXT/FILE/IMAGE/function_call/MIX，其余 `return <span>Not Support {message.content_type} Content</span>`；插件结果以 verbose 到达（`VerboseMsgType.STREAM_PLUGIN_FINISH`，字段 `tool_output_content`），而 verbose **不在白名单** `MESSAGE_TYPE_VALID_IN_TEXT_LIST`（仅 `answer` / `question` / `ack` / `task_manual_trigger`）⇒ 不进气泡。
- **异常态**：聊天区**无**失败/超时/被拒展示。协议层有中断（`isRequireInfoInterruptMessage` 读 `required_action?.submit_tool_outputs?.tool_calls`，`type==='require_info'`），但源码注释明写：*"tool_calls class behavior require_info interrupt is not rendered!!!"*。**无重试**。
- **推理**：独立插件包 `@coze-common/chat-area-plugin-reasoning`（注册名 `PluginName.Reasoning`），形态是 **Readonly 插件 + `TextMessageInnerTopSlot`**（推理与正文是同条消息的两个 slot，**不是独立折叠块**）。
- **架构事实（值得记）**：开源仓对话 UI 是**可插拔 SDK**（`@coze-common/chat-area` 状态/生命周期 + `@coze-common/chat-uikit` 渲染 + 一批 `chat-area-plugin-*`）。要补富展示，正确做法是**写 chat-area 插件**塞进 `TextMessageInnerTopSlot` / `MessageInnerBottomSlot`，或用 `IContentBoxProps.enhancedContentConfigList`（**支持带 `rule` 的自定义渲染器，源码已确认该字段存在**）⇒ **"插件调用不出现在正文气泡"是这个架构的默认结果，不是 bug**。

**证据路径（@v0.5.1）**：`frontend/packages/common/chat-area/chat-uikit/src/components/contents/simple-function-content/index.tsx`；`.../components/common/content-box/index.tsx`；`.../chat-uikit/src/constants/content-box.ts`；`.../chat-area/src/utils/verbose.ts`；`.../chat-area/src/plugin/constants/plugin-name.ts`；`.../chat-area-plugin-reasoning/src/{index.ts,plugin.ts}`；`rush.json`（包名↔路径对照）。

**未查到公开依据**：工具块聚合命名；长回合阈值；reasoning slot 的默认开合 / 动效 / 结束行为（`src/custom-components/*`、`src/services/life-cycle.ts`、`src/plugin.tsx` 均 404，Contents API 与 jsDelivr 因限流/体积超限失败）；`useStateWithLocalCache` 是否用于工具块。

---

## 二、WeKnora — 关键事实（含数值）

- **位置与容器**：助手消息**正文内、答案上方**；形态 **root summary + children tree 可折叠时间线**；**无外框底色**——`.action-card{background:transparent;border:0;box-shadow:none;display:flex;flex-direction:column}`，图标 `position:absolute;left:-42px` 挂左侧做轴标。
- **单步**：图标（按 `tool_name` 映射 TDesign 图标：`search_knowledge→data-search`、`web_search→internet`、`shell_exec→terminal`、`todo_write→task`、`call_mcp_tool→terminal`…）+ **自然语言标题**；参数不铺开而是"翻译"进标题——`getRagPipelineStepTitle()` 把 `knowledge_search` 渲染成「正在检索知识库：「{query}」」/「检索知识库：「{query}」」（query 取自 `arguments.query|queries`，见 `getQueryText()`）。running 走 **1.5s 线性扫光** shimmer（`.action-pending .action-name{chat-stream-shimmer-text()}`），done 恢复纯灰字。**耗时未查到展示**。
- **分组聚合**：整轮合并成一棵树（`tree-root` 摘要行 + `tree-children` 步骤）；`intermediateStepsCount` 是**折叠判定的输入之一**（测试以 `intermediateStepsCount:{value:2}` 构造用例）⇒ **步骤数参与"要不要折叠"决策**；聚合文案**未查到**（`AgentStreamDisplay.vue` 151KB 被截断）。
- **默认开合**：折叠根摘要 `showIntermediateSteps ? 'chevron-down' : 'chevron-right'`；折叠态由 `shouldShowCollapsedSteps` 计算，输入是 `isSegmentDone` / `isConversationDone`；单步内还有独立开合 `isEventExpanded(event.event_id)`。**进入页面初值未查到**。
- **自动时机（本组最有价值的一条）**：断言 **`isSegmentDone===true` 且 `isConversationDone===false` ⇒ `shouldShowCollapsedSteps===false`** ⇒ **流式中（含 steer 分段未整轮结束）不折叠，整轮真正结束才折叠**。另有断言 *"streaming log renders reasoning alongside tool calls"*、*"streaming tool log uses the same timeline structure"*、`streaming-loading-node` / `tree-child-last` 动态、结束后 `t('common.finish')` 收尾行。**是否自动滚到最后一步未查到**。
- **持久化（源码级反证）**：`preferenceStorage.ts` 的 key 白名单**只有 4 项**（`theme` / `font_sans` / `font_mono` / `font_size`，`WeKnora_${userId}_${suffix}`）⇒ **工具块开合态不在持久化范围**。「全部展开/收起」未查到。
- **结果展示**：**不是一坨 JSON，而是按类型分派到 20+ 专用渲染器**（`ToolResultRenderer.vue` 的 `displayType`）：`search_results` / `chunk_detail` / `related_chunks` / `knowledge_base_list` / `document_info` / `graph_query_results` / `plan` / `database_query` / `web_search_results` / `web_fetch_results` / `grep_results` / `knowledge_chunks_list` / `wiki_*` / `shell_exec` / `list_sandbox_files` / `write_sandbox_file` / `read_skill` / `mcp_discovery` / `mcp_call`。
  **截断硬值**：fallback 原文 `max-height:400px`；MCP schema `<pre>` **320px**；MCP 参数描述展开后 **240px**、折叠 `-webkit-line-clamp:2`；审批参数预览 **160px**。
  **全文入口**：MCP 用原生 `<details><summary>完整参数定义</summary>`。JSON→等宽 `<pre>`；表格→`DatabaseQuery`/`GraphQueryResults`/`GrepResults`；图片→`max-height:360px;object-fit:contain`+预览；文件→`ArtifactFileIcon`/artifacts 面板。
- **推理（两套并存）**：① `deepThink.vue` 独立卡——**默认展开**（`isFold=ref(false)`）；`onMounted` 若 `thinking===false`（历史回放）则折叠；`watch(thinking)` 在 `true→false`（流式结束）**自动折叠**；**思考中禁止手动折叠**（`toggleFold()` 里 `if(!thinking)`）；内容 `max-height:200px` 自动滚底；`transition: all 0.25s cubic-bezier(0.4,0.2,0,1)`（原文如此）。② 内联推理——测试锁死 *"expanded model reasoning stays inline without a separate thinking title"*、`class="thinking-inline-content markdown-content"`、且**必须不出现**独立 thinking 标题（`doesNotMatch`）；推理与工具调用**共用同一条时间线**。
- **异常态（三家最细）**：
  - **人工审核** `ToolApprovalCard.vue`：「等待审核 · {service} › {tool}」→「人工审核 · …」；参数**就地可编辑**（JSON 校验：非法=红字「参数不是合法 JSON」，改过=黄字「已修改」）；按钮「通过并执行 / 拒绝」；**倒计时**默认 **600s**、**≤120s 变 warning**、**≤30s 变 error**，支持 `m:ss`；状态 `已通过`/`已拒绝`/`等待审核`。
  - **OAuth** `McpOAuthCard.vue`：`等待授权 · {target}` / `去授权` / `跳过` / `已授权` / `授权超时` / `已取消` / `恢复执行失败，请重试`。
  - **工具失败** `McpToolResult.vue`：`success===false` → `<div class="mcp-error" role="alert">` + error-circle + `<pre>` 原文，用 `--td-error-color`。
  - **沙箱**：`shellExec.killed:'已超时终止'`、`truncated:'输出已截断'`。**统一重试按钮未查到**，但 OAuth 有「恢复执行」。
- **动效（两套）**：① 结果卡 `max-height:0;opacity:0` → `.expanded{max-height:2000px;opacity:1;padding:12px}`，`transition: max-height 0.2s ease, opacity 0.2s ease, padding 0.2s ease`（`@transition-time:0.2s`）；chevron `rotate(180deg)` + `transition: transform var(--app-motion-fast) ease`。② 深思考卡 `transition: all 0.25s cubic-bezier(...)`。**另有 `prefers-reduced-motion: reduce` 关闭 shimmer 的无障碍降级**。`--app-motion-fast/base` 具体毫秒值未在已读文件中定义。
- **人话摘要（三家最彻底）**：`agentStream.toolStatus` / `ragPipeline` / `tools`——「正在调用 {name}...」「调用 {name}」「检索知识库」「正在检索知识库：「{query}」」「检索知识库和网络」「网络搜索」「搜索关键词」「完成思考」「正在查看图片内容...」「正在解析附件...」「正在理解问题...」「正在执行沙箱命令...」「更新任务列表」。
  **结果阶段也人话化**：`getKnowledgeSearchSummaryHtml()` → 「找到 {count} 个结果，来自 {files} 个文件」/「找到 {count} 个结果（{docCount} 篇文档，{webCount} 条网页）」/「找到 {count} 条网页」/「命中 {count} 条候选，相关性不足，未用于回答」——源码注释点明设计意图：*"the difference is what tells you to look at the threshold instead of the knowledge base"*。

**证据路径（@v0.8.2）**：`frontend/src/views/chat/components/AgentStreamDisplay.vue`（151KB，未全文读取）与其测试 `AgentStreamDisplay.style.test.mjs`（8.4KB，用 `vm.runInNewContext` 直接抽取源码代码块求值 ⇒ 断言等同源码事实）；`agent-interaction-card.less`；`frontend/src/components/css/chat-timeline-loading.less`；`tool-results/tool-results.less`；`tool-results/McpToolResult.vue`；`tool-results/ThinkingDisplay.vue`；`ToolResultRenderer.vue`；`ToolApprovalCard.vue`；`BrowserToolDetails.vue`；`deepThink.vue`；`frontend/src/utils/agent-tool-display.ts`、`agent-tool-icons.ts`；`i18n/locales/zh-CN.ts`（已读 1521–1729 行 agentStream 段）；`composables/preferenceStorage.ts`；`utils/steerStreamFork.ts`。

**未查到公开依据**：聚合文案；`AgentStreamDisplay.vue` 模板全文（151KB 被截断，`views/chat/index.vue` 90KB 同）；折叠初值；自动滚动；是否展示耗时；`--app-motion-fast/base` 毫秒值；`chat.thinking` / `chat.deepThoughtCompleted` 文案。

---

## 三、MaxKB — 关键事实（含数值）

- **位置与容器（双轨，都不在浮动层）**：① 正文内联卡 `el-card shadow="never" class="layout-bg mt-8"`（`--el-card-padding: 8px 12px`，**有边框+底色**）；② 右侧 `.execution-detail-panel` 白底，`width: var(--execution-detail-panel-width, 400px)`（展开 400 / 收起 0）+ `transition: width 0.4s`；`executionIsRightPanel` 为 false 时退化成 `el-dialog`。
- **单步**：① 内联卡头 = **插件图标**（`toolCallsContent.icon`，无则默认 `ToolIcon`）+ **标题**（`title`，取不到显示 `-`）+ 右侧 `ArrowDown`；展开仅「输入参数：{content.input}」「输出参数：{content.output}」（output 包 `<pre>`）。② 步骤卡头 = **节点图标（按 `data.type` 映射）+ 节点名 `data.name`** + **tokens**（仅 Question/AiChat/ImageUnderstand/ImageGenerate/Application/Intent/VideoUnderstand 显示 `message_tokens + answer_tokens`）+ **耗时 `data.run_time.toFixed(2)} s`**（`status≠202` 时）+ **状态图标**：`200→CircleCheck`(绿) / `202→Loading`(转) / 其它→`CircleClose`(红)。**running 与 done 靠状态图标 + tokens/耗时是否出现区分，无行内文案差异**。
- **分组聚合**：**不合并**——正文每个 `<tool_calls_render>` 一张独立卡（`parseByPlugin()` 按标签切分，`TAG_PLUGINS` 注册）；面板里每节点一张卡，**按 `index` 排序**（`arraySort(props.detail ?? [], 'index')`）。**无「N 个工具」计数行**。循环节点用 `el-radio-button` 切轮次；工作流节点（`ToolWorkflowLib`）卡内**递归**渲染子 `ExecutionDetailCard`。
- **默认开合**：① 正文内联卡**默认折叠**（`showContent = ref(false)`）；② 步骤卡**默认折叠**（`data['show']` 由点击 toggle，初始未置 true）；③ 推理卡**默认展开**（`showThink = ref(true)`）。**无任何"超过 N 条就折叠"阈值**。
- **自动时机**：**没有自动展开/折叠**——三处纯点击，**未查到** watch 自动开合的代码（对比 WeKnora `deepThink.vue` 有显式 watch）。**流式期间是另一块 UI**：`AnswerContent` 里当 `!write_ed && progress && 最后一条` 显示一行进度卡 `{{ t('aiChat.executing') }} {{ currentChunk.node_name }}`（带节点图标）——**这是流式期间唯一的工具可见性**，答案逐字吐。自动滚动：`handleScroll()`「仅用户已在底部附近（**≤40px**）才自动滚到底」，另有 `isBottom` 触发的「置底」按钮。
- **持久化（源码级反证）**：`data['show']` 直接写在接口返回的 `execution_details` 上（`cloneDeep(res.data.execution_details)`），**刷新重取即丢**，未见写 localStorage / 后端偏好。「全部展开/收起」未查到。（v2 会存 `${accessToken}userForm`，但那是**表单**不是工具块。）
- **结果展示**：① 内联卡 `{content.output}` 直接 `<pre>`，**无截断阈值、无全文入口**。② 面板按节点类型分派：工具库（ToolLib/ToolLibCustom）显「输入 `data.params` / 输出 `data.result`」`break-all`；MCP 节点显工具名 `data.mcp_tool` + 参数表 `data.tool_params` + 输出 `data.result`；知识库检索/Reranker 用 `ParagraphCard`（本体未读）。**长内容内滚值**：多处 `el-scrollbar height="200"`（文档分段/知识库写入/网页站点/变量聚合），指定回复 **150**，文档内容提取 **200**。图片 `el-image` **40×40** 缩略 + `preview-src-list`（zoom-rate 1.2）；音频 `<audio controls>`；视频 `<video controls>`；文件按扩展名 `getImgUrl(name)` 出图标。
- **推理**：**独立卡且在正文最上方**——`MdRenderer` 第一行即 `<ReasoningRander v-if="reasoning_content?.trim()" .../>` ⇒ 推理**永远排在正文之前**；`el-card shadow="never"`，头 = 推理图标 + `$t('workflow.nodes.aiChatNode.think')`（"思考"）+ `ArrowDown`；**默认展开**；体是 `MdPreview`，文字色压成 `--app-input-color-placeholder` 弱化；**结束后不自动折叠**（无 watch）。执行详情里 AiChat 节点另把 `data.reasoning_content` 显成「思考」一节 ⇒ reasoning 是**每节点**字段。
- **异常态**：① 步骤卡 `status` 非 200/202 → **红 `CircleClose`**，展开区 `<template v-else>` 显示「错误信息」`data.err_message`。② 面板汇总 `errStepMsg = detail.find(item => item.status===500)` → 渲染「错误日志」`${err_step.step_type}: ${err_step.err_message}`。③ 回答失败 `errorWrite()` 置 500 并追加 `aiChat.tip.error500Message`；HTTP 460/461 → `errorIdentifyMessage` / `errorLimitMessage`。④ 用户停止 `is_stop` → 正文显 `aiChat.tip.stopAnswer`。**工具级重试未查到**（「重新生成」属回答级 `OperationButton`）。
- **长回合**：**会话级分页** `paginationConfig{current_page, page_size:20}`，滚到顶（`scrollTop===0` 且 total>已加载）加载下一页并**保持滚动位置**（记 `history_height` 再回填）。**工具块本身无虚拟化**，长输出靠 `el-scrollbar height="200"` 内滚。
- **动效**：**统一用 Element Plus `el-collapse-transition`**（高度动画，**默认约 0.3s，属组件库内置、未在本仓源码读到**），共 3 处：正文工具卡、步骤卡、推理卡；箭头用 `.rotate-180` / `.rotate-90` class。右侧面板 `transition: width 0.4s`。
- **人话摘要（部分）**：流式期间一行「正在执行 {节点名}」（`aiChat.executing` + `currentChunk.node_name`）；内联卡标题由后端下发的 `title`（JSON 结构 `{type,icon,title,content}`，**生成逻辑在 Python 侧，本次未取数**）。**完成态人话未查到**。

**值得单独提的设计**：正文工具卡是 **Markdown 标签协议驱动**——`MdRenderer` 渲染前用 `parseByPlugin()` 把 `<tool_calls_render>…</tool_calls_render>`（另注册 `quick_question` / `html_rander` / `iframe_render` / `echarts_rander` / `form_rander`，其中 `form_rander` 支持嵌套解析）切出来换成 Vue 组件，其余交 `MdPreview` ⇒ **工具卡可出现在回答文本任意位置**，不固定在开头。且 `ToolCalls` 接口 `{type,icon?,title,content}` 用 `kw[content.type]` 做**策略映射**，目前只注册 `'simple-tool-calls'` ⇒ **三家最易扩展的设计**。同一套 `ExecutionDetailContent` 被三处复用（右侧面板 / `el-dialog` / `type='log'` 日志页）。

**证据路径（@v2.10.6-lts）**：`ui/src/views/chat/pc/index.vue`；`ui/src/components/ai-chat/index.vue`；`.../answer-content/index.vue`；`.../knowledge-source-component/{index.vue,ExecutionDetailContent.vue}`；`ui/src/components/execution-detail-card/index.vue`；`ui/src/components/markdown/MdRenderer.vue`；`markdown/tool-calls-render/{index.vue,index.ts,content/index.vue,content/simple-tool-calls/index.vue}`；`markdown/ReasoningRander.vue`。

**未查到公开依据**：工具块开合是否持久化；「全部展开/收起」；`el-collapse-transition` 默认时长数值；`ParagraphCard` 本体；内联卡 `title` 的生成逻辑（在 Python 侧）；工具级重试。

---

## 四、三家横向速查

| 维度 | Coze Studio | WeKnora | MaxKB |
| --- | --- | --- | --- |
| 容器 | 正文一行，无框无底 | 正文时间线，无框无底 | 正文折叠卡（有框有底）+ 右侧 400px 面板 |
| 单步 | 图标 + "using" + 插件名 | 图标 + 自然语言标题（含 query 翻译） | 标题 + 输入/输出纯文本；面板内 + tokens + 秒 + 状态图标 |
| 入参 | ❌ | 折叠进标题（query 类） | ✅ 原文 |
| 结果 | ❌ 正文完全不显示 | ✅ 20+ 专用渲染器 + 分类型截断 | ✅ 原文 + `el-scrollbar` 内滚 |
| 耗时 | ❌ | 未查到 | ✅ `run_time` 秒 |
| 聚合 | ❌ 每次一行 | ✅ 整轮一棵树，步骤数参与折叠判定 | ❌ 每节点一张卡 |
| 默认开合 | 不适用 | 流式中展开、整轮结束才折叠 | 工具卡折叠、推理卡展开 |
| 自动折叠 | 不适用 | ✅ 有（**测试锁定语义**） | ❌ 纯手动 |
| reasoning | 独立 plugin + 消息内 slot（细节未取到） | ✅ 两套：独立卡（自动折叠）+ 内联时间线 | ✅ 独立卡置顶，默认展开、不自动折叠 |
| 失败态 | ❌（源码注释明说不渲染中断） | ✅ 审核 / OAuth / 失败 / 超时四种 | ✅ 红图标 + 「错误信息」节 |
| 重试 | ❌ | OAuth 有「恢复执行」 | 未查到 |
| 动效 | 无 | `max-height 0.2s ease` + `all 0.25s cubic-bezier` | `el-collapse-transition` + `width 0.4s` |
| 人话摘要 | 仅"进行时"一句 | ✅ 最彻底（进行时 + 完成态 + **结果统计**） | 仅「正在执行 {节点名}」 |
| 长回合 | 未查到 | 未查到（仅单结果内滚） | 会话级 20 条/页 |

---

## 五、取数受限点（如实标注）

1. **WeKnora `AgentStreamDisplay.vue`（151,578B）与 `views/chat/index.vue`（90,905B）**：`raw` 拉取一律在 ~50KB 截断 ⇒ 模板全文 / 折叠初值 / 聚合文案 / 自动滚动 / 耗时字段只能用其 8.4KB 配套测试 `AgentStreamDisplay.style.test.mjs` 反推；该测试用 `vm.runInNewContext` 直接抽取源码中 `shouldShowCollapsedSteps` / `isSegmentDone` / `isConversationDone` 代码块求值，**断言等同源码事实**，故仍记 `源码级`。
2. **Coze 的 reasoning slot 组件源码路径未定位成功**：`src/custom-components/*`、`src/services/life-cycle.ts`、`src/plugin.tsx` 均 404；Contents API 与 jsDelivr 因限流 / 体积超限失败 ⇒ 其默认开合、动效、结束行为**未查到**。
3. 调研期间本机 shell（PowerShell）被沙箱拒绝（`sandbox-local windows-acl temp grant materialization failed`）、子代理因 `maxDepth 1` 不可用 ⇒ **无法本地 clone**，全部工作为 `web_fetch`。
