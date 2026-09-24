/**
 * 正在流式的那一轮：**状态与连接由这个模块持有，而不是某个组件**（v0.41）。
 *
 * 源文件：`frontend/src/composables/useLiveTurn.ts`（586 行）。**逐条搬，不是重写**：
 * 四种落法、锚点、重连预算、收口、以及"流的所有权不跟页面走"这条设计都照旧，
 * 只把 Vue 的 `ref` 换成 **zustand store**（模块作用域的那几个变量本来就与响应式无关，
 * 原样留着）：
 *
 * - `liveTurnState.value` → `liveTurnState()`（**命令式读取**，给流回调这类非组件代码）；
 * - 组件要跟着变 → `useLiveTurn()`（订阅钩子，返回值还是同一个对象，引用变了才重渲染）；
 * - 写入一律走模块内的 `install`/`update`（旧实现直接改字段，靠 Vue 的深响应式通知；
 *   React/zustand 里必须换成新对象，见 `update` 的说明）。
 *
 * ## 为什么要有它
 *
 * 用户报的第 4 条：回答写到一半切去笔记页，回来这一轮就没了。
 * 根因是"**流的所有权跟着页面走**"——对话页卸载时 `abort()` 掉连接、
 * 而消息数组是组件局部的，页面一没，提问、半截回答、已经跑过的工具步骤一起消失；
 * 更糟的是那条 SSE 被掐了，后端那一轮也跟着没了（落库发生在流跑完之后）。
 *
 * 所以这一层把三样东西搬出组件：**这一轮的状态**（正文 / 思考 / 步骤 / 来源）、
 * **连接句柄**、以及**它属于哪条会话**。组件只在挂载期间做一件事：
 * 把这里的状态**镜像**进自己的消息数组（`syncLive`）。它随时可以走，镜像断了不影响流。
 *
 * ## 两种落法（`mode`）
 *
 * - `append`：新起一轮（发送、重新生成）——需要一对"提问 + 占位回答"；
 * - `patch`：续写最后一条回答（续跑）——只改那一条，不新增；
 * - `recover`：**刷新之后接回来的那一轮**（P2-2）——它的提问不在手上（问题随
 *   落库才有，而这一轮还在跑），所以只补回答那一条，见对话页的 `syncLive`；
 * - `command`：**一条斜杠命令**（P1-2）——它可能只是"一句系统回话"（`/help`），
 *   也可能真的要过一次模型（带参数的 `/plan`、自定义命令），所以**先不建气泡**，
 *   等真出了内容再按 `append` 那支补出来（见 `startCommandTurn`）。
 *
 * 分开的理由是**回到页面时的重放**：`append` 的那一轮在库里还没有（落库要等流跑完），
 * 必须由镜像把那一对补回画面上；`patch` 的那条在库里已经存在（只是内容旧），
 * 补一对会凭空多出一轮。
 *
 * ## 断线重连（P2-2，抄 ZCode 的 `stream_recovery_anchor_*` + QwenPaw 的环形缓冲重放）
 *
 * v0.41 只解决了"前端别主动断"，**刷新页面**与**真断线**仍然丢那一轮。后端从
 * 这一版起把一轮转成后台任务 + 按会话的环形缓冲（见 `services/live_turns.py`），
 * 于是这一层要做的是两件事：
 *
 * 1. **记锚点**：每条事件带的 `seq`（会话日志里的编号）里的最后一个，见
 *    `anchors`。它是 `GET /chat/turns/{id}/live?after=` 的参数；
 * 2. **接回来**：`attachLiveTurn` 在**页面挂载**或**流断开**时用锚点重开一条流——
 *    补发的事件走的是**同一套 handler**（所以补发与实时收到的处理不可能分叉），
 *    然后接着流；那一轮已经跑完时后端会给一条带 `recovered` 的 `done`，据此收口
 *    （正文增量不重发，那条 `done` 里是完整答复，所以**不追加**、只替换）。
 */

import { create } from 'zustand'

import {
  chatStream,
  isAbortError,
  openLiveTurn,
  resumeStream,
  type ChatApproval,
  type ChatCommandResult,
  type ChatDoneInfo,
  type ChatHandlers,
  type ChatPayload,
  type ChatSource,
  type ChatStep,
  type ChatStreamHandle,
  type ResumePayload,
  type ThinkingEffort,
} from '@/api/chat'

import { mergeStep } from './turns'

/** `append` = 新起一轮；`patch` = 续写最后一条回答；`recover` = 刷新后接回来的那一轮；
 *  `command` = 一条斜杠命令（有没有回答要等结果，见 `startCommandTurn`）。 */
export type LiveMode = 'append' | 'patch' | 'recover' | 'command'

export interface LiveTurnState {
  conversationId: string
  mode: LiveMode
  /** 这一轮的提问（`append` 重放时要用它补出提问那一条；`recover` 没有它）。 */
  query: string
  /** 这一轮实际用的思考档：过程面板要如实显示"这一步做没做"。 */
  thinking: { enabled: boolean; effort: ThinkingEffort } | null
  text: string
  thinkingText: string
  steps: ChatStep[]
  sources: ChatSource[]
  streaming: boolean
  /** 失败原因（空 = 没失败）。抛在模块里而不是组件里——切页之后也要看得见。 */
  error: string
  /**
   * 收尾那条是**补发**来的（P2-2，后端 `done.recovered`）。
   *
   * 它意味着"这一轮早就跑完了"：界面据此知道不必再等任何东西，
   * 也意味着**正文增量不会重发**——`text` 是以 `done` 里的全文为准的，
   * 半截的那份可能缺了断开期间那段（这点差异是这一条要说明的）。
   */
  recovered: boolean
  /**
   * 用户自己按了「停止」（或 `/stop`）。
   *
   * 与 `streaming` 分开是有原因的：P2-2 之后**断开连接不再取消那一轮**
   * （它在后端照跑、照落库），所以"界面不再等它"是这一侧的决定，
   * 重连（`scheduleReconnect`）**必须认这个标记**——不然用户刚说了不看，
   * 下一次网络抖一下又把那条流接回来了。
   */
  stopped: boolean
  /**
   * 后端在等用户点头的那一条（v0.41，`ask` 档的工具执行）。空 = 没有在等的。
   *
   * **和流一样放在模块里**：它也是一个"还没结束的状态"。放在组件里的话，
   * 用户切走再回来（组件重建）就看不到这条确认了——而后端还在等，
   * 那一轮会一直卡到超时。
   */
  approval: ChatApproval | null
}

/** store 里只有这一格：**整个应用只有这一份「正在流的那一轮」**。 */
interface LiveTurnStore {
  live: LiveTurnState | null
}

export const useLiveTurnStore = create<LiveTurnStore>()(() => ({ live: null }))

/**
 * 订阅钩子（组件用）：这一轮的状态变了就重渲染。
 *
 * 与 `liveTurnState()` 的分工：组件读它，流回调这类非组件代码读那个
 * （钩子只能在渲染里调，回调里调是违纪）。
 */
export function useLiveTurn(): LiveTurnState | null {
  return useLiveTurnStore((store) => store.live)
}

/** 命令式读取（对应旧实现的 `liveTurnState.value`）。 */
export function liveTurnState(): LiveTurnState | null {
  return useLiveTurnStore.getState().live
}

/**
 * 每**装进去一整份新状态**就 +1（新一轮、换会话、清空、挂载时接回来那一次）。
 *
 * 旧实现靠 Vue `ref` 里的**对象身份**判断"画面上还是不是我那一份"
 * （`attachLiveTurn` 里"没接上就清掉"那一处）。zustand 不做代理，但**每次更新都换新对象**
 * （React 要新引用才知道变了），身份比较因此不再成立——于是改用这一本代数。
 * `update`（delta / 步骤这类原地演进）**不动它**：那些时候"主人"没变。
 */
let liveRevision = 0

/** 换掉整份状态（新一轮、清空、接回来时登记）。 */
function install(next: LiveTurnState | null): void {
  liveRevision += 1
  useLiveTurnStore.setState({ live: next })
}

/**
 * 就地演进：改几个字段（旧实现是直接改 `state.xxx`，靠 Vue 的深响应式通知界面）。
 *
 * React 认"新引用"，所以这里必须换一个新对象——组件订阅的就是它。
 * 一次 delta 一个新对象是可以接受的：正文本来就是一次一个增量，
 * 而**步骤 / 出处**都是在事件里成批来的，不是每帧。
 */
function update(part: Partial<LiveTurnState>): void {
  useLiveTurnStore.setState((store) => (store.live ? { live: { ...store.live, ...part } } : {}))
}

let handle: ChatStreamHandle | null = null

/**
 * **重连锚点**：每条会话"我处理到哪个 seq 了"（P2-2）。
 *
 * 放模块作用域（不持久化）是有意的：它记的是"**这一趟**看过哪儿"。
 * 刷新之后这张表空了，重建的办法是把整圈补回来（`after=0`）——补发的那些事件
 * 会走同一套 handler，界面因此能把状态重新拼出来（见 `attachLiveTurn`）。
 * 这也把"锚点怎么持久化"这个坑绕开了：锚点过期（缓冲被后面的轮次挤掉）时
 * 唯一正确的动作本来就是"重读整条会话"，而前端没法自己判断这件事。
 */
const anchors = new Map<string, number>()

/** 这条会话上我处理到哪个 seq 了（0 = 一无所知）。 */
export function liveAnchor(conversationId: string): number {
  return anchors.get(conversationId) ?? 0
}

/**
 * 清空锚点表（**用例用**：它是模块作用域的，用例之间会互相传染——
 * 上一条用例把某条会话读到 20，下一条用例的重连就会带着 20 去补，
 * 而它期望的是 0）。与 `clearConversationDetailCache` 同一条理由。
 */
export function clearLiveAnchors(): void {
  anchors.clear()
}

/**
 * 当前这段思考的**分段**（见 `pushThinking`）。
 *
 * 为什么不直接往 `thinkingText` 上追加：同一次连续思考在服务端的直播缓冲与会话日志里
 * 只占**一条**（后续增量拼进它，见 `live_turns.LiveEmit` 的 `keep`），于是重连补发
 * 拿到的是那一段**合并后的全文**、编号还是那一个——按段号认段才能"替换"而不是"再追加一遍"。
 * 与 `liveTurnState` 同生命期（每次新建状态就清空）。
 */
let thinkingBlocks: { seq: number | null; text: string }[] = []

/** 重连的次数上限（连着失败这么多次就如实报错，见 `scheduleReconnect`）。 */
export const RECONNECT_MAX = 3
/** 重连前的等待（毫秒）：抖一下的网络多半自己就好了，抢着立刻重连往往是白试。 */
export const RECONNECT_DELAY_MS = 800

/** 还欠着几次重连（收到实时正文就清零——那证明这一轮真的还活着）。 */
let reconnectAttempts = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 每开一条流就 +1：让**上一条流**晚到的回调认得出自己已经过期。
 *
 * 要认的就是"断了"那一类（`onDropped`）：接回来之后，上一条流的收尾里也可能
 * 报一次断（它本来就是在断开那一刻结束的），认不出就会再排一次重连。
 */
let streamToken = 0

/** 正在建连的那条会话（挂载与"断开重连"可能前后脚都调过来，别建两条）。 */
let attaching: string | null = null

/**
 * 这一轮结束了（成功、失败、被停止都算）。
 *
 * **只翻状态、不回调**：收尾那一摊（写缓存、让后端校准）由**当时挂载着的组件**
 * 看见 `streaming` 变假之后自己做。曾经这里存过一个 `onSettled` 回调，
 * 但那是"发起这一轮的那个组件"的函数——用户切走之后它已经不在画面上了，
 * 它手里的 `conversationId` 甚至是空的，于是收尾被静默跳过（实测踩到）。
 * 换成"当前挂载者接手"之后，谁在看谁负责，与发起者无关。
 */
function endStream(): void {
  if (liveTurnState()) {
    // 这一轮已经结束了，那条确认条也就不用摆了：后端等到超时之后自己就往下跑了
    // （见 services/approvals.py），留在界面上只会让用户点了却拿到 409
    update({ streaming: false, approval: null })
  }
  handle = null
  clearReconnect()
}

/** 把还没到点的重连取消掉（收尾、用户叫停、开始新一轮时都要）。 */
function clearReconnect(): void {
  reconnectAttempts = 0
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

function finishWith(answer: string, info: ChatDoneInfo = { recovered: false, detail: '' }): void {
  const state = liveTurnState()
  if (state) {
    // done 带的是后端拼好的全文：以它为准，避免个别 delta 丢失后正文与引用对不上。
    // **是替换不是追加**——补发的那条 done（`recovered`）里也是全文，
    // 追加会让断开前后的正文重一遍（P2-2）
    update({ text: answer, error: '', recovered: info.recovered })
  }
  endStream()
}

function failWith(message: string): void {
  if (liveTurnState()) update({ error: message })
  endStream()
}

/**
 * 一段思考增量：带段号的替换那一段，不带的追加到当前段（见 `thinkingBlocks`）。
 *
 * `logSeq` 由 `api/chat.ts` 的 pump 给：只有**一段思考的第一条**才有
 * （后继增量没有，因为服务端也只把它们拼进第一条里）。
 */
function pushThinking(chunk: string, logSeq?: number): void {
  const state = liveTurnState()
  if (!state) return
  if (logSeq !== undefined) {
    const last = thinkingBlocks.at(-1)
    if (last && last.seq === logSeq) last.text = chunk
    else thinkingBlocks.push({ seq: logSeq, text: chunk })
  } else if (thinkingBlocks.length > 0) {
    thinkingBlocks[thinkingBlocks.length - 1].text += chunk
  } else {
    thinkingBlocks.push({ seq: null, text: chunk })
  }
  update({ thinkingText: thinkingBlocks.map((item) => item.text).join('') })
}

/**
 * 这一轮的事件要怎么写进状态——**只此一份**（P2-2）。
 *
 * 发起（`begin`）与接回来（`attachLiveTurn`）用的是同一个工厂：补发的事件与实时收到的
 * 是同一批东西，两套 handler 迟早会在某个事件上分叉（"断线重连之后少了一种反应"
 * 就是那种 bug 的样子）。
 */
function liveHandlers(token: number): ChatHandlers {
  return {
    onSeq: (seq) => {
      const state = liveTurnState()
      if (!state) return
      // 只往前记：补发是"从锚点之后"开始的，理论上不会倒着来，但单调这件事
      // 由这里守住之后，`after` 就永远不会往回退（退回一步就会重发一遍）
      if (seq > liveAnchor(state.conversationId)) anchors.set(state.conversationId, seq)
    },
    onStep: (step) => {
      const state = liveTurnState()
      if (state) update({ steps: mergeStep(state.steps, step) })
    },
    onSources: (items) => {
      if (liveTurnState()) update({ sources: items })
    },
    onThinking: (chunk, options) => pushThinking(chunk, options?.logSeq),
    onApproval: (approval) => {
      if (liveTurnState()) update({ approval })
    },
    onDelta: (delta) => {
      // 正文增量**只可能来自还活着的那一轮**（补发里没有它，见 live_turns 的 keep）：
      // 收到它就说明这一轮在动，重连预算因而可以收回
      reconnectAttempts = 0
      const state = liveTurnState()
      if (state) update({ text: state.text + delta })
    },
    onDone: (answer, info) => finishWith(answer, info),
    onError: (message) => failWith(message),
    onDropped: (reason) => {
      if (token !== streamToken) return // 上一条流晚到的收尾（见 `streamToken`）
      dropped(reason)
    },
  }
}

/** 流断了：**接回来**，实在接不上才如实报错（P2-2）。 */
function dropped(reason: string): void {
  const state = liveTurnState()
  if (!state || !state.streaming || state.stopped) return
  handle = null
  scheduleReconnect(reason)
}

/**
 * 刷新之后那一次接回来的专用 handler：**第一条事件到了，这一轮才算"在跑"**。
 *
 * 为什么值得包一层（见 `attachLiveTurn` 里 `fresh` 那条注释）：挂载时并不知道
 * 这条会话上有没有在跑的一轮——先标成"流式中"的话，绝大多数"打开一条旧会话"
 * 都会先闪一下停止按钮。而"有没有事件来"是服务端给的答案，比任何计时都准：
 * 补发到的是**已经收尾**的那一轮时事件照来（最后一条 `done(recovered)` 收口），
 * 界面上也不会多出任何东西（镜像那条规则管着，见对话页的 `syncLive`）。
 */
function adoptHandlers(token: number, revision: number): ChatHandlers {
  const inner = liveHandlers(token)
  //: 这一轮**已经收尾**（`done` / `error` 到过）之后，不许再把它抬回"流式中"。
  //
  // 为什么需要这道闸：`api/chat.ts` 的 `emit` 是**先 dispatch、再报锚点**
  // （那条顺序本身是对的，锚点语义要求如此），所以 `done` 那一事件的 `onSeq`
  // 是在收尾**之后**才到的。少了它，`done` 先把 `streaming` 落回 false、
  // 紧接着同一事件的 `onSeq` 又把它抬成 true —— 表现就是**输入框永远停在
  // 「停止生成」上**：刷新（或重进）任何"环形缓冲里还留着刚跑完那一轮"的会话都会中招，
  // 按什么都没用（用户点一次「停止生成」能救回来，但没人知道要点）。
  let closed = false
  const adopt = (): void => {
    if (closed) return
    // 这一格已经换过主（新一轮 / 换了会话）：什么都别动。
    // 旧实现是对着**捕获的那个对象**改字段——那种情况下它改的是一个已经没人看的对象，
    // 效果同样是"什么都不动"
    if (liveRevision !== revision) return
    const state = liveTurnState()
    if (state && !state.streaming) update({ streaming: true })
  }
  return {
    onSources: (items) => {
      adopt()
      inner.onSources?.(items)
    },
    onStep: (step) => {
      adopt()
      inner.onStep?.(step)
    },
    onThinking: (text, options) => {
      adopt()
      inner.onThinking?.(text, options)
    },
    onApproval: (approval) => {
      adopt()
      inner.onApproval?.(approval)
    },
    onDelta: (text) => {
      adopt()
      inner.onDelta?.(text)
    },
    onCommand: (result) => {
      adopt()
      inner.onCommand?.(result)
    },
    onSeq: (seq) => {
      adopt()
      inner.onSeq?.(seq)
    },
    onDone: (answer, info) => {
      adopt()
      // 先 adopt（`done` 也可能是第一条事件：那一轮确实跑到过），再封口——
      // 这样同一事件尾随的 `onSeq` 就不会把它抬回来（见上面 `closed` 那段）
      closed = true
      inner.onDone?.(answer, info)
    },
    onError: (message) => {
      adopt()
      closed = true
      inner.onError?.(message)
    },
    // 断了也算"认领过"：一条刚开始建连就断掉的流同样该按重连预算再接一次
    // （不然刷新之后遇到一次抖动就彻底没动静了）
    onDropped: (reason) => {
      adopt()
      inner.onDropped?.(reason)
    },
  }
}

/**
 * 排一次重连；连着失败 `RECONNECT_MAX` 次就报错收摊。
 *
 * 重试**只在"还有一轮在跑"时**有意义：`attachLiveTurn` 那头要是发现那一轮已经
 * 收尾（`done(recovered)`）或根本没跑过，它自己会把界面收口，不需要这里管。
 */
export function scheduleReconnect(reason: string): void {
  const state = liveTurnState()
  if (!state || !state.streaming || state.stopped) return
  if (reconnectAttempts >= RECONNECT_MAX) {
    failWith(reason)
    return
  }
  reconnectAttempts += 1
  const id = state.conversationId
  if (reconnectTimer !== null) clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    void attachLiveTurn(id)
  }, RECONNECT_DELAY_MS)
}

/**
 * 开一轮：先登记状态，再建连接，事件一路写进 store。
 *
 * `open` 由调用方给（发送/重新生成走 `chatStream`，续跑走 `resumeStream`）——
 * 这里只认"怎么开这条流"，不认它是哪条链路的。
 */
async function begin(
  state: LiveTurnState,
  open: (handlers: ChatHandlers) => Promise<ChatStreamHandle>,
): Promise<void> {
  clearReconnect()
  install(state)
  thinkingBlocks = []
  const token = ++streamToken
  try {
    handle = await open(liveHandlers(token))
  } catch (cause) {
    // 用户点了「停止」：已经流出来的部分留着，它仍然是有用的
    if (isAbortError(cause)) endStream()
    else failWith(cause instanceof Error ? cause.message : '对话失败')
  }
}

function makeState(
  conversationId: string,
  mode: LiveMode,
  query: string,
  thinking: { enabled: boolean; effort: ThinkingEffort } | null,
): LiveTurnState {
  return {
    conversationId,
    mode,
    query,
    thinking,
    text: '',
    thinkingText: '',
    steps: [],
    sources: [],
    streaming: true,
    error: '',
    recovered: false,
    stopped: false,
    approval: null,
  }
}

/** 发送 / 重新生成：新起一轮。 */
export function startChatTurn(
  payload: ChatPayload,
  meta: {
    conversationId: string
    /** 这一轮的提问——重放时要靠它补出提问那一条。 */
    query: string
    thinking: { enabled: boolean; effort: ThinkingEffort } | null
  },
): Promise<void> {
  return begin(makeState(meta.conversationId, 'append', meta.query, meta.thinking), (handlers) =>
    chatStream(payload, handlers),
  )
}

/**
 * 一条斜杠命令：**走正常那一轮，是不是"只回一句"由结果说了算**（P1-2）。
 *
 * 为什么不能照菜单里的 `short_circuit` 先分流：那个标记是**表级**的保守口径，而
 * `/plan` 是"看有没有参数"的两面派——`/plan <描述>` 在后端与 `/skill` 同一条改写路
 * （描述当这一轮的提示、要过一次模型、会留下回答）。照表级标记把它当"只回一句"的话，
 * 那条回答只落库、不进画面，用户得刷新才看得见（这条修的就是它）。
 *
 * 两条路合成一条的办法是 `mode: 'command'` 那个镜像规则：**先不建气泡**
 * （`/help` 这类不该在对话流里留下提问与空回答），一旦真出了内容（步骤 / 出处 / 正文）
 * 就按普通一轮补出"提问 + 回答"——于是"有回答就照常渲染、没有才当系统提示"这件事
 * 只由一个判据决定（见对话页的 `syncLive`）。
 *
 * `onCommand` 由调用方给：那条回话是**系统的回话**，归界面那一层显示
 * （它不进这一轮的状态：命令是瞬时的，不需要跟着切页活着）。
 */
export function startCommandTurn(
  payload: ChatPayload,
  meta: {
    conversationId: string
    /** 用户敲的那一行（`/plan 帮我做个 X`）——出回答时要作为提问补在对话里。 */
    query: string
    thinking: { enabled: boolean; effort: ThinkingEffort } | null
  },
  onCommand: (result: ChatCommandResult) => void,
): Promise<void> {
  return begin(makeState(meta.conversationId, 'command', meta.query, meta.thinking), (handlers) =>
    // 覆盖而不是另造一份：命令那一轮与普通一轮收到的是**同一批事件**
    // （改写类命令在后端就是正常那一轮），只有"回话怎么显示"这一件不同
    chatStream(payload, { ...handlers, onCommand }),
  )
}

/** 续跑：改的是**同一条**回答（`mode: 'patch'`）。 */
export function startResumeTurn(
  conversationId: string,
  payload: ResumePayload,
  meta: {
    thinking: { enabled: boolean; effort: ThinkingEffort } | null
  },
): Promise<void> {
  return begin(makeState(conversationId, 'patch', '', meta.thinking), (handlers) =>
    resumeStream(conversationId, payload, handlers),
  )
}

/**
 * **接回这条会话上的那一轮**（P2-2 的重连入口）。
 *
 * 两个调用时机，同一个动作：
 *
 * - **页面挂载**（刷新、直接打开一条正在跑的会话）：store 是空的、
 *   锚点也没了，于是 `after=0`——后端把它缓冲里那一轮的事件**整圈补发**，
 *   这一层用同一套 handler 重新拼出状态（见 `mode: 'recover'`）；
 * - **流断开**：锚点在手，只补没看到的那几条，然后接着收。
 *
 * 三种结局都不需要调用方判断：
 *
 * 1. 还在跑 → 补发 + 继续流（界面照常长）；
 * 2. 已经跑完 → 后端那条 `done(recovered)` 让 `finishWith` 收口，
 *    界面上的正文以它带的**全文**为准（增量不重发，所以不能追加）；
 * 3. 缓冲里已经没有它（跑完很久 / 服务重启过）→ 同样一条收口说明；
 *    这时 `text` 是库里的最后那条回答，而画面上本来就有一份，镜像会自行跳过
 *    （见对话页的 `syncLive` 对 `recover` 的那条规则）。
 *
 * **失败不抛**：接不上只是"这一趟看不到过程"，那一轮在后端照跑照落库
 * （见 `live_turns` 的模块头）——为它把对话页报红，比不接更糟。
 */
export async function attachLiveTurn(conversationId: string): Promise<void> {
  if (!conversationId) return
  const current = liveTurnState()
  // 手上那一轮是**别的会话**：别抢它的位置（这一格只放"当前这一轮"，
  // 抢了的话那条流还在跑、而画面上再也看不到它）
  if (current && current.conversationId !== conversationId) return
  // 已经是这条会话、而且那条流还开着（或正在开）：不重复建连
  if (current && (handle !== null || attaching === conversationId)) return

  const fresh = !current || !current.streaming
  // **还没接上之前不算"在跑"**：多数打开会话的时刻根本没有在跑的一轮，
  // 这个窗口里要是先亮成"流式中"，输入框会闪一下「停止」按钮。
  // 第一条事件到了才算（见 `adoptHandlers`）；已经接上的那条流本来就在跑，不用动。
  if (fresh) install(makeState(conversationId, 'recover', '', null))
  // 登记之后**再把那一份读回来**：`adoptHandlers` 要用它，而"没接上就清掉"那一处
  // 旧实现比的是对象身份（Vue 的 `ref` 会给对象套一层响应式代理，所以它得读回来再比）。
  // 这里比的是 `liveRevision`（见它的说明），语义一样：**这一格还是不是我放进去的**。
  const revision = liveRevision
  if (fresh) update({ streaming: false })
  // **接回已有的那一轮时不清分段**：补发只从锚点之后开始，早先那几段思考
  // 不在补发里（它们的编号 ≤ 锚点）——清掉就等于把它们从画面上抹了
  if (fresh) thinkingBlocks = []
  const token = ++streamToken
  attaching = conversationId
  try {
    // 重连那条流**不套显示节流**：它一上来可能是一批补发（节流只会把那一批拖长），
    // 而"过程看得见"靠的是往后那些实时事件——它们本来就有自己的节奏
    handle = await openLiveTurn(
      conversationId,
      liveAnchor(conversationId),
      fresh ? adoptHandlers(token, revision) : liveHandlers(token),
      undefined,
      { smooth: false },
    )
  } catch (cause) {
    handle = null
    if (fresh) {
      // 没接上：画面上什么都不该留下（这一轮要是真在跑，
      // 下一次挂载或下一次断线还会再试）。代数没变 = 这一格还是我放的
      if (liveRevision === revision) install(null)
      return
    }
    scheduleReconnect(cause instanceof Error ? cause.message : '重连失败')
  } finally {
    if (attaching === conversationId) attaching = null
  }
}

/**
 * 用户点了「停止」（或 `/stop` 那条命令已经在后端把它停下了）。
 *
 * P2-2 之后**断开连接不再取消那一轮**（它在后台线程里跑完并落库，见 `live_turns`），
 * 所以这里做的是"本页不再等它"：掐掉这条订阅、把状态收口（正文与过程都留着）。
 * 标记 `stopped` 是为了**不再重连**——用户已经明确说过不看了；
 * 要真的把那一轮停下，走 `/stop`（后端唯一的取消入口）。
 */
export function abortLiveTurn(): void {
  if (liveTurnState()) {
    update({ stopped: true, streaming: false, approval: null })
  }
  // 让这条流后面报的"断了"被忽略（那是用户自己断的，不是断线）
  streamToken += 1
  clearReconnect()
  handle?.abort()
  handle = null
}

/**
 * 那条确认已经有结论了（用户点了按钮，或它已经失效）：把确认条收起来。
 *
 * **只收界面**，决定本身由组件 POST 给后端（`api/chat.ts::decideApproval`）——
 * 两者分开是因为它们会各自失败：POST 失败时后端还在等，而"收起"这件事
 * 已经不该再等了（那一头会等到超时）。所以先收起来、再把失败如实说出来。
 */
export function settleLiveApproval(): void {
  if (liveTurnState()) update({ approval: null })
}

/** 这一轮已经交付给库了（或用户换了会话）：忘掉它。 */
export function clearLiveTurn(): void {
  install(null)
  handle = null
  thinkingBlocks = []
  clearReconnect()
  // 锚点**不清**：它是"这条会话我看到哪儿了"，与"手上这一轮还在不在"无关
}
