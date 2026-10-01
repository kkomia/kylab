/**
 * 知识库页面的**路由守卫**（M3 阶段 6）。
 *
 * ## 它挡什么
 *
 * 提供者不可用（没配 / 连不上 / 凭据错 / 协议版本不认识）时，四条知识库路由
 * （`/knowledge-bases`、`/kb/:kbId`、`/kb/:kbId/wiki`、`/documents/:documentId`）
 * **重定向到 `/chat` 并给一条 toast（含原因）**——不静默、不白屏、不留一个死页面
 * （方案 §3.4「断连后消失」那一段）。
 *
 * 侧栏那一组显隐与这里是**同一个判定源**（`api/provider.ts`），所以"导航里没了"
 * 与"直接敲地址进不去"永远一致：不会出现"菜单藏了、书签还能进"这种半截状态。
 *
 * ## 四条分支（顺序不能换）
 *
 * 1. **不是本机档** → 放行。浏览器 / NAS 网页端那一档知识库就是它自己
 *    （`gate = false`），守卫在这儿**一个字都不该管**——管了会把好端端的产品挡掉；
 * 2. `ready` → 放行（页面内容不缓存，M4 才做）；
 * 3. **本机档但还没结论** → 先等一下（一行"正在确认…"）。这是首屏那一次握手的窗口：
 *    直接跳走会把一条正常深链接冤枉成"不可用"，而"未知按缺席渲染"管的是**导航**
 *    （不闪一个点进去报错的入口），不是把深链接弹回去；
 * 4. 有结论且不是 `ready` → 记一条 toast + 重定向。
 *
 * toast 只发一次（`ref` 挡板）：状态每次广播都会重渲染这个组件，
 * 而"连不上"这件事说一遍就够，刷屏反而把原因淹掉。重定向用 `replace`：
 * 目的地址不该在历史里留下这条进不去的知识库路由。
 */
import { useEffect, useRef } from 'react'
import { Navigate } from 'react-router'

import { useKnowledgeProviderStatus } from '@/api/provider'

import { notify } from './store'

/**
 * 那条 toast 的原话（抽成纯函数：文案里**必须有原因**，用例逐字钉它）。
 *
 * 两句分开是有意的：`unconfigured`（还没配）与 `unavailable`（配了但连不上）
 * 的下一个动作完全不同——前者要填地址，后者要查网络/钥匙。后端给的原因句子里
 * 已经带了下一步，这里只补"你被送回哪儿了、本机后端还在不在"。
 */
export function providerBlockedMessage(state: string, reason: string): string {
  const lead = state === 'unconfigured' ? '还没接上知识库提供者' : '知识库提供者连不上'
  return `${lead}：${reason || '本机后端没给出原因'}；已回到对话页（本机后端仍在运行）`
}

export function ProviderRoute({ children }: { children: React.ReactNode }) {
  const provider = useKnowledgeProviderStatus()
  const blocked = provider.gate && provider.settled && !provider.ready
  const notified = useRef(false)

  useEffect(() => {
    if (!blocked || notified.current) return
    notified.current = true
    notify.warning(providerBlockedMessage(provider.state, provider.reason || provider.error))
  }, [blocked, provider.state, provider.reason, provider.error])

  // 服务器档（浏览器 / NAS 网页端）：这一档知识库就是它自己，守卫不管
  if (!provider.gate) return <>{children}</>
  if (provider.ready) return <>{children}</>

  if (!provider.settled) {
    return (
      <div className="page-shell">
        <p data-testid="provider-pending" className="text-text-tertiary">
          正在确认知识库连接…
        </p>
      </div>
    )
  }
  return <Navigate to="/chat" replace />
}
