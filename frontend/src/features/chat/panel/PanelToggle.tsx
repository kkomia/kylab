/**
 * 打开 / 收起右侧面板的那一颗按钮。
 *
 * ## 为什么是独立一个组件、而不是长在某一列里
 *
 * 它的位置是**页面（主区）的右上角**（用户口径，2026-10-09："常驻在页面右上角，
 * 不被对话列的样式包住，面板关着时也在同一个位置"）。原先它长在会话条那一行的末尾
 * （`ChatHeader` 里那个 `ml-auto`），于是位置跟着**对话列**走：面板一开，对话列窄了
 * 380，它就往左跳一大截；它还落在消息列那条 768 的居中窄列里，本来就不在最右边。
 *
 * 现在它有两个挂载点，**同一颗按钮、同一个位置**：
 *
 * | 面板 | 挂在哪 | 视觉位置 |
 * | --- | --- | --- |
 * | 关着 | `ChatPage` 那一行的右上角（绝对定位，见 `.ch-panel-corner`） | 页面右上角 |
 * | 开着 | 面板标签条（`ch-panel-tabs`）的右端 | **还是**页面右上角（面板右缘就是页面右缘） |
 *
 * 两处都靠右缘 `--space-2` 起算、都在 44px 那一行里居中，所以开关那一下按钮**不会动**。
 * 让标签条右端那两颗是「全屏 / 收起」的正是这一条：`SidePanel` 把「全屏」摆在标签条的
 * 最右端，紧挨着它右边就是这一颗（那一侧留出的位置见 `panel.css` 里
 * `.ch-panel-tabs` 的 `padding-right`）。
 *
 * 未读角标只在**关着**时画：开着的时候那个数在标签条的小圆点上，再说一遍是重复的。
 */
import { PanelRight } from 'lucide-react'

import { usePanelStore } from './panelStore'

export function PanelToggle() {
  const open = usePanelStore((state) => state.open)
  const toggle = usePanelStore((state) => state.toggle)
  /**
   * 面板里还有几个**没看过**的标签（agent 抓页建出来的那些，见 `panelStore.unread`）。
   *
   * 只在**面板关着**时露出来：开着的时候那个数在标签条的小圆点上（用户正看着标签条，
   * 再说一遍是重复的）。
   */
  const unseen = usePanelStore((state) => state.unread.length)

  return (
    <button
      type="button"
      className="ch-panel-action"
      aria-pressed={open}
      aria-label={open ? '收起右侧面板' : '打开右侧面板'}
      title={
        !open && unseen > 0
          ? `打开右侧面板（${unseen} 个新页面）`
          : open
            ? '收起右侧面板'
            : '打开右侧面板'
      }
      onClick={toggle}
    >
      <PanelRight size={16} />
      {!open && unseen > 0 ? (
        <span
          aria-hidden
          data-unseen={unseen}
          className="absolute -top-0.5 -right-0.5 inline-flex h-[14px] min-w-[14px] items-center justify-center rounded-[var(--radius-pill)] bg-[var(--accent)] px-[3px] text-[length:var(--text-micro-size)] leading-none text-[var(--Always-White)]"
        >
          {unseen}
        </span>
      ) : null}
    </button>
  )
}

export default PanelToggle
