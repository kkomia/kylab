/**
 * 技能市场（v0.27）——与旧前端 `components/capabilities/SkillMarketDialog.vue` 对应。
 *
 * 一件被调研钉死的事：**没有统一的技能市场协议**（`SKILL.md` 是事实标准，
 * 但分发各家一台自己的插件市场）。所以这里的"市场"不是某个站点，
 * 而是**一组 GitHub 仓库**——浏览 = 递归找仓库里所有 SKILL.md，
 * 装 = 按 commit SHA 把那个技能目录整个取下来。
 *
 * 五处刻意的设计：
 * 1. **弹窗，不是新页面**。逛市场是"找一样东西然后回来"；
 * 2. **两级：清单 → 详情**，在同一个弹窗里切换。详情是调研 §4.6 的硬要求：
 *    skill 目录里的 `scripts/` 是**会被执行的代码**，装之前必须摊开给人看；
 * 3. **装之前一定先看清单**：`scripts/`、hooks 这类文件标成「代码」并单独提示，
 *    而按钮上写的是这个版本（短 SHA）——分支会在两步之间变；
 * 4. **源是一等公民**：内置的 + 用户自己粘的仓库，都能启停、删得掉（内置的只能停用）；
 * 5. **报错要给出下一步**：GitHub 的匿名配额是 60 次/小时，撞上了要说
 *    "等一会儿或配 KYLAB_GITHUB_TOKEN"，而不是把 HTTP 403 甩给用户。
 */
import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  Archive,
  Check,
  ChevronLeft,
  Folder,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react'

import {
  addSkillSource,
  browseSkillSource,
  deleteSkillSource,
  inspectMarketSkill,
  installMarketSkill,
  listSkillSources,
  setSkillSourceEnabled,
  uploadSkill,
  type MarketSkill,
  type SkillSource,
} from '@/api/capabilities'

import { notifySuccess } from '../shared/toast'
import {
  Button,
  EmptyState,
  Modal,
  Select,
  SkeletonBlock,
  StatusTag,
  TextInput,
} from '../shared/ui'

const SOURCES_QUERY_KEY = ['skills', 'market', 'sources'] as const

type View = 'list' | 'detail' | 'sources'

const KIND_LABELS: Record<string, string> = { code: '代码', doc: '文本', asset: '资源' }

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 列表与详情上显示哪一句：**中文优先**（英文描述对中文用户等于没有）。 */
function blurb(item: { description: string; summary?: string }): string {
  return item.summary?.trim() || item.description
}

export function SkillMarketDialog({
  open,
  onClose,
  onInstalled,
}: {
  open: boolean
  onClose: () => void
  onInstalled: () => void
}) {
  const queryClient = useQueryClient()

  const [view, setView] = useState<View>('list')
  const [sourceId, setSourceId] = useState('')
  const [skills, setSkills] = useState<MarketSkill[]>([])
  const [cached, setCached] = useState(true)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [inspecting, setInspecting] = useState('')
  /** 出错时就地显示（不是一闪而过的 toast）：这里的错误大多带"下一步怎么做"。 */
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [bundle, setBundle] = useState<Awaited<ReturnType<typeof inspectMarketSkill>> | null>(null)

  const [newRepo, setNewRepo] = useState('')
  const [addingSource, setAddingSource] = useState(false)
  const [uploading, setUploading] = useState(false)
  const folderInput = useRef<HTMLInputElement | null>(null)
  const zipInput = useRef<HTMLInputElement | null>(null)

  const sources = useQuery({
    queryKey: SOURCES_QUERY_KEY,
    queryFn: async () => (await listSkillSources()).items,
    enabled: open,
  })
  const allSources: SkillSource[] = sources.data ?? []
  const enabledSources = allSources.filter((item) => item.enabled)
  const currentSource = allSources.find((item) => item.id === sourceId) ?? null
  const sourceOptions = enabledSources.map((item) => ({
    value: item.id,
    label: `${item.name} · ${item.repo}`,
  }))

  const visibleSkills = (() => {
    const word = query.trim().toLowerCase()
    if (!word) return skills
    return skills.filter((item) => `${item.name} ${item.description}`.toLowerCase().includes(word))
  })()
  const installedCount = skills.filter((item) => item.installed).length

  async function loadSkills(source: string, refresh: boolean): Promise<void> {
    if (!source) return
    if (refresh) setRefreshing(true)
    else setLoading(true)
    setError('')
    try {
      const result = await browseSkillSource(source, refresh)
      setSkills(result.items)
      setCached(result.cached)
    } catch (failure) {
      setSkills([])
      setError(messageOf(failure, '浏览失败'))
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  function pickSource(value: string): void {
    setSourceId(value)
    setQuery('')
    void loadSkills(value, false)
  }

  /**
   * 打开时（或首次拿到源列表时）装载：默认选**第一个还开着的源**，
   * 然后直接浏览它——用户点开市场是想看"有什么"，不是想先做一次选择。
   */
  useEffect(() => {
    if (!open) return
    setView('list')
    setQuery('')
    setBundle(null)
    setError('')
  }, [open])

  useEffect(() => {
    if (!open || allSources.length === 0) return
    const currentOk = allSources.some((item) => item.id === sourceId && item.enabled)
    if (currentOk) return
    const next = enabledSources[0]?.id ?? ''
    if (next) pickSource(next)
    else setSourceId('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, allSources])

  const addSource = useMutation({
    mutationFn: (repo: string) => addSkillSource(repo),
    onSuccess: async (source) => {
      setNewRepo('')
      await queryClient.invalidateQueries({ queryKey: SOURCES_QUERY_KEY })
      pickSource(source.id)
      notifySuccess(`已添加源「${source.repo}」`)
    },
    onError: (failure: unknown) => setError(messageOf(failure, '添加失败')),
  })

  const toggleSource = useMutation({
    mutationFn: (source: SkillSource) => setSkillSourceEnabled(source.id, !source.enabled),
    onSuccess: async (_result, source) => {
      // 停用的正好是当前这个：换到还开着的第一个，免得停在一个"已经不在下拉里"的源上
      const wasCurrentAndOn = source.id === sourceId && source.enabled
      await queryClient.invalidateQueries({ queryKey: SOURCES_QUERY_KEY })
      if (wasCurrentAndOn) {
        const next = allSources.find((item) => item.enabled && item.id !== source.id)?.id ?? ''
        pickSource(next)
      }
    },
    onError: (failure: unknown) => setError(messageOf(failure, '操作失败')),
  })

  const removeSource = useMutation({
    mutationFn: (source: SkillSource) => deleteSkillSource(source.id),
    onSuccess: async (_result, source) => {
      await queryClient.invalidateQueries({ queryKey: SOURCES_QUERY_KEY })
      if (source.id === sourceId) {
        pickSource(allSources.find((item) => item.enabled && item.id !== source.id)?.id ?? '')
      }
      notifySuccess('已删除这个源')
    },
    onError: (failure: unknown) => setError(messageOf(failure, '删除失败')),
  })

  async function openDetail(skill: MarketSkill): Promise<void> {
    setInspecting(skill.path)
    setBundle(null)
    setError('')
    setView('detail')
    try {
      setBundle(await inspectMarketSkill(skill.source_id, skill.path))
    } catch (failure) {
      setError(messageOf(failure, '读取文件清单失败'))
    } finally {
      setInspecting('')
    }
  }

  const install = useMutation({
    mutationFn: (target: { sourceId: string; path: string }) =>
      installMarketSkill(target.sourceId, target.path),
    onMutate: () => setInstalling(true),
    onSuccess: (record, target) => {
      setSkills((current) =>
        current.map((item) => (item.path === target.path ? { ...item, installed: true } : item)),
      )
      notifySuccess(`已安装「${record.name}」`)
      onInstalled()
      setView('list')
      setBundle(null)
    },
    onError: (failure: unknown) => setError(messageOf(failure, '安装失败')),
    onSettled: () => setInstalling(false),
  })

  /**
   * 选文件夹：浏览器把**每个文件**连同它的相对路径（`webkitRelativePath`）一起给出来。
   *
   * 相对路径要一起上行：技能的目录结构（`scripts/`、`references/`）是它的一部分，
   * 只传文件名会把它们全平铺到根下。
   */
  async function runUpload(files: File[], paths: string[]): Promise<void> {
    if (uploading) return
    setUploading(true)
    setError('')
    try {
      const record = await uploadSkill(files, paths)
      notifySuccess(`已添加「${record.name}」`)
      onInstalled()
      // 装完就关上：用户的目的是"把它加进来"，加完该看到的是能力页上那一张卡片
      onClose()
    } catch (failure) {
      setError(messageOf(failure, '上传失败'))
    } finally {
      setUploading(false)
    }
  }

  const pickFolder = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files
    if (!picked || picked.length === 0) return
    const files = Array.from(picked)
    void runUpload(
      files,
      files.map(
        (file) => (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
      ),
    )
    event.target.value = ''
  }

  const pickZip = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files
    if (!picked || picked.length === 0) return
    void runUpload(Array.from(picked), [])
    event.target.value = ''
  }

  return (
    <Modal
      open={open}
      title="添加技能"
      onClose={onClose}
      size="wide"
      height="full"
      footer={
        view !== 'detail' ? (
          <Button onClick={onClose}>关闭</Button>
        ) : (
          <>
            <Button
              onClick={() => {
                setView('list')
                setBundle(null)
              }}
            >
              返回
            </Button>
            <Button
              variant="primary"
              icon={<Check size={14} />}
              disabled={!bundle || installing}
              onClick={() =>
                bundle && install.mutate({ sourceId: bundle.source_id, path: bundle.path })
              }
            >
              {installing ? '安装中…' : '安装'}
            </Button>
          </>
        )
      }
    >
      {/* 顶部一行：选源（左）+ 动作（右）。**与技能页那条工具行同一条起始线** */}
      <div className="m-market-bar">
        {sourceOptions.length > 0 ? (
          <span className="m-source-pick">
            <Select
              value={sourceId}
              onValueChange={pickSource}
              options={sourceOptions}
              label="技能源"
            />
          </span>
        ) : (
          <span className="m-market-hint">
            还没有启用的源——先添加一个仓库，或到「管理源」里打开。
          </span>
        )}
        <div className="m-market-actions">
          <Button size="sm" onClick={() => setView(view === 'sources' ? 'list' : 'sources')}>
            {view === 'sources' ? '返回清单' : `管理源 ${allSources.length}`}
          </Button>
          {view !== 'sources' && sourceId && (
            <Button
              size="sm"
              disabled={refreshing}
              icon={<RefreshCw size={14} />}
              onClick={() => void loadSkills(sourceId, true)}
            >
              {refreshing ? '刷新中…' : '刷新'}
            </Button>
          )}
        </div>
      </div>

      {currentSource && view !== 'sources' && (
        <p className="m-source-note">
          {currentSource.why || currentSource.repo}
          {cached ? (
            <span> · 用的是缓存（几小时内不会重复请求 GitHub）</span>
          ) : (
            <span> · 刚从 GitHub 拉的最新清单</span>
          )}
        </p>
      )}

      {/* 错误**就地显示**：这里的错误大多带下一步（配 token、换个源、稍后再试） */}
      {error && (
        <p className="m-market-error" role="alert">
          <AlertCircle size={14} />
          {error}
        </p>
      )}

      {view === 'sources' && (
        <>
          {/* 从本地添加（v0.28）：文件夹或压缩包。
              压缩包那条路给 Firefox 用户留着（`webkitdirectory` 只有 Chromium 系支持） */}
          <div className="m-local-add">
            <span className="m-local-title">从本机添加</span>
            <div className="m-local-actions">
              <Button
                size="sm"
                disabled={uploading}
                icon={<Folder size={14} />}
                onClick={() => folderInput.current?.click()}
              >
                {uploading ? '添加中…' : '选文件夹'}
              </Button>
              <Button
                size="sm"
                disabled={uploading}
                icon={<Archive size={14} />}
                onClick={() => zipInput.current?.click()}
              >
                选压缩包
              </Button>
              {/* 两个 input 藏在按钮后面：`webkitdirectory` 那个是**选目录**的唯一办法
                  （浏览器不给别的入口），而它只有 Chromium 系支持；Firefox 走压缩包 */}
              <input
                ref={folderInput}
                className="m-local-input"
                type="file"
                // @ts-expect-error webkitdirectory 是 Chromium 的扩展属性，TS 的 DOM 类型里没有
                webkitdirectory=""
                multiple
                aria-label="选择技能文件夹"
                onChange={pickFolder}
              />
              <input
                ref={zipInput}
                className="m-local-input"
                type="file"
                accept=".zip,application/zip"
                aria-label="选择技能压缩包"
                onChange={pickZip}
              />
            </div>
          </div>
          <p className="m-add-hint">
            文件夹或 .zip 都行：里面要有一个带 name 的 SKILL.md（<code>my-skill/SKILL.md</code>{' '}
            这种一层目录就好）。
          </p>

          <div className="m-add-source">
            <TextInput
              value={newRepo}
              onValueChange={setNewRepo}
              placeholder="owner/repo，或 GitHub 上那个仓库（含子目录）的链接"
              aria-label="添加技能源"
              onKeyDown={(event) => {
                if (event.key === 'Enter' && newRepo.trim() && !addingSource) {
                  setAddingSource(true)
                  addSource.mutate(newRepo.trim(), { onSettled: () => setAddingSource(false) })
                }
              }}
            />
            <Button
              variant="primary"
              icon={<Plus size={14} />}
              disabled={!newRepo.trim() || addingSource}
              onClick={() => {
                setAddingSource(true)
                addSource.mutate(newRepo.trim(), { onSettled: () => setAddingSource(false) })
              }}
            >
              添加
            </Button>
          </div>
          <p className="m-add-hint">
            任意公开仓库都行——我们扫的是仓库里的 SKILL.md，所以不必等谁去做适配。
          </p>

          {sources.isLoading ? (
            <SkeletonBlock variant="list" rows={4} />
          ) : (
            <ul className="m-source-list">
              {allSources.map((item) => (
                <li key={item.id} className="m-source-row">
                  <div className="m-source-main">
                    <span className="m-source-name">{item.name}</span>
                    <code className="m-source-repo">{item.repo}</code>
                    {item.builtin && <span className="m-chip">内置</span>}
                    {item.subpath && <span className="m-chip">子目录 {item.subpath}</span>}
                  </div>
                  <div className="m-source-actions">
                    <button
                      type="button"
                      className="m-chip m-chip-btn"
                      onClick={() => toggleSource.mutate(item)}
                    >
                      {item.enabled ? '已启用' : '已停用'}
                    </button>
                    {!item.builtin && (
                      <Button
                        size="sm"
                        variant="subtle"
                        icon={<Trash2 size={14} />}
                        aria-label={`删除源 ${item.name}`}
                        onClick={() => removeSource.mutate(item)}
                      />
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {view === 'list' && (
        <>
          <label className="m-toolbar-search" style={{ flexBasis: '100%' }}>
            <Search size={15} />
            <input
              type="search"
              value={query}
              placeholder="在这个源里搜索技能"
              aria-label="搜索技能"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>

          {/* 骨架屏要盖住"还没读完"这一段：**读之前不能先说"这个源里没有技能"**——
              那是一句会自己消失的错话（实测：首帧就是这么闪一下的） */}
          {sources.isLoading || loading ? (
            <SkeletonBlock variant="list" rows={4} />
          ) : visibleSkills.length === 0 ? (
            <EmptyState
              title={skills.length > 0 ? '没有匹配的技能' : '这个源里没有技能'}
              hint={
                skills.length > 0
                  ? '换个关键词再找找。'
                  : '它可能不是一个技能仓库，或者技能放在了别处——换个源试试。'
              }
            />
          ) : (
            <>
              <p className="m-list-count">
                共 {skills.length} 个技能{installedCount > 0 && `，已装 ${installedCount} 个`}
              </p>
              <ul className="m-market-list">
                {visibleSkills.map((skill) => (
                  <li key={skill.path}>
                    <button
                      type="button"
                      className="m-market-item"
                      onClick={() => void openDetail(skill)}
                    >
                      <span className="m-item-icon">
                        <Search size={16} />
                      </span>
                      <span className="m-item-body">
                        <span className="m-item-head">
                          <span className="m-item-name">{skill.name}</span>
                          {skill.installed && <StatusTag label="已安装" tone="success" />}
                        </span>
                        <span className="m-item-desc">
                          {blurb(skill) || '（这个技能没写说明）'}
                        </span>
                        <code className="m-item-path">{skill.path}</code>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}

      {view === 'detail' && (
        <>
          <button
            type="button"
            className="m-back"
            onClick={() => {
              setView('list')
              setBundle(null)
            }}
          >
            <ChevronLeft size={14} />
            返回清单
          </button>

          {inspecting ? (
            <SkeletonBlock variant="list" rows={5} />
          ) : bundle ? (
            <>
              <h3 className="m-detail-name">{bundle.name}</h3>
              {blurb(bundle) && <p className="m-detail-desc">{blurb(bundle)}</p>}
              {/* 原文照旧给出来（不折叠成提示）：它可能比中文更精确，
                  而"这句是谁写的"是用户判断可信度时要看的 */}
              {bundle.summary && bundle.description && (
                <p className="m-detail-origin">{bundle.description}</p>
              )}
              <p className="m-detail-meta">
                <code>{bundle.repo}</code>
                <span>·</span>
                <code>{bundle.sha.slice(0, 7)}</code>
                {bundle.license && <span>· {bundle.license}</span>}
                <span>· {formatSize(bundle.total_bytes)}</span>
              </p>

              {/* 代码文件**单独提示**：技能目录里的脚本是会被 agent 执行的代码，
                  这是用户在装之前唯一能判断"我在装什么"的地方（调研 §4.6） */}
              {bundle.code_count > 0 && (
                <p className="m-code-warn">
                  <AlertCircle size={14} />
                  里面有 {bundle.code_count} 个脚本文件（下面标着「代码」的那些）——
                  技能用到它们时会在你的机器上执行。装之前不妨先看一眼。
                </p>
              )}
              {bundle.truncated && (
                <p className="m-code-warn">
                  <AlertCircle size={14} />
                  这个仓库太大，GitHub 只给了部分文件树——下面这份清单**可能不全**。
                </p>
              )}

              <ul className="m-file-list">
                {bundle.files.map((file) => (
                  <li key={file.path}>
                    <span
                      className={
                        file.kind === 'code' ? 'm-file-kind m-file-kind-code' : 'm-file-kind'
                      }
                    >
                      {KIND_LABELS[file.kind] ?? file.kind}
                    </span>
                    <code className="m-file-path">{file.path}</code>
                    <span className="m-file-size">{formatSize(file.size)}</span>
                  </li>
                ))}
              </ul>

              <p className="m-detail-foot">
                装的是 <code>{bundle.sha.slice(0, 7)}</code> 这一版。
                {bundle.files.some((item) => item.kind === 'code') && (
                  <span>
                    落盘后它只是文件，不会自己跑起来——用不用、怎么用由对话里的工具策略决定。
                  </span>
                )}
              </p>
            </>
          ) : null}
        </>
      )}
    </Modal>
  )
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}
