import { RuleTester } from 'eslint'
import { describe, it } from 'vitest'

import noEmojiRule from '../../../eslint-rules/no-emoji.js'

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
})

// 用码点构造字符，避免测试源码自身出现 emoji（否则会被 kylab/no-emoji 自己拦下）
const PARTY = String.fromCodePoint(0x1f389)
const HUNDRED = String.fromCodePoint(0x1f4af)
const ARROW = String.fromCodePoint(0x2192)
const EM_DASH = String.fromCodePoint(0x2014)

describe('kylab/no-emoji', () => {
  it('拦截字符串与模板字符串中的 emoji，放行普通文本与排版符号', () => {
    ruleTester.run('no-emoji', noEmojiRule, {
      valid: [
        { code: "const label = '任务已完成'" },
        { code: `const arrow = '${ARROW} 下一步'` },
        { code: `const range = '2020${EM_DASH}2024'` },
      ],
      invalid: [
        {
          code: `const done = '解析完成 ${PARTY}'`,
          errors: [{ messageId: 'noEmoji' }],
        },
        {
          code: `const score = \`满分 ${HUNDRED}\``,
          errors: [{ messageId: 'noEmoji' }],
        },
      ],
    })
  })
})
