/**
 * 空状态那排推荐问题的整理（v0.28，第二批评审 A5）。
 *
 * 问题**不是前端生成的**：`GET /chat/suggested-questions` 直接从库里已存的分段问题里抽
 * （入库时让模型为每一段出题，见后端 `services/suggested_questions.py`），前端拿到什么
 * 就显示什么。所以这一层只做一件事——**把两条粘在一行的问题拆开**，好让每一条占一行。
 *
 * ## 两条踩过的事实（查过，不是猜的）
 *
 * 1. **`片段N` 那种前缀是模型写下的原文**，不是前端拼的。出题提示词要求模型按
 *    `###片段3` 单独一行分段（后端 `_BLOCK_HEADER` 就是按这个切的），而模型有时不用
 *    块头、直接把编号写进问题里（"片段3中哪篇文献……？"）。后端 `_parse_questions`
 *    **刻意只做保守清洗**（去编号前缀、去引号），不替模型改写句子——所以那样的问题
 *    原样存进库、原样回到界面。**这一层同样不改它**：前端按自己的口味改后端文案的语义，
 *    会让"库里存的是什么"与"用户看到的是什么"分家，回看时对不上。
 *    （要治就治出题提示词那一端，不在界面这一层。）
 * 2. **两条问题粘在一起**是模型**没有分行**写：它写了一行
 *    "……视力恢复？" + 一个全角空格 + "相机暗箱中的图像通常被投影到哪里？"
 *    （这一个字符就是 U+3000），后端按行取，于是那**一行**就是一条"问题"。
 *    这是排版层面的事，不涉及语义：
 *    拆开之后两条都还是模型写的原文，一个字没动。
 *
 * ## 拆的边界（宁可少拆，不可错拆）
 *
 * 判据两条同时成立才拆：
 * - 分隔处是**全角空格**（U+3000）或**两个以上的半角空格**——单个半角空格太常见
 *   （英文句子、编号与文字之间），拆了会把一整句问题切成两半；
 * - 分隔处**左边紧挨着句末标点**（？?！!。；;）——"第一讲" + U+3000 + "绪论" 这种
 *   用全角空格对齐的标题不会被误伤。
 */

/** 拼接处：句末标点 + 全角空格（或两格以上半角空格）。标点本身留在前一段。 */
const JOINED_AT = /[？?！!。；;．]\s*(?:\u3000+| {2,})\s*/g

/** 把一条"其实不止一条"的问题拆开（拆不开就原样返回一条）。 */
function splitJoined(text: string): string[] {
  const parts: string[] = []
  let cursor = 0
  JOINED_AT.lastIndex = 0
  for (let match = JOINED_AT.exec(text); match; match = JOINED_AT.exec(text)) {
    // `match[0]` 的第一个字符就是句末标点，所以切点是 `match.index + 1`
    parts.push(text.slice(cursor, match.index + 1))
    cursor = match.index + match[0].length
  }
  parts.push(text.slice(cursor))
  return parts
}

/**
 * 一排推荐问题：拆开粘在一起的、去掉空白与重复项，顺序照旧（后端给的就是随机的）。
 *
 * 返回的每一条都是**原文**（只吃掉了拼接处的空白），可以安全地填进输入框发出去。
 */
export function splitSuggestions(list: readonly string[]): string[] {
  const out: string[] = []
  for (const item of list) {
    for (const part of splitJoined(item)) {
      const clean = part.trim()
      if (clean && !out.includes(clean)) out.push(clean)
    }
  }
  return out
}
