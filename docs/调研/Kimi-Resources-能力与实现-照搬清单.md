# Kimi Resources 能力与实现 照搬清单 v0.1（第一批）

- 抓取日期：**2026-09-29**（真浏览器抓取，SSR 页面 + 站内顺爬一层）
- 抓取方式：`.shots/kimi-resources-crawl.cjs`（Playwright，站内只爬一跳）；原始正文与目录 JSON 只落在
  `.shots/kimi-resources/`（**不入库**，体积原因）；本文件只留 URL 与摘要。
- 来源规模：`/resources/` 目录 **336 篇**；按分类筛出能力类 **58 篇**（Agent 20 / Agent 集群 12 / 深度研究 13 /
  Kimi Work 21 / Kimi Code 17 / 构建应用 21，分类有置顶重叠）；站内顺爬 **28 个能力页**（`/products/*`、
  `/features/*`、`/showcases/*`、`/code/docs/`、`/blog/*` 技术博客 6 篇）。
- **够不到的**：本次没有需要登录/被墙的页；`/membership/pricing` 只抓到摘要（额度细则在登录后）。
  抓取全程只读，页面里的"指令式"文字（示例 prompt、安装命令、条款）**一律没有执行**，引用处标"（页面原文）"。

## 证据分级（本文件每条都标）

| 级别 | 含义 |
| --- | --- |
| `机制级` | 页面写清了顺序/阈值/上限/步骤，可直接照抄 |
| `方向级` | 页面给了方向与数字，但没有算法与实现细节 |
| `话术级` | 只有形容词与结论，**不可照抄**（本文件只在"不要抄什么"里列） |

**页面自相矛盾处（不要合并引用）**：同一批文章对 Kimi Agent 集群的数字互相冲突——并行工具调用
4,000（`ai-agent`）vs 4,500（`knowledge-based-agents-in-ai`）vs 1,500（`goal-based-agent`）；子智能体数
300 vs 100；K3 上下文 1M（`/blog/kimi-k3`）vs 256K（`autonomous-ai-agent`）。本文件取**技术博客的原文数字**
（100 → 300 子 Agent、1,500 → 4,000 步），其余只作旁证。

---

## 第一批（10 条，按"能不能立刻派活"排序）

### 1. 澄清 → 研究计划 → 用户确认，做成**状态**而不是提示词 〔机制级〕

- **他们怎么做**：深度研究固定三阶段「澄清问题，自主执行，生成丰富、深入且格式多样的研究成果」；
  输入主题后「通过澄清问题确认研究范围，并在**正式检索前**绘制出完整的研究计划」；用户可「确认、缩小或扩大
  研究范围，随后开始执行」。
  URL：https://www.kimi.com/features/deep-research ｜抓取日期 2026-09-29｜正文行 19、45、73
- **我们的现状**：`backend/app/services/prompt.py:253-266` 有一段**纯提示词**判据 `_CLARIFY_BLOCK`
  （「歧义大 + 代价高，两条同时成立才问」，一次问 1~2 个）；`plan_gate.py:1-31` 的"计划门闸"只在 `plan` 档
  生效，而且**只拦写类工具**——研究型任务没有写操作，这道闸**永远不会触发**。也就是说"先给计划再执行"
  在我们这里只有提示词，没有机制、没有"待确认"状态。
- **建议怎么改（照抄，替换我们自造的部分）**：
  1. 把 Kimi 的顺序搬成状态机：`澄清（1-2 问）→ 出计划 → awaiting_plan_confirm → 执行`；计划是一次
     **可确认的产出**（复用 `approvals.py` 的通道与前端卡片），不是一段正文。
  2. `_CLARIFY_BLOCK` 的"两条同时成立"是**我们自造的形容词判据**，换成可计算判据：预计步数 > N、
     要出文件、或题目缺"范围/交付形式/口径"中的一项（N 用现成的 `tool_loop.DEFAULT_MAX_STEPS` 比例，不要新造）。
  3. `plan_gate.py` 的 `given` 判据从"这一轮以正文收尾"扩展为"计划已被用户确认"（研究型任务）。
- **落点与规模**：`plan_gate.py`（状态机 + 研究计划档）~120 行、`prompt.py`（删/改 `_CLARIFY_BLOCK`）~40 行、
  `chat.py`/`agent.py`（进入等待态）~80 行、前端复用审批卡片 ~60 行。合计 **~300 行**。
- **怎么验**：`plan_gate` 单测（新状态迁移）＋ 一条 D-03 型真会话（"帮我整理一份研究报告"）观察是否
  "先澄清 → 出计划 → 等确认 → 才检索"。

### 2. 检索停止判据：换成"够不够写一份完整报告"，删掉我们的数字阈 〔机制级〕

- **他们怎么做**：每个研究任务「执行**数十次**精准检索」；循环的停止点是「**不断迭代直到积累足够内容**
  撰写全面报告」。上下文政策另有一条：**超过阈值只保留最近一轮工具相关消息**（discard-all）。
  URL：https://www.kimi.com/features/deep-research ｜行 23、73；https://www.kimi.com/blog/kimi-k2-6 ｜行 265、268
- **我们的现状**：`prompt.py:273-285` 的 `_SEARCH_BLOCK` 是**我们自造的数字判据**：
  「先做 2~3 次精确检索」「同一事实 ≥2 个独立来源就停」「零命中最多再试两轮」。
  这与 Kimi 的"数十次检索"**方向相反**——研究型任务会被提前掐断。
- **建议怎么改**：
  1. **删掉**三个数字（2~3 次 / ≥2 来源 / 最多两轮），或降级成"起步建议"并写明"研究型任务数十次是正常的"。
  2. 停止判据改成两条**可执行**的：`产出判据`＝够不够写出一份覆盖问题各面的报告（他们的原话口径）；
     `预算判据`＝我们已有的 `tool_loop.CONVERGE_RATIO = 0.8` + `prompt.converge_note()`（如实报剩余步数/秒数）。
  3. **保留**两条可机器验证的纪律（他们官方轨迹也支持）：同一个查询不重复发；返回里已有正文就不必再抓页。
- **落点与规模**：`prompt.py:269-285` 一个块的改写 **~30-60 行** + 提示词快照单测。
- **怎么验**：同一道研究题的改前/改后对比（检索次数、交付完整度）；`tests/` 里提示词快照更新。

### 3. 止损结局要显式：预算/上下文用尽 ≠ 查完了 〔机制级〕

- **他们怎么做**：DeepSearchQA **不做上下文管理，超出支持上下文长度的任务直接计为失败**；BrowseComp
  用 discard-all；K3 的压缩在 **300K token** 触发（另一口径：1M 无管理时 BrowseComp 90.4）。
  URL：https://www.kimi.com/blog/kimi-k2-6 ｜行 265-268；https://www.kimi.com/blog/kimi-k3 ｜行 173
- **我们的现状**：`tool_loop.py:985-995` 的 `_stop_reason()` 只有两句——"本轮工具步数已用完"/
  "本轮时间已用尽"，到位后走 `_request_wrap_up()` **降级作答**；没有"未查完"这个**显式结局**。
  `subagent.py:122-135` 其实已经有 `stopped_reason`（answered/budget/timeout/error）的形状，值得推广。
- **建议怎么改**：把"因预算/上下文收尾"提升为**枚举结局**（沿用 subagent 的形状），一路带到落库与前端
  文案（"没查完"与"查完了"必须能分辨）；阈值**沿用我们现成的**：步数 30 / 墙钟 300s
  （`tool_loop.py:123,138`）、上下文 `chat.compress_at` + 绝对上限（`chat.py:53-80`），不新造。
- **落点与规模**：`tool_loop.py`（stop reason 枚举 + 事件字段）~120 行、前端过程面板文案 ~40 行。
- **怎么验**：单测枚举；真浏览器把预算打满的一轮，看收尾文案是否说明"没查完 + 还缺什么"。

### 4. 上下文压缩：我们已有两级，补它的**触发数据点**就够 〔机制级（数字）／机制我们更强〕

- **他们怎么做**：K2.6 自述「**simple context management strategy**：超过阈值只保留最近一轮工具相关消息」；
  K3 的压缩在 300K 触发。
- **我们的现状**：**比他们强**——`chat.py:82-135` 两级压缩：第一级把较早工具结果换占位符（保留最近 5 条、
  长度门槛 256 字，抄 DSH tool-result-pruner / ZCode microcompact），第二级摘要（花钱，仅第一级不够时）；
  `/compact` 手动压（`chat.py:1055-1090`）。`prompt.py:241-246` 已经写明"官方轨迹只留最近 3 次返回，我们
  第一级已覆盖"。
- **建议怎么改**：**不要**新增第三套压缩；只做两件事：(a) 把"保留最近 N 条"做成可配档（研究型任务可设
  1~3 轮，对齐他们的 discard-all）；(b) 把 300K 作为我们**绝对上限**的参照值复核一次
  （`chat.py` 的 `DEFAULT_COMPRESS_MAX_TOKENS`）。
- **落点与规模**：`chat.py` 常量 + `runtime_config.py` 文案 **~20-40 行**。
- **怎么验**：现有压缩单测 + 一个长会话的占用曲线（看阈值与压缩次数）。

### 5. 来源与发现"跨轮继承"：来源进独立集合，不进摘要 〔机制级〕

- **他们怎么做**：「Kimi 深度研究会继承首轮报告中的**上下文、来源和发现**，持续延展研究」，多轮深化
  "不必从头开始"；执行阶段**实时展示检索查询、推理步骤与 URL**。
  URL：https://www.kimi.com/features/deep-research ｜行 31、50、55
- **我们的现状**：出处走 `SourceRef` 在**单轮**里回传；跨轮只靠对话历史，而历史会被压缩（摘要会把来源压掉）。
- **建议怎么改**：把 sources 落成**会话级独立集合**（按 conversation 持久化、去重、记首次出现轮次），
  回答/报告从它取引用；`chat.py` 组装上下文时把它单独带上（与摘要并列，而非混进摘要）。字段沿用现有
  `SourceRef`，不新造。
- **落点与规模**：`services/sources.py` + `conversation.py` 存储 + `chat.py` 组装 **~200-300 行**。
- **怎么验**：单测（第二轮之后 sources 仍在且可引用）；前端出处面板跨轮可见。

### 6. 报告固定收尾：证据分级 + "缺口清单" 〔机制级（案例页写明了做法）〕

- **他们怎么做**（案例页把方法写在成果描述里）：把「**公开机制 / 外部观察 / 待验证假设**分开标注」；
  「每条论据注明出处…与**证据等级**，不以沉默作强证」；收尾表格**分清已验证结果与缺失证据**。
  URL：https://www.kimi.com/showcases/deep-research ｜行 27、34、97
- **我们的现状**：`SourceRef` 只有 `document_name` / `page`；没有 `source_type` / `evidence_level`，
  也没有"缺失证据"这一节。
- **建议怎么改**：给引用加两枚字段（`source_type`：一手/官方/媒体/个人；`evidence_level`），并在
  长回答/报告的输出格式段里固定三节：**已验证 / 待验证 / 缺失证据**。这是我们引用模型的最小扩展。
- **落点与规模**：`services/sources.py` + 模型 + `prompt.py` 输出格式段 + 前端引用渲染 **~150-250 行**。
- **怎么验**：快照单测 + 一份真实研究报告（三节齐全、引用可点）。

### 7. 长文按"章节所有权"分工再合并 〔机制级〕

- **他们怎么做**：40 篇 PDF → 100 页综述：把任务拆到文档集上，**多个写作子 agent 各自认领特定章节**，
  输出合并并带完整格式化引用。
  URL：https://www.kimi.com/blog/agent-swarm ｜行 72
- **我们的现状**：`subagent.py:52-59` 明说今天的子 Agent 是「一次检索 + 一次作答」，**没有任何工具面**、
  深度固定 1；长文只能由主 Agent 顺序写完。
- **建议怎么改**：先做数据结构、不急着真并行：父 Agent 产出**章节清单** → 每章一个子 Agent 任务
  （带 `section` 字段与"只写这一节"的边界）→ 合并时校验引用完整、去重。现有 `spawn_subagent` 串行也能跑。
- **落点与规模**：`subagent.py`（任务/结果加 `section` + 合并校验）+ `agent_tools.py` spawn 参数 **~150-250 行**。
- **怎么验**：单测（章节任务与合并规则）+ 一篇长文端到端（章节不重不漏、引用完整）。

### 8. 两级 fan-out 与并发宽度（我们的 spawn 一次只派一个）〔方向级〕

- **他们怎么做**：「先派子 agent 定义领域，再自主创建 100 个子 agent 并行检索」；K2.5 100 并行 /
  1500 次调用 / 比串行快 4.5×；**自己写明路线图：子 agent 直连通信与"并行宽度动态控制"当时尚未提供**；
  K2.6 扩到 300 子 agent / 4,000 步。
  URL：https://www.kimi.com/blog/agent-swarm ｜行 47-49、54、62、92；https://www.kimi.com/blog/kimi-k2-6 ｜行 215
- **我们的现状**：`subagent.py:50` `MAX_DEPTH = 1`；`agent_tools.py:756` 的 `spawn_subagent` 一次派一个；
  并行只发生在**同一批工具调用**之间（`tool_loop.py:228` `MAX_PARALLEL_TOOLS = 5`，分组见 `tool_meta.parallel_groups`）。
- **建议怎么改**：(a) 把 `spawn_subagent` 标成并发安全（`tool_meta.py:191` 现在是 `side_effect_scope="session"`），
  让模型能在同一批里派多个子 Agent，上限沿用现成的 5；(b) 结果继续带 `stopped_reason`；(c) **照抄他们的诚实边界**，
  在能力说明里写清"暂不支持子 Agent 直连、并发宽度固定"。
- **落点与规模**：`tool_meta.py` + `agent_tools.py`/`tool_loop.py` **~100-150 行**。
- **怎么验**：单测（一批两个 spawn 并发，结果按调用顺序回灌）+ 实测两路检索的耗时对比。

### 9. 技能：SKILL.md + frontmatter + 渐进式披露 + 三条"录制"入口 〔机制级〕

- **他们怎么做**：
  - 载体是 **SKILL.md**（YAML frontmatter；**渐进式披露**），可从自定义技能**导出 .md**；
  - 三条录制通道：「把操作录成技能」（演示一遍）、「把会话存为技能」（已完成会话的流程沉淀）、
    「把网页变成技能」（解析网页结构，把固定查询/筛选整理成 **skill 和 CLI**）；
  - 用法：`/` 唤出技能商店 → 安装 → `/技能名` 激活（例 `/okr-strategist`、`/value-investing-scorecard`）；
  - **获取技能共三条路径**（多篇措辞逐字一致，是官方统一话术）：① `/` 商店安装；② 提示词里贴
    **GitHub 仓库 URL**，Kimi 自动下载/配置并要你点"添加到我的技能"；③ **文档转技能**（上传文件生成，可编辑、可导出 .md）；
  - **装谁的技能两种形态**：Kimi Work **桌面端**才能"上传技能文件"（技能商店 → 自定义技能 → 上传技能），
    网页版只能**粘贴技能 URL**；**插件装好后不会在每次对话里自动调用，必须在输入框打 `/` 显式选**（这条决定了提示词要不要写"先看有没有可用技能"）；
  - 上传限制（少见的硬数字）：docx/xlsx/pdf/pptx + 截图，**最多 3 个文件、每个 ≤100 MB、生成 20–30 分钟**；
  - 上传限制（少见的硬数字）：docx/xlsx/pdf/pptx + 截图，**最多 3 个文件、每个 ≤100 MB、生成 20–30 分钟**；
  - 生态侧已有**依赖图与 lint**（`skills-md-graph` 抽依赖并标循环引用、`skill-graph` 用图替代单体
    SKILL.md 以省上下文、`skillscan-lint` 查悬空引用）。
  URL：https://www.kimi.com/products/kimi-browser-extension ｜行 25、29-39（通道）；
  https://www.kimi.com/resources/fashion-design-skills-for-agents ｜行 31-32、71-81；
  https://www.kimi.com/resources/research-writing-skills ｜行 68；
  https://www.kimi.com/resources/data-visualization-skills-for-agents ｜行 67-70
- **我们的现状**：`skills.py`(670) / `skill_market.py`(749，**已支持含 `name` 的 SKILL.md 压缩包导入**，
  `skill_market.py:417-443`) / `skill_sources.py`(1026) + 前端能力页；**缺**三件：从"会话/操作轨迹"生成技能、
  技能依赖图与 lint、技能导出。
- **建议怎么改**：先做**"把一次成功的会话固化成 SKILL.md"**——原料我们全有（`session_events.py` 只追加事件日志
  + 工具轨迹）；frontmatter 取 `name/description/when_to_use` 三项（与 ZCode/DSH 已有口径一致，别新造字段名）。
  再做依赖字段与 lint（照 `skills-md-graph` 的规则）。
- **落点与规模**：`skills.py` + `skill_market.py` + 前端能力页，拆两步各 **~300 行**。
- **怎么验**：单测（从轨迹生成 SKILL.md → 解析回读 → 技能列表出现）；一次真会话生成并复跑。
- **⚠️ 照抄注意**：他们**自己的文档里技能名就不一致**（表格写 `okr-planner`、正文让装 `okr-strategist`；
  `chart-gen` vs `chart-image`；`cashflow-valuation` vs `discounted-cashflow-model`）——以正文的 `/命令` 为准，
  或先验证再抄。

### 10. 主动执行/定时的边界必须显式写清 〔机制级〕

- **他们怎么做**：Kimi Work 的定时任务**在本地桌面跑**，必须"在预定时间保持应用和设备处于运行状态"，
  应用关闭/设备休眠/关机导致错过执行时间时**不会补执行**；Kimi Mira 的定时任务**在云端按计划执行，
  不受用户电脑是否开机限制**，`/stop` 可中断，职责提案**超 72 小时未处理自动取消**。
  URL：https://www.kimi.com/resources/kimi-for-windows ｜行 190（错过不补跑）；
  https://www.kimi.com/resources/kimi-mira-introduction ｜行 113
- **我们的现状**：`cron.py`(224) / `schedules.py`(349) / `schedule_runner.py`(279) 已有定时与调度
  （`schedule_runner.py:156` 给定时任务绑了 `spawn_subagent`，`schedule_runner.py:205` 复用对话那条压缩链）；
  **"错过是否补跑 / 重入 / 失败通知"这三条语义我没在代码里找到明确口径**（待核）。
- **他们日程配置的字段清单**（可直接当我们调度器的字段表）：创建有**手动/对话两种模式**（对话模式生成配置后
  可先微调再启用）；任务描述必须写清**信息来源、处理要求、输出格式、最终结果保存位置**；运行后在
  **任务历史**看输出与执行状态；改指令/时间/输出格式**自动应用到后续执行，不必重建任务**；
  触发内容可以是"调 LLM Agent"也可以是"跑 Python/Shell 脚本"（任务体与调度层解耦）。
  URL：https://www.kimi.com/resources/ai-automation ｜行 154-178、185-201；
  https://www.kimi.com/resources/ai-workflow-automation ｜行 116-128
- **建议怎么改**：照抄他们的默认——**错过不补跑**（更可预期），要补跑另开显式开关；把三件事写进任务页与文档：
  触发时进程不在怎么办、上次没跑完时这次是否重入、失败怎么通知。
- **落点与规模**：`schedule_runner.py` + `schedules.py` + 前端任务页 **~150-250 行**。
- **怎么验**：单测（错过窗口 / 重入）+ 真机（关掉后端一小时再开，看是否按"不补跑"处理）。

---

## 我们自造的判据 → 用 Kimi 的替换（这批最直接的收益）

| 我们自造的东西 | 位置 | 与 Kimi 的冲突 | 替换成 |
| --- | --- | --- | --- |
| 「歧义大 + 代价高，两条同时成立才问」 | `prompt.py:253-266` | 是形容词判据；Kimi 是固定阶段（澄清→计划→确认） | 状态机 + 可计算触发（第 1 条） |
| 「先 2~3 次精确检索」 | `prompt.py:273-285` | 与"每任务数十次检索"相反 | 删数字；改用"够写完整报告 + 预算收敛"（第 2 条） |
| 「同一事实 ≥2 个来源就停」 | 同上 | Kimi 没有这条阈值（只有"引用数十条可追溯来源"） | 降级为起步建议，不作硬停止 |
| 「零命中最多再试两轮」 | 同上 | Kimi 未公开同类阈值 | 保留"换路子"精神，删轮数上限，交给预算闸 |
| 预算用尽 → 降级作答 | `tool_loop.py:985-995` | Kimi 对超限任务**直接判失败**并如实说 | 显式结局枚举（第 3 条） |

## 不要抄什么（`话术级`，列出来免得有人当真）

- 「设置即忘，全天候自动化」「像人一样浏览互联网」「借助集群智能」——`/products/kimi-work`（无拆分/并发/合并细节）。
- 效率数字（文档"周期缩短 90%、反馈效率 3x"、表格"创建速度 +90%、每月省 25+ 小时"、PPT"Awwwards 级别"）
  ——`/features/docs`、`/features/sheets`、`/features/websites`（**无口径与方法**）。
- 安全承诺（"严格的安全协议""行业标准加密 + 持续监控"）——`/features/docs`、`/features/sheets`（无可验证机制）。
- Agent 集群的"self-organizing / it designs itself"——`/blog/agent-swarm`（方向明确，**自组织算法未公开**）。
- 案例页的本地化承诺（"文稿只存本地""投票状态存本机"）——只出现在案例描述里，不是产品级机制说明。

## 抓到但**不是**能力/实现类的（只进目录，不逐篇摘）

- `/resources/` 其余 **278 篇**是营销教程（PPT 模板、生日贺卡、演讲题目、Excel 公式…），
  完整清单在 `.shots/kimi-resources/index.json`（336 条 title+url）与 `by-category.json`（分类）。
- 评测类技术博客（PerceptionBench / WorldVQA）不是产品能力，但有两件可抄的**评测纪律**：
  按能力维度切分内部基准、报最弱项而非只报总分（K2.6 的 Claw Bench 五域、K3 的 Kimi Design Bench 四类、
  PerceptionBench 十类、WorldVQA 九类 + Head/Tail 分层）。

## 第二批候选（还没写进本文件，抓取已完成）

`agent-harness`（harness 六步循环 / 三层分工 / 构建清单，论文与基准数字最多）、
`parallel-agent`（任务队列 / 状态隔离 / 阶段门控 / 结果契约 / 所有权边界）、
`agentic-ai-architectures`（七种拓扑选型表 + 五条反模式）、`multi-agent`（五拓扑 + 框架对比 + 故障模式）、
`kimi-code-introduction` + `ai-coding-workflow`（CLI 全命令 / 9 步工程流程 / 长任务状态写进仓库）、
`kimi-work-dashboard` + `/blog/kimi-k3`（Widgets/Dashboard：把交互组件与持久视图落在会话里）、
`organize-files` / `ai-automation` / `ai-workflow-automation`（自动化的触发与边界）、
`/code/docs/`（双协议接入 / 模型档位 / API Key 上限 5 个）。

## 本次调研的边界

- 只读了 `/resources/` 与其一跳内的站内页；**没有**读登录后页面、**没有**读 API 文档之外的实现代码。
- 所有"他们怎么做"都来自**页面自述**，没有独立复现；页面自述与实测可能不一致（尤其集群规模数字）。
- 我们没有照抄任何原文；本文件是摘要 + 关键句短引（≤1 行）+ 行号，代码与注释将来由我们自己写。
