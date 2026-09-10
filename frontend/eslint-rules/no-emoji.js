/**
 * 自定义 ESLint 规则：kylab/no-emoji
 *
 * 依据《前端设计规范 v0.1》§3（图标系统）与 §8（禁止项）、
 * 《项目工程规范 v0.1》§4.3（风格纪律）：
 * **禁止 emoji 出现在任何源码字符串中**，图标只能引 components/icons/ 下的内联 SVG。
 *
 * 检查范围：字符串字面量、模板字符串、Vue 模板文本。
 * 不检查注释——禁令针对 UI 呈现，注释不进入界面。
 */

// 与 scripts/scan_emoji.py 的区段保持一致（两个扫描器的范围必须同一套）。
// 变体选择符 FE00-FE0F 段是刻意保留的：键帽类 emoji（如数字加 FE0F 组合）只有靠它才拦得住，
// 但核心规则 no-misleading-character-class 会把它误判为多码位字符类，故就地屏蔽。
const EMOJI_RE =
  // eslint-disable-next-line no-misleading-character-class
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{2190}-\u{21FF}]/u

// 文本排版合法字符白名单（引号、破折号、省略号、箭头等），不误报
const WHITELIST = new Set([
  '\u201C',
  '\u201D',
  '\u2018',
  '\u2019',
  '\u2014',
  '\u2013',
  '\u2026',
  '\u00B7',
  '\u2022',
  '\u2039',
  '\u203A',
  '\u00AB',
  '\u00BB',
  '\u2190',
  '\u2192',
  '\u2191',
  '\u2193',
  '\u2194',
])

/** @type {import('eslint').Rule.RuleModule} */
const noEmojiRule = {
  meta: {
    type: 'problem',
    docs: {
      description: '禁止 emoji 出现在源码字符串中（UI 全链路禁 emoji）',
      url: 'https://gitee.com/kkomia/kylab',
    },
    schema: [],
    messages: {
      noEmoji:
        '禁止使用 emoji（{{char}}，U+{{code}}）。图标请用 components/icons/ 下的内联 SVG，见《前端设计规范》§3。',
    },
  },

  create(context) {
    function check(node, value) {
      if (typeof value !== 'string') return
      for (const char of value) {
        if (!EMOJI_RE.test(char) || WHITELIST.has(char)) continue
        context.report({
          node,
          messageId: 'noEmoji',
          data: {
            char,
            code: char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'),
          },
        })
      }
    }

    return {
      Literal(node) {
        check(node, node.value)
      },
      TemplateElement(node) {
        check(node, node.value.raw)
      },
      // Vue 模板里的纯文本节点（由 vue-eslint-parser 提供）
      VText(node) {
        check(node, node.value)
      },
    }
  },
}

export default noEmojiRule
