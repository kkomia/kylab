/**
 * 顶栏那条「我的数据在哪」（M2 阶段 4）。
 *
 * ## 为什么要有它（产品理由，不是装饰）
 *
 * 从 M2 起，**会话 / 笔记 / 设置 / 模型注册 / 工作区 / 定时任务 / MCP / 记忆** 的主人
 * 变成了**这台机器**（边车进程里的本机 SQLite）。"我的东西在哪儿"于是在三处会长得
 * 一模一样、却完全不同：本机库、服务器库、以及被显式关掉时走的服务器那条链。
 * 方案 §4.3 把"**回退必须可见、不许静默**"写成纪律，这条状态条就是那个落点：
 * 用户不该靠猜（"我的会话是不是丢了？"），排障的人也不该只能翻控制台。
 *
 * ## 三态（`localStatus()` 的 `kind`，与 `reason` 一样来自一处判定）
 *
 * | 显示 | 什么时候 | 顶栏那句话 |
 * | --- | --- | --- |
 * | **本机** | 壳里问到了边车、`/health` 也通 | 打的是哪个基址（端口顺延也看得见） |
 * | **服务器** | `VITE_LOCAL_DATA=0` 显式关；或**浏览器里**（本机后端由桌面壳提供，那一档不成立） | 是哪个变量关的 / 为什么这一档不成立 |
 * | **本机后端未启动** | 壳在、边车却没起来（这时本机权威面**如实报错，不换源**） | 原因 + "会话数据在本机，未回退服务器" |
 *
 * 三种都**一直摆在顶栏上**（不是只在出错时才冒出来）：数据在哪是这一档最要紧的
 * 一件事，而"平时看不见、出事才出现"的提示，用户第一次看到时已经是坏消息了。
 *
 * ## 两个细节
 *
 * 1. **显式关掉时根本不探边车**：探了也没用（那一档已经不用了），白打一次请求；
 * 2. 「重试」只在不可用态出现：那是唯一一种"再试一次可能就好了"的情形
 *    （边车刚起来 / 用户刚把壳重启过）。
 *
 * ## 第二行：导入那三笔账（M2 阶段 6）
 *
 * 本机后端活着的时候，这条状态条**再读一次** `GET /local/status`，把三件事写出来
 * （阶段 5 登记过：这三项不进服务器档的 OpenAPI，所以类型是手写的，见 `api/local.ts`）：
 *
 * - `imports`：最近几批各是什么状态、新建了多少条；
 * - `unfinished_imports`：**有几笔没跑完**——这一项才是真正要显眼的（R1：断电/被杀
 *   之后的残留批次，可重跑续上；不说，用户只会看到"我的会话少了一半"）；
 * - `unimported_file_references`：最近一批里**没随导入过来的文件引用数**（R4）——
 *   不说这个数，用户会以为文件也搬过来了。
 *
 * 读不到就**如实写一行**（"本机状态读不到"）：那时本机后端明明在跑，
 * 读不到状态是异常，静默藏起来等于把排障线索删了。
 */
import { useCallback, useEffect, useState } from 'react'

import { batchStateLabel, getLocalStatus, importAccountsText, type LocalStatus } from '@/api/local'
import {
  ensureLocalBase,
  localAvailable,
  localDataEnabled,
  localStatus,
  type LocalDataStatus,
} from '@/api/sidecar'

/** 三态的人话名字。 */
const LABELS: Record<LocalDataStatus['kind'], string> = {
  local: '本机',
  server: '服务器',
  unavailable: '本机后端未启动',
}

/** 三态的颜色点（用主题里的语义色，不硬编码色值）。 */
const DOTS: Record<LocalDataStatus['kind'], string> = {
  local: 'bg-[var(--status-success)]',
  server: 'bg-[var(--text-quaternary)]',
  unavailable: 'bg-[var(--status-danger)]',
}

/**
 * 读那三笔账（`/local/status`）：**读不到也要留下一句话**（不静默）。
 *
 * 抽成纯函数式的一小段是为了让"读不到"那条路只有一个出口：组件里两处
 * （首次探活、那颗「重试」）用的是同一份，而两处各写一遍必然有一处忘了写错误。
 */
async function readAccounts(): Promise<{ accounts: LocalStatus | null; error: string }> {
  try {
    return { accounts: await getLocalStatus(), error: '' }
  } catch (error) {
    return { accounts: null, error: error instanceof Error ? error.message : String(error) }
  }
}

export function LocalDataStrip() {
  const [status, setStatus] = useState<LocalDataStatus>(() => localStatus())
  const [busy, setBusy] = useState(false)
  /** 本机档那三笔账（`GET /local/status`）；`null` = 还没读到/读不到，`error` 单独放。 */
  const [accounts, setAccounts] = useState<LocalStatus | null>(null)
  const [accountsError, setAccountsError] = useState('')

  const refresh = useCallback(async (force: boolean) => {
    if (!localDataEnabled()) {
      // 显式关：**不去探**（见文件头第 1 条）。状态照样给出来 —— 这就是"不许静默"
      setStatus(localStatus())
      setAccounts(null)
      setAccountsError('')
      return
    }
    setBusy(true)
    try {
      // 先问壳要基址、再探一次活：两步都是幂等的（`ensureLocalBase` 只问一次）
      await ensureLocalBase({ force })
      // 本机后端活着才读那三笔账：不可用时 `/local/status` 只会再报一次同样的错
      const outcome = (await localAvailable({ force }))
        ? await readAccounts()
        : { accounts: null, error: '' }
      setAccounts(outcome.accounts)
      setAccountsError(outcome.error)
    } finally {
      setBusy(false)
      setStatus(localStatus())
    }
  }, [])

  useEffect(() => {
    void refresh(false)
  }, [refresh])

  // 还没探完时**不猜**（与 `localStatus()` 同一条口径）：说"确认中"，不是先说"本机"再改口
  const label =
    status.kind === 'local' && status.available === null ? '本机（确认中）' : LABELS[status.kind]

  return (
    <div
      role="status"
      aria-live="polite"
      data-kind={status.kind}
      // 完整原因放 `title`：这一条要能截断（一行），但**一个字都不许丢**
      title={[status.reason, accounts ? accountsTitle(accounts) : '', accountsError]
        .filter(Boolean)
        .join('\n')}
      className="mt-[6px] mr-[6px] flex flex-col gap-0.5 px-3 text-[length:var(--text-meta-size)] text-text-secondary"
    >
      <div className="flex min-h-7 items-center gap-2">
        <span
          className={`size-1.5 shrink-0 rounded-full ${DOTS[status.kind]}`}
          aria-hidden="true"
        />
        <span className="shrink-0 font-medium text-text-primary">{label}</span>
        <span className="min-w-0 truncate text-text-tertiary">{status.reason}</span>
        {status.kind === 'unavailable' && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void refresh(true)}
            className="shrink-0 cursor-pointer rounded-control px-1.5 py-0.5 text-text-secondary transition-colors hover:bg-[var(--bg-hover)] hover:text-text-primary disabled:opacity-60"
          >
            {busy ? '重试中…' : '重试'}
          </button>
        )}
      </div>
      {/*
        第二行只有**本机后端活着**时才有内容（见文件头的"第二行"那一段）：
        没跑完的批次与未随导入的文件引用是这个档位最要紧的两笔账。
      */}
      {accounts ? (
        <div
          data-testid="local-import-accounts"
          title={accountsTitle(accounts)}
          className="min-w-0 truncate pl-[14px] text-[length:var(--text-micro-size)] text-text-tertiary"
        >
          {importAccountsText(accounts)}
        </div>
      ) : null}
      {accountsError ? (
        <div
          data-testid="local-import-accounts-error"
          className="min-w-0 truncate pl-[14px] text-[length:var(--text-micro-size)] text-[var(--status-danger)]"
        >
          本机状态读不到：{accountsError}
        </div>
      ) : null}
    </div>
  )
}

/** 悬停看到的那些**排障细节**（库路径 / WAL / 来源 / 每一批的 id 与错误）。 */
function accountsTitle(status: LocalStatus): string {
  const lines = [
    `库：${status.database}${status.database_exists ? '' : '（还没建出来）'}`,
    `数据目录：${status.data_dir}`,
    `这一档接的远端：${status.server_url || '（没接）'}`,
  ]
  for (const batch of status.imports) {
    const error = batch.error ? `；错误：${batch.error}` : ''
    lines.push(
      `批次 ${batch.batch_id}：${batchStateLabel(batch.state)}；来源 ${batch.source}${error}`,
    )
  }
  lines.push(status.note)
  return lines.join('\n')
}
