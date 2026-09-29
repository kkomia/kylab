/**
 * 工具返回**按类型分派**渲染的那一处判据（调研 §5.2 P2）。
 *
 * 为什么要有一层判据，而不是继续一律铺等宽 `<pre>`：返回是 JSON / 表格 / 网页正文时，
 * 用户得自己从原文里找（`{"artifact_id": "art_89cb…", "name": …}` 那种一坨、
 * 或者一张 `| a | b |` 的表格），而三家共有做法都是先判类型再选渲染器
 * （MaxKB 的 `kw[content.type]`、WeKnora 的 `displayType`、Coze 的
 * `enhancedContentConfigList.rule`）。这一层只回答"该用哪个渲染器"，
 * **不认识任何一个组件**（与 `turns.ts` 同一条纪律：纯逻辑层不 import 界面）。
 *
 * 只做三档，不铺二十个渲染器：**JSON（对象/数组）· Markdown 表格 · 其余**。
 * 每接一个新工具应当只加一个渲染器，不必再动主时间线。
 *
 * 注意：三个必须一起成立的前提（都落在这一层的判据里，别挪到渲染器里各判一遍）：
 *
 * 1. **返回是发到界面时被截过的字符串**：后端按 `MAX_STEP_PREVIEW_CHARS = 2000` 裁过，
 *    界面上还可能只给前 600 字（`resultPreview`）。半截 JSON、半截表格**都必须安全退回**
 *    等宽 `<pre>`——解析放在 `try` 里、表格要求行数与表头一致，都为这一条；
 * 2. **不抛**：解析失败不是异常路径，是**常态**（正文、日志、代码片段都走它），
 *    所以这一层只返回 `null` / `'text'`，让调用方落到现状那一种渲染；
 * 3. **不显示"解析中"这类假状态**：判据是**纯函数、同步**的，同一段文本永远同一档——
 *    界面上没有第二种"还在猜"的画法。
 */

/**
 * 返回该按哪一档画。`'text'` 是**兜底那一档**（现状的等宽 `<pre>`），不是"普通文本"的意思：
 * 认不出的、解析不了的、半截的，全都落在这里。
 */
export type ResultDisplayType = 'json' | 'table' | 'text'

/**
 * 缩进排版好的 JSON（`null` = 不是"能解析的对象 / 数组"）。
 *
 * 三条边界都是刻意的：
 *
 * - **只看 `{` / `[` 开头**：`"text"`、`12`、`true` 也是合法 JSON，但"缩进排版"
 *   对它们毫无意义，把它们认成 JSON 只会让同一行字的画法随内容乱跳；
 * - **必须真的解析出来**：半截 JSON（后端那一刀切在字符串中间时就是这样）走 `catch`，
 *   返回 `null` → 退回 `<pre>` 原文（用户看到的仍是"它到底回了什么"，
 *   而不是一句"解析失败"）；
 * - **`stringify` 用两个空格**：与后面"等宽 + 220px 限高"配着读，缩进是这一档的全部价值。
 */
export function parseJsonResult(result: string): string | null {
  const body = result.trim()
  if (!body.startsWith('{') && !body.startsWith('[')) return null
  try {
    const value = JSON.parse(body) as unknown
    if (typeof value !== 'object' || value === null) return null
    return JSON.stringify(value, null, 2)
  } catch {
    return null
  }
}

/** 表格的一行拆成单元格：**两端都得有 `|`**（半截的那一行正是缺收尾那根竖线）。 */
function tableCells(line: string): string[] | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null
  return trimmed
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim())
}

/** 分隔行（`| --- | :--: |`）：每格只由 `-` 与 `:` 组成，且至少一个 `-`。 */
function isDivider(cells: readonly string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell))
}

/**
 * Markdown 表格的行列（第一行是表头；`null` = 不是一张**完整**的表）。
 *
 * 判据两条，都是为了"半截的表格必须安全退回 `<pre>`"：
 *
 * - **每一行都必须两端带 `|`**：被截断的那一行通常没有收尾竖线；
 * - **每一行的列数必须与表头一致**，且**至少有一行数据**：只剩表头 + 分隔行的那种，
 *   正好是"切在半截"的样子，画出来是一张空表——那比原文更难读。
 *
 * 中间的空行不算一行（`filter`）：Markdown 表格本身不允许空行，而截断或粘贴常常带尾巴。
 */
export function parseTableResult(result: string): string[][] | null {
  const lines = result.split(/\r?\n/).filter((line) => line.trim() !== '')
  if (lines.length < 3) return null
  const head = tableCells(lines[0]!)
  const divider = tableCells(lines[1]!)
  if (!head || !divider || head.length < 2) return null
  if (head.length !== divider.length || !isDivider(divider)) return null

  const rows = [head]
  for (const line of lines.slice(2)) {
    const cells = tableCells(line)
    if (!cells || cells.length !== head.length) return null
    rows.push(cells)
  }
  return rows
}

/**
 * 这一步的返回该用哪个渲染器。 **这是唯一的判断**；未知、半截、解析不了，
 * 一律落到 `'text'`（= 现状的等宽 `<pre>`，见 `ui/StepResult.tsx` 那张映射表的兜底那一格）。
 *
 * 吃的是**真正要画的那段文本**、不是 `step.result`：预览态（`仅预览 600/2000 字`）
 * 拿到的就是半截，按整段判会判成 JSON 却画不出来——判据必须看屏幕上那一段。
 *
 * 顺序有意：JSON 先判（`{` / `[` 开头的东西不可能是表格），表格再判，
 * 两者都要"整段成立"才认——不成立就走 `'text'`，**没有第四档、也没有"大概像"这一档**。
 */
export function displayType(result: string): ResultDisplayType {
  if (parseJsonResult(result) !== null) return 'json'
  if (parseTableResult(result) !== null) return 'table'
  return 'text'
}
