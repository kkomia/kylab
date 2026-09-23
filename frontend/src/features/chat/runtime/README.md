# assistant-ui 自定义 runtime 契约（面向 kylab chat 开发）

> 本文是「照着写代码」的实现手册，不是 API 速查表。
> 所有签名与代码片段都从**上游最新源码**核对，标了文件路径。

## 0. 版本核对（先看这里）

| 项                                          | 值                                                            |
| ------------------------------------------- | ------------------------------------------------------------- |
| 上游仓库                                    | `https://github.com/assistant-ui/assistant-ui`（clone 成功）  |
| clone 位置                                  | `E:\gitlab\kylab\.cache\upstream\assistant-ui`（`--depth 1`） |
| 上游 HEAD                                   | `c84c7c6f7dec5fdfa111bd00bf42a6edd89b4964`（2026-09-23）      |
| `packages/react/package.json` 版本          | **0.15.21**                                                   |
| `npm view @assistant-ui/react version`      | **0.15.21**（latest，也是 0.15.x 最后一版）                   |
| 我们 `frontend-react/package.json` 固定版本 | `"@assistant-ui/react": "0.15.21"` 可用 与上游一致            |

**结论：上游 HEAD 就是 0.15.21，本文所有结论对本地安装版本直接生效，不需要降级或放宽版本。**

### 0.1 目录结构已经变了（重要，别照着旧资料找路径）

网上 0.8～0.11 时代的资料会让你们去读 `packages/react/src/runtimes/external-store/**`。**在 0.15.21 这个路径已经不存在了**，实际分布是：

```
packages/react/src/runtimes/external-store/        ← 不存在（旧的）
packages/core/src/runtimes/external-store/         ← 真实实现（1078 行的 thread runtime core 在这里）
packages/react/src/legacy-runtime/runtime-cores/external-store/*.ts
                                                   ← 只有 1~6 行，纯 re-export 桩
packages/core/src/react/primitives/**              ← primitive 的真实实现
packages/react/src/primitives/**                   ← React 端包装（默认组件、Slot）
```

例如 `packages/react/src/legacy-runtime/runtime-cores/external-store/useExternalStoreRuntime.ts` 全文只有 3 行：

```ts
'use client'

export { useExternalStoreRuntime } from '@assistant-ui/core/react'
```

**找源码时请直接去 `packages/core/src/**`。**

---

## 30 秒速答（六个问题的结论 + 跳转）

| #   | 问题                                 | 一句话答案                                                                                                                                                                                                                                                                                                                                                                                                                 | 详见 |
| --- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1   | `useExternalStoreRuntime` props 契约 | **只有 `onNew` 是必填**；`messages` / `messageRepository` 必须给一个（否则运行时报错）；`convertMessage` 在泛型不是 `ThreadMessage` 时必填。`adapters` 包含 `attachments/speech/dictation/voice/feedback/threadList`，**`history` 已被移除**；`onReload` 签名仍是 `(parentId, config)` 没变                                                                                                                                | §1   |
| 2   | 我们的消息塞哪种形状                 | 一个 assistant 消息 + `content` 数组（`text` / `reasoning` / `tool-call` / `source` / `file` / `image` / `data` / `generative-ui`）+ **`metadata.custom` 放自家数据**。**`status` 建议不填**，让运行时按内容自动推导（工具未完成 → 自动 `requires-action`）。「出处」用原生 `source` part，「审批」用 `tool-call.approval`                                                                                                 | §2   |
| 3   | 工具调用怎么渲染                     | `ToolCallMessagePart` 有 `toolName/args/argsText/result/isError/isPreliminary/artifact/status/approval/interrupt/parentId/messages`；渲染组件额外拿到 `addResult/resume/respondToApproval`。**`ToolFallback` 不在 `@assistant-ui/react` 里**（在 private 的 `@assistant-ui/ui`）。「同批合并成一行」用 **`MessagePrimitive.GroupedParts` + `groupPartByType({ "tool-call": ["group-tools"] })`**，组内状态用 `part.counts` | §3   |
| 4   | 必须的 primitive                     | **只有 `AssistantRuntimeProvider` 是强制的**。其余按需：`ThreadPrimitive.Root/Viewport/Messages/Empty/If/ScrollToBottom`、`MessagePrimitive.Root/Parts/GroupedParts/If`、`ComposerPrimitive.Root/Input/Send/Cancel/Attachments`。**`ThreadConfigProvider` 和 `useThreadRuntime` 都已彻底移除** —— 改用 `useAui()` / `useAuiState()` / `<AuiIf>`                                                                            | §4   |
| 5   | Composer 快捷键 / 禁用 / 菜单        | **Enter 发送、Shift+Enter 换行是默认行为**（`submitMode: "enter" \| "ctrlEnter" \| "none"`）。禁用分两层：`isDisabled`（连输入框都禁）vs `isSendDisabled`（只禁发，`Send` 按钮自动置灰）。**`/命令` 与 `@提及` 是原生支持的完整子系统**：`ComposerPrimitive.Unstable_TriggerPopover` + `unstable_useSlashCommandAdapter` / `unstable_useMentionAdapter`                                                                    | §5   |
| 6   | **离线可用？**                       | **可以完全自管网络层，不会被强制走它的 transport。** `useExternalStoreRuntime` 全量源码零 `fetch`/零 transport 依赖；`append()` 唯一出口就是 `await onNew(message)`；`isRunning` 直接透传你的值                                                                                                                                                                                                                            | §6   |

> **踩坑预警（最省时间的三条）**：
>
> 1. `convertMessage` 必须是**稳定引用**（模块级函数）—— 引用一变就清空整张转换缓存，流式时全量重转（§7.2）。
> 2. 消息对象**绝不能原地 mutate** —— 转换缓存是 `WeakMap`，key 不变则 UI 不更新（§7.2）。
> 3. `messages` 数组只替换变化的那一条，其余保持同一引用（§7.2）。

---

## 1. `useExternalStoreRuntime` 完整 props 契约

### 1.1 Hook 本身

`packages/core/src/react/runtimes/useExternalStoreRuntime.ts`

```ts
export const useExternalStoreRuntime = <T>(store: ExternalStoreAdapter<T>): AssistantRuntime => {
  const { modelContext, feedback } = useRuntimeAdapters() ?? {}
  const adaptedStore = useMemo(() => {
    if (!feedback || store.adapters?.feedback) return store
    return { ...store, adapters: { ...store.adapters, feedback } }
  }, [feedback, store])
  const [runtime] = useState(() => new ExternalStoreRuntimeCore(adaptedStore))

  useEffect(() => {
    return () => {
      invalidateThreadRuntime(runtime.threads.getMainThreadRuntimeCore())
    }
  }, [runtime])

  // 注意 没有依赖数组：每次 render 都同步最新 adapter 快照
  useEffect(() => {
    runtime.setAdapter(adaptedStore)
  })

  useEffect(() => {
    if (!modelContext) return undefined
    return runtime.registerModelContextProvider(modelContext)
  }, [modelContext, runtime])

  return useMemo(() => new AssistantRuntimeImpl(runtime), [runtime])
}
```

要点：

- 返回 `AssistantRuntime`，**必须**喂给 `<AssistantRuntimeProvider runtime={runtime}>`。
- runtime core 只创建一次（`useState` 惰性初始化）；props 变化通过每轮 render 后的 `setAdapter` 推入。
- 所以 **props 对象每轮 render 可以新建**，但 `convertMessage` / `messages` 的**引用稳定性**直接决定性能（见 §7）。

### 1.2 类型定义

`packages/core/src/runtimes/external-store/external-store-adapter.ts`

```ts
export type ExternalStoreMessageConverter<T> = (message: T, idx: number) => ThreadMessageLike

export type ExternalStoreAdapter<T = ThreadMessage> = ExternalStoreAdapterBase<T> &
  (T extends ThreadMessage ? object : ExternalStoreMessageConverterAdapter<T>) // { convertMessage: ... }
```

**关于 `convertMessage` 是否必需 —— 这是最容易被类型系统坑到的地方：**

| 泛型写法                                                           | `convertMessage`                               | 原因                                                                               |
| ------------------------------------------------------------------ | ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| `useExternalStoreRuntime<ThreadMessage>({...})`                    | 可选                                           | `ThreadMessage extends ThreadMessage` → 走 `object` 分支                           |
| `useExternalStoreRuntime<ThreadMessageLike>({...})`                | **必需**                                       | `ThreadMessageLike` 缺 `id`/`createdAt`/`metadata`，不满足 `extends ThreadMessage` |
| `useExternalStoreRuntime({...})`（不写泛型，默认 `ThreadMessage`） | 可选，但 `messages` 必须是完整 `ThreadMessage` | 默认泛型是 `ThreadMessage`                                                         |

运行时也印证了这一点（`external-store-thread-runtime-core.ts:356`）：

```ts
messages = !store.convertMessage
  ? store.messages                              // 直接当 ThreadMessage[] 用
  : this._converter.convertMessages(store.messages, (cache, m, idx) => { ... });
```

**我们的建议：统一用 `useExternalStoreRuntime<ThreadMessageLike>({ ..., convertMessage })`，显式提供 `convertMessage`。**

### 1.3 全部 props 逐个说明（0.15.21 真实签名）

```ts
type ExternalStoreAdapterBase<T> = {
  isDisabled?: boolean | undefined
  isSendDisabled?: boolean | undefined
  isRunning?: boolean | undefined
  isLoading?: boolean | undefined
  messages?: readonly T[]
  messageRepository?: ExportedMessageRepository
  unstable_messageRepositoryInstance?: MessageRepository | undefined
  suggestions?: readonly ThreadSuggestion[] | undefined
  state?: ReadonlyJSONValue | undefined
  extras?: unknown

  setMessages?: ((messages: readonly T[]) => void) | undefined
  onVoiceTranscript?: ((message: ThreadMessage) => void) | undefined
  unstable_onBranchChange?: ((event: ExternalStoreBranchChange) => void) | undefined
  onImport?: ((messages: readonly ThreadMessage[]) => void) | undefined
  onExportExternalState?: (() => any) | undefined
  onLoadExternalState?: ((state: any) => void) | undefined

  onNew: (message: AppendMessage) => Promise<void> // * 唯一真正必需
  queue?: ExternalThreadQueueAdapter | undefined
  onEdit?: ((message: AppendMessage) => Promise<void>) | undefined
  onDelete?: ((messageId: string) => Promise<void> | void) | undefined
  onReload?: ((parentId: string | null, config: StartRunConfig) => Promise<void>) | undefined
  onResume?: ((config: ResumeRunConfig) => Promise<void>) | undefined
  onCancel?: (() => Promise<void>) | undefined
  onRefetchThread?: (() => Promise<void>) | undefined

  onAddToolResult?: ((options: AddToolResultOptions) => Promise<void> | void) | undefined
  onResumeToolCall?: ((options: { toolCallId: string; payload: unknown }) => void) | undefined
  onRespondToToolApproval?:
    ((options: RespondToToolApprovalOptions) => Promise<void> | void) | undefined

  convertMessage?: ExternalStoreMessageConverter<T> | undefined
  adapters?:
    | {
        attachments?: AttachmentAdapter | undefined
        speech?: SpeechSynthesisAdapter | undefined
        dictation?: DictationAdapter | undefined
        voice?: RealtimeVoiceAdapter | undefined
        feedback?: FeedbackAdapter | undefined
        threadList?: ExternalStoreThreadListAdapter | undefined // @deprecated（写着 under active development）
      }
    | undefined

  unstable_capabilities?: { copy?: boolean | undefined } | undefined
  unstable_enableToolInvocations?: boolean | undefined
  unstable_isClientToolCall?: ((toolCall: ToolCallMessagePart) => boolean) | undefined
  setToolStatuses?: ((statuses: Record<string, ToolExecutionStatus>) => void) | undefined
}
```

#### 必填 / 选填总表

| prop                      | 必填？                            | 作用                                           | 不提供时                                                                                                 |
| ------------------------- | --------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `onNew`                   | **必填（TS 强制）**               | 用户发出新消息                                 | 编译不过                                                                                                 |
| `messages`                | 二者至少一个                      | 你 store 里的消息数组                          | 两个都没有 → **运行时报错** `ExternalStoreAdapter must provide either 'messages' or 'messageRepository'` |
| `messageRepository`       | 二者至少一个                      | 带分支树的仓库（`ExportedMessageRepository`）  | —                                                                                                        |
| `convertMessage`          | **泛型非 `ThreadMessage` 时必填** | `你的消息类型 → ThreadMessageLike`             | —                                                                                                        |
| `isRunning`               | 选填                              | 直接驱动 `thread.isRunning`                    | 回退到「最后一条消息的 status 启发式」                                                                   |
| `isLoading`               | 选填                              | 初始历史加载中（影响语音 transcript 投递时机） | `false`                                                                                                  |
| `setMessages`             | 选填                              | 分支切换 / 删除 / cancel 回滚落地              | 分支切换与删除按钮消失                                                                                   |
| `onEdit`                  | 选填                              | 编辑按钮                                       | 编辑 UI 不出现，调用会抛 `Runtime does not support editing messages.`                                    |
| `onReload`                | 选填                              | 重新生成按钮                                   | `capabilities.reload === false`                                                                          |
| `onCancel`                | 选填                              | 生成中「停止」按钮                             | `capabilities.cancel === false`                                                                          |
| `onDelete`                | 选填                              | 删除消息（走宿主，可拒绝）                     | 回退到 `setMessages` 本地删除                                                                            |
| `onResume`                | 选填                              | 断线续传 run                                   | —                                                                                                        |
| `onRefetchThread`         | 选填                              | `threads.reloadMainThread()`                   | 无                                                                                                       |
| `onAddToolResult`         | 选填                              | 客户端工具结果回传宿主                         | 工具结果无法回传                                                                                         |
| `onRespondToToolApproval` | 选填                              | **审批闸门作答**                               | `respondToApproval` 不可用                                                                               |
| `onResumeToolCall`        | 选填                              | 人工输入（interrupt）后继续                    | —                                                                                                        |
| `adapters.*`              | 全部选填                          | 见 §1.4                                        | 对应能力关闭                                                                                             |
| `queue`                   | 选填                              | 运行时期间排队发消息                           | 运行时发送被禁用                                                                                         |
| `suggestions`             | 选填                              | 建议气泡                                       | 无                                                                                                       |

> **能力开关是「回调即能力」模型。** `external-store-thread-runtime-core.ts:275` 起：
>
> ```ts
> const newCapabilities = {
>   edit: this._store.onEdit !== undefined,
>   reload: this._store.onReload !== undefined,
>   cancel: this._store.onCancel !== undefined,
>   ...
>   attachments: !!this._store.adapters?.attachments,
>   feedback: !!this._store.adapters?.feedback,
>   queue: this._store.queue !== undefined,
> };
> ```
>
> 这就是「为什么我的编辑/重新生成按钮不显示」的标准答案。

### 1.4 `adapters` 的四个子适配器真实签名

`packages/core/src/adapters/attachment.ts`

```ts
export type AttachmentAdapter = {
  accept: string
  add(state: { file: File }): Promise<PendingAttachment> | AsyncGenerator<PendingAttachment, void>
  remove(attachment: Attachment): Promise<void>
  send(
    attachment: PendingAttachment,
    options?: { signal?: AbortSignal },
  ): Promise<CompleteAttachment>
}
// 上游自带：SimpleImageAttachmentAdapter / SimpleTextAttachmentAdapter /
//           CompositeAttachmentAdapter / fileMatchesAccept
```

`packages/core/src/adapters/feedback.ts`

```ts
export type FeedbackAdapter = {
  submit: (feedback: {
    message: ThreadMessage
    type: 'positive' | 'negative'
    comment?: string
  }) => void
}
```

`packages/core/src/adapters/speech.ts`

```ts
export type SpeechSynthesisAdapter = {
  speak: (text: string) => SpeechSynthesisAdapter.Utterance
}
export type DictationAdapter = {
  listen: () => DictationAdapter.Session
  disableInputDuringDictation?: boolean
}
// 上游自带 WebSpeechSynthesisAdapter
```

`packages/core/src/adapters/voice.ts` → `RealtimeVoiceAdapter`（实时语音，本仓库用不上）。

### 1.5 注意 `adapters.history` 已经不存在了

0.15.21 的 `adapters` 只有 `attachments / speech / dictation / voice / feedback / threadList`。
**`history` 在旧版（0.8 时代 `useExternalHistory` / `adapters.history`）有，现在已移除**：

- `packages/core/src` 与 `packages/react/src` 全仓库 grep `useExternalHistory` → **零命中**。
- 历史加载现在由你自己在 `messages` / `messageRepository` 里给（你们本来就是自管 store，正好）。
- 线程列表用 `adapters.threadList`（`ExternalStoreThreadListAdapter`），标注 `@deprecated`，属于「开发中可能随时变」。

### 1.6 相对 0.8 / 0.11 的变动汇总（我们关心的）

| 项                                                                                 | 0.8 → 0.15.21 状态                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 源码路径                                                                           | `packages/react/src/runtimes/external-store` → `packages/core/src/runtimes/external-store`（react 侧只剩 re-export 桩）                                                                                                            |
| `adapters.history`                                                                 | **已移除**                                                                                                                                                                                                                         |
| `adapters.feedback`                                                                | 保留，且可通过 `<RuntimeAdapterProvider adapters={{ feedback }}>` 从 context 注入（hook 会自动合并，`useExternalStoreRuntime.ts:15-21`）                                                                                           |
| `onReload` 签名                                                                    | 仍是 `(parentId: string \| null, config: StartRunConfig)`，源码里那行 `// TODO: remove parentId in 0.12.0` 是**过时注释**，0.15.21 **没有移除**，第一个参数还在                                                                    |
| `isSendDisabled`                                                                   | **新增**（与 `isDisabled` 并存）                                                                                                                                                                                                   |
| `metadata.isOptimistic`                                                            | **新增**（乐观消息：只在当前 head 分支、`export()` 不落盘）                                                                                                                                                                        |
| `unstable_enableToolInvocations` / `unstable_isClientToolCall` / `setToolStatuses` | **新增**（内建客户端工具调用管线，默认 `false`）                                                                                                                                                                                   |
| `onRespondToToolApproval` / `part.approval`                                        | **新增**（服务端审批闸门）                                                                                                                                                                                                         |
| `queue` + `createMessageQueue`                                                     | **新增**（运行时排队）                                                                                                                                                                                                             |
| `isRunning`                                                                        | 语义明确为「直接覆盖 `thread.isRunning`」，不再只是启发式                                                                                                                                                                          |
| UI 层渲染机制                                                                      | 底层换成 `@assistant-ui/store` + `useAuiState` selector 订阅；primitive 结构基本保持，但 **`ThreadConfigProvider` 已被移除**（只在 `packages/cli/src/codemods/v0-8/ui-package-split.ts` 里作为「被搬走的符号」出现，全仓库无实现） |
| `MessagePrimitive.Unstable_PartsGrouped`                                           | 仍存在但**已 `@deprecated`**，推荐用 `MessagePrimitive.GroupedParts`                                                                                                                                                               |

> **`ThreadConfigProvider` 不存在了。** 配置通过 `AssistantRuntimeProvider` 的 `aui` / `config` prop，或直接 `useAui()` / `useAuiState()` / `useAuiEvent()`。见 §4。
> **`useThreadRuntime` 也已经被彻底移除** —— 全仓库（`packages/**`）grep 零命中，`@assistant-ui/react` 的 `index.ts` 无导出。别再照旧资料写 `const runtime = useThreadRuntime()`。

---

## 2. 我们的消息形状该塞进哪里

### 2.1 `ThreadMessageLike` 完整定义

`packages/core/src/runtime/utils/thread-message-like.ts:41-102`

```ts
export type ThreadMessageLike = {
  readonly role: 'assistant' | 'user' | 'system'
  readonly content:
    | string
    | readonly (
        | TextMessagePart
        | ReasoningMessagePart
        | SourceMessagePart
        | ImageMessagePart
        | FileMessagePart
        | DataMessagePart
        | GenerativeUIMessagePart
        | Unstable_AudioMessagePart
        | DataPrefixedPart // { type: `data-${string}`, data: any }
        | {
            readonly type: 'tool-call'
            readonly toolCallId?: string
            readonly toolName: string
            readonly args?: ReadonlyJSONObject
            readonly argsText?: string
            readonly artifact?: any
            readonly result?: any | undefined
            readonly isError?: boolean | undefined
            readonly isPreliminary?: boolean | undefined
            readonly parentId?: string | undefined
            readonly messages?: readonly ThreadMessage[] | undefined
            readonly interrupt?: { type: 'human'; payload: unknown }
            readonly timing?: ToolCallTiming
            readonly mcp?: ToolCallMessagePartMcpMetadata
            readonly providerMetadata?: PartProviderMetadata
            readonly approval?: NonNullable<ToolCallMessagePart['approval']>
          }
      )[]
  readonly id?: string | undefined
  readonly createdAt?: Date | undefined
  readonly status?: MessageStatus | undefined
  readonly attachments?:
    | readonly (Omit<CompleteAttachment, 'content'> & {
        readonly content: readonly (ThreadUserMessagePart | DataPrefixedPart)[]
      })[]
    | undefined
  readonly metadata?:
    | {
        readonly unstable_state?: ReadonlyJSONValue | undefined
        readonly unstable_annotations?: readonly ReadonlyJSONValue[] | undefined
        readonly unstable_data?: readonly ReadonlyJSONValue[] | undefined
        readonly steps?: readonly ThreadStep[] | undefined
        readonly timing?: MessageTiming | undefined
        readonly submittedFeedback?: { type: 'positive' | 'negative'; comment?: string } | undefined
        readonly isOptimistic?: boolean | undefined
        readonly modality?: MessageModality | undefined
        readonly custom?: Record<string, unknown> | undefined
      }
    | undefined
}
```

### 2.2 content 支持哪些 part —— 按 role 区分（**这是硬约束**）

`fromThreadMessageLike` 会**抛异常**（不是静默忽略）如果角色和 part 类型不匹配：

**assistant** 允许（`thread-message-like.ts:155-236`）：
`text` / `reasoning` / `file` / `source` / `image` / `data` / `generative-ui` / `tool-call` / `` `data-${string}` ``
→ 其它类型抛 `Unsupported assistant message part type: ${type}`

**user** 允许（`:238-277`）：
`text` / `image` / `audio` / `file` / `data` / `` `data-${string}` ``
→ 其它抛 `Unsupported user message part type: ${type}`

**system**（`:279-292`）：**必须恰好一个 `text` part**，否则抛
`System messages must have exactly one text message part.`

其它硬校验：

```ts
if (role !== 'user' && attachments?.length)
  throw new Error('attachments are only supported for user messages')
if (role !== 'assistant' && status)
  throw new Error('status is only supported for assistant messages')
if (role !== 'assistant' && metadata?.steps)
  throw new Error('metadata.steps is only supported for assistant messages')
```

清洗规则（会影响你们的渲染，注意）：

- **空 text 被静默丢弃**：`if (!part.text?.trim()) return null;`
- **空 reasoning 被丢弃**：`if (!part.text?.trim() && !part.unstable_summary?.trim()) return null;`
- **非法 image 被丢弃并 `console.warn("Invalid image data format detected")`**：`image` 必须是 `data:image/*` 或 `https://` 或 `blob:` 开头，否则 `null`。
- `tool-call` 没给 `toolCallId` → 自动生成 `tool-${generateId()}`（**我们一定要自己给稳定 id**，否则流式更新时 id 抖动会导致重挂载）。
- `tool-call` 没给 `args` → `args` 由 `parsePartialJsonObject(argsText)` 解析，`argsText` 为空则 `{}`。

### 2.3 `status` 怎么用

`packages/core/src/types/message.ts:374-396`

```ts
export type MessageStatus =
  | { readonly type: 'running' }
  | { readonly type: 'requires-action'; readonly reason: 'tool-calls' | 'interrupt' }
  | { readonly type: 'complete'; readonly reason: 'stop' | 'unknown' }
  | {
      readonly type: 'incomplete'
      readonly reason: 'cancelled' | 'tool-calls' | 'length' | 'content-filter' | 'other' | 'error'
      readonly error?: ReadonlyJSONValue
    }
```

**关键：`status` 你不用自己填也能跑。** 不填时运行时按内容自动推导（`packages/core/src/runtime/utils/auto-status.ts`）：

```ts
export const getContentAutoStatus = (content, isLast, isRunning): MessageStatus =>
  getAutoStatus(
    isLast,
    isRunning,
    // 有 interrupt / pending approval 的 tool-call
    typeof content !== 'string' && content.some(isInterruptedToolCall),
    // 有 result === undefined 的 tool-call
    typeof content !== 'string' && content.some(isPendingToolCall),
    undefined,
    undefined,
    // 有「子会话还在流式」的后台工具调用
    typeof content !== 'string' && content.some(isBackgroundToolCall),
  )

export const getAutoStatus = (
  isLast,
  isRunning,
  hasInterruptedToolCalls,
  hasPendingToolCalls,
  error?,
  isCancelled?,
  hasBackgroundToolCalls?,
) => {
  if (isLast && error !== undefined && error !== null)
    return { type: 'incomplete', reason: 'error', error }
  return isLast && isRunning
    ? { type: 'running' }
    : hasInterruptedToolCalls
      ? { type: 'requires-action', reason: 'interrupt' }
      : hasBackgroundToolCalls && !isCancelled
        ? { type: 'running' }
        : hasPendingToolCalls
          ? { type: 'requires-action', reason: 'tool-calls' }
          : isCancelled
            ? { type: 'incomplete', reason: 'cancelled' }
            : { type: 'complete', reason: 'unknown' }
}
```

**实操规则（重要）：**

1. **自动推导的 status 带一个隐藏 Symbol 标记**（`isAutoStatus`）。一旦你显式给了 `status`，运行时就**不再**随内容更新它（`external-store-thread-runtime-core.ts:364-380` 检查 `isAutoStatus(cache.status)`）。
   → **推荐：除非要表达 `cancelled` / `error` / `length` 这类信息，否则 assistant 消息不要写 `status`，让它自动推。**
2. **`type: "requires-action"` 的推导靠「`tool-call` 有 `result === undefined`」**。
   所以你们那串「步骤/工具调用」：
   - 工具**还在跑** → 不填 `result` → 自动 `requires-action`（前端 UX 上会被当作「等用户/等外部」）。
   - 工具**跑完了** → 填 `result`（哪怕是 `null`）→ 才会变成 `complete`。
     → **坑：`result: undefined` 和「没有 result 字段」等价，都算 pending。要表示「完成但无输出」，用 `result: null`。**
3. **「审批」用 `approval` 字段而不是自己造 part**（见 §2.5）。
4. `isRunning` 的影响：`isLast && isRunning` → 该消息 `running`。所以流式期间把 `isRunning: true` 传进去。
5. **`isRunning: true` 且最后一条不是 assistant 时，运行时会自动插一条空的 optimistic assistant 消息**：
   ```ts
   // external-store-thread-runtime-core.ts:72
   export const hasUpcomingMessage = (isRunning, messages) =>
     isRunning && messages[messages.length - 1]?.role !== 'assistant'
   ```
   即：用户发完消息、你 `setIsRunning(true)`，界面上立刻出现「thinking…」气泡，不用你自己塞占位消息。

### 2.4 `metadata` / `custom` 能带什么

| 字段                                     | 类型                                                                             | 用途                                                                                                               |
| ---------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `custom`                                 | `Record<string, unknown>`                                                        | **我们自己的任意数据，唯一合法的「私货」出口**                                                                     |
| `steps`                                  | `readonly ThreadStep[]`（`{ messageId?, usage?: {inputTokens, outputTokens} }`） | 仅 assistant；`fromThreadMessageLike` 里带 `messageId?`/`usage?`，**没有 **`index`/`type` 等字段，不是「步骤列表」 |
| `unstable_state`                         | `ReadonlyJSONValue`                                                              | 运行时状态快照（assistant only，默认 `null`）                                                                      |
| `unstable_annotations` / `unstable_data` | `ReadonlyJSONValue[]`                                                            | 默认 `[]`                                                                                                          |
| `timing`                                 | `MessageTiming`                                                                  | 首 token、tokens/s 等（我们有的话直接塞）                                                                          |
| `submittedFeedback`                      | `{type, comment?}`                                                               | 点赞/点踩                                                                                                          |
| `isOptimistic`                           | `boolean`                                                                        | 乐观消息，不落盘、离开 head 即被回收                                                                               |
| `modality`                               | `"voice"`                                                                        | 语音消息标记；带这个的消息在 `joinStrategy` 下不会被合并                                                           |

> **`metadata.custom` 是我们「出处 / 审批状态 / 步骤序号」等自有数据的正确落点**。
> 但注意 `custom` 只到 `Record<string, unknown>`，**不会被 UI 自动渲染**，要靠 `useAuiState((s) => s.message.metadata.custom)` 自己取。

**「出处 / 引用」有原生 part**：`SourceMessagePart`

```ts
export type SourceMessagePart =
  | {
      type: 'source'
      sourceType: 'url'
      id: string
      url: string
      title?: string
      providerMetadata?
      parentId?
    }
  | {
      type: 'source'
      sourceType: 'document'
      id: string
      url?: undefined
      title: string
      mediaType: string
      filename?
      providerMetadata?
      parentId?
    }
```

**这就是「出处」的第一选择**，直接用 `sourceType: "url"` 或 `"document"`，比塞 `custom` 好（能白嫖 `MessagePrimitive.Parts` 的 `Source` 槽位）。渲染路径见 §3.4。
唯一限制：`SourceMessagePart` 属于 **assistant 专用**（user 消息里会抛 `Unsupported user message part type: source`）。

### 2.5 「审批」的原生形状：`tool-call.approval`

`packages/core/src/types/message.ts:269-298`

```ts
readonly approval?: {
  readonly id: string;
  readonly prompt?: string;                   // 要问用户的问题本身
  readonly display?: ToolApprovalDisplay;     // "decision" | "select" | "text"（缺省 "decision"）
  readonly allowFreeform?: boolean;           // 是否接受自由文本
  readonly dismissible?: boolean;             // 是否允许「关掉不作答」
  readonly approved?: boolean;
  readonly reason?: string;
  readonly isAutomatic?: boolean;
  readonly options?: readonly ToolApprovalOption[];
  readonly optionId?: string;
  readonly text?: string;
  /** 终态非决策：宿主标记为取消/过期 */
  readonly resolution?: "cancelled" | "expired";
};

export type ToolApprovalOption = {
  readonly id: string;
  readonly kind: ToolApprovalOptionKind | (string & {});  // "allow-once" | "allow-always" | "reject-once" | "reject-always" 或 `_` 前缀自定义
  readonly label?: string;
  readonly description?: string;
  readonly grants?: readonly string[];
  readonly confirm?: boolean | { title?: string; description?: string };
};

export type ToolApprovalResponse =
  | { readonly approved: boolean; readonly text?: string; readonly reason?: string }
  | { readonly optionId: string; readonly text?: string; readonly reason?: string }
  | { readonly approved: boolean; readonly optionId: string; readonly text?: string; readonly reason?: string }
  | { readonly text: string; readonly reason?: string };
```

作答路径（`ToolCallMessagePartProps`）：

```ts
respondToApproval: (response: ToolApprovalResponse) => Promise<void>
```

→ 落到你的 `onRespondToToolApproval`：

```ts
onRespondToToolApproval?: (options: RespondToToolApprovalOptions) => Promise<void> | void;

export type RespondToToolApprovalOptions = {
  approvalId: string;
  approved: boolean;
  optionId?: string;
  text?: string;
  reason?: string;
};
```

**`approval` 会让消息自动进入 `requires-action`（`reason: "interrupt"`）**，所以「审批中的这一轮」状态是现成的：

```ts
// auto-status.ts
export const isInterruptedToolCall = (c) => c.type === 'tool-call' && hasPendingToolAction(c)
```

**另外还有第二个「要人类输入」的缝：`interrupt`**

```ts
readonly interrupt?: { type: "human"; payload: unknown };
// 作答：onResumeToolCall({ toolCallId, payload })
```

- 要**结构化决策 + 选项** → 用 `approval`。
- 要**给工具回一个任意 payload** → 用 `interrupt`。
  上游注释明确：`options` 表达不了的答案「留在 `interrupt` 缝里」。

### 2.6 我们「一轮 = 1 个 assistant 消息 + 步骤 + 出处 + 审批」的推荐形状

```ts
const ourAssistantMessage: ThreadMessageLike = {
  role: 'assistant',
  id: round.id, // * 必须稳定，否则流式抖动重挂载
  createdAt: round.createdAt,
  // status 不写：交给自动推导（running / requires-action / complete / incomplete 全自动）
  metadata: {
    custom: {
      roundId: round.id,
      stepIndex: round.currentStep,
      // 我们自己的步骤/审批扩展数据
    },
    ...(round.usage ? { steps: [{ usage: { inputTokens, outputTokens } }] } : {}),
    ...(round.timing ? { timing: round.timing } : {}),
  },
  content: [
    // 1) 推理（如果显示 CoT）
    ...(round.reasoning ? [{ type: 'reasoning' as const, text: round.reasoning }] : []),

    // 2) 正文
    ...(round.text ? [{ type: 'text' as const, text: round.text }] : []),

    // 3) 出处：用原生 source part（仅 assistant 可用）
    ...round.sources.map((s, i): ThreadMessageLike['content'][number] => ({
      type: 'source',
      sourceType: 'url',
      id: s.id ?? `src-${i}`,
      url: s.url,
      title: s.title,
    })),

    // 4) 一串工具调用 / 步骤：同一批给同一个 parentId → 可被 GroupedParts 合并成一行
    ...round.toolCalls.map((t) => ({
      type: 'tool-call' as const,
      toolCallId: t.id, // * 必须稳定
      toolName: t.name,
      args: t.args,
      argsText: t.argsText ?? JSON.stringify(t.args),
      // 完成才给 result；result: null 表示「完成但无输出」
      ...(t.status === 'done' ? { result: t.result ?? null } : {}),
      ...(t.status === 'error' ? { result: t.error, isError: true } : {}),
      parentId: round.stepGroupId, // * 同批工具调用共用 parentId
      // 5) 审批：替代自造 part
      ...(t.approval
        ? {
            approval: {
              id: t.approval.id,
              prompt: t.approval.prompt,
              display: 'decision' as const,
              options: [
                { id: 'allow-once', kind: 'allow-once' },
                { id: 'reject-once', kind: 'reject-once' },
              ],
            },
            interrupt: { type: 'human' as const, payload: t.approval },
          }
        : {}),
    })),
  ],
}
```

**能不能表达「一步 = 多个 tool-call + 中间文本 + 子步骤」？**
可以，但**有顺序约束**：`content` 是**有序扁平数组**，没有嵌套。表达层级只能靠：

- `parentId`（part 级，用于**相邻分组**渲染，见 §3.3）
- `tool-call.messages`（**工具调用可以嵌套完整子会话**：`readonly messages?: readonly ThreadMessage[]`）—— 子 agent / 子步骤的正规出口。

**表达不了的**：单条消息里「非线性/树状」的步骤拓扑。`content` 是数组不是树。真需要树，得用 `tool-call.messages` 递归下钻，或者拆成多条消息（但那样会破坏「一轮 = 一条 assistant 消息」）。

---

## 3. 工具调用怎么渲染

### 3.1 `ToolCallMessagePart` 字段（完整）

`packages/core/src/types/message.ts:232-306`

```ts
export type ToolCallMessagePart<TArgs = ReadonlyJSONObject, TResult = unknown> = {
  readonly type: 'tool-call'
  readonly toolCallId: string
  readonly toolName: string
  readonly args: TArgs // 流式中是**部分解析**结果，字段可能缺
  readonly result?: TResult | undefined
  readonly isError?: boolean | undefined
  readonly isPreliminary?: boolean | undefined // result 是中间值、工具仍在跑
  readonly argsText: string // 模型原始 JSON 文本
  readonly artifact?: unknown
  readonly timing?: ToolCallTiming
  readonly mcp?: ToolCallMessagePartMcpMetadata
  readonly providerMetadata?: PartProviderMetadata
  readonly modelContent?: readonly ToolModelContentPart[] | undefined
  readonly interrupt?: { type: 'human'; payload: unknown }
  readonly approval?: {/* 见 §2.5 */}
  readonly parentId?: string
  readonly messages?: readonly ThreadMessage[] // 嵌套子会话
}
```

**渲染时组件实际拿到的 props**（`packages/core/src/react/types/MessagePartComponentTypes.ts`）：

```ts
export type ToolCallMessagePartProps<TArgs = any, TResult = unknown> = MessagePartState & // ← 额外带 status / messageId / index 等
  ToolCallMessagePart<TArgs, TResult> & {
    addResult: (result: TResult | ToolResponse<TResult>) => void
    resume: (payload: unknown) => void
    respondToApproval: (response: ToolApprovalResponse) => Promise<void>
  }

export type ToolCallMessagePartComponent<TArgs = any, TResult = any> = ComponentType<
  ToolCallMessagePartProps<TArgs, TResult>
>
```

三个注入方法的语义（源码注释原文）：

- `addResult` — 「当 **renderer** 而不是 tool 的 `execute` 才是 result 来源时用」。
- `resume` — 「提供 `context.human(...)` 请求的 payload，恢复暂停的前端工具执行」。
- `respondToApproval` — 「只在 `approval` 存在、`approval.approved === undefined`、且没有 `approval.resolution` 时有效。**await 之后才 resolve**，失败会 reject，所以按钮可以保持可重试」。

### 3.2 `ToolFallback` 的真实位置 注意

**`ToolFallback` 不在 `@assistant-ui/react` 里。** 全仓库 grep 结果：

- 真身：`packages/ui/src/components/react/assistant-ui/elements/tool-fallback.aui.tsx`
- 是 `@assistant-ui/ui`（private，**copy-into-project 的 shadcn 风格组件**，靠 CLI 装进你的仓库，不是 npm 依赖）
- 依赖 `@/components/ui/collapsible`、`@/components/ui/button`、`@/components/ui/textarea`、`lucide-react`
- `@assistant-ui/react` 的 `index.ts` 里 **没有** `ToolFallback` 导出

```tsx
// tool-fallback.aui.tsx 的对外形态（节选）
import { toolApprovalAcceptsText, useAuiState, useScrollLock, useToolCallElapsed,
         type ToolCallMessagePart, type ToolCallMessagePartProps,
         type ToolCallMessagePartComponent, type ToolApprovalOption } from "@assistant-ui/react";

export const ToolFallback: ToolCallMessagePartComponent = (...) => { ... }
// 内部用 <Collapsible> 折叠，头部带
//   LoaderIcon（running）/ CheckIcon（complete）/ XCircleIcon（error）/ AlertCircleIcon（approval）
```

**实操建议：别依赖 `ToolFallback`。** 我们本来就要自定义渲染（合并成一行、步骤条），直接写自己的 `ToolCallMessagePartComponent` 即可。**但要照抄它的状态分支**：

```tsx
const MyToolCall: ToolCallMessagePartComponent = ({ toolName, args, argsText, result, isError, status, approval, respondToApproval }) => {
  const running = status?.type === "running";
  const requiresAction = status?.type === "requires-action";
  ...
};
```

### 3.3 「同一批调用合并成一行」—— 正确挂法：`MessagePrimitive.GroupedParts`

0.15.21 里有两套，选新的那套：

| API                                                       | 状态                         | 适用                                           |
| --------------------------------------------------------- | ---------------------------- | ---------------------------------------------- |
| `MessagePrimitive.Parts` + `components.tools[.ToolGroup]` | `ToolGroup` 已 `@deprecated` | 简单场景                                       |
| `MessagePrimitive.GroupedParts` + `groupBy`               | **推荐**（相邻合并）         | 我们要的「同批合并成一行」                     |
| `MessagePrimitive.Unstable_PartsGrouped`                  | 已 `@deprecated`             | 仅「非相邻聚类」（跨位置收集同一 key 的 part） |

`packages/core/src/react/primitives/message/MessageGroupedParts.tsx`

```ts
export namespace MessagePrimitiveGroupedParts {
  export type Props<TKey extends `group-${string}` = `group-${string}`> = {
    /** 每个 part → 分组 key 路径。相邻 part 共享前缀则合并。返回 [] / null 表示不分组。 */
    readonly groupBy: (part: PartState, context: GroupByContext) => readonly TKey[] | null
    /** 尾部 loading 指示器的发射时机。@default "no-text" */
    readonly indicator?: IndicatorMode // "never" | "empty" | "no-text" | "always"
    readonly children: (info: RenderInfo<TKey>) => ReactNode
  }

  export type RenderInfo<TKey extends `group-${string}`> = {
    readonly part: GroupPart<TKey> | EnrichedPartState | IndicatorPart
    readonly children: ReactNode
  }

  /** 合并组：走和叶子 part **同一个** `{ part }` 通道，用 `switch (part.type)` 分发。 */
  export type GroupPart<TKey extends `group-${string}` = `group-${string}`> = {
    readonly type: TKey // 形如 "group-tool"
    readonly status: MessagePartStatus | ToolCallMessagePartStatus
    readonly counts: {
      running: number
      complete: number
      incomplete: number
      requiresAction: number
    }
    readonly indices: readonly number[]
  }

  /** 合成尾槽：只在消息 running 时出现，用 `case "indicator"` 渲染 loading 点 */
  export type IndicatorPart = { readonly type: 'indicator' }
}
```

`GroupedParts` 的 `children` 渲染契约（源码注释原文）：

> 「`part.type` 要么是 `"group-…"` 字面量（此时 `children` 是递归渲染好的子树），要么是真实 part 类型（叶子，`children` 是**会抛异常的哨兵** —— 所以只有 group 分支才允许渲染 `children`）。叶子返回 `null` 会渲染它**注册的** UI；返回空 fragment 是显式压制注册 UI。」

**推荐写法：用 `groupPartByType` 拿到免费 memo（关键性能点）**

`packages/core/src/react/utils/groupParts.ts`

```ts
export const groupPartByType = <TKey extends `group-${string}`>(
  map: Partial<Readonly<Record<
    PartState["type"] | "standalone-tool-call" | `tool-call:${string}`,
    readonly TKey[]
  >>>,
) => ((part: PartState, context?: GroupByContext) => readonly TKey[]);
```

支持的 key：

- 真实 part 类型：`"text"` / `"reasoning"` / `"tool-call"` / `"source"` / …
- `"tool-call:${name}"` —— 按工具名匹配，**优先级高于** `"tool-call"`
- `"standalone-tool-call"` —— MCP app 调用 + 注册时 `standalone: true` 的工具（human 工具、内建 generative-UI 工具），**优先级最高**

它会给返回的函数挂一个 `GROUPBY_MEMO_KEY` 指纹，`GroupedParts` 据此在 `[parts, memoKey]` 上 memo 分组树 —— **即使你在 render 里每次重新调用 `groupPartByType(...)`，树也不会重算**。

**我们「同批合并成一行」的完整写法：**

```tsx
import { MessagePrimitive, groupPartByType } from '@assistant-ui/react'

const AssistantMessage = () => (
  <MessagePrimitive.Root>
    <MessagePrimitive.GroupedParts
      // 相邻的 tool-call 合并进 "group-tools"；reasoning 单独合并
      groupBy={groupPartByType({
        reasoning: ['group-thought'],
        'tool-call': ['group-tools'],
        // 需要单独展示的工具（比如审批类）赶出分组：
        // "tool-call:request_approval": [],
      })}
      indicator="no-text"
    >
      {({ part, children }) => {
        switch (part.type) {
          case 'group-tools':
            // * 这就是「同一批调用合并成一行」
            //   part.indices.length = 本组几个调用
            //   part.counts = { running, complete, incomplete, requiresAction }
            return <ToolStackRow counts={part.counts}>{children}</ToolStackRow>

          case 'group-thought':
            return <ReasoningBlock>{children}</ReasoningBlock>

          case 'tool-call':
            // 叶子 tool-call。返回 null → 渲染注册过的 toolUI（tools.by_name / Fallback）
            return <MyToolCall {...part} />

          case 'source':
            return <SourceChip {...part} />

          case 'text':
            return <MarkdownText {...part} />

          case 'indicator':
            return <LoadingDots />

          default:
            return null // 叶子返回 null → 用注册 UI；返回 <></> → 显式压制
        }
      }}
    </MessagePrimitive.GroupedParts>
  </MessagePrimitive.Root>
)
```

**注意 `counts`/`status` 是给「一行」用的**：`GroupPart.status` 的语义是「组内任一 part 在跑 → `running`，否则镜像最后一个 part 的状态」。所以「一行显示：3 个调用，2 完成 1 运行中」直接用 `part.counts` 就有了，不用自己 reduce。

**另一条路：`parentId` 分组。**
我们给同一批 tool-call 塞同一个 `parentId`，然后：

```tsx
groupBy={(part) => {
  if (part.type !== "tool-call" || !part.parentId) return [];
  return [`group-batch-${part.parentId}`];   // 注意 key 必须以 "group-" 开头
}}
```

注意 **`groupBy` 返回的 key 必须以 `"group-"` 开头**，否则 renderer 的 `switch (part.type)` 无法把「组」和真实 part 类型区分开。

### 3.4 另一条路：`MessagePrimitive.Parts` 的 `components` 映射

如果不需要合并、只要「按工具名给不同组件」，用 `MessagePrimitive.Parts`：

`packages/core/src/react/primitives/message/MessageParts.tsx`

```ts
export namespace MessagePrimitiveParts {
  type BaseComponents = {
    Empty?: EmptyMessagePartComponent;
    Text?: TextMessagePartComponent;
    Source?: SourceMessagePartComponent;
    Image?: ImageMessagePartComponent;
    File?: FileMessagePartComponent;
    Unstable_Audio?: Unstable_AudioMessagePartComponent;   // @deprecated，改用 File + audio/* mime
    data?: { by_name?: Record<string, DataMessagePartComponent>; Fallback?: DataMessagePartComponent };
    Quote?: QuoteMessagePartComponent;
    generativeUI?: { components: GenerativeUIComponentRegistry; Fallback?: ComponentType<{component;props?}> };
  };

  type ToolsConfig =
    | { by_name?: Record<string, ToolCallMessagePartComponent>;   // ← 按工具名注册
        Fallback?: ComponentType<ToolCallMessagePartProps> }      // ← 兜底
    | { Override: ComponentType<ToolCallMessagePartProps> };      // ← 全部接管

  type StandardComponents = BaseComponents & {
    Reasoning?: ReasoningMessagePartComponent;
    tools?: ToolsConfig;
    ToolGroup?: ...;       // @deprecated → 用 GroupedParts
    ReasoningGroup?: ...;  // @deprecated → 用 GroupedParts
  };

  // 与 ChainOfThought 互斥
  type Props =
    | { components: StandardComponents }
    | ({ components: ChainOfThoughtComponents })
    | { children: (value: { part: EnrichedPartState }) => ReactNode };
}
```

**解析优先级（`MessageParts.tsx:426-442`，照抄自源码）：**

```tsx
if ("Override" in tools)
  return <tools.Override {...part} addResult={...} resume={...} respondToApproval={...} />;

const Tool =
  (tools.by_name && Object.hasOwn(tools.by_name, part.toolName)
    ? tools.by_name[part.toolName]
    : undefined) ?? tools.Fallback;

// 再交给 <ToolUIDisplay> —— 它会先查运行时注册表：
//   s.tools.toolUIs[props.toolName]?.[0]?.render ?? Fallback
return <ToolUIDisplay {...part} Fallback={Tool} addResult={...} resume={...} respondToApproval={...} />;
```

即 **`tools.by_name` → `tools.Fallback` → 运行时注册表（`useAssistantToolUI`）**，`Override` 则是短路全接管。

`EnrichedPartState`（用 `children` 渲染函数时拿到的东西，`MessageParts.tsx:710-725`）：

```ts
export type EnrichedPartState =
  | (Extract<PartState, { type: 'tool-call' }> & {
      readonly toolUI: ReactNode // 已注册的 toolUI 元素，没有则 null
      addResult: ToolCallMessagePartProps['addResult']
      resume: ToolCallMessagePartProps['resume']
      respondToApproval: ToolCallMessagePartProps['respondToApproval']
    })
  | (Extract<PartState, { type: 'data' }> & { readonly dataRendererUI: ReactNode })
  | Exclude<PartState, { type: 'tool-call' } | { type: 'data' }>
```

→ 用 `children` 时，`case "tool-call": return part.toolUI ?? <MyFallback {...part} />;` 是最省事的写法。

**另外：`MessagePartPrimitive.Messages`**（`part.messages` 的渲染出口）—— 渲染 `tool-call.messages` 里的嵌套子会话：

```ts
export { PartPrimitiveMessages as Messages } from '@assistant-ui/core/react'
```

---

## 4. 必须的 primitive 清单

### 4.1 唯一的强制项：`AssistantRuntimeProvider`

`packages/core/src/react/AssistantRuntimeProvider.tsx`

```tsx
export const AssistantRuntimeProvider = memo(
  ({
    runtime,
    aui,
    config,
    children,
  }: {
    runtime: AssistantRuntime // ← useExternalStoreRuntime 的返回值
    aui?: AssistantClient | null // 嵌套在另一个 assistant context 里时用
    config?: AuiConfig // 额外 scope
    children: ReactNode
  }) => (
    <AssistantProviderBase runtime={runtime} aui={aui ?? null} config={config}>
      {children}
    </AssistantProviderBase>
  ),
)
```

内部装上 `AuiProvider`，之后所有 primitive 和 `useAui` / `useAuiState` / `useAuiEvent` 才能用。

### 4.2 `ThreadConfigProvider` 与 `useThreadRuntime` —— **都已移除，不要找**

- **`ThreadConfigProvider`**：全仓库只有 `packages/cli/src/codemods/v0-8/ui-package-split.ts` 里把它列为「被移走的符号」，**没有任何实现**。
- **`useThreadRuntime`**：`grep -rn "useThreadRuntime" packages/` → **零命中**。已彻底删除，没有兼容层。

替代方案（0.15.21 一等公民）：

| 需求                           | 用什么                                                               |
| ------------------------------ | -------------------------------------------------------------------- |
| 读线程/消息状态                | `useAuiState((s) => s.thread.*)` / `useAuiState((s) => s.message.*)` |
| 拿命令式入口                   | `useAui()` → `aui.composer.send()` / `aui.thread.*` / `aui.part.*`   |
| 订阅事件                       | `useAuiEvent`（如 `aui.on("thread.runStart", ...)`）                 |
| 条件渲染                       | `<AuiIf condition={(s) => s.thread.isEmpty} />`                      |
| 会话级配置                     | `<AssistantRuntimeProvider config={AuiConfig}>`                      |
| 视图层横切关注点（如虚拟滚动） | context provider，例如 `ThreadPrimitive.ViewportProvider`            |

`AuiIf` 的真实签名（`packages/store/src/AuiIf.ts`）：

```ts
export namespace AuiIf {
  export type Props = PropsWithChildren<{
    /** Selector deciding whether `children` render. */
    condition: AuiIf.Condition
  }>
  /** Boolean selector over the assistant state. */
  export type Condition = (state: AssistantState) => boolean
}
export const AuiIf: FC<AuiIf.Props> = ({ children, condition }) => {
  const result = useAuiState(condition)
  return result ? children : null
}
```

`@assistant-ui/react` 的 `index.ts` 明确导出：`useAui`（:5）、`useAuiState`（:8）、`useAuiEvent`（:9）、`AuiIf`（:10）、`useAssistantToolUI`（:209）、`groupPartByType`（:335）。

### 4.3 各 Primitive 的真实导出面（`packages/react/src/primitives/*.ts`）

```ts
// thread.ts —— 全部 13 个
ThreadPrimitive.Root
ThreadPrimitive.Empty            // @deprecated → <AuiIf condition={(s) => s.thread.isEmpty} />
ThreadPrimitive.If               // @deprecated → <AuiIf condition={...} />；filters: empty | running | disabled
ThreadPrimitive.Viewport         // autoScroll / turnAnchor: "top"|"bottom" / topAnchorMessageClamp
ThreadPrimitive.ViewportProvider
ThreadPrimitive.ViewportFooter
ThreadPrimitive.Messages         // components={...}（@deprecated）或 children render fn
ThreadPrimitive.MessageByIndex
ThreadPrimitive.Unstable_MessageById   // 虚拟列表用，配 unstable_useThreadMessageIds
ThreadPrimitive.ScrollToBottom
ThreadPrimitive.Suggestion
ThreadPrimitive.Suggestions / SuggestionByIndex

// message.ts
MessagePrimitive.Root
MessagePrimitive.Parts           // 别名 MessagePrimitive.Content
MessagePrimitive.PartByIndex
MessagePrimitive.GroupedParts        // * 推荐的分组渲染
MessagePrimitive.Unstable_PartsGrouped / .Unstable_PartsGroupedByParentId   // @deprecated
MessagePrimitive.If              // filters: user|assistant|system|hasBranches|copied|lastOrHover|last|speaking|hasAttachments|hasContent|submittedFeedback
MessagePrimitive.Attachments / AttachmentByIndex
MessagePrimitive.Quote / Error
MessagePrimitive.GenerativeUI

// messagePart.ts
MessagePartPrimitive.Text / Image / InProgress / Messages

// composer.ts
ComposerPrimitive.Root           // <form>；props: compact?
ComposerPrimitive.Input
ComposerPrimitive.Send
ComposerPrimitive.Cancel
ComposerPrimitive.AddAttachment / Attachments / AttachmentByIndex / AttachmentDropzone
ComposerPrimitive.Dictate / StopDictation / DictationTranscript
ComposerPrimitive.If / Quote / QuoteText / QuoteDismiss / Queue
// 以下全部 Unstable_ 前缀
ComposerPrimitive.Unstable_TriggerPopover {.Directive | .Action}     // * slash / mention
ComposerPrimitive.Unstable_TriggerPopoverRoot / .Unstable_TriggerPopoverCategories
ComposerPrimitive.Unstable_TriggerPopoverCategoryItem / .Unstable_TriggerPopoverItems
ComposerPrimitive.Unstable_TriggerPopoverItem / .Unstable_TriggerPopoverBack
```

**最小可用骨架：**

```tsx
<AssistantRuntimeProvider runtime={runtime}>
  <ThreadPrimitive.Root>
    <ThreadPrimitive.Viewport turnAnchor="bottom">
      <ThreadPrimitive.Empty>说点什么…</ThreadPrimitive.Empty>

      <ThreadPrimitive.Messages>
        {() => (
          <MessagePrimitive.Root>
            <AssistantContent />
          </MessagePrimitive.Root>
        )}
      </ThreadPrimitive.Messages>

      <ThreadPrimitive.ScrollToBottom>↓</ThreadPrimitive.ScrollToBottom>
    </ThreadPrimitive.Viewport>

    <ComposerPrimitive.Root>
      <ComposerPrimitive.Input submitMode="enter" placeholder="输入…" />
      <ComposerPrimitive.Send>发送</ComposerPrimitive.Send>
      <ComposerPrimitive.Cancel>停止</ComposerPrimitive.Cancel>
    </ComposerPrimitive.Root>
  </ThreadPrimitive.Root>
</AssistantRuntimeProvider>
```

> **注意：`ThreadPrimitive.Messages` / `MessagePrimitive.Root` 没有「没有就渲染不出来」的强绑定**，但 `MessagePrimitive.Parts` 必须在 `MessagePrimitive.Root`（或至少 `MessageByIndexProvider`）之内 —— 它靠 scope 拿当前消息。

---

## 5. Composer：快捷键 / 禁用发送 / slash & mention 菜单

### 5.1 Enter 发送、Shift+Enter 换行 —— 原生支持，且可配置

`packages/react/src/primitives/composer/ComposerInput.tsx`

```ts
export namespace ComposerPrimitiveInput {
  type SubmitModeProps =
    | {
        /**
         * - "enter": 裸 Enter 发送（Shift+Enter 换行）   ← 默认
         * - "ctrlEnter": Ctrl/Cmd+Enter 发送（裸 Enter 换行）
         * - "none": 禁用键盘提交
         * @default "enter"
         */
        submitMode?: 'enter' | 'ctrlEnter' | 'none' | undefined
        submitOnEnter?: never
      }
    | {
        submitMode?: never
        /** @deprecated 用 submitMode 代替，未来版本移除 */
        submitOnEnter?: boolean | undefined
      }

  export type Props = TextareaAutosizeProps & BaseProps & SubmitModeProps
}
```

**我们想要的「Enter 发送 / Shift+Enter 换行」就是默认值，什么都不用配。**

真实按键逻辑（源码 `handleKeyPress`，逐条照抄）：

```ts
if (isDisabled) return
if (e.nativeEvent.isComposing) return // ① IME 合成中不处理（中文输入安全）

// ② 先让插件（mention / slash 菜单）处理
if (pluginRegistry) {
  for (const plugin of pluginRegistry.getPlugins()) {
    if (plugin.handleKeyDown(e)) return // 被消费就 return
  }
}

if (e.key === 'Enter') {
  const threadState = aui.thread.getState()
  const hasQueue = threadState.capabilities.queue

  // ③ Ctrl/Cmd+Shift+Enter = steer（需 queue 能力，且 submitMode !== "none" 且 canSend）
  if (
    e.shiftKey &&
    (e.ctrlKey || e.metaKey) &&
    hasQueue &&
    declaredSubmitMode !== 'none' &&
    aui.composer.getState().canSend
  ) {
    e.preventDefault()
    aui.composer.send({ steer: true })
    return
  }

  if (e.shiftKey) return // ④ Shift+Enter → 换行（不拦截）

  // ⑤ 运行中且无 queue、也非语音会话 → 不提交
  if (threadState.isRunning && !hasQueue && threadState.voice === undefined) return

  let shouldSubmit = false
  if (effectiveSubmitMode === 'ctrlEnter') shouldSubmit = e.ctrlKey || e.metaKey
  else if (effectiveSubmitMode === 'enter') shouldSubmit = true

  if (shouldSubmit) {
    e.preventDefault()
    textareaRef.current?.closest('form')?.requestSubmit() // ⑥ 走 form submit → ComposerPrimitive.Root
  }
}
```

**推论（重要）：`ComposerPrimitive.Input` 必须放在 `ComposerPrimitive.Root`（`<form>`）里**，否则第 ⑥ 步 `closest("form")` 找不到 form，Enter 什么都不发生。

其他相关 props：

| prop                                            | 默认    | 说明                                                                                     |
| ----------------------------------------------- | ------- | ---------------------------------------------------------------------------------------- |
| `cancelOnEscape`                                | `true`  | Escape 取消（仅当 `composer.canCancel`）；**先给插件处理**，所以菜单开着时 Escape 关菜单 |
| `unstable_focusOnRunStart`                      | `true`  | run 开始时自动聚焦                                                                       |
| `unstable_focusOnScrollToBottom`                | `true`  | 滚到底时聚焦                                                                             |
| `unstable_focusOnThreadSwitched`                | `true`  | 切线程时聚焦                                                                             |
| `unstable_insertNewlineOnTouchEnter`            | `false` | 触摸设备（`pointer: coarse`）上裸 Enter 换行                                             |
| `addAttachmentOnPaste`                          | `true`  | 粘贴文件自动加附件（需要 `thread.capabilities.attachments`）                             |
| `asChild` / `render` / `autoFocus` / `disabled` | —       | 标准                                                                                     |

IME 处理：`compositionRef` + `onCompositionStart/End` 双保险，且 `flushTapSync` 同步 value —— **中文输入不会误发送**，这点上游处理得比手写好。

### 5.2 禁用发送 —— 三层，别搞混

```ts
// external-store-adapter.ts
/**
 * 整条线程禁用：连输入框都禁用（不能打字、不能加附件、不能提交）。
 */
isDisabled?: boolean | undefined;

/**
 * 只禁「发送」：输入框仍可用，但 send() 变成 no-op，且 composer.canSend === false。
 * 编辑 composer（保存消息编辑）**故意忽略**这个标记。
 */
isSendDisabled?: boolean | undefined;
```

判定链：

```ts
// ComposerPrimitive.Input
const isDisabled = useComposerInputDisabled(disabledProp);   // = thread.isDisabled || dictation.inputDisabled || 自传的 disabled

// composer scope
readonly canSend: boolean;   // isEditing && 有内容 && （thread composer 时）!isSendDisabled && 语音会话允许

// 实际发送守卫（store/clients/external-thread.ts:1162-1164）
if (!isEditingRef.current) throw new Error("Composer is not available");
if (isEmpty || isSendDisabled || submissionRef.current) return;   // ← 静默 no-op
```

| 目标                             | 用什么                                                                      |
| -------------------------------- | --------------------------------------------------------------------------- |
| 加载配置时先不让发，但能继续打字 | `isSendDisabled: true`                                                      |
| 整块区域锁死                     | `isDisabled: true`                                                          |
| 只禁某个按钮                     | 直接给 `<ComposerPrimitive.Send disabled>`；或自己读 `composer.canSend`     |
| 运行时不让发（无 queue）         | 自动：`thread.isRunning && !hasQueue` 时 Input 不提交，`canSend` 为 `false` |

**`ComposerPrimitive.Send` 是自动 disable 的。** `createActionButton`（`packages/react/src/utils/createActionButton.tsx`）的渲染逻辑：

```tsx
const callback = useActionButton(forwardedProps as TProps) ?? undefined
return (
  <Primitive.button
    type="button"
    {...primitiveProps}
    ref={forwardedRef}
    disabled={primitiveProps.disabled || !callback} // ← 没回调就自动禁用
    onClick={composeEventHandlers(primitiveProps.onClick, callback)}
  />
)
```

而 `ComposerPrimitive.Send` 的回调在 `disabled` 时返回 `null`（`primitives/composer/ComposerSend.ts`），所以**空输入 / 运行时 / `isSendDisabled` 都会自动把按钮置灰，不用你自己判断**。

**想要完全自己控制发送按钮 —— 用 `useAui()`（推荐，公开 API）：**

```tsx
import { useAui, useAuiState } from '@assistant-ui/react'

const aui = useAui()
const canSend = useAuiState((s) => s.composer.canSend)

;<button onClick={() => aui.composer.send()} disabled={!canSend}>
  发送
</button>
```

> 注意 **`useComposerSend` 不要从 `@assistant-ui/react` 里 import —— 它没有被导出。**
> 全仓库只有内部使用（`ComposerRoot.tsx`、`unstable/useComposerInput.ts`）。真要那个 `{ send, disabled }` 形状，只能从 `@assistant-ui/core/react` 拿（`packages/core/src/react/primitive-hooks/useComposerSend.ts`），但那是内部包路径，**不建议**。
> 同理 `useComposerCancel` 也不在 `@assistant-ui/react` 的导出里 —— 取消按钮直接用 `<ComposerPrimitive.Cancel>`，或 `aui.composer.cancel()` + `useAuiState((s) => s.composer.canCancel)`。

### 5.3 `/命令` 与 `@提及` 菜单 —— 原生支持（Unstable_，但已经是完整实现）

**这是 0.15.21 存在的完整子系统，不是半成品。** 位置：
`packages/react/src/primitives/composer/trigger/**`（23 个文件，含完整键盘/导航/选中资源与测试）
`packages/react/src/unstable/useSlashCommandAdapter.ts`、`useMentionAdapter.ts`

#### 5.3.1 输入框如何把按键让给菜单

`ComposerPrimitive.Input` 把每个 TriggerPopover 注册成「input plugin」，**按键顺序是：插件 → 内建逻辑**：

```tsx
// handleKeyPress 与 useEscapeKeydown 里，都是先问插件
if (pluginRegistry) {
  for (const plugin of pluginRegistry.getPlugins()) {
    if (plugin.handleKeyDown(e)) return
  }
}
```

菜单实际消费的键（`triggerKeyboardResource.ts`，仅在 `open` 时）：

| 键                          | 行为                                                             |
| --------------------------- | ---------------------------------------------------------------- |
| `ArrowDown` / `ArrowUp`     | 循环移动高亮（空列表返回 0，不崩）                               |
| `Enter` / `Tab`（非 Shift） | 选中高亮项（item 或 drill-in category），`preventDefault` 并消费 |
| `Shift+Tab`                 | **不消费**（`if (e.shiftKey) return false;`）→ 让回给浏览器      |
| `Escape`                    | 关闭菜单并消费                                                   |
| `Backspace`                 | 在 category 内且 query 为空 → 返回上一级并消费                   |

输入框还会自动挂 ARIA combobox 属性（`useComposerInputState.ts`）：

```ts
"aria-controls": activeAria.popoverId,
"aria-expanded": true,
"aria-haspopup": "listbox",
"aria-activedescendant": activeAria.highlightedItemId,
```

（菜单开着时，这四个属性会**覆盖**你手写的值。）

#### 5.3.2 触发检测 / 自定义 matcher

`trigger/detectTrigger.ts`

```ts
export type TriggerMatch = {
  readonly query: string
  readonly offset: number // 触发字符的下标
  readonly endOffset: number // 选中时被替换区间的**开区间**右端
}

export type TriggerMatcher = (
  text: string,
  triggerChar: string,
  cursorPosition: number,
) => TriggerMatch | null

// 默认检测：从光标往前扫，遇到空白就停；要求触发字符前也是空白（`i > 0 && !/\s/.test(text[i-1]) → continue`）
export function detectTrigger(text, triggerChar, cursorPosition, matcher?): TriggerMatch | null
```

`resolveTriggerMatch` 会做合法性校验（越界/前缀不符/test 边界）—— 自定义 matcher 也要过这一关，返回 `null` 即可拒绝。

#### 5.3.3 `ComposerPrimitive.Unstable_TriggerPopover` 契约

`trigger/TriggerPopover.tsx`

```ts
export namespace ComposerPrimitiveTriggerPopover {
  export type Props = Omit<ComponentPropsWithoutRef<typeof Primitive.div>, 'onSelect'> & {
    /** 触发字符，如 "@" / "/"。同时是它在 root 内的身份标识。 */
    readonly char: string
    /** 覆盖触发检测（textarea 与 Lexical 输入框都走这个）。endOffset 是替换区间右端。 */
    readonly matcher?: TriggerMatcher | undefined
    /** 提供 categories / items 的适配器。 */
    readonly adapter?: Unstable_TriggerAdapter | undefined
    /** adapter 是否正在异步取 items。@default false */
    readonly isLoading?: boolean | undefined
  }
}
```

- **必须放在 `ComposerPrimitive.Unstable_TriggerPopoverRoot` 内。**
- **行为子组件必须恰好一个**：`<TriggerPopover.Directive>` 或 `<TriggerPopover.Action>`。**没有 behavior 时 popover 永远不打开**（`const open = behavior !== null && resource.open;`）。
- 多注册一个会在 dev 下 `console.warn`，**最后一个生效**。
- 打开时渲染 `<div role="listbox" id aria-activedescendant data-state="open">`；关闭时**只渲染 children 不渲染容器**（children 始终挂载）。

#### 5.3.4 `/命令` —— 直接用现成 hook

```ts
export type Unstable_SlashCommand = {
  readonly id: string;
  readonly label?: string | undefined;
  readonly description?: string | undefined;
  readonly icon?: string | undefined;
  readonly execute: () => void;          // 只活在闭包里，绝不挂到 item 上（item 保持可序列化）
};

export type Unstable_UseSlashCommandAdapterOptions = {
  readonly commands: readonly Unstable_SlashCommand[];
  readonly removeOnExecute?: boolean | undefined;   // 执行后是否清掉触发文本 @default false
  readonly iconMap?: Record<string, Unstable_IconComponent>;
  readonly fallbackIcon?: Unstable_IconComponent;
};

export function unstable_useSlashCommandAdapter(options): {
  adapter: Unstable_TriggerAdapter;
  action: Unstable_SlashCommandAction;      // { onExecute, removeOnExecute? }
  iconMap?: ...;
  fallbackIcon?: ...;
};
```

用法（hook 返回值直接展开到 popover 上）：

```tsx
const slash = unstable_useSlashCommandAdapter({
  commands: [
    { id: 'summarize', execute: () => runSummarize(), icon: 'FileText' },
    { id: 'translate', execute: () => runTranslate(), icon: 'Languages' },
  ],
  removeOnExecute: true,
})

;<ComposerPrimitive.Unstable_TriggerPopover char="/" {...slash}>
  <ComposerPrimitive.Unstable_TriggerPopover.Action
    onExecute={slash.action.onExecute}
    removeOnExecute
  />
  <ComposerPrimitive.Unstable_TriggerPopoverItems>
    {(items) => items.map((it) => <Item key={it.id} {...it} />)}
  </ComposerPrimitive.Unstable_TriggerPopoverItems>
</ComposerPrimitive.Unstable_TriggerPopover>
```

它内部做的事：

```ts
const adapter = useMemo(
  () => ({
    categories: () => [],
    categoryItems: () => [],
    search: (query) => {
      const lower = query.toLowerCase()
      return items.filter((item) => matchesTriggerItemQuery(item, lower))
    },
  }),
  [items],
)
// toItem(): { id, type: "command", label: cmd.label ?? `/${cmd.id}`, description?, metadata: { icon } }
```

**注意 `execute` 不在 item 上**，选中时靠 `commandsRef.current.find(c => c.id === item.id)?.execute()`。所以你想给「命令」附带更多数据，得自己在外面 map by id，或者干脆自己写 `adapter`。

#### 5.3.5 `@提及`

```ts
export type Unstable_Mention = {
  readonly id: string
  readonly type: string
  readonly label: string
  readonly description?: string | undefined
  readonly icon?: string | undefined // metadata.icon 的快捷写法
  readonly metadata?: ReadonlyJSONObject | undefined
}
export type Unstable_MentionCategory = {
  readonly id: string
  readonly label: string
  readonly items: readonly Unstable_Mention[]
}
export type Unstable_UseMentionAdapterOptions = {
  readonly items?: readonly Unstable_Mention[] // 扁平列表
  readonly categories?: readonly Unstable_MentionCategory[] // 分类下钻
  readonly includeModelContextTools?: boolean | Unstable_ModelContextToolsOptions // 把 modelContext.tools 也列进来
  readonly formatter?: Unstable_DirectiveFormatter // @default unstable_defaultDirectiveFormatter
  readonly onInserted?: (item: Unstable_TriggerItem) => void
  readonly iconMap?: Record<string, Unstable_IconComponent>
  readonly fallbackIcon?: Unstable_IconComponent
}
```

**「`@提及` 在输入框里弹出菜单」= 完全可行且是一等场景**，上游连 `includeModelContextTools`（把工具也作为可提及项）都做了。

#### 5.3.6 `Unstable_TriggerAdapter` 的真实签名（全同步）

`packages/core/src/adapters/trigger.ts`

```ts
/** Adapter providing synchronous categories and items to a trigger popover. */
export type Unstable_TriggerAdapter = {
  /** Return the top-level categories for the trigger popover. */
  categories(): readonly Unstable_TriggerCategory[]

  /** Return items within a category. */
  categoryItems(categoryId: string): readonly Unstable_TriggerItem[]

  /** Global search across all categories (optional). */
  search?(query: string): readonly Unstable_TriggerItem[]
}
```

上游自带的匹配函数（`trigger/matchesTriggerItemQuery.ts`，可复用）：

```ts
export function matchesTriggerItemQuery(item: Unstable_TriggerItem, lowerQuery: string): boolean {
  if (!lowerQuery) return true
  return (
    item.id.toLowerCase().includes(lowerQuery) ||
    item.label.toLowerCase().includes(lowerQuery) ||
    (item.description?.toLowerCase().includes(lowerQuery) ?? false)
  )
}
```

#### 5.3.7 三个我们一定会关心的坑

1. **`Unstable_TriggerAdapter` 的三个方法必须同步返回。**
   `search?` 是**可选**的（只做分类下钻时可以不给）；但给了就必须同步。异步数据源要自己在外面取好、通过 `isLoading` 告知 popover 状态（`packages/react/src/primitives/composer/trigger/TriggerPopoverResource.ts`）。
   → `/命令` 本地列表没问题；`@提及` 如果要打后端搜索，得自己防抖 + 缓存，adapter 只读缓存。
2. **整个 trigger 子系统全是 `Unstable_` / `unstable_` 命名**。功能完整、有测试（`TriggerPopoverBehavior.test.tsx`、`triggerKeyboardResource.test.ts`、`triggerSelectionResource.test.ts`、`detectTrigger.test.ts` 等），但**签名不保证跨 minor 版本稳定**。建议在我们自己代码里包一层 `ComposerSlashMenu` / `ComposerMentionMenu`，把 unstable 细节隔离在一个文件里。

3. **`TriggerPopover.Action` 与 `Directive` 的区别**：`Directive` 用于「插入一个指令文本（如 `@张三`）」并配 `formatter`；`Action` 用于「执行一个动作（如 `/summarize`）」。**两者不共存**，一个 popover 只能有一个 behavior。

---

## 6. 【必答】离线可用判断 —— 会不会被强制走它的 transport？

### 结论

**不会。`useExternalStoreRuntime` 完全不带任何网络设施。只要给出 `messages` 与 `onNew`，网络层 100% 由我们自己管，可以完全离线。**

### 证据（逐条可复核）

**证据 1：依赖图里没有 transport。**
`packages/core/src/runtimes/external-store/` 全部 6 个文件，grep `transport` / `fetch(` / `AssistantTransport` → **零命中**。
`ExternalStoreRuntimeCore` 的全部 imports：

```ts
// packages/core/src/runtimes/external-store/external-store-runtime-core.ts
import { BaseAssistantRuntimeCore } from '../../runtime/base/base-assistant-runtime-core'
import { ExternalStoreThreadListRuntimeCore } from './external-store-thread-list-runtime-core'
import type { ExternalStoreAdapter } from './external-store-adapter'
import { ExternalStoreThreadRuntimeCore } from './external-store-thread-runtime-core'
```

只有 runtime core 家族，没有任何 HTTP/流式客户端。

**证据 2：`append()` 的唯一出口就是你给的 `onNew`。**

```ts
// external-store-thread-runtime-core.ts:713-720
if (isEdit) {
  if (!this._store.onEdit) throw new Error('Runtime does not support editing messages.')
  this._pendingDeleteEvictions.clear()
  await this._store.onEdit(message)
} else {
  await this._store.onNew(message) // ← 就这一行，await 你的 promise
}
```

运行时 **await 你的回调**，你怎么实现（fetch / WebSocket / 离线缓存 / 纯本地 mock）它不管，也不持有任何客户端实例。

**证据 3：渲染的数据源就是你传进去的 `messages`，别无他处。**
每个 render 后 `runtime.setAdapter(adaptedStore)`；快照阶段从 `store.messages` 或 `store.messageRepository` 取（`external-store-thread-runtime-core.ts:287-428`）。**没有 fallback 到内部 store 之类的东西**，两个都没有才抛 `must provide either 'messages' or 'messageRepository'`。

**证据 4：`isRunning` 完全由你控制。**

```ts
public get isRunning(): boolean | undefined {
  if (this._hasExecutingTools(this._store)) return true;
  return this._store.isRunning;     // ← 直接透传你的值
}
```

（还有个「有正在执行的客户端工具」的补充条件，但那个也只在 `unstable_enableToolInvocations === true` 时才有值，默认关。）

**证据 5：`onCancel` 也不碰任何内部 transport。**

```ts
if (!this._store.onCancel) ...          // 没给 → cancel 能力为 false
observeAdapterCallback("onCancel", this._store.onCancel());   // 只是调你的函数
```

### 「离线可用」还需要注意的三点（这才是真风险）

1. **不要用 `useExternalStoreRuntime` 之外的 runtime**。
   `useLocalRuntime` 需要一个 `ChatModelAdapter`，并且会内建 transport 语义；`useAssistantTransportRuntime` / `useAISDKRuntime` / `useChatRuntime` 都是自带网络的。**只认 `useExternalStoreRuntime`。**
   `packages/core/src/runtimes/assistant-transport/` 是一个**独立 runtime**，不是 external-store 的依赖。

2. **`@assistant-ui/react` 本身的可选依赖别被间接激活。**
   我们只 import `@assistant-ui/react`（外加可选 `@assistant-ui/ui` 的拷贝组件）。不上 `@assistant-ui/react-ai-sdk` / `react-data-stream` 就不会有任何隐含 client。

3. **离线时把 `isRunning` 收干净。**
   你的 `onNew` 里如果 await 一个会失败的网络请求，**必须 `try/finally { setIsRunning(false) }`**，否则 `isRunning: true` 会让运行时**永久插一条空 optimistic assistant 消息**（`hasUpcomingMessage`），界面上留一个永远转圈的幽灵气泡。
   另外 cancel 后残留的尾部 user 消息需要靠 `setMessages` 收回（源码注释原文：「Without it, cancelling a run leaves a trailing user message in the thread in the composer untouched; **an adapter that removes that message itself owns handing it back, because the runtime cannot see a removal it did not make**」）。

**一句话交付：`useExternalStoreRuntime` = 纯受控视图层。给 `messages` + `onNew`，网络层 100% 自管，可完全离线。**

---

## 7. 已知坑（StrictMode / memo / re-render 成本 / unstable_ 清单）

### 7.1 React 19 StrictMode —— 官方支持，有针对性测试

`packages/core/src/react/runtimes/useExternalStoreRuntime.lifecycle.test.tsx`

```tsx
it("keeps dispatching appends after StrictMode's simulated remount", async () => {
  const onNew = vi.fn(async () => {})
  // ...
  render(
    <StrictMode>
      <App />
    </StrictMode>,
  )

  await act(async () => {
    await capture.runtime!.thread.append({
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    })
  })

  expect(onNew).toHaveBeenCalledTimes(1) // * 恰好一次，不重复
})
```

同文件还有 `"dispatches an append before unmount"` 与用 `<Activity mode="hidden"/visible">` 的测试。

**结论：StrictMode 下 `onNew` 不会被双触发，可以放心开 `reactStrictMode`。**

需要注意的两处**无害但会看到的现象**：

1. `useState(() => new ExternalStoreRuntimeCore(adaptedStore))` 的惰性初始化在 dev StrictMode 下会**执行两次**，第一个实例被丢弃。
   → 里面没有副作用，只是多一次内存分配。**不要在 `useExternalStoreRuntime` 之外的 module-level 搞单例**，否则会真的重复。
2. `useEffect(() => { ... invalidateThreadRuntime(...) }, [runtime])` 的清理函数在 StrictMode 的 simulated remount 里会跑一次。
   → 上游已处理（测试覆盖）。**但我们不要在 React 渲染阶段手动调 `runtime.thread.*` 的变更方法。**

### 7.2 `convertMessage` 的 memo 要求 —— 这是**最硬**的性能红线

两层缓存，都基于**对象引用身份**：

**(a) 函数引用变化会清空整张缓存。**
`external-store-thread-runtime-core.ts:327-335`

```ts
if (oldStore) {
  // flush the converter cache when the convertMessage prop changes
  if (oldStore.convertMessage !== store.convertMessage) {
    this._converter = new ThreadMessageConverter() // ← 全部消息重新转换
  } else if (
    !repositoryChanged &&
    oldStore.isRunning === store.isRunning &&
    oldStore.messages === store.messages && // ← 数组身份
    previousIsRunning === isRunning
  ) {
    this._notifySubscribers()
    return // ← 提前返回，什么都不做
  }
}
```

**(b) 单条消息级缓存是 `WeakMap`，key 是消息对象身份。**
`external-store-thread-runtime-core.ts:136` + `thread-message-converter.ts`

```ts
private _converter = new ThreadMessageConverter();

export class ThreadMessageConverter {
  private readonly cache = new WeakMap<WeakKey, ThreadMessage>();
  convertMessages<TIn extends WeakKey>(messages: readonly TIn[], converter) {
    return messages.map((m, idx) => {
      const cached = this.cache.get(m);
      const newMessage = converter(cached, m, idx);
      this.cache.set(m, newMessage);
      return newMessage;
    });
  }
}
```

**由此得出四条硬规则：**

| 规则                                                                           | 违反的后果                                                                                |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| **`convertMessage` 必须是稳定引用**（模块级函数，或 `useCallback` 且依赖稳定） | 每次 render 都全量重转所有历史消息 → 流式时 O(n) 每 tick                                  |
| **`messages` 数组必须是稳定引用，除非真的变了**                                | 每次 render 都走完整快照流程（虽然内部有 dedupe，但白干）                                 |
| **只替换变化的那一条消息对象，其余保持同一引用**                               | 不替换 → WeakMap 命中失败 → 该条重转（历史全部重转）                                      |
| **绝不原地 mutate 消息对象**                                                   | WeakMap key 不变 → 转换被跳过 → **UI 不更新**（这是「为什么数据变了界面不动」的头号原因） |

**正确写法：**

```ts
// 模块级，天然稳定 *
const convertMessage = (m: OurMsg, idx: number): ThreadMessageLike => ({ ... });

// 或者
const convertMessage = useCallback((m: OurMsg, idx: number) => ({ ... }), []);

// 流式更新只换一条 *
setMessages((prev) => prev.map((m) => (m.id === targetId ? { ...m, text: m.text + chunk } : m)));
//                                                        ^^^^ 新对象                ^^^^ 其余引用不变
```

### 7.3 流式更新时的 re-render 成本 —— UI 侧已经是细粒度订阅

**底层换成了 `@assistant-ui/store` 的 selector 订阅**，不是「一个大 context 全量广播」。

`packages/core/src/react/primitives/thread/ThreadMessages.tsx`

```tsx
const ThreadPrimitiveMessagesInner: FC<...> = ({ children }) => {
  const messageIds = useAuiState(
    // * 只订阅 id 列表，且用 shallow 比较：消息内容变化不会触发这里
    useShallowSelector((s) => s.thread.messages.map((message) => message.id)),
  );

  return useMemo(() => {
    if (messageIds.length === 0) return null;
    return messageIds.map((messageId, index) => (
      <MessageByIndexProvider key={messageId} index={index}>
        <RenderChildrenWithAccessor getItemState={(aui) => aui.thread.message({ index }).getState()}>
          ...
        </RenderChildrenWithAccessor>
      </MessageByIndexProvider>
    ));
  }, [messageIds, children]);
};
```

**含义：第 5 条消息的内容流式更新时：**

- `messageIds` 数组不变 → `useMemo` 不重算 → **消息列表本身不 re-render**
- 只有那条消息自己的 scope（`MessageByIndexProvider`）内的订阅者更新

`MessagePart` 也有显式 memo（`MessageParts.tsx`）：

```tsx
const MessagePart = memo(MessagePartImpl, (prev, next) =>
  prev.partIndex === next.partIndex &&
  prev.components?.Text === next.components?.Text &&
  ... 逐个比较 components 槽位 ...);
```

→ **`components` 对象必须是稳定引用**，否则 memo 失效。**把 `components={{...}}` 提到组件外（模块级常量）或用 `useMemo`。**

`ThreadPrimitive.Messages` 本身也是 memo：

```tsx
export const ThreadPrimitiveMessages = memo(ThreadPrimitiveMessagesImpl, (prev, next) => {
  if (prev.children || next.children) return prev.children === next.children // ← children 引用要稳定
  return isComponentsSame(prev.components!, next.components!)
})
```

**性能 checklist：**

1. `convertMessage` 稳定引用（§7.2）。
2. 只替换变化的消息对象，其余保持引用（§7.2）。
3. `components={{...}}` 提到模块级或 `useMemo`（否则 `MessagePart` 的 memo 全废）。
4. `ThreadPrimitive.Messages` 的 `children` 用**模块级函数**或 `useCallback`，别写内联箭头。
5. 用 `groupPartByType(...)` 而不是内联 `groupBy`，白拿 `GROUPBY_MEMO_KEY` 的树级 memo。
6. 超长历史 + 大消息量：上虚拟列表，用 `unstable_useThreadMessageIds()` + `ThreadPrimitive.Unstable_MessageById`（专门为 windowing 设计的按 id 挂载，配 `MessageByIdProvider`，缺 id 时返回 `null` 不抛错）。参考 `examples/with-virtualized-thread/`。
7. 离线/弱网：`messages` 数组别每帧新建。

### 7.4 官方对「re-render 成本」的建议（原文照抄）

`apps/docs/content/docs/runtimes/custom/external-store.mdx`（Best practices）

> 1. **Immutable updates.** Always create new arrays: `setMessages([...messages, newMessage]); // not messages.push(newMessage)`
> 2. **Stable handler references.** Memoize `onNew`, `onEdit`, etc. with `useCallback` to avoid recreating the runtime.
> 3. **Use `useShallow`** with zustand to prevent unnecessary re-renders.

另外官方专门为「不想全量重转」提供了 `useExternalMessageConverter`：

```ts
// packages/core/src/react/runtimes/external-message-converter.ts
export const useExternalMessageConverter = <T extends WeakKey>({
  callback,       // (message, idx) => ThreadMessageLike
  messages,       // T[]
  isRunning,
  joinStrategy,   // "concat-content"（默认，合并相邻 assistant 消息）| "none"
  metadata,
}) => ThreadMessage[];
```

配套 `createExternalMessageConversionCache()`，源码注释：

> 「把同一个 cache 在同一个消息列表上每次都传进来，则自上次调用以来没变过的源消息会转出**同一个 `ThreadMessage` 对象**。条目以源消息身份为 key，并在 `callback` 或 `metadata` 与上次调用不是同一对象时整体重建，**所以这两个都要保持引用稳定**。」
> 「cache 生命期是组件生命期：React Compiler 会把没有响应式依赖的分配从 `useMemo` 里提升出去，所以条目自身携带产生它们的 callback 与 metadata，而不是在它们变化时被清掉。」

**「同一批调用合并成一行」也能靠 `joinStrategy: "concat-content"` 拿一部分效果**（相邻 assistant 消息会被合并成一条 `ThreadMessage`，`tool-call` part 的 `parentId` 会被串起来，见 `joinExternalMessages`）。带 `metadata.modality: "voice"` 的消息在任何 strategy 下都不合并。

### 7.5 `unstable_` / `Unstable_` 全清单（0.15.21，我们可能碰到的）

**`ExternalStoreAdapter` 上的（按风险从高到低）：**

| 名字                                 | 说明                                                                                                                                                         | 稳定性                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| `unstable_enableToolInvocations`     | 内建客户端工具调用管线（`streamCall`/`execute`），**默认 `false`**。源码明确警告：大多数 external-store 场景要么服务端跑工具、要么自管分发，**开了会双触发** | 默认关，**我们要跑自己的工具就保持关** |
| `unstable_isClientToolCall`          | 仅当上面为 `true` 才有意义                                                                                                                                   | 同上                                   |
| `setToolStatuses`                    | 仅当上面为 `true` 才有意义                                                                                                                                   | 同上                                   |
| `unstable_messageRepositoryInstance` | 外部持有的 `MessageRepository`，支持一个 runtime 路由多个会话                                                                                                | 源码注释「switches atomically」        |
| `unstable_onBranchChange`            | `@deprecated`（注释写「under active development」）。只在**显式** `switchToBranch` 时触发，不替代 `setMessages`                                              | 注意 慎用                              |
| `unstable_capabilities.copy`         | 开启复制能力                                                                                                                                                 | —                                      |
| `adapters.threadList`                | `@deprecated`                                                                                                                                                | 注意 慎用                              |

**React 侧的 `unstable_`：**

| 名字                                                                                                                     | 用途                                               |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| `unstable_useMentionAdapter`                                                                                             | `@提及` 菜单适配器                                 |
| `unstable_useSlashCommandAdapter`                                                                                        | `/命令` 菜单适配器                                 |
| `unstable_useLiveCompletionAdapter`                                                                                      | 实时补全                                           |
| `unstable_useComposerInput` / `unstable_useComposerInputHistory`                                                         | 输入框插件 / ↑↓ 历史（ArrowUp 空草稿召回历史）     |
| `unstable_useTriggerPopoverAriaProps`                                                                                    | combobox ARIA                                      |
| `unstable_useTriggerPopoverRootContext` / `...Optional` / `...ScopeContext` / `...Triggers`                              | trigger 上下文                                     |
| `unstable_defaultDirectiveFormatter`                                                                                     | 默认指令格式化器                                   |
| `unstable_useMessageStallDetection`                                                                                      | 消息卡死检测                                       |
| `unstable_useThreadMessageIds`                                                                                           | 虚拟列表取 id 列表                                 |
| `ThreadPrimitive.Unstable_MessageById`                                                                                   | 按 id 挂载消息（虚拟列表）                         |
| `MessagePrimitive.Unstable_PartsGrouped` / `Unstable_PartsGroupedByParentId`                                             | 非相邻分组（**@deprecated** → 用 `GroupedParts`）  |
| `unstable_convertExternalMessages` / `unstable_createExternalMessageConversionCache` / `unstable_createMessageConverter` | 转换工具                                           |
| `MessagePrimitive.GenerativeUI` / `generativeUI` 槽位                                                                    | 生成式 UI（同一 realm 渲染，allowlist 是安全边界） |
| `unstable_useWebMcpProvider` / `unstable_defaultWebMcpFilter`                                                            | WebMCP                                             |
| `unstable_Interactables` / `unstable_useInteractable*` 等一组                                                            | Interactables                                      |

**已经 `@deprecated`、别在新代码里用的：**

| 名字                                                  | 替代                                        |
| ----------------------------------------------------- | ------------------------------------------- |
| `ThreadPrimitive.If` / `ThreadPrimitive.Empty`        | `<AuiIf condition={(s) => s.thread.*} />`   |
| `MessagePrimitive.Unstable_PartsGrouped(…ByParentId)` | `MessagePrimitive.GroupedParts`             |
| `components.ToolGroup` / `components.ReasoningGroup`  | `MessagePrimitive.GroupedParts` + `groupBy` |
| `ComposerPrimitive.Input` 的 `submitOnEnter`          | `submitMode`                                |
| `Unstable_AudioMessagePart` / `Unstable_Audio` 槽位   | `FileMessagePart` + `audio/*` mime          |
| `ThreadPrimitive.Messages` 的 `components` prop       | `children` render function                  |
| `ExternalStoreAdapter.adapters.threadList`            | 仍在用，但标注 deprecated                   |

---

## 8. 我们的协议在它上面「表达不了」的点

按严重程度排：

### 8.1 `content` 是**有序扁平数组**，不是树 —— 步骤层级只能靠 `parentId` / `tool-call.messages` 模拟

「一轮 = assistant 消息 + 一串步骤」是**可表达**的（步骤 = `tool-call` part，顺序 = 数组顺序）。
但**「步骤里再套步骤、且不是线性」表达不了**。可行的替代：

- 相邻层级 → `parentId` + `GroupedParts` 做嵌套分组（`groupBy` 返回值本身是路径数组，`["group-a","group-b"]` 会生成两层 group）
- 子会话/子 agent → `tool-call.messages`（`readonly ThreadMessage[]`），配 `MessagePartPrimitive.Messages` 渲染
- 结构差异再大，就只能把细节塞 `metadata.custom`，自己渲染（放弃 primitive 的自动好处）

### 8.2 消息 `status` 被运行时语义「绑架」，我们无法表达任意状态机

`MessageStatus` 是**封闭联合**：`running` / `requires-action`(tool-calls|interrupt) / `complete`(stop|unknown) / `incomplete`(cancelled|tool-calls|length|content-filter|other|error)。

- 我们如果有「排队中 / 已计划 / 部分失败但可重试」这类状态，**没有位置**。
- 而且一旦显式给了 `status`，就**关掉了自动推导**（§2.3），后续内容变化不会再更新它。
- 兜底：塞 `metadata.custom.status`，自己渲染；但会失去 `ThreadPrimitive.If`/`MessagePrimitive.If` 的自动分支。

### 8.3 「工具调用合并成一行」的判据是**相邻性**，不是业务分组

`MessagePrimitive.GroupedParts` 只合并**相邻**且共享 `groupBy` 前缀的 part（`buildGroupTree` 做的是最长公共前缀 + 相邻合并）。

- 如果一批调用中间插了一段 text，它们会被切成两组，**不会合成一行**。
- 想跨位置聚合 → 只能用 `@deprecated` 的 `MessagePrimitive.Unstable_PartsGrouped`（非相邻聚类）。
- **实操建议：把同一批调用写成连续的 part，中间不插 text**，就能用推荐的 `GroupedParts`。这需要渲染顺序配合数据顺序 —— 需和协议侧对齐。

### 8.4 `adapters.history` 已移除，历史加载完全自己扛

没有「给我一个 history adapter 就自动加载/续流」的机制了。

- 老版本有 `useExternalHistory`，**0.15.21 全仓库为零**。
- 我们必须自己在 `messages` / `messageRepository` 里提供完整历史（含分支树），自己管分页/缓存/失效。
- 这跟我们「自管 store」的定位一致，**不算真障碍，但要有人在数据层真正做掉**。

### 8.5 工具调用的 `result` 用 `undefined` 表示「未完成」，无法表达「完成但结果就是 undefined」

`result === undefined` 被判定为 pending（`isPendingToolCall`），消息会停在 `requires-action`。
**规约：完成的工具必须给 `result`，无输出用 `result: null`。** 这需要在协议层强制。

### 8.6 `system` 消息只能有**恰好一个 text part**

```ts
if (content.length !== 1 || content[0]!.type !== 'text')
  throw new Error('System messages must have exactly one text message part.')
```

我们的系统提示 / 上下文注入如果有多个段落或结构化数据，**不能塞 system 消息**，得用 user/assistant 消息或走 store 层。

### 8.7 空文本 part 会被**静默丢弃**

`text` 空白 → 丢；`reasoning` 无 text 且无 `unstable_summary` → 丢。
我们如果有「空步骤但需要占位」的语义（比如「正在思考但还没输出」），**不能靠空 text part** 表达 —— 要靠 `isRunning` + 运行时的 optimistic 占位消息，或者 `indicator`。
（单独提：`MessagePrimitive.Parts` 在 assistant 消息 running 且无 part 时，会用 `{ type: "text", text: "", status: { type: "running" } }` 调一次 children —— 判定方式是 `part.status?.type === "running" && part.text === ""`。）

### 8.8 `image` part 被强制校验，非法 URL 静默丢弃

只接受 `data:image/*`、`https://`、`blob:`。**`http://` 会被丢**（会 `console.warn`）。
我们如果有内网 http 图床，要么升级 https，要么把 `image` 降到 `file` part（`file` 没有这个校验）或 `metadata.custom` 自己渲。

### 8.9 `parentId` 在 part 上的语义由**我们自己**约定，库不解释

`tool-call.parentId` 的注释是「Parent message-part ID when this part belongs to a nested structure」—— 纯挂载点，库只拿它做分组 key。
→ 它的语义完全由我们定义（「本批 id」「步骤 id」…都可以），**但也要我们自己保证一致性**，且 `groupBy` 生成的 key 必须 `group-` 前缀。

### 8.10 `isRunning` 是**线程级布尔**，无法按轮次/按步骤表达细粒度进度

`thread.isRunning` 只有一个 bool（`isRunning` prop 或最后一条消息状态的启发式）。

- 「这一轮的第 3 步正在跑」这种进度，只能靠 assistant 消息里的 `tool-call` 的 `result === undefined` + `GroupedParts` 的 `counts`（`{running, complete, incomplete, requiresAction}`）推出来。
- 没有「轮次级进度百分比」这类概念。

### 8.11 全 `Unstable_` 前缀的 slash/mention 子系统

功能完整、有测试，但**签名不保证跨 minor 稳定**。我们的 `/命令`、`@提及` 依赖它 → **必须包一层**，把 unstable 面收敛到 1~2 个文件内，降低升级成本。

### 8.12 不支持的：多模态「同一 part 多个资源」/ 并发生成多份候选

- 一个 `image`/`file` part = 一个资源，没有「一组图」的容器（`generative-ui` 是给 UI 树用的）。
- 一次只允许一条 assistant 消息在流式（`_optimistic` 只有一个 id），**并行生成 N 份候选再让用户选**表达不了 —— 只能靠分支（`messageRepository` 的 `parentId` 兄弟节点）模拟，但那时用户只能看到一个 head。

---

## 9. 落地清单（照这个顺序做）

**Phase 1 — 骨架跑通（离线可验证）**

1. `OurMessage` → `convertMessage(OurMessage, idx): ThreadMessageLike`，**模块级函数**，覆盖 `text` / `reasoning` / `source` / `tool-call`（含 `approval`）。
2. `useExternalStoreRuntime<ThreadMessageLike>({ messages, convertMessage, onNew, isRunning, setMessages })`。
3. `<AssistantRuntimeProvider>` + `ThreadPrimitive.Root/Viewport/Messages` + `MessagePrimitive.Root/Parts` + `ComposerPrimitive.Root/Input/Send`。
4. **离线打桩 `onNew`**（`await new Promise(r => setTimeout(r, 800))` + 假 assistant 消息）验证：Enter 发送、Shift+Enter 换行、`isRunning` 转圈、取消按钮。

**Phase 2 — 工具与分组** 5. `MessagePrimitive.GroupedParts` + `groupPartByType({ "tool-call": ["group-tools"], reasoning: ["group-thought"] })`；模块级 `components` 常量。6. 自定义 `ToolStackRow`（读 `part.counts`）与 `ToolCallCard`（读 `status.type` / `approval` / `respondToApproval`）。7. 接 `onAddToolResult` / `onRespondToToolApproval` / `onCancel` / `onEdit` / `onReload`，逐个点亮对应按钮。

**Phase 3 — 输入增强** 8. `ComposerPrimitive.Unstable_TriggerPopoverRoot` 包住 Input，里面放 `/` 与 `@` 两个 `Unstable_TriggerPopover`（`Directive` 或 `Action`）。9. `/` 用 `unstable_useSlashCommandAdapter`；`@` 用 `unstable_useMentionAdapter({ items })`。10. 全部 unstable 调用收敛进 `composer-menus.tsx` 单文件。

**Phase 4 — 规模化** 11. 历史消息多 → `useExternalMessageConverter` + `createExternalMessageConversionCache`（或在自带 store 层保证引用稳定）。12. 消息很长 → 虚拟列表（`unstable_useThreadMessageIds` + `ThreadPrimitive.Unstable_MessageById`）。13. 流式期间用 React DevTools Profiler 确认：只有当前消息子树 re-render。

---

## 10. 上游参考文件（clone 内路径，便于直接跳读）

| 主题                                                         | 路径（相对 `E:\gitlab\kylab\.cache\upstream\assistant-ui`）                                                                                              |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adapter 全部 props                                           | `packages/core/src/runtimes/external-store/external-store-adapter.ts`                                                                                    |
| Hook 本体                                                    | `packages/core/src/react/runtimes/useExternalStoreRuntime.ts`                                                                                            |
| Runtime core（1078 行，快照/append/cancel 全在这）           | `packages/core/src/runtimes/external-store/external-store-thread-runtime-core.ts`                                                                        |
| 消息类型 / part 类型 / approval                              | `packages/core/src/types/message.ts`                                                                                                                     |
| `ThreadMessageLike` + 转换校验                               | `packages/core/src/runtime/utils/thread-message-like.ts`                                                                                                 |
| status 自动推导                                              | `packages/core/src/runtime/utils/auto-status.ts`                                                                                                         |
| 转换缓存（memo 红线）                                        | `packages/core/src/runtime/utils/external-message-conversion.ts`、`packages/core/src/runtimes/external-store/thread-message-converter.ts`                |
| `MessagePrimitive.Parts` + components 映射                   | `packages/core/src/react/primitives/message/MessageParts.tsx`                                                                                            |
| `MessagePrimitive.GroupedParts`                              | `packages/core/src/react/primitives/message/MessageGroupedParts.tsx`                                                                                     |
| `groupPartByType` / `buildGroupTree`                         | `packages/core/src/react/utils/groupParts.ts`                                                                                                            |
| `ThreadPrimitive.Messages`（细粒度订阅）                     | `packages/core/src/react/primitives/thread/ThreadMessages.tsx`                                                                                           |
| `AssistantRuntimeProvider`                                   | `packages/core/src/react/AssistantRuntimeProvider.tsx`                                                                                                   |
| `ComposerPrimitive.Input`（快捷键/IME）                      | `packages/react/src/primitives/composer/ComposerInput.tsx`                                                                                               |
| 输入框禁用判定                                               | `packages/react/src/primitives/composer/useComposerInputState.ts`                                                                                        |
| `/` `@` trigger 全套                                         | `packages/react/src/primitives/composer/trigger/**`                                                                                                      |
| slash / mention 适配器                                       | `packages/react/src/unstable/useSlashCommandAdapter.ts`、`useMentionAdapter.ts`                                                                          |
| `ToolFallback`（在 `@assistant-ui/ui`，**不在 react 包里**） | `packages/ui/src/components/react/assistant-ui/elements/tool-fallback.aui.tsx`                                                                           |
| StrictMode 生命周期测试                                      | `packages/core/src/react/runtimes/useExternalStoreRuntime.lifecycle.test.tsx`                                                                            |
| 官方文档（external store 全文）                              | `apps/docs/content/docs/runtimes/custom/external-store.mdx`                                                                                              |
| 官方文档（分组）                                             | `apps/docs/content/docs/guides/part-grouping.mdx`                                                                                                        |
| 最小例子                                                     | `examples/with-external-store/app/MyRuntimeProvider.tsx`                                                                                                 |
| 其它参考例子                                                 | `examples/with-virtualized-thread/`、`examples/with-chain-of-thought/`、`examples/with-artifacts/`、`examples/with-mcp/`、`examples/with-interactables/` |
| 版本变更历史                                                 | `packages/react/CHANGELOG.md`、`packages/core/CHANGELOG.md`                                                                                              |
