# 对话 UI 显示逻辑与动效 · 全量审计 v0.1

- **审计对象**：`frontend/src/features/chat/**`（33 个文件 ≈ 4,900 行）+ 其依赖的全局基座（`styles/tokens.css`、`styles/themes/*`、`src/ui/{sheet,dialog,tabs,sonner}`）+ 上游 `@assistant-ui/react 0.15.21` 与 `tw-animate-css 1.4.0`、`sonner 2.0.8`
- **审计时点**：2026-09-29（以工作区源码 mtime 为准）
- **性质**：**只读审计**，未改动任何产品代码。本文只做取证与判定，不含实现
- **方法**：逐文件读源码 + 读构建产物 + 读 `node_modules` 上游源码 + 对测试断言交叉验证。每条结论标 `path:line`
- **证据级别约定**：`源码级`（读到实际代码）/ `产物级`（读到构建产物或上游库源码）/ `用例级`（有测试断言钉住）/ `推断`

> **一处必要的构建产物提醒**：`frontend/dist/assets/index-D6ZRihjy.css` 构建于 **2026-09-25**，比源码（09-29）旧 4 天。本文凡引用产物处均已标注，且只用它来判定**不随时间变化的规则**（如 Tailwind 的排序与令牌取值）。**若要按当前源码验收动效，需先重新构建。**

---

## 0. 结论摘要

| # | 结论 | 级别 |
| --- | --- | --- |
| 1 | **对话域的"动效"主体不是 CSS，而是显示节拍器（pacer）**：正文 40→600 字/秒、24ms 一拍、出处 110ms 逐条亮。CSS 那一侧极窄——`chat.css` **0 个 `@keyframes`** | 源码级 |
| 2 | **对话域是唯一"一处 `prefers-reduced-motion` 都没做"的域**（只有 `AnswerText` 的脉冲带 `motion-reduce:animate-none`）。pacer 逐字流本身**没有** reduced-motion 判断 | 源码级 |
| 3 | **工具调用面板没有 `status` 字段**：running 与 done 的行内**零差别**，唯一"还在跑"的信号是最上面那行实时文案 | 源码级 |
| 4 | **单步展开态跨轮次串号（真 bug）**：key 是 `${phase}-${index}`，而 `openSteps` 是全局一个 Set | 源码级 |
| 5 | **所有"进入"动画都比"退出"慢或等于，且遮罩与本体不同步**：抽屉开 500ms / 关 300ms，遮罩固定 150ms；弹窗本体 200ms、遮罩 150ms | 产物级 |
| 6 | **四颗下拉菜单与 `/`、`@` 两个菜单完全没有进出场动画**：chat 直接 `import '@radix-ui/react-dropdown-menu'`，`@/ui/dropdown-menu` 上的 `animate-in slide-in-from-*` **到不了对话页** | 源码级 |
| 7 | **知识库开关的滑块不会滑动（本文更正了初版判断）**：`transition-all` 被任意属性 `[transition:var(--transition-ui)]` 覆盖，而后者不含 `left` | 产物级 |
| 8 | **assistant-ui 的视口滚动在对话页全是"瞬时"**：`behavior:"auto"` 取元素的 `scroll-behavior`，而全仓没给视口设过 `smooth`；「回到最新」也是**跳**过去而不是滑过去 | 产物级 |
| 9 | **记忆类步骤被面板整段隐藏**：`read_memory` / `write_memory` / `remember` / 老标签「记住」在分组前就被 filter 掉，连带它们那一步的推理 | 源码级 |
| 10 | **前向兼容暗雷**：`api/chat.ts` 的分发末尾是 `if (type==='done') … else onError(...)`。后端将来**新增任何一种带 `data:` 的事件类型，都会被当成 error 分支**处理（后端 `ping` 之所以不带 `data:` 行，正是为了绕开它） | 源码级 |

**最该先动的四件事**（按性价比）：① 展开态跨轮串号（真 bug、改动局部）；② 未知 SSE 类型落进 error 分支（前向兼容）；③ 对话域补 `prefers-reduced-motion`（含 pacer 开关）；④ 工具调用块的默认展开/折叠策略（见 §5，这是用户最不满的一块）。

---

## 1. 版面骨架与尺寸体系

装配链（`ChatPage.tsx:60-89`）：

```
ChatProvider   页面状态与动作（消息 / 发送 / 过程面板 / 浮层 / 偏好）
└ ChatRuntime  assistant-ui runtime 适配（外部 store，协议仍是我们自己的）
  └ ChatThread 对话区（视口 / 跟随滚动 / 三态内容）
  └ Composer   输入卡片
+ SourceSheet / IngestDialog（页面级浮层，不随卡片重挂）
```

| 项 | 取值 | 来源 |
| --- | --- | --- |
| 整页 | `flex h-dvh flex-col bg-[var(--bg-canvas)]` | `ChatPage.tsx:69` |
| 会话抬头 | 高 44px（`--row-height`）、字号 14、无底色/无下边框、不放按钮；**无标题则整条不画** | `ChatHeader.tsx:46-49` |
| 滚动视口 | `min-h-0 flex-1 overflow-y-auto`，`aria-label="对话内容"` | `ChatThread.tsx:84` |
| 内容列 | `--chat-measure` = `--chat-input-max-width` = **768px**，两侧各留 `--page-gutter`（`clamp(20px,2.4vw,40px)`） | `tokens.css:381-400` |
| 正文行宽 | `--measure` = **66ch** | `MessageView.tsx:225` |
| 字号阶 | 18 / 16 / 15 / 14 / 12 / 10（拉丁），全部乘 `--font-scale` | `tokens.css:350-366` |
| 行高 | UI 1.47 / 长文 1.7 / 代码 1.6 | `tokens.css:370-374` |
| 轮间距 | 用户轮前 24px，助手轮前 12px | `MessageView.tsx:335` |

**关键修复（`ChatThread.tsx:69-77`）**：对话列必须 `min-h-0 flex-1` 而不是 `h-full`——后者会把输入卡片顶出视口（实测 900 高窗口卡片落在 y=900~1054）。用例级：`tests/chat-ui.test.tsx:988-1003`。

**空态与输入框的真实关系（与注释不符）**：输入卡片**永远贴底**（它是 `h-dvh` 那一列的第二个孩子），空态时居中的只有欢迎层（`min-h-full … justify-center` + `pb-0`，`ChatThread.tsx:89-94`）。`ChatProvider.tsx:222-223` 的注释写"欢迎层与输入卡片作为一组居中"，与实现不符。

---

## 2. 显示内容全量清单

### 2.1 会话抬头 `ChatHeader.tsx`

标题（14px/medium/truncate + `title`）+ 项目名（Folder 13px + 12px 三级灰 + `max-w-[12em]` truncate）。**没有标题就整条不画**（`:46`），新会话时由 `NewChatScope` 顶上「在项目「X」里新建…」（`ChatPage.tsx:45-58`），两者不同时出现。标题与 `workspace_id` 复用会话详情缓存，项目名查壳的工作区 store。

### 2.2 空态 `Welcome.tsx`

字标（wordmark 34px，accent 色）+ 标语「让你的知识触手可及」+ 「你可以这样问我」+ 「换一批」+ **一列、每行一条、左对齐**的推荐问题卡片 + 无库时的指路链接。
推荐问题整块跟着 `chat.showSuggestions`（= 开着知识库且至少选了一个库）出现/消失；`suggestionsLoading` 时整列 `opacity-50`（**无过渡**）。

### 2.3 骨架屏 `ChatThread.tsx:45-57`

4 条灰条（宽 92/78/85/64%、高 14px、`--bg-subtle`、`aria-hidden`），只在 `messages.length===0 && pendingEntry` 时出现，**不画欢迎层**。
**注意：它完全静止、没有 `animate-pulse`** —— 与壳的骨架（`App.tsx:148-156`，pulse 2s）和挂载前骨架（`index.html:89`，1.6s）三种行为并存，底色也不同（`--bg-subtle` / `--bg-active` / `--bg-hover`）。

### 2.4 消息列 `MessageView.tsx`

| 角色 | 对齐 | 最大宽度 | 背景/圆角 | 头像 | 轮间距 |
| --- | --- | --- | --- | --- | --- |
| user | 右对齐 | 列 `min(78%,620px)`；气泡 `w-fit` | `--bg-subtle` + 1px hairline；圆角 `16px 16px 4px 16px` | 无 | 24px |
| assistant | 左对齐（40px 头像沟槽） | 正文 66ch；错误/降级/交付物同宽 | **无气泡背景**（正文直接铺在画布上） | 40×40 圆底 `--accent` + Logo mark 22px | 12px |

用户气泡：`whitespace-pre-wrap` + `[overflow-wrap:anywhere]`，**不走 Markdown**；hover 才显形的 22×22 复制键（opacity 0→100）；随发附件片（`max-w-[220px]`，FileIcon 13 + 名字 truncate + `formatBytes`，`aria-label="预览 {name}"`）。

助手列四条互斥分支：

| 分支 | 判据 | 显示 |
| --- | --- | --- |
| 失败 | `message.error` | 红字「这一轮没跑起来：{failureText}」+ 「重试」（每轮都有；后续还有轮次时 title 说明代价）+ 「复制问题」；**过程面板与正文整块不画**（`MessageView.tsx:133,196-199`） |
| 工具标记 | `hasToolCallMarkup` | 「未执行的工具调用标记」+ 等宽原文（`data-testid="reply-raw-tools"`）；**注意：这一支会吞掉整条 Markdown 渲染**，含引用徽标与代码块按钮 |
| 正常 | 其余 | `TracePanel` → `AnswerText` → 降级提示 → 交付物 → 动作行 |
| 降级 | `!streaming && wasDegraded` | 橙字「这次没跑完（{服务端给的 detail}）。」+ 仅最后一轮给「继续 / 重试」 |

动作行（仅 `!message.streaming`）：复制 / 存为笔记 / 重新生成（仅最后一轮）。

### 2.5 正文渲染管线 `model/markdown.tsx`

```
remark:  remarkGfm → remarkMath
rehype:  rehypeUnwrapLinks → rehypeCodeText → rehypeSoftBreaks → rehypeTrimBlocks
       → rehypeBareUrls → [rehypeCitations（有出处或有兜底时才挂）]
       → rehypeHighlight → rehypeCodeTail → rehypeMathSpacing
       → [rehypeKatex, {strict:'ignore'}] → rehypeStyleObjects
```

带 300 条的渲染缓存 `ELEMENT_CACHE`（键含正文 + 出处签名 + plain/rich + 兜底文案）。
**安全口径**：不开 `rehype-raw`，模型输出的 HTML 只当文本；链接白名单 `^(https?://|mailto:)`。

**引用徽标**（`:469-579`）：正则 `\[(\d+(?:\s*[,，]\s*\d+)*)\]`；替换发生在**文本节点**上（代码块与行内代码天然不在扫描范围）；有出处 → `<a class="md-cite" data-cite-index role="button">`，**徽标上显示文档短名而不是序号**（剥目录前缀 + 剥扩展名）；**组里有一个对不上就整组不换**；这一轮跑过联网搜索时给 `citeFallback`，对不上的编号渲染成**不可点的虚线标记**（`title="联网搜索结果，见过程面板"`），没跑过则原样留着裸编号。

**代码块**（`:874-970`）：两段式 `.md-code`（语言名 + 展开键 + 复制键 + `pre.md-pre`）；限高 `CODE_MAX_HEIGHT_PX = 400`，用 `scrollHeight > 401` 量一次决定要不要给展开键；限高走**内联 `maxHeight`**，展开时清掉。
**已知缺陷**：该测量只以 `[codeText]` 为依赖（`:896-900`）⇒ 用户调字号（`--font-scale`）或改窗口宽度后**不重测**。

**表格**：复制走制表符分隔（粘 Excel 拆单元格），下载走带 BOM 的 CSV，文件名 `表格-<ISO>.csv`（在页面层，`AnswerText.tsx:56-91`）。
**公式**：`remark-math` + `rehype-katex`，另有一条 `rehypeMathSpacing` 按 GitHub 口径把"`$` 与内容之间有空格"的退回原文（`$5 到 $10` 不再被排成公式）。8 条与旧自写插件的差异见 `model/README.md:156-193`。
**KaTeX 样式**：在入口引（`main.tsx:13` `import 'katex/dist/katex.min.css'`）。
**没有的**：标题无 `id`/锚点；`img` 无自定义组件（无 lightbox、无尺寸约束）；任务列表用浏览器默认 checkbox。

**正文排版的全部取值**（`chat.css`，全部只写下边距靠外边距折叠）：段落 `0 0 12px` + `pre-wrap`；小标题 `20px 0 8px` + 16px/600/1.4；列表 `padding-left:20px` + 显式还原 `disc`/`decimal`（preflight 把符号删了）+ 条目间距 8px + 嵌套换 `circle`；引用 `8px 12px` + 左侧 3px `--border`；行内代码 `1px 4px` + 0.92em；徽标 `max-width:8.5em`、高 16px、12px 字、`vertical-align:-2px`。

### 2.6 交付物 `Deliverables.tsx`

每份一张卡：`format.toUpperCase()` 的 40×28 文字块 + 文件名（truncate）+ `formatBytes` + `· {where}` + 「预览」「下载」「存进知识库」（已入库变灰字「已存进知识库「库名」」）。按 `artifact_id` 去重（`turns.ts:609-622`），顺序即产出先后。
**流式中整块不摆**（`MessageView.tsx:272`），等这一轮收尾。**卡片本身没有 creating/ready/failed 状态机**，唯一失败反馈是 `notifyError`。

### 2.7 输入卡片 `Composer.tsx` + `ComposerControls.tsx`

**内容自上而下**：回到最新浮标 → 审批条 → 命令回话 → 两个菜单浮层 → 拖拽提示 → **卡片本体**（待发附件 → 超长粘贴提示 → textarea → 控制行）→ 两个隐藏 file input → FilesSheet。

| 区域 | 要点 |
| --- | --- |
| 卡片壳 | `radius-input`(24px) + `--bg-surface` + `shadow-input`，`px-3 py-2` |
| 待发附件 | 图片 56×56 缩略图 / 其它文件片；右上角 16px 移除键；**此刻还没上传**（发送那一刻才落会话文件区） |
| textarea | `maxLength=32000`、`min-h-[44px] max-h-[240px]`、**随内容长高**（每次设 `height=scrollHeight`，**无过渡**）、无 placeholder（改用 `aria-label`） |
| 控制行 | 左：`+ 权限 知识库`；右：`模型 (+未选知识库提示/+正在上传…) 发送` |
| 发送/停止 | **同一个 32×32 按钮、同一个位置**；发送键空输入时**灰化**（不是半透明） |
| 回到最新 | 挂卡片上沿，`messages.length>0` 且未贴底时出现（贴底时靠 `disabled:hidden`） |

**「+」菜单**：添加文件和图片 / 添加文件夹 / 浏览文件 / （子菜单）技能（勾选 = 钉住本轮）。
**「权限」胶囊**：仅查看 / 工作区内编辑 / 完全访问；**只写档名**（「权限」二字挪进 `aria-label`）；非管理员整颗不渲染；读写的就是设置页那一份 `chat.permission`。
**「知识库」胶囊**：**一颗胶囊里两件东西** = 左边 28×16 开关（`role="switch"`）+ 右边「知识库」文字（开面板）；**触发器上一个字的状态都不印**；面板里是筛选框（库 > 8 个才出现）+「全选 / 清空」+ 带勾清单（关掉时置灰但**选择留着**）。
**「模型」胶囊**：Bot + 模型名（truncate）+ 箭头；`!thinkingOn` 时多一枚「思考关」小片。面板 = 「默认模型」+ 各模型（右勾）→ 分隔线 → 上下文行（环 + 比率）→ 思考开关 → 强度三档 → 分隔线 → 上下文明细 + 「压缩上下文（/compact）」。
**上下文环**：`viewBox 0 0 24 24`、16×16、`r=10`、`strokeWidth=2`；底圈 `opacity .25`，进度圈 `opacity .7` + `round` + `strokeDasharray=2πr` + `strokeDashoffset=2πr(1-filled)` + `rotate(-90deg)`。行上只放比率，精确 token 数在 `title`；读不到时「不可用」，还没回来「—」（**不给 0%**）。

### 2.8 审批条与浮层

**审批条**（`ApprovalBar.tsx`）：边框 `--border-strong`（比普通卡重一档）；标题 + 等宽命令原文（可横向滚，**不许省略号截中间**）+ 可选 detail + `rule` 预告（「「这类都允许」会往放行清单加一行 …」）+ 拒绝理由输入（上限 500，**回车即拒绝**）+ 三键 + 倒计时提示（`{N} 秒内不回应，这一轮会按「拒绝」继续`，秒级取整；`left<=0` 时该句消失）。决定**自己 POST**，成败都收条。

| 浮层 | 形态 |
| --- | --- |
| 引用原文 / 产物与文件 | **右侧抽屉**（`sm:max-w-[min(720px,92vw)]`）；文件抽屉有面包屑、上一级、`truncated` 提示、内嵌预览、多选串行上传（逐条结果留抽屉里）、行可拖拽（自定义 MIME `application/x-kylab-file`） |
| 存进知识库 | **仍是居中弹窗**（故意：这一步要拦一下，不让服务端替用户挑库） |
| Toast | sonner，`top-center`，`closeButton`，语义化图标；**只有壳挂一个** |

### 2.9 过程面板（工具调用块）—— 详见 §5

---

## 3. 显示逻辑

### 3.1 四个页面态（互斥，顺序不可换）

1. `messages.length===0 && pendingEntry` → **骨架屏**（等待解析入口/回放）；
2. `welcome`（`messages.length===0 && !pendingEntry`）→ **欢迎层**；
3. 其余 → **消息列表**（按我们自己的消息数组遍历，`buildTurns` 配好轮次）。

### 3.2 两层状态（理解全部现象的前提）

| 层 | 位置 | 生命期 |
| --- | --- | --- |
| **live 状态** `LiveTurnState` | zustand 模块作用域，**全应用一格** | 不跟页面走：切页不丢、刷新靠锚点接回 |
| **messages 数组** | `ChatProvider` 的 `useState` | 跟页面走 |

四个"落法" `mode`：`append`（发送/重新生成，补一对气泡）/ `patch`（续跑，只改最后那条回答）/ `recover`（刷新重连，只补回答且**只有正文到了才补**）/ `command`（斜杠命令，**真有内容才建气泡**）。
"等待批准"**不是独立 mode**，是 streaming 期间的一个子状态。

### 3.3 一轮的完整生命周期

```
idle → send/regenerate/retry/useSample
     → streamTurn(): 先 setMessages 追加「提问 + 空 assistant{streaming:true}」(乐观渲染)
     → startChatTurn() → install(streaming:true)
streaming 期间：
   onStep      → steps 合并（过程面板长出一行）
   onSources   → sources 整份替换（出处徽标/摘要行出现）
   onThinking  → 带段号替换那段、不带则追加当前段
   onDelta     → text += delta（**经 pacer 节流后**）
   onApproval  → approval≠null → 后端停住，确认条出现
   onDone      → text = **整篇替换**，streaming=false
   onError     → error 留下，streaming=false
   onDropped   → 静默，排重连（800ms × ≤3 次）
   abortLiveTurn() → stopped=true, streaming=false
收尾：usageRefetch()；若 !stopped 再 detailRefetch()（按库重画）
```

### 3.4 九类 SSE 事件 → 状态与屏幕

| 事件 | 前端处理 | 节流 | 屏幕 |
| --- | --- | --- | --- |
| `step` | 追加/合并步骤，只转发后端真给了的键 | **否** | 过程面板长出一行；`status==='running'` 时标题那行变「正在{label}…」 |
| `sources` | 整份替换 | **是**（pacer 逐条亮出） | 出处列表 / 摘要行 / 正文徽标可点 |
| `thinking` | 带 `seq` = 新一段（先 flush 上一段） | 是（思考专用更快 pacer） | 思考正文逐字长出 |
| `delta` | `text += delta` | 是（主 pacer） | 正文逐字出；首字一到撤掉「正在生成…」 |
| `done` | **整篇替换** + `streaming=false, approval=null` | 排空后交付 | 停止键变回发送键；动作行、交付物这时才出现 |
| `error` | `error = message`，收口 | — | 回答气泡整块换错误块 + 重试/复制问题 |
| `command` | **不进 live 状态**，只落 `commandResult` | **否** | 输入框上沿一块等宽回话面板；`refill` 非空时回填并抢焦点 |
| `approval` | `approval = {...}` | **零节流**（后端已停住） | 审批条出现在输入卡片上沿 |
| `ping` | **到不了前端**（后端发 `event: ping` 无 `data:` 行，前端只认 `data:`） | — | 无 |

### 3.5 可见性门控总表

| 元件 | 显示条件 |
| --- | --- |
| 会话抬头 / 项目名 | 有标题 / `workspace_id` 能查到名字 |
| 「思考关」小片 | `!chat.thinkingOn` |
| 权限胶囊 | 管理员 **且** `chat.permission` 读到了值 |
| 知识库筛选框 | 库数 > 8 |
| 未选知识库警示 | 开着知识库 + 有库 + 一个都没选 |
| 「正在上传…」 | `chat.uploading` |
| 发送键 ↔ 停止键 | `chat.sending = live.streaming && live.conversationId === conversationId` |
| 回到最新浮标 | `messages.length>0` 且未贴底 |
| 交付物 | 有产物 **且** `!message.streaming` |
| 动作行 | `!message.streaming`；「重新生成」还要最后一轮且 `!sending` |
| 重试（失败） | `!chat.sending`（每一条失败轮都给） |
| 继续/重试（降级） | 最后一轮且 `!chat.sending` |
| 代码块展开键 | 量出来真的溢出（>400px） |
| 步骤展开键 | `args \|\| result` 有值 |
| 分页「加载更多」 | `view.hidden > 0` |
| 出处折叠 | `sources.length > 3` |

### 3.6 失败文案口径

`failureText`（`turns.ts:347-366`）只做**一件**翻译：把浏览器那串英文（`Failed to fetch` / `Load failed` / `NetworkError…` / `ERR_NETWORK` 等 8 个标记）翻成「网络没连上（这条请求没有发出去）」；其余**一个字都不改**，直接用后端写好的中文；空错误体给「没有拿到失败原因」。
后端更硬（`services/failures.py`）：**只从写死的句子里挑**，`str(exc)` / `exc.detail` 一次都不出现，异常原文只进日志——理由是"过滤总有漏的，异常文本可以是任意内容"。分层：先按 HTTP 状态 → 再按 `reason` → 兜底一句笼统话。

### 3.7 三个"重来"的语义差别（极易混淆，代码里刻意分开）

| 动作 | 实现 | 对库的影响 | 给谁 |
| --- | --- | --- | --- |
| 重试（失败气泡） | `retryTurn` | **不回退**（失败这轮从没落库）；但会把这轮**之后已落库**的轮次一起撤掉 | 每一条失败轮 |
| 重新生成 | `rewindConversation(id,1)` → 再流 | 回退一轮 | 仅最后一轮 |
| 继续（降级） | `startResumeTurn`（mode `patch`） | 改的是**同一条回答** | 仅最后一轮 |

输入框**不回填**（刻意的，避免同一句有两个入口）；只有 `/rewind` 这类**真把提问删掉了**的命令才 `refill` 回填。

### 3.8 乐观渲染的真实机制

**没有 id 级 reconcile——是整数组替换**。本地 id 是模块级自增计数器（`m1, m2…`），一轮收尾后 `detailRefetch()` 把服务端那份**整份覆盖**上来。`createdEntryRef` + `appliedDetail` 两道闸的意义：新会话地址从 `/chat?new=1` 变成 `/chat/<id>` 时，不被"清空 + 空详情覆盖"各擦一次。

### 3.9 键盘与快捷键

- **`isComposing` 是总闸**（`Composer.tsx:272`）：合成态一律不算按键，`/`、`@`、发送三条路一起被覆盖。
- 菜单开着时 ↑↓ / 回车 / Esc 归菜单；**一条都没匹配上时回车不吃**，落到发送。
- 菜单都关着时交给快捷键注册表（`kylab-shortcuts`，与 misc 域共用键名）；**未命中绑定的键一律不拦截**（这正是"把发送键改成 Ctrl+回车后，单独回车仍能换行"的原因）。
- 四条键：`chat.send`(Enter / Mod+Enter)、`chat.newline`(Shift+Enter)、`chat.new`(Mod+K)、`layout.toggleSidebar`(Mod+B)。冲突按命令表顺序取第一个命中。

### 3.10 三条与后端同值的上限

单次提问 **32,000 字**（前端先拦并给"该怎么办"的话，而不是等 422）；单文件 **200 MB**（前端预校验，超限的不加进来并逐份说明）；拒绝理由 **500 字**。

---

## 4. 动效全量

### 4.1 基础设施

**两档令牌 + 三个特例**（`tokens.css:429-450`）：

| 令牌 | 取值 | 用在哪 |
| --- | --- | --- |
| `--motion-fast` `.15s` + `--motion-ease` `ease` + `--transition-ui` | `background-color/color/box-shadow .15s ease` | 状态过渡：悬停、聚焦、选中、展开箭头 |
| `--motion-slow` `.3s` + `--motion-ease-inout` `ease-in-out` + `--transition-surface` | 上述四元组 `.3s ease-in-out` | 按钮类"有体量"的东西 |
| `--motion-send` | `cubic-bezier(.4,0,.2,1)` | **全仓 0 引用（死令牌）** |

**Tailwind v4**：CSS-first，无 `tailwind.config.*` / `postcss.config.*` / `components.json`。裸 `transition-*` 默认 **150ms + `cubic-bezier(.4,0,.2,1)`**；`animate-pulse` = 2s `cubic-bezier(.4,0,.6,1) infinite`；`animate-spin` = 1s linear infinite。
**产物级实测**：`--ease-in-out:cubic-bezier(.4, 0, .2, 1)` —— **Tailwind 的 `ease-in-out` 不是 CSS 关键字 `ease-in-out`**（后者是 `cubic-bezier(.42,0,.58,1)`）。而 `tokens.css:438` 的 `--motion-ease-inout: ease-in-out` 是关键字。**两条不同的曲线共用一个名字**，抽屉的 500/300ms 走的是 Tailwind 那条。

**tw-animate-css 1.4.0**：`animate-in` / `animate-out` = `enter`/`exit` 关键帧，**未写 `duration-*` 时默认 150ms / `ease` / `fill-mode: none`**；`fade-in-0`、`zoom-in-95`、`slide-in-from-*-2`（=∓8px）都是往 CSS 变量里写值。
产物里**只有 `enter` / `exit` / `pulse` 三个 keyframes** ⇒ `caret-blink`、`accordion-*`、`collapsible-*` 都被 tree-shake 掉了 ⇒ **本产品没有闪烁光标、没有 typing dots**。

**sonner 2.0.8**（toast）：`transform/opacity/height 400ms`、`box-shadow 200ms`、入场（transition，非 keyframes）400ms、退场 400ms、滑动关闭 200ms、自动消失 4000ms；**库自带 `prefers-reduced-motion` 兜底**（`styles.css:708-715`）。

**`chat.css` 里 0 个 `@keyframes`**；对话域唯一由关键帧驱动的动画是「正在生成…」的 `animate-pulse`。

### 4.2 逐处清单（对话域及其浮层）

| # | 元素 | 触发 | 机制 | 时长/缓动 |
| --- | --- | --- | --- | --- |
| 1 | 用户气泡复制键 | hover / focus / 已复制 | `opacity-0 → group-hover:opacity-100` + `[transition:opacity_…]` `MessageView.tsx:50` | 150ms ease |
| 2 | 用户附件片 | hover | `transition-colors` `MessageView.tsx:75` | 150ms，`cubic-bezier(.4,0,.2,1)` |
| 3 | 过程面板三个箭头 | 开合 | `caretClass` → `[transition:transform_…]` + `rotate-180` `traceStyles.ts:85-89` | 150ms ease |
| 4 | 步骤标签 / 「思考」/「思考过程」 | hover | `[transition:var(--transition-ui)]` | 150ms ease |
| 5 | 子行展开箭头 18×18 | hover | `[transition:var(--transition-ui)]` `TraceStepRow.tsx:232` | 150ms ease |
| 6 | 「加载更多」「看全文」「收起出处」 | hover | `[transition:var(--transition-ui)]` + `hover:underline` | 150ms ease（**下划线不参与过渡**） |
| 7 | **出处行「闪一下」** | 点正文 `[n]` | `bg-[var(--accent-soft)]` + `[transition:var(--transition-surface)]` `TracePanel.tsx:131-133` | **底色 300ms ease-in-out**；1400ms 后清 |
| 8 | 滚到那一条出处 | 同上 | `scrollIntoView({block:'center', behavior:'smooth'})` `ChatProvider.tsx:1674` | 浏览器平滑滚动 |
| 9 | **流式实时行 `LiveLine`** | 每次变化 | `[scroll-behavior:smooth]` + 直接 `scrollLeft = scrollWidth`；左侧 28px `mask-image` 淡出 `TracePanel.tsx:309-328` | 零计时器、零动画库 |
| 10 | **「正在生成…」** | 流式中且正文为空 | `animate-pulse` + `motion-reduce:animate-none` `AnswerText.tsx:106` | 2s，opacity 1↔0.5 |
| 11 | 代码块头部图标键 | hover | `transition: var(--transition-ui)` `chat.css:302` | 150ms ease |
| 12 | 代码块展开/收起 | 点键 | **瞬时**（内联 `maxHeight` 切换）`markdown.tsx:957` | **0** |
| 13 | 行内引用徽标 | hover | 直接切 color/bg，无 transition `chat.css:230-237` | **0** |
| 14 | 不可点徽标（联网编号） | hover | **刻意零变化** `chat.css:257-261` | 无 |
| 15 | 发送 ↔ 停止 | 状态切换 | `[transition:var(--transition-ui)]`；**同一元素同一位置** | 150ms；切换无位移 |
| 16 | 附件移除键 | hover | `transition-colors` | 150ms |
| 17 | 输入框自增高 | 内容变化 | 直接设 `height` | **0（瞬时，跟手）** |
| 18 | **回到最新浮标** | 离底/贴底 | `disabled:hidden`；点击 = `behavior:undefined` → **瞬时跳** | **0** |
| 19 | 审批条 / 命令回话 / 拖拽提示 | 状态出现 | 条件渲染 | **无进出场** |
| 20 | **`/` 与 `@` 菜单** | 输入 `/` 或 `@` | `PANEL` 类里**没有任何 `animate-*`** | **瞬时** |
| 21 | **四颗下拉菜单** | 点触发器 | 直连 Radix，`className = MENU_PANEL`（无 animate 类） | **无进出场** |
| 22 | 知识库开关轨道 | 开关 | `transition-colors [transition:var(--transition-ui)]` | 150ms ease（`border-color` **不在**列表） |
| 23 | **知识库开关滑块** | 开关 | `transition-all` **被** `[transition:var(--transition-ui)]` **覆盖**，后者不含 `left` | **0（跳位，见 §6）** |
| 24 | 模型浮层里的「思考」开关 | 开关 | `transition-colors` / `transition-transform` + `translate-x-[16px]` | 150ms，Tailwind 默认曲线（**会滑**） |
| 25 | **上下文环** | 比率变化 | `strokeDashoffset` 直接算，**无过渡** | **0** |
| 26 | 强度三档分段 | 选中 | 无 transition | 0 |
| 27 | **两个抽屉** | 开 / 关 | `animate-in duration-500` / `animate-out duration-300` + `slide-*-right`；遮罩 `fade-*-0` 默认 150ms | **开 500 / 关 300**；遮罩 150 |
| 28 | 抽屉关闭走位 | 关 | 先播退场动画，`LEAVE_MS=300` 后才通知宿主卸载 | 300ms |
| 29 | 存进知识库弹窗 | 开 / 关 | 遮罩 150ms；内容 `duration-200` + `fade + zoom 1↔0.95` | 200ms |
| 30 | Toast | 出现/堆叠/滑关 | sonner 自带 | 入出 400ms |
| 31 | 滚动条 | 滚动 / 移入窄带 | chat 视口用**全局常显**细胶囊；`scroll-quiet`（亮起后停手 1200ms 灭）只用在侧栏 | 切换无过渡 |
| 32 | **滚动跟随（贴底）** | 流式内容增长 | 全部交给 assistant-ui；chat 域**没有任何自定义滚动代码** | 见 §4.4 |
| 33 | 菜单键盘高亮滚动 | ↑↓ | `scrollIntoView({block:'nearest'})` | 浏览器默认（瞬时） |

### 4.3 流式"打字机"——三只显示节拍器（真正的动效来源）

| 参数 | 值 | 来源 |
| --- | --- | --- |
| 心跳 | **24ms ≈ 40fps**（`setTimeout` 而非 rAF：后台标签页 rAF 会被完全暂停） | `pacer.ts:81` |
| 起步速度 | 正文 **40 字/秒** | `pacer.ts:70` |
| 速度上限 | 正文 **600 字/秒**（2000 字约 3.3 秒放完） | `pacer.ts:75` |
| 追赶时长 | **0.9s**：`rate = clamp(积压/0.9, 40, 600)` | `pacer.ts:77` |
| 来源逐条亮出 | **110ms/条**（前缀式回调，每次给累计前 N 条） | `pacer.ts:79` |
| 结尾快照 | 剩余 **≤10 字**一次吐完 | `pacer.ts:83,165-168` |
| 后台追赶 | 每拍 `dt` 上限 **250ms**（切回来是"快放一会儿"） | `pacer.ts:152` |
| 思考专用节拍器 | **120 / 3000 / 0.4s** | `api/chat.ts:763-768` |
| 重连补发 | **不套节流**（`{smooth:false}`，`liveTurn.ts:637-643`）——刷新后那一批是一次到齐的 | 源码级 |
| 收尾/报错/停止 | `flush()` 把已收未显示的字**全部亮完**（不丢字） | `api/chat.ts:770-775` |

**这一层没有 `prefers-reduced-motion` 判断**——这是本 UI 最大的持续动效。

### 4.4 滚动：本仓一行算法都没写

`ChatThread.tsx:84` 的 `ThreadPrimitive.Viewport` **没有传 `autoScroll`，也没有传 `turnAnchor`** ⇒ 上游默认 `autoScroll = turnAnchor !== 'top'` = **true**。

| 行为 | 上游机制 | 值 |
| --- | --- | --- |
| 「贴底」判据 | `isViewportAtBottom` | `abs(scrollHeight-scrollTop-clientHeight) <= 1`（**1px 容差**）或 `scrollHeight <= clientHeight` |
| 「内容溢出」 | `viewportOverflows` | `scrollHeight > clientHeight + 1` |
| 「用户上翻」 | `isUserScrollUp` | `prev.scrollTop > cur.scrollTop` **且 `prev.scrollHeight === cur.scrollHeight`**——后半句把"内容自己变长"排除掉，否则流式每来一个字都会被误判成用户想往上翻 |
| 内容变高 | `useOnResizeContent` | `autoScroll && followBottomRef` → `scrollToBottom("instant")` |
| 新的一轮开始 | `thread.runStart` | `scheduleScrollToBottom("auto")` |
| 初始化 / 切会话 | — | `"instant"` |
| 用户上翻 | — | 取消挂起帧、`followBottomRef=false`（从此不抢） |
| 调度 | — | `requestAnimationFrame`（可取消） |

**裁定**：`behavior:"auto"` 的含义是"用该元素 computed 的 `scroll-behavior`"，而**全仓没有给对话视口设过 `scroll-behavior: smooth`**（唯一的 `scroll-behavior:smooth` 在 `LiveLine` 那个 span 上）⇒ **对话页所有视口滚动都是瞬时的**；「回到最新」因为 `Composer` 没传 `behavior` prop，也是**跳**过去而不是滑过去。

### 4.5 时长/缓动汇总与不一致点

**出现过的时长**：24ms（节拍）· 110ms（来源间隔）· 150ms（状态过渡 / bare transition / tw-animate 默认 / 遮罩）· 200ms（弹窗本体）· 300ms（`--transition-surface` / 抽屉退场 / 抽屉走位 / 侧栏宽度）· 400ms（sonner）· 500ms（抽屉进场）· 800ms（重连延时）· 1200ms（滚动条滞留）· 1400ms（出处闪一下清除）· 1600ms（「已复制」回退）· 1.6s / 2s（两种骨架）· 4s（toast 自动消失）· 15s（后端 ping）。

**十处不一致**：

1. **遮罩与本体不同步**：dialog 150 vs 200；sheet 150 vs 开 500 / 关 300。
2. **滑出/滑入不对称**：抽屉关比开快 40%，且 `Sheets.tsx:60` 的 `LEAVE_MS=300` 与之硬耦合（改一处要同步改另一处）。
3. **骨架屏三种行为**：chat 静止 / 壳 pulse 2s / 挂载前 1.6s，底色还各不相同。
4. **同类折叠交互三种速度**：箭头 150ms、代码块展开 0、思考块展开 0。
5. **同一文件两个开关两种行为**：知识库那颗滑块**跳位**，模型浮层那颗**滑动**（见 §6）。
6. **悬停反馈有/无 transition 混杂**：有的走 `--transition-ui`，有的完全裸切（失败气泡的动作行、审批条三键、拖拽提示、抽屉内多处、菜单高亮）。
7. **`transition` 属性列表漏项造成"半动画"**：欢迎态卡片 hover 时 `border-color` 瞬变、底色/字色渐变。
8. **菜单弹出观感两极**：`.md-icon-btn`、步骤箭头老老实实 150ms；四颗下拉菜单与 `/`、`@` **完全没有进出场**。
9. **`--motion-send` 定义了但无人引用**（发送键用的是 `--transition-ui`）。
10. **`ease-in-out` 一词两义**：令牌是 CSS 关键字，Tailwind 工具类是 `cubic-bezier(.4,0,.2,1)`，注释里被当作同一个"四元组"。

### 4.6 `prefers-reduced-motion` 覆盖盘点

| 位置 | 覆盖 | 在对话域？ |
| --- | --- | --- |
| `layout.css:205-211 / 290-298` | 侧栏折叠过渡、5 个导航图标悬停动画 | 否 |
| `misc.css:247-251` | `.m-dot-live` 脉动点 | 否 |
| `knowledge.css:238`、`notes.css:912/935/1112` | 各自页面 | 否 |
| `index.html:104-108` | 挂载前骨架 | 否 |
| `App.tsx:148-156` | 启动骨架 pulse | 否（同屏壳） |
| sonner 库内 | toast 全部 | 是（库自带） |
| **`AnswerText.tsx:106`** | 「正在生成…」脉冲 | **是（对话域唯一一处）** |
| ❌ **pacer 逐字流** | — | **无** |
| ❌ `animate-in/out`（弹窗 200ms、抽屉 500/300ms） | — | **无** |
| ❌ 两处 smooth 滚动（`ChatProvider.tsx:1674`、`TracePanel.tsx:322`） | — | **无** |
| ❌ 全部 150/300ms 过渡与箭头旋转 | — | **无** |

⇒ **对话域是唯一"基本没做"的域。**

---

## 5. 工具调用块专项（本次审计的重点）

### 5.1 现状：一行一步 + 同类合并 + 三级开合

结构（`TracePanel.tsx` + `TraceStepRow.tsx` + `traceStyles.ts`）：

| 槽位 | 内容与判据 |
| --- | --- |
| **面板头** | **它同时是开合开关**。流式中 → `LiveLine`（单行实时状态）；非流式**且有出处** → 「检索完成 · 引用了 N 个片段 · M 篇文档」；**两者都不是 → 只剩一个孤立箭头** |
| 图标 | 单独一步 = 21×21 圆底，配色按语义种类；组内子行 = 5px 圆点 |
| 标签 | 有 `args\|result` → 可点按钮（标签 + 12px 箭头）；无 → 纯文本 |
| 结论行 | `step.detail`（12px 三级灰，独占一行）；**原始 JSON 不印**（正则挡掉） |
| 这一步的思考 | 「思考」+ `N 字` + 箭头 |
| 入参 | 「入参」+ `<pre>`（`art_*` key 缀上真实文件名） |
| 返回 | 「返回」+ 预览（默认 **600 字**）+「仅预览 X / Y 字」+「加载全部（Y 字）」 |
| 分页 | 20 条目/页 + 「当前已显示 X / Y 条工具调用」+「加载更多」 |
| 出处 | 默认铺 3 条，其余折成「还有 N 条出处」 |

**图标与配色映射**（`tool_meta.kind_of` 给的语义种类）：

| kind | 图标 | 配色 |
| --- | --- | --- |
| `read` | FileText | **不着色** |
| `search` | Search | 信息蓝 |
| `write` | Pencil | 绿 |
| `delete` | Trash | 红 |
| `exec` | SquareCode | 橙 |
| `skill` | ListChecks | 紫 |
| `session` | Sparkles | 品牌蓝 |
| `message` | MessageSquare | 信息蓝 |
| `tool`（外部 MCP） | Server | **不着色** |
| `think` / `build` | Bot / Check | 不着色 |

**分组规则**（`turns.ts:639-659, 746-784`）：① 只并**同一个块**内的（非工具步是分界）；② 块内按 `group`（新数据=工具名，老快照=中文标签）分组、按首次出现排序；③ **只有一次的不并**。组行 = 标签 + `N 次` + 箭头。
**分页口径**：切的是**条目**、报的是**调用**（一组算它里面那几次）。

### 5.2 开合默认值全表（这是用户最关心的部分）

| 层级 | 默认值 | 依据 | 用户覆盖 | 持久化 |
| --- | --- | --- | --- | --- |
| **面板级** | **展开** | `isTraceOpen` fallback = true | 点标题即切 | **全局记忆**（localStorage `kylab-trace-open`）+ 本轮 override；点一次同时写两处 |
| **组级** | **收起** | `openGroups` 初值空集 | 点组行 | 无（换会话清空） |
| **单步（原文）** | **收起**，但**被拦下/等确认的行默认展开** | `userChose ?? (hostOpen \|\| refusal)`；`refusal` 优先看结构化 `outcome`（`blocked`/`awaiting`），老快照回退词表 | 点标签/箭头 | 无（**且 key 跨轮串号，见 §6**） |
| **单步的思考** | **跟流式状态走**：干活时摊开、**答完自动收起** | `thinkingChose ?? streaming` | 点「思考」 | 无（只活在本次渲染） |
| **整轮思考（老消息兜底）** | **收起** | `useState(false)` | 点「思考过程」 | 无 |
| **出处列表** | 铺 3 条 | `CITE_FOLD_LIMIT=3` | 点「还有 N 条」 | 无；点正文徽标会**自动展开** |

### 5.3 现状下可指认的六个问题

1. **面板默认展开 + 位于正文上方** ⇒ 长任务时过程把答案推到首屏之外。用户必须先滚过一屏"联网搜索 18 次"才读到答案。（该走查早已记录过同一现象：`docs/产品走查-2026-09-28/走查报告-2026-09-28.md` §五 第 3 条）
2. **组级默认收起 ⇒ 第一眼"零信息"**：用户看到的是「联网搜索 18 次」，但 18 次搜到了什么、花了多久，一个字都没有；而同一面板里 `导出幻灯`、`组织回答` 这类**单步**却直接铺出结论——**同一块里两种密度**。
3. **面板头在"无出处"时只剩一个孤立箭头**（见用户截图里最上面那个 `^`）——它是开合开关，但看起来像一枚残留符号。
4. **running 与 done 行内零差别**：`TraceStep` **没有 `status` 字段**（`turns.ts:839-866` 不映射它，`TraceStepRow` 也从不读），唯一的"还在跑"信号是面板头那行实时文案；**全对话域没有 spinner**。
5. **没有耗时、没有 token 数**：面板里没有任何计时/计数代码（上下文 token 只在输入卡片的模型浮层里）。用户无法回答"这一步卡了多久"。
6. **没有"全部展开/全部收起"**；组级与单步级开合都不持久化；**且单步开合会跨轮串号**。

### 5.4 与截图一致性的说明

用户提供的截图（`读技能 2 次` / `联网搜索 18 次` / `抓取网页 3 次` / `导出幻灯` + `已生成「…pptx」（40 KB）` / `思考 3,329 字` / `组织回答` + `共 714 字`）与上面的规则**完全一致**：三个组收起、两个单步展开、`思考` 是 `导出幻灯` 那一步自己的推理（因为它排在 `导出幻灯` 的结论下面、`组织回答` 上面），面板整体展开。截图中"面板头只看得到一枚箭头"也对应 §5.3 第 3 条。

> 下一步的对标调研另见《[工具调用 UI 对标调研 v0.1](工具调用UI-对标调研-v0.1.md)》（Cline / Roo Code / Cherry Studio / LobeChat / Coze Studio / WeKnora / MaxKB / Qwen Code / Kimi CLI / OpenHands，以及 Trae / Qoder 的公开证据）。

---

## 6. 缺陷与死代码清单

### 6.1 真缺陷（建议优先修）

| # | 问题 | 证据 | 影响 |
| --- | --- | --- | --- |
| 1 | **单步展开态跨轮次串号** | key = `${step.phase}-${index}`（`turns.ts:844`），而 `openSteps` 是**全局一个 Set**、`isStepOpen: key => openSteps.has(key)`（`ChatProvider.tsx:2060`）——key 里没有轮次命名空间；组 key 由 `group[0].key` 组成（`turns.ts:769`）同样会撞 | 长会话里点开第 5 轮的 `tool-3`，第 2 轮的 `tool-3` 一起展开 |
| 2 | **未知 SSE 事件类型落进 error 分支** | `api/chat.ts:861-876`：`delivered = true; if (type==='done') … else onError(event.message)`，而 6 类事件都在前面 `return` 掉了 | 后端将来新增任何带 `data:` 的事件类型，都会被当 error 处理（`message` 为 `undefined`）。后端 `ping` 之所以不带 `data:` 行正是为了绕开它 |
| 3 | **前向兼容的静默失败** | 同上 | 新增事件类型不会报"未知类型"，而是安静地走错误路径 |
| 4 | **抽屉在 300ms 窗口内不可重开** | `Sheets.tsx:88-120`：`closing` 锁 + `shouldOpen` 已在 true 时不再触发 | 点另一条引用"没反应" |
| 5 | **知识库开关滑块不滑动** | `ComposerControls.tsx:286` 的 `transition-all` 被 `[transition:var(--transition-ui)]` 覆盖，而后者不含 `left`；**产物级验证**：`.transition-all{` 在构建产物中出现在该任意属性**之前**（顺序敏感正则实测），同级特异性下后者胜 | 与同文件 `:70` 那颗开关行为不一致（那颗会滑） |
| 6 | **`MarkdownPre` 的溢出测量只依赖 `[codeText]`** | `markdown.tsx:896-900` | 调字号或改窗口宽度后不重测，"展开代码"该出现时不出现（或反之） |
| 7 | **工具标记兜底分支吞掉整条 Markdown** | `MessageView.tsx:207-219` | 老消息里同含 `<tool_call>` 与 `[1]` 时，引用徽标与代码块按钮全都点不了 |
| 8 | **记忆类步骤被整段隐藏** | `turns.ts:828-842` | `read_memory`/`write_memory`/`remember`/「记住」不进面板，**连带它们那一步的推理一起消失**（若是有意的，应在文档里写明） |

### 6.2 显示缺口

| # | 问题 | 证据 |
| --- | --- | --- |
| 9 | 模型胶囊禁用态与可用态**视觉无差别** | `CONTROL_TRIGGER` 无任何 `disabled:` 类（`DropdownShell.tsx:28-31`），而 `ModelPicker` 在 `models.length===0` 时置 `disabled` |
| 10 | 知识库胶囊**展开时不变色** | `data-[state=open]:bg-…` 挂在最外层 `<span>` 上，而 Radix 的 `data-state` 落在内层 `Trigger` 上（`ComposerControls.tsx:269,292`） |
| 11 | 无出处时面板头只剩孤立箭头 | `TracePanel.tsx:216-223` |
| 12 | 长内容下计数带千分位逗号 | `formatCount` → 「1,000 字 / 1,000 次」 |
| 13 | running/done 行内无区别、全程无 spinner | `turns.ts:839-866` |

### 6.3 死代码 / 未用声明

| 项 | 证据 |
| --- | --- |
| **`--motion-send`** 定义后 0 引用 | `tokens.css:441` |
| **`--chat-input-radius`** 定义后 0 引用 | `tokens.css:390` |
| **`ChatModeView` / `getChatMode` / `setChatMode`** 无生产消费者 | `api/settings.ts:75-97` |
| **`kylab:mode-changed`** 广播零监听者 | `ChatProvider.tsx:1190` |
| `commandsLoading` / `modelsLoaded` / `mentionToken` 三个 props 无外部消费者 | `ChatProvider.tsx:300,314,317` |
| **`renderAnswerMarkdown` / `renderAnswerWithCitations` / `renderPlainMarkdown` 与整个 `plain` 分支**在生产零调用（只有测试用）；`FilePreview.tsx:12` 的表格写着用它，实现（`:107`）却自己写了一份 `ReactMarkdown + remarkGfm` | `markdown.tsx:1270-1290`、`PLAIN_COMPONENTS:1083` |
| `data-running` 无任何 CSS 消费者（仅测试用） | `ChatThread.tsx:79` |
| **`ui/drawer.tsx`（vaul 1.1.2）全仓无引用**（只在 `sheet.tsx:14` 注释里被提到） | 源级 |
| `TraceStep.artifacts` 在面板里未被使用（只服务交付物） | `turns.ts:135,862` |
| 知识库面板**以一条分隔线开头**（原「启用」行搬走后的残留） | `ComposerControls.tsx:314` |
| 菜单外层包裹 div 的类名不起作用（子元素全 `absolute`，基准是最外层 `relative`） | `Composer.tsx:485,560` |
| `transition-transform`（`caretClass`）、`transition-colors`（`TracePanel:131`）、`transition-opacity`（`MessageView:50`）都是**被任意属性覆盖的死声明**（行为无损失） | 产物级 |
| 上游 `--animate-accordion-*` / `--animate-collapsible-*` / `--animate-caret-blink` 被 tree-shake 掉 | 产物级 |

### 6.4 文档漂移

| 声明 | 实际 |
| --- | --- |
| `ChatProvider.tsx:222-223`：「欢迎层与输入卡片作为一组居中」 | 输入卡片**永远贴底**，只有欢迎层居中 |
| `ChatThread.tsx:87` 引用旧类名 `.chat-centered` | React 版已不存在 |
| `SideNav.tsx:405-408`：「对话页还挂着临时实现（ChatProvider 里那段监听）」 | 那段已删除 |
| `stepIcons.tsx:9`：「配色在 `.step-kind-*`」 | 没有这类名（实际是 `KIND_ICON` Tailwind 表） |
| `traceStyles.ts:41-45`：「圆心正落在时间轴那条竖线上」 | React 版**没有**那条竖线元素 |
| `model/README.md:111-112`：重连常量导出后「用例与页面可以据此显示"重连中"」 | **没有任何"重连中"状态**（能力有了、界面没接） |
| `runtime/README.md`（1438 行）被当作状态机说明 | 它整篇是 **assistant-ui 契约文档**，grep `onSeq\|adoptHandlers\|pacer\|环形缓冲` 零命中 |
| `tests/chat-ui.test.tsx:1037` 用例名「收成三颗：+ / 知识库 / 模型」 | 用例体已按**四格 + 条件权限颗**断言 |
| `tests/chat-ui.test.tsx:1108` 用例名「压缩阈值说的是**百分比**」 | 断言查的是 `到 17,920 tokens 会自动压缩` |

---

## 7. 复核记录（本审计的可信度说明）

本次审计由五路并行深挖 + 主控复核构成。主控对**每条高影响结论**回源核对，结果如下——**包括把错的改过来**：

| 被复核的结论 | 裁决 |
| --- | --- |
| 「KaTeX 的 CSS 在本仓没被 import，公式排版会塌」 | ❌ **证伪**。`main.tsx:13` 就是 `import 'katex/dist/katex.min.css'` |
| 「`sourceWhere` 会渲染 `第 undefined 页`（用户可见 bug）」 | ⚠️ **降级**。[turns.ts:983] 只判 `page !== null`，[Sheets.tsx:217] 判 null+undefined——两份实现确实不一致，但 `ChatSource = Required<…>` 让 `page` 在类型上必然存在，只有"历史快照整份缺键"才触发。**是潜在不一致，不是已确认可复现的 bug** |
| 「runStart 的滚动是平滑的」 | ❌ **改判为瞬时**。`behavior:"auto"` 取元素 `scroll-behavior`，而全仓没给视口设过 `smooth`；「回到最新」同理是**跳** |
| 「知识库开关滑块 150ms 动 `left`」（**主控初版报告的结论**） | ❌ **本审计更正**：任意属性覆盖了 `transition-all`，`left` 不在过渡属性里 ⇒ **滑块跳位**。用顺序敏感正则在构建产物上验证：`.transition-all{` 在该任意属性之前出现，反向不成立 |
| assistant-ui 的自动滚动阈值、`isAtBottom → return null` | ✅ **逐条对上游源码验证**：1px 容差、`isUserScrollUp` 要求 `scrollHeight` 不变、`return null` → `disabled` |
| `{smooth:false}` 用于重连补发 | ✅ 源码验证（`liveTurn.ts:637-643`） |
| `--motion-send` 0 引用、`data-running` 无消费者、`@/ui/drawer` 无引用、chat 不用 `@/ui/dropdown-menu` | ✅ grep 验证 |

**仍未独立复核**（保留为深挖结论）：`services/failures.py` 的后端文案分档细节、后端环形缓冲参数（240 事件 / 16 会话 / 600s）、若干测试文件的具体断言条数。

---

## 8. 测试锚点（回归防线在哪）

| 主题 | 位置 |
| --- | --- |
| 对话流、过程面板出步骤 | `tests/chat-ui.test.tsx:283-317` |
| 图标按 kind、同类工具并成一行 + 次数 | `:596-650` |
| 出处默认 3 条 / 展开 / 看全文就地 | `:1172-1209` |
| 交付物四件事（存库/下载/预览直落/去重） | `:1211-1385` |
| 失败轮：原因 / 重试不回退 / 复制问题 | `:1546-1626, 2039-2097` |
| 降级：原因原样 + 继续/重试 | `:902-927` |
| 工具标记不当回答渲染 | `:929-945` |
| 「回到最新」贴底不出现（`disabled:hidden`） | `:961-973` |
| 布局红线：`flex-1 + min-h-0`、卡片常驻 | `:988-1003` |
| 控制行成员与 DOM 次序（硬断言） | `:1005-1073` |
| 上下文环几何 | `:1075-1106` |
| 合成态回车不选菜单项 | `:1969-2009` |
| 首字之前「正在生成…」 | `:2012-2037` |
| 用户随发附件（新发 + 回看） | `:1868-1927` |
| markdown 规则 73 条 | `tests/chat-model-markdown.test.ts:52-876` |
| 分页/计数/预览、分组/hidden/图标/老快照兜底、liveLine/traceSummary、收起态记忆、每步思考 vs 整轮兜底 | `tests/chat-model-turns.test.ts:390-446, 594-796, 106-179, 351-371, 926-984` |
| onSeq 缺陷（停止键卡住）、断线接回、跨会话串字 | `tests/chat-model-live-turn.test.ts:316-341, 343-382, 461-508` |
| 锚点顺序、节流、onDropped vs onError | `tests/api-chat.test.ts:396-424, 284-318, 484-524` |
| 拖拽 / 粘贴 / 上传上限 | `tests/chat-paste-upload.test.tsx:296-445` |
| 两个抽屉（先滑回再通知宿主、打开时取数、子目录、截断提示） | `tests/chat-drawers.test.tsx:188-582` |
| 快捷键（默认 / 改键 / 冲突） | `tests/chat-shortcuts.test.tsx:234-299` |

---

## 9. 与既有文档的关系

- `docs/规范/前端设计规范-v0.14.md` §5 定义的**两档动效 + 三类豁免**，本文 §4 逐处核对了落实情况，并列出十处口径不一致——**规范本身没有被违反的地方，问题在于"规范没覆盖到的地方各写各的"**（菜单进出场、折叠动画、数值收敛）。
- `docs/产品走查-2026-09-28/走查报告-2026-09-28.md` §五「布局与动效专项小结」记录了"过程面板与正文同列上下堆叠，长任务时正文被推到首屏之外"与「流式单次最大跳变 113px」。本文 §5.3 把前者细化为**六个可指认的问题**，后者仍未处理（建议给 `img/table/pre` 预留 `min-height` 或用 `content-visibility`）。
- `docs/调研/Agent-与对话架构对标调研-v0.1.md` 是 agent 架构层的对标；本文是**界面层**的审计，两者互补。

---

**审计结论一句话**：显示逻辑本身是**清晰且被测试钉住**的（门控、失败文案、乐观渲染、重试语义都站得住）；真正薄弱的是**动效的两端**——一端是"该动的地方不动"（菜单、折叠、环、滑块、回到最新），另一端是"该克制的没克制"（pacer 逐字流无 reduced-motion），而**工具调用块的开合默认值与信息密度**是用户感知最强的短板。
