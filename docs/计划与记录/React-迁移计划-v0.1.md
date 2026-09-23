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
| 路由 | **react-router** v8.4.0（数据路由不必用） | vue-router | 194 行 |
| 测试 | **vitest** + **@testing-library/react** | @vue/test-utils | 863 条逐域重写 |

**一处刻意不取最新：`typescript` 钉在 5.9.3，不是 registry 上最新的 7.0.2**——因为
`typescript-eslint@8.70.1`（最新）的 peer 范围是 `typescript >=4.8.4 <6.1.0`，TS 7 落在
门禁的 lint 之外；5.9.3 是该范围内最新的一个。等 typescript-eslint 放开再抬，
不为一个版本号把 lint 这条门禁弄瘸。

其余依赖**全量逐条对着 registry 复核**（2026-09-23，`pnpm view <包> version`，
**79 个依赖一个不落**）：**78 个等于 registry 上的最新版**，唯一例外的就是上面那个 `typescript`。
这一遍还顺手抬掉了四处落后项：`eslint 9.38.0 → 10.11.0`（连同 `@eslint/js 10.0.1`——
插件侧 `typescript-eslint` / `eslint-plugin-react-hooks` / `eslint-config-prettier`
的 peer 都已含 `^10`，不是被谁卡住的）与 `@testing-library/dom 10.4.2`、
`@testing-library/user-event 14.6.7`、`@types/katex 0.16.8` 三个补丁版。
eslint 10 带出的唯一一处新告警是真问题：`src/lib/clipboard.ts` 里
`let copied = false` 的初值在两条分支上都会被覆盖（`no-useless-assignment`），
已按最小改法修成 `let copied: boolean`，语义不变（见 §12.251）。

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
| **P5 切换** | **完成** | `§12.234` | 新前端搬到规范路径 `frontend/`、旧 Vue 前端删除（历史在 `agent` 分支）；`gen_api_types.py` 回单目标；`check-react.sh` 删除（`check-frontend.sh` 现在查的就是 React）；nginx / compose / 桌面壳 / 脚本路径**一处未改** |

**当前门禁**：`scripts/check-frontend.sh` 全绿（lint / tsc / **510 条用例** / 构建 / emoji / API 契约 /
分层与文案与版本号），`scripts/lint.sh` 全过；后端未改动。
（迁移期的 `scripts/check-react.sh` 已在 P5 删除。）

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

**已完成（第三轮）**：**应用壳接线**——`features/layout/**`（侧栏 / 历史会话面板 / 用户区 /
全局快捷键宿主 / 401 转登录 / 换页关面板）进路由，落地页回 `/` = 概览（与旧前端一致），
登录页留在壳外；对话页**文件抽屉**补齐审计的 F11–F14（子目录进出 / 就地预览走
`@/features/preview` / 往文件区上传 / 行拖出做引用）；完整性审计报告见
[React-迁移完整性审计 v0.1](../调研/React-迁移完整性审计-v0.1.md)（22 条缺口 → 已清第一档 5 条）。
**门禁**：`scripts/check-react.sh` 全绿，**510 条用例**（468 → 510）。

**下一步**：见 §10 —— 代码侧已无待办，唯一没做的是 **NAS 上重建前端镜像**
（本机没有任何登录入口，需要用户跑一条命令，或给公钥/密钥后由助手代做）。

## 10. 收尾状态（2026-09-23）

### 10.1 代码侧：完成

- **迁移**：`frontend/` 就是 React 版（`git rm -r frontend` + `git mv frontend-react frontend`，`5632c2b`）。
  旧 Vue 在 `agent` 分支（`git checkout agent -- frontend` 取回）；`react` 领先 `agent` 14 个提交、
  领先 `main` **112** 个。**合并预检**：`git merge-tree --write-tree main react` **退出 0、零冲突**
  （`react` 从 `agent` 切、`agent` 是 `main` 的后代），并进 `main` 是快进式——风险在部署不在合并。
- **门禁（合并树上）**：前端 `scripts/check-frontend.sh` 全绿 —— **532 条用例**
  （§12.251 补了图表基座 4 条：切主题重画、`var()` 与 `color-mix()` 解析、卸载时销毁；
  以及剪贴板两级兜底 8 条）+ 构建 + emoji + 分层与文案与版本号；后端 **2881 通过 / 9 跳过**；
  `scripts/lint.sh` 全过。
  **跑法有讲究**：这条命令的输出别接 `tail`/`head` 再看退出码——那样读到的是 `tail` 的退出码，
  门禁红了也会显示 0（§12.251 里记了这个教训：当时正是这样误报过一次"全绿"）。
- **产物层面也核过**：`frontend/dist/assets/` 里 34 个 js 资源，**没有任何 Vue 运行时标记**
  （`createApp` / `__vue` / `vue-router` / `reactive(` 一个都不命中）——"前端离开 Vue 技术栈"
  在交付物上成立，不只是源码里没有 `.vue`。
- **审计缺口清零**：[完整性审计](../调研/React-迁移完整性审计-v0.1.md) 第一档 5 条（壳接线、401、
  会话管理、文件抽屉四件事、落地页口径）与第二档 2 条（通知条关闭按钮、悬停/聚焦预热）**全部补完**；
  连"启动后 idle 预热"也补了（`features/misc/prewarm.ts`：`onIdle` 空闲时预热
  任务列表 / 定时任务 / 概览统计与用量，键与页面共用同一批导出常量；壳里挂一次、`useRef` 挡
  重复；有用例钉住）——**审计清单到此没有代码项了**。
- **观感对齐**（用户口径"按旧版逐处对齐"）：导航图标换回 **Remix Icon**；概览大数回
  18px / 1.15 / -0.015em；知识库页头齿轮贴回标题（gap 4px）；状态标签回胶囊（22px）；
  正文列宽回 66ch（实测 **533.672px**）——五处都在浏览器里量过、与旧值一致。
- **两处口径**（按主流实现自收）：公式边界用 **GitHub 口径**（`$` 与内容之间不留空格，
  于是 `$5 到 $10` 不再被当公式排）；文件抽屉内嵌预览经核实**本来就已具备**。
- **规范文档按规矩升版**（§12.251）：`项目工程规范` **v0.4 → v0.5**（只重写 §4 前端部分：
  目录树 / 命名表 / 图标与颜色纪律各一处）、`部署与运行` **v0.2 → v0.3**（适用行 +
  §3 追加"NAS 上已是 React，判据是挂载点 `#root`"）；旧版进 `docs/归档/` 并在头部标注被取代，
  活指针（`README.md` / `README.en.md` / `docs/README.md` / 调研的"关联"行）跟着换——
  **没有就地改任何已提交的规范内容**（这是《项目工程规范》§2 自己的规矩）。
- **其余提到前端的文档逐份过了**（判据：它是不是"读作现状"的文档）：
  `设计/架构设计-v0.2` 与 `设计/插件与技能-v0.1` 里"控制台前端 Vue 3"那类说法，
  照这两份文档**各自已有的做法**就地加"后续修订"注（架构设计早在 2026-09-17 就这么标过存储那条；
  插件与技能那份给它那张落点表补了一张 Vue→React 路径对照）——**只标注、不改正文**；
  `规范/前端设计规范-v0.14` **有意不动**：它那两处 Vue 提法是当时的实测记录（scoped 样式里
  `@keyframes` 被改名、切主题要靠 `watch(theme, render)`），规则本身仍然成立，
  而且其中"切换主题要重画"这一条已经在 React 版里被用例钉住了
  （`frontend/tests/misc-echart.test.tsx`）；`调研/` 与 `计划与记录/` 里的 Vue 提法
  是历史快照与新旧对照，本来就不该改。

### 10.2 NAS 产物的本机预检（都做了）

1. `vite preview` 加 `/api` 反代（与 nginx 同形），用**生产构建** `dist/`（6.5 MB / 87 个资源）实跑：
   首页 200、挂载点 `#root`、经反代 `/api/v1/health` 200、四个主资源全 200。
2. **生产构建 + 真实会话逐页实测**：给预览端口注入现有会话令牌（只读核对、核完即清），
   概览（真实统计）/ 知识库详情（31 篇文档、目录树、工具栏）/ 笔记（真实列表）/ 任务中心
   （真实任务行）/ 能力（7 个技能 + 五档筛选）全部正常，侧栏**13 条真实会话**都在，挂载点 `#root`。
   ——**NAS 上要跑的那份 dist 与本机验过的是同一份。**
3. **懒加载在生产产物上也验过**（§12.248 的拆分之后）：生产构建首屏是概览、**不含对话页**
   （`chatLoaded:false`，13 条真实会话在侧栏），点进一条会话后 `thread`/`composer` 都在
   ——说明打包后的 `ChatPage-*.js` 能在真实浏览器里正常按需拉起（dev 与 prod 各验一次）。
4. **桌面壳（Tauri）核查过**：`desktop/src/shell.js` 只驱动它自己的本地配置页
   （`form`/`address`/`status`/`recent` 这些 id 都在 `desktop/src/` 里），不碰 SPA 的 DOM；
   `desktop/src-tauri/src/main.rs` 是 `Url::parse(探测到的地址)` → `window.navigate(url)`，
   **按 URL 加载、与前端框架无关**（`WebviewUrl::App(...)` 只用于本地配置页与「更换服务器」窗）。
   所以桌面端**不需要任何改动**，NAS 一重建它就跟着换成 React 版。
5. 锁文件含 `@esbuild/linux-x64`、`@tailwindcss/oxide-linux-x64-gnu`（容器里装得上）；
   本机那两个 win32 包被 `.dockerignore` 排掉，不会带进 Linux 构建。

### 10.2.1 发版口径：**没动版本号，也没写 CHANGELOG**

迁移这一批**刻意不碰版本号**（`backend/pyproject.toml` / `core/config.py` / `deploy/docker-compose.yml` /
`frontend/package.json` 四处仍是 `0.1.1`，V1 门禁一致），也不往 CHANGELOG 里加条目——
这是**发版动作**，由用户在合并 `react` → `main` 时一起定（`0.2.0` 还是 `0.1.2`），
本计划只把"落了什么"记在 §12.230–§12.249 与本文里，避免"改了代码顺手改了版本号"这种越权。
（CHANGELOG 的格式见 `CHANGELOG.md` 顶部：一个版本一段，附"为什么"与门禁数字。）

### 10.3 唯一没做完的一步：NAS 上重建前端镜像

**现状实测**：`http://192.168.31.18:8081/` 200，但 HTML 里是 **`id="app"`（旧 Vue）**；
后端 `/api/v1/health` = `version 0.1.1` 健康。

**本机入口已逐条试尽**（记在这里免得重复查）：`~/.ssh/` 只有 `config` 与 `known_hosts`、
无任何登录私钥；`ssh-add -l` 无 agent；本机唯一那把 `~/.ollama/id_ed25519` 试过被拒；
NAS 的 Docker 远程 API（2375/2376）**未开放**；本机**无 docker**（无法先在本机建一遍镜像）；
仓库文档里**没有**登录凭据/密钥入口（规范明确"任何 token 不落库"）；SMB（445）**开着**，
但那只到文件层——重建镜像仍要 NAS 上的 docker，跳不过登录。

**SSH 用户是 `yumao`，不能省**（2026-09-23 复查发现的一处真缺陷）：脚本原先写的是
`ssh "$HOST"`，而本机 `ssh -G 192.168.31.18` 解析出的用户是 **「小又」**（这台 Windows 的登录名），
NAS 上没有这个账号——那条"只问一次密码"的路会**白输一次**。`yumao` 才是 NAS 上的登录用户
（部署记录：开发计划 §"13 条做完"那节「SSH 到 `yumao@192.168.31.18`」；`docker-compose.yml`
注释里容器以 uid 1000 跑，也就是它）。现在脚本默认带 `yumao@`，第 3 个参数或 `NAS_USER=` 可覆盖。

**给用户的两条路**（`deploy/nas/README.md` 里有，密码只在用户终端里输）：

```bash
# A. 从这台 Windows 直接部署（一次连接、只问一次密码；也可以直接双击同名 .cmd）
sh deploy/nas/deploy-from-windows.sh          # 默认 react / 192.168.31.18 / yumao
sh deploy/nas/deploy-from-windows.sh --dry-run   # 先看要执行的那条 ssh 命令，不碰网络

# B. 已经登录在 NAS 上时，一条命令
sh /vol1/1000/docker/kylab/src/deploy/nas/update-frontend.sh react
```

手工的两条（脚本做的就是这两步）收在 README 的折叠块里，注意其中 **SSH 用户同样是 `yumao@`**
（`kkomia@` 试过被拒）。

NAS README 另有「**部署后核对与回滚**」一节（`a` 机器可判两条 + 人眼三条：登录 / 发一句看流式与出处 /
知识库与笔记各开一处；回滚是把 `frontend/` 换回 `agent` 分支那份再只重建前端，两分钟）。

脚本带**四道守卫**（都用临时目录模拟验证过）：源码是新前端才继续；还是旧 Vue 就**拒绝构建**
并打印三条换源码的路子（退出码 2）；`app/docker-compose.yml` 不在就提示路径不对（2）；
用不了 docker 就把 `sudo sh <脚本> react` 那行打出来（3）。构建走 **npmmirror**
（`NPM_REGISTRY` + `COREPACK_NPM_REGISTRY`，与后端那份 `UV_INDEX_URL` 同一个理由）。
