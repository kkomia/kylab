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

import { formatCount } from '@/lib/format'

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
                ) : (
                  <p className={NOTE}>勾上的技能每一轮都会展开正文——它会占上下文，按需勾。</p>
                )}
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

/** 知识库开关 + 选库菜单（开关关掉时选库入口没有意义，摆着只是噪声）。 */
export function KnowledgeBaseControl() {
  const chat = useChat()
  const [filter, setFilter] = useState('')

  const keyword = filter.trim().toLocaleLowerCase()
  const visible = keyword
    ? chat.kbs.filter((item) => item.name.toLocaleLowerCase().includes(keyword))
    : chat.kbs

  return (
    <>
      {/*
        「知识库」**就是一个开关**（v0.19）：原先它是个"开关 + 选库"二合一的菜单，
        要先点开才知道这一轮到底查不查库，而"查不查"比"查哪几个"高频得多。
      */}
      <button
        type="button"
        role="switch"
        aria-checked={chat.useKb}
        aria-label="使用知识库"
        title={chat.useKb ? '这一轮会查知识库' : '这一轮不查知识库，按纯对话回答'}
        // 与左右邻居同一个容器（等高、胶囊、浅底）：它原先是一颗**裸开关**——
        // `border-radius: 0`、没有底色，一行里就它没有形状（A4）
        className={`${TRIGGER} gap-[var(--space-2)]`}
        onClick={chat.toggleKbSwitch}
      >
        <span
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
        <span>知识库</span>
      </button>

      {chat.useKb ? (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button type="button" className={TRIGGER} aria-label="选择要查的知识库">
              <span className="max-w-[132px] truncate">{chat.kbPickText}</span>
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
              {/* 库多了（几十个）没有它就得在一长条里找 */}
              {chat.kbs.length > 8 ? (
                <input
                  className="mb-[var(--space-1)] h-[var(--control-height)] w-full rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--bg-surface)] px-[var(--space-2)] text-[length:var(--text-meta-size)]"
                  type="search"
                  placeholder="筛选知识库"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                />
              ) : null}
              {visible.map((kb) => (
                <DropdownMenu.CheckboxItem
                  key={kb.id}
                  className={ITEM}
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
                <p className={NOTE}>还没有知识库。去「所有知识库」建一个，或先关掉这个开关。</p>
              ) : visible.length === 0 ? (
                <p className={NOTE}>没有匹配的知识库。</p>
              ) : null}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      ) : null}
    </>
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
 * 上下文仪表：输入框旁边一个**能核对**的读数，「上下文已用 X / Y」，
 * 点开看到按来源分解，里面那个「压缩」走既有那条 `/compact` 链路（界面不另造一套压缩）。
 *
 * 三条纪律（旧 `ContextGauge` 逐条搬）：
 * 1. **数字全部来自接口**（`used` / `total` / `share` 一个都不在这里算）——
 *    估算口径在服务端那一处，界面再算一遍必然分叉，而仪表上最忌讳的正是
 *    "分解条加起来不等于总数"；
 * 2. **只读**：调它不会触发压缩，所以随时可以刷新；
 * 3. **是估算就说出来**：`estimated` 与后端那句 `note` 原样显示，不把估算画成账单。
 */
export function ContextGauge() {
  const chat = useChat()
  const usage = chat.contextUsage.data
  const error = chat.contextUsage.error
  if (!chat.conversationId) return null

  const percent = usage ? Math.round(Math.min(1, Math.max(0, usage.ratio)) * 100) : 0

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className={TRIGGER} aria-label="上下文用量" title="上下文用量">
          <span className="inline-flex items-center gap-[var(--space-1-5)]">
            <span className="tabular">
              {error
                ? '上下文读数不可用'
                : usage
                  ? `上下文已用 ${formatCount(usage.used)} / ${formatCount(usage.total)}`
                  : '正在读上下文…'}
            </span>
            {/* 一圈很细的占用条：它替掉"再去点开看一眼"的那一步 */}
            <span className="inline-block h-[4px] w-[28px] overflow-hidden rounded-[2px] bg-[var(--bg-active)]">
              <span
                className="block h-full bg-[var(--text-tertiary)]"
                style={{ width: `${percent}%` }}
              />
            </span>
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
                  到 {formatCount(usage.compress_at)} 会自动压缩（先剪旧工具结果，再摘要）。
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
