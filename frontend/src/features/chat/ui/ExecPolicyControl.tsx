/**
 * 输入框那一排的「命令执行策略」（旧 `components/chat/ExecPolicyControl.vue`）。
 *
 * 为什么把它从设置页搬到输入框旁边：被拦下的那一刻，用户正看着这段对话——
 * 让他先去「能力 → 沙箱执行」翻出那一项、改完再问一遍，是这条链路上最没必要的往返。
 * 而这一项恰恰是"改完立刻能感觉到差别"的那种设置。
 *
 * **读写的是与设置页同一份**（`sandbox.exec_policy`，走 `/settings` 那两个接口）：
 * 在这里另存一份是最危险的实现方式——两处显示的档迟早不一致，
 * 而"我明明改成允许了，它怎么还拦"正是最难查的一类问题（数据只有一份，
 * 这里只是它的另一个门）。
 *
 * 名字从「执行·x」改成「命令·x」（用户问"它和模式里的全放行是不是冲突"）：
 * 这一排并排摆着两个胶囊，「执行」与「模式」在中文里都可以被读成"这一轮它有多放手"，
 * 用户无法从名字判断谁管什么。事实是——这一项管**命令本身能不能跑**
 * （能不能在这台机器上起进程），而「模式」管**要不要先问一句**。
 * 名字落在"命令"上，两者才是可区分的问题。
 *
 * 只引导三档（allow / ask / deny）：`sandbox` 是四档里更早的写法，仍然认，但不在这里
 * 引导去选；当前值不在三档里时**照原样显示**，不假装它是别的东西。
 * 非管理员**不显示**：它背后是管理员端点，摆在成员眼前只会让他点了拿到 403。
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ShieldCheck } from 'lucide-react'
import { useState } from 'react'

import { getSettings, updateSettings } from '@/api/settings'
import { useSessionStore } from '@/lib/session'

import { notifyError, notifySuccess } from '../runtime/notify'
import { Dropdown } from './DropdownShell'

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

export function ExecPolicyControl() {
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

  // 读不到就**不显示这个控件**：它是顺手的入口，不值得为它把对话页变成错误提示
  const mode = query.data ?? null
  if (!isAdmin || mode === null) return null

  const label = POLICIES.find((item) => item.value === mode)?.label ?? mode

  async function choose(value: string): Promise<void> {
    if (value === mode || saving) return
    setSaving(true)
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
  }

  return (
    <Dropdown label={`命令·${label}`} ariaLabel="命令执行策略" icon={<ShieldCheck size={14} />}>
      {POLICIES.map((item) => (
        <button
          key={item.value}
          type="button"
          className="flex w-full cursor-pointer items-center gap-[var(--space-2)] rounded-[var(--radius-control)] px-[var(--space-3)] py-[var(--space-2)] text-left text-[length:var(--text-meta-size)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-60"
          disabled={saving}
          title={item.hint}
          onClick={() => void choose(item.value)}
        >
          <span className="inline-flex w-[14px] shrink-0 text-[var(--accent)]">
            {item.value === mode ? <Check size={14} /> : null}
          </span>
          <span>{item.label}</span>
        </button>
      ))}
    </Dropdown>
  )
}
