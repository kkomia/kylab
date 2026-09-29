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
 * 行与行之间用 `--space-2`（8px，原先是 `--space-3` 12px）：这一族是**元信息**，
 * 行距不该与正文的段距同宽——正文段距正是 `--space-3`（`chat.css` 的 `.md-p`），
 * 过程行之间再用 12px，扫起来就与"一段正文"的间隔一样松了。
 */
const STEP_ROW_SHELL = 'flex items-start [&+&]:mt-[var(--space-2)]'

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

/**
 * 图标位：21px 的圆底。
 *
 * （旧实现那一列是"时间轴"—— 步骤之间连着一条竖线，圆心要对齐那条线；
 * 这一版**没有竖线**，圆底只负责把图标与文字对齐。）
 *
 * **面板头也用这一个类名**（2026-09-29 用户："这不还是没对齐吗"）：那之前面板头是
 * 「箭头 12 + 间距 4 + 图标 13 + 间距 4」凑出 33 得到 461 的——文字对了，但那条
 * 13px 的图标落在 444，比这一列右 16px，于是面板头多出一条说不清来历的竖线。
 * 现在面板头与行内同构：**同一个 21px 圆底 + 同一个 `--space-3`（12）** →
 * 图标左边缘 428 / 中心 438.5、文字 461，三样都落在行内那几条线上（真浏览器实测见
 * `.shots/trace-cleanup/`）。
 */
export const STEP_ICON =
  'relative z-[1] inline-flex shrink-0 items-center justify-center w-[21px] h-[21px] ' +
  // 纵向：**图标中心 = 首行行盒中心**（用户 2026-09-29："你的图标大小比文字要高啊，肯定要用中心对齐"）。
  // 为什么不是 items-center：那是按**整个文字块**居中，标签换行（组行标题实测会换到两行）时
  // 图标会跟着块中心下沉，反而更歪；所以留着父级的 items-start，只在图标上补一个精确偏移：
  //   首行行盒高 = --text-meta-size × --line-ui = 14 × 1.47 = 20.58px（tokens.css 实测值，
  //   标签那一档显式 leading-[var(--line-ui)]）；STEP_BODY 有 pt-px(1px)，所以
  //   偏移 = (20.58 − 21) / 2 + 1 = +0.79px。
  // 真浏览器量法（另一条 lane 给的口径）：行盒中心 ≠ 字形盒中心（14px 字号 Range 给 16px 字形盒，
  // 两者中心差 ≈2.3px）—— 所以必须按行盒量，否则会把"已经对齐"看成差 2px。
  'mt-[calc(var(--text-meta-size)*var(--line-ui)/2-10.5px+1px)] ' +
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

/*
 * 「全部展开 / 全部收起」那两条类名（`TRACE_BULK_BAR` / `TRACE_BULK`）**已随功能一起删掉**
 * （2026-09-29，用户要求把批量入口去掉，只留单行/单组各自开合）。
 * 这里只留这一句：见到旧代码或旧文档引用它们时，是"删了"，不是"忘了"。
 */

/** 正文列。 */
export const STEP_BODY = 'min-w-0 pt-px'

/**
 * 标签：14px（`--text-meta-size`）二级灰。
 *
 * 这是"过程 vs 正文"那条层级线的上半截：正文是 `--text-body-size`(15) + `--text-primary`，
 * 过程标签落在**更小一档的字号 + 更淡一档的颜色**上，扫过去才分得清"这是它干的过程"
 * 与"这是回答本身"（用户原话："工具调用过程的字体设计跟正文意义导致没区分度"）。
 * 行高显式给 `--line-ui`(1.47)：这一族是元信息，不该跟着正文那档 1.7 走。
 *
 * `text-left` 与 `STEP_TOGGLE` 同一处理由（见那一段），两处是同一个视觉档。
 */
export const STEP_LABEL =
  'm-0 text-left text-[length:var(--text-meta-size)] text-[var(--text-secondary)] leading-[var(--line-ui)]'

/**
 * 可点的标签（标签 + 箭头）：字号与颜色与 `STEP_LABEL` **同一档**。
 *
 * **这一档原先漏了**：这里只有 `font-[inherit]`，一个字号/颜色都没给，于是按钮版标签
 * 继承到父级——实测 computed 是 15px / `rgba(0, 0, 0, 0.9)`，与答案段落**逐项相同**
 * （字号、颜色、字重全一样）。用户截图里"跟正文没区分度"的那些行就是它
 * （`执行命令` / `查看上传的文件` / `思考` / 组行的 `联网搜索 11 个关键词`）。
 * 单步行与组行共用这一个类名，所以改这一处两处一起变。
 *
 * 去掉 `font-[inherit]` 是刻意的：`font: inherit` 会把字号/字重/行高一起交回父级，
 * 与上面那两笔冲突，**谁赢取决于打包后的声明顺序**（同一层里逐条比先后）；
 * 字体族交给 preflight（`button { font: inherit }`）就够了——那一条在 base 层，
 * utilities 里的字号/行高照样压得住它（实测字体族与正文段落逐字相同）。
 *
 * ## `text-left` 不是装饰（D11-①，2026-09-29 走查："标签与文字没对齐"）
 *
 * `<button>` 的 UA 默认是 **`text-align: center`**，而这一档的标签**会换行**：
 * 组行那句「联网搜索 11 个关键词 · 2025国庆 重庆到遵义 高速救援…」实测两行。
 * 不写 `text-left` 时每一行**各自居中**——真浏览器量到的数字：
 * 首字形落在 **x=467.28**（容器左边缘是 461，多出 6.28）、第二行落在 **x=732.44**，
 * 而它下面那排站点行 / 结论都在 **461**。看上去就是"标签与文字没对齐"
 * （证据：`.shots/d11b-align/before*.json` 与 `glyph.json`）。
 * 单步行那些短标签不换行，所以只有长标题（组行）看得出这一条。
 *
 * 顺手钉住它的用例：`frontend/tests/chat-trace-step-row.test.tsx` 里
 * 「标签类名带 text-left」那两条（类名级，不用起浏览器）。
 */
export const STEP_TOGGLE =
  'inline-flex items-center gap-[var(--space-1)] p-0 border-none bg-transparent ' +
  'text-left text-[length:var(--text-meta-size)] text-[var(--text-secondary)] ' +
  'leading-[var(--line-ui)] cursor-pointer [transition:var(--transition-ui)] ' +
  'hover:text-[var(--text-primary)]'

/** 箭头：展开时转 180°。 */
export function caretClass(open: boolean): string {
  return `shrink-0 text-[var(--text-quaternary)] transition-transform [transition:transform_var(--motion-fast)_var(--motion-ease)] ${
    open ? 'rotate-180' : ''
  }`
}

/**
 * 结论那一行：独占一行、三级灰、比标签再小一档（12 对 14）。
 *
 * 层级是"标签说做了什么、结论说做成了什么"：结论是标签的注解，所以更小更淡，
 * 而两者都在正文（15px / 一级色）之下。这一档本来就在 `--text-micro-size` +
 * `--text-tertiary` 上（真浏览器实测 12px / `rgba(0, 0, 0, 0.55)`），
 * 本轮要修的是上面那个**漏了字号**的标签，不是它。
 */
export const STEP_DETAIL =
  'block mt-[var(--space-pair)] text-[length:var(--text-micro-size)] text-[var(--text-tertiary)] ' +
  'break-words [overflow-wrap:anywhere]'

/** 没有新增资料的检索轮次：压暗一档（它和"找到了新东西"的几轮价值不同）。 */
export const STEP_EMPTY_DIM = 'opacity-70'

/**
 * 「这一步 / 这一组**还在跑**」那三个字（2026-09-29 用户："那个蓝色循环圈没有用"）。
 *
 * 删的是那枚转圈（`stepIcons.StepSpinner`），**不是状态**：状态改成一句静态文字，
 * 排在标签之后。"还在跑"是**用户在等的时候唯一要看的读数**（见 `isRunningStep`），
 * 所以它不能只留在 `data-running` 那种机器属性上——那等于回到了"看不出在跑"。
 *
 * 为什么是文字而不是换一枚静态图标：图标那一格（21px 圆底）已经被"这一步干了什么"
 * 占着，再塞一枚就得挤在右下角；而右下角那格是**状态灯**（失败/被拦/待确认）的位置，
 * 两者共用一格本身就已经是一次妥协。文字不进那一格，也不参与"跑完时往左跳"那笔账
 * （它在行尾，跑完就消失，左边的图标与标签一个字都不动）。
 *
 * 字号与结论同档（`--text-micro-size`）、颜色用最淡那档：它是元信息，不该抢标签的注意力。
 */
export const STEP_RUNNING =
  'shrink-0 text-[length:var(--text-micro-size)] text-[var(--text-quaternary)]'

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

/**
 * 真实 logo 那一格（D11-②）：**外框尺寸与 `SITE_TILE` 逐字相同**（1.2em 见方）。
 *
 * 为什么必须同尺寸：图标是**异步**取回来的（先画字母牌、拿到了再换成图），两者只要差
 * 一点，这一行就会在加载完成的那一刻抖一下——而面板里每一行都会经历那一下。
 * 所以图收在同一个 1.2em 方框里，用 `object-contain`（不裁不拉伸）。
 */
export const SITE_TILE_IMG =
  'inline-block h-[1.2em] w-[1.2em] shrink-0 rounded-[var(--radius-control)] object-contain'

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
