/**
 * 一组运行期配置的「看 + 改」（v0.26）——与旧前端 `components/settings/SettingGroupPanel.vue` 对应。
 *
 * 它存在的理由是一次分家：**长期记忆的开关原来挂在「设置 → 功能 → 长期记忆」里**，
 * 而记忆页就在侧栏上、那一页还写着"记忆服务未启用"。同一个东西的说明和开关隔着
 * 两个菜单，用户按指引找过去还得先猜它在哪一组。
 *
 * 所以把"按后端给的字段渲染一组设置"这件事抽成一个组件，谁家的设置就挂谁家的页面上：
 * - 记忆页 → `memory`；能力页 → `web`（联网搜索）与 `sandbox`（执行策略）；
 * - 总设置弹窗 → 仍然用它渲染"后端新加了、还没有专门归属"的那些组。
 *
 * **自取自存**：组件自己 `getSettings()`、自己 `updateSettings()`。
 * 让调用方喂数据会让"打开面板要先读一次配置"变成每个宿主都要记得做的事。
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { getSettings, updateSettings, type SettingField, type SettingGroup } from '@/api/settings'

import { notifyError, notifySuccess } from '../shared/toast'
import { Button } from '@/ui/button'
import { Input } from '@/ui/input'
import { Textarea } from '@/ui/textarea'
import {
  CheckRow,
  ErrorLine,
  InfoTip,
  OptionSelect,
  SkeletonBlock,
  StatusTag,
} from '../shared/composites'
import { editHint, groupTip } from './groupTips'

export const SETTINGS_QUERY_KEY = ['settings'] as const

/**
 * 一个字段值的显示文案。
 *
 * 按类型分开写是因为它们**该说的话不一样**：布尔说"开启/关闭"（写成 true/false
 * 等于没翻译），密钥说"已配置/未配置"，其余取值本身。空值统一给破折号——
 * 留空白会让人以为界面坏了。
 */
export function fieldSummary(field: SettingField): string {
  if (field.type === 'bool') return field.value === 'true' ? '开启' : '关闭'
  if (field.type === 'secret') return field.configured ? field.value : '未配置'
  if (field.type === 'select') {
    return field.options.find((option) => option.value === field.value)?.label ?? field.value
  }
  return field.value || '—'
}

export function SettingGroupPanel({ keys, onSaved }: { keys: string[]; onSaved?: () => void }) {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<SettingGroup | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})

  const settings = useQuery({ queryKey: SETTINGS_QUERY_KEY, queryFn: getSettings })

  /** **按调用方给的顺序取**，不是按后端返回的顺序：面板在页面上的位置是设计过的。 */
  const groups = keys
    .map((key) => settings.data?.groups.find((item) => item.key === key))
    .filter((item): item is SettingGroup => item !== undefined)

  const save = useMutation({
    mutationFn: (group: SettingGroup) =>
      updateSettings(
        group.fields.map((field) => ({ key: field.key, value: draft[field.key] ?? '' })),
      ),
    onSuccess: async (result) => {
      if (result.rejected.length > 0) {
        notifyError(`以下配置项不被接受：${result.rejected.join('、')}`)
        return
      }
      notifySuccess('配置已保存，下一个任务即刻生效')
      setEditing(null)
      await queryClient.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY })
      onSaved?.()
    },
    onError: (cause: unknown) => notifyError(cause instanceof Error ? cause.message : '保存失败'),
  })

  function openEdit(target: SettingGroup): void {
    setEditing(target)
    const next: Record<string, string> = {}
    for (const field of target.fields) {
      // 密钥**永不回显**：留空表示不改动（与总设置同一口径）
      next[field.key] = field.type === 'secret' ? '' : field.value
    }
    setDraft(next)
  }

  if (settings.isLoading) return <SkeletonBlock variant="text" rows={3} />

  // 读不到就说读不到：这些面板背后是管理员端点，成员点进来会拿到 403，
  // 而"一片空白"会让人以为这一组没有设置项
  if (settings.isError) {
    return <ErrorLine>{messageOf(settings.error, '配置读取失败')}</ErrorLine>
  }

  if (groups.length === 0) return <p className="m-muted">这里暂时没有可配置的项。</p>

  return (
    <div className="m-block">
      {groups.map((group) => (
        <section key={group.key}>
          <h3 className="m-section-title">
            {group.label}
            {groupTip(group.key) && <InfoTip text={groupTip(group.key)} />}
          </h3>

          {editing?.key === group.key ? (
            <>
              <div className="m-edit-form">
                {editing.fields.map((field) => {
                  // 布尔项不能走文本输入：里面的 "false" 是非空字符串，一不小心就写成了开启
                  if (field.type === 'bool') {
                    return (
                      <CheckRow
                        key={field.key}
                        checked={draft[field.key] === 'true'}
                        onCheckedChange={(next) =>
                          setDraft((current) => ({ ...current, [field.key]: String(next) }))
                        }
                      >
                        {field.label}
                      </CheckRow>
                    )
                  }
                  if (field.type === 'select') {
                    return (
                      <label key={field.key} className="m-edit-field">
                        <span className="m-edit-label">{field.label}</span>
                        <OptionSelect
                          value={draft[field.key] ?? ''}
                          onValueChange={(value) =>
                            setDraft((current) => ({ ...current, [field.key]: value }))
                          }
                          options={field.options}
                          label={field.label}
                        />
                      </label>
                    )
                  }
                  return (
                    <label key={field.key} className="m-edit-field">
                      <span className="m-edit-label">
                        {field.label}
                        {field.type === 'secret' && field.configured && (
                          <span className="m-edit-current">当前 {field.value}</span>
                        )}
                      </span>
                      {field.type === 'textarea' ? (
                        <Textarea
                          rows={5}
                          value={draft[field.key] ?? ''}
                          onChange={(event) =>
                            setDraft((current) => ({ ...current, [field.key]: event.target.value }))
                          }
                          aria-label={field.label}
                        />
                      ) : (
                        <Input
                          type={field.type === 'int' ? 'number' : 'text'}
                          placeholder={field.type === 'secret' ? '留空表示不改动' : undefined}
                          value={draft[field.key] ?? ''}
                          onChange={(event) =>
                            setDraft((current) => ({ ...current, [field.key]: event.target.value }))
                          }
                          aria-label={field.label}
                        />
                      )}
                    </label>
                  )
                })}
                {editHint(editing.key) && <p className="m-edit-hint">{editHint(editing.key)}</p>}
              </div>
              <div className="m-edit-actions">
                <Button onClick={() => setEditing(null)}>返回</Button>
                <Button disabled={save.isPending} onClick={() => save.mutate(editing)}>
                  {save.isPending ? '保存中…' : '保存'}
                </Button>
              </div>
            </>
          ) : (
            <>
              {group.fields.map((field) => (
                <div key={field.key} className="m-row">
                  <div className="m-row-main">
                    <span className="m-row-label">{field.label}</span>
                    <span className="m-row-value">{fieldSummary(field)}</span>
                  </div>
                  {field.type === 'bool' ? (
                    <StatusTag
                      tone={field.value === 'true' ? 'success' : 'neutral'}
                      label={field.value === 'true' ? '已开启' : '未开启'}
                    />
                  ) : field.type === 'secret' ? (
                    <StatusTag
                      tone={field.configured ? 'success' : 'neutral'}
                      label={field.configured ? '已配置' : '未配置'}
                    />
                  ) : null}
                </div>
              ))}
              <div className="m-edit-actions">
                <Button onClick={() => openEdit(group)}>编辑</Button>
              </div>
            </>
          )}
        </section>
      ))}
    </div>
  )
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}
