/**
 * 一条消息（旧 `ChatView.vue` 模板里的 `.ask` 与 `.reply` 两块）。
 *
 * 提问是**右对齐气泡**（位置与形状已经说明它是谁说的，不再有"我的问题"这类标签）；
 * 回答左侧留一条头像位（`.ch-avatar`：56px，`margin-right:-12px` 让视觉宽收到 44px），
 * 正文与它下面的动作都归右边那一列。
 *
 * **竖向那两条间距**（2026-09-30 用户批注「间距与头像对齐」，两个数都是 Kimi 实测值，
 * 口径写在各自的调用点上）：
 * - 提问气泡底 → 回复行顶（回复行是**头像顶对齐**的，行顶就是头像顶）**34px**：
 *   改前这一档与"两组问答之间"共用 12px，气泡与回复贴得像同一条消息；
 * - 头像顶 → 回复首行顶 **16px**：56px 头像的**垂直中心**因此落在回复首行的中心上
 *   （首行 = 工具链总标题那种 24px 行，没有工具链时是正文首行）。这个 16px 就是
 *   `(56 - 24) / 2`，与《对话UI-重做-设计-v0.1》§5.2「助手段容器
 *   `padding: 16px 0 12px 16px`（源码值）」里那 16px 同值。
 *
 * 消息的原对象从 `getExternalStoreMessages` 回读——assistant-ui 只管"这是第几条、
 * 谁说的"，过程面板/出处/交付物这些属于我们的字段一个字都没经过它。
 */
import { Copy, File as FileIcon, RotateCcw, StickyNote, TriangleAlert } from 'lucide-react'
import { memo, useCallback, useMemo } from 'react'

import {
  degradedReason,
  failureText,
  hasToolCallMarkup,
  replyArtifacts,
  stripToolCallMarkup,
  usedWebSearch,
  wasDegraded,
  type Message,
  type Turn,
} from '@/features/chat/model/turns'
import { webCitationsOfSteps } from '@/features/chat/model/sourceCitations'
import { formatBytes } from '@/lib/format'

import { AnswerText } from './AnswerText'
import { AssistantAvatar } from './AssistantAvatar'
import { Deliverables } from './Deliverables'
import { ToolchainFlow, hasFlow } from './ToolchainFlow'
import { useChatRows, type ChatMessage } from '../runtime/ChatProvider'

/**
 * 正文那一块**只在它自己的文本 / 出处 / "待生成"那一位变了时才重渲染**。
 *
 * 为什么在这里包一层、而不改 `AnswerText.tsx` 自己：那个文件不属于这一条 lane，而且它
 * **不消费 `useChat()`**——这正是它能整块跳过的原因（D32：context value 每拍都换新对象，
 * 消费 `useChat()` 的组件一律重渲染，只有不消费的那些 `React.memo` 才拦得住）。
 * markdown 重排是这棵树里最贵的一项：实测单次 commit 里有 ~680 个 markdown 段落重新渲染，
 * 而其中绝大多数属于**没在流式**的那些回答（它们的 `text` 一个字都没变）。
 *
 * 代价是它的每个 prop 都必须稳定，所以 `className` 写成字面量、`citeFallback` 与
 * `onCite` 在 `AssistantMessage` 里各做了一次稳定化（见那里的注释）。
 */
const MemoAnswerText = memo(AnswerText)

/**
 * 正文那一块的类名——**两串都在模块加载时定好、之后不再变**：上面那段说的"`className`
 * 写成字面量"，要的就是"每一拍交下去的 `className` 是同一个字符串"。
 *
 * 两串只差开头那一档 `mt-3`（12px = 过程块与正文之间的那口气）：**上面真有过程块时才挂**
 * （`ANSWER_CLASS_AFTER_FLOW`），理由见 `gapAfterFlow`。
 */
const ANSWER_CLASS_BASE =
  'max-w-[var(--measure)] text-[length:calc(16px*var(--font-scale))] leading-[1.625] text-[var(--Labels-Primary)]'
const ANSWER_GAP = 'mt-[var(--space-3)]'
const ANSWER_CLASS_AFTER_FLOW = `${ANSWER_GAP} ${ANSWER_CLASS_BASE}`

function UserMessage({ message, turnIndex }: { message: ChatMessage; turnIndex: number }) {
  const chat = useChatRows()
  const copied = chat.copiedKey === `${turnIndex}:user`
  return (
    <div className="group/ask flex items-end justify-end gap-[var(--space-2)]">
      {/* 提问也能复制：用户常常要把同一个问题拿去别处问 */}
      <button
        type="button"
        className={`mb-[2px] inline-flex h-[22px] w-[22px] cursor-pointer items-center justify-center rounded-[var(--radius-control)] text-[var(--text-tertiary)] opacity-0 transition-opacity [transition:opacity_var(--motion-fast)_var(--motion-ease)] group-hover/ask:opacity-100 focus-visible:opacity-100 ${
          copied ? 'opacity-100' : ''
        }`}
        aria-label={copied ? '已复制提问' : '复制提问'}
        title={copied ? '已复制' : '复制'}
        onClick={() => chat.copyMessage(turnIndex, message)}
      >
        <Copy size={13} />
      </button>
      <div className="flex max-w-[min(78%,620px)] flex-col items-end gap-[var(--space-2)]">
        {/* 用户气泡对标 Kimi（设计文档 §9 实测值）：Bg-Secondary 底 + 12px 圆角 +
            10/12 内边距，**没有描边**（旧版那条 hairline 删掉） */}
        <p className="m-0 w-fit max-w-full rounded-[12px] bg-[var(--Bg-Secondary)] px-[12px] py-[10px] text-[length:var(--text-body-size)] whitespace-pre-wrap text-[var(--text-primary)] [overflow-wrap:anywhere]">
          {message.text}
        </p>
        {/*
          随发的附件（v0.55）：一份一个小片，摆在提问文本**下方**。
          点它开「产物与文件」抽屉并直落这一份（与产物卡片同一条路），所以 key / name / kind
          三个一起给过去——光有 key 猜不出该用哪个渲染器（见 `ChatProvider.filesSeed`）。
          aria-label 带上文件名，读屏才分得出点的是哪一份。
        */}
        {message.attachments.length > 0 ? (
          <ul className="m-0 flex list-none flex-wrap justify-end gap-[var(--space-2)] p-0">
            {message.attachments.map((file) => (
              <li key={file.key}>
                <button
                  type="button"
                  className="inline-flex max-w-[220px] cursor-pointer items-center gap-[var(--space-1)] rounded-[var(--radius-control)] border border-[var(--border-hairline)] bg-[var(--bg-subtle)] px-[var(--space-2)] py-[var(--space-1)] text-left text-[length:var(--text-micro-size)] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
                  aria-label={`预览 ${file.name}`}
                  title={file.name}
                  onClick={() =>
                    chat.openFiles({ key: file.key, name: file.name, kind: file.kind })
                  }
                >
                  <FileIcon size={13} aria-hidden="true" className="shrink-0" />
                  <span className="truncate">{file.name}</span>
                  <span className="tabular shrink-0 text-[var(--text-tertiary)]">
                    {formatBytes(file.size_bytes)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  )
}

function AssistantMessage({
  message,
  turn,
  turnIndex,
}: {
  message: ChatMessage
  turn: Turn
  turnIndex: number
}) {
  const chat = useChatRows()
  /**
   * `revealSource` 单独取出来：`useCallback` 的依赖数组要写它（写 `chat.revealSource` 的话
   * lint 会要求依赖整个 `chat`，而那个对象每拍都换新身份 → memo 白做）。
   */
  const { revealSource } = chat
  const artifacts = replyArtifacts(turn)
  /**
   * 这一轮的工具链块（以及正文上面那条灰线）出不出——**判据只有一处**（`hasFlow`）：
   * 灰线、正文上面那一档间距、以及"这一列的首行是谁"问的都是它。
   */
  const flow = hasFlow(turn)
  /**
   * 过程块与正文之间那一档间距（12px = `--space-3`）：**上面真有过程块时才给**。
   *
   * 没有过程块的那些轮次（纯直接作答、只剩一句"只返回了工具调用标记"），正文自己就是
   * 这一列的**首行**——首行的位置由列上的 `pt-[16px]` 说了算（见文件头那两条间距）。
   * 这里再补一次 `mt-3`，首行顶就落到 +28px、中心落到 +40px 上，比头像中心（+28px）
   * 低出**半行**（12px = 首行行高 24px 的一半）——肉眼看到的就是用户批注②那句「没对齐」。
   */
  const gapAfterFlow = flow ? ANSWER_GAP : ''
  const isLastTurn = turnIndex === chat.turnCount - 1
  /**
   * 这一轮**后面**还有几轮（D35）：失败气泡上那个「重试」会把它们一起撤掉，
   * 所以标题里要把代价说清楚（`retryTurn` 那边同时会把已落库的那几轮从库里撤掉）。
   */
  const laterTurns = chat.turnCount - turnIndex - 1
  const copied = chat.copiedKey === `${turnIndex}:assistant`
  /** 「复制问题」与提问气泡上那枚复制共用一份状态（同一个键）。 */
  const questionCopied = chat.copiedKey === `${turnIndex}:user`
  const saved = chat.savedTurns.includes(turnIndex)
  const degraded = !message.streaming && wasDegraded(message)
  const rawTools = hasToolCallMarkup(message.text)
  /** 正文先把工具调用标记剥掉（只动显示，库里原文不改），再进 Markdown。 */
  const answerText = useMemo(() => stripToolCallMarkup(message.text), [message.text])
  /**
   * 正文里对不上出处的编号怎么画（A6）。
   *
   * 这一轮**跑过联网搜索**时给一句说明：那些编号指的就是过程面板里那次搜索的返回
   * （`web_search` 的返回本身是 `[1] … [N]` 带编号的，见 `usedWebSearch`）。
   * 没跑过就什么都不说——模型凭空写的编号，我们不给它编一个来源。
   *
   * `citations`（D11-③）：把这一次联网搜索的**编号 → 网页引用**（标题 / URL / 域名 / 摘要）
   * 一起交下去，正文里那些编号就渲染成**站点徽章**（真实 logo + 域名 + 悬停卡片）。
   * 数据全部来自**这一步已有的返回文本**（`model/sourceCitations.ts` 解析），
   * 没有新增后端字段；解析不出 URL 的那些**仍然走上面那句说明**（不做空徽章、不出破图）。
   */
  const citeFallback = useMemo(
    () =>
      usedWebSearch(message)
        ? { title: '联网搜索结果，见过程面板', citations: webCitationsOfSteps(message.steps) }
        : undefined,
    [message],
  )
  /**
   * 点正文里的编号 → 就地滑出那段原文。
   *
   * 包一层 `useCallback` 是为了 `MemoAnswerText`：内联箭头每次都换身份，会让那一层 memo
   * 整块失效（`revealSource` 自己是宿主上的 `useCallback`，身份是稳的）。
   */
  const revealCite = useCallback(
    (sourceIndex: number) => revealSource(turnIndex, sourceIndex),
    [revealSource, turnIndex],
  )

  return (
    <div className="flex items-start gap-[var(--space-3)]">
      <AssistantAvatar live={message.streaming === true && !message.error} />
      {/*
        回复列：`pt-[16px]` 是**头像与首行对齐**那一条（2026-09-30 用户批注②）——
        头像是这一行里 `items-start` 顶对齐的第一个孩子，所以列的 `padding-top` 就是
        "首行比头像顶低多少"。56px 的头像与 24px 的首行要**中心重合**，这个下沉量就是
        `(56 - 24) / 2 = 16px`（首行是 `.ch-head`，`min-height:24px` + `line-height:24px`；
        没有工具链的那一轮首行换成正文首行，16px/1.625 = 26px，中心只差 1px；
        工具链那一档的 24px 是写死的，所以任何字号档（`--font-scale`）都对得上）。

        16px 是 `--space-4` 的档位值，但这里**不写成 `pt-[var(--space-4)]`**：它是从
        头像与首行两个高度**算出来的**光学对齐量（头像改高、首行改行高都要跟着重算），
        不是间距阶梯上的一次选择——写成令牌会让人以为改令牌是安全的。
      */}
      <div className="min-w-0 flex-1 pt-[16px]">
        {message.error ? (
          /*
            失败那一轮（第四批评审 B①）：原先这里只有一句红字，**没有任何出口**——
            输入框里的字已经被清空了，用户既看不到原因，也没有"再试一次"的路。
            现在两件事：**重试**（把这一轮原样重发，见 provider 的 `retryTurn`）
            与**复制问题**（重试还不行时，把那句提问拿到别处去问）。

            只给**最后一轮**「重试」：重发是把提问追加到会话末尾，
            中间那一轮重发会把顺序弄乱（与「重新生成」同一条纪律）。
            重试一失败，新的失败气泡自己又长出这两个出口，不必在别处再放一份。

            **输入框不回填**（评估过，不是漏了）：那句提问就在上面这轮里看得见，
            回填等于给同一件事第二个入口——用户若顺手发出去，会话里会多出一条
            一模一样的提问；要改一版再问，走「复制问题」拿出去改，比"填回来再删"
            少一步错。**回填只给「撤回」那一类**（`/rewind` 是真把提问从会话里删了，
            不填回来就真没了，见 ChatProvider 的 `commandRefill`）。
          */
          <div className="max-w-[var(--measure)]">
            <p
              className="m-0 flex items-start gap-[var(--space-1)] text-[length:var(--text-body-size)] text-[var(--status-danger)]"
              data-testid="reply-error"
            >
              <TriangleAlert size={15} className="mt-[3px] shrink-0" />
              <span>这一轮没跑起来：{failureText(message.error)}</span>
            </p>
            <div className="mt-[var(--space-2)] flex items-center gap-[var(--space-3)]">
              {/*
                失败的那一轮**每一轮都给重试**（D35，2026-09-28 走查）。
                原先这里还有 `isLastTurn`：非最后一轮的失败气泡只剩「复制问题」，
                而用户看到的正是一个可以再试一次的失败。现在放开了——
                `retryTurn` 那边已经会把"这一轮之后**已落库**的轮次"一起撤掉
                （本地切掉而库里留着会错位，那正是当初加这道限制的原因）；
                后面真有轮次要撤时，标题里把代价说清楚。
              */}
              {!chat.sending ? (
                <button
                  type="button"
                  className="inline-flex cursor-pointer items-center gap-[var(--space-1)] text-[length:var(--text-micro-size)] font-medium text-[var(--accent-text)] hover:underline disabled:cursor-default disabled:opacity-60"
                  disabled={chat.regenerating}
                  title={
                    laterTurns > 0
                      ? `把这一轮原样再发一次（后面的 ${laterTurns} 轮会一起撤掉）`
                      : '把这一轮原样再发一次'
                  }
                  onClick={() => chat.retryTurn(turnIndex)}
                >
                  <RotateCcw size={13} />
                  重试
                </button>
              ) : null}
              {turn.user ? (
                <button
                  type="button"
                  className="inline-flex cursor-pointer items-center gap-[var(--space-1)] text-[length:var(--text-micro-size)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                  title="把那句提问复制下来"
                  onClick={() => chat.copyMessage(turnIndex, turn.user as Message)}
                >
                  <Copy size={13} />
                  {questionCopied ? '已复制' : '复制问题'}
                </button>
              ) : null}
            </div>
          </div>
        ) : (
          <>
            {/* 出错的那一轮没有过程可讲，只报错 */}
            <ToolchainFlow
              turn={turn}
              turnIndex={turnIndex}
              open={chat.traceOpen(message) === 'full'}
              onToggle={() => chat.toggleTrace(message)}
              expansion={{
                isOpen: chat.isStepOpen,
                toggle: chat.toggleStep,
                groupChoice: chat.groupOpenChoice,
                chooseGroup: chat.chooseGroupOpen,
              }}
              citesOpen={chat.citesExpanded(turnIndex)}
              onToggleCites={() => chat.toggleCites(turnIndex)}
              flashSource={chat.flashCite}
              onOpenSource={(item) => chat.openSource(item)}
              artifactNames={chat.artifactNames}
            />

            {/*
              **工具链与正文之间的那条灰色分隔线**（2026-09-30 用户批注：对照 Kimi
              最初的设计，过程与最终回答要有灰线分开）。出不出与块**同一个判据**
              （`flow`，就是 `hasFlow(turn)`）——块不出的时候也不该留一条空线
              （R4 起纯直接作答那轮就是这种）。
            */}
            {flow ? <div className="ch-divider" role="separator" aria-hidden /> : null}

            {/*
              模型把工具调用写进正文（§12.219）：**标记永远不进正文**（2026-09-30
              《对话UI-重做-设计》§5.1）——剥掉再排，只动显示、库里的原文不改。
              剥完什么都不剩的那一轮（整条回答只有标记）给一句安静的说明，
              而不是旧版那一大块等宽原文。
            */}
            {answerText || message.streaming ? (
              /* 正文排版对标 Kimi markdown B1：16px/1.625（=26px 行高），
                 字号仍乘全局 `--font-scale`（用户的字号设置不能失效）。
                 `max-w-[var(--measure)]`：行宽 66ch 上限照旧（阅读型界面的口径）。
                 两串类名在模块顶上定好了（`ANSWER_CLASS_*`）：上面有过程块时才多那一档
                 `mt-3`，没有过程块时正文就是这一列的首行（见 `gapAfterFlow`）。 */
              <MemoAnswerText
                className={flow ? ANSWER_CLASS_AFTER_FLOW : ANSWER_CLASS_BASE}
                text={answerText}
                // 流式中且还没有正文 → 正文区给一句"正在生成…"（D27）。消息上的 `streaming`
                // 由镜像层按 live 状态写着（见 ChatProvider 的 mirrorLive）。
                pending={message.streaming === true}
                sources={message.sources}
                citeFallback={citeFallback}
                onCite={revealCite}
              />
            ) : rawTools ? (
              <p
                className={`${gapAfterFlow} mb-0 text-[length:var(--text-micro-size)] text-[var(--text-tertiary)]`}
                data-testid="reply-raw-tools"
              >
                这一轮只返回了工具调用标记，没有正文。
              </p>
            ) : null}

            {/*
              降级提示：**没按设计走完**是这一轮唯一的降级情形。两个出口是两件不同的事：
              「继续」= 接着做（已经查到的资料接着用）；「重试」= 从头再来（回退一轮重发）。
              两个都只在最后一轮给：续跑端点认的就是"会话里最后一条回答"。
            */}
            {degraded ? (
              <p className="mt-[var(--space-3)] mb-0 flex flex-wrap items-center gap-[var(--space-1)] text-[length:var(--text-micro-size)] text-[var(--status-warning)]">
                <TriangleAlert size={13} />
                这次没跑完（{degradedReason(message)}）。
                {isLastTurn && !chat.sending ? (
                  <>
                    <button
                      type="button"
                      className="cursor-pointer font-medium text-[var(--accent-text)] hover:underline disabled:cursor-default disabled:opacity-60"
                      disabled={chat.resuming || chat.regenerating}
                      title="接着用已经查到的资料继续做"
                      onClick={() => chat.resumeTurn(turnIndex)}
                    >
                      {chat.resuming ? '继续中…' : '继续'}
                    </button>
                    <span className="text-[var(--separator)]">·</span>
                    <button
                      type="button"
                      className="cursor-pointer text-[var(--accent-text)] hover:underline disabled:cursor-default disabled:opacity-60"
                      disabled={chat.resuming || chat.regenerating}
                      title="丢掉这次的过程，重新问一遍"
                      onClick={() => chat.regenerate(turnIndex)}
                    >
                      {chat.regenerating ? '重试中…' : '重试'}
                    </button>
                  </>
                ) : null}
              </p>
            ) : null}

            {/* 交付物：**流式中先不摆**，等这一轮收尾再一起交付 */}
            {artifacts.length > 0 && !message.streaming ? <Deliverables files={artifacts} /> : null}

            {/* 消息级操作：复制永远可用；重新生成只给**最后一轮** */}
            {!message.streaming ? (
              <div className="mt-[var(--space-2)] flex items-center gap-[var(--space-3)]">
                <button
                  type="button"
                  className="inline-flex cursor-pointer items-center gap-[var(--space-1)] text-[length:var(--text-micro-size)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                  onClick={() => chat.copyMessage(turnIndex, message)}
                >
                  <Copy size={13} />
                  {copied ? '已复制' : '复制'}
                </button>
                {/* 存为笔记：问答是笔记最自然的来源之一（问答 → 笔记 → 语料 闭环） */}
                <button
                  type="button"
                  className="inline-flex cursor-pointer items-center gap-[var(--space-1)] text-[length:var(--text-micro-size)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                  onClick={() => chat.saveAsNote(turnIndex, turn)}
                >
                  <StickyNote size={13} />
                  {saved ? '已存为笔记' : '存为笔记'}
                </button>
                {isLastTurn && !chat.sending ? (
                  <button
                    type="button"
                    className="inline-flex cursor-pointer items-center gap-[var(--space-1)] text-[length:var(--text-micro-size)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] disabled:cursor-default disabled:opacity-60"
                    disabled={chat.regenerating}
                    onClick={() => chat.regenerate(turnIndex)}
                  >
                    <RotateCcw size={13} />
                    {chat.regenerating ? '生成中…' : '重新生成'}
                  </button>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}

/**
 * 一条消息的入口（由 assistant-ui 的消息列表逐个调用）。
 *
 * `turnIndex` 由外层算好传进来（`数据` 里那两个键 `[turnIndex]:[role]` 用它）：
 * 一条回答与它前面那条提问共享同一个轮次号，行内徽标、出处、消息动作都按它分组。
 *
 * **`memo` 的前提是 props 稳定**，而两件事一起保证了它：`ChatThread` 那边
 * `useStableTurns`（没动的轮还是上一帧那个对象）、镜像那边只换被写到的那一条消息。
 * 注意这一层只挡得住"父组件重渲染"；`useChat()` 的 context 变化会绕过 memo
 * （子组件 `UserMessage`/`AssistantMessage` 都是消费者），那一半由 context 拆分解决。
 */
export const MessageView = memo(function MessageView({
  message,
  turn,
  turnIndex,
  isFirst,
  role,
}: {
  message: ChatMessage
  /** 这一条所属的那一轮（提问 + 回答）——「存为笔记」的标题要用提问那条。 */
  turn: Turn
  turnIndex: number
  isFirst: boolean
  role: 'user' | 'assistant'
}) {
  /*
    两种间距，各一条：
    - **两组问答之间 24px**（`--space-6`）：组与组要能一眼分开，所以比组内大一档；
    - **提问气泡 → 它那条回复 34px**（2026-09-30 用户批注①，Kimi 实测值）：改前这里与
      上一档共用 `mt-3`（12px），气泡底到回复第一行只有 12px，贴得像同一条消息。
      这 34px 量的是**气泡底 → 回复行顶**，而回复行是头像顶对齐的（头像就是这个行的顶，
      见文件头），所以写在这一行的上边距上；行内到首行还有 16px（回复列的 `pt-[16px]`），
      两段加起来 50px 才是"气泡底 → 回复第一行文字"。真机复量时按同样两段认。
  */
  const spacing = isFirst ? '' : role === 'user' ? 'mt-[var(--space-6)]' : 'mt-[34px]'

  return (
    <div className={spacing} data-turn={turnIndex} data-role={role}>
      {role === 'user' ? (
        <UserMessage message={message} turnIndex={turnIndex} />
      ) : (
        <AssistantMessage message={message} turn={turn} turnIndex={turnIndex} />
      )}
    </div>
  )
})
