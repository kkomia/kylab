/**
 * 对话页右侧面板的那一份状态（`SidePanel` 的骨架 + 两种标签：文件 / 网页）。
 *
 * ## 为什么是一个 zustand 模块级单例
 *
 * 四处要读同一份东西，而且它们**不在同一棵子树上**：面板那一列的开关
 * （页面那一行的右上角，见 `panel/PanelToggle.tsx`）、面板自己（在页面那一行里）、
 * 消息流里的「预览」（`Deliverables` / `MessageView` 点附件 → `ChatProvider.openFiles`）、
 * 以及抓页那一步行尾的「在面板里打开」（`ui/SearchHits.tsx` 的 `FetchPages`）。摆进
 * `ChatProvider` 的值里是**不行的**：那个 value 每拍都新建（`ChatProvider.tsx` 的
 * `ChatRowApi` 注里记着实测数——流式期间每次写入都会让 172 个消息实例重渲染），
 * 面板状态挂上去等于让"开一个标签"也拖着整个对话区重渲染。与
 * `layout/useSidebar.ts` 同一个形状、同一个理由。
 *
 * ## 什么落盘、什么不落
 *
 * **显隐**（`kylab-chat-panel-open`）与**宽度**（`kylab-chat-panel-width`，见下）走
 * `runtime/prefs` 的 `readStored` / `writeStored`：它们是"这台机器怎么摆"，与主题、
 * 侧栏折叠同一类。标签、当前目录、浏览历史、未读**一律不落盘**：下次打开这一页要从
 * 一个确定的样子开始（空态），而不是恢复上次翻了半天的三个标签。
 *
 * **宽度要落盘**（2026-10-09，用户："宽度记住到 localStorage，刷新保持"）：拖出来的
 * 宽度是用户量过的"我要多宽"，刷新丢掉它等于每次都要再拖一次。它落的是**数值**，
 * 读回来一律过 `clampWidth`——改了 localStorage、或者换了台更小的屏，都不该让面板
 * 宽到把对话列挤没。
 *
 * ## 不含请求
 *
 * 文件清单走 `runtime/useChatData` 的 `useConversationFiles`、网页那两份走同目录的
 * `useWebData`（都是 react-query 那份缓存），这一层只记"看的是哪一档、哪一层、哪一页"。
 * 面板因此可以在没有网络的时候照样开合。
 */
import { create } from 'zustand'

import { readStored, writeStored } from '../runtime/prefs'

/** 面板显隐的存储键（本机偏好；只落这一位，见文件头注）。 */
export const PANEL_OPEN_KEY = 'kylab-chat-panel-open'

/** 面板宽度的存储键（本机偏好，见文件头注）。 */
export const PANEL_WIDTH_KEY = 'kylab-chat-panel-width'

/**
 * 面板宽度的上下限（用户口径：280–720）。
 *
 * 下限 280：再窄下去文件树里的名字只剩两三个字，面包屑也排不下；
 * 上限 720：面板是**右边那一列**，比它还宽，中间那条对话列就落回"比消息列还窄"
 * 那一档（与 `usePanelLayout` 里 1100 那条线同一个病）。
 *
 * 默认值取 `tokens.css` 的 `--panel-width` 那一档——**同一份口径写两处**是刻意的：
 * 令牌表给的是"没拖过时长什么样"，这里是"拖过之后允许落在哪儿"，两者的读者不同。
 */
export const PANEL_WIDTH_MIN = 280
export const PANEL_WIDTH_MAX = 720
export const PANEL_WIDTH_DEFAULT = 380

/** 把一个宽度收进上下限（非数字一律回默认值：那说明 localStorage 被改过）。 */
export function clampWidth(value: number): number {
  if (!Number.isFinite(value)) return PANEL_WIDTH_DEFAULT
  return Math.min(PANEL_WIDTH_MAX, Math.max(PANEL_WIDTH_MIN, Math.round(value)))
}

/** 打开文件时带的那一份（`ChatProvider.openFiles(seed)` 原样给过来）。 */
export interface PanelSeed {
  key: string
  name: string
  kind: string
}

/**
 * 面板上的一个标签。
 *
 * `web` 那一档的 `history` / `index` **就是它的前进后退**（不是浏览器历史，也不落盘，
 * 见文件头那一段）：`navigateWebTab` 只动这两个位，`WebTab` 的 ←/→ 读它们。
 * `title` 是抓回来的页面标题（抓不到时留空，标签上按域名退一步，见 `SidePanel.labelOf`）。
 */
export type PanelTab =
  | { id: string; kind: 'files' }
  | { id: string; kind: 'web'; url: string; history: string[]; index: number; title: string }

/**
 * 「文件」标签现在在哪一层。**只有一个位**：范围（会话产物 / 项目目录）不再是一个可以
 * 单独挑的档，它由"这条会话挂没挂项目"推出来（见 `FilesTab`：挂了项目就显示项目目录，
 * 没挂就显示会话产物目录）。原先那个 `scope` 与两个范围页签一起去掉了（2026-10-09，
 * 用户："它们本来就是一回事——会话产物就在项目目录里"）。
 */
export interface FilesView {
  path: string
}

interface PanelState {
  /** 面板现在开着没有（用户点过就以他点的为准，落盘）。 */
  open: boolean
  tabs: PanelTab[]
  /** 当前标签的 id；没有标签时是空串（那正是空态那一屏）。 */
  activeId: string
  /**
   * 这条会话的 id（由 `ChatProvider` 的一个 effect 同步进来）。
   *
   * 面板自己不去 `useParams`：它不是一个页面，读参数就要拖进路由上下文，
   * 而"当前是哪条会话"只有 provider 那一处是权威（新建会话那一刻它就在变）。
   */
  currentConversationId: string
  /** 最近一次要求定位的那一份（含 `seq`：同一份连着点两次也要各算一次）。 */
  seed: (PanelSeed & { seq: number }) | null
  filesView: FilesView
  /**
   * **还没看过的那些标签**（放的是标签 id）。
   *
   * 它存在的理由只有一条：agent 抓页建出来的标签**不抢焦点**（用户可能正在读别的），
   * 所以"有新东西"这件事必须自己说出来——标签条上一个小圆点、面板关着时开关按钮上
   * 一个 `N 个新页面` 角标（`ChatHeader`）。点开那个标签（`activate`）就算看过了。
   *
   * 不进 `PanelTab`：那是"这个标签是什么"，这是"我还没看它"——两件事的生命期也不同
   * （看过了就该灭），塞进标签里会让每个"改标签"的动作都要顺手想一下这一位。
   */
  unread: string[]
  /**
   * 面板那一列现在的宽度（像素，落盘，见文件头注）。
   *
   * 拖缝隙（`panel/PanelSplitter.tsx`）与「全屏/还原」共用它之外的两位：这一位是
   * **常规态**下的宽度，全屏态不看它（那时面板撑满主区，见 `full`）。
   */
  width: number
  /**
   * 面板是不是撑满了主区（「全屏」那一档）。
   *
   * **不落盘**：它是"现在这一下我要把面板放到最大"，刷新回到常规列子更合理
   * （与标签、目录同一类"本次会话里的临时看法"，见文件头注）。
   */
  full: boolean

  setOpen: (next: boolean) => void
  toggle: () => void
  setConversationId: (id: string) => void
  /** 打开面板并落到「文件」标签（已经开着就激活它——**单例**）：`seed` 给了就定位到那一份。 */
  openFilesTab: (seed?: PanelSeed | null) => void
  /**
   * 开一个网页标签（同一个地址已经有标签就激活它，不另开一个）。
   *
   * `options.activate: false` = **建标签但不抢焦点**（agent 抓页那条路的用法）：
   * 当前标签与面板开合都不动，只把这个标签记成"还没看过"（见 `unread`）。
   */
  openWebTab: (url: string, options?: { activate?: boolean }) => void
  /**
   * 这个网页标签去一个新地址。
   *
   * **一条规则同时管两件事**（前进后退与手输地址走的是它）：地址在这个标签的历史里
   * 出现过就**只挪下标**（那是 ←/→），没出现过就从当前位置往后截断再压一条
   * （浏览器那条规则）。所以新地址会把这一个标签的"前进"那半截历史丢掉，
   * 而那正是用户预期。
   */
  navigateWebTab: (id: string, url: string) => void
  /** 抓到页面标题之后回填标签名（抓不到就不调，标签会退回域名）。 */
  setTabTitle: (id: string, title: string) => void
  activate: (id: string) => void
  closeTab: (id: string) => void
  setFilesView: (next: Partial<FilesView>) => void
  /** 调宽度（拖缝隙、以及键盘那两下都走它）：一律过 `clampWidth` 并落盘。 */
  setWidth: (next: number) => void
  /** 撑满主区 / 还原。 */
  toggleFull: () => void
  setFull: (next: boolean) => void
}

/**
 * 标签 id：`files-1` / `web-2` 这种。模块级自增，**只在本次会话里唯一**（不落盘，
 * 所以不需要跨会话唯一）。可以预测的 id 也让用例读起来不费劲。
 */
let tabSeq = 0
function newTabId(kind: PanelTab['kind']): string {
  tabSeq += 1
  return `${kind}-${tabSeq}`
}

/**
 * 「定位种子」的序号。**模块级自增**，与 `tabSeq` 同一个手法，但理由不同：
 * 收到种子的那一方（`FilesTab`）要判断"这一份我是不是已经落过了"，而"同一个 seed 对象、
 * 每次调用都各算一次"是接口上写死的行为（见 `seed`）。自增计数器因此**不能只比同一个
 * store 值**：store 里的 `seed` 会被清空（换会话、用例之间复位），清掉之后从 1 重新数，
 * 序号就会重复，而"落过了"的记号是单调的——两次不同的动作会撞成同一个号。
 * 全局自增保证"新种子永远比落过的最后一个更靠后"。
 */
let seedSeq = 0

function readOpen(): boolean {
  return readStored(PANEL_OPEN_KEY) === '1'
}

/** 读回拖过的宽度（没有、或者被改坏了就给默认值，见 `clampWidth`）。 */
function readWidth(): number {
  const raw = readStored(PANEL_WIDTH_KEY)
  return raw ? clampWidth(Number(raw)) : PANEL_WIDTH_DEFAULT
}

/**
 * 开 / 合面板：**状态与落盘永远一起走**。
 *
 * 三条改开合的路都经过它（用户点开关、点消息里的「预览」、点一个标签）：只要面板
 * 真的开了，本机偏好就该是"开着"。分开写的话会留下一种自相矛盾的状态——面板在屏幕上
 * 开着、偏好还是关的，刷新一下又没了（用户看到的是"我刚才明明开着它"）。
 */
function writeOpen(next: boolean): void {
  writeStored(PANEL_OPEN_KEY, next ? '1' : '0')
}

export const usePanelStore = create<PanelState>((set, get) => ({
  open: typeof window === 'undefined' ? false : readOpen(),
  tabs: [],
  activeId: '',
  currentConversationId: '',
  seed: null,
  filesView: { path: '' },
  unread: [],
  width: typeof window === 'undefined' ? PANEL_WIDTH_DEFAULT : readWidth(),
  full: false,

  setOpen: (next) => {
    writeOpen(next)
    // 收起来就退出全屏：全屏说的是"这一列撑满主区"，面板都不在时它没有意义，
    // 留着它下次开面板会直接跳成撑满（用户没要求过）
    set(next ? { open: next } : { open: next, full: false })
  },
  toggle: () => get().setOpen(!get().open),

  setConversationId: (id) => {
    if (get().currentConversationId === id) return
    /*
      换会话要**把看的东西收回去**：目录、定位种子、标签都按会话算（文件区就是
      按会话划的）。留着上一条会话的目录，切过去看到的是"这一层读不了"——
      比一个干净的空态糟得多。**开合本身不动**：面板开不开是这台机器的偏好。
    */
    set({
      currentConversationId: id,
      tabs: [],
      activeId: '',
      seed: null,
      filesView: { path: '' },
      // 未读也跟着标签走：标签都没了，那个小圆点就没有落点了（角标同理）
      unread: [],
    })
  },

  openFilesTab: (seed = null) =>
    set((state) => {
      const existing = state.tabs.find((tab) => tab.kind === 'files')
      const tab: PanelTab = existing ?? { id: newTabId('files'), kind: 'files' }
      // 开面板就该落盘（见 `writeOpen`）：点消息里的「预览」也是"我要看面板"
      writeOpen(true)
      return {
        open: true,
        tabs: existing ? state.tabs : [...state.tabs, tab],
        activeId: tab.id,
        unread: existing ? withoutId(state.unread, tab.id) : state.unread,
        seed: seed ? { ...seed, seq: (seedSeq += 1) } : state.seed,
      }
    }),

  openWebTab: (url, options = {}) =>
    set((state) => {
      const focus = options.activate !== false
      /*
        同一个地址已经有标签就**用它**（面板是"这些页面摆在这儿"，同一个地址摆两个
        标签是重复）。判据是 `tab.url` —— 那是这个标签**现在显示的那一页**：一个标签
        在它自己的历史里翻远了之后，新来的同一个地址该另开一个（两处上下文不同，
        合并会把先前那次阅读的位置抹掉）。
      */
      const existing = state.tabs.find((tab) => tab.kind === 'web' && tab.url === url)
      if (existing) {
        // 后台那条（agent 抓页）：已经有这一页了，什么都不做 —— **不抢焦点**是它的全部
        if (!focus) return state
        writeOpen(true)
        return {
          open: true,
          activeId: existing.id,
          unread: withoutId(state.unread, existing.id),
        }
      }
      const tab: PanelTab = {
        id: newTabId('web'),
        kind: 'web',
        url,
        history: [url],
        index: 0,
        title: '',
      }
      if (focus) {
        writeOpen(true)
        return { open: true, activeId: tab.id, tabs: [...state.tabs, tab] }
      }
      // 不抢焦点：当前标签、开合、落盘偏好**一个都不动**，只多一个待看的标签
      return { tabs: [...state.tabs, tab], unread: [...state.unread, tab.id] }
    }),

  navigateWebTab: (id, url) =>
    set((state) => ({
      tabs: state.tabs.map((tab): PanelTab => {
        if (tab.id !== id || tab.kind !== 'web') return tab
        const seen = tab.history.lastIndexOf(url)
        // 见过的地址：只挪下标（←/→ 走的就是这一支）
        if (seen >= 0) return seen === tab.index ? tab : { ...tab, index: seen, url, title: '' }
        // 新地址：从当前位置往后截断再压一条（浏览器那条规则，见接口上的说明）
        const history = [...tab.history.slice(0, tab.index + 1), url]
        return { ...tab, history, index: history.length - 1, url, title: '' }
      }),
      // 自己导航到这儿了就算看过（这一下是用户动作，不是后台送来的）
      unread: withoutId(state.unread, id),
    })),

  setTabTitle: (id, title) =>
    set((state) => ({
      tabs: state.tabs.map((tab): PanelTab =>
        tab.id === id && tab.kind === 'web' && tab.title !== title ? { ...tab, title } : tab,
      ),
    })),

  activate: (id) => {
    if (!get().tabs.some((tab) => tab.id === id)) return
    writeOpen(true)
    set({ activeId: id, open: true, unread: withoutId(get().unread, id) })
  },

  /**
   * 关一个标签，并把**当前标签挪到它的右邻**（没有右邻就取左邻）。
   *
   * 为什么是这个次序：标签条是从左往右读的，当前那个关掉之后，视线落在它原来占的
   * 位置上——那里现在站着的是右邻。关最后一个时右邻不存在，退到左邻；
   * 一个都不剩就是**空态那一屏**（面板不跟着收：开合是用户自己那一位，不该被
   * "关掉最后一个标签"顺手改掉）。
   */
  closeTab: (id) => {
    const state = get()
    const index = state.tabs.findIndex((tab) => tab.id === id)
    if (index < 0) return
    const tabs = state.tabs.filter((tab) => tab.id !== id)
    const unread = withoutId(state.unread, id)
    if (state.activeId !== id) {
      set({ tabs, unread })
      return
    }
    const next = tabs[index] ?? tabs[index - 1]
    set({ tabs, unread, activeId: next?.id ?? '' })
  },

  setFilesView: (next) => set({ filesView: { ...get().filesView, ...next } }),

  setWidth: (next) => {
    const width = clampWidth(next)
    if (width === get().width) return
    writeStored(PANEL_WIDTH_KEY, String(width))
    set({ width })
  },

  setFull: (next) => {
    if (get().full === next) return
    set({ full: next })
  },
  toggleFull: () => get().setFull(!get().full),
}))

/** 去掉一个 id（未读那一位的每一处修改都长这样，抽出来免得五处各写一遍 `filter`）。 */
function withoutId(ids: readonly string[], id: string): string[] {
  return ids.filter((item) => item !== id)
}

/**
 * 从**别处**（非组件代码）打开面板的文件标签。
 *
 * `ChatProvider.openFiles` 走它：那个函数在一次事件里调用，用 `getState()` 比在
 * 组件里订阅更省一层（React 之外没有 hook 可用）。
 */
export function openPanelFiles(seed?: PanelSeed | null): void {
  usePanelStore.getState().openFilesTab(seed ?? null)
}

/**
 * 从**别处**建一个网页标签（agent 抓页那条路：`ChatProvider` 的流订阅）。
 *
 * 默认 `activate: false` —— **不抢焦点**是这条路的全部要求：用户正在读的东西不许被
 * "它在后台抓了一页"顶掉（未读小圆点与开关上的角标替他记着，见 `unread`）。
 */
export function openPanelWeb(url: string, options: { activate?: boolean } = {}): void {
  usePanelStore.getState().openWebTab(url, options)
}

export function togglePanel(): void {
  usePanelStore.getState().toggle()
}
