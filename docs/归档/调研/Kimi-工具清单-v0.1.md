# Kimi 工具层清单 v0.1（第三批·延伸：**工具也可以抄**）

- 抓取日期：**2026-09-29**；来源：`.shots/kimi-resources/` 下的 **258 份真实 `SKILL.md`**（268 个可导入仓库去重后的文件）+
  站内 **69 个栏目页** + 我们自己的工具面；原始内容只在 `.shots/`（**不入库**），页面只当资料。
- 提取脚本：`.shots/kimi-resources-tools.cjs`；结果 `.shots/kimi-resources/tools/index.json`。
- 页面里的安装命令/示例提示词**一律未执行**。

## 一、他们的技能假定宿主有哪些工具（258 份 SKILL.md 反推）

| 他们假定的工具    | 提及次数                       | 语义                                 | 我们的对应                               | 判定                                        |
| ----------------- | ------------------------------ | ------------------------------------ | ---------------------------------------- | ------------------------------------------- |
| `Skill`           | 1226                           | 按名加载技能正文（技能之间互相引用） | `read_skill` / `list_skills`             | **名字不同，语义已对齐**                    |
| `Read`            | 763                            | 读文件                               | `read_file`                              | 已对齐（名字不同）                          |
| `Bash`            | 691                            | 跑命令                               | `run_command`                            | 已对齐（我们还多一层隔离探测）              |
| `Write`           | 421                            | 写文件                               | **没有**（刻意，见下）                   | **缺口**                                    |
| `Task`            | 370                            | 派子 agent                           | `spawn_subagent`                         | 名字不同；能力弱（一次检索+作答、深度 1）   |
| `Edit`            | 180                            | 改文件（精确替换）                   | **没有**                                 | **缺口**                                    |
| `Grep`            | 94                             | 按内容搜                             | `search_files`（正则 + 行号 + 上限提示） | 已对齐                                      |
| `Glob`            | 35                             | 按模式找文件                         | **没有**（`list_files` 只按目录列）      | **缺口**                                    |
| `WebFetch`        | 26                             | 抓网页                               | `web_fetch`                              | 已对齐                                      |
| `AskUserQuestion` | 26                             | **结构化提问并等回答**               | **没有**                                 | **缺口（正好是第一批第 1 条"澄清"的载体）** |
| `WebSearch`       | 17                             | 联网搜                               | `web_search`                             | 已对齐                                      |
| `Computer`        | 6                              | GUI 操作                             | 没有                                     | 缺口（不打算做）                            |
| `TodoWrite`       | 0（在 frontmatter/正文里少见） | 写回待办                             | 没有                                     | 可选                                        |

**frontmatter 声明工具的机制**：`allowed-tools` **23 个技能在用**、`tools` 2 个、`metadata` 9 个
（`metadata` 里还见过 `requires.bins/env` 这类依赖声明）。我们的 `skills.py` **不解析这些字段**。

## 二、外部 CLI / 运行时依赖（技能要跑起来，沙箱里就得有）

出现次数（258 份技能正文）：

| CLI / 运行时     | 次数 |     | CLI / 运行时  | 次数 |
| ---------------- | ---- | --- | ------------- | ---- |
| `python`         | 503  |     | `pip`         | 47   |
| `node`           | 198  |     | **`ffmpeg`**  | 47   |
| `curl`           | 192  |     | `gh`          | 36   |
| `git`            | 106  |     | `mermaid`     | 26   |
| **`playwright`** | 104  |     | `docker`      | 26   |
| `jq`             | 102  |     | `python-pptx` | 21   |
| `npx`            | 85   |     | `matplotlib`  | 20   |
| `uv`             | 73   |     | `pandoc`      | 13   |
| `d3`             | 72   |     | `openpyxl`    | 10   |
| `npm`            | 60   |     | `libreoffice` | 6    |

- **30 个技能提到 MCP**（我们有 `mcp_client.py` ✓）；**101 个技能带脚本或 `.py`**（我们有 `run_command` + 沙箱 ✓）。
- **含义**：`playwright` 104 次、`ffmpeg` 47 次、`pandoc`/`libreoffice` 也在列——**我们的 Docker 沙箱镜像
  （`isolation.py:104` 明确是"最小且可预测的"）里没有这些，导入的技能大半跑不起来**。
  落点：给镜像定一份"技能运行基线"（python/uv/node/npx/curl/git/jq/playwright/ffmpeg/pandoc/libreoffice）。

## 三、命令面：他们 26 条 vs 我们 12 条

- **Kimi Code**（`/academy/kimi-code-cheat-sheet`）：`init plan compact tasks new clear sessions resume fork title
undo usage status version btw exit login logout provider model settings effort experiments secondary-model editor export-md`
- **我们**（`commands.py:287-444`）：`help compact new stop mode model plan skill rewind context status skills`
  ＋用户自定义 `.md` 命令（`$ARGUMENTS` 占位、支持命名空间、参数声明、影子/冲突提示——这套比他们文档里写的更细）。

**最值得抄的 5 条**：`/init`（**生成 AGENTS.md/项目指引**，对应 `ai-in-programming` 里那句"`/init` 生成 `AGENTS.md`"）、
`/export-md`（**会话导出 Markdown**）、`/fork`（分叉会话、保留完整历史）、`/tasks`（后台任务面板）、
`/usage`（token/配额；我们 `/context` + `/status` 已覆盖一部分）。

## 四、缺口 + 落点（照旧：改哪、多大、怎么验）

| #   | 项                                                                                                                               | 为什么值得抄                                                                      | 落点与规模                                                                        | 怎么验                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | **工具名对齐表**（Read/Write/Edit/Bash/Grep/Glob/Task/Skill/AskUserQuestion → 我们的名字）+ 在技能目录注入一段"本宿主工具名"说明 | **268 个技能全是按 Claude Code 的工具名写的**，不改写就调不动                     | `agent_tools.py`（工具的 `description`/别名）+ `skills.py`（注入）**~100-150 行** | 导入 3 个真技能，让模型按技能正文办事，看它调的是不是我们的工具          |
| 2   | **`AskUserQuestion` 工具**（结构化选项 + 等待回答）                                                                              | 26 个技能在用它；也是第一批第 1 条"澄清→计划→确认"的**机制载体**                  | 新工具 + 前端复用审批卡片 **~80-120 行**                                          | 单测 + 一条"信息不足该问一句"的真会话                                    |
| 3   | **`glob` 工具**（按模式找文件）                                                                                                  | 35 个技能在用；我们只有按目录列                                                   | `agent_tools.py` **~40-60 行**                                                    | 单测（模式匹配、忽略规则）                                               |
| 4   | **`allowed-tools` 白名单解析**                                                                                                   | 23 个技能声明了工具集；**这是"技能即权限声明"**，能接我们的 `approvals.py` 权限档 | `skills.py` + `skill_market.py` **~60-100 行**                                    | 单测（越界工具被拦、白名单缺省=不限制）                                  |
| 5   | **沙箱基线 CLI 清单**                                                                                                            | 不然导入的技能大半跑不动（playwright/ffmpeg/pandoc/libreoffice…）                 | `isolation.py` 的 `DOCKER_IMAGE` + Dockerfile + 一份清单文档 **~20-40 行**        | 在沙箱里跑 `playwright --version`、`ffmpeg -version`、`pandoc --version` |
| 6   | **命令面 5 条**（`/init` `/export-md` `/fork` `/tasks` `/usage`）                                                                | 用户可见、成本低                                                                  | `commands.py` 每条 **~40-80 行** + 前端提示                                       | 单测 + 手点一遍                                                          |
| 7   | `TodoWrite`（把待办写回）                                                                                                        | 长任务进度可见                                                                    | 视需要                                                                            | —                                                                        |

## 五、一个必须写明的**架构立场**（不建议直接抄的两项）

- **`Write` / `Edit`：我们刻意没有**。`agent_files.py:19-21` 写得很清楚——"这里没有任何写接口，这是刻意的：
  写由两条已有的路承担——`export_*`（产出新文件）与 `run_command`（执行）。把读写混在一个工具里，
  等于开出一条我们没设计过、也没审过的写路径。"
  **所以做法不是"补一个 Write 工具"，而是**：导入技能时把 `Write`/`Edit` **改写**成我们已有的通道
  （`export_*` / `run_command`），并在注入说明里讲清楚。**这条是决策点，要你拍**（加工具 vs 改写）。
- **`Computer`（GUI 操作）**：6 个技能在用，但我们没有 GUI 自动化的产品面，**不抄**（要抄就得先有浏览器/桌面桥，
  那是另一个项目量级——参考他们的 `本地桥接 + 扩展 + CDP` 方案，见第一批第 4 条）。

## 六、结论

1. **我们已有的工具基本够，但名字不同**（Read/Bash/Grep/WebFetch/WebSearch/Task 都有对应）→
   最大的收益是**一张对齐表 + 注入说明**，不是新写一堆工具。
2. **真正缺的是 3 个**：`AskUserQuestion`（结构化提问）、`Glob`、`allowed-tools` 白名单解析；
   外加**沙箱基线 CLI**（否则技能跑不起来）。
3. **工具层的目标不是"功能对齐"，是"让 268 个技能在我们这边能跑"**——这句话应该写在导入 lane 的任务里。
4. 页面里的安装命令（`curl | bash`、`irm | iex`、`npm i -g`）**一律未执行**；原文与提取结果只在 `.shots/`。
