/**
 * 面板上的「网页」标签：**三档互斥**——嵌入（原页 iframe）/ 阅读（抓回来的正文）/
 * 抓不到（只说原因 + 给一条出路）。
 *
 * ## 档位怎么选：先探测、再决定，**不靠 iframe 自己报错**
 *
 * 进来的第一件事是 `GET /web/embed-check`（`useWebEmbed`）。为什么不能"先挂 iframe，
 * 载不进去再退阅读模式"：**HTTP 错误对 iframe 也是一次"成功加载"**——对方 403 或
 * 404 时，`onError` 根本不触发，用户看到的是一张写满了对方站点样式的错误页，
 * 而界面还当它是正常的一档。所以判据只有"挂载之前的那一次探测结论"这一条。
 *
 * `embeddable: true` → 嵌入档；`false` → 阅读档。**用户可以覆盖**（`⋯` 菜单里那两档）：
 * 探测说能嵌、他偏要读正文；探测说不能嵌、他偏要试一次（对方用 JS 自检、或者探测那次
 * 恰好超时，都可能让一个本来能嵌的页面被判成不能嵌）。覆盖是**按地址**记的
 * （`override.url === url`）——换了地址就回到自动那一档，否则"上一页我选了阅读模式"
 * 会莫名其妙地跟着到下一页。
 *
 * **挑过的那一档压过探测的失败**（真机上撞出来的）：探测那一条请求自己失败时（边车那一刻
 * 不在），错误那一屏原先排在所有分支最前面，于是用户点「阅读模式」也毫无反应——他选的
 * 明明是一条**不需要探测**的路。现在错误只决定**自动那一档**，挑过就听用户的（判据是
 * `choice` 那一处）。
 *
 * ## 阅读档的诚实口径
 *
 * 这一档画出来的是**我们抓回来的那一份正文**，不是那个网站本身：没有它的样式、脚本、
 * 交互，可能还只是文章主体（后端 `extract_article` 抽过）。所以抬头那一行必须说清楚
 * （用户明确要的这一条），并给出「在系统浏览器打开」这条出路——真想看那个网站，
 * 那儿才是它本人。
 *
 * 正文里的两条纪律：
 *
 * 1. **链接只认绝对 http(s)，点了是标签内导航**（写进这个标签自己的 `history`）：
 *    面板是一个"浏览"的地方，点一条链接就把用户弹出到系统浏览器会让他丢掉当前位置，
 *    而正文里的相对链接相对的是**那一页**（`/about` 在我们的面板里指不到对方的服务器），
 *    所以非绝对地址一律不动作；
 * 2. **图片不自动加载**：渲染前先把 `![…](…)` 降级成链接（`demoteImageSyntax`），
 *    否则浏览器会照着正文里的图片地址去访问第三方站点，把用户的 IP 与访问时刻交出去。
 *    这与 `model/webSites.ts` / `ui/siteLogos.ts` 是同一条纪律（站点图标只向**我们自己的源**要）。
 *
 * ## iframe 那一档的属性都不是随手写的
 *
 * - `sandbox="allow-scripts allow-same-origin allow-forms allow-popups"`：原页要能跑
 *   （不然绝大多数站点是一片空白），但**不给** `allow-top-navigation`（不能把我们这一页
 *   顶走）、不给 `allow-modals`（不许弹窗）。`allow-same-origin` 与 `allow-scripts` 同时
 *   给是**刻意的**：这里嵌的是**别人的源**，不是我们自己的页，那个著名的
 *   "sandbox 逃逸"组合拳说的正是"同一个源里脚本 + 同源"这一种，而这一档天然不满足；
 * - `referrerPolicy="no-referrer"`：别把这一页的地址当 referer 交出去；
 * - `loading="lazy"`：面板里标签多了不该一上来就把每一页都拉起来。
 *
 * ## 刷新
 *
 * `⟳` 做两件事：**重新抓**（`refetch`，抓取时间跟着更新）与**换一个 iframe**（`key`
 * 上加一个自增数，逼它重建）。两者都是"再要一次"的诚实做法——iframe 没有跨源的重载手段
 * （拿不到它内部的 `location`），换 key 是唯一干净的那条。
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  ExternalLink,
  Globe,
  MoreHorizontal,
  RefreshCw,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { copyText } from '@/lib/clipboard'
import { formatRelativeTime } from '@/lib/format'
import type { WebEmbedCheck } from '@/api/web'

import { renderPlainMarkdown } from '../model/markdown'
import { hostOfUrl, siteOfDomain } from '../model/webSites'
import { notifyWarning } from '../runtime/notify'
import { MENU_CHECK, MENU_ITEM, MENU_PANEL } from '../ui/DropdownShell'
import { useSiteLogo } from '../ui/siteLogos'
import { usePanelStore, type PanelTab } from './panelStore'
import { useWebEmbed, useWebPage } from './useWebData'
import { demoteImageSyntax, normalizeWebUrl } from './webText'

/** 网页标签的两种查看方式（自动选择只是在这两档之间选，见文件头）。 */
type WebMode = 'embed' | 'reader'

/** 抓回来的正文里到底有哪些链接可以点：绝对 http(s) 才算（理由见文件头）。 */
const ABSOLUTE_URL = /^https?:\/\//i

/**
 * 探测的结论 → **自动那一档**（用户没挑过时用它）。
 *
 * 还没结论时有两种情况，各自对应一屏：**失败**（那条请求自己的原因 + 出路，别拿它去
 * 猜"能不能嵌"）与**在飞**（"正在问对方…"）。两个都不是 `WebMode`，所以返回值多两档。
 */
function autoChoice(probe: {
  data?: WebEmbedCheck
  isError: boolean
}): WebMode | 'pending' | 'error' {
  if (probe.data) return probe.data.embeddable ? 'embed' : 'reader'
  return probe.isError ? 'error' : 'pending'
}

export function WebTab({ tab }: { tab: Extract<PanelTab, { kind: 'web' }> }) {
  const navigate = usePanelStore((state) => state.navigateWebTab)
  const setTabTitle = usePanelStore((state) => state.setTabTitle)
  const url = tab.url
  /** 用户手动选的那一档（按地址记，见文件头）。 */
  const [override, setOverride] = useState<{ url: string; mode: WebMode } | null>(null)
  /** 地址栏的编辑态（`null` = 只读展示那一档）。 */
  const [draft, setDraft] = useState<string | null>(null)
  /** 输入框里那个地址认不出来（不给假动作，见 `webText.normalizeWebUrl`）。 */
  const [rejected, setRejected] = useState(false)
  /** `⟳` 的重建计数（iframe 没有跨源重载的手段，见文件头）。 */
  const [nonce, setNonce] = useState(0)

  const embed = useWebEmbed(url, true)
  /**
   * 这一档是哪一档（**用户选的那一档优先**，见文件头"可覆盖"那一段）。
   *
   * 五种取值各对应一屏：
   *
   * | 取值 | 什么时候 | 画什么 |
   * | --- | --- | --- |
   * | `'reader'` / `'embed'` | 用户从 `⋯` 菜单里挑过 | 就是那一档（探测说什么都不改） |
   * | `'pending'` | 还没挑过、探测在飞 | 「正在问对方能不能嵌…」 |
   * | `'error'` | 还没挑过、探测自己失败了 | 那条请求的原因 + 一条出路 |
   * | `'embed'` / `'reader'` | 还没挑过、探测有结论 | 按结论分派（`autoChoice`） |
   *
   * 为什么"挑过的"要压过探测的**失败**（这是真机上撞出来的）：探测那一条失败（边车那一刻
   * 不在、或本机面那一层判成"浏览器形态"）之后，如果错误分支永远排在最前面，用户点
   * 「阅读模式」也不会得到任何反应——他明明选了一条**不需要探测**的路，界面却拿一次
   * 探测的失败把他挡在门外。所以错误只决定**自动那一档**：用户挑过就听他的。
   */
  const choice: WebMode | 'pending' | 'error' =
    override?.url === url ? override.mode : autoChoice(embed)
  // 嵌入档不抓正文（那一档画的是原页本身，Markdown 一个字都用不上）
  const page = useWebPage(url, choice === 'reader')

  const site = useMemo(() => siteOfDomain(hostOfUrl(url)), [url])
  const logo = useSiteLogo(site)
  const title = page.data?.title.trim() ?? ''
  useEffect(() => {
    if (title) setTabTitle(tab.id, title)
  }, [tab.id, title, setTabTitle])

  const canBack = tab.index > 0
  const canForward = tab.index < tab.history.length - 1

  /** 换地址：认不出来就**在原地说不认**，不把用户丢进一个必然失败的请求。 */
  function submitDraft(): void {
    const next = normalizeWebUrl(draft ?? '')
    if (!next) {
      setRejected(true)
      return
    }
    setRejected(false)
    setDraft(null)
    navigate(tab.id, next)
  }

  /** 正文里的链接接管（理由见文件头）。 */
  function onContentClick(event: React.MouseEvent<HTMLDivElement>): void {
    const anchor = (event.target as HTMLElement).closest('a')
    if (!anchor) return
    const href = anchor.getAttribute('href') ?? ''
    event.preventDefault()
    if (ABSOLUTE_URL.test(href)) navigate(tab.id, href)
  }

  return (
    <>
      <div className="ch-panel-bar">
        <div className="ch-panel-webbar">
          <button
            type="button"
            className="ch-panel-tool"
            aria-label="后退"
            title="后退"
            disabled={!canBack}
            onClick={() => navigate(tab.id, tab.history[tab.index - 1]!)}
          >
            <ArrowLeft size={15} />
          </button>
          <button
            type="button"
            className="ch-panel-tool"
            aria-label="前进"
            title="前进"
            disabled={!canForward}
            onClick={() => navigate(tab.id, tab.history[tab.index + 1]!)}
          >
            <ArrowRight size={15} />
          </button>
          <button
            type="button"
            className="ch-panel-tool"
            aria-label="刷新"
            title="重新抓一次"
            onClick={() => {
              setNonce((value) => value + 1)
              void embed.refetch()
              if (choice === 'reader') void page.refetch()
            }}
          >
            <RefreshCw size={15} />
          </button>

          {draft === null ? (
            /*
              只读展示那一档是一颗**按钮**而不是一个 `readonly` 输入框：地址常常比面板宽，
              一个只读输入框会带着自己的滚动与光标语义，还占着 Tab 序里的一格却什么也做不了。
              点它才变成输入框（`draft !== null`），那时光标在末尾、内容全选过一次就够。
            */
            <button
              type="button"
              className="ch-panel-address"
              aria-label="网页地址"
              title={url}
              onClick={() => {
                setRejected(false)
                setDraft(url)
              }}
            >
              <span className="ch-panel-address-text">{url}</span>
            </button>
          ) : (
            <input
              // 点了地址栏才出现这一格，焦点就该在它里面（不是在别处等用户再点一次）
              autoFocus
              className="ch-panel-address ch-panel-address--input"
              aria-label="网页地址"
              aria-invalid={rejected}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  submitDraft()
                  return
                }
                if (event.key === 'Escape') setDraft(null)
              }}
              onBlur={() => setDraft(null)}
            />
          )}

          {/*
            「在系统浏览器打开」是一整颗独立按钮（不是 `⋯` 菜单里的一项）：
            它是这一档最常用的一条出路——阅读模式看到的是抓回来的正文、嵌入档也可能
            被对方的 JS 拦下，那时用户的下一步就是"去真的浏览器里看它"。
          */}
          <button
            type="button"
            className="ch-panel-tool"
            aria-label="在系统浏览器打开"
            title="在系统浏览器打开"
            onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}
          >
            <ExternalLink size={15} />
          </button>

          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button type="button" className="ch-panel-tool" aria-label="更多" title="更多">
                <MoreHorizontal size={15} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content side="bottom" align="end" sideOffset={6} className={MENU_PANEL}>
                <DropdownMenu.Label className="ch-panel-menu-line">查看方式</DropdownMenu.Label>
                <DropdownMenu.RadioGroup
                  value={choice === 'pending' || choice === 'error' ? undefined : choice}
                  onValueChange={(value) => setOverride({ url, mode: value as WebMode })}
                >
                  <DropdownMenu.RadioItem value="reader" className={MENU_ITEM}>
                    <span className={MENU_CHECK}>
                      {choice === 'reader' ? <Check size={14} /> : null}
                    </span>
                    <span>阅读模式</span>
                  </DropdownMenu.RadioItem>
                  <DropdownMenu.RadioItem value="embed" className={MENU_ITEM}>
                    <span className={MENU_CHECK}>
                      {choice === 'embed' ? <Check size={14} /> : null}
                    </span>
                    <span>嵌入原页</span>
                  </DropdownMenu.RadioItem>
                </DropdownMenu.RadioGroup>
                <DropdownMenu.Item
                  className={MENU_ITEM}
                  onSelect={() => {
                    void copyText(url).then((ok) => {
                      if (!ok) notifyWarning('链接没复制上，请手动选中后复制')
                    })
                  }}
                >
                  <Copy size={14} />
                  复制链接
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
        {/* 地址栏那一格认不出来时**当场说**（不是等一个必然失败的请求回来再说） */}
        {rejected ? (
          <p className="ch-panel-text" data-tone="bad">
            这个地址认不出来，只认 http / https 的网址。
          </p>
        ) : null}
      </div>

      {choice === 'pending' ? (
        <div className="ch-panel-scroll">
          <p className="ch-panel-text">正在问对方能不能嵌…</p>
        </div>
      ) : choice === 'error' ? (
        /*
          探测这一条**自己**失败了（400 被 SSRF 闸拦 / 边车那一刻不在 / 别的错）：
          `embeddable: false` 那种正常答案走的是阅读档，不该到这里来（后端把"探不到"
          也做成了 200 + false）。所以这里显示的就是那条请求自己的原因，照原样说，
          再给"去系统浏览器"这条出路。

          **只有"还没挑过"才会到这里**（见 `choice` 的说明）：用户挑过的那一档优先，
          一次探测失败不该把他自己选的那条路也挡掉。
        */
        <div className="ch-panel-scroll">
          <p className="ch-panel-text" data-tone="bad">
            {embed.error instanceof Error ? embed.error.message : '打不开这一页'}
          </p>
          <OpenExternal url={url} />
        </div>
      ) : choice === 'embed' ? (
        <div className="ch-panel-scroll">
          {/*
            手动切到嵌入档、而探测说不能嵌（或者根本没探成）时，把对方那句话摆出来：
            否则用户面对的是一片空白，看不出"是我让他嵌的"还是"这一页坏了"。
          */}
          {!embed.data || embed.data.embeddable ? null : (
            <p className="ch-panel-text">{embed.data.reason || '对方不让这一页被嵌进来。'}</p>
          )}
          <div className="ch-panel-frame">
            <iframe
              // 换地址或按了 ⟳ 就重建一个（理由见文件头）
              key={`${url}#${nonce}`}
              className="ch-panel-frame-body"
              title={title || url}
              src={url}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              referrerPolicy="no-referrer"
              loading="lazy"
            />
          </div>
        </div>
      ) : (
        <div className="ch-panel-scroll">
          {page.isPending ? (
            <p className="ch-panel-text">正在抓取正文…</p>
          ) : page.isError || !page.data ? (
            <>
              {/* 抓不回来的原因**原样**显示（400 是那道闸的原话、502 是上游的事） */}
              <p className="ch-panel-text" data-tone="bad">
                {page.error instanceof Error ? page.error.message : '这一页没抓回来'}
              </p>
              <OpenExternal url={url} />
            </>
          ) : (
            <>
              <div className="ch-panel-webhead">
                <span className="ch-panel-row-icon">
                  {logo ? (
                    <img className="ch-panel-weblogo" src={logo} alt="" aria-hidden />
                  ) : site.badge ? (
                    <span className="ch-panel-weblogo ch-panel-weblogo--letter" aria-hidden>
                      {site.badge}
                    </span>
                  ) : (
                    /* 认不出的站点画一枚通用地球：域名首字母那一档已经撤掉了
                       （2026-10-01 用户："你放个字母标在这儿没意义啊"） */
                    <Globe size={13} aria-hidden />
                  )}
                </span>
                <span className="ch-panel-webtitle" title={page.data.title}>
                  {page.data.title || site.name || url}
                </span>
              </div>
              <p className="ch-panel-text">
                {`这是抓回来的正文，不是那个网站本身（${formatRelativeTime(
                  page.data.fetched_at,
                )}取回${page.data.truncated ? '，只读了前一段' : ''}）。`}
              </p>
              <div className="md-body ch-panel-webtext" onClick={onContentClick}>
                {renderPlainMarkdown(demoteImageSyntax(page.data.text))}
              </div>
              <OpenExternal url={url} />
            </>
          )}
        </div>
      )}
    </>
  )
}

/**
 * 那一条出路（抓不到 / 探测失败时给的下一步）。
 *
 * 名字比工具条上那颗图标按钮**具体一格**（"这一页"）：两者做的是同一件事，
 * 而在失败那一屏它们同时可见——两颗同名按钮对读屏用户是"两个一样的东西"，
 * 而这一颗的作用域是"正文没抓到的那一页"。可见文字仍完整包含在名字里（WCAG 2.5.3）。
 */
function OpenExternal({ url }: { url: string }) {
  return (
    <button
      type="button"
      className="ch-panel-webopen"
      aria-label="在系统浏览器打开这一页"
      onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}
    >
      <ExternalLink size={14} aria-hidden />
      在系统浏览器打开
    </button>
  )
}
