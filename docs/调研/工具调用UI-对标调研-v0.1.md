# 工具调用 UI 对标调研 v0.1

- **动机**：用户明确表示「工具调用这一块的 UI（含自动展开折叠）我们做得不好」，要求与主流 Agent 产品做 diff 调研
- **范围**：**只对标"工具调用块"这一个面**——位置与容器、单步行结构、分组聚合、默认展开折叠、自动展开折叠时机、用户覆盖与持久化、结果展示、思考/推理、异常态、长回合、动效、人话摘要（12 个维度）
- **取数时点**：2026-09-29
- **配套文档**：《[对话 UI 显示逻辑与动效 · 全量审计 v0.1](对话UI-显示逻辑与动效-全量审计-v0.1.md)》（本文 §1 的现状部分以它为准，不重复取证）
- **证据级别**：`源码级`（读到实际源码）/ `产物级` / `文档级`（官方文档）/ `截图级` / `第三方描述` / `推断`

---

## 1. 我们的现状（基线，全部源码级）

### 1.1 结构

`TracePanel` 挂在助手消息里、**位于正文上方**、与正文同列（66ch），是**裸列表不是卡片**（无外框、无底色、无圆角）：

```
[⌄]                        ← 面板头（同时是开合开关）：无出处时只剩这一枚箭头
  ▣ 读技能 2 次 ⌄
  ▣ 联网搜索 18 次 ⌄
  ▣ 抓取网页 3 次 ⌄
  ▣ 导出幻灯 ⌄
      已生成「今日国内新闻速览-2026-09-29.pptx」（40 KB）
      思考 3,329 字 ⌄
  ✓ 组织回答
      共 714 字
```

（上面这棵树的形状与用户提供的截图逐行一致，可由 `turns.ts` + `TracePanel.tsx` 的分组与开合规则完全推出。）

### 1.2 十二维度的现状

| 维度 | 现状 |
| --- | --- |
| 1 位置与容器 | 正文**上方**、同列、裸列表（无卡片容器） |
| 2 单步行结构 | 21px 圆底图标（按语义 kind 上色）+ 标签（12px）+ 结论行（12px 三级灰）+ 箭头。**没有状态图标、没有耗时、没有 token** |
| 3 分组聚合 | 同一"块"内同类工具合并成一行 + `{n} 次`；只有一次的不并 |
| 4 默认展开折叠 | 面板**展开**（全局记忆）；组**收起**；单步**收起**（被拦下/等确认的**展开**）；单步自己的思考**跟流式状态**；整轮思考兜底**收起** |
| 5 自动展开折叠 | **只有一处**：单步的思考在流式时摊开、**答完自动收起**。**面板本身答完不收起**；失败不自动展开；新步骤不自动滚动 |
| 6 用户覆盖与持久化 | 面板级记住（localStorage `kylab-trace-open` + 本轮 override）；组级、单步级**都不记住**；**没有"全部展开/收起"**；**单步开合跨轮次串号（真 bug）** |
| 7 结果展示 | 返回默认只给 600 字 + 「仅预览 X / Y 字」+「加载全部」；入参数不截断（后端已裁 2000 字）；`art_*` 缀文件名 |
| 8 思考/推理 | 每步自带 `thinking`（默认跟流式）；老消息整轮一串时兜底成**默认收起**的「思考过程」块 |
| 9 异常态 | 失败/被拒/等待确认**都靠 `status: done` + `outcome`** 区分；被拦下的行默认展开；有 `ApprovalBar` 但**不在面板里** |
| 10 长回合 | 20 条目/页 + 「当前已显示 X / Y 条工具调用」+「加载更多」 |
| 11 动效 | 箭头 150ms 旋转；**展开收起本身零动画**（条件渲染）；**全对话域没有 spinner** |
| 12 人话摘要 | 面板头在流式时给一行实时文案（「正在{label}…」/ 思考尾巴）——**这是全 UI 唯一的"人话"**，且只在流式期间存在 |

### 1.3 已确认的六个问题

1. **面板默认展开 + 位于正文上方** ⇒ 长任务时过程把答案推到首屏之外（用户必须先滚过一屏「联网搜索 18 次」才读到答案）。走查报告 §五 第 3 条早已记录同一现象。
2. **组级默认收起 ⇒ 第一眼零信息**：看到「联网搜索 18 次」，但搜到了什么、耗时多久一个字都没有；而同一面板里 `导出幻灯`、`组织回答` 这类单步却**直接铺出结论**——同一块里两种密度。
3. **面板头在无出处时只剩一枚孤立箭头**（截图最上面那个 `^`），看起来像残留符号。
4. **running 与 done 行内零差别**：`TraceStep` **没有 `status` 字段**，全对话域**没有 spinner**；唯一的"还在跑"信号是最上面那行实时文案。
5. **没有耗时、没有 token 数**：面板里没有任何计时/计数代码。
6. **没有"全部展开/收起"**；组级/单步级开合都不持久化；**且单步开合跨轮次串号**。

---

## 2. 基座对照：我们**已经在用、却一点没用上**的 assistant-ui 能力（源码级）

这是本次调研**最可行动的一条**，因为它不需要换栈、不需要换库——`@assistant-ui/react 0.15.21`（我们已固定并用着）本身就把"好用的工具调用块"整套实现了。

### 2.1 库里的 `ToolFallback`（`templates/minimal/components/assistant-ui/elements/tool-fallback.aui.tsx`）

| 能力 | 库的做法 | 我们的现状 | 差距判定 |
| --- | --- | --- | --- |
| **状态图标** | `statusIconMap = { running: LoaderIcon, complete: CheckIcon, incomplete: XCircleIcon, 'requires-action': AlertCircleIcon }` | 只有"按 kind 上色"的语义图标，**没有状态维度** | **缺** |
| **running 的动感** | 图标 `animate-spin [animation-duration:0.6s]`；标签加 `shimmer`，**两处都带 `motion-reduce:`** | 无 spinner、无 shimmer | **缺**（且我们连 reduced-motion 都没做） |
| **耗时** | `ToolFallbackDuration` → `useToolCallElapsed()`，格式 `<1s` / `1.2s`（<10s 一位小数）/ `12s` / `1m 5s` | **完全没有** | **缺** |
| **展开动画** | `Collapsible` + `animate-collapsible-up/down`，**200ms**，缓动 `cubic-bezier(0.32,0.72,0,1)`；内层再加 `fade + blur-[2px] + slide-in-from-top-1`；**两处都带 `motion-reduce:animate-none`** | 条件渲染，**零动画** | **缺** |
| **滚动锁** | `useScrollLock(ref, 200)`——展开时锁住外层滚动，避免"展开把页面顶走" | 无 | **缺**（这正是"展开过程面板后答案被推走"的手感来源） |
| **箭头** | `-rotate-90 → rotate-0`，`transition-transform duration-(--animation-duration)` + **`motion-reduce:transition-none`** | `rotate-180`，150ms（方向相反） | 有，但方向与时长口径不同 |
| **需人工介入时自动展开** | 文档明写：`ToolFallbackRoot` — **"Opens automatically on `requires-action`"** | 我们靠 `outcome` 让"被拦下/等确认"的行默认展开（思路一致） | **思路一致，粒度不同**（他们整卡展开，我们那一行展开） |
| **错误渲染** | `ToolFallbackError` 仅在 `status.type === "incomplete"` 且带 error 时渲染 | 我们靠 `outcome` + 词表兜底 | 思路一致 |
| **取消态** | `incomplete + reason === "cancelled"` → 标签变 `Cancelled tool` 且 **`line-through`** | 无取消态样式 | **缺** |
| **审批** | `ToolFallbackApproval` 是卡片内的按钮组，带 `options`/`grants`/`confirm` 与自由文本；`grants` 会先把"将要持久化的规则"显示给用户 | 我们的 `ApprovalBar` 在输入框上沿、不在工具卡里（这是**有意的**，见 `ApprovalBar.tsx` 头注） | 取舍不同 |

### 2.2 库里的 `ToolGroup`（`packages/ui/.../elements/tool-group.tsx`）

| 能力 | 库的做法 | 我们的现状 |
| --- | --- | --- |
| 组头 | 箭头（`rotate-90`，200ms，带 reduced-motion）+ 标签 + **状态计数** + 尾部状态图标 | 标签 + `{n} 次` + 箭头，**没有状态计数、没有尾部图标** |
| 状态计数文案 | 有在跑 → **`{done}/{total}`**；有失败 → **`{failed} failed`**；全好 → **`{total} done`** | 只有 `{n} 次`（静态，不含状态） |
| 组头图标 | 在跑 → `Loader2` 转；失败 → 红 X；完成 → 绿勾 | 无 |
| 行内单项 | 状态图标 + 工具名（mono）+ **`target`（人话主体，如 URL/文件名）** + **`durationMs`** | 图标 + 标签 + 结论行；**没有 target 与耗时**（我们有 `detail`，语义接近 target） |
| 数据模型 | `GroupedTool = { id, name, target, state: 'running'\|'done'\|'failed', durationMs? }` | `TraceStep` **没有 state、没有 duration** |
| 容器 | `paper` + `rounded-2xl` + **`max-w-sm`**（一张卡，不是满宽裸列表） | 满宽裸列表 |
| 展开 | `open &&` 条件渲染 + `animate-in fade-in slide-in-from-top-1 duration-200` | 条件渲染，无动画 |

### 2.3 官方分组机制（我们完全没用）

- `MessagePrimitive.GroupedParts` + `groupPartByType({ "tool-call": ["group-tool"], reasoning: [...] })` 是官方推荐的"把连续工具调用收成一组"的做法，`Thread` 默认就接好了。
- `ToolCallMessagePart` 自带 `timing: { startedAt, completedAt? }`（**外部 store 也可通过 `ThreadMessageLike` 传**），并有 `unstable_useMessageStallDetection({thresholdMs})` 用来报告"跑一半不吐字了"。
- `useToolCallElapsed()` **在我们的 0.15.21 里就有**（`node_modules/@assistant-ui/react/dist/hooks/useToolCallElapsed.js`），不是要升级才有的新 API。

### 2.4 **但它在我们的架构里不可达**（这条决定了落地路径）

`useToolCallElapsed()` 读的是 `useAuiState(s => s.optional.part)`（`useToolCallElapsed.js:53-56`）——**必须有 message part 作用域**。

而我们的 `ChatRuntime.tsx:48-54` 把每条消息压成了：

```ts
function convertMessage(message: ChatMessage): ThreadMessageLike {
  return { id: message.id, role: message.role, content: [{ type: 'text', text: message.text }] }
}
```

**一个 `tool-call` part 都没有**。`ChatThread.tsx:14-17` 也明说：消息列表按我们自己的数组遍历，不走 `MessagePrimitive.Messages`。

⇒ **两条路**：

| 路径 | 做法 | 代价 | 建议 |
| --- | --- | --- | --- |
| **A. 接入 part 体系** | 让 `convertMessage` 产出真实 `tool-call` part，消息渲染改用 `MessagePrimitive.Parts` / `GroupedParts`，工具卡换成 `ToolFallback` | 大：把"过程/出处/交付物属于我们自己的字段"重新塞回 assistant-ui 的结构，正是 `ChatRuntime.tsx` 头注刻意避开的耦合；且我们自己的 `steps` 模型要重写成 part | ✗ 不建议 |
| **B. 只抄做法，不动架构** | 在现有 `TraceStep` / `TracePanel` 上补：状态图标与 spinner、耗时、组头状态计数、展开高度动画 + reduced-motion、`全部展开/收起`、默认折叠策略 | 小：全部落在 `traceStyles.ts` / `TraceStepRow.tsx` / `TracePanel.tsx` / `turns.ts` 四个文件里 | ✓ **建议** |

**结论：定级为"照抄做法"，不定级为"接入库"**——库的价值在于它把"一个工具调用块该有哪些状态与信息"定义清楚了（`{state, target, durationMs}` 三元组 + 组头计数 + 需介入时自动展开），而不在于非得用它那几个组件。

---

## 3. 差异框架（12 维度）

后文各产品对照统一按这 12 个维度：

| # | 维度 |
| --- | --- |
| 1 | 位置与容器（正文上/下/侧栏；卡片 or 裸列表） |
| 2 | 单步行结构（图标/名称/参数/结果/耗时/状态） |
| 3 | 分组聚合（是否合并、标题、计数口径） |
| 4 | 默认展开折叠（面板/组/单步各级） |
| 5 | 自动展开折叠时机（流式中、完成后、失败时、自动滚动） |
| 6 | 用户覆盖与持久化（记住范围、全部展开/收起） |
| 7 | 结果展示（截断阈值、全文入口、各类内容渲染） |
| 8 | 思考/推理（独立 or 并入、默认开合、答完是否自动收起） |
| 9 | 异常态（失败/被拒/待批准、重试入口） |
| 10 | 长回合（分页/虚拟化阈值） |
| 11 | 动效（高度动画、时长缓动、reduced-motion） |
| 12 | 人话摘要（是否把调用翻译成人话、写在哪一行） |

---

## 4. 逐家产品对照

> **本节状态：五路取数已全部完成**（2026-09-29）。共 **12 个样本 + 1 个基座**：
> ① Cline / Roo Code（源码级）② Cherry Studio / LobeHub（源码级）③ Coze Studio / WeKnora / MaxKB（源码级 + 证据附录）
> ④ Qwen Code / Kimi CLI / OpenHands（源码级 + 独立文档）⑤ Trae / Qoder / 通义灵码 / CodeBuddy（**闭源**，证据附录）
> + **assistant-ui 0.15.21**（我们已装的基座，源码级）。
>
> ⚠️ ⑤ 的四家**闭源**，"源码级对照"在它们身上不成立——本调研对它们只给 `文档级` / `官方论坛回复级` / `截图级` 证据，**不当作实现依据**。
> 另有两处样本本身要打折：**Kimi CLI（Python）已归档**（仓库只读）、**OpenHands 该仓库现在只是前端**（后端在 `software-agent-sdk`）。

### 4.1 WeKnora（腾讯开源，v0.8.2）— 源码级

> **含数值的证据索引见附录**《[Coze Studio / WeKnora / MaxKB 证据索引](工具调用UI-对标调研-附-Coze-WeKnora-MaxKB证据-v0.1.md)》（截断硬值 400/320/240/160px、20+ 渲染器清单、`ToolApprovalCard` 倒计时三档 600/≤120/≤30s 等）。

**一句话定位**：把工具调用做成**正文里的一条时间线**，折叠态只留一行 root summary，展开才是树状子步骤。

| # | 维度 | 做法 | 对我们的意义 |
| --- | --- | --- | --- |
| 1 | 位置与容器 | 正文内的时间线；**折叠态只留一行 root summary + chevron** | ✅ **正是我们 P0 想要的方向**（我们无出处时只剩一枚箭头，且默认整个摊开） |
| 2 | 单步行结构 | **纯文本行**：18px 图标 + 13/14px 名称/摘要；`.action-card{background:transparent;border:0}`（无边框无底色，与我们的裸列表同取向） | 与我们一致 ✓（但我们缺状态与耗时） |
| 3 | 分组聚合 | 树状子步骤（`tree-root-summary` / `tree-child`，配 `shouldShowCollapsedSteps`） | 比我们的"扁平合并 + N 次"多了**层级** |
| 4 | 默认展开折叠 | 折叠态 = 一行摘要（见 #1） | ✅ 我们相反 |
| 5 | 自动展开折叠 | — | — |
| 6 | 用户覆盖与持久化 | `max-height 0→2000px + opacity`，**0.2s ease**（`tool-results.less`） | ✅ 我们**零动画** |
| 2/11 | running 态 | **1.5s 线性 shimmer 扫光**（`chat-timeline-loading.less`） | ✅ 我们**没有 shimmer、没有 spinner** |
| 8 | 思考/推理 | **两套实现**：① `deepThink.vue` 独立卡片，**默认展开**，`thinking=false` 时自动折叠，`transition all .25s cubic-bezier`；② `AgentStreamDisplay` 里的 `thinking-inline-content` **内联在时间线里、无独立标题** | 比我们多一档"独立卡片"形态；我们只有"每步内联 + 整轮兜底" |
| 9 | 异常态 | **三个专门组件**：`ToolApprovalCard`（人工审核，**带倒计时 / 改参数 / 拒绝**）、`McpOAuthCard`（OAuth 授权）、`McpToolResult`（错误以 red 展示） | ✅ 明显强于我们：被拒/等待确认在我们这里**只有"默认展开"这一条线索**，且审批条在输入框上沿、不在工具块里 |
| 7 | 结果展示 | **20+ 个专用渲染器**（表格 / 图片 / 文件 / 沙箱 / 数据库 / shell…）；fallback 原文 `max-height:400px` 可滚 | ✅ 我们**全部是纯文本 `<pre>`**；阈值也不同（我们 220px + 600 字预览） |
| 12 | 人话摘要 | **全部自然语言化**：`toolStatus.calling: '正在调用 {name}...'`、`ragPipeline.searchingWithQuery: '正在检索知识库：「{query}」'` | 与我们一致 ✓（我们也只有流式期间那一行），但他们**常驻**、我们是"无出处就只剩箭头" |

### 4.2 MaxKB（1Panel 开源，v2.10.6-lts）— 源码级

> **含数值的证据索引见附录**《[Coze Studio / WeKnora / MaxKB 证据索引](工具调用UI-对标调研-附-Coze-WeKnora-MaxKB证据-v0.1.md)》（节点卡的 tokens + `run_time` 秒 + 三态图标、`el-scrollbar` 内滚值 200/150、Markdown 标签协议 `<tool_calls_render>` 与 `kw[type]` 策略映射等）。

**一句话定位**：**双轨**——正文里是默认折叠的内联卡，右下角另有可滑出的「执行详情」面板。

| # | 维度 | 做法 | 对我们的意义 |
| --- | --- | --- | --- |
| 1 | 位置与容器 | ① 正文内联卡 `tool_calls_render`（Markdown 标签插件，`ui/src/components/markdown/tool-calls-render/index.vue`）：`el-card` + 箭头；② **右下侧滑「执行详情」面板**（`ui/src/views/chat/pc/index.vue`，`width 0→400px`、`transition width .4s`），每个节点一张 `ExecutionDetailCard` | ✅ **双轨分离**是我们完全没有的：细节进侧栏，正文只留卡 |
| 4 | 默认展开折叠 | 内联卡 **默认折叠**（`showContent = ref(false)`）；节点卡也**默认折叠**（`data.show`） | ✅ 我们默认整面板展开 |
| 11 | 动效 | `el-collapse-transition`（两处） | ✅ 我们零动画 |
| 2 | 单步行结构 | 节点卡头部 = **节点名 + token 数 + 耗时（秒）+ 状态图标**（200 成功 / 202 loading / 其它失败） | ✅ **一条就够**：我们连 `status` 都没有，更没有 token 与耗时 |
| 7 | 结果展示 | 内联卡展开只有「输入参数 / 输出参数」两块纯文本；工具库节点显示输入/输出，**MCP 节点显示 `mcp_tool` + `tool_params` + `result`** | 我们不分节点类型 |
| 8 | 思考/推理 | `ReasoningRander.vue` **独立卡片但默认展开**（`showThink = ref(true)`） | 与 WeKnora 的 `deepThink` 同取向：**推理默认可见**，折叠的是工具细节 |
| 12 | 人话摘要 | 流式期间**正文只有一行**「正在执行 {节点名}」 | 与我们一致 ✓（我们也只有流式期间那一行） |

### 4.3 这一组的横向：折叠的到底是谁？（WeKnora / MaxKB / Coze Studio / 我们）

**Coze Studio（字节开源，v0.5.1，React + Rush）—— 反面教材**：开源版把工具调用压到极致——正文只插**一行不可展开的「using {插件名}」**（`<IconCozLoading class="animate-spin"/>` + 插件名，最大宽 230px），**没有入参、没有结果、没有耗时、没有失败态、没有展开折叠**。running 与 done **无任何区别**（图标恒转、文案恒 `using`）。插件结果以 verbose 到达（`STREAM_PLUGIN_FINISH.tool_output_content`），而 verbose **不在正文白名单** `MESSAGE_TYPE_VALID_IN_TEXT_LIST` 里 ⇒ **结果根本不进气泡**；中断/需用户输入的 tool_call 源码注释直接写着 *"require_info interrupt is not rendered!!!"*。
它的架构事实值得记一笔：对话 UI 是**可插拔 SDK**（`@coze-common/chat-area` + `chat-uikit` + 一堆 `chat-area-plugin-*`），"插件调用不出现在正文气泡"是**这个架构的默认结果，不是 bug**；要补富展示得写 chat-area 插件，或用 `IContentBoxProps.enhancedContentConfigList`（支持带 `rule` 的自定义渲染器）。

| | 工具细节（入参/结果） | 推理（thinking） | 运行中的可见性 | 折叠时机 |
| --- | --- | --- | --- | --- |
| **WeKnora** | **折叠**（一行 root summary） | `deepThink` **默认展开**、流式结束自动折叠、**思考中禁止手动折叠**；另一套是内联在时间线里 | 1.5s 线性 shimmer + 自然语言摘要 | **`shouldShowCollapsedSteps = f(isSegmentDone, isConversationDone)`——流式中不折、整轮真正结束才折**（用测试锁死，见下） |
| **MaxKB** | **折叠**（`showContent=false`；节点卡也默认折叠） | `ReasoningRander` **默认展开且在正文最上方**，结束**不**自动折叠 | 正文只有一行「正在执行 {节点名}」 | **纯手动**（三处 toggle，无 watch 自动开合） |
| **Coze Studio** | **完全不显示** | 独立 plugin（细节未取到） | 一行「using {插件名}」 | **不存在折叠** |
| **我们** | **展开**（面板默认展开、组收起） | 每步内联**跟流式**（跑时开、答完收） | 一行实时文案（但**只在流式期间**，无出处时连这一行都没了） | **面板不折**；只有单步思考在流式结束时收 |

⇒ **三家都把"工具细节"折起来、把"推理"亮出来；我们正好反了一半**：过程板默认摊开占满首屏，而推理被折进"思考 N 字"里。

**WeKnora 那条"折叠时机"是这一组里最值得抄的一条**（它比"完成后折叠"更精确）：`shouldShowCollapsedSteps` 由 `isSegmentDone` / `isConversationDone` 共同决定，配套测试断言 **`isSegmentDone===true` 且 `isConversationDone===false` ⇒ 不折叠**——也就是**流式中（含 steer 分段未整轮结束）不折、整轮真正结束才折**。多数实现（含 MaxKB）是纯手动，或"一结束就啪地收起"把用户正在读的内容跳走。

**WeKnora 的异常态是三家最细的**（同一次调用落到三种完全不同的 UI）：需授权 → `McpOAuthCard`（去授权 / 跳过 / 已授权 / 授权超时 / **恢复执行**）；高危 → `ToolApprovalCard`（**参数就地可编辑 + JSON 校验 + 倒计时三档变色**：默认 600s、≤120s warning、≤30s error，支持 `m:ss`，按钮「通过并执行 / 拒绝」）；普通失败 → `McpToolResult` 的 `.mcp-error` + `<pre>` 原文。MaxKB 只有最后一种（红图标 + 「错误信息」节）。

**WeKnora 的"结果阶段人话化"也是三家最彻底的**：不只 `正在调用 {name}...`，还给出 `找到 {count} 个结果，来自 {files} 个文件` / `找到 {count} 条网页` / **`命中 {count} 条候选，相关性不足，未用于回答`**——源码注释点明这句的设计意图：*"the difference is what tells you to look at the threshold instead of the knowledge base"*（**这句文案决定用户该去调阈值还是去补知识库**）。

> 这条正好解释了用户"看着不舒服"的直觉，也说明 §5 里 **P0 的"面板默认收起"不是审美偏好，而是与全部能确证的样本一致的取舍**。

### 4.4 Cline / Roo Code（VS Code 插件）— 源码级

**一句话定位**：Cline 把工具调用**逐行内联在正文流**，连续的低风险读/列目录/搜索**合并成一行自然语言摘要**；Roo 同样逐行内联，但每行是"加粗一句话 + 缩进 24px 的圆角浅底卡片"，且**展示层不合并同类调用**。

| # | 维度 | Cline | Roo Code |
| --- | --- | --- | --- |
| 1 | 位置与容器 | 与正文同列、左右各 16px，**无卡片外框**；只有"结果载体"（文件路径行/代码块/命令块）画圆角小卡片 | 每行外壳 `px-[15px] py-[10px]`；结果块 `pl-6` 缩进 24px 包 `ToolUseBlock`（**圆角 6px + 底色、无边**） |
| 2 | 单步行 | 图标（`size-2`）+ 加粗文案；`HEADER_CLASSNAMES`；**running/done 两套文案**（"wants to view" vs "viewed"）；MCP 用 `ProgressIndicator`（`animate-spin`）；**无耗时、无 token** | 图标（`w-4`）+ ask/done 两套 i18n；`isLoading` 时 header 插 `VSCodeProgressRing`；diff 给 `+N/-M`；api_req 行右侧成本徽标，完成后整行 `opacity-40 hover:opacity-100` |
| 3 | 分组聚合 | **只合并低风险工具**（`LOW_STAKES_TOOLS` 五个），`groupLowStakesTools()` 顺序扫连续段；组头 `"Cline read 3 files, 1 folder, performed 2 searches"`；按类型计数不去重 | **展示层不合并**；只在"连续同类 **ask**"时合成批量审批块（batchFiles/batchDirs/batchDiffs） |
| 4 | 默认开合 | 行级默认**全收起**（`expandedRows[ts] \|\| false`）；组**没有整体展开态**，只有组内每项各自的默认收起 | 行级默认**全收起**（`useState<Record<number,boolean>>({})`）；任务切换清空 |
| 5 | 自动时机 | ①reasoning 流式中自动展开；②**流式结束自动收起**；③命令执行中**延迟 500ms 自动展开**，停止时复位；④失败/待批准**未查到**；⑤「completion_result 自动展开/收起」两个 effect **只写 ref、不改状态 → 现 main 上是死代码**；⑥新消息 `scrollToBottomSmooth()` + 40/70ms 二次校正、行高变化 500ms debounce 保持贴底 | 行级无自动展开；**完成后自动折叠：未查到**；展开任一行即 `enterUserBrowsingHistory("row-expansion")` 停止跟随，并给「回到底部」「跳到最近 checkpoint」两个按钮 |
| 6 | 覆盖与持久化 | `expandedRows` 组件 state，**仅当前 webview 会话**；展开时 `disableAutoScrollRef=true`（"expanding should stay in place"），收起时回到底部；**无「全部展开/收起」** | `expandedRows` 组件 state，任务切换清空；**全局记住的是设置项** `reasoningBlockCollapsed`；**无「全部展开/收起」** |
| 7 | 结果展示 | **按行数切**：`lineCount <= 5` 全显，>5 行收起 `max-h-[75px]`／展开 `max-h-[200px]`，居中三角把手 `ExpandHandle` 当"查看全部"；未展开时输出自动滚到底；`📋 Output is being logged to:` 渲染成可点行 | CodeAccordion `max-h-[300px]` 滚动、**不做字符截断**；`readCommandOutput` 直接报"第 X–Y 字节 / 共 Z 字节""N matches" |
| 8 | 思考/推理 | 独立块 `ThinkingRow`：流式中开、**流式结束自动收起**；标题流式时 `animate-shimmer`；**组内 reasoning 被显式丢弃**（"Never show reasoning in file lists"） | 独立块 `ReasoningBlock`：默认开合＝**全局设置** `reasoningBlockCollapsed`；流式中每秒 tick `reasoning.seconds`；**流式结束不自动折叠** |
| 9 | 异常态 | `ErrorRow`（`errorType` 四档）+ **有重试入口**；取消分灰/红两色；批准按钮在输入框上方的 `ActionButtons`，**不在行内** | 统一 `ErrorRow`（六档 type）；`api_req_failed` 主按钮 `chat:retry.title`；自动重试倒计时从 `<retry_timer>N</retry_timer>` 抠出，`transition-all duration-1000`；批准按钮在列表下方固定区，**不在行内** |
| 10 | 长回合 | **不分页**，`react-virtuoso` 虚拟化（`atBottomThreshold={10}`）+ `filterVisibleMessages()` | Virtuoso 虚拟化 + "曾可见"LRU（`max:100, ttl:5min`）+ 视口尾 100 条 |
| 11 | 动效 | 思考块 `transition-[max-height]` **250ms `cubic-bezier(0.4,0,0.2,1)`** + `opacity 150ms ease-out`；命令块 `transition: all 0.3s ease-in-out`；代码块/组内项**无高度过渡（瞬时）** | **折叠本体是条件渲染 = 瞬时**；只有 chevron `transition-opacity`、重试倒计时 `duration-1000` 等 |
| 12 | 人话摘要 | **两层**：组头摘要 + 组内"进行中"项 `getActivityText()` 配 `<TypewriterText speed={15}>`（`Reading {path} (lines x-y)…` / `Searching "{terms}" in {path}/…`） | 每行的加粗标题即 ask/done 两套 i18n 句子（`wantsToRead` / `didRead`…） |

**新增的一条关键差距（两家共有、我们完全没有）**：**组里会插一条"正在跑的那一次"行**——Cline 把 `completedTools` 与 `activeTools` 合成一个列表并按 path 去重。我们的组只有静态成员，用户**看不出是哪一次调用在跑**。

### 4.5 Cherry Studio / LobeHub（国产开源客户端）— 源码级

**一句话定位**：Cherry 是"**活跃态平铺实时组 / 完成态折叠的「已处理」Accordion**"两相切换；LobeHub 是把一轮的过程折成 `N calls / 3m 37s` 的单行 Accordion，**最终答案永远留在折叠之外**。

（Cherry v2 已重构：工具 UI 从 `src/renderer/src/pages/home/Messages/` 迁到 **`src/renderer/components/chat/messages/`**；LobeChat 仓库已更名为 **`lobehub/lobehub`**，默认分支 `canary`。）

| # | 维度 | Cherry Studio | LobeHub |
| --- | --- | --- | --- |
| 1 | 位置与容器 | 独立 block，与正文**同列**、非侧栏；**无卡片外框**（`variant="light"` → `bg-transparent`，非 light 才 `rounded-[7px] border`） | 一轮被切成 process / final 两段，**final answer 在折叠之外**；**borderless**——用 inline style 显式抹掉 Accordion header 的 hover 底色与 padding |
| 2 | 单步行 | `{serverName} : {name}` + 状态；`ToolStatusIndicator` 是**文字 + 图标 + 颜色**：`streaming`/primary、`pending\|invoking`/"invoking"/primary、`waiting`/"Awaiting Approval"/warning、`done`/"completed"/success、`error`/三角/error、`cancelled`/error；**error 色被刻意降为灰**；`getEffectiveStatus` 把 `pending` 拆成 `waiting`/`invoking` | `StatusIndicator`（`Block variant="outlined"` **24×24 描边方块**）+ 标题 + `ExecutionTime`；六态图标 `Check`/`X`/`HandIcon`/`Ban`/`CornerUpRight`/`PauseIcon`，否则 `Spin`；**耗时仅执行中渲染**，100ms 刷新，`<1s → "123ms"`、`<60s → "12.3s"`；加载中标题 `shinyText` |
| 3 | 分组聚合 | **两层**：轮级 `MessageProcessGroup` + 嵌套 `ToolBlockGroup`；组标题**动态**——全完成给 summary + 耗时，运行中给"最后一条 running/waiting 项的人话标题 + `BeatLoader`" | `WorkflowCollapse` **只报总调用数**（`{{count}} call(s)`）；源码注释明确否决按工具细分："a per-tool breakdown … is detail the expanded list already carries"；无工具时回退 `Thought for {{duration}}` |
| 4 | 默认开合 | 轮级 `defaultExpanded=false`（完成后默认折叠）、活跃相恒展开；嵌套组默认折叠；单条 MCP `activeKeys=[]` 默认折叠 | 单 tool `getRenderDisplayControl()` **默认 `'collapsed'`**；轮级 `streamingInitialLevel='full'` / `completionInitialLevel='collapsed'`；另设 `semi` 档＝高度封顶 `max-height: min(40vh,320px)` |
| 5 | 自动时机 | 单条 MCP：**流式自动展开、完成与失败都自动折叠**；轮级靠 active↔completed 相位切换 | 单 tool：`needExpand` 时 **100ms 后自动展开**；轮级：`allComplete` false→true 且**用户没手动开过**时自动折；**待确认 → `forceExpanded` 并拒绝收起**；`suppressAutoCollapse` 专为避免"折两次"的抖动（注释："Collapsing twice … is what makes the conversation visibly jitter"） |
| 6 | 覆盖与持久化 | `useMessageDisclosureState` → window-local 缓存，键 `messageId + disclosureId`；**不跨重启持久化** | `userOpenedRef`（用户开过就不自动折）；`ProcessFold` 注释 "**Purely a view affordance — never persisted**"；**有「全部展开/收起」**（message action bar，作用于整条消息） |
| 7 | 结果展示 | `truncateOutput(output, 50000)` 尽量落在换行 + `TruncatedIndicator`（显示原始字节） + **hover 复制完整 JSON**；MCP `content` 逐项分类：text（试 JSON 美化）/ image（内联 `<img maxWidth:300>`）/ resource（`[Resource: uri]`）；参数表 depth≥2 归约；容器 `max-h-[300px]`；**没有"查看全文"入口** | 详情只在展开时 `dynamic()` 挂载 + Skeleton；有富卡片走 `CustomRender`，否则 fallback args+content；`payloadOmitted==='render'` 时**展开才回取**存储的 body；图片有专门能力（`isImageBearingTool`，CC `Read` 命中图片会自动翻成展开） |
| 8 | 思考/推理 | 独立块；默认开合由**用户设置** `thoughtAutoCollapse` 决定（设置变化会重置手动开合）；**流式结束不自动折叠**；流式中 `BeatLoader` + 一行滚动预览 | 独立块；**进入推理自动展开、推理结束自动折叠**；`max-height: min(40vh,320px)`；标题带 duration；流式标题也会取"纯思考 block 的最后一个 markdown 标题" |
| 9 | 异常态 | 有 `cancelled`/`error`；`errorText` 套 Tooltip；**超时态与工具级重试：未查到** | 失败→红 X；**超时→ `RejectedResponse timedOut`**，图标中性（注释："nothing went wrong and nobody made a choice"）；被拒→ `AlertTriangle` + warning；中止→ `PauseIcon`；**待确认的行内联不渲染**，由底部 `InterventionBar` 承载 |
| 10 | 长回合 | 消息级虚拟滚动 + 条件渲染 + 分级延迟挂载（展开 40ms / args 120ms / 高亮 220ms 或 `requestIdleCallback`）；**组内条目无分页** | ScrollArea + 高度封顶 + `dynamic()`；**核心是订阅粒度**——每个 tool 只订阅自己那一个（"a streaming chunk that only updates a sibling tool does not push new props through this subtree"） |
| 11 | 动效 | **混合**：组级 Accordion `motion-safe:data-[state=open]:[animation-duration:200ms]` / `closed:160ms` + `motion-reduce:animate-none`；单条 disclosure 与思考块 `hidden={!isOpen}` → **瞬时** | **有高度过渡**：`enter {height:'auto',opacity:1}` ↔ `exit {height:0,opacity:0}`，**duration 0.2、ease `[0.4,0,0.2,1]`**；另 `duration:0.18` 的按钮动效、流式标题 `popLayout` y:8→0、`WORKFLOW_HEADLINE_DEBOUNCE_MS=320` |
| 12 | 人话摘要 | **很厚**：主动词/被动词双表（21 组）+ `getCommandActivity` 用正则把 shell 命令分到 17 类并推断宾语；MCP 走 `getMcpToolGroupPresentation`（action ∈ 8 × target ∈ 10）；标题用 `useMinimumDisplayDuration(1200ms)` 稳定 | **是这一版的设计核心**：折叠行读作一句 `⟨动作⟩ ⟨关键词⟩`（注释："so a finished run scans as prose"）；动作来自 i18n + `TOOL_API_DISPLAY_NAMES`（100+ apiName）；关键词由 `extractToolKeyword` 按 name→command→query→path→url 抽取，命令还会剥掉 env 赋值与 `npx/tsx` 包装器 |

### 4.6 Trae / Qoder / CodeBuddy（闭源三家）

**详尽证据表见附录**《[工具调用 UI 对标调研 · 附：闭源三家证据](工具调用UI-对标调研-附-闭源三家证据-v0.1.md)》。这里只留结论：

| 产品 | 能确证到什么 | 关键教训 |
| --- | --- | --- |
| **Trae** | 官方文档级：**「对话流节点自动折叠」**——"已完成的任务将被自动总结并折叠，展开后展示详情"；官方身份在社区承认"**中间的执行过程和结果确实会被默认折叠在「任务耗时」区块中，只直接展示最终的总结报告**"；且 v3.3.94 **关不掉**（文档写了开关、客户端没交付） | ①**默认折叠是这一代国产 Agent 的共识**；②**不给逃生舱会被当阻断性缺陷**（用户称其为 BUG）；③折叠摘要写成统计式「已编辑 3 个文件，读取 2 个文件，搜索 3 次文件」**被开发者批评"没有营养"**；④思考嵌套导致"**需要点 3 次才能展开**" |
| **Qoder**（原通义灵码） | 官方文档级：设置项 **「Expand tool calls by default / 默认展开工具调用」**——"开启后新建展示的工具块默认展开，可随时手动收起"。**该开关的存在本身即反证默认值是折叠**；另有「在 IM 频道展示工具调用执行过程」；工具名同时维护**显示名与工具 ID**；状态枚举文档化（生成中/应用中/应用完成；空心圈/旋转圈/复选框） | 设置项命名范式可直接照抄：**默认态 + 作用对象 + 手动兜底**。但"流式中是否展开、完成后是否自动折叠"**零官方表述** |
| **CodeBuddy** | **"工具块默认开合"零官方依据**。但更新日志从故障侧暴露了大量结构：**「命令卡片」「工具审批卡片」「子 Agent 卡片」**；"**工具审批卡片不下发导致对话卡死**"；子 Agent 成员栏折叠为「+N」；思考可按 Agent 单独配置开关与强度 | ①**审批卡片是最不能折叠的一环**（折叠/丢失 → 对话卡死）；②截断出过"**变成空白**"级 bug ⇒ **绝不能截成空白**；③思考/正文/工具是三条并行流，**正文不能被工具状态截断** |

### 4.7 横向总表（决策相关的 9 列）

| 产品 | 工具细节默认 | 完成后自动折叠 | 执行中折叠 | 用户手动保护 | 全部展开/收起 | 行内状态位 | 耗时 | 展开动画 | 人话摘要 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **我们** | **展开**（整面板） | ❌ 不折 | — | ⚠️ 面板级"记忆"反而**压制**自动折叠 | ❌ | ❌ | ❌ | ❌ 瞬时 | 仅流式一行 |
| Cline | 收起（行级） | 思考块折 | 命令**延迟 500ms 自动展开** | 展开即停止自动滚动 | ❌ | ✅ 组内"进行中"行 + 打字机 | ❌ | 250ms（思考）/ 300ms（命令） | ✅ 两层 |
| Roo Code | 收起 | 未查到 | — | 展开即进入"用户浏览历史" | ❌ | ✅ spinner 插 header | ✅ 倒计时 | ❌ 瞬时 | ✅ ask/done 双套 |
| Cherry | 收起（轮级 + 单条） | ✅ 完成与失败都折 | ✅ 流式自动展开 | window-local 缓存 | ❌ | ✅ 文字+图标+颜色 | ❌ | 组级 200/160ms、单条瞬时 | ✅ 21 组动词表 |
| LobeHub | collapsed | ✅ 完成后折 | 单条 100ms 后自动展开 | ✅ `userOpenedRef` | ✅（整条消息） | ✅ 24×24 方块 + 六态 | ✅ 100ms 刷新 | ✅ 200ms `cubic-bezier(.4,0,.2,1)` | ✅ 动作×关键词 |
| WeKnora | 折叠（一行 root summary） | — | — | — | 未查到 | ✅ 1.5s shimmer | — | ✅ 200ms | ✅ 常驻 |
| MaxKB | 收起（内联卡 + 节点卡） | — | — | — | 未查到 | ✅ 状态图标 + token + 耗时秒 | ✅ | ✅ `el-collapse-transition` | ✅ 「正在执行 X」 |
| Trae | 折叠（文档级） | ✅ 官方承认 | ✅（**有害**，用户反弹） | 疑似**不**保护 | 未查到 | ❌（MCP 只有计数） | 区块名"任务耗时" | 未查到 | ✅ 统计式（被批评） |
| Qoder | 折叠（由开关反证） | 未查到 | 未查到 | ✅ 单块可手动收起（文档级） | 未查到 | ✅ 三态/三符号（文档级） | 未查到 | 未查到 | ✅ 显示名 vs 工具 ID |
| CodeBuddy | **零依据** | 零依据 | 零依据 | 零依据 | 零依据 | 卡片术语 | 零依据 | 零依据 | 零依据 |
| Coze Studio | **不显示**（正文仅一行「using {插件名}」） | —（无折叠） | —（无折叠） | ❌ | ❌ | ❌（图标恒转，running 与 done 无差别） | ❌ | ❌（不存在） | ✅ 仅进行时一句 |
| Qwen Code | **按工具类型分区**（read/search/list 折成一行，edit/write/command/agent 始终逐个） | **思考流式摊开、落定收成一行** `Thought for 3.2s (ctrl+o to expand)` | —（工具行不自动折） | ✅ `Ctrl+O` / `Alt+T` | ✅ 组行 `{done}/{total}` | ✅ 6 态字形 `✓ o ⊷ ? - x`；执行中 80ms spinner；**等确认时冻结成 `⠏`** | ✅ 每行有 | ❌ 折叠＝条件渲染（不画） | ✅ 随时态换词（`Reading`→`Read`，>3 给 `… and N more`） |
| Kimi CLI | **没有折叠**（终端限制，源码自陈 "cannot be unprinted"） | —（无折叠） | —（无折叠） | ⚠️ `Ctrl+O` 在这家是"外部编辑器"，不是展开 | ❌ | 一个字 `Using`→`Used` | ❌ | ✅ 6 帧 bullet 0.13s/帧 | ✅ **默认不渲染推理原文**，只给 `Thought for 3.2s · 1.2k tokens` |
| OpenHands | 组与卡**两级都默认收起** | 被"翻篇"后主标题换成 `{n} actions completed` | —（未查到自动展开） | ❌ | ❌ | ✅ 组头"最新一步人话" + `{done}/{total} actions completed` + `animate-spin` | ❌（只有组头计数） | ❌ 展开**无高度过渡**（"没做，不是做不到"） | ✅ "最新一步人话"写进组头 |
| **assistant-ui（我们已装）** | 卡 `defaultOpen=false` | — | `requires-action` **自动展开** | — | — | ✅ 四态图标 + spinner + shimmer | ✅ `useToolCallElapsed` | ✅ 200ms collapsible | — |

### 4.8 从十二个样本 + 基座里浮出来的十一条规律

1. **"默认折叠工具细节"是共识，我们是唯一的例外。** 十二个样本里，凡是能确证的**没有一个默认展开**（Cline/Roo/Cherry/LobeHub/WeKnora/MaxKB/Trae/Qoder/OpenHands 默认折叠，Coze Studio 干脆只留一行「using {插件名}」，外加 assistant-ui 的 `defaultOpen=false`）；只有我们默认**整面板展开**。
2. **"完成后自动折叠"也是共识**：Cherry（完成与失败都折）、LobeHub（`completionDefault='collapsed'`）、Trae（官方承认）、OpenHands（"翻篇"后换标题）。Cline 折的是思考块，Qwen 折的是思考行。
3. **但"执行中折叠"是有害的**：Trae 用户原话"展开了，过一会……**又给折叠掉了**，AI 在干啥都不知道"；Trae 改版前"最后才被折叠"的行为反而被怀念。**折叠只在 turn 结束时做。**
4. **手动展开必须能压过自动折叠**：LobeHub 用 `userOpenedRef` 明写这条，Trae 是反面教材。⚠️ **我们现在的 `traceOpenMemory` 语义正好相反**——"记住上次开合"会让自动折叠永远失效（用户上次开着 → 这次也开着）。
5. **行内必须有状态位，耗时是标配**：样本里六家有行内状态（图标/颜色/文字），Cherry 把 `pending` 拆成 `waiting`/`invoking`，LobeHub 与 MaxKB 都显示耗时，Qwen 每行都有。**我们两样都没有**；而"进行中=旋转、已完成=勾选"是 Qoder 官方文档就写死的惯例。
6. **展开动画的时长收敛在 200ms**：LobeHub 200ms、Cherry 组级 200/160ms、WeKnora 200ms、assistant-ui 200ms、Cline 思考块 250ms。缓动出现两次 `cubic-bezier(0.4,0,0.2,1)`。**我们是 0（瞬时）。**
7. **"人话摘要"分两派，且写错会被骂**：一派是**进行时句子**（Cline `Reading {path} (lines x-y)…`、Cherry 21 组动词表、MaxKB「正在执行 X」、WeKnora「正在调用 {name}...」、Qwen 随时态换词）；另一派是**统计式**（Trae「已编辑 3 个文件，读取 2 个文件，搜索 3 次文件」、LobeHub 的 `N calls`）——Trae 那套被开发者明确批评"没有营养"。**"在做什么/做成了什么" > "做了几次"。**
8. **同一块里不要两种信息密度**：这是本次对标最刺的一条——**十二个样本里，没有一家是"面板展开 + 组收起 + 单步收起"这种同块两种密度的做法**（= 我们当前的形态）。要么**整块收成一行**（WeKnora/MaxKB/Qoder/Trae/OpenHands），要么**逐行平铺、每行都自足**（Cline/Roo），要么**只留一行**（Coze）；而我们让"组"收起、"单步"铺开，读者在同一屏里既有"零信息行"又有"满信息行"，这正是用户说"看着不舒服"的结构性来源。
9. **"折叠时机"要按"整轮是否真的结束"判，而不是"这一轮一完就收"**：WeKnora 把它写成状态机并用测试锁死——`shouldShowCollapsedSteps = f(isSegmentDone, isConversationDone)`，断言 **`isSegmentDone===true` 且 `isConversationDone===false` ⇒ 不折叠**（即流式中、含 steer 分段未整轮结束时**不折**，整轮真正结束才折）。两个极端都已被证明是有害的：Trae 折得太早（执行中就折，用户投诉"AI 在干啥都不知道"）；我们**永不折**（过程常驻占首屏）。MaxKB 则是纯手动、没有任何自动时机。
10. **异常与"需人工介入"要按语义分形态**：WeKnora 同一次调用能落到三种完全不同的 UI——需授权 → OAuth 卡（去授权/跳过/**恢复执行**）；高危 → 审批卡（**参数就地可改 + JSON 校验 + 倒计时三档变色** 600s/≤120s/≤30s）；普通失败 → 红字 + `<pre>` 原文。**我们目前只有"默认展开这一行"这一条线索**，且审批条在输入框上沿、不在工具块里。
11. **人话摘要要覆盖"结果阶段"，不只是"进行中"**：WeKnora 连"召回不足"都专门写了一句 `命中 {count} 条候选，相关性不足，未用于回答`——源码注释点明它的用途：**这句文案决定用户该去调阈值还是去补知识库**。我们只有后端的 `step.detail`（结论），没有这一层"为什么"。另外 WeKnora 的 shimmer 带 `prefers-reduced-motion` 降级——**我们整个对话域基本没做 reduced-motion**（见审计文档 §4.6）。

> 另外两条与折叠无关但同等重要的**约束**：**审批卡片最不能折**（腾讯日志："工具审批卡片不下发导致对话卡死"）；**截断绝不能截成空白**（腾讯踩过这个坑）。我们目前这两条都没踩雷——审批条在输入框上沿、结果截断有「仅预览 X / Y 字」的如实标注，**这一点我们比 Trae 那种"关不掉又不说"的做法好**。

### 4.9 Qwen Code / Kimi CLI / OpenHands（源码级）

>> 详尽版见《[工具调用 UI 源码级对标：Qwen Code / Kimi CLI / OpenHands](工具调用UI-源码级对标-QwenCode-KimiCLI-OpenHands-v0.1.md)》。
> **版本锚点**：Qwen Code `main`（CLI 0.24.6，未逐文件钉 SHA）；Kimi CLI tag `1.52.0`；OpenHands tag `v1.24.0`。
> ⚠️ **两条会改变"照抄"判断的事实**：① **Kimi CLI（Python）已归档**（`1.52.0` 的 README 首行即 `# Kimi CLI (Archived)`，仓库只读）——做法可学，但不能当"在演进的产品"引用；② **OpenHands 这个仓库现在只是前端**（根 `AGENTS.md`：*"only the agent-canvas frontend"*），后端在 `software-agent-sdk`，所以它只能回答"前端拿到事件后怎么画"。

**Qwen Code —— 唯一把工具调用当独立产品面做的**：按**工具类型**分区折叠（read/search/list 折成一行，edit/write/command/agent 始终逐个）；6 态状态字形 `✓ o ⊷ ? - x`（`constants.ts` 的 `TOOL_STATUS`）；执行中 80ms spinner，**被确认卡住时故意冻结成 `⠏`（`WAITING_SPINNER_FRAME`）**；每行带耗时；摘要句**随时态换词**（`Reading 3 files` → `Read 3 files`，>3 条给 `… and N more`）；`forceExpandAll` 把"出错 / 待确认 / 用户发起 / 前台 shell / 终态子代理"枚举成**一个单一安全阀**；`Ctrl+O`（`Alt+T`）展开收起全部、`Ctrl+S` 解除高度截断；**折叠＝条件渲染（不画）**；**思考流式摊开、落定收成一行** `Thought for 3.2s (ctrl+o to expand)`，`<1s` 降级成 `Thought briefly`。

**Kimi CLI —— 没有折叠这回事**：Rich `Live(transient=True, refresh_per_second=10)` 暂存区 + `flush_finished_tool_calls()` 定稿永久打印；状态只用一个字（`Using`→`Used`）；动画最多（6 帧 bullet 0.13s/帧、dots/moon spinner）；`Ctrl+E` 只在**审批面板**截断时开 pager；工具输出上限 50,000 字符 + 单行 2,000。**它把"省地方"的力气花在思考上：默认不渲染推理原文**，只给 `Thought for 3.2s · 1.2k tokens` + 实时 tok/s 心跳。⚠️ 但 `show_thinking_stream` 的**代码默认是 `True`**，与它自己 docstring 写的 "never render it" 相反——调研已如实标注这处不一致。

**OpenHands —— 唯一有真 web 折叠组件的**：`EventGroup` 折**连续**可分组事件（`EVENT_GROUP_MIN_SIZE = 2`；ThinkAction / FinishAction / error / hook / markdown 工件 / TaskTracker 都是断裂点）；**组与卡两级都默认收起**；组头在跑时给"最新一步人话 + `{done}/{total} actions completed` + `animate-spin`"，被后面内容"翻篇"后（`isFinalized`）主标题换成 `{n} actions completed`；有完整 `aria-expanded` / `aria-controls` / `role=region`；自动滚动带用户意图判断（上滚关、到底开、**20px 阈值**）；历史首次只拉 50 条，滚到顶部 80px 内分页并**钉住视口**；`TextShimmer` 带 `useReducedMotion`。**思考默认收起且从不自动展开**（注释理由：思考语言常 ≠ 对话语言），但从 action 提升出来的 thought 走 `ThoughtEventMessage` 是**不折叠的正文**。⚠️ `SuccessIndicator` 在 v1.24.0 只渲染 `timeout`（success/error 分支为空），与它自己 AGENTS.md 的描述不符——以源码为准。

#### 4.9.1 「受终端限制」还是「产品意图」——这一节决定了哪些不能照抄

| 观察 | 判定 |
| --- | --- |
| "已打印历史不可折叠" | **终端硬限制**（Kimi 源码自陈 *cannot be unprinted*）。**web 没有这条限制** ⇒ 折不了**不构成**"我们也不该折"的理由 |
| Qwen 的"就地 per-block 展开" | 在其设计文档里是**明确的 follow-up，不是做不到** |
| OpenHands 的"展开无高度过渡" | **没做，不是做不到**（同仓库 `TextShimmer` 证明它会做动画） |
| "思考默认不显原文" | **三家收敛（含 web 的 OpenHands）⇒ 产品意图** |
| "失败 / 待确认强制展开" | **三家一致 ⇒ 安全语义**，应当照抄 |

#### 4.9.2 这一路最刺的一句结论

> **没有一家是"面板展开 + 组收起 + 单步收起"这种同块两种密度的做法。**

这正是我们当前的形态（面板默认展开、组默认收起、单步默认收起）——**十一家里只有我们是这样**。

---

## 5. 改进清单

### 5.1 先说改动集中度

调研里**性价比最高的三条落在同一批文件**（`model/turns.ts` · `ui/TracePanel.tsx` · `ui/TraceStepRow.tsx`）——**应当合成一次改动做，分三次做会三次动同一处渲染**。剩下两条是独立的：一条是 bug 修复，一条在 `chat.css` / `traceStyles.ts`。

### 5.2 清单（每条都标了依据与落点）

| 优先级 | 事项 | 落点 | 依据 |
| --- | --- | --- | --- |
| **P0** | **面板默认值重定：过程默认收起、答案常显**。`traceOpen` 从布尔改成 `'collapsed' \| 'full'`，并照抄 LobeHub `WorkflowCollapse` 的四条规则：**(a)** 流式默认 `full`、完成默认 `collapsed`；**(b)** 只有**用户没手动开过**才自动折（`userOpenedRef`）；**(c)** 存在 `outcome==='awaiting'` 的步骤时 `forceExpanded` 并**拒绝收起**；**(d)** 摘要写"…"，但**最后一轮回答永远留在折叠之外**。<br>⚠️ **同时必须改 `traceOpenMemory` 的语义**：从"记住上次开合"改成"记住用户是否手动干预过"——现在的语义会让自动折叠永远失效（用户上次开着 → 这次也开着） | `turns.ts::isTraceOpen` · `TracePanel.tsx` · `ChatProvider.tsx:1489-1507` | §4.7（11 个样本里凡能确证的全部默认折叠，**只有我们不是**）· §4.8 规律 1/2/4 |
| **P0** | **单步开合跨轮次串号**（key 加轮次命名空间） | `turns.ts:844` · `ChatProvider.tsx:2060` | 真 bug（§1.3 第 6 条）。注意组 key 同样会撞（`turns.ts:769`） |
| **P1** | **组行标题自然语言化 + 状态计数**：跑时主标题给"最新一步在干嘛" + `{done}/{total}`，结束后换成聚合句（≤3 条列全，>3 条列前 2 + `… 还有 N 个`）。**不需要动数据模型、也不需要后端加字段** | `TracePanel.tsx:87-98` | §4.8 规律 7（Trae 的统计式摘要被开发者骂"没有营养"）· Cline `getToolGroupSummaryFromParsedTools` · OpenHands 组头 · Qwen 随时态换词 |
| **P1** | **`TraceStep` 补 `state: running\|done\|failed\|awaiting` + 行内耗时**：`awaiting` 直接由现有 `outcome` 映射；耗时前端自己算 running→done 的时间差（不阻塞后端）；格式抄 LobeHub `ExecutionTime`（`<1s → "123ms"`、`<60s → "12.3s"`、否则 `Xm Ys`），**done 后耗时留在组行上**。<br>**单独抄"等确认时冻结 spinner"这一招**（Qwen 的 `⠏`）——它把"卡住了？"和"在等你确认"分开 | `turns.ts` · `traceStyles.ts` · `TraceStepRow.tsx` | §4.1 第 2/4 条 · §4.8 规律 5 · Cherry `getEffectiveStatus` · Qwen `WAITING_SPINNER_FRAME` |
| **P1** | **展开折叠加高度过渡 + 高度封顶 + 跟随滚动**：`{open ? <div/> : null}` 换成 `height: 0 ↔ auto` + opacity，**200ms `cubic-bezier(0.4,0,0.2,1)`**（五家取值收敛在 200ms），并加 `prefers-reduced-motion` 直落；过程列表 `max-height: min(40vh,320px)` + `overflow:auto`；受限档用 **120px** 阈值做"贴底才跟随"（LobeHub `WORKFLOW_EXPANDED_SCROLL_THRESHOLD_PX`；Cline / Roo 都用 `atBottomThreshold = 10` 判"在底部"） | `traceStyles.ts` · `TracePanel.tsx` · `ChatThread.tsx` | §4.8 规律 6（200ms 收敛）· §4.2 §4.5 · §4.6（两家都有展开↔滚动联动，我们完全没有） |
| **P1** | **把"必须看得见"枚举成一个 `forceExpand` 安全阀**：现在只有"被拦下/等确认"，而且靠 `REFUSAL_MARKS` 词表散在 `TraceStepRow` 里。抄 Qwen 的 `forceExpandAll`（出错 / 待确认 / 用户发起 / 前台 shell） | `TraceStepRow.tsx:61-96` · `TracePanel.tsx` | §4.9（"失败/待确认强制展开"三家一致 ⇒ **安全语义**） |
| **P2** | **结果阶段也人话化**：现在只有后端的 `step.detail`（结论句），没有"为什么"。照 WeKnora 给每个工具写 `pending / pendingWithQuery / done(+failed)` 三套模板与一个 `summarize(toolName, args, result)`，**单独文件、无依赖、立刻可见**；特别是"召回不足 / 未用于回答"这一类**要专门写一句**——它决定用户去调阈值还是去补知识库 | 新增 `model/toolActivity.ts` + `TraceStepRow.tsx` | §4.3 · §4.8 规律 11 |
| **P2** | **结果渲染器按类型分派**：照 MaxKB 的 `kw[content.type]` 策略映射 / WeKnora 的 `displayType` 分派（20+ 渲染器）/ Coze 的 `enhancedContentConfigList.rule`——**三家共有**。定义 `displayType` 枚举 → 组件映射表 → 未知类型 fallback 到等宽 `<pre>` + 限高。之后每接一个新工具只加一个渲染器，不必再动主时间线 | `TraceStepRow.tsx` 的 `result` 分支 | §4.3 · §4.8 规律 11 |
| **P2** | **「全部展开 / 全部收起」**：LobeHub 有（message action bar，作用于整条消息）、Qwen 有（`Ctrl+O` / `Alt+T`）。**样本里只有我们和 Roo / Cline / Cherry / MaxKB / Coze 没有**——但 Cline / Roo 至少给了"回到底部" | `TracePanel.tsx` | §4.8 规律 5 · §1.3 第 6 条 |
| **P2** | **组里插一条"正在跑的那一次"**：Cline 把 `completedTools` 与 `activeTools` 合成一个列表并按 path 去重，并用打字机刷新（`TypewriterText speed={15}`） | `TracePanel.tsx:100-113` | §4.4（**两家共有、我们完全没有**：用户看不出是哪一次在跑） |
| **P2** | **无出处时不要只剩一枚箭头**：要么给一句常驻摘要（WeKnora 是"折叠态只留一行 root summary"），要么至少给个可读的短句 | `TracePanel.tsx:216-223` | §1.3 第 3 条 · §4.1 |
| **P2** | **组级也记住开合**（或至少"本轮内记住"） | `ChatProvider.tsx` 的 `openGroups` | §1.3 第 6 条 |

### 5.3 明确**不建议**照抄的

| 不抄 | 为什么 |
| --- | --- |
| Kimi CLI 的"不折叠" | 那是**终端硬限制**（源码自陈 *cannot be unprinted*）；web 没有这条限制 |
| OpenHands 的"每张卡也默认收起" | 走的是全收路线，第一眼零信息；我们已经有"面板收起 + 一行摘要"，不必连单卡也收 |
| Qwen 的 edit/write/command 类型白名单 | 我们的 `phase` 只有 `tool` 一档，粒度对不上，硬搬会漏判 |
| OpenHands 的 `SuccessIndicator` | v1.24.0 里只渲染 `timeout`，success/error 分支是空的——**半成品** |
| Trae 的"执行中反复折叠" | 用户原话"AI 在干啥都不知道"；**折叠只在 turn 结束时做** |
| Trae 的统计式摘要作为**唯一**摘要 | 被开发者评为"没有营养"；要与**对象**绑定（"读取 2 个文件" 优于 "调用 2 次工具"） |

### 5.4 验收与回归锚点

改完之后，这几条已有用例必须仍然绿（它们是这次改动的护栏）：

| 用例 | 钉住了什么 |
| --- | --- |
| `tests/chat-ui.test.tsx:596-650` | kind → `[data-icon]`、同工具合并成「联网搜索 2 次」、展开组后逐条结论保序 |
| `tests/chat-ui.test.tsx:1172-1209` | 出处默认 3 条 / 展开 / 看全文就地 |
| `tests/chat-ui.test.tsx:961-973` | 「回到最新」贴底时不出现（`disabled:hidden`） |
| `tests/chat-ui.test.tsx:988-1003` | 布局红线：`flex-1 + min-h-0`、输入卡片常驻 |
| `tests/chat-model-turns.test.ts:390-446` | 分页 / 计数 / 预览阈值 |
| `tests/chat-model-turns.test.ts:594-796` | 分组、hidden、图标、老快照兜底 |
| `tests/chat-model-turns.test.ts:351-371` | 收起态记忆（`kylab-trace-open`）——**P0 要改的正是它的语义，这条用例必须同步改写而不是删掉** |
| `tests/chat-trace-refusal.test.tsx:26-62` | `outcome` 优先于句式（P1 的 `state` 映射不能破坏它） |
| `tests/chat-trace-thinking.test.tsx:74-132` | 流式中开、答完收、老消息兜底折起 |

### 5.5 还缺的一块（靠公开证据补不上，建议实测）

十二个样本的**取数**已全部完成。下面这几条是**公开证据的边界**，不是没查完——想坐实只能上手用产品：

| 缺口 | 状态 |
| --- | --- |
| CodeBuddy 工具块的默认开合与完成后行为 | **零官方依据**（已穷尽 codebuddy.ai / codebuddy.cn 全部文档与 200+ 版本发布页）——只能实测客户端 |
| 三家闭源产品"手动展开是否被自动折叠覆盖" | 仅 Trae 有间接线索（指向"不覆盖"） |
| 三家闭源产品是否有「全部展开/收起」 | 均未查到公开依据 |
| WeKnora `AgentStreamDisplay.vue` 模板全文（151KB） | raw 拉取在 ~50KB 被截断 ⇒ 聚合文案 / 折叠初值 / 自动滚动 / 是否显示耗时 均未确证（折叠**语义**已由配套测试反推确证） |
| Coze 的 reasoning slot 组件 | 源码路径未定位（Contents API 限流 + jsDelivr 体积超限）⇒ 默认开合 / 动效 / 结束行为 未查到 |
| Kimi CLI 的图片渲染、OpenHands 的 i18n 英文文案 | 未查到 |
| Kimi `show_thinking_stream` | **代码默认 `True` 与其自家 docstring 矛盾**——已如实标注，未当作结论 |

> 另：本机 shell 在本次调研全程不可用（`sandbox-local windows-acl temp grant materialization failed`），子代理因 `maxDepth 1` 不可用 ⇒ **所有调研都是 `web_fetch` 单线程完成的**，"未查到公开依据"的条目里有一部分是这个限制造成的，不全是产品没公开。

---

**与其它文档的关系**：现状取证见《[对话 UI 显示逻辑与动效 · 全量审计 v0.1](对话UI-显示逻辑与动效-全量审计-v0.1.md)》§5；agent 架构层的对标见《[Agent 与对话架构对标调研 v0.1](Agent-与对话架构对标调研-v0.1.md)》（其中已记录 DSH 的"过程折叠（最终答案常显）"、ZCode 的"工具卡按 `(kind, status, input, output)` 渲染 + 两级懒加载"）；界面取值规范见《[前端设计规范 v0.14](../规范/前端设计规范-v0.14.md)》。
