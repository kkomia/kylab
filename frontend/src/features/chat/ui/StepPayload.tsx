/**
 * 工具步骤原文的两块面板：**Request / Response**（Kimi 的 `inline-tool-detail`，R4 批注）。
 *
 * 改前这两段（`step.args` / `step.result`）都是一坨 `<pre>` 平铺：JSON 一行到底、
 * 正文没有行号。Kimi 的画法是**浅灰圆角面板 + 加粗小标题**（Request / Response），
 * JSON 缩进排版并着色，Response 那一侧正文带行号槽（`1  Gained some skills…`）。
 *
 * 四条写下来的口径：
 *
 * 1. **能 parse 才当 JSON**：判据走模型层既有的 `parseJsonResult`（只看 `{` / `[` 开头、
 *    必须真解析得出来）——半截 JSON 是常态，解析不了就照原文，一句话都不多说；
 * 2. **着色只在 JSON 那一档**：正文里出现数字 / 引号不该被当成语法染色（那是噪声），
 *    所以 token 化只在 `parseJsonResult` 有结果时启用；
 * 3. **色档借 markdown 代码高亮那套令牌**（`preview.css` 给 hljs 的：字符串 = `--status-success`、
 *    键与数字 = `--accent-text`、字面量 = `--status-warning`、标点 = `--text-secondary`），
 *    **不新造色值**——见 `flow.css` 的 `.ch-json-*`；
 * 4. **行号槽只在 Response**：它是"工具回了什么"的正文；Request 是"我给出去什么"，
 *    短、也不需要按行核对。
 *
 * `pre.ch-raw` / `data-args` / `data-result` 这些属性**一个不动**（换的是内部渲染，
 * 用例读 `[data-args]` 的 textContent 照旧成立）。
 */
import { useMemo } from 'react'

import { parseJsonResult } from '@/features/chat/model/resultDisplay'

/** 行内一段：`cls` 是色档（`.ch-json-*`）。 */
interface Piece {
  text: string
  cls: string
}

/*
 * 六档色（与 `flow.css` 的类名一一对应）。名字取"语法角色"而不是 hljs 的类名：
 * 我们不做完整的高亮器，只认 JSON 的六类记号。
 */
const PUNCT = 'ch-json-punct'
const KEY = 'ch-json-key'
const STR = 'ch-json-str'
const NUM = 'ch-json-num'
const LIT = 'ch-json-lit'

/**
 * 把一段 JSON 切成"带色档的片段"。
 *
 * **不做校验**：能不能解析由调用方先判过（`parseJsonResult`），所以这里只管认记号；
 * 认不出来的一律算**标点**（弱化那几档），于是任何输入都能安全走完、不抛。
 * 键与字符串靠**后面紧跟冒号**区分（`"a":` 是键，`"a"` 是值）。
 */
function piecesOf(text: string): Piece[] {
  const token = /"(?:[^"\\]|\\.)*"|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g
  const out: Piece[] = []
  let at = 0
  for (let matched = token.exec(text); matched !== null; matched = token.exec(text)) {
    if (matched.index > at) out.push({ text: text.slice(at, matched.index), cls: PUNCT })
    const piece = matched[0]
    let cls = NUM
    if (piece.startsWith('"')) {
      cls = /^\s*:/.test(text.slice(matched.index + piece.length)) ? KEY : STR
    } else if (piece === 'true' || piece === 'false' || piece === 'null') {
      cls = LIT
    }
    out.push({ text: piece, cls })
    at = matched.index + piece.length
  }
  if (at < text.length) out.push({ text: text.slice(at), cls: PUNCT })
  return out
}

/** 缩进排版的正文（JSON 才排版；其余照原文）。`json` 一并回出去给着色那一步用。 */
function usePretty(text: string): { body: string; json: boolean } {
  return useMemo(() => {
    const pretty = parseJsonResult(text)
    return { body: pretty ?? text, json: pretty !== null }
  }, [text])
}

/** 面板的公共骨架：加粗小标题 + 浅灰圆角体。 */
function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="ch-panel">
      <div className="ch-panel-head">{title}</div>
      {children}
    </div>
  )
}

/**
 * 「Request」：这一步发给工具的入参。
 * 面板体是 `pre.ch-raw[data-args]`（属性照旧，用例读 textContent）。
 */
export function RequestPanel({ text }: { text: string }) {
  const { body, json } = usePretty(text)
  return (
    <Panel title="Request">
      <pre className="ch-raw ch-panel-body" data-args>
        {json
          ? piecesOf(body).map((piece, index) => (
              <span key={index} className={piece.cls}>
                {piece.text}
              </span>
            ))
          : body}
      </pre>
    </Panel>
  )
}

/**
 * 「Response」：工具回给这一步的正文。**带行号槽**（一行一个行号，右侧正文照旧可换行）。
 *
 * `marker` 落到 `data-result`（`'json'` / `'text'`，与 `displayType` 同一档），
 * 排查与用例读的都是它。
 */
export function ResponsePanel({ text, marker }: { text: string; marker: string }) {
  const { body, json } = usePretty(text)
  const lines = useMemo(() => body.split('\n'), [body])
  return (
    <Panel title="Response">
      <pre className="ch-raw ch-panel-body ch-panel-body--numbered" data-result={marker}>
        {lines.map((line, index) => (
          <span className="ch-panel-line" key={index}>
            <span className="ch-ln" aria-hidden>
              {index + 1}
            </span>
            <span className="ch-lt">
              {json
                ? piecesOf(line).map((piece, at) => (
                    <span key={at} className={piece.cls}>
                      {piece.text}
                    </span>
                  ))
                : line}
            </span>
          </span>
        ))}
      </pre>
    </Panel>
  )
}
