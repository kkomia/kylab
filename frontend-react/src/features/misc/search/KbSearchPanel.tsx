/**
 * 知识库内的检索面板（《前端设计规范》§6）
 * ——与旧前端 `components/search/KbSearchPanel.vue` 逐条对应。
 *
 * 检索本来就是"在某个库里查东西"，单独占一个全局页面没有道理：
 * 用户得先去检索台、再从下拉里挑库，而那一刻他其实已经站在那个库里了。
 * 所以检索收进知识库详情页，用弹窗打开——检索是**动作**，不是常驻视图。
 * （旧路由里的 `/search` 是一条指向知识库列表的重定向，没有独立页面。）
 *
 * 面板里刻意把**通道与分数摊开**（向量 / BM25、各自排名与原始分）：
 * 它同时承担"这个库检索质量如何"的验证责任。
 * 服务端没配 embedding API Key 时是确定性哈希兜底（只有词面重叠、没有语义），
 * 此时必须明说"向量召回不可信"，否则用户会把兜底结果当成真实效果。
 */
import { useEffect, useState } from 'react'
import { Image as ImageIcon, Search } from 'lucide-react'
import { Link } from 'react-router'

import { search, type SearchHit, type SearchResponse } from '@/api/search'
import { formatAge, formatScore } from '@/lib/format'

import { notifyError, notifyWarning } from '../shared/toast'
import {
  Button,
  EmptyState,
  ErrorLine,
  Field,
  Modal,
  Select,
  SkeletonBlock,
  TextArea,
  TextInput,
} from '../shared/ui'

interface Turn {
  query: string
  response: SearchResponse | null
  error: string
  /** 发起时间：会话历史里要能看出"这是刚才那次"还是"十分钟前那次"。 */
  at: number
}

const MODE_OPTIONS = [
  { value: 'hybrid', label: '混合（向量 + BM25）' },
  { value: 'vector', label: '仅向量' },
  { value: 'fulltext', label: '仅 BM25' },
]

export function channelLabel(channel: string): string {
  return channel === 'vector' ? '向量' : channel === 'fulltext' ? 'BM25' : channel
}

export function modeLabel(value: string): string {
  if (value === 'hybrid') return '混合检索'
  if (value === 'vector') return '仅向量'
  if (value === 'fulltext') return '仅 BM25'
  return value
}

/** 命中条目用 chunk_id 作 key：同一文档可能有多个块命中。 */
const hitKey = (hit: SearchHit): string => hit.chunk_id

export function KbSearchPanel({
  open,
  kbId,
  kbName,
  onClose,
}: {
  open: boolean
  kbId: string
  kbName: string
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<'hybrid' | 'vector' | 'fulltext'>('hybrid')
  /** 数字输入留成字符串交给原生 input，提交时再转——避免与输入框类型打架。 */
  const [topK, setTopK] = useState('8')
  const [candidateK, setCandidateK] = useState('40')
  const [rerank, setRerank] = useState(false)
  const [turns, setTurns] = useState<Turn[]>([])
  const [searching, setSearching] = useState(false)
  /** 当前在看第几次检索：会话历史可点，右侧结果跟着切。 */
  const [activeTurn, setActiveTurn] = useState(-1)

  /**
   * 会话历史里的"多久之前"需要一个会走的时钟。
   * 不引定时器的话，标签会一直停在首次渲染的时刻。
   */
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!open) return
    const clock = setInterval(() => setNow(Date.now()), 10_000)
    return () => clearInterval(clock)
  }, [open])

  const latest = turns[activeTurn] ?? null
  /** 命中过多时正文收成三行摘要：一屏放不下两条结果就没法相互比较。 */
  const showFullText = (latest?.response?.hits.length ?? 0) <= 8
  const embeddingIsDevelopment = latest?.response?.embedding_is_development === true
  /** 没配嵌入模型：向量通道被跳过，本次只做了关键词检索。 */
  const embeddingMissing = latest?.response?.embedding_configured === false

  async function runSearch(): Promise<void> {
    const text = query.trim()
    if (!text) {
      notifyWarning('请输入检索内容')
      return
    }
    setSearching(true)
    const turn: Turn = { query: text, response: null, error: '', at: Date.now() }
    const next = [...turns, turn]
    setTurns(next)
    setActiveTurn(next.length - 1)
    try {
      const response = await search({
        query: text,
        kb_ids: [kbId],
        mode,
        top_k: Number(topK) || 8,
        candidate_k: Number(candidateK) || 40,
        rerank,
      })
      setTurns((current) => current.map((item) => (item === turn ? { ...item, response } : item)))
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '检索失败'
      setTurns((current) =>
        current.map((item) => (item === turn ? { ...item, error: message } : item)),
      )
      notifyError(message)
    } finally {
      setSearching(false)
      setActiveTurn(next.length - 1)
    }
  }

  return (
    <Modal open={open} title={`在「${kbName}」中检索`} onClose={onClose} size="wide" height="full">
      <div className="m-search-layout">
        <div className="m-block">
          <div className="field">
            <label className="field-label" htmlFor="kb-search-input">
              检索内容
            </label>
            <TextArea
              id="kb-search-input"
              rows={3}
              value={query}
              onValueChange={setQuery}
              placeholder="输入问题或关键词，回车检索"
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void runSearch()
                }
              }}
            />
          </div>

          <div className="m-form-actions">
            <div className="m-filter-select">
              <Field label="模式">
                <Select
                  value={mode}
                  onValueChange={(value) => setMode(value as typeof mode)}
                  options={MODE_OPTIONS}
                  label="检索模式"
                />
              </Field>
            </div>
            <div style={{ flex: '0 0 96px' }}>
              <Field label="返回条数">
                <TextInput
                  type="number"
                  value={topK}
                  onValueChange={setTopK}
                  aria-label="返回条数"
                />
              </Field>
            </div>
          </div>

          <details className="m-advanced">
            <summary>高级选项</summary>
            <div className="m-form-actions">
              <div style={{ flex: '0 0 96px' }}>
                <Field label="候选池">
                  <TextInput
                    type="number"
                    value={candidateK}
                    onValueChange={setCandidateK}
                    aria-label="候选池"
                  />
                </Field>
              </div>
              <label className="m-check">
                <input
                  type="checkbox"
                  checked={rerank}
                  onChange={(event) => setRerank(event.target.checked)}
                />
                <span>启用 rerank（失败自动退回 RRF 顺序）</span>
              </label>
            </div>
          </details>

          <div>
            <Button
              variant="primary"
              icon={<Search size={14} />}
              disabled={searching}
              onClick={() => void runSearch()}
            >
              {searching ? '检索中…' : '检索'}
            </Button>
          </div>

          {turns.length > 0 && (
            <div>
              <p className="m-group-label">本次会话</p>
              <ul className="m-history-list">
                {turns.map((turn, index) => (
                  <li key={index}>
                    <button
                      type="button"
                      className={
                        index === activeTurn ? 'm-history-item m-history-item-on' : 'm-history-item'
                      }
                      onClick={() => setActiveTurn(index)}
                    >
                      <span className="m-history-query">{turn.query}</span>
                      <span className="m-history-hits tabular">
                        {turn.response ? `${turn.response.hits.length} 条` : '—'}
                      </span>
                      <span className="m-history-age tabular">{formatAge(turn.at, now)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="m-block">
          {searching ? (
            <SkeletonBlock variant="text" rows={6} />
          ) : !latest ? (
            <EmptyState
              title="还没有检索记录"
              hint="左侧输入内容；结果会显示每条命中来自哪条通道、各自排名多少。"
            />
          ) : latest.error ? (
            <ErrorLine>{latest.error}</ErrorLine>
          ) : latest.response ? (
            <>
              <div className="m-hit-summary">
                <span>
                  {latest.response.hits.length} 条命中<span className="sep">·</span>
                  {modeLabel(latest.response.mode)}
                </span>
                {latest.response.reranked && <span className="m-summary-note">已 rerank</span>}
                {latest.response.filtered_out > 0 && (
                  <span className="m-summary-note m-summary-warn">
                    元数据过滤掉 {latest.response.filtered_out} 条
                  </span>
                )}
              </div>

              {embeddingMissing ? (
                <p className="m-dev-warning">
                  <strong>本次只做了关键词检索：</strong>
                  服务端未选定嵌入模型，向量通道已跳过。请到「设置 →
                  向量化」选定默认嵌入模型后重试。
                </p>
              ) : embeddingIsDevelopment ? (
                <p className="m-dev-warning">
                  <strong>向量召回不代表真实效果：</strong>
                  当前用的是开发用确定性哈希（只反映词面重叠，没有语义）。BM25
                  的结果是可信的，向量分数仅供链路自测。
                </p>
              ) : null}

              {/* 通道耗时：三列对齐，数字沿一条竖轴 */}
              {latest.response.stats.length > 0 && (
                <div>
                  <div className="m-channel-head" aria-hidden="true">
                    <span className="m-col-name">通道</span>
                    <span className="m-col-count">候选</span>
                    <span className="m-col-ms">耗时</span>
                  </div>
                  <ul className="m-channel-stats">
                    {latest.response.stats.map((stat) => (
                      <li key={stat.channel} className="m-channel-stat">
                        <span className="m-col-name">{channelLabel(stat.channel)}</span>
                        <span className="m-col-count">{stat.count}</span>
                        <span className="m-col-ms">{stat.elapsed_ms.toFixed(1)} ms</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {latest.response.hits.length === 0 ? (
                <EmptyState
                  title="没有命中"
                  hint="换关键词、放宽模式到混合检索，或确认文档已经处理到「已索引」。"
                />
              ) : (
                <ol className="m-list">
                  {latest.response.hits.map((hit) => (
                    <li key={hitKey(hit)} className="m-hit">
                      <div className="m-hit-head">
                        <span>
                          <Link className="m-hit-title" to={`/documents/${hit.document_id}`}>
                            {hit.document_name ?? hit.document_id}
                          </Link>
                          {hit.heading_path && (
                            <span className="text-micro"> {hit.heading_path}</span>
                          )}
                          {hit.page !== null && (
                            <span className="text-micro"> 第 {hit.page} 页</span>
                          )}
                        </span>
                        <span
                          className="m-row-value tabular"
                          title={`融合分数 ${formatScore(hit.score)}`}
                        >
                          {formatScore(hit.score)}
                        </span>
                      </div>

                      <p className={showFullText ? 'm-hit-text' : 'm-hit-text m-hit-text-clamped'}>
                        {hit.text}
                      </p>

                      {/* 命中通道：三列对齐，一眼看出这条是靠哪条通道捞上来的 */}
                      <ul className="m-hit-channels">
                        {hit.channels.map((channel) => (
                          <li key={channel} className="m-hit-channel">
                            <span className="m-col-name">{channelLabel(channel)}</span>
                            <span className="m-col-rank tabular">
                              第 {hit.ranks[channel] ?? '—'} 位
                            </span>
                            <span className="m-col-raw tabular">
                              {formatScore(hit.raw_scores[channel])}
                            </span>
                          </li>
                        ))}
                        {hit.image_ids.length > 0 && (
                          <li className="m-hit-channel">
                            <ImageIcon size={13} />
                            {hit.image_ids.length} 张图
                          </li>
                        )}
                      </ul>
                    </li>
                  ))}
                </ol>
              )}
            </>
          ) : null}
        </div>
      </div>
    </Modal>
  )
}
