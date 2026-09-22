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

import * as documentsApi from '@/api/documents'
import * as kbApi from '@/api/knowledgeBases'
import KnowledgeBaseMenu from '@/components/knowledge/KnowledgeBaseMenu.vue'
import InfoTip from '@/components/ui/InfoTip.vue'
import type { KnowledgeBase } from '@/api/knowledgeBases'

vi.mock('@/api/knowledgeBases', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/knowledgeBases')>()
  return {
    ...actual,
    updateKnowledgeBase: vi.fn(),
    getKnowledgeBaseImpact: vi.fn(),
    deleteKnowledgeBase: vi.fn(),
    generateKBPrompt: vi.fn(),
  }
})

vi.mock('@/api/documents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/documents')>()
  return { ...actual, batchDocuments: vi.fn() }
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
    suggested_enabled: true,
    suggested_count: 6,
    suggested_model_pk: null,
    suggested_prompt: '',
    system_prompt: '',
    wiki_enabled: false,
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
      // 回答要求（v0.19）：提示词从对话页搬到库里，入口在这里
      '回答要求',
      '库信息',
      '切块策略',
      'Wiki',
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

describe('KnowledgeBaseMenu 切块策略（v17）', () => {
  async function openChunking(wrapper: Awaited<ReturnType<typeof mountMenu>>) {
    const tab = wrapper.findAll('.nav-item').find((el) => el.text() === '切块策略')!
    await tab.trigger('click')
    return wrapper
  }

  /**
   * 模拟指针拖动。吸附**只在指针拖动时**生效（键盘的每一步本来就是精确的 1，
   * 一吸就再也走不出刻度），所以这里必须先把按下这件事告诉控件。
   * 用原生事件而不是 `trigger('pointerdown')`：jsdom 的 PointerEvent 时有时无。
   */
  function startDrag(input: { element: Element }) {
    input.element.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  }

  function endDrag(input: { element: Element }) {
    input.element.dispatchEvent(new Event('pointerup', { bubbles: true }))
  }

  function inputValue(wrapper: Awaited<ReturnType<typeof mountMenu>>, selector: string) {
    return (wrapper.find(selector).element as HTMLInputElement).value
  }

  it('切块这一栏是可编辑的，预填当前值，且底部有保存', async () => {
    const wrapper = await openChunking(await mountMenu())

    expect((wrapper.find('#kb-chunk-size').element as HTMLInputElement).value).toBe('512')
    expect((wrapper.find('#kb-chunk-overlap').element as HTMLInputElement).value).toBe('64')
    expect(saveButton(wrapper).exists()).toBe(true)
    // 这一条必须写在界面上：否则用户会以为"保存了却没反应"
    expect(wrapper.text()).toContain('重新摄入')
  })

  it('只改块长时只发 chunk_size，另一项不动', async () => {
    const wrapper = await openChunking(await mountMenu())

    await wrapper.find('#kb-chunk-size').setValue('256')
    await saveButton(wrapper).trigger('click')
    await flushPromises()

    expect(kbApi.updateKnowledgeBase).toHaveBeenCalledWith('kb_1', { chunk_size: 256 })
  })

  it('解释性文字收进标题旁的「?」，面板里不再摊着一段灰字', async () => {
    const wrapper = await openChunking(await mountMenu())

    // 面板正文里不该再有 pane-desc
    expect(wrapper.find('.pane-desc').exists()).toBe(false)
    // 说明移到了 InfoTip 的 text 里（用户要求：转到 ？图标里面）
    const tip = wrapper.findComponent(InfoTip)
    expect(tip.exists()).toBe(true)
    expect(tip.props('text')).toContain('块太大：一段里混着好几件事')
    // 跟着块长变的那句留在正文里：工具提示里写不死一个动态的数
    expect(wrapper.text()).toContain('块长的一半')
  })

  it('块长是滑杆：范围固定在 128–2048，默认值处有刻度点', async () => {
    const wrapper = await openChunking(await mountMenu())

    const input = wrapper.find('#kb-chunk-size')
    expect(input.attributes('type')).toBe('range')
    expect(input.attributes('min')).toBe('128')
    expect(input.attributes('max')).toBe('2048')
    // 常用值（默认 512）画成一个点——要求用户心算"512 是几等分点"是不合理的
    expect(wrapper.find('.range-mark-primary').exists()).toBe(true)
  })

  it('滑杆把越界值夹回范围内——"填了个 10"这条路已经不存在了', async () => {
    const wrapper = await openChunking(await mountMenu())

    // 原生 range 的取值算法会把超出 [min, max] 的赋值夹到边界
    await wrapper.find('#kb-chunk-size').setValue('10')
    expect((wrapper.find('#kb-chunk-size').element as HTMLInputElement).value).toBe('128')

    await saveButton(wrapper).trigger('click')
    await flushPromises()

    expect(kbApi.updateKnowledgeBase).toHaveBeenCalledWith('kb_1', { chunk_size: 128 })
    expect(wrapper.find('.pane-error').exists()).toBe(false)
  })

  it('块长调小以后，重叠自动压回新上限（滑块画不出超上限的值）', async () => {
    const wrapper = await openChunking(await mountMenu())

    await wrapper.find('#kb-chunk-overlap').setValue('256')
    expect((wrapper.find('#kb-chunk-overlap').element as HTMLInputElement).value).toBe('256')

    // 块长 128 时重叠上限是 64：压不回去的话，滑块会停在 64 而读数还是 256
    await wrapper.find('#kb-chunk-size').setValue('128')
    expect((wrapper.find('#kb-chunk-overlap').element as HTMLInputElement).value).toBe('64')
    expect(wrapper.find('#kb-chunk-overlap').attributes('max')).toBe('64')
  })

  it('保存切分参数后**不关弹窗**，停在切块栏并提示需要重新摄入', async () => {
    const wrapper = await openChunking(await mountMenu())

    await wrapper.find('#kb-chunk-size').setValue('256')
    await saveButton(wrapper).trigger('click')
    await flushPromises()

    // 报错与"参数已保存"都靠看这里，而不是猜
    expect(wrapper.find('.nav-item-active').text()).toBe('切块策略')
    expect(wrapper.find('.callout').classes()).toContain('callout-strong')
    expect(wrapper.text()).toContain('已有文档还是按旧的切块参数、也没有问题')
  })

  // ------------------------------------------------ 吸附与可输入（用户报的第 11 条）

  it('拖动滑杆时吸附到最近的常用档：停在 1024 不再靠手感', async () => {
    const wrapper = await openChunking(await mountMenu())
    const input = wrapper.find('#kb-chunk-size')

    startDrag(input)
    // 1000 离刻度 1024 只有 24，在磁力半径（量程的 3%，约 58）以内
    await input.setValue('1000')
    expect(inputValue(wrapper, '#kb-chunk-size')).toBe('1024')

    // 磁力只覆盖刻度附近：900 离最近的刻度 124，拖到哪就是哪
    await input.setValue('900')
    expect(inputValue(wrapper, '#kb-chunk-size')).toBe('900')
    endDrag(input)

    // 吸附的结果就是要保存的值（不是只有画面上的滑块跳了一下）
    startDrag(input)
    await input.setValue('1000')
    endDrag(input)
    await saveButton(wrapper).trigger('click')
    await flushPromises()

    expect(kbApi.updateKnowledgeBase).toHaveBeenCalledWith('kb_1', { chunk_size: 1024 })
  })

  it('块重叠也吸附：30 落到刻度 32 上', async () => {
    const wrapper = await openChunking(await mountMenu())
    const overlap = wrapper.find('#kb-chunk-overlap')

    startDrag(overlap)
    await overlap.setValue('30')
    endDrag(overlap)

    // 量程 0–256 时磁力半径约 8：30 与 32 只差 2
    expect(inputValue(wrapper, '#kb-chunk-overlap')).toBe('32')
  })

  it('键盘不受吸附影响：方向键那一格一格照样走得动', async () => {
    const wrapper = await openChunking(await mountMenu())

    // 没有指针按下（键盘/程序设值）：1000 就是 1000。
    // 若这里也被吸成 1024，焦点停在刻度上时按方向键会被反复拽回去，永远走不出这个刻度
    await wrapper.find('#kb-chunk-size').setValue('1000')
    expect(inputValue(wrapper, '#kb-chunk-size')).toBe('1000')
  })

  it('右侧数字可以直接输入：回车生效并回显', async () => {
    const wrapper = await openChunking(await mountMenu())
    const box = wrapper.find('#kb-chunk-size-value')

    expect(inputValue(wrapper, '#kb-chunk-size-value')).toBe('512')

    // 输入过程中不夹取（"1" 是 "1024" 的前半截），也不动手改别的参数
    await box.setValue('1000')
    expect(inputValue(wrapper, '#kb-chunk-overlap')).toBe('64')

    // 回车：先把这个数落到草稿上回显，紧接着弹窗那条"回车保存"的老规矩把它一起提交
    await box.trigger('keydown.enter')
    expect(inputValue(wrapper, '#kb-chunk-size-value')).toBe('1000')
    await flushPromises()

    expect(kbApi.updateKnowledgeBase).toHaveBeenCalledWith('kb_1', { chunk_size: 1000 })
  })

  it('数字框里超出范围的值，失焦时按现有上下限纠正并回显', async () => {
    const wrapper = await openChunking(await mountMenu())
    const box = wrapper.find('#kb-chunk-size-value')

    // 失焦提交（不牵扯弹窗的回车保存）：5000 被夹到上限 2048
    await box.setValue('5000')
    await box.trigger('blur')

    // 与滑杆的原生夹取同一套边界（128–2048）：框里不留非法值，也就不会出现
    // "读数 5000、轨道却停在 2048"的分裂画面
    expect(inputValue(wrapper, '#kb-chunk-size-value')).toBe('2048')
    expect(inputValue(wrapper, '#kb-chunk-size')).toBe('2048')
  })

  it('数字框回显 1000 这类非档位值：吸附只认拖动，不替手打的数做主', async () => {
    const wrapper = await openChunking(await mountMenu())
    const box = wrapper.find('#kb-chunk-size-value')

    await box.setValue('1000')
    await box.trigger('blur')

    expect(inputValue(wrapper, '#kb-chunk-size-value')).toBe('1000')
    expect(inputValue(wrapper, '#kb-chunk-size')).toBe('1000')
  })

  it('数字框清空或乱敲：回显当前值，等于这次输入没发生', async () => {
    const wrapper = await openChunking(await mountMenu())
    const box = wrapper.find('#kb-chunk-size-value')

    await box.setValue('')
    await box.trigger('blur')
    expect(inputValue(wrapper, '#kb-chunk-size-value')).toBe('512')

    // 保存按钮仍然是禁用的：没改动就不许发空 PATCH
    expect(saveButton(wrapper).attributes('disabled')).toBeDefined()
  })

  it('用数字框改块长，重叠超过新上限时照旧被压回（与滑杆同一套规则）', async () => {
    const wrapper = await openChunking(await mountMenu())

    await wrapper.find('#kb-chunk-overlap-value').setValue('256')
    await wrapper.find('#kb-chunk-overlap-value').trigger('keydown.enter')
    expect(inputValue(wrapper, '#kb-chunk-overlap-value')).toBe('256')

    // 块长 128 时重叠上限 64
    await wrapper.find('#kb-chunk-size-value').setValue('128')
    await wrapper.find('#kb-chunk-size-value').trigger('keydown.enter')

    expect(inputValue(wrapper, '#kb-chunk-overlap-value')).toBe('64')
    expect(wrapper.find('#kb-chunk-overlap').attributes('max')).toBe('64')
  })

  it('数字框改块重叠：超过上限的值回车时被夹到上限', async () => {
    const wrapper = await openChunking(await mountMenu())
    const box = wrapper.find('#kb-chunk-overlap-value')

    // 块长 512 时上限是 256
    await box.setValue('300')
    await box.trigger('keydown.enter')

    expect(inputValue(wrapper, '#kb-chunk-overlap-value')).toBe('256')
  })

  it('「重新摄入全部文档」走 all=true，由服务端解析全集', async () => {
    vi.mocked(documentsApi.batchDocuments).mockResolvedValue({
      action: 'reprocess',
      succeeded: 2,
      failed: 0,
      items: [],
    })
    const wrapper = await openChunking(await mountMenu())

    const button = wrapper.findAll('button').find((b) => b.text().includes('重新摄入全部文档'))!
    await button.trigger('click')
    await wrapper.findComponent({ name: 'ConfirmDialog' }).vm.$emit('confirm')
    await flushPromises()

    expect(documentsApi.batchDocuments).toHaveBeenCalledWith('kb_1', 'reprocess', [], null, true)
    expect(wrapper.emitted('changed')).toContainEqual(['sources'])
  })
})

describe('分段出题（v23，并在切块栏里）', () => {
  it('四个控件的初值来自这个库，保存时按"改过的才发"提交', async () => {
    const wrapper = await mountMenu()
    // 没有独立的"推荐问题"栏了：它跟的是分段，就在「切块与出题」里
    expect(wrapper.findAll('.nav-item').map((el) => el.text())).not.toContain('推荐问题')
    const tab = wrapper.findAll('.nav-item').find((el) => el.text() === '切块策略')!
    await tab.trigger('click')

    // 初值来自 kb（fixture 里是开 / 6 条）
    const checkbox = wrapper.find('.suggested-toggle input')
    expect((checkbox.element as HTMLInputElement).checked).toBe(true)

    await checkbox.setValue(false)

    await saveButton(wrapper).trigger('click')
    await flushPromises()

    expect(kbApi.updateKnowledgeBase).toHaveBeenCalledWith(
      'kb_1',
      expect.objectContaining({ suggested_enabled: false }),
    )
  })

  it('没动过就不发这一组字段（与切块参数同一套"脏了才发"）', async () => {
    const wrapper = await mountMenu()
    await nameInput(wrapper).setValue('改了名')
    await saveButton(wrapper).trigger('click')
    await flushPromises()

    const patch = vi.mocked(kbApi.updateKnowledgeBase).mock.calls[0][1] as Record<string, unknown>
    expect(patch).not.toHaveProperty('suggested_enabled')
    expect(patch).not.toHaveProperty('suggested_prompt')
  })
})

describe('回答要求（库级提示词）', () => {
  // ------------------------------------------------ 回答要求（库级提示词，v0.19）

  async function openPromptSection(wrapper: Awaited<ReturnType<typeof mountMenu>>) {
    const item = wrapper.findAll('.nav-item').find((el) => el.text() === '回答要求')!
    await item.trigger('click')
    return item
  }

  it('回答要求：提示词存在这个库里，改完跟着保存提交', async () => {
    const wrapper = await mountMenu(kbFixture({ system_prompt: '按 mm 记。' }))
    await openPromptSection(wrapper)

    const box = wrapper.find('#kb-setting-prompt')
    expect((box.element as HTMLTextAreaElement).value).toBe('按 mm 记。')

    await box.setValue('按 mm 记，单位统一用毫米。')
    await saveButton(wrapper).trigger('click')
    await flushPromises()

    const patch = vi.mocked(kbApi.updateKnowledgeBase).mock.calls.at(-1)?.[1] as any
    expect(patch.system_prompt).toBe('按 mm 记，单位统一用毫米。')
  })

  it('回答要求：没改动时保存按钮仍是禁用的（不许发空 PATCH）', async () => {
    const wrapper = await mountMenu(kbFixture({ system_prompt: '原样' }))
    await openPromptSection(wrapper)

    expect(saveButton(wrapper).attributes('disabled')).toBeDefined()
  })

  it('按摘要生成：草稿填进编辑框，并把**用了哪几篇**列出来（溯源）', async () => {
    vi.mocked(kbApi.generateKBPrompt).mockResolvedValue({
      prompt: '你是干眼领域的助手。分级按严重程度 [来源: 共识.pdf]。',
      sources: [
        { document_id: 'd1', name: '共识.pdf', summary: '讲分级', cited: true },
        { document_id: 'd2', name: '另一篇.pdf', summary: '讲治疗', cited: false },
      ],
      cited_documents: 1,
      unknown_citations: [],
    })
    const wrapper = await mountMenu()
    await openPromptSection(wrapper)

    const button = wrapper.findAll('button').find((b) => b.text().includes('按文档摘要生成'))!
    await button.trigger('click')
    await flushPromises()

    // 草稿进编辑框（用户要能改），不是只读展示
    const box = wrapper.find('#kb-setting-prompt')
    expect((box.element as HTMLTextAreaElement).value).toContain('你是干眼领域的助手')
    // 溯源：依据了哪几篇、哪几篇被写进去了
    expect(wrapper.text()).toContain('依据了 2 篇摘要')
    expect(wrapper.text()).toContain('1 篇被写进要求里')
    expect(wrapper.findAll('.prompt-trace-cited').map((el) => el.text())).toEqual(['共识.pdf'])
  })

  it('引用了清单里没有的文件：明确提示要核对（那是编造的迹象）', async () => {
    vi.mocked(kbApi.generateKBPrompt).mockResolvedValue({
      prompt: '按某标准执行 [来源: 不存在的指南.pdf]。',
      sources: [{ document_id: 'd1', name: '共识.pdf', summary: '讲分级', cited: false }],
      cited_documents: 0,
      unknown_citations: ['不存在的指南.pdf'],
    })
    const wrapper = await mountMenu()
    await openPromptSection(wrapper)

    const button = wrapper.findAll('button').find((b) => b.text().includes('按文档摘要生成'))!
    await button.trigger('click')
    await flushPromises()

    const warn = wrapper.find('.prompt-trace-warn')
    expect(warn.exists()).toBe(true)
    expect(warn.text()).toContain('不存在的指南.pdf')
    expect(warn.text()).toContain('编造')
  })

  it('关掉再打开设置：上一次生成的溯源不会留着（否则框与溯源对不上）', async () => {
    vi.mocked(kbApi.generateKBPrompt).mockResolvedValue({
      prompt: '你是助手，按资料回答，不要编造，标出出处。',
      sources: [{ document_id: 'd1', name: '共识.pdf', summary: '讲分级', cited: true }],
      cited_documents: 1,
      unknown_citations: [],
    })
    const wrapper = await mountMenu()
    await openPromptSection(wrapper)
    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('按文档摘要生成'))!
      .trigger('click')
    await flushPromises()
    expect(wrapper.find('.prompt-trace').exists()).toBe(true)

    // 取消 → 重新打开
    await wrapper
      .findAll('button')
      .find((b) => b.text() === '取消')!
      .trigger('click')
    await flushPromises()
    await openPromptSection(wrapper)

    expect(wrapper.find('.prompt-trace').exists()).toBe(false)
  })

  it('后端还没返回 system_prompt 时也不该崩（字段缺失 ≠ 空串）', async () => {
    // 实测踩过：后端进程比前端旧、列表接口不返回这个字段，于是 `kbPrompt` 被写成
    // `undefined`，而面板里有一处 `kbPrompt.trim()`——渲染直接抛错，
    // Vue 放弃这次 patch，表现是"点了菜单右边还是上一栏"（很难查的那种）。
    // 夹具故意把这个字段打成 undefined，模拟那个状态。
    const stale = kbFixture()
    delete (stale as { system_prompt?: string }).system_prompt
    const wrapper = await mountMenu(stale)

    const item = wrapper.findAll('.nav-item').find((el) => el.text() === '回答要求')!
    await item.trigger('click')

    // 面板正常渲染，输入框是空的（不是崩掉、也不是显示 undefined）
    const box = wrapper.find('#kb-setting-prompt')
    expect(box.exists()).toBe(true)
    expect((box.element as HTMLTextAreaElement).value).toBe('')
  })
})
