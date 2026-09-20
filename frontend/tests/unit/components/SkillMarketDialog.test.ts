import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import SkillMarketDialog from '@/components/capabilities/SkillMarketDialog.vue'
import { resetResizeObservers } from '../../setup'

/**
 * 技能市场（v0.27）。
 *
 * 这里盯的是**装之前那一步**，因为它是调研 §4.6 的硬要求：
 * 技能目录里的 `scripts/` 是会被执行的代码，用户在看到文件清单之前没有别的地方
 * 能判断"我到底在装什么"。所以：
 *
 * 1. **详情先于安装**：点一个技能先看到文件清单（含「代码」标记），而不是一个
 *    "一点就装"的按钮；
 * 2. **错误就地显示**：这里的错误大多带下一步（GitHub 配额用完 → 配 token），
 *    一闪而过的 toast 会把这些字吞掉；
 * 3. **已安装的不再给安装入口**。
 */

const listSkillSources = vi.fn()
const browseSkillSource = vi.fn()
const inspectMarketSkill = vi.fn()
const installMarketSkill = vi.fn()
const addSkillSource = vi.fn()
const deleteSkillSource = vi.fn()
const setSkillSourceEnabled = vi.fn()
const uploadSkill = vi.fn()
const notifySuccess = vi.fn()

vi.mock('@/api/capabilities', () => ({
  listSkillSources: (...a: unknown[]) => listSkillSources(...a),
  browseSkillSource: (...a: unknown[]) => browseSkillSource(...a),
  inspectMarketSkill: (...a: unknown[]) => inspectMarketSkill(...a),
  installMarketSkill: (...a: unknown[]) => installMarketSkill(...a),
  addSkillSource: (...a: unknown[]) => addSkillSource(...a),
  deleteSkillSource: (...a: unknown[]) => deleteSkillSource(...a),
  setSkillSourceEnabled: (...a: unknown[]) => setSkillSourceEnabled(...a),
  uploadSkill: (...a: unknown[]) => uploadSkill(...a),
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({
    notifyError: vi.fn(),
    notifySuccess,
    notify: vi.fn(),
    notifyWarning: vi.fn(),
  }),
}))

const SOURCE = {
  id: 'anthropic',
  name: 'Anthropic 官方技能',
  repo: 'anthropics/skills',
  ref: '',
  subpath: '',
  builtin: true,
  enabled: true,
  why: '格式的参考实现',
}

const CUSTOM = { ...SOURCE, id: 'me-notes', name: 'me/notes', repo: 'me/notes', builtin: false }

const SKILL = {
  name: 'pdf',
  description: '处理 PDF 表单',
  path: 'skills/pdf',
  source_id: 'anthropic',
  repo: 'anthropics/skills',
  installed: false,
}

const BUNDLE = {
  source_id: 'anthropic',
  repo: 'anthropics/skills',
  sha: 'a'.repeat(40),
  path: 'skills/pdf',
  name: 'pdf',
  description: '处理 PDF 表单',
  ref: 'main',
  license: 'Apache-2.0',
  files: [
    { path: 'SKILL.md', size: 8072, kind: 'doc' as const },
    { path: 'scripts/fill.py', size: 3819, kind: 'code' as const },
    { path: 'logo.png', size: 2048, kind: 'asset' as const },
  ],
  total_bytes: 13939,
  code_count: 1,
  truncated: false,
}

function mountDialog(props: Record<string, unknown> = {}) {
  return mount(SkillMarketDialog, {
    props: { open: true, ...props },
    global: { stubs: { teleport: true } },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  resetResizeObservers()
  listSkillSources.mockResolvedValue({ items: [SOURCE, CUSTOM] })
  browseSkillSource.mockResolvedValue({ source: SOURCE, items: [SKILL], cached: true })
  inspectMarketSkill.mockResolvedValue(BUNDLE)
  installMarketSkill.mockResolvedValue({ ...SKILL, source: 'user' })
  setSkillSourceEnabled.mockResolvedValue(SOURCE)
  deleteSkillSource.mockResolvedValue(undefined)
  addSkillSource.mockResolvedValue(CUSTOM)
})

describe('技能市场', () => {
  it('打开就列出当前源里的技能', async () => {
    const wrapper = mountDialog()

    await vi.waitFor(() => expect(wrapper.text()).toContain('pdf'))
    expect(browseSkillSource).toHaveBeenCalledWith('anthropic', false)
    expect(wrapper.text()).toContain('处理 PDF 表单')
    // 内置源那句"为什么内置它"要显示出来——源不是随便列的
    expect(wrapper.text()).toContain('格式的参考实现')
  })

  it('点一个技能先看文件清单，而不是直接装', async () => {
    const wrapper = mountDialog()
    await vi.waitFor(() => expect(wrapper.text()).toContain('pdf'))

    await wrapper.findAll('.market-item')[0].trigger('click')

    await vi.waitFor(() => expect(wrapper.text()).toContain('scripts/fill.py'))
    // 三类文件都在，而且**代码那一类被单独标出来 + 单独提示**
    expect(wrapper.text()).toContain('SKILL.md')
    expect(wrapper.text()).toContain('logo.png')
    expect(wrapper.text()).toContain('代码')
    expect(wrapper.text()).toContain('会在你的机器上执行')
    // 装的是哪一版要看得见（分支会在两步之间变）
    expect(wrapper.text()).toContain('aaaaaaa') // 40 位 SHA 的前 7 位
    expect(installMarketSkill).not.toHaveBeenCalled()
  })

  it('装完之后回到清单，并且那一条标成已安装', async () => {
    const wrapper = mountDialog()
    await vi.waitFor(() => expect(wrapper.text()).toContain('pdf'))
    await wrapper.findAll('.market-item')[0].trigger('click')
    await vi.waitFor(() => expect(wrapper.text()).toContain('SKILL.md'))

    const install = wrapper.findAll('button').find((node) => node.text().includes('安装'))!
    await install.trigger('click')

    await vi.waitFor(() =>
      expect(installMarketSkill).toHaveBeenCalledWith('anthropic', 'skills/pdf'),
    )
    expect(wrapper.emitted('installed')?.[0]).toEqual(['pdf'])
    await vi.waitFor(() => expect(wrapper.text()).toContain('已安装'))
  })

  it('浏览失败时把原因就地写出来（不是一闪而过）', async () => {
    browseSkillSource.mockRejectedValue(
      new Error('GitHub 的匿名配额（60 次/小时）用完了，等一会儿再试，或设 KYLAB_GITHUB_TOKEN'),
    )
    const wrapper = mountDialog()

    await vi.waitFor(() => expect(wrapper.text()).toContain('KYLAB_GITHUB_TOKEN'))
    expect(wrapper.find('.market-error').exists()).toBe(true)
  })

  it('管理源：内置的能停用、自定义的能删', async () => {
    const wrapper = mountDialog()
    await vi.waitFor(() => expect(wrapper.text()).toContain('pdf'))

    const manage = wrapper.findAll('button').find((node) => node.text().includes('管理源'))!
    await manage.trigger('click')

    expect(wrapper.text()).toContain('anthropics/skills')
    expect(wrapper.text()).toContain('me/notes')
    // 内置源没有删除按钮（只能停用）
    const rows = wrapper.findAll('.source-row')
    expect(rows[0].findAll('.icon-button').length).toBe(0)
    expect(rows[1].findAll('.icon-button').length).toBe(1)

    await rows[0].find('.chip-button').trigger('click')
    await vi.waitFor(() => expect(setSkillSourceEnabled).toHaveBeenCalledWith('anthropic', false))
  })

  it('添加自定义源：粘一个仓库地址就能用', async () => {
    const wrapper = mountDialog()
    await vi.waitFor(() => expect(wrapper.text()).toContain('pdf'))
    const manage = wrapper.findAll('button').find((node) => node.text().includes('管理源'))!
    await manage.trigger('click')

    await wrapper.find('.add-source input').setValue('me/notes')
    await wrapper
      .findAll('button')
      .find((node) => node.text() === '添加')!
      .trigger('click')

    await vi.waitFor(() => expect(addSkillSource).toHaveBeenCalledWith('me/notes'))
    expect(notifySuccess).toHaveBeenCalled()
  })

  it('这个源里没有技能时说的是"换个源"，而不是一句空白', async () => {
    browseSkillSource.mockResolvedValue({ source: SOURCE, items: [], cached: true })
    const wrapper = mountDialog()

    await vi.waitFor(() => expect(wrapper.text()).toContain('这个源里没有技能'))
    // 等**加载完**再看：刚打开那一帧还没有结果，骨架屏期间不该说"没有技能"
    await vi.waitFor(() => expect(wrapper.find('.empty-title').exists()).toBe(true))
    expect(wrapper.text()).toContain('换个源试试')
  })
})

describe('中文简介与本地添加（v0.28）', () => {
  it('列表与详情显示中文简介，英文原文留在详情里', async () => {
    // 技能生态里绝大多数描述是英文，而这一页是给中文用户看的：
    // "这个技能是干什么的"看不懂，市场就白逛了。
    const translated = {
      ...SKILL,
      description: 'Work with PDF files',
      summary: '处理 PDF 表单与文档',
    }
    const bundleTranslated = {
      ...BUNDLE,
      description: 'Work with PDF files',
      summary: '处理 PDF 表单与文档',
    }
    browseSkillSource.mockResolvedValue({ source: SOURCE, items: [translated], cached: true })
    inspectMarketSkill.mockResolvedValue(bundleTranslated)
    const wrapper = mountDialog()

    await vi.waitFor(() => expect(wrapper.text()).toContain('处理 PDF 表单与文档'))
    expect(wrapper.text()).not.toContain('Work with PDF files') // 英文原文不占列表那一行

    await wrapper.findAll('.market-item')[0].trigger('click')
    await vi.waitFor(() => expect(wrapper.text()).toContain('scripts/fill.py'))
    // 详情里两行都在：中文在上、原文在下（"这句是谁写的"是判断可信度时要看的）
    expect(wrapper.text()).toContain('处理 PDF 表单与文档')
    expect(wrapper.text()).toContain('Work with PDF files')
  })

  it('没有中文简介时退回英文原描述', async () => {
    browseSkillSource.mockResolvedValue({ source: SOURCE, items: [SKILL], cached: true })
    const wrapper = mountDialog()

    await vi.waitFor(() => expect(wrapper.text()).toContain('处理 PDF 表单'))
  })

  it('管理源那一屏有"从本机添加"，两个入口都在', async () => {
    const wrapper = mountDialog()
    await vi.waitFor(() => expect(wrapper.text()).toContain('pdf'))
    await wrapper
      .findAll('button')
      .find((node) => node.text().includes('管理源'))!
      .trigger('click')

    expect(wrapper.text()).toContain('从本机添加')
    expect(wrapper.find('input[webkitdirectory]').exists()).toBe(true)
    expect(wrapper.find('input[accept=".zip,application/zip"]').exists()).toBe(true)
  })

  it('选压缩包上传：文件与相对路径一起上行，成功后关掉弹窗', async () => {
    uploadSkill.mockResolvedValue({ ...SKILL, name: 'pdf' })
    const wrapper = mountDialog()
    await vi.waitFor(() => expect(wrapper.text()).toContain('pdf'))
    await wrapper
      .findAll('button')
      .find((node) => node.text().includes('管理源'))!
      .trigger('click')

    const archive = new File(['PK'], 'my-skill.zip', { type: 'application/zip' })
    const input = wrapper.find('input[accept=".zip,application/zip"]')
    Object.defineProperty(input.element, 'files', { value: [archive], configurable: true })
    await input.trigger('change')

    await vi.waitFor(() => expect(uploadSkill).toHaveBeenCalled())
    const [files, paths] = uploadSkill.mock.calls[0] as [File[], string[]]
    expect(files).toHaveLength(1)
    expect(paths).toEqual([])
    expect(wrapper.emitted('installed')?.[0]).toEqual(['pdf'])
  })
})
