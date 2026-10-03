# 知识库 Wiki 页面生成调研 v0.1

- 日期：2026-09-13
- 范围：主流产品/开源项目如何自动生成 Wiki 页面，以及 kylab 若要做该怎么接
- 目的：**先看清"Wiki 页面"这件事在业界到底有几种做法、各自代价多大**，再决定 kylab 抄哪条
- 关联：[知识库产品对标调研-v0.1](知识库产品对标调研-v0.1.md)、[笔记功能调研-v0.1](笔记功能调研-v0.1.md)

---

## 0. 一页结论

1. **"Wiki 页面自动生成"不是一个统一功能，而是四条差异很大的路线**：①代码库 Wiki（从源码结构生成）；②语料主题页（聚类 + 分层摘要）；③文档集概览（摘要 / 思维导图 / FAQ）；④人工 Wiki 的 AI 增强（AI 搜索问答，**不自动生成页面**）。前三条是"生成"，第四条只是"问答"——**多数通用知识库产品（Confluence / Outline / Notion / 语雀）属于第四条，它们并不自动写出整站 Wiki**，这一点在选型时最容易误判。
2. **生成质量的上限取决于"结构从哪来"**。代码库路线有天然骨架（AST、模块、依赖图），所以能生成稳定的页面树；通用文档没有骨架，只能靠**聚类**（GraphRAG 的实体社区、RAPTOR 的向量簇）或**文档树**造骨架——这是通用知识库做 Wiki 的核心难点。
3. **两条可直接抄的技术主线**：**RAPTOR 的递归摘要树**（chunk → 聚类 → 摘要 → 再聚类再摘要，天然形成"主题页 → 子主题页"层次）与 **RepoAgent 的增量 diff**（Git 变更 → 只重算受影响的文档，`repoagent diff` 先干跑再生成）。前者解决"页面怎么来"，后者解决"改一个文档后怎么不全量重算"。
4. **成本是这条路线的真正门槛**，不是算法。GraphRAG 式索引要对全语料做实体抽取 + 多层社区摘要，是"每个文档被 LLM 读好几遍"；必须靠**分层按需展开 + 摘要缓存 + 脏标记增量**压住，否则一次全量生成能把 token 预算烧穿。
5. **kylab 的接入点已经预留好了**：`DocumentStage.ENRICHING/ENRICHED` 状态机与 `TaskKind.ENRICH` 本就是为"图谱/Wiki"占的位（`[代码] backend/app/models/enums.py:26`，注释写明"默认关闭，失败不影响主链路"）。chunk 已切好、引用体系与引用快照现成、异步队列的租约/退避/断点续跑可直接承载生成任务。**建议 P0 只做"单文档摘要页"，P1 做主题聚类页，全局概览页留到有真实语料规模再评估。**
6. **产品化现状（两条路线都有人做，但没有"标配"）**：RAPTOR 侧最完整的是 **RAGFlow**（默认关闭的实验性 RAPTOR 开关 + Knowledge Compilation 的 Tree 模板，后者把聚类阈值/聚类比例/摘要长度做成旋钮）；GraphRAG 侧是 RAGFlow 的 Graph 模板 + **Neo4j** 的 SDK/工具链 + 微软自家的开源库（Azure 加速器自述"非官方支持"，仅是演示）。**最接近"语料主题页"的现成产品是 RAGFlow 的 Knowledge Compilation**，其 Wiki 产线 MAP → PLAN → REFINE → **MERGE** 与并发/超时参数可直接作为设计参考（MERGE 是增量合并的落点）。详见 §1.5。

---

## 1. 四条路线取证

### 路线 A：代码库 Wiki —— 结构从源码来，所以最成熟

| 项目 | 产物 | 管线要点 | 增量 |
|---|---|---|---|
| **DeepWiki**（Cognition，Devin Wiki 的公开版；公开索引 5 万+ 仓库） | 页面树 + 架构图 + 可追问的 Q&A | **官方博客未披露内部管线**（本次取证确认：博客只讲入口与规模，无技术细节）。可观察到的是"替换 github.com 为 deepwiki.com"即得结果，说明是**预计算 + 缓存**模式 | 未公开 |
| **deepwiki-rs** | Project Overview / Architecture / Workflow / Deep Dive / Boundary-Interfaces / Database 等**预定义页集合** + C4 模型 Mermaid 图 | 四阶段流水线：**预处理**（结构抽取、模块依赖、注释抽取）→ **分析推理**（System Context / Domain Module / Workflow / Boundary 等 agent，ReAct 循环）→ **文档生成**（各章节 Editor 消费共享记忆）→ **校验增强**（Mermaid 语法校验、图自动修复、质量报告）。**没有独立的"大纲规划"阶段，页面结构是预定义模板**，"Deep Dive"是唯一可变部分 | 有 CacheManager 缓存与 `sync-knowledge` / `--force`；**未做到只重算变更文档**（粗粒度） |
| **RepoAgent**（OpenBMB） | 每个代码对象的 Markdown 文档 + JSON 层级清单 | AST 解析定位代码对象 → 并发逐对象生成文档 → 维护对象间调用关系双向追踪 | **最值得抄的一环**：自动检测 Git 的增/删/改，`repoagent diff` 先列出"哪些文档会被更新/生成"再执行；pre-commit 钩子触发增量更新，标题/正文按变更无缝替换 |

**结论**：代码库 Wiki 之所以能做成产品，是因为**骨架免费**（AST/模块/依赖）。它的三个可迁移动作是：①预定义页面模板 + 少量动态章节；②把"结构事实"（谁引用了谁、文件归属）先抽成结构化数据，再让 LLM 只负责叙述；③**先 diff 后生成**。

### 路线 B：语料主题页 —— 通用文档的骨架只能靠聚类

**GraphRAG（微软）** `[公开]`：LLM 从原文抽取实体/关系建知识图谱 → **对实体做社区检测（分层社区）** → **为每个社区预生成摘要报告（community summary）** → 查询时"每个社区摘要各生成一段局部回答，再汇总成最终回答"。它解决的是 **query-focused summarization（全局性问题）**——"这批资料的主题是什么"这种问题普通 RAG 答不好，因为答案不在任何单个 chunk 里。原文报告在**全面性与多样性**上优于朴素 RAG。
→ **社区摘要天然就是"主题 Wiki 页"**：一个社区 = 一个主题页，分层社区 = 主题页的父子结构。

**RAPTOR（递归摘要树）** `[公开]`：chunk → 向量化 → **聚类** → **每簇摘要** → **对摘要再向量化、再聚类、再摘要**，递归形成一棵"越往上越抽象"的树；检索时可跨层取用，解决"只召回短片段、看不到全局"的问题（论文报告在 QuALITY 上把最好成绩绝对提升 20%）。
→ **这是"Wiki 页面树"最直接的技术原型**，而且**不依赖实体抽取**（比 GraphRAG 便宜、实现简单），对 kylab 这种已有向量库的系统改造成本最低。

### 路线 C：文档集概览 —— 单文档/小集合的摘要产物

- **ima**：文档解析后**自动生成摘要与思维导图**（千页内文献），并把 AI 问答结果沉淀为笔记/知识库内容——它走的是"**单文档 → 概览页**"而非"全库 Wiki"。
- **NotebookLM**：从来源集合生成 overview、mind map、FAQ、timeline 等**多种视图产物**（本次原文抓取超时，仅作方向性参考）。
- 共同点：**产物是"视图"不是"站点"**，页面之间没有强链接结构，也不需要维护一致性。**代价低、见效快，是 kylab 最合适的第一步。**

### 路线 D：人工 Wiki 的 AI 增强 —— 注意：这类不生成页面

Confluence / Outline / Notion / 语雀的 AI 能力集中在**检索问答、续写、模板、摘要**，页面仍由人写、人维护。它们**没有"自动生成整站 Wiki"**这个功能。把它和前三类混为一谈，会得出"主流产品都做了、我们也得做全自动"的错误结论。**真正做自动整站生成的是代码库工具（A）与 RAG 研究路线（B）。**

---

## 1.5 产品化实例：两条路线各自的代表（2026-09 取证）

**结论先说：两条路线都有产品，但没有任何一家把它做成"标配"**——RAPTOR 侧最成熟的产品形态是 RAGFlow 的模板与实验开关，GraphRAG 侧是 RAGFlow 的 Graph 模板 + Neo4j 的 SDK + 微软自家的开源库（Azure 加速器自述"非官方支持产品"）。

| 路线 | 代表 | 产品化形态 | 关键事实（取证） |
|---|---|---|---|
| **RAPTOR** | **RAGFlow 的 RAPTOR** | 文件解析后的**实验性开关**，独立于知识库设置 | chunk → **递归聚类 + 分层摘要**成摘要树；检索用的是**"打平的树"**（原始 chunk 与摘要一起进全文/向量索引），**并非分层检索**；默认关闭，官方明说"开启会消耗更多 token 配额" |
| **RAPTOR** | **RAGFlow Knowledge Compilation 的 Tree 模板** | 数据集内的「Artifacts」产物 | 旋钮是**聚类阈值（clustering threshold）、聚类比例（clustering ratio）、摘要长度、摘要提示词**，产出"知识树"artifact——即"语料主题页"的可调参产品形态 |
| RAPTOR（生态，非产品） | LlamaIndex RAPTOR pack、各向量库的 RAPTOR 教程 | 代码配方 | 没有独立产品，属"自己拼" |
| RAPTOR（形态近似） | NotebookLM 思维导图 / overview、ima 摘要与思维导图 | 单集概览视图 | 分层摘要的产品形态，但不构树、不落页面链接 |
| **GraphRAG** | **RAGFlow Knowledge Compilation 的 Graph 模板** | 同一套编译体系 | 配置项是**实体类型（EntitySpecification）+ 关系类型（RelationSpecification）+ 全局规则**，产出知识图谱 artifact |
| **GraphRAG** | 微软官方 `graphrag` 库 | 开源库 | README 只称"数据管线与转换套件"，**未点名任何采用它的产品**（本次取证确认） |
| **GraphRAG** | Azure `graphrag-accelerator` | 演示级 | 自述"**非微软官方支持的产品**"，只提供 hosted API 与 Quickstart |
| **GraphRAG** | **Neo4j** | SDK + 工具链 | `neo4j-graphrag`（`SimpleKGPipeline` / `VectorCypherRetriever`）、LLM Knowledge Graph Builder、graphrag.com 模式目录；**商业上最认真的一条**，但卖的是图数据库与工具，不是现成 Wiki |
| GraphRAG（反例） | **LightRAG** | 开源框架 | 明确自称"微软 GraphRAG 的高效替代"，**"不依赖低效的社区报告"**，用实体图的 local/global/hybrid/naive 查询模式取全局主题——**连同路线项目都在绕开社区报告，说明那条路成本压力是共识** |

**最接近你要做的"语料主题页"的产品，是 RAGFlow 的 Knowledge Compilation**，它把两条路线都包成了模板，共 6 种：Graph / Tree / PageIndex / MindMap / Timeline / **Wiki**。三点值得直接抄：

1. **接入方式**：编译不是独立功能，而是以 **Compiler 节点接进摄入流水线**（Parser → Chunker → **Compiler** → Indexer），产物作为"辅助信息"回灌检索与问答——**与 kylab 用 `ENRICH` 分支挂在摄入主链路后的设想完全同构**。
2. **Wiki 模板的产线分工**（最能照搬的一条）：**MAP（抽取实体/事实）→ PLAN（页面规划，可开关）→ REFINE（逐页写作）→ MERGE（把新内容合并进已有页面）**。配套参数暴露了真实成本结构：`WIKI_MAP_LLM_POOL_SIZE`（并发 LLM 池上限，默认 20）、`WIKI_MAP_MAX_PENDING`、`WIKI_REFINE_WORKERS`、各阶段超时（MAP/PLAN/MERGE 600s、REFINE 300s）。
3. **MERGE 就是增量更新的落点**：它把"已有页面 + 新生成内容"做合并，而不是整页重写——这比 §3.4 里"标 stale 后整页重算"更省，kylab 若做增量，值得照这个思路设计。

**对 kylab 的直接结论**：

- 走 **RAPTOR 式聚类 + 分层摘要**这条路是有人验证过的：RAGFlow 的 Tree 模板已经把它做成了四个可调旋钮，**这四个旋钮可以直接作为 kylab 主题页的配置项设计参考**（聚类阈值 / 聚类比例 / 摘要长度 / 摘要提示词）。
- 但**别指望"社区报告式 GraphRAG"给你现成参照**：微软没产品化、Azure 只是演示、Neo4j 卖的是数据库、LightRAG 干脆绕开——这条路线的产品化程度明显低于 RAPTOR 侧。
- 成本是共识：RAGFlow 把 RAPTOR 标为**默认关闭的实验开关**并明说多耗 token，这与本报告 §0 的第 4 条判断一致。

---

## 2. 一条生成流水线的六个环节（跨路线共性拆解）

| 环节 | 关键问题 | 业界做法 | kylab 可用资源 |
|---|---|---|---|
| ①骨架 | 页面树从哪来 | 代码：AST/依赖（A）；通用：文档树或聚类（B/C） | 现有文件夹树 + 知识库分区 |
| ②抽取 | 先结构化再叙述 | 所有成熟实现都**先抽出结构化事实**（对象、调用、实体、关系），LLM 只做叙述 | 现有 chunk + 章节路径 + 页码 |
| ③分层摘要 | 怎么形成多级页面 | 递归聚类摘要（RAPTOR）；分层社区报告（GraphRAG） | `llm.py` 的 `complete()`（非流式，适合批处理） |
| ④溯源 | 页面内容凭什么可信 | deepwiki-rs 只做到"交叉引用"，**没有正式引用机制**——这是 kylab 的机会 | **现成的 `[n]` 引用体系 + 引用快照** |
| ⑤增量 | 改一个文档后怎么办 | RepoAgent：Git diff → 先列受影响文档 → 只重算；deepwiki-rs 仅粗粒度缓存 | `content_hash` 可做脏标记；`queue_worker` 的租约/退避/断点续跑 |
| ⑥校验 | 图渲染坏了、模型跑偏 | deepwiki-rs 有 Mermaid 语法校验 + 图自动修复 + 质量报告 | 无现成，需新增（可先做最小校验） |

**两条最容易漏、但决定成败的**：**④溯源**（没有出处的自动 Wiki 没人敢信，kylab 恰好有）与 **⑤增量**（没有增量，一次语料更新就要全量重生成，成本不可持续）。

---

## 3. 对 kylab 的落地建议

### 3.1 数据模型（两表）

```sql
-- wiki_pages：生成出来的页面
CREATE TABLE wiki_pages (
    id           TEXT PRIMARY KEY,
    kb_id        TEXT NOT NULL,          -- 页面属于哪个知识库
    parent_id    TEXT,                   -- 主题页的父子层次（对应摘要树的上一层）
    level        INTEGER NOT NULL DEFAULT 0,  -- 0=文档摘要页, 1..n=主题页层级
    slug         TEXT NOT NULL,
    title        TEXT NOT NULL,
    content_md   TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'draft',  -- draft|generating|ready|stale|failed
    content_hash TEXT,                   -- 生成时的输入指纹，用于判过期
    model        TEXT,                   -- 生成用的模型（可追溯）
    generated_at TEXT,
    created_at / updated_at
);
-- wiki_page_sources：页面的出处（引用与脏标记都靠它）
CREATE TABLE wiki_page_sources (
    page_id    TEXT NOT NULL,
    chunk_id   TEXT NOT NULL,
    doc_id     TEXT NOT NULL,
    weight     REAL NOT NULL DEFAULT 0,  -- 该 chunk 对本页的贡献度（聚类归属）
    PRIMARY KEY (page_id, chunk_id)
);
```

要点：`level + parent_id` 就是 RAPTOR 树的落库形态；`wiki_page_sources` 同时承担**引用渲染**与**增量失效**（文档变 → 查哪些 page 引用了它的 chunk → 只把这些页标 `stale`）。

### 3.2 三档生成策略（按代价递增，建议逐档验收）

**P0 · 单文档摘要页（对标 ima 摘要 / NotebookLM overview）**

- 输入：一篇文档的 chunks（已有，不重新解析）。
- 管线：章节路径聚合 → 分段摘要（map）→ 合并成页（reduce）→ 写 `level=0` 页面。
- 产物：标题、一句话摘要、关键要点、章节导航、**每个要点带 `[n]` 回链到 chunk**。
- 成本：每篇文档 1~2 次 LLM 调用（可先只对 >N 字的长文档生成）。
- 增量：文档 `content_hash` 变 → 该页 `stale` → 队列重算。

**P1 · 主题聚类页（对标 GraphRAG 社区报告，但用 RAPTOR 式轻实现）**

- 输入：知识库内 chunks 的向量（已有 sqlite-vec）。
- 管线：**聚类**（先 k-means/层次聚类，无需实体抽取）→ 每簇 LLM 摘要成一页 → 簇内再聚类形成上层主题页。
- 决策点：**"租一个主题"还是"生成子页"**——建议每簇先产出一页，页内列子主题链接，避免一次性生成整棵树。
- 成本控制：只对簇内代表 chunk 采样摘要（每簇取 N 条 + 标题），不要把整簇原文喂进去。

**P2 · 全局概览页 / 知识地图（可选，规模到了再做）**

- 全库 top-level 摘要 + 页面关系图（可输出 Mermaid mindmap 或前端 ECharts 力导图——前端已有 echarts）。
- 风险最高、最像"炫技"，**没有真实语料规模前不建议做**。

### 3.3 与现有代码的衔接（复用清单）

| 需要的件 | 现成的 | 说明 |
|---|---|---|
| 生成任务承载 | `TaskKind.ENRICH` + `DocumentStage.ENRICHING/ENRICHED` | 已为"图谱/Wiki"占位，**默认关闭、失败不影响主链路**——语义完全吻合，直接用 |
| 异步执行 | `backend/app/workers/queue_worker.py` | 租约心跳、指数退避、断点续跑、协作取消，生成任务不需要新写调度 |
| LLM 调用 | `backend/app/services/llm.py` 的 `complete()` / `stream()` | 批处理用 `complete()`，页面流式预览用 `stream()` |
| 模型选择 | `model_registry` 三层 | 摘要页生成应支持"按库选模型"，与 embedding 的库级属性一致 |
| 检索/采样 | `services/retrieval/service.py` | 主题页需要"这个主题下最相关的原文"，直接复用现成混合检索 |
| 出处与引用 | 对话页 `[n]` 引用体系 + 引用快照 | **不要另起一套引用实现**，Wiki 页的出处直接复用同一渲染与数据形态 |
| 切块与指纹 | `chunking` 的 `chunk_id` / `content_hash` | 增量失效的判据 |

### 3.4 增量与失效（照抄 RepoAgent 的思路）

1. 文档入库/更新完成 → 比对 `content_hash` → 变化则把 `wiki_page_sources` 关联到的页面标 `stale`；
2. **先干跑**（类似 `repoagent diff`）：给出"将重算 N 页、预计 M 次 LLM 调用"，让人确认后再执行——**这是成本失控的唯一有效刹车**；
3. 只重算 `stale` 页；页面的 `content_hash` 用于判断"输入没变就别重算"（重试与幂等友好）；
4. 生成失败：页面置 `failed` 并可重试，**不阻塞摄入主链路**（沿用 ENRICH 分支"失败不影响主链路"的既有约定）。

### 3.5 风险与明确不做

- **幻觉与"一本正经的废话"**：自动 Wiki 最大的风险是读起来通顺但无出处。对策：**每个要点强制带出处**；无出处的段落宁可不生成；页面上标注生成模型与时间。
- **成本**：GraphRAG 式全量索引是"每个文档被 LLM 读多遍"。**不做全量重生成**，靠采样 + 增量 + 干跑确认压成本。
- **一致性**：不同时间生成的页面风格会漂。对策：固定 prompt 模板与结构化输出（页头字段 + 固定小节），把"生成"当成有 schema 的抽取任务而非自由写作。
- **明确不做**：整站全自动重写、多人协作编辑 Wiki、页面级权限（沿用知识库分享即可）。

---

## 4. 照抄清单：能直接拿来用的现成产物

前面讲的是"路线怎么选"，这一节讲**"哪几行东西可以不动脑子照着做"**。结论是：**算法、参数、页面规范、并发/超时默认值都有现成的，唯一必须自己写的是"跨文档"这一层。**

### 4.1 三份可直接抄的资产（外加一个必须自研的点）

| 资产 | 出处 | 为什么能直接抄 |
|---|---|---|
| **RAGFlow 的内置编译模板（YAML 明文）** | `api/db/init_data/compilation_templates/*.yaml`（`tree.yaml`、`wiki.yaml`、`wiki/{general,brand,engineering,market,product,user_interview}.yaml`） | 提示词、参数、实体 schema、页面写作规范全在 YAML 里，**"模板即数据"**——照这个设计，kylab 改提示词不需要改代码 |
| **RAPTOR 实现与参数** | `rag/advanced_rag/knowlege_compile/raptor.py`（Python，可读性最好）与 `internal/ingestion/component/knowledge_compiler/tree/raptor.go` | 聚类策略、参数默认值与取值域、取消检查都是现成的 |
| **claim + evidence 抽取（引用可校验）** | `tree.yaml` 的 `claim_prompt` + `tree/claims.go` + `structure` 的 `_struct_apply_evidence_gate` | **每条断言强制带逐字引文与 chunk_id，引文必须是原文的连续子串，否则下游直接拒收**——这正是本报告 §3.5 要求的"无出处宁可不生成"，人家已经实现成了校验闸门 |
| **RAPTOR 官方参考实现（MIT，1.7k★）** | https://github.com/parthsarthi03/raptor | 三个可替换抽象（Summarization / QA / Embedding Model）+ classic 与 Psi 两种树策略，作为对照实现读一遍就够 |

**必须自己写的一点**：RAGFlow 的 `tree.yaml` 自述是 **"over a single document's chunks"**——它的 Tree 模板是**单文档**摘要树；跨文档的只有 Wiki 模板，而 Wiki 是**图式（实体页）**路线。你要的"**语料主题页**"= **把 Tree 的聚类+分层摘要算法从单文档提升到知识库级**，这一层没有现成的，但改造量只是"把输入从一篇文档的 chunks 换成一库的 chunks"，算法本身照抄。

### 4.2 逐项：抄什么、拿到什么、怎么用

| # | 抄的东西 | 具体内容（取证原文） | kylab 怎么用 |
|---|---|---|---|
| 1 | **RAPTOR 参数默认值** | `max_token=512`（钳制在 512–2048）、`small_layer_collapse=8`、`clustering_threshold=0.3`、`clustering_ratio=0.5`、`max_cluster` | 直接作为主题页生成的默认配置；这几个旋钮与 §1.5 里 RAGFlow 文档页暴露给用户的旋钮一一对应 |
| 2 | **聚类算法细节** | 相邻块的余弦相似度**低于阈值即为簇边界**（分水岭式）；阈值法产出的簇数超过 `clustering_ratio × 块数` 上限时，**抬高阈值重试** | 不需要引入 GMM/UMAP 那一套（论文用，工程上重）；照抄这个"分水岭 + 比例封顶"更好实现，也更好解释 |
| 3 | **claims 先于聚类** | 注释原文：*"Claim extraction runs before clustering so the cluster summaries can be built from claims"*；簇摘要的输入是 **claims 而不是原文**，且 claims **作为独立可检索行持久化** | 两个好处：①摘要输入更短更稳（省钱）；②检索可直接命中"断言"粒度，而不是又一大段摘要 |
| 4 | **逐字引证闸门** | `evidence.quote` 必须是 chunk 的**连续逐字子串**（同词序、不得改写、不得截断、<240 字符），表格行要保留分隔符原样；**校验不过则下游拒收** | 直接搬这个校验规则到 kylab 的页面生成：**没有通过逐字校验的句子不写进页面**，比"事后人工检查"可靠得多 |
| 5 | **页面写作规范** | `wiki.yaml` 的 `instruction`：百科式文章而非 bullet 列表；开篇 2–4 句定义、无标题；H2 分节且先散文后子项；**关键术语首用加粗**；用 `[[ ]]` wikilink 互链；结尾 `## See also`（少于 12 条） | 作为 kylab 主题页提示词的骨架，连"See also 少于 12 条"这种细节都可直接用 |
| 6 | **主题化指令（可切换）** | `wiki/general.yaml` 等 6 个主题包（general / brand / engineering / market / product / user_interview），每个是一段 `instruction` | 对应 kylab 的"模板"概念：同库可切换不同写作口径 |
| 7 | **实体抽取 schema** | `wiki.yaml` 的 `entity.fields`：person / org / product / regulation / location / system / equipment / other，每条含 `description` + `rule` + **最大长度**（60–120 字符） | 若 kylab 主题页要抽实体（可选），schema 直接可用 |
| 8 | **并发与超时默认值** | `WIKI_MAP_LLM_POOL_SIZE=20`、`WIKI_MAP_MAX_PENDING=25`、`WIKI_REFINE_WORKERS=4`、`WIKI_MAP_WORKERS=20`、MAP/PLAN/MERGE 超时 600s、REFINE 300s；**LLM 池是硬上限，限流时池会自行降并发** | 作为 kylab 生成任务的默认并发/超时；注意它**把聚类与 embedding 也算进同一个限流池**（注释原文："chat_limiter (which also serves clustering and embedding)"），这个坑要提前避 |
| 9 | **任务编排形态** | `internal/engine/nats/knowledgecompile.go`：编译任务走 **NATS 队列 + 租约**（acquire / heartbeat / release，带 revision 防重复持有）+ 消费批拉 | 与 kylab `queue_worker` 的租约/心跳**同构**，不需要换队列，只抄"每阶段独立超时 + 租约续期"的参数设计 |
| 10 | **模板清单（覆盖面参考）** | 6 种：Graph / Tree / PageIndex / MindMap / Timeline / Wiki | kylab 先做 Tree（主题页）+ 可选 MindMap（前端已有 echarts）；Graph 缓做 |

### 4.3 许可与合规（抄之前必须确认）

| 来源 | 许可证 | 抄的边界 |
|---|---|---|
| **RAGFlow** | **Apache-2.0** | **代码可抄**（含 YAML 模板），需保留版权声明与 NOTICE、修改过的文件要标注；与 kylab 的 MIT 兼容。**建议**：算法、参数、schema 照搬；**提示词文本属"表达"，逐字复制请保留出处声明，更稳妥的做法是改写后使用** |
| RAPTOR 参考实现 | MIT | 可抄，保留许可与版权声明 |
| RAPTOR / GraphRAG 论文 | 论文方法（思想）不受版权保护，**文字表达受保护** | 抄方法、抄参数，别抄论文原文段落 |
| LightRAG | MIT | 若想走"不用社区报告"的图式全局检索，可直接读 |
| Neo4j / Azure 加速器 | 各自许可，且 Azure 加速器非官方支持 | 只作参考，不建议进生产依赖 |

### 4.4 落到 kylab 的三步（把"抄"变成可执行）

1. **建 `compilation_templates` 表，模板即数据**（照 RAGFlow 的 YAML 落库方式）：字段 `kind / display_name / instruction / prompt / params(json) / global_rules`；内置 tree 模板的初始数据**按 §4.2 第 1、5、6 项填默认值**。这样 P1 阶段调参不用发版。
2. **按 §3.1 两表 + 一张可选的 `wiki_claims` 表**：若采纳第 3 项，claims 独立成行并进 FTS5/向量索引，检索能命中"断言"粒度；页面的 `[n]` 出处直接指向 claim 的 `chunk_id`，与现有引用体系天然对接。
3. **生成任务全走 `ENRICH` + `queue_worker` 租约**，按第 8 项设每阶段超时与并发上限，**并保证聚类/向量化与 LLM 生成共用一个限流池**（这是 RAGFlow 踩过的坑）。

---

## 5. 建议的最小实施顺序

| 步 | 内容 | 预估 |
|---|---|---|
| 1 | 两表 + 迁移；`ENRICH` 任务接入 queue_worker；提示词模板 | 1–2 人日 |
| 2 | P0 单文档摘要页（map-reduce + `[n]` 出处回链）+ 前端一个只读页 | 2–3 人日 |
| 3 | 增量失效（hash → stale → 干跑确认 → 重算） | 1–2 人日 |
| 4 | P1 主题聚类页（先 k-means + 每簇采样摘要） | 3–4 人日 |
| 5 | 质量校验（Mermaid/链接/出处完整性）与前端导航 | 2 人日 |

---

## 6. 参考来源

### 6.1 可直接抄的代码与模板（§4 的取证出处）

- RAGFlow 内置编译模板（Apache-2.0，YAML 明文，含提示词与参数）：
  - `tree.yaml`（自述 "Tree — RAPTOR-based document tree"，含 `raptor.prompt`、`max_token`、`clustering_threshold`、`clustering_ratio`、`claim_prompt`）：https://github.com/infiniflow/ragflow/blob/main/api/db/init_data/compilation_templates/tree.yaml
  - `wiki.yaml`（页面写作 `instruction` + 实体 `entity.fields`）：https://github.com/infiniflow/ragflow/blob/main/api/db/init_data/compilation_templates/wiki.yaml
  - 主题包 `wiki/*.yaml`（general / brand / engineering / market / product / user_interview）：https://github.com/infiniflow/ragflow/tree/main/api/db/init_data/compilation_templates/wiki
- RAGFlow RAPTOR 实现（参数与两种树策略）：https://github.com/infiniflow/ragflow/blob/main/rag/advanced_rag/knowlege_compile/raptor.py · Go 版：https://github.com/infiniflow/ragflow/blob/main/internal/ingestion/component/knowledge_compiler/tree/raptor.go
- RAGFlow claim 抽取与引文校验：https://github.com/infiniflow/ragflow/blob/main/internal/ingestion/component/knowledge_compiler/tree/claims.go
- RAGFlow 编译任务的队列与租约：https://github.com/infiniflow/ragflow/blob/main/internal/engine/nats/knowledgecompile.go
- RAGFlow 编译运行参数（并发池与超时默认值）：https://github.com/infiniflow/ragflow/blob/main/docs/guides/knowledge_compilation/runtime_configuration.md
- RAPTOR 官方参考实现（MIT，可替换的 Summarization/QA/Embedding 抽象）：https://github.com/parthsarthi03/raptor

### 6.2 定位与对比来源

- DeepWiki：https://cognition.com/blog/deepwiki（本次抓取确认：**官方未披露生成管线**，只有入口与规模） · https://deepwiki.com/
- deepwiki-open（DeepWiki 开源实现）：https://github.com/AsyncFuncAI/deepwiki-open（README 只列四步功能，无管线细节）
- deepwiki-rs（四阶段流水线 + C4 Mermaid 图 + 校验修复）：https://github.com/sopaco/deepwiki-rs
- RepoAgent（AST 结构 + Git diff 增量 + `repoagent diff` 干跑）：https://github.com/OpenBMB/RepoAgent
- GraphRAG（实体图 + 分层社区报告 + 全局问题 map-reduce）：https://arxiv.org/abs/2404.16130 · https://microsoft.github.io/graphrag/index/overview/ · 官方库 README（未点名任何采用产品）：https://github.com/microsoft/graphrag
- Azure graphrag-accelerator（自述"非官方支持"的演示）：https://github.com/Azure-Samples/graphrag-accelerator
- RAPTOR（递归聚类摘要树）：https://arxiv.org/abs/2401.18059
- RAGFlow 的 RAPTOR（实验开关、默认关、多耗 token、"打平的树"检索）：https://ragflow.io/blog/long-context-rag-raptor
- RAGFlow Knowledge Compilation（Graph/Tree/PageIndex/MindMap/Timeline/Wiki 六模板、Compiler 接进流水线）：https://ragflow.io/docs/dev/knowledge_compilation/overview
  - 模板与旋钮（Tree 的聚类阈值/聚类比例/摘要长度；Wiki 的 Plan 与实体/关系规格）：https://github.com/infiniflow/ragflow/blob/main/docs/guides/knowledge_compilation/built_in_templates_and_dedicated_configuration.md
  - Artifacts（产物在数据集内浏览、回灌检索）：https://github.com/infiniflow/ragflow/blob/main/docs/guides/dataset/artifacts_knowledge_artifact_generation_and_management.md
- Neo4j GraphRAG（`neo4j-graphrag` SDK、LLM Knowledge Graph Builder、graphrag.com 模式目录）：https://neo4j.com/blog/genai/what-is-graphrag/
- LightRAG（自称 GraphRAG 替代，明确不用社区报告）：https://github.com/HKUDS/LightRAG
- ima 文档摘要与思维导图：https://ima.qq.com/
- NotebookLM（overview / mind map / FAQ / timeline 多视图）：https://support.google.com/notebooklm/（本次原文抓取超时，仅作方向性参考）

（公开资料检索时间：2026-09-13；标注 `[代码]` 的结论来自本仓库源码）
