/**
 * 工具返回的**三档渲染器**（调研 §5.2 P2：结果按类型分派）。
 *
 * 为什么在这儿、而不是塞进 `ToolchainFlow` 的行里：那一行装着"这一步做了什么"的五六件事
 * （图标位、状态灯、标签、结论、思考、站点、原文），渲染器一多就会长成一棵没人敢动的树。
 * 分派本身走 `model/resultDisplay.ts` 的 `displayType`（纯判据，一处），
 * 这里只是**判据 → 组件**的那张映射表 + 两个新渲染器。
 *
 * 三档 = 两个新渲染器 + **兜底那一格**（等宽 `<pre>`，也就是原先唯一的画法）：
 * 认不出的、半截的、解析不了的一律走兜底，所以"未知类型"不需要第四档。
 *
 * 三条不许丢的旧行为（换的是排版，不是取舍）：
 *
 * 1. **限高 220px + 自己滚**：三种渲染器共用 `traceStyles` 里那一个限高常量
 *    （表格与 JSON 都不是"全铺出来"的理由，原文那一块的量级没变）；
 * 2. **网址照样点得到**：三档都过 `LinkText`（它只做"识别网址、其余原样"）——
 *    JSON 里、表格单元格里的 https 链接不该因为换了排版就点不动；
 * 3. **这一段是原文**：`data-result` 如实报出用的是哪一档（用例与排查都读它），
 *    内容一个字不改（JSON 那一档只是**缩进排版**，不替用户改写、不截断）。
 */
import type { ReactNode } from 'react'

import {
  displayType,
  parseJsonResult,
  parseTableResult,
  type ResultDisplayType,
} from '@/features/chat/model/resultDisplay'

import { LinkText } from './LinkText'
import { RAW_BODY, RESULT_TABLE, RESULT_TABLE_WRAP, RESULT_TD, RESULT_TH } from './traceStyles'

/** 兜底那一档：等宽 `<pre>`，与这一批之前完全一致（`RAW_BODY` 原样引用）。 */
function ResultText({ text }: { text: string }) {
  return (
    <pre className={RAW_BODY} data-result="text">
      <LinkText text={text} />
    </pre>
  )
}

/** JSON（对象 / 数组）：缩进排版 + 等宽，比一坨原文好读。 */
function ResultJson({ text }: { text: string }) {
  /*
    判据已经在 `displayType` 里下过（这里**不再判一次**）：`?? text` 是防御性的，
    取不到排版结果就照原文画——它不改变"哪一档"这个结论，只是让这一格永远不会空白。
  */
  const pretty = parseJsonResult(text) ?? text
  return (
    <pre className={RAW_BODY} data-result="json">
      <LinkText text={pretty} />
    </pre>
  )
}

/**
 * Markdown 表格：**真表格**（列名进 `<th scope="col">`，读屏器也读得出表头与单元格的关系）。
 *
 * 数据行由 `parseTableResult` 保证"列数与表头一致"，所以这里不再逐格补空。
 */
function ResultTable({ text }: { text: string }) {
  const rows = parseTableResult(text) ?? []
  const [head = [], ...body] = rows
  if (head.length === 0) return <ResultText text={text} />
  return (
    <div className={RESULT_TABLE_WRAP} data-result="table">
      <table className={RESULT_TABLE}>
        <thead>
          <tr>
            {head.map((cell, index) => (
              // 单元格是**同一张表按位置切出来的**，没有稳定 id；下标即位置
              <th key={index} scope="col" className={RESULT_TH}>
                <LinkText text={cell} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className={RESULT_TD}>
                  <LinkText text={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** 判据 → 组件。**兜底那一格就是现状**，未知类型因此不需要再写一档。 */
const RESULT_RENDERERS: Record<ResultDisplayType, (props: { text: string }) => ReactNode> = {
  json: ResultJson,
  table: ResultTable,
  text: ResultText,
}

/**
 * 画一段工具返回。`text` 必须是**真正要画的那段**（预览态与全文态各调一次）：
 * 判据吃的是它，见 `resultDisplay.displayType`。
 */
export function StepResult({ text }: { text: string }) {
  const Renderer = RESULT_RENDERERS[displayType(text)]
  return <Renderer text={text} />
}
