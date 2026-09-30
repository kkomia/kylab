/**
 * 那一排触发器的**薄壳**（那一排与各处菜单共用的取值）。
 *
 * 抽出来只有一条理由，而且是用户明确报过的毛病：**同一行里两个高度**。
 * 取值只有一处（`--control-height` + `--radius-pill`），谁加进来的控件都跟它对齐。
 *
 * **2026-09-27 摘掉了这里的 `Dropdown` 组件**：它是"触发器 + 面板"的整壳，
 * 而用它最后的两处（命令执行策略、任务模式）一个折进了权限轴、一个回到了设置页。
 * 留着的三个 `MENU_*` 是**取值**（面 / 项 / 勾），那一排与各处的菜单共用。
 */

/**
 * 输入框那一排控件的**统一外形**（高度、形状、底色、悬停）。
 *
 * 高度与形状都收在这里一处：v0.28 的第二批评审（A4）量出来那一行里有四种形状——
 * 12px 圆角的浅底块、没有容器的裸开关、方形图标按钮、实心圆发送键。
 * 现在这一排的**菜单类控件**（加号 / 执行策略 / 模式 / 选库 / 模型 / 上下文仪表）
 * 全部走这一份取值：胶囊 + `--bg-subtle` + 同一种悬停。
 * （发送键与知识库开关也在这条线上，只是各自还有"开关/实心"要表达。）
 *
 * 横内边距 `space-2`（8px，第三批评审 A②）而不是 `space-3`：那一行六个胶囊要在一张
 * 768 的卡片里排成一行，12px 时整行要 751px、卡片只有 742px——多出来的十几像素正是
 * "整格折到第二行"的来源。收窄这一处（六个胶囊同时跟上，仍是一种形状），整行才有
 * 余量。**2026-09-24 起读数那一格换成环 + 比率**（`ContextGauge`，16px 的环替掉原来
 * 那条 28px 的占用条），它自己从 ~111px 收到 ~70px，是这一排里省得最多的一格；
 * 再往后（更大字号、更窄的窗口）仍由左组折行接住。
 *
 * 末尾那两条 `disabled:` 是**必须的**：模型那一颗在"一个可用模型都没有"时是 `disabled`
 * （`ModelPicker` 里那个判据），而禁用只写 `disabled` 属性的话外形一点不变——
 * 用户点下去没有反应，只会以为"这个按钮坏了"。
 */
export const CONTROL_TRIGGER =
  'inline-flex h-[var(--control-height)] cursor-pointer items-center gap-[var(--space-1-5)] ' +
  'rounded-[var(--radius-pill)] border border-transparent bg-[var(--bg-subtle)] px-[var(--space-2)] ' +
  'text-[length:var(--text-meta-size)] font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] data-[state=open]:bg-[var(--bg-hover)] data-[state=open]:text-[var(--text-primary)] disabled:cursor-default disabled:opacity-50'

/**
 * 菜单面（浮层的底、边框、圆角、内边距）——**菜单类控件共用一份**。
 *
 * 2026-09-27 从 `ComposerControls` 搬到这里：那一排收窄之后，命令与模式两档搬进了
 * 「+」菜单的子菜单，而子菜单用的还是这张面。两处各写一份的话，浮层的圆角或内边距
 * 改一次就要记得改两处（"同一行两个高度"那个毛病的同型）。
 *
 * 进出场也收在这一处：chat 里那四个菜单**直连 `@radix-ui/react-dropdown-menu`**
 * （绕过了 `ui/dropdown-menu.tsx` 那份自带 `data-[state=open]:animate-in` 的封装），
 * 于是弹窗 200ms、抽屉 300/500ms，而菜单是 0ms——一屏里菜单"凭空出现"，看起来比别处
 * 生硬。150ms 是 `tokens.css` 的 `--motion-fast` 档，与列表行/底色的状态切换同速：
 * 菜单是"轻"的那一类，不该跟弹窗同一档（Radix 靠这段动画名把关闭也演完再卸载）。
 */
export const MENU_PANEL =
  'z-50 min-w-[220px] max-h-[420px] overflow-y-auto rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--bg-menu)] p-[var(--space-2)] shadow-[var(--shadow-popover)] duration-150 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-1 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-1'

/** 菜单项的形状（+ 菜单、模型菜单、命令/模式子菜单共用）。 */
export const MENU_ITEM =
  'flex w-full cursor-pointer items-center gap-[var(--space-2)] rounded-[var(--radius-control)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-meta-size)] text-[var(--text-primary)] outline-none data-[highlighted]:bg-[var(--bg-hover)]'

/** 勾的位置**永远占着**（没选中的那些也留一格）：否则选中项一变，整列文字会左右跳。 */
export const MENU_CHECK = 'inline-flex w-[14px] shrink-0 text-[var(--accent)]'
