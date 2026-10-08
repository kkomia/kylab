# 对话页的纯逻辑层（`features/chat/model`）

React 迁移 P1 的"对话页逻辑层"。四个模块逐一对应旧 Vue 的四个 composable，
**行为、边界与注释里的"为什么"照搬**（见 `docs/计划与记录/React-迁移计划-v0.1.md` §2）：

| 这里           | 旧实现（`frontend/src/`）               | 换掉的那一层                                                                                   |
| -------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `turns.ts`     | `composables/useChatTurns.ts`（832 行） | 无（纯函数，逐字搬）                                                                           |
| `liveTurn.ts`  | `composables/useLiveTurn.ts`（586 行）  | Vue `ref` → **zustand store**                                                                  |
| `markdown.tsx` | `composables/useMarkdown.ts`（580 行）  | 自研块级解析 → **react-markdown + remark-gfm + remark-math + rehype-katex + rehype-highlight** |
| `latex.ts`     | `composables/useLatex.ts`（290 行）     | Unicode 手写映射 → 同规则 + **KaTeX**（`katex.renderToString`）                                |

用例：`tests/chat-model-{turns,live-turn,markdown,latex}.test.ts`，旧用例的功能点一条不丢
（详见文末"旧 → 新"表）。

---

## 1. 渲染回答：用哪个出口

三个名字与旧实现一致的函数，加一个组件（`AnswerMarkdown` 是 `Answer` 的别名，
给 `ui/AnswerText.tsx` 的运行时取键用）：

```tsx
import {
  Answer,
  renderAnswerMarkdown,
  renderAnswerWithCitations,
  renderPlainMarkdown,
} from '@/features/chat/model'

// ① 推荐：组件形态
;<div className="reply-text">
  <Answer
    text={message.text}
    sources={message.sources}
    onOpenSource={(index) => revealSource(index)} // 点行内徽标 [n]
    onCopyCode={(code) => copy(code)} // 代码块上的复制
    onCopyTable={(tsv) => copy(tsv)} // 表格复制（制表符分隔）
    onDownloadTable={({ header, rows }) => download(header, rows)}
  />
</div>

// ② 函数形态（返回 ReactNode，不是 HTML 字符串）
renderAnswerMarkdown(text)
renderAnswerWithCitations(text, sources) // sources 为空时退回普通渲染
renderPlainMarkdown(text) // 只读那一档（文件预览用）：不挂复制 / 下载按钮、
// 标题保留原文层级（`#` 就是 `h1`，不夹到 2–4 级）、
// 单换行不换成 `<br>`（文档里那是 CommonMark 的一个空格）
```

**`Answer` 不包外层 div**（只有给 `className` 时才包一层）。`ui/AnswerText.tsx` 自己那层
`.reply-text` 挂着事件委托，所以这里必须保持 Fragment，否则 `> p` 这类选择器会被隔断。

### 徽标的两种接法（**二选一，别同时用**）

1. **回调**：`onOpenSource(index)` —— 组件自己 `preventDefault` + `stopPropagation`；
2. **事件委托**（旧的接法）：容器上监听 `[data-cite-index]`，与旧实现一字不差。

徽标始终带 `data-cite-index` / `role="button"` / `tabindex="0"`；**只在给了
`onOpenSource` 时才挂处理函数**，所以走委托时的 DOM 与旧实现没有区别。

### 代码块 / 表格的按钮

按钮的 `data-copy-code` / `data-copy-table` / `data-download-table` 与旧的**同名同位置**，
委托照样能用。给了回调时，回调拿到的是：

- `onCopyCode(code)`：**代码原文**（不含语言名、不含高亮补的收尾空行——与旧实现从
  `.md-code` 里只取 `pre` 同一个口径）；
- `onCopyTable(tsv)`：制表符分隔的正文（粘进 Excel / 飞书会被拆成单元格）；
- `onDownloadTable({ header, rows })`：**BOM、CSV 转义、文件名归页面那一层**
  （旧实现是 `ChatView.tableToCsv` + `downloadTable`，属于页面逻辑，没有搬进这一层）。

### 样式（页面侧要准备的）

- KaTeX 的样式表要引：`import 'katex/dist/katex.min.css'`（`rehype-katex` 只出标记）；
- 代码高亮用的是 highlight.js 的类名（`hljs` / `hljs-keyword`…），要上色得引一份主题
  （或按《前端设计规范》自己写 `--hljs-*` 到类名的映射）；
- 这一层**不引任何 CSS**，class 名与旧实现完全一致（`md-p` / `md-h2` / `md-ul` /
  `md-code` / `md-table-block` / `md-cite` …）。**这一族类名的样式现在在
  `ui/chat.css`**（v0.28 补齐）：迁移时旧样式表没跟着搬，于是 `md-p` 是 `margin: 0`、
  `md-ul` 连条目符号都没有（Tailwind 的 preflight 把 `ul/ol` 的符号也去掉了）——
  长回答读成一整块文字墙，列表退化成几行普通文字。取值与知识库那份
  （`knowledge.css` 的 `.kb-md-*`）同一套口径，两页之间不该有两种段距。
- `citeFallback`（`Answer` 的入参）给的是"对不上出处的编号"那句说明：给了就把那些
  编号渲染成**不可点**的虚线标记（`md-cite-plain` + `title`），没给就原样留着。
  对话页只在**这一轮确实跑过联网搜索**时给（见 `turns.ts` 的 `usedWebSearch`）。

---

## 2. 正在跑的那一轮（`liveTurn.ts`）

**状态与连接都在模块里，不跟页面走**（旧的 v0.41 设计）。zustand store 只装一格：

```ts
useLiveTurn() // 订阅钩子：组件用（返回值是同一个对象，引用变了才重渲染）
liveTurnState() // 命令式读取：流回调这类非组件代码用（对应旧的 `liveTurnState.value`）
```

四个落法（`mode`）与旧实现一致：`append`（新起一轮）/ `patch`（续跑）/ `recover`
（刷新后接回来）/ `command`（斜杠命令，真有内容才建气泡）。

```ts
startChatTurn(payload, { conversationId, query, thinking })
startCommandTurn(payload, { conversationId, query, thinking }, onCommand)
startResumeTurn(conversationId, payload, { thinking })
attachLiveTurn(conversationId) // 挂载 / 断线重连同一个入口（用 seq 锚点补发）
abortLiveTurn() // 「停止」：本页不再等它（真要停走 /stop）
settleLiveApproval() // 收起确认条（决定本身由页面 POST）
clearLiveTurn() // 交付给库了 / 换会话：忘掉它
liveAnchor(id) / clearLiveAnchors() // 重连锚点（模块作用域，用例之间要手动清）
```

`RECONNECT_MAX = 3`、`RECONNECT_DELAY_MS = 800`、`scheduleReconnect(reason)` 都照旧
（前两个现在**导出**了：用例据此钉住重连预算。**页面当前没有任何"重连中"状态** ——
`liveTurn` 只在内部排重连、不往外报"正在重连"，要加得另做，别以为它已经存在）。

---

## 3. 与旧实现的差异（**逐条列全**）

### 3.1 命名 / 形态（逻辑等价）

| 旧                                      | 新                                                                                   | 说明                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `liveTurnState`（`ref`，读 `.value`）   | `liveTurnState()`（getter）+ `useLiveTurn()`（钩子）                                 | 组件订阅必须走钩子；回调里读 getter                                    |
| `renderAnswerMarkdown` 返回 HTML 字符串 | 返回 `ReactNode`；组件 `<Answer>`                                                    | 不再有 `v-html` / 事件委托依赖                                         |
| （新增）                                | `Answer` / `AnswerMarkdown` / `MarkdownActions` / `MarkdownTable`                    | 组件形态与回调                                                         |
| （新增）                                | `isInlineLatex` / `renderLatexToHtml` / `splitInlineLatex` / `INLINE_MATH_MAX_CHARS` | KaTeX 那条路                                                           |
| （内部）                                | `ELEMENT_CACHE`（只此一层）                                                          | 旧的 `BLOCK_CACHE`（块级）**没有插点了**：解析在 `react-markdown` 里面 |

### 3.2 行为差异（都是刻意的，且有注释说明）

1. **`cleanInlineLatex` 仍是"文本 → 文本"**，一个 KaTeX 标签都不吐。理由不是兼容而是
   流水线：阅读视角那条路是 `renderAnswerMarkdown(cleanInlineLatex(正文))`，它要是吐 HTML，
   下游 Markdown 就得开 `rehype-raw`（把模型输出当可信 HTML），安全口径崩掉。
   **真渲染走 `renderLatexToHtml` / `splitInlineLatex`**，识别判据两条路共用（`isInlineLatex`）。
2. **`$` / `$$` 边界**：整式 `$$…$$` 先配对。旧实现只认单 `$`，`$$52.7\%$$` 会留下两个
   孤儿 `$`（`$52.7%$`）；现在整式当一整段处理，不再有残留（`latex.test.ts` 有一条专测）。
3. **`blockquote` 里多一层 `<p class="md-p">`**：remark 的结构如此（旧自研解析器是直接铺行）。
   功能点不变（一个 blockquote、行内换行成 `<br>`），但样式若写了 `.md-quote > *` 要留意。
4. **换了项目符号（`-` 接 `*`）算两个列表**：CommonMark 的口径（旧实现把三种符号归成一个）。
5. **Markdown 语法面变大**：GFM 的**表格 / 删除线 / 任务列表 / 脚注**、**图片**、
   **标题 / 分隔线**都按标准渲染了（旧实现只认"小标题、列表、加粗、行内代码、代码块、表格、链接"）。
   安全口径**没有放松**：裸 HTML 仍然只当文本（`<img src=x onerror=…>` 原样显示），
   链接仍然只放行 `http(s):` / `mailto:`（其余整条退回字面量，可读不可点）。
6. **划掉的旧行为**：旧实现"代码块内不做行内标记"仍然成立（结构上跳过），但
   `{ }` 之类的字符序列不再被特殊处理；`![图](url)` 现在会渲染成图片（旧实现当字面量）。
7. **`blockquote` / 列表 / 表格里的空行**：`rehypeTrimBlocks` 把 remark 插在块之间的
   只含换行的文本节点删掉了——旧实现的 `join('')` 没有这些节点，留着会让
   "同内容同输出"对不上、`white-space: pre-wrap` 的容器里还会多一行。
8. **代码块末尾的空行**：围栏代码的 value 带一个收尾换行、highlight.js 还会再补一个，
   这里按旧口径（`body.join('\n')`）**收掉一个**，DOM 与复制内容因此与旧实现一致。
9. **公式走标准路线**（`remark-math` + `rehype-katex`，原先是自写的 `rehypeInlineMath`）：
   `$x^{2}$`、`$\frac{1}{2}$`、`$\alpha$` 这类交给 KaTeX 排版（旧回答路径完全不处理，
   字面显示）。**与旧口径的差异逐条列在下面那张表**——最要紧的是第一条（钱）。
10. **引用徽标不再进 `a` 里**：`[1]` 出现在链接文字里时不再换成徽标（旧的会，那会造出
    嵌套 `<a>`——非法 HTML）。

### 3.2.1 公式口径：`remark-math`（标准路线）与旧自写插件的**全部差异**

问题从哪儿来：自写的 `rehypeInlineMath` 是在 **hast（渲染前一步）** 上按文本认公式，
判据是"公式体里得有可识别的 LaTeX 标记"（`latex.ts` 的 `isInlineLatex`）；
`remark-math` 是在 **mdast（解析期）** 认，判据是"`$` 配对"（micromark 的口径）。
两条路的判据不同，差异就是下面这张表——**前四条在
`tests/chat-model-markdown.test.ts` 里有用例钉住**，其余几条是换路线时按两边实现
逐条核对出来的。

| 写法                                           | 旧（自写 `rehypeInlineMath`）                                           | 现在（`remark-math`）                                                                           |
| ---------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `价格从 $5 到 $10 不等`                        | **一个字都不动**（`5 到` 里没有 LaTeX 标记）                            | **也不排**：收尾 `$` 前是空格，`rehypeMathSpacing` 按 GitHub 口径退回原文（早期版本会排，已修） |
| `价格从 \$5 到 \$10 不等`（转义）              | 不动（`\$` 是普通文本）                                                 | 不动（CommonMark 的字符转义先吃掉反斜杠，KaTeX 看不到公式）——**这就是那句缓解写法**             |
| `$52.7\%$`（只有转义符）                       | 认不出（CommonMark 先把 `\%` 还原成 `%`，到 rehype 那一步就不是公式了） | **正常排版**（公式体在解析期就整段收走，`\%` 原样交给 KaTeX）——这一类是**变好了**               |
| `推导 $$\frac{1}{2}$$ 结束`（单行 `$$`）       | 按整式排（`math-display`，整块居中）                                    | 行内公式（`$$` 必须**自成一行**才是 display，GitHub 的写法）                                    |
| 跨行的 `$x␊第二行$`                            | **不认**（正则里有 `[^$\n]`：跨行会把两行的公式并成一个）               | 认（micromark 允许行内公式跨行；首尾的空白与换行会被去掉）                                      |
| 超过 200 字的公式体（`INLINE_MATH_MAX_CHARS`） | 不认（旧实现写死的长度上限）                                            | 认（micromark 没有长度上限）                                                                    |
| `$\alpha$$\beta$` / `$a$$b$`（公式体里有 `$`） | 就近配对：认得出的切成**两个**公式，认不出的一个字不动                  | 配对个数不等 → 不当公式，KaTeX 报错画成 `katex-error`（**原文照旧可读**）                       |
| `$ x $`（首尾有空格，且里面没有别的标记）      | 不动（`trim()` 之后没有可识别的 LaTeX 标记）                            | 认（空格被当作 padding 去掉，公式体就是 `x`）                                                   |

**没有放松的两条（安全口径）**：代码块与行内代码里的 `$` 照旧是字面量（结构上不在
扫描范围里）；KaTeX 排不出来时的兜底照旧是"把原文显示出来"（`rehype-katex` 的
`katex-error` 分支），不吐假 HTML。

**边界规则：`rehypeMathSpacing`（已实现）**。`remark-math` 只认"配对"，价格那种写法会被排掉；
补的这条规则用 **GitHub 的口径**（`$` 与内容之间不留空格），把不合口径的退回原文：

- 认的是 `remark-math` 生成的 `code.language-math`（**实测——不是 `span.math-inline`**，
  这一点没有文档，写错就永远不命中）；
- **右侧留空能判**（`$5 到 $` ← 价格那种），**左侧留空判不出**：`remark-math` 在 mdast
  阶段就把公式体去了首尾空白，转换到 hast 之后左边的空格已经不可考（`$ x $` 仍会被排，
  要字面量就写 `\$`）；
- 顺带一条经验：**在 mdast 上改这个是不行的**——插件跑完树里 0 个 `inlineMath`，
  产物里照样有 KaTeX（转换那一步拿到的不是被改过的那棵树，实测）。所以规则落在 hast 上、
  挂在 `rehype-katex` **之前**。

`singleDollarTextMath: false` 那条路仍然留着（那会连 `$x$` 一起关掉，只剩 `$$…$$`），
现在不需要它了。

### 3.3 与旧实现**完全一致**的部分（重点保留）

- `turns.ts` 一个字符都没改行为：`buildTurns` / `mergeStep` / `traceSteps` /
  `traceEntries` / `tracePage` / `stepIcon`（含 `LEGACY_*` 两张老快照兜底表）/
  `replyArtifacts` / `wasDegraded` / `degradedReason` / `hasToolCallMarkup` /
  `sourceWhere` / `sourcePreview` / `traceSummary`；
  - ⚠️ **`liveLine`（连同 `LIVE_TAIL_CHARS` 与它内部的 `tailOf`）已删**（用户要求：
    "把 agent 执行中跟头像齐平的那个流式输出干掉"）。它给的是流式期间那一行会滚的
    实时文案，而那一行挂在过程面板的开合开关上、位于助手列第一个节点（与头像齐平）。
    删掉之后那一行在流式期间改用一个**静态短标签**（「执行过程」）说明"这里能点开"，
    免得只剩一枚箭头；面板自己的开合规则（进行中展开、跑完折叠）与那条摘要素一个字都没动；
  - **`isTraceOpen` 后来又改过两次**（都在 2026-09-29，用户明确推翻 v0.25 那条"默认展开、
    不再自动收起"，改按成熟产品：**进行中展开、跑完折叠**）—— 它现在是纯函数，档位从布尔变成
    `'collapsed' | 'full'`。第一次把本机记忆的语义从"记住上次开合"改成"记住用户是否手动干预过"；
    第二次（§12.335）**把那份本机记忆整档删掉**（用户原话"那个记忆可以不要"）：
    豁免**只作用于这一轮**（`chosen`），没点过的完成轮一律自动折，`kylab-trace-open`
    这个键与它的读写函数都不存在了。同一条规则还加了渲染层的 `traceKey(turnIndex, key)`
    （修跨轮串号）。上面这份"一字未改"的名单**不再包含它**；细节见
    `docs/计划与记录/开发计划-v0.1.md` §12.333 / §12.335；
- `liveTurn.ts` 的锚点、重连预算、`done(recovered)` 收口、"停止之后不重连"、
  "接不上就什么都不留"、"别的会话不抢位置"；
- 裸链接的两条边界（前面不是字母数字就算开头、网址体里不许有中文标点）与
  **裁断的网址不链**；`www.` 补 `https://`；不猜邮箱、不猜裸域名；
- 行内 `[n]` 徽标：`{index, document_name, heading_path, page}` 的短名与 `title` 口径、
  "组里有一个对不上就整组不换"、"找不到出处的编号原样留着"；
- LaTeX 的两张表（转义 / 符号）、上下标映射、`\frac`、引用上标、模式外只动 `\~` `\_`。

---

## 4. 旧 → 新 用例对照

| 旧用例文件                                    | 条数    | 新用例文件                           | 条数                                                        |
| --------------------------------------------- | ------- | ------------------------------------ | ----------------------------------------------------------- |
| `tests/unit/composables/useChatTurns.test.ts` | 60      | `tests/chat-model-turns.test.ts`     | 60（逐条搬，只改 import）                                   |
| `tests/unit/composables/useLiveTurn.test.ts`  | 15      | `tests/chat-model-live-turn.test.ts` | 15（逐条搬，`.value` → 调用）                               |
| `tests/unit/composables/useMarkdown.test.ts`  | 54      | `tests/chat-model-markdown.test.ts`  | 73（54 条搬 + 15 条新增：组件/@ 动作 + 4 条：公式口径差异） |
| `tests/unit/composables/useLatex.test.ts`     | 16      | `tests/chat-model-latex.test.ts`     | 30（16 条搬 + 14 条新增：`$$` 边界 / KaTeX）                |
| **合计**                                      | **145** |                                      | **178**                                                     |

markdown 那一批的**断言文本**也照旧（`html()` 只把 React 的空标签写法 `<br>` 归一成旧写的
`<br />`），只有几处因为上面 §3.2 的结构差异改了写法，并在用例里写明了原因：
列表符号（第 4 条）、`blockquote` 多一层 `p`（第 3 条）、代码块内容断言走 `textContent`
（高亮把代码切成了 span）、以及**公式那两条**（第 9 条 + §3.2.1 的差异表）。

**`latex.ts` 一行没动**：它服务的是文档阅读视角（`cleanInlineLatex` 的纯文本还原、
`splitInlineLatex` + `renderLatexToHtml` 自己拼），与回答渲染的公式路线互不影响——
所以 `chat-model-latex.test.ts` 那 30 条**原样跑绿**。

---

## 5. 回答里的网页引用：`sourceCitations.ts` + 站点徽章（D11-③，2026-09-29）

用户要的样子（照 Kimi）：行内一枚**小圆角徽章 = 站点真实 logo + 域名**，悬停/聚焦出
一张卡片（站点 + 域名 + 淡色对勾 / 页面标题 / 一两行摘要 / 可点可复制的 URL）。

### 5.1 数据从哪来（**不新增后端字段**）

知识库出处的 `ChatSource` 只有 `document_name / heading_path / page / preview`——
**没有 URL、没有站点**，那是**文档**不是网页，所以它**照旧**画文档名徽标 ✓（别硬套 ✗）。
网页引用的标题 / 网址 / 摘要**本来就在库里**：`web_search` 那一步的 `result` 就是后端
渲染好的编号列表（`services/tools.py::_web_search`）：

```
检索词：agent skills，共 3 条：
[1] Anthropic 的官方仓库
https://github.com/anthropics/skills
官方维护的 Agent Skills 仓库，含文档与示例。
```

`webCitationsOfSteps(steps)` 把这段文本解析成 `{index, title, url, domain, snippet, site}`：
摘要取的就是搜索结果自带的那行 snippet；站点标识复用 `webSites.ts` 那张表
（`siteOfDomain`）。**解析不出 URL/域名的编号整条不要** → 它退回原来那句说明
（`citeFallback`），**不出现空徽章、不出破图**。

### 5.2 三层怎么接（分层纪律：`model/` 不认识界面组件）

| 层                                 | 做什么                                                                                                                                                                                                                     |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model/sourceCitations.ts`         | 纯函数解析（上面那一件事）                                                                                                                                                                                                 |
| `model/markdown.tsx`               | `CiteFallback.citations` 给了就**不再画"有说明的非链接"**，改成一枚带 `data-cite-site-chip` 的标记；**卡片长什么样**由 `MarkdownActions.renderWebCitation` 交给界面                                                        |
| `ui/SourceCard.tsx`                | `SourceBadge`（行内徽章）+ `SourceCardHost`（**一条回答只挂一个**的卡片）；`ui/sourceCardStore.ts` 是"当前开着哪一条"那个小状态（`ui/siteLogos.ts` 供两处共用取图）                                                        |
| `ui/SourceCard.tsx` 的 `LinkBadge` | **正文里的普通外链**那一档（2026-10-01 批四）：同一副胶囊 + 同一张卡片，**没有编号与对勾**（胶囊的 `aria-label` 是「链接：域名」）；域名与站点由 `hostOfUrl` / `siteOfDomain` 派生，接线是 `MarkdownActions.renderWebLink` |

接线一行在 `ui/MessageView.tsx`：`citeFallback` 带上 `citations: webCitationsOfSteps(message.steps)`。

### 5.3 两条踩过的坑（都留了用例）

1. **渲染缓存键必须带上引用**：同一段正文先在"有联网引用"那一轮渲染成徽章、缓存住，
   另一轮同样文字但没有引用时命中同一棵树 → **没有引用的那一轮也画出了 `github.com`**。
   修法是 `citationsSignature()` 进 `renderMarkdown` 的 `ELEMENT_CACHE` 键
   （用例：`chat-source-citations.test.tsx` 的「没给 citations（老调用方）…」）；
2. **`[data-cite-site]` 只在认得出站点时才有值**：真实结果里大量是表外域名
   （`iim.net.cn`、`xhby.net`…）——它们**也有徽章**，所以按 `data-cite-domain` 认。

### 5.4 验收数字（真浏览器，`.shots/d11b-cite/`）

- **行内徽章 13 枚**（`conv_563ca9101377`），控制台 error / pageerror **0**；
- **段落行高变化 = 0**：带徽章那几段的高度是行高的**整数倍**（76.5 = 3×25.5、51 = 2×25.5），
  与不带徽章的段落同一口径；徽章盒高 **15.08px** < 行高 **25.5px**，
  `bottomGapToLine = 0`（没有沉到行外）；
- 卡片：悬停（`mouseover`）/ 键盘聚焦都能开、`aria-expanded=true`、Esc 关、
  贴边翻转（`cardPlacement` 纯函数 + 用例）、**没有 👍/👎**；
- 亮/暗各一张：`light-inline.png` / `light-card.png` / `dark-inline.png` / `dark-card.png`。

---

## 6. 右侧面板的文件树：`fileTree.ts` + `fileIcons.tsx`

面板（`features/chat/panel/**`）里那几件纯计算与那张图标的表住在这里，理由只有一个：
**它们没有请求、没有 React**，所以能单测（`tests/chat-panel-tree.test.ts`）。
渲染在 `panel/FilesTab.tsx` 与 `panel/FileTree.tsx`，界面那一层的用例在
`tests/chat-panel.test.tsx`。

| 这里            | 提供什么                                                                                                                                                          |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fileTree.ts`   | 同层排序（名称 / 修改时间 / 类型，**目录恒在最前**）、模糊匹配（子序列 + 前缀加成）、把"已展开的那几层"摊平（搜索的地盘）、续层定位（要展开哪几层才看得见那一份） |
| `fileIcons.tsx` | 后缀 → lucide 图形的**唯一一张表**（产物卡片与文件树共用）；`fileIconFor()` 给要自己拼 `size` 的地方，`<FileTypeIcon/>` 给 JSX                                    |

三条口径（都留了用例）：

1. **搜索只吃已展开的层**：`flattenLevels(root, byDir, expanded)` 只往 `expanded` 里的目录
   下走——一个目录收起来之后，它那份清单还留在 react-query 的缓存里，但那不算"展开着"。
   面板上那句话（「只搜已展开的目录」）说的就是这件事，不假装搜了整棵树；
2. **排序说的是"同类里怎么排"**：目录与文件不混着重排，而且一次只吃一层
   ——排序永远不会把子目录里的东西拎到父层来；
3. **图标表只有一份**：`ui/Deliverables.tsx` 原先自己写了一张（`ARTIFACT_ICONS`），
   文件树要画的又是同一件事，所以抽到这一层两处共用（抄两份的话，给 `.pptx` 换一枚图标
   就要记得改两处，漏掉的那一处谁也不会发现）。
