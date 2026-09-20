/**
 * 知识库页的批量动作：四个入口共用**同一条**报账路径（v0.2 收敛）。
 *
 * 这一页此前没有测试文件（《开发计划》§12.175 之后补上），而它恰好是"同构代码抄了
 * 四份"的地方：删除/重建、批量出题、单篇出题、停用/恢复。四处各有一份
 * "守卫 → 置忙 → 调接口 → 刷新 → 按全成/部分失败报账"的骨架，
 * 于是文案与选择策略的差别只存在于代码里，没有任何东西拦得住它们继续分叉。
 *
 * 这里钉住三件会被人改坏的事：
 *
 * 1. **部分失败是正常结果**：只报总数等于让人自己去猜哪篇没成——要把第一条原因带出来；
 * 2. **成功文案各自不同**：出题说"已排队"、停用说"的检索"——收敛不该把它们统一掉；
 * 3. **失败项留在选中态**（删除/重建那条）：用户要能直接重试。
 */
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'

const listDocuments = vi.fn()
const listFolders = vi.fn()
const batchDocuments = vi.fn()
const notifySuccess = vi.fn()
const notifyError = vi.fn()

vi.mock('@/api/documents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/documents')>()
  return {
    ...actual,
    listDocuments: (...args: unknown[]) => listDocuments(...args),
    listFolders: (...args: unknown[]) => listFolders(...args),
    batchDocuments: (...args: unknown[]) => batchDocuments(...args),
    getDocumentImpact: vi.fn(),
    listDocumentParts: vi.fn(),
  }
})

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({
    notifySuccess: (...args: unknown[]) => notifySuccess(...args),
    notifyError: (...args: unknown[]) => notifyError(...args),
    notify: vi.fn(),
    notifyWarning: vi.fn(),
  }),
}))

vi.mock('@/stores/knowledgeBases', () => ({
  useKnowledgeBaseStore: () => ({
    items: [CAN_WRITE_KB],
    summaries: {},
    loading: false,
    error: '',
    byId: (id: string) => (id === CAN_WRITE_KB.id ? CAN_WRITE_KB : undefined),
    load: vi.fn(),
    refreshSummaries: vi.fn(),
  }),
}))

import type { DocumentSummary } from '@/api/documents'
import KnowledgeBaseView from '@/views/KnowledgeBaseView.vue'

const CAN_WRITE_KB = {
  id: 'kb_1',
  name: '指南库',
  description: '',
  embedding_model_id: 'm1',
  embedding_dim: 8,
  chunk_strategy: 'fixed',
  chunk_size: 512,
  chunk_overlap: 64,
  suggested_enabled: false,
  suggested_count: 0,
  suggested_model_pk: null,
  suggested_prompt: '',
  system_prompt: '',
  wiki_enabled: false,
  created_at: null,
  can_manage: true,
  can_write: true,
  document_count: 2,
}

function doc(id: string, name: string): DocumentSummary {
  return {
    id,
    knowledge_base_id: 'kb_1',
    name,
    source_kind: 'upload',
    stage: 'indexed',
    size_bytes: 100,
    mime_type: 'application/pdf',
    page_count: 1,
    is_split: false,
    error: null,
    folder_id: null,
    disabled: false,
    created_at: null,
    updated_at: null,
    progress: null,
    disabled_chunks: 0,
  } as unknown as DocumentSummary
}

function batchResult(ok: number, failed: { document_id: string; error: string }[] = []) {
  return {
    action: 'disable',
    succeeded: ok,
    failed: failed.length,
    items: [
      ...Array.from({ length: ok }, (_, i) => ({
        document_id: `ok_${i}`,
        ok: true,
        error: null,
      })),
      ...failed.map((item) => ({ document_id: item.document_id, ok: false, error: item.error })),
    ],
  }
}

async function mountPage(): Promise<{ wrapper: VueWrapper; router: Router }> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/kb/:kbId', component: { template: '<div />' } },
      { path: '/knowledge-bases', component: { template: '<div />' } },
    ],
  })
  await router.push('/kb/kb_1')
  await router.isReady()

  const wrapper = mount(KnowledgeBaseView, {
    global: { plugins: [router] },
  })
  await flushPromises()
  return { wrapper, router }
}

/** 勾上前两篇（批量条因此浮出）。 */
async function selectFirstTwo(wrapper: VueWrapper): Promise<void> {
  const boxes = wrapper.findAll('.doc-row input[type="checkbox"]')
  expect(boxes.length).toBeGreaterThanOrEqual(2)
  await boxes[0].setValue(true)
  await boxes[1].setValue(true)
  await flushPromises()
}

function clickText(wrapper: VueWrapper, text: string): Promise<void> {
  const button = wrapper.findAll('button').find((item) => item.text().includes(text))
  expect(button, `没找到按钮：${text}`).toBeTruthy()
  return button!.trigger('click')
}

describe('知识库页：批量动作', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    listDocuments.mockReset().mockResolvedValue({
      items: [doc('d1', '甲.pdf'), doc('d2', '乙.pdf')],
      total: 2,
      limit: 20,
      offset: 0,
    })
    listFolders.mockReset().mockResolvedValue([])
    batchDocuments.mockReset()
    notifySuccess.mockReset()
    notifyError.mockReset()
  })

  it('停用检索：成功文案带上"的检索"，且不清空选择', async () => {
    // 这一页的停机率不动选中项：用户往往要接着做下一个动作
    batchDocuments.mockResolvedValue(batchResult(2))
    const { wrapper } = await mountPage()
    await selectFirstTwo(wrapper)

    await clickText(wrapper, '停用检索')
    await flushPromises()

    expect(batchDocuments).toHaveBeenCalledWith('kb_1', 'disable', ['d1', 'd2'], null, false)
    expect(notifySuccess).toHaveBeenCalledWith('已停用 2 篇的检索')
    expect(notifyError).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('部分失败：把每条的原因带出来（只报总数等于让人自己猜）', async () => {
    batchDocuments.mockResolvedValue(
      batchResult(1, [{ document_id: 'd2', error: '文档正在处理中' }]),
    )
    const { wrapper } = await mountPage()
    await selectFirstTwo(wrapper)

    await clickText(wrapper, '停用检索')
    await flushPromises()

    expect(notifySuccess).not.toHaveBeenCalled()
    expect(notifyError).toHaveBeenCalledWith('停用：1 篇成功、1 篇失败（文档正在处理中）')
    // 停用/恢复**不动选中项**：用户往往要接着做下一个动作（如停用完再恢复试试）
    expect(wrapper.find('.batch-count').text()).toContain('已选 2 篇')
    wrapper.unmount()
  })

  it('批量删除：失败的那几篇留在选中态，用户可以就地重试', async () => {
    batchDocuments.mockResolvedValue({
      ...batchResult(1, [{ document_id: 'd2', error: '文档正在处理中' }]),
      action: 'delete',
    })
    const { wrapper } = await mountPage()
    await selectFirstTwo(wrapper)

    await clickText(wrapper, '删除')
    await flushPromises()
    // 确认弹窗（破坏性动作要二次确认）。
    // **要按弹窗标题定位那个 danger 按钮**：这一页同时挂着好几个确认弹窗，
    // 它们的内容都在 DOM 里，`find('.button-danger')` 拿到的多半是别家的按钮。
    const lead = wrapper.findAll('.confirm-lead').find((item) => item.text().includes('删除选中的'))
    expect(lead, '批量删除的确认弹窗没打开').toBeTruthy()
    const dialog = lead!.element.closest('dialog')
    const confirm = wrapper.findAll('.button-danger').find((item) => dialog?.contains(item.element))
    expect(confirm, '确认弹窗里没有 danger 按钮').toBeTruthy()
    await confirm!.trigger('click')
    await flushPromises()

    expect(batchDocuments).toHaveBeenCalledWith('kb_1', 'delete', ['d1', 'd2'], null, false)
    expect(notifyError).toHaveBeenCalledWith('删除：1 篇成功、1 篇失败（文档正在处理中）')
    expect(wrapper.find('.batch-count').text()).toContain('已选 1 篇')
    wrapper.unmount()
  })

  it('批量出题：走同一条路，但说的是"已排队"（异步任务，不是立刻完成）', async () => {
    batchDocuments.mockResolvedValue({ ...batchResult(2), action: 'questions' })
    const { wrapper } = await mountPage()
    await selectFirstTwo(wrapper)

    await clickText(wrapper, '生成问题')
    await flushPromises()

    expect(batchDocuments).toHaveBeenCalledWith('kb_1', 'questions', ['d1', 'd2'], null, false)
    expect(notifySuccess).toHaveBeenCalledWith('已排队为 2 篇生成问题，完成后列表会自动刷新')
    wrapper.unmount()
  })

  it('单篇出题（行菜单）与批量同一条路：目标只有这一篇', async () => {
    batchDocuments.mockResolvedValue({ ...batchResult(1), action: 'questions' })
    const { wrapper } = await mountPage()

    // 行菜单在第一列的动作按钮里（收起状态只有图标，按 aria-label 找）
    const rowMenu = wrapper.find('summary[aria-label="更多操作"]')
    expect(rowMenu.exists()).toBe(true)
    await rowMenu.trigger('click')
    await flushPromises()
    await clickText(wrapper, '生成问题')

    expect(batchDocuments).toHaveBeenCalledWith('kb_1', 'questions', ['d1'], null, false)
    expect(notifySuccess).toHaveBeenCalledWith('已排队生成问题，完成后列表会自动刷新')
    wrapper.unmount()
  })
})
