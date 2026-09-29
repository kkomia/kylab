# 工具调用 UI 对标调研 · 附：闭源三家证据表 v0.1

> **这是《[工具调用 UI 对标调研 v0.1](工具调用UI-对标调研-v0.1.md)》的附录**，只装证据，不下结论。
> 正文的取舍与改进清单在主文档 §4.5 / §5。
> 本文原为调研过程产物、落在仓库根目录（`tool-call-ui-benchmark-cn-agents.md`），
> 按《项目工程规范》§2.3「文档分文件夹」迁入 `docs/调研/`，行文未改，仅去掉两行重复的截断条目。

**调研对象**：Trae（字节跳动）、Qoder / 通义灵码（阿里）、CodeBuddy（腾讯）
**调研时点**：基于 2026-09 可见的公开材料
**核心约束**：三者均闭源、无源码可读。本文只采信可给出 URL 的公开证据，并逐条标注证据级别。

## 证据级别定义

| 级别 | 含义 |
| --- | --- |
| **文档级** | 官方文档站 / 官方更新日志的正文明确描述该行为（最强，属"官方承诺的行为规则"） |
| **官方论坛回复级** | 官方社区中带官方身份（如 `TRAE宝`、`TRAE技术支持-*`）的回复所确认的行为。**低于文档级**：非正式渠道、且本次调研中已出现官方助手先给错答案后自我更正的情况 |
| **截图级** | 界面截图可佐证，但本次调研仅拿到图片链接、未能逐张判读像素内容；标注为"截图存在"而非"截图内容已核实" |
| **第三方描述级** | 权威第三方（大厂开发者社区、知名开源项目 README、公开插件）对界面元素的具体描述。仅作旁证 |
| **用户报告级** | 官方论坛普通用户对自身观察的描述。仅用于佐证"现象存在"，不作为官方行为规则 |

> ⚠️ 关于产品归属的一个重要更正：**通义灵码已更名为 Qoder CN**。官方文档明确区分「Qoder CN（原灵码）」与「QoderWork CN」两条产品线。因此阿里侧的证据需按产品线分别归属，不能混用。

---

# 一、Trae（字节跳动）

Trae 是三家中**唯一在官方文档正文里把"工具调用/思考过程的折叠"写成产品的正式功能**并给出截图与配置项说明的。同时它也是唯一有**官方身份在社区明确承认"中间过程默认折叠、只展示最终总结报告"**的。

## 可确证的事实

| 维度 | 结论 | 证据 URL | 证据级别 |
| --- | --- | --- | --- |
| 1. 容器形态 / 位置 | 工具调用与思考过程**不是独立侧栏或 tab**，而是嵌在对话流里，以可折叠节点的形式聚合进 **「任务耗时」区块**。已完成的节点被折叠进该区块内 | [forum.trae.cn/t/topic/179863](https://forum.trae.cn/t/topic/179863) | 官方论坛回复级 |
| 1. 容器形态 | 官方把它抽象为「**对话流节点**」，每个节点可整块折叠并生成摘要（"折叠并生成摘要"）。用户描述展开路径为"在『任务耗时』下**挨个点开**" | [docs.trae.cn/ide_solo-mode](https://docs.trae.cn/ide_solo-mode)、[forum.trae.cn/t/topic/176722](https://forum.trae.cn/t/topic/176722) | 文档级 + 用户报告级 |
| 2. 单步行显示什么 | MCP 调用**不暴露工具名与参数**，只显示 **「正在调用 mcp」** 与 **「已调用 x 次 mcp」** | [forum.trae.cn/t/topic/176722](https://forum.trae.cn/t/topic/176722) | 用户报告级（标题即结论，未获官方否认） |
| 3. 分组聚合 + 计数写法 | **有分组聚合，且有明确计数文案**：折叠态摘要形如 **「已编辑 3 个文件，读取 2 个文件，搜索 3 次文件」**。有开发者明确批评这类二级摘要"对开发者是没有什么营养的信息" | [forum.trae.cn/t/topic/177137](https://forum.trae.cn/t/topic/177137) | 用户报告级（含原文引用） |
| 4. 默认展开还是折叠 | **默认折叠**。官方文档：开启「对话流节点自动折叠」后"**已完成的任务将被自动总结并折叠**，展开后展示详情" | [docs.trae.cn/ide_solo-mode](https://docs.trae.cn/ide_solo-mode)、[docs.trae.cn/ide_ide-settings](https://docs.trae.cn/ide_ide-settings) | 文档级 |
| 4. 默认值 | **思考链（思维链）默认折叠**——这是用户 bug 反馈的标题与主诉 | [forum.trae.cn/t/topic/176722](https://forum.trae.cn/t/topic/176722) | 用户报告级 |
| 5. 完成后是否自动折叠 | **是，且是核心争议点**。官方身份回复原文："目前 Agent 执行较长任务时，**中间的执行过程和结果确实会被默认折叠在「任务耗时」区块中，只直接展示最终的总结报告**"。官方技术支持在同帖补充："**目前暂时是这样设计的**" | [forum.trae.cn/t/topic/179863](https://forum.trae.cn/t/topic/179863) | 官方论坛回复级（**关键结论**） |
| 5. 流式中是否也折叠 | **会中途反复折叠**。用户原文："展开了，过一会，AI 跑一会，**又给折叠掉了**，AI 在干啥都不知道" | [forum.trae.cn/t/topic/176220](https://forum.trae.cn/t/topic/176220) | 用户报告级 |
| 5. 流式收纳策略 | 官方标题即为"更新后，**『思维链』『终端命令』和『文件改动』等都自动折叠了**" —— 说明自动折叠的作用域覆盖三类内容，不止思考 | [forum.trae.cn/t/topic/178117](https://forum.trae.cn/t/topic/178117) | 用户报告级（标题由用户撰写，但官方回复未否认该作用域） |
| 6. 能否关闭自动折叠 | **官方文档说能关，实际版本里找不到，属已知问题。** 文档写明开关位于「设置 > 对话流 > 待办清单」；但多名用户在 v3.3.90 / v3.3.94 实测**该选项不存在**。官方身份在 v3.3.94 帖中确认："你的截图证实了该选项在当前版本中缺失……**目前确实无法通过其他设置来关闭强制折叠**"，官方技术支持补充"**搜索条件是已知问题，正在修复中**" | [docs.trae.cn/ide_solo-mode](https://docs.trae.cn/ide_solo-mode)、[forum.trae.cn/t/topic/177834](https://forum.trae.cn/t/topic/177834)、[forum.trae.cn/t/topic/178117](https://forum.trae.cn/t/topic/178117) | 文档级 + 官方论坛回复级 |
| 6. 手动开合是否被记住 | **未查到公开依据**。反向线索：用户抱怨"展开了，过一会……又给折叠掉了"，**暗示手动展开不被保持**，但这只是间接推断，不能作为确认结论 | [forum.trae.cn/t/topic/176220](https://forum.trae.cn/t/topic/176220) | 用户报告级（仅作线索） |
| 6. 全部展开/收起 | **未查到公开依据（已查：docs.trae.cn 的 SOLO 模式 / 工具面板 / IDE 设置总览 / 快捷键页，以及 Trae 官方中文社区相关主题）** | — | — |
| 8. 思考/推理是否单独成块 | **是，且存在嵌套**。官方技术支持解释"第二个思考中是**总的思考，里面可能包含多个思考节点**"。用户对应反馈"思考过程**又嵌一个思考**"，并称"现在发现 AI 跑偏看思考**需要点 3 次才能展开完整的折叠**" | [forum.trae.cn/t/topic/176220](https://forum.trae.cn/t/topic/176220)、[forum.trae.cn/t/topic/177137](https://forum.trae.cn/t/topic/177137) | 官方论坛回复级 + 用户报告级 |
| 8. 思考块被折叠的时序 | 用户描述**改版前**的行为："原本思考过程和调用的 mcp 是可以看见的，**最后才被折叠**" → 即折叠发生在**任务收尾时**，而非流式过程中。改版后变为"思考链被默认折叠" | [forum.trae.cn/t/topic/176722](https://forum.trae.cn/t/topic/176722) | 用户报告级（**对"何时折叠"很有价值**） |
| 11. 人话摘要 | **有**。摘要为统计式人话（"已编辑 3 个文件，读取 2 个文件，搜索 3 次文件"），而非"正在读取 xxx 文件"式的进行时叙述。进行时状态表现为「正在调用 mcp」 | [forum.trae.cn/t/topic/177137](https://forum.trae.cn/t/topic/177137)、[forum.trae.cn/t/topic/176722](https://forum.trae.cn/t/topic/176722) | 用户报告级 |
| — 界面截图存在性 | 官方文档在「对话流节点自动折叠」小节提供**「折叠后」与「展开后」两张对照截图**；社区中另有大量截图链接 | [docs.trae.cn/ide_solo-mode](https://docs.trae.cn/ide_solo-mode)、[forum.trae.cn/t/topic/179863](https://forum.trae.cn/t/topic/179863) | 截图级（图存在，像素内容本次未逐张判读） |
| — 相关设置项 | 「对话流」分组下存在 **待办清单**、**对话流节点自动折叠**（标注"仅 SOLO 模式"）、自动修复、智能体主动提问、代码审查范围、终端工具偏好、任务状态通知等 | [docs.trae.cn/ide_ide-settings](https://docs.trae.cn/ide_ide-settings) | 文档级 |
| — 异常通知 | 提示音可分别配置 **任务完成 / 等待操作 / 异常打断** 三种环节 | [docs.trae.cn/ide_ide-settings](https://docs.trae.cn/ide_ide-settings) | 文档级 |

## 未能确证（Trae）

1. **单步工具行走显示工具名与参数** —— 反证是 MCP 只显示"正在调用 mcp"；但内置工具（读文件/终端）是否显示具体工具名，未查到公开依据。
2. **耗时显示** —— "任务耗时"是一个区块名，是否同时是每步的耗时时长，未查到公开依据。
3. **running 与 done 的视觉区分方式** —— 仅有"正在调用 mcp" vs "已调用 x 次 mcp"的文案差异线索，视觉区分未查到。
4. **手动开合状态的持久化** —— 未查到公开依据。
5. **是否有「全部展开/收起」** —— 未查到公开依据。
6. **长输出截断与"查看全文"入口** —— 未查到公开依据。
7. **失败 / 被拒 / 待批准是否自动展开** —— 未查到公开依据。仅知存在"权限审批"文档页与"等待操作""异常打断"提示音配置。
8. **展开折叠是否有动画** —— 未查到公开依据。
9. **自动滚到底** —— 未查到公开依据。

---

# 二、Qoder / 通义灵码（阿里）

**产品线辨析（重要）**：官方文档明确「**Qoder CN（原灵码）**」，即通义灵码已并入 Qoder CN 品牌；另有桌面端产品线 **QoderWork CN**。本次查到的**关于"工具调用块默认开合"的唯一文档级证据来自 QoderWork CN 的官方系统设置页**，不能直接等同为 Qoder CN IDE 插件的行为——尽管二者同属阿里、共用同一套帮助中心与文档站。

阿里侧最硬的一条证据是：**官方设置项「Expand tool calls by default」的存在本身，就反证了默认值是收起**。

## 可确证的事实

| 维度 | 结论 | 证据 URL | 证据级别 |
| --- | --- | --- | --- |
| 4. 默认展开还是折叠 | **默认折叠**。官方设置项名为 **「Expand tool calls by default」**（中文：**「默认展开工具调用」**），其存在即在默认状态上反证"默认不展开"。原文定义："When on, newly displayed tool blocks are expanded by default; can still be collapsed manually." / 中文："开启后**新建展示的工具块默认展开**，可随时手动收起" | EN: [docs.qoder.com/qoderwork/settings](https://docs.qoder.com/qoderwork/settings)；CN: [alibabacloud.com/help/zh/lingma/system-settings](https://www.alibabacloud.com/help/zh/lingma/system-settings)；亦见 [help.aliyun.com/en/lingma/system-settings](https://help.aliyun.com/en/lingma/system-settings) | **文档级（最强）** |
| 1. 容器形态 | 官方用词是 **「工具块 / tool blocks」**，即卡片式块，非时间轴、非独立 tab | 同上 | 文档级 |
| 4/6. 手动开合 | **可随时手动收起**（"can still be collapsed manually"），即单块级别的手动开合被明确支持 | 同上 | 文档级 |
| 5. 流式展示的开关 | 另有设置项 **「Show tool execution steps in IM channels / 在 IM 频道中展示工具调用执行过程」**，定义为"开启后在 IM 频道**同步输出每步工具执行情况**；关闭则只显示最终回复" → 官方承认存在"**每步工具执行情况**"这一可流式推送的粒度 | 同上 | 文档级 |
| 2. 工具名显示方式 | 内置工具在文档中**同时给出「显示名称」与「工具 ID」**（如 显示名称「查看文件」/ ID `read_file`；「运行命令」/ `run_in_terminal`；「创建 To-dos 任务」/ `add_tasks`；「获取代码问题」/ `get_problems`；「检索仓库」/ `search_codebase` 等）。存在独立的"显示名称"字段，说明 UI 走的是**本地化人话名**而非原始 ID | [docs.qoder.cn/user-guide/tools](https://docs.qoder.cn/user-guide/tools) | 文档级 |
| 2. 状态枚举 | 文件修改过程被明确为三态：**生成中（Generating） / 应用中（Applying） / 应用完成（Applied）**，且状态"可在**回答卡片**或工作区中看到相关的变更文件及状态" | [docs.qoder.cn/user-guide/overview-of-chat](https://docs.qoder.cn/user-guide/overview-of-chat)、[help.aliyun.com/zh/lingma/overview-of-chat](https://help.aliyun.com/zh/lingma/overview-of-chat) | 文档级 |
| 1. 容器形态 | 对应容器官方称 **「回答卡片」**；会话流中可"自动定位到产生该快照代码变更文件的**回答卡片**" | 同上 | 文档级 |
| 3. 待办进度显示 | 待办事项在**聊天窗口底部**显示进度，且用三种符号区分状态：**空心圆圈=尚未开始 / 旋转圆圈=进行中 / 复选框=已完成** | [docs.qoder.cn/user-guide/agent](https://docs.qoder.cn/user-guide/agent) | 文档级 |
| 9. 待批准（终端/MCP） | 终端命令**默认每次执行前需开发者确认**，提供 **「运行」/「取消」** 按钮；需要后台运行的命令会出现 **「后台运行」标记**。MCP 工具**每次执行前主动询问，单击执行按钮确认**。允许列表内的命令可免确认自动执行 | [docs.qoder.cn/user-guide/agent](https://docs.qoder.cn/user-guide/agent) | 文档级 |
| 9. 审批粒度 | 问答社区中官方侧答复称："**部分工具调用详情默认是折叠的**，这也有助于减轻渲染压力" | [developer.aliyun.com/ask/706910](https://developer.aliyun.com/ask/706910) | 第三方描述级（阿里云开发者社区答复，**非官方文档，身份未经官方背书**） |
| 9. 拒绝单步不中断 | 未查到阿里侧官方依据。**行业交叉印证**（腾讯侧）："优化任务权限处理，拒绝单步权限时仅跳过当前步骤，执行中切换能力不再中断当前回复" | [cloud.tencent.com/document/product/1831/134324](https://cloud.tencent.com/document/product/1831/134324) | 文档级（腾讯产品，**不可作为阿里的结论**） |
| — 界面截图存在性 | QoderWork 设置页在官方文档中配有界面截图，alt 文本明确列出 "Expand tool calls by default" 位于 Preferences 面板 | [docs.qoder.com/qoderwork/settings](https://docs.qoder.com/qoderwork/settings) | 截图级（alt 文本级证据；图片本身本次未能下载判读） |

## 未能确证（Qoder / 通义灵码）

1. **"默认展开工具调用"关闭时，新工具块到底是完全收起还是显示一行摘要** —— 文档只说"newly displayed tool blocks are expanded by default"，未描述关闭态的视觉形态。
2. **是否分组聚合同类调用及计数文案** —— 未查到公开依据（已查：docs.qoder.cn 的 overview-of-chat / agent / tools / settings / approval-and-sandbox / plug-in-configuration-guide / cli-interface，docs.qoder.com 的 qoderwork-settings / task-management / plugins-ai-chat，help.aliyun.com 的 zh/lingma/overview-of-chat，以及 QoderWork CN 全部更新日志）。
3. **流式中是否自动展开、完成后是否自动折叠** —— **未查到任何官方表述**。这是本次调研中阿里侧最大的空白。
4. **失败 / 被拒的显示与重试入口** —— 未查到公开依据。
5. **手动开合状态是否跨会话记住** —— 未查到公开依据。
6. **是否有「全部展开/收起」** —— 未查到公开依据。仅有 CLI 的 `Ctrl+T`「展开查看完整任务列表」，属任务列表而非工具块，不能套用。
7. **展开折叠是否有动画** —— 未查到公开依据。
8. **Qoder CN IDE 插件（原通义灵码本体）是否也有同名设置** —— 未查到公开依据。该设置目前只在 QoderWork CN 的产品线文档中出现。
9. **思考/reasoning 是否单独成块、默认开合** —— 未查到公开依据（已查上述各页）。

---

# 三、CodeBuddy（腾讯）

CodeBuddy 的情况比较特殊：**官方更新日志里关于工具调用 UI 的"故障与修复"细节极其丰富**（足以反推出大量 UI 结构），但**几乎没有任何一句正面描述"工具块长什么样/默认开合"的规范性文档**。

## 可确证的事实

| 维度 | 结论 | 证据 URL | 证据级别 |
| --- | --- | --- | --- |
| 1. 容器形态 | 官方更新日志反复出现 **「命令卡片」**（command card）与 **「工具审批卡片」**（tool approval card）两个术语，并存在 **「Agent 窗口」** 这一容器。→ 工具调用以**卡片**形态存在于 Agent 对话窗口中 | [cloud.tencent.com/document/product/1831/134323](https://cloud.tencent.com/document/product/1831/134323) | 文档级（术语来自官方 update log 正文） |
| 9. 待批准 / 审批 | **存在「工具审批卡片」**并有明确故障记录："修复后台会话的**工具审批卡片不下发**导致对话卡死、切换标签后授权弹窗不弹出的问题"；另有"修复**审批卡丢失与超时误判**的问题"、"修复点过工具确认后，本轮剩余时间无法显示『暂停』按钮的问题" | [cloud.tencent.com/document/product/1831/134323](https://cloud.tencent.com/document/product/1831/134323)、[cloud.tencent.com/document/product/1831/134325](https://cloud.tencent.com/document/product/1831/134325) | 文档级 |
| 9. 命令卡片自动运行 | 存在 **「命令卡片自动运行模式」** 及其同步失效 bug（IDE 4.11.2、插件 4.11.2 均记录） | 同上 | 文档级 |
| 8. 思考开关与思考强度 | **思考是可独立开关的 UI 元素**，且**可按 Agent 配置而非仅全局**："自定义 Agent 支持单独配置**思考强度与思考开关**，不再受全局设置限制" | [cloud.tencent.com/document/product/1831/134323](https://cloud.tencent.com/document/product/1831/134323) | 文档级 |
| 6. 折叠的实操记录 | "修复多工作区下文件预览状态隔离、**技能筛选在展开后的保持**" → 官方在意"展开状态是否被保持"，但这条针对技能筛选器，**不能推及工具块** | [cloud.tencent.com/document/product/1831/134325](https://cloud.tencent.com/document/product/1831/134325) | 文档级（但**不可外推**） |
| 10. 滚动稳定性 | 有专门的滚动与渲染修复："修复会话流在滚动时偶发**重影、消息重叠**"、"修复对话流消息偶发重叠"、"优化消息列表渲染，消息较多时滚动与对话更流畅"、"修复粘贴长文本后视图跳到对话顶部" | [cloud.tencent.com/document/product/1831/134323](https://cloud.tencent.com/document/product/1831/134323) | 文档级 |
| 3. 子 Agent 折叠计数 | **有明确的"+N"折叠计数**："**子 Agent 数量较多时，底部成员栏折叠为「+N」**，不再挤占对话区" | [cloud.tencent.com/document/product/1831/134323](https://cloud.tencent.com/document/product/1831/134323) | 文档级（针对子 Agent 成员栏，**非工具调用块**） |
| 3. 子 Agent 卡片 | 存在 **「子 Agent 卡片」**，并有"修复子 Agent 卡片的调用方式在中文界面下显示为英文的问题" | 同上 | 文档级 |
| 7. 长输出截断 | 存在明确的截断机制并出过严重 bug："**修复子 Agent 最终结果过长时被截断或变成空白的问题**"；英文版另记 "Fixed terminal information truncation when terminal output is too long"、"Optimized MCP content truncation issues, supporting large character scenarios" | [cloud.tencent.com/document/product/1831/134323](https://cloud.tencent.com/document/product/1831/134323)、[tencentcloud.com/document/product/1256/77264](https://www.tencentcloud.com/document/product/1256/77264) | 文档级 |
| 11. 人话操作入口 | 存在 **「Continue Next Step」按钮**："Optimized 'Continue Next Step' button display when model calls Terminal" → 工具调用后有面向用户的人话操作入口 | [tencentcloud.com/document/product/1256/77264](https://www.tencentcloud.com/document/product/1256/77264) | 文档级 |
| 5. 重连补齐 | "返回仍在生成的会话时可**补齐离开期间的思考、正文和工具内容**" → 佐证**思考 / 正文 / 工具内容是三类可区分的流式分区** | [cloud.tencent.com/document/product/1831/134324](https://cloud.tencent.com/document/product/1831/134324) | 文档级（腾讯 WorkBuddy 产品线） |
| 4/5. 工具块默认开合 | **未查到公开依据**（已查：codebuddy.ai / codebuddy.cn 的 IDE/插件/CLI/WorkBuddy 全部文档与 200+ 版本发布页、腾讯云 1831 产品动态 4 篇更新记录、腾讯云 CodeBuddy Release Notes） | — | — |
| — 折叠卡片的形态（旁证） | 第三方开源插件 README 称其复刻了 CLI 的界面元素："**可折叠的思考过程与工具调用卡片**"（Collapsible thinking blocks and tool-call cards）；另一插件称"支持流式回复、**思考过程、工具调用**与会话历史" | [github.com/ben4202121/buddybridge](https://github.com/ben4202121/buddybridge)、[github.com/jiang198012/workbuddian](https://github.com/jiang198012/workbuddian) | 第三方描述级（**非官方**；且是第三方自行实现的 UI，只能证明 CLI 事件流里有 thinking / tool call 两类数据，**不能证明官方 UI 长这样**） |

## 未能确证（CodeBuddy）

1. **工具调用块默认展开还是折叠** —— **未查到任何官方依据**。这是本次调研三个产品中最大的空白。
2. **单步工具行是否显示工具名 / 参数 / 结果 / 耗时** —— 未查到公开依据。仅知"Agent 窗口命令卡片""文件变更列表"存在。
3. **running 与 done 的区分方式** —— 未查到公开依据。
4. **是否分组聚合同类工具调用及计数文案** —— 未查到公开依据。唯一的"+N"折叠计数属**子 Agent 成员栏**，不可外推到工具调用。
5. **流式中/完成后是否自动折叠** —— 未查到公开依据。
6. **失败 / 被拒状态的显示与重试入口** —— 仅查到"修复命令执行失败时输出被丢弃、AI 看不到失败原因"（说明曾经连 AI 都看不到失败原因），但**用户侧失败态如何显示、有无重试按钮，未查到**。
7. **长输出的"查看全文"入口** —— 未查到公开依据。
8. **展开折叠是否有动画** —— 未查到公开依据。
9. **是否有「全部展开/收起」** —— 未查到公开依据。
10. **有无"正在读取 xxx 文件"式的进行时人话摘要** —— 未查到公开依据。

---

# 四、从这三家身上能得到的、且不依赖源码的结论

以下每条都附有可核查的公开证据。**凡本次未查到证据的推断，一律不写。**

### 结论 1：把"工具调用过程"折叠起来是这一代国产 Agent 的默认选择，而非可选项 —— 且用户会强烈反弹

Trae 的官方身份在社区明确承认："**目前 Agent 执行较长任务时，中间的执行过程和结果确实会被默认折叠在「任务耗时」区块中，只直接展示最终的总结报告**"，官方技术支持补充"**目前暂时是这样设计的**"；并且在 v3.3.94 上**无法通过任何设置关闭**。
— [forum.trae.cn/t/topic/179863](https://forum.trae.cn/t/topic/179863)、[forum.trae.cn/t/topic/177834](https://forum.trae.cn/t/topic/177834)

**指导意义**：默认折叠"过程"、默认突出"结论"是业界共识方向；但如果**不给出逃生舱**，重度用户会把它当成阻断性缺陷（Trae 该帖中用户称之为"BUG"，并称"让软件变得极其难用"）。**折叠可以有，开关必须有。**

### 结论 2：官方文档写了开关 ≠ 用户能用上；文档与实现脱节会直接摧毁信任

Trae 官方文档 [SOLO 模式概览](https://docs.trae.cn/ide_solo-mode) 与 [IDE 设置总览](https://docs.trae.cn/ide_ide-settings) 都明确写了「对话流节点自动折叠」开关的位置与语义，但多名用户在 3.3.90 / 3.3.94 实测找不到该选项，官方最终承认"**该选项在当前版本中缺失**"且"搜索条件是已知问题，正在修复中"。
— [forum.trae.cn/t/topic/177834](https://forum.trae.cn/t/topic/177834)

**指导意义**：折叠行为的开关属于**用户信任基础设施**，不能在文档里先承诺、在客户端里后交付。

### 结论 3：这条能力是可配置的，而且业界已有明确的设置项命名范式

阿里官方设置项就直接叫 **「Expand tool calls by default / 默认展开工具调用」**，语义是"开启后新建展示的工具块默认展开，可随时手动收起"。
— [docs.qoder.com/qoderwork/settings](https://docs.qoder.com/qoderwork/settings)、[alibabacloud.com/help/zh/lingma/system-settings](https://www.alibabacloud.com/help/zh/lingma/system-settings)

**指导意义**：这个命名把三件事拆得很干净 —— ①默认态（expand by default）②作用对象（tool calls）③手动兜底（can still be collapsed manually）。**照抄这个语义划分即可，不必自创。**

### 结论 4：默认值就是"折叠"；"默认展开"是那个需要被打开的开关

这正是"Expand tool calls **by default**"这个设置项存在的意义 —— 如果默认已展开，这个开关没有存在必要。
— 同上

### 结论 5：折叠会做二级嵌套，且嵌套深度会直接变成可用性问题

Trae 官方技术支持解释"第二个思考中是**总的思考**，里面可能包含多个思考节点"；用户的对应体验是"**需要点 3 次才能展开完整的折叠**"。
— [forum.trae.cn/t/topic/176220](https://forum.trae.cn/t/topic/176220)、[forum.trae.cn/t/topic/177137](https://forum.trae.cn/t/topic/177137)

**指导意义**：思考/工具块如果同时存在"任务级折叠 → 阶段级折叠 → 单步折叠"，点击深度会迅速劣化。**能不嵌套就不嵌套；必须嵌套时，要提供"一次展开到最内层"的手段。**

### 结论 6：折叠不该在流式过程中反复发生 —— "自动折叠"最伤人的时刻是执行途中

Trae 用户的原文是"展开了，过一会，AI 跑一会，**又给折叠掉了**，AI 在干啥都不知道"。
— [forum.trae.cn/t/topic/176220](https://forum.trae.cn/t/topic/176220)

而更早的版本行为恰好相反："原本思考过程和调用的 mcp 是可以看见的，**最后才被折叠**"。
— [forum.trae.cn/t/topic/176722](https://forum.trae.cn/t/topic/176722)

**指导意义**：**"任务完成后折叠"是合理的；"执行中折叠"是有害的。** 折叠动作应当只在 turn 结束时触发，且用户手动展开过的节点应免于被自动折叠。

### 结论 7：折叠态的摘要怎么写，是有真实分歧的 —— "统计式"会被开发者嫌弃

Trae 折叠摘要的实际形态是 **「已编辑 3 个文件，读取 2 个文件，搜索 3 次文件」**，有开发者直接评价"对开发者是没有什么营养的信息"；同一帖另一位用户的诉求是"过程是展开的"。
— [forum.trae.cn/t/topic/177137](https://forum.trae.cn/t/topic/177137)、[forum.trae.cn/t/topic/176220](https://forum.trae.cn/t/topic/176220)

**指导意义**：一行摘要里，**"在做什么/做成了什么"比"做了几次"更有价值。** Trae 的计数式摘要（"已调用 x 次 mcp"）也被同一批用户批评。若要写计数，至少要和**对象**绑定（如"读取 2 个文件"已比"调用 2 次工具"好）。

### 结论 8：工具调用的 UI 形态，三家的官方措辞已经收敛到"卡片"

- 阿里：「**工具块 / tool blocks**」、「**回答卡片**」 — [docs.qoder.com/qoderwork/settings](https://docs.qoder.com/qoderwork/settings)、[docs.qoder.cn/user-guide/overview-of-chat](https://docs.qoder.cn/user-guide/overview-of-chat)
- 腾讯：「**命令卡片**」、「**工具审批卡片**」、「**子 Agent 卡片**」 — [cloud.tencent.com/document/product/1831/134323](https://cloud.tencent.com/document/product/1831/134323)
- Trae：以「**对话流节点**」聚合进「**任务耗时**」区块 — [docs.trae.cn/ide_solo-mode](https://docs.trae.cn/ide_solo-mode)、[forum.trae.cn/t/topic/179863](https://forum.trae.cn/t/topic/179863)

**指导意义**：**卡片/块**是主流容器形态，而不是时间轴或独立侧栏。三家中没有一家把工具调用放进侧栏或 tab。

### 结论 9：状态枚举已经被官方文档写死过，可以直接对齐

- 阿里的文件修改三态：**生成中（Generating） / 应用中（Applying） / 应用完成（Applied）**，且三态"可在回答卡片或工作区中看到" — [docs.qoder.cn/user-guide/overview-of-chat](https://docs.qoder.cn/user-guide/overview-of-chat)
- 阿里的待办进度三符号：**空心圆圈=未开始 / 旋转圆圈=进行中 / 复选框=已完成** — [docs.qoder.cn/user-guide/agent](https://docs.qoder.cn/user-guide/agent)

**指导意义**：`进行中` 用**旋转**语义、`已完成` 用**勾选**语义，这是官方文档级别的既定惯例，值得直接采用。

### 结论 10：工具名要过一层"显示名称"，不要把工具 ID 直接怼给用户

Qoder 官方文档为每个内置工具**同时维护「显示名称」与「工具 ID」**两套字段（如「查看文件」/`read_file`、「运行命令」/`run_in_terminal`、「创建 To-dos 任务」/`add_tasks`）。
— [docs.qoder.cn/user-guide/tools](https://docs.qoder.cn/user-guide/tools)

**指导意义**：UI 层用人话显示名，ID 只留在协议/日志层。这是官方文档结构直接给出的设计意图。

### 结论 11：待批准态必须是"阻断式卡片 + 明确按钮"，且拒绝单步不应中断整个任务

- 阿里：终端命令**默认每次执行前需确认**，给出 **「运行」/「取消」** 两个动作；需要后台运行的命令出现 **「后台运行」标记**；MCP 调用**每次执行前主动询问**，单击执行按钮确认 — [docs.qoder.cn/user-guide/agent](https://docs.qoder.cn/user-guide/agent)
- 腾讯官方日志把"审批卡片丢失"直接列为**对话卡死**的成因 — [cloud.tencent.com/document/product/1831/134323](https://cloud.tencent.com/document/product/1831/134323)

**指导意义**：审批卡片是工具调用 UI 里**最不能折叠**的一环 —— 腾讯官方日志里"**工具审批卡片不下发导致对话卡死**"正是把它折叠/丢失后的直接后果。

### 结论 12：长输出截断是必须做的，但截断本身是个高风险动作

腾讯官方日志同时记录了"**修复子 Agent 最终结果过长时被截断或变成空白的问题**"和"Optimized MCP content truncation issues, supporting large character scenarios"、"Fixed terminal information truncation when terminal output is too long"。
— [cloud.tencent.com/document/product/1831/134323](https://cloud.tencent.com/document/product/1831/134323)、[tencentcloud.com/document/product/1256/77264](https://www.tencentcloud.com/document/product/1256/77264)

**指导意义**：头部厂商确实都在截断，且都因为截断出过"变成空白"级别的 bug。**截断必须保证"至少还看得见摘要 + 有展开全文的入口"，绝不能截成空白。**

### 结论 13（反例，但同等重要）：思考与工具调用在数据层是两类东西，在 UI 层要不要合并是可选项

腾讯有"**修复复杂回复正文被工具状态截断，导致内容缺失或顺序异常的问题**"，以及"返回仍在生成的会话时可**补齐离开期间的思考、正文和工具内容**"（三类并列）。
— [cloud.tencent.com/document/product/1831/134324](https://cloud.tencent.com/document/product/1831/134324)

**指导意义**：思考、正文、工具内容在实现上是**三条可并行的流**，UI 上很容易互相挤占。**正文绝不能被工具状态截断** —— 这是官方承认发生过的真实缺陷。

---

# 五、一句话总结（诚实版）

- **Trae**：折叠行为查得最透。有文档级定义（「对话流节点自动折叠」）、有官方身份承认"默认折叠中间过程、只展示最终总结"、有官方承认"关不掉"。**最佳对标样本。**
- **阿里（Qoder / 通义灵码）**：拿到了**最有价值的一条文档级证据** —— 官方存在「默认展开工具调用」设置项，从而确认**默认态是折叠**、且**单块可手动收起**。但"流式中是否展开、完成后是否自动折叠"**完全没有官方表述**。
- **腾讯（CodeBuddy）**：**没有查到任何关于工具块默认开合的官方依据**。官方更新日志反而从故障侧暴露了大量结构信息（命令卡片、工具审批卡片、命令卡片自动运行模式、子 Agent 卡片 + "+N" 折叠、结果过长截断），这些足以反推 UI 结构，但**不足以断定默认开合行为**。若需该结论，只能实测客户端。

**本次调研最重要的三个空白（建议实测补齐，不要靠推测）**：
1. CodeBuddy 工具块的默认开合与完成后行为 —— 零官方依据。
2. 三家"完成后自动折叠"是否会被用户的手动展开所覆盖 —— 仅 Trae 有间接线索指向"不覆盖"。
3. 三家是否提供「全部展开 / 全部收起」 —— 全都没有查到公开依据。
