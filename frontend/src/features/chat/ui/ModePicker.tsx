/**
 * 「Agent 模式」四档（旧 `components/chat/ModePicker.vue`）——**2026-09-27 从输入框那一排
 * 搬进「+」菜单**（用户挑的旧版布局：那一排只留 `+ 知识库 模型 发送`，见《界面优化计划》§5.9）。
 *
 * 四档的枚举、顺序与语义**照抄 ZCode**：`plan / build / edit / yolo`；
 * 每档一句话的文案也是它的 UI 文案直译（后端同一份在 `services/modes.py` 的
 * `MODE_DEFS`）。**档名与取值以后端返回的候选为准**（`getChatMode().options`），
 * 这里只配中文文案——后端换一句措辞、多一档少一档，界面都跟着走。
 *
 * 三点边界（照旧，外加搬迁后的那一条）：
 *
 * - **读不到就不显示这个入口**（非管理员、旧后端没有这一项、请求失败）：
 *   它是顺手的入口，不值得为它把对话页变成错误提示；
 * - **别处改了模式要跟着显示**：改它的路有三条（这个入口、设置页、输入框里的 `/mode`），
 *   第三条发生在这个控件之外——`/mode` 那条命令会广播 `kylab:mode-changed`，
 *   这里监听它（不重新请求：值已经在事件里带回来了）；
 * - **搬迁的代价**（与「命令执行策略」同一条取舍）：这一档从此不再一眼可见。
 *   承担"需要知道当前档"那一刻的是**过程面板**（被拦下时它就展开在眼前）与
 *   `/mode` 命令；用户明确选了这一档取舍。
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import { useEffect, useState } from 'react'

import { getChatMode, setChatMode } from '@/api/settings'

import { notifyError, notifySuccess } from '../runtime/notify'
import { MENU_CHECK, MENU_ITEM } from './DropdownShell'
import { useIsAdmin } from './ExecPolicyControl'

/**
 * 每一档的短名字与那一句人话（**没有这一档就退化成后端给的展示名**）。
 *
 * 每档只写"选了它会发生什么"，**不写它相对「命令·…」是什么关系**：
 * 那一整段（"模式管要不要先问一句、命令能不能跑由旁边决定、拒绝更硬"）连同
 * `MENU_NOTE` 都删了——它是把两个控件的分工讲给用户听，而用户要的是挑一档
 * （2026-09-24："不要再在 webui 上向我解释这是个什么东西"）。
 */
const COPY: Record<string, { label: string; hint: string }> = {
  // 「构建」这句原先写"该问的照问"——用户读不出"该"是谁定的（用户原话：
  // "和模式里面的全放行是不是有冲突…摸不着头脑"），改成把动作说白：写东西前问一句。
  build: { label: '构建', hint: '变更前确认：写东西前问一句' },
  edit: { label: '编辑', hint: '自动编辑：写东西不再逐条问' },
  plan: { label: '计划', hint: '先给计划再动手：没计划前不写东西' },
  yolo: { label: '全放行', hint: '少确认全放行：连审批也不再问' },
}

/**
 * 当前档与四档候选。
 *
 * **入口那一行与子菜单里的四档都读这一处**：两处各写一份的话，"显示的是哪一档"
 * 与"点了写哪一档"迟早对不上。
 */
export function useChatMode(): {
  ready: boolean
  label: string
  current: string
  saving: boolean
  options: { value: string; label: string; hint: string }[]
  choose: (value: string) => void
} {
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
  const current = query.data?.mode ? (pushed ?? query.data.mode) : ''
  const options = (query.data?.options ?? []).map((option) => ({
    value: option.value,
    label: COPY[option.value]?.label ?? option.label,
    hint: COPY[option.value]?.hint ?? '',
  }))
  const ready = isAdmin && Boolean(current) && options.length > 0
  const label = options.find((item) => item.value === current)?.label ?? current

  function choose(value: string): void {
    if (value === current || saving) return
    setSaving(true)
    void (async () => {
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
    })()
  }

  return { ready, label, current, saving, options, choose }
}

/** 子菜单里的四档。Radix 的 `RadioItem`：键盘能走、当前档能播报（`aria-checked`）。 */
export function ModeItems() {
  const { current, saving, options, choose } = useChatMode()
  return (
    <DropdownMenu.RadioGroup value={current} onValueChange={(value) => choose(value)}>
      {options.map((item) => (
        <DropdownMenu.RadioItem
          key={item.value}
          value={item.value}
          disabled={saving}
          title={item.hint}
          data-mode={item.value}
          className={`${MENU_ITEM} items-start data-[disabled]:cursor-default data-[disabled]:opacity-60`}
        >
          {/* 勾的位置**永远占着**（没选中的那些也留一格）：否则选中项一变，整列文字会左右跳 */}
          <span className={`${MENU_CHECK} mt-[1px]`}>
            {item.value === current ? <Check size={14} /> : null}
          </span>
          <span className="flex min-w-0 flex-col gap-[2px]">
            <span className="font-medium">{item.label}</span>
            {item.hint ? (
              <span className="text-[length:var(--text-meta-size)] text-[var(--text-tertiary)]">
                {item.hint}
              </span>
            ) : null}
          </span>
        </DropdownMenu.RadioItem>
      ))}
    </DropdownMenu.RadioGroup>
  )
}
