/**
 * 文档详情抽屉。
 *
 * 它盖在文档列表上，所以这里钉三件事：
 * 1. **换文档要重新加载**——宿主点列表里另一份时组件被复用（`:key` 之外还有 prop 变化），
 *    只把加载写在 onMounted 里就会"点了没反应"；
 * 2. 内容按 WeKnora 那样分区：基本信息（元信息）与文件内容（片段数 + 视角切换）；
 * 3. 关闭是**通知宿主**（`close` 事件），抽屉自己不改路由——路由归列表页管。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

import * as api from '@/api/documents'
import DocumentDrawer from '@/components/knowledge/DocumentDrawer.vue'

vi.mock('@/api/documents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/documents')>()
  return {
    ...actual,
    getDocument: vi.fn(),
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

async function mountDrawer(
  documentId = 'doc_a',
  options: { props?: Record<string, unknown>; query?: Record<string, string> } = {},
) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/kb/:kbId', component: { template: '<div />' } }],
  })
  await router.push({ path: '/kb/kb_1', query: options.query })
  await router.isReady()
  const wrapper = mount(DocumentDrawer, {
    props: { documentId, ...options.props },
    global: { plugins: [router, createPinia()] },
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  vi.mocked(api.getDocument).mockImplementation(async (id: string) =>
    summary(id, id === 'doc_a' ? '甲.pdf' : '乙.pdf'),
  )
  vi.mocked(api.listDocumentChunks).mockResolvedValue({
    items: [],
    total: 3,
  } as unknown as Awaited<ReturnType<typeof api.listDocumentChunks>>)
  vi.mocked(api.getDocumentPreview).mockResolvedValue({
    kind: 'pdf',
    filename: '甲.pdf',
    text: null,
    url: '/api/v1/documents/doc_a/content?format=original&disposition=inline',
    expires_at: null,
    original_kind: 'pdf',
  })
})

describe('DocumentDrawer', () => {
  it('按 WeKnora 的分区呈现：基本信息 + 文件内容（带片段数）', async () => {
    const wrapper = await mountDrawer()

    const titles = wrapper.findAll('.section-title').map((el) => el.text())
    expect(titles[0]).toContain('基本信息')
    expect(titles[1]).toContain('文件内容')
    expect(wrapper.find('.section-badge').text()).toContain('共 3 个片段')

    // 元信息六项：状态 / 大小 / 切块数 / 页数 / 来源 / 更新时间
    expect(wrapper.findAll('.meta-item')).toHaveLength(6)
    expect(wrapper.find('.drawer-name').text()).toBe('甲.pdf')
    // 能渲染原件时默认看原件（PDF 进 iframe）
    expect(wrapper.find('.reader-frame').exists()).toBe(true)
  })

  it('换文档会重新加载（组件被复用，不能只靠 onMounted）', async () => {
    const wrapper = await mountDrawer('doc_a')
    expect(api.getDocument).toHaveBeenCalledWith('doc_a')

    await wrapper.setProps({ documentId: 'doc_b' })
    await flushPromises()

    expect(api.getDocument).toHaveBeenLastCalledWith('doc_b')
    expect(wrapper.find('.drawer-name').text()).toBe('乙.pdf')
  })

  it('外部传入的页码直接落进 PDF 地址（对话页的引用抽屉走这条，那条路径上没有 ?page=）', async () => {
    const wrapper = await mountDrawer('doc_a', { props: { page: 2 } })

    expect(wrapper.find('.reader-frame').attributes('src')).toContain('#page=2')
  })

  it('没传页码时仍认 URL 上的 ?page=（库页的用法不受影响）', async () => {
    const wrapper = await mountDrawer('doc_a', { query: { page: '5' } })

    expect(wrapper.find('.reader-frame').attributes('src')).toContain('#page=5')
  })

  it('页码变了地址跟着变（iframe 以最终地址为 key，原生查看器才会重新定位）', async () => {
    const wrapper = await mountDrawer('doc_a', { props: { page: 2 } })

    await wrapper.setProps({ page: 7 })

    expect(wrapper.find('.reader-frame').attributes('src')).toContain('#page=7')
  })

  it('两个下载按钮的文字不一样（长相一样会让人分不清哪个是哪个）', async () => {
    const wrapper = await mountDrawer()

    const labels = wrapper.findAll('.drawer-actions button').map((b) => b.text())
    expect(labels[0]).toContain('下载原文')
    expect(labels[1]).toContain('下载 Markdown')
  })

  it('下载按钮走签名链接那条路', async () => {
    vi.mocked(api.downloadDocument).mockResolvedValue(undefined)
    const wrapper = await mountDrawer()

    await wrapper.find('.drawer-actions button').trigger('click')
    await flushPromises()

    expect(api.downloadDocument).toHaveBeenCalledWith('doc_a', 'original')
  })

  it('收起是「先滑回去再通知宿主」，不是瞬间消失', async () => {
    const wrapper = await mountDrawer()

    await wrapper.find('button[aria-label="收起"]').trigger('click')

    // 先加上位移类（滑回去），此时**还不能**通知宿主卸载——否则动画会被直接掐掉。
    // 注意用 `find` 而不是 `wrapper.classes()`：这个组件是多根（抽屉 + 确认弹窗），
    // 多根组件在 VTU 里没有"根元素"可问。
    expect(wrapper.find('.doc-drawer').classes()).toContain('doc-drawer-closing')
    expect(wrapper.emitted('close')).toBeUndefined()

    // 等动画跑完（样式里是 180ms）
    await new Promise((resolve) => setTimeout(resolve, 260))
    expect(wrapper.emitted('close')).toHaveLength(1)

    wrapper.unmount()
  })

  it('Esc 同样走收起（这条路径挂在 window 上：焦点可能在 iframe 里）', async () => {
    const wrapper = await mountDrawer()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await new Promise((resolve) => setTimeout(resolve, 260))

    expect(wrapper.emitted('close')).toHaveLength(1)

    wrapper.unmount()
  })
})
