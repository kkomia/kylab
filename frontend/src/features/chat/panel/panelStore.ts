/**
 * 对话页右侧面板的那一份状态（`SidePanel` 的骨架 + 文件标签）。
 *
 * ## 为什么是一个 zustand 模块级单例
 *
 * 三处要读同一份东西，而且它们**不在同一棵子树上**：`ChatHeader` 上的那颗开关
 * （在会话条里）、面板自己（在页面那一行里）、以及消息流里的「预览」（`Deliverables` /
 * `MessageView` 点附件 → `ChatProvider.openFiles`）。摆进 `ChatProvider` 的值里
 * 是**不行的**：那个 value 每拍都新建（`ChatProvider.tsx` 的 `ChatRowApi` 注里
 * 记着实测数——流式期间每次写入都会让 172 个消息实例重渲染），面板状态挂上去等于
 * 让"开一个标签"也拖着整个对话区重渲染。与 `layout/useSidebar.ts` 同一个形状、
 * 同一个理由。
 *
 * ## 什么落盘、什么不落
 *
 * **只有显隐**（`kylab-chat-panel-open`，走 `runtime/prefs` 的 `readStored` /
 * `writeStored`）：它是"这台机器怎么摆"，与主题、侧栏折叠同一类。标签、当前目录、
 * 浏览历史**一律不落盘**：下次打开这一页要从一个确定的样子开始（空态），
 * 而不是恢复上次翻了半天的三个标签——那种"我上次看过什么"的记忆在这里没有收益，
 * 只有"它为什么自己开着一堆东西"的困惑。
 *
 * ## 不含请求
 *
 * 文件清单走 `runtime/useChatData` 的 `useConversationFiles`（react-query 那份缓存），
 * 这一层只记"看的是哪一档、哪一层"。面板因此可以在没有网络的时候照样开合。
 */
import { create } from 'zustand'

import type { FileScope } from '@/api/conversations'

import { readStored, writeStored } from '../runtime/prefs'

/** 面板显隐的存储键（本机偏好；只落这一位，见文件头注）。 */
export const PANEL_OPEN_KEY = 'kylab-chat-panel-open'

/** 打开文件时带的那一份（`ChatProvider.openFiles(seed)` 原样给过来）。 */
export interface PanelSeed {
  key: string
  name: string
  kind: string
}

/**
 * 面板上的一个标签。
 *
 * `web` 这一档**本轮只有类型与入口的占位**（视图下一轮做）：类型先定下来是因为
 * "打开网页"要么进 `tabs` 那一个数组、要么另开一份状态——后者等下一轮做的时候
 * 一定要把两处合成一处。空着的 `history` / `index` 是下轮要用的浏览历史
 * （它就是"不落盘"那条里说的那种东西）。
 */
export type PanelTab =
  | { id: string; kind: 'files' }
  | { id: string; kind: 'web'; url: string; history: string[]; index: number; title: string }

/** 「文件」标签现在在看哪儿（档 + 层）。**不进 `PanelTab`**：那两个位与"开了哪个标签"无关。 */
export interface FilesView {
  scope: FileScope
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

  setOpen: (next: boolean) => void
  toggle: () => void
  setConversationId: (id: string) => void
  /** 打开面板并落到「文件」标签（已经开着就激活它——**单例**）：`seed` 给了就定位到那一份。 */
  openFilesTab: (seed?: PanelSeed | null) => void
  activate: (id: string) => void
  closeTab: (id: string) => void
  setFilesView: (next: Partial<FilesView>) => void
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

function readOpen(): boolean {
  return readStored(PANEL_OPEN_KEY) === '1'
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
  filesView: { scope: 'conversation', path: '' },

  setOpen: (next) => {
    writeOpen(next)
    set({ open: next })
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
      filesView: { scope: 'conversation', path: '' },
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
        seed: seed ? { ...seed, seq: (state.seed?.seq ?? 0) + 1 } : state.seed,
      }
    }),

  activate: (id) => {
    if (!get().tabs.some((tab) => tab.id === id)) return
    writeOpen(true)
    set({ activeId: id, open: true })
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
    if (state.activeId !== id) {
      set({ tabs })
      return
    }
    const next = tabs[index] ?? tabs[index - 1]
    set({ tabs, activeId: next?.id ?? '' })
  },

  setFilesView: (next) => set({ filesView: { ...get().filesView, ...next } }),
}))

/**
 * 从**别处**（非组件代码）打开面板的文件标签。
 *
 * `ChatProvider.openFiles` 走它：那个函数在一次事件里调用，用 `getState()` 比在
 * 组件里订阅更省一层（React 之外没有 hook 可用）。
 */
export function openPanelFiles(seed?: PanelSeed | null): void {
  usePanelStore.getState().openFilesTab(seed ?? null)
}

export function togglePanel(): void {
  usePanelStore.getState().toggle()
}
