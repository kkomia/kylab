/**
 * 设置 ·「知识库连接」一节（M3 阶段 6）——**本机档才渲染**。
 *
 * ## 为什么这一节只有本机档有（一句话，说给用户听）
 *
 * 浏览器 / NAS 网页端那一档，**知识库就是它自己**（进程内检索、本机那几张表），
 * "提供者在不在"没有第二个东西可问；本机档正相反——知识库在**壳里那台 NAS** 上，
 * 于是"连没连上、能力集是什么、这把钥匙看得见哪些库"必须有一处能看、能改。
 *
 * ## 四块内容（方案 §4.1）
 *
 * 1. **地址**：输入 + 保存 + 恢复默认。权威那一处是**壳的 `config.json`**
 *    （`server` + `api_key`，也是长期凭据唯一的落点），这里的地址是一处**覆盖**——
 *    只在"知识库要指到另一台 NAS"时才需要填，留空即回到继承（决策点 D2）；
 * 2. **凭据**：**只读**。凭据只看有没有（`configured` / `missing`），**永不回显**——
 *    它只从引导级来（壳的 `config.json` / 环境变量），本机库里没有、日志里也没有
 *    （方案 §4.2 与 R3）。所以这一块没有输入框，也不打算有；
 * 3. **状态**：`state` / 原因 / 协议版本 / 上次确认时间，外加一颗「测试连接」
 *    （= `refresh=1` 强制重探）。保存地址之后不需要重启边车：提供者**每次调用现取目标**；
 * 4. **库清单**：名字 / 文档数 / 能不能写。不可用时**显示不可用原因**，而不是空清单
 *    ——"看不见任何库"与"根本没连上"是两件完全不同的事。
 *
 * ## 第五块：「本机留了一份」（M4 阶段 6）
 *
 * 本机后端会留一份知识库的**目录性**内容（库列表 / 每库详情 / 文档清单），下次打开知识库页
 * 就先把这一份摆上屏幕、再如实更新。这一块把"留了多少、最近一次是什么时候"**如实说出来**，
 * 并给两颗按钮：**立即刷新**（去 NAS 再确认一次）与**清除**（把留着的清掉）。
 *
 * 两条纪律：
 *
 * - 行数与最近更新读的是后端那一份读数（`GET /local/kb-cache/stats`，与「清除」同一族），
 *   **不是**前端自己数——"留了多少"只有一个答案；
 * - 界面上**不许出现实现语汇**（"缓存"那一类，U2 是硬门禁）：说的永远是"本机留了一份"、
 *   "留着的内容"、"上次看到的内容"。
 *
 * 它随时可以丢掉：**删了只丢速度、不丢数据**（NAS 上那份才是权威）——那句话也写在下面。
 *
 * 最后一句常显的说明回答一个**故意不做的功能**：「哪几个库参与检索由对话里那个开关决定」
 * ——这里不发明第二套"默认库集"，否则同一个问题会有两个答案。
 */
import { useCallback, useEffect, useState } from 'react'

import { clearKbCache, getKbCacheStats, revalidateKbCache, type KbCacheStats } from '@/api/kbCache'
import {
  credentialLabel,
  patchLocalProvider,
  providerDetailLines,
  providerStateLabel,
  useKnowledgeProviderStatus,
} from '@/api/provider'
import { formatCount, formatRelativeTime } from '@/lib/format'

import { ErrorLine, InfoTip, SkeletonBlock, StatusTag } from '../shared/composites'
import { notifyError, notifySuccess } from '../shared/toast'
import { Button } from '@/ui/button'
import { Input } from '@/ui/input'

/** 那一句"哪几个库参与检索"的说明（常显，避免再发明一个"默认库集"概念）。 */
const PICK_NOTE =
  '哪几个库参与检索，由对话输入框上那个「知识库」开关决定——这里只管连接，不设默认库集。'

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
        <p className="m-row-note">
          「知识库连接」只有本机档（桌面壳）才有：这一档的知识库就是它自己， 没有第二个东西可问。
        </p>
      </>
    )
  }

  const unavailable = !provider.ready
  const capabilityLines: string[] = []
  const ingest = provider.capabilities?.ingest
  if (ingest?.max_bytes) {
    capabilityLines.push(`单文件上限 ${Math.round(ingest.max_bytes / (1024 * 1024))}MB`)
  }
  if (ingest?.extensions?.length) {
    capabilityLines.push(`收 ${ingest.extensions.length} 种格式`)
  }
  if (provider.capabilities?.embedding) {
    capabilityLines.push(
      provider.capabilities.embedding.configured ? '向量化已配置' : '向量化未配置（不能建库）',
    )
  }

  return (
    <>
      <h3 className="m-section-title">
        知识库连接
        <InfoTip text="默认就是壳里那台 NAS；除非你在这里填了别的地址。" />
      </h3>

      {/* 还没探过：如实写"正在确认"，不先给一个判断（与顶栏那条同一条口径） */}
      {!provider.settled ? (
        <SkeletonBlock variant="text" rows={2} />
      ) : (
        <>
          {/* ------------------------------------------------------------------ ① 地址 */}
          <div className="m-row">
            <div className="m-row-main">
              <span className="m-row-label">地址</span>
              <span className="m-row-value">{resolved || '（留空 = 用壳里那台 NAS）'}</span>
            </div>
            <StatusTag
              tone={resolved ? 'neutral' : 'warning'}
              label={resolved ? '已设置' : '继承壳'}
            />
          </div>
          <div className="m-edit-form">
            <label className="m-edit-field">
              <span className="m-edit-label">知识库地址（留空 = 恢复默认）</span>
              <Input
                value={address}
                placeholder="http://nas:8000/api/v1"
                aria-label="知识库地址"
                onChange={(event) => setDraft(event.target.value)}
              />
            </label>
            <p className="m-edit-hint">
              默认就是壳里那台 NAS；除非你在这里填了别的地址。填错也没关系——
              保存后立刻重探，状态会如实告诉你连不上。
            </p>
          </div>
          <div className="m-edit-actions">
            <Button disabled={saving} onClick={() => void save('')}>
              恢复默认
            </Button>
            <Button disabled={saving || !edited} onClick={() => void save(address.trim())}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </div>
          {/* ------------------------------------------------------------------ ② 凭据 */}
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
          <p className="m-row-note">
            凭据只从桌面壳那侧来（跟地址不是同一处，也**不会**存在本机库里）—— 要连另一台
            NAS，得先把那台的钥匙交给壳。
          </p>
          {/* ------------------------------------------------------------------ ③ 状态 */}
          <h3 className="m-section-title m-section-gap">状态</h3>
          {unavailable ? (
            <ErrorLine>
              {status
                ? `${providerStateLabel(status.state)}：${status.reason || '（后端没给原因）'}`
                : `读不到：${provider.error || '本机后端没给出原因'}`}
            </ErrorLine>
          ) : null}
          <div className="m-row">
            <div className="m-row-main">
              <span className="m-row-label">连接</span>
              <span className="m-row-value">
                {status ? providerStateLabel(status.state) : '读不到'}
              </span>
            </div>
            <StatusTag
              tone={provider.ready ? 'success' : 'warning'}
              label={provider.ready ? '已连接' : status ? '未连接' : '读不到'}
            />
            <Button disabled={provider.loading} onClick={() => void test()}>
              {provider.loading ? '测试中…' : '测试连接'}
            </Button>
          </div>
          {status?.protocol_version != null ? (
            <div className="m-row">
              <div className="m-row-main">
                <span className="m-row-label">协议版本</span>
                <span className="m-row-value">
                  {status.protocol_version}
                  {status.app_version ? `（对面应用 ${status.app_version}）` : ''}
                </span>
              </div>
            </div>
          ) : null}
          <div className="m-row">
            <div className="m-row-main">
              <span className="m-row-label">上次确认</span>
              <span className="m-row-value">
                {status?.checked_at ? formatRelativeTime(status.checked_at) : '还没探过'}
              </span>
            </div>
          </div>{' '}
          {capabilityLines.length > 0 ? (
            <div className="m-row">
              <div className="m-row-main">
                <span className="m-row-label">这台提供者能做</span>
                <span className="m-row-value">{capabilityLines.join(' · ')}</span>
              </div>
            </div>
          ) : null}
          {/* ------------------------------------------------------------------ ④ 库清单 */}
          <h3 className="m-section-title m-section-gap">看得见的库</h3>
          {/* 不可用时**显示原因**：空清单会被读成"一个库都没有"（两件事完全不同） */}
          {unavailable ? (
            <p className="m-row-note">
              {provider.reason || provider.error || '连不上，所以现在看不到任何库。'}
            </p>
          ) : provider.knowledgeBases.length === 0 ? (
            <p className="m-row-note">
              这把凭据在这台提供者上看得见 0 个库（受限的钥匙只会看到范围内的）。
            </p>
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
          <p className="m-row-note">{PICK_NOTE}</p>
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
          <p className="m-row-note">
            这台机器上留着一份知识库的目录（库、每库的详情、文档清单这些目录性质的内容），
            下次打开知识库页会先把这一份摆上屏幕、再如实更新。它随时可以丢掉——
            <strong>删了只影响下次打开的速度，不影响 NAS 上的数据</strong>。
          </p>
          {/* 排障那一眼（地址 / 协议版本 / 库数 / 上次确认）：与顶栏那条状态条同一份口径 */}
          {status ? (
            <p className="m-row-note" data-testid="provider-detail">
              {providerDetailLines(status).join('；')}
            </p>
          ) : null}
        </>
      )}
    </>
  )
}
