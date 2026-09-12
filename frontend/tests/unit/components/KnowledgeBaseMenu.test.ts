/**
 * 知识库设置弹窗（左导航 + 右内容 + 底部统一保存）。
 *
 * 这里钉的是布局改版后**行为**上的几件事：
 * 1. 分组导航把"有哪些可设"摆出来，默认停在基本信息；
 * 2. 保存收敛成**一个**按钮，只发真正变了的字段——没改动时它是禁用的，
 *    不能发一次空 PATCH；
 * 3. 描述是多行输入，**那里的回车是换行不是提交**（顺手提交会让人打不完一段话）。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import * as kbApi from '@/api/knowledgeBases'
import KnowledgeBaseMenu from '@/components/knowledge/KnowledgeBaseMenu.vue'
import type { KnowledgeBase } from '@/api/knowledgeBases'

vi.mock('@/api/knowledgeBases', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/knowledgeBases')>()
  return {
    ...actual,
    updateKnowledgeBase: vi.fn(),
    getKnowledgeBaseImpact: vi.fn(),
    deleteKnowledgeBase: vi.fn(),
  }
})

function kbFixture(overrides: Partial<KnowledgeBase> = {}): KnowledgeBase {
  return {
    id: 'kb_1',
    name: '眼科知识库',
    description: '旧简介',
    embedding_model_id: 'BAAI/bge-m3',
    embedding_dim: 1024,
    chunk_strategy: 'fixed',
    chunk_size: 512,
    chunk_overlap: 64,
    created_at: '2026-09-11T00:00:00Z',
    can_manage: true,
    can_write: true,
    document_count: 2,
    last_activity: null,
    ...overrides,
  }
}

async function mountMenu(kb = kbFixture()) {
  setActivePinia(createPinia())
  const wrapper = mount(KnowledgeBaseMenu, {
    props: { kb },
    global: {
      // AppModal 在 jsdom 里没有 `<dialog>.showModal()`，换成普通容器（同 ConfirmDialog 测试）；
      // SourcePanel 会自己去打接口，这里与本文件要验的东西无关
      stubs: {
        AppModal: { template: '<div><slot /><slot name="footer" /></div>' },
        SourcePanel: true,
      },
    },
  })
  await wrapper.find('.kb-settings').trigger('click')
  await flushPromises()
  return wrapper
}

function nameInput(wrapper: Awaited<ReturnType<typeof mountMenu>>) {
  return wrapper.find('#kb-setting-name')
}

function saveButton(wrapper: Awaited<ReturnType<typeof mountMenu>>) {
  return wrapper.findAll('button').find((b) => b.text().includes('保存并关闭'))!
}

beforeEach(() => {
  // 先清调用记录：不清的话上一条用例的调用会留在这里，
  // "没有发出请求"这类断言永远失败（也很难看出原因）
  vi.clearAllMocks()
  vi.mocked(kbApi.updateKnowledgeBase).mockImplementation(async (id, patch) =>
    kbFixture({ id, ...patch }),
  )
})

describe('KnowledgeBaseMenu', () => {
  it('左侧按分组列出可设置项，默认停在基本信息', async () => {
    const wrapper = await mountMenu()

    expect(wrapper.findAll('.nav-group').map((el) => el.text())).toEqual([
      '基础',
      '数据',
      '危险操作',
    ])
    expect(wrapper.findAll('.nav-item').map((el) => el.text())).toEqual([
      '基本信息',
      '库信息',
      '数据源',
      '删除知识库',
    ])
    expect(wrapper.find('.nav-item-active').text()).toBe('基本信息')
    // 知识库 ID 是 API 集成的入口，摆在基本信息里并可直接复制
    expect(wrapper.find('.kb-id').text()).toBe('kb_1')
    expect(wrapper.find('button[aria-label="复制知识库 ID"]').exists()).toBe(true)
  })

  it('切到库信息只读呈现建库时冻结的参数，底部不再出现保存', async () => {
    const wrapper = await mountMenu()

    const infoTab = wrapper.findAll('.nav-item').find((el) => el.text() === '库信息')!
    await infoTab.trigger('click')

    expect(wrapper.text()).toContain('BAAI/bge-m3')
    expect(wrapper.text()).toContain('块长 512')
    expect(wrapper.text()).toContain('关闭')
    expect(wrapper.text()).not.toContain('保存并关闭')
  })

  it('只发真正变了的字段，未改动时保存按钮禁用', async () => {
    const wrapper = await mountMenu()

    // 什么都没改：不能发空 PATCH
    expect(saveButton(wrapper).attributes('disabled')).toBeDefined()

    await nameInput(wrapper).setValue('眼科知识库（新）')
    expect(saveButton(wrapper).attributes('disabled')).toBeUndefined()

    await saveButton(wrapper).trigger('click')
    await flushPromises()

    expect(kbApi.updateKnowledgeBase).toHaveBeenCalledWith('kb_1', { name: '眼科知识库（新）' })
    expect(wrapper.emitted('changed')?.[0]).toEqual(['renamed'])
  })

  it('描述是多行输入：那里的回车是换行，不是提交', async () => {
    const wrapper = await mountMenu()

    const description = wrapper.find('#kb-setting-description')
    await description.setValue('新的一段描述')
    await description.trigger('keydown.enter')
    await flushPromises()

    expect(kbApi.updateKnowledgeBase).not.toHaveBeenCalled()

    // 名称那种单行输入里回车才提交；此时两处都改过，所以两个字段一起发
    await nameInput(wrapper).setValue('改个名')
    await nameInput(wrapper).trigger('keydown.enter')
    await flushPromises()

    expect(kbApi.updateKnowledgeBase).toHaveBeenCalledWith('kb_1', {
      name: '改个名',
      description: '新的一段描述',
    })
  })
})
