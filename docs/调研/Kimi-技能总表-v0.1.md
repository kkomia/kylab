# Kimi 资源站 技能总表 v0.2（第三批·①，已修正）

- 抓取日期：**2026-09-29**（全站 `/resources/` **336 篇** + 站内 **69 个栏目页**，全部成功 0 失败）
- 脚本（都在 `.shots/`）：`kimi-resources-skills.cjs`（抽两张技能表）、
  `kimi-resources-skills-deep.cjs`（整仓 tarball 复验，**v0.2 的关键修正**）、
  `kimi-resources-skills-report.cjs`（汇总 + `--markdown` 出机器生成表格）
- 数据（**只在 `.shots/kimi-resources/skills/`，不入库**）：`index.json`（全量含判定）、
  `tables.md`（机器生成的表）、`*.md`（抓到的 SKILL.md 原文）
- 页面只当资料；**页面里的安装命令与示例提示词一律未执行**。

## v0.1 → v0.2：我错在哪（结论：是我探测方式的问题）

v0.1 报"**只有话术 238 条 / 可直接导入 88 个仓库**"。复核后发现两个 bug，都在我这边：

1. **`/tree/<分支>/<子目录>` 链接被整段当成目录名**。例：
   `github.com/K-Dense-AI/scientific-agent-skills/tree/main/skills/paper-lookup` 被解析成目录
   `tree/main/skills/paper-lookup` → 去问 `…/tree/main/skills/paper-lookup/SKILL.md`（必然 404）。
   这一条吃掉了大批"一个仓库挂很多技能"的 monorepo（`scientific-agent-skills` 一家就 11 个）。
2. **404 与 429/限流不分**。并发 8 × 13 条路径 ≈ 3800 次请求，被限流的也记成"找不到"，
   而我把两者合并成了一个数字。

**修法**：按修好的路径先试 raw；**全不成再下整仓 tarball（codeload）解压遍历所有 `SKILL.md`**——
只要仓库里有就一定找得到。每个仓库记录 HTTP 状态，429/5xx 退避重试。

**修正后的判定**（去重 **293 个仓库**）：

| 判定                                  | v0.1（错） | **v0.2（对）**               |
| ------------------------------------- | ---------- | ---------------------------- |
| **可直接导入**                        | 88         | **268 个仓库（323 条条目）** |
| 需要改格式（有 SKILL.md 但缺 `name`） | 5          | 3 个仓库（5 条）             |
| 只有话术                              | 205        | **22 个仓库（25 条）**       |

复验的 HTTP 状态分布：**200 → 192 个 / 404 → 2 个**（其余为 raw 命中）。

## 剩余 22 个"只有话术"的否定性证据

这些是**整仓扫过**之后仍然没有 `SKILL.md` 的（括号里是归档大小）：

- **文章挂错了链接（根本不是技能仓库）**：`openai/whisper`（7093KB）、`taskflow/taskflow`（41543KB）、
  `khoj-ai/openpaper`（56999KB）、`liangdabiao/langgraph_multi-agent-rag-customer-support`（5556KB）、
  `ustc-table-mining/TabClaw`（50412KB）、`rishishanbhag/Ticket-AI`（102KB）、
  `carloocchiena/python_seo_automation_pack`（40KB）、`deepakmashyal143/git-smith-workflows`（6KB）、
  `mgreiler/code-review-checklist`（3KB）、`zarazhangrui/lark-minutes-tasks`（7KB）、
  `chenyl8848/great-open-source-project`（145KB）
- **是"清单/聚合"仓库，技能在别处**：`InternScience/Awesome-Scientific-Skills`（1106KB）、
  `ANVEAI/awesome-openclaw-skills`（11KB）、`heilcheng/awesome-agent-skills`（2094KB）、
  `Gak6900/awesome-frontend-skills`（535KB）、`SYuan03/Skill-Anything`（1541KB）、
  `WenyuChiou/ai-research-skills`（8494KB）
- **工具仓库（不是技能）**：`navfa/skills-md-graph`（60KB）、`hanamizuki/obsidian-skill-graph`（77KB）、
  `kurtpayne/skillscan-lint`（74KB）——它们正是我在第一批里引用的"技能依赖图/lint 工具链"
- **不是仓库链接**：`github.com/topics/skill-md`（GitHub 主题页）
- **归档取回是 0KB（异常）**：`eduard22222222/claude-skill-stack`（文章给的是
  `…/blob/main/skills/customer-support/SKILL.md`，解析后路径正确但 tarball 空）——**这 1 个待人工看一眼**

## 按节的可导入清单（去重仓库）

条目数（同一仓库被多篇文章引用会重复计）与可导入仓库数：

| 节        | 条目 | 开源 / 商店 | 可导入仓库        |
| --------- | ---- | ----------- | ----------------- |
| PPT       | 18   | 12 / 6      | **8**（条目 12）  |
| 文档      | 156  | 66 / 90     | **43**（条目 46） |
| 表格/图表 | 66   | 30 / 36     | **23**（条目 25） |
| 设计      | 54   | 39 / 15     | **26**（条目 36） |
| 其余      | 498  | 206 / 292   | **170**           |

### PPT（8 个仓库，说明为文章原表摘要）

| 技能                            | 干什么                                                                            | 仓库                                                          |
| ------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| knowledge-cat-ppt-skill         | 以故事为核心；可编辑 PPTX / HTML / 图片型 PPTX 之间**路由** + 质检                | https://github.com/gnipbao/knowledge-cat-ppt-skill            |
| guizang-ppt-skill               | 杂志编辑风 + 瑞士版式 HTML 幻灯片（图片提示词/社交封面/WebGL）                    | https://github.com/op7418/guizang-ppt-skill                   |
| agentbuff-presentation-skills   | 导出 HTML/PDF/PNG/可编辑 PPTX，**像素级一致**                                     | https://github.com/nugrahalabib/AgentBuff-Presentation-Skills |
| frontend-slides                 | 从零做 HTML 幻灯片或转 PPT；风格探索 + 版式模式                                   | https://github.com/zarazhangrui/frontend-slides               |
| slide-skill                     | 20 种主题、多画布、排练模式、演讲者备注、TTS、PPTX 校验                           | https://github.com/icgma/slide-skill                          |
| slide-maestro                   | 视觉预设 + 文案框架（PAS/AIDA/SCQA）+ 叙事策略                                    | https://github.com/BFLabsAI/Slide-maestro_agents-skill        |
| **html2pptx**                   | 浏览器渲染的 HTML/WebDeck → **可编辑 PPTX**（保留可编辑元素、图表转矢量）         | https://github.com/GX-Alex/html2pptx                          |
| **image-to-editable-ppt-skill** | 演示文稿**图片 → 可编辑 PowerPoint**（提取素材、重建文字与版式、批量重建 + 质检） | https://github.com/ningzimu/image-to-editable-ppt-skill       |
| slide-writer                    | 想法/大纲/文档/讲稿 → 企业级 HTML 演示                                            | https://github.com/FeeiCN/slide-writer                        |
| powerpoint-fancy-design         | 逐页 Markdown → 1600x900 HTML + PNG + 可导出 PPTX                                 | https://github.com/Phlegonlabs/Powerpoint-fancy-design        |
| slide-creator                   | AI 规划 + 风格探索 + PPTX 导出                                                    | https://github.com/kaisersong/slide-creator                   |
| starry-slides                   | HTML 为源格式的创建与编辑；含**需求收集流程**与模板参考                           | https://github.com/StarryKit/starrykit-plugin                 |

商店技能 6 条（无载体）：`business-plan-ppt`、`geo-magazine-slides-cn`、`commodity-research-outlook`、
`market-insight-report`、`primary-market-research`、`equity-research-report-cn`。

### 文档（43 个仓库，名 + 仓库）

`research-paper-writing-skills` https://github.com/Master-cai/Research-Paper-Writing-Skills ｜
`academic-writing-agents` https://github.com/andrehuang/academic-writing-agents ｜
`aut-sci-write` https://github.com/ShZhao27208/Aut_Sci_Write ｜
`econ-writing-skill` https://github.com/hanlulong/econ-writing-skill ｜
`journal-adapt-writing` https://github.com/WantongC/journal-adapt-writing-skill ｜
`academic-paper-skills` https://github.com/lishix520/academic-paper-skills ｜
`paper-writing-skill` https://github.com/SNL-UCSB/paper-writing-skill ｜
`humanizer` https://github.com/blader/humanizer ｜
`plain-writing-skill` https://github.com/docwriter-org/plain-writing-skill ｜
`sales-page-copywriting-skill` https://github.com/yashaiguy-dev/Sales-Page-Copywriting-Skill ｜
`global-think-tank-analyst` https://github.com/vassiliylakhonin/global-think-tank-analyst ｜
`skill-memo` https://github.com/aliksir/skill-memo ｜
`professional-business-writing-skill` https://github.com/b33kman/professional-business-writing-skill ｜
`proposal-skills` https://github.com/peterbamuhigire/proposal-skills ｜
`email-marketing-skill` https://github.com/jacquescorbytuech/email-marketing-skill ｜
`cold-email-salesblink` https://github.com/open-salesblink/skill ｜
`better-writing` https://github.com/forjd/better-writing ｜
`skill-forge` https://github.com/WilliamSaysX/skill-forge ｜
`thesis-writing-skill` https://github.com/santifs/thesis-writing-skill ｜
`skill-ml-conference-poster-creation` https://github.com/ZLHe0/Skill-ML-Conference-Poster-Creation ｜
`ogilvy` https://github.com/boraoztunc/skills ｜
`novel-writing` https://github.com/wgwtest/novel-writing ｜
`novel-project-strategy` https://github.com/wgwtest/novel-project-strategy ｜
`fiction-humanizer-zh` https://github.com/deedeekong07-alt/fiction-humanizer-zh ｜
`creative-writing-skills` https://github.com/haowjy/creative-writing-skills ｜
`pdf-pro` https://github.com/DXBMark/pdf-pro ｜
`book-to-skill` https://github.com/virgiliojr94/book-to-skill ｜
`pdf-viewer-sdk-skills` https://github.com/syncfusion/pdf-viewer-sdk-skills ｜
`lineage-skill` https://github.com/JuneYaooo/lineage-skill ｜
`office-automation` https://github.com/texiaoyao/office-automation-skill ｜
`document-illustrator` https://github.com/op7418/document-illustrator-skill ｜
`research-paper-review` https://github.com/BESSER-PEARL/research-agent-skills ｜
`kreuzberg` https://github.com/xberg-io/xberg ｜
`pm-skills` https://github.com/product-on-purpose/pm-skills ｜
`content-creation-publisher` https://github.com/anbeime/skill ｜
`embodied-ai-paper-writer` https://github.com/OpenGHz/embodied-ai-paper-writer ｜
`sciwrite` https://github.com/labarba/sciwrite ｜
`vibe-paper-writing` https://github.com/Zhangyanbo/vibe-paper-writing ｜
`anti-slop-writing` https://github.com/adewale/anti-slop-writing ｜
`ai-research-writing-skill` https://github.com/jin-s13/ai-research-writing-skill ｜
`agent-research-skills` https://github.com/lingzhi227/agent-research-skills ｜
`scientific-agent-skills` https://github.com/k-dense-ai/scientific-agent-skills（**monorepo，11 个技能**）｜
`medical-research-skills` https://github.com/aipoch/medical-research-skills

商店技能 90 条里最值得抄描述的：`paper-review-coach`、`ref-style-converter`、`meeting-recap`、
`work-report-writer`、`sop-writer`、`daily-report`、`copy-editor`、`equity-researcher`、`pro-email-composer`。

### 表格 / 图表（23 个仓库）

`snow-d3`（D3 图表与交互可视化）https://github.com/jiannanya/snow-d3 ｜
`svg-design` https://github.com/tryopendata/skills ｜
`data-visualization` https://github.com/aj-geddes/useful-ai-prompts ｜
`preview-d3` https://github.com/veelenga/preview-skills ｜
`markdown-viewer-skills` https://github.com/markdown-viewer/skills ｜
`data-analytics-skills` https://github.com/nimrodfisher/data-analytics-skills ｜
`d3-visualization-skill` https://github.com/nexu-io/open-design/blob/main/skills/d3-visualization/SKILL.md ｜
`tufte-data-viz-skill` https://github.com/caylent/tufte-data-viz ｜
`data-visualization-report-skill` https://github.com/nexu-io/open-design/blob/main/skills/data-report/SKILL.md ｜
`analytics-tracking-measurement-strategy` https://github.com/diegosouzapw/awesome-omni-skills/blob/main/skills/analytics-tracking/SKILL.md ｜
`designer-skills-collection` https://github.com/Owl-Listener/designer-skills ｜
`inclusive-design-skills` https://github.com/Owl-Listener/inclusive-design-skills ｜
`wireframer-skill` https://github.com/agilek/wireframer-skill ｜
`motion-design-skill` https://github.com/LottieFiles/motion-design-skill ｜
`color-expert-skill` https://github.com/meodai/skill.color-expert ｜
`icon-generator-skill` https://github.com/anhao/icon-generator-skill ｜
`responsive-craft` https://github.com/kylezantos/responsive-craft ｜
`brand-to-design-md-skill` https://github.com/shaom/brand-to-design-md-skill ｜
`ux-flow-designer` https://github.com/ThomasPraun/ux-flow-designer ｜
`ai-config-table-skill`（**确认前绝不覆盖原文件**）https://github.com/1aita0v/ai-config-table-skill ｜
`recite-agent-skill`（票据 OCR → CSV）https://github.com/rivradev/recite-agent-skill ｜
`excel-sheet` https://github.com/bg-szy/TOP-SKILLS ｜
`open-ptc-agent` https://github.com/Chen-zexi/open-ptc-agent

商店技能 36 条里成色高的：`chart-gen`、`data-viz-gen`（JSON → 自包含 HTML 信息图，8 套配色 + 24 图标）、
`gantt-chart-builder`（关键路径 CPM）、`chrono-flow`、`dataset-health-audit`、`auto-stat-test`、`weighted-scoring`。

### 设计（26 个仓库）

`mckinsey-style-visualization-skill` https://github.com/kgraph57/mckinsey-style-visualization-skill ｜
`scientific-plotting-skill` https://github.com/dazhiyang/scientific-plotting-skill ｜
`tableau-dashboard-creator-skill` https://github.com/laviDrori0702/tableau-dashboard-creator-skill ｜
`dashboard-governance-skill` https://github.com/buccaneermethodology/dashboard-governance-skill ｜
`knowledge-graph-reasoning` https://github.com/michaelwinczuk/knowledge-graph-reasoning ｜
`aeo-schema-skill` https://github.com/yulia-glukhova/aeo-schema-skill ｜
`skill-graph` https://github.com/quaylabshq/skill-graph ｜
`ugc-fashion` https://github.com/tfcbot/rawugc-skills ｜
`jojos-design-skill` https://github.com/MushroomFleet/jojos-design-skill ｜
`morpheus-fashion-design` https://github.com/PauldeLavallaz/morpheus-fashion-design ｜
`genstore-ai-skill` https://github.com/Alpha-Park/genstore-ai-skill ｜
`sogni-creative-agent-skill` https://github.com/Sogni-AI/sogni-creative-agent-skill ｜
`ai-agents-skills` https://github.com/hoodini/ai-agents-skills ｜
`ds-skills` https://github.com/wenmin-wu/ds-skills ｜
`fabric-skills` https://github.com/PatrickGallucci/fabric-skills ｜
`skills-for-fabric` https://github.com/microsoft/skills-for-fabric ｜
`ui-ux-agent-skill-system` https://github.com/sergekostenchuk/ui-ux-agent-skill-system ｜
`ui-craft`（含**设计令牌**、动效、排版、色彩、无障碍参考资料）https://github.com/educlopez/ui-craft ｜
`open-design-skill` https://github.com/sugarforever/open-design-skill ｜
`tasteful-ui-skill` https://github.com/DonkeyKing01/tasteful-ui-skill ｜
`ux-discovery-interviewer` https://github.com/JacobLinCool/ux-discovery-interviewer-skill ｜
`apple-design-skill` https://github.com/dickwu/apple-design-skill ｜
`uxui-principles-agent-skills` https://github.com/uxuiprinciples/agent-skills ｜
`figma-ai-bridge` https://github.com/renfei-design/Figma-AI-Bridge ｜
`agent-ready` https://github.com/Owl-Listener/agent-ready ｜
`figma-context-mcp-skill` https://github.com/HowardTangOvO/Figma-Context-MCP-Skill

商店技能 15 条里最值得抄的"设计系统"型：**`ui-blueprint`（从截图/设计稿抽完整设计系统：配色/字体/
组件/间距 → 设计文档 + 一致的实现提示词）**、`theme-kit`（10 套预设主题：配色+字体）、
`lp-proto-gen`（落地页五段式）、`journalistic-portrait-cn`、`retro-tech-illustration-cn`、`fashion-sketch-cn`。

## 结论

- **268 个仓库可直接导入**（都有带 `name` 的 `SKILL.md`）→ 走现有 zip 导入通道
  （`skill_market.py` 要求包内有带 `name` 的 `SKILL.md`）。**技能正文只在 `.shots/`**，交给导入 lane 按通道做。
- **3 个需补 frontmatter `name`**；**22 个仓库确实没有 SKILL.md**（证据见上，多数是文章挂错链接或聚合清单）。
- **439 条商店技能**无载体，但描述即 `name`+`description`+`when_to_use` 三段，**抄这三段最快**。
- 商店技能名在不同文章里偶有出入（表格 `okr-planner` vs 正文 `/okr-strategist`）→ **以 `/命令` 为准**。

## 纪律与边界

- 技能正文只落 `.shots/`；**没有**往仓库 `skills/` 或技能市场目录写任何文件。
- 未核实的数字/说法逐条标出处；跨页冲突的数字不合并引用。
- **本次修正的教训**：判定"某仓库里没有某文件"这类**否定结论**，必须用整仓扫描（tar 遍历）而不是
  "若干条猜测路径都 404"；并且**必须把 404 与限流分开记**——否则一个解析 bug 会把 200 多个仓库误判成"没有"。

## 落地时发现的两条（2026-09-29，批量补装那一轮记）

- ⚠️ **仓库清单要以 `.shots/kimi-resources/skills/index.json` 的 253 个为准，本文表格里的链接不全**。
  实测：本文正文里能正则出的 `github.com/<owner>/<repo>` 只有 **105 个**，而抓取索引里有 **253 个**，
  且索引**完全包含**那 105 个（只在文档里 0 个、只在索引里 **148 个**）。
  照文档跑批量补装，会**永久漏掉 148 个仓库**（例如 `spencerpauly/awesome-cursor-skills`、
  `nexscope-ai/eCommerce-Skills`）——这一轮就是这么漏过一次，后来改用并集才补上。
- ⚠️ **`.ps1` 必须存成 UTF-8 with BOM**：Windows PowerShell 5.1 对**无 BOM** 的 `.ps1` 按 GBK 解码，
  中文注释会让脚本在**解析期**就死（报 `Missing type name after '['`），而它**不会**留下任何日志——
  看起来像"跑着但没输出"。本条与 `scripts/dev-backend.ps1:3` 记的是同一个坑。
