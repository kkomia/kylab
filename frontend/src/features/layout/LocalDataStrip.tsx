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
 */
import { useCallback, useEffect, useState } from 'react'

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

export function LocalDataStrip() {
  const [status, setStatus] = useState<LocalDataStatus>(() => localStatus())
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (force: boolean) => {
    if (!localDataEnabled()) {
      // 显式关：**不去探**（见文件头第 1 条）。状态照样给出来 —— 这就是"不许静默"
      setStatus(localStatus())
      return
    }
    setBusy(true)
    try {
      // 先问壳要基址、再探一次活：两步都是幂等的（`ensureLocalBase` 只问一次）
      await ensureLocalBase({ force })
      await localAvailable({ force })
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
      title={status.reason}
      className="mt-[6px] mr-[6px] flex min-h-7 items-center gap-2 px-3 text-[length:var(--text-meta-size)] text-text-secondary"
    >
      <span className={`size-1.5 shrink-0 rounded-full ${DOTS[status.kind]}`} aria-hidden="true" />
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
  )
}
