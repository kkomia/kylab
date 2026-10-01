/**
 * 对话域里**还活在用**的那几组类名（原 400 行家族只剩这些，2026-09-30 重做后收编）。
 *
 * 旧那套（`STEP_*` / `TRACE_FOLD*` / `THINK_*` / `RAW_LABEL`…）随 TracePanel /
 * TraceStepRow / Fold 的退役一起删了——工具链块的排版在 `flow.css`，与这里无关。
 * **留下来的只剩一件**：
 *
 * 1. **工具返回的表格**（`RESULT_*`）：`StepResult` 的表格那一档在用——
 *    换排版不许把限高换掉（后端已把返回裁到 2000 字，一屏里连着展开十条仍是一屏正文墙）；
 *    （原先还有一条 `RAW_BODY` 给"等宽原文"那一档，R4 起那一档由 `StepPayload` 的
 *    Response 面板承担——浅灰圆角面板 + 行号槽，所以那一条随之下线。）
 *
 * 改前还有第二件——**站点牌**（`SITE_STRIP` / `SITE_CHIP` / `SITE_TILE` / `SITE_TILE_IMG` /
 * `SITE_MORE`）：那是 `WebSiteList`（联网搜索行尾那一排带站点名的牌子）用的。2026-10-01
 * 用户批注（批四）把它整档撤掉（原话"联网搜索这里不要显示网址啊，这个去掉"），
 * 于是这五个常量连同那个组件一并删了——留下的那一档抓页 favicon（`WebSiteIcons`）
 * 用的是 `flow.css` 里的 `.ch-hit-logo`，与两张清单里那一枚同款，本来就不经过这里。
 */
const RAW_MAX_HEIGHT = 'max-h-[220px]'

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
