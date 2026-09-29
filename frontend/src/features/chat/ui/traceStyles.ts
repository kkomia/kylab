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

/**
 * 一行的外壳：图标位 + 正文列。
 *
 * 行内间距（图标位与正文列之间那一笔）**父子两档不一样**，所以在下面各给一份，
 * 而不是在子行上再补一层左内边距：两种做法叠起来就是用户报的"缩进得太多了"。
 */
const STEP_ROW_SHELL = 'flex items-start [&+&]:mt-[var(--space-3)]'

/** 父行（单独一步 / 同类工具并成的一组）：21px 的图标沟配 `--space-3`。 */
export const STEP_ROW = `${STEP_ROW_SHELL} gap-[var(--space-3)]`

/**
 * 子行（一组展开后的一次调用）：图标沟换成一个 5px 圆点，行内间距收到 `--space-1`。
 *
 * 为什么必须是另一档而不是照抄父行：子行的 `<li>` 起点已经在父行**文字列**上
 * （`ol` 在 `STEP_BODY` 里），所以子行里每一笔横向留白都是实打实的缩进。
 * 照抄父行的 `--space-3`(12) 再加原来 `li` 上的 `--space-4`(16) 内边距与圆点的
 * `mx-[8px]`，加起来就是 49px——用户说的"一层套一层"。
 *
 * 数字是在真浏览器里量的（`.shots/dsh-indent-probe.cjs`，会话 `conv_615c4ac504fe`）：
 * 改前子行正文列比父行文字起点深 49px（12 行内间距 + 16 内边距 + 8 圆点左外边距
 * + 5 圆点 + 8 圆点右外边距），改后 9px（4 行内间距 + 5 圆点）——用户要的
 * "可以有一点缩进 但是不能太多"，上限就是这 ~10px。
 */
export const STEP_ROW_CHILD = `${STEP_ROW_SHELL} gap-[var(--space-1)]`

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

/**
 * 过程面板里**每一处折叠**的容器（§12.335：动效优先，三处共用一份取值）。
 *
 * 用它的地方：面板（`TracePanel`）、组（同一文件里的组行）、单步的原文与思考
 * （`TraceStepRow`）——都在 `ui/Fold.tsx` 那一层引用，所以这里只有类名。
 *
 * 行高走 `grid-template-rows`（`0fr ↔ 1fr`），高度由内容自己决定——不量像素，
 * 内容长短变了也不用跟着改（`min-h-0` + `overflow-hidden` 让 0fr 时真的贴成 0）。
 *
 * 过渡写在**类里**、不写在 `style` 里：内联样式优先级更高，`motion-reduce:transition-none`
 * 就压不住它，"减少动态效果直落"那一半会失效（与 `ComposerControls` 那条进度圈
 * 同一条教训）。`grid-template-rows` 的内联值是另一件事（开合态只有组件知道）。
 *
 * 200ms + `cubic-bezier(0.4, 0, 0.2, 1)`：开合动效五家都收敛在 200ms（调研 §4.8），
 * 曲线就是本仓发送按钮那一档（`tokens.css` 的 `--motion-send`）。
 *
 * **展开与收起两个方向都过渡**（§12.335 推翻了"收起直落"那个旧取舍）：内容由 `Fold`
 * 按"展开过一次就常驻"挂着，0fr ↔ 1fr 两头都有东西可以动；DOM 开销怎么挡、
 * "从没展开过的那一轮"为什么仍然零成本，见 `Fold.tsx` 的头注。
 */
export const TRACE_FOLD =
  'grid transition-[grid-template-rows] duration-200 ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none'

/** 折叠容器的内层：0fr 时要能真的收到 0（自动最小尺寸是 grid 行不肯收的常见原因）。 */
export const TRACE_FOLD_BODY = 'min-h-0 overflow-hidden'

/** 面板内容与开关那一行之间的间距（原先在条件渲染的那一层上）。 */
export const TRACE_FOLD_CONTENT = 'mt-[var(--space-3)]'

/**
 * 面板内容顶上那一行「全部展开 / 全部收起」（调研 §5.2 P2）。
 *
 * 右对齐一行小字，与时间线隔开一点：它是**整块的批量动作**，不是某一行的一部分，
 * 所以既不上"执行过程"那一行（那是面板的开关），也不与「加载更多」同排（那是分页）。
 */
export const TRACE_BULK_BAR = 'mb-[var(--space-2)] flex justify-end gap-[var(--space-3)]'

/**
 * 批量动作那两个文字按钮。
 *
 * **无障碍名字就用可见文字本身**（不另加 `aria-label`）：名字与可见文字一致，
 * 语音控制才点得到"全部展开"；作用范围写在注释与用例里，不靠一个读屏器才听得到的名字。
 */
export const TRACE_BULK =
  'cursor-pointer p-0 text-[length:var(--text-micro-size)] text-[var(--accent-text)] ' +
  '[transition:var(--transition-ui)] hover:underline'

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

/**
 * 原文那一块的限高（220px，P2-1 就定下的）：后端已把返回裁到 2000 字，
 * 一屏里连着展开十条仍是一屏正文墙。
 *
 * 提成一个常量是**给"返回"的几种渲染器共用**（等宽 `<pre>`、缩进 JSON、真表格）：
 * 换档不许把限高换掉——那是"这一段是原文、看一眼就好"的同一套取舍。
 */
const RAW_MAX_HEIGHT = 'max-h-[220px]'

export const RAW_BODY =
  `m-0 p-[var(--space-2)] ${RAW_MAX_HEIGHT} overflow-auto rounded-[var(--radius-control)] ` +
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

/**
 * 「这一步查了哪些站点」那一行（v0.56，§12.334 第二节）。
 *
 * 为什么是**行内一排小牌子**而不是一行一个：用户要的是"扫一眼知道在查哪些常见的网页"，
 * 一排紧凑的牌子才扫得动；字号与标签同级（`--text-micro-size`），不抢标签的位置。
 * 牌子本身是**本机站点表**给的（不拉 favicon，理由见 `model/webSites.ts`）。
 *
 * 尺寸用 em（跟着这一行自己的字号走），颜色与圆角全部取令牌
 * ——与这一族其余类名同一条纪律。
 */
export const SITE_STRIP =
  'mt-[var(--space-1)] flex flex-wrap items-center gap-x-[var(--space-2)] gap-y-[var(--space-1)]'

export const SITE_CHIP =
  'inline-flex items-center gap-[var(--space-1)] text-[length:var(--text-micro-size)] text-[var(--text-tertiary)]'

/** 那枚"牌子"：一枚字母/字（认出来的站点）或一枚通用地球（没认出来的）。 */
export const SITE_TILE =
  'inline-flex h-[1.2em] min-w-[1.2em] items-center justify-center rounded-[var(--radius-control)] ' +
  'border border-[var(--border)] bg-[var(--bg-subtle)] px-[0.15em] text-[0.82em] leading-none ' +
  'text-[var(--text-secondary)]'

/** 多出来的站点收成 `+N`。 */
export const SITE_MORE = 'text-[length:var(--text-micro-size)] text-[var(--text-quaternary)]'

export const RAW_MORE =
  'mt-[var(--space-1)] p-0 text-[length:var(--text-micro-size)] text-[var(--accent-text)] ' +
  '[transition:var(--transition-ui)] hover:underline'

/**
 * 返回是 **Markdown 表格**时的那张真表格（调研 §5.2 P2 的结果分派）。
 *
 * 与等宽 `<pre>` 同一个**限高常量**：换的是排版，不是"这一段是原文、看一眼就好"
 * 那套取舍（长表格照样在 220px 里自己滚）。
 *
 * 取值全部来自令牌：表格线用 `--border-hairline`（与别的分隔线同一档），
 * 表头底用 `--bg-subtle`（与原文块同一个底），单元格留白用 `--space-*`。
 * 表头 `sticky` 是刻意的：限高里滚动时列名得一直看得见，否则读第二屏就不知道哪一列是什么。
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
