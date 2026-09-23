/**
 * 检索面板（旧 `components/search/KbSearchPanel.vue`）的用例。
 *
 * 三条口径：
 * 1. **通道与分数要摊开**（向量 / BM25 各自排名与原始分）——它承担"这个库检索质量如何"的验证责任；
 * 2. **开发用确定性哈希要标注"向量召回不代表真实效果"**（否则用户会把兜底结果当成真实效果）；
 * 3. **未选嵌入模型时如实说明"本次只做了关键词检索"**（`embedding_configured === false`）。
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/search', () => ({ search: vi.fn() }))

import { search, type SearchResponse } from '@/api/search'
import { KbSearchPanel } from '@/features/misc/search/KbSearchPanel'
import { renderMisc } from '@/features/misc/testing/harness'
import { resetToasts } from '@/features/misc/shared/toast'

const searchMock = vi.mocked(search)

function response(overrides: Partial<SearchResponse> = {}): SearchResponse {
  return {
    hits: [
      {
        chunk_id: 'c1',
        document_id: 'doc-1',
        document_name: '手册.pdf',
        knowledge_base_id: 'kb-1',
        text: '第三章讲的是部署流程。',
        score: 0.812,
        page: 12,
        heading_path: '部署 > 前置条件',
        image_ids: [],
        channels: ['vector', 'fulltext'],
        ranks: { vector: 1, fulltext: 4 },
        raw_scores: { vector: 0.91, fulltext: 12.4 },
        rerank_score: null,
      },
    ],
    mode: 'hybrid',
    reranked: true,
    filtered_out: 0,
    stats: [
      { channel: 'vector', count: 40, elapsed_ms: 12.34 },
      { channel: 'fulltext', count: 40, elapsed_ms: 3.2 },
    ],
    embedding_configured: true,
    embedding_is_development: false,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetToasts()
  searchMock.mockResolvedValue(response())
})

describe('检索面板', () => {
  it('命中把通道与分数摊开：融合分、各通道排名与原始分', async () => {
    renderMisc(<KbSearchPanel open kbId="kb-1" kbName="产品手册" onClose={() => undefined} />)

    await userEvent.type(screen.getByLabelText('检索内容'), '部署流程')
    await userEvent.click(screen.getByRole('button', { name: '检索' }))

    await waitFor(() => expect(searchMock).toHaveBeenCalledTimes(1))
    expect(searchMock.mock.calls[0][0]).toMatchObject({
      query: '部署流程',
      kb_ids: ['kb-1'],
      mode: 'hybrid',
      top_k: 8,
      candidate_k: 40,
    })

    expect(await screen.findByText('手册.pdf')).toBeInTheDocument()
    expect(screen.getByText('部署 > 前置条件')).toBeInTheDocument()
    expect(screen.getByText('0.812')).toBeInTheDocument()
    expect(screen.getByText('第 1 位')).toBeInTheDocument()
    expect(screen.getByText('12.400')).toBeInTheDocument()
    expect(screen.getByText('已 rerank')).toBeInTheDocument()
    // 通道耗时表：两列对齐的三列数字
    expect(screen.getByText('12.3 ms')).toBeInTheDocument()
  })

  it('开发用确定性嵌入时明确警告"向量召回不代表真实效果"', async () => {
    searchMock.mockResolvedValue(response({ embedding_is_development: true }))

    renderMisc(<KbSearchPanel open kbId="kb-1" kbName="产品手册" onClose={() => undefined} />)
    await userEvent.type(screen.getByLabelText('检索内容'), '部署')
    await userEvent.click(screen.getByRole('button', { name: '检索' }))

    expect(await screen.findByText(/向量召回不代表真实效果/)).toBeInTheDocument()
    expect(screen.getByText(/BM25 的结果是可信的/)).toBeInTheDocument()
  })

  it('未选定嵌入模型时说明"本次只做了关键词检索"并给出下一步', async () => {
    searchMock.mockResolvedValue(response({ embedding_configured: false, reranked: false }))

    renderMisc(<KbSearchPanel open kbId="kb-1" kbName="产品手册" onClose={() => undefined} />)
    await userEvent.type(screen.getByLabelText('检索内容'), '部署')
    await userEvent.click(screen.getByRole('button', { name: '检索' }))

    expect(await screen.findByText(/服务端未选定嵌入模型，向量通道已跳过/)).toBeInTheDocument()
  })

  it('空查询不发请求；没有命中时给出可操作的建议', async () => {
    renderMisc(<KbSearchPanel open kbId="kb-1" kbName="产品手册" onClose={() => undefined} />)
    await userEvent.click(screen.getByRole('button', { name: '检索' }))
    expect(screen.getByText('请输入检索内容')).toBeInTheDocument()
    expect(searchMock).not.toHaveBeenCalled()

    searchMock.mockResolvedValue(response({ hits: [], stats: [] }))
    await userEvent.type(screen.getByLabelText('检索内容'), '不存在的词')
    await userEvent.click(screen.getByRole('button', { name: '检索' }))

    const panel = await screen.findByRole('dialog')
    expect(await within(panel).findByText('没有命中')).toBeInTheDocument()
    expect(screen.getByText(/确认文档已经处理到「已索引」/)).toBeInTheDocument()
  })
})
