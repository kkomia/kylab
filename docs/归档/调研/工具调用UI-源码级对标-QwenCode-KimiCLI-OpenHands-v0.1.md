# 工具调用 UI 源码级对标：Qwen Code / Kimi CLI / OpenHands v0.1

- **范围**：**只查"工具调用块"这一个面**（位置与容器、单步行结构、分组聚合、默认开合、自动开合时机、用户覆盖与持久化、结果展示、思考/推理、异常态、长回合、动效、人话摘要 —— 12 维度）。
- **方法**：只用**公开可查的开源源码/文档**。优先 `web_fetch` 读 `raw.githubusercontent.com` 真实源码；每条结论标 **证据级别**：`源码级` / `文档级` / `截图级` / `推断`。查不到就写"未查到公开依据"，不编。
- **版本与取数**（每个仓库都钉了 ref，可复现）：

| 产品 | 仓库 | 读的 ref | 该 ref 的元数据 |
| --- | --- | --- | --- |
| Qwen Code | `QwenLM/qwen-code` | `main`（源码）+ `1.52.0` 不适用 | 仓库 latest release 为 `sdk-typescript-v0.1.16`（bundled CLI **0.24.6**），见 [releases/latest](https://api.github.com/repos/QwenLM/qwen-code/releases/latest)。源码依赖（Ctrl+O＝transcript）读 `main`，**未逐文件钉 SHA**，故标注为 `源码级(main)` |
| Kimi CLI | `MoonshotAI/kimi-cli` | tag **`1.52.0`** | release `1.52.0`，`published_at` 2026-09-22T10:02:17Z |
| OpenHands | `OpenHands/OpenHands` | tag **`v1.24.0`** | release `v1.24.0`，`published_at` 2026-09-25T15:09:26Z，`target_commitish` = `7dc6805406ea3c76cb4a3ce407c3c72d481b0ac6` |

> ⚠️ **先记两条会影响"照抄"判断的事实**（都是 `文档级`/`源码级`）：
> 1. **Kimi CLI（Python 版）已归档**。`1.52.0` 的 README 首行即 `# Kimi CLI (Archived)`，明写 *"This project has been archived and is no longer maintained… replaced by Kimi Code CLI"*，仓库转为只读、不再发版。→ 它的做法可以学，但**不能再当"在演进的产品"引用**（[README@1.52.0](https://raw.githubusercontent.com/MoonshotAI/kimi-cli/1.52.0/README.md)）。
> 2. **OpenHands 这个仓库现在只是前端**。根 `AGENTS.md` 明写 *"This repository is the OpenHands frontend… only the agent-canvas frontend"*，后端/工具在 `OpenHands/software-agent-sdk`。→ 凡"工具怎么执行、事件怎么产生"的问题，本仓库答不了，只能答"**前端拿到事件后怎么画**"（[AGENTS.md@1098d73](https://raw.githubusercontent.com/OpenHands/OpenHands/1098d73df42351a31b2940557efb9fe8750365c4/AGENTS.md)，`文档级`）。

---

## 一句话总览

- **Qwen Code**：三者里唯一把"工具调用块"当**独立产品面**设计的——有类型分区折叠、有每步状态字形、有耗时、有 `Ctrl+O` 全套展开屏、**思考块答完自动收成一行**，基本可以当作"终端里能做到的上限"参考。
- **Kimi CLI**：**没有折叠**。它是"Rich Live 暂存区 + 定稿即永久打印"的模型——**折不了，只能定稿**；它把精力全花在"折叠之外"：思考**默认不给你看原文**、只在末尾留一行 `Thought for Xs · N tokens`，以及审批态下的 `Ctrl+E` 全屏 pager。
- **OpenHands**：三者里唯一有**真正的 web 折叠组件**（React `useState` + 条件渲染 + `aria-expanded`），也是唯一做了**跨调用分组**的；但它的卡片**默认全收起、且每个卡片自己的开合默认也是收起**，`SuccessIndicator` 在代码里**只渲染超时图标**。

---

# 一、Qwen Code（阿里，Ink/React TUI）

**一句话定位**：把工具调用当"可折叠的会话条目"来做的终端 TUI——**按工具类型分区折叠 + 每步行带状态与耗时 + Ctrl+O 进独立全详情屏**，是"受终端限制"之下做得最接近 web 的一家。

### 12 维度表

| # | 维度 | 结论 | 证据级别 | 证据 |
| --- | --- | --- | --- | --- |
| 1 | 位置与容器 | **每次调用插一段**，且以"工具组"（`ToolGroupMessage`）为一个渲染单元；组内**按类型分区**：可折叠类（read/search/list）折成**一行摘要**，不可折叠类（edit/write/command/agent）**始终逐个**完整渲染。不是卡片（Ink 无卡片概念），是缩进的行块 | `源码级(main)` | [ToolGroupMessage.tsx](https://raw.githubusercontent.com/QwenLM/qwen-code/main/packages/cli/src/ui/components/messages/ToolGroupMessage.tsx) |
| 2 | 单步行结构 | 行 = **状态字形（2 列固定宽）+ 工具名（i18n 本地化）+ 描述（路径/命令）+ 耗时**。状态字形有明确表：`✓` 成功 / `o` 待执行 / `⊷` 执行中 / `?` 待确认 / `-` 已取消 / `x` 出错；执行中换成 `⠋⠙⠹…` 动画 spinner（80ms/帧），**被确认卡住时 spinner 冻结成 `⠏`** | `源码级(main)` | [constants.ts](https://raw.githubusercontent.com/QwenLM/qwen-code/main/packages/cli/src/ui/constants.ts)（`TOOL_STATUS`、`SPINNER_FRAMES`、`SPINNER_INTERVAL_MS`、`WAITING_SPINNER_FRAME`）、[ToolStatusIndicator.tsx](https://raw.githubusercontent.com/QwenLM/qwen-code/main/packages/cli/src/ui/components/shared/ToolStatusIndicator.tsx) |
| 3 | 分组聚合 | **合并，且合并口径按"工具类型"而不是"同一个工具名"**。摘要由 `buildToolSummary` 生成：单条有描述 → `Read a.ts`；≤3 条 → `Read a.ts, b.ts, c.ts`；>3 条 → `Read a.ts, b.ts, ... and 3 more`；多条无描述 → `Read 3 files`；混合类 → `Read 2 files, ran npm test`。**时态会变**：进行中用 `Reading/Editing/Running`，结束后用 `Read/Edited/Ran` | `源码级(main)` | [CompactToolGroupDisplay.tsx](https://raw.githubusercontent.com/QwenLM/qwen-code/main/packages/cli/src/ui/components/messages/CompactToolGroupDisplay.tsx)（`CATEGORY_TEMPLATES`、`buildToolSummary`、`isCollapsibleTool`） |
| 4 | 默认展开/折叠 | **三级、且默认值取决于类型与状态**：① 组级——read/search/list **默认折成一行摘要**；② 单步——edit/write/command/agent **默认就是完整渲染**（不折）；③ 结果——**已完成**的可折叠类工具的 string/ansi 结果**默认不渲染**（`shouldCollapseResult`），而 Shell/Edit 的结果"本身就是答案"所以始终显示。Ink 里的"折叠"= **条件渲染**（根本不画那段），不是 CSS 隐藏 | `源码级(main)` | 同上 + [ToolMessage.tsx](https://raw.githubusercontent.com/QwenLM/qwen-code/main/packages/cli/src/ui/components/messages/ToolMessage.tsx)（`shouldCollapseResult`） |
| 5 | 自动展开/折叠时机 | **失败/待确认/用户主动发起/前台 shell 聚焦/子代理终态 → 整组强制展开**（`forceExpandAll`），并给触发那一行 `forceShowResult=true` 解除结果折叠。**思考块是"流式摊开、落定收成一行"**（见 #8）。新输出：终端原生 scrollback；但开了 `ui.useTerminalBuffer`（虚拟化历史）后是**应用内视口 + 自动跟随**，`Ctrl+End` 重新贴底 | `源码级(main)` + `文档级` | ToolGroupMessage.tsx（`forceExpandAll` 的 7 个条件）；[keyboard-shortcuts.md](https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/reference/keyboard-shortcuts.md)（History scrollback 一节） |
| 6 | 用户覆盖与持久化 | **`Ctrl+O` / `Alt+T` = 展开/收起全部思考块与工具输出（可再按收起）**；`Ctrl+S` = 解除高度截断（"看更多行"）；`Ctrl+T` = 切换工具描述显示。**开合态本身不持久化**（`useState`），且官方文档明确说明"全局 compact 模式已废弃、改为 transcript 模型" | `文档级` + `源码级(设计文档)` | [keyboard-shortcuts.md](https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/reference/keyboard-shortcuts.md)；[Ctrl+O 重构设计](https://raw.githubusercontent.com/doudouOUC/qwen-code/6e877640551c0c5ef1de67a7c5a886d12ce5d3da/docs/design/ctrl-o-detail-expand/design.md)（**该设计文档在 fork `doudouOUC/qwen-code` 上，非上游 main**，仅作设计意图证据） |
| 7 | 结果展示 | 分层截断：**行数**由 `MaxSizedBox` 管，溢出画 `... first N lines hidden ...` / `... last N lines hidden ...` 并把该 box 注册进全局溢出态（这才是 `Press ctrl-s to show more lines` 提示的来源）；**字符**上限 `MAXIMUM_RESULT_DISPLAY_CHARACTERS = 1_000_000`（只防性能）；**shell 输出另有独立行数帽** `ui.shellOutputMaxLines`（默认 `DEFAULT_SHELL_OUTPUT_MAX_LINES = 5`）；**参数行**（`ui.showToolCallArgs`）被限成 `TOOL_ARGS_INLINE_MAX_LINES = 2` 行 / 1000 字符，超出显示 `… +N chars (ctrl+o)`。分类渲染：diff→`DiffRenderer`、终端 ANSI→`AnsiOutputText`+`ShellStatsBar`（`+N lines`）、图片→`TerminalImage`、todo→`TodoDisplay`、计划→`PlanSummaryDisplay` | `源码级(main)` | [MaxSizedBox.tsx](https://raw.githubusercontent.com/QwenLM/qwen-code/main/packages/cli/src/ui/components/shared/MaxSizedBox.tsx)、[ToolMessage.tsx](https://raw.githubusercontent.com/QwenLM/qwen-code/main/packages/cli/src/ui/components/messages/ToolMessage.tsx)、[ConversationMessages.tsx](https://raw.githubusercontent.com/QwenLM/qwen-code/main/packages/cli/src/ui/components/messages/ConversationMessages.tsx) |
| 8 | **思考/推理（重点）** | **独立块，且"答完自动收成一行"**。三种形态：进行中 → `∵ Thinking… 3.2s`（字形是 `BECAUSE`，body 摊开）；落定且未展开 → **一行灰斜体** `∴ Thought for 3.2s (ctrl+o to expand)`；**耗时 < 1000ms** 时文案降级为 `Thought briefly`（连秒数都不给）。`ThinkBody` 在 `!expanded` 时**直接 `return null`**——折叠就是"不画" | `源码级(main)` | [ConversationMessages.tsx](https://raw.githubusercontent.com/QwenLM/qwen-code/main/packages/cli/src/ui/components/messages/ConversationMessages.tsx)（`ThinkMessage`、`ThinkBody`、`BRIEF_THOUGHT_THRESHOLD_MS = 1_000`、`toggleKeyHint = 'ctrl+o'`） |
| 9 | 异常态 | 6 态字形区分（见 #2），**出错那一行被强制展示结果**（`forceShowResult`）；取消态**行名加删除线**（`strikethrough={status === Canceled}`）；待确认那一刻**整组展开**并把该行的确认 UI 插在它自己下面（`ToolConfirmationMessage`）；子代理等审批时给"前 3 次调用"作为上下文（`APPROVAL_CONTEXT_CALLS = 3`），未获焦点的兄弟子代理显示 `◌ Queued approval:`。重试：输入框 `Ctrl+Y` = 重试上一次失败的请求 | `源码级(main)` + `文档级` | ToolMessage.tsx、ToolGroupMessage.tsx、keyboard-shortcuts.md |
| 10 | 长回合 | **两层**：① 单条结果按行/字符截断（见 #7）；② 历史本身分页——`ui.useTerminalBuffer` 打开时用虚拟化视口，向上滚**自动加载更旧事件**（OpenHands 的同类能力是 REST 分页 50 条/页）。溢出文案是 `... N lines hidden ...`，没有"第 X/Y 页" | `源码级(main)` + `文档级` | MaxSizedBox.tsx；[AGENTS.md（OpenHands）](https://raw.githubusercontent.com/OpenHands/OpenHands/1098d73df42351a31b2940557efb9fe8750365c4/AGENTS.md)（对照项） |
| 11 | 动效 | **有，但克制**：执行中 spinner 逐帧（80ms，`⠋⠙⠹…`）；待确认时**故意停止动画**、冻结成 `⠏`（"它不是卡了，是在等你"）；思考进行中用 `∵` / 落定用 `∴` 作字形切换。**折叠/展开本身没有过渡动画**（Ink 的条件渲染天然没有），文档也承认 Ctrl+O 会"重绘整个会话" | `源码级(main)` + `文档级` | constants.ts（`WAITING_SPINNER_FRAME` 注释）、ToolStatusIndicator.tsx、keyboard-shortcuts.md |
| 12 | 人话摘要 | **有，而且是主标签本身**。`buildToolSummary` 输出的是完整自然语言句（`Read 3 files, ran 1 command`），并且**时态随状态变**（`Reading 3 files` → `Read 3 files`）。本地化走 i18n（9 种语言的模板），只有英文单动词前缀是硬编码（注释说明：描述本身是路径/命令这类语言中性文本） | `源码级(main)` | CompactToolGroupDisplay.tsx（`CATEGORY_TEMPLATES` / `pastVerb` / `activeVerb`） |

### 关键代码片段

**① 折叠 = 按类型分区；`forceExpandAll` 是"必须看得见"的安全阀**（`ToolGroupMessage.tsx`）
```tsx
const forceExpandAll =
  fullDetail || hasRenderableToolCallArgs || hasConfirmingTool ||
  hasSubagentPendingConfirmation || hasErrorTool ||
  isEmbeddedShellFocused || isUserInitiated || hasTerminalSubagent;

const collapsibleTools = forceExpandAll ? [] : inlineToolCalls.filter(
  (t) => isCollapsibleTool(t.name) && t.status !== ToolCallStatus.Canceled && !hasInlineImageOutput(t));
```

**② 结果折叠只对"信息采集类"生效**（`ToolMessage.tsx`）
```tsx
const shouldCollapseResult =
  !forceShowResult && status === ToolCallStatus.Success && isCollapsibleTool(name) &&
  (effectiveDisplayRenderer.type === 'string' || effectiveDisplayRenderer.type === 'ansi');
```

**③ 思考：落定收成一行；`<1s` 连秒数都不给**（`ConversationMessages.tsx`）
```tsx
const completedLabel = durationMs == null ? null
  : durationMs < BRIEF_THOUGHT_THRESHOLD_MS ? t('Thought briefly')
  : `${t('Thought for')} ${formatDuration(durationMs)}`;

if (!isPending && !expanded) {
  return <Text dimColor italic>{THINKING_ICON}{label} (ctrl+o to expand)</Text>;
}
...
const ThinkBody = ({ text, isPending, expanded, ... }) => {
  if (!expanded) return null;   // ← 折叠就是"不画"
```

**④ 状态字形表**（`constants.ts`）
```ts
export const TOOL_STATUS = { SUCCESS: '✓', PENDING: 'o', EXECUTING: '⊷',
  CONFIRMING: '?', CANCELED: '-', ERROR: 'x' } as const;
export const SPINNER_INTERVAL_MS = 80;
export const WAITING_SPINNER_FRAME = '⠏';   // 被确认卡住时冻结成这一帧
```

---

# 二、Kimi CLI（月之暗面，Rich/prompt_toolkit TUI，**已归档**）

**一句话定位**：**没有折叠**的流式视图——用 Rich `Live` 的 `transient=True` 做"暂存区"，工具调用跑完就**定稿永久打印到 scrollback**；它把"省地方"的力气全花在**思考默认不给你看原文**上。

### 12 维度表

| # | 维度 | 结论 | 证据级别 | 证据 |
| --- | --- | --- | --- | --- |
| 1 | 位置与容器 | **两区结构**：Rich `Live(transient=True, refresh_per_second=10)` 管一块**临时区**（未定稿的内容），`flush_finished_tool_calls()` 把**已完成的前缀**逐块 `console.print()` 到**永久 scrollback**。所以既不是"每调用插一段"也不是"一个折叠面板"，而是**"暂存 → 定稿"的传送带**。工具调用之间没有容器，就是连续的 bullet 行 | `源码级` | [_live_view.py@1.52.0](https://raw.githubusercontent.com/MoonshotAI/kimi-cli/1.52.0/src/kimi_cli/ui/shell/visualize/_live_view.py)（`visualize_loop`、`flush_finished_tool_calls`） |
| 2 | 单步行结构 | **一行 + 结果块**。行文本 = `Using <ToolName> (<关键参数>)`，**跑完把 `Using` 换成 `Used`**（一字之差就是状态）；参数由 `extract_key_argument` 抽取**一个关键参数**（路径/命令），FetchURL 还会把参数做成可点超链接。**有 token/耗时，但只给思考块**（`Thought for 3.2s · 1.2k tokens`），工具行**不给耗时** | `源码级` | [_blocks.py@1.52.0](https://raw.githubusercontent.com/MoonshotAI/kimi-cli/1.52.0/src/kimi_cli/ui/shell/visualize/_blocks.py)（`_ToolCallBlock._build_headline_text`）、[tools/utils.py@1.52.0](https://raw.githubusercontent.com/MoonshotAI/kimi-cli/1.52.0/src/kimi_cli/tools/utils.py) |
| 3 | 分组聚合 | **不合并同类调用**（同一工具的多次调用各占一行）。唯一的"计数"出现在**子代理**里：每个子代理工具调用块最多列 `MAX_SUBAGENT_TOOL_CALLS_TO_SHOW = 4` 条，超出补一行 `{n} more tool call(s) ...` | `源码级` | _blocks.py（`MAX_SUBAGENT_TOOL_CALLS_TO_SHOW`、`_n_finished_subagent_tool_calls`） |
| 4 | 默认展开/折叠 | **没有折叠这回事**（源码级）。运行中用**动画 bullet**（`_BULLET_FRAMES = (".  ", ".. ", "...", " ..", "  .", "   ")`，0.13s/帧）+ `Spinner("dots")` 作项目符号；定稿后 bullet 变成**颜色**（`green` / `dark_red`）。已打印到永久 scrollback 的内容**不可再折叠**——这是终端 scrollback 的硬限制，不是产品选择 | `源码级` | _blocks.py、_live_view.py |
| 5 | 自动展开/折叠时机 | **"自动定稿"**：`append_tool_result()` 一收到结果就 `flush_finished_tool_calls()` → 该块**离开临时区、永久打印**（此后不可变）。**失败/重试**：`StepRetry` 会**丢弃本次尝试的流式状态**（`discard_retry_attempt` 清掉未完成的 content/tool 块），并显示 `Retrying after rate limit · attempt 2/3 · 1.0s`；但源码注释坦白：**已经 flush 到 scrollback 的内容删不掉**。自动滚动＝终端原生 | `源码级` | _live_view.py（`discard_retry_attempt` docstring、`append_tool_result`、`_format_step_retry`） |
| 6 | 用户覆盖与持久化 | **唯一的"展开"键 `Ctrl+E` 只作用于审批面板**（`has_expandable_content` 为真时把全文丢进 pager），**对工具调用块无效**。注意 `Ctrl+O` 在这家是"用外部编辑器编辑输入"，**不是展开**——跨产品抄键位时这一点必须对齐。**没有任何开合状态被记住** | `源码级` + `文档级` | [_approval_panel.py@1.52.0](https://raw.githubusercontent.com/MoonshotAI/kimi-cli/1.52.0/src/kimi_cli/ui/shell/visualize/_approval_panel.py)（`has_expandable_content`、`should_handle_running_prompt_key`）；[docs/en/reference/keyboard.md@1.52.0](https://raw.githubusercontent.com/MoonshotAI/kimi-cli/1.52.0/docs/en/reference/keyboard.md) |
| 7 | 结果展示 | **两层上限都在工具侧（模型看到的也被裁）**：`DEFAULT_MAX_CHARS = 50_000` 总字符、`DEFAULT_MAX_LINE_LENGTH = 2_000` 单行，裁了就打标记 `[...truncated]` 并在 message 里追一句 `Output is truncated to fit in the message.`。渲染端按类型分：diff → 专门 panel（`render_diff_panel` / `render_diff_summary_panel`，会聚合同文件连续块并统计 `+added/-removed`）、shell → `KimiSyntax`（语法高亮）、todo → markdown 列表（`- 标题` / `- 标题 ←` / `- ~~标题~~` 表示 pending/in-progress/done）、后台任务 → `` `task_id` [status] description ``。**图片：未查到公开依据**（TUI 无内联图片渲染的证据） | `源码级` | tools/utils.py（`ToolResultBuilder`、`DEFAULT_MAX_CHARS`）、_blocks.py（`DiffDisplayBlock`/`TodoDisplayBlock`/`BackgroundTaskDisplayBlock` 分支） |
| 8 | **思考/推理（重点）** | **默认"不渲染原文"**——这是三家最反直觉、也最值得抄的一条。默认态（`show_thinking_stream` 有配置项但**代码默认 `True`**，见下方矛盾说明）：**临时区**只画一行 `Thinking .   3.2s · 1.2k tokens · 48 tok/s`（`Thinking` 斜体 + 动画点 + 耗时 + token + **实时 tok/s 心跳**）；**定稿时**只落一行灰斜体 `Thought for 3.2s · 1.2k tokens`。原文 `raw_text` **"only for token accounting and never render it"**。把 `show_thinking_stream` 设为 `false` 才切到紧凑模式；设为 `true`（**当前代码默认**）则退回"6 行滚动预览（`_THINKING_PREVIEW_LINES = 6`）+ 定稿时打印完整 markdown"。**代码默认与注释/docstring 描述相反**，见下方"已知不一致" | `源码级`（代码默认）+ `文档级`（配置项说明） | _blocks.py（`_ContentBlock` 类 docstring、`_compose_thinking`、`_compose_thinking_stream`、`_THINKING_PREVIEW_LINES`）、[config.py@1.52.0](https://raw.githubusercontent.com/MoonshotAI/kimi-cli/1.52.0/src/kimi_cli/config.py)（`show_thinking_stream: bool = Field(default=True, ...)`）、[config-files.md@1.52.0](https://raw.githubusercontent.com/MoonshotAI/kimi-cli/1.52.0/docs/en/configuration/config-files.md) |
| 9 | 异常态 | 三层：① **工具失败** → 该块的 bullet 变 `dark_red`，`BriefDisplayBlock` 文本也变 `dark_red`；② **用户拒绝** → `ToolRejectedError`，`brief = "Rejected by user"`（模型侧收到的是一句"停下来问用户"的指令）；③ **等审批** → 弹一个**黄色边框 panel**，标题 `approval`，四个选项（`Approve once` / `Approve for this session` / `Reject` / `Reject, tell the model what to do instead`），**数字键 1–4 直选**，选 "for session" 会把队列里**同 action** 的待批请求一并放行。重试：`max_retries_per_step` 默认 3，重试有独立 banner | `源码级` | _approval_panel.py（`ApprovalRequestPanel`、`_submit_approval`、`OPTIONS`）、_live_view.py（`_submit_approval` 的 `approve_for_session` 批处理）、tools/utils.py（`ToolRejectedError`） |
| 10 | 长回合 | **不截断"会话"，只截断"单次工具输出"**（#7 的 50k 字符）。回合长度由 `loop_control.max_steps_per_turn = 1000` 兜着；上下文靠自动压缩：`reserved_context_size = 50_000` 与 `compaction_trigger_ratio = 0.85` 二者先到先触发。历史本身在终端 scrollback 里，**没有分页/虚拟化** | `源码级` + `文档级` | config.py（`LoopControl`）、config-files.md |
| 11 | 动效 | **有，而且是三家最多的**：Rich `Live` 10Hz 刷新；动画 bullet（6 帧循环、0.13s/帧）；`Spinner("dots")` 作工具行项目符号；`Spinner("moon")` 作"空转"占位；`Spinner("balloon", "Compacting...")` 作压缩态。**但这些都是"暂存区"的动画——一旦定稿进 scrollback 就永久静止**（终端无法重绘历史） | `源码级` | _live_view.py（`refresh_per_second=10`、`_mooning_spinner`）、_blocks.py（`_BULLET_FRAMES`、`_BULLET_FRAME_INTERVAL = 0.13`） |
| 12 | 人话摘要 | **有，但是"模板化动词 + 一个关键参数"**，不是自然语言句：`Used ReadFile (src/main.py)`、`Used Shell (npm test)`、子代理行 `Used ReadFile (package.json)`。**时态用 `Using`/`Used` 区分**（与 Qwen 同思路、更简）。思考块的人话是 `Thought for 3.2s · 1.2k tokens` | `源码级` | _blocks.py（`_build_headline_text`：`text.append("Used " if self.finished else "Using ")`） |

### 关键代码片段

**① 折叠不存在：`transient` 暂存 + 定稿打印**（`_live_view.py`）
```python
with Live(self.compose(), console=console, refresh_per_second=10,
          transient=True, vertical_overflow="visible") as live:
    ...

def flush_finished_tool_calls(self) -> None:
    """Flush all leading finished tool call blocks."""
    for tool_call_id in tool_call_ids:
        block = self._tool_call_blocks[tool_call_id]
        if not block.finished:
            break                      # ← 只定稿"已完成的前缀"
        self._tool_call_blocks.pop(tool_call_id)
        console.print(block.compose()) # ← 此后不可变
```

**② 折叠之外的做法：思考原文默认不渲染**（`_blocks.py` 类 docstring）
```
For **thinking** (``is_think=True``), the default behavior is to keep the
raw reasoning text only for token accounting and never render it.  The
Live area shows a compact ``Thinking`` label with an animated bullet
sequence, elapsed time, token count, and a live tokens/second pulse;
when the block ends, a one-liner ``Thought for Xs · N tokens`` is
committed to history in grey italics.
```

**③ 状态用一个字表达：`Using` → `Used`**（`_blocks.py`）
```python
def _build_headline_text(self) -> Text:
    text = Text()
    text.append("Used " if self.finished else "Using ")
    text.append(self._tool_name, style="blue")
    if self._argument:
        text.append(" (", style="grey50")
        arg_style = Style(color="grey50", link=self._full_url) if self._full_url else "grey50"
        text.append(self._argument, style=arg_style)
        text.append(")", style="grey50")
    return text
```

**④ 审批面板：截断才给 `Ctrl+E`，且行数预算写死**（`_approval_panel.py`）
```python
MAX_PREVIEW_LINES = 4
...
# P1: diff pager always has context lines not shown in preview
# P2: non-diff blocks may have been truncated
self.has_expandable_content = self._has_diff or self._non_diff_truncated
...
if self.has_expandable_content and self._non_diff_truncated:
    content_lines.append(Text("... (truncated, ctrl-e to expand)", style="dim italic"))
```

### ⚠️ 已知不一致（照抄前必须知道）

**`show_thinking_stream` 的代码默认值与它自己的注释/docstring 描述相反**：
- `config.py`：`show_thinking_stream: bool = Field(default=True, ...)`
- `_blocks.py` 的类 docstring 写的是：*"the default behavior is to keep the raw reasoning text only for token accounting and never render it"*，并把 6 行预览称为 *"the legacy behavior is restored"*。

也就是说：**默认走的是"6 行滚动预览 + 定稿打印全文"（legacy），而"只留一行**（compact）**需要显式配置**。我按代码默认值记结论，并按 docstring 记设计意图（`源码级`，矛盾点已如实标注）。

---

# 三、OpenHands（前 OpenDevin，React web UI）

**一句话定位**：三者里唯一有**真正的 web 折叠组件**——连续动作/观测被折成一个**默认收起的组头**，组头在跑时显示"最新一步的人话 + `{done}/{total} actions completed` + spinner"，但**每张卡片自己默认也是收起的**。

### 12 维度表

| # | 维度 | 结论 | 证据级别 | 证据 |
| --- | --- | --- | --- | --- |
| 1 | 位置与容器 | **在消息流里（不是侧栏）**，是**组 + 卡**两级：连续的可分组事件被 `groupEvents` 折成 `EventGroup`（可折叠组头），展开后是**一张张独立的卡**（`GenericEventMessage`：标题行 + 可点箭头 + 详情）。`TaskTrackerObservation`、markdown 工件卡另走独立渲染 | `源码级` | [group-events.ts](https://raw.githubusercontent.com/OpenHands/OpenHands/v1.24.0/src/components/conversation-events/chat/group-events.ts)、[event-group.tsx](https://raw.githubusercontent.com/OpenHands/OpenHands/v1.24.0/src/components/conversation-events/chat/event-message-components/event-group.tsx) |
| 2 | 单步行结构 | 行 = **标题（人话，见 #12）+ 箭头 + 右侧状态指示**。**没有耗时、没有 token**（`GenericEventMessage` 的 props 里根本没有这些字段）。running/done 的差别**不在行内**：未完成的 action 卡右上角**什么都不显示**，完成才有 `SuccessIndicator`——而 `SuccessIndicator` 在 v1.24.0 的代码里**只渲染 `timeout` 一个状态（黄色时钟图标）**，`success` / `error` 都渲染空 span。真正的"在跑"信号在**别处**：底部 `TypingIndicator` 活动胶囊（标题即当前动作人话 + 一颗 `animate-pulse` 圆点）与组头的 `LoaderCircle animate-spin` | `源码级` | [generic-event-message.tsx](https://raw.githubusercontent.com/OpenHands/OpenHands/v1.24.0/src/components/features/chat/generic-event-message.tsx)、[success-indicator.tsx](https://raw.githubusercontent.com/OpenHands/OpenHands/v1.24.0/src/components/features/chat/success-indicator.tsx)、[typing-indicator.tsx](https://raw.githubusercontent.com/OpenHands/OpenHands/v1.24.0/src/components/features/chat/typing-indicator.tsx) |
| 3 | 分组聚合 | **跨调用的连续区间合并**，阈值 `EVENT_GROUP_MIN_SIZE = 2`（**连两个都并**）。计数文案：跑着 → `{completed}/{total} actions completed`；跑完 → `{count} actions completed`。**`ThinkAction`、`FinishAction`、hook、error、markdown 工件卡、TaskTracker 都是"分组断裂点"**（不参与合并）。**同一工具名的多次调用不特殊合并**——合并口径是"连续"而不是"同类"，这点与 Qwen 正相反 | `源码级` | group-events.ts（`EVENT_GROUP_MIN_SIZE`、`isGroupableEvent`）、event-group.tsx（`countSummary`） |
| 4 | 默认展开/折叠 | **两级都默认收起**：`EventGroup` → `useState(false)`；`GenericEventMessage` → `initiallyExpanded = false`（唯一例外：markdown 文件工件卡 `initiallyExpanded = true`，理由是"它的预览本来就是被裁过的，让工件不用多点一次就能看见"）。折叠实现是**条件渲染**（`{expanded && ...}` / `{showDetails && ...}`），带 `aria-expanded` / `aria-controls` / `role="region"` / `aria-labelledby`（a11y 比另两家都完整） | `源码级` | event-group.tsx、generic-event-message.tsx、[generic-event-message-wrapper.tsx](https://raw.githubusercontent.com/OpenHands/OpenHands/v1.24.0/src/components/conversation-events/chat/event-message-components/generic-event-message-wrapper.tsx) |
| 5 | 自动展开/折叠时机 | **有一处"随回合推进自动降级"**：组的 `isFinalized` 由"它后面还有没有别的渲染项"决定——**还是话题尾巴时**组头把"最新一步的人话"当主标题、计数降为次要；**后面又冒出内容后**主标题换成 `{n} actions completed`（`messages.tsx` 里 `const isFinalized = itemIndex < renderedItems.length - 1`）。**没有任何"答完自动收起"**——收起是默认值，展开是用户动作，代码里没有把它改回去的地方。**失败不自动展开**。自动滚动：**有**，`useScrollToBottom` 只在"用户没往上滚"时贴底（`autoscroll` 状态机：上滚关、到底开、发消息强制开），另有悬浮 `ScrollToBottomButton` 与向上滚分页加载 | `源码级` | [messages.tsx](https://raw.githubusercontent.com/OpenHands/OpenHands/v1.24.0/src/components/conversation-events/chat/messages.tsx)、[use-scroll-to-bottom.ts](https://raw.githubusercontent.com/OpenHands/OpenHands/v1.24.0/src/hooks/use-scroll-to-bottom.ts)、[chat-interface.tsx](https://raw.githubusercontent.com/OpenHands/OpenHands/v1.24.0/src/components/features/chat/chat-interface.tsx) |
| 6 | 用户覆盖与持久化 | **没有"全部展开/收起"**。开合态是组件内 `useState`，**不持久化**（换会话即丢）。该仓库对"面板开合要不要记住"有一条明确的既有决策可作参照：右侧面板开合被**刻意**做成 session-only（`isRightPanelShown` 不写 localStorage，且读取时会**剥掉**旧 blob 里的该字段）——即这家在"哪些 UI 状态该记住"上是有主张的 | `源码级` | event-group.tsx、generic-event-message.tsx、[AGENTS.md](https://raw.githubusercontent.com/OpenHands/OpenHands/1098d73df42351a31b2940557efb9fe8750365c4/AGENTS.md)（Conversation right-panel regression note） |
| 7 | 结果展示 | 详情体按事件类型分派：`resolveVisualizerBody()` 命中就用**专用 React visualizer**，否则退到 markdown（`getActionContent` / `getObservationContent`）。有些类很专门：`execute_bash`/`terminal` 走"Command: … / Output: …"文本块、`grep`/`glob` 的 `pattern` 打头（标题里还会把 pattern 截到 50 字符、命令截到 80 字符）、`task_tracking` 走专用组件、`canvas_ui` 走一句话说明。**图片**：有 `inspect_image_with_vision` 专用标题路径（`Describing image with <profile>`），前端渲染证据未逐文件确认 → **图片渲染细节标注为未查到公开依据**。**长用户消息**有一套独立的一行折叠：超过一行就折起 + 整块可点展开（`chat-message.tsx` 的 `UserMessageBody` / `data-testid="chat-message-expand"`） | `源码级`（主体）+ `未查到公开依据`（图片） | [get-event-content.tsx](https://raw.githubusercontent.com/OpenHands/OpenHands/v1.24.0/src/components/conversation-events/chat/event-content-helpers/get-event-content.tsx)、[chat-message.tsx](https://raw.githubusercontent.com/OpenHands/OpenHands/v1.24.0/src/components/features/chat/chat-message.tsx) |
| 8 | **思考/推理（重点）** | **独立块，默认收起，且不自动展开**。`CollapsibleThinking`：折叠态是一行 `💡 <THINKING$TITLE>` + 箭头，点开才 `MarkdownRenderer` 渲染全文；组件自己的注释写明理由——*"Collapsed by default so the chat stays compact — especially useful when the thinking language differs from the conversation language"*（**思考语言常与对话语言不同**，这是产品级理由）。**但并非所有思考都被收**：从 action 上"提升（hoist）"出来的思考走 `ThoughtEventMessage` → 直接复用 `ChatMessage type="agent"`，**是一段正常正文，不折叠**；`groupEvents` 会把它提升成独立渲染项并**打断分组**，免得"推理被埋在一个折叠组里"。**没有"答完自动收起"**——它从一开始就是收起的 | `源码级` | [collapsible-thinking.tsx](https://raw.githubusercontent.com/OpenHands/OpenHands/v1.24.0/src/components/conversation-events/chat/event-message-components/collapsible-thinking.tsx)、[thought-event-message.tsx](https://raw.githubusercontent.com/OpenHands/OpenHands/v1.24.0/src/components/conversation-events/chat/event-message-components/thought-event-message.tsx)、[event-message.tsx](https://raw.githubusercontent.com/OpenHands/OpenHands/v1.24.0/src/components/conversation-events/chat/event-message.tsx)、group-events.ts |
| 9 | 异常态 | 分四类：① **工具失败** → `getObservationResult()` 归一成 `success` / `error` / **`timeout`** 三态（`exit_code === -1` 或 `metadata.exit_code === -1` 判 timeout；`is_error`、`error` 字段判 error）——**只有 timeout 有专属图标**；② **Agent 级错误** → `ErrorEventMessage` 独立渲染，且是**分组断裂点**；③ **用户拒绝** → `UserRejectObservation` 被 `TypingIndicator` 用来"清账"（即拒绝也算这一动作已了结，活动胶囊不再显示它）；④ **待批准** → `pendingConfirmation` 走子代理内的 `ToolConfirmationMessage`，未获焦点的兄弟显示 `◌ Queued approval:`。**重试入口：只在用户消息发送失败时有**（`chat-message-retry` / `chat-message-dismiss`），工具失败没有重试按钮 | `源码级` | [get-observation-result.ts](https://raw.githubusercontent.com/OpenHands/OpenHands/v1.24.0/src/components/conversation-events/chat/event-content-helpers/get-observation-result.ts)、typing-indicator.tsx、chat-message.tsx |
| 10 | 长回合 | **两条独立机制**：① **历史分页**——首次只拉最近 `INITIAL_HISTORY_PAGE_SIZE`（默认 **50**）条事件（`sort_order='TIMESTAMP_DESC'` 再反转），滚到顶部 **80px 阈值**内自动加载更旧一页，并**保存 `scrollHeight` 差值把视口钉住**（否则会"跳到下面"）；② 首次加载走 REST、之后 WebSocket 以 `resend_mode='since'` 续传。**没有"第 X/Y 页"文案**，只有加载 spinner（`data-testid="loading-older-events"`） | `源码级` | [AGENTS.md](https://raw.githubusercontent.com/OpenHands/OpenHands/1098d73df42351a31b2940557efb9fe8750365c4/AGENTS.md)（Conversation history is loaded lazily）、chat-interface.tsx |
| 11 | 动效 | **有，但不是"高度过渡"**。可动的地方：组头 spinner `LoaderCircle animate-spin`、活动胶囊的 `animate-pulse` 圆点、shimmer 文字动画（`TextShimmer`，用 `repeating-linear-gradient` + `@keyframes` 移动 `background-position`，**并显式读 `useReducedMotion()` → 命中就直接退化成静态灰字**）、消息气泡 `transition-colors` / `transition-opacity duration-150`、滚动到底按钮 `transition-colors`。**折叠/展开本身没有任何高度过渡**——是条件渲染，内容直接出现/消失（这也是它和 assistant-ui `ToolFallback` 的关键差距） | `源码级` | [text-shimmer.tsx](https://raw.githubusercontent.com/OpenHands/OpenHands/v1.24.0/src/components/shared/text-shimmer.tsx)、typing-indicator.tsx、event-group.tsx、[scroll-to-bottom-button.tsx](https://raw.githubusercontent.com/OpenHands/OpenHands/v1.24.0/src/components/shared/buttons/scroll-to-bottom-button.tsx) |
| 12 | 人话摘要 | **有，而且是这套 UI 的主干**。标题由 i18n 模板 + 结构化字段拼出，例如 `OBSERVATION_MESSAGE$RUN` + `command`（截 80 字符）→ 运行类人话、`FileEditorObservation` 按 `command` 分 `READ` / `WRITE` / `EDIT` → `Reading <path>` / `Editing <path>`、`TASK` → `Running subagent <name>`、`think` → `ACTION_MESSAGE$THINK`、未知类型兜底成大写类型名。**且"正在做什么"被单独提成一条实时胶囊**：`deriveLiveActivity()` 从事件尾部倒着找第一个"还没被 observation 收掉"的 action，用它的标题当活动文案，找不到就退成 `THINKING_ACTIVITY` | `源码级` | get-event-content.tsx（`switch (observationType)`）、typing-indicator.tsx（`deriveLiveActivity`、`LIVE_ACTION_KINDS`） |

### 关键代码片段

**① 组头：跑时给"最新一步的人话 + 计数 + spinner"，落定后换口径**（`event-group.tsx`）
```tsx
const pendingAction = events.find((e): e is ActionEvent => isActionEvent(e));
const completedCount = events.filter(isObservationEvent).length;
const totalCount = events.length;
const isRunning = !!pendingAction;

const countSummary = isRunning
  ? t(I18nKey.EVENT_GROUP$ACTIONS_PROGRESS, { completed: completedCount, total: totalCount })
  : t(I18nKey.EVENT_GROUP$ACTIONS_COMPLETED, { count: totalCount });
```
```tsx
{isFinalized ? (
  <span>…<Chevron />{countSummary}</span>          // 被"翻篇"后：只报数
) : (
  <>
    <span>…<Chevron />{latestTitle ?? countSummary}</span>   // 还是尾巴：报"最新一步"
    <span>{countSummary}{isRunning ? <LoaderCircle className="… animate-spin" /> : null}</span>
  </>
)}
```

**② 卡片默认收起；唯一例外是 markdown 工件卡**（`generic-event-message.tsx` + wrapper）
```tsx
const [showDetails, setShowDetails] = React.useState(initiallyExpanded);
...
{showDetails && (typeof details === "string"
  ? <MarkdownRenderer>{details}</MarkdownRenderer> : details)}
```
```tsx
// Markdown file-editor cards carry a clipped preview; expand them by
// default so the artifact is visible without an extra chevron click.
const initiallyExpanded = !isSkillReadyEvent(event) && isMarkdownFileEditorEvent(event, correspondingAction);
```

**③ `SuccessIndicator` 在 v1.24.0 只画超时**（`success-indicator.tsx`，全文）
```tsx
export function SuccessIndicator({ status }: SuccessIndicatorProps) {
  return (
    <span className="flex-shrink-0">
      {status === "timeout" && (
        <FaClock data-testid="status-icon" className="h-4 w-4 ml-2 inline fill-yellow-500" />
      )}
    </span>
  );
}
```
> 注：AGENTS.md 的文字描述是 *"the header shows `EVENT_GROUP$ACTIONS_COMPLETED` (with a success check)"*，而 v1.24.0 的 `SuccessIndicator` 源码里 `success` 分支为空。**两者不一致，以源码为准**（已如实标注）。

**④ 思考默认收起，理由写进了注释**（`collapsible-thinking.tsx`）
```tsx
/**
 * Renders agent thinking or extended reasoning content inside a collapsible
 * section.  Collapsed by default so the chat stays compact — especially
 * useful when the thinking language differs from the conversation language.
 */
export function CollapsibleThinking({ content }: CollapsibleThinkingProps) {
  const [expanded, setExpanded] = React.useState(false);
```

**⑤ 自动滚动是"带用户意图判断"的**（`use-scroll-to-bottom.ts`）
```ts
// Turn off autoscroll only when scrolling up
if (isScrollingUp) setAutoscroll(false);
// Turn on autoscroll when scrolled to the bottom
if (isCurrentlyAtBottom) setAutoscroll(true);
const bottomThreshold = 20;   // 距底 20px 内算"在底部"
```

---

# 四、三家横向：**哪些是终端逼的，哪些是产品意图**

这一节是本次调研里最该被单独读的一节——**同一件事在终端里做不到，不等于产品不想要；照抄时抄错层会很贵。**

| 做法 | 谁这么做 | 判定 | 理由 |
| --- | --- | --- | --- |
| **已打印的历史不可折叠** | Kimi（完全做不到）；Qwen（做不到"就地折"，只能 `Ctrl+O` 进独立全详情屏） | **终端硬限制** | ANSI scrollback 一旦写出就不可重绘。Kimi 源码自己承认这一点：*"content already flushed to terminal history … cannot be unprinted"*（`discard_retry_attempt` docstring）。**web 没有这条限制**——所以"折不了"绝不构成"我们也不该折"的理由 |
| **"展开"用外部 pager / 独立全屏屏，而不是就地展开** | Kimi `Ctrl+E` → Rich pager；Qwen `Ctrl+O` → alt-screen transcript | **两者都有**：一半是限制（就地重排成本高/会打乱 scrollback），一半是**有意对齐 Claude Code 的 transcript 模型** | Qwen 的设计文档把"就地 per-block 展开"列为 **follow-up、明确不在本期**（理由是 type-based partition 下"折叠工具已聚合成单行、无 per-tool 点击目标"）。→ 这是**设计选择**，不是能力不足 |
| **折叠 = 条件渲染（不画），不是 CSS 隐藏** | Qwen（Ink）；OpenHands（React `{expanded && …}`） | **两家的共同选择** | Ink 没有 CSS，只能不画；OpenHands 是 web，**本可以做高度过渡，但它也没做**。→ **"展开没有动画"在 OpenHands 上是产品没做，不是做不到**（同一仓库里 `TextShimmer` 是做了带 `useReducedMotion` 的动画的，说明它会做） |
| **不做"同类聚合"，只做"连续区间聚合"** | OpenHands（`EVENT_GROUP_MIN_SIZE = 2`，断裂点一大堆） | **产品意图** | 它的合并口径是"这一段连续动作是一件事"，而 Qwen 是"这几个 read 是同一种活儿"。两种口径**都不假**，但**不能混用**——混用会出现"读 3 个文件"和"2 个动作"两种标题打架 |
| **思考默认不渲染原文** | Kimi（默认走 6 行预览，紧凑模式需配置）；Qwen（**流式摊开、落定收成一行**）；OpenHands（`CollapsibleThinking` 从始至终收起） | **产品意图，且三家收敛** | Kimi 的 `tok/s` 心跳、Qwen 的 `<1s → Thought briefly`、OpenHands 的"思考语言≠对话语言"注释——三家都在解决同一个问题：**思考是过程，不是答案**。这不是终端逼的（OpenHands 是 web，照样收） |
| **失败/待确认强制展开** | Qwen（`forceExpandAll` 7 个条件）；OpenHands（`pendingConfirmation` 走独立渲染 + 兄弟显示 `Queued approval`）；Kimi（审批弹独立 panel + 数字键直选） | **三家一致的产品意图（安全语义）** | Qwen 的设计文档把它点得最透：这些 `force` 条件是**"必须看见"的安全语义**，review 时误删会导致"出错的工具被折叠看不全"的回归 |
| **分组默认收起、单步默认展开（同一块里两种密度）** | **没有一家这么做**（Qwen 按类型分；OpenHands 全收；Kimi 无折叠） | — | 我们的现状（面板展开 + 组收起 + 单步收起）在三家里找不到对应做法 |
| **每行都带耗时** | Qwen（`ToolElapsedTime`，含 `(elapsed · timeout N)`）；Kimi（**只给思考块**）；OpenHands（**完全没有**） | **Qwen 是产品意图，OpenHands 是没做** | Ink 里做耗时并不比 React 容易，Qwen 做了、OpenHands 没做 → 说明这跟平台无关 |

---

# 五、与我们的现状的差异

> **我们的现状（本文以仓库既有取证为准，不重复取证）**：面板级**默认展开**且**全局记忆**（localStorage `kylab-trace-open`）；组级**默认收起**、`{n} 次`、不持久化；单步**默认收起**、被拦下/等确认**默认展开**；`TraceStep` **没有 `status`、没有耗时/ token**；单步思考**跟流式状态**（`thinkingChose ?? streaming`）；面板**答完不收起**、失败不自动展开；**没有全部展开/收起**；单步开合**跨轮串号（真 bug）**；20 条目/页 + 「加载更多」。
> 取证见 [对话 UI 显示逻辑与动效 · 全量审计 v0.1](对话UI-显示逻辑与动效-全量审计-v0.1.md) §5 与 [工具调用 UI 对标调研 v0.1](工具调用UI-对标调研-v0.1.md) §1。本次另做**源码级复核**两点：`frontend/src/features/chat/ui/TraceStepRow.tsx:60-79` 的注释自陈 *"`StepEvent` 没有'成功/失败'这一维度，拦下与跑完都是 `status: done`"*；`frontend/src/features/chat/ui/` 目录内**除 `LiveLine` 外没有任何 spinner 实现**。

## 5.1 他们比我们好的地方（按"改善了什么"排序）

| # | 他们好在哪 | 谁 | 我们缺什么 | 证据级别 |
| --- | --- | --- | --- | --- |
| 1 | **思考"答完自动收成一行"，且那一行带耗时** | Qwen | 我们**已经在做**（单步思考 `thinkingChose ?? streaming`，答完自动收起）——**但我们收起来之后那一行不带任何信息**，用户再也看不出"它想了多久"。Qwen 给的是 `Thought for 3.2s`，`<1s` 时降级成 `Thought briefly`（连秒数都不给，避免为 0.4 秒写一行字） | `源码级` |
| 2 | **每步有状态字形，且"等待"和"在跑"用不同视觉** | Qwen（6 态字形 + spinner；**等确认时故意冻结成 `⠏`**）；OpenHands（活动胶囊 `animate-pulse`） | 我们 `TraceStep` 连 `status` 字段都没有，running 与 done **行内零差别**，全靠最上面那行实时文案。**"冻结的 spinner"这一招尤其值得抄**——它把"卡住了？"和"在等你点确认"区分开了 | `源码级` |
| 3 | **分组标题会随时态换词** | Qwen（`Reading 3 files` → `Read 3 files`；`Running` → `Ran`） | 我们的组标题是静态的「联网搜索 18 次」——**跑着的和跑完的长得一样**，且第一眼零信息（不知道搜到了什么） | `源码级` |
| 4 | **"必须看得见"的条件被显式枚举成一个安全阀** | Qwen（`forceExpandAll` 7 条件） | 我们只覆盖了"被拦下/等确认"一种（靠 `outcome` + 词表），**出错、用户主动发起、前台交互**这些都没有强制展开 | `源码级` |
| 5 | **分组标题就是一句自然语言，且限长有明确口径** | Qwen（`Read a.ts, b.ts, ... and 3 more`：≤3 全列，>3 列前 2 + "and N more"） | 我们给的是 `{n} 次`，没有"读的是哪几个"；而**限长策略**（列几个、超出怎么说）我们根本没有 | `源码级` |
| 6 | **卡片有真正的 a11y 语义** | OpenHands（`aria-expanded` / `aria-controls` / `role="region"` / `aria-labelledby`） | 我们的面板头是 `div`+点击，无 `aria-expanded` | `源码级` |
| 7 | **"正在做什么"被单独提成一条实时活动文案，且有兜底** | OpenHands（`deriveLiveActivity` 倒查第一个未了结 action；查不到退成 `THINKING_ACTIVITY`） | 我们只有流式期间面板头那一行 `LiveLine`，**非流式就完全没有"它在干嘛"的表达** | `源码级` |
| 8 | **滚动是"带用户意图判断"的** | OpenHands（上滚即关自动跟随、到底自动开、发消息强制开；距底 20px 算在底） | 我们的跟随滚动是按"指纹"驱动的；**"用户往上滚了就不要再把他拽回去"这条语义**值得核对（本报告未取证我们的实现，见下方"边界"） | `源码级`（对方）+ 未取证（我方） |
| 9 | **向上滚加载更旧内容时会把视口钉住** | OpenHands（存 `scrollHeight`、加载后补差值；阈值 80px） | 我们有「加载更多」按钮（20 条目/页），是**显式点击**而不是滚动触发，因此没有这个问题——但也少了"无缝回溯" | `源码级` |
| 10 | **动画有 reduced-motion 出口** | OpenHands（`TextShimmer` 显式 `useReducedMotion()` → 退化成静态灰字） | 审计已记：我们的对话域**没有 `prefers-reduced-motion`** | `源码级` |

## 5.2 **可直接照抄的 3 条**（按性价比排序）

### 抄 1｜把"组的标题"从「`{n} 次`」改成**一句会随时态换词的自然语言**，并给"最新一步"当主标题
- **抄谁**：Qwen 的 `buildToolSummary`（口径）+ OpenHands 的 `isFinalized`（主标题切换）。
- **具体形态**（两端各取一半，合起来最省事）：
  - 进行中 → **主标题给"最新一步在干嘛"**（`正在读取 src/main.py`），右侧给 `{done}/{total}`；
  - 结束后 → 主标题换成**聚合句**：`读取 3 个文件、执行 1 条命令`（≤3 条列全名，>3 条列前 2 + 「…还有 N 个」）。
- **为什么这条排第一**：它**直接解掉我们审计里的第 1、2 条**（第一眼零信息 + 同块两种密度），而且**不需要动数据模型**——`turns.ts` 的 `group`/`label` 已经够拼出这句话；也不需要新增后端字段。
- **成本**：改 `turns.ts` 的分组标题生成 + `TracePanel`/`TraceStepRow` 的组头渲染。
- **依据**：`源码级` — [CompactToolGroupDisplay.tsx](https://raw.githubusercontent.com/QwenLM/qwen-code/main/packages/cli/src/ui/components/messages/CompactToolGroupDisplay.tsx) 的 `buildToolSummary` + `CATEGORY_TEMPLATES`；[event-group.tsx](https://raw.githubusercontent.com/OpenHands/OpenHands/v1.24.0/src/components/conversation-events/chat/event-message-components/event-group.tsx) 的 `isFinalized` 分支。

### 抄 2｜给每步行补上 **状态** 与 **耗时**，并且"等待确认"要有一眼可辨的专用视觉
- **抄谁**：Qwen 的 `TOOL_STATUS` 六态 + `ToolElapsedTime`；**"等确认冻结 spinner"**（`WAITING_SPINNER_FRAME = '⠏'`）这一招单独拎出来抄。
- **具体形态**：`TraceStep` 加 `state: running | done | failed | awaiting`（`awaiting` 可由现有 `outcome` 映射，不必等后端加字段）；行内给字形/小圆环；耗时格式抄 Qwen 的 `<1s` 不写秒数、其余 `1.2s`。
- **为什么**：这是"看得见它在干活"的最低成本改法，也是我们六个问题里的第 4、5 条。且**耗时我们前端能自己算**（running→done 两次事件的时间差），不阻塞后端。
- **依据**：`源码级` — [constants.ts](https://raw.githubusercontent.com/QwenLM/qwen-code/main/packages/cli/src/ui/constants.ts)（`TOOL_STATUS` + `WAITING_SPINNER_FRAME` 注释：*"both renderers stop animating and show this one instead"*）。

### 抄 3｜把"必须看得见"枚举成一个**单一安全阀**（`forceExpand`），并让思考收起后的那一行带上信息
- **抄谁**：Qwen 的 `forceExpandAll`（条件清单）+ `Thought for 3.2s (…to expand)` 的一行形态。
- **具体形态**：集中一处判断 `forceExpand = 出错 || 待确认 || 用户主动发起 || 前台交互中`（我们现在只有"被拦下/等确认"）；思考收起后那一行从「思考 3,329 字」补上**耗时**，与 Qwen 同款。
- **为什么把这条排第三而不是第二**：它的**收益小于前两条、但结构价值最高**——Qwen 的设计文档专门警告过：这些 `force` 条件是安全语义，**散落各处就一定会被误删**。我们现在正是散落的（`TraceStepRow` 里的 `REFUSAL_MARKS` 词表 + `outcome` 判断）。
- **依据**：`源码级` — `ToolGroupMessage.tsx` 的 `forceExpandAll`；`ConversationMessages.tsx` 的 `Thought for {duration}`。

## 5.3 明确**不建议**照抄的

| 不抄 | 为什么 |
| --- | --- |
| **Kimi 的"完全不折叠"** | 那是**终端 scrollback 硬限制**下的妥协（源码自陈"印出去就删不掉"）。我们是 web，**没有任何理由放弃折叠** |
| **OpenHands 的"每张卡片也默认收起"** | 它是"全收"路线，代价是**第一眼什么都没有**；我们的组级默认收起已经吃过这个亏（审计第 2 条）。要抄的是它的**组头在跑时给最新一步人话**，不是它的默认值 |
| **Qwen 的"edit/write/command 始终不折"颗粒度** | 它成立的前提是"这些工具的输出本身就是答案"；我们的 `TraceStep` 粒度与工具类型没有一一对应关系（`phase` 只有 `tool` 一档），**硬搬类型白名单会漏判**。先做"连续区间"与"同 group"两种口径里我们已有的那种，别引入第三套 |
| **OpenHands 的 `SuccessIndicator`（只画超时）** | 那个状态在 v1.24.0 的源码里就是个半成品（`success`/`error` 分支为空，与它自己的 AGENTS.md 描述不符）。**不要把一个半成品当标杆** |

## 5.4 本次调研的边界（没查到 / 没取证的，如实标注）

- **Qwen 的源码 ref**：我用的是 `main`，**没有逐文件钉 commit SHA**（releases 页给的是 SDK tag `sdk-typescript-v0.1.16` / bundled CLI 0.24.6，与 CLI 源码目录不对应）。若要写进正式文档，建议补一次 `main` 的 SHA。
- **Qwen 的 `ui.showToolCallArgs` 完整设置文档、`DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD` 的确切数值**：只搜到 PR/issue/commit 与设计文档的引用，**未逐字读到 settings.md 与常量定义** → 标 `未查到公开依据`（本文只用了我实际读到的 `TOOL_ARGS_INLINE_MAX_LINES = 2`、`TOOL_ARGS_INLINE_MAX_CHARS = 1000`、`MAXIMUM_RESULT_DISPLAY_CHARACTERS = 1_000_000`、`DEFAULT_SHELL_OUTPUT_MAX_LINES = 5`）。
- **Kimi 的图片/TUI 内联图片渲染**：`未查到公开依据`。
- **OpenHands 的图片渲染细节**：只确证有 `inspect_image_with_vision` 的标题路径（`Describing image with <profile>`），**前端组件本身的渲染未逐文件确认** → 标 `未查到公开依据`。
- **OpenHands i18n 的英文/中文原文字面**：`translation.json` 抓取被截断，**没有读到 `EVENT_GROUP$ACTIONS_COMPLETED` 等的实际文案** → 我引用的是**代码里的 i18n key** 与我实际读到的 `ACTION_MESSAGE$TASK`（`"Running subagent <cmd>{{name}}</cmd>"`、`OBSERVATION_MESSAGE$TASK` = `"Ran subagent …"`）。凡未读到原文的字面，**本文不写猜测文案**。
- **我们自己"跟随滚动指纹"的实现**：本报告只按仓库既有审计文档引用，**未读 `ChatProvider.tsx` 的对应实现**，所以 §5.1 第 8 条标了"我方未取证"。
- **`web_fetch` 的一处限制**：抓 `src/i18n/translation.json` 时结果被截断（另存到了本地 spill 文件），这直接导致上一条。若要补齐，应改为按 key 精确抓取或用 GitHub code search。

---

**与其它文档的关系**：现状基线见《[对话 UI 显示逻辑与动效 · 全量审计 v0.1](对话UI-显示逻辑与动效-全量审计-v0.1.md)》§5；本文是《[工具调用 UI 对标调研 v0.1](工具调用UI-对标调研-v0.1.md)》§4「逐家产品对照」里 **Qwen Code / Kimi CLI / OpenHands** 三家的**源码级**支撑材料（那份文档的 §4 当时标注"正在补齐"）。
