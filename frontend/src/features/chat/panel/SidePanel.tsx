/**
 * 对话页右端那一列：标签条 + 内容（本轮只有「文件」这一种标签）。
 *
 * ## 它是**常驻的一列**，不是浮层
 *
 * 与引用原文、产物与文件那两只抽屉（Radix `Sheet`：贴边滑出、盖在页面上、遮罩挡着）
 * 是**两回事**。面板要一直摆在那儿：左边对话照旧能读、能点、能滚，用户在文件树里翻到
 * 一半回头问一句，面板里的位置一点不动。用抽屉那套原语反而会去抢焦点、加遮罩。
 *
 * 唯一的例外是**窄屏**（< 1100）：那时它改盖在聊天列上（`data-overlay`，理由见
 * `panel.css` 与 `usePanelLayout.ts`），此时它是"临时的浮层"，所以按 `Esc` 收起来
 * ——常驻态下 `Esc` 不关它（面板是页面的一部分，按一下 Esc 就没了会莫名其妙）。
 *
 * ## 标签条是自绘的
 *
 * 不用 `@/ui/tabs`：那个 trigger 是 `flex-1` 等宽的（三个标签各占三分之一，长得像
 * 分段开关），而标签该按名字的宽度排；它的下划线指示条也与"44px 高、带关闭键"的标签
 * 不是一套东西。这里自己接 `role=tablist/tab` 与 `←`/`→`（规范里 tablist 的那条键盘约定）。
 *
 * ## 关标签之后当前标签挪到哪儿
 *
 * 右邻，没有右邻就左邻（规则写在 `panelStore.closeTab`）。一个都不剩时是**空态**那一屏
 * （仿 Kimi 的初始态：一个功能入口 + 一行灰字），面板**不跟着收**——开合是用户自己那一位。
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { FileText, Folder, Globe, Plus, X } from 'lucide-react'
import { useEffect, useRef } from 'react'

import { MENU_ITEM, MENU_PANEL } from '../ui/DropdownShell'
import { FilesTab } from './FilesTab'
import { usePanelStore, type PanelTab } from './panelStore'
import { usePanelOverlay } from './usePanelLayout'
// 面板的全部样式。**挂在这一层**（面板的外壳）而不是 `FilesTab`：这一份里也有外壳、
// 标签条、空态那一半，它们在"一个标签都没有"时也要在——挂到 `FilesTab` 上的话，
// 空态那一屏会是没样式的裸字（2026-10-05 真机走查就是这么发现的：
// CSS 没被任何地方 import，整个面板按浏览器默认样式排）。
import './panel.css'

/** 标签上的名字：文件标签是固定的一枚，网页标签用它的标题（没有标题时退回域名）。 */
function labelOf(tab: PanelTab): string {
  if (tab.kind === 'files') return '文件'
  return tab.title || tab.url
}

function TabIcon({ tab }: { tab: PanelTab }) {
  if (tab.kind === 'files') return <FileText size={13} />
  return <Globe size={13} />
}

export function SidePanel() {
  const open = usePanelStore((state) => state.open)
  const tabs = usePanelStore((state) => state.tabs)
  const activeId = usePanelStore((state) => state.activeId)
  const activate = usePanelStore((state) => state.activate)
  const closeTab = usePanelStore((state) => state.closeTab)
  const openFilesTab = usePanelStore((state) => state.openFilesTab)
  const setOpen = usePanelStore((state) => state.setOpen)
  const overlay = usePanelOverlay()
  const listRef = useRef<HTMLDivElement | null>(null)

  // 浮层态才吃 Esc（常驻态下它不是"临时的东西"，见文件头注）
  useEffect(() => {
    if (!open || !overlay) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, overlay, setOpen])

  if (!open) return null

  const active = tabs.find((tab) => tab.id === activeId) ?? null

  /**
   * `←`/`→` 在标签之间走一圈（到头绕回去，与规范里 tablist 的键盘约定一致）。
   *
   * 焦点**手动**挪到下一颗上：`tabIndex` 那套 roving tabindex 只把"能 Tab 到"的那一颗
   * 减到一颗，按了方向键之后焦点还得跟过去，否则连按两下第二次就没反应了
   * （焦点还留在原来那颗上）。节点本来就在 DOM 里，直接 `.focus()` 即可。
   */
  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
    if (tabs.length < 2) return
    event.preventDefault()
    const step = event.key === 'ArrowRight' ? 1 : -1
    const index = tabs.findIndex((tab) => tab.id === activeId)
    const nextIndex = (index + step + tabs.length) % tabs.length
    activate(tabs[nextIndex].id)
    listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[nextIndex]?.focus()
  }

  return (
    <aside className="ch-panel-shell" data-overlay={overlay} aria-label="右侧面板">
      {tabs.length > 0 ? (
        <div
          className="ch-panel-tabs"
          role="tablist"
          aria-label="面板标签"
          ref={listRef}
          onKeyDown={onKeyDown}
        >
          {tabs.map((tab) => (
            <div key={tab.id} className="ch-panel-tab" data-active={tab.id === activeId}>
              <button
                type="button"
                role="tab"
                aria-selected={tab.id === activeId}
                // roving tabindex：整条标签条在 Tab 序里只占一格，进去之后用 ←/→ 走
                tabIndex={tab.id === activeId ? 0 : -1}
                className="ch-panel-tab-main"
                title={labelOf(tab)}
                onClick={() => activate(tab.id)}
              >
                <span className="ch-panel-tab-icon" aria-hidden>
                  <TabIcon tab={tab} />
                </span>
                <span className="ch-panel-tab-name">{labelOf(tab)}</span>
              </button>
              <button
                type="button"
                className="ch-panel-tab-close"
                aria-label={`关闭 ${labelOf(tab)}`}
                title="关闭"
                onClick={() => closeTab(tab.id)}
              >
                <X size={12} />
              </button>
            </div>
          ))}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button type="button" className="ch-panel-add" aria-label="打开" title="打开文件">
                <Plus size={15} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                side="bottom"
                align="start"
                sideOffset={6}
                className={MENU_PANEL}
              >
                {/*
                  **只有「文件」这一项**：本轮另一种标签（网页）只有类型与入口的占位，
                  视图下一轮做。与其摆一条点了没反应的灰项（还要写一段"下一轮开放"的解释），
                  不如就一项——下一轮它旁边多一行「打开网页…」即可。
                */}
                <DropdownMenu.Item className={MENU_ITEM} onSelect={() => openFilesTab()}>
                  <Folder size={14} />
                  文件
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      ) : null}

      {active ? (
        active.kind === 'files' ? (
          <FilesTab />
        ) : null
      ) : (
        /*
          空态（仿 Kimi 的初始态）：给的是**能开什么**，不是"这里是什么"。
          「文件」那一项与「+」菜单里同名同图标——它是同一件事的第二个入口。
        */
        <div className="ch-panel-empty">
          <button type="button" className="ch-panel-empty-item" onClick={() => openFilesTab()}>
            <Folder size={16} aria-hidden />
            文件
          </button>
          <p className="ch-panel-empty-text">打开的文件会留在这里。</p>
        </div>
      )}
    </aside>
  )
}
