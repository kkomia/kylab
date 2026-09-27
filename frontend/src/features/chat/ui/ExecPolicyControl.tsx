/**
 * 「命令执行策略」——**2026-09-27 从输入框那一排搬进「+」菜单**（用户挑的旧版布局：
 * 那一排只留 `+ 知识库 模型 发送`，见《界面优化计划》§5.9）。
 *
 * 搬的是**入口，不是判定**：读写仍与设置页同一份（`sandbox.exec_policy`，走 `/settings`
 * 那两个接口）。在这里另存一份是最危险的实现方式——两处显示的档迟早不一致，
 * 而"我明明改成允许了，它怎么还拦"正是最难查的一类问题（数据只有一份，这里只是它的另一个门）。
 *
 * **搬走的代价记在这里**：这一项从此不再一眼可见。原先的取舍是"被拦下的那一刻用户正看着
 * 这段对话"——现在承担那一刻的是**审批条**与过程面板（真的被拦下时它们就在眼前），
 * 而"这一轮有多放手"要看一眼菜单。用户明确选了这一档取舍。
 *
 * 只引导三档（allow / ask / deny）：`sandbox` 是四档里更早的写法，仍然认，但不在这里
 * 引导去选；当前值不在三档里时**照原样显示**，不假装它是别的东西。
 * 非管理员**不显示**：它背后是管理员端点，摆在成员眼前只会让他点了拿到 403。
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import { useState } from 'react'

import { getSettings, updateSettings } from '@/api/settings'
import { useSessionStore } from '@/lib/session'

import { notifyError, notifySuccess } from '../runtime/notify'
import { MENU_CHECK, MENU_ITEM } from './DropdownShell'

/** 后端 `sandbox.exec_policy` 的键。**不另起名字**：改的就是设置页那一项。 */
const KEY = 'sandbox.exec_policy'

const POLICIES: { value: string; label: string; hint: string }[] = [
  { value: 'allow', label: '允许', hint: '允许执行命令：直接跑，不再问你' },
  { value: 'ask', label: '需确认', hint: '需确认：每次执行命令前问你一下' },
  { value: 'deny', label: '拒绝', hint: '拒绝：一律不执行命令' },
]

/**
 * 菜单底部那段常驻说明**已删**（2026-09-24）。
 *
 * 原文是"管的是命令能不能跑：允许 / 需确认 / 拒绝。「拒绝」最硬——模式选了全放行也拦得住。
 * （设置页里同一项叫「沙箱执行 → 总开关」。）"——三句都在解释这一项与别处的关系，
 * 而这一项自己的三档名字已经把答案写在脸上。用户原话："不要再在 webui 上向我解释
 * 这是个什么东西"。同一批删掉的还有 `ModePicker` 的那一段（两段本来是一对）。
 */

/** 是否管理员：这一排里的两个设置入口都是管理员端点。会话还没恢复完时按"不是"处理。 */
export function useIsAdmin(): boolean {
  const user = useSessionStore((state) => state.currentUser)
  return user?.role === 'admin'
}

/**
 * 这一项的当前档与写入动作。
 *
 * **触发器（子菜单那一行）与子菜单里的三档都读这一处**：两处各写一份的话，
 * "显示的是哪一档"与"点了写哪一档"迟早对不上（这一项的全部风险就在这里）。
 */
export function useExecPolicy(): {
  ready: boolean
  label: string
  current: string | null
  saving: boolean
  choose: (value: string) => void
} {
  const isAdmin = useIsAdmin()
  const client = useQueryClient()
  const [saving, setSaving] = useState(false)

  const query = useQuery({
    queryKey: ['chat', 'exec-policy'],
    queryFn: async (): Promise<string | null> => {
      const view = await getSettings()
      const field = view.groups
        .find((group) => group.key === 'sandbox')
        ?.fields.find((item) => item.key === KEY)
      return field?.value ?? null
    },
    enabled: isAdmin,
  })

  // 读不到就**不显示这个入口**：它是顺手的入口，不值得为它把对话页变成错误提示
  const current = query.data ?? null
  const label =
    current === null ? '' : (POLICIES.find((i) => i.value === current)?.label ?? current)

  function choose(value: string): void {
    if (value === current || saving) return
    setSaving(true)
    void (async () => {
      try {
        const result = await updateSettings([{ key: KEY, value }])
        if (result.rejected.length > 0) {
          notifyError(new Error(`这一项不被接受：${result.rejected.join('、')}`))
          return
        }
        client.setQueryData(['chat', 'exec-policy'], value)
        const chosen = POLICIES.find((item) => item.value === value)
        // 保留"下一个动作就生效"这一截：它说的是这次改动从哪一刻起作用（与
        // `ModePicker` 的"下一轮生效"同一类），不是解释这一项是什么
        notifySuccess(`命令执行策略已改成「${chosen?.label ?? value}」，下一个动作就生效`)
      } catch (cause) {
        notifyError(cause)
      } finally {
        setSaving(false)
      }
    })()
  }

  return { ready: isAdmin && current !== null, label, current, saving, choose }
}

/**
 * 子菜单里的三档。走 Radix 的 `RadioItem`：键盘能走、当前档能播报（`aria-checked`）。
 *
 * 选中之后**不拦默认行为**（与技能那种"关了菜单还要接着勾"不同）：改档是一次决定，
 * 决定做完就把菜单收掉——旧版那一颗胶囊也是这个行为。
 */
export function ExecPolicyItems() {
  const { current, saving, choose } = useExecPolicy()
  return (
    <DropdownMenu.RadioGroup value={current ?? ''} onValueChange={(value) => choose(value)}>
      {POLICIES.map((item) => (
        <DropdownMenu.RadioItem
          key={item.value}
          value={item.value}
          disabled={saving}
          title={item.hint}
          className={`${MENU_ITEM} data-[disabled]:cursor-default data-[disabled]:opacity-60`}
        >
          <span className={MENU_CHECK}>{item.value === current ? <Check size={14} /> : null}</span>
          <span>{item.label}</span>
        </DropdownMenu.RadioItem>
      ))}
    </DropdownMenu.RadioGroup>
  )
}
