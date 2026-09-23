# React 迁移完整性审计 v0.1（P5 切换前的缺口清单）

- 日期：2026-09-23
- **审计时刻的靶（重要，本文结论只对这一刻成立）**：
  - 基线提交 **`7b9f834`**（原语收口那一提交）；
  - 工作区里另有一份**未跟踪、未提交**的 `frontend-react/src/features/layout/**`
    （11 个文件 2,319 行，含 `SideNav.tsx`/`AppShell.tsx`/`AccountMenu.tsx`/历史会话面板/
    行菜单/会话与工作区 store/`useAutoHideScrollbar`/`useSidebar`）与两个用例文件
    `tests/layout-{shell,conversations}.test.tsx` —— **文件时间 19:13–19:18，晚于最后一次提交
    的 19:10，是我审计期间同步在长的"壳"**（见 E1、§7 第 1 条）。
    **`app/App.tsx` 到 19:19 为止仍未改**（`git diff` 为空），即**这套壳没有任何页面在用**。
- 方法：**只读**核对。① 把旧前端 `frontend/src` 的 153 个 `.vue` + 62 个 `.ts`
  （含 `api/schema.d.ts` 14,060 行）与新前端 `frontend-react/src` 的 188 个模块逐个枚举、
  给出行数；② 按域逐文件对行为（读实现、比对 handler 名单、比对中文字面量集合、
  抽样读模板）；③ 跑新前端门禁的测试：`cd frontend-react && pnpm test` →
  **31 个文件 468 条全绿**（19:14，21.4s）；随后工作区新增的两个 layout 用例文件
  **另跑一次：35 条全绿**（19:19）→ 工作区里现共 **503 条**，其中 35 条属于**未接线的壳**；
  ④ 核对部署件（nginx / Dockerfile / compose / 脚本 / 桌面壳）。
  **没有改动任何产品代码**，本文档是本次审计唯一的写入。
- 判定的四档：`已迁（文件对照）` / `已迁（换实现）` / `有意未迁` / **`缺口`**。
- **证据分级**（每条缺口都标）：
  - `文件对照` = 两边的文件/行/字符串能一一对上，可直接复算；
  - `行为核对` = 读了双方实现并跑了用例，行为口径逐条比过；
  - `推断` = 从 import 关系、时间戳、注释推出来的，**需主控复核**（末尾 §7 集中列）。

## 0. 一页结论

| 判定 | 量 | 说明 |
| --- | --- | --- |
| `已迁（文件对照）` | api 层 24 个文件**逐字相同**（唯一差异：`api/chat.ts` 比旧版多 5 行，补 `kind` 转发）；13 条路由逐条对应；12 个 `views/*` 全部有对应页；知识库/笔记/任务/记忆/工作区/能力/驾驶舱/搜索/预览/设置**九个域的行为基本齐** | 设计令牌 234→255 个（旧的一个不少，多 21 个别名），`index.html` 首屏脚本逐字一致 |
| `已迁（换实现）` | 图标 78 → lucide；`components/ui` 21 件 → shadcn/Radix 29 个原语；markdown/latex/toast/pacer/format 等 13 个 composable → 库或 `lib/`；Pinia → zustand + react-query；vue-router → react-router | 见 §4 |
| `有意未迁` | 6 项（`useTopLayer`、`shims/vue-office.d.ts`、预览的"抽屉里 iframe"形态、桌面壳、旧 `frontend/` 目录、旧 emoji 的 eslint 单测） | 见 §5 |
| **`缺口`** | **22 条：功能 17 / 工程 5** | 见 §1（功能）、§2（工程） |

**最要紧的一句**：**新前端目前没有"壳"**——`app/App.tsx` 里没有侧栏、没有任何页内导航入口，
所以除对话页外其余 12 条路由**只能靠手敲 URL 到达**；设置弹窗、账号菜单（退出登录/切换主题）
在新前端**没有任何入口**。

**但这条已经在收尾**：`features/layout/**`（含 `AppShell.tsx` 的容器、`SideNav`、历史会话面板、
行菜单、账号菜单、会话/工作区 store、`useAutoHideScrollbar`）**已经在工作区里写好**，
自带 **35 条用例**（19:19 实测全绿），并且 `index.ts` 的模块头**写好了给主控的接线方式**
（布局路由 `<Route element={<AppShell/>}>` 或包住整张路由表两种写法）。
**只差 `app/App.tsx` 那一步**（到 19:19 为止 `git diff` 为空）。

因此下面的 22 条缺口分两类读：
- **「接线即闭合」**：F1–F9、F16、F17、E1（零件已就绪、用例已有，只差接进 `App.tsx` 与提交）；
- **「接线也闭合不了」**：F10（401）、F11–F14（对话页文件抽屉）、F15（落地页/概览）、
  F18（预热）、F19（通知关闭按钮）、E2–E4 —— **这几条才是真正还要做的工作**。

---

## 1. 缺口表 · 功能（用户能看见的）

| # | 旧文件 | 行为 | 新前端状况 | 影响（用户能看见什么） | 建议 | 证据 |
| --- | --- | --- | --- | --- | --- | --- |
| F1 | `components/layout/SideNav.vue`(1632) | 侧栏主导航：笔记 / 记忆 / 能力 / 知识库▸（所有知识库 / 概览 / 任务中心）；折叠开关（`kylab-sidebar-collapsed`）；品牌行 | `features/layout/SideNav.tsx`(553) + `AppShell.tsx`(100) **已写好**，`tests/layout-shell.test.tsx` **19 条用例（19:19 全绿）**，但 `app/App.tsx` **未改**（`git diff` 为空）、无人 import → 产品里没有壳 | **点不到任何页面**：打开站点后只能看到对话页，去笔记/记忆/能力/知识库/概览/任务中心都得手动改地址；侧栏折叠、选中态、导航图标动效全部看不到 | **接线**（`index.ts` 的模块头已写好两种接法：布局路由或包住路由表），然后提交 | `文件对照`：`rg -n "SideNav" src/app` 无命中；`git status` 显示 layout 未跟踪 |
| F2 | 同上 | 「新建会话」按钮（置顶、带可读可改的快捷键小片 `Ctrl K`） | 随 F1；`SideNav.tsx:303` 已实现（用例：指向 `/chat?new=1` + 快捷键提示） | 新建一条会话只能靠改 URL 成 `/chat?new=1` | 随 F1 | `行为核对` |
| F3 | 同上 | 项目节：项目行（名字 + 会话条数）、项目内会话（默认 5 条 + 「展开（还有 N 条）」）、「全部项目」、「新建项目」→ `/workspaces?new=1`、点项目 → `?focus=<id>` | 随 F1；`features/layout/workspaces.ts`(64) 与 `SideNav` 的项目节都在（用例覆盖"超过 5 条先收起、点展开看全部"），`WorkspacesPage` 的 `?new=1`/`?focus=` 也早就处理了 | 看不到"这台机器上有哪些项目、各自聊过什么"；进项目页只能敲地址 | 随 F1（无需改 `WorkspacesPage`） | `行为核对` |
| F4 | 同上 | 对话节：未归项目的会话前 8 条、「查看全部会话」 | 随 F1；`SideNav` + `ConversationHistoryPanel` 都在，用例覆盖"点开面板、Esc 关、换页就关" | 看不到最近聊过的会话，回不去上一轮对话 | 随 F1 | `行为核对` |
| F5 | `components/layout/ConversationHistoryPanel.vue`(499) | 历史会话面板：搜索（300ms 防抖）、全部/已归档两档、按相对时间分组（今天/昨天/本周/本月/更早）、条目两行预览、置顶徽标、Esc 收起、换页自动关 | `features/layout/ConversationHistoryPanel.tsx`(343) 已写好、**8 条用例**（自己拉 limit=100+预览、搜索防抖与归档视图、分组与两行预览、点一条进去、两种空态、改完重拉；另有开合 2 条在 shell 用例里），随 F1 未接线 | 找不到旧会话：只能记住 URL；没有搜索、没有归档视图 | 随 F1 | `行为核对` |
| F6 | `components/layout/ConversationRowMenu.vue`(276) | 会话行「⋯」：置顶 / 重命名 / 移至项目 / 归档（不确认）/ 删除（二次确认，写明"消息一起删"） | `features/layout/ConversationRowMenu.tsx`(327) 已写好、**6 条用例**（置顶就地重排/重命名/删除需确认/归档不确认/移至项目含计数刷新/移出项目），随 F1 未接线 | 不能整理会话：改名、归档、删错会话都做不到 | 随 F1 | `行为核对` |
| F7 | `stores/conversations.ts`(362) | 会话清单数据层：`loadDetailList`（带预览/含归档/100 条）、`setPinned`、`setArchived`（侧栏就地移除）、`setWorkspace`、`rename`（不重排）、`remove`、`latestId`（按最近活动而不是置顶第一条）、正文缓存（TTL 5 分钟）+ `prefetchDetail`/`prefetchLatestDetail` | `features/layout/conversations.ts`(185) 已实现上述动作并有 **3 条用例**（未归档进对话节、空态、归档后立刻从侧栏消失），**只差接线**；**正文缓存与预取没有迁**（见 F18） | 同 F5/F6 | 随 F1；正文缓存可后补（见 F18） | `行为核对` |
| F8 | `SideNav.vue` 页脚 + `components/settings/AvatarDialog.vue`(201) | 账号菜单：28px 头像（无图用名字首字）、显示名 + 角色、菜单四项——头像 / 设置（仅管理员）/ 切换为浅色·深色 / 退出登录（停会话 + 清两个 store + 清名册 + 去登录页） | `features/layout/AccountMenu.tsx`(198) 已写好、**admin 四项/成员少一项/换头像/开设置/切主题写进 data-theme/退出登录**都有用例，随 F1 未接线 | **不能退出登录**（只能手动清 localStorage）、不能换头像、不能切换深浅色（深色只能靠系统偏好） | 随 F1 | `行为核对` |
| F9 | `components/settings/SettingsModal.vue`(1405) | 设置弹窗 9 组 + 功能组：模型注册 / 向量化 / 对话模型 / 服务配置 / 存储配置（维护动作）/ 用户（管理员）/ 系统与安全（改密码）/ 外观 / 快捷键 / 各功能开关（含长期记忆、Wiki 等） | `features/misc/settings/SettingsModal.tsx`(1213) **已写好、8 条用例通过**；**唯一入口在未接线的 `AccountMenu.tsx` 里**（用例"「设置」开 SettingsModal"已有），`rg -n "SettingsModal" src` 除自己以外只命中 `features/layout/` | **改不了任何配置**：没有模型与密钥、不能管用户、不能清存储、不能改外观/快捷键/功能开关——这一块是"完全看不见"，不是"少了某个按钮" | 随 F1（`AccountMenu` 已经 import 它，接线即可） | `文件对照` |
| F10 | `App.vue` 的 `watch(reloginCount)` | 会话失效（401）→ 清本地令牌 + 跳登录页并带 `redirect=<原地址>` | `lib/session.ts` 有 `reloginCount` 计数与 `requestRelogin()`，`api/client.ts` 也在 401 时调用它，但**没有任何消费者**（`rg -n reloginCount src` 只有定义与自增；`features/layout/` 里也搜不到 `relogin`） | 令牌过期后：页面原地报"登录已过期"的错，**不会自动回登录页**；刷新页面才回去（旧版是当场跳走并记住原地址） | 在 `AppShell` 里加一个 effect 监听 `reloginCount` → `navigate('/login?redirect=…')`（**接线那一步不会自动带来它**） | `文件对照` |
| F11 | `components/files/FileDrawer.vue`(543) | 文件区的**子目录进出一层**：面包屑（每段可点）、点目录进入、`listing.truncated` 的"只给你看了 300 个"提示 | `features/chat/ui/Sheets.tsx`(236) 只有**平铺清单**（`listFiles(conversationId)` 不带 path）：`is_dir` 的行只显示"目录"两个字，点了没有任何动作 | 工作区挂上的会话里，子目录**进不去**，产物在子目录时看不到 | 在 `FilesSheet` 里加 path 状态 + 面包屑 + 点目录 `load(entry.key)`；`api/conversations.listFiles(id, path)` 本来就支持 | `行为核对` |
| F12 | 同上 + `components/files/FilePreview.vue`(378) | 抽屉里**内嵌预览**：按后缀分派（md / 文本 / 图片 / pdf iframe / docx / pptx / xlsx），`FilePreview` 按需加载 Office 三引擎 | `features/preview/**`（1,747 行，三个渲染器 + 分派表 + 失败态）**已就绪**，但只被知识库域用（`DocumentDrawer.tsx`）；对话页走的是"签名 URL 新标签页打开"。旧版的 `initialKey`/`initialEntry`（从产物卡片点进去直接预览那一份，含"产物 key 无扩展名"的兜底）**没有对应物** | 产物卡片点「预览」会**跳到一个新标签页**：PDF/图片能看，Office 三件套靠浏览器下载行为，且离开对话上下文；旧版是在抽屉里就地看、看完接着聊 | 把 `@/features/preview` 的 `<FilePreview/>` 接进 `FilesSheet`，并把 `openArtifact` 的落点改成"开抽屉 + 直落那一份"（旧版就是这个口径，代码里留着 `initialEntry` 的原因注释） | `行为核对` |
| F13 | 同上 `onDragStart` | 把文件区里的一行**拖进输入框**做引用：写自定义 MIME `application/x-kylab-file` + `text/plain` | `Composer` 的投放分支**在**（`dropKind === 'reference'` → 插 `@路径`），但**全仓没有任何 `setData(` / `draggable` / `onDragStart`**（`rg` 结果为空）——**投放端是死代码**，没有任何东西能生产这个拖拽 | 旧版"从文件区拖一份文件进输入框 = 只插一条引用、不读内容"这条路径**完全不可达**（从资源管理器拖进来仍然是上传，那条还在） | 在 `FilesSheet` 的行上补 `draggable` + `onDragStart`（旧 `FileDrawer.onDragStart` 逐字搬） | `文件对照` |
| F14 | 同上 `onPick` | 往文件区**上传**文件（`uploadFile(conversationId, file, path)` + "已放入「X」"） | `FilesSheet` 没有上传入口；`api/conversations.uploadFile` 在，但产品内无调用 | 不能把文件放进会话的文件区（只能靠 Agent 产出产物） | 随 F11/F12 一起补 | `行为核对` |
| F15 | `router/index.ts` 的 `/` + `views/DashboardView.vue` | 落地页是**概览（驾驶舱）**；`/settings` 重定向到概览 | `app/App.tsx`：`/` → **重定向 `/chat`**，驾驶舱搬到 `/dashboard`；`TITLES` 里**没有 `/dashboard`**（回落成"KYLAB 知识库"）；`features/layout/SideNav.tsx:132` 的「概览」仍写 `to: '/'`（→会落在对话页） | 打开站点先看到对话页（旧版是概览）；点侧栏「概览」也是对话页；驾驶舱那一页的标签标题不对 | 拍一个口径：`/` 回驾驶舱（与旧版一致、桌面壳与书签都按它）还是明确改成对话页；`TITLES` 补 `/dashboard`；`SideNav` 的「概览」指到 `/dashboard`（**接线那一步不会自动带来它**） | `文件对照` |
| F16 | `SideNav.vue` 的 window `keydown` | 全局快捷键：**任意页面** `Ctrl/Cmd+K` 新建会话、`Ctrl/Cmd+B` 切侧栏（`isTypingTarget` 挡输入框） | `ChatProvider` 在**对话页**注册了 window 监听（用例覆盖）；`features/layout/SideNav.tsx:222` 也注册了一份、**4 条用例**（Ctrl+B 落存储 + 侧栏当场变窄、Ctrl+K 跳 `/chat?new=1`、输入框里不抢），但未接线；`layout.toggleSidebar` 现在只改 localStorage + 广播 `kylab:sidebar-toggle`，**没有监听者** | 在笔记/知识库/任务/设置页按 `Ctrl+K` **没有反应**；`Ctrl+B` 也只写了一个没人读的键 | 随 F1；两份 window 监听会同时生效 → 接线时按 `SideNav.tsx:212` 的注释把 `ChatProvider` 里那一段摘掉 | `行为核对` |
| F17 | `composables/useAutoHideScrollbar.ts`(120) | 侧栏滚动条"用时才出现、停手 1.2s 消失"（`scroll-quiet` + 3px 感应带） | `features/layout/useAutoHideScrollbar.ts`(90) 已写好（`SideNav` 已调用 `useAutoHideScrollbar(sideScroll)`）、随 F1 未接线；`tokens.css` 里 `scroll-quiet` 那套样式还在 | 侧栏做出来之后如果不接，滚动条会**一直在**（旧版特意调过这一处） | 随 F1 | `行为核对` |
| F18 | `SideNav.vue` 的 idle 预热 + `stores/*.prefetch` | 启动空闲预热任务/统计/注册表；悬停导航项预热路由 chunk 与那一页的数据；悬停会话行预取**会话正文**（5 分钟缓存） | 新前端用 react-query（`staleTime` 15–60s、`retry: 2`、失败去重），**没有 hover/idle 预热，也没有会话正文缓存**（`useConversationDetail` 每次进页都拉；`layout/conversations.ts` 也没带正文缓存） | 点进某页/某条会话时会**多一次往返的空白**（旧版是"点进去就有"）；功能不缺，属于观感退化 | 低优先：可用 `queryClient.prefetchQuery` 在壳里补 hover 预热；正文缓存按会话 id 做 `initialData` | `推断`（未实测两版时序） |
| F19 | `components/ui/ToastStack.vue`(107) | 通知条带「关闭通知」按钮、最多叠 4 条、按 tone 上语义色 | `ui/sonner.tsx`：位置、语义色图标、令牌都对齐了，但**没有开 `closeButton`** | 通知条上**没有关闭按钮**（只能等它自己消失，默认 4s） | 一行的事：需要就说一声，`<Sonner closeButton>` | `推断`（只读了 props，未在浏览器里核对 sonner 默认行为） |

---

## 2. 缺口表 · 工程（用户看不见，但 P5 之前必须处理）

| # | 项 | 状况 | 影响 | 建议 | 证据 |
| --- | --- | --- | --- | --- | --- |
| E1 | `frontend-react/src/features/layout/**`（11 文件 2,319 行）+ `tests/layout-{shell,conversations}.test.tsx`（35 条） | **未跟踪、未提交、无人 import**（`git status` 只有一行 `?? frontend-react/src/features/layout/`）；文件时间 19:13–19:18，晚于最后一次提交（19:10）；`app/App.tsx` 到 19:19 **未改**（`git diff` 为空）；`index.ts` 的模块头写了两种接线方式，等主控接 | 以提交 `7b9f834` 为准，**这一整块等于不存在**；F1–F9、F16、F17 全部因此计为缺口 | **接线 + 提交**：`<Route element={<AppShell/>}>` 包住业务路由（登录页留在壳外）。用例已写好（旧 `SideNav` 18 / `ConversationHistoryPanel` 12 / `ConversationRowMenu` 6 = 36 条可对照，新 35 条）；接线后跑一次全量门禁 | `文件对照`（`git status` / `git diff` / `wc -l` 均可复算） |
| E2 | 部署与门禁脚本**仍指向旧前端** | 未改：`deploy/docker-compose.yml`（`context: ../frontend`、`image: kylab-frontend`）、`deploy/nas/docker-compose.yml`（`../src/frontend`）、`scripts/check-frontend.sh`/`.ps1`、`scripts/lint.sh`、`scripts/ci.sh`、`scripts/dev-frontend.sh`、`scripts/audit-copy.py`（`ROOT/... "frontend" / "src"`） | 切换后**构建的、被测的都是旧前端**；新前端的门禁只有 `check-react.sh` 在跑 | P5 一起改；`frontend-react/{nginx.conf,Dockerfile}` 已备好（与旧版同构，只差 pnpm 与注释），`compose` 只改 `context` 与镜像名 | `文件对照` |
| E3 | `features/misc/search/KbSearchPanel.tsx`(357) 与 `features/knowledge/KbSearchPanel.tsx`(347) | **两份实现**：产品用 knowledge 那份（`KnowledgeBaseView` import），misc 那份只被 `tests/misc-search.test.tsx` 用（4 条用例） | 现在不影响用户；但两处改一处、另一处不会跟着改（旧版只有一份 624 行） | 删一份、用例改指向（哪份留由主控拍） | `推断`（按 import 关系判断，未跑覆盖率） |
| E4 | 旧 863 条用例里**逻辑型**的那些在新前端没有对应 | 新前端 468 条覆盖了对话模型/流式、笔记、知识库、预览、misc 各页；**没有对应**的主要有：`api/*` 54 条（`client` 的 401 与 multipart、`chat` 的 SSE 解析、`conversations`/`documents`/`memory`/`settings`/`maintenance`）、`useFormat` 24、`useShortcuts` 15、`useSession`+`useSessionToken` 13、`status` 10、`providerPresets` 10、`AppMultiSelect` 10、`AppSelect` 11、`AppCombobox` 9、`displayPacer` 8、`clipboard` 8、`usePolling` 7、`icons` 7、`ConfirmDialog` 5、`useTheme` 5、`useSidebar` 3、`useFontScale` 9，以及 SideNav/历史面板/行菜单 36 条（随 F1–F7） | 回归风险：这些行为在新前端**没有自动化防线**（例如 401 链路、CSV/表格导出的边界、pacer 的追赶口径） | 按迁移计划 §0 验收第 3 条补"逻辑型用例"；优先 api 层与 401 链路（后者正好是 F10） | `推断`（"哪些算逻辑型"是我按纯函数/状态机判的，取舍需主控拍） |
| E5 | 旧 `frontend/` 目录与旧门禁**仍在跑** | 两套前端共存期（迁移计划 §7 明写"共存只到 P5 结束"） | 这期间同一个 bug 可能只在一侧被修（`react` 分支还要求定期 `merge agent`） | P5 时删目录、改脚本；在此之前每次 bug 修复注意落两边 | `文件对照` |

---

## 3. 按域统计（旧行数 / 新行数 / 用例数 / 缺口数）

行数含 `.vue/.ts/.tsx/.css`（不含 `api/schema.d.ts` 那 14,060 行的生成物）；
用例数按文件归属统计（旧 = `frontend/tests/unit/**` 的 82 个文件，合计 **863**；
新 = `frontend-react/tests/` 的文件，`pnpm test` 实测 **468**（31 文件）+ 工作区里新增的
layout 两个文件 **35**（实测全绿），按文件归属拆到各域。

| 域 | 旧文件/行数 | 新文件/行数 | 旧用例 | 新用例 | 缺口数 |
| --- | --- | --- | --- | --- | --- |
| 对话页（`views/ChatView` + `components/chat` + 回合/流/公式模型 + `ModelPicker`） | 15 / 9,446 | 33 / 8,438 | 265 | 214 | 4（F11–F14 全在文件抽屉） |
| 知识库与文档（`KnowledgeBaseView`/`KnowledgeBasesView`/`Wiki`/`DocumentView` + `components/knowledge`/`search`/`files`/`charts`） | 17 / 10,754 | 30 / 11,252 | 101 | 102 | 1（E3 重复实现） |
| 笔记（`NotesView` + `components/notes` + `stores/notes`） | 5 / 2,817 | 7 / 3,174 | 40 | 75 | 0 |
| 其余页面（任务/记忆/工作区/能力/设置/驾驶舱/登录/404 + 定时/负载/图谱/注册表） | 27 / 12,166 | 40 / 13,721 | 134 | 50 | 2（F9 设置无入口、F8 账号菜单） |
| 外壳 shell（`components/layout`） | 3 / 2,407 | 11 / 2,319（**未接线**） | 36 | 35（**新增，未接线**） | 12（F1–F9、F15–F17 的宿主） |
| ui 原语与图标（旧自研 21 件 + 78 个图标） | 98 / 5,201 | 29 / 2,624（shadcn/Radix + lucide） | 73 | 16 | 0（换实现，见 §4） |
| composables → `lib/` + 各域 | 17 / 1,902 | 7 / 784 | 115 | 见各域 | 2（F17 滚动条、F18 预热） |
| stores（Pinia → zustand/react-query/域 store） | 6 / 811 | 分散在各域（含 `layout/conversations.ts`、`layout/workspaces.ts`） | 44 | 见各域 | 1（F7） |
| api 层 | 24 / 4,015 | 24 / 4,020 | 54 | 0（直接单测） | 0（唯一差异：`chat.ts` +5 行补 `kind`） |
| 壳/路由/令牌（`App.vue`/`main.ts`/`router`/`assets`） | 7 / 1,419 | 7 / 1,331（`app/App.tsx`+`main.tsx`+`styles`） | 3（`App.test`） | 21（含 smoke 2） | 1（F10 401） |
| 部署与门禁 | nginx/Dockerfile/compose/7 个脚本 | `frontend-react/{nginx.conf,Dockerfile}` 已备；compose/脚本未改 | — | — | 1（E2） |
| **合计** | **219 / 50,938** | **188 / 47,663** | **863** | **503** | **22（功能 17 / 工程 5）** |

---

## 4. 已迁但**换实现**（旧 → 新库/新文件）

| 旧 | 新 | 口径差异（要盯的） |
| --- | --- | --- |
| `components/icons/**` 78 个手写 SVG + `brands/index.ts` | **lucide-react 1.47**（+ `chat/ui/Logo.tsx` 承 `IconLogo` 的字标/环标） | 图标形状不一致（像素级），品牌标仍自绘 |
| `components/ui/**` 21 件（`AppModal`/`AppSelect`/`AppCombobox`/`RowMenu`/`ConfirmDialog`/`ToastStack`/`AppAvatar`/`SkeletonBlock`/`MeterBar`/`RingGauge`/`PageShell`/`InfoTip`…） | **shadcn/ui + Radix 29 个原语**（`src/ui/**`），两域各留一组 `composites.tsx`（`StatusTag`/`MeterBar`/`EmptyState`/`InfoTip`/`SegmentedControl`…） | 浮层从"自写 `<details>`/手算定位"换成 Radix portal（Esc/点外关闭/焦点陷阱由库管）；`AppMultiSelect` 的**下拉浮层 → 平铺勾选行**（`misc/shared/MultiSelect.tsx`，行为等价形态不同）；上下文仪表的**环形表 → 细条**（`ComposerControls.ContextGauge`） |
| `composables/useMarkdown.ts`(580) | `chat/model/markdown.tsx`(1124) + `knowledge/markdown.tsx`(196)：**react-markdown + remark-gfm + rehype-highlight** | 代码块复制/表格复制与下载 CSV 的**动作按钮**由自定义 rehype 组件承担（同一套 `data-*` 与类名保留，测试可查）；BOM、TSV 粘贴口径逐条对齐 |
| `composables/useLatex.ts`(290) | `chat/model/latex.ts`(432)：**remark-math + rehype-katex** | **8 条口径差异**写在 `chat/model/README.md`；已知一条要用户拍：`$5 到 $10` 会被当公式排（缓解写法 `\$5`） |
| `composables/useToast.ts`(48) + `ToastStack.vue`(107) | **sonner**（`ui/sonner.tsx`，`Toaster` 挂在 `App.tsx`） | 见 F19（无关闭按钮）；三档语义（成功/失败/警告）保留 |
| `composables/displayPacer.ts`(244) / `clipboard.ts`(120) / `useFormat.ts`(135) | `lib/pacer.ts` / `lib/clipboard.ts` / `lib/format.ts`（**逐行等价，只是 ESM 出去**） | 无 |
| `composables/useChatTurns.ts`(832) / `useLiveTurn.ts`(586) | `chat/model/turns.ts`(844) / `chat/model/liveTurn.ts`(642)（Vue 响应式 → 纯函数 + store） | 无（旧 145 条逻辑用例 → 新 176 条） |
| `composables/useShortcuts.ts`(378) | `misc/settings/useShortcuts.ts`(372)（写方）+ `chat/runtime/shortcutPrefs.ts`(240)（**只读副本**） | 契约同一份（`kylab-shortcuts`）但**两份实现**——改一处要改两处，注释里也承认了；建议 P5 后收敛成一份 |
| `composables/useTheme.ts` / `useFontScale.ts` / `useSession*.ts` / `useOperator.ts` / `useChunking.ts` / `useUploadLimits.ts` | `misc/settings/useTheme.ts` / `useFontScale.ts` + `lib/session.ts`+`sessionActions.ts` / `lib/operator.ts` / `knowledge/chunking.ts` / `knowledge/uploadLimits.ts` | 字号与主题的**首屏内联脚本逐字一致**（`index.html`）；键名一字不差（`kylab-*` 一族） |
| `stores/**`（Pinia 7 个） | **zustand**（会话/笔记/侧栏/工作区）+ **@tanstack/react-query**（知识库以外的服务端状态）+ `features/knowledge/store.ts`（本域自管） | react-query 的缓存/失效语义替换了手写 `loading/error/loaded`；分页与排序口径在页内实现（`sortConversations`/`latestConversationId` 都在未接线的 `layout/conversations.ts` 里） |
| Office 预览：`@vue-office/excel`、`@vue-office/pptx`、`docx-preview` 包装（`OfficePreview.vue` 110 + `FilePreview.vue` 378） | `features/preview/**`（`DocxPreview` docx-preview / `PptxPreview` pptx-preview / `SpreadsheetPreview` **exceljs**） | **`xls`（二进制）会解析失败并落到失败态**，文案单列（`LEGACY_XLS_NOTE`）；分派表 `kinds.ts` 与旧表逐条对齐，只多了"后端 kind 优先"一条 |
| `components/charts/EChart.vue`(291) / `ActivityHeatmap.vue`(148) | `misc/dashboard/EChart.tsx`(270) / `ActivityHeatmap.tsx`(137)（echarts 6 仍是框架无关那一个） | 懒加载（驾驶舱单独异步）保留 |
| vue-router 13 条路由 | react-router 8，**路径/标题/重定向逐条照抄** | 两条路由的"必须写成一条可选参数路由"约束（`/chat/:id?`、`/notes/:id?`）两边一致；`/` 的落点不同（F15） |

---

## 5. 有意未迁（逐条理由）

| 项 | 理由 |
| --- | --- |
| `composables/useTopLayer.ts`(30) | 它是给自研 `AppModal`/`ToastStack` 处理**原生 `<dialog>` 的 top-layer 叠放顺序**用的。React 侧的浮层一律走 Radix portal + z-index 令牌，"谁在最上面"由库管；这条抽象没有存在的地方 |
| `shims/vue-office.d.ts` | 随 `@vue-office/*` 一起下线（换成 docx-preview / pptx-preview / exceljs 的**自带类型**） |
| `components/files/FilePreview.vue` 的**独立组件形态** | 预览能力**已迁**（`features/preview/**`），只是不再挂在一个"抽屉里的 iframe"上；对话页那一处的接线差异见 F12（算缺口，不算不迁） |
| 桌面壳（`desktop/`） | 不改：壳按 URL 连 NAS 上的前端（`desktop/README.md` §首次打开是配置页），新前端沿用同一批路径与 `/api/v1` 相对前缀，`tauri.conf.json` 的 `frontendDist` 指壳自己的 `src/`，与前端构建无关 |
| `frontend/`（旧 Vue 目录）本身 | P5 切换完成后删（迁移计划 §0 验收第 4 条）；在那之前它仍是可回退的一份 |
| 旧 `frontend/tests/unit/eslint-rules/no-emoji.test.ts` | 新前端把这条规则做成独立脚本（`scripts/scan_emoji.py` 扫 `frontend-react/src`，在 `check-react.sh` 里当门禁），不依附 eslint 插件；**代价**：规则本身没有单测（旧 1 条） |

---

## 6. P5 切换前必须补的清单（按"会不会让用户少看到东西"排序）

**第一档：不做就是"用户少看见半个产品"**

1. **接线 `features/layout/**` 到 `app/App.tsx` 并提交**（E1）：一次闭合 F1–F9、F16、F17
   （侧栏主导航 + 新建会话 + 项目节 + 对话节 + 账号菜单 + 设置入口 + 历史会话面板 +
   会话行菜单 + 会话清单数据层 + 自动隐藏滚动条 + 全局快捷键宿主）。
   `index.ts` 的模块头已经写好两种接法；接线时的四个注意点（都写在旧 `App.vue`/`SideNav.vue`、
   新 `AppShell.tsx` 的注释里）：① 登录页留在壳外（壳自己也会在 `/login` 退化成只有内容区）；
   ② 换页就关历史会话面板（用户报过的"点了菜单没反应"）；③ 记住 `?new=1`（侧栏「新建会话」）
   与 `/chat`（回最近一次）的分工；④ 从 `ChatProvider` 里摘掉重复的 window keydown。
2. **接 401 → 登录页**（F10）：一个监听 `reloginCount` 的 effect。**接线不会自动带来它**
   （`features/layout/` 里搜不到 `relogin`），缺了它"会话过期"变成"原地报错"。
3. **补齐会话管理链路**（F5+F6+F7，随 1 一起）：没有它，用户在产品里**无法管理自己的会话**
   （改名/归档/删除/置顶/找回来）。
4. **文件抽屉补齐四件事**（F11+F12+F13+F14）：子目录进出、内嵌预览、上传、拖拽引用——
   对话页是主战场，这四处旧版天天在用；**这一块与壳无关，是独立的工作量**。
5. **定落地页口径并修三处**（F15）：`/` 是概览还是对话页、`TITLES` 补 `/dashboard`、
   `SideNav.tsx:132` 的「概览」目标地址（现在是 `/`，会落到对话页）。

**第二档：观感与体验退化（不补也能用，但要知情）**

6. ~~通知条的关闭按钮（F19，一行）~~ → **已补**（`@/ui/sonner` 开 `closeButton`，§12.241）。
7. ~~hover/idle 预热与会话正文缓存（F18）~~ → **已补**（导航项 hover/focus 预载路由 chunk：
   `app/routes.ts` 的 `PAGES` + `preloadPage`，与 `React.lazy` 共用同一批 import 函数；
   会话行 hover/focus 预取正文：`chat/runtime/useChatData.prefetchConversationDetail`
   与 `useConversationDetail` 同一个 queryKey。两条都有用例钉住，§12.241）。
   **仍留的**：启动后的 idle 预热（任务/统计/注册表）与"只预取正文不预取整页"的进一步优化。
8. 侧栏滚动条自动隐藏（F17，随 1 一起落地）。

**第三档：工程与部署（不影响用户，但决定"切得成不成"）**

9. **人工浏览器逐页对照**（迁移计划 §0 验收第 2 条 + §9 的下一步第 1 条）：同一条会话、同一份笔记、同一个库，两套前端截图比——**到本次审计为止一次都没做过**。本审计是代码级对照，替代不了它。
10. 部署与脚本改指向（E2）：`deploy/docker-compose.yml`、`deploy/nas/docker-compose.yml`、`scripts/{check-frontend.sh,check-frontend.ps1,lint.sh,ci.sh,dev-frontend.sh,audit-copy.py}`。
11. 补逻辑型用例（E4）：优先 api 层 54 条里的 `client`（401 与 multipart）与 `chat`（SSE 解析），以及 `useFormat`/`displayPacer` 这类纯函数。
12. 删重复的检索面板（E3）。
13. 两处口径待用户拍（迁移计划的遗留项，本次审计复核仍在）：① `$5 到 $10` 被当公式排；② 对话页文件抽屉要不要接 `@/features/preview` 的内嵌预览（本次审计建议：接，见 F12）。

---

## 7. 本次审计里的"推断"条目（请主控复核）

以下几条的判定链**没有跑到最终证据**，请主控按需要复核或补测：

1. **`features/layout/**` 的性质**：我按"未跟踪 + 文件时间晚于最后一次提交 + 内容与旧 `SideNav` 逐条对应 + `index.ts` 里写着"主控怎么接""推断它是**同期在施工的壳**（审计期间它从 0 长到 11 文件 + 35 条用例）。它归谁、什么时候提交、要不要再补别的（例如 `TITLES`/`/` 的口径它就明确留给了主控），得主控确认。**本文把 F1–F9/F16/F17 记作缺口，只因为它们此刻在产品里不可达**；接线 + 提交后这些行应改成"已迁"。
2. **F16 的"两份 window keydown 会重复触发"**：读未接线的 `SideNav.tsx` 的注释（它自己写了"壳落地之后那段由主控摘掉"）推断的，没跑浏览器验证双份监听的实际表现。
3. **F15 的标签标题**：从 `TITLES` 数组没有 `/dashboard` 这一条推断用户会看到"KYLAB 知识库"而不是"概览"，没在浏览器里核对。
4. **F19 的关闭按钮**：只读了 `ui/sonner.tsx` 的 props（没开 `closeButton`）推断 sonner 默认不显示，没实测。
5. **F18 的性能影响**（"点进去先空白一下"）：属于推断，没有实测两版的首帧时序。
6. **E3 的孤儿判断**：按 `rg` 的 import 关系推的（misc 那份只被测试引用），没跑覆盖率确认没有动态引用。
7. **E4 的"哪些旧用例算逻辑型"**：我按"纯函数/状态机"自行分类，具体哪些必须在新前端有一一对应，是主控/用户的取舍（迁移计划 §0 只写了"逻辑型的都要有对应用例"）。
8. **对话域没有做逐按钮对照**：旧 `ChatView.vue` 4,869 行 / 新 chat 域 8,438 行，我做的是"handler 名单 + 中文字面量集合 + 抽样读模板 + 跑 dialog/trace/审批/抽屉的用例"，**没有把模板里的每一个按钮逐个点对**。已抽查过的部分（流式、过程面板两级懒加载、审批、降级出口、斜杠/提及菜单、出处折叠、交付物、上下文仪表、执行策略、模式、停止、回到最新、复制/存为笔记）都在；**仍可能有个别局部交互或边界文案未发现**，建议在人工对照（第 9 项）里覆盖。
9. **知识库/笔记/其余域同理**：这三域做了"页面交互清单 vs 新实现"的逐项对照（含表格列、批量动作、分页、空态、错误态、弹窗），未做像素级版式对照。
