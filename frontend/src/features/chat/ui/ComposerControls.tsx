/**
 * 输入卡片底部那一排控件（旧 `ChatView` 的 `.composer-left` / `.composer-right`）。
 *
 * 分工是用户定的（v0.19）：**左边是"给这一轮什么"**（加号、执行策略、模式、知识库），
 * **右边是"怎么生成 + 发出去"**（上下文仪表、模型与思考、发送/停止）。
 * 两类动作各占一端，扫视时不用在中间找。
 *
 * 所有控件共用一个高度（`--control-height`）**与一种形状**（胶囊 + 浅底）：
 * 同一行里差几个像素、或者一个是实心胶囊一个是裸文字，用户一眼就看出"大小不一"——
 * 旧前端为高度这件事专门加了那个令牌；v0.28 的第二批评审（A4）把**形状**也收齐了：
 * 原先「加号 / 执行策略 / 模式 / 选库」是 12px 圆角的浅底块，而「知识库」开关是
 * 一颗**没有容器的裸开关**（`border-radius: 0`、无底色），一行里两种形态。
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Bot, Check, ChevronDown, ChevronRight, Folder, Plus, Sparkles, Upload } from 'lucide-react'
import { useState } from 'react'

import { formatCount, formatPercent } from '@/lib/format'

import { CONTROL_TRIGGER } from './DropdownShell'
import { useChat } from '../runtime/ChatProvider'

/**
 * 触发器与菜单里那几个控件共用的一族类名。
 *
 * **取值只有一处**：`DropdownShell` 的 `CONTROL_TRIGGER`（薄壳那一份也要它，
 * 两处各写一遍正是"一行四个控件四种形状"的来源）。这里只是给它一个短名字。
 */
const TRIGGER = CONTROL_TRIGGER
const CONTENT =
  'z-50 min-w-[220px] overflow-hidden rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--bg-menu)] p-[var(--space-2)] shadow-[var(--shadow-popover)]'
const ITEM =
  'flex w-full cursor-pointer items-center gap-[var(--space-2)] rounded-[var(--radius-control)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-meta-size)] text-[var(--text-primary)] outline-none data-[highlighted]:bg-[var(--bg-hover)]'
const NOTE =
  'px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-meta-size)] text-[var(--text-tertiary)]'
/** 勾的位置**永远占着**（没选中的那些也留一格）：否则选中项一变，整列文字会左右跳。 */
const MARK = 'inline-flex w-[14px] shrink-0 text-[var(--accent)]'

/**
 * 「加号」：附件与技能都收在这里（照 Kimi 的输入框布局）。
 *
 * 拼成一个菜单而不是并排两个按钮：它们回答的是同一个问题——"这一轮除了问题本身，
 * 还要给它什么"。摆成两个按钮时工具条会比输入框还热闹。
 */
export function PlusMenu({
  onPickFiles,
  onBrowseFiles,
}: {
  onPickFiles: () => void
  onBrowseFiles: () => void
}) {
  const chat = useChat()
  const [skillsOpen, setSkillsOpen] = useState(false)

  return (
    <DropdownMenu.Root
      onOpenChange={(open) => {
        if (open) chat.loadMentions()
        else setSkillsOpen(false)
      }}
    >
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className={TRIGGER}
          aria-label="添加附件或技能"
          title="添加附件或技能"
        >
          <Plus size={16} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content side="top" align="start" sideOffset={6} className={CONTENT}>
          <DropdownMenu.Item className={ITEM} onSelect={onPickFiles}>
            <Upload size={15} />
            <span>添加文件和图片</span>
          </DropdownMenu.Item>
          {/* 浏览文件区与"添加"是两件事：一个是往这一轮里塞素材，一个是看已经在那儿的文件 */}
          <DropdownMenu.Item className={ITEM} onSelect={onBrowseFiles}>
            <Folder size={15} />
            <span>浏览文件</span>
          </DropdownMenu.Item>

          {/*
            技能是**钉住**（本轮必定展开正文）而不是"打开某个开关"：后端没有
            "关掉某个技能"的概念——技能由模型按需读，钉住只是把"要读"这一步替它做了。
          */}
          <DropdownMenu.Sub open={skillsOpen} onOpenChange={setSkillsOpen}>
            <DropdownMenu.SubTrigger className={ITEM}>
              <Sparkles size={15} />
              <span className="flex-1 text-left">技能</span>
              <ChevronRight size={13} />
            </DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
              <DropdownMenu.SubContent
                sideOffset={4}
                className={`${CONTENT} max-h-[320px] overflow-y-auto`}
              >
                {chat.skills.map((skill) => (
                  <DropdownMenu.CheckboxItem
                    key={skill.name}
                    className={ITEM}
                    checked={chat.pinnedSkills.includes(skill.name)}
                    title={skill.description}
                    onCheckedChange={() => chat.toggleSkill(skill.name)}
                  >
                    <span className={MARK}>
                      {chat.pinnedSkills.includes(skill.name) ? <Check size={14} /> : null}
                    </span>
                    <span className="truncate">{skill.name}</span>
                  </DropdownMenu.CheckboxItem>
                ))}
                {chat.skillsLoading ? (
                  <p className={NOTE}>正在读技能清单…</p>
                ) : chat.skills.length === 0 ? (
                  <p className={NOTE}>还没有可用的技能。去「能力」页装一个。</p>
                ) : null}
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

/**
 * 选库那一行小动作（「全选」/「清空」）：**是两个菜单项**，不是两个裸按钮。
 *
 * 理由与启用开关那条一样——菜单里的键盘是**方向键在菜单项之间走**，裸按钮只可能被
 * Tab 碰到，而 Radix 的菜单按 Tab 就关（`DropdownMenu` 默认 modal）。摆成菜单项，
 * 它们才和下面那份清单在同一套键盘里。
 */
const SMALL_ITEM =
  'flex-1 cursor-pointer rounded-[var(--radius-control)] px-[var(--space-2)] py-[var(--space-1)] text-center text-[length:var(--text-meta-size)] text-[var(--text-secondary)] outline-none data-[highlighted]:bg-[var(--bg-hover)] data-[highlighted]:text-[var(--text-primary)] data-[disabled]:cursor-default data-[disabled]:opacity-50'

/**
 * 「知识库」——**一颗胶囊管两件事**（2026-09-24 用户："开关和「全部 4 个」多选——
 * 合并成一个控件"）。
 *
 * 合并前是并排两颗：一颗 `role=switch` 的裸语义开关，一颗「全部 4 个 / 已选 N 个」的
 * 多选下拉。它们管的是同一件事（这一轮的检索范围），却要用户在两颗之间自己拼出
 * "现在到底查不查、查哪几个"；而且左组因此要 473.6px，比卡片内宽 742 里分给它的
 * 那半还宽——实测那一排折成两行（`.shots/feedback/laneB-00-row-before.png`）。
 *
 * 合并之后：
 * - **触发器读状态**（`ChatProvider` 的 `pickText`，一处口径）：`知识库 · 全部 4 个` /
 *   `知识库 · 已选 2 个` / `知识库 · 已关`——三态从这一颗上直接读出来；
 * - **面板里分两层**：顶上那行「启用」是原来那颗开关（"我平时怎么用"，写进本机偏好），
 *   下面是这一轮的库清单（勾选即选，带「全选 / 清空」）；
 * - **关掉启用时清单置灰但选择留着**（`disabled` 只是不让改，不动 `selectedKbIds`）：
 *   用户关掉再打开，原来勾的那几个还在。
 */
export function KnowledgeBaseControl() {
  const chat = useChat()
  const [filter, setFilter] = useState('')

  const keyword = filter.trim().toLocaleLowerCase()
  const visible = keyword
    ? chat.kbs.filter((item) => item.name.toLocaleLowerCase().includes(keyword))
    : chat.kbs
  /** 「全选」要能一眼看出"已经全了"：全都勾着时置灰（没有"全选一次"可做了）。 */
  const allSelected = chat.kbs.length > 0 && chat.selectedKbIds.length === chat.kbs.length
  const label = `知识库 · ${chat.kbPickText}`

  return (
    // 收起时清掉筛选词：下次打开看到的还是完整清单（筛剩下的那几个不该留着当默认）
    <DropdownMenu.Root
      onOpenChange={(open) => {
        if (!open) setFilter('')
      }}
    >
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className={TRIGGER}
          // 名字给一个**稳定的**（可见的 `知识库 · 全部 4 个` 里那半段是状态，不能当名字）：
          // 探针与用例都按它取这一颗，状态另从文本读
          aria-label="知识库范围"
          // 挤窄了会出省略号，悬停里补全（写的与可见的那一行**逐字相同**，不另造一句）
          title={label}
        >
          {/* `truncate`：这一格的字不许折成两行（理由与右边那颗模型名同款） */}
          <span className="max-w-[168px] truncate">{label}</span>
          <ChevronDown size={13} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="start"
          sideOffset={6}
          className={`${CONTENT} max-h-[360px] overflow-y-auto`}
        >
          {/*
            「启用」= 原开关（`KB_SWITCH_KEY` 那份本机偏好，语义一字没改）。
            它是**菜单项**（`CheckboxItem`）而不是面板里一枚裸开关：菜单里的键盘只走项，
            裸开关会被 Radix 关菜单的那一下 Tab 挡在外面（见 `SMALL_ITEM` 上的说明）。
            视觉仍是滑块——"这是开还是关"这一眼不该因为换了个位置就丢掉。
          */}
          <DropdownMenu.CheckboxItem
            className={ITEM}
            checked={chat.useKb}
            onCheckedChange={(value) => chat.setKbEnabled(value === true)}
            // 改开关**不关面板**（同下面那些勾选）：接着多半就要挑库
            onSelect={(event) => event.preventDefault()}
          >
            <span className="flex-1 text-left">启用</span>
            {/* 滑块是这一行的**读数**（状态已经由 `data-state` 与 aria 表达）：不参与无障碍树 */}
            <span
              aria-hidden="true"
              className={`relative inline-block h-[16px] w-[28px] shrink-0 rounded-[var(--radius-pill)] transition-colors [transition:var(--transition-ui)] ${
                chat.useKb ? 'bg-[var(--accent)]' : 'bg-[var(--bg-active)]'
              }`}
            >
              <span
                className={`absolute top-[2px] h-[12px] w-[12px] rounded-[var(--radius-pill)] bg-[var(--bg-surface)] transition-all [transition:var(--transition-ui)] ${
                  chat.useKb ? 'left-[14px]' : 'left-[2px]'
                }`}
              />
            </span>
          </DropdownMenu.CheckboxItem>

          <DropdownMenu.Separator className="my-[var(--space-1)] h-px bg-[var(--border)]" />

          <div className="flex items-center gap-[var(--space-1)]">
            {/*
              动作写在 `onSelect` 里（**不是 `onClick`**）：键盘回车/空格激活菜单项时
              Radix 只派发 `onSelect`，不派发 DOM 的 click——写在 onClick 上的话鼠标能点、
              键盘按不动。`preventDefault` 同时表示"别关菜单"。
            */}
            <DropdownMenu.Item
              className={SMALL_ITEM}
              disabled={!chat.useKb || allSelected}
              onSelect={(event) => {
                event.preventDefault()
                chat.selectAllKbs()
              }}
            >
              全选
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className={SMALL_ITEM}
              disabled={!chat.useKb || chat.selectedKbIds.length === 0}
              onSelect={(event) => {
                event.preventDefault()
                chat.clearKbs()
              }}
            >
              清空
            </DropdownMenu.Item>
          </div>

          {/* 库多了（几十个）没有它就得在一长条里找 */}
          {chat.kbs.length > 8 ? (
            <input
              className="my-[var(--space-1)] h-[var(--control-height)] w-full rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--bg-surface)] px-[var(--space-2)] text-[length:var(--text-meta-size)]"
              type="search"
              placeholder="筛选知识库"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          ) : null}

          {visible.map((kb) => (
            <DropdownMenu.CheckboxItem
              key={kb.id}
              /*
                关掉「启用」时**只是不让改**（`disabled`），不动选择：用户关掉再打开，
                原来勾的还是原来那几个。置灰那一下也顺便说明"现在这些勾不生效"。
              */
              disabled={!chat.useKb}
              className={`${ITEM} data-[disabled]:cursor-default data-[disabled]:opacity-50`}
              checked={chat.selectedKbIds.includes(kb.id)}
              onCheckedChange={() => chat.toggleKb(kb.id)}
              // 勾选**不关菜单**：用户常要一次勾几个
              onSelect={(event) => event.preventDefault()}
            >
              <span className={MARK}>
                {chat.selectedKbIds.includes(kb.id) ? <Check size={14} /> : null}
              </span>
              <span className="truncate">{kb.name}</span>
            </DropdownMenu.CheckboxItem>
          ))}
          {chat.kbs.length === 0 ? (
            <p className={NOTE}>还没有知识库。去「所有知识库」建一个，或先关掉「启用」。</p>
          ) : visible.length === 0 ? (
            <p className={NOTE}>没有匹配的知识库。</p>
          ) : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

/**
 * 模型 + 思考 + 强度收在同一个入口里（旧 `ModelPicker` 的取舍）：
 * 三个控件并排时工具条比输入框还热闹，而它们回答的是同一个问题——这一轮怎么生成。
 */
export function ModelPicker() {
  const chat = useChat()
  const current = chat.modelOptions.find((item) => item.value === chat.modelPk)
  const label = current?.label ?? chat.modelPlaceholder

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className={TRIGGER}
          aria-label="选择对话模型"
          disabled={chat.models.length === 0}
        >
          <Bot size={14} />
          <span className="max-w-[140px] truncate">{label}</span>
          <ChevronDown size={13} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="end"
          sideOffset={6}
          className={`${CONTENT} min-w-[240px]`}
        >
          <DropdownMenu.RadioGroup
            value={chat.modelPk}
            onValueChange={(value) => chat.setModelPk(value)}
          >
            {/* 留空 = 交给后端的全局默认；把它单独列一条，别让用户以为必须选一个 */}
            <DropdownMenu.RadioItem className={ITEM} value="">
              <span className={MARK}>{chat.modelPk === '' ? <Check size={14} /> : null}</span>
              <span>默认模型</span>
            </DropdownMenu.RadioItem>
            {chat.modelOptions.map((model) => (
              <DropdownMenu.RadioItem key={model.value} className={ITEM} value={model.value}>
                <span className={MARK}>
                  {chat.modelPk === model.value ? <Check size={14} /> : null}
                </span>
                <span className="truncate">{model.label}</span>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>

          <DropdownMenu.Separator className="my-[var(--space-1)] h-px bg-[var(--border)]" />

          <DropdownMenu.CheckboxItem
            className={ITEM}
            checked={chat.thinkingOn}
            onCheckedChange={(value) => chat.setThinkingOn(value === true)}
            // 开关不关菜单：改完思考档常常还要接着改强度
            onSelect={(event) => event.preventDefault()}
          >
            <span className={MARK}>{chat.thinkingOn ? <Check size={14} /> : null}</span>
            <span>深度思考</span>
          </DropdownMenu.CheckboxItem>

          {chat.thinkingOn ? (
            <DropdownMenu.RadioGroup
              value={chat.thinkingEffort}
              onValueChange={(value) => chat.setThinkingEffort(value)}
            >
              <DropdownMenu.RadioItem className={ITEM} value="low">
                <span className={MARK}>
                  {chat.thinkingEffort === 'low' ? <Check size={14} /> : null}
                </span>
                <span>强度：低</span>
              </DropdownMenu.RadioItem>
              <DropdownMenu.RadioItem className={ITEM} value="medium">
                <span className={MARK}>
                  {chat.thinkingEffort === 'medium' ? <Check size={14} /> : null}
                </span>
                <span>强度：中</span>
              </DropdownMenu.RadioItem>
              <DropdownMenu.RadioItem className={ITEM} value="high">
                <span className={MARK}>
                  {chat.thinkingEffort === 'high' ? <Check size={14} /> : null}
                </span>
                <span>强度：高</span>
              </DropdownMenu.RadioItem>
            </DropdownMenu.RadioGroup>
          ) : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

/**
 * 环的几何：`r=10` 与 `strokeWidth=2` 是 AI Elements 的原值（见 `ContextGauge` 那段）。
 * 周长要手算：`strokeDasharray` 用一整圈、`strokeDashoffset` 用"还差多少"，
 * SVG 没有"百分比进度"这种属性。
 */
const RING_RADIUS = 10
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

/**
 * 上下文占用环（来源与改法：`ContextGauge` 的注释，Apache-2.0 / vercel/ai-elements）。
 *
 * `ratio` 先夹到 0..1：环的几何只能表达一圈，把 120% 画成"绕一圈多"会让人误以为
 * 还有余量——上限与"确实占满"是两件事，百分比读数在环旁边写着，这里不重复表达。
 *
 * 颜色仍走上游的 `currentColor`，但**由这一层给一个令牌**（`text-[var(--text-primary)]`）：
 * 环是这一格的图形读数，按 SC 1.4.11 要 ≥3:1，而进度圈的可见透明度是
 * 「字色 alpha × 0.7」两层相乘——跟着按钮的 `--text-secondary`（0.6）走只有
 * **3.01:1**（浅色、压在按钮底 `--bg-subtle` 上），比门槛高 0.01，像素取整就能把
 * 它推到线下；换成 `--text-primary`（浅 0.9 / 深 0.84）之后实测
 * **浅色 6.23:1、深色 6.53:1**，而底圈（× 0.25）仍是 **1.70:1（浅）/ 1.98:1（深）** 的
 * "空槽"档——它不是要被读的那一半（旧那条线性条的轨道 `--bg-active` 是 1.44:1，
 * 现在这档比它还实一点）。
 */
function ContextRing({ ratio }: { ratio: number }) {
  const filled = Math.min(1, Math.max(0, ratio))
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      role="img"
      aria-label="上下文用量"
      /* `shrink-0`：这一格被挤时环不许跟着缩（缩了就成一团看不清的墨点） */
      className="shrink-0 text-[var(--text-primary)]"
      fill="none"
    >
      {/* 底圈：整圈都画满，作为"总量"的背景 */}
      <circle
        cx={12}
        cy={12}
        r={RING_RADIUS}
        stroke="currentColor"
        strokeWidth={2}
        opacity={0.25}
      />
      {/* 进度圈：从 12 点起笔，圆的缺口由 `strokeDashoffset` 给 */}
      <circle
        cx={12}
        cy={12}
        r={RING_RADIUS}
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeDasharray={RING_CIRCUMFERENCE}
        strokeDashoffset={RING_CIRCUMFERENCE * (1 - filled)}
        opacity={0.7}
        style={{ transform: 'rotate(-90deg)', transformOrigin: 'center' }}
      />
    </svg>
  )
}

/**
 * 上下文仪表：输入框旁边一个**能核对**的读数，点开看到按来源分解，
 * 里面那个「压缩」走既有那条 `/compact` 链路（界面不另造一套压缩）。
 *
 * 三条纪律（旧 `ContextGauge` 逐条搬）：
 * 1. **数字全部来自接口**（`used` / `total` / `ratio` / `share` 一个都不在这里算）——
 *    估算口径在服务端那一处，界面再算一遍必然分叉，而仪表上最忌讳的正是
 *    "分解条加起来不等于总数"；
 * 2. **只读**：调它不会触发压缩，所以随时可以刷新；
 * 3. **是估算就说出来**：`estimated` 与后端那句 `note` 原样显示，不把估算画成账单。
 *
 * **形状是环，不是条**（2026-09-24 用户："明明基本所有的上下文都是用的圆圈，
 * 你是设计成进度条"）。环照 **Vercel AI Elements 的 `Context`**（Apache-2.0，
 * vercel/ai-elements，取数 2026-09-24，注册表条目 https://registry.ai-sdk.dev/context.json，
 * 其中环那一段在源文件 63-102 行）：`viewBox="0 0 24 24"`、`r=10`、`strokeWidth=2`、
 * 两条 `circle`（底圈 `opacity=0.25`；进度圈 `opacity=0.7` + `strokeDasharray` +
 * `strokeDashoffset` + `strokeLinecap="round"` + `rotate(-90deg)` 让起笔落在 12 点），
 * 颜色一律 `currentColor`。
 * 我们改了两处，理由都在下面：
 *   a. **不引 hover-card / tokenlens / echarts**（照上游那一整套要装三个包，而这三个
 *      都不是我们缺的东西）：分解面板继续用既有 `DropdownMenu.Content`——按来源分解、
 *      估算说明、`/compact` 入口都还在原处；
 *   b. 颜色不写死在 SVG 里：两条圈仍然是 `currentColor`，颜色由 `ContextRing` 用一个
 *      令牌给（`--text-primary`）——环是图形读数，要 ≥3:1，为什么不是继承按钮的
 *      `--text-secondary`（只有 3.01:1）见 `ContextRing` 的注释；
 *
 * **读数不许截断**（第三批评审 A② 为了省宽度，把这一格压到 59.5px，
 * `scrollWidth` 却是 101——屏幕上只剩「上下文…」，百分比根本看不见，而百分比正是
 * 这一格要回答的问题）。现在那一格只放**比率**：环 + `11%`（10% 以下留一位小数，
 * 见 `formatPercent`）。完整读数（`7,133 / 65,536 tokens（11%）`）仍在 `title` 里，
 * 菜单里一字不少。这一格因此比原来窄 ~40px（环 16 + 间隙 6 + 比率 31，原来 93.5）。
 * 读数那一格也**不再参与收缩**（`whitespace-nowrap` + 不带 `overflow: hidden`，见下面
 * 触发器上的注释）：它今天是全排唯一"必须看得见"的字，放不下时先挤按钮的内边距与
 * 旁边那个会出省略号的模型名——实测 `scrollWidth == clientWidth`（27 = 27）。
 */
export function ContextGauge() {
  const chat = useChat()
  const usage = chat.contextUsage.data
  const error = chat.contextUsage.error
  if (!chat.conversationId) return null

  // 环的推进量按 0..1 的占用比画；文字读数走 `formatPercent`（10% 以下留一位小数）
  const ratio = usage ? Math.min(1, Math.max(0, usage.ratio)) : 0
  // 菜单里那行括号用整数百分比（口径与旧版一致：菜单给整数，行上给小数的读数）
  const percent = Math.round(ratio * 100)
  const percentText = formatPercent(usage ? ratio * 100 : null)
  // 行上那一格的字：有读数给比率，出错说"不可用"，还没回来给占位符
  // （**不给 0%**——0% 的含义是"确实没占"，而"还没读到"不是它）
  const label = error ? '不可用' : usage ? percentText : '—'

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          // `min-w-0`：整行真放不下时让**按钮**先缩进自己的横内边距，而不是把整行顶出去
          className={`${TRIGGER} min-w-0`}
          aria-label="上下文用量"
          // 精确到个位数的读数放悬停里（行上只放比率，见上面那段说明）
          title={
            usage
              ? `上下文已用 ${formatCount(usage.used)} / ${formatCount(usage.total)} tokens（${percentText}）`
              : '上下文用量'
          }
        >
          {/* 内层这一格**不参与收缩**：环是 `shrink-0`，读数是 `whitespace-nowrap`
              且**不带** `overflow: hidden`——于是它的最小宽度就是这几个字的宽度。
              上一版是 `min-w-0 truncate`：`overflow: hidden` 会把自动最小尺寸变成 0，
              它因此第一个被压扁（实测 `clientWidth 23 / scrollWidth 27`，数字被截，
              与用户报的"百分比看不见"是同一个毛病）。现在放不下时先挤按钮自己那 8px
              横内边距，再挤旁边那个本来就出省略号的模型名——读数不动。 */}
          <span className="inline-flex items-center gap-[var(--space-1-5)]">
            <ContextRing ratio={ratio} />
            <span className="tabular whitespace-nowrap">{label}</span>
          </span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="end"
          sideOffset={6}
          className={`${CONTENT} min-w-[260px]`}
        >
          {usage ? (
            <>
              <p className="m-0 px-[var(--space-1)] text-[length:var(--text-meta-size)] text-[var(--text-primary)]">
                已用 {formatCount(usage.used)} / {formatCount(usage.total)} tokens
                <span className="text-[var(--text-tertiary)]">（{percent}%）</span>
              </p>
              {/* 按来源分解：**label 用后端给的中文**（口径在服务端，界面不翻译 kind） */}
              <ul className="m-0 mt-[var(--space-1)] flex list-none flex-col gap-[var(--space-1)] p-0">
                {usage.items.map((part) => (
                  <li
                    key={part.kind}
                    className="grid grid-cols-[1fr_auto_64px] items-center gap-[var(--space-2)] text-[length:var(--text-meta-size)] text-[var(--text-secondary)]"
                  >
                    <span className="truncate" title={part.label}>
                      {part.label}
                    </span>
                    <span className="tabular text-[var(--text-tertiary)]">
                      {formatCount(part.tokens)}
                    </span>
                    <span className="block h-[4px] overflow-hidden rounded-[2px] bg-[var(--bg-active)]">
                      <span
                        className="block h-full bg-[var(--accent)]"
                        style={{ width: `${Math.round(part.share * 100)}%` }}
                      />
                    </span>
                  </li>
                ))}
                {usage.items.length === 0 ? (
                  <li className={NOTE}>这一轮还没有可分解的内容。</li>
                ) : null}
              </ul>
              {usage.compress_at > 0 ? (
                <p className={`${NOTE} leading-[1.5]`}>
                  {/* 只给这条读数（阈值是用户自己的设置）。后面原来还缀着
                      "（先剪旧工具结果，再摘要）"——那是在讲压缩怎么实现的，
                      属于 2026-09-24 用户要求清掉的那一类解释，删。
                      `compress_at` 是**百分比**（后端 `chat.compress_at` 设置项，
                      见 `backend/app/api/v1/schemas.py` 与该文件里「自动压缩阈值：{n}%」
                      那句），不是 token 数：此前直接 `formatCount` 打出来是"到 70 会
                      自动压缩"——既少了 `%`，也把一个百分比当成了数量。 */}
                  到 {usage.compress_at}% 会自动压缩
                </p>
              ) : null}
              {usage.estimated && usage.note ? (
                <p className={`${NOTE} leading-[1.5]`}>{usage.note}</p>
              ) : null}
            </>
          ) : (
            <p className={`${NOTE} leading-[1.5]`}>
              {error ? (error as Error).message : '正在读上下文用量…'}
            </p>
          )}
          <DropdownMenu.Item
            className={`${ITEM} justify-center border border-[var(--border)]`}
            onSelect={chat.compressContext}
          >
            压缩上下文（/compact）
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
