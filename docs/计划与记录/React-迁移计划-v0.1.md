# React 迁移计划 v0.1（路线 B：全量迁）

- 日期：2026-09-23
- 决策：用户拍 **路线 B —— 前端全量从 Vue 迁到 React**（评估见
  [前端技术栈与 chat UI 重做评估 v0.1](../调研/前端技术栈与-chat-UI-重做评估-v0.1.md)）。
- 两条硬要求（用户原话）：**"尽可能直接复用成熟的代码，能复用就复用，直接抄，不要重复造轮子"**；
  **"参考成熟方案的代码时要去网络仓库上拉最新版本，不要在本地找代码，因为可能过时了"**。
- 配套：[开发计划 §12.230](../计划与记录/开发计划-v0.1.md)

---

## 0. 目标与验收

**目标**：`frontend-react/`（Vite + React + TS）在功能上等价替换 `frontend/`（Vue），
用户可见的行为一条不少（对话流式/过程面板/引用/交付物/审批/笔记/知识库/设置/…），
设计令牌与现有视觉一致，后端与部署形态不变。

**验收（每一条都要有证据）**：

1. 新前端的门禁自足跑绿：`lint`（eslint+prettier）、`typecheck`（tsc）、`test`（vitest+RTL）、
   `build`；
2. **逐页对照**：同一条会话/同一份数据，在两个前端里截图对照，观感不劣于旧版
   （对照口径沿用《前端设计规范 v0.14》与 `docs/调研/Kimi-界面逐处对照-v0.1.md`）；
3. 老前端的 863 条用例里，**逻辑型**的都要在新前端有对应用例（UI 型的不强求一一对应，
   但覆盖的功能点要对齐）；
4. 切换后 `frontend/` 目录删除、`scripts/check-frontend.sh` 指向新前端、部署（nginx/桌面壳）
   不用改路径。

---

## 1. 分支与提交纪律

| 项 | 约定 |
| --- | --- |
| 分支 | `react`（从 `agent` 切出）。`agent`/`main` 在迁移期间**只接受 bug 修复**，不再加新功能 |
| 提交粒度 | 一个功能域一个提交（与现有习惯一致：中文 + 一句话 + `（§12.230）`） |
| 推送 | 每完成一个阶段推到 `origin/react`，保持可回退 |
| 门禁 | 新前端自己的门禁**独立**跑（`scripts/check-react.sh`，本计划新增）；老前端门禁在 `frontend/` 删除前保持绿 |
| 生成物 | `schema.d.ts` 由 `scripts/gen_api_types.py` 直接生成到新前端（脚本加一个 `--target` 参数，两处共用一份 spec） |

---

## 2. 复用映射（"不要重复造轮子"的落点）

**每个能力都先问"有没有成熟库"，能抄就抄，抄的是上游最新版**（`git clone --depth 1` 到
`.cache/upstream/` 或 npm 最新版，**不看本地 `node_modules`**）。

| 能力 | 用它（最新版，2026-09-23 查） | 替掉我们的自研/旧实现 | 省下的量 |
| --- | --- | --- | --- |
| 组件原语（弹窗/下拉/浮层/选择/开关/提示） | **shadcn/ui**（Radix 原语）+ Tailwind v4 | `components/ui/` 22 个文件 | 4,188 行 |
| 图标 | **lucide-react** | `components/icons/` 78 个手写组件 | 1,493 行 |
| 对话 UI 骨架（消息列表/输入框/自动滚动/附件） | **@assistant-ui/react**（`useExternalStoreRuntime` 自建 runtime，接我们自己的 SSE） | `ChatView.vue` 里的列表/输入/滚动那一层 | 估 1,500–2,000 行 |
| Markdown | **react-markdown** + remark-gfm | `useMarkdown.ts` | 580 行 |
| LaTeX | **rehype-katex** + katex | `useLatex.ts` | 290 行 |
| 代码高亮 | **rehype-highlight**（highlight.js）或 shiki | `useMarkdown` 里的代码块处理 | 含在上行 |
| 服务端状态（缓存/失效/重试/轮询） | **@tanstack/react-query** | 各 store 里的手写缓存与轮询 | 分散在 stores/ |
| 客户端状态 | **zustand**（只放真正跨页的 UI 状态） | Pinia stores 的 UI 部分 | — |
| 列表虚拟化 | **@tanstack/react-virtual** | 手写分页/懒加载 | — |
| 富文本编辑器 | **@tiptap/react**（扩展沿用现有 3.31.3 那几个） | `@tiptap/vue-3` + 笔记页封装 | 编辑器逻辑可搬 |
| 图表 | **echarts**（框架无关，保留） | `EChart.vue` 包一层 React | — |
| Office 预览 | **docx-preview**（已框架无关）+ **pptx-preview** + **exceljs/x-data-spreadsheet**（替 `@vue-office/*`） | `@vue-office/excel`、`@vue-office/pptx` | 预览链换实现 |
| Toast | **sonner** | 自研 `useToast` | 48 行 |
| 表单校验 | 原生 + 少量手写（现有前端也没用表单库，不引入） | — | — |
| 路由 | **react-router** v7（数据路由不必用） | vue-router | 194 行 |
| 测试 | **vitest** + **@testing-library/react** | @vue/test-utils | 863 条逐域重写 |

**直接搬（框架无关的 TS，几乎零改动）**：

- `src/api/*.ts` **4,015 行**（只有 `client.ts` 依赖两个 Vue 状态模块 → 换成 React 版，见 §3.1）；
- `composables/displayPacer.ts`（244）、`clipboard.ts`（120）、`useFormat.ts`（135）；
- `useMarkdown`/`useLatex` 的**规则与测试**（实现换库，规则作为对照）；
- `useChatTurns.ts` 的**回合模型**（832 行，纯函数部分：`buildTurns/traceSteps/mergeStep/…`）；
- `useLiveTurn.ts` 的**重连状态机**（586 行，把 Vue 响应式换成 zustand store，逻辑照搬）；
- 设计令牌 `assets/base.css` 75 条 + 亮/暗主题（纯 CSS 变量，**原样复制**）。

---

## 3. 目录与所有权（子智能体并行时的防冲突约定）

```
frontend-react/
  src/
    api/            # 从 frontend/src/api 搬（我负责，冻结后各域只读）
    lib/            # session/operator/format/clipboard/pacer（我负责）
    styles/         # tokens + themes（从 frontend/src/assets 搬）
    ui/             # shadcn 原语（shell 域负责）
    app/            # 路由、布局壳、Provider 装配（我负责，别人不改）
    features/
      chat/         # A 域：对话页（含 runtime、过程面板、工具卡、引用、审批、交付物）
      notes/        # B 域：笔记
      knowledge/    # C 域：知识库（列表/详情/文档/Wiki/抽屉/预览）
      misc/         # D 域：任务/记忆/工作区/能力/设置/搜索/驾驶舱
    test/           # 测试基建（我负责）
```

**所有权铁律**：一个文件同一时刻只有一个智能体在写；跨域要改别人的文件，
先在自己的 PR 说明里提出，由我（主控）改。公共文件（`package.json`、配置、
`src/app/**`、`src/api/**`）**只有主控能改**。

---

## 4. 阶段与顺序（每阶段结束跑门禁 + 提交 + 推送）

| 阶段 | 内容 | 交付物 | 谁 |
| --- | --- | --- | --- |
| **P0 脚手架** | `frontend-react/` 建起来：Vite+React+TS+Tailwind4+vitest/RTL+eslint/prettier、令牌与主题、api 层与 lib 层搬完、`scripts/check-react.sh` | 能跑起来的空壳 + 门禁脚本 | 主控 |
| **P1 对话页** | assistant-ui + 自建 runtime 打通真实 `/chat/stream`：流式正文、过程面板（分组/图标/分页）、出处与引用抽屉、交付物、审批（含拒绝理由）、模式/模型/思考、斜杠命令、@ 提及、上下文仪表、重连/停止/继续/重试 | `src/features/chat/**` + 用例 | A 域智能体（+ 主控接线） |
| **P2 应用壳** | 登录页、会话恢复、侧栏导航、主题/字号、路由、Toast、错误页、shadcn 原语 | `src/app/**`、`src/ui/**` | B 域智能体 |
| **P3 知识库域** | 列表/详情/文档列表/文档抽屉/Wiki/上传/分享/预览（docx/pptx/xlsx）/数据源 | `src/features/knowledge/**` | C 域智能体 |
| **P4 笔记 + 其余** | 笔记（tiptap React）/任务与定时/记忆/工作区/能力（技能/插件/MCP）/设置/搜索/驾驶舱 | `src/features/notes/**`、`misc/**` | D、E 域智能体 |
| **P5 切换** | nginx 路径分流（`/chat` 等先切新前端）→ 全量切 → 删 `frontend/`、门禁脚本改指向、文档更新 | 部署与文档 | 主控 |

**中途共存**：P1 完成即可让 `/chat*` 走新前端（nginx `location ^~ /chat` → 新构建），
其余路径继续旧 Vue；这样每一个阶段都是一个**可上线**的状态。

---

## 5. 子智能体分工（用户要求"尽可能多"，按域并行）

| 域 | 任务 | 关键要求 |
| --- | --- | --- |
| 调研-1 | assistant-ui 最新版 API（`useExternalStoreRuntime` 的完整契约、`ToolFallback`、`ThreadPrimitive`） | **上 GitHub 拉最新源码/文档**，把真实用法写成 `src/features/chat/runtime/README` 并附源码片段 |
| 调研-2 | shadcn/ui + Tailwind v4 接我们现有 CSS 变量（不推翻设计令牌） | 从上游 registry 拉最新组件源码 vendor 进来，不装 CLI 黑盒 |
| 调研-3 | Office 预览（xlsx/pptx/docx）在 React 下的路线 | 拉 `pptx-preview`、`exceljs`、`docx-preview` 最新源码与示例，给出选型与最小可用封装 |
| A | 对话页（最大件） | runtime 自建 + 过程面板；不许改 `src/api/**`、`src/app/**` |
| B | 应用壳 + 原语 + 登录 | 原语 vendor 自 shadcn 最新版 |
| C | 知识库域 | 预览按调研-3 的结论落地 |
| D | 笔记域 | tiptap React + 现有 markdown 序列化口径 |
| E | 其余页面 | 先抄结构，功能点对表（见 §6） |

**并行纪律**：每个智能体只在自己的目录里写文件；遇到必须改公共文件的情形，
停下来在最终报告里写"需要主控改 X"。

---

## 6. 功能点对表（迁移时逐条打勾，防止悄悄丢功能）

对话页（A）：流式正文 / 思考分块 / 过程面板分组与图标 / 工具卡四元组 / 大输出两级懒加载 /
出处徽标与抽屉 / 交付物卡片（含"存进知识库"）/ 审批条（允许一次/总是/拒绝+理由+倒计时）/
停止、继续、重试 / 模式四档 / 模型与思考强度 / 斜杠命令菜单与回话 / @ 提及 / 上下文仪表 /
附件与引用两分（拖拽）/ 执行策略 / 建议问题 / 复制与存为笔记 / 快捷键 / 首问不丢、
刷新接回（重连锚点）/ 后台跑与补发。

其余域（B–E）：按 `frontend/src/router/index.ts` 的 13 条路由逐条对表，
每条路由下列出该页所有交互（按钮/弹窗/表格/空状态/错误态），迁移时逐项勾。

---

## 7. 风险与退路

| 风险 | 应对 |
| --- | --- |
| assistant-ui 的表达力撑不起过程面板/工具卡 | P1 第一天先做 spike（真实会话跑通一条完整链路），不通过就改用"自研骨架 + shadcn 原语"（仍然在 React 里，不回 Vue） |
| 双前端共存期的维护税 | 共存只到 P5 结束；期间新功能**只进新前端**（旧前端冻结） |
| 两套测试基础设施 | 新前端测试从零起（vitest+RTL），逻辑型用例从旧测试**翻译**而不是重写 |
| 部署/桌面壳 | 路径与 URL 不变（`/chat` 等），nginx 只加分流 location；Tauri 壳无需改 |
| 迁移期 bug 修复 | `agent` 分支继续收 bug 修复，定期 merge 进 `react`（`git merge agent`，冲突集中在被重写的那几页） |

---

## 8. 本计划自身的位置

- 计划文档：本文（`docs/计划与记录/React-迁移计划-v0.1.md`）；
- 评估依据：`docs/调研/前端技术栈与-chat-UI-重做评估-v0.1.md`；
- 进度记录：开发计划 §12.230（每完成一个阶段回填一行，含提交号）。

---

## 9. 进度（回填）

| 阶段 | 状态 | 提交 | 证据 |
| --- | --- | --- | --- |
| **P0 脚手架** | 完成 | `a93d052` | `frontend-react/` 四门禁自足跑绿（构建 167ms）；api 层 25 个文件 + 设计令牌原样搬；`gen_api_types.py --target`、`scripts/check-react.sh` |
| **P1 对话页** | 完成（首版） | `ea0425c` | assistant-ui `useExternalStoreRuntime` 自管网络；过程面板/出处/交付物/审批/命令/提及/上下文仪表/重连全在；回合模型与常驻流从 Vue 逐条搬（旧 145 条逻辑用例 → 新 176 条） |
| **P2 应用壳** | 完成（首版） | `ea0425c` | 路由与旧 vue-router 逐条对应 + 登录守卫 + 标题映射 + 全局 Toaster；19 个 shadcn 原语 vendor 进 `src/ui`（令牌化） |
| **P3 知识库域** | 完成（首版） | `ea0425c` | 列表/详情/Wiki/文档详情 + 抽屉/上传/分享/数据源/时间线/库内检索；75 条用例 |
| **P4 笔记 + 其余** | 完成（首版） | `ea0425c` | 笔记 tiptap React（84 条用例）；任务/记忆/工作区/能力/设置/驾驶舱/登录/404（50 条用例）；Office 预览三套渲染器（27 条用例） |
| **P5 切换** | 未开始（准备件已就绪） | — | 需要：逐页浏览器对照（同一条会话/同一份数据）、nginx 路径分流、删 `frontend/`、`check-frontend.sh` 改指向。`frontend-react/{nginx.conf,Dockerfile}` 已按旧前端逐字备好（P5 只改 compose 的 `context` 与镜像名） |

**当前门禁**：`scripts/check-react.sh` 全绿（lint / tsc / **434 条用例** / 构建 / emoji / API 契约）；
旧前端与后端的门禁**不受影响**（本计划第 1 节的纪律：两套互不当对方的红灯）。

**已完成（第二轮）**：29 个 shadcn 原语全部 vendor 到位（新增 10 个：alert-dialog / checkbox /
radio-group / context-menu / avatar / progress / collapsible / command / drawer / resizable）；
**知识库域与 misc 域的两处自写外壳已删掉**（`knowledge/primitives.tsx` 471 行、
`misc/shared/ui.tsx` 684 行），全量换成 `@/ui/*`，两域各自只留一组**组合件**
（`composites.tsx`：上游没有一一对应物的 `StatusTag`/`MeterBar`/`EmptyState`/`InfoTip` 这类拼装），
用例条数与断言数都不减（知识库 75→75 / 断言 258→259；misc 50→50 / 断言 156→168）；
对话页把出处/产物换成 `@/ui/sheet` 抽屉（先滑回去再通知宿主、不动底下滚动）、
快捷键接到与设置页**同一个 localStorage 契约**（`kylab-shortcuts`，不 import 别人的域）、
公式换成标准路线 `remark-math` + `rehype-katex`（8 条口径差异写在 `chat/model/README.md`）。
**门禁**：`scripts/check-react.sh` 全绿，**468 条用例**（434 → 468）。

**下一步（P5 之前必须做的事）**：

1. **人工对照**：同一条会话、同一份笔记、同一个库，在两套前端里逐页截图比对——
   这是 §0 验收第 2 条，**目前一次都没做过**（各域报告只做了代码级对照）；
2. **`src/ui` 原语替换**：知识库域自带的 `primitives.tsx`（占位实现）与 misc 域的 `shared/ui.tsx`
   应在对照通过后替换成 `src/ui/*`（shadcn），去掉两份手写外壳；
3. **侧栏（壳）还没做**：`layout.toggleSidebar` / `chat.new` 的快捷键已接在对话页，
   等壳里的侧栏读同一个存储键（`kylab-sidebar-collapsed`）并监听 `kylab:sidebar-toggle`
   ——契约写在 `chat/runtime/shortcutPrefs.ts` 模块头，搬到壳上时 id 不变；
4. **两处口径要用户拍**：① `remark-math` 把"`$5 到 $10`"按公式排（标准口径的代价，
   缓解写法是 `\$5`）；② 对话页的文件抽屉仍是"文件区列表 + 签名 URL 预览"，
   旧版的内嵌预览与子目录进出属知识库域的 `FilePreview`，要不要接由对照结果定。
