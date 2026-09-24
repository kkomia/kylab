/**
 * 输入框那一排的「Agent 模式」四档（旧 `components/chat/ModePicker.vue`）。
 *
 * 四档的枚举、顺序与语义**照抄 ZCode**：`plan / build / edit / yolo`；
 * 每档一句话的文案也是它的 UI 文案直译（后端同一份在 `services/modes.py` 的
 * `MODE_DEFS`）。**档名与取值以后端返回的候选为准**（`getChatMode().options`），
 * 这里只配中文文案——后端换一句措辞、多一档少一档，界面都跟着走。
 *
 * 两点边界（照旧）：
 *
 * - **读不到就不显示这个控件**（非管理员、旧后端没有这一项、请求失败）：
 *   它是顺手的入口，不值得为它把对话页变成错误提示；
 * - **别处改了模式要跟着显示**：改它的路有三条（这个控件、设置页、输入框里的 `/mode`），
 *   第三条发生在这个控件之外——`/mode` 那条命令会广播 `kylab:mode-changed`，
 *   这里监听它（不重新请求：值已经在事件里带回来了）。
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Compass } from 'lucide-react'
import { useEffect, useState } from 'react'

import { getChatMode, setChatMode } from '@/api/settings'

import { notifyError, notifySuccess } from '../runtime/notify'
import { Dropdown } from './DropdownShell'
import { useIsAdmin } from './ExecPolicyControl'

/** 每一档的短名字与那一句人话（**没有这一档就退化成后端给的展示名**）。 */
const COPY: Record<string, { label: string; hint: string }> = {
  // 「构建」这句原先写"该问的照问"——用户读不出"该"是谁定的（用户原话：
  // "和模式里面的全放行是不是有冲突…摸不着头脑"），改成把动作说白：写东西前问一句。
  build: { label: '构建', hint: '变更前确认：写东西前问一句' },
  edit: { label: '编辑', hint: '自动编辑：写东西不再逐条问' },
  plan: { label: '计划', hint: '先给计划再动手：没计划前不写东西' },
  yolo: { label: '全放行', hint: '少确认全放行：连审批也不再问；「命令·拒绝」仍然拦得住' },
}

/**
 * 菜单里那句把两个旋钮分开的话。
 *
 * 为什么不放进某一档的 hint 里：这个疑问是**打开菜单时**产生的（两个胶囊并排），
 * 而 hint 只挂在悬停的 title 上——看到了问题的地方就该看到答案。
 */
const MENU_NOTE =
  '模式管"要不要先问一句"；命令能不能跑由旁边的「命令·允许/需确认/拒绝」决定。' +
  '那一道的「拒绝」更硬：这里选了全放行也拦得住。'

export function ModePicker() {
  const isAdmin = useIsAdmin()
  const client = useQueryClient()
  const [saving, setSaving] = useState(false)
  /** `/mode` 改了档时带回来的新值（按事件同步显示，不重新请求）。 */
  const [pushed, setPushed] = useState<string | null>(null)

  const query = useQuery({
    queryKey: ['chat', 'mode'],
    queryFn: getChatMode,
    enabled: isAdmin,
  })

  useEffect(() => {
    const onModeChanged = (event: Event): void => {
      const detail = (event as CustomEvent<string>).detail
      if (typeof detail === 'string' && detail) setPushed(detail)
    }
    window.addEventListener('kylab:mode-changed', onModeChanged)
    return () => window.removeEventListener('kylab:mode-changed', onModeChanged)
  }, [])

  // 后端没给这一项（旧版本，或者字段没登记）时**不显示**——显示了也写不动
  const mode = query.data?.mode ? (pushed ?? query.data.mode) : ''
  const options = (query.data?.options ?? []).map((option) => ({
    value: option.value,
    label: COPY[option.value]?.label ?? option.label,
    hint: COPY[option.value]?.hint ?? '',
  }))
  if (!isAdmin || !mode || options.length === 0) return null

  const label = options.find((item) => item.value === mode)?.label ?? mode

  async function choose(value: string): Promise<void> {
    if (value === mode || saving) return
    setSaving(true)
    try {
      const result = await setChatMode(value)
      if (result.rejected.length > 0) {
        notifyError(new Error(`这一项不被接受：${result.rejected.join('、')}`))
        return
      }
      setPushed(value)
      const chosen = options.find((item) => item.value === value)
      notifySuccess(`Agent 模式已切到「${chosen?.label ?? value}」，下一轮生效`)
      void client.invalidateQueries({ queryKey: ['chat', 'mode'] })
    } catch (cause) {
      notifyError(cause)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dropdown label={`模式·${label}`} ariaLabel="Agent 模式" icon={<Compass size={14} />}>
      {options.map((item) => (
        <button
          key={item.value}
          type="button"
          className="flex w-full cursor-pointer items-start gap-[var(--space-2)] rounded-[var(--radius-control)] px-[var(--space-3)] py-[var(--space-2)] text-left text-[length:var(--text-meta-size)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-60"
          disabled={saving}
          title={item.hint}
          data-mode={item.value}
          onClick={() => void choose(item.value)}
        >
          {/* 勾的位置**永远占着**（没选中的那些也留一格）：否则选中项一变，整列文字会左右跳 */}
          <span className="inline-flex w-[14px] shrink-0 pt-[1px] text-[var(--accent)]">
            {item.value === mode ? <Check size={14} /> : null}
          </span>
          <span className="flex flex-col gap-[2px]">
            <span className="font-medium">{item.label}</span>
            {item.hint ? (
              <span className="text-[length:var(--text-meta-size)] text-[var(--text-tertiary)]">
                {item.hint}
              </span>
            ) : null}
          </span>
        </button>
      ))}
      <p
        className="m-0 mt-[var(--space-1)] border-t border-[var(--border)] px-[var(--space-3)] pt-[var(--space-2)] text-[length:var(--text-micro-size)] leading-[1.5] text-[var(--text-tertiary)]"
        data-testid="mode-note"
      >
        {MENU_NOTE}
      </p>
    </Dropdown>
  )
}
