# Agent 与对话架构对标调研 v0.1（ZCode / DeepSeek Harness / QwenPaw）

- 日期：2026-09-23
- 动机：用户对 KYLAB 的 agent 能力与对话系统不满意，明确要求「**直接照抄成熟的**——
  agent 流、工具流、技能系统、插件市场、UI 交互、agent 模式、agent 命令、上下文添加」。
- 方法：**读本机安装的真实源码**（只读），三家各一路子代理，按同一张八项清单逐条对照。
- 配套：[开发计划 §12.225](../计划与记录/开发计划-v0.1.md)（照抄的执行计划）、
  [Agent-工作区与能力层设计 v0.1](../设计/Agent-工作区与能力层设计-v0.1.md)

**证据分级**（本报告里每条都标了）：
`源码级` = 读的是未压缩源码，结构与语义都可信；
`字符串证据` = 从打包压缩产物里 grep 出的常量/枚举/文案（枚举可信，函数体语义是推断）；
`配置级` = 从运行期配置与目录结构读出的事实。

| 系统 | 版本 | 源码在哪 | 可读性 |
| --- | --- | --- | --- |
| ZCode | 本机安装版 | `F:\zcode\resources\glm\`（`packages/*` 未压缩 + `zcode.cjs` 14MB 压缩） | 插件/技能**源码级**，内核**字符串证据** |
| DeepSeek Harness | 0.1.7（包版本 0.1.5-rc.1） | `C:\Users\小又\.dsh\profiles\node_modules\@deepseek-ai\`（**249 包，全部未压缩**） | **源码级** |
| QwenPaw | 1.1.6 | `F:\QwenPaw\Lib\site-packages\qwenpaw\` + `agentscope` 框架 | **源码级** |

---

## 一、八项对照总表

| 方面 | ZCode | DSH 0.1.7 | QwenPaw 1.1.6 | KYLAB 现在 |
| --- | --- | --- | --- | --- |
| agent 流 | 有界 for + `maxTurns`，终止原因是**枚举返回值**；空闲超时 30s + 可重试白名单 + 重连锚点 | turn/step **两层**，`kick(){while(turn())}`；唯一闸门 `agent/pre-step` 返回 enter/reject；取消保留已交付文本 | `ReActAgent.reply()` + `max_iters`（默认 **100**）；无墙钟；中断补假 tool_result | 单层工具循环（步数 30 / 墙钟 300s）；中断不发假结果 |
| 工具流 | 元数据六字段（`readOnly/destructive/concurrentSafe/sideEffectScope/riskLevel/needsApproval`）；并行只给 `concurrentSafe && scope=="none"`，上限 10 | `defineTool({name,description,parameters})` + JSON Schema **子集强校验**；`executionMode` **fail-closed**；`tool/call`+`tool/result` 事件对 + seq 关联 | 函数即工具（docstring+注解生成 schema）；**全仓串行**（`parallel_tool_calls` 从不开启）；失败包成文本回灌 | 全部工具**一并并发**（`_execute_batch`），无安全分类；失败回文本 ✓ |
| 技能系统 | `SKILL.md` + 扁平 frontmatter（`name/description/when_to_use/license/metadata`）；六层发现、深者优先；**只注入 名+250 字描述+路径** | 目录 bundle `SKILL.md` 或扁平 `<name>.md`；必填 `name/description`；坏文件 warn 忽略；catalog **完整替换** | 目录 + `SKILL.md`（必填 name/description，可选 `metadata.qwenpaw.emoji/requires.{bins,env}`）；三层（内置/用户池/工作区 manifest） | 有 `skills/` 目录与 `list_skills`/`read_skill` 工具 ✓，但**没有描述级 catalog 注入** |
| 插件市场 | manifest 只强制 `name`；`.zcode-plugin/plugin.json`；组件靠**目录约定**；状态与内容分离（启停/屏蔽写用户 config）；官方市场 `zcode-plugins-official` | manifest = `package.json` 的 `dsh` 字段；profile = **有序 bundle patch 层栈**，`cordis.patch.yml` 按 id 整行替换；`dsh plugin --profile <name> <pnpm args>` | 目录 + `plugin.json`（必填 id/name/version）；`register(api)` 四类能力（provider/hook/控制命令/工具配置）；**没有在线市场** | 只有「技能」一档，没有插件包格式与市场 |
| UI 交互 | 工具卡 = **（kind, status, input, output）**；大输出 slice/snapshot 两级懒加载；上下文仪表**按来源分解**；快捷键可重绑定 + 冲突检测 | Host→RPC→client modules→**slots** 四层；过程折叠（最终答案常显）；乐观提交 + 权威覆盖；聊天视图与轨迹视图分离 | SSE（POST + `text/event-stream`）+ 后台 run + **环形缓冲 reconnect 重放**；审批靠消息 metadata 标记 | 过程面板 + 出处折叠（v0.41 刚做）；无上下文仪表；无懒加载 |
| agent 模式 | 四档 `build/edit/plan/yolo`（+`auto` 预留），**模式只是权限引擎的一个参数** | preset = **每会话一套插件的组合文件**（standard/ptc/cordis/minimal），**创建时固定、空会话才能切** | 三维度：plan 门闸（未出计划禁其它工具）/ mission 外层循环 / agent 模板 | 无模式概念（沙箱策略四档算半个） |
| agent 命令 | md 文件即命令（文件名即命令名），扁平 frontmatter，`$ARGUMENTS`/`$N`；first match wins | `ctx.commands.register()` 重名即抛；三种派发 kind；**执行写 session log 但不进模型历史** | 三类命令（会话/控制/守护）**进 LLM 之前短路**，优先级 0/10/20/30；插件可注册 | 无斜杠命令 |
| 上下文添加 | `@` 多分类统一搜索；**严格区分「上传附件」与「引用工作区文件」**；条目带 source/tokens；两级压缩（微压缩清旧工具结果 → 摘要） | `@` 只做引用**不预读**；附件内容寻址、事件里不落 base64/路径；两级压缩（`tool-result-pruner` 先剪 → 再摘要），压缩结果入 log | 附件落地后**把本地路径写进消息文本**；人设 md + 滚动摘要；工具结果单独裁剪并可 offload 到文件 | 无 @ 提及；有上下文压缩（阈值 70%）；工具结果不裁剪 |

---

## 二、逐项：它们怎么做 + 我们抄什么

### 1. agent 流

**ZCode（字符串证据）**：`for(;n<e.maxTurns;n+=1){ …模型…executeTool… }`；步数 `y1a=5`（legacy）、
子代理 `maxTurns ?? 4`、schema 上限 200。终止原因是**枚举**：
`success|cancelled|error_max_turns|error_max_budget|error_during_execution|error_max_tool_calls`。
流式分块到 `text_delta/thinking_delta/input_json_delta/tool_input_delta`；差 30 秒没事件就断
（`MODEL_STREAM_IDLE_TIMEOUT`），可重试集合 `stream_idle_timeout|rate_limited|server_error|network_error|timeout`；
断流后按**锚点**续（`stream_recovery_anchor_*`）。会话是**只追加事件日志**：
`Session{Created,Resumed,Forked,Compacted,ModeChanged}` / `Turn{Started,InputReceived,Complete,Error}` /
`Model{Request,Streaming,Complete,Error}` / `ToolCall{Scheduled,Started,Progress,Result,Error}` /
`ToolBatchComplete` / `CompactBoundary`+`MicrocompactBoundary` / `CheckpointCreated`。

**DSH（源码级）**：`dsh-agent-loop/lib/index.js`：`ReactLoopAgent.kick()`(879) `while (await this.turn())`；
`turn()`(920) → `step()`(1008)：`preStep()` → `step/start` → `agent/request` 瀑布 → LLM 流 → 工具组 → `step/end`；
`turnEnds` 状态机 completed/blocked/error/aborted/max-tokens。闸门只有一处 `agent/pre-step`，
返回 `{kind:'enter'|'reject'}`。取消时保留**用户已看到的可见前缀**（`interruptedBlocks()`），
给未派发的调用补合成结果。`resume()` 只回放日志；`request/header` 只在首请求/配置变/工具变/压缩后重写（护 KV cache）。

**QwenPaw（源码级）**：`agentscope/agent/_react_agent.py`：`for _ in range(self.max_iters)`
里固定顺序 `_compress_memory_if_needed → _reasoning() → _acting()×N`；无工具调用即 break；
`max_iters=100`（无墙钟）。中断时给每个未完成 tool_use 伪造
`"The tool call has been interrupted by the user."` 保证消息配对不坏；
每轮 finally `save_session_state`（JSON 落盘）。外层还有 mission 循环读磁盘 `prd.json` 的 `all_passed` 收敛。

**抄什么**
1. **会话 = 只追加事件日志**（ZCode 的第一条）。它一旦定下，过程面板、断流续跑、
   插话、压缩、审计、分享**全变成对同一份日志的读操作**。KYLAB 已有 `chat_messages`
   与 `steps` 快照——P1 把它升级成 `session_events`（append-only），`steps` 变成它的投影。
2. **终止原因是枚举返回值**，不要用异常区分"没预算"与"崩了"；前端按枚举渲染不同重试入口。
3. **流式空闲超时 + 可重试白名单 + 重连锚点**：KYLAB 现在一次网络抖动就整轮失败。
4. **取消/中断要补齐未完成调用的结果**（QwenPaw 那条假 tool_result）：否则下一轮消息不成对，
   OpenAI 兼容端点会 400。
5. 闸门收成**一处**（DSH `agent/pre-step`）：步数、时间、模式、审批都在这一个函数里判，
   而不是散在循环各处。

### 2. 工具流

**ZCode（字符串证据）**：每个工具一张元数据表——
`{name, description, inputSchema, outputSchema, handler, readOnly, destructive, concurrentSafe, timeoutMs, maxOutputBytes, sideEffectScope, riskLevel, needsApproval, formatModelContent, permission}`。
实例：`Read` = readOnly+concurrentSafe+scope:none+risk:low；`Write/Edit` = scope:workspace+risk:medium+needsApproval；
`Bash` = scope:system+risk:high+needsApproval。`sideEffectScope ∈ none|session|workspace|system|network`。
并发判定：`concurrentSafe && !destructive && !needsApproval && !alwaysAsk && scope==="none"`，上限 10。
结果与错误**分事件**（`ToolCallResult` / `ToolCallError`）。审批记忆分级：
always / session / project / exactCommand / commandPrefix。

**DSH（源码级）**：`dsh-tools`：`defineTool()`(837) + `assertSupportedJsonSchema`（只允许 JSON Schema 子集，
越界抛 `UNSUPPORTED_SCHEMA`）；`executionMode()`(2951) **fail-closed**（未声明/抛异常一律 exclusive）；
`DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10`；exclusive 是**排序屏障**，`commitReady()` 按模型顺序提交；
`tools/pre-execute` / `tools/post-execute` 瀑布可拦；`ctx.approval.request()` **one-shot、fail-closed**，
`approval/asked`+`approval/decided` 必须 turn 内成对写审计。

**QwenPaw（源码级）**：`@toolkit.register_tool_function` 装饰器，用 **docstring + 类型注解**生成 JSON schema；
失败统一包成 `ToolResponse([TextBlock("Error: ...")])` 回灌，绝不炸循环；
**全仓串行**（框架支持 `parallel_tool_calls` 但从不开启）；审批 = `asyncio.Future` 阻塞 + 消息
metadata `tool_guard_approval` 驱动前端卡片 + `/approval approve|deny` 命令双通道。

**抄什么**（**这是最该先抄的一块**）
1. 给每个工具补一张**元数据表**：`readOnly / destructive / concurrentSafe / sideEffectScope / riskLevel / needsApproval`。
   它一次性回答了三个问题：**哪些能并行、哪些要问用户、哪些能审计**——而且同时是"给模型看的描述"
   与"给引擎用的策略"，模型行为与系统约束天然一致。
2. **并发只对安全工具放行**（KYLAB 现在把所有调用一并并发，写类工具会互相踩）。未声明的**默认串行**（fail-closed）。
3. 授权记忆分级（`always / session / project / exact-command / command-prefix`）——体验差异最大的一处细节。
4. 工具结果与工具错误**分事件**，界面才能区分"业务失败"与"管道失败"。
5. schema 收成**受支持的子集**并在注册时校验（DSH `assertSupportedJsonSchema`），越界当场报错。

### 3. 技能系统

**ZCode（源码级）**：目录 + `SKILL.md`；frontmatter 扁平 `key: value`，识别 `name/description/when_to_use/license/metadata`；
缺 `name`/`description` 或描述 > 1024 字符**直接丢弃**。发现六层（显式根 → `~/.zcode/skills` → `~/.agents/skills`
→ 工作区 `.zcode/skills`（逐级上溯，**越深越优先**）→ 工作区 `.agents/skills` → 启用的插件根），first match wins。
进提示词的是 meta-user system-reminder：`- {name}: {description - when_to_use} (file: {path})`，
描述截断 250 字、整段预算 2 万字符；**正文按需加载**（`Skill` 工具，`sideEffectScope:"session"`）。

**DSH（源码级）**：`dsh-skill-filesystem` 扫 project/custom/user 根 + chokidar 热更新；
`dsh-tool-skill` 首个请求前注入 durable catalog（名字 + 截断描述），catalog 变更**完整替换**（不 diff）；人可 `/技能名` 直接注入。

**QwenPaw（源码级）**：`skills_manager.py` 三源（包内置 / 用户池 / 工作区），工作区有
`workspace-skill-manifest.v1`（`enabled/channels/source`）；`Toolkit.get_agent_skill_prompt()`
只给 `## {name}\n{description}\nCheck "{dir}/SKILL.md"`；`metadata.qwenpaw.requires.{bins,env}`
声明依赖并在调用时注入环境变量；`/<skill_dir_name> <input>` 把整份正文塞进用户消息。

**抄什么**
1. `SKILL.md` + 扁平 frontmatter 是**跨工具事实标准**（`~/.agents/skills` 被 Claude/Codex/Cursor 共用），
   KYLAB 照抄白捡生态；校验前置（缺字段/超长直接丢弃并报错），别让坏技能静默进提示词。
2. **渐进披露**：平时只把「名字 + 250 字描述 + 路径」花约 2 万字符预算塞进提示词，正文按需取。
   KYLAB 现在没有描述级 catalog（模型要先 `list_skills` 才知道有什么），这一步的收益最大。
3. 发现顺序保留"用户 → 工作区逐级上溯（深者优先）→ 插件"，同级 `.zcode` 先于 `.agents`（KYLAB 可类比自己）。
4. 技能可声明 `requires.{bins,env}` 并在调用时注入；`/<技能名>` 显式注入正文比让模型翻更省更稳。

### 4. 插件市场

**ZCode（源码级）**：manifest 探测顺序 `.zcode-plugin/plugin.json` → `.claude-plugin/…` → `.codex-plugin/…`；
必填仅 `name`（`^[a-z0-9][a-z0-9._-]{0,127}$`），可选 `version/description/commands/skills/hooks/mcpServers/userConfig`；
组件靠**目录约定**（`skills/`、`hooks/hooks.json`、`.mcp.json`）而不在 manifest 写路径；
**状态与内容分离**：仓库只读、启停/配置/屏蔽写用户 config；内置插件**幂等物化 + 版本变更才刷新 + 屏蔽标记**；
市场 `marketplace.json = {name, plugins[], pluginRoot?}`，source 支持 `directory|github|git|url|git-subdir`（**不支持 npm/pip**），
跨市场依赖 `name@marketplace` 需显式放行。

**DSH（源码级）**：插件元数据 = `package.json` 的 `dsh` 字段（`dsh.bundle.patch` 指向 `cordis.patch.yml`）；
profile = **有序 bundle patch 层栈 + 用户层**，patch 是 `- insert:` 行列表 `{id, name, config, disabled, group, isolate}`，
**按 id 定位整行替换（非 merge）、后写覆盖、行序无语义**；`dsh --dump-config` 看合成结果；
`dsh-host-plugin-inventory` 是对外只读投影。

**QwenPaw（源码级）**：`plugins/` 有 `PluginManifest/PluginLoader/PluginRegistry/PluginApi`；
`plugin.json` 必填 `id/name/version`，`entry.{backend,frontend}`；后端模块导出 `plugin` 并实现 `register(api)`
（provider / 生命周期 hook / 控制命令 / 工具配置四类能力）；装完把新工具同步进各 agent 的 `builtin_tools`
但**默认关闭**；**没有在线市场**（在线市场在技能侧 clawhub.ai）。

**抄什么**
1. manifest **只强制 `name`**（其余全可选）+ **目录约定发现组件** + **状态与内容分离**——安装门槛低、出错面小。
2. **内置插件幂等物化 + 屏蔽标记**（伪装卸载）：省掉一堆迁移脚本。
3. 插件能力面先收窄到四类（provider / hook / 命令 / 工具配置），加载时机由宿主掌控。
4. 市场源做成可插拔 URL 解析器（`directory|github|git|url|subdir`），先不碰 npm/pip。
5. 反面教材：ZCode 的插件级权限声明很弱（`userConfig.sensitive` 都无法在 UI 录入）——
   我们**先把密管做出来**再谈插件市场。

### 5. UI 交互

**ZCode（UI 字符串）**：工具卡渲染只靠**（kind, status, input, output）**四元组，kind 是固定语义枚举
（读取/搜索/写入/编辑/删除/终端/技能/会话上下文/消息/回复/任务输出/停止任务/待办），**不是工具名**——
所以工具加几十个 UI 不用改。大输出两级懒加载：`{shown}/{total} 条工具调用` + `{toolCount} 个调用仅预览 {previewBytes}/{fullBytes}`。
上下文仪表 `上下文已用 X / 总量 Y` 且**按来源分解**（消息/系统提示词/技能/工具提示词/系统工具/MCP/其他）+ `cacheHitRate` + 一键压缩。
快捷键**可重绑定**（作用域 输入框/全局、录制、冲突提示、恢复默认）。审批弹窗带"拒绝理由"输入框。

**DSH（源码级）**：Host(`dsh-host-webserver` 静态 SPA + 单一 fallback) → RPC(`dsh-client-connection`) →
client modules（`__DSH_BOOT__` 增量 scan + 惰性 CJS 模块表）→ React slots（`dsh-client-ui-renderer/-layout/-chat/-trajectory/-tool` 各自独立插件）。
**过程折叠**（最终答案常显）、**乐观提交 + 权威覆盖**（本地 transcript 立即显示，权威记录到达后原子消失）、
聊天视图与轨迹视图分离（`-chat` vs `-trajectory`，后者是"回合感知的事件账本 + 时间轴"）。

**QwenPaw（源码级）**：SSE（`POST /api/console/chat` + `text/event-stream`）+ **后台 run + 环形缓冲 + `reconnect` 重放**；
事件 envelope 只有 `object: response|message|content` + `status: created|in_progress|completed`，
少量自定义 type；审批靠消息 `metadata.message_type` 标记驱动前端组件；计划单独一条广播通道喂侧边栏。

**抄什么**
1. **工具卡按（kind, status, input, output）渲染**，kind 用固定语义枚举而非工具名。
2. **大输出两级懒加载**（先 slice 后 snapshot）——长会话不至于把 DOM 撑爆。
3. **上下文仪表按来源分解** + 一键压缩（用户才知道该删谁）。
4. **过程折叠 + 最终答案常显**；长任务用 **SSE + 环形缓冲 + reconnect 重放**（KYLAB 已有 SSE，
   缺的是"后台跑 + 可重放"这一半 —— 这正是 v0.41 那条"切页不丢"要做到底的东西）。
5. 审批弹窗必须有**拒绝理由输入框**（agent 自我纠正最高性价比的输入）。

### 6. agent 模式

**ZCode（字符串证据 + UI 字符串）**：`permissionMode ∈ build|edit|plan|yolo`（`auto` 已进枚举未实现，
报 `"Auto mode is reserved but not implemented yet"`）。语义：build=变更前确认 / edit=自动编辑 /
plan=先给计划再动手 / yolo=少确认全放行。**模式不影响工具是否存在，只喂权限引擎**：
`allow(tool, …, "mode.yolo", "Yolo mode bypasses permission prompts")`；
plan 模式由 `resolveExecutionState → {mode, planEnabled}` 表达，`EnterPlanMode/ExitPlanMode` 工具记录
`previousMode/mode/planEnabled`，退出时弹"批准"。切换发 `SessionModeChanged`（带 previousMode）。

**DSH（源码级）**：preset = 「**每会话一套插件的组合文件**」（`preset.yml` + `agent.cordis.yml`），
出厂 standard/ptc/cordis/minimal；**创建会话时固定，只有空会话能切**；决定本会话的 tools/prompt sections/skills；
同 preset 会话共享一份已装组合但**状态隔离**（realm/scope）；加载失败的 preset 也列出并附原因。

**QwenPaw（源码级）**：三个正交维度而不写子类——plan 模式（`plan.enabled` + `set_plan_gate` 门闸：
未出计划前只允许 `create_plan`，其它工具被拦并回灌错误文案）、mission 模式（外层循环 + 把 shell/write/edit
移进 `mission_impl` 组并 `update_tool_groups(active=False)` **禁用**）、agent 模板（default/local/qa 决定
初始技能 + 工具集 + 人设）。

**抄什么**
1. **模式是权限引擎的一个参数，不是工具的开关**（ZCode）——否则每加一个模式要改所有工具。
2. 四档命名直接照抄：`plan / build / edit / yolo`（语义正交：只读与否 × 确认粒度 × 是否放行）。
3. **计划模式必须有门闸**（QwenPaw）：没出计划前禁掉写类工具，并把"为什么被拦"回灌给模型。
4. 模式切换发**带 previousMode 的事件**（撤销/审计/前端动画免费）。
5. 会话级 preset（DSH）：把"这个会话能用哪些工具/技能/提示词段"落成一个组合文件，创建时固定。

### 7. agent 命令

**ZCode（字符串证据 + 文档级）**：内置表 `{name, summary, usage, details[]}`：`/help /login /logout /compact /init
/expert /fork /mcp /mode /model /rewind /skill /workflow /effort /locale /plugins /new /resume /goal`；
其中 `/skill [<name> [task]]` 会**重写下一条 prompt** 强制先加载技能。自定义命令 = 一个 `.md` 文件
（**文件名即命令名**，`^[a-z0-9][a-z0-9_:-]{0,63}$`），扁平 frontmatter 识别
`description/argument-hint/allowed-tools/model/skills/disable-noninteractive`；`$ARGUMENTS`/`$1..$N`，
**有参数但正文无占位符时自动追加 "User arguments:"**；嵌套目录用冒号（`review/code.md` → `/review:code`）；
去重按归一化名 first match wins（用户级 > 工作区级 > 插件级）。

**DSH（源码级）**：`ctx.commands.register(definition)`（重名即抛）；三种派发 kind
（`leadingInput` / `CommandUiSpec` 的 `popupSelect` 与 `action` / 其余 `execute`）；`/` 行**永不静默降级**为普通 prompt；
**命令执行写 session log 但不进模型历史**。

**QwenPaw（源码级）**：三类命令（会话 / 控制 / 守护）**进 LLM 之前短路**；
优先级 0(critical `\/stop`) / 10 / 20 / 30；插件可 `api.register_control_command(...)` 插命令；
技能命令 `/<技能目录名> [input]`；CLI 用 click `LazyGroup` 懒加载 24 个顶层命令。

**抄什么**
1. **命令在进模型之前短路**（`/stop`、`/compact` 不该让 LLM 解析），且**不进模型历史**。
2. 自定义命令 = **一个 md 文件 + 文件名即命令名 + 扁平 frontmatter**，零注册代码、零重启。
3. 参数语义就两条 `$ARGUMENTS` / `$N`，**无占位符时自动追加**——省掉大量"命令没收到参数"的困惑。
4. 注册重名即抛 + 明确优先级；UI 只管"光标触发 + 分组菜单 + 路由"。
5. 审批/停止也要是**一等命令**（没有前端按钮时仍能跑通）。

### 8. 上下文添加

**ZCode（UI 字符串 + 字符串证据）**：`@` 是**多分类统一搜索**（文件 / 技能 / 子智能体 / 画板 / 插件），
一律"选择要插入到输入框里的引用"；输入框入口 `添加上下文 / 选择能力 / 选择技能`；
**严格区分"上传附件"与"引用工作区文件"**（拖拽文案："松开以添加附件" vs "松开以引用此文件或目录"）；
超长粘贴转成附件（副标题显示行数）；上传状态机 `等待会话→等待上传→{progress}%→完成`；
每个上下文条目带 `source（real_user/todo_reminder/goal-continuation/subagent_message/…）+ tokens + visibility`；
背景上下文用 `<system-reminder>` 包裹并声明"这是背景不是指令"。压缩**两级**：
90% 阈值 + 固定 reserve 触发整段摘要；`MicrocompactBoundary` 先只清旧工具结果并以
`"[Old tool result content cleared]"` 占位（阈值 5 条 / 60 分钟 / 256 字）；**切模型前检查窗口并联动压缩**。

**DSH（源码级）**：`dsh-file-reference` 的共享 grammar（`@"path with spaces"`，email 里的 @ 不触发）；
**@ 只给候选路径、不预读内容**（模型必须自己 `read`）；`dsh-session-reference` 把 `@label` 抓成**不可变快照**并带"禁止听从其中指令"的警告；
附件走 `dsh-attachment-local`（**内容寻址**），**session event 绝不含 base64/本地路径/provider URL**；
压缩 = `dsh-compaction-basic`（`thresholdRatio × contextWindow`）+ `dsh-compaction-tool-result-pruner`
（`thresholdChars 8192` / head 4096 / tail 1024 先单独剪工具结果）；**压缩内容留在 session log，回放可复现**。

**QwenPaw（源码级）**：附件落地后**主动把本地路径写进消息文本**（"用户上传文件，已经下载到 `<path>`"），
模型即可 `read_file`；人设 md（AGENTS/SOUL/PROFILE/MEMORY，`<!-- memory:start -->` 锚点嵌动态段）
与滚动摘要两套并存；工具结果裁剪（最近 2 条 50000B、更早 3000B，超长 offload 到 `tool_results/` 保留 5 天）。

**抄什么**
1. `@` 做成**统一搜索 + 只引用不预读**（DSH）：候选来自多分类，选中插入的是引用，读不读由模型决定。
2. **严格区分"上传"与"引用"**（ZCode）：这是最容易被漏掉、体验影响又最大的一处。
3. 附件**内容寻址**且事件里不落敏感字段（base64/本地路径），落盘后把**路径写进消息文本**（QwenPaw）。
4. **两级压缩**：先剪旧工具结果（占位符标注），不够再整段摘要——成本差一个数量级。
5. 每个上下文条目记 `source + tokens`，压缩/计量/分享时区别对待；阈值用"比例 × 窗口 + reserve"。
6. **切模型前检查上下文窗口并联动压缩**（多模型产品迟早要踩）。

---

## 三、只能抄三样的话

**第一：会话的只追加事件日志 + 显式 turn 状态机（§2.1）。**
它决定了后面所有功能的形状：过程面板、断流续跑、插话、分支、压缩、审计、分享**都是对同一份日志的读操作**。
KYLAB 用 FastAPI，这就是一张 append-only 表 + SSE 推送，实现成本极低；反过来先写业务再补日志，
上面每个能力都会变成独立补丁。（这也是 v0.41 那条"切页不丢"要做到彻底时的天花板。）

**第二：工具元数据表即权限策略表（§2.2）。**
六个字段一次回答"哪些能并行、哪些要问用户、哪些能审计"，而且同时是给模型看的描述与给引擎用的策略，
模型行为与系统约束天然一致。**KYLAB 现在把一批调用一律并发，写类工具会互相踩**——这条既是架构也是 bug 修复。

**第三：SKILL.md + 插件的双层声明与分层发现（§2.3/§2.4）。**
这是从"一个 agent 应用"变成"一个平台"的最便宜路径：格式是跨工具事实标准（用户已有的技能零改造搬进来）；
渐进披露（名 + 250 字描述 + 路径）控制上下文成本；分层发现让"个人偏好 / 团队规范 / 第三方扩展"共存不打架。

**为什么不是别的**：UI 与上下文添加的每个细节都能在前两条落地后**增量补**；
模式本质是权限引擎的参数（跟着第二条）；斜杠命令价值高但可后置，且它与技能系统在 ZCode 里本来就是同一套
（发现顺序、frontmatter 解析规则完全一致）。

---

## 四、本次调研的边界

- **只读**：未改任何被调研系统的文件，未执行 git 操作。
- 证据分级已在各处标注：ZCode 内核（`zcode.cjs` / `app.asar`）是压缩产物，
  其**枚举与常量可信**，函数体的运行期语义（如并行判定链、错误回滚路径）属推断，未逐行验证。
- 三家的**联网/模型侧实现**另有专文：[工具调用限制调研](工具调用限制调研-v0.1.md)（含 DSH 的服务端搜索路线）。
- **没查的**：ZCode 的 renderer 只有 i18n 表可读，具体组件树与状态管理未追；DSH 的桌面壳（Tauri/Rust）
  属第三方仓库，只作参考；QwenPaw 的前端是构建产物，源码未随包发布。
