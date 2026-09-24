/**
 * 插件包一栏（v0.43）——与旧前端 `components/capabilities/PluginPackPanel.vue` 对应。
 *
 * 与相邻那一栏「插件」（协议上是 MCP 服务）的区别，正是这一栏最要紧的事：
 * 那一栏是**连出去的外部服务**，这一栏是**磁盘上的能力包**——
 * 一个目录 + 一份 `plugin.json`，里面按目录约定装技能/命令/钩子/工具四类东西。
 *
 * 四处刻意的设计：
 * 1. **本地市场就是目录**：把路径显示出来，否则"怎么装一个插件"只能靠读文档才会；
 * 2. **加载失败的也列出来，并给出原因**：静默藏掉会让用户以为插件没装上；
 * 3. **四类能力面各自带着"未实现"的说明**（后端的 `status` 原样显示）：
 *    命令、钩子、工具这一轮只列出，界面不能让人以为点了就能跑；
 * 4. **启停只写状态**：后端不碰插件目录，所以这里不提供"删除"。
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, Archive, EllipsisVertical, RefreshCw, Search } from 'lucide-react'

import {
  disablePlugin,
  enablePlugin,
  listPlugins,
  type PluginList,
  type PluginPack,
} from '@/api/plugins'
import { formatCount } from '@/lib/format'
import { useSessionStore } from '@/lib/session'

import { notifyError, notifySuccess } from '../shared/toast'
import { Badge } from '@/ui/badge'
import { Button } from '@/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu'
import { EmptyState, FilterChips, SkeletonBlock, StatusTag } from '../shared/composites'

export const PLUGINS_QUERY_KEY = ['plugins', 'list'] as const

/** 四类能力面的中文名（界面上说人话，kind 是接口里的枚举）。 */
const KIND_LABELS: Record<string, string> = {
  skill: '技能',
  command: '命令',
  hook: '钩子',
  tool: '工具',
}

export interface PackStats {
  total: number
  enabled: number
  failed: number
}

/** 状态栏要的数（页头上那一行由父组件画，所以把数交出去）。 */
export function statsOf(data: PluginList | undefined): PackStats {
  return {
    total: data?.total ?? 0,
    enabled: data?.enabled ?? 0,
    failed: data?.failed ?? 0,
  }
}

function sourceLabel(record: PluginPack): string {
  return record.source === 'builtin' ? '随代码发布' : '放在数据目录'
}

function kindsLabel(record: PluginPack): string {
  return record.kinds.map((kind) => KIND_LABELS[kind] ?? kind).join(' / ')
}

export function PluginPackPanel() {
  const queryClient = useQueryClient()
  const isAdmin = useSessionStore((store) => store.currentUser?.role === 'admin')

  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'enabled' | 'disabled' | 'failed'>('all')
  const [expanded, setExpanded] = useState('')
  const [busy, setBusy] = useState('')

  const list = useQuery({ queryKey: PLUGINS_QUERY_KEY, queryFn: listPlugins })
  const items = list.data?.items ?? []
  const userDir = list.data?.user_dir ?? ''
  const builtinDir = list.data?.builtin_dir ?? ''

  const visible = items.filter((item) => {
    if (filter === 'enabled' && (!item.enabled || !item.loaded)) return false
    if (filter === 'disabled' && item.enabled) return false
    if (filter === 'failed' && item.loaded) return false
    const word = query.trim().toLowerCase()
    if (!word) return true
    return `${item.name} ${item.description}`.toLowerCase().includes(word)
  })

  const filters = [
    { key: 'all' as const, label: '全部', count: items.length },
    {
      key: 'enabled' as const,
      label: '已启用',
      count: items.filter((item) => item.enabled && item.loaded).length,
    },
    {
      key: 'disabled' as const,
      label: '已停用',
      count: items.filter((item) => !item.enabled).length,
    },
    {
      key: 'failed' as const,
      label: '加载失败',
      count: items.filter((item) => !item.loaded).length,
    },
  ]

  const toggle = useMutation({
    mutationFn: (record: PluginPack) =>
      record.enabled ? disablePlugin(record.name) : enablePlugin(record.name),
    onMutate: (record) => setBusy(record.name),
    // 内置插件停用会**记一条屏蔽**（不是删掉）——这件事得说出来，
    // 否则用户会以为"它被我卸了"
    onSuccess: (updated, record) =>
      notifySuccess(updated.enabled ? `已启用「${record.name}」` : `已停用「${record.name}」`),
    onError: (error: unknown) => notifyError(messageOf(error, '启停失败')),
    onSettled: async () => {
      setBusy('')
      await queryClient.invalidateQueries({ queryKey: PLUGINS_QUERY_KEY })
    },
  })

  return (
    <section aria-label="插件包">
      <header className="m-toolbar">
        <label className="m-toolbar-search">
          <Search size={15} />
          <input
            type="search"
            value={query}
            placeholder="搜索插件包"
            aria-label="搜索插件包"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="m-market-actions">
          {/* **本地市场就在这个目录里**：把路径摊在工具栏上，用户才知道东西该放哪 */}
          <code
            className="m-market-dir"
            title={builtinDir ? `内置：${builtinDir}` : '没有内置插件目录'}
          >
            {userDir}
          </code>
          <Button size="sm" disabled={list.isFetching} onClick={() => void list.refetch()}>
            <RefreshCw size={14} />
            重新扫描
          </Button>
        </div>
      </header>

      <FilterChips items={filters} value={filter} onChange={setFilter} ariaLabel="插件包筛选" />
      {list.isLoading && <SkeletonBlock variant="list" rows={3} />}

      {!list.isLoading && visible.length === 0 && (
        <EmptyState
          title={items.length > 0 ? '没有匹配的插件包' : '还没有插件包'}
          hint={
            items.length > 0
              ? '换个关键词，或者把筛选切回「全部」。'
              : `把带 plugin.json 的目录放进 ${userDir}，这里就会列出来。`
          }
        />
      )}

      {visible.length > 0 && (
        <ul className="m-cards">
          {visible.map((record) => (
            <li key={record.name} className="m-card">
              <span className="m-card-icon">
                <Archive size={18} />
              </span>
              <div className="m-card-body">
                <span className="m-card-title">{record.name}</span>
                <p className="m-card-desc">{record.description || '（没有描述）'}</p>
                <div className="m-card-meta">
                  <Badge variant="secondary">{sourceLabel(record)}</Badge>
                  <Badge variant="secondary">{record.version}</Badge>
                  {record.kinds.length > 0 && (
                    <Badge variant="secondary">{kindsLabel(record)}</Badge>
                  )}
                  {!record.loaded ? (
                    <StatusTag label="加载失败" tone="danger" />
                  ) : (
                    <>
                      {!record.enabled && <StatusTag label="已停用" tone="warning" />}
                      {/* 屏蔽（照 ZCode 的标记）：内置的那份被用户停用了，文件还在、
                          列表里也在，只是不会生效——它和"停用"的区别要说出来 */}
                      {record.blocked && <StatusTag label="已屏蔽" tone="warning" />}
                    </>
                  )}
                  {record.user_config.length > 0 && (
                    <Badge variant="secondary" title="manifest 里声明的配置项">
                      配置项 {formatCount(record.user_config.length)}
                    </Badge>
                  )}
                  {record.components.length > 0 && (
                    <Badge asChild variant="secondary">
                      <button
                        type="button"
                        onClick={() => setExpanded(expanded === record.name ? '' : record.name)}
                      >
                        {expanded === record.name
                          ? '收起'
                          : `提供了 ${formatCount(record.components.length)} 项`}
                      </button>
                    </Badge>
                  )}
                </div>

                {/* 加载失败的原因**原样显示**（这是用户唯一能拿到的那一句） */}
                {record.error && (
                  <ul className="m-flags">
                    <li>
                      <AlertCircle size={12} />
                      {record.error}
                    </li>
                  </ul>
                )}
                {record.loaded && <code className="m-card-target">{record.manifest_path}</code>}

                {expanded === record.name && (
                  <ul className="m-pack-parts">
                    {record.components.map((part) => (
                      <li key={`${part.kind}-${part.name}`}>
                        <Badge variant="secondary">{KIND_LABELS[part.kind] ?? part.kind}</Badge>
                        <code>{part.name}</code>
                        {part.path && <span className="m-part-path">{part.path}</span>}
                        <span className="m-part-status">{part.status}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {isAdmin && (
                <div className="m-card-actions">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`${record.name} 的操作`}
                        title={`${record.name} 的操作`}
                      >
                        <EllipsisVertical />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <DropdownMenuItem
                        disabled={busy === record.name}
                        onSelect={() => toggle.mutate(record)}
                      >
                        {record.enabled ? '停用' : '启用'}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}
