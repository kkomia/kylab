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
renderPlainMarkdown(text) // 只读：不挂复制 / 下载按钮（文件预览用）
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
  `md-code` / `md-table-block` / `md-cite` …），旧样式表可以直接搬。

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
（前两个现在**导出**了，用例与页面可以据此显示"重连中"）。

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

| 写法                                           | 旧（自写 `rehypeInlineMath`）                                           | 现在（`remark-math`）                                                               |
| ---------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `价格从 $5 到 $10 不等`                        | **一个字都不动**（`5 到` 里没有 LaTeX 标记）                            | `$5 到 $` 被当成公式排掉——**这是换标准路线的已知代价**；要字面量就把美元号转义      |
| `价格从 \$5 到 \$10 不等`（转义）              | 不动（`\$` 是普通文本）                                                 | 不动（CommonMark 的字符转义先吃掉反斜杠，KaTeX 看不到公式）——**这就是那句缓解写法** |
| `$52.7\%$`（只有转义符）                       | 认不出（CommonMark 先把 `\%` 还原成 `%`，到 rehype 那一步就不是公式了） | **正常排版**（公式体在解析期就整段收走，`\%` 原样交给 KaTeX）——这一类是**变好了**   |
| `推导 $$\frac{1}{2}$$ 结束`（单行 `$$`）       | 按整式排（`math-display`，整块居中）                                    | 行内公式（`$$` 必须**自成一行**才是 display，GitHub 的写法）                        |
| 跨行的 `$x␊第二行$`                            | **不认**（正则里有 `[^$\n]`：跨行会把两行的公式并成一个）               | 认（micromark 允许行内公式跨行；首尾的空白与换行会被去掉）                          |
| 超过 200 字的公式体（`INLINE_MATH_MAX_CHARS`） | 不认（旧实现写死的长度上限）                                            | 认（micromark 没有长度上限）                                                        |
| `$\alpha$$\beta$` / `$a$$b$`（公式体里有 `$`） | 就近配对：认得出的切成**两个**公式，认不出的一个字不动                  | 配对个数不等 → 不当公式，KaTeX 报错画成 `katex-error`（**原文照旧可读**）           |
| `$ x $`（首尾有空格，且里面没有别的标记）      | 不动（`trim()` 之后没有可识别的 LaTeX 标记）                            | 认（空格被当作 padding 去掉，公式体就是 `x`）                                       |

**没有放松的两条（安全口径）**：代码块与行内代码里的 `$` 照旧是字面量（结构上不在
扫描范围里）；KaTeX 排不出来时的兜底照旧是"把原文显示出来"（`rehype-katex` 的
`katex-error` 分支），不吐假 HTML。

**要改回"价格不当公式"怎么办**（留给以后的决定，不在这版里）：`remark-math` 只有一个
像样的开关 `singleDollarTextMath: false`——那会连 `$x$` 行内公式一起关掉，只剩 `$$…$$`；
另一半做法是在 mdast 上再挂一个自己的插件按 `isInlineLatex` 过滤（那等于把自写规则
挪个位置，不是"标准路线"了）。

### 3.3 与旧实现**完全一致**的部分（重点保留）

- `turns.ts` 一个字符都没改行为：`buildTurns` / `mergeStep` / `traceSteps` /
  `traceEntries` / `tracePage` / `stepIcon`（含 `LEGACY_*` 两张老快照兜底表）/
  `replyArtifacts` / `wasDegraded` / `degradedReason` / `hasToolCallMarkup` /
  `sourceWhere` / `sourcePreview` / `isTraceOpen` / `liveLine` / `traceSummary`；
- 收起态记忆的键名 `kylab-trace-open`；
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
