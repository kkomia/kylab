/**
 * 输入框那一排的「权限」：**仅查看 / 手动批准 / 默认 / 全自动**（2026-09-29 四档）。
 *
 * 它是用户定下的**两根轴**里的第一根（另一根是"任务模式"：目标 / 计划，在设置页）：
 * 这一根管**能不能碰 × 要不要问**，那一根管**怎么干活**。原先这根轴是四档模式的一部分
 * （``build``/``edit``/``yolo`` 的差别其实就在"能碰多少"），拆开之后它有了自己的位置
 * ——**加号右边、知识库左边**（用户指定的位置）。
 *
 * **读写的就是设置页那一份**（`chat.permission`，走 `/settings` 那两个接口）：
 * 在这里另存一份是最危险的实现方式——两处显示的档迟早不一致，而"我明明改成全自动了，
 * 它怎么还拦"正是最难查的一类问题（同一份数据，这里只是它的另一个门）。
 *
 * 它同时**取代了原来那一项「命令执行策略」**（allow / ask / deny）：
 * 命令能不能跑由这一档决定（仅查看不跑、手动批准每条都问、默认工作区内不问而出界/联网才问、
 * 全自动直接跑），设置里不再单设一项——两处都说"命令能不能跑"，
 * 必然出现"界面上写着允许、实际还是被拒"。
 *
 * 非管理员**不显示**：这一档背后是管理员端点，摆在成员眼前只会让他点了拿到 403。
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ShieldCheck } from 'lucide-react'
import { useState } from 'react'

import { getSettings, updateSettings } from '@/api/settings'
import { useSessionStore } from '@/lib/session'

import { notifyError, notifySuccess } from '../runtime/notify'
import { CONTROL_TRIGGER, MENU_CHECK, MENU_ITEM, MENU_PANEL } from './DropdownShell'

/** 后端设置项的键。**不另起名字**：改的就是设置页那一项。 */
const KEY = 'chat.permission'

/**
 * 四档的名字与那一句人话。
 *
 * **与后端 `services/modes.PERMISSION_DEFS` 同源**（那边的 `describe_permissions()`
 * 供设置页的下拉项用）：这里这一份是**控件自己那份**——两者的 label 必须一字不差，
 * 否则"胶囊上写着默认、设置页里写着别的"就会同时出现在两张截图上。
 * 取值与顺序也照它（由严到松：仅查看 → 手动批准 → 默认 → 全自动）。
 */
const LEVELS: { value: string; label: string; hint: string }[] = [
  { value: 'view', label: '仅查看', hint: '只看不动：不改文件、不跑命令' },
  { value: 'manual', label: '手动批准', hint: '每条都问你：写与命令都要先问一次' },
  { value: 'smart', label: '默认', hint: '只读与工作区内直接做；越界、联网、删除、危险命令要问' },
  { value: 'full', label: '全自动', hint: '写与命令都放行、也不再问' },
]

/** 是否管理员：这一排里的设置入口都是管理员端点。会话还没恢复完时按"不是"处理。 */
export function useIsAdmin(): boolean {
  const user = useSessionStore((state) => state.currentUser)
  return user?.role === 'admin'
}

/**
 * 当前权限档与写入动作。
 *
 * **触发器与菜单里的三档都读这一处**：两处各写一份的话，"显示的是哪一档"
 * 与"点了写哪一档"迟早对不上（这一档的全部风险就在这里）。
 */
export function usePermission(): {
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
    queryKey: ['chat', 'permission'],
    queryFn: async (): Promise<string | null> => {
      const view = await getSettings()
      const field = view.groups
        .find((group) => group.key === 'chat')
        ?.fields.find((item) => item.key === KEY)
      return field?.value ?? null
    },
    enabled: isAdmin,
  })

  // 读不到就**不显示这个入口**：它是顺手的入口，不值得为它把对话页变成错误提示
  const current = query.data ?? null
  const label = current === null ? '' : (LEVELS.find((i) => i.value === current)?.label ?? current)

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
        client.setQueryData(['chat', 'permission'], value)
        const chosen = LEVELS.find((item) => item.value === value)
        // 说的是"从哪一刻起生效"，不是解释这一档是什么（后者是设置页的事）
        notifySuccess(`权限已改成「${chosen?.label ?? value}」，下一个动作就生效`)
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
 * 那一排上的胶囊：**只写档名**（默认档写的就是「默认」）。
 *
 * 原先写的是 `权限·工作区内编辑`（旧档名）：那颗胶囊上有盾牌图标、位置就在加号右边，
 * 而"权限"两个字在每一帧里都在，用户要的只是档名（原话："这个权限按钮不要加权限俩字"）。
 * **"这是什么"不能丢**，所以它挪到了无障碍名字上（`aria-label`）——
 * 屏幕阅读器与用例读到的仍是完整语义，屏幕上只剩档名。
 */
export function PermissionControl() {
  const { ready, label, current, saving, choose } = usePermission()
  if (!ready) return null

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className={CONTROL_TRIGGER}
          aria-label={`权限：${label}`}
          title="这一轮它能碰多少"
        >
          <ShieldCheck size={14} />
          <span className="max-w-[168px] truncate">{label}</span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content side="top" align="start" sideOffset={6} className={MENU_PANEL}>
          <DropdownMenu.RadioGroup value={current ?? ''} onValueChange={(value) => choose(value)}>
            {LEVELS.map((item) => (
              <DropdownMenu.RadioItem
                key={item.value}
                value={item.value}
                disabled={saving}
                title={item.hint}
                data-permission={item.value}
                className={`${MENU_ITEM} data-[disabled]:cursor-default data-[disabled]:opacity-60`}
              >
                <span className={MENU_CHECK}>
                  {item.value === current ? <Check size={14} /> : null}
                </span>
                <span>{item.label}</span>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
