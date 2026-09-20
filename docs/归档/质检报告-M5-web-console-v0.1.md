# 代码质检报告（M5 Web 控制台）

- 范围：`ed28b58..de7256c`（M5 前端页面：图标与组件基座、五个页面、侧栏导航、前端单测）
- 日期：2026-09-10
- 依据规范：项目工程规范 v0.3 / 前端设计规范 v0.3 / 架构设计 v0.2
- 结论：**通过**（无 P0/P1；3 项 P2、3 项 P3 建议修复）

## 问题清单

| 级别 | 位置（文件:行） | 规则 | 问题描述 | 修复建议 |
|------|----------------|------|----------|----------|
| P2 | `frontend/src/views/TasksView.vue:34-45` | 功能完整性 | 关联文档名只在挂载时取一次，之后新上传的文档在任务中心会退化成显示 `doc_xxxx` | 轮询时一并刷新文档名映射，或给 `/tasks` 响应补 `document_name`（后端侧更彻底） |
| P2 | `frontend/src/views/SearchView.vue:44-50` | 可用性 | 检索历史只存在内存里，刷新页面即丢；查询参数也不进 URL，无法分享/回退到某次检索 | 把查询参数同步到 URL query，历史落 `sessionStorage` |
| P2 | `frontend/src/api/client.ts:14-32` | 健壮性 | 网络层失败（后端没起、连接被拒）时抛的是浏览器原文 `Failed to fetch`，界面上会直接显示英文 | 捕获 `TypeError` 换成"无法连接后端服务，请确认服务已启动" |
| P3 | `frontend/src/router/index.ts:39-42` | 类型完整性 | `to.meta.title` 用 `as string` 断言，未声明 `RouteMeta`，写错 key 不会报错 | 在 `router/index.ts` 里 `declare module 'vue-router'` 补 `RouteMeta` |
| P3 | `frontend/src/views/KnowledgeBaseView.vue:53-58` | 逻辑冗余 | `watch(hasActive, syncPolling)` 与非响应式的 `setInterval` 混用，且手动调用 `syncPolling()` 与 watch 触发存在重复路径 | 统一为"每次 refresh 后按 hasActive 调整定时器"，去掉 watch |
| P3 | `frontend/src/components/ui/AppButton.vue:41-47` | 主题完备性 | `--button-primary-*` 之外，若将来引入 disabled 专用底色仍会缺 Token；当前用 `opacity` 表达禁用态，深色下对比度偏低 | 暂可接受；若要改，补 `--button-primary-bg-disabled` Token 而不是就地写色值 |

## 自动化检查结果

- ruff：通过（后端未改动，随门禁复核）
- emoji 扫描：通过（后端 0 处 / 前端 0 处）
- 分层纪律与测试位置：通过（前端源码目录内无测试文件）
- pytest：423 通过 / 0 失败，`app/` 覆盖率 **100%**
- eslint + prettier：通过（0 error / 0 warning）
- vue-tsc 类型检查：通过
- vitest：**27 通过 / 0 失败**（新增 23 条：格式化、状态映射、Toast、知识库 store）
- 前端生产构建：通过
- `scripts/ci.ps1` 九步门禁：**全绿**

## 人工审查覆盖（六组）

### 一、分层纪律
- ✓ 后端分层沿用上一轮结论；本轮未改后端源码（仅 `docs/` 与 `frontend/`）
- ✓ 前端 API 调用全部集中在 `src/api/`，组件不直接 `fetch`
- ✓ 后端 DTO ↔ 前端类型的对应关系在每个 `api/*.ts` 头部注明

### 二、命名
- ✓ 组件 `PascalCase.vue`、composable `use*.ts`、图标 `Icon<名称>.vue`
- ✓ 路径 kebab-case（`/knowledge-bases`、`/documents/:id`）；前端路由同样 kebab-case
- ✓ `docs/` 命名 `<主题>-v<主.次>.md`，旧版保留

### 三、测试
- ✓ 前端测试只在 `frontend/tests/unit/`，镜像同构（`composables/`、`components/`、`stores/`）
- ✓ 新增功能带测试；被测行为是"会被改坏的地方"（分档边界、未知状态兜底、12 条阈值）
- ✓ 夹具无大文件；未引入真实凭据

### 四、安全
- ✓ 前端源码无 token / key / 密码
- ✓ 用户输入一律经 Vue 插值渲染，无 `v-html`（避免 XSS）
- ✗ 上传幂等键、签名 URL、API Key 鉴权仍未实现（沿用 M4 显式延后，已在设置页与开发计划如实标注"未启用 / 待接入"，不伪装成已完成）

### 五、前端风格（本轮主战场，逐项过检）
- ✓ 源码字符串 0 emoji（机械扫描 + `no-emoji` lint 规则双保险）
- ✓ 图标全部来自 `components/icons/` 内联 SVG，统一 `currentColor`，无 iconfont / 图片图标 / 外链
- ✓ 颜色只引主题变量：本轮把 4 处硬编码 `rgb(0 0 0 / 12%)` 抽成 `--shadow-popover` / `--overlay-scrim`，并补齐 `--button-primary-*`、`--danger-soft`（深浅两套都补）
- ✓ 无渐变、无玻璃拟态；圆角最大 8px；卡片无阴影
- ✓ 卡片网格窄屏单列（`minmax(220px, 1fr)`）；检索台双栏在 900px 以下退化为单栏
- ✓ 状态一律"图标 + 文字"双编码（`StatusTag`），不靠颜色单独表意
- ✓ hover 才出现的行内操作改用原生 `<details>`，**始终可聚焦、始终可点**，触屏不依赖悬停
- ✓ 弹层用原生 `<dialog>`：焦点陷阱、Esc 关闭、背景惰性由浏览器负责
- ✓ 尊重 `prefers-reduced-motion`（骨架屏呼吸动画可关）
- ✓ §5.1 形态规则落地并有单测兜底：知识库 ≤12 卡片、>12 列表；文档/任务/命中一律列表

### 六、架构承诺
- ✓ 流水线状态机阶段与任务状态的中文文案集中映射（`components/ui/status.ts`），未知阶段退化为中性而非崩掉
- ✓ 无 embedding Key 时检索台**明确提示**向量召回不可信、BM25 才可信（架构 §6.2 的诚实性要求）
- ✓ 产品边界在概览页与检索台均有文字声明："只返回原文，不做 LLM 预处理"
- ✗ >1000 页强制切分、扫描件页级路由、模型切换校验、级联删除、chunk 级增量更新仍属未到验收点（M2 云端解析器 / M6）

## 真实 HTTP 冒烟（非单测，实起服务验证）

| 步骤 | 结果 |
|------|------|
| `GET /api/v1/health`（经 Vite 代理） | ok v0.0.1 api=v1 |
| `POST /api/v1/knowledge-bases` | 建库成功，模型 `dev/deterministic-hash`、256 维 |
| `POST …/documents` 上传中文 Markdown | 202，`stage=uploaded`，任务 `task_a8a740046e6c` |
| 等待消费 | `parse` 任务 `succeeded`，文档 `stage=indexed`，`chunk_count=1` |
| `POST /api/v1/search` 混合检索 | 1 条命中，`channels=[vector, fulltext]`、`ranks={vector:1, fulltext:1}`；`embedding_is_development=true` 如实上报 |
| 检索返回正文 UTF-8 往返 | 逐字节解码校验通过（中文无损） |
| 五个前端路由 | `/`、`/tasks`、`/search`、`/settings`、`/kb/:id` 均 200；`main.ts`、`SearchView.vue`、`SideNav.vue` 转换无错 |

## 结论

无 P0/P1 阻塞项，六组人工审查逐项过检，**通过**。三项 P2 属于体验完整性而非正确性缺陷，
列入下一轮修复清单；安全组三项未完成项沿用显式延后决定，**投入局域网前必须补齐**。
