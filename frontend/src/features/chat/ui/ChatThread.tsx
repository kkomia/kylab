/**
 * 对话区骨架（assistant-ui 的 Thread 原语）+ 我们自己那三种"这一块现在画什么"。
 *
 * **骨架给的是那几件容易做错的事**：视口、跟随滚动（贴底才跟随，用户往上翻就不抢）、
 * 会话状态（`isRunning`）、以及"回到最新"浮标的出现时机（那块在 `Composer` 上沿，
 * 见 `ui/Composer.tsx`）。**我们给的是内容**：欢迎层、骨架屏、每条消息。
 *
 * 三个状态互斥，顺序不能换（旧 `ChatView` 的模板顺序）：
 * 1. **还没决定显示哪条会话**（解析入口 / 回放中）→ 骨架屏，**不画欢迎层**：
 *    先画再跳的话，用户还是会看到"一屏新对话一闪而过"；
 * 2. **一条消息都没有** → 欢迎层（品牌标 + 标语 + 推荐问题）；
 * 3. 其余 → 消息列表。
 *
 * 消息列表按**我们自己的消息数组**遍历，而不是走 `ThreadPrimitive.Messages`
 * 的渲染函数：那一路给的是 assistant-ui 自己的 parts 结构，而这边每一条都要读回
 * 我们的原对象（过程步骤、出处、交付物都挂在那上面）。少一层翻译，
 * 过程面板那类"我们的字段"就不会在骨架里被磨掉。
 */
import { ThreadPrimitive, useAuiState } from '@assistant-ui/react'
import { useCallback, useEffect, useMemo, useRef } from 'react'

import { buildTurns, type Turn } from '@/features/chat/model/turns'

import { ChatHeader } from './ChatHeader'
import { MessageView } from './MessageView'
import { Welcome } from './Welcome'
import { useFollowStore } from './followStore'
import { useChat, type ChatMessage } from '../runtime/ChatProvider'

/**
 * 离底多少像素以内算"还贴着底"（可以继续跟随）。
 *
 * 不取 0/1px：贴底那一头本来就有取整误差（子像素布局、`scrollHeight` 取整到整数），
 * 判得比浏览器真能落到的位置更严，跟随会在正常落底的最后一两帧里自己关掉。
 */
const FOLLOW_THRESHOLD_PX = 24

/** 这几个键的含义就是"用户自己在往上翻"（和滚轮同一类意图，不必等 `scroll` 事件）。 */
const SCROLL_UP_KEYS = new Set(['ArrowUp', 'PageUp', 'Home'])

/**
 * 这一下按键是不是发生在**输入控件**里（见 `onDocumentKeyDown` 的闸①）。
 *
 * 在输入框里按方向键是"改光标"、按 PageUp 是"翻自己的内容"，都不是"往回读对话"；
 * 而实测这种情形下**这一栏根本不会滚**（浏览器滚的是"焦点元素的最近可滚动祖先"，
 * 那条链上不是这一栏），停跟随只会把正在流式的视图冻住。
 *
 * `contenteditable` 要单独判：它长在普通 `div` 上，光看标签名看不出来。
 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/** 轮次号：一条提问与它后面那条回答共享同一个号（0 起，与旧 `turns` 的下标一致）。 */
function turnIndexes(messages: ChatMessage[]): Map<string, number> {
  const map = new Map<string, number>()
  let turn = -1
  for (const message of messages) {
    if (message.role === 'user') {
      turn += 1
      map.set(message.id, turn)
    } else {
      // 第一条回答前面可能没有提问（刷新之后接回来的那一轮就是这种）
      map.set(message.id, Math.max(turn, 0))
    }
  }
  return map
}

/**
 * 上一帧那几轮（`Turn`）——**只在它那两条消息对象真的换了时才重建**。
 *
 * 为什么要这一层（D32 §12.312 定位，第三节的"放大器"）：`buildTurns` 每次调用都给**所有**轮
 * 造新对象，而消息数组每一拍都换引用 ⇒ 每一轮的 `turn` 属性都换 ⇒ `React.memo` 一次也拦不住，
 * 整棵消息树每一拍全量重渲染（实测：单次 commit 有 ~4465 个组件真正渲染过，其中 markdown
 * 段落 ~680 个）。
 *
 * 判据只有一条：**这一轮的提问与回答还是不是上一帧那两个对象**。`mirrorLive` 只换被写到的那
 * 一条消息，所以没动的那些轮天然满足。表按 `${user.id}|${reply.id}` 收，收完把上一帧的键丢掉
 * ——它只是"上一帧"的快照，不是缓存（不留历史、不会长）。
 */
function useStableTurns(messages: ChatMessage[]): Turn[] {
  const cacheRef = useRef(new Map<string, Turn>())
  return useMemo(() => {
    const cache = cacheRef.current
    const kept = new Map<string, Turn>()
    const stable = buildTurns(messages).map((turn) => {
      // `Turn` 上那两条是 `Message`（模型层的基类型），实际对象就是我们这边的 `ChatMessage`
      const user = turn.user as ChatMessage | null
      const reply = turn.reply as ChatMessage | null
      const key = `${user?.id ?? ''}|${reply?.id ?? ''}`
      const previous = cache.get(key)
      const value =
        previous && previous.user === turn.user && previous.reply === turn.reply ? previous : turn
      kept.set(key, value)
      return value
    })
    cacheRef.current = kept
    return stable
  }, [messages])
}

/** 骨架屏：只画有把握的结构（几行灰条），不画"空对话"的欢迎层，也别让人干等一屏白。
    灰条走 Kimi 的 shimmer 扫光（`ch-shimmer`，与工具链块的加载语言同一条）。 */
function LoadingSkeleton() {
  return (
    <div className="ch-skeleton" aria-hidden>
      {[92, 78, 85, 64].map((width, row) => (
        <div key={row} className="ch-skeleton-bar" style={{ width: `${width}%` }} />
      ))}
    </div>
  )
}

export function ChatThread() {
  const chat = useChat()
  const isRunning = useAuiState((state) => state.thread.isRunning)
  const order = useMemo(() => turnIndexes(chat.messages), [chat.messages])
  // 提问与回答是**一个整体**（旧前端渲染前先配对）：配对交给 `model/turns` 的
  // `buildTurns`，这里按轮次号取回来——「存为笔记」的标题、出处、交付物都按它对。
  // **这一层必须保住"没动的轮还是原来那个对象"**（见 `useStableTurns`），
  // 否则下面那些 `React.memo` 一个都拦不住。
  const turns = useStableTurns(chat.messages)

  /**
   * 「用户还在最新那一头」——内容再长就贴回底部；他往上翻过就不再抢。
   *
   * 这一条状态**只由三处改**：滚轮/触摸/翻页键（停）、滚回贴底（恢复）、
   * 换会话或新发出提问（回到最新）。库自带的那套自动落底已经全关（见下面视口那一段），
   * 所以"把翻上去的人拽回底部"不再有第二条路。
   */
  const followRef = useRef(true)
  /** 视口节点：由回调 ref 交上来（落底与量"离底多远"都要它）。 */
  const viewportRef = useRef<HTMLDivElement | null>(null)
  /** 已经排队、还没执行的那一次落底——用户一翻页就要把它撤掉。 */
  const frameRef = useRef<number | null>(null)
  /** 当前节点上那批监听/观察者的拆除函数（ref 换了节点时必须成对摘掉）。 */
  const detachRef = useRef<(() => void) | null>(null)

  /**
   * 贴到最底下。
   *
   * **已经贴底（或内容压根没溢出）就一个字都不写**：那一写会连带发出一次 `scroll` 事件，
   * 也会把"用户自己摆的那个位置"擦掉——jsdom 不算版面（`scrollHeight` 恒为 0），
   * 这一条在那里就是"视口本来就没得滚却把人摆的位置改成 0"，
   * `chat-ui.test.tsx` 的「开抽屉不动底下对话的滚动位置」正是这么红过一次。
   */
  const pinToBottom = useCallback(() => {
    const el = viewportRef.current
    if (!el) return
    // 贴底那一档：把共享位写成"贴底"（浮标据此消失）。早退那一路同样要写——
    // "没有可滚的空间"本身就是贴底
    useFollowStore.getState().setAtBottom(true)
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= 0) return
    el.scrollTop = el.scrollHeight
  }, [])

  /**
   * 视口的监听与观察者都挂在**回调 ref** 里，不放进 `useEffect(…, [])`。
   *
   * 为什么非得是回调 ref：本版 assistant-ui 的 `ThreadPrimitive.Viewport` 自己组合了一个
   * `autoScrollRef`，节点交给外面是**晚一步**的——`useEffect(…, [])` 跑到时 `current`
   * 还是 `null`，监听一个都没装上，而库里那个 ResizeObserver 是当场读 ref 的，照写不误，
   * 表现成"用户往上翻、程序还在把人拽回底部"。
   *
   * 但**光用回调 ref 还不够**（上一轮就停在这儿）：本版库里那个组合 ref 的**函数身份每次
   * 渲染都换**（`useManagedRef` 收到的是内联箭头，而 radix 的 `useComposedRefs` 把 `refs`
   * 当依赖），于是 React 每渲染一次就先 `ref(null)` 再 `ref(node)` 重交一次。流式每来一个
   * 字都要重渲染，实测 6 秒里视口上的监听被摘掉重挂 **1930 次**、挂在它上面的
   * MutationObserver 重绑 **772 次**——监听确实挂上了，但下一帧就被拆掉，**连已经排队的那
   * 一次贴底也一起撤了**，所以看起来还是"没生效"。节点本身从头到尾没换过
   * （`.shots/d31-remount.cjs`），所以这里：`null` 一律忽略，只有**真换了节点**才拆旧的。
   */
  const attachViewport = useCallback(
    (node: HTMLDivElement | null) => {
      // 见上面：`null` 是"ref 函数换身份"的伴生调用，不是卸载（真卸载时这个闭包连同节点
      // 一起变成不可达，会被回收，所以不拆也不漏）
      if (node === null || node === viewportRef.current) return
      detachRef.current?.()
      detachRef.current = null
      viewportRef.current = node
      // 把节点交给共享位（浮标点击时滚它），并按当下位置初始化"贴底"这一格
      const follow = useFollowStore.getState()
      follow.setViewport(node)
      const atBottomNow = () =>
        node.scrollHeight - node.scrollTop - node.clientHeight <= FOLLOW_THRESHOLD_PX
      follow.setAtBottom(atBottomNow())

      /** 内容长了一截 → 一帧内补到新的底部（贴底那一档才补）。 */
      const scheduleFollow = () => {
        if (frameRef.current !== null) return
        frameRef.current = requestAnimationFrame(() => {
          frameRef.current = null
          if (followRef.current) pinToBottom()
        })
      }

      /**
       * 停止跟随。**已经排队的那一次落底要一起撤掉**——上一轮查到的那一次回拽，
       * 就是"滚轮之前最后一批内容增长把帧排上了，滚轮之后它照跑"。
       */
      const stopFollowing = () => {
        followRef.current = false
        useFollowStore.getState().setAtBottom(false)
        if (frameRef.current !== null) {
          cancelAnimationFrame(frameRef.current)
          frameRef.current = null
        }
      }

      const onWheel = (event: WheelEvent) => {
        /*
          判"用户在往上翻"只认 `wheel` 的方向，不认 `scroll` 的位置。

          两个理由：① `wheel` 在浏览器真正滚动**之前**就到，判据落地时位置还没变；
          ② `scroll` 那一头分不清是谁改的——浏览器滚动锚定会自己补偿 `scrollTop`
          （实测：一次滚轮之后 JS 一次都没写，位置却被挪了 324px），`scrollHeight`
          在流式期间又一直在变，把"用户往上翻"挂在 `scroll` 上两头都会误判。
        */
        if (event.deltaY < 0) stopFollowing()
      }
      // 触摸一上来就先停：手指的意图没法像 `wheel` 那样只看一个数
      const onTouchMove = () => stopFollowing()

      /**
       * 上翻键的意图判在 **document** 上，不再挂在视口元素上（D31 补验 + 本轮实测）。
       *
       * 病灶（真浏览器实测）：监听挂在视口上时只有"焦点落在视口里"才收得到；而视口原先
       * **不可聚焦**（没有 `tabindex`），点一下消息区焦点落在 `BODY`——于是键盘用户按 PageUp
       * **根本翻不动这一栏**（浏览器滚的是"焦点元素的最近可滚动祖先"，那条链上不是这一栏），
       * 位置差实测 0。现在两件事配一对：
       * ① 视口加 `tabIndex={0}`（见下面视口那一行）→ 它成为可聚焦的滚动区，键盘真能滚它；
       * ② 判定挪到 document → 焦点在视口本身或它里面任何可聚焦元素上都收得到。
       *
       * 两道闸：
       * - ① **输入控件里不算**（见 `isEditableTarget`）：那是改文字，不是往回读；
       * - ② **视口不在文档里不算**（`isConnected`）。这一条刻意**不用 `getClientRects()`
       *   判"看得见"**：不在这棵树上时监听本来就随 `attachViewport` 的 cleanup 摘掉了，
       *   而 jsdom 不算版面（任何元素都没有 client rect）——用它会把手写用例里这条行为
       *   一起挡掉，等于让这条修法在测试里测不到。
       *
       * 只改"停止跟随"这一个状态：往下滚、回到贴底那两条路一个字都没动。
       */
      const onDocumentKeyDown = (event: KeyboardEvent) => {
        if (!SCROLL_UP_KEYS.has(event.key)) return
        if (isEditableTarget(event.target)) return
        const el = viewportRef.current
        if (!el || !el.isConnected) return
        stopFollowing()
      }

      /*
        `scroll` 只用来做一件事：**回到贴底就把跟随接回来**。

        点浮标、自己滚到底、换会话之后落底，走的都是这里；其余任何位置变化都不改跟随，
        所以浏览器滚动锚定的补偿、内容长高之后的位移，都不会被误读成"用户在看旧内容"。
      */
      const onScroll = () => {
        const el = viewportRef.current
        if (!el) return
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD_PX
        useFollowStore.getState().setAtBottom(atBottom)
        if (atBottom) {
          followRef.current = true
        }
      }

      // 流式的每一个字都是一次 `characterData` 变更，所以这个观察者就是"内容长了"的信号。
      // 不观察 `attributes`：视口里不少元素靠 class 开关做过渡，那些变更不代表内容变高。
      const growth = new MutationObserver(scheduleFollow)
      growth.observe(node, { childList: true, subtree: true, characterData: true })

      node.addEventListener('wheel', onWheel, { passive: true })
      node.addEventListener('touchmove', onTouchMove, { passive: true })
      document.addEventListener('keydown', onDocumentKeyDown)
      node.addEventListener('scroll', onScroll, { passive: true })

      detachRef.current = () => {
        follow.setViewport(null)
        growth.disconnect()
        node.removeEventListener('wheel', onWheel)
        node.removeEventListener('touchmove', onTouchMove)
        document.removeEventListener('keydown', onDocumentKeyDown)
        node.removeEventListener('scroll', onScroll)
        if (frameRef.current !== null) {
          cancelAnimationFrame(frameRef.current)
          frameRef.current = null
        }
      }
    },
    [pinToBottom],
  )

  const conversation = chat.conversationId
  const userTurns = chat.messages.reduce(
    (count, message) => count + (message.role === 'user' ? 1 : 0),
    0,
  )

  /**
   * "这一刻用户要看的是最新那一头"的三个时刻：刚进会话、换了另一条会话、刚发出提问。
   *
   * 只认两件**回合级**的事实：**会话 id 换了没有**（`conversationId` 就是路由参数，
   * `/chat` 那条新会话在第一条消息落定之后才拿到 id）、**提问多了几条**。
   *
   * **不许拿消息 id 当判据**（第一版就是那么写的，被真浏览器探针抓出来）：一轮跑完时
   * 详情会从库里重画一次（乐观消息整批换成库里那份），id 全变——按 id 判就会在那一刻
   * 把正在往上读的人再拽回底部（实测：这一轮跑完 8 秒后一次 **2139px** 的回拽，
   * 写入的调用栈正落在这一行的 `pinToBottom` 上）。会话 id 与提问条数在"换会话 / 新提问"
   * 之外都不会变，所以详情重画、内容增长、过程面板更新都不会误触。
   */
  useEffect(() => {
    followRef.current = true
    pinToBottom()
  }, [conversation, userTurns, pinToBottom])

  return (
    <ThreadPrimitive.Root
      /*
        `min-h-0 flex-1`：这一列**必须能让位**（第三批评审 A P0，实测修正）。
        原先是 `h-full`——它把这一列钉在容器高度上，而 `h-dvh` 那一列的另一个孩子
        是输入卡片：只要会话里有一点内容，这一列的"内容最小高度"就超过了容器高度，
        于是它再也不能压缩，**输入卡片被整个挤出视口**（测：窗口 900 时卡片在
        y=900~1054，`main.scrollHeight` = 1054，想打字得先把页面滚一下）。
        换成 `flex-1`（`flex: 1 1 0%`）+ `min-h-0` 之后，视口自己滚（它本来就有
        `min-h-0 flex-1 overflow-y-auto`），输入卡片常驻在视口底部。
      */
      className="relative flex min-h-0 flex-1 flex-col"
      data-running={isRunning ? 'true' : 'false'}
    >
      {/* 抬头**在视口之外**（不跟着消息滚走）：常驻的"这是哪条会话、属于哪个项目"。
          它同时给消息区一条上边界——原先正文直接贴在窗口顶端 */}
      <ChatHeader />
      <ThreadPrimitive.Viewport
        /*
          **库的整套自动落底都关掉**（`autoScroll` + 那三条"到某个时刻落底"），
          跟随改由上面 `attachViewport` 自己判。为什么非关不可：

          `useThreadViewportAutoScroll` 的判据是 `isUserScrollUp`——它要求两次读数之间
          `scrollHeight` **一模一样**才算"用户往上翻"。流式期间内容每一帧都在长，这个等号
          几乎从不成立，于是真实的滚轮被读成"内容长了"，`followBottomRef` 一直是真的，
          下一次内容增长就 `scrollToBottom` 把人拽回底部（上一轮基线：翻上去 400px 被拽回
          正好 400px、浮标一次都没出现；本轮反向验证在这支探针上量到一次 **3192px** 的回拽，
          伴随 239 次 `scrollTop` 写入、86 次 `scrollTo`）。这条判据在库内部，外面改不了，
          只能不用它。三条"到某个时刻落底"各自还会先种下一个**待落底意图**：内容还没
          溢出时它既不落底也不清掉（库自己用 `pointerdown` 兜的就是这个坑，而滚轮用户
          不会触发 `pointerdown`），会在后面某次内容增长时补上一记——所以一并关掉，
          落底时机集中在上面那个 effect 里。

          `overflow-anchor: none` 是**关掉浏览器滚动锚定**：视口里那块 markdown 长高时，
          浏览器会自己改 `scrollTop` 去补偿（实测 324px，且 JS 一次没写）。那是浏览器行为，
          不是用户也不是我们写的——留着它，用户读到一半位置会被挪走，而"谁动了 scrollTop"
          这件事也永远查不清。关掉之后 `scrollTop` 只会因为两件事变：用户的手势，
          和我们自己那次贴底。
        */
        autoScroll={false}
        scrollToBottomOnRunStart={false}
        scrollToBottomOnInitialize={false}
        scrollToBottomOnThreadSwitch={false}
        className="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]"
        aria-label="对话内容"
        /*
          **可聚焦的滚动区**（D31 补验的缺口）：不聚焦时键盘用户按 PageUp 翻不动这一栏
          （浏览器滚的是"焦点元素的最近可滚动祖先"，而点一下消息区时焦点落在 `BODY`）。
          加上 `tabIndex={0}` 之后：Tab 到它、或点它内部任何不可聚焦的地方，焦点都落到这里，
          PageUp / ArrowUp 就真能滚这一栏；焦点环由 `tokens.css` 那条全局
          `:focus-visible`（2px 墨环 + 2px offset）给——**鼠标点它不亮**，只有键盘导航才亮，
          所以不需要再加任何类名。
        */
        tabIndex={0}
        ref={attachViewport}
      >
        {/* 正文列：**与输入卡片同一条 768px 的居中窄列**（`--chat-measure`），内边距照旧
            `ChatView.vue` 的 `.chat-inner`（`space-6 / gutter / space-4`）；空态那一条把
            **下内边距归零**（旧 `.chat-centered .chat-inner { padding-bottom: 0 }`）——
            空态下半屏不留贴底用的那截呼吸感。 */}
        <div
          className={
            chat.welcome
              ? 'mx-auto flex min-h-full w-full max-w-[calc(var(--chat-measure)+2*var(--page-gutter))] flex-col items-center justify-center px-[var(--page-gutter)] pt-[var(--space-6)] pb-0'
              : 'mx-auto w-full max-w-[calc(var(--chat-measure)+2*var(--page-gutter))] px-[var(--page-gutter)] pt-[var(--space-6)] pb-[var(--space-4)]'
          }
        >
          {chat.messages.length === 0 && chat.pendingEntry ? (
            <div className="w-full">
              <LoadingSkeleton />
            </div>
          ) : chat.welcome ? (
            <Welcome />
          ) : (
            <div data-testid="message-list">
              {chat.messages.map((message, index) => (
                <MessageView
                  key={message.id}
                  message={message}
                  turn={turns[order.get(message.id) ?? 0] ?? { user: null, reply: message }}
                  turnIndex={order.get(message.id) ?? 0}
                  isFirst={index === 0}
                  role={message.role === 'user' ? 'user' : 'assistant'}
                />
              ))}
            </div>
          )}
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  )
}
