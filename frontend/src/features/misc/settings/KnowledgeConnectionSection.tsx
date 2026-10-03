/**
 * 设置 ·「知识库连接」一节（M3 阶段 6）——**本机档才渲染**。
 *
 * 浏览器 / NAS 网页端那一档，**知识库就是它自己**（进程内检索、本机那几张表），
 * "提供者在不在"没有第二个东西可问；本机档正相反——知识库在**壳里那台 NAS** 上，
 * 于是"连没连上、这把钥匙看得见哪些库"必须有一处能看、能改。
 *
 * ## 版式：三行说清（R5 起按产品化整改，见 `misc-settings` 的门禁）
 *
 * ```
 * 连接   <状态人话>   上次确认 · 刚刚 · 协议 v1   [已连接] [测试连接]
 * 地址   <当前地址>                                [已设置]
 * 凭据   <已配置/未配置>                            [已配置]
 * ```
 *
 * 三条纪律（这一节曾被用户点名"解释太多、很草台"）：
 *
 * 1. **零段落文字**：不再有 `m-row-note` / `m-edit-hint` 那种成句的说明；
 *    "留空 = 用壳里那台"这类**填法**写在标签上，"上次确认 / 协议版本"这类**技术读数**
 *    降成状态行里的小字；
 * 2. **只用设置里既有的行/节规范**（`m-row` / `m-edit-*` / `m-section-title`），
 *    不为这一页现造组件或样式；
 * 3. **状态与代价照旧如实说**：连不上时后端那句原因原样摆出来（`ErrorLine`），
 *    值读不到就说读不到（不摆 0、不摆猜测）。
 *
 * 行为一个字没动：地址可改可恢复默认、保存后后端立刻重探、测试连接 = `refresh=1` 强制重探、
 * 「本机留了一份」那两颗按钮照旧（`GET|POST /local/kb-cache/*`）。
 *
 * ## 第五块：「本机留了一份」（M4 阶段 6）
 *
 * 本机后端会留一份知识库的**目录性**内容（库列表 / 每库详情 / 文档清单），下次打开知识库页
 * 就先把这一份摆上屏幕、再如实更新。这一块把"留了多少、最近一次是什么时候"如实说出来，
 * 并给两颗按钮：**立即刷新**（去 NAS 再确认一次）与**清除**（把留着的清掉）。
 *
 * 行数与最近更新读的是后端那一份读数（`GET /local/kb-cache/stats`）——"留了多少"只有一个答案。
 * 界面上**不许出现实现语汇**（"缓存"那一类，U2 是硬门禁）：说的永远是"本机留了一份"、
 * "留着的内容"、"上次看到的内容"。
 */
import { useCallback, useEffect, useState } from 'react'

import { clearKbCache, getKbCacheStats, revalidateKbCache, type KbCacheStats } from '@/api/kbCache'
import {
  credentialLabel,
  patchLocalProvider,
  providerStateLabel,
  useKnowledgeProviderStatus,
} from '@/api/provider'
import { formatCount, formatRelativeTime } from '@/lib/format'

import { ErrorLine, SkeletonBlock, StatusTag } from '../shared/composites'
import { notifyError, notifySuccess } from '../shared/toast'
import { Button } from '@/ui/button'
import { Input } from '@/ui/input'

export function KnowledgeConnectionSection() {
  const provider = useKnowledgeProviderStatus()
  /** 输入框里那一份；`null` = 还没动过，跟着后端回的地址走（保存后自动回到这个状态）。 */
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  /** 「本机留了一份」那一块：读数 / 读过没有 / 两颗按钮的在飞状态。 */
  const [kept, setKept] = useState<KbCacheStats | null>(null)
  const [keptRead, setKeptRead] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [clearing, setClearing] = useState(false)

  const status = provider.status
  /** 后端解析后的实际地址（空 = 没配，正在继承壳里那台）。 */
  const resolved = status?.base_url ?? ''
  const address = draft ?? resolved
  const edited = draft !== null && draft.trim() !== resolved

  /**
   * 保存 / 恢复默认都是同一条 PATCH（空串 = 清掉覆盖、回继承）。
   *
   * 后端写完**立刻重探**并把最新状态整个回给我们，本模块再广播一次——于是
   * "地址填错"当场就看得出来（状态变 `unavailable` + 原因），侧栏那一组也跟着动。
   */
  async function save(baseUrl: string): Promise<void> {
    setSaving(true)
    try {
      const next = await patchLocalProvider({ base_url: baseUrl })
      setDraft(null)
      notifySuccess(
        next.available
          ? `已保存，连接正常（${next.base_url}）`
          : `已保存，但当前${providerStateLabel(next.state)}：${next.reason || '原因见面板'}`,
      )
    } catch (cause) {
      notifyError(cause instanceof Error ? cause.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  /** 「测试连接」= 强制重探一次（缓存里的旧结论不算数）。 */
  async function test(): Promise<void> {
    await provider.refresh()
    const fresh = provider.status
    if (fresh?.available) notifySuccess(`连接正常（${fresh.base_url}）`)
    else notifyError(`还连不上：${fresh?.reason || provider.error || '原因见面板'}`)
  }

  /**
   * 读一次"本机留了多少"（`GET /local/kb-cache/stats`）。
   *
   * 这一读是**纯请求**（不写模块状态）：它只服务这一块的两行字（几项 / 最近更新）。
   * 读到 `null` 时 `keptRead` 仍然置真——"读不到"与"还没读"在界面上是两句不同的话
   * （与凭据那一行同一条口径）。
   */
  const readKept = useCallback(async (): Promise<void> => {
    setKept(await getKbCacheStats())
    setKeptRead(true)
  }, [])

  useEffect(() => {
    void readKept()
  }, [readKept])

  /**
   * 「立即刷新」：去 NAS 再确认一次，把本机留的那一份换上最新的，然后重读数字。
   *
   * 为什么是**库列表**那一份：它是这一页的入口内容（"看得见的库"），而且后端确认它时会
   * 顺带把每个库的详情按同一份内容拆开写（§3.1）——一次动作更新的是最要紧的那一片。
   * 结果按**如实三态**说：没答上来 / 还是没有新鲜的 / 已刷新。内容没变时时间戳不会动，
   * 那是"确认过还是那份"，不是失败（§4.1）。
   */
  async function refreshKept(): Promise<void> {
    setRefreshing(true)
    try {
      const snapshot = await revalidateKbCache({ resource: 'kb_list' })
      if (!snapshot) notifyError('刷新失败：本机后端没答上来')
      else if (snapshot.stale) notifyError(`还是连不上：${snapshot.last_error || '原因见上面'}`)
      else if (!snapshot.available) notifyError(snapshot.reason || '现在没有可刷新的内容')
      else notifySuccess('已去 NAS 确认一次')
      await readKept()
    } finally {
      setRefreshing(false)
    }
  }

  /** 「清除」：把本机留的那一份清掉（**全清**）。清完重读数字，界面上那个数当场归零。 */
  async function clearKept(): Promise<void> {
    setClearing(true)
    try {
      const removed = await clearKbCache()
      notifySuccess(removed > 0 ? `已清掉 ${removed} 项` : '本来就没有留')
      await readKept()
    } catch (cause) {
      // 清除失败要说出来：静默失败会让用户以为"清干净了"（这也是这条链唯一会抛的一条）
      notifyError(cause instanceof Error ? cause.message : '清除失败')
    } finally {
      setClearing(false)
    }
  }

  // 防御性的一层：服务器档里这一节不该被渲染（菜单也不会给它入口）。
  // 真被渲染了也要**说清为什么**，而不是摆一堆读不到的字段。
  if (!provider.gate) {
    return (
      <>
        <h3 className="m-section-title">知识库连接</h3>
        <p className="m-row-note">「知识库连接」只有本机档（桌面壳）才有。</p>
      </>
    )
  }

  const unavailable = !provider.ready

  return (
    <>
      <h3 className="m-section-title">知识库连接</h3>

      {/* 还没探过：如实写"正在确认"，不先给一个判断 */}
      {!provider.settled ? (
        <SkeletonBlock variant="text" rows={2} />
      ) : (
        <>
          {/* ------------------------------------------------------------------ ① 状态
              一行说完三件事：连没连上（值 + badge）、上次什么时候确认的（小字，技术味重的
              协议版本也降到这里）、当场测一次（按钮）。 */}
          <div className="m-row" data-testid="provider-status">
            <div className="m-row-main">
              <span className="m-row-label">连接</span>
              <span className="m-row-value">
                {status ? providerStateLabel(status.state) : '读不到'}
              </span>
            </div>
            <span className="m-row-value">
              {status?.checked_at
                ? `上次确认 · ${formatRelativeTime(status.checked_at)}`
                : '还没探过'}
              {status?.protocol_version != null ? ` · 协议 v${status.protocol_version}` : ''}
            </span>
            <StatusTag
              tone={provider.ready ? 'success' : 'warning'}
              label={provider.ready ? '已连接' : status ? '未连接' : '读不到'}
            />
            <Button disabled={provider.loading} onClick={() => void test()}>
              {provider.loading ? '测试中…' : '测试连接'}
            </Button>
          </div>
          {/* 连不上时把后端那句原因原样摆出来（不静默） */}
          {unavailable ? (
            <ErrorLine>
              {status
                ? status.reason || '（后端没给原因）'
                : `读不到：${provider.error || '本机后端没给出原因'}`}
            </ErrorLine>
          ) : null}

          {/* ------------------------------------------------------------------ ② 地址 */}
          <div className="m-row">
            <div className="m-row-main">
              <span className="m-row-label">地址</span>
              <span className="m-row-value">{resolved || '壳里那台 NAS'}</span>
            </div>
            <StatusTag
              tone={resolved ? 'neutral' : 'warning'}
              label={resolved ? '已设置' : '继承壳'}
            />
          </div>
          <div className="m-edit-form">
            <label className="m-edit-field">
              {/* 「留空 = …」是**这一格的填法**，写在标签上（不另起一句解释） */}
              <span className="m-edit-label">知识库地址（留空 = 用壳里那台）</span>
              <Input
                value={address}
                placeholder="http://nas:8000/api/v1"
                aria-label="知识库地址"
                onChange={(event) => setDraft(event.target.value)}
              />
            </label>
          </div>
          <div className="m-edit-actions">
            <Button disabled={saving} onClick={() => void save('')}>
              恢复默认
            </Button>
            <Button disabled={saving || !edited} onClick={() => void save(address.trim())}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </div>

          {/* ------------------------------------------------------------------ ③ 凭据 */}
          <div className="m-row">
            <div className="m-row-main">
              <span className="m-row-label">凭据</span>
              {/* **读不到就说读不到**：没结论时"未配置"是一句猜测（凭据有没有要看后端） */}
              <span className="m-row-value">
                {status ? credentialLabel(status.credential ?? 'missing') : '（还没读到）'}
              </span>
            </div>
            <StatusTag
              tone={status?.credential === 'configured' ? 'success' : 'warning'}
              label={status?.credential === 'configured' ? '已配置' : status ? '未配置' : '读不到'}
            />
          </div>

          {/* ------------------------------------------------------------------ ④ 库清单 */}
          <h3 className="m-section-title m-section-gap">看得见的库</h3>
          {/* 不可用时**显示原因**：空清单会被读成"一个库都没有"（两件事完全不同）。
              原因只在那条 ErrorLine 上说一遍（就在上面一行），这里不再重复那句话。 */}
          {unavailable ? (
            <p className="m-row-note">连不上，所以现在看不到任何库。</p>
          ) : provider.knowledgeBases.length === 0 ? (
            <p className="m-row-note">这把凭据在这台提供者上看不见任何库。</p>
          ) : (
            <ul className="m-user-list">
              {provider.knowledgeBases.map((kb) => (
                <li key={kb.id} className="m-user-row">
                  <span className="m-user-main">
                    <span className="m-user-name">{kb.name}</span>
                    <span className="m-user-meta">
                      {formatCount(kb.document_count ?? 0)} 篇文档
                      {kb.last_activity ? (
                        <>
                          <span className="sep">·</span>
                          最近 {formatRelativeTime(kb.last_activity)}
                        </>
                      ) : null}
                    </span>
                  </span>
                  <StatusTag
                    tone={kb.can_write ? 'success' : 'neutral'}
                    label={kb.can_write ? '可写' : '只读'}
                  />
                </li>
              ))}
            </ul>
          )}
          {/* ------------------------------------------------------------------ ⑤ 本机留了一份 */}
          <h3 className="m-section-title m-section-gap">本机留了一份</h3>
          <div className="m-row" data-testid="kept-snapshot-row">
            <div className="m-row-main">
              <span className="m-row-label">留着的内容</span>
              {/* 读不到就说读不到（与凭据那一行同一条口径）：静默摆一个 0 会被读成"本机没留东西" */}
              <span className="m-row-value">
                {!keptRead ? '读取中…' : kept ? `${formatCount(kept.rows)} 项` : '读不到'}
              </span>
            </div>
            <div className="m-row-main">
              <span className="m-row-label">最近更新</span>
              <span className="m-row-value">
                {!keptRead
                  ? '读取中…'
                  : kept?.newest_fetched_at
                    ? formatRelativeTime(kept.newest_fetched_at)
                    : '还没有'}
              </span>
            </div>
            <Button disabled={refreshing} onClick={() => void refreshKept()}>
              {refreshing ? '刷新中…' : '立即刷新'}
            </Button>
            <Button disabled={clearing} onClick={() => void clearKept()}>
              {clearing ? '清除中…' : '清除'}
            </Button>
          </div>
        </>
      )}
    </>
  )
}
