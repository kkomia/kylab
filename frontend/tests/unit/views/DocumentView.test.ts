/**
 * 文档详情页（左列表 + 右抽屉）。
 *
 * 这里钉的是**同路由换参数必须重新加载**：左栏点另一份文档时路径只变参数，
 * Vue 会复用组件、不重新挂载——只把加载写在 onMounted 里就会"点了没反应"。
 * 这是路由参数类页面最经典的坑，对话页踩过同一个，所以拿测试挡住。
 *
 * 顺带钉住左栏：它列的是**同一个知识库**的文档，并且当前那一份要高亮。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

import * as api from '@/api/documents'
import DocumentView from '@/views/DocumentView.vue'

vi.mock('@/api/documents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/documents')>()
  return {
    ...actual,
    getDocument: vi.fn(),
    listDocuments: vi.fn(),
    listDocumentChunks: vi.fn(),
    getDocumentPreview: vi.fn(),
    downloadDocument: vi.fn(),
  }
})

function summary(id: string, name: string): api.DocumentSummary {
  return {
    id,
    knowledge_base_id: 'kb_1',
    name,
    source_kind: 'upload',
    stage: 'indexed',
    size_bytes: 2048,
    mime_type: 'application/pdf',
    page_count: 2,
    is_split: false,
    error: null,
    chunk_count: 3,
    uploaded_by: null,
    uploaded_by_name: '',
    folder_id: null,
    disabled: false,
    original_kind: 'pdf',
    created_at: '2026-09-11T00:00:00Z',
    updated_at: '2026-09-11T00:00:00Z',
  }
}

async function mountAt(path: string) {
  const blank = { template: '<div />' }
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/documents/:documentId', component: DocumentView },
      // 页面里有指向这两个地址的链接；不注册它们 Vue Router 会刷一片
      // "No match found" 警告，把测试输出弄脏（断言没问题，但噪声会掩盖真问题）
      { path: '/', component: blank },
      { path: '/kb/:kbId', component: blank },
    ],
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(DocumentView, { global: { plugins: [router, createPinia()] } })
  await flushPromises()
  return { wrapper, router }
}

beforeEach(() => {
  vi.mocked(api.getDocument).mockImplementation(async (id: string) =>
    summary(id, id === 'doc_a' ? '甲.pdf' : '乙.pdf'),
  )
  vi.mocked(api.listDocuments).mockResolvedValue({
    items: [summary('doc_a', '甲.pdf'), summary('doc_b', '乙.pdf')],
  })
  vi.mocked(api.listDocumentChunks).mockResolvedValue({ items: [], total: 3 })
  vi.mocked(api.getDocumentPreview).mockResolvedValue({
    kind: 'markdown',
    filename: '甲.md',
    text: '正文',
    url: null,
    expires_at: null,
    original_kind: 'pdf',
  })
})

describe('DocumentView', () => {
  it('左栏列出同库文档，当前那一份高亮', async () => {
    const { wrapper } = await mountAt('/documents/doc_a')

    const rows = wrapper.findAll('.context-row')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('甲.pdf')
    expect(rows[0].classes()).toContain('context-row-active')
    expect(rows[1].classes()).not.toContain('context-row-active')
    expect(wrapper.find('.drawer-name').text()).toBe('甲.pdf')
  })

  it('同路由换文档会重新加载（不是"点了没反应"）', async () => {
    const { wrapper, router } = await mountAt('/documents/doc_a')
    expect(api.getDocument).toHaveBeenCalledWith('doc_a')

    await router.push('/documents/doc_b')
    await flushPromises()

    expect(api.getDocument).toHaveBeenLastCalledWith('doc_b')
    expect(wrapper.find('.drawer-name').text()).toBe('乙.pdf')
  })

  it('左栏拿不到列表时不影响详情：它是上下文，不是主体', async () => {
    vi.mocked(api.listDocuments).mockRejectedValue(new Error('后端不可达'))

    const { wrapper } = await mountAt('/documents/doc_a')

    expect(wrapper.findAll('.context-row')).toHaveLength(0)
    expect(wrapper.find('.drawer-name').text()).toBe('甲.pdf')
    expect(wrapper.text()).toContain('这个库还没有别的文档。')
  })
})
