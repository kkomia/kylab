# Kimi 资源站 技能总表 v0.1（第三批·①）

- 抓取日期：**2026-09-29**（真浏览器抓 `/resources/` 全站 **336 篇 → 336 成功 / 0 失败** + 站内一跳栏目）
- 抽取与验证脚本：`.shots/kimi-resources-skills.cjs`（抽表 + 并发验 `SKILL.md`）、
  `.shots/kimi-resources-skills-report.cjs`（汇总，`--markdown` 出机器生成的表格）
- 数据（**全在 `.shots/`，不入库**）：`skills/index.json`（全量）、`skills/tables.md`（机器生成的可导入表）、
  `skills/*.md`（抓到的 SKILL.md 原文）
- 页面内容只当资料；**页面里的安装命令（`curl … | bash` / `irm … | iex` / `npm i -g`）与示例提示词一律未执行**。

## 抽法与判定（写死，避免各人各判）

资源站的技能文章统一是两张表：**商店技能** `技能名称<TAB>技能描述`（描述里自带"…时触发"）、
**开源技能** `技能名称<TAB>说明<TAB>GitHub URL`。

对每个仓库按 13 条常见路径找 `SKILL.md`（文章给的子目录 → 根 → `skills/` → `skill/` → `.claude/skills/`，
分支 `HEAD`/`main`/`master`），全不成再拉仓库首页 HTML 兜底，然后解析 frontmatter：

| 判定           | 含义                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------ |
| **可直接导入** | 拿到 `SKILL.md` 且 frontmatter 有 `name` —— 与 `skill_market.py:417` 的导入硬要求一致（打成 zip 即可） |
| **需要改格式** | 有 `SKILL.md` 但缺 `name`（补一行 frontmatter）                                                        |
| **只有话术**   | 商店技能（只给 `/命令`，无载体），或仓库按上述路径找不到 `SKILL.md`                                    |

## 总统计（全站 336 篇）

| 项                            | 数量                           |
| ----------------------------- | ------------------------------ |
| 商店技能条目                  | **439**                        |
| 开源技能条目                  | **353**（去重 **293 个仓库**） |
| └ **可直接导入**              | **110 条 / 去重 88 个仓库**    |
| └ 需要改格式                  | 5                              |
| └ 只有话术（找不到 SKILL.md） | 238                            |

按节分布（可导入 = 去重仓库数）：PPT 18 条 → **9**；文档 156 条 → **20**；
表格/图表 66 条 → **10**；设计 54 条 → **15**；其余 498 条 → **44**。

> 下面四节的表格是**机器生成后核对过的**（`.shots/.../tables.md`）；说明按文章原表压缩过，
> 完整原文在 `skills/index.json`。

## ① PPT（9 个可直接导入）

| 技能名                        | 干什么                                                                  | 判定       | 仓库                                                          |
| ----------------------------- | ----------------------------------------------------------------------- | ---------- | ------------------------------------------------------------- |
| knowledge-cat-ppt-skill       | 以故事为核心；在可编辑 PPTX / HTML / 图片型 PPTX 之间**路由**，并做质检 | 可直接导入 | https://github.com/gnipbao/knowledge-cat-ppt-skill            |
| guizang-ppt-skill             | 杂志编辑风 + 瑞士版式的 HTML 幻灯片；含图片提示词、社交封面、WebGL 演示 | 可直接导入 | https://github.com/op7418/guizang-ppt-skill                   |
| agentbuff-presentation-skills | 导出 HTML / PDF / PNG / 可编辑 PPTX，**像素级一致**；多套视觉风格预览   | 可直接导入 | https://github.com/nugrahalabib/AgentBuff-Presentation-Skills |
| frontend-slides               | 从零做 HTML 幻灯片或转换 PowerPoint；风格探索 + 精选版式模式            | 可直接导入 | https://github.com/zarazhangrui/frontend-slides               |
| slide-skill                   | 20 种主题、多画布尺寸、排练模式、演讲者备注、TTS、PPTX 校验             | 可直接导入 | https://github.com/icgma/slide-skill                          |
| slide-maestro                 | 视觉预设 + 文案框架（PAS/AIDA/SCQA）+ 叙事策略 + HTML 模板              | 可直接导入 | https://github.com/BFLabsAI/Slide-maestro_agents-skill        |
| slide-writer                  | 想法/大纲/文档/讲稿 → 企业级 HTML 演示                                  | 可直接导入 | https://github.com/FeeiCN/slide-writer                        |
| powerpoint-fancy-design       | 逐页 Markdown → 1600x900 HTML 幻灯片 + PNG + 可导出 PPTX                | 可直接导入 | https://github.com/Phlegonlabs/Powerpoint-fancy-design        |
| slide-creator                 | AI 规划 + 风格探索 + PPTX 导出                                          | 可直接导入 | https://github.com/kaisersong/slide-creator                   |

**商店技能 6 条（无载体，但描述即 frontmatter 素材）**：`business-plan-ppt`（18 页路演 PPTX）、
`geo-magazine-slides-cn`（地理杂志风 PPTX）、`commodity-research-outlook`、`market-insight-report`、
`primary-market-research`、`equity-research-report-cn`（后四条都是"研报 → PDF/DOCX/PPTX"）。

## ② 文档（20 个可直接导入）

| 技能名                              | 干什么                                                                   | 判定       | 仓库                                                           |
| ----------------------------------- | ------------------------------------------------------------------------ | ---------- | -------------------------------------------------------------- |
| office-automation                   | 办公自动化总集：PDF/Word/Excel/PPT 批处理、格式转换、模板生成            | 可直接导入 | https://github.com/texiaoyao/office-automation-skill           |
| pdf-pro                             | Python（reportlab/pypdf/pdfplumber）做 PDF 创建/编辑/审阅/表单/遮盖/校验 | 可直接导入 | https://github.com/DXBMark/pdf-pro                             |
| document-illustrator                | 分析文档（含 PDF），为每个关键主题生成配图                               | 可直接导入 | https://github.com/op7418/document-illustrator-skill           |
| skill-ml-conference-poster-creation | 论文 → 可编辑 PPTX 会议海报（Python 渲染预览、迭代）                     | 可直接导入 | https://github.com/ZLHe0/Skill-ML-Conference-Poster-Creation   |
| journal-adapt-writing               | 围绕一篇论文 + 一个投稿目标，从目标期刊语料生成适配写作技能              | 可直接导入 | https://github.com/WantongC/journal-adapt-writing-skill        |
| paper-writing-skill                 | 论文流水线：大纲 → 润色，按 CS/工程写作惯例                              | 可直接导入 | https://github.com/SNL-UCSB/paper-writing-skill                |
| ai-research-writing-skill           | 论文全生命周期：起草/修改/排版 + 引用管理                                | 可直接导入 | https://github.com/jin-s13/ai-research-writing-skill           |
| vibe-paper-writing                  | 聊天记录/邮件/笔记 → 学术规范 LaTeX 文稿                                 | 可直接导入 | https://github.com/Zhangyanbo/vibe-paper-writing               |
| embodied-ai-paper-writer            | 从 63 篇论文提炼的具身智能顶会写作技能                                   | 可直接导入 | https://github.com/OpenGHz/embodied-ai-paper-writer            |
| sciwrite                            | 科学写作五道审查（冗余/语态/句式/术语一致/数据准确）                     | 可直接导入 | https://github.com/labarba/sciwrite                            |
| humanizer                           | 去 AI 味：删 AI 腔、空洞过渡、无依据夸大                                 | 可直接导入 | https://github.com/blader/humanizer                            |
| better-writing                      | 让邮件/文章/报告/提案更像人写的                                          | 可直接导入 | https://github.com/forjd/better-writing                        |
| professional-business-writing-skill | 商务写作：扫 18+ 种 AI 痕迹并用直接语言重写                              | 可直接导入 | https://github.com/b33kman/professional-business-writing-skill |
| fiction-humanizer-zh                | 中文小说改写/润色：修"情节概述感、人物扁平、对话生硬、钩子弱"            | 可直接导入 | https://github.com/deedeekong07-alt/fiction-humanizer-zh       |
| global-think-tank-analyst           | 战略风险备忘录：证据边界、不确定性、场景、置信度                         | 可直接导入 | https://github.com/vassiliylakhonin/global-think-tank-analyst  |
| proposal-skills                     | 提案全流程：需求发现→资格→商业案例→定价→POC→采购框架                     | 可直接导入 | https://github.com/peterbamuhigire/proposal-skills             |
| skill-forge                         | 从 GitHub 仓库/在线文档/PDF 自动生成可复用技能                           | 可直接导入 | https://github.com/WilliamSaysX/skill-forge                    |
| book-to-skill                       | 技术书 PDF → 可按章节渐进展开的技能                                      | 可直接导入 | https://github.com/virgiliojr94/book-to-skill                  |
| lineage-skill                       | 视频/PDF/转录/笔记 → 带出处的教师技能                                    | 可直接导入 | https://github.com/JuneYaooo/lineage-skill                     |
| content-creation-publisher          | 从云端仓库发布内容技能 + 运行时测试                                      | 可直接导入 | https://github.com/anbeime/skill                               |

**商店技能 90 条里最值得抄描述的**：`paper-review-coach`（模拟同行评审，四维给 Major/Minor）、
`ref-style-converter`（APA/MLA/IEEE/Harvard 互转）、`research-paper-refiner`、`meeting-recap`
（议题/结论/行动项 + 负责人与截止日）、`work-report-writer`（从 git log 生成周报）、`sop-writer`
（流程 → SOP + 流程图 + RACI）、`daily-report`（每日情报简报 PDF）、`copy-editor`（七轮编辑）、
`equity-researcher`（3-5 页速览 / ≥25 页深度研报）、`pro-email-composer`（按收件人身份校准语气）。

## ③ 表格 / 图表（10 个可直接导入）

| 技能名                       | 干什么                                                                    | 判定       | 仓库                                                           |
| ---------------------------- | ------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------- |
| ai-config-table-skill        | 安全编辑 Excel/CSV/TSV/JSON：扫描→校验→预览→差异→**确认前不覆盖**         | 可直接导入 | https://github.com/1aita0v/ai-config-table-skill               |
| recite-agent-skill           | 票据扫描记账：自动重命名 + CSV 日志（OCR + 结构化提取）                   | 可直接导入 | https://github.com/rivradev/recite-agent-skill                 |
| d3-visualization             | D3 图表与交互式可视化（仪表盘、报告、说明图）                             | 可直接导入 | https://github.com/jiannanya/snow-d3                           |
| mckinsey-style-visualization | 杂乱笔记 → 高管级可视化（零依赖 Python 渲染器、12 种模式、真 SVG 幻灯片） | 可直接导入 | https://github.com/kgraph57/mckinsey-style-visualization-skill |
| tufte-data-viz-skill         | Tufte 原则：高数据墨水比、直接标注、小倍数图、迷你图                      | 可直接导入 | https://github.com/caylent/tufte-data-viz                      |
| color-expert-skill           | 色彩科学：色彩空间、APCA/WCAG 无障碍、调色板生成与校验规则                | 可直接导入 | https://github.com/meodai/skill.color-expert                   |
| responsive-craft             | 响应式审查 + 多断点预览（含容器查询、框架探测）                           | 可直接导入 | https://github.com/kylezantos/responsive-craft                 |
| ux-flow-designer             | 需求 → Mermaid 图 + HTML 线框 + 移动优先可点击原型                        | 可直接导入 | https://github.com/ThomasPraun/ux-flow-designer                |
| wireframer-skill             | 低保真手绘风线框图，可点击单页原型（React/Vue/Svelte/HTML）               | 可直接导入 | https://github.com/agilek/wireframer-skill                     |
| icon-generator-skill         | 单图 → Android/iOS 全套应用图标（含 Contents.json）                       | 可直接导入 | https://github.com/anhao/icon-generator-skill                  |

**商店技能 36 条里成色高的**：`chart-gen`（JSON → PNG/SVG 图表）、`data-viz-gen`（JSON → 自包含
HTML 信息图，8 套配色 + 24 图标）、`gantt-chart-builder`（关键路径 CPM）、`chrono-flow`（交互式时间线）、
`dataset-health-audit`（12 维度数据质量审计）、`auto-stat-test`（自动选统计检验）、`weighted-scoring`
（加权评分决策矩阵）。**注意**：这批里有几个（`d3-visualization`、`mckinsey`、`color-expert`、
`responsive-craft`、`ux-flow-designer`、`wireframer`）同时被"表格"和"设计"两节引用，**是同一个仓库**。

## ④ 设计（15 个可直接导入）

| 技能名                                                                                             | 干什么                                                                                           | 判定       | 仓库                                                           |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------- | -------------------------------------------------------------- |
| open-design-skill                                                                                  | 品牌化 `DESIGN.md` + 渲染模板 + 设计参考资料（社区版 Open Design）                               | 可直接导入 | https://github.com/sugarforever/open-design-skill              |
| apple-design-skill                                                                                 | 按 Apple HIG 做跨平台 UI/UX 评审（Flutter/Tauri/Electron/RN）                                    | 可直接导入 | https://github.com/dickwu/apple-design-skill                   |
| figma-context-mcp-skill                                                                            | 通过 MCP 取 Figma 设计上下文/素材，并按规范校验 UI                                               | 可直接导入 | https://github.com/HowardTangOvO/Figma-Context-MCP-Skill       |
| agent-ready                                                                                        | 评估设计文件是否"可交给 AI 用"：查缺失上下文、补元数据、出评审证据                               | 可直接导入 | https://github.com/Owl-Listener/agent-ready                    |
| mckinsey-style-visualization-skill                                                                 | 咨询级可视化（同③）                                                                              | 可直接导入 | https://github.com/kgraph57/mckinsey-style-visualization-skill |
| scientific-plotting-skill                                                                          | 期刊级 ggplot2/plotnine → 矢量 PDF（85/180mm、Wong 配色、Times 排版）                            | 可直接导入 | https://github.com/dazhiyang/scientific-plotting-skill         |
| knowledge-graph-reasoning                                                                          | 建/查/验知识图谱 + 对抗式事实验证（JSON-LD、5 个测试用例）                                       | 可直接导入 | https://github.com/michaelwinczuk/knowledge-graph-reasoning    |
| wireframer-skill / ux-flow-designer / color-expert-skill / icon-generator-skill / responsive-craft | 见③（同仓库跨节引用）                                                                            | 可直接导入 | 见③                                                            |
| jojos-design-skill                                                                                 | 基于荒木飞吕彦视觉原则的设计技能（含时尚模块）                                                   | 可直接导入 | https://github.com/MushroomFleet/jojos-design-skill            |
| genstore-ai-skill                                                                                  | 时尚电商：AI 店铺设计、图生描述、按需印刷                                                        | 可直接导入 | https://github.com/Alpha-Park/genstore-ai-skill                |
| sogni-creative-agent-skill                                                                         | 时尚图像/视频创作（人脸迁移、故事板工作流）                                                      | 可直接导入 | https://github.com/Sogni-AI/sogni-creative-agent-skill         |
| 其余                                                                                               | `pptx-skill`（演示文稿工作区 + 设计简报）、`visualise`（对话内渲染 SVG/HTML 视觉件）归在"其余"节 | —          | 见 `.shots/.../tables.md`                                      |

**商店技能 15 条里最值得抄的"设计系统"型**：`ui-blueprint`（**从截图反抽设计系统**：配色/字体/组件/
间距 → 生成一致的实现提示词，与我们 `tokens.css` 正好互补）、`theme-kit`（10 套预设主题：配色 + 字体）、
`lp-proto-gen`（落地页 HTML 原型五段式）、`photo-magazine-cn`（杂志级横版版式）、
`retro-tech-illustration-cn`、`fashion-sketch-cn`（服装 Tech Pack）。

## 其余 44 个可直接导入（名字级，说明见 `.shots/.../tables.md`）

`review-forge`、`ios-code-audit`、`revise-skill`、`code-review-skill`、`playwright-skill`、
`cypress-agent-skill`、`qa-patrol`、`superstar-engineer-skill`、`ios-agent-skill`、
`alibaba-java-coding-guidelines-skill`、`financial-analysis`（三表/可比公司/DCF/LBO + Excel 模板生成器）、
`financial-red-flag-auditor-skill`、`earnings-analysis`、`personal-finance-skill`、
`notion-crm-lead-processing`、`amo-crm-api`、`qiaomu-goal-meta-skill`、`goal-forge`（SPEC.md + GOAL.md）、
`workflow-orchestration`（Plan Mode + 子智能体委派 + 经验教训）、`overnight-worker`（夜间自主任务）、
`product-manager-skills`、`product-business-finance`、`product-manager-skill`、`pm-agent-skill`、
`visualise`、`pptx-skill`、`video-use`（视频剪辑 + ElevenLabs 配音）、`comfyui-agent-skill`、
`ultimate-ai-media-generator-skill`、`detect-skill`（深度伪造检测）、`slowmist-agent-security`（技能/MCP 安全审查）、
`en-zh-translation-polish`、`best-aeo-skill`、`seo-geo-aeo-skill`、`ecommerce-seo-audit-skill`、`distribb-skill`。

## 能直接进我们技能系统的结论

- **88 个仓库 = 可直接导入**：都有带 `name` 的 `SKILL.md`，走我们现有 zip 导入通道即可
  （`skill_market.py` 要求包内有带 `name` 的 `SKILL.md`）。**本文件不落技能内容**，原文在
  `.shots/kimi-resources/skills/`，交给导入 lane 按通道做（可控）。
- **5 个需要改格式**：有 `SKILL.md` 但缺 `name` —— 补一行。
- **439 条商店技能**：没有可下载载体，但**描述本身就写着触发条件**（"当用户需要…时触发"）——
  正好是 `SKILL.md` 的 `name` + `description` + `when_to_use` 三段。**抄这三段自己写技能**最快。
- **238 条"只有话术"的仓库**：不是"没有技能"，而是按 13 条常见路径没找到 `SKILL.md`
  （技能可能在更深的子目录）。**要挖这批得 clone 后 `find`**，建议放在导入 lane 里做。

## 纪律与边界

- 技能正文只落 `.shots/`；**没有**往仓库 `skills/` 或技能市场目录写任何文件。
- 未核实的数字/说法逐条标了出处页；跨页冲突的数字**不合并引用**。
- 商店技能名在不同文章里偶有出入（表格 `okr-planner` vs 正文 `/okr-strategist`）——**以输入框里那个 `/命令` 为准**。
- 本节只覆盖"技能"这一层；**PPT / 文档 / 表格 / 设计四节的"他们怎么把东西做出来"**（生成机制、
  模板与主题管理、排版/图表/配图、失败降级、设计系统）写在第三批·② ，与本节配套看。
