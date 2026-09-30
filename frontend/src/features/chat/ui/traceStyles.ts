/**
 * 对话域里**还活在用**的那几组类名（原 400 行家族只剩这些，2026-09-30 重做后收编）。
 *
 * 旧那套（`STEP_*` / `TRACE_FOLD*` / `THINK_*` / `RAW_LABEL`…）随 TracePanel /
 * TraceStepRow / Fold 的退役一起删了——工具链块的排版在 `flow.css`，与这里无关。
 * **留下来的是两份被复用的取值**：
 *
 * 1. **工具原文**（`RAW_BODY` / `RESULT_*`）：`StepResult` 的三档渲染器共用——
 *    换档不许把限高换掉（后端已把返回裁到 2000 字，一屏里连着展开十条仍是一屏正文墙）；
 * 2. **站点牌**（`SITE_*`）：`WebSiteList` 在用，尺寸用 em（跟着行自己的字号走）、
 *    真 logo 与字母牌**同尺寸**（异步换图不许让那一行抖一下）。
 */
const RAW_MAX_HEIGHT = 'max-h-[220px]'

export const RAW_BODY =
  `m-0 p-[var(--space-2)] ${RAW_MAX_HEIGHT} overflow-auto rounded-[var(--radius-control)] ` +
  'bg-[var(--bg-subtle)] font-mono text-[length:var(--text-micro-size)] ' +
  'leading-[var(--line-code)] text-[var(--text-secondary)] whitespace-pre-wrap ' +
  '[overflow-wrap:anywhere]'

export const SITE_STRIP =
  'mt-[var(--space-1)] flex flex-wrap items-center gap-x-[var(--space-2)] gap-y-[var(--space-1)]'

export const SITE_CHIP =
  'inline-flex items-center gap-[var(--space-1)] text-[length:var(--text-micro-size)] text-[var(--text-tertiary)]'

/** 那枚"牌子"：一枚字母/字（认出来的站点）或一枚通用地球（没认出来的）。 */
export const SITE_TILE =
  'inline-flex h-[1.2em] min-w-[1.2em] items-center justify-center rounded-[var(--radius-control)] ' +
  'border border-[var(--border)] bg-[var(--bg-subtle)] px-[0.15em] text-[0.82em] leading-none ' +
  'text-[var(--text-secondary)]'

/** 真实 logo 那一格：外框尺寸与 `SITE_TILE` 逐字相同（1.2em 见方），换图不抖。 */
export const SITE_TILE_IMG =
  'inline-block h-[1.2em] w-[1.2em] shrink-0 rounded-[var(--radius-control)] object-contain'

/** 多出来的站点收成 `+N`。 */
export const SITE_MORE = 'text-[length:var(--text-micro-size)] text-[var(--text-quaternary)]'

/**
 * 表格那一族：表格线用 `--border-hairline`（与别的分隔线同一档），表头底用 `--bg-subtle`
 * （与原文块同一个底），表头 `sticky` 是刻意的——限高里滚动时列名得一直看得见。
 */
export const RESULT_TABLE_WRAP = `m-0 ${RAW_MAX_HEIGHT} overflow-auto rounded-[var(--radius-control)] bg-[var(--bg-subtle)]`

export const RESULT_TABLE =
  'w-full border-collapse text-[length:var(--text-micro-size)] leading-[var(--line-code)] ' +
  'text-[var(--text-secondary)]'

export const RESULT_TH =
  'sticky top-0 border-b border-[var(--border-hairline)] bg-[var(--bg-subtle)] ' +
  'px-[var(--space-2)] py-[var(--space-1)] text-left font-medium text-[var(--text-primary)]'

export const RESULT_TD =
  'border-b border-[var(--border-hairline)] px-[var(--space-2)] py-[var(--space-1)] align-top ' +
  'break-words [overflow-wrap:anywhere]'
