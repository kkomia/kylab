/**
 * 输入框上的两个菜单：`/` 命令菜单与 `@` 上下文菜单（旧 `SlashMenu.vue` / `MentionMenu.vue`）。
 *
 * 两份共同的三条约定（照旧，两条都不能丢）：
 *
 * 1. **键盘不在这里**：`↑↓` / 回车 / `Esc` 全绑在输入框上（焦点自始至终在输入框里），
 *    组件只把 `move(±1)` / `pickActive()` 暴露出去，由 `Composer` 转发；
 * 2. **过滤词命中优先**：前缀命中排在"包含"之前——输入 `/m` 时 `/mode` 要在最前；
 * 3. **一条都没匹配上时明确说一句**（而不是画一个空框）：这时回车会落到"发送"上，
 *    由后端回一句"没有这个命令"，用户至少看得见自己的输入被谁读了。
 *
 * 两个菜单的判据互斥（`@` 之后不能有空白、`/` 开头且还没打空格），所以不会同时开着；
 * `Composer` 里 `@` 排在 `/` 之前——先问引用那个更贴用户当下的动作。
 */
import { useEffect, useRef } from 'react'

import type { ChatCommand } from '@/api/chat'

import type { MentionItem } from '../runtime/ChatProvider'

/** 浮层的通用外壳：贴在输入卡片上方、不抢焦点。 */
const PANEL =
  'overflow-hidden rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--bg-menu)] shadow-[var(--shadow-popover)]'
const LIST = 'max-h-[320px] overflow-y-auto py-[var(--space-1)]'
const GROUP =
  'm-0 px-[var(--space-3)] pt-[var(--space-2)] pb-[var(--space-1)] text-[length:var(--text-meta-size)] text-[var(--text-tertiary)]'
const ITEM =
  'flex w-full cursor-pointer items-baseline gap-[var(--space-2)] border-0 bg-transparent px-[var(--space-3)] py-[var(--space-1-5)] text-left font-[inherit] text-[var(--text-primary)]'
const ITEM_ACTIVE = 'bg-[var(--bg-hover)]'
const FOOT =
  'm-0 border-t border-[var(--border)] px-[var(--space-3)] py-[var(--space-1-5)] text-[length:var(--text-meta-size)] text-[var(--text-quaternary)]'
const EMPTY =
  'm-0 p-[var(--space-3)] text-[length:var(--text-meta-size)] text-[var(--text-tertiary)]'

/** 键盘要在外面驱动的那几条：菜单把"当前高亮"与"选中动作"交出去。 */
export interface MenuHandle {
  move: (delta: number) => void
  pickActive: () => void
  /** 当前有几条候选（回车要不要被菜单吃掉，靠它判断）。 */
  count: () => number
}

/**
 * 分组的顺序与标题（`group` 的取值与后端 `CommandOut.group` 一一对应）。
 * 「随代码自带」是**我们调过的那些**，与"用户放的"分开说——出问题时先怀疑自己放的那份。
 *
 * 这个顺序**核过，不改**：内置在最上（每台机器都一样，也是敲 `/` 时最常用到的一批），
 * 接着是用户自己放的那份（他要找的大概率是刚写的那条），再是随代码自带的
 * ——"不是我写的"那类收尾，出问题时也最先怀疑它们——最后是**技能**。
 *
 * 「技能」放最后是刻意的：技能是一眼可辨的一类（`/kylab-web` 这种），但它有
 * 二十多条（装得越多越长），排在内置后面会把 `/rewind` `/status` `/skills` 这些
 * 会话动作挤出首屏；放末尾时"敲 `/` 先看到动作、想找技能再往下滚"。
 */
const COMMAND_GROUPS: { key: ChatCommand['group']; label: string }[] = [
  { key: 'builtin', label: '内置' },
  { key: 'user', label: '自定义（你放的）' },
  { key: 'repo', label: '自定义（随代码自带）' },
  { key: 'skill', label: '技能' },
]

/**
 * 认不出的 `group` 的落点。
 *
 * 后端将来再多一类分组时，前端这份表**一定会晚一步**——照旧写法，那些命令会被
 * `filter` 悄悄丢掉，菜单里少几条是没人会发现的错（用户只会觉得"我明明装了这条
 * 技能"）。所以认不出的一律收在这里摆出来，宁可分组标题不精确，也不能让命令消失。
 * （技能那一组就是这么加的：后端加了 `skill` 取值，这里跟着补一行。）
 */
const OTHER_GROUP = { key: 'other' as const, label: '其它' }

export function SlashMenu({
  items,
  filter,
  handleRef,
  onPick,
}: {
  items: ChatCommand[]
  filter: string
  handleRef: { current: MenuHandle | null }
  onPick: (command: ChatCommand) => void
}) {
  const query = filter.trim().toLowerCase()
  const matched = query
    ? [
        ...items.filter((item) => item.name.toLowerCase().startsWith(query)),
        ...items.filter(
          (item) =>
            !item.name.toLowerCase().startsWith(query) &&
            (item.name.toLowerCase().includes(query) || item.summary.includes(filter.trim())),
        ),
      ]
    : items

  const grouped = [
    ...COMMAND_GROUPS.map((group) => ({
      ...group,
      items: matched.filter((item) => item.group === group.key),
    })),
    {
      ...OTHER_GROUP,
      items: matched.filter(
        (item) => !COMMAND_GROUPS.some((group) => group.key === (item.group as string)),
      ),
    },
  ].filter((group) => group.items.length > 0)
  const flat = grouped.flatMap((group) => group.items)

  // 高亮项在**扁平顺序**里的下标（组的顺序就是扁平顺序，两处不会对不上）
  const active = useRef(0)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    active.current = 0
  }, [filter])

  handleRef.current = {
    move: (delta) => {
      if (flat.length === 0) return
      active.current = (active.current + delta + flat.length) % flat.length
      listRef.current
        ?.querySelector<HTMLElement>('[data-active="true"]')
        ?.scrollIntoView({ block: 'nearest' })
    },
    pickActive: () => {
      const command = flat[active.current]
      if (command) onPick(command)
    },
    count: () => flat.length,
  }

  return (
    <div className={PANEL} role="listbox" aria-label="命令">
      <div ref={listRef} className={LIST}>
        {grouped.map((group) => (
          <div key={group.key}>
            <p className={GROUP}>{group.label}</p>
            {group.items.map((command) => {
              const isActive = flat.indexOf(command) === active.current
              return (
                <button
                  key={command.name}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  data-active={isActive ? 'true' : 'false'}
                  className={`${ITEM} ${isActive ? ITEM_ACTIVE : ''}`}
                  // 鼠标移上去也要把高亮带过去，否则键盘与鼠标会指着两条不同的命令
                  onMouseEnter={() => {
                    active.current = flat.indexOf(command)
                  }}
                  onClick={() => onPick(command)}
                >
                  <span className="shrink-0 font-mono text-[length:var(--text-meta-size)]">
                    {command.usage}
                  </span>
                  <span className="truncate text-[length:var(--text-meta-size)] text-[var(--text-secondary)]">
                    {command.summary}
                  </span>
                </button>
              )
            })}
          </div>
        ))}
        {flat.length === 0 ? <p className={EMPTY}>没有匹配的命令；回车按原样发给后端</p> : null}
      </div>
      <p className={FOOT}>↑↓ 选择，回车或点击插入；命令由后端直接执行，不进模型历史</p>
    </div>
  )
}

const MENTION_GROUPS: { kind: MentionItem['kind']; label: string }[] = [
  { kind: 'file', label: '文件' },
  { kind: 'skill', label: '技能' },
  { kind: 'session', label: '会话' },
]

export function MentionMenu({
  items,
  filter,
  loading,
  handleRef,
  onPick,
}: {
  items: MentionItem[]
  filter: string
  loading: boolean
  handleRef: { current: MenuHandle | null }
  onPick: (item: MentionItem) => void
}) {
  const query = filter.trim().toLowerCase()
  // 目录只在**搜索时**出现：想引用的是目录里的某份文件，那就该继续往里打；
  // 而"列一堆目录"会把文件挤下去（那些才是能引用的东西）
  const matched = query
    ? [
        ...items.filter(
          (item) =>
            item.label.toLowerCase().startsWith(query) ||
            item.value.toLowerCase().startsWith(query),
        ),
        ...items.filter(
          (item) =>
            !item.label.toLowerCase().startsWith(query) &&
            !item.value.toLowerCase().startsWith(query) &&
            (item.label.toLowerCase().includes(query) ||
              item.value.toLowerCase().includes(query) ||
              item.detail.includes(query)),
        ),
      ]
    : items.filter((item) => !item.isDir)

  const grouped = MENTION_GROUPS.map((group) => ({
    ...group,
    items: matched.filter((item) => item.kind === group.kind),
  })).filter((group) => group.items.length > 0)
  const flat = grouped.flatMap((group) => group.items)

  const active = useRef(0)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    active.current = 0
  }, [filter])

  handleRef.current = {
    move: (delta) => {
      if (flat.length === 0) return
      active.current = (active.current + delta + flat.length) % flat.length
      listRef.current
        ?.querySelector<HTMLElement>('[data-active="true"]')
        ?.scrollIntoView({ block: 'nearest' })
    },
    pickActive: () => {
      const item = flat[active.current]
      if (item) onPick(item)
    },
    count: () => flat.length,
  }

  return (
    <div className={PANEL} role="listbox" aria-label="添加上下文">
      <div ref={listRef} className={LIST}>
        {grouped.map((group) => (
          <div key={group.kind}>
            <p className={GROUP}>{group.label}</p>
            {group.items.map((item) => {
              const isActive = flat.indexOf(item) === active.current
              return (
                <button
                  key={`${item.kind}:${item.value}`}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  data-active={isActive ? 'true' : 'false'}
                  className={`${ITEM} ${isActive ? ITEM_ACTIVE : ''}`}
                  onMouseEnter={() => {
                    active.current = flat.indexOf(item)
                  }}
                  onClick={() => onPick(item)}
                >
                  <span className="max-w-[60%] shrink-0 truncate text-[length:var(--text-meta-size)]">
                    {item.label}
                  </span>
                  {item.detail ? (
                    <span className="truncate text-[length:var(--text-meta-size)] text-[var(--text-quaternary)]">
                      {item.detail}
                    </span>
                  ) : null}
                </button>
              )
            })}
          </div>
        ))}
        {flat.length === 0 ? (
          <p className={EMPTY}>{loading ? '正在读文件清单…' : '没有匹配的文件 / 技能 / 会话'}</p>
        ) : null}
      </div>
      <p className={FOOT}>只插入引用，不读取内容；↑↓ 选择，回车或点击插入</p>
    </div>
  )
}
