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
import { Eye, EyeOff } from 'lucide-react'

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

/**
 * 一次保存该发出去的（键, 值）：**留空的密钥不发**。
 *
 * 服务端把空值当**清除**（`runtime_config.set`），而界面这一侧的承诺是
 * "留空表示不改动"——掩码永不回填，所以密钥那一格打开时本来就是空的。
 * 照原样发出去，就会出现"只想换个搜索服务商，顺手把密钥抹掉了"，
 * 而两次保存之间没有任何提示（**最难查的一类故障**）。
 *
 * 真要清除密钥得显式送一个空值，那是另一个动作：后端 `set(clear_secrets=…)`
 * 支持它，界面上暂时没有入口（`groupTips` 里原本写着"用下方「清除」入口"，
 * 而那个入口并不存在——那句话已经删掉）。
 */
export function settingsPayloadOf(
  group: SettingGroup,
  draft: Record<string, string>,
): { key: string; value: string }[] {
  return group.fields
    .filter((field) => !(field.type === 'secret' && !(draft[field.key] ?? '').trim()))
    .map((field) => ({ key: field.key, value: draft[field.key] ?? '' }))
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
    mutationFn: (group: SettingGroup) => updateSettings(settingsPayloadOf(group, draft)),
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
                  // 密钥单独一支：里面那颗「显示 / 隐藏」是个 button，**不能待在 `<label>` 里**
                  // （label 会把交互元素算成"被标注的控件"，与 `Field` 的 `tip` 同一条理由）。
                  // 控件的可访问名由 `aria-label` 给。
                  if (field.type === 'secret') {
                    return (
                      <div key={field.key} className="m-edit-field">
                        <span className="m-edit-label">
                          {field.label}
                          {field.configured && (
                            <span className="m-edit-current">当前 {field.value}</span>
                          )}
                        </span>
                        <SecretInput
                          label={field.label}
                          value={draft[field.key] ?? ''}
                          onChange={(next) =>
                            setDraft((current) => ({ ...current, [field.key]: next }))
                          }
                        />
                      </div>
                    )
                  }
                  return (
                    <label key={field.key} className="m-edit-field">
                      <span className="m-edit-label">{field.label}</span>
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

/**
 * 密钥输入框：`type="password"` + 一颗「显示 / 隐藏」（2026-09-30）。
 *
 * 原先密钥与普通文本共用同一个 `Input`，也就是**明文摊在屏幕上**。填进这一格的
 * 是从服务商后台复制来的一把串，粘错了多半**看不出来**——而"看不出哪里错了"
 * 正是 401 排查最难的一步。所以要给一个能看一眼的开关；但默认仍然是遮住的，
 * 明文不该是默认（肩窥是常态）。
 *
 * 显示状态是**这一个输入框自己的**：它不进 `draft`、不落库，面板关掉即复位——
 * 它不是配置，是"我刚才想确认一下"。
 */
function SecretInput({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (next: string) => void
}) {
  const [revealed, setRevealed] = useState(false)
  return (
    <div className="relative">
      <Input
        type={revealed ? 'text' : 'password'}
        className="pr-9"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="留空表示不改动"
        aria-label={label}
        autoComplete="off"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="absolute top-0.5 right-0.5"
        aria-label={revealed ? '隐藏密钥' : '显示密钥'}
        onClick={() => setRevealed((current) => !current)}
      >
        {revealed ? <EyeOff size={14} /> : <Eye size={14} />}
      </Button>
    </div>
  )
}
