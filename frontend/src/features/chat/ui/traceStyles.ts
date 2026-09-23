/**
 * 过程面板那一族的类名（旧 `components/chat/trace-row.css` 的 Tailwind 版）。
 *
 * 为什么收在一个文件里而不是散在组件中：这一行有**两个渲染位置**——单步
 * （`TraceStepRow`）与"同类工具并成的一组"的表头（`TracePanel`），
 * 而旧前端正是在这里栽过一次：v0.26 把单步的样式连着标记一起搬进组件时，
 * 组那一行没跟着搬，于是它的图标掉了圆底、标签起始线也上下错开
 * （用户报的"UI 排版有问题"，截图里「联网搜索 12 次」那一行就是）。
 * 一份取值、两处引用，就不会再有第二次。
 *
 * 取值全部来自 `src/styles/tokens.css` 的令牌（颜色、间距、圆角、字号），
 * 没有一处硬编码色值或像素——这是《前端设计规范》§2/§4 的硬要求。
 */

/** 一行的外壳：图标位 + 正文列。 */
export const STEP_ROW = 'flex items-start gap-[var(--space-3)] [&+&]:mt-[var(--space-3)]'

/** 图标位：21px 的圆底，圆心正落在时间轴那条竖线上。 */
export const STEP_ICON =
  'relative z-[1] inline-flex shrink-0 items-center justify-center w-[21px] h-[21px] ' +
  'rounded-[var(--radius-pill)] border border-[var(--border)] bg-[var(--bg-canvas)] ' +
  'text-[var(--text-tertiary)]'

/**
 * 按种类上色（P2-1，照 ZCode：卡片的样子由 kind 决定，不由工具名）。
 *
 * 规则只落在图标那一格：标签与结论一律是灰的——强调只在小面积上用，
 * 一排彩色的字会把过程面板变成告示牌，而用户要的是"一眼扫出这几步分别干了什么"。
 */
const KIND_ICON: Record<string, string> = {
  // 找东西（检索、联网、抓页）与会话上下文：信息蓝
  search: 'text-[var(--status-info)] bg-[var(--status-info-soft)] border-transparent',
  session: 'text-[var(--accent-text)] bg-[var(--accent-soft)] border-transparent',
  message: 'text-[var(--status-info)] bg-[var(--status-info-soft)] border-transparent',
  // 写入 / 产出：绿
  write: 'text-[var(--status-success)] bg-[var(--status-success-soft)] border-transparent',
  // 删除：红
  delete: 'text-[var(--status-danger)] bg-[var(--status-danger-soft)] border-transparent',
  // 在这台机器上跑东西：橙（警示）
  exec: 'text-[var(--status-warning)] bg-[var(--status-warning-soft)] border-transparent',
  // 技能：紫
  skill: 'text-[var(--accent-2-text)] bg-[var(--accent-2-soft)] border-transparent',
}

/** `read` 与 `tool` 不加色（中性灰），是刻意的：读一眼与不认识的外部工具都该安静。 */
export function stepIconClass(icon: string): string {
  return `${STEP_ICON} ${KIND_ICON[icon] ?? ''}`
}

/** 正文列。 */
export const STEP_BODY = 'min-w-0 pt-px'

/** 标签：12px 二级灰；可点的那一版只是把光标与悬停提亮交给按钮。 */
export const STEP_LABEL = 'm-0 text-[length:var(--text-micro-size)] text-[var(--text-secondary)]'

/** 可点的标签（标签 + 箭头）：不加下划线也不加底色，整块面板里已经有一层层级了。 */
export const STEP_TOGGLE =
  'inline-flex items-center gap-[var(--space-1)] p-0 border-none bg-transparent font-[inherit] ' +
  'cursor-pointer [transition:var(--transition-ui)] hover:text-[var(--text-primary)]'

/** 箭头：展开时转 180°。 */
export function caretClass(open: boolean): string {
  return `shrink-0 text-[var(--text-quaternary)] transition-transform [transition:transform_var(--motion-fast)_var(--motion-ease)] ${
    open ? 'rotate-180' : ''
  }`
}

/** 结论那一行：独占一行、三级灰。 */
export const STEP_DETAIL =
  'block mt-[var(--space-pair)] text-[length:var(--text-micro-size)] text-[var(--text-tertiary)] ' +
  'break-words [overflow-wrap:anywhere]'

/** 没有新增资料的检索轮次：压暗一档（它和"找到了新东西"的几轮价值不同）。 */
export const STEP_EMPTY_DIM = 'opacity-70'

/** 原文块（入参 / 返回）：限高滚动，动辄上千字，全铺出来会把面板变成一屏 JSON。 */
export const RAW_LABEL =
  'mt-[var(--space-2)] mb-[var(--space-1)] m-0 text-[length:var(--text-micro-size)] text-[var(--text-quaternary)]'

export const RAW_BODY =
  'm-0 p-[var(--space-2)] max-h-[220px] overflow-auto rounded-[var(--radius-control)] ' +
  'bg-[var(--bg-subtle)] font-mono text-[length:var(--text-micro-size)] ' +
  'leading-[var(--line-code)] text-[var(--text-secondary)] whitespace-pre-wrap ' +
  '[overflow-wrap:anywhere]'

/**
 * 思考正文那一块（v0.28，第二批评审 A3）。
 *
 * 三件事要同时成立，才读得出一句"这是过程、不是答案"：
 *
 * 1. **它得是一个块**。原先思考正文直接套 `RAW_BODY`（给工具原文用的那一族），
 *    而承载它的是 `LinkText` 的 `<span>`——`span` 是 inline，`max-height` /
 *    `overflow` 在 inline 上**不生效**，背景也只跟着每一行文字跑，看起来像被荧光笔
 *    划过的几行，而不是一块内容；
 * 2. **缩进 + 独立底色 + 左侧一道线**：与正文（同一列、无底色的纯文字）分开；
 * 3. **比正文更紧**：字号 `--text-micro-size`（12，正文 15）、行高 `--line-code`（1.6，
 *    正文 1.7），段与段之间 `--space-2`（8px，正文 `--space-3` 12px）。
 *    段落由 `thinkingParagraphs` 切开后逐段排——原先靠空行的整行空档撑着，
 *    过程比答案还疏。
 */
export const THINK_BLOCK = `mt-[var(--space-2)] flex flex-col gap-[var(--space-2)] rounded-[var(--radius-control)] border-l-2 border-[var(--border-strong)] bg-[var(--bg-subtle)] py-[var(--space-2)] pr-[var(--space-3)] pl-[var(--space-3)]`

/** 思考正文的**一段**：`pre-wrap` 保住段内的换行，`min-w-0` 让长串能断行。 */
export const THINK_PARAGRAPH = `block min-w-0 text-[length:var(--text-micro-size)] leading-[var(--line-code)] text-[var(--text-secondary)] whitespace-pre-wrap [overflow-wrap:anywhere]`

export const RAW_NOTE =
  'ml-[var(--space-2)] text-[length:var(--text-micro-size)] text-[var(--text-quaternary)]'

export const RAW_MORE =
  'mt-[var(--space-1)] p-0 text-[length:var(--text-micro-size)] text-[var(--accent-text)] ' +
  '[transition:var(--transition-ui)] hover:underline'
