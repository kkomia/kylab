/**
 * 档案卡（§6.1）：四个分区纵向排列，条目行内可改、可删、可加，项目区按组显示。
 *
 * 三条与界面无关、但决定了这里每一行怎么写的口径：
 *
 * 1. **顺序与注入一致**（§6.1）：四个分区按 §3.1 的固定顺序画，用户看到的顺序 =
 *    模型看到的顺序。所以这里**不排序、不折叠分区**，只按后端给的 `sections` 顺序画；
 * 2. **只给读数与事实**（§6.1 的"不出现实现细节"）：条数、字数、分组名、来源与时间；
 *    不解释分区是干什么的，也不说"它会被注入提示词"；
 * 3. **未知分区照常显示**（§3.5 第 4 条）：后端把不认识的 `## 某区` 也算进 `sections`，
 *    这里只给它一枚"分区不认识"，条照常画——静默丢掉用户写在自己档案里的东西，
 *    比多显示一块糟得多。
 *
 * 编辑的三条规则（§4.1 第 ③ 路、§6.1）：点一下变 textarea、**失焦保存 = 一次顶替**
 * （带上原值当 `replaces`）、行尾删除是"忘掉"。回执用后端那一句，界面不另编。
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, FileText, Plus, Trash2 } from 'lucide-react'

import {
  forgetMemory,
  getMemoryFile,
  rememberMemory,
  renameMemoryGroup,
  type MemoryArchive,
  type MemoryEntry,
  type MemorySection,
} from '@/api/memory'
import { Badge } from '@/ui/badge'
import { Button } from '@/ui/button'
import { Input } from '@/ui/input'
import { Textarea } from '@/ui/textarea'

import { EmptyState, Modal } from '../shared/composites'
import { notifyError, notifySuccess } from '../shared/toast'

/** 来源 → 界面上那句话（事实，不解释它怎么发生的）。 */
const SOURCE_LABELS: Record<string, string> = {
  显式: '来自会话',
  隐式: '来自会话',
  界面: '界面直改',
  迁移: '来自旧记忆',
}

type Tone = 'ok' | 'warn' | 'over'

/** 读数接近上限时变色：到顶是 `over`，八成是 `warn`（§5.2、§6.1 的"接近上限变色"）。 */
function toneOf(parts: { current: number; limit: number }[]): Tone {
  let tone: Tone = 'ok'
  for (const part of parts) {
    if (!part.limit) continue
    const ratio = part.current / part.limit
    if (ratio >= 1) return 'over'
    if (ratio >= 0.8) tone = 'warn'
  }
  return tone
}

/** 顶部那条全局读数（`32/60 条 · 1840/4000 字`）。 */
function globalReadout(archive: MemoryArchive): string {
  const { entries, chars, entry_limit, char_limit } = archive.budget
  return `${entries}/${entry_limit} 条 · ${chars}/${char_limit} 字`
}

/**
 * 一个分区的读数。
 *
 * 项目区按"组"限（每组条数另有上限），所以它多报一个组数；未知分区没有限额，
 * 只报事实——写 `N/0 条` 是在报一个不存在的上限。
 */
function sectionReadout(section: MemorySection): string {
  const chars = `${section.chars}/${section.suggested_chars} 字`
  if (section.group_limit) {
    return `${section.groups.length}/${section.group_limit} 组 · ${section.entries} 条 · ${chars}`
  }
  if (!section.limit && !section.suggested_chars) {
    return `${section.entries} 条 · ${section.chars} 字`
  }
  return `${section.entries}/${section.limit} 条 · ${chars}`
}

function sectionTone(section: MemorySection): Tone {
  const parts = [{ current: section.entries, limit: section.limit }]
  if (section.group_limit) {
    parts.push({ current: section.groups.length, limit: section.group_limit })
  }
  return toneOf(parts)
}

export interface ArchiveCardProps {
  archive: MemoryArchive
  /** 工作区目录（后端报的那一条），与档案文件名拼出磁盘路径。 */
  workspace: string
  /** 点来源小字时跳到变更流那一条。 */
  onJumpChange: (index: number) => void
}

export function ArchiveCard({ archive, workspace, onJumpChange }: ArchiveCardProps) {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<{ section: string; text: string } | null>(null)
  const [draft, setDraft] = useState('')
  const [adding, setAdding] = useState<string | null>(null)
  const [addDraft, setAddDraft] = useState('')
  const [renaming, setRenaming] = useState<{ section: string; group: string } | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [originalOpen, setOriginalOpen] = useState(false)

  const original = useQuery({
    queryKey: ['memory', 'file', 'archive'],
    queryFn: () => getMemoryFile(archive.path),
    enabled: originalOpen,
  })

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['memory', 'archive'] })
    await queryClient.invalidateQueries({ queryKey: ['memory', 'changes'] })
    await queryClient.invalidateQueries({ queryKey: ['memory', 'overview'] })
  }

  const save = useMutation({
    mutationFn: (payload: { text: string; section: string; replaces: string }) =>
      rememberMemory(payload.text, { section: payload.section, replaces: payload.replaces }),
    onSuccess: async (result) => {
      setEditing(null)
      await refresh()
      notifySuccess(result.receipt)
    },
    onError: (error: unknown) => notifyError(messageOf(error)),
  })

  const remove = useMutation({
    mutationFn: (text: string) => forgetMemory(text),
    onSuccess: async (result) => {
      await refresh()
      notifySuccess(result.receipt)
    },
    onError: (error: unknown) => notifyError(messageOf(error)),
  })

  const add = useMutation({
    mutationFn: (payload: { text: string; section: string }) =>
      rememberMemory(payload.text, { section: payload.section }),
    onSuccess: async (result) => {
      setAdding(null)
      setAddDraft('')
      await refresh()
      notifySuccess(result.receipt)
    },
    onError: (error: unknown) => notifyError(messageOf(error)),
  })

  const rename = useMutation({
    mutationFn: (payload: { section: string; old: string; next: string }) =>
      renameMemoryGroup(payload.section, payload.old, payload.next),
    onSuccess: async (result) => {
      setRenaming(null)
      await refresh()
      notifySuccess(result.receipt)
    },
    onError: (error: unknown) => notifyError(messageOf(error)),
  })

  const startEdit = (section: string, entry: MemoryEntry) => {
    setEditing({ section, text: entry.text })
    setDraft(entry.text)
  }

  const submitEdit = () => {
    if (!editing) return
    const next = draft.trim()
    if (!next || next === editing.text) {
      setEditing(null)
      return
    }
    save.mutate({ text: next, section: editing.section, replaces: editing.text })
  }

  const renderEntry = (section: MemorySection, entry: MemoryEntry) => {
    const isEditing = editing?.section === section.name && editing.text === entry.text
    return (
      <li className="m-entry" data-testid="archive-entry" data-text={entry.text} key={entry.text}>
        {isEditing ? (
          <Textarea
            className="m-entry-input"
            data-testid="archive-entry-input"
            autoFocus
            rows={2}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={submitEdit}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                setEditing(null)
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="m-entry-text"
            data-testid="archive-entry-text"
            onClick={() => startEdit(section.name, entry)}
          >
            {entry.text}
          </button>
        )}
        <span className="m-entry-actions">
          {entry.source && (
            <button
              type="button"
              className="m-entry-source"
              data-testid="archive-entry-source"
              disabled={entry.change_index < 0}
              onClick={() => onJumpChange(entry.change_index)}
            >
              {SOURCE_LABELS[entry.source] ?? entry.source}
              {entry.change_at ? ` · ${entry.change_at}` : ''}
            </button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="删除"
            data-testid="archive-entry-delete"
            disabled={remove.isPending}
            onClick={() => remove.mutate(entry.text)}
          >
            <Trash2 size={14} />
          </Button>
        </span>
      </li>
    )
  }

  const renderGroup = (section: MemorySection, name: string, items: MemoryEntry[]) => {
    const key = `${section.name}:${name}`
    const folded = collapsed[key] ?? false
    const isRenaming = renaming?.section === section.name && renaming.group === name
    return (
      <div className="m-group" data-testid="archive-group" data-group={name} key={key}>
        <div className="m-group-head">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={folded ? '展开' : '折叠'}
            data-testid="archive-group-toggle"
            onClick={() => setCollapsed((prev) => ({ ...prev, [key]: !folded }))}
          >
            {folded ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </Button>
          {isRenaming ? (
            <Input
              className="m-group-rename"
              data-testid="archive-group-rename-input"
              autoFocus
              value={renameDraft}
              onChange={(event) => setRenameDraft(event.target.value)}
              onBlur={() => setRenaming(null)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  const next = renameDraft.trim()
                  if (next && next !== name) {
                    rename.mutate({ section: section.name, old: name, next })
                  } else setRenaming(null)
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setRenaming(null)
                }
              }}
            />
          ) : (
            <button
              type="button"
              className="m-group-title"
              data-testid="archive-group-rename"
              onClick={() => {
                setRenaming({ section: section.name, group: name })
                setRenameDraft(name)
              }}
            >
              {name}
            </button>
          )}
        </div>
        {!folded && (
          <ul className="m-entries">{items.map((item) => renderEntry(section, item))}</ul>
        )}
      </div>
    )
  }

  return (
    <section className="m-archive" data-testid="archive-card" aria-label="档案">
      <header className="m-archive-head">
        <span
          className="m-readout m-readout-global"
          data-testid="archive-budget"
          data-tone={toneOf([
            { current: archive.budget.entries, limit: archive.budget.entry_limit },
            { current: archive.budget.chars, limit: archive.budget.char_limit },
          ])}
        >
          {globalReadout(archive)}
        </span>
      </header>

      {archive.sections.map((section) => {
        const ungrouped = section.items.filter((item) => !item.group)
        const groups: [string, MemoryEntry[]][] = []
        for (const item of section.items) {
          if (!item.group) continue
          const found = groups.find(([name]) => name === item.group)
          if (found) found[1].push(item)
          else groups.push([item.group, [item]])
        }
        return (
          <section
            className="m-section"
            data-testid="archive-section"
            data-section={section.name}
            data-known={section.known}
            key={section.name}
          >
            <header className="m-section-head">
              <h2 className="m-section-title">{section.name}</h2>
              {!section.known && (
                <Badge variant="warning" data-testid="archive-unknown-section">
                  分区不认识
                </Badge>
              )}
              <span
                className="m-readout"
                data-testid="archive-section-readout"
                data-tone={sectionTone(section)}
              >
                {sectionReadout(section)}
              </span>
            </header>

            {ungrouped.length > 0 && (
              <ul className="m-entries">{ungrouped.map((item) => renderEntry(section, item))}</ul>
            )}
            {groups.map(([name, items]) => renderGroup(section, name, items))}

            {section.items.length === 0 && adding !== section.name && (
              <p className="m-section-empty" data-testid="archive-section-empty">
                还没有条目
              </p>
            )}

            {adding === section.name ? (
              <div className="m-add-box">
                <Textarea
                  data-testid="archive-add-input"
                  autoFocus
                  rows={2}
                  value={addDraft}
                  onChange={(event) => setAddDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      setAdding(null)
                      setAddDraft('')
                    }
                  }}
                />
                <div className="m-add-actions">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setAdding(null)
                      setAddDraft('')
                    }}
                  >
                    取消
                  </Button>
                  <Button
                    size="sm"
                    data-testid="archive-add-save"
                    disabled={!addDraft.trim() || add.isPending}
                    onClick={() => add.mutate({ text: addDraft.trim(), section: section.name })}
                  >
                    记下来
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                data-testid="archive-add"
                onClick={() => {
                  setAdding(section.name)
                  setAddDraft('')
                }}
              >
                <Plus size={14} />
                加一条
              </Button>
            )}
          </section>
        )
      })}

      {archive.sections.length === 0 && (
        <EmptyState title="档案还是空的" hint="在上面任何一个分区里点「加一条」。" />
      )}

      <footer className="m-archive-foot">
        <Button
          variant="outline"
          size="sm"
          data-testid="archive-original"
          onClick={() => setOriginalOpen(true)}
        >
          <FileText size={14} />
          原文
        </Button>
      </footer>

      <Modal open={originalOpen} title="档案原文" onClose={() => setOriginalOpen(false)} size="md">
        <p className="m-original-path" data-testid="archive-original-path">
          {workspace ? `${workspace}/${archive.path}` : archive.path}
        </p>
        <pre className="m-original-body" data-testid="archive-original-content">
          {original.data?.content ?? ''}
        </pre>
      </Modal>
    </section>
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
