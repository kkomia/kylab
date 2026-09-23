/**
 * 对话页的**纯逻辑层**（React 迁移 P1）。
 *
 * 四个模块，与旧 Vue 的四个 composable 一一对应（文件名也对应，方便逐条对照）：
 *
 * | 这里 | 旧实现 | 内容 |
 * | --- | --- | --- |
 * | `turns.ts` | `composables/useChatTurns.ts` | 回合组织、过程面板数据、引用摘要、降级说明、收起态记忆（全是纯函数） |
 * | `liveTurn.ts` | `composables/useLiveTurn.ts` | 正在跑的那一轮（zustand store）+ 断线重连状态机 |
 * | `markdown.tsx` | `composables/useMarkdown.ts` | 回答渲染（react-markdown + 规则）与行内引用徽标 |
 * | `latex.ts` | `composables/useLatex.ts` | 行内 LaTeX 的识别规则 + KaTeX 渲染 |
 *
 * 用法与"哪儿与旧实现不一样"写在同目录的 `README.md` 里。
 * 这一层不认识任何页面组件；反过来，页面只该通过这里拿对话的数据与渲染。
 */

export * from './turns'
export * from './liveTurn'
export * from './latex'
export * from './markdown'
