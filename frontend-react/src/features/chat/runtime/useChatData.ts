/**
 * 对话页要读的那些**服务端状态**（知识库、模型注册表、命令目录、技能、会话详情、
 * 上下文用量、推荐问题、会话文件区）。
 *
 * 为什么这一层用 `@tanstack/react-query` 而不是自己写：旧前端这些数据散在四个 Pinia
 * store 里，各自手写缓存、失效与"正在加载"标记，于是同一件事有四种写法。
 * 迁移计划 §2 定的就是它——缓存、失效、重试、并发去重都由库负责，这里只声明
 * "读什么、什么时候读"。**写操作不经过它**（那些是「一轮对话」的一部分，
 * 见 `ChatProvider`）。
 */
import { useQuery } from '@tanstack/react-query'

import { listSkills, type Skill } from '@/api/capabilities'
import { getSuggestedQuestions, listCommands, type ChatCommand } from '@/api/chat'
import {
  getConversation,
  listConversations,
  listFiles,
  type ConversationDetail,
} from '@/api/conversations'
import { getRegistry, type RegisteredModel } from '@/api/modelRegistry'
import { listKnowledgeBases, type KnowledgeBase } from '@/api/knowledgeBases'
import { getContextUsage, type ContextUsage } from '@/api/chat'

/** 知识库清单：这一页只用 id 与名字（选库、入库、@ 提及的说明）。 */
export function useKnowledgeBases() {
  return useQuery({
    queryKey: ['chat', 'knowledge-bases'],
    queryFn: async (): Promise<KnowledgeBase[]> => (await listKnowledgeBases()).items,
    staleTime: 60_000,
  })
}

/**
 * 可对话的模型。
 *
 * 口径与旧前端 store 的 `chatModels` getter 一致：**供应商启用**、且
 * 能力列表里没有专有项（空 = 通用）或明确含 `chat`。两处各写一份迟早会漂，
 * 所以这条筛选写在这里一处，`ModelPicker` 只吃结果。
 */
export function useChatModels() {
  return useQuery({
    queryKey: ['chat', 'registry'],
    queryFn: async (): Promise<{
      models: RegisteredModel[]
      defaultPk: string
      loaded: boolean
    }> => {
      const registry = await getRegistry()
      const enabled = new Set(
        registry.providers.filter((item) => item.enabled).map((item) => item.id),
      )
      const models = registry.models.filter(
        (model) =>
          enabled.has(model.provider_id) &&
          (model.capabilities.length === 0 || model.capabilities.includes('chat')),
      )
      const bound = registry.slots.find((slot) => slot.slot === 'chat')?.bound_model_pk ?? ''
      return { models, defaultPk: bound, loaded: true }
    },
    staleTime: 60_000,
  })
}

/**
 * 斜杠命令目录（`GET /chat/commands`）。
 *
 * **懒加载**：不敲 `/` 就不请求（与旧前端一致）——它是顺手的入口，
 * 给对话页的首屏加一次往返不值当。取回之后永久新鲜（`Infinity`）：
 * 命令文件改了就刷新页面，那是"文件"这条路的常态。
 */
export function useChatCommands(enabled: boolean) {
  return useQuery({
    queryKey: ['chat', 'commands'],
    queryFn: async (): Promise<ChatCommand[]> => listCommands(),
    enabled,
    staleTime: Infinity,
  })
}

/** 技能清单（「加号 → 技能」与 `@` 提及都要它）。同样懒加载。 */
export function useSkills(enabled: boolean) {
  return useQuery({
    queryKey: ['chat', 'skills'],
    queryFn: async (): Promise<Skill[]> => {
      const { items } = await listSkills()
      // 只列**能进提示词**的：被安全扫描拦下的技能钉了也不生效，
      // 摆在可勾的位置上就是骗人（旧前端同一条口径）
      return items.filter((item) => item.used_by_prompt)
    },
    enabled,
    staleTime: 60_000,
  })
}

/** 会话详情（消息、库范围、模型、思考偏好）。 */
export function useConversationDetail(conversationId: string) {
  return useQuery({
    queryKey: ['chat', 'conversation', conversationId],
    queryFn: (): Promise<ConversationDetail> => getConversation(conversationId),
    enabled: Boolean(conversationId),
  })
}

/** 会话列表：`@` 提及里的"会话"那一类（以及没带 id 时的"最近一条"）。 */
export function useConversations(limit = 50) {
  return useQuery({
    queryKey: ['chat', 'conversations', limit],
    queryFn: async () => (await listConversations(limit)).items,
    staleTime: 15_000,
  })
}

/** 这条会话的文件区（`@` 提及的文件那一类）。 */
export function useConversationFiles(conversationId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['chat', 'files', conversationId],
    queryFn: async () => (await listFiles(conversationId)).entries,
    enabled: enabled && Boolean(conversationId),
    staleTime: 15_000,
  })
}

/**
 * 上下文用量（`GET /chat/context-usage`）。
 *
 * 失败**如实抛**（不吞成 0）：仪表是"这个数现在是多少"的入口，
 * 拿不到就显示"读不到"——旧前端 `ContextGauge` 里那条纪律一字不差地搬过来。
 */
export function useContextUsage(conversationId: string) {
  return useQuery({
    queryKey: ['chat', 'context-usage', conversationId],
    queryFn: (): Promise<ContextUsage> => getContextUsage(conversationId),
    enabled: Boolean(conversationId),
    staleTime: 5_000,
  })
}

/**
 * 推荐问题（空状态那一排）。
 *
 * 只在"空状态 + 至少选了一个库"时才请求：它是从库里的分段出题结果抽的，
 * 关掉知识库就没有语料（旧前端 `scheduleSamples` 同一条）。
 */
export function useSuggestedQuestions(kbIds: string[], enabled: boolean) {
  const key = [...kbIds].sort().join(',')
  return useQuery({
    queryKey: ['chat', 'suggested', key],
    queryFn: async () => getSuggestedQuestions(kbIds),
    enabled: enabled && kbIds.length > 0,
    staleTime: 30_000,
    // 生成只是引导：拿不到就回退静态样例，别把空状态变成错误提示
    retry: 0,
  })
}
