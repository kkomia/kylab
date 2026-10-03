# Agent 暴露机制：对标与落点 v0.1

> 写这份文档的来由：用户问「目前 skill 和工具列表的暴露机制我们做设计没有」。
> **技能有设计**（两段加载 + 字符预算 + 条数上限，见下），**工具没有**。
> 本文档做两件事：① 把"别人怎么做"按阵营与模式落档；② 把"我们现在实际发出去多少、有哪些控制、
> 缺什么"用**实测数字**写清楚。**本轮不改任何产品代码**（方案齐了统一排期）。
>
> 出处说明：三种阵营与五条模式的**要点由用户转述**（原文文档尚未到手，到手后按条补 URL 与行号）；
> 我们能直接引的只有 Kimi 深度研究那一份（`docs/调研/Kimi-Resources-能力与实现-照搬清单.md` 里有 URL）。
> 本仓库自己的数字全部是**实测**（探针与原始输出在 `.shots/exposure/`）。

---

## 一、三个阵营

| 阵营 | 代表 | 暴露风格 | 关键差别 |
| --- | --- | --- | --- |
| Coding Agent | **Claude Code**（事实标准）、ZCode、DSH | 核心工具**完整 schema 常驻**，长尾工具**延迟发现**（ToolSearch 一类）；技能=索引常驻 + 正文触发加载 | 工具数量几十个，因而需要"分层暴露"这一层机制 |
| 消费级助手 | Kimi 深度研究、豆包、Qwen Chat | **流程固定**（澄清 → 计划 → 确认 → 执行），工具面**按场景收敛**；技能/插件按需唤起 | 暴露控制更多体现在**流程**上，而不是工具表裁剪 |
| 工作流平台 | Dify / Coze / n8n 一类 | 工具/插件**按节点装配**，用户显式挑；运行期只有被挑中的那些 | "装配"发生在设计期，运行期天然是小集合 |

## 二、五条通用模式

1. **分层暴露**：核心工具给完整 schema；长尾工具只给名字，模型用 **ToolSearch / 工具检索** 延迟发现。
   （Claude Code 阵营的做法；对我们的意义见第四节第 1 条）
2. **索引 / 实体分离**：技能只常驻 `name + description`（索引），**正文在触发时才加载**（实体）。
   这条已是跨工具标准——Claude Code 的 Skills、ZCode、DSH、QwenPaw 都这么做；
   **我们照的就是这一套**（`chat.py:692-707` + `skills.py:438-473`）。
3. **按调用者过滤**：同一个 Agent 面按调用者收窄。典型是**子 Agent 只拿被分配的子集**
   （探索型子 Agent 只给只读工具）。
4. **四层作用域合并**：用户级 → 项目级 → 插件自带 → 内置；**同名谁覆盖谁是暴露设计里最容易出 bug 的地方**。
5. **暴露 ≠ 授权**：模型看得见不等于能执行；审批/权限独立成层，不靠"少给它看几个工具"来兜安全。

## 三、对我们的落点（用户口径）

- **内置工具量级本来就在 10 个以内 → 不需要 ToolSearch 那一层的复杂度**。
  （实测：不是一个"工具很多"的处境，真正多的是**技能**：本机 **176 条可用技能**。）
- **Skill 的"索引 + 按需"是最经济的扩展方式**：加 100 个 skill 只增几百 token 的目录开销。
- **按场景 / 租户装配工具子集**（商业化产品控成本与风险）——**排队，不在本轮**。
- **记忆工具必须常驻**：被延迟发现就等于没有记忆。
- **ToolSearch 不做**（工具数不够多是前提）；**按租户装配排队**。

## 四、四条核对（数字与 file:line）

### 4.1 内置工具到底几个、是不是全常驻

**结论：23 个（知识库关）/ 36 个（知识库开）；全部常驻，没有任何清单级裁剪。**

装配点只有一处：`agent_tools.tool_specs()`（`backend/app/services/agent_tools.py:545`），
顺序是**内置 → 技能 → 本机能力 → 记忆 → 外部 MCP**。线上形状在
`backend/app/services/llm.py:458-472`（`tools: [{"type":"function","function":{…}}]` + `tool_choice: "auto"`）。

| 装配 | 工具数 | 线上 `tools` JSON 字符 | 估 token | 只读工具 |
| --- | --- | --- | --- | --- |
| 知识库**关**（`kb_ids=[]`） | **23** | **13,171** | **5,666** | 13 个 / 5,687 字符 / 2,392 token |
| 知识库**开**（`kb_ids=[…]`） | **36** | **19,395** | 8,300+ | 22 个 |

- 多出来的 13 个 = `_KB_TOOLS` 的 10 个（`agent_tools.py:529-542`）+ `_LOCAL_KB_TOOLS` 的 3 个
  （`list_tables` / `query_table` / `ingest_file`，`agent_tools.py:399`、`:590-598`）；
- 最贵的几个工具（线上字符数）：`export_table` 1,373、`export_document` 857、`create_note` 829、
  `schedule_task` 803、`export_file` 769、`export_deck` 688、`run_command` 651、`write_memory` 595；
- **没有截断/裁剪**：`tool_specs` 里只有"按开关整族增删"，没有任何"太多就截断"的代码
  （对比技能那边的 `CATALOG_BUDGET_CHARS` / `MAX_CATALOG`）。

### 4.2 记忆工具是否常驻

**结论：常驻，但有两个明确的开关会让一部分记忆工具整轮消失。**

常驻集里确实有它们（kb 关那一档，逐项实测）：

| 工具 | 在不在 | kind | 说明 |
| --- | --- | --- | --- |
| `recall` | ✅ 常驻（**但见下面的门控**） | search | 记忆检索 |
| `remember` | ✅ 常驻 | write | 写一条记忆 |
| `read_memory` | ✅ 常驻（**但见下面的门控**） | read | 展开 `recall` 给的片段 |
| `write_memory` | ✅ 常驻 | write | 写人设/记忆文件 |
| `read_skill` | ✅ 常驻 | skill | 技能按需取正文 |
| `list_skills` | ✅ 常驻 | skill | 列出技能 |

**会让它们整轮消失的门控（两条）**：

1. **记忆开关关掉**：`agent_tools.py:502` `_memory_on()` 为假时，
   `_MEMORY_SWITCH_TOOLS = {recall, read_memory}`（`agent_tools.py:427`）**从工具表里消失**，
   而 `remember` / `write_memory` 仍在（`:567-578`、`:602-610`）——
   即"能写但读不回"这一档是真实存在的状态；
2. **知识库开关关掉**：`_KB_TOOLS`（10 个）与 `_LOCAL_KB_TOOLS`（3 个）消失（`:566-579`、`:590-598`）。
   与记忆无关，但同属"整族消失"这一类。

`read_skill` / `list_skills` **不在任何门控里**：技能目录每个请求都注入，取正文的入口也一直在
（这正是模式 2 成立的前提）。

**按模式 / 权限档隐掉工具：没有。** `tool_specs()` 的签名里没有 mode / permission 参数
（只有 `owner_id` 与 `kb_ids`）；模式与权限只在**执行那一刻**判
（`tool_loop.py:794-811` `_approval_for`、`modes.py:272-285`）。
这一条是**对的**（对应模式 5：暴露 ≠ 授权），如实记录。

### 4.3 技能作用域合并与同名覆盖

**结论：三层（不是四层），先出现的赢，有用例钉住；同名不会进两行。**

| 层 | 目录 | 代码 |
| --- | --- | --- |
| 1. 仓库自带（等价"内置"） | `<repo>/skills` | `skills.py:338`、`:354` |
| 2. 数据目录（KYLAB 用户池，等价"用户级"） | `<data>/skills` | `skills.py:355` |
| 3. 跨工具共享池（等价"用户级"的另一处） | `~/.agents/skills` | `skills.py:341`、`:356` |

- **没有**"项目级"与"插件自带"这两层：`skills.py:27`、`:345-357` 明确写了裁成三层
  （"技能是部署级能力"）；插件那条路只有命令/工具（`plugins.py`），不产技能。
- **谁覆盖谁**：`skills.py:359-384` —— 先出现的赢（builtin → data/skills → ~/.agents/skills），
  唯一例外是**被丢弃的不遮蔽能用的**（`:369-372`）。
- **有没有用例钉住**：有。`tests/unit/services/test_skills.py:735`
  `test_shadowing_order_is_builtin_then_user_then_agents`（顺序）、
  `:485 test_a_dropped_skill_does_not_shadow_a_usable_one`（丢弃不遮蔽）、
  `:110`（"同名时以随代码发布的那份为准"）。
  另有一处**不在本问题里但相关**：命令/技能命令面的 `shadowed_by`
  （`commands.py`、`api/v1/skills.py:80-114`）——列表里被遮蔽的也留着并写明"被谁遮蔽"。
- **实测（探针 D 段）**：三层各放一个 `dup-skill` → `list()` 里只剩 1 条（`source=builtin`），
  目录里**恰好 1 行** `- dup-skill:`，另两条层独有技能都在 → **没有"两条同名同时进目录"的风险**。

### 4.4 按调用者过滤

**结论：只做了一半——MCP 那一段按 `owner_id` 过滤；内置工具不按调用者过滤；
子 Agent 干脆没有工具面。**

- MCP：`agent_tools.py:611-612` → `_mcp_specs`（`:642`）→ `services.mcp.available_tools(user_id=owner_id)`，
  只列调用方自己有权限用的那些（`:553-555`）；
- 内置工具：`tool_specs` 的 `owner_id` **不影响**内置那几段（同一个 tool_meta 对谁都一样）；
- **子 Agent：没有工具面**。`services/subagent.py` 全文没有 `tools=`；
  `chat.py:1374-1415 run_subagent_text()` 只把问题与库范围交给 `run_subagent`，
  子 Agent 自己走"检索 → 作答"（`subagent.py:114` 的 `max_searches` 是它的搜索预算，不是工具表）。
  也就是说**模式 3 我们只对上了一半**：没有"给子 Agent 一个只读子集"这回事。

**最小切片建议（只写方案，不实现）**：
给 `build_runner` 的 `subagent=` 那一处传一个**显式只读子集**
——`read_file` / `search_files` / `list_files` / `read_skill`（必要时加 `search`，但它是 KB 门控的），
实现上只需在 `SubAgentTask` 上带一个 `tools: Sequence[ToolSpec]` 并让 `run_subagent` 用它；
**不要**把整张工具表塞进去（那就等于给子 Agent 开了写权限与执行权限）。
与排队中的第 15/16 条一起排。

## 五、我们现在的暴露量（构成表）

**口径**：token 用项目自己的 `chat.estimate_tokens`（`chat.py:1681-1691`：中日韩 1 字 ≈1 token、
其余 4 字符 ≈1，**刻意偏高**）；字符是 `json.dumps(..., ensure_ascii=False)` 的长度。
仪表那一份来自 `chat.context_usage()`（`chat.py:1155-1234`），它与线上 payload 的口径略有差别，
两栏都给。

| 项 | 字符 | 估 token | 占压缩预算 120,000 | 占窗口 1,000,000 |
| --- | --- | --- | --- | --- |
| 工具表（**线上 payload 实测**） | 13,171 | **5,666** | 4.72% | 0.57% |
| 工具表（我们仪表那口径 `_tool_spec_text`） | 11,330 | 5,206 | 4.34% | 0.52% |
| 技能目录（176 条里**实际进目录 60 条**） | **17,300** | **4,557** | 3.80% | 0.46% |
| **暴露合计（工具 + 技能）** | **30,471** | **10,223** | **8.52%** | **1.02%** |
| 系统提示词 | 1,710 | 1,267 | 1.06% | 0.13% |
| 记忆与人设 | 2,729 | 1,836 | 1.53% | 0.18% |
| **一轮固定开销合计** | — | **12,938** | **10.78%** | 1.29% |

- 运行时窗口设置是 **`chat.context_window = 1000000`**、`chat.compress_at = 70`、
  `chat.compress_max_tokens = 120000` → `compress_budget = min(1,000,000×70%, 120,000) = 120,000`
  （`chat.py:78-81 compress_budget`）。**"12 万"是现在真正绑住的那个数**；
  默认常量 `DEFAULT_CONTEXT_WINDOW = 65536` 只在没设过设置项时生效（那时预算是 45,875）。
- 也就是说：**每轮光"工具表 + 技能目录"就吃掉 8.5% 的压缩预算**，而它**不随对话长短变化**。

## 六、机制清单（我们已有的暴露控制，逐条给落点）

| # | 机制 | 落点 |
| --- | --- | --- |
| 1 | 技能两段加载：目录常驻 + 正文按需（`read_skill`） | `chat.py:692-707`、`skills.py:438-473`、`agent_tools.py:78+` |
| 2 | 目录**字符预算** 20,000（超了 break，不写半行） | `skills.py:124`、生效处 `skills.py:467-468` |
| 3 | 目录**条数上限** 60 | `skills.py:132`、生效处 `skills.py:452` |
| 4 | 每条描述 / 何时用 截断 250 字 | `skills.py:119`、`skills.py:296-298` |
| 5 | `used_by_prompt` 判据（关掉的 / 被拦的 / 被丢弃的都不进） | `skills.py:182-183`、`:373-383`、`:545/:553` |
| 6 | 安全扫描拦下不注入（私钥 / 令牌 / 注入模式） | `skills.py:150-165`、`:553` |
| 7 | 技能正文不常驻（只有目录） | `chat.py:1278`、`skills.py:450` |
| 8 | 知识库开关 → 整族收走 13 个工具 | `agent_tools.py:566-579`、`:399`、`:529-542`、`:590-598` |
| 9 | 记忆开关 → `recall` / `read_memory` 消失 | `agent_tools.py:427`、`:502`、`:567-578`、`:602-610` |
| 10 | MCP 工具**按调用者**过滤（+ 缓存，不每轮握手） | `agent_tools.py:553-555`、`:611-612`、`:642+` |
| 11 | 对话门去掉导出工具的 `knowledge_base_id` 参数 | `agent_tools.py:626-639` |
| 12 | 线上工具形状（`tools` 数组 + `tool_choice=auto`） | `llm.py:458-472` |
| 13 | `tool_meta.side_effect_scope` **只参与权限/审批**，不参与裁剪 | `tool_meta.py:105`、`:224 meta_of`、`modes.py:272-285` |
| 14 | 权限/模式**不隐藏工具**（只在执行那一刻判） | `tool_specs` 无 mode 参数；`tool_loop.py:794-811` |
| 15 | 暴露量有仪表（工具/技能分别算 token） | `chat.py:1155-1234`（`context_usage`）、`chat.py:1681` |

## 七、缺口（明确写"没有"的那几条）

1. **工具表没有任何清单级预算/裁剪**：没有字符上限、没有条数上限、没有按场景/租户装配。
   唯一"减"的机制是**按开关整族隐藏**（知识库、记忆）。→ 对应模式 1、3 的"我们这半边空着"。
2. **技能条数上限是静默丢弃**：本机 **176 条可用技能，进目录 60 条，116 条被丢掉**，
   不告警、不记录、界面上也看不出来（`/skills` 列表列全部 177 条）；
   排序只有"内置优先 + 名字字母序"（`skills.py:373`），**没有优先级/使用频率/时效**——
   被丢掉的是字母序靠后的那 116 条（fractal、frontend-design、…、ios-code-audit…）。
3. **`_catalog_line` 不压平换行** → 一条技能可以吐出多行目录项：
   本机 `data/skills/financial-analysis/SKILL.md` 的 `description: |` 带 markdown 列表，
   于是 **60 条技能渲染出 62 个 `- ` 行**，多出来的 "Comps Analysis"/"DCF Model" 会被模型当成
   两个技能名（读不到正文）。这同时是"往目录里塞假条目"的一个口子
   （安全扫描只查密钥/令牌模式，不查结构）。落点 `skills.py:292-303`。
4. **没有"暴露量"阈值与告警**：目录 + 工具表 ~10.2k token 的固定开销随技能数增长，
   而没有任何地方在它超过某个比例时说话（仪表是只读的）。
5. **子 Agent 完全没有工具面**（模式 3 只对上一半）——见 4.4 的最小切片建议。

## 八、三分类（已对齐 / 缺 / 只排队）

**已对齐（有设计、有落点、有实测）**

- 模式 2「索引 / 实体分离」：技能目录常驻 + 正文按需 —— 两段加载、字符预算、条数上限、`used_by_prompt`、
  安全扫描、`read_skill` 入口全在（第六节 1-7 条）；
- 模式 4「作用域合并」：三层 + 先到先得 + 丢弃不遮蔽，且有用例钉住（4.3）；
- 模式 5「暴露 ≠ 授权」：权限/审批不靠隐藏工具实现（第六节 13-14 条）；
- **记忆工具常驻**（`recall`/`remember`/`read_memory`/`write_memory` 都在，门控只有记忆开关与库开关两条）。

**缺（本轮列出、待排期）**

- 工具表的清单级预算 / 按场景装配（模式 1、3 的工具侧）；
- 技能条数上限的**可见性**（丢了哪 116 条、为什么丢）与**优先级**（现在只有字母序）；
- `_catalog_line` 压平换行（一条技能一行）；
- 暴露量的阈值告警；
- 子 Agent 的只读工具子集（4.4 的最小切片）。

**只排队（明确不做）**

- ~~**ToolSearch / 延迟发现**：内置工具 23~36 个，不在"工具太多"的处境里~~
  → **用户已裁定：要做**（见第九节，本轮已实现）。上面这条结论是本文档 v0.1 第一版按
  "工具数不够多"推的，**已被推翻**，留在这里是为了记下判据变过：
  真正要控的不是"工具多到模型记不住"，而是**每轮的固定注入成本 + 外围能力的风险面**；
- **按租户装配工具子集**：商业化要的那一档，等产品口径（与"按场景装配"同一批）；
- **四层作用域里的"项目级 / 插件自带"两层**：现在裁成三层是刻意的（技能是部署级能力），
  要加的话先定"插件能不能带技能"。

---

**证据**（都在 `.shots/exposure/`，gitignore）：
`probe_exposure.py`（四段探针：工具表 / 目录放大 / 口径占比 / 同名覆盖）、
`exposure.json`（原始数字）、`probe_catalog_lines.py` + `catalog-lines.json` + `catalog-real.txt`
（目录行数、被丢掉的 116 条、"一条技能多行"的取证）。

> 上面第五~七节的数字是**改造前**的基线（工具 23 个 / 13,171 字符 / 5,666 token；
> 技能 176 条里进目录 60 条）。改造后的数字在第九节，两组可以直接对照。

---

## 九、设计：核心常驻 + 外围可发现（v0.57，**已实现**）

用户裁定（原话口径）：**核心工具肯定常驻**；**外围技能和工具延迟发现**；
**"目前工具没有接列表"**（注册表内部有、没用来做暴露）→ 要补。
本文档第一版按"工具数不够多"推的"不做 ToolSearch"**已被推翻**（见第八节那条划掉的）。

### 9.1 核心 / 外围的划分依据（**一处定义**）

**判据两条**：**是不是每轮都可能用到** + **有没有替代物**。

落点只有一处（不在别处再抄一份名单）：

| 东西 | 落点 | 说明 |
| --- | --- | --- |
| 外围名单 | `tool_meta.py` 的 `PERIPHERAL_TOOLS` | 24 个（导出 4 / 笔记 2 / 本机执行与派活 4 / 文件列举搜索 2 / 库管理 12） |
| 单工具覆盖 | `ToolMeta.exposure`（`core`/`peripheral`） | 以后"某个 MCP 服务要常驻"这类例外走它 |
| 判据 | `tool_meta.is_peripheral(name)` | 三条按顺序：`CORE_ALWAYS` → `mcp__` 前缀 → 名单/meta |
| 默认值 | `ToolMeta.exposure = "core"` | **fail-safe**：忘了标只会多占上下文，不会静默消失 |

**必留项（硬约束，`CORE_ALWAYS`）**：

- **记忆四件**：`recall` / `remember` / `read_memory` / `write_memory`
  —— "被延迟发现就等于没有记忆"（用户原话）；
- **技能两件**：`read_skill` / `list_skills` —— 技能那套"索引常驻 + 正文按需"靠它俩；
- **发现通道自身**：`find_tools` / `use_tool` —— **这是死锁约束**：
  发现工具自己若也需要被发现，外围就永远不可达。所以它不只"别忘了标"，
  而是写进 `CORE_ALWAYS` **强制**（用例 `test_the_discovery_gateway_is_core_even_if_someone_flags_it`），
  并且实现上**不依赖任何别的工具**（只读这一轮的表）；
- **数量段本身**（用户新要求）：核心注入里**始终**告诉模型"当前可用技能 N 个 / 工具 M 个"
  —— 没有这两个数，模型不会意识到"还有东西没看到"，也就不会去发现。见 9.3。

**改造后的核心（13 个，知识库关）**：
`recall` `remember` `read_memory` `write_memory` `read_skill` `list_skills`
`web_search` `web_fetch` `read_file` `list_conversation_files` `read_conversation_file`
`find_tools` `use_tool`（`search` 是库门控的，开了库才在）。

**外围（12 个，知识库关）**：`export_document` `export_table` `export_deck` `export_file`
`create_note` `list_notes` `run_command` `spawn_subagent` `schedule_task`
`list_scheduled_tasks` `list_files` `search_files`；开了库再加 12 个库管理工具（共 24）。

### 9.2 发现通道

| 工具 | 作用 | 上限 |
| --- | --- | --- |
| `find_tools(query, limit?)` | 命中 → 回**完整参数 schema**；没命中/空查询 → 回**索引**（名字 + 一句话） | `MAX_DISCOVER_PER_CALL = 4`；索引最多 40 行 |
| `use_tool(name, arguments)` | 调**已经发现过**的外围工具（常驻工具直接叫名字也行） | — |

- **匹配是可算的**：`_match_score` = 查询与「工具名 + 描述」的**字符二元组**命中数，
  外加名字直接命中的 8 分加权（中英一视同仁、不引分词器、不引模型）。
  它决定"外围工具能不能被找到"，所以用例逐条钉住；
- **`use_tool` 只放行发现过的**（或常驻的）：这样发现通道是**唯一的路**，
  "发现 → 调用"是一条真链路而不是可选装饰；拿不到就回**索引**给出路（不只说"不行"）；
- **审批、权限、产物落点、来源账本全部走原路**：网关把参数翻成一次**同样的内部分发**
  （`run(target, inner, approval=approval)`）。一处必须自己补：
  **plan 档的写类门闸**——网关在元数据里是只读的（否则用户会被问两遍），
  而工具循环那道门闸只看**外层调用**的元数据，所以 `use_tool` 里用
  `modes.is_write` 把内层工具再判一次（不另写一套判据）。
- **自递归拒绝**：`use_tool` / `find_tools` 不许包自己。

### 9.3 核心注入里的"数量"（用户新要求）

`find_tools` 的描述里**每轮**带着这一段的**真实数字**（当场算）：

> 【本环境的暴露情况】当前工具共 **25** 个：其中 **13** 个已常驻在你的工具表里
> （记忆、技能、检索、联网、读文件与下面这两个入口），另有 **12** 个**按需检索**
> （导出、建库、跑命令、派子 Agent、定时任务、文件列举与搜索、外部 MCP 服务等）；
> 当前可用技能 **182** 个，其中 **60** 个已列在系统提示词里，另有 **122** 个可直接用
> `list_skills` 查、`read_skill` 取正文。要外围工具：`find_tools`（查）→ `use_tool`（调）；要技能：`read_skill`。

- **数字都是真的**：工具数来自**这一轮的表**（常驻 + 外围），技能数来自
  `services.skills.list()`（与技能目录**同一套判据**：`used_by_prompt` + `MAX_CATALOG`）；
- **加减东西就跟着变**：用例 `test_the_counts_follow_the_registry_not_a_constant`
  用 7 / 176 / 323 三种技能数各建一次表，断言注入里的数字不同（写死 → 红，见 9.8 反向验证③）；
- **为什么放工具描述里、而不是系统提示词**：那份提示词（`prompt.py`）与核心注入文案
  现在在别的 lane 手里；而工具表本来每轮都发，数一数就能算出来的事不该跨文件改。
  升级路径：把它挪进系统提示词的那一段（那时 `_exposure_text` 直接复用即可）。

### 9.4 MCP 工具与技能带的工具怎么归类

| 来源 | 归类 | 理由 |
| --- | --- | --- |
| 技能工具（`read_skill` / `list_skills`） | **核心** | 技能是"索引常驻 + 正文按需"，取正文的入口不能延迟 |
| 技能正文 / 技能目录 | 不进工具表 | 那是模式 2 那条路（目录进系统提示词、正文 `read_skill` 取） |
| 外部 MCP 工具（`mcp__…`） | **外围**（按前缀判定） | 一个服务随时可能装几十个工具，正是外围这一档存在的理由 |
| 单个 MCP 服务要常驻 | 排队（`ToolMeta.exposure` 已留好口子） | 等"按服务配置"那条产品口径 |

### 9.5 按调用者过滤（现状 + 最小切片，**只写方案不实现**）

现状：MCP 那一段按 `owner_id` 过滤；内置工具不分调用者；
**子 Agent 完全没有工具面**（`subagent.py` 全文没有 `tools=`）。
最小切片：给 `SubAgentTask` 带一个**显式只读子集**
（`read_file` / `search_files` / `list_files` / `read_skill`），
`run_subagent` 用它建一张小表；**不要**把整张表塞进去。与第 15/16 条一起排。

### 9.6 预算：改造前后的真数字（线上 `tools` JSON 的字符）

| 装配 | 改造前 | 改造后（常驻） | 降幅 | 外围 |
| --- | --- | --- | --- | --- |
| 知识库**关** | 23 个 / **13,171** 字符 / 5,666 token（原始基线） | **13** 个 / **6,431** 字符 / **2,825** token | **−51% 字符 / −50% token** | 12 个 |
| 知识库**关**（含两个网关的完整表） | 25 个 / 14,501 字符 | — | −56% 字符 | — |
| 知识库**开** | 36 个 / 19,395 字符 | **14** 个 / **7,748** 字符 | −60% 字符 | 24 个 |

- **一次发现的代价**：`find_tools("把结果导出成 Excel 表格")` → 4 个工具、**4,835 字符 / 1,830 token**
  （导出那四个正好是最贵的四个）；**索引模式**（空查询）**1,787 字符 / 961 token**；
- 所以净账是：**每轮省 ~6,700 字符（~2,800 token）**，代价是"要用外围工具时多一跳
  ~1.8k token"——一轮里发现超过 3~4 次才不划算，而外围工具本来就是"一轮用一次"的那类；
- **占比**：常驻工具 2,825 token + 技能目录 5,244 token ≈ **8,069 token ≈ 6.7%** 的压缩预算（120,000），
  比改造前（5,666 + 5,244 ≈ 10,910 ≈ 9.1%）低 2.4 个百分点；
- **323 条技能时的目录压力**（真数字，`probe_exposure_after.py`）：
  **条数上限先绑住** → 目录恒为 **60 条 / 18,594 字符 / 5,244 token**（丢 263 条）；
  **若不上限**则是 **90,753 字符 / 22,689 token**（≈ 压缩预算的 19%）。
  也就是说"加 100 个 skill 只增几百 token"这句话**靠的是 `MAX_CATALOG=60` 这道条数闸**，
  不是字符预算（20,000 那时根本没碰到）。

### 9.7 落点与规模

| 文件 | 改动 | 内容 |
| --- | --- | --- |
| `backend/app/services/tool_meta.py` | ~120 行 | `exposure`/`kind` 两个字段、`PERIPHERAL_TOOLS`、`CORE_ALWAYS`、`is_peripheral()`、两个网关的元数据 |
| `backend/app/services/agent_tools.py` | ~330 行 | `_all_specs` 抽出、`ToolTable`、`find_tools`/`use_tool` 定义与执行、`_exposure_text`/`_skill_counts`、`_plan_mode_blocks` |
| `backend/app/api/v1/chat.py` | 4 处 | `_agent_loop` 建一次表、两处共源；仪表（`/context-usage` 与 `/context`）也改读常驻那一份 |
| `backend/tests/unit/services/test_tool_exposure.py` | ~210 行 | 5 条验收 + 3 条反向验证 |

**没有动 `tool_loop.py` / `prompt.py` / `plan_gate.py` / `frontend/**`**（边界）：
`tool_loop` 在构造时把工具表**拷了一份**（`self._tools = list(tools)`），
所以"发现了就把 schema 加进 tools 数组"那条路需要它配合；本轮改用**网关**把
"发现 → 调用"整条链留在 `agent_tools` 这一侧（代价：过程面板上会看到
`find_tools` / `use_tool` 两个步骤，而不是"直接调用了 export_table"）。
**升级路径**（真·按需声明、面板只显示真实工具名）：把那一行改成
`self._tools = tools if isinstance(tools, MutableToolTable) else list(tools)`
—— 1 行，落点在 `tool_loop.py`，**等那条 lane 空出来再做**。

`skills.py` 本轮**没有动**：写这一节时它正被另一条 lane 改（那里有一条
`if translate_names and False:` 的反向验证桩），而"技能数量"这条要求只读它的 `list()`。

### 9.8 验收：5 条用例 + 3 条反向验证

`backend/tests/unit/services/test_tool_exposure.py`（**13 passed**）：

| # | 用例 | 钉住什么 |
| --- | --- | --- |
| ① | `test_core_tools_are_always_resident` | 核心工具（含记忆四件、技能两件）**一定**在注入里 |
| ② | `test_peripheral_tools_are_not_in_the_resident_table` | 外围工具**默认不在**注入里（导出/建库/跑命令逐项断言） |
| ③ | `test_the_discovery_gateway_is_core_even_if_someone_flags_it` | **发现工具自身常驻**（死锁约束） |
| ④ | `test_discover_returns_full_schemas_for_a_query` + `..._without_a_hit_returns_the_index_instead` + `test_use_tool_requires_a_previous_discovery` + `test_discovery_then_call_reaches_the_real_tool` | 发现回完整 schema、没命中回索引、只放行发现过的、发现后能转发执行 |
| ⑤ | `test_the_core_injection_carries_real_counts` + `test_the_counts_follow_the_registry_not_a_constant` | 核心注入带真数量，且技能/工具增减时跟着变 |

**反向验证（三条，改坏 → 红 → 记原文 → 恢复）**：

1. 把核心工具 `web_search` 误标成外围 → `test_core_tools_are_always_resident` 红
   （原文 `assert 'web_search' not in resident` 成立，即"标错确实会让它掉出常驻"）；
2. **去掉发现通道**（`_exposure_specs` 返回空）→ `find_tools` / `use_tool` 都不在常驻里，
   外围工具在册但**没有任何入口能取到 schema**（死锁的原形）；
3. 把技能数**写死**成常量 → `test_the_counts_follow_the_registry_not_a_constant` 红
   （323 与 7 两种情况都会显示同一个数）。

### 9.9 真链路证据（一次真会话）

探针 `.shots/case-exposure-runner.cjs`（走真 SSE），提问
「把这三行数据导出成一个 Excel 表格：苹果 12，香蕉 7，橙子 20。」：

```
1.9s  find_tools   {"query": "把数据导出成 Excel 表格文件"}
2.6s  use_tool     {"name": "export_table", "arguments": {"filename": "水果数量.xlsx",
                    "sheet_name": "水果数量", "rows": [["水果", "数量"], ["苹果", 12], …]}}
3.0s  use_tool     → 产出交付物 水果数量.xlsx
3.4s  组织回答
```

**交付物真的落出来了**（`水果数量.xlsx`），全程 **4 秒、无错误**。证据：
`.shots/cases-exposure/exposure-run.json`。
（同一探针的第二条用例"整理成一份 Word 文档"走进了研究计划那条流程、
停在计划卡上等确认 —— 那是 `plan_gate` 的行为，与本条无关。）

### 9.10 顺带发现的**两个既有问题**（都不在本轮改动范围内）

1. **P0：一个技能的 YAML 里写了字面转义 `"\ud83e\udd16"`，会让每一轮对话都失败。**
   `backend/data/skills/00-andruia-consultant-v2/SKILL.md` 的 frontmatter 用双引号包了
   UTF-16 代理对转义，frontmatter 解析后得到两个**孤立代理字符**，拼进 system prompt 之后
   httpx 序列化请求时抛 `UnicodeEncodeError: 'utf-8' codec can't encode characters …
   surrogates not allowed` —— 表现是**任何一句话都回"服务端出错了"**。
   本轮为了取证把它**挪出技能目录**（`.shots/exposure/quarantine/`，可还原）。
   建议修法（一处）：技能读取后把代理对**合并回码位**，仍非法就按"丢弃 + 理由"走既有
   `_drop_reason`/`flagged` 那条路；否则从市场装一个带 emoji 的技能就能让整台机器答不了话。
2. **目录一条技能可以渲染出多行**（`_catalog_line` 没压平换行）：本机 `financial-analysis`
   的 `description: |` 带 markdown 列表 → 60 条技能渲染出 **62 个 `- ` 行**，
   多出来的 "Comps Analysis" / "DCF Model" 会被模型当成两个技能名（读不到正文）。

### 9.11 排队（本轮不做）

- **真·按需声明**（把外围工具的 schema 直接加进 `tools` 数组，需要 `tool_loop.py` 1 行配合）；
- **按场景 / 租户装配工具子集**（商业化那一档）；
- **子 Agent 的只读工具子集**（9.5）；
- **单 MCP 服务标记常驻**（`ToolMeta.exposure` 已留口子）；
- **技能条数上限的可见性与优先级**（第八节缺口 2）；
- **`_catalog_line` 压平换行**（8.10 的第 2 条）。
