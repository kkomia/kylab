/**
 * 对话页右端那一列：标签条 + 内容（「文件」与「网页」两种标签）。
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
 * （仿 Kimi 的初始态：功能入口 + 一行灰字），面板**不跟着收**——开合是用户自己那一位。
 *
 * ## 两个入口各自开什么（「网页」这一档进来之后）
 *
 * | 入口 | 落点 |
 * | --- | --- |
 * | 「+」菜单 / 空态里的「文件」 | 「文件」标签（**单例**：再开一次只是激活它） |
 * | 「+」菜单 / 空态里的「网页」 | 标签条里**原地出现一个地址输入框**（不先建标签） |
 *
 * 网页那一条**先问地址再建标签**：没有地址就没有"这一页"，凭空建一个空标签再让用户
 * 自己找地方填地址，比原地开一格输入框多两步。那一格输入框是**同一份状态**，
 * 所以"空态里点网页"与「+」菜单里点网页落到的**是同一个东西**。
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { FileText, Folder, Globe, Plus, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { hostOfUrl, siteOfDomain } from '../model/webSites'
import { MENU_ITEM, MENU_PANEL } from '../ui/DropdownShell'
import { FilesTab } from './FilesTab'
import { usePanelStore, type PanelTab } from './panelStore'
import { usePanelOverlay } from './usePanelLayout'
import { WebTab } from './WebTab'
import { normalizeWebUrl } from './webText'
// 面板的全部样式。**挂在这一层**（面板的外壳）而不是 `FilesTab`：这一份里也有外壳、
// 标签条、空态那一半，它们在"一个标签都没有"时也要在——挂到 `FilesTab` 上的话，
// 空态那一屏会是没样式的裸字（2026-10-05 真机走查就是这么发现的：
// CSS 没被任何地方 import，整个面板按浏览器默认样式排）。
import './panel.css'

/**
 * 标签上的名字：文件标签是固定的一枚；网页标签用抓回来的标题，**没有标题就退一步**
 * ——站点名（本机表里的名字，如「知乎」）→ 域名 → 地址。
 *
 * 退的那两步都要有：嵌入档**根本不抓正文**（见 `WebTab` 的文件头），那一刻没有标题可写；
 * 阅读档在正文回来之前也没有。只写地址的话，标签条上就是一串挤在一起的 URL。
 */
function labelOf(tab: PanelTab): string {
  if (tab.kind === 'files') return '文件'
  const site = siteOfDomain(hostOfUrl(tab.url))
  return tab.title || site.name || tab.url
}

function TabIcon({ tab }: { tab: PanelTab }) {
  if (tab.kind === 'files') return <FileText size={13} />
  return <Globe size={13} />
}

export function SidePanel() {
  const open = usePanelStore((state) => state.open)
  const tabs = usePanelStore((state) => state.tabs)
  const activeId = usePanelStore((state) => state.activeId)
  const unread = usePanelStore((state) => state.unread)
  const activate = usePanelStore((state) => state.activate)
  const closeTab = usePanelStore((state) => state.closeTab)
  const openFilesTab = usePanelStore((state) => state.openFilesTab)
  const openWebTab = usePanelStore((state) => state.openWebTab)
  const setOpen = usePanelStore((state) => state.setOpen)
  const overlay = usePanelOverlay()
  const listRef = useRef<HTMLDivElement | null>(null)
  /**
   * 地址输入框里正在打的那一行（`null` = 没有在输）。
   *
   * 它是**两个入口共用的一份状态**（见文件头那张表）：空态里的「网页」与「+」菜单里的
   * 「打开网页…」都是把它摆成 `''`。空串与 `null` 必须分开——`''` 是"输入框开着、
   * 还是空的"，`null` 是"压根没有这一格"。
   */
  const [draft, setDraft] = useState<string | null>(null)
  /** 那一行认不出来（不给假动作：认不出来当场说，别去请求一个必然失败的地址）。 */
  const [rejected, setRejected] = useState(false)

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

  /** 开那个地址（认不出来就留在原地、把那一格标红）。 */
  function submitDraft(): void {
    const next = normalizeWebUrl(draft ?? '')
    if (!next) {
      setRejected(true)
      return
    }
    setDraft(null)
    setRejected(false)
    openWebTab(next)
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
                /*
                  未读那件事挂在**按钮的名字**上（`aria-label`）：那枚小圆点对读屏是
                  不可见的（`aria-hidden`），不在这里说一声，读屏用户不会知道
                  "面板里多了东西"。名字里带着可见的那一段文字（WCAG 2.5.3）。
                */
                aria-label={unread.includes(tab.id) ? `${labelOf(tab)}（还没看过）` : labelOf(tab)}
                onClick={() => activate(tab.id)}
              >
                <span className="ch-panel-tab-icon" aria-hidden>
                  <TabIcon tab={tab} />
                </span>
                <span className="ch-panel-tab-name">{labelOf(tab)}</span>
                {/*
                  未读小圆点：agent 抓页建出来的标签**不抢焦点**，所以"有新东西"要靠它
                  说出来（面板关着时那颗开关上的角标是同一个数的另一种说法，见 ChatHeader）。
                */}
                {unread.includes(tab.id) ? (
                  <span className="ch-panel-tab-dot" aria-hidden data-unread="true" />
                ) : null}
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
              <button type="button" className="ch-panel-add" aria-label="打开" title="打开">
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
                <DropdownMenu.Item className={MENU_ITEM} onSelect={() => openFilesTab()}>
                  <Folder size={14} />
                  文件
                </DropdownMenu.Item>
                {/* 「打开网页…」= 摆出那一格地址输入框，**先问地址再建标签**（见文件头） */}
                <DropdownMenu.Item
                  className={MENU_ITEM}
                  onSelect={() => {
                    setRejected(false)
                    setDraft('')
                  }}
                >
                  <Globe size={14} />
                  打开网页…
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      ) : null}

      {/*
        地址输入框的**唯一一处宿主**（在标签条与内容之间）：空态与有标签时都摆在这儿，
        所以两个入口不用各写一份。`onBlur` 收起来、`Enter` 才开——与地址栏那一格同一口径。
      */}
      {draft === null ? null : (
        <form
          className="ch-panel-webopenform"
          onSubmit={(event) => {
            event.preventDefault()
            submitDraft()
          }}
        >
          <input
            // 点了菜单项才出现这一格，焦点就该在它里面
            autoFocus
            type="text"
            className="ch-panel-webopeninput"
            aria-label="网页地址"
            aria-invalid={rejected}
            placeholder="粘贴网址"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setDraft(null)
            }}
          />
          {rejected ? (
            <p className="ch-panel-text" data-tone="bad">
              这个地址认不出来，只认 http / https 的网址。
            </p>
          ) : null}
        </form>
      )}

      {active ? (
        active.kind === 'files' ? (
          <FilesTab />
        ) : (
          <WebTab tab={active} />
        )
      ) : (
        /*
          空态（仿 Kimi 的初始态）：给的是**能开什么**，不是"这里是什么"。
          这两项与「+」菜单里同名同图标——每一项都是同一件事的第二个入口。
        */
        <div className="ch-panel-empty">
          <button type="button" className="ch-panel-empty-item" onClick={() => openFilesTab()}>
            <Folder size={16} aria-hidden />
            文件
          </button>
          <button
            type="button"
            className="ch-panel-empty-item"
            onClick={() => {
              setRejected(false)
              setDraft('')
            }}
          >
            <Globe size={16} aria-hidden />
            网页
          </button>
          <p className="ch-panel-empty-text">打开的文件与网页会留在这里。</p>
        </div>
      )}
    </aside>
  )
}
