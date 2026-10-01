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
 * 最后一句常显的说明回答一个**故意不做的功能**：「哪几个库参与检索由对话里那个开关决定」
 * ——这里不发明第二套"默认库集"，否则同一个问题会有两个答案。
 */
import { useState } from 'react'

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
