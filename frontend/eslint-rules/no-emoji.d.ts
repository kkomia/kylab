/**
 * 本地 ESLint 规则的类型声明。
 *
 * 规则本体是 `no-emoji.js`（ESLint 规则用 JS 写，无需构建），
 * 但测试文件用 TS 导入它，缺少声明会命中 TS7016（隐式 any）。
 */
import type { Rule } from 'eslint'

declare const noEmojiRule: Rule.RuleModule
export default noEmojiRule
