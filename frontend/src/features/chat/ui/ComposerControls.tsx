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
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderUp,
  Plus,
  Sparkles,
  Upload,
} from 'lucide-react'
import { useState } from 'react'

import { formatCount, formatPercent } from '@/lib/format'

import { CONTROL_TRIGGER, MENU_CHECK, MENU_ITEM, MENU_PANEL } from './DropdownShell'
import { useChat } from '../runtime/ChatProvider'

/**
 * 触发器与菜单里那几个控件共用的一族类名。
 *
 * **取值只有一处**：`DropdownShell` 的 `CONTROL_TRIGGER`（薄壳那一份也要它，
 * 两处各写一遍正是"一行四个控件四种形状"的来源）。这里只是给它一个短名字。
 */
const TRIGGER = CONTROL_TRIGGER
const CONTENT = MENU_PANEL
const ITEM = MENU_ITEM
const NOTE =
  'px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-meta-size)] text-[var(--text-tertiary)]'
/** 勾的位置**永远占着**（没选中的那些也留一格）：否则选中项一变，整列文字会左右跳。 */
const MARK = MENU_CHECK

/**
 * 「思考 / 强度」那两行的形状（v0.53，照旧版 `ModelPicker.vue` 的 `.mp-row`）。
 *
 * 一行一个偏好：左边是标签，右边是控件，行高一致。两个偏好共用一层行壳，
 * 视觉上才是"一组参数"而不是两条随意的菜单项。
 */
const PREF_ROW =
  'flex min-h-[32px] w-full items-center justify-between gap-[var(--space-3)] rounded-[var(--radius-control)] px-[var(--space-3)] text-[length:var(--text-meta-size)] text-[var(--text-primary)]'
/** 开关那一行整行可点（它是 `CheckboxItem`，键盘能走、状态能播报），所以要 hover 反馈。 */
const PREF_ROW_BUTTON = `${PREF_ROW} cursor-pointer outline-none data-[highlighted]:bg-[var(--bg-hover)]`

/**
 * 开关的槽与滑块（旧版的 `.mp-switch` / `.mp-knob`）：36×20 的胶囊，滑块 14px。
 * **开=主色填充**，关=浅底 + 强边框——关着时它看起来是"一个槽"，开着时是"一条亮色"，
 * 一眼能分辨，不必去读旁边有没有字。
 */
const switchTrack = (on: boolean) =>
  `relative inline-flex h-[20px] w-[36px] shrink-0 items-center rounded-full border transition-colors ${
    on
      ? 'border-[var(--accent)] bg-[var(--accent)]'
      : 'border-[var(--border-strong)] bg-[var(--bg-hover)]'
  }`
const switchKnob = (on: boolean) =>
  `absolute left-[2px] top-[2px] h-[14px] w-[14px] rounded-full bg-[var(--bg-surface)] transition-transform ${
    on ? 'translate-x-[16px]' : ''
  }`

/**
 * 强度那三档的槽与档（旧版的 `.mp-seg` / `.mp-seg-btn`）。
 *
 * **三档并排摆出来**是这个设计的一半：做成三个菜单项时，用户得先点开「强度」
 * 才知道有哪几档可挑，而挑一档的成本本来就低。选中的那一档底色立起来（`--bg-surface`
 * + 1px 投影），未选的只是文字——所以"当前在哪一档"是看形状得到的，不用读小字。
 */
const SEG_GROUP = 'flex items-center rounded-[var(--radius-control)] bg-[var(--bg-subtle)] p-[2px]'
const SEG_BUTTON =
  'inline-flex h-[24px] min-w-[34px] cursor-pointer items-center justify-center rounded-[var(--radius-control)] px-[var(--space-2)] text-[length:var(--text-meta-size)] text-[var(--text-secondary)] outline-none data-[highlighted]:bg-[var(--bg-hover)] data-[state=checked]:bg-[var(--bg-surface)] data-[state=checked]:text-[var(--text-primary)] data-[state=checked]:shadow-[0_1px_2px_rgb(0_0_0/10%)] data-[disabled]:cursor-not-allowed data-[disabled]:text-[var(--text-tertiary)]'

/**
 * 思考强度的三档（与后端 `ThinkingEffort` 同值）。**中文标签只有三个字**，
 * 并排放得下；写成"强度：低"那种句子就摆不成一排了。
 */
const THINKING_EFFORTS: { value: string; label: string }[] = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
]

/**
 * 模型列表那一行（v0.53，照旧版 `.mp-model`）。
 *
 * 两个改动都有依据：① **勾挪到右边**——旧版就是右勾，而右侧的勾不会让左边的名字左右跳
 * （左勾必须给每行留一格，那一格在视觉上是"缩进"，名字全都退了一格）；
 * ② **选中项整行用主色**，扫一眼就知道现在是哪个，不必去找勾。
 */
const MODEL_ITEM =
  'flex w-full cursor-pointer items-center justify-between gap-[var(--space-2)] rounded-[var(--radius-control)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-meta-size)] text-[var(--text-primary)] outline-none data-[highlighted]:bg-[var(--bg-hover)] data-[state=checked]:text-[var(--accent)]'
/** 勾的位置**永远占着**（没选中的也留一格）：否则选中项一变，整列文字会左右跳。 */
const CHECK_SLOT = 'inline-flex w-[14px] shrink-0 justify-end text-[var(--accent)]'

/**
 * 「加号」：附件与技能都收在这里（照 Kimi 的输入框布局）。
 *
 * 拼成一个菜单而不是并排两个按钮：它们回答的是同一个问题——"这一轮除了问题本身，
 * 还要给它什么"。摆成两个按钮时工具条会比输入框还热闹。
 */
export function PlusMenu({
  onPickFiles,
  onPickFolder,
  onBrowseFiles,
}: {
  onPickFiles: () => void
  /** 选一整个文件夹（整棵目录按相对路径传上去，见 `Composer` 那一处）。 */
  onPickFolder: () => void
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
          {/* 文件夹单独一条：目录选择要靠 `webkitdirectory`，与"选文件"那个 input 不是同一个 */}
          <DropdownMenu.Item className={ITEM} onSelect={onPickFolder}>
            <FolderUp size={15} />
            <span>添加文件夹</span>
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
              <DropdownMenu.SubContent sideOffset={4} className={`${CONTENT} max-h-[320px]`}>
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

          {/*
            「命令」与「模式」这两颗**搬出去**了（2026-09-27，权限轴那一次改动）：
            - 「命令执行策略」折进了**权限轴**——它是"能碰多少"的一部分，
              现在有自己的位置（那一排上、加号右边、知识库左边那颗「权限」）；
            - 「任务模式」（目标 / 计划）是**另一根轴**（怎么干活），用户要它"不单独弄一个菜单"，
              所以它回到了设置页。

            留在这里的只有"这一轮给它什么"：附件、文件、技能。
          */}
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
 * 合并之后（**2026-09-27 起触发器不再读状态**，用户："就写「知识库」，用一个开关按钮，
 * 不要显示「已关」"）：
 * - **触发器 = 开关 + 名字**：左边开关直接开/关（`role=switch`），右边「知识库」点开面板；
 *   原先那三态文字（`知识库 · 全部 4 个` / `已选 N 个` / `已关`）一个字都不印了——
 *   每变一次宽度就跳一次，而"开没开"本来就该由开关表达；
 * - **面板里只剩"查哪几个"**：勾选即选，带「全选 / 清空」（原来那行「启用」随开关搬到触发器上）；
 * - **关掉时清单置灰但选择留着**（`disabled` 只是不让改，不动 `selectedKbIds`）：
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
  const label = '知识库'

  return (
    // 收起时清掉筛选词：下次打开看到的还是完整清单（筛剩下的那几个不该留着当默认）
    <DropdownMenu.Root
      onOpenChange={(open) => {
        if (!open) setFilter('')
      }}
    >
      {/*
        **一颗胶囊里两件东西**（2026-09-27 用户："知识库那个地方就写「知识库」，
        然后用一个打开关闭的按钮就可以了，不要显示「已关」"）：

        - 左边是**开关**（`role=switch`，onClick 直接开/关）——"这一轮查不查库"从这一颗上
          一步就能改；
        - 右边是**名字**，点它展开面板挑"查哪几个"。

        原先触发器读的是状态文字（`知识库 · 全部 4 个` / `知识库 · 已选 2 个` /
        `知识库 · 已关`）：那个词每变一次，这一颗的宽度就跟着跳一次，而"开没开"本来就
        该用开关表达，不该再写一遍。**状态一个字都不印**，选择结果在面板的勾上。
      */}
      <span className={`${TRIGGER} gap-[var(--space-2)] pr-[var(--space-1)]`}>
        <button
          type="button"
          role="switch"
          aria-checked={chat.useKb}
          aria-label={chat.useKb ? '关闭知识库' : '打开知识库'}
          title={chat.useKb ? '关闭知识库' : '打开知识库'}
          onClick={() => chat.setKbEnabled(!chat.useKb)}
          className="inline-flex shrink-0 cursor-pointer items-center"
        >
          <span
            aria-hidden="true"
            className={`relative inline-block h-[16px] w-[28px] rounded-[var(--radius-pill)] transition-colors [transition:var(--transition-ui)] ${
              chat.useKb ? 'bg-[var(--accent)]' : 'bg-[var(--bg-active)]'
            }`}
          >
            <span
              className={`absolute top-[2px] h-[12px] w-[12px] rounded-[var(--radius-pill)] bg-[var(--bg-surface)] transition-all [transition:var(--transition-ui)] ${
                chat.useKb ? 'left-[14px]' : 'left-[2px]'
              }`}
            />
          </span>
        </button>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            // 名字给一个**稳定的**（这一颗上不再有状态文字，名字与可见文本同字）
            aria-label="知识库范围"
            // 悬停里补全"这一轮查哪几个"（`kbPickText` 那一处口径）——**行上不印**：
            // 用户要的是"就写知识库"，而想知道细节时悬停一下还有据可查
            title={`知识库：${chat.kbPickText}`}
            className="cursor-pointer truncate text-left outline-none"
          >
            {label}
          </button>
        </DropdownMenu.Trigger>
        <ChevronDown size={13} />
      </span>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="start"
          sideOffset={6}
          className={`${CONTENT} max-h-[360px] overflow-y-auto`}
        >
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
            <p className={NOTE}>还没有知识库。去「所有知识库」建一个。</p>
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
          {/*
            「思考关」只在**非默认**时占位（旧版的做法）：默认开着思考，触发器上不该多一个字；
            而关掉之后，这一格是唯一能看出"这一轮它不深想"的地方——不写出来，
            用户得点开面板才知道自己关过。
          */}
          {!chat.thinkingOn && (
            <span className="shrink-0 rounded-[var(--radius-control)] bg-[var(--bg-hover)] px-[var(--space-1)] text-[length:var(--text-micro-size)] text-[var(--text-tertiary)]">
              思考关
            </span>
          )}
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
            <DropdownMenu.RadioItem className={MODEL_ITEM} value="">
              <span className="truncate">默认模型</span>
              <span className={CHECK_SLOT}>{chat.modelPk === '' ? <Check size={14} /> : null}</span>
            </DropdownMenu.RadioItem>
            {chat.modelOptions.map((model) => (
              <DropdownMenu.RadioItem key={model.value} className={MODEL_ITEM} value={model.value}>
                <span className="truncate">{model.label}</span>
                <span className={CHECK_SLOT}>
                  {chat.modelPk === model.value ? <Check size={14} /> : null}
                </span>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>

          <DropdownMenu.Separator className="my-[var(--space-1)] h-px bg-[var(--border)]" />

          {/* 上下文读数（环 + 比率）留在**上半屏**：它与"用哪个模型、要不要深想"同类，
              一眼要看得见；明细与压缩入口在浮层最底下（见 ContextDetails 的注释） */}
          <ContextSummary />

          {/*
            「思考」与「强度」沿用**旧版（Vue）那套形态**（v0.53）：思考是一个**开关**、
            强度是**并排三档**，两样都收在模型这一个入口里——它们回答的是同一个问题
            "这一轮怎么生成"，铺在输入框下面只会让工具条比输入框还热闹（旧版的原话）。

            语义仍走 Radix（`CheckboxItem` / `RadioItem`）：键盘能走、选中状态能播报，
            只是把"一条带勾的菜单项"换成了开关与分段的外观。`onSelect` 里 `preventDefault`
            让面板留着——改完思考常常还要接着改强度（旧版也是这个取舍：选模型才收起）。
            强度做成三档而不是三条菜单项：那样得先点开「强度」才知道有哪几档。
          */}
          <DropdownMenu.CheckboxItem
            className={PREF_ROW_BUTTON}
            checked={chat.thinkingOn}
            onCheckedChange={(value) => chat.setThinkingOn(value === true)}
            onSelect={(event) => event.preventDefault()}
          >
            <span>思考</span>
            <span aria-hidden="true" className={switchTrack(chat.thinkingOn)}>
              <span className={switchKnob(chat.thinkingOn)} />
            </span>
          </DropdownMenu.CheckboxItem>

          <div className={PREF_ROW}>
            <span>强度</span>
            <DropdownMenu.RadioGroup
              value={chat.thinkingEffort}
              onValueChange={(value) => chat.setThinkingEffort(value)}
              className={SEG_GROUP}
              aria-label="思考强度"
            >
              {THINKING_EFFORTS.map((item) => (
                <DropdownMenu.RadioItem
                  key={item.value}
                  value={item.value}
                  disabled={!chat.thinkingOn}
                  onSelect={(event) => event.preventDefault()}
                  className={SEG_BUTTON}
                >
                  {item.label}
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          </div>

          {/* 明细沉底：读数、按来源分解、估算说明与「压缩上下文」——要看时往下滚 */}
          <DropdownMenu.Separator className="my-[var(--space-1)] h-px bg-[var(--border)]" />
          <ContextDetails />
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
 * 上下文读数：**在模型浮层里的一行**（2026-09-27 从输入框那一排搬进来），
 * 下面是能核对的分解与那个「压缩」入口（走既有 `/compact` 链路，界面不另造一套压缩）。
 *
 * **为什么与模型放在一起**：它回答的是"还能问多长"，与"用哪个模型、要不要深想"
 * 是同一类问题（这一句原先就写在 `Composer.tsx` 那一排的注释里）。那一排要减到
 * `+ 知识库 模型 发送`，它就跟着模型走——而不是被删掉：**该看到的读数一个都没少**，
 * 只是从"总在眼前"变成"打开模型这一格就在眼前"。
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
 * 颜色一律 `currentColor`；颜色由 `ContextRing` 用一个令牌给（`--text-primary`）——
 * 环是图形读数，要 ≥3:1，为什么不是继承按钮的 `--text-secondary`（只有 3.01:1）
 * 见 `ContextRing` 的注释。
 */
export function ContextSummary() {
  const chat = useChat()
  const usage = chat.contextUsage.data
  const error = chat.contextUsage.error
  if (!chat.conversationId) return null

  // 环的推进量按 0..1 的占用比画；文字读数走 `formatPercent`（10% 以下留一位小数）
  const ratio = usage ? Math.min(1, Math.max(0, usage.ratio)) : 0
  const percentText = formatPercent(usage ? ratio * 100 : null)
  // 行上那一格的字：有读数给比率，出错说"不可用"，还没回来给占位符
  // （**不给 0%**——0% 的含义是"确实没占"，而"还没读到"不是它）
  const label = error ? '不可用' : usage ? percentText : '—'
  // 精确到个位数的读数放悬停里（行上只放比率）
  const title = usage
    ? `上下文已用 ${formatCount(usage.used)} / ${formatCount(usage.total)} tokens（${percentText}）`
    : '上下文用量'

  return (
    <div className={PREF_ROW} title={title}>
      <span>上下文</span>
      <span className="inline-flex items-center gap-[var(--space-1-5)]">
        <ContextRing ratio={ratio} />
        <span className="tabular whitespace-nowrap">{label}</span>
      </span>
    </div>
  )
}

/**
 * 上下文那一行的**明细**（读数、按来源分解、估算说明、压缩入口）。
 *
 * **与 `ContextSummary` 那一行分开是实测逼出来的**（2026-09-27）：明细有六七行，
 * 直接跟在模型后面时浮层一到 `max-h` 就滚——「思考 / 强度」被挤到折线以下，
 * 而用户给的参照图里它们就在模型下面一眼可见。所以：**读数那一行留在上半屏**
 * （模型 / 上下文 / 思考 / 强度），明细与压缩沉到底部，要看时往下滚。
 */
export function ContextDetails() {
  const chat = useChat()
  const usage = chat.contextUsage.data
  const error = chat.contextUsage.error
  if (!chat.conversationId) return null
  // 详情里那行括号用整数百分比（口径与旧版一致：那一行给整数，行上给小数的读数）
  const percent = usage ? Math.round(Math.min(1, Math.max(0, usage.ratio)) * 100) : 0

  return (
    <>
      {usage ? (
        <div className="px-[var(--space-3)] pb-[var(--space-1)] pt-[var(--space-1)]">
          <p className="m-0 text-[length:var(--text-meta-size)] text-[var(--text-primary)]">
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
              <li className="text-[length:var(--text-meta-size)] text-[var(--text-tertiary)]">
                这一轮还没有可分解的内容。
              </li>
            ) : null}
          </ul>
          {usage.compress_at > 0 ? (
            <p className="m-0 mt-[var(--space-1)] text-[length:var(--text-meta-size)] leading-[1.5] text-[var(--text-tertiary)]">
              {/* 只给这条读数（阈值是用户自己的设置）。后面原来还缀着
                  "（先剪旧工具结果，再摘要）"——那是在讲压缩怎么实现的，
                  属于 2026-09-24 用户要求清掉的那一类解释，删。
                  数字用 `compress_budget`（**实际**阈值，D37）而不是百分比：
                  它是"窗口的 `compress_at`%"与绝对上限取小的那个——窗口调到 1M 时
                  按比例算是 70 万 token，而那条会话总共才 1.2 万，那句提示就成了
                  一个永远到不了的数。 */}
              到 {formatCount(usage.compress_budget)} tokens 会自动压缩
            </p>
          ) : null}
          {usage.estimated && usage.note ? (
            <p className="m-0 mt-[var(--space-1)] text-[length:var(--text-meta-size)] leading-[1.5] text-[var(--text-tertiary)]">
              {usage.note}
            </p>
          ) : null}
        </div>
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
    </>
  )
}
